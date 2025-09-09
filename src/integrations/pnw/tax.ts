// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";            // use the wrapper, NOT ./client
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  sinceId?: number | null;
  allowedTaxIds?: number[];  // optional explicit filter
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

function pickAllianceNode(node: any): any | null {
  if (!node) return null;
  if (Array.isArray(node)) return node[0] ?? null;
  return node;
}

// Pull newest-first (orderBy desc); we’ll do sinceId filtering client-side.
async function fetchBankrecsChunk(
  apiKey: string,
  allianceId: number,
  limit = 500
): Promise<any[]> {
  const query = `
    query AllianceBankrecs($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit, orderBy: "id desc") {
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
  ` as const;

  const data: any = await pnwQuery(apiKey, query, { id: allianceId, limit });
  const alliancesNode = pickAllianceNode(data?.alliances);
  const recs: any[] = alliancesNode?.bankrecs ?? [];
  return recs;
}

function sumDelta(recs: any[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    const idNum = Number(r?.id ?? 0);
    if (idNum && (newestId === null || idNum > newestId)) newestId = idNum;

    const resFields = [
      "money","food","munitions","gasoline","steel","aluminum",
      "oil","uranium","bauxite","coal","iron","lead",
    ] as const;

    for (const f of resFields) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, allowedTaxIds } = args;

  const recs = await fetchBankrecsChunk(apiKey, allianceId, 500);

  // Only credit-to-alliance rows & only tax records.
  const filtered = recs.filter((r) => {
    const tid = Number(r?.tax_id ?? 0);
    const creditToAlliance =
      (r?.rtype?.toLowerCase?.() === "alliance") || (r?.receiver_type?.toLowerCase?.() === "alliance");
    const isTax =
      (allowedTaxIds && allowedTaxIds.length > 0) ? allowedTaxIds.includes(tid) : tid > 0;

    const idOk = sinceId ? Number(r?.id ?? 0) > Number(sinceId) : true;
    return creditToAlliance && isTax && idOk;
  });

  return sumDelta(filtered);
}

// ---- Stored-key wrappers ----

export async function previewAllianceTaxCreditsStored(allianceId: number, sinceId?: number | null) {
  const apiKey = await getAllianceReadKey(allianceId);
  const allowed = await getAllowedTaxIds(allianceId); // may be empty
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null, allowedTaxIds: allowed });
}

export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);
  const allowed = await getAllowedTaxIds(allianceId);

  const preview = await previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: lastSeenId,
    allowedTaxIds: allowed,
  });

  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId, newestId: preview.newestId, allowedTaxIds: allowed },
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
