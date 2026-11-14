# adapter-shopify/app — basic-flow auto-connector (test only)

No Remix/CLI needed. Thin glue: existing `src/` mapping + `@techladder/core` client.

## Run (your PC, secrets stay local)

```powershell
cd TechLadder\techladder-sdk\packages\adapter-shopify
$env:TECHLADDER_API_KEY="<dev sk_>"
$env:TECHLADDER_BASE_URL="https://api.dev.techladder.ai"
$env:SHOPIFY_API_SECRET="<partner Client secret>"
$env:SHOPIFY_SHOP="dev-store-1gm9xtph.myshopify.com"
$env:SHOPIFY_TOKEN=""   # empty = log-only write-back for now
$env:TECHLADDER_WEBHOOK_SECRET=""  # empty = accept-and-ignore until registered endpoint secret set
$env:PORT="4311"
npx tsx app/server.ts
```

Expose it: `cloudflared tunnel --url http://localhost:4311` (or ngrok). Register:
* Partners -> AI Calls -> Webhooks: `orders/create -> POST https://<tunnel>/webhooks/shopify/orders`
* TechLadder `POST /webhook-endpoints {url: https://<tunnel>/webhooks/techladder, events: [call.completed]}` -> copy `whsec_...` to `TECHLADDER_WEBHOOK_SECRET`, restart.

Test: create order with phone on dev store -> `GET /health` ok, server logs `queued sched_...`, TechLadder history shows attempt, tag step logs until `SHOPIFY_TOKEN` set (OAuth phase).
