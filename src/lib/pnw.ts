// src/lib/pnw.ts
import { PrismaClient } from "@prisma/client";

// Node 18+ global fetch
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
    // ignore prisma errors; still try env
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
  variables?: Record<string, any>
) {
  const url =
    "https://api.politicsandwar.com/graphql?api_key=" +
    encodeURIComponent(apiKey);

  const body =
    variables && Object.keys(variables).length
      ? JSON.stringify({ query, variables })
      : JSON.stringify({ query });

  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PnW GraphQL parse error: ${text.slice(0, 200)}`);
  }

  if (json.errors) {
    throw new Error("PnW GraphQL error: " + JSON.stringify(json.errors));
  }

  return json;
}

// A tiny nations probe to separate “PnW up” vs “alliances resolver broken”
async function probeNations(apiKey: string) {
  const q = `{ nations(first:1){ data { id nation_name } } }`;
  const j = await postGql(apiKey, q);
  const ok = !!j?.data?.nations?.data?.length;
  return ok;
}

// ---------------------------
// GraphQL Bankrec Fetch (+diagnostic fallbacks)
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
  const variables: Record<string, any> = { aid: allianceId, limit };
  if (opts.afterId) variables.afterId = opts.afterId; // omit if undefined

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

  // Minimal alliances query, literal ID, no variables
  const alliancesPing = `
    {
      alliances(ids:[${allianceId}]){
        data { id }
      }
    }`;

  try {
    const json = await postGql(apiKey, fullQuery, variables);
    const alliance = json.data?.alliances?.data?.[0];
    if (!alliance) return [];

    let recs: any[] = alliance.bankrecs || [];

    if (opts.filter === "tax") {
      recs = recs.filter((r) => Number(r.tax_id) > 0);
    } else if (opts.filter === "nontax") {
      recs = recs.filter((r) => Number(r.tax_id) === 0);
    }

    return recs;
  } catch (e: any) {
    const msg = String(e?.message || e);
    const is500 = /HTTP 500/i.test(msg);
    if (!is500) throw e;

    // Step 1: is the alliances resolver itself broken?
    try {
      await postGql(apiKey, alliancesPing);
      // If this succeeds, it's not the alliances root (rare), rethrow original
      throw e;
    } catch (e2: any) {
      const msg2 = String(e2?.message || e2);
      const isAlliances500 = /HTTP 500/i.test(msg2);
      if (!isAlliances500) {
        // A different error; bubble that up
        throw e2;
      }
      // Step 2: probe nations to confirm API is up but alliances path is failing
      try {
        const nationsOk = await probeNations(apiKey);
        if (nationsOk) {
          throw new Error(
            "PnW GraphQL ‘alliances’ resolver is returning 500 (server-side). " +
              "API itself is reachable (nations OK), but bank records cannot be retrieved right now."
          );
        } else {
          throw new Error(
            "PnW GraphQL appears to be failing right now (server-side 500)."
          );
        }
      } catch (probeErr: any) {
        // If even the probe blew up unexpectedly, just return a concise message
        throw new Error(
          "PnW GraphQL returned 500 and health probe could not complete."
        );
      }
    }
  }
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
