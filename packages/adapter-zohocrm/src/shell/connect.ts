// Zoho connect flow (P2 shell logic, framework-free).
// The thin route/UI layer supplies clientId/secret/redirectUri from env and a
// per-request state; this module holds the OAuth orchestration so it is fully
// unit-testable with mocked HTTP. Secrets are never logged — this module logs
// nothing at all.
import { randomBytes } from "node:crypto";
import { buildAuthorizeUrl, exchangeCodeForTokens } from "../oauth.js";
import type { ZohoConnectionStore } from "../stores.js";

export interface ZohoConnectRequest {
  clientId: string;
  redirectUri: string;
  dataCenter: string;
  scope?: string;
  /** CSRF value the shell stores in session. Generated when absent. */
  state?: string;
}

export interface ZohoConnectChallenge {
  url: string;
  state: string;
}

/** Step 1: merchant clicks Connect → redirect them at url, remember state. */
export function beginZohoConnect(input: ZohoConnectRequest): ZohoConnectChallenge {
  const state = input.state ?? randomBytes(16).toString("hex");
  return {
    url: buildAuthorizeUrl({
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      dataCenter: input.dataCenter,
      ...(input.scope ? { scope: input.scope } : {}),
      state,
    }),
    state,
  };
}

export interface ZohoCallbackInput {
  store: ZohoConnectionStore;
  orgId: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  dataCenter: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/**
 * Step 2: Zoho redirects back with a code → exchange, persist the token pair
 * (encrypted by the Mongo store; plaintext in memory only), mark connected.
 */
export async function completeZohoConnect(input: ZohoCallbackInput): Promise<{ orgId: string; dataCenter: string }> {
  const tokens = await exchangeCodeForTokens({
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    dataCenter: input.dataCenter,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri: input.redirectUri,
    code: input.code,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  await input.store.save({
    orgId: input.orgId,
    dataCenter: input.dataCenter,
    accessTokenEnc: tokens.accessToken,
    refreshTokenEnc: tokens.refreshToken,
    fieldMap: {},
    status: "connected",
    createdAt: now,
    updatedAt: now,
  });
  return { orgId: input.orgId.toLowerCase(), dataCenter: input.dataCenter };
}

/** Disconnect: drop the row (tokens with it). Ledger history is untouched. */
export async function disconnectZohoOrg(store: ZohoConnectionStore, orgId: string): Promise<void> {
  await store.remove?.(orgId);
}

export async function zohoConnectionStatus(
  store: ZohoConnectionStore,
  orgId: string,
): Promise<"connected" | "disconnected" | "not-connected"> {
  const rec = await store.get(orgId);
  if (!rec) return "not-connected";
  return rec.status;
}
