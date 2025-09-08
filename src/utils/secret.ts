// src/utils/secret.ts
import crypto from "node:crypto";

const RAW = process.env.GT_SECRET || process.env.ENCRYPTION_KEY || "";
export const secretConfigured = !!RAW;

// Derive a 32-byte key regardless of input length
const KEY = crypto.createHash("sha256").update(RAW).digest(); // 32 bytes

export function encryptToString(plaintext: string): string {
  if (!secretConfigured) throw new Error("Encryption secret not configured (set GT_SECRET or ENCRYPTION_KEY).");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64"); // [12 IV][16 TAG][N CIPHERTEXT]
}

export function decryptFromString(packed: string): string {
  if (!secretConfigured) throw new Error("Encryption secret not configured (set GT_SECRET or ENCRYPTION_KEY).");
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}
