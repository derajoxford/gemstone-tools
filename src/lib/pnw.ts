// src/lib/pnw.ts
import 'dotenv/config';

export type Bankrec = {
  id: number;
  date: string;
  note?: string | null;

  sender_type: number;
  sender_id: number;
  receiver_type: number;
  receiver_id: number;

  money: number;
  food: number;
  coal: number;
  oil: number;
  uranium: number;
  lead: number;
  iron: number;
  bauxite: number;
  gasoline: number;
  munitions: number;
  steel: number;
  aluminum: number;
};

type GQLInput = { apiKey: string };
const GQL_URL = 'https://api.politicsandwar.com/graphql';

// ---------------- GQL core ----------------
async function gql<T>(apiKey: string, query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.errors)) {
    const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(data?.errors || data)}`;
    throw new Error(msg);
  }
  return data.data as T;
}

// ---------------- Queries (new schema w/ paginator) ----------------
const Q_ALLIANCE_BANKRECS_V2 = `
query AllianceBankrecsV2($ids: [Int!], $firstAlliances: Int!, $firstRecs: Int!) {
  alliances(id: $ids, first: $firstAlliances) {
    data {
      id
      bankrecs(first: $firstRecs, orderBy: [{ column: ID, order: DESC }]) {
        data {
          id
          date
          note
          sender_type
          sender_id
          receiver_type
          receiver_id
          money
          food
          coal
          oil
          uranium
          lead
          iron
          bauxite
          gasoline
          munitions
          steel
          aluminum
        }
      }
    }
  }
}
`;

// ---------------- Legacy query (older schema w/o paginator nesting) ----------------
const Q_ALLIANCE_BANKRECS_LEGACY = `
query AllianceBankrecsLegacy($ids: [Int!], $firstRecs: Int!) {
  alliances(id: $ids) {
    id
    bankrecs(first: $firstRecs, orderBy: [{ column: ID, order: DESC }]) {
      id
      date
      note
      sender_type
      sender_id
      receiver_type
      receiver_id
      money
      food
      coal
      oil
      uranium
      lead
      iron
      bauxite
      gasoline
      munitions
      steel
      aluminum
    }
  }
}
`;

// ---------------- Public helpers ----------------

/**
 * Fetch recent bankrecs for ONE alliance id.
 * Handles both the new paginator shape and a legacy fallback.
 */
export async function fetchAllianceBankrecsViaGQL(
  { apiKey }: GQLInput,
  allianceId: number,
  limit: number = 250
): Promise<Bankrec[]> {
  const firstAlliances = 1;
  const firstRecs = Math.max(1, Number(limit) || 250);

  // Try V2 (paginator) first
  try {
    type R2 = {
      alliances: {
        data: Array<{
          id: number;
          bankrecs: { data: Bankrec[] };
        }>;
      };
    };
    const d = await gql<R2>(apiKey, Q_ALLIANCE_BANKRECS_V2, {
      ids: [allianceId],
      firstAlliances,
      firstRecs,
    });

    const al = d?.alliances?.data?.[0];
    if (!al) return [];
    const rows = al.bankrecs?.data ?? [];
    return normalizeBankrecs(rows);
  } catch (e) {
    // Fallback to legacy shape
    try {
      type R1 = {
        alliances: Array<{
          id: number;
          bankrecs: Bankrec[];
        }>;
      };
      const d = await gql<R1>(apiKey, Q_ALLIANCE_BANKRECS_LEGACY, {
        ids: [allianceId],
        firstRecs,
      });
      const al = (d as any)?.alliances?.[0];
      if (!al) return [];
      const rows = (al.bankrecs as any[]) || [];
      return normalizeBankrecs(rows as Bankrec[]);
    } catch (e2) {
      throw e2;
    }
  }
}

/**
 * Fetch recent bankrecs for MANY alliance ids.
 * Returns array of { id, bankrecs } to match existing callers.
 */
export async function fetchBankrecs(
  { apiKey }: GQLInput,
  allianceIds: number[],
  limit: number = 250
): Promise<Array<{ id: number; bankrecs: Bankrec[] }>> {
  const out: Array<{ id: number; bankrecs: Bankrec[] }> = [];
  for (const id of allianceIds) {
    try {
      const rows = await fetchAllianceBankrecsViaGQL({ apiKey }, id, limit);
      out.push({ id, bankrecs: rows });
    } catch {
      out.push({ id, bankrecs: [] });
    }
  }
  return out;
}

// ---------------- utils ----------------
function toNum(x: any): number {
  const n = Number.parseFloat(String(x));
  return Number.isFinite(n) ? n : 0;
}

function normalizeBankrecs(rows: any[]): Bankrec[] {
  return (rows || []).map((r: any) => ({
    id: Number(r.id),
    date: String(r.date),
    note: r.note ?? null,
    sender_type: Number(r.sender_type),
    sender_id: Number(r.sender_id),
    receiver_type: Number(r.receiver_type),
    receiver_id: Number(r.receiver_id),

    money: toNum(r.money),
    food: toNum(r.food),
    coal: toNum(r.coal),
    oil: toNum(r.oil),
    uranium: toNum(r.uranium),
    lead: toNum(r.lead),
    iron: toNum(r.iron),
    bauxite: toNum(r.bauxite),
    gasoline: toNum(r.gasoline),
    munitions: toNum(r.munitions),
    steel: toNum(r.steel),
    aluminum: toNum(r.aluminum),
  }));
}
