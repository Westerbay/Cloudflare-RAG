/** Operator-only REST calls. No credential values or provider response bodies are logged. */
export function cloudflareClient(environment = process.env, fetcher = fetch) {
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw new Error("Set CLOUDFLARE_ACCOUNT_ID to your 32-character account ID");
  if (!token?.trim() || /[\r\n]/.test(token)) throw new Error("Set CLOUDFLARE_API_TOKEN in the operator environment");
  return {
    account,
    async call(path, options = {}) {
      const headers = new Headers(options.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        ...options, headers, signal: AbortSignal.timeout(120_000), redirect: "error",
      });
      if (options.allowNotFound && response.status === 404) return null;
      let body;
      try { body = await response.json(); } catch { throw new Error(`Cloudflare returned HTTP ${response.status} with invalid JSON`); }
      if (!response.ok || body?.success !== true) {
        const error = new Error(`Cloudflare request failed (HTTP ${response.status}); no automatic retry was made`);
        error.status = response.status;
        throw error;
      }
      return body.result;
    },
  };
}
