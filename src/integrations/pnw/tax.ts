// src/integrations/pnw/tax.ts
import { pnwQuery } from "../pnw/query";
import { getAllianceReadKey } from "../pnw/store";

type Bankrec = {
  id: number | string;
  date?: string;
  sender_type?: number | string;
  sender_id?: number | string;
  receiver_type?: number | string;
  receiver_id?: number | string;
  note?: string | null;

  money?: number | string;
  food?: number | string;
  coal?: number | string;
  oil?: number | string;
  uranium?: number | string;
  lead?: number | string;
  iron?: number | string;
  bauxite?: number | string;
  gasoline?: number | string;
  munitions?: number | string;
  steel?: number | string;
  aluminum?: number | string;
};

export type ResourceDelta = Record<string, number>;

const RES_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isAutomatedTaxToAlliance(r: Bankrec, allianceId: number): boolean {
  const recvType = toInt(r.receiver_type);
  const recvId = toInt(r.receiver_id);
  const note = String(r.note ?? "");
  return recvType === 2 && recvId === allianceId && /Automated Tax/i.test(note);
}

function sumDelta(recs: Bankrec[]) {
  const delta: ResourceDelta = {};
  for (const k of RES_KEYS) delta[k] = 0;

  let newestId: number | null = null;
  for (const r of recs) {
    newestId = Math.max(newestId ?? 0, toInt(r.id));
    for (const k of RES_KEYS) {
      delta[k] += toNum((r as any)[k]);
    }
  }
  return { count: recs.length, newestId: newestId || null, delta };
}

/**
 * Fetch recent bank records for an alliance with a hard limit,
 * then filter to "Automated Tax" incoming to the alliance bank.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit: number
): Promise<{ count: number; newestId: number | null; delta: ResourceDelta }> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }

  // GraphQL: alliances(id: [Int]) -> AlliancePaginator -> data: [Alliance] -> bankrecs(limit: Int)
  const query = `
    query TaxScan($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            sender_type
            sender_id
            receiver_type
            receiver_id
            note
            money
            food
            coal
            oil
            uranium
            lead
            iron
            bauxite
            gasoline
            munitions
            steel
            aluminum
          }
        }
      }
    }
  ` as const;

  const apiKey = await getAllianceReadKey(allianceId);
  if (!apiKey) {
    throw new Error(
      "No valid stored PnW user API key for this alliance. Run /pnw_set again (and ensure GT_SECRET/ENCRYPTION_KEY matches the one used when saving)."
    );
  }

  const vars = { ids: [allianceId], limit: Math.trunc(limit) };
  const data: any = await pnwQuery(apiKey, query, vars);

  const rows: Bankrec[] = data?.alliances?.data?.[0]?.bankrecs ?? [];
  // Filter to automated tax into alliance & respect cursor client-side
  const minId = toInt(lastSeenId ?? 0);
  const filtered = rows
    .filter((r) => toInt(r.id) > minId)
    .filter((r) => isAutomatedTaxToAlliance(r, allianceId))
    // keep order oldest→newest for stable newestId computation
    .sort((a, b) => toInt(a.id) - toInt(b.id));

  return sumDelta(filtered);
}

// Back-compat export (some older command modules still import this name)
export const previewAllianceTaxCredits = previewAllianceTaxCreditsStored;
