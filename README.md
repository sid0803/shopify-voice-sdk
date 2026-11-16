# TechLadder SDK + Shopify app shell

Platform-neutral core + adapters. Shopify specifics live in the adapter and the
shell; `packages/core` never imports Shopify names.

## What is in the repo

| Path | Purpose |
| --- | --- |
| `packages/core` | HTTP client, typed errors, calls/batches/webhook-endpoint resources, idempotency, signed-webhook verification, neutral events + Zod, adapter interface |
| `packages/adapter-webhook` | Generic webhook passthrough adapter |
| `packages/adapter-shopify` | HMAC verification, order mapping, result→tag mapping, GraphQL `tagsAdd` write-back, per-shop settings, durable queue, GDPR handlers, Mongo stores with AES-256-GCM encryption |
| `apps/shopify-app` | Deployable React Router Shopify app: OAuth/session handling, fast-ack webhooks, background worker, embedded Connect / Settings / Call-log UI |

## Tests and checks

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm --filter app build
```

All suites are expected green: core 24, adapter-shopify 57, adapter-webhook 4.

## Local development

```bash
cd apps/shopify-app
cp .env.example .env      # fill local values; never commit it
pnpm dev                  # Shopify CLI injects the API key/secret
```

Local dev can run without Mongo (in-memory stores, Shopify template SQLite
sessions) but state is lost on restart. Production must set Mongo + the
encryption key together.

## Production environment

Required:

- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`
- `MONGODB_URI` and `TOKEN_ENCRYPTION_KEY` (base64 of exactly 32 random bytes,
  e.g. `openssl rand -base64 32`). Setting `MONGODB_URI` without the key fails
  closed by design.
- `TECHLADDER_BASE_URL`

Optional: `TECHLADDER_API_KEY` (staging-only fallback; per-shop keys are pasted
in Connect), `TECHLADDER_WEBHOOK_TOLERANCE`, `TECHLADDER_SINGLE_CALL`,
`STORE_DISPLAY_NAME`, `DATABASE_URL` (Prisma session fallback only).

Set `shopify.app.toml` `application_url` / `redirect_urls` and the app
`client_id` from the Partners app before `shopify app deploy`.

## Hosting notes (owner action)

- The v1 worker runs in-process (`ensureWorkerStarted`). Move it to a
  long-running service or scheduled job if the web host sleeps or scales to
  zero.
- Mongo must be reachable by every web + worker instance; use a managed
  replica set if the host requires transactions/change streams (none required
  by the current code).
- Keep the encryption key in the host's secret manager. Rotating it requires
  re-encrypting stored settings; rotate together with any key that ever leaked.
- Register webhooks through `shopify.app.toml` at deploy time, delete any
  manually created store webhooks to avoid double firing, and confirm the app
  URL is public HTTPS.

## Still open (not code)

- Shopify Billing (flat plan first; usage billing needs a backend usage-minutes
  endpoint).
- App Store listing, privacy policy, protected-customer-data approval.
- Backend branch review/merge + staging deploy; a real signed
  `analysis.ready` / `call.completed` sample; outcome-key confirmation.
- Reconciliation is manual ("Reconcile pending calls") until a shop-list store
  exists; missed-webhook SLA is still a backend question.
- History scrub + key rotation (deferred to the end intentionally).

See `docs/backend-gaps.md` for backend requests and `docs/implementation-plan.md`
for the full task history.
