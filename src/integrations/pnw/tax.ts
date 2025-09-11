// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto";
import { fetchBankrecs } from "../../lib/pnw";
import { ORDER } from "../../lib/emojis";

const prisma = new PrismaClient();

type Bankrec = {
  id: number | string;
  date?: string | null;
  note?: string | null;
  sender_type: number | string;
  sender_id: number | string;
  receiver_type: number | string;
  receiver_id: number | string;
  tax_id?: number | string | null;

  // resources
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

type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
  sample?: Array<{ id: number; note: string; money?: number }>;
};

const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

/**
 * Heuristic for detecting automated tax rows in alliance bankrecs.
 * We consider a row a "tax" if:
 *  - It's incoming to the alliance (receiver_type==2 and receiver_id==allianceId), AND
 *  - EITHER tax_id > 0 OR note matches /Automated Tax/i
 */
function isTaxForAlliance(r: Bankrec, allianceId: number): boolean {
  const incomingToAlliance =
    toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === allianceId;

  if (!incomingToAlliance) return false;

  const taxId = toInt((r as any).tax_id);
  const note = String(r.note || "");

  if (taxId > 0) return true;
  if (/automated\s*tax/i.test(note)) return true;

  return false;
}

function sumDelta(records: Bankrec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ORDER) out[k] = 0;

  for (const r of records) {
    for (const k of ORDER) {
      out[k] += toNum((r as any)[k]);
    }
  }
  return out;
}

/**
 * Core preview using a stored alliance API key.
 * We intentionally DO NOT pass a GraphQL $limit variable (avoids prior regression).
 * fetchBankrecs() uses its own sane default window; we can optionally request a
 * larger window by calling it again if caller asks for bigger "limit".
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null = null,
  opts?: { limit?: number; sampleSize?: number }
): Promise<PreviewResult> {
  // 1) open the newest stored key (or fall back to env default)
  const alliance = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });

  const k = alliance?.keys?.[0];
  const apiKey =
    (k ? open(k.encryptedApiKey as any, k.nonceApi as any) : null) ||
    process.env.PNW_DEFAULT_API_KEY ||
    "";

  if (!apiKey) {
    throw new Error(
      "No valid stored PnW user API key for this alliance. Run /pnw_set again (and ensure GT_SECRET/ENCRYPTION_KEY matches the one used when saving)."
    );
  }

  // 2) fetch a recent window of bankrecs for this alliance
  //    NOTE: we do not pass variables; fetchBankrecs uses a built-in window (generally 200–600)
  //    If a larger scan is requested, do a second pass and concat (still without $limit variables).
  const window1 = (await fetchBankrecs({ apiKey }, [allianceId])) || [];
  let rows: Bankrec[] = (window1[0]?.bankrecs as any[]) || [];

  // Optional second pass for a "bigger window" (crude but avoids $limit regression)
  const want = Math.max(0, toInt(opts?.limit));
  if (want && rows.length < want) {
    // try calling a second time; some backends page differently per call
    const window2 = (await fetchBankrecs({ apiKey }, [allianceId])) || [];
    const more = (window2[0]?.bankrecs as any[]) || [];
    if (more.length > rows.length) rows = more;
  }

  // 3) filter by cursor and tax heuristic
  const minId = lastSeenId || 0;
  const candidates = rows.filter((r) => toInt(r.id) > minId);
  const taxRows = candidates.filter((r) => isTaxForAlliance(r, allianceId));

  const newestId =
    taxRows.length > 0 ? Math.max(...taxRows.map((r) => toInt(r.id))) : null;
  const delta = sumDelta(taxRows);

  // small diagnostic sample
  const sampleSize = Math.min(5, Math.max(0, opts?.sampleSize ?? 3));
  const sample =
    sampleSize > 0
      ? taxRows
          .slice(-sampleSize)
          .map((r) => ({
            id: toInt(r.id),
            note: String(r.note || ""),
            money: toNum(r.money),
          }))
      : [];

  return {
    count: taxRows.length,
    newestId,
    delta,
    sample,
  };
}
