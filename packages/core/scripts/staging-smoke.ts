// Local staging smoke (uses src directly, no publish needed). Env only.
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "../src/index.js";

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function main(): Promise<void> {
  const client = new TechLadderHttpClient({
    apiKey: required("TECHLADDER_API_KEY"),
    baseUrl: required("TECHLADDER_BASE_URL"),
  });
  const batches = new BatchesResource(client);
  const externalId = process.env["EXTERNAL_ID"] ?? "smoke-test";
  const res = await batches.createIdempotent({
    agent_id: required("AGENT_ID"),
    version_id: process.env["AGENT_VERSION_ID"],
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: new Date().toISOString().slice(0, 10),
    schedule_time: process.env["SCHEDULE_TIME"] ?? "10:00",
    timezone: required("SCHEDULE_TIMEZONE"),
    contacts: [{ external_id: externalId, phone_number: required("CONTACT_PHONE") }],
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
