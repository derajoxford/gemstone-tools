// src/lib/pnw.ts
// Minimal PnW GraphQL client + bankrecs helpers.
// Uses Node 18+/20+ global fetch (no node-fetch import needed).

export type BankrecRow = {
  id: number;
  date: string;
  sender_type: number;
  sender_id: number;
  receiver_type: number;
  receiver_id: number;
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

export class PnwGqlError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, msg: string) {
    super(`PnW GraphQL error (status ${status}): ${msg}`);
    this.status = status;
    this.body = body;
  }
}

async function gql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ query, variables }),
  });

  let body: any = null;
  try { body = await res.json(); } catch {
    throw new PnwGqlError(res.status, null, "Invalid JSON from PnW");
  }

  if (!res.ok || body?.errors) {
    const msg = JSON.stringify(body?.errors ?? body ?? {});
    throw new PnwGqlError(res.status, body, msg);
  }
  return body.data as T;
}

/**
 * Fetch bankrecs for a single alliance.
 * IMPORTANT: schema wants a single `alliance(id: Int!)`, and `orderBy` is an array of clauses.
 * `limit` is max rows (PnW typically caps around ~600).
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  { limit = 200 }: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const Q = /* GraphQL */ `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        id
        bankrecs(
          limit: $limit,
          orderBy: [{ column: ID, order: DESC }]
        ) {
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
        }
      }
    }
  `;

  const data = await gql<{ alliance: { id: number; bankrecs: BankrecRow[] } }>(
    apiKey,
    Q,
    { id: Number(allianceId), limit: Number(limit) }
  );

  const rows = data?.alliance?.bankrecs ?? [];
  // Normalize numeric fields
  for (const r of rows) {
    for (const k of [
      "id", "sender_type", "sender_id", "receiver_type", "receiver_id",
      "money", "food", "coal", "oil", "uranium", "lead", "iron",
      "bauxite", "gasoline", "munitions", "steel", "aluminum",
    ] as const) {
      // @ts-ignore
      r[k] = Number(r[k] ?? 0);
    }
  }
  return rows;
}

/**
 * Back-compat wrapper used by /pnw_bankpeek and older code.
 * Signature kept intentionally simple: ({apiKey}, [allianceId], limit) -> [{ id, bankrecs: BankrecRow[] }]
 */
export async function fetchBankrecs(
  opts: { apiKey: string },
  allianceIds: number[],
  limit = 200
): Promise<Array<{ id: number; bankrecs: BankrecRow[] }>> {
  const out: Array<{ id: number; bankrecs: BankrecRow[] }> = [];
  for (const id of allianceIds) {
    const rows = await fetchAllianceBankrecsViaGQL(opts.apiKey, id, { limit });
    out.push({ id, bankrecs: rows });
  }
  return out;
}
