// Debug which public paths exist on dev (no secrets in output).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TechLadderHttpClient } from "../src/index.js";

// Load techladder-sdk/.env locally so the key never goes on the command line.
function loadLocalEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
  if (!existsSync(root)) return;
  for (const line of readFileSync(root, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadLocalEnv();

async function main(): Promise<void> {
  const baseUrl = process.env["TECHLADDER_BASE_URL"] ?? "";
  const client = new TechLadderHttpClient({ apiKey: process.env["TECHLADDER_API_KEY"] ?? "", baseUrl });
  const cases: Array<{ method: string; path: string }> = [
    { method: "GET", path: "/call-batches?limit=1&page=1" },
    { method: "PUT", path: "/call-batches" },
    { method: "POST", path: "/call-batches" },
  ];
  for (const c of cases) {
    try {
      await client.request({ method: c.method, path: c.path, body: c.method === "GET" ? undefined : {}, idempotencyKey: c.method === "GET" ? undefined : "probe-key" });
      console.log(c.method, c.path, "OK");
    } catch (e) {
      const err = e as { status?: number; message?: string; code?: string; requestId?: string; details?: string[] };
      console.log(c.method, c.path, "ERR", err.status, err.message, err.code ?? "-", err.requestId ?? "-", JSON.stringify(err.details ?? []));
    }
  }
}

void main();
