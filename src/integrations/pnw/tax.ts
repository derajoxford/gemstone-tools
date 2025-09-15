// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import {
  BankrecRow,
  fetchAllianceBankrecsViaGQL,
  fetchAllianceMemberNationIds,
  fetchNationBankrecsViaGQL,
  isAutomatedTaxRow,
  sumDelta,
} from "../../lib/pnw.js";

const prisma = new PrismaClient();

async function getApiKeyForAlliance(allianceId: number): Promise<string> {
  const k = await prisma.allianceKey.findFirst({ where: { allianceId }, orderBy: { id: "desc" } });
  if (!k) throw new Error(`No stored key for alliance ${allianceId}. Run /pnw_set first.`);
  return open(k.encryptedApiKey, k.nonceApi);
}

export type PreviewResult = {
  allianceId: number;
  count: number;
  newestId: number | null;
  delta: ReturnType<typeof sumDelta>;
  sample: BankrecRow[];
  source: "members" | "alliance";
};

/**
 * Preview automated tax credits using stored key.
 * 1) Try member-level nation bankrecs for tax rows (preferred; includes Automated Tax)
 * 2) If that yields nothing, fall back to alliance bankrecs (rarely has tax rows)
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number = 0,
  perNationLimit: number = 20,
): Promise<PreviewResult> {
  const apiKey = await getApiKeyForAlliance(allianceId);

  // PRIMARY: member-level tax scan
  const memberIds = await fetchAllianceMemberNationIds(apiKey, allianceId);
  const nationRows = await fetchNationBankrecsViaGQL(apiKey, memberIds, perNationLimit);
  const taxRows = nationRows.filter(r => isAutomatedTaxRow(r, allianceId) && r.id > lastSeenId);
  if (taxRows.length) {
    const newestId = taxRows.reduce((m, r) => Math.max(m, r.id), 0);
    taxRows.sort((a, b) => b.id - a.id);
    return {
      allianceId,
      count: taxRows.length,
      newestId,
      delta: sumDelta(taxRows),
      sample: taxRows.slice(0, 10),
      source: "members",
    };
  }

  // FALLBACK: alliance-level bankrecs (usually 0 for taxes, but keep as safety)
  const aliRows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit: 300 });
  const aliTax = aliRows.filter(r => isAutomatedTaxRow(r, allianceId) && r.id > lastSeenId);
  const newestId = aliTax.length ? aliTax.reduce((m, r) => Math.max(m, r.id), 0) : null;
  aliTax.sort((a, b) => b.id - a.id);
  return {
    allianceId,
    count: aliTax.length,
    newestId,
    delta: sumDelta(aliTax),
    sample: aliTax.slice(0, 10),
    source: "alliance",
  };
}
