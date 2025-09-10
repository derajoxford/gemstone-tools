// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury, type Treasury as ResourceDelta } from "../../utils/treasury";
import { getPnwCursor, setPnwCursor, appendPnwApplyLog } from "../../utils/pnw_cursor";
import { getAllowedTaxIds } from "../../utils/pnw_tax_ids";

/** ------------ Types ------------ */
export type PreviewArgs = {
  apiKey: string;
  allianceId: number;
  /** Optional: we ignore it in the query to keep schema-compat, but we still compute newestId to advance later */
  sinceId?: number | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

export type ApplyArgsStored = {
  allianceId: number;
  /** Optional lower cursor (exclusive) — we still fetch recent window then filter client-side */
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

/** ------------ Internal helpers ------------ */

/**
 * We deliberately DO NOT use server-side cursors/after to avoid schema differences.
 * Strategy: pull the latest N bankrecs and filter client-side by:
 *  - note contains "Automated Tax" (case-insensitive) or "Tax Deposit"/"Auto Tax"
 *  - optional: tax_id is in the configured allowlist
 *  - optional: id > lastSeen
 */
const RES_FIELDS = [
  "money","food","munitions","gasoline","steel","aluminum",
  "oil","uranium","bauxite","coal","iron","lead",
] as const;

type Bankrec = {
  id?: number;
  note?: string;
  stype?: string;
  rtype?: string;
  tax_id?: number | null;
} & { [K in (typeof RES_FIELDS)[number]]?: number | null };

/** Try A: alliances(id: Int!) -> { bankrecs(limit: Int!) } */
const QUERY_A = `
  query BankrecsA($id: Int!, $limit: Int!) {
    alliances(id: $id) {
      id
      bankrecs(limit: $limit) {
        id
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

/** Try B: alliances(id: [Int]!) -> AlliancePaginator -> data { ... } */
const QUERY_B = `
  query BankrecsB($ids: [Int]!, $limit: Int!) {
    alliances(id: $ids) {
      data {
        id
        bankrecs(limit: $limit) {
          id
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

async function fetchRecentBankrecs(apiKey: string, allianceId: number, limit = 300): Promise<Bankrec[]> {
  // Try schema A
  try {
    const data: any = await pnwQuery(apiKey, QUERY_A, { id: allianceId, limit });
    const recs: any[] = data?.alliances?.[0]?.bankrecs ?? [];
    if (Array.isArray(recs)) return recs;
  } catch (_e) {
    // fall through to B
  }
  // Try schema B
  const dataB: any = await pnwQuery(apiKey, QUERY_B, { ids: [allianceId], limit });
  const recsB: any[] = dataB?.alliances?.[0]?.data?.[0]?.bankrecs ?? [];
  return Array.isArray(recsB) ? recsB : [];
}

function isAutomatedTax(note?: string | null): boolean {
  if (!note) return false;
  const n = String(note).toLowerCase();
  return /automated\s*tax|tax\s*deposit|auto[\s-]*tax/.test(n);
}

function passesDirection(r: Bankrec): boolean {
  // Prefer incoming to alliance if types are present
  const rt = (r.rtype || "").toLowerCase();
  const st = (r.stype || "").toLowerCase();
  if (rt && st) {
    // nation -> alliance is typical for tax
    if (rt === "alliance" && st !== "alliance") return true;
    // fallback: if we don't recognize, let other filters decide
  }
  return true;
}

function withinAllowedIds(r: Bankrec, allow: number[] | null | undefined): boolean {
  if (!allow || allow.length === 0) return true;
  const tid = Number(r.tax_id ?? 0);
  if (!tid) return false;
  return allow.includes(tid);
}

function sumDelta(recs: Bankrec[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};
  for (const r of recs) {
    const id = Number(r.id ?? 0);
    if (id && (!newestId || id > newestId)) newestId = id;

    for (const f of RES_FIELDS) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      // Alliance receives +v on tax deposits — keep sign as-is (PnW uses positive for credits)
      delta[f] = (delta[f] ?? 0) + v;
    }
  }
  return { count: recs.length, newestId, delta };
}

/** ------------ Public API (manual key) ------------ */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const { apiKey, allianceId, sinceId = null } = args;

  const [recs, allow] = await Promise.all([
    fetchRecentBankrecs(apiKey, allianceId, 500),
    getAllowedTaxIds(allianceId).catch(() => [] as number[]), // robust
  ]);

  const out = recs
    // note/keyword match
    .filter((r) => isAutomatedTax(r.note))
    // direction sanity (nation -> alliance)
    .filter(passesDirection)
    // optional allowlist
    .filter((r) => withinAllowedIds(r, allow))
    // cursor (client-side)
    .filter((r) => (sinceId ? Number(r.id ?? 0) > sinceId : true));

  return sumDelta(out);
}

/** ------------ Stored-key wrappers ------------ */
export async function previewAllianceTaxCreditsStored(allianceId: number): Promise<PreviewResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  const last = await getPnwCursor(allianceId); // may be null
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: last });
}

export async function applyAllianceTaxCreditsStored(args: ApplyArgsStored): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId);

  // preview using lastSeenId (if caller passed one), otherwise stored cursor
  const since = lastSeenId ?? (await getPnwCursor(allianceId));
  const preview = await previewAllianceTaxCredits({ apiKey, allianceId, sinceId: since });

  const applied = confirm && preview.count > 0 && Object.keys(preview.delta).length > 0;

  if (applied) {
    await addToTreasury(allianceId, preview.delta, {
      source: "pnw_tax",
      meta: { lastSeenId: since, newestId: preview.newestId },
    });
  }

  // advance cursor if we saw anything new — even in preview mode we can safely update,
  // but to stay conservative: advance only when applied or when count>0
  if (preview.newestId && preview.count > 0) {
    await setPnwCursor(allianceId, preview.newestId);
  }

  // always append a log for visibility
  await appendPnwApplyLog({
    ts: new Date().toISOString(),
    allianceId,
    lastSeenId: since ?? null,
    newestId: preview.newestId ?? null,
    records: preview.count,
    delta: preview.delta,
    applied,
    reason: applied ? "apply" : "preview",
  });

  return {
    allianceId,
    lastSeenId: since ?? null,
    newestId: preview.newestId ?? null,
    records: preview.count,
    delta: preview.delta,
    applied,
    mode: applied ? "apply" : "noop",
  };
}
