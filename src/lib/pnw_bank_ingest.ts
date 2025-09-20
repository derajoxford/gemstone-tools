// src/lib/pnw_bank_ingest.ts
import fetch from "node-fetch";

export interface BankrecRow {
  id: string;               // numeric string
  date: string;             // ISO
  note: string | null;
  sender_type: number;      // 1=nation, 2=alliance, 3=trade?
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
}

export interface FetchOpts {
  apiKey: string;
  allianceId: number;
  limit?: number;           // default 50
  minId?: number | null;    // fetch rows with id > minId (cursor)
  timeoutMs?: number;       // default 15000
}

/**
 * Fetch alliance-scoped bankrecs via GraphQL v3
 * Shape: alliances(id:[ID]) { data { bankrecs(limit: L, min_id: X?) { ... } } }
 */
export async function fetchAllianceBankrecs(opts: FetchOpts): Promise<BankrecRow[]> {
  const {
    apiKey,
    allianceId,
    limit = 50,
    minId = null,
    timeoutMs = 15000,
  } = opts;

  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);

  const query = `
    query ($aid:[Int!], $limit:Int!, $min:Int) {
      alliances(id:$aid) {
        data {
          id
          name
          bankrecs(limit:$limit, min_id:$min) {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
          }
        }
      }
    }`;

  const body = JSON.stringify({
    query,
    variables: { aid: [allianceId], limit, min: minId ?? undefined },
  });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PnW GraphQL HTTP ${res.status}: ${text.slice(0, 400)}`);
    }

    const json: any = JSON.parse(text);
    if (json.errors?.length) {
      throw new Error(`PnW GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
    }

    const alliance = json?.data?.alliances?.data?.[0];
    const rows: BankrecRow[] = alliance?.bankrecs ?? [];
    return rows ?? [];
  } catch (err) {
    // Bubble up for caller to decide (command or cron can log)
    throw err;
  } finally {
    clearTimeout(t);
  }
}

/** Simple filters the command already expects */
export type PeekFilter = "all" | "tax" | "nontax";

/** True if a row is “tax” by our heuristic */
export function isTaxRow(r: BankrecRow): boolean {
  // Heuristic: tax deposits are nation -> alliance
  // (sender_type=1 nation, receiver_type=2 alliance)
  return r.sender_type === 1 && r.receiver_type === 2;
}

export function applyPeekFilter(rows: BankrecRow[], filter: PeekFilter): BankrecRow[] {
  if (filter === "all") return rows;
  if (filter === "tax") return rows.filter(isTaxRow);
  return rows.filter(r => !isTaxRow(r));
}
