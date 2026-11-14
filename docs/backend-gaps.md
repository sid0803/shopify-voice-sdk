# Backend gaps (needs backend team / senior decision)

Updated: 2026-11-13. Each item says where we looked.

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
