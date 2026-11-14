# Changelog

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
