// Authed Zoho CRM REST client (P1). Stateless by design: the caller supplies
// an org-scoped token getter (oauth.ensureFreshToken), so tokens can never
// leak across orgs inside this client. Retry posture mirrors core http.ts and
// the Shopify adapter: network errors + 429/5xx only, never other 4xx.
import { zohoApiBase } from "./zohoConfig.js";

export class ZohoApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ZohoApiError";
    this.status = status;
    this.code = code;
  }
}

/** 401 from Zoho: the access token is dead. The caller refreshes and retries. */
export class ZohoAuthError extends ZohoApiError {
  constructor(message = "Zoho unauthorized: refresh the access token") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "ZohoAuthError";
  }
}

export interface ZohoClientConfig {
  dataCenter: string;
  /** Org-scoped token supplier. Called per request batch, never cached here. */
  getToken: () => string | Promise<string>;
  /** Refresh hook used for exactly one retry after a 401. */
  onUnauthorized?: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ZohoRecordEnvelope {
  data?: Array<Record<string, unknown> & { code?: string; message?: string; status?: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let last: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetchImpl(url, init);
      if (res.status === 429 || res.status >= 500) {
        last = new ZohoApiError(`Zoho responded ${res.status}`, res.status);
      } else {
        return res;
      }
    } catch (err) {
      last = err;
    }
    if (i < attempts) await sleep(Math.min(1000 * 2 ** (i - 1), 4000) + Math.floor(Math.random() * 200));
  }
  throw last instanceof Error ? last : new ZohoApiError("Zoho request failed", 0);
}

/** Throws unless the first data item carries code SUCCESS. */
export function assertZohoSuccess(res: Response, body: ZohoRecordEnvelope, what: string): void {
  const first = body.data?.[0];
  if (res.ok && first?.code === "SUCCESS") return;
  const detail = first?.message ?? first?.code ?? `${res.status}`;
  const code = first?.code;
  throw new ZohoApiError(`Zoho ${what} failed: ${detail}`, res.status, code);
}

export interface ZohoClient {
  getRecord(module: string, id: string, fields?: string[]): Promise<Record<string, unknown>>;
  updateRecord(module: string, id: string, data: Record<string, unknown>): Promise<void>;
  createNote(module: string, id: string, note: { title: string; content: string }): Promise<void>;
  listFields(module: string): Promise<Array<Record<string, unknown>>>;
}

export function createZohoClient(config: ZohoClientConfig): ZohoClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 15_000;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<{ res: Response; json: ZohoRecordEnvelope }> {
    const token = retried && config.onUnauthorized ? await config.onUnauthorized() : await config.getToken();
    const res = await fetchWithRetry(fetchImpl, `${zohoApiBase(config.dataCenter)}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        // Never log this object: it carries the secret.
        Authorization: `Zoho-oauthtoken ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && !retried && config.onUnauthorized) {
      return request(method, path, body, true);
    }
    if (res.status === 401) throw new ZohoAuthError();
    let json: ZohoRecordEnvelope;
    try {
      json = (await res.json()) as ZohoRecordEnvelope;
    } catch {
      throw new ZohoApiError(`Zoho returned non-JSON: ${res.status}`, res.status);
    }
    return { res, json };
  }

  return {
    async getRecord(module, id, fields) {
      const suffix = fields && fields.length > 0 ? `?fields=${fields.map(encodeURIComponent).join(",")}` : "";
      const { json } = await request("GET", `/${module}/${encodeURIComponent(id)}${suffix}`);
      const first = json.data?.[0];
      if (!first) throw new ZohoApiError(`Zoho record not found: ${module}/${id}`, 404, "NOT_FOUND");
      return first;
    },
    async updateRecord(module, id, data) {
      const { res, json } = await request("PUT", `/${module}/${encodeURIComponent(id)}`, { data: [data] });
      assertZohoSuccess(res, json, "record update");
    },
    async createNote(module, id, note) {
      const { res, json } = await request("POST", `/${module}/${encodeURIComponent(id)}/Notes`, {
        data: [{ Note_Title: note.title, Note_Content: note.content }],
      });
      assertZohoSuccess(res, json, "note create");
    },
    async listFields(module) {
      const { json } = await request("GET", `/settings/fields?module=${encodeURIComponent(module)}`);
      return (json.data ?? []) as Array<Record<string, unknown>>;
    },
  };
}
