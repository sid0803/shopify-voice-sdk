// Store factory for the Shopify shell.
//
// - MONGODB_URI set  -> durable Mongo stores (shops/settings/calls/events/jobs)
// - otherwise        -> in-memory stores for local/dev (lost on restart)
//
// Secrets at rest are encrypted by the adapter's Mongo stores; this module
// never sees or logs plaintext tokens.
import {
  InMemoryCallLedger,
  InMemoryEventClaim,
  InMemoryJobQueue,
  InMemorySettingsStore,
  InMemoryShopStore,
  MongoCallLedger,
  MongoEventClaim,
  MongoJobQueue,
  MongoSettingsStore,
  MongoShopStore,
  createGdprStore,
  ensureCallIndexes,
  ensureEventIndexes,
  ensureJobIndexes,
  ensureSettingsIndexes,
  ensureShopIndexes,
  getDb,
} from "@techladder/adapter-shopify";
import type {
  CallLedger,
  Col,
  EventClaim,
  GdprStore,
  JobQueue,
  SettingsStore,
  ShopStore,
} from "@techladder/adapter-shopify";

export interface RuntimeStores {
  mode: "mongo" | "memory";
  shops: ShopStore;
  settings: SettingsStore;
  ledger: CallLedger;
  claims: EventClaim;
  queue: JobQueue;
  gdpr: GdprStore;
}

type StoreGlobal = typeof globalThis & { __techladderStores?: Promise<RuntimeStores> };
const storeGlobal = globalThis as StoreGlobal;

async function mongoCol(name: string): Promise<Col> {
  const db = await getDb();
  return db.collection(name) as unknown as Col;
}

async function createMongoStores(): Promise<RuntimeStores> {
  const [shopsCol, settingsCol, callsCol, eventsCol, jobsCol] = await Promise.all([
    mongoCol("shops"),
    mongoCol("settings"),
    mongoCol("calls"),
    mongoCol("webhook_events"),
    mongoCol("jobs"),
  ]);
  await Promise.all([
    ensureShopIndexes(shopsCol),
    ensureSettingsIndexes(settingsCol),
    ensureCallIndexes(callsCol),
    ensureEventIndexes(eventsCol),
    ensureJobIndexes(jobsCol),
  ]);
  const shops = new MongoShopStore(shopsCol);
  const ledger = new MongoCallLedger(callsCol);
  const settings = new MongoSettingsStore(settingsCol);
  return {
    mode: "mongo",
    shops,
    settings,
    ledger,
    claims: new MongoEventClaim(eventsCol),
    queue: new MongoJobQueue(jobsCol),
    gdpr: createGdprStore(shops, ledger, settings),
  };
}

function createMemoryStores(): RuntimeStores {
  const shops = new InMemoryShopStore();
  const ledger = new InMemoryCallLedger();
  const settings = new InMemorySettingsStore();
  return {
    mode: "memory",
    shops,
    settings,
    ledger,
    claims: new InMemoryEventClaim(),
    queue: new InMemoryJobQueue(),
    gdpr: createGdprStore(shops, ledger, settings),
  };
}

/**
 * Fail closed: the Mongo path stores tokens/keys under envelope encryption.
 * A half-configured deployment must refuse to start rather than silently
 * running with unencrypted credential storage.
 */
function assertRuntimeConfig(): void {
  if (process.env["MONGODB_URI"] && !process.env["TOKEN_ENCRYPTION_KEY"]?.trim()) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required when MONGODB_URI is set");
  }
}

export function getStores(): Promise<RuntimeStores> {
  assertRuntimeConfig();
  if (!storeGlobal.__techladderStores) {
    const created = process.env["MONGODB_URI"]
      ? createMongoStores()
      : Promise.resolve(createMemoryStores());
    // Do not cache a rejected init forever; a transient Mongo outage should be
    // retryable on the next request.
    storeGlobal.__techladderStores = created.catch((err) => {
      storeGlobal.__techladderStores = undefined;
      throw err;
    });
  }
  return storeGlobal.__techladderStores;
}

/** Lazy Mongo collection provider for Shopify session storage. */
export async function getShopifySessionsCol(): Promise<Col> {
  assertRuntimeConfig();
  return mongoCol("shopify_sessions");
}
