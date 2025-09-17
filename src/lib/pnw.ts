// src/lib/pnw.ts
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

// ---------- helpers: schema-agnostic KV (same idea as pnw_cursor) ----------
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

// ---------- crypto helpers (only used when value is explicitly "enc:") ----------
function decryptEncGcm(value: string, secret: string): string {
  // format: enc:<ivHex>:<cipherHex>:<tagHex>
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") return value; // passthrough

  const [_, ivHex, cipherHex, tagHex] = parts;
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

// ---------- API key resolution ----------
export async function getAllianceApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  // 1) ENV (strongest & simplest)
  const envKeyPerAlliance = process.env[`PNW_API_KEY_${allianceId}`];
  if (envKeyPerAlliance && envKeyPerAlliance.trim()) return envKeyPerAlliance.trim();
  const envKey = process.env.PNW_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();

  // 2) DB (schema-agnostic)
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

// ---------- PnW GraphQL fetching ----------
export type Bankrec = {
  id: string;               // API returns strings
  date: string;
  note?: string | null;
  sender_id?: string | null;
  receiver_id?: string | null;
  sender_type?: number | null;
  receiver_type?: number | null;
  tax_id?: string | null;   // "0" for non-tax; otherwise bracket id like "27291"
};

export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  params: { allianceId: number; afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const { allianceId, afterId, limit = 100, filter = "all" } = params;

  const query = `
    query AllianceBank($aid:Int!, $after:Int, $limit:Int!) {
      alliances(ids: [$aid]) {
        data {
          id
          name
          bankrecs(after_id: $after, limit: $limit) {
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

  const res = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  const node = json?.data?.alliances?.data?.[0] ?? null;
  const records: Bankrec[] = node?.bankrecs ?? [];

  let out = records;
  if (filter === "tax")     out = records.filter(r => r.tax_id && r.tax_id !== "0");
  if (filter === "nontax")  out = records.filter(r => !r.tax_id || r.tax_id === "0");
  return out;
}

// convenience wrapper used by commands & index
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: { afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
) {
  const apiKey = await getAllianceApiKey(prisma, allianceId);
  return fetchAllianceBankrecsViaGQL(apiKey, { allianceId, ...opts });
}
