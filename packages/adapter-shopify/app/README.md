# adapter-shopify/app — basic-flow auto-connector (test only)

No Remix/CLI needed. Thin glue: existing `src/` mapping + `@techladder/core` client.

## Run (your PC, secrets stay local)

```powershell
npx tsx app/server.ts
```
Env comes from `techladder-sdk/.env` (all values local only):
`TECHLADDER_API_KEY`, `TECHLADDER_BASE_URL`, `SHOPIFY_API_SECRET` (required —
server refuses to start without it), `SHOPIFY_SHOP`, `AGENT_ID`, `AGENT_VERSION`,
`AGENT_VOICE`, `SCHEDULE_TIMEZONE`, `STORE_DISPLAY_NAME`, `SHOPIFY_TOKEN`
(empty = log-only write-back), `TECHLADDER_WEBHOOK_SECRET` (empty = TechLadder
posts ignored), `WEBHOOK_TOLERANCE`, `PORT`.

Expose it: `cloudflared tunnel --url http://localhost:4311` (or ngrok). Register:
* Partners -> AI Calls -> Webhooks: `orders/create -> POST https://<tunnel>/webhooks/shopify/orders`
* TechLadder `POST /webhook-endpoints {url: https://<tunnel>/webhooks/techladder, events: [call.completed]}` -> copy `whsec_...` to `TECHLADDER_WEBHOOK_SECRET`, restart.

Test: create order with phone on dev store -> `GET /health` ok, server logs `queued sched_...`, TechLadder history shows attempt, tag step logs until `SHOPIFY_TOKEN` set (OAuth phase).
