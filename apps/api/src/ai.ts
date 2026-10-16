import { embeddingResponseSchema } from "@small-rag/contracts/ai";
import { modelAnswerSchema } from "@small-rag/contracts/chat";
import type { Evidence, ChatInput } from "@small-rag/contracts/chat";
import type { AIBinding } from "./bindings.ts";
import { CHAT_MODEL, EMBEDDING_MODEL, MAX_OUTPUT_TOKENS } from "@small-rag/contracts/config";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function embeddingFromResponse(value: unknown): number[] {
  return embeddingResponseSchema.parse(value).data[0];
}

export async function embed(ai: AIBinding, text: string): Promise<number[]> {
  return embeddingFromResponse(await ai.run(EMBEDDING_MODEL, { text: [text] }));
}

function modelAnswer(value: unknown): unknown {
  if (!isObject(value)) throw new Error("Invalid generation response");
  let answer: unknown = value.response;
  if (Array.isArray(value.choices)) {
    const choice: unknown = value.choices[0];
    if (!isObject(choice) || choice.finish_reason === "length" || !isObject(choice.message)) {
      throw new Error("Invalid or truncated generation response");
    }
    answer = choice.message.content;
  }
  if (typeof answer === "string") return JSON.parse(answer);
  if (isObject(answer)) return answer;
  throw new Error("Missing generation response");
}

export async function generateAnswer(
  ai: AIBinding, prompt: string, input: ChatInput, evidence: Evidence[],
) {
  const refusalRequired = evidence.length === 0;
  const payload: Record<string, unknown> = {
    question: input.message, history: input.history,
    evidence: evidence.map(({ chunk_id, ...passage }) => passage),
  };
  if (refusalRequired) payload.required_status = "insufficient_context";
  let citationSchema: Record<string, unknown>;
  if (refusalRequired) citationSchema = { type: "array", maxItems: 0, items: { type: "string" } };
  else citationSchema = { type: "array", items: { type: "string", enum: evidence.map(item => item.id) } };
  const schema = {
    type: "object",
    properties: {
      status: { type: "string", enum: refusalRequired ? ["insufficient_context"]
        : ["answered", "insufficient_context", "out_of_scope"] },
      answer: { type: "string", minLength: 1 },
      citations: citationSchema,
    },
    required: ["status", "answer", "citations"], additionalProperties: false,
  };
  const value = modelAnswerSchema.parse(modelAnswer(await ai.run(CHAT_MODEL, {
    messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(payload) }],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.1, stream: false,
  })));
  if (refusalRequired && value.status !== "insufficient_context") throw new Error("Invalid refusal status");
  const chosen = new Map(evidence.map(item => [item.id, item]));
  const citations = [...new Set(value.citations)].map(id => {
    const item = chosen.get(id);
    if (!item) throw new Error("Unknown citation");
    return { chunk_id: item.chunk_id, path: item.path, line_start: item.lines[0], line_end: item.lines[1] };
  });
  if ((value.status === "answered" && citations.length === 0)
      || (value.status !== "answered" && citations.length !== 0)) throw new Error("Invalid citation status");
  return { status: value.status, answer: value.answer.trim(), citations };
}
