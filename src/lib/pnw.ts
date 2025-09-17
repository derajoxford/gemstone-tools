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
  if (parts.length !== 4 || parts[0] !== "enc") {
    // not our encrypted format, pass through as plaintext
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

  // 2) DB (schema-agnostic KV)
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

// ---------- Types aligned to current schema ----------
export type Bankrec = {
  id: string;                 // comes back as string
  date: string;               // ISO string
  note?: string | null;
  tax_id?: string | null;     // string "0" when not a tax record
  sender_type?: number | null;
  receiver_type?: number | null;
  sender_id?: string | null;
  receiver_id?: string | null;
};

type FetchOpts = {
  allianceId: number;
  afterId?: number | null;        // client-side filter
  limit?: number;                 // 1..500
  filter?: "all" | "tax" | "nontax";
};

// ---------- PnW GraphQL fetching (new schema) ----------
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  { allianceId, afterId, limit = 100, filter = "all" }: FetchOpts
): Promise<Bankrec[]> {
  const ids = [allianceId];
  const query = `
    query($ids:[Int!]) {
      alliances(id:$ids) {
        data {
          id
          name
          bankrecs(limit:${Math.max(1, Math.min(500, limit))}) {
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

  const res = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { ids } }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json: any = await res.json();
  const records: Bankrec[] = json?.data?.alliances?.data?.[0]?.bankrecs ?? [];

  // Optional filters
  let filtered = records;
  if (filter === "tax")     filtered = records.filter(r => r.tax_id && r.tax_id !== "0");
  if (filter === "nontax")  filtered = records.filter(r => !r.tax_id || r.tax_id === "0");

  if (afterId != null) {
    const n = Number(afterId);
    filtered = filtered.filter(r => Number(r.id) > n);
  }

  return filtered;
}

// ---------- convenience wrappers used by commands & index ----------
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: { afterId?: number | null; limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const apiKey = await getAllianceApiKey(prisma, allianceId);
  return fetchAllianceBankrecsViaGQL(apiKey, { allianceId, ...opts });
}

export async function fetchBankrecsSince(
  prisma: PrismaClient,
  allianceId: number,
  afterId: number,
  filter: "all" | "tax" | "nontax" = "all",
  limit = 100
): Promise<Bankrec[]> {
  return fetchBankrecs(prisma, allianceId, { afterId, filter, limit });
}
