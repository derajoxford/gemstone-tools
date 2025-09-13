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
 * Tries the plural `alliances(id: [$id])` first; if that shape isn't supported on
 * the server, falls back to `alliance(id: $id)`.
 *
 * NOTE: There is no documented server-side filter for "Automated Tax" notes,
 * so we fetch and filter client-side.
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const LIMIT = Math.max(1, Math.min(1000, opts.limit ?? 200));

  // Query A: plural "alliances"
  const Q_ALLIANCES = `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliances(id: [$id]) {
        id
        bankrecs(limit: $limit, orderBy: "id desc") {
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

  // Query B: singular "alliance"
  const Q_ALLIANCE = `
    query AllianceBankrecsSingle($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: "id desc") {
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

  const vars = { id: allianceId, limit: LIMIT };

  try {
    const data = await gql<{ alliances: Array<{ id: number, bankrecs: BankrecRow[] }> }>(apiKey, Q_ALLIANCES, vars);
    const list = Array.isArray(data?.alliances) ? data.alliances : [];
    const a = list[0];
    return (a?.bankrecs ?? []) as BankrecRow[];
  } catch (err: any) {
    const msg = String(err?.message || "");
    // If the server doesn't support the plural shape, try the singular.
    if (/Cannot query field .*alliances|Unknown argument .*id.* on field "alliances"/i.test(msg)) {
      const data = await gql<{ alliance?: { id: number, bankrecs: BankrecRow[] } }>(apiKey, Q_ALLIANCE, vars);
      return (data?.alliance?.bankrecs ?? []) as BankrecRow[];
    }
    throw err;
  }
}
