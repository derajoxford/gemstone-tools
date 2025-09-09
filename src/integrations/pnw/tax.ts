// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive). We’ll client-filter by id > sinceId. */
  sinceId?: number | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  lastSeenId?: number | null;
  confirm?: boolean; // if false, preview only
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

const RES_FIELDS = [
  "money","food","munitions","gasoline","steel","aluminum",
  "oil","uranium","bauxite","coal","iron","lead",
] as const;

function sumDelta(recs: any[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};
  for (const r of recs) {
    const id = Number(r?.id ?? 0);
    if (id && (newestId === null || id > newestId)) newestId = id;
    for (const f of RES_FIELDS) {
      const v = Number(r?.[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }
  return { count: recs.length, newestId, delta };
}

function looksLikeTax(r: any): boolean {
  // Fallback heuristic if no tax_id filter saved
  const note = String(r?.note ?? "");
  const stype = String(r?.stype ?? "").toUpperCase();   // sender type
  const rtype = String(r?.rtype ?? "").toUpperCase();   // receiver type
  // “Nation -> Alliance” deposits with “tax” in the note are almost always tax pulls
  if (/\btax\b/i.test(note) && stype === "NATION" && rtype === "ALLIANCE") return true;
  return false;
}

/**
 * Fetch recent bank records (newest first) and client-filter by sinceId/tax filter.
 * We deliberately avoid PnW’s “ids/paginator/after(DateTime)” variants for compatibility.
 */
async function fetchTaxRecs(
  apiKey: string,
  allianceId: number,
  sinceId: number | null,
  allowedTaxIds: number[] | null,
  limit = 400 // pull a decent window; we’ll filter client-side
) {
  const query = `
    query AllianceBankrecsSimple($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit) {
          id
          tax_id
          note
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
          date
        }
      }
    }
  ` as const;

  const data: any = await pnwQuery(apiKey, query, { id: allianceId, limit });
  let recs: any[] = data?.alliances?.[0]?.bankrecs ?? [];

  // Only records after our cursor
  if (sinceId) recs = recs.filter(r => Number(r?.id ?? 0) > sinceId);

  // Filter to tax-only:
  // - If specific tax_ids are stored, require a match
  // - Otherwise, use the heuristic
  if (allowedTaxIds?.length) {
    const set = new Set(allowedTaxIds.map(Number));
    recs = recs.filter(r => set.has(Number(r?.tax_id ?? 0)));
  } else {
    recs = recs.filter(looksLikeTax);
  }

  return recs;
}

/** Public: validate a provided key (manual preview) */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null } = args;
  const allowedTaxIds = await getAllowedTaxIds(allianceId);
  const recs = await fetchTaxRecs(apiKey, allianceId, sinceId, allowedTaxIds ?? null);
  return sumDelta(recs);
}

/** Public: use the stored (encrypted) read key */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const allowedTaxIds = await getAllowedTaxIds(allianceId);
  const recs = await fetchTaxRecs(apiKey, allianceId, sinceId ?? null, allowedTaxIds ?? null);
  return sumDelta(recs);
}

/** Apply: add preview delta to treasury and return the result */
export async function applyAllianceTaxCreditsStored(args: ApplyArgsStored): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);
  const allowedTaxIds = await getAllowedTaxIds(allianceId);

  const recs = await fetchTaxRecs(apiKey, allianceId, lastSeenId, allowedTaxIds ?? null);
  const preview = sumDelta(recs);
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
