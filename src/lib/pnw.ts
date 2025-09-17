// src/lib/pnw.ts
import { PrismaClient } from "@prisma/client";

// Use Node 18+ global fetch
const fetchFn: typeof fetch = (...args: Parameters<typeof fetch>) =>
  (globalThis as any).fetch(...args);

// ---------------------------
// Resource Keys + Delta Utils
// ---------------------------
export const RESOURCE_KEYS = [
  "money",
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
  "food",
] as const;

export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Record<ResourceKey, number>;

export function zeroDelta(): ResourceDelta {
  return Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0])) as ResourceDelta;
}

export function sumDelta(deltas: ResourceDelta[]): ResourceDelta {
  const out = zeroDelta();
  for (const d of deltas) for (const k of RESOURCE_KEYS) out[k] += d[k];
  return out;
}

export function signedDeltaFor(rec: any): ResourceDelta {
  const out = zeroDelta();
  for (const k of RESOURCE_KEYS) {
    const v = rec[k] ?? 0;
    // incoming -> positive, outgoing -> negative (2 = alliance)
    out[k] = rec.receiver_type === 2 ? v : -v;
  }
  return out;
}

// ---------------------------
// API key resolver (DB -> ENV)
// ---------------------------
async function resolveApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  try {
    const keyRec = await prisma.allianceKey.findFirst({
      where: { allianceId },
      orderBy: { id: "desc" },
    });
    const fromDb = (keyRec as any)?.decrypted || (keyRec as any)?.apiKey;
    if (fromDb && String(fromDb).trim()) return String(fromDb).trim();
  } catch {
    // ignore prisma errors; we still try env
  }
  const envKey =
    process.env[`PNW_API_KEY_${allianceId}`] || process.env.PNW_API_KEY || "";
  if (envKey.trim()) return envKey.trim();
  throw new Error("Alliance key record missing usable apiKey");
}

// ---------------------------
// Internal: perform GQL fetch
// ---------------------------
async function postGql(
  apiKey: string,
  query: string,
  variables: Record<string, any>,
  opts?: { minimal?: boolean }
) {
  const url =
    "https://api.politicsandwar.com/graphql?api_key=" +
    encodeURIComponent(apiKey);

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  if (!res.ok) {
    // Bubble up a trimmed error; Discord messages have limits.
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PnW GraphQL parse error: ${text.slice(0, 200)}`);
  }

  if (json.errors) {
    // Don't retry for GraphQL-level errors; surface them.
    throw new Error("PnW GraphQL error: " + JSON.stringify(json.errors));
  }

  return json;
}

// ---------------------------
// GraphQL Bankrec Fetch (+retry)
// ---------------------------
export async function fetchAllianceBankrecsViaGQL(
  prisma: PrismaClient,
  allianceId: number,
  opts: {
    afterId?: string;
    limit?: number;
    filter?: "all" | "tax" | "nontax";
  } = {}
) {
  const apiKey = await resolveApiKey(prisma, allianceId);

  const limit = opts.limit ?? 50;
  const afterId = opts.afterId;

  // Build variables WITHOUT undefineds — some servers 500 on undefined.
  const variables: Record<string, any> = { aid: allianceId, limit };
  if (afterId) variables.afterId = afterId;

  // Full selection set (normal path)
  const fullQuery = `
    query($aid:Int!,$limit:Int,$afterId:ID){
      alliances(ids:[$aid]){
        data{
          id
          name
          bankrecs(limit:$limit, after_id:$afterId){
            id
            date
            note
            tax_id
            sender_type
            receiver_type
            sender_id
            receiver_id
            money
            coal
            oil
            uranium
            iron
            bauxite
            lead
            gasoline
            munitions
            steel
            aluminum
            food
          }
        }
      }
    }`;

  // Minimal selection set (retry path)
  const minimalQuery = `
    query($aid:Int!,$limit:Int){
      alliances(ids:[$aid]){
        data{
          id
          bankrecs(limit:$limit){
            id
            date
            note
            tax_id
          }
        }
      }
    }`;

  // Try full query; if HTTP 500, retry minimal once.
  let json: any;
  try {
    json = await postGql(apiKey, fullQuery, variables);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const is500 = /HTTP 500/i.test(msg);
    if (!is500) throw e;

    // Retry minimal (without after_id too, to be extra safe)
    const minimalVars: Record<string, any> = { aid: allianceId, limit };
    const j2 = await postGql(apiKey, minimalQuery, minimalVars);

    const allianceLite = j2.data?.alliances?.data?.[0];
    if (!allianceLite) return [];

    const liteRecs: any[] = allianceLite.bankrecs || [];

    // If caller only needs minimal (e.g., to avoid server errors), return now
    // Otherwise, try to fetch the full detail in a second step by IDs, but
    // since the schema doesn’t provide an id-lookup for bankrecs, we’ll
    // just return the minimal set to keep things reliable.
    let recs = liteRecs;

    if (opts.filter === "tax") {
      recs = recs.filter((r) => Number(r.tax_id) > 0);
    } else if (opts.filter === "nontax") {
      recs = recs.filter((r) => Number(r.tax_id) === 0);
    }

    return recs;
  }

  const alliance = json.data?.alliances?.data?.[0];
  if (!alliance) return [];

  let recs: any[] = alliance.bankrecs || [];

  if (opts.filter === "tax") {
    recs = recs.filter((r) => Number(r.tax_id) > 0);
  } else if (opts.filter === "nontax") {
    recs = recs.filter((r) => Number(r.tax_id) === 0);
  }

  return recs;
}

// ---------------------------
// Convenience wrappers
// ---------------------------
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: {
    afterId?: string;
    limit?: number;
    filter?: "all" | "tax" | "nontax";
  }
) {
  return fetchAllianceBankrecsViaGQL(prisma, allianceId, opts);
}

export async function fetchBankrecsSince(
  prisma: PrismaClient,
  allianceId: number,
  afterId: string
) {
  return fetchAllianceBankrecsViaGQL(prisma, allianceId, { afterId });
}
