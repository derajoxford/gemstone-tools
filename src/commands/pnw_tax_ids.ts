// src/integrations/pnw/tax.ts

import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

/** --- TYPES --- */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive): only records with id > sinceId are counted */
  sinceId?: number | null;
  /** Optional hard cap on bankrecs pulled (we filter by id client-side) */
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

/** --- INTERNAL HELPERS --- */

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
  stype?: string | null;
  rtype?: string | null;
  note?: string | null;
  date?: string | null;
} & Partial<Record<(typeof RESOURCE_FIELDS)[number], number>>;

function isTaxRec(r: Bankrec, allowedIds: number[]): boolean {
  const tid = Number(r?.tax_id ?? 0);
  if (allowedIds.length > 0) return allowedIds.includes(tid);
  // Fallback heuristic when no filter saved (very conservative):
  // require a tax_id and "nation -> alliance" style credit.
  const s = (r.stype || "").toLowerCase();
  const t = (r.rtype || "").toLowerCase();
  return !!tid && (s === "nation" && t === "alliance");
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

async function fetchBankrecs(
  apiKey: string,
  allianceId: number,
  limit = 500,
): Promise<Bankrec[]> {
  // IMPORTANT: alliances(id: [Int!]) returns a paginator => use .data { ... }
  const query = /* GraphQL */ `
    query FetchBankrecs($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            tax_id
            stype
            rtype
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
    }
  `;
  const data: any = await pnwQuery(apiKey, query, { ids: [allianceId], limit });
  const recs: Bankrec[] = data?.alliances?.data?.[0]?.bankrecs ?? [];
  return Array.isArray(recs) ? recs : [];
}

/** --- PUBLIC API (manual key) --- */
/** Needed by /pnw_preview (imports this symbol). */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, limit = 500 } = args;
  const allowed = await getAllowedTaxIds(allianceId);
  const all = await fetchBankrecs(apiKey, allianceId, limit);
  const filtered = all.filter(
    (r) => (sinceId == null || r.id > (sinceId as number)) && isTaxRec(r, allowed),
  );
  return sumDelta(filtered);
}

/** --- PUBLIC API (stored key wrappers) --- */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
  limit = 500,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecipherable
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null, limit });
}

export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const preview = await previewAllianceTaxCreditsStored(allianceId, lastSeenId);
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
