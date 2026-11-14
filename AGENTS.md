# AGENTS.md — techladder-sdk

- New repo. Never branch/commit in `techladder-core`, `dashboard`, etc. for SDK work.
- Core (`packages/core`) knows NOTHING about Shopify/order/cart/store. Neutral words only: contact, event, context, source, externalId, externalAccountId.
- Adapters depend on core. Core never imports adapters.
- Do not invent endpoints. Copy from `docs/api.md` with file path. Unknowns -> `docs/backend-gaps.md` + TODO.
- No `any` without comment. No API keys or PII in logs. Staging only, key from env.
