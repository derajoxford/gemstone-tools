// src/lib/pnw.ts
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

/* -------------------------------------------------------------------------- */
/*  Resource helpers                                                          */
/* -------------------------------------------------------------------------- */

export const RESOURCE_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "iron",
  "bauxite",
  "lead",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Partial<Record<ResourceKey, number>>;

export function zeroDelta(): ResourceDelta {
  const d: ResourceDelta = {};
  for (const k of RESOURCE_KEYS) d[k] = 0;
  return d;
}

export function sumDelta(a: ResourceDelta, b: ResourceDelta): ResourceDelta {
  const out: ResourceDelta = {};
  for (const k of RESOURCE_KEYS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

export function signedDeltaFor(delta: ResourceDelta): string {
  // Pretty “+1,234 / -56” style string for logs/embeds if needed
  return RESOURCE_KEYS
    .filter(k => (delta[k] ?? 0) !== 0)
    .map(k => `${k}: ${(delta[k] ?? 0) >= 0 ? "+" : ""}${Number(delta[k] ?? 0).toLocaleString()}`)
    .join(", ");
}

/* -------------------------------------------------------------------------- */
/*  Generic KV handle (so we don’t depend on a specific table name)           */
/* -------------------------------------------------------------------------- */

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

function kvKeyApiKey(aid: number) {
  return `pnw:api_key:${aid}`;
}

/* -------------------------------------------------------------------------- */
/*  Optional encryption support for stored keys (enc:<iv>:<cipher>:<tag>)     */
/* -------------------------------------------------------------------------- */

function decryptEncGcm(value: string, secret: string): string {
  // format: enc:<ivHex>:<cipherHex>:<tagHex>
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") return value; // passthrough (plaintext)
  const ivHex = parts[1], cipherHex = parts[2], tagHex = parts[3];
  if (!ivHex || !cipherHex || !tagHex) {
    throw new Error("Encrypted API key is missing iv/cipher/tag parts.");
  }
  if (!secret) throw new Error("Encrypted API key found but PNW_SECRET is not set.");

  const iv = Buffer.from(ivHex, "hex");
  const cipher = Buffer.from(cipherHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const key = crypto.createHash("sha256").update(secret).digest(); // 32 bytes

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plain.toString("utf8");
}

/* -------------------------------------------------------------------------- */
/*  Resolve the Alliance API key                                              */
/*    Priority:                                                               */
/*      1) env PNW_API_KEY_<AID>                                              */
/*      2) env PNW_API_KEY                                                    */
/*      3) DB KV row key = "pnw:api_key:<AID>"                                 */
/* -------------------------------------------------------------------------- */

export async function getAllianceApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  const envPerAid = process.env[`PNW_API_KEY_${allianceId}`];
  if (envPerAid && envPerAid.trim()) return envPerAid.trim();

  const envAny = process.env.PNW_API_KEY;
  if (envAny && envAny.trim()) return envAny.trim();

  const kv = getKV(prisma);
  if (!kv) {
    throw new Error(
      "No KV/Settings model found and no PNW_API_KEY env present. " +
      "Set PNW_API_KEY(_<ALLIANCE_ID>) in .env or add a KV table."
    );
  }
  const row = await kv.m.findUnique({ where: { key: kvKeyApiKey(allianceId) } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? null;
  if (!raw) {
    throw new Error(
      `No API key found for alliance ${allianceId}. ` +
      `Set env PNW_API_KEY_${allianceId} or PNW_API_KEY, or store it in ${kv.name} with key="${kvKeyApiKey(allianceId)}".`
    );
  }
  const str = String(raw);
  if (str.startsWith("enc:")) {
    const secret = process.env.PNW_SECRET ?? "";
    return decryptEncGcm(str, secret).trim();
  }
  return str.trim();
}

/* -------------------------------------------------------------------------- */
/*  PnW GraphQL                                                               */
/* -------------------------------------------------------------------------- */

export type Bankrec = {
  id: number;
  date: string;
  note?: string | null;
  sender_id?: number | null;
  receiver_id?: number | null;
  sender_type?: string | null;
  receiver_type?: string | null;
  amount?: number | null;
  tax_id?: number | null;
  tax_note?: string | null;
};

export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  params: { allianceId: number; afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const { allianceId, afterId, limit = 100, filter = "all" } = params;

  const query = `
    query AllianceBank($aid:Int!, $after:Int, $limit:Int!) {
      alliance(id:$aid) {
        bankRecords(afterId:$after, limit:$limit) {
          id date note sender_id receiver_id sender_type receiver_type amount tax_id tax_note
        }
      }
    }
  `;

  const body = JSON.stringify({
    query,
    variables: { aid: allianceId, after: afterId ?? null, limit: Math.max(1, Math.min(500, limit)) }
  });

  // IMPORTANT: PnW expects the API key in the query string, not a header
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const records: Bankrec[] = json?.data?.alliance?.bankRecords ?? [];

  let filtered = records;
  if (filter === "tax") filtered = records.filter(r => r.tax_id != null);
  if (filter === "nontax") filtered = records.filter(r => r.tax_id == null);
  return filtered;
}

/** Convenience wrapper used by commands & index */
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: { afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const apiKey = await getAllianceApiKey(prisma, allianceId);
  return fetchAllianceBankrecsViaGQL(apiKey, { allianceId, ...opts });
}
