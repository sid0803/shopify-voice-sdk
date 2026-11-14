import { describe, expect, it, vi, afterEach } from "vitest";
import { TechLadderHttpClient } from "../src/http.js";
import { WebhookEndpointsResource } from "../src/resources/more.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("webhook-endpoints", () => {
  it("create returns secret once, test queues event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(201, { status_code: 201, message: "created", error: null, data: { webhook_endpoint_id: "wh_1", signing_secret: "whsec_x" } }),
      )
      .mockResolvedValueOnce(
        json(200, { status_code: 200, message: "sent", error: null, data: { webhook_endpoint_id: "wh_1", event_id: "evt_test_1", event: "webhook.test", delivery_status: "queued" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const http = new TechLadderHttpClient({ apiKey: "sk_test_x", baseUrl: "https://x.test" });
    const webhooks = new WebhookEndpointsResource(http);
    const created = await webhooks.create({ url: "https://shop.example/hook", events: ["call.completed"] });
    expect(created.signing_secret).toBe("whsec_x");
    const tested = await webhooks.test("wh_1");
    expect(tested.delivery_status).toBe("queued");
    const [url] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/webhook-endpoints/wh_1/test");
  });
});
