// Compare two batches' dial config (agent, voice, DID snapshot). No calls placed.
// Usage: npx tsx scripts/compare-batches.ts <batchA> <batchB>
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TechLadderHttpClient } from "../src/index.js";

for (const p of [join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  break;
}

const [a, b] = process.argv.slice(2);
if (!a || !b) throw new Error("Usage: compare-batches.ts <batchA> <batchB>");

async function show(id: string): Promise<void> {
  const http = new TechLadderHttpClient({
    apiKey: process.env["TECHLADDER_API_KEY"] ?? "",
    baseUrl: process.env["TECHLADDER_BASE_URL"] ?? "",
  });
  const data = await http.request<Record<string, unknown>>({ method: "GET", path: `/call-batches/${encodeURIComponent(id)}` });
  const d = (data as { data?: Record<string, unknown> }).data ?? data;
  console.log(id, JSON.stringify({
    agent_id: d["agent_id"],
    version_id: d["version_id"],
    voice: d["voice"],
    did_number_id: d["did_number_id"],
    did_number: d["did_number"],
    interruption: d["interruption"],
    status: d["status"],
  }, null, 1));
}

await show(a);
await show(b);
