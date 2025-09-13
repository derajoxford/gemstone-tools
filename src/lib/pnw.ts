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

function sortDescById(rows: BankrecRow[]): BankrecRow[] {
  return [...rows].sort((a, b) => Number(b.id) - Number(a.id));
}

function looksLikeOrderByError(e: unknown): boolean {
  const msg =
    (e as any)?.message ||
    (e as any)?.body?.errors?.map((x: any) => x?.message).join(" | ") ||
    "";
  return /argument\s+"orderBy"|requires type .*OrderBy.*Clause/i.test(String(msg));
}

/**
 * Fetch alliance bank records (recent first) using the current schema.
 * Strategy:
 *  1) Try singular shape:
 *       alliance(id:$id) { bankrecs(limit:$limit, orderBy:[{column:ID,order:DESC}]) { ... } }
 *     Fallback (if orderBy not supported):
 *       alliance(id:$id) { bankrecs(limit:$limit) { ... } }  // then sort locally desc
 *  2) If singular not available, use plural+paginator .data[0]:
 *       alliances(id:[$id]) { data { bankrecs(limit:$limit, orderBy:[{column:ID,order:DESC}]) { ... } } }
 *     Fallback:
 *       alliances(id:[$id]) { data { bankrecs(limit:$limit) { ... } } }  // then sort locally desc
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

  // --- Singular with orderBy ---
  const Q_SINGULAR_OB = `
    query AllianceBankrecsSingle($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: [{ column: ID, order: DESC }]) {
          ${FIELDS}
        }
      }
    }
  `;

  // --- Singular without orderBy (fallback) ---
  const Q_SINGULAR_NOOB = `
    query AllianceBankrecsSingleNoOB($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        id
        bankrecs(limit: $limit) {
          ${FIELDS}
        }
      }
    }
  `;

  // --- Plural+paginator with orderBy ---
  const Q_PLURAL_OB = `
    query AllianceBankrecsPlural($id: Int!, $limit: Int!) {
      alliances(id: [$id]) {
        data {
          id
          bankrecs(limit: $limit, orderBy: [{ column: ID, order: DESC }]) {
            ${FIELDS}
          }
        }
      }
    }
  `;

  // --- Plural+paginator without orderBy (fallback) ---
  const Q_PLURAL_NOOB = `
    query AllianceBankrecsPluralNoOB($id: Int!, $limit: Int!) {
      alliances(id: [$id]) {
        data {
          id
          bankrecs(limit: $limit) {
            ${FIELDS}
          }
        }
      }
    }
  `;

  // 1) Try singular first
  try {
    const d1 = await gql<{ alliance?: { id: number, bankrecs: BankrecRow[] } }>(apiKey, Q_SINGULAR_OB, vars);
    if (Array.isArray(d1?.alliance?.bankrecs)) return sortDescById(d1.alliance.bankrecs).slice(0, LIMIT);
  } catch (e1) {
    if (looksLikeOrderByError(e1)) {
      const d1b = await gql<{ alliance?: { id: number, bankrecs: BankrecRow[] } }>(apiKey, Q_SINGULAR_NOOB, vars);
      const rows = d1b?.alliance?.bankrecs ?? [];
      return sortDescById(rows).slice(0, LIMIT);
    }
    // otherwise fall through to plural
  }

  // 2) Fallback: plural + paginator .data[]
  try {
    const d2 = await gql<{ alliances?: { data?: Array<{ id: number, bankrecs: BankrecRow[] }> } }>(apiKey, Q_PLURAL_OB, vars);
    const list = d2?.alliances?.data ?? [];
    const a = Array.isArray(list) ? list[0] : undefined;
    if (Array.isArray(a?.bankrecs)) return sortDescById(a!.bankrecs).slice(0, LIMIT);
  } catch (e2) {
    if (looksLikeOrderByError(e2)) {
      const d2b = await gql<{ alliances?: { data?: Array<{ id: number, bankrecs: BankrecRow[] }> } }>(apiKey, Q_PLURAL_NOOB, vars);
      const list = d2b?.alliances?.data ?? [];
      const a = Array.isArray(list) ? list[0] : undefined;
      const rows = a?.bankrecs ?? [];
      return sortDescById(rows).slice(0, LIMIT);
    }
    throw e2;
  }

  return [];
}
