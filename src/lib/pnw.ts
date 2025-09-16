import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

/** ---------- schema-agnostic tiny KV helper (optional) ---------- */
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

/** ---------- decrypt helper for "enc:<iv>:<cipher>:<tag>" values ---------- */
function decryptEncGcm(value: string, secret: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") return value; // not our format
  const [_, ivHex, cipherHex, tagHex] = parts;
  if (!ivHex || !cipherHex || !tagHex) {
    throw new Error("Encrypted API key missing iv/cipher/tag.");
  }
  if (!secret) throw new Error("PNW_SECRET is not set for encrypted API key.");
  const iv = Buffer.from(ivHex, "hex");
  const cipher = Buffer.from(cipherHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plain.toString("utf8");
}

/** ---------- Resolve alliance API key (ENV first, then KV) ---------- */
export async function getAllianceApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  // ENV (strongest)
  const per = process.env[`PNW_API_KEY_${allianceId}`];
  if (per && per.trim()) return per.trim();
  const any = process.env.PNW_API_KEY;
  if (any && any.trim()) return any.trim();

  // DB (optional KV table)
  const kv = getKV(prisma);
  if (!kv) {
    throw new Error(
      "No PNW_API_KEY env and no KV table detected. " +
      "Set PNW_API_KEY(_<ALLIANCE_ID>) in .env OR create a KV model " +
      `with key="${kvKeyApiKey(allianceId)}".`
    );
  }
  const row = await kv.m.findUnique({ where: { key: kvKeyApiKey(allianceId) } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? null;
  if (!raw) {
    throw new Error(
      `No API key for alliance ${allianceId}. Use env PNW_API_KEY_${allianceId} or PNW_API_KEY, ` +
      `or store under ${kv.name}.key="${kvKeyApiKey(allianceId)}".`
    );
  }
  const str = String(raw);
  if (str.startsWith("enc:")) {
    const secret = process.env.PNW_SECRET ?? "";
    return decryptEncGcm(str, secret).trim();
  }
  return str.trim();
}

/** ---------- Types and GQL fetchers ---------- */
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

  const res = await fetch("https://api.politicsandwar.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      query,
      variables: {
        aid: allianceId,
        after: afterId ?? null,
        limit: Math.max(1, Math.min(500, limit)),
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json().catch(() => ({} as any));
  const records: Bankrec[] = json?.data?.alliance?.bankRecords ?? [];

  if (params.filter === "tax")   return records.filter(r => r.tax_id != null);
  if (params.filter === "nontax")return records.filter(r => r.tax_id == null);
  return records;
}

/** Convenience wrappers */
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
  sinceId?: number | null,
  opts?: { limit?: number; filter?: "all" | "tax" | "nontax" }
): Promise<Bankrec[]> {
  const apiKey = await getAllianceApiKey(prisma, allianceId);
  return fetchAllianceBankrecsViaGQL(apiKey, {
    allianceId,
    afterId: sinceId ?? null,
    limit: opts?.limit,
    filter: opts?.filter,
  });
}
