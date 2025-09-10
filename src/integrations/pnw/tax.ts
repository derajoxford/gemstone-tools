// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

/** ---------- Types ---------- */
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
  tax_id?: number | null;
  stype?: string | null;
  rtype?: string | null;
} & { [K in (typeof RES_FIELDS)[number]]?: number | null } & {
  date?: string | null; // schema uses 'date' (not created_at)
};

function isAutomatedTaxNote(s: string | null | undefined): boolean {
  if (!s) return false;
  // Be strict to avoid false positives: match the literal phrase "Automated Tax"
  return /\bautomated\s*tax\b/i.test(s);
}

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    if (typeof r.id === "number") {
      if (newestId === null || r.id > newestId) newestId = r.id;
    }
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
  // Keep the query minimal and schema-safe: only 'limit' as an arg, no after/sort.
  const query = /* GraphQL */ `
    query AllianceBankrecs($ids: [Int]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            note
            tax_id
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
            date
          }
        }
      }
    }
  ` as const;

  // Grab a decent window; we’ll locally filter by sinceId & note text.
  const vars = { ids: [allianceId], limit: 500 };
  const data: any = await pnwQuery(apiKey, query, vars);

  const recs: Bankrec[] =
    data?.alliances?.[0]?.data?.[0]?.bankrecs?.filter((r: any) => r && typeof r.id === "number") ??
    [];

  // Local filtering:
  // 1) cursor
  const afterFiltered = typeof sinceId === "number" ? recs.filter((r) => r.id > sinceId) : recs;

  // 2) tax filter:
  //    - Always include notes containing "Automated Tax"
  //    - If you have stored allowed tax_id values, UNION them in (never exclude automated notes)
  const allowedIds = new Set<number>((await getAllowedTaxIds(allianceId)) ?? []);
  const out = afterFiltered.filter((r) => {
    const byNote = isAutomatedTaxNote(r.note);
    const byId =
      allowedIds.size > 0 && typeof r.tax_id === "number" && allowedIds.has(Number(r.tax_id));
    return byNote || byId;
  });

  return out;
}

/** ---------- Public API (manual-key) ---------- */
/** Used by /pnw_preview to test an arbitrary API key. */
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
 * Apply: fetch tax records after lastSeenId, compute delta, and (optionally) add to treasury.
 * Returns what it did, plus newestId so callers can advance a cursor.
 */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored,
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable

  const preview = await previewAllianceTaxCredits({
    apiKey,
    allianceId,
    sinceId: lastSeenId,
  });

  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId, newestId: preview.newestId, mode: "automated_tax" },
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
