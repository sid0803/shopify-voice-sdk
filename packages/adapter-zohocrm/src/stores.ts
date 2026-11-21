// Zoho store interfaces. In-memory implementations run tests and local dev;
// Mongo implementations (mongo/stores.ts) replace them at staging with no
// caller changes. Tokens/keys at rest MUST be encrypted there — never here.
export interface ZohoConnectionRecord {
  /** Lowercased Zoho org id. */
  orgId: string;
  dataCenter: string;
  /** Encrypted access token envelope (v1.). Plaintext only in memory. */
  accessTokenEnc: string;
  refreshTokenEnc: string;
  /** Resolved logical -> API-name field map from metadata inspection. */
  fieldMap: Record<string, string | null>;
  status: "connected" | "disconnected";
  createdAt: string;
  updatedAt: string;
}

export interface ZohoConnectionStore {
  get(orgId: string): ZohoConnectionRecord | Promise<ZohoConnectionRecord | null> | null;
  save(record: ZohoConnectionRecord): Promise<void> | void;
  remove?(orgId: string): Promise<void> | void;
}

export class InMemoryZohoConnectionStore implements ZohoConnectionStore {
  private readonly map = new Map<string, ZohoConnectionRecord>();
  get(orgId: string): ZohoConnectionRecord | null {
    return this.map.get(orgId.toLowerCase()) ?? null;
  }
  save(record: ZohoConnectionRecord): void {
    this.map.set(record.orgId.toLowerCase(), { ...record, orgId: record.orgId.toLowerCase() });
  }
  remove(orgId: string): void {
    this.map.delete(orgId.toLowerCase());
  }
}

export interface ZohoLeadRecord {
  orgId: string;
  /** Zoho module API name (Leads/Contacts/Deals). */
  module: string;
  /** Zoho record id. Stable handle for write-back and ledger identity. */
  recordId: string;
  /** Mirrors recordId; the key TechLadder events carry back as external_id. */
  externalId: string;
  callId?: string;
  batchId?: string;
  idempotencyKey: string;
  status: string;
  outcome?: string;
  callStatus?: string;
  labelApplied?: string;
  recordingUrl?: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ZohoLeadLedger {
  save(record: ZohoLeadRecord): Promise<void> | void;
  /** Lookup by TechLadder callId, then batchId, then Zoho record id. */
  lookup(key: string): Promise<{ orgId: string; recordId: string; module: string } | null> | { orgId: string; recordId: string; module: string } | null;
  update(key: string, patch: Partial<ZohoLeadRecord>): Promise<void> | void;
  /** Read-only call log per org. */
  list(orgId: string, limit?: number): Promise<ZohoLeadRecord[]> | ZohoLeadRecord[];
  /** Org disconnect: delete every lead row for an org. */
  deleteOrg?(orgId: string): Promise<void> | void;
}

export class InMemoryZohoLeadLedger implements ZohoLeadLedger {
  private readonly byKey = new Map<string, ZohoLeadRecord>();
  private readonly records = new Map<string, ZohoLeadRecord>();

  private rowKey(r: ZohoLeadRecord): string {
    return `${r.orgId}|${r.externalId}`;
  }

  save(record: ZohoLeadRecord): void {
    const key = this.rowKey(record);
    this.records.set(key, record);
    this.byKey.set(record.externalId, record);
    if (record.callId) this.byKey.set(record.callId, record);
    if (record.batchId) this.byKey.set(record.batchId, record);
  }

  lookup(key: string): { orgId: string; recordId: string; module: string } | null {
    const r = this.byKey.get(key);
    return r ? { orgId: r.orgId, recordId: r.recordId, module: r.module } : null;
  }

  update(key: string, patch: Partial<ZohoLeadRecord>): void {
    const r = this.byKey.get(key);
    if (!r) return;
    const next = { ...r, ...patch, updatedAt: new Date().toISOString() };
    this.save(next);
  }

  list(orgId: string, limit = 100): ZohoLeadRecord[] {
    return [...this.records.values()]
      .filter((r) => r.orgId === orgId.toLowerCase())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  deleteOrg(orgId: string): void {
    const target = orgId.toLowerCase();
    for (const [key, r] of this.records) {
      if (r.orgId !== target) continue;
      this.records.delete(key);
      this.byKey.delete(r.externalId);
      if (r.callId) this.byKey.delete(r.callId);
      if (r.batchId) this.byKey.delete(r.batchId);
    }
  }
}

export interface ZohoEventClaim {
  /** Atomically claim eventId. True = first claim (process), false = duplicate. */
  claim(eventId: string): Promise<boolean> | boolean;
  /** Release a claim so a redelivery can reprocess (transient failures only). */
  release(eventId: string): Promise<void> | void;
}

export class InMemoryZohoEventClaim implements ZohoEventClaim {
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
