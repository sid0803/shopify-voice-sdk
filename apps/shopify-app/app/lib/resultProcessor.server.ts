// TechLadder result -> Shopify order tag. The ledger is the only source of
// shop/order identity; nothing in the webhook payload is trusted for that.
import {
  createShopifyAdapter,
  defaultSettings,
  resolveResultTag,
  toCallResultAsync,
  withEnvFallbacks,
} from "@techladder/adapter-shopify";
import { getStores } from "./stores.server.js";
import shopify from "../shopify.server";

export interface ResultJobPayload {
  shop: string;
  /** TechLadder event id; released if the job finally fails. */
  eventId?: string;
  envelope: Record<string, unknown>;
}

export async function processResultJob(payload: ResultJobPayload): Promise<string> {
  const stores = await getStores();
  const result = await toCallResultAsync(payload.envelope, {
    lookup: async (key) => stores.ledger.lookup(key),
  });
  if (!result) return "ignored:no-ledger-match";

  // The ledger is authoritative; payload.shop is only a hint from the route.
  const shop = result.externalAccountId.toLowerCase();
  const stored =
    (await stores.settings.get(shop)) ?? (await stores.settings.get(payload.shop));
  const settings = withEnvFallbacks(stored ?? defaultSettings(shop));

  const basePatch = {
    outcome: result.outcome,
    ...(result.callStatus ? { callStatus: result.callStatus } : {}),
    ...(result.recordingUrl ? { recordingUrl: result.recordingUrl } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
  };
  const writeLedger = async (status: string, tagApplied?: string) => {
    const patch = { ...basePatch, status, ...(tagApplied ? { tagApplied } : {}) };
    for (const key of [result.callId, result.externalId, result.batchId ?? ""]) {
      if (key) await stores.ledger.update(key, patch);
    }
  };

  // Tags are a per-shop opt-in. Still record the outcome so the call log and
  // reconciliation see it as finished instead of retrying forever.
  if (!settings.tagsEnabled) {
    await writeLedger("result");
    return `result:${result.outcome}:tags-disabled`;
  }

  const { session } = await shopify.unauthenticated.admin(shop);
  const adapter = createShopifyAdapter({
    apiSecret: process.env.SHOPIFY_API_SECRET ?? "",
    accessToken: session.accessToken,
    tagNames: settings.tagNames,
  });
  await adapter.handleResult(result, {
    externalAccountId: shop,
    config: { apiSecret: process.env.SHOPIFY_API_SECRET ?? "", tagNames: settings.tagNames },
  });

  await writeLedger("tagged", resolveResultTag(result, settings.tagNames));
  return `tagged:${result.outcome}`;
}
