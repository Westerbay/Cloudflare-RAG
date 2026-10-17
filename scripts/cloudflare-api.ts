/** Operator-only REST calls. Never log credentials or provider response bodies. */
import { z } from "zod";
export interface CloudflareCallOptions extends RequestInit { allowNotFound?: boolean }
export interface CloudflareClient {
  account: string;
  call(path: string, options?: CloudflareCallOptions): Promise<unknown>;
}
const envelopeSchema = z.object({ success: z.boolean(), result: z.unknown().optional() });
const errorsSchema = z.object({ errors: z.array(z.object({
  code: z.number().int().min(0).max(1_000_000).optional(), message: z.string().optional(),
})).max(100).optional() });

function operationName(path: string): string {
  if (path.startsWith("/d1/database")) return path.endsWith("/query") ? "D1 query" : "D1 resource setup";
  if (path.startsWith("/ai/run/")) return "Workers AI inference";
  if (path.startsWith("/vectorize/")) {
    if (path.endsWith("/upsert")) return "Vectorize upsert";
    if (path.endsWith("/info")) return "Vectorize index info";
    return "Vectorize resource setup";
  }
  return "Cloudflare request";
}

const networkCodes = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "TimeoutError", "AbortError",
]);
function transportFailure(path: string, cause: unknown): Error {
  const pending: unknown[] = [cause], codes = new Set<string>();
  // Node fetch can wrap connection failures in an AggregateError and nested causes.
  for (let inspected = 0; pending.length && inspected < 16; inspected++) {
    const error = pending.shift();
    if (!(error instanceof Error)) continue;
    if (networkCodes.has(error.name)) codes.add(error.name);
    if ("code" in error && typeof error.code === "string" && networkCodes.has(error.code)) codes.add(error.code);
    if (error.cause) pending.push(error.cause);
    if (error instanceof AggregateError) pending.push(...error.errors.slice(0, 8));
  }
  const detail = codes.size ? [...codes].join(", ") : "network error";
  return new Error(`${operationName(path)} failed before a complete HTTP response (${detail}); no automatic retry was made.`, { cause });
}

function requestFailure(path: string, status: number, raw: unknown, invalidJson = false): Error {
  const operation = operationName(path);
  const parsed = errorsSchema.safeParse(raw);
  const errors = parsed.success ? parsed.data.errors ?? [] : [];
  const codes = [...new Set(errors.flatMap(error => error.code === undefined ? [] : [error.code]))].slice(0, 5);
  const details = [`HTTP ${status}`];
  if (codes.length) details.push(`codes ${codes.join(", ")}`);
  if (invalidJson) details.push("invalid JSON response");
  let hint = "";
  if (operation === "D1 query" && errors.some(error =>
    /\bno such table:\s*(?:generations|active_generation|chunks)\b/i.test(error.message ?? ""))) {
    hint = " D1 index tables are missing; run pnpm db:migrate:remote for the configured database.";
  }
  return Object.assign(new Error(`${operation} failed (${details.join("; ")}); no automatic retry was made.${hint}`),
    { status });
}
export function cloudflareClient(environment = process.env, fetcher: typeof fetch = fetch): CloudflareClient {
  const account = environment.CLOUDFLARE_ACCOUNT_ID, token = environment.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to your 32-character account ID");
  if (!token?.trim() || /[\r\n]/.test(token)) throw new Error("Set CLOUDFLARE_API_TOKEN in the operator environment");
  return { account, async call(path, options = {}) {
    const { allowNotFound, ...request } = options;
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (request.body && !(request.body instanceof FormData)) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        ...request, headers, signal: AbortSignal.timeout(120_000), redirect: "error",
      });
    } catch (cause) { throw transportFailure(path, cause); }
    if (allowNotFound && response.status === 404) return null;
    let raw: unknown;
    try { raw = await response.json(); } catch (cause) {
      if (cause instanceof SyntaxError) throw requestFailure(path, response.status, undefined, true);
      throw transportFailure(path, cause);
    }
    const body = envelopeSchema.safeParse(raw);
    if (!response.ok || !body.success || !body.data.success) {
      throw requestFailure(path, response.status, raw);
    }
    return body.data.result;
  } };
}
