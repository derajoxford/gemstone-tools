// src/lib/pnw.ts
// Uses Node 18+ global fetch (no node-fetch import)

// -----------------------------
// Resource helpers & types
// -----------------------------

export const RESOURCE_KEYS = [
  "money",
  "coal",
  "oil",
  "uranium",
  "iron",
  "bauxite",
  "lead",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
  "food",
] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number];
export type ResourceDelta = Partial<Record<ResourceKey, number>>;

export function zeroDelta(): ResourceDelta {
  const z: ResourceDelta = {};
  for (const k of RESOURCE_KEYS) z[k] = 0;
  return z;
}

export function sumDelta(a: ResourceDelta, b: ResourceDelta): ResourceDelta {
  const out: ResourceDelta = {};
  for (const k of RESOURCE_KEYS) {
    const av = Number(a[k] ?? 0);
    const bv = Number(b[k] ?? 0);
    out[k] = av + bv;
  }
  return out;
}

export function signedDeltaFor(delta: ResourceDelta, sign: 1 | -1): ResourceDelta {
  const out: ResourceDelta = {};
  for (const k of RESOURCE_KEYS) out[k] = sign * Number(delta[k] ?? 0);
  return out;
}

// -----------------------------
// PnW GraphQL helpers
// -----------------------------

export function getAllianceApiKey(allianceId?: number): string {
  if (allianceId) {
    const perAlliance = process.env[`PNW_API_KEY_${allianceId}`];
    if (perAlliance && perAlliance.trim()) return perAlliance.trim();
  }
  const generic = process.env.PNW_API_KEY;
  if (generic && generic.trim()) return generic.trim();
  throw new Error("Alliance key record missing usable apiKey");
}

// -----------------------------
// Bankrec types + utils
// -----------------------------

export type BankrecRow = {
  id: string;
  date: string;
  note: string;
  tax_id: string;
  sender_type: number;
  receiver_type: number;
  sender_id: string;
  receiver_id: string;
};

function isAllianceRow(aid: number, r: BankrecRow): boolean {
  // type 2 = alliance (based on observed data)
  return (
    (r.sender_type === 2 && String(r.sender_id) === String(aid)) ||
    (r.receiver_type === 2 && String(r.receiver_id) === String(aid))
  );
}

// -----------------------------
// Fallback via top-level bankrecs with pagination
// -----------------------------

/**
 * Walks pages of the global bankrecs feed and filters for rows that involve the alliance.
 * This is a workaround while alliances(ids:){ bankrecs(...) } intermittently returns 500.
 */
export async function fetchAllianceBankrecsViaTopLevel(
  apiKey: string,
  allianceId: number,
  limit: number
): Promise<BankrecRow[]> {
  const collected: BankrecRow[] = [];
  const first = Math.min(Math.max(limit, 25), 100); // items per page
  const maxPages = 12; // safety cap to avoid hammering the API

  const q = `
    query($first:Int!, $page:Int!) {
      bankrecs(first:$first, page:$page) {
        data {
          id
          date
          note
          tax_id
          sender_type
          receiver_type
          sender_id
          receiver_id
        }
        paginatorInfo {
          currentPage
          lastPage
          hasMorePages
        }
      }
    }
  `;

  let page = 1;
  for (; page <= maxPages; page++) {
    const resp = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { first, page } }),
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`PnW GraphQL HTTP ${resp.status}: ${text}`);

    const parsed = JSON.parse(text);
    if (parsed?.errors?.length) throw new Error(`PnW GraphQL error: ${text}`);

    const pageRows: BankrecRow[] = parsed?.data?.bankrecs?.data ?? [];
    for (const r of pageRows) {
      if (isAllianceRow(allianceId, r)) {
        collected.push(r);
        if (collected.length >= limit) return collected.slice(0, limit);
      }
    }

    const info = parsed?.data?.bankrecs?.paginatorInfo;
    if (!info || !info.hasMorePages) break; // no more pages
  }

  return collected.slice(0, limit);
}

// -----------------------------
// Preferred path using alliances(...)
// -----------------------------

export async function fetchAllianceBankrecsViaGQL(
  apiKey: string,
  allianceId: number,
  opts: { limit: number }
): Promise<BankrecRow[]> {
  const { limit } = opts;

  const q = `
    query($aid:Int!, $first:Int!) {
      alliances(ids: [$aid]) {
        data {
          id
          bankrecs(first: $first) {
            data {
              id
              date
              note
              tax_id
              sender_type
              receiver_type
              sender_id
              receiver_id
            }
          }
        }
      }
    }
  `;

  try {
    const resp = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { aid: allianceId, first: limit } }),
    });

    const text = await resp.text();
    if (!resp.ok) throw new Error(`PnW GraphQL HTTP ${resp.status}: ${text}`);

    const parsed = JSON.parse(text);
    if (parsed?.errors?.length) throw new Error(`PnW GraphQL error: ${text}`);

    const data: BankrecRow[] =
      parsed?.data?.alliances?.data?.[0]?.bankrecs?.data ?? [];

    // guard against any mixed rows
    return data.filter((r) => isAllianceRow(allianceId, r));
  } catch {
    // When alliances(...) 500s, fall back to top-level paginated scan
    return await fetchAllianceBankrecsViaTopLevel(apiKey, allianceId, limit);
  }
}

// -----------------------------
// Public wrappers (for existing imports)
// -----------------------------

export async function fetchBankrecs(
  allianceId: number,
  opts?: { limit?: number }
): Promise<BankrecRow[]> {
  const apiKey = getAllianceApiKey(allianceId);
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  return fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
}

export async function fetchBankrecsSince(
  allianceId: number,
  afterId: number,
  opts?: { limit?: number }
): Promise<BankrecRow[]> {
  // grab a wider window then filter client-side
  const windowSize = Math.max(50, Math.min(opts?.limit ?? 100, 200));
  const rows = await fetchBankrecs(allianceId, { limit: windowSize });
  return rows.filter((r) => Number(r.id) > Number(afterId));
}
