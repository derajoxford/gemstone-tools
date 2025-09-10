// src/integrations/pnw/tax.ts
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { fetchAllianceBankrecs } from "./query";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive): only include rows with id > sinceId */
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

async function fetchTaxRecs(
  apiKey: string,
  allianceId: number,
  sinceId?: number | null,
  lookback = 250
) {
  const all = await fetchAllianceBankrecs(apiKey, allianceId, lookback);

  // Optional id filter (we don't do it in GraphQL because schemas vary)
  const after = typeof sinceId === "number" && sinceId > 0 ? sinceId : null;
  let rows = all.filter((r: any) => (after ? Number(r?.id ?? 0) > after : true));

  // tax_id filter: if user saved allowed tax IDs, only include those
  const allow = await getAllowedTaxIds(allianceId);
  if (allow.length) {
    const set = new Set(allow.map(Number));
    rows = rows.filter((r: any) => set.has(Number(r?.tax_id ?? 0)));
  } else {
    // No explicit filter configured — be conservative and keep only rows that look like tax deposits.
    rows = rows.filter((r: any) => {
      const note: string = String(r?.note ?? "");
      return /\btax\b/i.test(note);
    });
  }

  return rows;
}

/** Validate a user-entered key before saving, or preview with a raw key. */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const recs = await fetchTaxRecs(args.apiKey, args.allianceId, args.sinceId ?? null);
  return sumDelta(recs);
}

/** Stored-key wrapper. */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const recs = await fetchTaxRecs(apiKey, allianceId, sinceId ?? null);
  return sumDelta(recs);
}

/** Apply into your treasury JSON using the stored key. */
export async function applyAllianceTaxCreditsStored(args: ApplyArgsStored): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);
  const recs = await fetchTaxRecs(apiKey, allianceId, lastSeenId);
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
