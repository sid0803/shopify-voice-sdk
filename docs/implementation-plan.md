# Implementation plan: Shopify app shell to deployable pilot
Date: 2026-11-16. Status: PLAN OF RECORD — Tasks 1–7 are done (shell built,
stores/encryption wired, hardcoded order-path values removed, reconciliation engine
implemented + tested); Tasks 8–10 and the scrub/rotation in Task 12 remain owner actions.
Rule compliance: backend `main` and infra were never modified; backend work is
on feature branches only, with no PRs opened by us.

## 1. Current state (verified this session)

### Repos
- SDK repo: branch `main`, HEAD `b3b9f06` before the current audit changes.
  Current files contain only `.env.example` (names, no values) and fake
  fixtures. Public personal repo.
- Backend repo: B1/B2, B3 and B4 are pushed to feature branches
  (`ee889dd1`, `dd869807`, `b8b32112` + `51cee1b`). `main` and
  `origin/main` (`10efdff2`) untouched. No PRs opened.
- Infra branch `feat/sdk-webhook-worker-schedule` exists, zero writes.

### Tests (latest audit run)
- `packages/core` 24/24, `packages/adapter-shopify` 57/57,
  `packages/adapter-webhook` 4/4 — 85 total, green. Workspace `typecheck` and
  `pnpm --filter app build` also green.

### Layout
- `pnpm-workspace.yaml`: `packages: ["packages/*", "apps/*"]`.
- Root `package.json`: private, `packageManager pnpm@9.0.0`, scripts
  build/test/lint/typecheck (recursive), root `pnpm.overrides` for `qs`.
- `apps/shopify-app` is the deployable shell; it depends on core + adapter via
  `workspace:*` and builds both in `predev`/`prebuild`.
- `packages/adapter-shopify/package.json`: deps `mongodb ^7.9.0`,
  `zod ^3.23.8`; engines `node >= 18`.
- **Recommendation: scaffold at `packages/adapter-shopify/shopify-app/`.**
  Why: webhooks/settings/GDPR logic it must import already lives in
  `packages/adapter-shopify/{src,app}`; a sibling `apps/shopify-app`
  would split one adapter across two top-level dirs. pnpm workspace
  picks it up via a second pattern (`apps/*`) or by moving nothing —
  simplest is keeping it inside the package dir so `tsup`/`vitest`
  configs and the `@techladder/*` workspace links apply. No circular
  build: the shell depends on core + adapter (one direction only);
  core never imports the shell.

### What exists vs missing
- Exists: everything in §1 of the brief (verified by file reads this
  session: `app/server.ts:87-236` semantics, `src/index.ts:69-93,150-166`
  tags, `src/result.ts`, `src/settings.ts`, `src/stores.ts`,
  `src/shopStore.ts`, `src/gdpr.ts`, `src/shopifyConfig.ts`,
  `app/mapping.ts`, replay fixture + test).
- Missing: staging deploy, worker schedule (Task 8), real-payload replay, live
  order tests, rotation/scrub (Task 12), Shopify billing/listing.
- Built since: `apps/shopify-app`, `shopify.app.toml`, Mongo-backed stores,
  encrypted Shopify sessions, embedded Connect/Settings/Call-log UI, durable
  queue + in-process worker, GDPR routes, replay fixture sanitized to fakes.

## 2. Brief mismatches found while verifying

1. **Token model is bigger than briefed.** Docs (access-tokens page, read
   2026-11-16): expiring offline tokens live 1h with 90-day refresh tokens;
   template refreshes automatically; **new public apps cannot use
   non-expiring tokens for GraphQL**, and existing ones are delisted
   2027-01-01 / rejected 2027-04-01. Consequence: `ShopRecord` needs
   `refreshToken` + `expiresAt` fields and a refresh path — the brief's
   `{domain, token}` model is insufficient. Managed install exists
   (SCOPES then optional).
2. **Default session storage is Prisma+SQLite, not Mongo** (deploy page).
   Mongo is a prod choice, not the template default. Plan: dev on template
   default, Mongo adapter (`@shopify/shopify-app-session-storage-mongodb`,
   README read 2026-11-16, supports refresh tokens with no migration) for
   staging/prod — or our `MongoSessionStore` adapted to the session shape.
3. **Mongo replica-set requirement UNVERIFIED.** Neither the session-storage
   README nor the deploy page states it (404 on the old session-tokens URL).
   Keep as constraint, confirm from the package README at scaffold time.
4. **Node/CLI versions UNVERIFIED.** Docs say "latest CLI + Chrome/Firefox"
   only. Check `shopify --version` output and template `engines` at init;
   our packages require `node >= 18`.
5. **`Send test` never exercises mapping** (dummy payload, no phone) —
   already handled in code (`test-skipped`), restating because the plan's
   test section must forbid it as evidence.
6. **Manual store webhook must be DELETED at toml migration** or every order
   double-fires (docs-mandated). Explicit step in task 3.
7. Core neutrality holds: only comments/example strings mention platforms
   (`adapter.ts:1-21`, `idempotency.ts:7-9`, `events/types.ts:16`).

## 3. Task plans

### Task 1 — App shell (React Router template + screens)
- Goal: `shopify app dev` boots; login, status, connect (paste sk_ →
  server-side `AccountResource.validate`), settings (all `settings.ts`
  fields), read-only call log (outcome + recording link).
- Files: NEW `packages/adapter-shopify/shopify-app/` from `shopify app
  init` (template `react-router`); routes
  `app/routes/{_index,status,settings.connect,settings.general,calls}.tsx`,
  `app/shopify.server.ts`, `shopify.app.toml` (task 3); add
  `@techladder/core` + `@techladder/adapter-shopify` as `file:`/workspace
  deps (verify resolution at build time — UNVERIFIED until then).
- Steps: global CLI install → init inside package dir (creates Dev
  Dashboard app record; decide new vs existing test app FIRST — default:
  new `TechLadder AI Calls (staging)`, keep test-sid frozen) → wire deps
  → Connect route (sk_ never touches the browser; validate server-side)
  → settings form bound 1:1 to `ShopSettingsSchema` → log table via
  `listCallsByExternalId` + `getResult` server-side.
- Depends: 3 (toml), 4 (sessions), 10 (env names). Tests: schema
  round-trip, loader tests with mocked core, manual install on dev store.
- Accept: dev boot, install, Connect validates a dev key, settings persist,
  log renders a real batch. Effort M (2–3d). Risk: CLI drift — pin version.
- Parallel after 3+4 start.

### Task 2 — Webhook routes in the shell
- Goal: `orders/create`, TechLadder result, `app/uninstalled`, GDPR ×3.
- Files: `shopify-app/app/routes/webhooks.*.tsx` delegating to adapter
  `verifyIncoming`/`toStandardEvent`/`handleResult`/`handleGdprWebhook`;
  port logic from prototype `app/server.ts:76-236` (now frozen reference).
- Steps: implement per docs `authenticate.webhook` pattern for Shopify
  routes; TechLadder route keeps OUR `verifyWebhook` (helper is
  Shopify-only); add `X-Shopify-Webhook-Id` persistent check (missing
  today — only idempotency keys dedupe); keep 401/502/200 semantics
  byte-equal; delete manual store webhook at cutover (§2.8).
- Depends: 1, 4 (claim store), 3. Tests: signed fixtures (good→200,
  bad→401, duplicate delivery-id→skip once, transient→502); replay test
  already covers mapping.
- Accept: `shopify app webhook trigger` per topic reaches handlers;
  redelivery processes once. Effort S-M. Parallel with 1.

### Task 3 — shopify.app.toml
- Goal: declarative scopes/topics/compliance with placeholder URL.
- Files: NEW `shopify-app/shopify.app.toml`: `[webhooks]
  api_version = "2026-10"` (docs-confirmed form); `[[webhooks.
  subscriptions]]` topics `["orders/create"]`,
  `uri = "${PUBLIC_BASE_URL}/webhooks/shopify/orders"`;
  `compliance_topics` all three (docs-required for store distribution);
  scopes `read_orders,write_orders` (verify in Dev Dashboard; expand only
  on 403 evidence).
- Depends: 10 (real URL). Tests: `shopify app deploy` to dev store;
  Versions page shows config-managed subscriptions.
- Accept: deploy green, no manual subscriptions remain. Effort S.

### Task 4 — Mongo stores + encryption + sessions
- Goal: `ShopStore` (+refreshToken/expiresAt per §2.1),
  `SettingsStore`, `CallLedger`, `EventClaim`, session store on Mongo.
- Files: NEW `packages/adapter-shopify/src/mongo/{client,shops,settings,
  calls,events,sessions}.ts`; extend `ShopRecord` (+refresh fields —
  additive); `TOKEN_ENCRYPTION_KEY` AES-GCM envelope, fail-closed when
  unset (document KMS as follow-up, not code).
- Steps: `mongodb` dep already in package.json; interfaces unchanged;
  unique-index claim; tests vs in-memory fakes + one documented manual run
  on a local replica set.
- Depends: 10 (URI, key). Accept: existing store tests pass against Mongo
  impls; wrong-key decrypt fails closed. Effort M (2d). Parallel: yes.

### Task 5 — Consent/DND (hook exists, data missing)
- Goal: order-time gate with a real source.
- Files: server gate exists (`server.ts:119`); settings `blockedPhones`
  exists. Only addition: consent-source mapping once a real payload with
  consent data is inspected (`customer.email_marketing_consent` presence
  UNVERIFIED). Default until then: DND-only (already coded).
- Accept: listed number → `suppressed`, logged, no batch. Effort S.

### Task 6 — Replace hardcoded values
- Goal: no literals in the order path.
- Files: `app/server.ts:161-168` (env fallbacks) + `settings.ts` defaults;
  seed settings row per shop at OAuth; keep env as documented dev-seed
  only. Verify with `grep -E "agt-|Version [0-9]|Deepika|Kolkata|2026-"`.
- Depends: 4. Accept: grep clean. Effort S.

### Task 7 — Reconciliation job (adapter) [DONE]
- Goal: poll calls without outcome after N min; backfill tags.
- Files: `src/reconcile.ts` (list recent → `getResult` → `toCallResult`
  → `handleResult`, ledger-gated, per-call claim). Wired to worker.
- Tests: `packages/adapter-shopify/test/reconcile.test.ts` (6 tests green:
  miss gets tagged, second run no-ops, window checks, claim-locking).

### Task 8 — Backend webhook scheduler
- Targets re-verified (signatures only, bodies read earlier in this work):
  `webhooks/service.py:519,607,670,745`. Emission guarded by
  `webhook_events_emitted` addToSet; deliveries unique per enqueue; no
  distributed lock — concurrent instances double-DELIVER (safe via
  idempotency + claims, wasteful). So single-instance schedule, no lock work.
- Proposal only (infra owner decides, nothing written): EventBridge
  Scheduler → ECS `runTask` (`python -m app.workers`, one-shot per
  `app/workers/__main__.py:21-34`) every 2–5 min. Never cron inside API
  containers (couples scaling, multiplies senders).
- Accept: `call.completed` delivered within one interval. Effort S code,
  M coordination.

### Task 9 — Backend PRs (branches pushed)
- Branches exist: B1-a + B2 (`ee889dd1`), B3 (`dd869807`), B4 (`b8b32112` +
  `51cee1b`). Next: owner review, then merge + staging deploy. Add the
  `call_id: null` note to B1-a's description at PR time.

### Task 10 — Deployment pack (senior/host)
- Build/start: `pnpm install --frozen-lockfile`, `pnpm -r build`
  (`tsup` configs exist), `npm run setup` (Prisma, template default) OR
  Mongo wiring (task 4), `npm run start`; `shopify app deploy` for config.
  Confirm `app/` prototype server is NOT the deploy artifact — shell is.
- `.env.example` (names only): verify current names then ADD
  `TOKEN_ENCRYPTION_KEY`, `MONGODB_URI`, `PUBLIC_BASE_URL`,
  `SHOPIFY_APP_URL`, `SCOPES`. Never values.
- Dockerfile: default to template's (exists per docs); custom only if the
  host demands it — ask, don't invent.
- Rollback: additive + default-off everywhere → previous task-def revision
  + delete toml subscriptions. Record per deploy.

### Task 11 — Docs
- `backend-gaps.md`: close decided, link PRs, keep sample/keys/consent/
  pricing open with owners. `README.md`: replace prototype quickstart with
  shell flow. `CHANGELOG.md`: per-task entries.

### Task 12 — Pre-push scrub (approval already constrained: edits forbidden
  by this brief — list for later)
- Known in history: a partial key prefix (`backend-gaps.md:11`, unusable
  alone; value redacted here), real phone in replay fixture (`:13`) + `mapping.test.ts:30`,
  real order ids (fixture + `tag-test.ts` comment). No `shpss_`/`shpat_`/
  ngrok/JWT in any commit (searched all). Fixture phone collides with the
  no-PII rule for new files — grandfathered, must be scrubbed with the rest.

## 4. Build order + milestones
- M0 done: prototype, 50 tests, live proof, branches.
- M1 (parallel): T4 + T6 + T5-check + T12-prep → T1 + T3 + T2.
- M2: T7 + T9 push/review + T10 + T11.
- M3 (owners): T8, Mongo/KMS live, OAuth live, real-sample replay, live
  tag, 7-scenario matrix. Critical path: shell → PRs → deploy.

## 5. Deployment checklist (senior/host)
Per §3 task 10 + §6 evidence below. Rollback revision recorded per deploy.

## 6. Test and evidence plan
- Local now: per-package `vitest run` (50 green today), `tsc --noEmit`,
  `ruff` + backend suites at PR time; replay test swaps fixture-only for
  a real sample.
- After hosting: 7-scenario matrix (Web call, then PSTN), tag-on-order
  screenshot, duplicate-redelivery-once log, `/health` + Versions page.
- Handover: matrix + recordings + PR links + scrub attestation. Billing
  and listing evidence explicitly out of scope.

## 7. Open decisions (recommended defaults — yes/no)
1. Flat-plan v1, usage later? YES. 2. Consent = DND-only? YES.
3. Address excluded? YES. 4. Env-key encryption, KMS later? YES.
5. Single-instance scheduler? YES. 6. Delete scoped helper after Option-1
   lock? YES. 7. SDK public repo acceptable? YES (retro-confirm).

## 8. Unasked-for (should-know)
- Leaked secrets outrank code risk: rotate before pilot; scrub per §12.
- Manual webhook must die at toml migration (double-fire).
- `Send test` proves nothing (dummy payload; server skips loudly by design).
- PSTN cuts undiagnosed: `scripts/compare-batches.ts` DID-compare is the
  next step, not prompt edits.
- `call_id: null` until dial — integrators key on `batch_id`; PR note it.
- `GET /call-batches` 500 class fixed on branch; dev's exact row still
  needs their traceback.
