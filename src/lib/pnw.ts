// src/lib/pnw.ts
import { PrismaClient } from "@prisma/client";

// Use Node 18+ global fetch (no node-fetch dependency)
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
  return Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0])) as ResourceDelta;
}

export function sumDelta(deltas: ResourceDelta[]): ResourceDelta {
  const out = zeroDelta();
  for (const d of deltas) {
    for (const k of RESOURCE_KEYS) out[k] += d[k];
  }
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
// GraphQL Bankrec Fetch
// ---------------------------
export async function fetchAllianceBankrecsViaGQL(
  prisma: PrismaClient,
  allianceId: number,
  opts: { afterId?: string; limit?: number; filter?: "all" | "tax" | "nontax" } = {}
) {
  const keyRec = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!keyRec) throw new Error(`No API key stored for alliance ${allianceId}`);
  const apiKey = (keyRec as any).decrypted || keyRec.apiKey || null;
  if (!apiKey) throw new Error(`Alliance key record missing usable apiKey`);

  const { afterId, limit = 50 } = opts;
  const query = `
    query($aid:Int!,$limit:Int,$afterId:ID){
      alliances(ids:[$aid]){
        data{
          id
          name
          bankrecs(limit:$limit,after_id:$afterId){
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

  const body = JSON.stringify({
    query,
    variables: { aid: allianceId, limit, afterId },
  });

  // PnW requires api_key in the query string (header is ignored)
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error("PnW GraphQL error: " + JSON.stringify(json.errors));
  }

  const alliance = json.data?.alliances?.data?.[0];
  if (!alliance) return [];

  let recs: any[] = alliance.bankrecs || [];

  if (opts.filter === "tax") {
    recs = recs.filter(r => Number(r.tax_id) > 0);
  } else if (opts.filter === "nontax") {
    recs = recs.filter(r => Number(r.tax_id) === 0);
  }

  return recs;
}

// ---------------------------
// Convenience wrappers
// ---------------------------
export async function fetchBankrecs(
  prisma: PrismaClient,
  allianceId: number,
  opts?: { afterId?: string; limit?: number; filter?: "all" | "tax" | "nontax" }
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
