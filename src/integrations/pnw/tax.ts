// src/integrations/pnw/tax.ts
import { pnwQuery } from "./client"; // whatever your client export is called
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { computeTreasuryDelta } from "../../utils/treasury_delta";

/**
 * --- TYPES ---
 */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive): only records with id > sinceId are considered */
  sinceId?: number | null;
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

/**
 * --- HELPERS ---
 * We query recent bank records and filter to "tax-related" rows.
 * Keep these simple so we can reuse for preview/apply.
 */
async function fetchBankrecsSince(apiKey: string, allianceId: number, sinceId?: number | null) {
  // Minimal GraphQL; adjust fields to match your schema.
  // We pull newest-first and page a bit; callers will sum/filter.
  const query = `
    query AllianceBankrecs($id: Int!, $after: Int) {
      alliances(id: $id) {
        id
        bankrecs(after_id: $after, sort: "id", order: "DESC", first: 100) {
          id
          note
          type
          sender_type
          receiver_type
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
          created_at
        }
      }
    }
  ` as const;

  const vars: any = { id: allianceId, after: sinceId ?? null };
  const data: any = await pnwQuery(apiKey, query, vars);

  const list =
    data?.alliances?.[0]?.bankrecs?.filter((r: any) =>
      // Heuristic: all automatic *tax* deposits that credit the alliance
      // Tune this condition if your API exposes a dedicated "TAX" type.
      (r?.type?.toLowerCase?.() ?? "").includes("tax") ||
      /\btax\b/i.test(r?.note ?? "")
    ) ?? [];

  return list;
}

function sumDelta(recs: any[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    if (typeof r.id === "number") {
      if (newestId === null || r.id > newestId) newestId = r.id;
    }
    // Positive amounts represent credit to alliance
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

/**
 * --- PUBLIC API (manual-key) ---
 * Used by /pnw_set to validate a user-entered key BEFORE we store it.
 */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const recs = await fetchBankrecsSince(args.apiKey, args.allianceId, args.sinceId ?? null);
  return sumDelta(recs);
}

/**
 * --- PUBLIC API (stored-key wrappers) ---
 * These NEVER use env fallbacks; they require the per-alliance stored key.
 */

export async function previewAllianceTaxCreditsStored(allianceId: number, sinceId?: number | null) {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null });
}

/**
 * Apply: fetch tax records after lastSeenId, compute delta, and (optionally) add to treasury.
 * Returns what it did, plus newestId so callers can advance a cursor.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable

  const preview = await previewAllianceTaxCredits({ apiKey, allianceId, sinceId: lastSeenId });
  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    // Reuse your existing treasury utility (creates/updates AllianceTreasury JSON balances).
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
