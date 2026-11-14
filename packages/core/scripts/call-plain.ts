// Isolation test: same batch path, EMPTY metadata, explicit Deepika voice.
// Decides whether a metadata value breaks turns. Local only — never commit
// real phone numbers. CONTACT_PHONE comes from env.
//   $env:CONTACT_PHONE="+91XXXXXXXXXX"; npx tsx scripts/call-plain.ts
// Delete this file before any commit.
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
  const phone = (process.env["CONTACT_PHONE"] ?? "").trim();
  if (!phone) throw new Error("Set CONTACT_PHONE env (your test number, terminal only)");
  const client = new TechLadderHttpClient({
    apiKey: process.env["TECHLADDER_API_KEY"] ?? "",
    baseUrl: process.env["TECHLADDER_BASE_URL"] ?? "",
  });
  const batches = new BatchesResource(client);
  const res = await batches.createIdempotent({
    agent_id: "agt-d24d1800",
    version_name: "Version 2",
    voice: "Deepika",
    interruption: false,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: "2026-11-14",
    schedule_time: "10:00",
    timezone: "Asia/Kolkata",
    contacts: [{ external_id: "plain-test-2", phone_number: phone, metadata: {} }],
    idempotency_key: buildScopedIdempotencyKey("shopify", "dev-store-1gm9xtph.myshopify.com", "order_confirmation", "plain-test-2"),
  });
  console.log(res.batch_id, res.status);
}

void main();
