// Zoho OAuth 2.0 for the adapter (P1).
// One TechLadder OAuth client; per-org access + refresh token pairs.
// Tokens are secrets: this module never logs them — it never logs at all.
// At-rest encryption (`v1.` AES-256-GCM envelope) is applied by the P2 stores,
// which reuse the envelope format in adapter-shopify's mongo/crypto.ts.
import { ZOHO_ACCOUNTS_HOST } from "./zohoConfig.js";

export type ZohoDataCenter = "in" | "com" | "eu" | "com.au";

/** Throws on unknown data center — never default it silently (wrong DC = 404s). */
export function assertDataCenter(dataCenter: string): asserts dataCenter is ZohoDataCenter {
  if (!Object.hasOwn(ZOHO_ACCOUNTS_HOST, dataCenter)) {
    throw new Error(`Unknown Zoho data center: ${dataCenter}`);
  }
}

export function accountsHost(dataCenter: string): string {
  assertDataCenter(dataCenter);
  const host = ZOHO_ACCOUNTS_HOST[dataCenter];
  if (!host) throw new Error(`No accounts host for data center: ${dataCenter}`);
  return host;
}

/** Per-org token pair. Both fields are secrets; the store encrypts them. */
export interface ZohoTokenRecord {
  orgId: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAtMs: number;
  dataCenter: ZohoDataCenter;
  /** Zoho api_domain from the grant (informational, non-secret). */
  apiDomain?: string;
}

export interface ZohoTokenStore {
  get(orgId: string): ZohoTokenRecord | Promise<ZohoTokenRecord | null> | null;
  save(record: ZohoTokenRecord): void | Promise<void>;
  remove?(orgId: string): void | Promise<void>;
}

export class InMemoryZohoTokenStore implements ZohoTokenStore {
  private readonly map = new Map<string, ZohoTokenRecord>();
  get(orgId: string): ZohoTokenRecord | null {
    return this.map.get(orgId.toLowerCase()) ?? null;
  }
  save(record: ZohoTokenRecord): void {
    if (!record.accessToken || !record.refreshToken) throw new Error("Refusing to store empty tokens");
    this.map.set(record.orgId.toLowerCase(), record);
  }
  remove(orgId: string): void {
    this.map.delete(orgId.toLowerCase());
  }
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  /** Space-delimited scopes; defaults to ZOHO_SCOPES. */
  scope?: string;
  dataCenter: string;
  /** Opaque CSRF value round-tripped by Zoho. */
  state: string;
}

/** Connect URL the merchant opens. access_type=offline yields a refresh token. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    scope: input.scope ?? "ZohoCRM.modules.ALL,ZohoCRM.settings.ALL",
    redirect_uri: input.redirectUri,
    access_type: "offline",
    prompt: "consent",
    state: input.state,
  });
  return `https://${accountsHost(input.dataCenter)}/oauth/v2/auth?${params.toString()}`;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Zoho returns seconds; tolerate ms in case the contract changes. */
  expires_in_sec?: boolean;
  api_domain?: string;
  scope?: string;
  error?: string;
}

export class ZohoOAuthError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(`Zoho OAuth failed: ${code}${detail ? ` — ${detail}` : ""}`);
    this.name = "ZohoOAuthError";
    this.code = code;
  }
}

function toForm(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function postToken(
  fetchImpl: typeof fetch,
  dataCenter: string,
  body: Record<string, string>,
): Promise<TokenEndpointResponse> {
  const res = await fetchImpl(`https://${accountsHost(dataCenter)}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm(body),
    signal: AbortSignal.timeout(15_000),
  });
  let parsed: TokenEndpointResponse;
  try {
    parsed = (await res.json()) as TokenEndpointResponse;
  } catch {
    throw new ZohoOAuthError("bad_response", `status ${res.status}`);
  }
  if (!res.ok || parsed.error || !parsed.access_token) {
    throw new ZohoOAuthError(parsed.error ?? "bad_response", `status ${res.status}`);
  }
  return parsed;
}

/**
 * Zoho `expires_in` is documented in seconds. If a value ever arrives in ms
 * (larger than any plausible seconds TTL), treat it as ms rather than minting
 * a token that lives for decades. Assumption — recheck against Zoho docs.
 */
export function expiresAtMs(expiresIn: number, nowMs = Date.now()): number {
  const seconds = expiresIn > 100_000 ? Math.floor(expiresIn / 1000) : expiresIn;
  return nowMs + seconds * 1000;
}

export interface TokenFetchInput {
  fetchImpl?: typeof fetch;
  dataCenter: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  nowMs?: number;
}

/** Exchange the authorization code for the org's token pair (connect time). */
export async function exchangeCodeForTokens(input: TokenFetchInput): Promise<Omit<ZohoTokenRecord, "orgId">> {
  const parsed = await postToken(input.fetchImpl ?? fetch, input.dataCenter, {
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  if (!parsed.refresh_token) throw new ZohoOAuthError("missing_refresh_token", "reconnect with prompt=consent");
  assertDataCenter(input.dataCenter);
  return {
    accessToken: parsed.access_token ?? "",
    refreshToken: parsed.refresh_token,
    expiresAtMs: expiresAtMs(parsed.expires_in ?? 3600, input.nowMs),
    dataCenter: input.dataCenter,
    ...(parsed.api_domain ? { apiDomain: parsed.api_domain } : {}),
  };
}

export interface TokenRefreshInput {
  fetchImpl?: typeof fetch;
  dataCenter: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  nowMs?: number;
}

/**
 * Refresh an access token. Zoho does not always return a new refresh token —
 * the caller keeps the existing one in that case.
 */
export async function refreshAccessToken(input: TokenRefreshInput): Promise<{ accessToken: string; refreshToken: string; expiresAtMs: number }> {
  const parsed = await postToken(input.fetchImpl ?? fetch, input.dataCenter, {
    grant_type: "refresh_token",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
  });
  return {
    accessToken: parsed.access_token ?? "",
    refreshToken: parsed.refresh_token ?? input.refreshToken,
    expiresAtMs: expiresAtMs(parsed.expires_in ?? 3600, input.nowMs),
  };
}

/** True when the token expires within the skew window — refresh before use. */
export function expiresSoon(record: Pick<ZohoTokenRecord, "expiresAtMs">, nowMs = Date.now(), skewMs = 60_000): boolean {
  return record.expiresAtMs - nowMs <= skewMs;
}

export interface EnsureFreshTokenInput {
  store: ZohoTokenStore;
  orgId: string;
  dataCenter: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
  skewMs?: number;
}

/**
 * Org-isolated token getter for API clients. Returns the cached token when
 * fresh; refreshes, persists and returns the new one otherwise. Throws when
 * the org has never connected — the shell turns that into a reconnect prompt.
 */
export async function ensureFreshToken(input: EnsureFreshTokenInput): Promise<string> {
  const stored = await input.store.get(input.orgId);
  if (!stored) throw new ZohoOAuthError("not_connected", `org ${input.orgId} has no stored tokens`);
  const nowMs = input.nowMs ?? Date.now();
  if (!expiresSoon(stored, nowMs, input.skewMs)) return stored.accessToken;
  const refreshed = await refreshAccessToken({
    fetchImpl: input.fetchImpl,
    dataCenter: stored.dataCenter,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: stored.refreshToken,
    nowMs,
  });
  await input.store.save({ ...stored, ...refreshed });
  return refreshed.accessToken;
}
