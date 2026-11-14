// Webhook de-duplication: skip already-seen event IDs.
// Backend emits evt_... per delivery; sync jobs guard with webhook_events_emitted
// (techladder-core/app/domain/developer_integrations/webhooks/service.py:700-730).
// Adapter side needs the same guard. Pluggable store, in-memory default.

export interface WebhookEventStore {
  has(eventId: string): boolean | Promise<boolean>;
  add(eventId: string): void | Promise<void>;
}

export class InMemoryWebhookStore implements WebhookEventStore {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxSize = 10_000, private readonly ttlMs = 24 * 3600 * 1000) {}

  has(eventId: string): boolean {
    this.prune();
    return this.seen.has(eventId);
  }

  add(eventId: string): void {
    this.prune();
    if (this.seen.size >= this.maxSize) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest) this.seen.delete(oldest);
    }
    this.seen.set(eventId, Date.now());
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.seen) if (v < cutoff) this.seen.delete(k);
  }
}

/** Returns true if this event should be processed (first seen), false if duplicate. */
export async function shouldProcessEvent(store: WebhookEventStore, eventId: string): Promise<boolean> {
  if (await store.has(eventId)) return false;
  await store.add(eventId);
  return true;
}
