// src/integrations/pnw/tax.ts
import { pnwQuery } from "./query";
import { getAllianceReadKey } from "./store";
import { getPnwCursor } from "../../utils/pnw_cursor";

/**
 * Minimal shape we need from PnW bankrecs to detect automated tax deposits.
 */
type Bankrec = {
  id: number | string;
  date: string;
  note?: string | null;
  sender_type?: number | string | null;
  receiver_type?: number | string | null;
  sender_id?: number | string | null;
  receiver_id?: number | string | null;

  money?: number | string | null;
  food?: number | string | null;
  coal?: number | string | null;
  oil?: number | string | null;
  uranium?: number | string | null;
  lead?: number | string | null;
  iron?: number | string | null;
  bauxite?: number | string | null;
  gasoline?: number | string | null;
  munitions?: number | string | null;
  steel?: number | string | null;
  aluminum?: number | string | null;
};

const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum",
] as const;

const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

export type PreviewTaxResult = {
  allianceId: number;
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
};

/**
 * Fetch recent bankrecs for an alliance and filter to “Automated Tax …” records
 * that are incoming to the alliance (nation -> alliance). We also honor the stored cursor.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lookbackLimit = 500
): Promise<PreviewTaxResult> {
  const apiKey = await getAllianceReadKey(allianceId);
  if (!apiKey) throw new Error("No stored PnW API key for this alliance.");

  const lastSeen = await getPnwCursor(allianceId); // number | 0
  const q = `
    query Bankrecs($ids: [Int]!, $limit: Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            sender_type
            receiver_type
            sender_id
            receiver_id
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

  const data: any = await pnwQuery(apiKey, q, { ids: [allianceId], limit: lookbackLimit });

  // Cope with either alliances -> data -> [Alliance] or older shapes
  const alliancesArr: any[] =
    data?.alliances?.data ??
    data?.alliances ??
    [];

  const al = alliancesArr[0];
  const recs: Bankrec[] = Array.isArray(al?.bankrecs) ? al.bankrecs : [];

  // Filter to:
  //  - Automated Tax notes (prefix match, case-insensitive)
  //  - incoming to alliance (receiver_type == 2) to be safe
  //  - strictly greater than stored cursor id
  const taxRecs = recs.filter((r) => {
    const note = String(r?.note || "");
    const isTax = /^Automated Tax\b/i.test(note);
    const isIncomingToAlliance = toInt(r?.receiver_type) === 2;
    const idOk = toInt(r?.id) > (toInt(lastSeen) || 0);
    return isTax && isIncomingToAlliance && idOk;
  });

  // Sum positive amounts for the tax deltas
  const delta: Record<string, number> = {};
  for (const k of RES_KEYS) delta[k] = 0;
  for (const r of taxRecs) {
    for (const k of RES_KEYS) {
      const v = toNum((r as any)[k]);
      if (v > 0) delta[k] += v;
    }
  }

  // newestId among the processed tax records
  const newestId = taxRecs.length
    ? taxRecs.map((r) => toInt(r.id)).reduce((a, b) => Math.max(a, b), 0)
    : null;

  return {
    allianceId,
    count: taxRecs.length,
    newestId,
    delta,
  };
}
