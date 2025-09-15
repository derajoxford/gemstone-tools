// src/lib/pnw.ts
export class PnwGqlError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
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

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, any>
): Promise<T> {
  const res = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* noop */ }

  if (!res.ok || (body && body.errors)) {
    const msg = `PnW GraphQL error (status ${res.status}): ${body?.errors ? JSON.stringify(body.errors) : text}`;
    throw new PnwGqlError(res.status, body ?? text, msg);
  }

  return body.data as T;
}

/**
 * Fetch recent bankrecs for a single alliance via GraphQL.
 * Uses the current schema:
 *   alliances(id:[ID]) { bankrecs(limit:Int, orderBy:[{column:ID, order:DESC}] ) { ... } }
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number; order?: "DESC" | "ASC" } = {}
): Promise<BankrecRow[]> {
  const LIMIT = Math.max(1, Math.min(500, opts.limit ?? 100));
  const ORDER = opts.order ?? "DESC";

  const Q = `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliances(id: [$id]) {
        id
        bankrecs(limit: $limit, orderBy: [{ column: ID, order: ${ORDER} }]) {
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
          iron
          bauxite
          lead
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

  type Resp = {
    alliances: Array<{
      id: number;
      bankrecs: BankrecRow[];
    }>;
  };

  const data = await gql<Resp>(apiKey, Q, { id: allianceId, limit: LIMIT });
  const ali = data?.alliances?.[0];
  if (!ali) return [];
  return ali.bankrecs ?? [];
}
