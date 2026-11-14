// Call-records + webhook-endpoints resources. Verified:
// techladder-core/app/domain/developer_integrations/call_records/router.py:23-53
// techladder-core/app/domain/developer_integrations/webhooks/router.py:26-103

import type { TechLadderHttpClient } from "../http.js";
import type { ApiEnvelope, Pagination } from "./envelope.js";

export class CallRecordsResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  async list(opts: { start_date: string; end_date: string; agent_id?: string[]; page?: number; page_size?: number }): Promise<{ items: Array<Record<string, unknown>>; pagination: Pagination }> {
    const params = new URLSearchParams({ start_date: opts.start_date, end_date: opts.end_date });
    params.set("page", String(opts.page ?? 1));
    params.set("page_size", String(opts.page_size ?? 50));
    for (const a of opts.agent_id ?? []) params.append("agent_id", a);
    const env = await this.http.request<ApiEnvelope<{ items: Array<Record<string, unknown>>; pagination: Pagination }>>({
      method: "GET",
      path: `/call-records?${params.toString()}`,
    });
    return env.data;
  }
}

export interface WebhookEndpoint {
  webhook_endpoint_id: string;
  url: string;
  description?: string | null;
  events: string[];
  status: string;
  created_at?: string;
  signing_secret?: string;
}

export class WebhookEndpointsResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  async create(payload: { url: string; description?: string; events: string[] }): Promise<WebhookEndpoint> {
    const env = await this.http.request<ApiEnvelope<WebhookEndpoint>>({
      method: "POST",
      path: "/webhook-endpoints",
      body: payload,
    });
    return env.data;
  }

  async list(): Promise<{ items: WebhookEndpoint[] }> {
    const env = await this.http.request<ApiEnvelope<{ items: WebhookEndpoint[] }>>({
      method: "GET",
      path: "/webhook-endpoints",
    });
    return env.data;
  }

  async update(id: string, payload: { url?: string; description?: string | null; events?: string[]; status?: string }): Promise<WebhookEndpoint> {
    const env = await this.http.request<ApiEnvelope<WebhookEndpoint>>({
      method: "PATCH",
      path: `/webhook-endpoints/${encodeURIComponent(id)}`,
      body: payload,
    });
    return env.data;
  }

  async remove(id: string): Promise<{ webhook_endpoint_id: string; deleted: boolean }> {
    const env = await this.http.request<ApiEnvelope<{ webhook_endpoint_id: string; deleted: boolean }>>({
      method: "DELETE",
      path: `/webhook-endpoints/${encodeURIComponent(id)}`,
    });
    return env.data;
  }

  async test(id: string): Promise<{ webhook_endpoint_id: string; event_id: string; event: string; delivery_status: string }> {
    const env = await this.http.request<ApiEnvelope<{ webhook_endpoint_id: string; event_id: string; event: string; delivery_status: string }>>({
      method: "POST",
      path: `/webhook-endpoints/${encodeURIComponent(id)}/test`,
      body: {},
    });
    return env.data;
  }
}
