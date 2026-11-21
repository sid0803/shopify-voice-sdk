// Persistent background job queue. Webhook receivers only enqueue and ack;
// a worker executes the fetch/call/write-back work later. Mirrors the
// Shopify adapter queue shape; duplicated (not imported) so adapters stay
// independently deployable.
import type { Col, Docs } from "./mongo/collection.js";

export type ZohoJobType = "zoho.lead" | "zoho.result" | "zoho.reconcile";

export interface ZohoJobRecord {
  id: string;
  type: ZohoJobType;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set while running so a crashed worker's job can be reclaimed. */
  lockedAt?: string;
  lastError?: string;
}

export interface ZohoJobQueue {
  /** True when inserted; false when the same id already exists (dedupe). */
  enqueue(
    job: Pick<ZohoJobRecord, "id" | "type" | "payload"> &
      Partial<Pick<ZohoJobRecord, "maxAttempts" | "runAt">>
  ): Promise<boolean> | boolean;
  claimNext(nowIso?: string): Promise<ZohoJobRecord | null> | ZohoJobRecord | null;
  complete(id: string): Promise<void> | void;
  fail(id: string, error: string, retryAfterMs?: number): Promise<void> | void;
  /** Org disconnect: stop pending work for an org. */
  deleteForOrg?(orgId: string): Promise<void> | void;
  /** Drop queued jobs for one record. */
  deleteForRecord?(orgId: string, recordId: string): Promise<void> | void;
}

/** A running job older than this is assumed crashed and may be reclaimed. */
export const ZOHO_JOB_LEASE_MS = 5 * 60_000;

function fresh(job: Parameters<ZohoJobQueue["enqueue"]>[0]): ZohoJobRecord {
  const now = new Date().toISOString();
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    status: "pending",
    attempts: 0,
    maxAttempts: job.maxAttempts ?? 5,
    runAt: job.runAt ?? now,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryZohoJobQueue implements ZohoJobQueue {
  private readonly jobs = new Map<string, ZohoJobRecord>();

  enqueue(job: Parameters<ZohoJobQueue["enqueue"]>[0]): boolean {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, fresh(job));
    return true;
  }

  claimNext(nowIso = new Date().toISOString()): ZohoJobRecord | null {
    const now = Date.parse(nowIso);
    const staleBefore = now - ZOHO_JOB_LEASE_MS;
    for (const job of this.jobs.values()) {
      const due = job.status === "pending" && job.runAt <= nowIso;
      const stale =
        job.status === "running" && Boolean(job.lockedAt) && Date.parse(job.lockedAt as string) < staleBefore;
      if (!due && !stale) continue;
      job.status = "running";
      job.attempts += 1;
      job.updatedAt = new Date().toISOString();
      job.lockedAt = nowIso;
      return { ...job };
    }
    return null;
  }

  complete(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      delete job.lockedAt;
    }
  }

  fail(id: string, error: string, retryAfterMs = 30_000): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lastError = error.slice(0, 500);
    job.updatedAt = new Date().toISOString();
    delete job.lockedAt;
    if (job.attempts >= job.maxAttempts) {
      job.status = "failed";
    } else {
      job.status = "pending";
      job.runAt = new Date(Date.now() + retryAfterMs).toISOString();
    }
  }

  deleteForOrg(orgId: string): void {
    const target = orgId.toLowerCase();
    for (const [id, job] of this.jobs) {
      if (String(job.payload["orgId"] ?? "").toLowerCase() === target) this.jobs.delete(id);
    }
  }

  deleteForRecord(orgId: string, recordId: string): void {
    const target = orgId.toLowerCase();
    for (const [id, job] of this.jobs) {
      if (
        String(job.payload["orgId"] ?? "").toLowerCase() === target &&
        String(job.payload["recordId"] ?? "") === recordId
      ) {
        this.jobs.delete(id);
      }
    }
  }
}

export async function ensureZohoJobIndexes(col: Col): Promise<void> {
  await col.createIndex({ id: 1 }, { unique: true });
  await col.createIndex({ status: 1, runAt: 1 });
}

function toJob(doc: Docs): ZohoJobRecord {
  const { _id: _ignored, ...rest } = doc;
  return rest as unknown as ZohoJobRecord;
}

function requireDeleteMany(col: Col): (filter: Docs) => Promise<{ deletedCount: number }> {
  if (!col.deleteMany) throw new Error("Mongo collection does not implement deleteMany");
  return col.deleteMany.bind(col);
}

export class MongoZohoJobQueue implements ZohoJobQueue {
  constructor(private readonly col: Col) {}

  async enqueue(job: Parameters<ZohoJobQueue["enqueue"]>[0]): Promise<boolean> {
    try {
      await this.col.insertOne(fresh(job) as unknown as Docs);
      return true;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return false;
      throw err;
    }
  }

  async claimNext(nowIso = new Date().toISOString()): Promise<ZohoJobRecord | null> {
    // Only claim work that is due. Selecting the first pending row regardless
    // of runAt would let one delayed retry block every ready job behind it.
    const staleBefore = new Date(Date.parse(nowIso) - ZOHO_JOB_LEASE_MS).toISOString();
    const doc =
      (await this.col.findOne({ status: "pending", runAt: { $lte: nowIso } } as unknown as Docs)) ??
      (await this.col.findOne({
        status: "running",
        lockedAt: { $lt: staleBefore },
      } as unknown as Docs));
    if (!doc) return null;

    const job = toJob(doc);
    const patch = {
      status: "running" as const,
      attempts: job.attempts + 1,
      updatedAt: nowIso,
      lockedAt: nowIso,
    };
    const filter =
      job.status === "pending"
        ? ({ id: job.id, status: "pending" } as Docs)
        : ({ id: job.id, status: "running", lockedAt: doc["lockedAt"] } as Docs);
    const res = await this.col.updateOne(filter, { $set: patch });
    if (res.matchedCount === 0) return null;
    return { ...job, ...patch };
  }

  async complete(id: string): Promise<void> {
    await this.col.updateOne(
      { id },
      {
        $set: { status: "done", updatedAt: new Date().toISOString() },
        $unset: { lockedAt: "" },
      },
    );
  }

  async fail(id: string, error: string, retryAfterMs = 30_000): Promise<void> {
    const doc = await this.col.findOne({ id });
    if (!doc) return;
    const job = toJob(doc);
    const final = job.attempts >= job.maxAttempts;
    await this.col.updateOne(
      { id },
      {
        $set: {
          status: final ? "failed" : "pending",
          lastError: error.slice(0, 500),
          updatedAt: new Date().toISOString(),
          ...(final ? {} : { runAt: new Date(Date.now() + retryAfterMs).toISOString() }),
        },
        $unset: { lockedAt: "" },
      },
    );
  }

  async deleteForOrg(orgId: string): Promise<void> {
    await requireDeleteMany(this.col)({ "payload.orgId": orgId.toLowerCase() });
  }

  async deleteForRecord(orgId: string, recordId: string): Promise<void> {
    await requireDeleteMany(this.col)({
      "payload.orgId": orgId.toLowerCase(),
      "payload.recordId": recordId,
    });
  }
}
