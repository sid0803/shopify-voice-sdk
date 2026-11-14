// Standard event format. No platform-specific fields.
// Core uses neutral words only: contact, event, context, source, externalId, externalAccountId.
// Backend field mapping: external_id <- doc.external_id/CONVERSATION_METADATA,
// batch_id <- schedule_id, call_id <- call_id/contact_id.
// See techladder-core/app/domain/developer_integrations/webhooks/service.py:120-167.

import { z } from "zod";

export const ContactSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().min(8).max(32),
  language: z.string().max(16).optional(),
});

export const InboundEventSchema = z.object({
  // e.g. order_confirmation, cart_recovery, lead_callback — open string, keep minimal.
  eventType: z.string().min(1).max(64),
  contact: ContactSchema,
  context: z.record(z.unknown()).default({}),
  source: z.string().min(1).max(64),
  externalId: z.string().min(1).max(120),
  externalAccountId: z.string().min(1).max(120),
});

// Canonical BUSINESS dispositions from the voice agent (customer intent).
// Source: SHOPIFY ORDER CONFIRMATION prompt v2.0 section 2 + section 10A.
// Seven values only — never execution statuses.
export const CallDispositionSchema = z.enum([
  "confirmed",
  "cancelled",
  "modification_requested",
  "callback_requested",
  "human_assistance",
  "uncertain",
  "wrong_number",
]);

// Call EXECUTION statuses, tracked by the calling platform/integration —
// never invented by the voice agent (prompt v2.0 section 2 + section 10E).
export const CallExecutionStatusSchema = z.enum(["completed", "no_answer", "failed"]);

export const CallCompletedEventSchema = z.object({
  eventType: z.literal("call_completed"),
  outcome: CallDispositionSchema,
  // Execution status rides along when the platform reports it (e.g. TechLadder
  // call.failed). Absent means completed — the common call.completed path.
  callStatus: CallExecutionStatusSchema.optional(),
  summary: z.string().optional(),
  transcriptUrl: z.string().optional(),
  recordingUrl: z.string().optional(),
  callId: z.string().min(1),
  batchId: z.string().optional(),
  source: z.string().min(1).max(64),
  externalId: z.string().min(1).max(120),
  externalAccountId: z.string().min(1).max(120),
});

export type Contact = z.infer<typeof ContactSchema>;
export type InboundEvent = z.infer<typeof InboundEventSchema>;
export type CallDisposition = z.infer<typeof CallDispositionSchema>;
export type CallExecutionStatus = z.infer<typeof CallExecutionStatusSchema>;
export type CallCompletedEvent = z.infer<typeof CallCompletedEventSchema>;
