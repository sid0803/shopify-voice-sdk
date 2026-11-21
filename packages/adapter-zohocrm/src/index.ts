// Zoho CRM adapter barrel. Behavior lives in sibling modules; this file only
// re-exports so hosts never deep-import package internals.
// Zoho specifics live in the adapter modules — core stays neutral.
// TODO: switch relative imports to "@techladder/core" after first publish.
export * from "./adapter.js";
export * from "./settings.js";
export * from "./mapping.js";
export * from "./zohoConfig.js";
export * from "./oauth.js";
export * from "./client.js";
export * from "./fieldMapper.js";
export * from "./consent.js";
export * from "./writeback.js";
export * from "./stores.js";
export * from "./queue.js";
export * from "./shell/connect.js";
export * from "./shell/fieldSetup.js";
export * from "./shell/webhook.js";
export * from "./shell/leadProcessor.js";
export * from "./shell/resultProcessor.js";
export { MongoZohoConnectionStore, MongoZohoEventClaim, MongoZohoLeadLedger } from "./mongo/stores.js";
export { closeMongo, getDb } from "./mongo/client.js";
export { decryptSecret, encryptSecret } from "./mongo/crypto.js";
