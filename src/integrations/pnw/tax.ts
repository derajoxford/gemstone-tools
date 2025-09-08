// src/integrations/pnw/tax.ts
//
// Tax import helpers.
// - Identify PnW tax bank records via bankrec.tax_id != null
// - Summarize positives into a resource delta
// - Offer a preview (no side effects) and an apply() that uses creditTaxRevenue()

import { fetchAllianceBankrecs, PnwBankrec } from "./client";
import { creditTaxRevenue, previewDelta, formatPreviewLines, DeltaMap } from "../../utils/treasury_delta";

export type TaxPreview = {
  newestId: number | null;
  count: number;
  delta: DeltaMap;
  previewLines: string[];
  warnings: string[];
};

const RESOURCE_KEYS: (keyof Pick<
  PnwBankrec,
  | "money"
  | "food"
  | "munitions"
  | "gasoline"
  | "aluminum"
  | "steel"
  | "coal"
  | "oil"
  | "uranium"
  | "iron"
  | "bauxite"
  | "lead"
>)[] = [
  "money",
  "food",
  "munitions",
  "gasoline",
  "aluminum",
  "steel",
  "coal",
  "oil",
  "uranium",
  "iron",
  "bauxite",
  "lead",
];

/** Sum all positive resources from bankrecs that are tax-based and > minId (if provided). */
export function summarizeTaxDelta(bankrecs: PnwBankrec[], minId?: number): { newestId: number | null; delta: DeltaMap; picked: PnwBankrec[] } {
  const picked = bankrecs.filter((br) => br.tax_id != null && (minId == null || br.id > minId));
  const delta: DeltaMap = {};
  let newestId: number | null = null;

  for (const br of picked) {
    newestId = br.id; // bankrecs already sorted asc by id in client
    for (const key of RESOURCE_KEYS) {
      const v = br[key] ?? 0;
      if (v > 0) {
        delta[key] = (delta[key] ?? 0) + v;
      }
    }
  }
  return { newestId, delta, picked };
}

/**
 * Preview-only: builds a normalized delta from tax bankrecs > lastSeenId.
 * No writes. Use this in a command to show admins what's about to be credited.
 */
export async function previewAllianceTaxCredits(params: {
  apiKey: string;
  allianceId: number;
  lastSeenId?: number;
}): Promise<TaxPreview> {
  const items = await fetchAllianceBankrecs(params.apiKey, params.allianceId);
  const { newestId, delta, picked } = summarizeTaxDelta(items, params.lastSeenId);

  const v = previewDelta(delta, "credit");
  const previewLines = formatPreviewLines(v, { mode: "credit" });
  return {
    newestId: newestId ?? null,
    count: picked.length,
    delta: v.clean,
    previewLines,
    warnings: v.warnings,
  };
}

/**
 * Apply: credits the Alliance Treasury with the summed tax delta.
 * In later steps we’ll persist a cursor & audit log; for now this is a pure apply.
 */
export async function applyAllianceTaxCredits(params: {
  apiKey: string;
  allianceId: number;
  lastSeenId?: number;
  meta?: { source?: "income_tax" | "trade_tax" | "other_tax"; note?: string; actorDiscordId?: string; actorMemberId?: number };
}): Promise<{ applied: DeltaMap; newestId: number | null; warnings: string[] }> {
  const items = await fetchAllianceBankrecs(params.apiKey, params.allianceId);
  const { newestId, delta } = summarizeTaxDelta(items, params.lastSeenId);

  const { applied, warnings } = await creditTaxRevenue(params.allianceId, delta, {
    source: params.meta?.source ?? "income_tax",
    note: params.meta?.note,
    actorDiscordId: params.meta?.actorDiscordId,
    actorMemberId: params.meta?.actorMemberId,
  });

  return { applied, newestId, warnings };
}
