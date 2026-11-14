// Platform adapter interface (types only — no Shopify code in core).
// Adapters depend on core. Core never imports adapters.
// 1. verifyIncoming: platform's own signature check (e.g. Shopify HMAC) — NOT TechLadder's.
// 2. toStandardEvent: platform event -> neutral InboundEvent. null = ignore.
// 3. handleResult: write call result back to the platform (e.g. order tags/notes).

import type { CallCompletedEvent, InboundEvent } from "./events/types.js";

export interface AdapterContext<TConfig = unknown> {
  /** Neutral tenant id. For Shopify: shop domain. Never a platform-specific name in core. */
  externalAccountId: string;
  config: TConfig;
}

export interface RawIncomingRequest {
  rawBody: Uint8Array | string;
  headers: Record<string, string | string[] | undefined>;
}

export interface PlatformAdapter<TPlatformEvent, TConfig = unknown> {
  /** e.g. "shopify", "webhook", "crm" */
  name: string;
  verifyIncoming(request: RawIncomingRequest): Promise<void>;
  toStandardEvent(platformEvent: TPlatformEvent): InboundEvent | null;
  handleResult(result: CallCompletedEvent, ctx: AdapterContext<TConfig>): Promise<void>;
}
