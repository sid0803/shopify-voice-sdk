// Isolation test: same batch path, EMPTY metadata, explicit voice.
// Local only — never commit real phone numbers. Every value comes from env.
//   CONTACT_PHONE=+10000000000 AGENT_ID=... AGENT_VERSION=... AGENT_VOICE=... \
//   TECHLADDER_API_KEY=... TECHLADDER_BASE_URL=... npx tsx scripts/call-plain.ts
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
  const externalId = process.env["EXTERNAL_ID"] ?? "plain-test";
  const res = await batches.createIdempotent({
    agent_id: required("AGENT_ID"),
    version_name: required("AGENT_VERSION"),
    voice: required("AGENT_VOICE"),
    interruption: false,
    use_alternate_number: false,
    start_mode: "immediate",
    schedule_date: new Date().toISOString().slice(0, 10),
    schedule_time: process.env["SCHEDULE_TIME"] ?? "10:00",
    timezone: required("SCHEDULE_TIMEZONE"),
    contacts: [{ external_id: externalId, phone_number: required("CONTACT_PHONE"), metadata: {} }],
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
