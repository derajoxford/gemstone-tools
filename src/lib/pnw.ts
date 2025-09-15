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

// Minimal Bankrec row shape we actually use
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
        // pass in header too – some infra likes it this way
        "X-Api-Key": apiKey,
        "Accept": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    let body: any = null;
    try { body = await res.json(); } catch {}

    // GraphQL puts errors in body.errors with HTTP 200 sometimes
    const hasErrors = !!(body && body.errors && body.errors.length);
    if (!res.ok || hasErrors) {
      const msg = `PnW GraphQL error (status ${res.status}): ${JSON.stringify(body?.errors || body)}`;
      // retry only on obvious server hiccups
      const transient = res.status >= 500 || (hasErrors && JSON.stringify(body.errors).includes("Internal Server Error"));
      if (transient && attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new PnwGqlError(res.status, body, msg);
    }
    return body.data as T;
  }
  // should never reach
  throw new PnwGqlError(500, null, "PnW GraphQL retry exhaustion");
}

/**
 * Fetch alliance bankrecs via GraphQL (simple, stable shape).
 * Uses the *singular* alliance(id: Int!) field and the bankrecs(limit: Int!) list.
 * No paginator/ordering shenanigans — we rely on API defaults.
 */
export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit?: number } = {}
): Promise<BankrecRow[]> {
  const LIMIT = Math.max(1, Math.min(1000, opts.limit ?? 200));

  const Q = `
    query Bankrecs($id: Int!, $limit: Int!) {
      alliance(id: $id) {
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

  type Resp = { alliance: { id: number, bankrecs: BankrecRow[] } | null };
  const data = await gql<Resp>(apiKey, Q, { id: allianceId, limit: LIMIT });
  const rows = data?.alliance?.bankrecs ?? [];
  // coerce numbers
  return rows.map(r => ({
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

/** Heuristic: is this bankrec a tax credit into the alliance? */
export function isLikelyTaxRow(r: BankrecRow, allianceId: number): boolean {
  // Classic automated tax note; keep case-insensitive match
  const n = (r.note || "").toLowerCase();
  const noteLooksTax = n.includes("automated tax") || n.includes("tax ");
  // nation -> alliance + positive resources
  const flowLooksTax = r.sender_type === 1 && r.receiver_type === 2 && r.receiver_id === allianceId;
  return noteLooksTax && flowLooksTax;
}
