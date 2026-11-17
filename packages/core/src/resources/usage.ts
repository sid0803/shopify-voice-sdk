// Usage resource — GET /public/usage account minute-equivalent consumption (B3).
// Verified: techladder-core/app/domain/developer_integrations/usage/router.py,
// service.py, schemas.py on branch feat/sdk-usage-endpoint (dd86980).
//
// Backend notes applied here:
// - BUG-002: endpoint recomputes full lifetime history per request (no cache).
//   SDK callers must NOT poll; cache for minutes, fetch on demand only.
// - BUG-006: first GET mints a credit doc (write side effect). Expected.
// - BUG-007: empty client_id would read a shared "" doc. Guarded here.
// - BUG-008: backend returns {**free_credit, consumption} passthrough.
//   This SDK uses an explicit tier shape so future stored keys do not leak.

import type { TechLadderHttpClient } from "../http.js";
import type { ApiEnvelope } from "./envelope.js";

export interface UsageTier {
  limit?: number | null;
  consumption?: number | null;
  remaining?: number | null;
  status?: string | null;
}

export interface AccountUsage {
  account_id: string;
  usage: {
    free_credit?: UsageTier | null;
    paid_credit?: UsageTier | null;
    skip_credit?: boolean | null;
  };
  computed_at: string;
}

export class UsageResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  /** GET /usage — lifetime-to-date consumption. Do not poll; cache the result. */
  async get(): Promise<AccountUsage> {
    const env = await this.http.request<ApiEnvelope<AccountUsage>>({
      method: "GET",
      path: "/usage",
    });
    if (!env.data?.account_id?.trim()) throw new Error("Usage response missing account_id");
    return env.data;
  }
}
