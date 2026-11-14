# TechLadder SDK (core + adapters scaffold — pending senior review)

Platform-neutral core + adapters. Shopify first, no Shopify names in core.

## Install (staging, <10 min)

```bash
cd techladder-sdk/packages/core
npm install
npx vitest run
```

```bash
TECHLADDER_API_KEY=sk_test_... TECHLADDER_BASE_URL=https://api.staging.techladder.ai npx tsx ../../examples/create-batch-staging.ts
```

Key from env only. Never commit keys. No PII in logs.

## What is verified

* `docs/api.md` — every endpoint with `techladder-core/...` file paths
* `docs/backend-gaps.md` — 10 items senior must decide
* `docs/event-format.md` — neutral inbound/outbound events + Zod

## Layout

* `packages/core` — client, resources, idempotency, webhook verify/dedupe, events, adapter interface
* `packages/adapter-webhook` — Phase 3 placeholder
* `packages/adapter-shopify` — Phase 4 placeholder
