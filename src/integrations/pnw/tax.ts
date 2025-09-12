// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, toInt, toNum, RES_KEYS } from "../../lib/pnw.js";

const prisma = new PrismaClient();

export type ResourceDelta = Record<string, number>;
export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

/**
 * Business rule we used earlier:
 * - Count bankrecs that look like *automated tax credits into the alliance*.
 *   Historically these can be detected by:
 *   (A) bankrec note containing "Automated Tax" (case-insensitive), OR
 *   (B) if PnW ever adds a flag, we'd switch to that; for now we use (A).
 *
 * - They should be incoming to the alliance (receiver_type == 2, receiver_id == allianceId).
 * - Only include records with id > lastSeenId (cursor).
 */
function isAutomatedTaxRec(r: any, allianceId: number): boolean {
  const recvAlliance = toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === toInt(allianceId);
  const note = String(r.note || "");
  const looksLikeAuto = /automated\s*tax/i.test(note); // "Automated Tax 100%/100%"
  return recvAlliance && looksLikeAuto;
}

function sumDelta(rows: any[]): ResourceDelta {
  const out: ResourceDelta = {};
  for (const k of RES_KEYS) out[k] = 0;

  for (const r of rows) {
    for (const k of RES_KEYS) {
      out[k] += toNum((r as any)[k]);
    }
  }
  return out;
}

export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  lastSeenId = 0,
  limit = 600
): Promise<PreviewResult> {
  const recs = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });

  // Filter by id > lastSeenId then by "automated tax" into the alliance
  const filtered = recs
    .filter((r) => toInt(r.id) > toInt(lastSeenId))
    .filter((r) => isAutomatedTaxRec(r, allianceId));

  const count = filtered.length;
  const newestId =
    count > 0 ? filtered.reduce((m, r) => Math.max(m, toInt(r.id)), 0) : null;

  const delta = sumDelta(filtered);
  return { count, newestId, delta };
}

/**
 * Convenience: pull key from DB (allianceKeys newest first), fallback to env PNW_DEFAULT_API_KEY.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId = 0,
  limit = 600
): Promise<PreviewResult> {
  // newest saved key for this alliance
  const keyRow = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });

  const apiKey =
    keyRow
      ? open(keyRow.encryptedApiKey as any, keyRow.nonceApi as any)
      : (process.env.PNW_DEFAULT_API_KEY || "");

  if (!apiKey) {
    throw new Error(
      `No API key available for alliance ${allianceId}. Use /pnw_set first.`
    );
  }

  return previewAllianceTaxCredits(apiKey, allianceId, lastSeenId, limit);
}
