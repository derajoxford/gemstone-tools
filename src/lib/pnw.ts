// src/lib/pnw.ts
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * ---------------------------
 * Simple schema-agnostic KV
 * ---------------------------
 * We probe for a reasonable key/value model so new users don't have to rename code.
 * Any model that exposes findUnique({ where: { key } }) and stores the value under
 * one of value/val/data will work.
 */
type KVHandle = { name: string; m: any };
function getKV(prisma: PrismaClient): KVHandle | null {
  const candidates = [
    "setting", "settings",
    "kv", "kvs",
    "keyValue", "keyvalue", "key_values",
    "appSetting", "appSettings",
    "config", "configs",
  ];
  const p: any = prisma as any;
  for (const name of candidates) {
    const m = p?.[name];
    if (m && typeof m.findUnique === "function") return { name, m };
  }
  return null;
}
function kvKeyApiKey(aid: number) { return `pnw:api_key:${aid}`; }

/**
 * ---------------------------
 * Crypto helper (optional)
 * ---------------------------
 * Only used if a stored key begins with "enc:<iv>:<cipher>:<tag>" and PNW_SECRET is set.
 */
function decryptEncGcm(value: string, secret: string): string {
  // format: enc:<ivHex>:<cipherHex>:<tagHex>
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") return value; // not our format, pass-through

  const [, ivHex, cipherHex, tagHex] = parts;
  if (!ivHex || !cipherHex || !tagHex) {
    throw new Error("Encrypted API key is missing iv/cipher/tag parts.");
  }
  if (!secret) {
    throw new Error("Encrypted API key found but PNW_SECRET is not set.");
  }

  const iv = Buffer.from(ivHex, "hex");
  const cipher = Buffer.from(cipherHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const key = crypto.createHash("sha256").update(secret).digest(); // 32 bytes

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * ---------------------------
 * API key resolution
 * ---------------------------
 * Priority:
 *   1) PNW_API_KEY_<ALLIANCE_ID>
 *   2) PNW_API_KEY
 *   3) KV row under key "pnw:api_key:<ALLIANCE_ID>"
 *      (value may be plaintext or enc:<iv>:<cipher>:<tag> if PNW_SECRET is configured)
 */
export async function getAllianceApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  const envKeyPerAlliance = process.env[`PNW_API_KEY_${allianceId}`];
  if (envKeyPerAlliance && envKeyPerAlliance.trim()) return envKeyPerAlliance.trim();

  const envKey = process.env.PNW_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  const kv = getKV(prisma);
  if (!kv) {
    throw new Error(
      "No settings/kv model in Prisma schema and no PNW_API_KEY env. " +
      "Either set PNW_API_KEY(_<ALLIANCE_ID>) in .env or add a KV table."
    );
  }
  const row = await kv.m.findUnique({ where: { key: kvKeyApiKey(allianceId) } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? null;
  if (!raw) {
    throw new Error(
      `No API key found for alliance ${allianceId}. Set env PNW_API_KEY_${allianceId} or PNW_API_KEY, ` +
      `or store key in ${kv.name} with key="${kvKeyApiKey(allianceId)}".`
    );
  }
  const str = String(raw);
  if (str.startsWith("enc:")) {
    const secret = process.env.PNW_SECRET ?? "";
    return decryptEncGcm(str, secret).trim();
  }
  return str.trim();
}

/**
 * ---------------------------
 * Types
 * ---------------------------
 */
export type Bankrec = {
  id: string;                 // comes back as string from API
  date: string;
  note?: string | null;
  sender_id?: string | null;
  receiver_id?: string | null;
  sender_type?: number | null;
  receiver_type?: number | null;
  tax_id?: string | number | null; // non-zero => tax bracket id
};

/**
 * ---------------------------
 * GraphQL fetch
 * ---------------------------
 * Important: PnW GraphQL expects the API key as a *query param* (?api_key=xxx)
 * for POSTs. Using only the X-Api-Key header can yield 401s.
 *
 * Also: schema notes
 *   - top field is "alliances", not "alliance"
 *   - alliances(...) returns a paginator with "data"
 *   - bankrecs(...) is the field for bank records
 *   - There is no "amount" here; we only get meta fields (note, tax_id, etc.)
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  params: { allianceId: number; afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const { allianceId, afterId, limit = 100, filter = "all" } = params;

  const query = `
    query AllianceBank($aid:Int!, $after:Int, $limit:Int!) {
      alliances(id: [$aid]) {
        data {
          id
          name
          bankrecs(limit: $limit, after_id: $after) {
            id
            date
            note
            tax_id
            sender_type
            receiver_type
            sender_id
            receiver_id
          }
        }
      }
    }
  `;

  const body = JSON.stringify({
    query,
    variables: { aid: allianceId, after: afterId ?? null, limit: Math.max(1, Math.min(500, limit)) }
  });

  const res = await fetch(`https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const records: Bankrec[] = json?.data?.alliances?.data?.[0]?.bankrecs ?? [];

  // Normalize / filter by tax flag (non-zero = tax bracket id)
  const isTax = (v: any) => v != null && v !== 0 && v !== "0";
  let filtered = records;
  if (filter === "tax")     filtered = records.filter(r => isTax(r?.tax_id));
  if (filter === "nontax")  filtered = records.filter(r => !isTax(r?.tax_id));
  return filtered;
}

/**
 * ---------------------------
 * Convenience wrapper used by commands & jobs
 * ---------------------------
 */
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: { afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const apiKey = await getAllianceApiKey(prisma, allianceId);
  return fetchAllianceBankrecsViaGQL(apiKey, { allianceId, ...opts });
}
