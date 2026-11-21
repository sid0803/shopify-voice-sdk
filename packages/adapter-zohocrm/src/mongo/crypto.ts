// Envelope encryption for tokens at rest.
// AES-256-GCM, random 12-byte IV per value, format "v1.<b64 iv>.<b64 ct>".
// Fail-closed: missing or malformed TOKEN_ENCRYPTION_KEY throws — there is
// no plaintext fallback in any environment.
//
// Intentionally duplicated from adapter-shopify's mongo/crypto.ts instead of
// imported: adapters stay independently deployable with zero cross-adapter
// imports. If the envelope ever changes, change both and note it here.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function loadKey(): Buffer {
  const raw = (process.env["TOKEN_ENCRYPTION_KEY"] ?? "").trim();
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is required");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be base64 of 32 bytes");
  return key;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(envelope: string): string {
  const [v, ivB64, ctB64] = envelope.split(".");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("Unknown secret envelope");
  const iv = Buffer.from(ivB64, "base64");
  const raw = Buffer.from(ctB64, "base64");
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct) + decipher.final("utf8");
}
