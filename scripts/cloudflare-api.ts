/** Operator-only REST calls. Never log credentials or provider response bodies. */
import { z } from "zod";
export interface CloudflareCallOptions extends RequestInit { allowNotFound?: boolean }
export interface CloudflareClient {
  account: string;
  call(path: string, options?: CloudflareCallOptions): Promise<unknown>;
}
const envelopeSchema = z.object({ success: z.boolean(), result: z.unknown().optional() });
export function cloudflareClient(environment = process.env, fetcher: typeof fetch = fetch): CloudflareClient {
  const account = environment.CLOUDFLARE_ACCOUNT_ID, token = environment.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to your 32-character account ID");
  if (!token?.trim() || /[\r\n]/.test(token)) throw new Error("Set CLOUDFLARE_API_TOKEN in the operator environment");
  return { account, async call(path, options = {}) {
    const { allowNotFound, ...request } = options;
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (request.body && !(request.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      ...request, headers, signal: AbortSignal.timeout(120_000), redirect: "error",
    });
    if (allowNotFound && response.status === 404) return null;
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new Error(`Cloudflare returned HTTP ${response.status} with invalid JSON`); }
    const body = envelopeSchema.safeParse(raw);
    if (!response.ok || !body.success || !body.data.success) {
      throw Object.assign(new Error(`Cloudflare request failed (HTTP ${response.status}); no automatic retry was made`),
        { status: response.status });
    }
    return body.data.result;
  } };
}
