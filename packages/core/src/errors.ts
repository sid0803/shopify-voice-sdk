// Typed errors for @techladder/core.
// Backend envelope (verified): { status_code, message, error: { code, details[] }, data }
// See techladder-sdk/docs/api.md section 6 and
// techladder-core/app/domain/developer_integrations/response_schemas.py:6-8
// requestId is UNVERIFIED: we read it from headers/body when present, else undefined.

export interface TechLadderErrorOptions {
  status?: number;
  code?: string;
  requestId?: string;
  details?: string[];
}

export class TechLadderError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly details: string[];

  constructor(message: string, opts: TechLadderErrorOptions = {}) {
    super(message);
    this.name = "TechLadderError";
    this.status = opts.status;
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.details = opts.details ?? [];
  }
}

export class AuthError extends TechLadderError {
  constructor(message: string, opts: TechLadderErrorOptions = {}) {
    super(message, opts);
    this.name = "AuthError";
  }
}

export class RateLimitError extends TechLadderError {
  readonly retryAfterSeconds?: number;
  constructor(message: string, opts: TechLadderErrorOptions & { retryAfterSeconds?: number } = {}) {
    super(message, opts);
    this.name = "RateLimitError";
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class ValidationError extends TechLadderError {
  constructor(message: string, opts: TechLadderErrorOptions = {}) {
    super(message, opts);
    this.name = "ValidationError";
  }
}

export class ServerError extends TechLadderError {
  constructor(message: string, opts: TechLadderErrorOptions = {}) {
    super(message, opts);
    this.name = "ServerError";
  }
}

export interface ParsedErrorBody {
  message: string;
  code?: string;
  details: string[];
  requestId?: string;
}

/** Extract message/code/details from the verified backend envelope. Never throws. */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  const fallback: ParsedErrorBody = { message: "Request failed", details: [] };
  if (typeof body !== "object" || body === null) {
    return typeof body === "string" && body ? { message: body.slice(0, 300), details: [] } : fallback;
  }
  const b = body as Record<string, unknown>;
  // FastAPI error shape: {"detail": "reason" or [{loc, msg}]} — surface it.
  if (typeof b["detail"] === "string" && (b["detail"] as string)) {
    return { message: b["detail"] as string, details: [] };
  }
  // FastAPI request-validation shape: {"detail": [{loc, msg, type}]} — surface it.
  if (Array.isArray(b["detail"])) {    const details = (b["detail"] as Array<Record<string, unknown>>)
      .map((d) => {
        const loc = Array.isArray(d["loc"]) ? (d["loc"] as unknown[]).join(".") : "";
        const msg = typeof d["msg"] === "string" ? (d["msg"] as string) : "invalid";
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean)
      .slice(0, 10);
    return { message: details[0] ?? "Validation failed", details };
  }
  const message =
    (typeof b["message"] === "string" && b["message"]) || fallback.message;
  const err =
    typeof b["error"] === "object" && b["error"] !== null
      ? (b["error"] as Record<string, unknown>)
      : undefined;
  const code = typeof err?.["code"] === "string" ? (err["code"] as string) : undefined;
  const rawDetails = err?.["details"];
  const details = Array.isArray(rawDetails)
    ? rawDetails.filter((d): d is string => typeof d === "string")
    : [];
  // requestId: UNVERIFIED location — check common spots, else undefined.
  const requestId =
    (typeof b["request_id"] === "string" && (b["request_id"] as string)) ||
    (typeof b["requestId"] === "string" && (b["requestId"] as string)) ||
    undefined;
  return { message, code, details, requestId };
}

/** Map HTTP status + parsed body to a typed error. 4xx (except 401/403/429) -> ValidationError. */
export function toTypedError(
  status: number,
  body: unknown,
  opts: { requestId?: string; retryAfterSeconds?: number } = {},
): TechLadderError {
  const parsed = parseErrorBody(body);
  const requestId = opts.requestId ?? parsed.requestId;
  if (status === 401 || status === 403) {
    return new AuthError(parsed.message, { status, code: parsed.code, requestId, details: parsed.details });
  }
  if (status === 429) {
    return new RateLimitError(parsed.message, {
      status, code: parsed.code, requestId, details: parsed.details,
      retryAfterSeconds: opts.retryAfterSeconds,
    });
  }
  if (status >= 400 && status < 500) {
    return new ValidationError(parsed.message, { status, code: parsed.code, requestId, details: parsed.details });
  }
  return new ServerError(parsed.message, { status, code: parsed.code, requestId, details: parsed.details });
}
