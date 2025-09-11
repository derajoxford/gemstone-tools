// src/lib/pnw.ts
import { request as rq, gql } from "graphql-request";

type PnwOpts = { apiKey: string; botKey?: string };

// Low-level GQL call (URL param + header both accepted by PnW; we use URL param)
export async function pnwQuery<T = any>(
  opts: PnwOpts,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(
    opts.apiKey
  )}`;
  // Use fetch instead of graphql-request’s client to keep headers minimal & transparent
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": opts.apiKey },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any)?.errors) {
    throw new Error(
      `PnW GraphQL error (status ${res.status}): ${
        JSON.stringify((json as any)?.errors) || "unknown"
      }`
    );
  }
  return (json as any).data as T;
}

/**
 * Fetch recent bankrecs for given alliances.
 * NOTE:
 *  - $limit is OPTIONAL (Int) so we never hit “must not be null”.
 *  - We return the raw alliances array with .data[0].bankrecs
 */
export async function fetchBankrecs(
  opts: PnwOpts,
  allianceIds: number[],
  limit?: number
): Promise<
  Array<{
    id: number;
    bankrecs?: any[];
  }>
> {
  const q = /* GraphQL */ `
    query ($ids: [Int!]!, $limit: Int) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            tax_id
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
  `;

  const data = await pnwQuery<{
    alliances: { data: Array<{ id: number; bankrecs: any[] }> };
  }>(opts, q, { ids: allianceIds, limit: limit ?? null });

  return (data?.alliances?.data || []).map((a) => ({
    id: a.id,
    bankrecs: a.bankrecs || [],
  }));
}
