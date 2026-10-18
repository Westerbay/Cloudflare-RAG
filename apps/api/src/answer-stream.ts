import { JSONParser } from "@streamparser/json";
import { createParser } from "eventsource-parser";
import type { ChatInput, Evidence } from "@small-rag/contracts/chat";
import { CHAT_MODEL } from "@small-rag/contracts/config";
import { answerGenerationInput, isObject, validateAnswer } from "./ai.ts";
import type { AIBinding } from "./bindings.ts";
import { ServiceAvailability, ServiceSleeping, sleepingPayload } from "./availability.ts";

// Generous envelopes around the fixed 200-token model budget, including SSE metadata.
const MAX_PROVIDER_BYTES = 128 * 1024;
const MAX_PROVIDER_EVENTS = 2048;
const MAX_ANSWER_JSON_CHARS = 16 * 1024;

class InvalidAnswerStream extends Error {}

class ProviderStreamError extends Error {
  code?: string | number;
  constructor(value: unknown) {
    super(isObject(value) && typeof value.message === "string" ? value.message : "Provider stream failure");
    if (isObject(value) && (typeof value.code === "string" || typeof value.code === "number")) this.code = value.code;
  }
}

/** Extracts only the answer string. Model JSON and provider fields never reach clients. */
class AnswerDecoder {
  private json = "";
  private answer = "";
  private answerComplete = false;
  private done = false;
  private eventCount = 0;
  private parser: JSONParser;
  private sse;

  constructor(emit: (delta: string) => void) {
    this.parser = new JSONParser({ paths: ["$.answer"], emitPartialTokens: true, emitPartialValues: true });
    this.parser.onValue = ({ value, key, partial }) => {
      if (key !== "answer" || typeof value !== "string") return;
      if (this.answerComplete || !value.startsWith(this.answer)) throw new InvalidAnswerStream("Answer changed during generation");
      // Do not expose half of an escaped UTF-16 surrogate pair.
      const end = value.length > 0 && /[\uD800-\uDBFF]/.test(value.at(-1) ?? "") ? value.length - 1 : value.length;
      const next = value.slice(0, end);
      const delta = next.slice(this.answer.length);
      if (delta) emit(delta);
      this.answer = next;
      this.answerComplete = !partial;
    };
    this.sse = createParser({
      maxBufferSize: MAX_PROVIDER_BYTES,
      onError: () => { throw new InvalidAnswerStream("Malformed provider event"); },
      onEvent: ({ event, data }) => {
        if (++this.eventCount > MAX_PROVIDER_EVENTS || this.done) throw new InvalidAnswerStream("Unexpected provider event");
        if (data === "[DONE]") { this.done = true; return; }
        const value: unknown = JSON.parse(data);
        if (event === "error" || (isObject(value) && value.error)) {
          throw new ProviderStreamError(isObject(value) ? value.error ?? value : value);
        }
        if (!isObject(value)) throw new InvalidAnswerStream("Invalid provider response");
        const choice: unknown = Array.isArray(value.choices) ? value.choices[0] : undefined;
        const reasons = [value.finish_reason, isObject(choice) ? choice.finish_reason : undefined];
        if (reasons.some(reason => reason !== undefined && reason !== null && reason !== "stop")) {
          throw new InvalidAnswerStream("Truncated answer");
        }
        // The verified Workers AI stream sends one usage-only frame before [DONE].
        if (value.response === undefined && isObject(value.usage)
            && Array.isArray(value.choices) && value.choices.length === 0) return;
        // Depending on token boundaries, stop is emitted separately from the final text.
        if (value.response === undefined && isObject(choice) && choice.finish_reason === "stop"
            && isObject(choice.delta) && Object.keys(choice.delta).length === 0) return;
        // Cloudflare can coerce response fragments such as "3.3" into numbers. The
        // OpenAI-compatible delta retains the original text; never concatenate both.
        let fragment: unknown = value.response;
        if (isObject(choice) && isObject(choice.delta) && typeof choice.delta.content === "string") {
          fragment = choice.delta.content;
        }
        if (typeof fragment !== "string") throw new InvalidAnswerStream("Missing provider response");
        this.json += fragment;
        if (this.json.length > MAX_ANSWER_JSON_CHARS) throw new InvalidAnswerStream("Answer budget exceeded");
        this.parser.write(fragment);
      },
    });
  }

  feed(value: string): void { this.sse.feed(value); }
  get complete(): boolean { return this.done; }

  finish(evidence: Evidence[]) {
    if (!this.done) throw new InvalidAnswerStream("Provider stream ended without completion");
    if (!this.parser.isEnded) this.parser.end();
    const result = validateAnswer(JSON.parse(this.json), evidence);
    if (!this.answerComplete || this.answer.trim() !== result.answer) throw new InvalidAnswerStream("Incomplete answer text");
    return result;
  }
}

export async function streamAnswer(
  ai: AIBinding, prompt: string, input: ChatInput, evidence: Evidence[], searchQuestion: string,
  availability: ServiceAvailability, clock: () => number, requestSignal: AbortSignal,
  headers: Record<string, string>,
): Promise<Response> {
  requestSignal.throwIfAborted();
  const upstream = await ai.run(CHAT_MODEL, answerGenerationInput(prompt, input, evidence, searchQuestion, true));
  if (!(upstream instanceof ReadableStream)) throw new InvalidAnswerStream("Missing provider stream");
  const reader = upstream.getReader();
  const cancellation = new AbortController();
  const encoder = new TextEncoder();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let closed = false;
  let bytes = 0;
  const stop = () => {
    cancellation.abort(requestSignal.reason);
    // Reader cleanup after disconnection is best effort, never an availability signal.
    void reader.cancel(requestSignal.reason).catch(() => undefined);
  };
  requestSignal.addEventListener("abort", stop, { once: true });
  if (requestSignal.aborted) stop();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, value: unknown) => {
        if (!closed && !cancellation.signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      const decoder = new AnswerDecoder(delta => emit("delta", { delta }));
      async function pump() {
        try {
          while (!decoder.complete) {
            const next = await availability.run("workers_ai", () => reader.read(), clock, cancellation.signal);
            cancellation.signal.throwIfAborted();
            if (next.done) {
              decoder.feed(utf8.decode());
              break;
            }
            if (!(next.value instanceof Uint8Array)) throw new InvalidAnswerStream("Invalid stream bytes");
            bytes += next.value.byteLength;
            if (bytes > MAX_PROVIDER_BYTES) throw new InvalidAnswerStream("Provider stream budget exceeded");
            try { decoder.feed(utf8.decode(next.value, { stream: true })); }
            catch (error) {
              if (error instanceof ProviderStreamError) {
                await availability.run("workers_ai", async () => { throw error; }, clock, cancellation.signal);
              }
              throw error;
            }
          }
          cancellation.signal.throwIfAborted();
          decoder.feed(utf8.decode());
          emit("result", decoder.finish(evidence));
        } catch (error) {
          if (!cancellation.signal.aborted) {
            if (error instanceof ServiceSleeping) emit("sleeping", sleepingPayload(error));
            else emit("error", { code: "response" });
          }
        } finally {
          requestSignal.removeEventListener("abort", stop);
          if (!closed) { closed = true; controller.close(); }
          // We have a terminal event or an abort; do not keep the inference stream open.
          try { await reader.cancel(); } catch { /* Cleanup cannot replace the already emitted terminal state. */ }
          reader.releaseLock();
        }
      }
      void pump();
    },
    async cancel(reason) {
      closed = true;
      cancellation.abort(reason);
      await reader.cancel(reason);
    },
  });
  return new Response(body, { headers: { ...headers,
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform",
  } });
}
