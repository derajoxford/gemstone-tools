// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, isLikelyTaxRow, BankrecRow } from "../../lib/pnw";

const prisma = new PrismaClient();

/** Sum resources across rows */
function sumRows(rows: BankrecRow[]) {
  const keys = ["money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum"] as const;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  for (const r of rows) {
    for (const k of keys) out[k] += Number((r as any)[k] || 0);
  }
  return out;
}

/** Public: use a provided key string (for debugging/tools) */
export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  lastSeenId: number | null,
  limit = 200
) {
  const all = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
  const fresh = (lastSeenId ? all.filter(r => r.id > lastSeenId) : all);
  const tax = fresh.filter(r => isLikelyTaxRow(r, allianceId));
  const newestId = fresh.length ? Math.max(...fresh.map(r => r.id)) : null;
  return {
    count: tax.length,
    newestId,
    delta: sumRows(tax),
    rows: tax,
  };
}

/** Public: read the encrypted alliance key from DB and preview */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit = 200
) {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) throw new Error("No stored API key for this alliance. Run /pnw_set.");
  const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);
  return previewAllianceTaxCredits(apiKey, allianceId, lastSeenId, limit);
}
