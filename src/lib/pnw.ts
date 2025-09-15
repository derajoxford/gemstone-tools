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

// Minimal shape we actually use
export interface BankrecRow {
  id: number;
  date: string;
  sender_type: number;
  sender_id: number;
  receiver_type: number;
  receiver_id: number;
  note: string | null;
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
}

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, any>,
  { retries = 2 }: { retries?: number } = {}
): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        // Some infra wants it in the header too
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    let body: any = null;
    try { body = await res.json(); } catch {}

    const hasErrors = !!(body && body.errors && body.errors.length);
    if (!res.ok || hasErrors) {
      const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body?.errors || body)}`;
      const transient = res.status >= 500 || (hasErrors && JSON.stringify(body.errors).includes("Internal Server Error"));
      if (transient && attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new PnwGqlError(res.status, body, msg);
    }
    return body.data as T;
  }

  throw new PnwGqlError(500, null, "PnW GraphQL retry exhaustion");
}

/** Normalize numeric columns to numbers (API sometimes returns strings). */
function coerceRows(rows: any[]): BankrecRow[] {
  return (rows || []).map((r: any) => ({
    ...r,
    id: Number(r.id),
    sender_type: Number(r.sender_type),
    sender_id: Number(r.sender_id),
    receiver_type: Number(r.receiver_type),
    receiver_id: Number(r.receiver_id),
    money: Number(r.money || 0),
    food: Number(r.food || 0),
    coal: Number(r.coal || 0),
    oil: Number(r.oil || 0),
    uranium: Number(r.uranium || 0),
    lead: Number(r.lead || 0),
    iron: Number(r.iron || 0),
    bauxite: Number(r.bauxite || 0),
    gasoline: Number(r.gasoline || 0),
    munitions: Number(r.munitions || 0),
    steel: Number(r.steel || 0),
    aluminum: Number(r.aluminum || 0),
    note: r.note ?? null,
  }));
}

/**
 * Fetch alliance bankrecs via GraphQL in a way that tolerates schema variants.
 * 1) Try `alliances(id: $id) { ... }`     (array-of-Alliance variant)
 * 2) Try `alliances(id: $id, first: 1) { data { ... } }` (paginator variant)
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));

  // Variant 1: alliances(id) -> [Alliance]
  const Q1 = `
    query BankrecsV1($id: Int!, $limit: Int!) {
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
        }
      }
    }
  `;

  // Variant 2: alliances(id, first: 1) -> { data: [Alliance] }
  const Q2 = `
    query BankrecsV2($id: Int!, $limit: Int!) {
      alliances(id: $id, first: 1) {
        data {
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
          }
        }
      }
    }
  `;

  // Try V1
  try {
    type R1 = { alliances: Array<{ id: number; bankrecs: any[] }> | null };
    const d1 = await gql<R1>(apiKey, Q1, { id: allianceId, limit });
    const arr = (d1?.alliances ?? []) as Array<any>;
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.bankrecs) return coerceRows(first.bankrecs);
    // If alliances exists but empty, just return [] (no error)
    if (Array.isArray(arr) && arr.length === 0) return [];
    // Fallthrough to try V2
  } catch (e: any) {
    const msg = String(e?.message || "");
    // Only swallow errors that indicate a shape mismatch; rethrow hard errors
    const shapeErr =
      msg.includes('Cannot query field "alliances"') ||
      msg.includes('Unknown argument "id" on field "alliances"') ||
      msg.includes('Cannot query field "bankrecs" on type "AlliancePaginator"') ||
      msg.includes('Cannot query field "id" on type "AlliancePaginator"') ||
      msg.includes('Unknown argument "ids" on field "alliances"');
    if (!shapeErr) throw e;
  }

  // Try V2
  try {
    type R2 = { alliances: { data: Array<{ id: number; bankrecs: any[] }> } | null };
    const d2 = await gql<R2>(apiKey, Q2, { id: allianceId, limit });
    const arr = d2?.alliances?.data ?? [];
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.bankrecs) return coerceRows(first.bankrecs);
    return [];
  } catch (e: any) {
    // If this also fails, bubble it up
    throw e;
  }
}

/** Heuristic: is this bankrec a tax credit into the alliance? */
export function isLikelyTaxRow(r: BankrecRow, allianceId: number): boolean {
  const n = (r.note || "").toLowerCase();
  const noteLooksTax = n.includes("automated tax") || n.includes(" tax ") || n.startsWith("tax");
  const flowLooksTax = r.sender_type === 1 && r.receiver_type === 2 && r.receiver_id === allianceId;
  return noteLooksTax && flowLooksTax;
}
