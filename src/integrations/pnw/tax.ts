// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";
import { appendTaxHistory } from "../../utils/pnw_tax_history";

/**
 * --- TYPES ---
 */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional: only count records with id > sinceId */
  sinceId?: number | null;
  /** Optional: how many recent taxrecs to fetch from API (default 250; API window is 14 days) */
  limit?: number;
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
  /** If false, preview only (no treasury write / history append) */
  confirm?: boolean;
  /** Optional fetch cap */
  limit?: number;
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
 * --- INTERNAL HELPERS ---
 */

const RES_FIELDS = [
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

type TaxRec = {
  id: number;
  date?: string | null;
  note?: string | null;
  tax_id?: number | null;
} & { [K in (typeof RES_FIELDS)[number]]?: number | null };

async function fetchTaxRecs(
  apiKey: string,
  allianceId: number,
  limit = 250,
): Promise<TaxRec[]> {
  // alliances(id: [Int]) -> { data: [Alliance] } -> taxrecs(limit: Int)
  const query = `
    query TaxRecs($ids: [Int!]!, $limit: Int) {
      alliances(id: $ids, first: 1) {
        data {
          id
          taxrecs(limit: $limit) {
            id
            date
            note
            tax_id
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

  const list: TaxRec[] =
    data?.alliances?.data?.[0]?.taxrecs ?? [];

  // API already returns "Automated Tax" only via taxrecs; no note filtering needed.
  return list;
}

function sumDelta(recs: TaxRec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    if (typeof r.id === "number") {
      if (newestId === null || r.id > newestId) newestId = r.id;
    }
    for (const f of RES_FIELDS) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }
  return { count: recs.length, newestId, delta };
}

function applySinceAndFilter(
  recs: TaxRec[],
  sinceId: number | null | undefined,
  allowedTaxIds: number[] | null,
): TaxRec[] {
  let out = recs;
  if (sinceId != null) {
    out = out.filter((r) => Number(r.id) > Number(sinceId));
  }
  if (allowedTaxIds && allowedTaxIds.length) {
    const allow = new Set(allowedTaxIds.map(Number));
    out = out.filter((r) => r?.tax_id && allow.has(Number(r.tax_id)));
  }
  return out;
}

/**
 * --- PUBLIC API (manual-key) ---
 * Useful for /pnw_preview (user pastes a key directly).
 */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, limit = 250 } = args;
  const recs = await fetchTaxRecs(apiKey, allianceId, limit);
  // Manual-key preview does not apply stored tax_id filtering.
  const filtered = applySinceAndFilter(recs, sinceId, null);
  return sumDelta(filtered);
}

/**
 * --- PUBLIC API (stored-key) ---
 */

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
  limit = 250,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  const recs = await fetchTaxRecs(apiKey, allianceId, limit);
  const allow = await getAllowedTaxIds(allianceId);
  const filtered = applySinceAndFilter(recs, sinceId ?? null, allow ?? null);
  return sumDelta(filtered);
}

/**
 * Apply: fetch tax records after lastSeenId and (optionally) add to treasury.
 * Also persists the processed records into our local long-term history store.
 * Note: saving the cursor & writing an "apply log" is still done by the /pnw_apply command.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true, limit = 250 } = args;
  const apiKey = await getAllianceReadKey(allianceId);

  const recs = await fetchTaxRecs(apiKey, allianceId, limit);
  const allow = await getAllowedTaxIds(allianceId);
  const filtered = applySinceAndFilter(recs, lastSeenId, allow ?? null);

  const preview = sumDelta(filtered);
  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId, newestId: preview.newestId },
    });

    // Persist raw records we just applied so data survives the 14-day API window.
    await appendTaxHistory(allianceId, filtered);
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
