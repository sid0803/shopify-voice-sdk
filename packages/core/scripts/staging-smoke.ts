// Local staging smoke (uses src directly, no publish needed).
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "../src/index.js";

async function main(): Promise<void> {
  const baseUrl = process.env["TECHLADDER_BASE_URL"] ?? "";
  if (!baseUrl) throw new Error("Set TECHLADDER_BASE_URL");
  const client = new TechLadderHttpClient({ apiKey: process.env["TECHLADDER_API_KEY"] ?? "", baseUrl });
  const batches = new BatchesResource(client);
  const res = await batches.createIdempotent({
    agent_id: "agt-5face2cd",
    version_id: "pmt-bc2e83fcd4",
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: "2026-11-14",
    schedule_time: "10:00",
    timezone: "Asia/Kolkata",
    contacts: [{ external_id: "demo-1", phone_number: "9999999999" }],
    idempotency_key: buildScopedIdempotencyKey("shopify", "demo.myshopify.com", "order_confirmation", "demo-1"),
  });
  console.log(res.batch_id, res.status);
}

void main();
