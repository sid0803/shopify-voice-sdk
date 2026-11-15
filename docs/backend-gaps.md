# Backend gaps (needs backend team / senior decision)

Updated: 2026-11-14 — senior prod-ready review decisions recorded below.
Items marked DECIDED need no further debate; items marked BACKEND-REQUEST need
another repo (techladder-core) — nothing outside techladder-sdk/ was touched.

## Senior decisions (applied to code where possible)
- D1 per-shop auth: Option 1 — one sk_ per shop, pasted in app settings, validated
  via GET /me (new AccountResource). Scoped idempotency helper kept for shared-key
  setups only.
- D2 v1 webhook scope: orders/create + app/uninstalled + 3 GDPR topics only.
  orders/updated, checkouts/*, carts/update parked (topicToEventType narrowed).
- D3 write-back: GraphQL tagsAdd (atomic) with §11 tag table; log + throw on
  userErrors. HMAC fail → 401, transient → 502 for Shopify retry, fast ack.
- D4 GDPR: customers/redact = customer only; shop/redact = shop; data_request =
  export log; app/uninstalled = revoke + stop.
- D5 settings: agent/version/voice/DID/filters/hours/language/retries/tags per
  shop (settings.ts); embedded UI still needs the Remix scaffold (confirm).
- D6 billing: flat plan first; usage-minutes endpoint still requested (old #7).
- D7 context: name/items/amount/address metadata (amount added; address excluded
  for privacy — confirm). Consent/DND hooks exist; no source data yet (confirm).

## Backend branches (techladder-core, NOT pushed, main untouched)
- feat/sdk-post-calls-idempotency: B1-a single-call routing + B2 serializer
  hardening with crash-hunt test. Needs PR review, then push.
- feat/sdk-usage-endpoint: B3 GET /public/usage. Needs PR review.
- feat/sdk-public-rate-limit: B4 opt-in limiter (default OFF). Needs PR review.
- B2 GET-500: crash class reproduced + fixed; dev's exact row still needs their
  traceback to confirm. B5: no scheduler precedent in infra — propose
  EventBridge Scheduler triggering ECS runTask every 2-5 min; infra owner
  confirms. Nothing applied to infra.

## Backend requests (need techladder-core — confirm each before I touch it)
- B1 POST /calls idempotency_key (account-scoped, repeat returns existing).
- B2 GET /call-batches 500 on dev (requestIds logged) + call.completed /
  analysis.ready sample payloads + outcome-key confirmation for toCallResult.
- B3 usage-minutes endpoint for Shopify usage billing.
- B4 exact 429 shape + public error codes for public v1.
- B5 polling SLA for missed webhooks.

1. Webhook replay protection: NO timestamp-tolerance check found in `techladder-core/app/domain/developer_integrations/webhooks/service.py` (sign uses `iso_now()` at send, `service.py:542`). SDK cannot enforce expiry until backend documents allowed skew. Proposed: accept ±5 min, constant-time compare. Needs senior sign-off.
2. Secret rotation: no rotate/reveal endpoint in `webhooks/router.py` (only create/list/patch/delete/test). If a `whsec_` leaks, adapter must create a new endpoint + delete old. Confirm this is the intended flow.
3. `whsec_` for per-batch `callback_url`: delivered UNSIGNED (`service.py:479-487`). Confirm Shopify adapter must use registered webhook-endpoints, not per-batch `callback_url`, for signed delivery.
4. `call.completed` as official SDK contract: code emits it (`service.py:643-655`, `schemas.py:15`) but no published sample payload doc. Need one signed sample + confirmation this event is stable.
5. Missed-webhook SLA: no polling-fallback documented. SDK falls back to `GET /call-batches/{id}/results` / `GET /calls/{call_id}/result`. Need expected delay + sync frequency (`sync_call_result_webhook_events`, `service.py:670-732` is internal).
   - Dev finding 2026-11-13: `PUT /call-batches` EXISTS on dev (probe with `{}` returns 422 listing missing fields + requestId). Earlier staging-smoke 404 was bad `agent_name: Demo` reference, not a missing route — use a real agent/version from the dev account.
   - Dev finding 2026-11-13: `GET /call-batches?limit=1&page=1` returns plain-text 500 (no JSON envelope, no requestId header) while `GET /calls|/webhook-endpoints|/call-records` are OK. Likely crash in `list_call_batches` (`service.py:1693-1755`, counts/serialize path). Backend team needs dev logs around the probe timestamp for account `sk_3x5z...`; no full key shared.
6. Per-store auth: no code maps Shopify shop -> `sk_` key. Decision needed: one `sk_` per store vs one key + `externalAccountId` routing in adapter. Affects `accountId/externalAccountId` design.
7. Usage/billing minutes: no public usage endpoint found in `developer_integrations/` (only internal credit audit in `techladder-agents/.../credit_billing` + `techladder-queue-listener/credit_audit`). Needed later for Shopify usage-based billing.
8. Rate limits + error codes: no rate-limit middleware on `/public/*` found; `429` shape UNVERIFIED. `DeveloperApiError{code, details[]}` confirmed (`response_schemas.py`) but code strings (e.g. `rate_limited` in `app/api/v2/errors.py:38`) not confirmed for public v1.
9. Order lookup during call: no public order/inbound-lookup endpoint in `developer_integrations/`. If voice agent needs Shopify order data mid-call, backend must add it or adapter injects into `context` at batch create.
10. Base URLs: production/staging hosts not in code. Need official values.
