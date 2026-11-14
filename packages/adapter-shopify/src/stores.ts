// Store interfaces (senior item 3). In-memory implementations run the test
// connector; a Mongo/KMS implementation replaces them at staging with no
// caller changes. Tokens/keys at rest MUST be encrypted there — never here.
import type { ShopRecord, ShopStore } from "./shopStore.js";

export { InMemoryShopStore } from "./shopStore.js";
export type { ShopRecord, ShopStore } from "./shopStore.js";

export interface CallRecord {
  shop: string;
  orderId: string;
  externalId: string;
  callId?: string;
  batchId?: string;
  idempotencyKey: string;
  status: string;
  outcome?: string;
  tagApplied?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallLedger {
  save(record: CallRecord): Promise<void> | void;
  /** Lookup by TechLadder callId first, then platform externalId. */
  lookup(key: string): Promise<{ shop: string; orderId: string } | null> | { shop: string; orderId: string } | null;
  update(key: string, patch: Partial<CallRecord>): Promise<void> | void;
}

export class InMemoryCallLedger implements CallLedger {
  private readonly byKey = new Map<string, CallRecord>();

  save(record: CallRecord): void {
    this.byKey.set(record.externalId, record);
    if (record.callId) this.byKey.set(record.callId, record);
  }

  lookup(key: string): { shop: string; orderId: string } | null {
    const r = this.byKey.get(key);
    return r ? { shop: r.shop, orderId: r.orderId } : null;
  }

  update(key: string, patch: Partial<CallRecord>): void {
    const r = this.byKey.get(key);
    if (r) this.byKey.set(key, { ...r, ...patch, updatedAt: new Date().toISOString() });
  }
}

export interface EventClaim {
  /** Atomically claim eventId. True = first claim (process), false = duplicate. */
  claim(eventId: string): Promise<boolean> | boolean;
}

export class InMemoryEventClaim implements EventClaim {
  private readonly seen = new Set<string>();
  claim(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}
