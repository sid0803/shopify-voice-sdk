import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhook } from "../src/webhooks/verify.js";
import { InMemoryWebhookStore, shouldProcessEvent } from "../src/webhooks/dedupe.js";
import { AuthError } from "../src/errors.js";

function sign(secret: string, timestamp: string, body: string): string {
  const base = Buffer.concat([Buffer.from(timestamp), Buffer.from("."), Buffer.from(body)]);
  return `sha256=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

describe("webhook verify + dedupe", () => {
  const secret = "whsec_test123";
  const body = JSON.stringify({ event_id: "evt_1", event: "call.completed", api_version: "2026-04-25", data: {} }, null, 0).replace(/": "/g, '":"').replace(/", "/g, '","');
  const timestamp = new Date().toISOString();

  it("accepts a good signature (mixed-case headers)", () => {
    const headers = {
      "X-TechLadder-Signature": sign(secret, timestamp, body),
      "X-TECHLADDER-Timestamp": timestamp,
      "x-techladder-event-id": "evt_1",
    };
    expect(verifyWebhook({ rawBody: body, headers, secret, toleranceSeconds: 300 }).eventId).toBe("evt_1");
  });

  it("rejects bad signature", () => {
    expect(() =>
      verifyWebhook({ rawBody: body, headers: { "x-techladder-signature": "sha256=bad", "x-techladder-timestamp": timestamp, "x-techladder-event-id": "evt_1" }, secret, toleranceSeconds: 300 }),
    ).toThrow(AuthError);
  });

  it("rejects expired timestamp", () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    expect(() =>
      verifyWebhook({ rawBody: body, headers: { "x-techladder-signature": sign(secret, old, body), "x-techladder-timestamp": old, "x-techladder-event-id": "evt_1" }, secret, toleranceSeconds: 300 }),
    ).toThrow(AuthError);
  });

  it("skips already-seen event IDs", async () => {
    const store = new InMemoryWebhookStore();
    expect(await shouldProcessEvent(store, "evt_1")).toBe(true);
    expect(await shouldProcessEvent(store, "evt_1")).toBe(false);
    expect(await shouldProcessEvent(store, "evt_2")).toBe(true);
  });
});
