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
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw new PnwGqlError(res.status, body, msg);
    }
    return body.data as T;
  }

  throw new PnwGqlError(500, null, "PnW GraphQL retry exhaustion");
}

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

/** Pull all message strings out of a PnwGqlError, safely. */
function getErrorMessages(err: any): string[] {
  const msgs: string[] = [];
  const body = err?.body;
  if (body?.errors && Array.isArray(body.errors)) {
    for (const e of body.errors) {
      if (e?.message) msgs.push(String(e.message));
    }
  }
  if (!msgs.length && err?.message) msgs.push(String(err.message));
  return msgs;
}

/** Is this a schema/shape mismatch that we should fall back from? */
function isShapeError(err: any): boolean {
  const msgs = getErrorMessages(err);
  return msgs.some((m) =>
    /AlliancePaginator/.test(m) ||
    /Cannot query field "alliances" on type "Query"/.test(m) ||
    /Cannot query field "alliance" on type "Query"/.test(m) ||
    /Unknown argument "ids" on field "alliances"/.test(m) ||
    /Unknown argument "id" on field "alliances"/.test(m) ||
    /Unknown argument "first" on field "alliances"/.test(m) ||
    /Cannot query field "data" on type "Alliance"/.test(m) ||
    /Variable "\$id".*position expecting type "\[Int\]"/.test(m)
  );
}

/**
 * Fetch alliance bankrecs; try multiple schema shapes.
 * We intentionally try the Paginator shape first because many shards expose it.
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const ids = [Number(allianceId)];

  const FIELDS = `
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
  `;

  // B) alliances(id: [Int!], first: 1) -> { data: [Alliance] }
  const Q_B = `
    query Bankrecs_B($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids, first: 1) {
        data { ${FIELDS} }
      }
    }
  `;

  // A) alliances(id: [Int!]) -> [Alliance]
  const Q_A = `
    query Bankrecs_A($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids) {
        ${FIELDS}
      }
    }
  `;

  // C) alliances(ids: [Int!]) -> [Alliance]
  const Q_C = `
    query Bankrecs_C($ids: [Int!]!, $limit: Int!) {
      alliances(ids: $ids) {
        ${FIELDS}
      }
    }
  `;

  // D) legacy: alliance(id: Int!) -> Alliance
  const Q_D = `
    query Bankrecs_D($id: Int!, $limit: Int!) {
      alliance(id: $id) {
        ${FIELDS}
      }
    }
  `;

  // ---- Try B (Paginator) ----
  try {
    type R = { alliances: { data: Array<{ id: number; bankrecs: any[] }> } | null };
    const d = await gql<R>(apiKey, Q_B, { ids, limit });
    const arr = d?.alliances?.data ?? [];
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.bankrecs) return coerceRows(first.bankrecs);
    if (Array.isArray(arr) && arr.length === 0) return [];
  } catch (e: any) {
    if (!isShapeError(e)) throw e;
  }

  // ---- Try A (Array of Alliance) ----
  try {
    type R = { alliances: Array<{ id: number; bankrecs: any[] }> | null };
    const d = await gql<R>(apiKey, Q_A, { ids, limit });
    const arr = d?.alliances ?? [];
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.bankrecs) return coerceRows(first.bankrecs);
    if (Array.isArray(arr) && arr.length === 0) return [];
  } catch (e: any) {
    if (!isShapeError(e)) throw e;
  }

  // ---- Try C (alliances(ids: ...)) ----
  try {
    type R = { alliances: Array<{ id: number; bankrecs: any[] }> | null };
    const d = await gql<R>(apiKey, Q_C, { ids, limit });
    const arr = d?.alliances ?? [];
    const first = Array.isArray(arr) ? arr[0] : null;
    if (first && first.bankrecs) return coerceRows(first.bankrecs);
    if (Array.isArray(arr) && arr.length === 0) return [];
  } catch (e: any) {
    if (!isShapeError(e)) throw e;
  }

  // ---- Try D (legacy single alliance) ----
  try {
    type R = { alliance: { id: number; bankrecs: any[] } | null };
    const d = await gql<R>(apiKey, Q_D, { id: Number(allianceId), limit });
    const a = d?.alliance;
    if (a && a.bankrecs) return coerceRows(a.bankrecs);
  } catch (e: any) {
    if (!isShapeError(e)) throw e;
  }

  return [];
}

/** Heuristic: likely a tax credit into the alliance bank. */
export function isLikelyTaxRow(r: BankrecRow, allianceId: number): boolean {
  const n = (r.note || "").toLowerCase();
  const noteLooksTax = n.includes("automated tax") || n.includes(" tax ") || n.startsWith("tax");
  const flowLooksTax = r.sender_type === 1 && r.receiver_type === 2 && r.receiver_id === allianceId;
  return noteLooksTax && flowLooksTax;
}
