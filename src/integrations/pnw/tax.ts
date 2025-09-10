// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { appendPnwApplyLog } from "../../utils/pnw_cursor";

/** ---------- Types ---------- */
export type ResourceDelta = Record<string, number>;

export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional lower cursor (exclusive) — only rows with id > sinceId are counted */
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

/** ---------- Internals ---------- */

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

type Bankrec = {
  id: number;
  note?: string | null;
} & { [K in (typeof RES_FIELDS)[number]]?: number | null } & {
  date?: string | null; // schema uses 'date'
};

function isAutomatedTax(note?: string | null) {
  return note ? /\bautomated\s*tax\b/i.test(note) : false;
}

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};
  for (const r of recs) {
    if (typeof r.id === "number" && (newestId === null || r.id > newestId)) newestId = r.id;
    for (const f of RES_FIELDS) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }
  return { count: recs.length, newestId, delta };
}

async function fetchAutomatedTaxRecs(
  apiKey: string,
  allianceId: number,
  sinceId?: number | null,
): Promise<Bankrec[]> {
  // Schema-safe: alliances(id:[Int]) -> data -> bankrecs(limit: Int)
  const query = /* GraphQL */ `
    query AllianceBankrecs($ids: [Int]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            note
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
            date
          }
        }
      }
    }
  ` as const;

  // Pull a recent window; we filter locally
  const vars = { ids: [allianceId], limit: 500 };
  const data: any = await pnwQuery(apiKey, query, vars);

  const recs: Bankrec[] =
    data?.alliances?.[0]?.data?.[0]?.bankrecs?.filter((r: any) => r && typeof r.id === "number") ??
    [];

  const after = typeof sinceId === "number" ? recs.filter((r) => r.id > sinceId) : recs;
  return after.filter((r) => isAutomatedTax(r.note));
}

/** ---------- Public API (manual-key) ---------- */
/** Used by /pnw_preview and /pnw_set to validate a key. */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const recs = await fetchAutomatedTaxRecs(args.apiKey, args.allianceId, args.sinceId ?? null);
  return sumDelta(recs);
}

/** ---------- Public API (stored-key wrappers) ---------- */

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  sinceId?: number | null,
): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null });
}

/**
 * Apply: fetch tax records after lastSeenId, compute delta, optionally add to treasury,
 * and ALWAYS append a log entry so hourly checks are recorded even with no deltas.
 */
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
      meta: { lastSeenId, newestId: preview.newestId, mode: "automated_tax" },
    });
  }

  // Log every run (applied or noop)
  try {
    await appendPnwApplyLog({
      ts: new Date().toISOString(),
      allianceId,
      lastSeenId,
      newestId: preview.newestId,
      records: preview.count,
      delta: preview.delta,
      applied,
      reason: "automated_tax",
    } as any);
  } catch (e) {
    // Non-fatal: keep execution flowing
    console.error("[tax.apply] failed to append log:", e);
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
