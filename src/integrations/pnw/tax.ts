// src/integrations/pnw/tax.ts
import { PrismaClient } from '@prisma/client';
import { open } from '../../lib/crypto.js';
import { fetchAllianceBankrecsViaGQL, Bankrec } from '../../lib/pnw.js';

const prisma = new PrismaClient();

export type TaxPreview = {
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
};

// A tax row should be: nation -> alliance, receiver == our alliance
function looksLikeAutomatedTax(r: Bankrec, allianceId: number): boolean {
  const isNationToAlliance = r.sender_type === 1 && r.receiver_type === 2 && r.receiver_id === allianceId;
  if (!isNationToAlliance) return false;
  const note = (r.note || '').toLowerCase();
  // Very permissive: catch "Automated Tax" variations
  return note.includes('automated tax');
}

const RES_KEYS = [
  'money','food','coal','oil','uranium','lead','iron','bauxite',
  'gasoline','munitions','steel','aluminum',
] as const;

export async function previewAllianceTaxCreditsStored(allianceId: number, lastSeenId: number | null, limit: number = 600): Promise<TaxPreview> {
  // pull the newest alliance key (or PNW_DEFAULT_API_KEY)
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: 'desc' }, take: 1 } },
  });
  const apiKeyEnc = a?.keys?.[0];
  const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || '');
  if (!apiKey) throw new Error('No API key found for this alliance.');

  // get recent bankrecs via GraphQL (paginator-safe)
  const rows = await fetchAllianceBankrecsViaGQL({ apiKey }, allianceId, Math.max(1, Number(limit) || 600));

  // apply cursor filter (id > lastSeenId) if provided
  const filteredByCursor = (lastSeenId && lastSeenId > 0)
    ? rows.filter(r => Number(r.id) > lastSeenId)
    : rows;

  // find only *automated tax* rows (nation -> alliance, note contains)
  const taxRows = filteredByCursor.filter(r => looksLikeAutomatedTax(r, allianceId));

  // compute newest id
  const newestId = taxRows.length ? Math.max(...taxRows.map(r => Number(r.id))) : null;

  // sum positive deltas
  const delta: Record<string, number> = {};
  for (const k of RES_KEYS) delta[k] = 0;
  for (const r of taxRows) {
    for (const k of RES_KEYS) {
      const v = Number((r as any)[k] || 0);
      if (v > 0) delta[k] += v;
    }
  }

  // trim zeros
  for (const k of Object.keys(delta)) {
    if (!delta[k]) delete delta[k];
  }

  return { count: taxRows.length, newestId, delta };
}
