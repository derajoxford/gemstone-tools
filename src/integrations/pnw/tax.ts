// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

// ----- Types -----
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  sinceId?: number | null; // exclusive
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  lastSeenId?: number | null; // exclusive
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

// ----- Internal helpers -----
type Bankrec = {
  id: number;
  note?: string | null;
  stype?: string | null; // sender type
  rtype?: string | null; // receiver type
  tax_id?: number | null;
  money?: number; food?: number; munitions?: number; gasoline?: number; steel?: number; aluminum?: number;
  oil?: number; uranium?: number; bauxite?: number; coal?: number; iron?: number; lead?: number;
  date?: string;
};

function isTaxCredit(r: Bankrec): boolean {
  if (r.tax_id == null) return false;
  const recvAlliance = (r.rtype ?? "").toLowerCase() === "alliance";
  const sendNation   = (r.stype ?? "").toLowerCase() === "nation";
  return recvAlliance && sendNation;
}

async function fetchBankrecsSince(
  apiKey: string,
  allianceId: number,
  sinceId?: number | null
) {
  const query = `
    query AllianceBankrecs($ids: [Int], $limit: Int) {
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
  ` as const;

  const data = await pnwQuery<any>(apiKey, query, { ids: [allianceId], limit: 250 });
  const all: Bankrec[] = data?.alliances?.data?.[0]?.bankrecs ?? [];

  // newest first
  all.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  // cursor (exclusive)
  const afterCursor = sinceId != null ? all.filter(r => (r.id ?? 0) > Number(sinceId)) : all;

  // tax rows only
  const taxOnly = afterCursor.filter(isTaxCredit);

  // apply optional allowlist of tax IDs (multi-tier support)
  const allow = await getAllowedTaxIds(allianceId);
  if (allow.length === 0) return taxOnly;

  const allowSet = new Set(allow.map(Number));
  return taxOnly.filter(r => r.tax_id != null && allowSet.has(Number(r.tax_id)));
}

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};
  const fields = [
    "money","food","munitions","gasoline","steel","aluminum",
    "oil","uranium","bauxite","coal","iron","lead",
  ] as const;

  for (const r of recs) {
    const rid = Number(r.id ?? 0);
    if (Number.isFinite(rid) && (newestId === null || rid > newestId)) newestId = rid;
    for (const f of fields) {
      const v = Number((r as any)[f] ?? 0);
      if (v > 0) delta[f] = (delta[f] ?? 0) + v; // credits only
    }
  }

  return { count: recs.length, newestId, delta };
}

// ----- Public API (manual key) -----
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const recs = await fetchBankrecsSince(args.apiKey, args.allianceId, args.sinceId ?? null);
  return sumDelta(recs);
}

// ----- Public API (stored key wrappers) -----
export async function previewAllianceTaxCreditsStored(allianceId: number, sinceId?: number | null) {
  const apiKey = await getAllianceReadKey(allianceId);
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null });
}

export async function applyAllianceTaxCreditsStored(args: ApplyArgsStored): Promise<ApplyResult> {
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
