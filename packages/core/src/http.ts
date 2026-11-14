// HTTP layer for @techladder/core.
// Verified backend: Bearer sk_... auth, JSON envelope, no public rate-limit docs.
// See techladder-sdk/docs/api.md sections 1-6.
// Rules: timeout on every request; retry only network errors, 429, 5xx with
// exponential backoff + jitter and Retry-After; never retry 4xx (except via
// 429/5xx path); never auto-retry non-idempotent creates without a key;
// never log the API key.

import {
  RateLimitError,
  ServerError,
  TechLadderError,
  toTypedError,
} from "./errors.js";

export type TechLadderEnv = "production" | "staging";

export interface TechLadderClientOptions {
  apiKey: string;
  /**
   * Full base URL, e.g. https://api.staging.techladder.ai.
   * REQUIRED — no placeholder default. Backend hosts are UNVERIFIED (backend-gaps#10).
   * Pass via TECHLADDER_BASE_URL env. Fail fast if missing.
   */
  baseUrl: string;
  /** Default per-request timeout. */
  timeoutMs?: number;
  /** Default max retries for retryable failures. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

// TODO(backend-gaps#10): no default hosts — caller must pass baseUrl explicitly.

const API_PREFIX = "/api/v1/public";

export interface RequestOptions {
  method?: string;
  path: string;
  /** JSON body (object) or raw string. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Idempotency key for creates (PUT /call-batches body key).
   * Verified: techladder-core/app/domain/developer_integrations/call_batches/router.py:47-68.
   * When set on POST/PUT, retry is allowed; without it, non-GET is attempted once.
   */
  idempotencyKey?: string;
  /** Set to "text" for CSV export. Default "json". */
  responseType?: "json" | "text";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function backoffWithJitterMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs + Math.floor(Math.random() * 250);
  const base = Math.min(1000 * 2 ** attempt, 10_000);
  return base + Math.floor(Math.random() * 250);
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function getRequestIdFromHeaders(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "x-requestid", "x-techladder-request-id"]) {
    const v = headers.get(name);
    if (v) return v;
  }
  return undefined;
}

export class TechLadderHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TechLadderClientOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required (use staging key from env)");
    if (!opts.baseUrl) throw new Error("baseUrl is required (TECHLADDER_BASE_URL, see backend-gaps#10)");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const method = (opts.method ?? "GET").toUpperCase();
    // Never auto-retry non-idempotent creates unless a key is set.
    const retryableMethod = isSafeMethod(method) || Boolean(opts.idempotencyKey);
    const maxRetries = retryableMethod ? (opts.maxRetries ?? this.maxRetries) : 0;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      // Never log this object: it carries the secret.
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };

    let body: string | undefined;
    if (opts.body !== undefined) {
      body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    let attempt = 0;
    // Retry loop: network errors, 429, 5xx only. Never 4xx (except 429 handled above).
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${API_PREFIX}${opts.path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        const requestId = getRequestIdFromHeaders(res.headers);
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));

        if (res.status === 429 || res.status >= 500) {
          const payload = await this.readBody(res).catch(() => undefined);
          if (attempt < maxRetries) {
            attempt += 1;
            await sleep(backoffWithJitterMs(attempt, retryAfterMs));
            continue;
          }
          if (res.status === 429) {
            const secs = retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
            throw new RateLimitError("Rate limited", { status: 429, requestId, retryAfterSeconds: secs });
          }
          throw toTypedError(res.status, payload, { requestId });
        }

        if (!res.ok) {
          const payload = await this.readBody(res).catch(() => undefined);
          throw toTypedError(res.status, payload, { requestId });
        }

        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        if (opts.responseType === "text") return text as T;
        return JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof TechLadderError || err instanceof ServerError) throw err;
        // Network error / timeout / abort: retry only if the method is retryable.
        const retryable = this.isNetworkError(err);
        if (retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(backoffWithJitterMs(attempt));
          continue;
        }
        if (retryable) {
          throw new ServerError(err instanceof Error ? `Network error: ${err.message}` : "Network error", {});
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 500) };
    }
  }

  private isNetworkError(err: unknown): boolean {
    if (err instanceof Error) {
      return (
        err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        err.message.toLowerCase().includes("fetch failed") ||
        err.message.toLowerCase().includes("network")
      );
    }
    return false;
  }
}
