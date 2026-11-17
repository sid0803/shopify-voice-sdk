// Call-batch resource. Verified contracts:
// techladder-core/app/domain/developer_integrations/call_batches/router.py
// techladder-core/app/domain/developer_integrations/call_batches/schemas.py
// Full shapes in techladder-sdk/docs/api.md section 2.

import type { TechLadderHttpClient } from "../http.js";
import type { ApiEnvelope, Pagination } from "./envelope.js";

export interface BatchContact {
  external_id: string;
  name?: string;
  phone_number: string;
  alternate_number?: string;
  metadata?: Record<string, unknown>;
  status?: string;
}

export interface CreateBatchRequest {
  agent_id?: string;
  agent_name?: string;
  version_id?: string;
  version_name?: string;
  voice?: string;
  did_number_id?: string;
  interruption: boolean;
  use_alternate_number: boolean;
  start_mode: "manual" | "immediate" | "scheduled";
  scheduled_at?: string;
  schedule_date: string;
  schedule_time: string;
  timezone: string;
  concurrency?: number;
  callback_url?: string;
  metadata?: Record<string, unknown>;
  deduplicate_by_phone?: boolean;
  recording_enabled?: boolean;
  max_duration_seconds_per_call?: number;
  contacts: BatchContact[];
}

export interface IdempotentCreateBatchRequest extends CreateBatchRequest {
  /** Caller-supplied key, 1-128 chars. Same account + key returns existing batch. */
  idempotency_key: string;
}

function assertIdempotencyKey(key: string): void {
  // Backend BUG-013: whitespace-only keys degrade to non-idempotent.
  if (!key.trim()) throw new Error("idempotency_key must not be blank");
  if (key.length > 128) throw new Error("idempotency_key must be 1-128 chars");
}

export interface CreateBatchResponse {
  batch_id: string;
  agent_id: string;
  version_id?: string | null;
  status: string;
  start_mode: string;
  total_contacts: number;
  accepted_contacts: number;
  rejected_contacts: number;
  validation_errors: Array<{ index: number; external_id?: string | null; field: string; message: string }>;
  concurrency?: number | null;
  created_at: string;
  idempotent: boolean;
}

export interface BatchListItem {
  batch_id: string;
  agent_id: string;
  version_id?: string | null;
  status: string;
  total_contacts: number;
  queued: number;
  in_progress: number;
  completed: number;
  failed: number;
  cancelled: number;
  created_at: string;
}

export interface BatchCallItem {
  call_id: string;
  batch_id?: string | null;
  contact_id?: string | null;
  external_id?: string | null;
  phone_number?: string | null;
  agent_id?: string | null;
  status?: string | null;
  call_status?: string | null;
  duration_seconds?: number | null;
  summary?: string | null;
  outcomes?: Record<string, unknown> | null;
  recording_available?: boolean | null;
  recording_url?: string | null;
  llm_transcript?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export class BatchesResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  /** POST /call-batches — non-idempotent. Retried by http layer only if idempotencyKey passed. */
  async create(payload: CreateBatchRequest, opts: { idempotencyKey?: string } = {}): Promise<CreateBatchResponse> {
    const env = await this.http.request<ApiEnvelope<CreateBatchResponse>>({
      method: "POST",
      path: "/call-batches",
      body: payload,
      idempotencyKey: opts.idempotencyKey,
    });
    return env.data;
  }

  /** PUT /call-batches — idempotent via body idempotency_key. 201 first, 200 + idempotent:true on repeat. */
  async createIdempotent(payload: IdempotentCreateBatchRequest): Promise<CreateBatchResponse> {
    assertIdempotencyKey(payload.idempotency_key);
    const env = await this.http.request<ApiEnvelope<CreateBatchResponse>>({
      method: "PUT",
      path: "/call-batches",
      body: payload,
      idempotencyKey: payload.idempotency_key,
    });
    return env.data;
  }

  async list(filters: { agent_id?: string; status?: string; limit?: number; page?: number } = {}): Promise<{ items: BatchListItem[]; pagination: Pagination }> {
    const env = await this.http.request<ApiEnvelope<{ items: BatchListItem[]; pagination: Pagination }>>({
      method: "GET",
      path: `/call-batches${qs({ agent_id: filters.agent_id, status: filters.status, limit: filters.limit ?? 50, page: filters.page ?? 1 })}`,
    });
    return env.data;
  }

  async get(batchId: string): Promise<BatchListItem & { scheduled_at?: string | null }> {
    const env = await this.http.request<ApiEnvelope<BatchListItem & { scheduled_at?: string | null }>>({
      method: "GET",
      path: `/call-batches/${encodeURIComponent(batchId)}`,
    });
    return env.data;
  }

  async listCallsByExternalId(externalId: string, opts: { status?: string; limit?: number; page?: number } = {}): Promise<{ items: BatchCallItem[]; pagination: Pagination }> {
    const env = await this.http.request<ApiEnvelope<{ items: BatchCallItem[]; pagination: Pagination }>>({
      method: "GET",
      path: `/call-batches/calls${qs({ external_id: externalId, status: opts.status, limit: opts.limit ?? 100, page: opts.page ?? 1 })}`,
    });
    return env.data;
  }

  async listCallsInBatch(batchId: string, opts: { status?: string; external_id?: string; limit?: number; page?: number } = {}): Promise<{ items: BatchCallItem[]; pagination: Pagination }> {
    const env = await this.http.request<ApiEnvelope<{ items: BatchCallItem[]; pagination: Pagination }>>({
      method: "GET",
      path: `/call-batches/${encodeURIComponent(batchId)}/calls${qs({ status: opts.status, external_id: opts.external_id, limit: opts.limit ?? 100, page: opts.page ?? 1 })}`,
    });
    return env.data;
  }

  async listResults(batchId: string, opts: { outcome?: string; status?: string; limit?: number; page?: number } = {}): Promise<{ items: BatchCallItem[]; pagination: Pagination; status?: string | null }> {
    const env = await this.http.request<ApiEnvelope<{ items: BatchCallItem[]; pagination: Pagination; status?: string | null }>>({
      method: "GET",
      path: `/call-batches/${encodeURIComponent(batchId)}/results${qs({ outcome: opts.outcome, status: opts.status, limit: opts.limit ?? 100, page: opts.page ?? 1 })}`,
    });
    return env.data;
  }

  async start(batchId: string, concurrency?: number): Promise<{ batch_id: string; status: string }> {
    const env = await this.http.request<ApiEnvelope<{ batch_id: string; status: string }>>({
      method: "POST",
      path: `/call-batches/${encodeURIComponent(batchId)}/start`,
      body: concurrency === undefined ? {} : { concurrency },
    });
    return env.data;
  }

  async cancel(batchId: string, opts: { cancel_active_calls?: boolean; reason?: string } = {}): Promise<{ batch_id: string; status: string }> {
    const env = await this.http.request<ApiEnvelope<{ batch_id: string; status: string }>>({
      method: "POST",
      path: `/call-batches/${encodeURIComponent(batchId)}/cancel`,
      body: { cancel_active_calls: opts.cancel_active_calls ?? false, reason: opts.reason },
    });
    return env.data;
  }

  async exportResultsCsv(batchId: string): Promise<string> {
    return this.http.request<string>({
      method: "GET",
      path: `/call-batches/${encodeURIComponent(batchId)}/results/export.csv`,
      responseType: "text",
    });
  }
}
