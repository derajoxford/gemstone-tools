// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
// Optional allow-list support if you later want bracket IDs again.
// (Safe to keep; if no ids stored, it has no effect)
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

/** --- TYPES --- */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive): only records with id > sinceId are considered */
  sinceId?: number | null;
  /** How many newest bankrecs to fetch (we filter locally by sinceId). */
  limit?: number;
};

export type PreviewResult = {
  /** Count of matched (tax) records after filtering */
  count: number;
  /** Highest bankrec id seen among ALL fetched recs (use this to advance the cursor) */
  newestId: number | null;
  /** Sum of resources for matched (tax) records */
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  /** Optional lower cursor (exclusive) */
  lastSeenId?: number | null;
  /** If false, just preview and do not add to treasury */
  confirm?: boolean;
  /** Fetch window size */
  limit?: number;
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

/** --- CONSTANTS --- */
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

const DEFAULT_FETCH_LIMIT = 500;

/** --- HELPERS --- */

function toInt(x: unknown): number | null {
  const n = Number(x);
  return Number.isInteger(n) ? n : null;
}

function isAutomatedTax(note: unknown): boolean {
  return /automated\s*tax/i.test(String(note ?? ""));
}

/**
 * We fetch newest-N bankrecs and filter in JS:
 *  - id > sinceId (if provided)
 *  - receiver type is the alliance (rtype === "alliance")
 *  - note contains "Automated Tax"
 *  - (optional) tax_id in allow-list, if one is stored for the alliance
 */
async function fetchTaxRecs(
  apiKey: string,
  allianceId: number,
  sinceId: number | null,
  limit: number,
): Promise<{ all: any[]; matched: any[]; newestId: number | null }> {
  const query = /* GraphQL */ `
    query AllianceBankrecs($ids: [Int], $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
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
            tax_id
          }
        }
      }
    }
  `;

  const vars: any = { ids: [allianceId], limit };
  const data: any = await pnwQuery(apiKey, query, vars);

  // Cope with either alliances->data[] or (rare) alliances[]
  const alliances = Array.isArray(data?.alliances?.data)
    ? data.alliances.data
    : Array.isArray(data?.alliances)
    ? data.alliances
    : [];

  const recs: any[] = alliances?.[0]?.bankrecs ?? [];

  // Highest id among ALL fetched recs (so we can advance cursor even if zero matched)
  let newestId: number | null = null;
  for (const r of recs) {
    const id = toInt(r?.id);
    if (id !== null && (newestId === null || id > newestId)) newestId = id;
  }

  // Local id-cutoff (sinceId is exclusive)
  const afterCut = recs.filter((r) => {
    const id = toInt(r?.id);
    return id !== null && (sinceId === null || sinceId === undefined || id > sinceId);
  });

  // Optional allow-list of tax_id; if empty, it is ignored
  const allowList: number[] = await getAllowedTaxIds(allianceId);
  const hasAllow = Array.isArray(allowList) && allowList.length > 0;

  const matched = afterCut.filter((r) => {
    // Must be incoming to alliance
    const rtype = String(r?.rtype ?? "").toLowerCase();
    if (rtype !== "alliance") return false;

    // Must look like an automated tax row
    if (!isAutomatedTax(r?.note)) return false;

    // If an allow-list exists, the row must have a tax_id and be in the list
    if (hasAllow) {
      const tid = toInt(r?.tax_id);
      if (tid === null || !allowList.includes(tid)) return false;
    }

    return true;
  });

  return { all: recs, matched, newestId };
}

function sumDelta(recs: any[]): PreviewResult {
  const delta: ResourceDelta = {};
  let newestId: number | null = null;

  for (const r of recs) {
    const id = toInt(r?.id);
    if (id !== null && (newestId === null || id > newestId)) newestId = id;

    for (const f of RES_FIELDS) {
      const v = Number(r?.[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

/** --- PUBLIC API (manual-key) --- */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null, limit = DEFAULT_FETCH_LIMIT } = args;

  const { matched, newestId: newestSeen } = await fetchTaxRecs(
    apiKey,
    allianceId,
    sinceId,
    limit,
  );

  const preview = sumDelta(matched);
  // Advance cursor to newestSeen among ALL fetched, even if zero matched
  return { count: preview.count, newestId: newestSeen ?? preview.newestId, delta: preview.delta };
}

/** --- PUBLIC API (stored-key wrappers) --- */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
  limit: number = DEFAULT_FETCH_LIMIT,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null, limit });
}

/**
 * Apply: fetch tax records after lastSeenId, compute delta, and (optionally) add to treasury.
 * Returns what it did, plus newestId so callers can advance a cursor.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true, limit = DEFAULT_FETCH_LIMIT } = args;
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable

  const preview = await previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: lastSeenId,
    limit,
  });

  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId, newestId: preview.newestId, kind: "automated_tax" },
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
