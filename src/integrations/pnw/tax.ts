// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";
import { addToTreasury } from "../../utils/treasury";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  sinceId?: number | null;
  allowedTaxIds?: number[] | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  lastSeenId?: number | null;
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

// current schema: alliances(id: Int!) -> Alliance -> bankrecs(limit: Int)
const QUERY_ALLIANCE_BANKRECS = `
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

/** Pull recent bankrecs; filter client-side by sinceId and allowed tax_id list. */
export async function fetchTaxRecs(
  apiKey: string,
  allianceId: number,
  sinceId: number | null,
  allowedTaxIds: number[] | null,
  limit = 400
) {
  const data: any = await pnwQuery(apiKey, QUERY_ALLIANCE_BANKRECS, { id: allianceId, limit });
  const all: any[] = data?.alliances?.[0]?.bankrecs ?? [];

  const onlyNew = sinceId ? all.filter(r => Number(r?.id ?? 0) > Number(sinceId)) : all;

  if (allowedTaxIds && allowedTaxIds.length) {
    const allow = new Set(allowedTaxIds.map(Number).filter(Number.isFinite));
    return onlyNew.filter(r => allow.has(Number(r?.tax_id ?? 0)));
  }
  // fallback heuristic: treat records with a positive tax_id as tax credits
  return onlyNew.filter(r => Number(r?.tax_id ?? 0) > 0);
}

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

export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, allowedTaxIds = null } = args;
  const recs = await fetchTaxRecs(apiKey, allianceId, sinceId, allowedTaxIds, 400);
  return summarize(recs);
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const allow = await getAllowedTaxIds(allianceId);
  return previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: sinceId ?? null,
    allowedTaxIds: allow.length ? allow : null,
  });
}

export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored
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
