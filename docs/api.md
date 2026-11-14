# TechLadder public API contracts (Phase 0 — verified from code)

> Source: `techladder-core` repo, read directly. No guessing.
> Anything marked `UNVERIFIED` was not found in code — see `backend-gaps.md`.
> All paths below are prefixed with `/api/v1/public` unless noted.
> Auth for all `/public/*` below: `Authorization: Bearer sk_...` via `get_current_api_key_user`.

Source routers:
- `techladder-core/app/domain/developer_integrations/router.py:12` (mounts at `/public`)
- `techladder-core/app/domain/developer_integrations/README.md` (dashboard-style payload notes)

## 0. Base URLs — UNVERIFIED

No hardcoded URLs in SDK. Use env:
- `TECHLADDER_ENV=production|staging` or `TECHLADDER_BASE_URL`
- Staging key from env var only. Never commit keys.

## 1. Account / API keys

File: `techladder-core/app/domain/developer_integrations/account_api/router.py`

- `POST /api-key` (dashboard access token) -> `{ data: { api_key: "sk_..." } }` — `router.py:23-33`
- `GET /api-key` -> list keys — `router.py:36-46`
- `DELETE /api-key/{api_key_id}` — `router.py:49-60`
- `GET /me` -> account info — `router.py:63-73`

## 2. Call batches

File: `techladder-core/app/domain/developer_integrations/call_batches/router.py`
Schemas: `.../call_batches/schemas.py`

- `POST /call-batches` -> 201 `DeveloperCreateCallBatchResponse` (`batch_id, agent_id, version_id, status, start_mode, total_contacts, accepted_contacts, rejected_contacts, validation_errors[], concurrency, created_at`) — `router.py:32-44`, `schemas.py:178-192`
- `PUT /call-batches` idempotent create, body `idempotency_key` (1-128 chars, aliases `idempotency_key|idempotencyKey`) — `router.py:47-68`, `schemas.py:150-168`
  - First: 201. Repeat same key (same account): 200 + `idempotent: true`, no duplicate — `router.py:59-68`
  - Uniqueness: `(client_id, idempotency_key)` partial unique index — `techladder-core/app/db/indexes.py:929-936`
  - NOTE: this is a body key, NOT the v2 `Idempotency-Key` header (`app/api/v2/schemas/common.py:14` is for dashboard v2 schedules only).
- `GET /call-batches?agent_id&status&created_at_from&created_at_to&limit(<=200)&page` — `router.py:71-97`
- `GET /call-batches/calls?external_id(required)&status&limit(<=200)&page` — scoped to API-key account, matches `external_id` + contact IDs incl. nested metadata — `router.py:100-119`, `README.md:192`
- `GET /call-batches/{batch_id}` — `router.py:122-133`
- `POST /call-batches/{batch_id}/start` -> 202 (200 if already running/queued) — `router.py:136-161`
- `POST /call-batches/{batch_id}/cancel` body `{cancel_active_calls, reason}` — `router.py:164-178`
- `GET /call-batches/{batch_id}/calls?status&external_id&limit(<=200)&page` — `router.py:181-202`
- `GET /call-batches/{batch_id}/results?outcome&status&transcript_status&limit(<=200)&page` — item fields: `call_id, external_id, phone_number, agent_id/name, version_id/name, voice, status/call_status, duration_seconds, answer_duration_seconds, created_at/completed_at, summary, outcomes, recording_available, recording_url (signed temp URL), llm_transcript` — `router.py:205-231`, `schemas.py:301-332`, `README.md:194-210`
- `GET /call-batches/{batch_id}/results/export.csv` -> `text/csv` — `router.py:234-255`

Create-batch request (aliases accepted, e.g. `agent_name|agent_id`, `version_name|version_id`, `did_number|did_number_id`, `batch_call_concurrency|concurrency`, `schedule_timezone|timezone`):
`agent_id|agent_name (one required), version_id|version_name (one required), voice?, did_number_id|did_number?, interruption: bool, use_alternate_number: bool, start_mode: manual|immediate|scheduled, schedule_date+schedule_time or scheduled_at (if scheduled), timezone, concurrency?, callback_url?, metadata?, deduplicate_by_phone?, recording_enabled?, contacts[]: {external_id|contact_id|externalId (required), name?, phone_number (8-32 chars, required), alternate_number?, metadata{}, status}` — `schemas.py:11-136`, `README.md:38-99`

## 3. Single calls

File: `techladder-core/app/domain/developer_integrations/calls/router.py`

- `POST /calls` -> 202 `{call queued}` — `router.py:45-56`
- `POST /calls/test` -> 202 — `router.py:31-42`
- `GET /calls?agent_id&version_id&batch_id&status&external_id&phone_number&is_test&created_at_from&created_at_to&limit(<=200)&page` — `router.py:59-95`
- `GET /calls/{call_id}` — `router.py:98-109`
- `GET /calls/{call_id}/result` — 200 always; message differs `ready` vs `still processing` — `router.py:112-128`
- `GET /calls/{call_id}/transcript` — `router.py:131-142`
- `POST /calls/{call_id}/recording-url` body `{expires_in_seconds}` -> signed URL (recording file keys are NOT platform URLs — fixed in backend) — `router.py:145-161`, `README.md:245`

## 4. Call records

File: `techladder-core/app/domain/developer_integrations/call_records/router.py`

- `GET /call-records?start_date(YYYY-MM-DD, required)&end_date(required)&agent_id[]&page&page_size(<=DEVELOPER_CALLS_MAX_PAGE_SIZE, default 200)` — inclusive UTC days, `start_date <= end_date` else 422 — `router.py:23-53`, `README.md:220-232`

## 5. Webhook endpoints (outbound TechLadder -> adapter)

Files:
- `techladder-core/app/domain/developer_integrations/webhooks/router.py`
- `techladder-core/app/domain/developer_integrations/webhooks/service.py`
- `techladder-core/app/domain/developer_integrations/webhooks/schemas.py`

Management:
- `POST /webhook-endpoints` body `{url (https), description?, events[] (min 1)}` -> 201 `{webhook_endpoint_id (wh_...), url, description, events, status, signing_secret (whsec_...), created_at}`. Secret shown ONLY here — `router.py:26-37`, `service.py:248-275`, `schemas.py:34-54`
- `GET /webhook-endpoints` -> `{items[]}` without secrets — `router.py:40-50`, `service.py:278-295`
- `PATCH /webhook-endpoints/{id}` body `{url?, description?, events?, status?}` — `router.py:53-69`, `service.py:298-339`
- `DELETE /webhook-endpoints/{id}` -> soft delete + `disabled` — `router.py:72-86`, `service.py:342-362`
- `POST /webhook-endpoints/{id}/test` (must be `active`, else 422) -> queues `webhook.test` event, returns `{event_id (evt_test_...), event, delivery_status: queued}` — `router.py:89-103`, `service.py:365-404`

Delivery contract (what SDK `verifyWebhook` must check):
- Body bytes: `json.dumps(payload, separators=(",",":"), ensure_ascii=False).encode("utf-8")` — `service.py:198-199`
- `base_string = timestamp_bytes + b"." + body` ; `digest = hex(HMAC_SHA256(secret, base_string))` — `service.py:202-210`
- Headers sent: `X-TechLadder-Event-Id`, `X-TechLadder-Timestamp` (= `iso_now()` e.g. `2026-...Z`), `X-TechLadder-Signature: sha256={digest}`, `X-TechLadder-Api-Version: 2026-04-25`, `Content-Type: application/json` — `service.py:211-217`
- Envelope: `{event_id (evt_...), event, api_version, created_at, data}` — `service.py:188-195`
- Events enum: `webhook.test, call.queued|ringing|answered|completed|failed|cancelled, transcript.ready|failed, analysis.ready|failed, batch.started|completed|cancelled|failed` — `schemas.py:10-25`
- `call.completed` data fields: `call_id, agent_id, version_id, batch_id (from schedule_id), external_id, phone_number, status, duration_seconds, answer_duration_seconds, disconnect_reason, transcript_status, analysis_status, metadata, started_at, answered_at, ended_at, failure_code/reason` — `service.py:120-144`
- `analysis.ready` data adds `summary, outcomes{}, extracted_fields{}, recording{available, file_key}` — `service.py:147-167`
- Transport: 20s timeout, 2xx = `delivered`, else retry at +1h, +6h, +1d then `failed` — `service.py:28-33,519-604`
- Per-batch `callback_url` field exists on create (`schemas.py:118`) and is delivered UNSIGNED (`signing_secret=""`, `target_type="callback_url"`) — `service.py:479-487`. Prefer registered endpoints for Shopify. UNVERIFIED for production use.

What `POST /{id}/test` sends: envelope with `event=webhook.test`, `data={webhook_endpoint_id}` — `service.py:376-389`.

## 6. Response / error envelope — confirmed

- Success: `{status_code, message, error: null, data}` — e.g. `webhooks/router.py:32-37`
- Shared error type: `{code, details[]}` (`DeveloperApiError`) — `response_schemas.py:6-8`
- UNVERIFIED: exact `code` strings for 401/404/422/429 and rate-limit headers — not found in public routers. See `backend-gaps.md`.
