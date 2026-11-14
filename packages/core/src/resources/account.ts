// Account resource — validates a pasted sk_ key via GET /me.
// Verified: techladder-core/app/domain/developer_integrations/account_api/router.py:63-73
// (GET /me) returns {account_id, name, environment, features, limits}.
// Used by the per-shop settings Connect step (senior item 0A/4).

import { TechLadderHttpClient } from "../http.js";
import type { ApiEnvelope } from "./envelope.js";

export interface DeveloperAccount {
  account_id: string;
  name: string;
  environment: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
}

export class AccountResource {
  constructor(private readonly http: TechLadderHttpClient) {}

  /** GET /me with an arbitrary key (Connect-step validation). No retries. */
  async validate(apiKey: string, baseUrl: string): Promise<DeveloperAccount> {
    const probe = new TechLadderHttpClient({ apiKey, baseUrl, maxRetries: 0 });
    const env = await probe.request<ApiEnvelope<DeveloperAccount>>({ method: "GET", path: "/me" });
    if (!env.data?.account_id) throw new Error("Account response missing account_id");
    return env.data;
  }

  /** GET /me with this resource's own client. */
  async me(): Promise<DeveloperAccount> {
    const env = await this.http.request<ApiEnvelope<DeveloperAccount>>({ method: "GET", path: "/me" });
    return env.data;
  }
}
