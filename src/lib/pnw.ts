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

export async function gql<T = any>(apiKey: string, query: string, variables?: Record<string, any>): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
    body: JSON.stringify({ query, variables }),
  });

  let json: GqlResp<T>;
  try { json = (await res.json()) as any; }
  catch {
    throw new PnwGqlError(res.status, await res.text().catch(() => null), `PnW GraphQL error (status ${res.status}): non-JSON response`);
  }

  if (!res.ok || json.errors) {
    const body = json.errors || json;
    const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body)}`;
    throw new PnwGqlError(res.status, body, msg);
  }
  if (!json.data) throw new PnwGqlError(res.status, json, `PnW GraphQL error (status ${res.status}): empty data`);
  return json.data;
}

// ---------- small helpers ----------
export const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
export const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

export const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum",
] as const;
export type ResKey = (typeof RES_KEYS)[number];

// ---------- GQL: bankrecs (dual-shape support) ----------
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
  credits
`;

/**
 * Try Alliances Paginator shape first:
 *   alliances(ids:[Int]) { data { id bankrecs(limit:Int) { ... } } }
 * If the server complains (older alt shape), fall back to single-alliance:
 *   alliances(id:Int) { id bankrecs(limit:Int) { ... } }
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts?: { limit?: number }
): Promise<any[]> {
  const limit = Math.max(1, Math.min(1000, Number(opts?.limit ?? 500)));

  // Variant A: paginator
  const QA = `
    query($ids: [Int], $limit: Int){
      alliances(ids: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            ${FIELDS}
          }
        }
      }
    }
  `;

  try {
    const dataA = await gql<any>(apiKey, QA, { ids: [Number(allianceId)], limit });
    const arrA = Array.isArray(dataA?.alliances?.data) ? dataA.alliances.data : [];
    const rowA = arrA.find((a: any) => Number(a?.id) === Number(allianceId));
    return Array.isArray(rowA?.bankrecs) ? rowA.bankrecs : [];
  } catch (e: any) {
    const msg = String(e?.message || "");
    const isShapeErr =
      /AlliancePaginator|Cannot query field "data"|Unknown argument "ids"|position expecting type "\[Int]/i.test(msg);
    if (!isShapeErr) throw e;
  }

  // Variant B: single alliance (no paginator)
  const QB = `
    query($id: Int!, $limit: Int){
      alliances(id: $id) {
        id
        bankrecs(limit: $limit) {
          ${FIELDS}
        }
      }
    }
  `;
  const dataB = await gql<any>(apiKey, QB, { id: Number(allianceId), limit });
  const arrB = Array.isArray(dataB?.alliances) ? dataB.alliances : [];
  const rowB = arrB.find((a: any) => Number(a?.id) === Number(allianceId));
  return Array.isArray(rowB?.bankrecs) ? rowB.bankrecs : [];
}

/**
 * Backwards-compat for the cron in index.ts.
 * Returns [{ id, bankrecs }] the way the old helper did.
 */
export async function fetchBankrecs(
  opts: { apiKey: string },
  allianceIds: number[],
  limit = 500
): Promise<Array<{ id: number; bankrecs: any[] }>> {
  const out: Array<{ id: number; bankrecs: any[] }> = [];
  for (const id of allianceIds) {
    const bankrecs = await fetchAllianceBankrecsViaGQL(opts.apiKey, id, { limit });
    out.push({ id, bankrecs });
  }
  return out;
}
