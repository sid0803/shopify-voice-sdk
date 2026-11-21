# Zoho CRM — Architecture Decisions (P1/P2)

Status: **proposed**. Only one item needs a product-level call (D5 consent
source of truth). Everything else is an engineering default below — approve
or correct per line.

Context: P0 landed (`c0ad8a0` — `packages/adapter-zohocrm/` with config,
settings, mapping, 3-method adapter, 14 tests). Recon across
`techladder-core` / infra / dashboard found zero Zoho references and confirmed
core already exposes everything P1 needs (idempotent `POST /calls`,
`PUT /call-batches`, signed webhooks, `GET /me`). **No core changes for P1.**
If core ever needs changes, they go on a feature branch in `techladder-core` —
never `main`. Same rule for infra/dashboard.

Each decision follows: decision → reason → trade-off → failure → validation.

## D1 — Trigger scope: Leads in P1, Deals in P3

**Decision:** P1 wires Leads (+ Contacts shares the path free). Deals comes
after Leads are stable, as a separate module adapter — not a fork of the
integration.

**Reason:** Leads are the natural first outbound-call object; one object type
validates the whole lifecycle (webhook → fetch → eligibility → queue → call
→ write-back). Deals differ in ownership, stage transitions and value
filtering — supporting both day one multiplies test/maintenance surface.

**Trade-off:** A merchant whose use case is deal-stuck follow-up waits for P3.

**Failure if wrong:** Mixed-module bugs (deal stage machine called like a lead)
ship silently. Mitigation: `moduleToEventType` returns `null` for
non-enabled modules — unknown modules are ignored, never called.

**Validation:** P1 E2E on Leads only; Deals webhook in P1 test org must
produce `ignored:module-disabled`, never a call.

## D2 — Write-back: Note + custom fields, metadata-driven mapping

**Decision:** Every result writes both: a **Note** (human-readable summary)
and **record fields** (machine-readable outcome). P0's `outcomeField`
default (`Call_Outcome`) is a fallback only — P1 adds a `fieldMapper` that
reads Zoho Fields Metadata API at connect time and caches label → API-name →
type per org.

**Reason:** Notes are the audit trail humans read; fields are what reports,
filters and workflows act on. Different orgs have different custom fields —
hardcoded API names break on the second customer.

**Trade-off:** Connect flow gains a metadata fetch + mapping screen.

**Failure if wrong:** Write-back 4xx on orgs missing the field. Mitigation:
validate mapped fields at save time; fail the write-back loudly (settled
error, no silent drop) and surface it in the call log.

**Validation:** Two test orgs with different field sets; both write back
correctly; org missing the field shows a config error, not a lost result.
Proposed logical fields (confirm API names per org via metadata):
`TechLadder_Call_Status`, `TechLadder_Last_Call_At`, `TechLadder_Call_ID`,
`TechLadder_Call_Duration`, `TechLadder_Call_Outcome`.

## D3 — Hosting: library now, shopify-app-pattern shell later

**Decision:** P1 is a library (`adapter-zohocrm`) — no hosting at all. P2's
shell (webhook receiver, lead processor) follows the `apps/shopify-app`
pattern: its own app module/task on the same cluster, sharing nothing but
core client conventions. Webhook processing is async via the existing
queue/claim pattern; **a slow Zoho API call never blocks the call pipeline.**

**Reason:** Our Shopify integration does not live in the core backend ECS
service — it lives in the SDK shell, and core stays neutral (AGENTS.md). Putting
Zoho inside `techladder-core` would couple platform glue to the voice API,
break the adapter pattern, and force core deploys for CRM UI tweaks.

**Trade-off:** A second deployable when P2 ships (same Dockerfile pattern as
shopify-app, so marginal cost).

**Failure if wrong:** Sync Zoho calls in the call path → pipeline stalls on
Zoho latency/outage. Mitigation: fast-ack routes (verify → claim → enqueue →
2xx), worker owns retries, 503 + claim-release on transient failure.

**Validation:** Load test with Zoho API stubbed at 5s latency — call
throughput unchanged, queue drains on recovery.

## D4 — OAuth: one app, per-org tokens

**Decision:** One TechLadder Zoho OAuth client (ID + secret in secret
manager). Each connected org yields its own access + refresh token pair,
stored encrypted (AES-256-GCM, same envelope as Shopify secrets), keyed by
org id, refreshed independently. Tokens never cross orgs.

**Reason:** Standard multi-tenant SaaS. 50 customers = 50 token pairs, not 50
OAuth apps. Zoho grants/tokens are org-specific by design.

**Trade-off:** Token isolation becomes our correctness burden.

**Failure if wrong:** Org A calls with Org B's token → cross-org data leak.
Mitigation: store layer namespaces by lowercased org id; every read/write
takes org id; integration test connects two orgs, revokes one, proves the
other is unaffected.

**Validation:** Two-org test: independent connect, independent refresh,
revoke-A-keeps-B-green, expired-token refresh under load.

## D5 — Consent/DND: three layers, fail closed, in P1 — NOT deferred

**Decision:** Eligibility is checked on every call attempt:
1. **Zoho record** — DND/consent fields + phone presence (fields TBD at
   metadata inspection; never assume a populated phone = permission).
2. **TechLadder suppression** — `blockedPhones` + central opt-out records.
3. **Decision:** explicit opt-out or revoked consent from *either* source
   blocks; required-but-unverifiable consent blocks. Only verified-eligible
   calls proceed. TechLadder central suppression is authoritative and cannot
   be overridden by a CRM update.

**Reason:** Calling-compliance failure is a legal event, not a bug. The check
must exist in the first version that dials (P1's call path), not as P2
hardening.

**Trade-off:** Extra reads per attempt; some callable-looking records get
skipped until consent fields are mapped.

**Failure if wrong:** Call to an opted-out number. Mitigation: fail-closed
defaults, DND list checked before any API call, every skip logged with reason
(`skipped:dnc`, `skipped:consent-unverified`).

**Validation:** Matrix test — opt-out in Zoho only / suppression only / both /
neither; revoked-consent mid-campaign stops further attempts.
**Needs product/senior:** authoritative consent source + applicable
calling-eligibility policy (India telecom/privacy). This is the one
non-engineering call.

## D6 — Idempotency: key format + claim dedupe

**Decision:** Idempotency key `zoho-{module}-{recordId}-{eventTs}` per org;
event-claim dedupe on webhook id at the receiver. Repeat delivery → 200
replay, never a duplicate call.

**Reason:** Zoho workflow webhooks retry; without this, retries = duplicate
calls. Core already returns 200 on idempotent replay — the adapter only has
to send a stable key.

**Trade-off:** Requires a stable per-event timestamp/id from Zoho.

**Failure if wrong:** Duplicate calls to the same lead. Mitigation: claim
table with unique index (same pattern as Shopify `claims.claim`).

**Validation (at metadata inspection):** confirm what unique delivery
identifier Zoho workflow webhooks carry; if none, dedupe on
`(recordId + record Updated_Time)` and document the edge.

## D7 — Module layout (TypeScript, this repo)

The guidance's Python layout maps to our packages 1:1 — no new top-level
dirs, no new repos:

```
packages/adapter-zohocrm/src/
  index.ts        # createZohoAdapter (3 methods) + outcome labels — DONE (P0)
  zohoConfig.ts   # DC map, scopes, modules, version — DONE (P0)
  settings.ts     # ZohoSettingsSchema + store — DONE (P0)
  mapping.ts      # extract/normalize/hours/slot — DONE (P0)
  oauth.ts        # authorize, refresh, per-org token store interface — P1
  client.ts       # authed Zoho REST client (records, notes, metadata) — P1
  fieldMapper.ts  # metadata → field map, validated at save — P1
  consent.ts      # 3-layer eligibility check — P1
  writeback.ts    # field update + note (extracted from index.handleResult) — P1
  stores.ts / queue.ts / reconcile.ts  # P2 (copied shapes, Mongo impl)
```

Shell (P2, `apps/`): connect route (OAuth + metadata mapping UI), workflow
webhook route (fast-ack), lead processor, result processor, call log.
`packages/core` untouched.

## Scope

- **P1 (adapter complete, no creds needed for most):** `oauth.ts`,
  `client.ts`, `fieldMapper.ts`, `consent.ts`, `writeback.ts` — all unit-tested
  with mocked HTTP. Blocked only by metadata inspection for field names (test
  org) — code ships with documented assumptions first.
- **P2 (shell + Leads E2E):** connect flow, webhook receiver, processors,
  ledger/queue, dev-org E2E + negative matrix.
- **P3 (Deals):** separate module adapter on the P1/P2 bones.

## Pending items

| Item | Owner | Status |
|---|---|---|
| D1 Leads-first, module-generic code | Engineering | Proposed above |
| D2 Note + fields, metadata mapping | Engineering | Proposed above |
| Actual field API names per org | CRM config (inspection) | Needs test org |
| D3 library now, shell later | Engineering | Proposed above |
| D4 one client, per-org tokens | Engineering | Proposed above |
| D5 consent source of truth + policy | **Product/Senior** | **Needs confirmation** |
| D6 webhook unique id | Engineering (inspection) | Validate at P1 |
| Deals support | Product | P3 scope confirmation |

## Validation gate before P2

Duplicate webhooks, token expiry mid-run, Zoho 4xx/5xx, DND/opt-out matrix,
missing-field org, revoke-one-org isolation, 5s-latency Zoho stub — all green
on the P1 suite + dev org before shell E2E counts as done.
