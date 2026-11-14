// One-shot agent-reference check (dev only). Proves whether the dedicated
// Shopify agent resolves under this sk_ before blaming webhooks.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TechLadderHttpClient, BatchesResource, buildScopedIdempotencyKey } from "../src/index.js";

for (const p of [join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  break;
}

async function main(): Promise<void> {
  const client = new TechLadderHttpClient({
    apiKey: process.env["TECHLADDER_API_KEY"] ?? "",
    baseUrl: process.env["TECHLADDER_BASE_URL"] ?? "",
  });
  const batches = new BatchesResource(client);
  const res = await batches.createIdempotent({
    agent_id: "agt-d24d1800",
    version_name: "Version 2",
    interruption: true,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: "2026-11-14",
    schedule_time: "10:00",
    timezone: "Asia/Kolkata",
    contacts: [{ external_id: "agent-check-1", phone_number: "9999999999" }],
    idempotency_key: buildScopedIdempotencyKey("shopify", "dev-store-1gm9xtph.myshopify.com", "order_confirmation", "agent-check-1"),
  });
  console.log(res.batch_id, res.status);
}

void main();
