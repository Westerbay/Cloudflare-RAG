import type { ChatInput, Evidence } from "@small-rag/contracts/chat";
import type { Database } from "@small-rag/database/bindings";
import type { Env } from "./bindings.ts";
import { chatInputSchema } from "@small-rag/contracts/chat";
import { embed, generateAnswer } from "./ai.ts";
import { ServiceAvailability, ServiceSleeping } from "./availability.ts";
import {
  similarityThreshold, DIMENSIONS, EMBEDDING_MODEL, MAX_BODY_BYTES,
  MAX_EVIDENCE_CHARS, TOP_K,
} from "@small-rag/contracts/config";

// Reused bindings share a pause within this isolate; no dependency on writable D1.
const availabilityByDatabase = new WeakMap<Database, ServiceAvailability>();

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}

async function authenticated(request: Request, password: string): Promise<boolean> {
  let supplied: string;
  const header = request.headers.get("Authorization") ?? "";
  try {
    if (!header.startsWith("Basic ") || header.length > 4096) return false;
    supplied = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), char => char.charCodeAt(0)));
  } catch { return false; }
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(`rag:${password}`)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const left = new Uint8Array(expected), right = new Uint8Array(actual);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function parseInput(request: Request): Promise<ChatInput> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/json") {
    throw new RequestError(415, "Content-Type must be application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(422, "Request body is required");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError(413, "Request body is too large");
    }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(422, "Invalid JSON body"); }
  const parsed = chatInputSchema.safeParse(value);
  if (!parsed.success) throw new RequestError(422, "Invalid chat input");
  return parsed.data;
}

async function activeGeneration(db: Database, availability: ServiceAvailability, clock: () => number): Promise<string> {
  const row = await availability.run("d1", () => db.prepare(
    `SELECT g.id, g.embedding_model, g.chunk_count FROM generations g
     JOIN active_generation a ON a.generation_id = g.id WHERE a.singleton = 1`,
  ).first(), clock);
  if (!row || typeof row.id !== "string" || row.embedding_model !== EMBEDDING_MODEL
      || typeof row.chunk_count !== "number" || row.chunk_count < 1) throw new Error("Index absent or incompatible");
  return row.id;
}

async function retrieve(env: Env, input: ChatInput, generation: string, threshold: number, availability: ServiceAvailability, clock: () => number): Promise<Evidence[]> {
  const vector = await embed(env.AI, input.message);
  const matches = await availability.run("vectorize", () =>
    env.VECTORS.query(vector, { topK: TOP_K, namespace: generation, returnMetadata: "none" }), clock);
  const evidence: Evidence[] = [];
  let remaining = MAX_EVIDENCE_CHARS;
  const seen = new Set<string>();
  for (const hit of matches.matches) {
    if (!Number.isFinite(hit.score) || hit.score < threshold || remaining <= 0 || seen.has(hit.id)) continue;
    seen.add(hit.id);
    const row = await availability.run("d1", () => env.DB.prepare(
      `SELECT chunk_id, document_path, heading, line_start, line_end, content FROM chunks
       WHERE vector_id = ? AND generation_id = ?`,
    ).bind(hit.id, generation).first(), clock);
    if (!row || typeof row.chunk_id !== "string" || typeof row.document_path !== "string"
        || typeof row.content !== "string" || typeof row.line_start !== "number"
        || typeof row.line_end !== "number" || (row.heading !== null && typeof row.heading !== "string")) {
      throw new Error("Retrieved evidence is missing or malformed");
    }
    const text = row.content.slice(0, remaining);
    if (!text.trim()) continue;
    evidence.push({ id: `s${evidence.length + 1}`, chunk_id: row.chunk_id, path: row.document_path,
      lines: [row.line_start, row.line_end], heading: row.heading, text });
    remaining -= text.length;
  }
  return evidence;
}

export async function handleRequest(request: Request, env: Env, prompt: string, now?: Date): Promise<Response> {
  const clock = () => now?.getTime() ?? Date.now();
  let availability = availabilityByDatabase.get(env.DB);
  if (!availability) {
    availability = new ServiceAvailability();
    availabilityByDatabase.set(env.DB, availability);
  }
  const services = availability;
  const bindings: Env = { ...env, AI: {
    run: (model, input) => services.run("workers_ai", () => env.AI.run(model, input), clock),
  } };
  try {
    if (!env.BASIC_AUTH_PASSWORD || env.BASIC_AUTH_PASSWORD.length < 16) {
      return json({ detail: "Service authentication is not configured" }, 503);
    }
    if (!await authenticated(request, env.BASIC_AUTH_PASSWORD)) {
      return json({ detail: "Authentication required" }, 401, { "WWW-Authenticate": 'Basic realm="Small RAG", charset="UTF-8"' });
    }
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health/live") return json({ status: "ok" });
    if (request.method === "GET" && path === "/health/ready") {
      similarityThreshold(env.MIN_SIMILARITY);
      services.check(clock());
      await activeGeneration(env.DB, services, clock);
      const info = await services.run("vectorize", () => env.VECTORS.describe(), clock);
      if (info.dimensions !== DIMENSIONS) throw new Error("Incompatible vector index");
      return json({ status: "ok" });
    }
    if (request.method !== "POST" || path !== "/v1/chat") return json({ detail: "Not found" }, 404);
    const input = await parseInput(request);
    services.check(clock());
    const generation = await activeGeneration(env.DB, services, clock);
    const threshold = similarityThreshold(env.MIN_SIMILARITY);
    const evidence = await retrieve(bindings, input, generation, threshold, services, clock);
    return json(await generateAnswer(bindings.AI, prompt, input, evidence));
  } catch (error) {
    if (error instanceof RequestError) return json({ detail: error.message }, error.status);
    if (error instanceof ServiceSleeping) {
      const pause = error.pause;
      return json({
        status: "sleeping", detail: "Waiting for Cloudflare service availability",
        service: pause.service, reason: pause.reason,
        retry_at: new Date(pause.retryAt).toISOString(),
        ...(pause.resetAt ? { reset_at: new Date(pause.resetAt).toISOString() } : {}),
      }, 503, { "Retry-After": String(Math.max(1, Math.ceil((pause.retryAt - clock()) / 1000))) });
    }
    // Do not expose provider payloads, credentials, questions or passages in errors/logs.
    return json({ detail: "RAG service is unavailable" }, 503);
  }
}
