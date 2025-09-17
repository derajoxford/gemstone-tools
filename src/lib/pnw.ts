// src/lib/pnw.ts

// NOTE: Node 18+ has global fetch. Do not import 'node-fetch' to avoid bundling issues.

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

/**
 * Resolve API key for an alliance:
 *  - PNW_API_KEY_<ALLIANCE_ID>
 *  - PNW_API_KEY
 */
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
// Bankrec types + filters
// -----------------------------

export type BankrecRow = {
  id: string; // numeric string
  date: string; // ISO
  note: string;
  tax_id: string; // "0" if not a tax attachment
  sender_type: number;
  receiver_type: number;
  sender_id: string;
  receiver_id: string;
};

function isAllianceRow(aid: number, r: BankrecRow): boolean {
  // Based on observed data, '2' denotes alliance type.
  return (
    (r.sender_type === 2 && String(r.sender_id) === String(aid)) ||
    (r.receiver_type === 2 && String(r.receiver_id) === String(aid))
  );
}

// -----------------------------
// Fallback: Top-level bankrecs
// -----------------------------

/**
 * Temporary workaround for current 500s from alliances(...) resolver.
 * Pulls top-level { bankrecs(first: N) } and filters client-side to the alliance.
 */
export async function fetchAllianceBankrecsViaTopLevel(
  apiKey: string,
  allianceId: number,
  limit: number
): Promise<BankrecRow[]> {
  // Ask for more than limit to offset non-alliance rows; cap to keep it light.
  const fetchCount = Math.min(Math.max(limit * 3, limit), 50);

  const q = `
    {
      bankrecs(first: ${fetchCount}) {
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
  `;

  const resp = await fetch(`https://api.politicsandwar.com/graphql?api_key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`PnW GraphQL HTTP ${resp.status}: ${text}`);

  const parsed = JSON.parse(text);
  if (parsed?.errors?.length) throw new Error(`PnW GraphQL error: ${text}`);

  const rows: BankrecRow[] = parsed?.data?.bankrecs?.data ?? [];
  return rows.filter((r) => isAllianceRow(allianceId, r)).slice(0, limit);
}

// -----------------------------
// Primary fetch: alliances(...)
// -----------------------------

/**
 * Preferred path using alliances(ids:){ data{ bankrecs(first:) } }.
 * If this throws (HTTP 500, etc.), we automatically fall back to top-level bankrecs().
 */
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

    // Even if PnW returns a mixed set (it shouldn't), ensure alliance-only.
    return data.filter((r) => isAllianceRow(allianceId, r));
  } catch (_e) {
    // Transparent fallback while PnW fixes alliances(...)
    return await fetchAllianceBankrecsViaTopLevel(apiKey, allianceId, limit);
  }
}

// -----------------------------
// Public wrappers (preserve old imports)
// -----------------------------

/**
 * Fetch recent bankrecs for an alliance. Uses per-alliance API key if present.
 */
export async function fetchBankrecs(
  allianceId: number,
  opts?: { limit?: number }
): Promise<BankrecRow[]> {
  const apiKey = getAllianceApiKey(allianceId);
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100));
  return fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
}

/**
 * Fetch bankrecs *after* a specific numeric ID (strictly greater than).
 * Note: We grab a window then client-filter; for deep pagination, expand as needed.
 */
export async function fetchBankrecsSince(
  allianceId: number,
  afterId: number,
  opts?: { limit?: number }
): Promise<BankrecRow[]> {
  const rows = await fetchBankrecs(allianceId, { limit: Math.max(10, opts?.limit ?? 50) });
  return rows.filter((r) => Number(r.id) > Number(afterId));
}
