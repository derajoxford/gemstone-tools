// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, BankrecRow } from "../../lib/pnw";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

export type ResourceDelta = Record<string, number>;

const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite",
  "gasoline","munitions","steel","aluminum",
] as const;

function isTaxCreditToAlliance(r: BankrecRow, allianceId: number): boolean {
  // Only count automated taxes that CREDIT the alliance
  return r.tax_id != null
    && Number(r.tax_id) > 0
    && r.receiver_type === 2
    && r.receiver_id === allianceId;
}

function addDelta(dst: ResourceDelta, src: Partial<ResourceDelta>) {
  for (const k of RES_KEYS) {
    const v = Number((src as any)[k] ?? 0);
    if (!v) continue;
    dst[k] = Number(dst[k] ?? 0) + v;
  }
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number = 0,
  limit: number = 300
): Promise<{ count: number; newestId: number | null; delta: ResourceDelta; rows: BankrecRow[] }> {
  const keyRow = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!keyRow) throw new Error(`No stored API key for alliance ${allianceId}. Run /pnw_set first.`);

  const apiKey = open(keyRow.encryptedApiKey, keyRow.nonceApi);

  const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit: Math.max(1, Math.min(500, limit)) });

  // Only tax credits to the alliance, newer than cursor
  const filtered = rows.filter(r =>
    isTaxCreditToAlliance(r, allianceId) && (!lastSeenId || r.id > lastSeenId)
  );

  const delta: ResourceDelta = {};
  for (const r of filtered) addDelta(delta, r as any);

  const newestId = filtered.length ? Math.max(...filtered.map(r => r.id)) : null;

  return { count: filtered.length, newestId, delta, rows: filtered };
}
