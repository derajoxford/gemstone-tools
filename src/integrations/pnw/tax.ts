// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

/**
 * --- TYPES ---
 */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive): only records with id > sinceId are considered */
  sinceId?: number | null;
  /** Optional explicit tax_id allow-list (overrides stored filter) */
  allowedTaxIds?: number[] | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  /** Optional lower cursor (exclusive) */
  lastSeenId?: number | null;
  /** If false, just preview and do not add to treasury */
  confirm?: boolean;
};

export type ApplyResult = {
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: ResourceDelta;
  applied: boolean;
  mode: "apply" | "noop";
};

/**
 * --- HELPERS ---
 * Query recent bank records for an alliance (newest-first). We keep the query
 * compatible with the current PnW GraphQL shape:
 *   alliances(id: [Int]) -> AlliancePaginator -> data: [Alliance]
 *   Alliance.bankrecs(limit: Int)
 */
async function fetchRecentBankrecs(
  apiKey: string,
  allianceId: number,
  limit: number = 500,
) {
  const query = `
    query AllianceBankrecs($ids: [Int], $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            tax_id
            stype
            rtype
            money
            food
            munitions
            gasoline
            steel
            aluminum
            oil
            uranium
            bauxite
            coal
            iron
            lead
          }
        }
      }
    }
  ` as const;

  const vars = { ids: [allianceId], limit };
  const data: any = await pnwQuery(apiKey, query, vars);
  const recs: any[] = data?.alliances?.data?.[0]?.bankrecs ?? [];
  return recs;
}

function sumDeltaFromRecs(recs: any[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  const resFields = [
    "money",
    "food",
    "munitions",
    "gasoline",
    "steel",
    "aluminum",
    "oil",
    "uranium",
    "bauxite",
    "coal",
    "iron",
    "lead",
  ] as const;

  for (const r of recs) {
    const id = Number(r?.id ?? 0);
    if (id && (newestId === null || id > newestId)) newestId = id;

    for (const f of resFields) {
      const v = Number(r?.[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

/**
 * --- PUBLIC API (manual-key) ---
 * Used by /pnw_set to validate a user-entered key BEFORE we store it.
 * Respects an optional allowedTaxIds list if provided.
 */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, allowedTaxIds = null } = args;

  const recsAll = await fetchRecentBankrecs(apiKey, allianceId, 500);

  // Filter: only records with id > sinceId (if provided)
  let recs = recsAll.filter((r: any) => {
    const idNum = Number(r?.id ?? 0);
    return !sinceId || (Number.isFinite(idNum) && idNum > sinceId);
  });

  // Filter: only those with a matching tax_id if an allow-list exists
  const allow = (allowedTaxIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  if (allow.length) {
    const set = new Set(allow);
    recs = recs.filter((r: any) => set.has(Number(r?.tax_id ?? 0)));
  } else {
    // Otherwise, treat any record that has a positive tax_id as tax-related
    recs = recs.filter((r: any) => Number(r?.tax_id ?? 0) > 0);
  }

  return sumDeltaFromRecs(recs);
}

/**
 * --- PUBLIC API (stored-key wrappers) ---
 * These use the per-alliance stored key and stored tax_id filter.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  const allowed = await getAllowedTaxIds(allianceId);  // [] means "no filter" -> any tax_id > 0
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null, allowedTaxIds: allowed });
}

/**
 * Apply: fetch tax records after lastSeenId, compute delta, and (optionally) add to treasury.
 * Returns what it did, plus newestId so callers can advance a cursor.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  const allowed = await getAllowedTaxIds(allianceId);

  const preview = await previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: lastSeenId,
    allowedTaxIds: allowed,
  });

  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId, newestId: preview.newestId },
    });
  }

  return {
    allianceId,
    lastSeenId,
    newestId: preview.newestId,
    records: preview.count,
    delta: preview.delta,
    applied,
    mode: applied ? "apply" : "noop",
  };
}
