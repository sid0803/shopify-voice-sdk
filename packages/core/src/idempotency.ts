// Idempotency key helper.
// Verified backend rule: PUT /call-batches dedupes by body `idempotency_key`
// scoped to the account (client_id), max 128 chars.
// techladder-core/app/domain/developer_integrations/call_batches/schemas.py:150-168
// techladder-core/app/db/indexes.py:929-936
// Neutral format: <source>:<eventType>:<externalId> so any platform can build it
// (e.g. "shopify:order_confirmation:123" or "crm:lead_callback:abc").
// COLLISION WARNING (senior decision): backend scopes by TechLadder account (client_id),
// NOT by shop. If one sk_ is shared across shops, two shops with the same order id
// collide. Use buildScopedIdempotencyKey with externalAccountId in that case,
// or prefer one sk_ per shop.

export function buildIdempotencyKey(source: string, eventType: string, externalId: string): string {
  const clean = (part: string, lower: boolean): string => {
    const t = part.trim().replace(/\s+/g, "-");
    if (!t) throw new Error("idempotency parts must be non-empty");
    return lower ? t.toLowerCase() : t;
  };
  const key = `${clean(source, true)}:${clean(eventType, true)}:${clean(externalId, false)}`;
  if (key.length <= 128) return key;
  // Truncate externalId tail to fit backend max length; keep prefix for readability.
  const overflow = key.length - 128;
  const shortExternal = clean(externalId, false).slice(0, Math.max(1, clean(externalId, false).length - overflow));
  return `${clean(source, true)}:${clean(eventType, true)}:${shortExternal}`;
}

/** Scoped variant for shared-sk_ setups: <source>:<account>:<eventType>:<externalId>. */
export function buildScopedIdempotencyKey(source: string, account: string, eventType: string, externalId: string): string {
  return buildIdempotencyKey(`${source}:${account}`, eventType, externalId);
}
