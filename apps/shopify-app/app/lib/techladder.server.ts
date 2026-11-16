// Per-shop TechLadder client. The key is pasted in Connect, validated with
// GET /me, encrypted at rest, and never sent to the browser.
import {
  AccountResource,
  BatchesResource,
  CallsResource,
  TechLadderHttpClient,
  WebhookEndpointsResource,
} from "@techladder/core";
import type { ShopSettings } from "@techladder/adapter-shopify";

export function techladderBaseUrl(): string {
  const url = (process.env.TECHLADDER_BASE_URL ?? "").trim();
  if (!url) throw new Error("TECHLADDER_BASE_URL is required");
  return url;
}

export function appUrl(): string {
  const url = (process.env.SHOPIFY_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!url) throw new Error("SHOPIFY_APP_URL is required to register webhooks");
  return url;
}

export function resultWebhookUrl(): string {
  return `${appUrl()}/webhooks/techladder/result`;
}

export function techladderKey(settings: ShopSettings): string {
  const key = settings.techladderKeyRef || process.env.TECHLADDER_API_KEY || "";
  if (!key) throw new Error("TechLadder key is not configured for this shop");
  return key;
}

export function techladderClient(settings: ShopSettings): TechLadderHttpClient {
  return new TechLadderHttpClient({
    apiKey: techladderKey(settings),
    baseUrl: techladderBaseUrl(),
    // Worker/queue owns retries; don't hold the request for internal retries.
    maxRetries: 0,
  });
}

export async function validateTechLadderKey(
  apiKey: string,
  baseUrl = techladderBaseUrl(),
): Promise<{ accountId: string; name: string }> {
  const http = new TechLadderHttpClient({ apiKey, baseUrl, maxRetries: 0 });
  const account = await new AccountResource(http).validate(apiKey, baseUrl);
  return { accountId: account.account_id, name: account.name };
}

export interface OrderCallInput {
  orderId: string;
  phone: string;
  customerName?: string;
  orderReference: string;
  orderItems?: string;
  paymentMethod?: string;
  orderAmount?: string;
  storeName: string;
  language?: string;
  idempotencyKey: string;
  scheduleDate: string;
  scheduleTime: string;
  timezone: string;
}

export interface CreatedCall {
  callId?: string;
  batchId?: string;
  status: string;
  idempotencyKey: string;
}

/** One call per order. Batch machinery is the compatibility path until B1-a
 * (idempotency on POST /calls) is merged and deployed everywhere. */
export async function createOrderCall(
  settings: ShopSettings,
  input: OrderCallInput,
): Promise<CreatedCall> {
  const http = techladderClient(settings);
  const metadata = {
    Customer_Name: input.customerName,
    Order_Reference: input.orderReference,
    Order_Items: input.orderItems,
    Payment_Method: input.paymentMethod,
    Order_Amount: input.orderAmount,
    Store_Name: input.storeName,
    ...(input.language ? { Language: input.language } : {}),
  };

  if (process.env.TECHLADDER_SINGLE_CALL === "1") {
    // TODO(backend-gaps): POST /calls body shape is not documented in docs/api.md.
    // Keep this behind the env flag until B1-a confirms the field names.
    const call = await new CallsResource(http).create({
      agent_id: settings.agentId,
      version_id: settings.versionName,
      phone_number: input.phone,
      external_id: input.orderId,
      metadata,
      idempotency_key: input.idempotencyKey,
      recording_enabled: true,
    });
    return {
      ...(call.call_id ? { callId: call.call_id } : {}),
      ...(call.batch_id ? { batchId: call.batch_id } : {}),
      status: call.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
    };
  }

  const batch = await new BatchesResource(http).createIdempotent({
    agent_id: settings.agentId,
    version_name: settings.versionName,
    voice: settings.voice,
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: input.scheduleDate,
    schedule_time: input.scheduleTime,
    timezone: input.timezone,
    ...(settings.didNumberId ? { did_number_id: settings.didNumberId } : {}),
    contacts: [
      {
        external_id: input.orderId,
        phone_number: input.phone,
        ...(input.customerName ? { name: input.customerName } : {}),
        metadata,
      },
    ],
    idempotency_key: input.idempotencyKey,
  });
  return {
    ...(batch.batch_id ? { batchId: batch.batch_id } : {}),
    status: batch.status ?? "queued",
    idempotencyKey: input.idempotencyKey,
  };
}

export interface WebhookRegistration {
  endpointId: string;
  secret: string;
}

/** Register (or refresh) this shop's TechLadder result webhook. */
export async function ensureResultWebhook(
  settings: ShopSettings,
  apiKey: string,
  existingSecret: string,
): Promise<WebhookRegistration> {
  const http = new TechLadderHttpClient({ apiKey, baseUrl: techladderBaseUrl(), maxRetries: 0 });
  const endpoints = new WebhookEndpointsResource(http);
  const url = resultWebhookUrl();
  const description = `Shopify ${settings.externalAccountId}`;
  const events = ["analysis.ready", "call.failed"];

  const listed = await endpoints.list();
  const match =
    listed.items.find((e) => e.url === url && e.description === description) ??
    listed.items.find((e) => e.url === url);

  if (match) {
    await endpoints.update(match.webhook_endpoint_id, { url, description, events, status: "active" });
    // The signing secret is only returned at creation. If it was lost we must
    // recreate the endpoint; otherwise keep the stored one.
    if (existingSecret) return { endpointId: match.webhook_endpoint_id, secret: existingSecret };
    await endpoints.remove(match.webhook_endpoint_id);
  }

  const created = await endpoints.create({ url, description, events });
  if (!created.signing_secret) throw new Error("TechLadder did not return a webhook signing secret");
  return { endpointId: created.webhook_endpoint_id, secret: created.signing_secret };
}
