import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  Session,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import {
  MongoShopifySessionStorage,
  ensureShopifySessionIndexes,
} from "@techladder/adapter-shopify";
import prisma from "./db.server";
import { getShopifySessionsCol, getStores } from "./lib/stores.server";

let sessionIndexesReady = false;
async function sessionsCol() {
  const col = await getShopifySessionsCol();
  if (!sessionIndexesReady) {
    await ensureShopifySessionIndexes(col);
    sessionIndexesReady = true;
  }
  return col;
}

// Durable encrypted sessions when Mongo is configured. Local dev without
// MONGODB_URI falls back to the template Prisma/SQLite storage. Selecting Mongo
// here is deliberate: a deployment that sets MONGODB_URI but forgets
// TOKEN_ENCRYPTION_KEY must fail closed (the stores guard throws) rather than
// silently keeping Shopify tokens in plaintext SQLite.
const useMongoSessions = Boolean(process.env.MONGODB_URI);

const storage = useMongoSessions
  ? new MongoShopifySessionStorage(
      sessionsCol,
      (payload) => new Session(payload as unknown as ConstructorParameters<typeof Session>[0]),
    )
  : new PrismaSessionStorage(prisma);

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: storage,
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      // Install metadata only. The access token stays in session storage
      // (single source of truth, auto-refresh); never copy it here.
      const stores = await getStores();
      const existing = await stores.shops.get(session.shop);
      await stores.shops.save({
        shopDomain: session.shop,
        scopes: session.scope ? session.scope.split(",").map((s) => s.trim()).filter(Boolean) : [],
        status: "installed",
        installedAt: existing?.installedAt ?? new Date().toISOString(),
      });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
