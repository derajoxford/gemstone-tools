// src/lib/pnw.ts
import fetch from "node-fetch";

export type BankrecRow = {
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
  // not always present, but request it if available
  tax_id?: number | null;
};

export async function gql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Carry key in header too — avoids occasional auth weirdness.
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* keep raw text */ }

  // 401/403/etc
  if (!res.ok) {
    const msg = `PnW GraphQL error (status ${res.status}): ${text || res.statusText}`;
    throw new Error(msg);
  }

  // GraphQL-level errors still come back 200
  if (json && json.errors) {
    const msg = `PnW GraphQL error (status 200): ${JSON.stringify(json.errors)}`;
    throw new Error(msg);
  }

  return json.data as T;
}

/**
 * Fetch alliance bankrecs via GraphQL in paged chunks.
 * We query alliances(id:[...]) then alliance.bankrecs(first:$first,page:$page).
 * We keep it minimal and omit orderBy to avoid schema drift causing failures.
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  {
    perPage = 50,
    maxPages = 20,   // up to ~1,000 rows safest
    pageStart = 1,
  }: { perPage?: number; maxPages?: number; pageStart?: number } = {}
): Promise<BankrecRow[]> {
  const FIRST = Math.max(1, Math.min(100, perPage)); // lighthouse default: <= 100
  const MAXP = Math.max(1, Math.min(50, maxPages));

  const Q = /* GraphQL */ `
    query AllianceBankrecs($ids: [Int!], $page: Int!, $first: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(page: $page, first: $first) {
            paginatorInfo { hasMorePages currentPage lastPage }
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
              tax_id
            }
          }
        }
      }
    }
  `;

  const rows: BankrecRow[] = [];
  let page = pageStart;

  for (let i = 0; i < MAXP; i++, page++) {
    const data = await gql<{
      alliances: { data: Array<{ id: number, bankrecs: { paginatorInfo: { hasMorePages: boolean, currentPage: number, lastPage: number }, data: BankrecRow[] } }> }
    }>(apiKey, Q, { ids: [allianceId], page, first: FIRST });

    const ali = data?.alliances?.data?.[0];
    if (!ali) break;

    const batch = ali.bankrecs?.data ?? [];
    rows.push(...batch);

    const hasMore = ali.bankrecs?.paginatorInfo?.hasMorePages;
    if (!hasMore) break;
  }

  return rows;
}
