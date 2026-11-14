// Staging-only quickstart (10-minute path). Key + URL from env, never hardcoded.
// Fails fast if TECHLADDER_BASE_URL is missing (backend-gaps#10).
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "@techladder/core";

async function main(): Promise<void> {
  const baseUrl = process.env["TECHLADDER_BASE_URL"] ?? "";
  if (!baseUrl) throw new Error("Set TECHLADDER_BASE_URL (staging host from senior)");
  const client = new TechLadderHttpClient({
    apiKey: process.env["TECHLADDER_API_KEY"] ?? "",
    baseUrl,
  });
  const batches = new BatchesResource(client);

  const res = await batches.createIdempotent({
    agent_name: "Demo",
    version_name: "Version 1",
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: "2026-11-14",
    schedule_time: "10:00",
    timezone: "Asia/Kolkata",
    contacts: [{ external_id: "demo-1", phone_number: "9999999999" }],
    // Scoped form avoids cross-shop collision on shared sk_ (see idempotency.ts).
    idempotency_key: buildScopedIdempotencyKey("shopify", "demo.myshopify.com", "order_confirmation", "demo-1"),
  });
  console.log(res.batch_id, res.status);
}

void main();
