// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

export type ResourceDelta = Record<string, number>;

export type PreviewArgsStored = {
  allianceId: number;
  /** optional lower cursor (exclusive) — we still fetch a window and filter in code */
  lastSeenId?: number | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = PreviewArgsStored & {
  /** if false, just preview and do not add to treasury */
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

type Bankrec = {
  id: number;
  date?: string;
  note?: string | null;
  stype?: string | null;
  rtype?: string | null;
  tax_id?: number | null;
  // resources
  money?: number;
  food?: number;
  munitions?: number;
  gasoline?: number;
  steel?: number;
  aluminum?: number;
  oil?: number;
  uranium?: number;
  bauxite?: number;
  coal?: number;
  iron?: number;
  lead?: number;
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

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    if (typeof r.id === "number") {
      if (newestId === null || r.id > newestId) newestId = r.id;
    }
    for (const f of RES_FIELDS) {
      const v = Number((r as any)[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

function isTaxCredit(rec: Bankrec, allowedTaxIds: number[]): boolean {
  // If user explicitly configured allowed tax IDs, we ONLY count rows whose tax_id matches.
  if (allowedTaxIds.length > 0) {
    return !!rec.tax_id && allowedTaxIds.includes(Number(rec.tax_id));
  }

  // Fallback heuristic (only used if no filter configured):
  const n = (rec.note ?? "").toLowerCase();
  return /\btax\b/.test(n) || /\btaxes\b/.test(n);
}

async function fetchAllianceBankrecsLatestN(
  apiKey: string,
  allianceId: number,
  limit = 500,
): Promise<Bankrec[]> {
  const query = /* GraphQL */ `
    query AllianceBankLatest($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            stype
            rtype
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
  `;

  const vars = { ids: [allianceId], limit };
  const data: any = await pnwQuery(apiKey, query, vars);
  return (data?.alliances?.data?.[0]?.bankrecs as Bankrec[]) ?? [];
}

/**
 * Preview using STORED key + STORED tax_id filter (if any).
 * We fetch latest N and filter by lastSeenId in code.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId?: number | null,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const allowedIds = await getAllowedTaxIds(allianceId);
  const recs = await fetchAllianceBankrecsLatestN(apiKey, allianceId, 500);

  const filtered = recs
    .filter((r) => (lastSeenId ? r.id > lastSeenId : true))
    .filter((r) => isTaxCredit(r, allowedIds));

  return sumDelta(filtered);
}

/**
 * Apply: preview + optionally write into treasury.
 */
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
