// src/lib/pnw.ts
import fetch from "node-fetch";

export class PnwGqlError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const ENDPOINT = "https://api.politicsandwar.com/graphql";

async function gql<T>(apiKey: string, query: string, variables?: Record<string, any>): Promise<T> {
  const res = await fetch(`${ENDPOINT}?api_key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body.errors || body)}`;
    throw new PnwGqlError(res.status, body, msg);
  }
  return body.data as T;
}

export type BankrecRow = {
  id: number;
  date: string;
  sender_type: number;
  sender_id: number;
  receiver_type: number;
  receiver_id: number;
  note: string | null;
  banker_id?: number | null;
  money: number;
  coal: number;
  oil: number;
  uranium: number;
  iron: number;
  bauxite: number;
  lead: number;
  gasoline: number;
  munitions: number;
  steel: number;
  aluminum: number;
  food: number;
  tax_id?: number | null;
};

// ---------------- Alliance-level bankrecs (does NOT include automated taxes) ----------------
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {},
): Promise<BankrecRow[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  const Q = /* GraphQL */ `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: [{ column: id, order: DESC }]) {
          id
          date
          sender_type
          sender_id
          receiver_type
          receiver_id
          note
          money
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
          food
          tax_id
        }
      }
    }
  `;
  const data = await gql<any>(apiKey, Q, { id: allianceId, limit });
  const ali = Array.isArray(data.alliances) ? data.alliances[0] : data.alliances;
  const rows = (ali?.bankrecs ?? []) as BankrecRow[];
  return rows;
}

// ---------------- Members in an alliance ----------------
export async function fetchAllianceMemberNationIds(apiKey: string, allianceId: number): Promise<number[]> {
  // Try using "nations" first; fall back to "members".
  const QA = /* GraphQL */ `
    query AllianceMembers($id: Int!) {
      alliances(id: $id) { id nations { id } }
    }
  `;
  try {
    const data = await gql<any>(apiKey, QA, { id: allianceId });
    const ali = Array.isArray(data.alliances) ? data.alliances[0] : data.alliances;
    const list = (ali?.nations ?? []) as Array<{ id: number }>;
    if (list.length) return list.map(n => n.id);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (!/Cannot query field "nations"|Unknown field/i.test(msg)) throw e;
  }

  const QB = /* GraphQL */ `
    query AllianceMembersFallback($id: Int!) {
      alliances(id: $id) { id members { id } }
    }
  `;
  const dataB = await gql<any>(apiKey, QB, { id: allianceId });
  const aliB = Array.isArray(dataB.alliances) ? dataB.alliances[0] : dataB.alliances;
  const listB = (aliB?.members ?? []) as Array<{ id: number }>;
  return listB.map(n => n.id);
}

// ---------------- Nation-level bankrecs (this DOES include automated taxes) ----------------
export async function fetchNationBankrecsViaGQL(
  apiKey: string,
  nationIds: number[],
  perNationLimit = 20,
): Promise<BankrecRow[]> {
  const IDS = [...new Set(nationIds)].filter(n => Number.isFinite(n));
  if (!IDS.length) return [];

  const chunks: number[][] = [];
  for (let i = 0; i < IDS.length; i += 40) chunks.push(IDS.slice(i, i + 40));

  const fields = `
    id date sender_type sender_id receiver_type receiver_id note
    money coal oil uranium lead iron bauxite gasoline munitions steel aluminum food tax_id
  `;

  const Q = /* GraphQL */ `
    query NationBankrecs($ids: [Int!], $limit: Int!) {
      nations(id: $ids) {
        id
        bankrecs(limit: $limit, orderBy: [{ column: id, order: DESC }]) { ${fields} }
      }
    }
  `;
  const Q_FALLBACK = /* GraphQL */ `
    query NationBankrecsPaginated($ids: [Int!], $limit: Int!) {
      nations(id: $ids, first: 500) {
        data {
          id
          bankrecs(limit: $limit, orderBy: [{ column: id, order: DESC }]) { ${fields} }
        }
      }
    }
  `;

  const out: BankrecRow[] = [];
  for (const ids of chunks) {
    try {
      const d = await gql<any>(apiKey, Q, { ids, limit: perNationLimit });
      const arr = Array.isArray(d.nations) ? d.nations : [];
      for (const n of arr) out.push(...(n?.bankrecs ?? []));
    } catch (e: any) {
      const d = await gql<any>(apiKey, Q_FALLBACK, { ids, limit: perNationLimit });
      const arr = Array.isArray(d.nations?.data) ? d.nations.data : [];
      for (const n of arr) out.push(...(n?.bankrecs ?? []));
    }
  }
  return out;
}

// ---------------- Helpers ----------------
export function isAutomatedTaxRow(r: BankrecRow, allianceId: number): boolean {
  return r.receiver_type === 2 && r.receiver_id === allianceId && !!r.tax_id && Number(r.tax_id) > 0;
}

export type Delta = {
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

export function sumDelta(rows: BankrecRow[]): Delta {
  const z = (): Delta => ({
    money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0, bauxite: 0,
    gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
  });
  const d = z();
  for (const r of rows) {
    d.money += r.money || 0;
    d.food += r.food || 0;
    d.coal += r.coal || 0;
    d.oil += r.oil || 0;
    d.uranium += r.uranium || 0;
    d.lead += r.lead || 0;
    d.iron += r.iron || 0;
    d.bauxite += r.bauxite || 0;
    d.gasoline += r.gasoline || 0;
    d.munitions += r.munitions || 0;
    d.steel += r.steel || 0;
    d.aluminum += r.aluminum || 0;
  }
  return d;
}

// ------------- Back-compat: legacy symbol so index.ts doesn’t crash -------------
type PnwKeys = { apiKey: string };
export async function fetchBankrecs(keys: PnwKeys, allianceIds: number[]) {
  const out: Record<number, BankrecRow[]> = {};
  for (const id of allianceIds) {
    out[id] = await fetchAllianceBankrecsViaGQL(keys.apiKey, id, { limit: 100 });
  }
  return out;
}
