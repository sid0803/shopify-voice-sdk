// Staging-only quickstart (10-minute path). Every value from env, never hardcoded.
// Fails fast if TECHLADDER_BASE_URL is missing (backend-gaps#10).
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "@techladder/core";

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Set ${name} (value comes from staging, never commit it)`);
  return value;
}

async function main(): Promise<void> {
  const baseUrl = required("TECHLADDER_BASE_URL");
  const client = new TechLadderHttpClient({
    apiKey: required("TECHLADDER_API_KEY"),
    baseUrl,
  });
  const batches = new BatchesResource(client);
  const externalId = process.env["EXTERNAL_ID"] ?? "demo-1";

  const res = await batches.createIdempotent({
    agent_id: required("AGENT_ID"),
    version_name: process.env["AGENT_VERSION"],
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: new Date().toISOString().slice(0, 10),
    schedule_time: process.env["SCHEDULE_TIME"] ?? "10:00",
    timezone: required("SCHEDULE_TIMEZONE"),
    contacts: [{ external_id: externalId, phone_number: required("CONTACT_PHONE") }],
    // Scoped form avoids cross-shop collision on shared sk_ (see idempotency.ts).
    idempotency_key: buildScopedIdempotencyKey(
      "shopify",
      process.env["SHOPIFY_SHOP"] ?? "local.example.myshopify.com",
      "order_confirmation",
      externalId,
    ),
  });
  console.log(res.batch_id, res.status);
}

void main();
