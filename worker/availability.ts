export type CloudflareService = "workers_ai" | "d1" | "vectorize";

// Unknown failures are probed by the next request after one minute, never by a timer.
const PROBE_DELAY_MS = 60_000;

export interface Pause {
  service: CloudflareService;
  reason: "quota_exhausted" | "service_unavailable";
  retryAt: number;
  resetAt?: number;
}

export class ServiceSleeping extends Error {
  pause: Pause;
  constructor(pause: Pause) { super("Cloudflare service is unavailable"); this.pause = pause; }
}

function dailyQuota(service: CloudflareService, error: unknown): boolean {
  // Match documented exhaustion signals, not every 429 (AI 3040 is temporary capacity).
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    const code = "code" in error ? error.code : undefined;
    if (service === "workers_ai" && (code === 3036 || code === "3036" || /\b3036\b/.test(error.message))) return true;
    if (service === "d1" && /exceeded D1's free tier daily row (read|write) limit/i.test(error.message)) return true;
  }
  return false;
}

/** Best-effort isolate-local pause; Cloudflare remains the account-wide quota authority. */
export class ServiceAvailability {
  private pause?: Pause;

  check(now: number): void {
    if (this.pause && now < this.pause.retryAt) throw new ServiceSleeping(this.pause);
    this.pause = undefined;
  }

  async run<T>(service: CloudflareService, operation: () => Promise<T>, clock: () => number): Promise<T> {
    this.check(clock());
    try { return await operation(); }
    catch (error) {
      if (error instanceof ServiceSleeping) throw error;
      const now = clock();
      let resetAt: number | undefined;
      if (dailyQuota(service, error)) {
        const date = new Date(now);
        resetAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      }
      const pause: Pause = {
        service, reason: resetAt ? "quota_exhausted" : "service_unavailable",
        retryAt: resetAt ?? now + PROBE_DELAY_MS,
        ...(resetAt ? { resetAt } : {}),
      };
      // An overlapping transient failure must not shorten an already known quota pause.
      if (!this.pause || pause.retryAt > this.pause.retryAt) this.pause = pause;
      throw new ServiceSleeping(this.pause);
    }
  }
}
