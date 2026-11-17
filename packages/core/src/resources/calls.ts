// Single-call resource. Verified:
// techladder-core/app/domain/developer_integrations/calls/router.py:31-161
// Shapes in techladder-sdk/docs/api.md section 3.

import type { TechLadderHttpClient } from "../http.js";
import type { ApiEnvelope, Pagination } from "./envelope.js";

export interface CallDetail {
  /** Null until the dialer assigns one (B1-a: single calls route via batches). batch_id is the stable handle. */
  call_id: string | null;
  batch_id?: string | null;
  external_id?: string | null;
  phone_number?: string | null;
  status?: string | null;
  /** True on 200 replay (same idempotency key); false on 202 first create. */
  idempotent?: boolean;
  created_at?: string | null;
}

function assertIdempotencyKey(key: string): void {
  // BUG-013: backend degrades " " to non-idempotent instead of 422.
  // Fail fast in the SDK so a caller that thinks it sent idempotency gets it.
  if (!key.trim()) throw new Error("idempotency_key must not be blank");
  if (key.length > 128) throw new Error("idempotency_key must be 1-128 chars");
}

export class CallsResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  async create(payload: Record<string, unknown>): Promise<CallDetail> {
    const rawKey = payload["idempotency_key"] ?? payload["idempotencyKey"];
    if (rawKey !== undefined && rawKey !== null) assertIdempotencyKey(String(rawKey));
    const env = await this.http.request<ApiEnvelope<CallDetail>>({
      method: "POST",
      path: "/calls",
      body: payload,
    });
    return env.data;
  }

  async createTest(payload: Record<string, unknown>): Promise<CallDetail> {
    const env = await this.http.request<ApiEnvelope<CallDetail>>({
      method: "POST",
      path: "/calls/test",
      body: payload,
    });
    return env.data;
  }

  async list(filters: Record<string, string | number | undefined> = {}): Promise<{ items: CallDetail[]; pagination: Pagination }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v !== undefined) params.set(k, String(v));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const env = await this.http.request<ApiEnvelope<{ items: CallDetail[]; pagination: Pagination }>>({
      method: "GET",
      path: `/calls${suffix}`,
    });
    return env.data;
  }

  async get(callId: string): Promise<CallDetail> {
    const env = await this.http.request<ApiEnvelope<CallDetail>>({
      method: "GET",
      path: `/calls/${encodeURIComponent(callId)}`,
    });
    return env.data;
  }

  async getResult(callId: string): Promise<Record<string, unknown>> {
    const env = await this.http.request<ApiEnvelope<Record<string, unknown>>>({
      method: "GET",
      path: `/calls/${encodeURIComponent(callId)}/result`,
    });
    return env.data;
  }

  async getTranscript(callId: string): Promise<Record<string, unknown>> {
    const env = await this.http.request<ApiEnvelope<Record<string, unknown>>>({
      method: "GET",
      path: `/calls/${encodeURIComponent(callId)}/transcript`,
    });
    return env.data;
  }

  async getRecordingUrl(callId: string, expiresInSeconds?: number): Promise<{ recording_url: string }> {
    const env = await this.http.request<ApiEnvelope<{ recording_url: string }>>({
      method: "POST",
      path: `/calls/${encodeURIComponent(callId)}/recording-url`,
      body: expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds },
    });
    return env.data;
  }
}
