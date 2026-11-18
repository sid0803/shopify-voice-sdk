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

Prerequisites: Node 18+ and pnpm 9 (`npm i -g pnpm@9`, or `corepack enable`). No npm publish needed — workspaces link locally after install.

```bash
git clone https://github.com/techladderai/techladder-shopify-sdk.git
cd techladder-shopify-sdk
pnpm install   # deterministic via pnpm-lock.yaml
pnpm build     # builds packages/*/dist consumed by the shell
pnpm typecheck
pnpm test
pnpm --filter app build
```

All suites are expected green: core 29, adapter-shopify 64, adapter-webhook 4.

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

## Hosting checklist

- The v1 worker runs in-process (`ensureWorkerStarted()`), so the host must
  stay awake: use a long-running service or scheduled job, not a host that
  sleeps or scales to zero.
- All web + worker instances must share one Mongo. A managed replica set
  works; the current code needs no transactions or change streams.
- Keep `TOKEN_ENCRYPTION_KEY` in the host's secret manager. Rotating it
  requires re-encrypting stored settings, so rotate app credentials at the
  same time if anything leaks.
- Register webhooks via `shopify.app.toml` at deploy time over public HTTPS,
  and remove any manually created store webhooks so orders don't fire twice.

## Roadmap (tracked, not code in this repo)

- Shopify Billing (flat plan first; usage billing wires up to the
  `GET /public/usage` endpoint).
- App Store listing, privacy policy, protected-customer-data approval.
- Backend review/merge + staging deploy; a real signed `analysis.ready` /
  `call.completed` sample; outcome-key confirmation.
- Automatic reconciliation (today it's the manual "Reconcile pending calls"
  button) and a missed-webhook SLA — both backend questions.
- History scrub + key rotation (deferred to the end intentionally).

See `docs/backend-gaps.md` for backend requests and `docs/implementation-plan.md`
for the full task history.
