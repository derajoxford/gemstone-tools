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

// Prefer strong signal: tax_id > 0. Fallback to "Automated Tax" note.
function looksLikeAutomatedTax(r: Bankrec, allianceId: number): boolean {
  // If API gives tax_id, that’s definitive.
  if (typeof r.tax_id === 'number' && r.tax_id > 0) return true;

  // Otherwise, try to infer from structure + note.
  const note = (r.note || '').toLowerCase();
  const hasNote = note.includes('automated tax');

  // Typical tax row is nation -> alliance (receiver is our alliance)
  const nationToAlliance = r.receiver_type === 2 && r.receiver_id === allianceId;

  return hasNote && nationToAlliance;
}

const RES_KEYS = [
  'money','food','coal','oil','uranium','lead','iron','bauxite',
  'gasoline','munitions','steel','aluminum',
] as const;

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 600
): Promise<TaxPreview> {
  // Pull newest alliance key (or fallback)
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: 'desc' }, take: 1 } },
  });
  const apiKeyEnc = a?.keys?.[0];
  const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || '');
  if (!apiKey) throw new Error('No API key found for this alliance.');

  const rows = await fetchAllianceBankrecsViaGQL({ apiKey }, allianceId, Math.max(1, Number(limit) || 600));

  // Cursor filter
  const afterCursor = (lastSeenId && lastSeenId > 0) ? rows.filter(r => Number(r.id) > lastSeenId) : rows;

  // Keep only tax rows
  const taxRows = afterCursor.filter(r => looksLikeAutomatedTax(r, allianceId));

  // newest id
  const newestId = taxRows.length ? Math.max(...taxRows.map(r => Number(r.id))) : null;

  // sum
  const delta: Record<string, number> = {};
  for (const k of RES_KEYS) delta[k] = 0;
  for (const r of taxRows) {
    for (const k of RES_KEYS) {
      const v = Number((r as any)[k] || 0);
      if (v > 0) delta[k] += v;
    }
  }
  // prune zeros
  for (const k of Object.keys(delta)) if (!delta[k]) delete delta[k];

  return { count: taxRows.length, newestId, delta };
}
