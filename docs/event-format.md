# Standard event format (core — platform-neutral)

No `order`, `shopify`, `store`, `cart` names here. Those belong in adapters.

## InboundEvent (platform -> core -> TechLadder API)

| Field | Type | Meaning |
|---|---|---|
| `eventType` | string | `order_confirmation`, `cart_recovery`, `lead_callback`, ... Open string, keep minimal. |
| `contact` | `{name?, phone, language?}` | Phone 8-32 chars. PII: never log. |
| `context` | object | Free-form (order id, lead id, amounts). Passed to batch `metadata`. |
| `source` | string | `shopify`, `webhook`, `crm`, ... Lowercase. |
| `externalId` | string | Platform object id (order id, lead id). Maps to backend `external_id`. |
| `externalAccountId` | string | Tenant id (shop domain, account id). Maps to backend account scoping. |

Backend mapping: `externalId` -> `contacts[].external_id`, `context` -> `contacts[].metadata`, batch `idempotency_key` = `<source>:<eventType>:<externalId>`.
Verified: `techladder-core/app/domain/developer_integrations/call_batches/schemas.py:11-32`,
`techladder-core/app/domain/developer_integrations/webhooks/service.py:67-74`.

## CallCompletedEvent (TechLadder -> adapter -> platform)

| Field | Type | Meaning |
|---|---|---|
| `eventType` | `"call_completed"` | Fixed. Backend emits `call.completed`. |
| `outcome` | `confirmed\|cancelled\|no_answer\|failed` | Adapter maps to tags/notes. |
| `summary`, `transcriptUrl`, `recordingUrl` | optional | From `GET .../result`, `.../transcript`, `.../recording-url`. |
| `callId`, `batchId?` | string | Backend `call_id`, `schedule_id`. |
| `source`, `externalId`, `externalAccountId` | string | Echo of inbound routing keys so adapter can write back. |

Zod: `packages/core/src/events/types.ts` (`InboundEventSchema`, `CallCompletedEventSchema`).
