// src/lib/pnw.ts
// Minimal PnW GraphQL helpers (uses Node 18+ global fetch)

export class PnwGqlError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type Vars = Record<string, any>;

export async function gql<T = any>(
  apiKey: string,
  query: string,
  variables: Vars
): Promise<T> {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ query, variables }),
  });

  let body: any = null;
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok || (body && body.errors)) {
    const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body?.errors ?? body)}`;
    throw new PnwGqlError(res.status, body, msg);
  }
  return body.data as T;
}

export type BankrecRow = {
  id: number | string;
  date: string;
  sender_type: number | string;
  sender_id: number | string;
  receiver_type: number | string;
  receiver_id: number | string;
  note?: string | null;

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

/**
 * Fetch alliance bank records (recent first) using the current schema.
 * Strategy:
 *  1) Try singular shape:   alliance(id:$id) { bankrecs(limit:$limit, orderBy:"id desc") { ... } }
 *  2) Fallback to plural+paginator:
 *     alliances(id:[$id]) { data { bankrecs(limit:$limit, orderBy:"id desc") { ... } } }
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const LIMIT = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const vars = { id: allianceId, limit: LIMIT };

  const FIELDS = `
    id
    date
    sender_type
    sender_id
    receiver_type
    receiver_id
    note
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
  `;

  const Q_SINGULAR = `
    query AllianceBankrecsSingle($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: "id desc") {
          ${FIELDS}
        }
      }
    }
  `;

  const Q_PLURAL_DATA = `
    query AllianceBankrecsPlural($id: Int!, $limit: Int!) {
      alliances(id: [$id]) {
        data {
          id
          bankrecs(limit: $limit, orderBy: "id desc") {
            ${FIELDS}
          }
        }
      }
    }
  `;

  // 1) Try singular first
  try {
    const d1 = await gql<{ alliance?: { id: number, bankrecs: BankrecRow[] } }>(apiKey, Q_SINGULAR, vars);
    const rows = d1?.alliance?.bankrecs ?? [];
    if (Array.isArray(rows)) return rows;
  } catch (e1) {
    // continue to fallback
  }

  // 2) Fallback: plural + paginator .data[]
  try {
    const d2 = await gql<{ alliances?: { data?: Array<{ id: number, bankrecs: BankrecRow[] }> } }>(apiKey, Q_PLURAL_DATA, vars);
    const list = d2?.alliances?.data ?? [];
    const a = Array.isArray(list) ? list[0] : undefined;
    return (a?.bankrecs ?? []) as BankrecRow[];
  } catch (e2) {
    // Throw the fallback error (more indicative for current schema)
    throw e2;
  }
}
