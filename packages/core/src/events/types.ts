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

export const CallOutcomeSchema = z.enum(["confirmed", "cancelled", "no_answer", "failed"]);

export const CallCompletedEventSchema = z.object({
  eventType: z.literal("call_completed"),
  outcome: CallOutcomeSchema,
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
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;
export type CallCompletedEvent = z.infer<typeof CallCompletedEventSchema>;
