// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, BankrecRow } from "../../lib/pnw";

const prisma = new PrismaClient();

function toNum(v: any) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toInt(v: any) { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : 0; }

export type ResourceDelta = Record<string, number>;
export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

/** Resolve the alliance API key from DB (latest saved), else env fallback. */
async function getAllianceApiKey(allianceId: number): Promise<string> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const enc = a?.keys?.[0];
  if (enc) {
    try { return open(enc.encryptedApiKey as any, enc.nonceApi as any) as string; }
    catch { /* fall through */ }
  }
  const envKey = process.env.PNW_DEFAULT_API_KEY || "";
  if (!envKey) throw new Error("No stored API key and PNW_DEFAULT_API_KEY is not set.");
  return envKey;
}

/**
 * Core preview that uses a provided apiKey.
 * - Fetches recent bankrecs for the alliance.
 * - Filters rows whose note contains "Automated Tax" (case-insensitive).
 * - Applies lastSeenId (only rows with id > lastSeenId are counted).
 * - Sums deltas across PnW resources.
 */
export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  lastSeenId: number | null = null,
  limit = 200
): Promise<PreviewResult> {
  const rows: BankrecRow[] = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });

  let newestId: number | null = null;
  let count = 0;
  const delta: ResourceDelta = {
    money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0,
    bauxite: 0, gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
  };

  for (const r of rows) {
    const idNum = toInt(r.id);
    if (!newestId || idNum > newestId) newestId = idNum;

    // Only consider rows strictly newer than the cursor (if provided)
    if (lastSeenId && idNum <= lastSeenId) continue;

    // Count only automated tax lines (what appears on the banktaxes page)
    const note = (r.note || "").toString();
    if (!/automated tax/i.test(note)) continue;

    // Must be incoming to this alliance
    const recvType = toInt(r.receiver_type);
    const recvId = toInt(r.receiver_id);
    if (!(recvType === 2 && recvId === allianceId)) continue;

    count++;
    delta.money += toNum(r.money);
    delta.food += toNum(r.food);
    delta.coal += toNum(r.coal);
    delta.oil += toNum(r.oil);
    delta.uranium += toNum(r.uranium);
    delta.lead += toNum(r.lead);
    delta.iron += toNum(r.iron);
    delta.bauxite += toNum(r.bauxite);
    delta.gasoline += toNum(r.gasoline);
    delta.munitions += toNum(r.munitions);
    delta.steel += toNum(r.steel);
    delta.aluminum += toNum(r.aluminum);
  }

  return { count, newestId: newestId ?? null, delta };
}

/** Convenience wrapper that resolves the key from storage/env. */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null = null,
  limit = 200
): Promise<PreviewResult> {
  const apiKey = await getAllianceApiKey(allianceId);
  return previewAllianceTaxCredits(apiKey, allianceId, lastSeenId, limit);
}
