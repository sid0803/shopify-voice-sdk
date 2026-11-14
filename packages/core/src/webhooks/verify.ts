// Webhook verification for TechLadder's own outbound webhooks.
// Verified scheme: techladder-core/app/domain/developer_integrations/webhooks/service.py:198-217
// base = timestamp_bytes + b"." + raw_body
// digest = hex(HMAC_SHA256(secret, base)), header "sha256={digest}"
// Headers: X-TechLadder-Event-Id, X-TechLadder-Timestamp (iso_now), X-TechLadder-Signature, X-TechLadder-Api-Version
// Replay tolerance is UNVERIFIED (no check in backend code) — configurable, default 5 min.
// See techladder-sdk/docs/backend-gaps.md #1.

import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthError, ValidationError } from "../errors.js";

export interface VerifyWebhookInput {
  /** RAW request body bytes (do not re-serialize). */
  rawBody: Uint8Array | string;
  /** Request headers (any casing). */
  headers: Record<string, string | string[] | undefined>;
  /** Endpoint secret shown once at create (whsec_...). */
  secret: string;
  /**
   * Allowed clock skew in seconds. REQUIRED — no safe default.
   * Backend has no documented window (backend-gaps#1). Pass explicit value
   * agreed with senior (e.g. 300 for first week with skew logging).
   */
  toleranceSeconds: number;
  nowMs?: number;
}

export interface VerifiedWebhook {
  eventId: string;
  timestamp: string;
  apiVersion?: string;
}

function header(input: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const [k, v] of Object.entries(input)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

export function verifyWebhook(input: VerifyWebhookInput): VerifiedWebhook {
  const signature = header(input.headers, "x-techladder-signature");
  const timestamp = header(input.headers, "x-techladder-timestamp");
  const eventId = header(input.headers, "x-techladder-event-id");
  if (!signature || !timestamp || !eventId) {
    throw new ValidationError("Missing webhook signature headers", { code: "missing_signature" });
  }
  if (!input.secret) throw new AuthError("Missing webhook secret", { code: "missing_secret" });

  const raw = toBytes(input.rawBody);
  const base = Buffer.concat([Buffer.from(timestamp, "utf-8"), Buffer.from("."), Buffer.from(raw)]);
  const expected = `sha256=${createHmac("sha256", input.secret).update(base).digest("hex")}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  const match = a.length === b.length && timingSafeEqual(a, b);
  if (!match) throw new AuthError("Invalid webhook signature", { code: "bad_signature" });

  const tolerance = input.toleranceSeconds;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError("toleranceSeconds is required (see backend-gaps#1)", { code: "missing_tolerance" });
  }
  const tsMs = Date.parse(timestamp);
  if (!Number.isFinite(tsMs)) throw new ValidationError("Invalid webhook timestamp", { code: "bad_timestamp" });
  const now = input.nowMs ?? Date.now();
  if (Math.abs(now - tsMs) > tolerance * 1000) {
    throw new AuthError("Webhook timestamp outside tolerance", { code: "stale_timestamp" });
  }

  return { eventId, timestamp, apiVersion: header(input.headers, "x-techladder-api-version") };
}
