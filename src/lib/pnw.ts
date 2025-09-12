// src/lib/pnw.ts
import fetch from "node-fetch";

type GqlError = { message: string };
type GqlResp<T> = { data?: T; errors?: GqlError[] };

export class PnwGqlError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any, message?: string) {
    super(message || `PnW GraphQL error (status ${status})`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal GQL helper for PnW (v2) — POST with api_key in querystring
 */
export async function gql<T = any>(apiKey: string, query: string, variables?: Record<string, any>): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // X-Api-Key header is optional when api_key is in the querystring, but keep it for parity:
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  let json: GqlResp<T>;
  try {
    json = (await res.json()) as any;
  } catch {
    throw new PnwGqlError(res.status, await res.text().catch(() => null), `PnW GraphQL error (status ${res.status}): non-JSON response`);
  }

  if (!res.ok || json.errors) {
    const body = json.errors || json;
    const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body)}`;
    throw new PnwGqlError(res.status, body, msg);
  }
  if (!json.data) {
    throw new PnwGqlError(res.status, json, `PnW GraphQL error (status ${res.status}): empty data`);
  }
  return json.data;
}

/**
 * Fetch alliance bankrecs. Schema (2025-09):
 * alliances(id: ID!) { id bankrecs(limit: Int) { ...Bankrec } }
 *
 * NOTE: This returns a plain array (no paginator). We filter client-side by id.
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts?: { limit?: number }
): Promise<Array<any>> {
  const limit = Math.max(1, Math.min(1000, Number(opts?.limit ?? 500)));

  const QUERY = `
    query($id: ID!, $limit: Int){
      alliances(id: $id) {
        id
        bankrecs(limit: $limit) {
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
          credits
        }
      }
    }
  `;

  const data = await gql<any>(apiKey, QUERY, { id: String(allianceId), limit });
  const arr = Array.isArray(data?.alliances) ? data.alliances : [];
  const row = arr.find((a: any) => Number(a?.id) === Number(allianceId));
  const recs = Array.isArray(row?.bankrecs) ? row.bankrecs : [];
  return recs;
}

/** numeric safe-helpers */
export const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
export const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

export const RES_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
  // "credits" — not part of tax income but present on recs
] as const;
export type ResKey = (typeof RES_KEYS)[number];
