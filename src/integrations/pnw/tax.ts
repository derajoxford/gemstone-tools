// src/integrations/pnw/tax.ts
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { pnwQuery } from "./query";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  sinceId?: number | null; // only count bankrecs with id > sinceId
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  lastSeenId?: number | null; // exclusive lower bound
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

const RESOURCE_FIELDS = [
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

type Bankrec = {
  id: number;
  tax_id?: number | null;
} & { [K in (typeof RESOURCE_FIELDS)[number]]?: number | null };

async function fetchLatestBankrecs(
  apiKey: string,
  allianceId: number,
  limit = 250,
): Promise<Bankrec[]> {
  // Use alliances(ids:[Int]) paginator → data[0].bankrecs
  const query = `
    query AllianceBankrecs($ids: [Int!], $limit: Int!) {
      alliances(ids: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
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

  const data: any = await pnwQuery(apiKey, query, { ids: [allianceId], limit });
  return (data?.alliances?.data?.[0]?.bankrecs ?? []) as Bankrec[];
}

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    if (typeof r.id === "number") {
      if (newestId === null || r.id > newestId) newestId = r.id;
    }
    for (const f of RESOURCE_FIELDS) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

/** Manual-key preview */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null } = args;

  // Pull a recent window, then filter + aggregate locally to avoid schema drift on args like after/or_id
  const recs = await fetchLatestBankrecs(apiKey, allianceId, 250);

  // Only tax records: if a whitelist is configured, honor it; otherwise require tax_id > 0
  const allowed = await getAllowedTaxIds(allianceId);
  const filtered = recs.filter((r) => {
    if (sinceId && r.id <= sinceId) return false;
    const tid = Number(r.tax_id ?? 0);
    if (!tid) return false;
    return allowed.length ? allowed.includes(tid) : tid > 0;
  });

  return sumDelta(filtered);
}

/** Stored-key wrapper: preview */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
) {
  const apiKey = await getAllianceReadKey(allianceId);
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null });
}

/** Stored-key wrapper: apply */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);

  const preview = await previewAllianceTaxCredits({ apiKey, allianceId, sinceId: lastSeenId });
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
