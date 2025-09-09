// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { addToTreasury } from "../../utils/treasury";

/** --- TYPES --- */
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

/** --- HELPERS --- */
async function fetchBankrecsSince(apiKey: string, allianceId: number, sinceId?: number | null) {
  // NOTE: alliances returns an AlliancePaginator; read from `.data`
  const query = `
    query AllianceBankrecs($ids: [Int], $after: Int, $limit: Int) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(after: $after, limit: $limit) {
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
            date
          }
        }
      }
    }
  ` as const;

  const variables = {
    ids: [Number(allianceId)],
    after: sinceId ?? null,
    limit: 100,
  };

  const data: any = await pnwQuery<any>(apiKey, query, variables);

  // alliances is a paginator -> { data: [Alliance, ...] }
  const list = Array.isArray(data?.alliances?.data) ? data.alliances.data : [];
  const alliance = list[0];
  const recs: any[] = Array.isArray(alliance?.bankrecs) ? alliance.bankrecs : [];

  // Filter to tax-related credits. Adjust if your API exposes a dedicated discriminator.
  const taxy = recs.filter((r: any) => {
    const t = (r?.type ?? "").toString().toLowerCase();
    const note = (r?.note ?? "").toString();
    return t.includes("tax") || /\btax\b/i.test(note);
  });

  return taxy;
}

function sumDelta(recs: any[]): PreviewResult {
  let newestId: number | null = null;
  const delta: ResourceDelta = {};

  for (const r of recs) {
    const rid = Number(r?.id ?? 0);
    if (Number.isFinite(rid) && (newestId === null || rid > newestId)) {
      newestId = rid;
    }

    const fields = [
      "money", "food", "munitions", "gasoline", "steel", "aluminum",
      "oil", "uranium", "bauxite", "coal", "iron", "lead",
    ] as const;

    for (const f of fields) {
      const v = Number(r?.[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }

  return { count: recs.length, newestId, delta };
}

/** --- PUBLIC (manual-key) --- */
export async function previewAllianceTaxCredits(args: PreviewArgs): Promise<PreviewResult> {
  const recs = await fetchBankrecsSince(args.apiKey, args.allianceId, args.sinceId ?? null);
  return sumDelta(recs);
}

/** --- PUBLIC (stored-key wrappers) --- */
export async function previewAllianceTaxCreditsStored(allianceId: number, sinceId?: number | null) {
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable
  return previewAllianceTaxCredits({ apiKey, allianceId, sinceId: sinceId ?? null });
}

/** Apply previewed delta to treasury (optionally) and return summary */
export async function applyAllianceTaxCreditsStored(
  args: ApplyArgsStored
): Promise<ApplyResult> {
  const { allianceId, lastSeenId = null, confirm = true } = args;
  const apiKey = await getAllianceReadKey(allianceId); // throws if missing/undecryptable

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
