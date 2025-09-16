// src/lib/pnw.ts
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

/** ---------- resources (needed by commands/utils) ---------- */
export const RESOURCE_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
  "credits",
] as const;

export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Partial<Record<ResourceKey, number>>;

/** ---------- helpers: schema-agnostic KV (same idea as pnw_cursor) ---------- */
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

/** ---------- crypto helpers (only used when value is explicitly "enc:") ---------- */
function decryptEncGcm(value: string, secret: string): string {
  // format: enc:<ivHex>:<cipherHex>:<tagHex>
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") {
    return value;
  }
  const ivHex = parts[1], cipherHex = parts[2], tagHex = parts[3];
  if (!ivHex || !cipherHex || !tagHex) {
    throw new Error("Encrypted API key is missing iv/cipher/tag parts.");
  }
  if (!secret) {
    throw new Error("Encrypted API key found but PNW_SECRET is not set.");
  }
  const iv = Buffer.from(ivHex, "hex");
  const cipher = Buffer.from(cipherHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const key = crypto.createHash("sha256").update(secret).digest();

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plain.toString("utf8");
}

/** ---------- API key resolution ---------- */
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

/** ---------- PnW GraphQL fetching ---------- */
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

  const res = await fetch("https://api.politicsandwar.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey
    },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0,200)}`);
  }

  const json = await res.json();
  con
