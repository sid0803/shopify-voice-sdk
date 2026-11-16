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
  /** Shopify customer id. Required for customers/redact + data_request. */
  customerId?: string;
  idempotencyKey: string;
  status: string;
  outcome?: string;
  callStatus?: string;
  tagApplied?: string;
  recordingUrl?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CallLedger {
  save(record: CallRecord): Promise<void> | void;
  /** Lookup by TechLadder callId, then batchId, then platform externalId. */
  lookup(key: string): Promise<{ shop: string; orderId: string } | null> | { shop: string; orderId: string } | null;
  update(key: string, patch: Partial<CallRecord>): Promise<void> | void;
  /** Read-only call log for the embedded admin screen. */
  list(shop: string, limit?: number): Promise<CallRecord[]> | CallRecord[];
  /** GDPR customers/redact: delete one customer's rows only, never the shop. */
  deleteCustomerData?(shop: string, customerId: string): Promise<void> | void;
  /** GDPR customers/data_request: return that customer's call log. */
  customerCallLog?(shop: string, customerId: string): Promise<CallRecord[]> | CallRecord[];
  /** shop/redact: delete every call row for a shop. */
  deleteShop?(shop: string): Promise<void> | void;
}

export class InMemoryCallLedger implements CallLedger {
  private readonly byKey = new Map<string, CallRecord>();
  private readonly records = new Map<string, CallRecord>();

  save(record: CallRecord): void {
    this.byKey.set(record.externalId, record);
    if (record.callId) this.byKey.set(record.callId, record);
    if (record.batchId) this.byKey.set(record.batchId, record);
    this.records.set(record.externalId, record);
  }

  lookup(key: string): { shop: string; orderId: string } | null {
    const r = this.byKey.get(key);
    return r ? { shop: r.shop, orderId: r.orderId } : null;
  }

  update(key: string, patch: Partial<CallRecord>): void {
    const r = this.byKey.get(key);
    if (!r) return;
    const next = { ...r, ...patch, updatedAt: new Date().toISOString() };
    this.save(next);
  }

  list(shop: string, limit = 100): CallRecord[] {
    return [...this.records.values()]
      .filter((r) => r.shop === shop.toLowerCase())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  deleteCustomerData(shop: string, customerId: string): void {
    for (const [externalId, r] of this.records) {
      if (r.shop === shop.toLowerCase() && r.customerId === customerId) {
        this.records.delete(externalId);
        this.byKey.delete(externalId);
        if (r.callId) this.byKey.delete(r.callId);
        if (r.batchId) this.byKey.delete(r.batchId);
      }
    }
  }

  customerCallLog(shop: string, customerId: string): CallRecord[] {
    return [...this.records.values()].filter(
      (r) => r.shop === shop.toLowerCase() && r.customerId === customerId,
    );
  }

  deleteShop(shop: string): void {
    for (const [externalId, r] of this.records) {
      if (r.shop === shop.toLowerCase()) {
        this.records.delete(externalId);
        this.byKey.delete(externalId);
        if (r.callId) this.byKey.delete(r.callId);
        if (r.batchId) this.byKey.delete(r.batchId);
      }
    }
  }
}

export interface EventClaim {
  /** Atomically claim eventId. True = first claim (process), false = duplicate. */
  claim(eventId: string): Promise<boolean> | boolean;
  /** Release a claim so a redelivery can reprocess (transient failures only). */
  release(eventId: string): Promise<void> | void;
}

export class InMemoryEventClaim implements EventClaim {
  private readonly seen = new Set<string>();
  claim(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
  release(eventId: string): void {
    this.seen.delete(eventId);
  }
}
