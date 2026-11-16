# Changelog

## Unreleased (staging only)
- Mongo stores (shops/settings/ledger/claims/sessions) with envelope
  encryption (fail-closed), tested against fakes; `docs/deferred.md` lists
  the end-phase tasks (visibility, rotation, live tests, deploy).

## 0.3.0 (staging only, senior prod-ready plan)

- Per-shop sk_ validation (AccountResource GET /me); v1 topics narrowed.
- toCallResult: analysis.ready/call.failed/call.completed → CallCompletedEvent
  with ledger-based shop/order resolution; tolerant outcome matcher (prompt-owner
  keys TBD).
- GraphQL tagsAdd write-back with retry; 401/502 webhook semantics; GDPR per
  spec; settings module; E.164 + DND hooks; Order_Amount metadata.
- Call ledger + event-claim store interfaces (in-memory now, Mongo later).

## 0.2.1 (staging only)

- Review fixes: dynamic schedule slot (no hardcoded date), agent/version/voice from
  env, fail-closed without `SHOPIFY_API_SECRET`, pure mapping helpers with tests,
  write-back retry (network/5xx), contextual server logs.

## 0.2.0 (staging only)

- Outcomes follow prompt v2.0: 7 canonical dispositions + separate execution status; Shopify tags per §11 table (`call-cancel-requested`, etc.); `Send-test` deliveries skipped via `X-Shopify-Test`.
- Server passes all 5 prompt context vars into batch metadata; nested Shopify phone extraction.

## 0.1.1 (staging only, senior fixes)

- Fail fast: `TechLadderHttpClient` requires explicit `baseUrl` (no placeholders).
- `verifyWebhook` requires explicit `toleranceSeconds` (backend has no window, backend-gaps#1).
- Shopify: `SHOPIFY_API_VERSION=2026-10` to match dashboard, merge-safe tag write-back (GET+PUT).
- Idempotency: added `buildScopedIdempotencyKey` for shared-`sk_` shops; documented collision.
- CI: secrets scan blocks `sk_live_|shpat_|shpss_|whsec_` + missing `.env` guard.

## 0.1.0 (staging only, pending senior review)

- Core: HTTP + typed errors, batch/call/record/webhook-endpoint resources, idempotency helper, TechLadder webhook verify + dedupe, neutral events + Zod, adapter interface.
- Webhook adapter: generic passthrough + callback POST.
- Shopify adapter scaffold: HMAC verify, order/checkout mapping, outcome-tag write-back, per-shop token store interface + GDPR handlers.
- Docs: `docs/api.md` (verified), `docs/backend-gaps.md`, `docs/event-format.md`.
