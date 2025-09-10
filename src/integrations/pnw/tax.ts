// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";
import { addToTreasury } from "../../utils/treasury";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Only include records with id > sinceId (client-side filtered) */
  sinceId?: number | null;
  /** Optional tax_id allowlist; if empty or null we use heuristic (tax_id > 0) */
  allowedTaxIds?: number[] | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  /** Only include records with id > lastSeenId (client-side filtered) */
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

/**
 * Fetch recent bank records for an alliance.
 * IMPORTANT: this uses the **current** PnW GraphQL shape:
 *   alliances(id: Int!) { bankrecs(limit: Int) { id, tax_id, money, ... } }
 * No paginator, no "ids", no "after_id", no "first/sort/order".
 */
async function fetchRecentBankrecs(apiKey: string, allianceId: number, limit = 400) {
  const query = `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit) {
          id
          tax_id
          note
          date
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
  ` as const;

  const data: any = await pnwQuery(apiKey, query, { id: allianceId, limit });
  const recs: any[] = data?.alliances?.[0]?.bankrecs ?? [];
  return recs;
}

/** Sum resources over selected records and report newest id */
function summarize(recs: any[]): PreviewResult {
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

/**
 * Core preview that accepts an explicit key (used by validation flows).
 * - Grabs recent bankrecs
 * - Client-side filters to id > sinceId
 * - Filters to tax-only by allowedTaxIds (or heuristic: tax_id > 0)
 */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, allowedTaxIds = null } = args;

  const all = await fetchRecentBankrecs(apiKey, allianceId, 400);

  const onlyNew = sinceId ? all.filter((r) => Number(r?.id ?? 0) > Number(sinceId)) : all;

  let taxOnly: any[];
  if (allowedTaxIds && allowedTaxIds.length > 0) {
    const allow = new Set(allowedTaxIds.map(Number).filter(Number.isFinite));
    taxOnly = onlyNew.filter((r) => allow.has(Number(r?.tax_id ?? 0)));
  } else {
    // Heuristic fallback: keep rows that have a tax_id > 0
    taxOnly = onlyNew.filter((r) => Number(r?.tax_id ?? 0) > 0);
  }

  return summarize(taxOnly);
}

/**
 * Stored-key wrapper: loads the alliance's read key and its tax_id allowlist.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const allow = await getAllowedTaxIds(allianceId); // [] means "none saved"
  return previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: sinceId ?? null,
    allowedTaxIds: allow.length ? allow : null,
  });
}

/**
 * Apply: fetch tax records after lastSeenId, compute delta, and (optionally) add to treasury.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);
  const allow = await getAllowedTaxIds(allianceId);

  const preview = await previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: lastSeenId,
    allowedTaxIds: allow.length ? allow : null,
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
