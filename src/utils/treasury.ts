// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export type TreasuryBalances = Record<string, number>;

/**
 * Fetch the alliance-wide treasury balances JSON.
 * Returns an empty object if the row doesn't exist yet.
 */
export async function getTreasury(
  prisma: PrismaClient,
  allianceId: number
): Promise<TreasuryBalances> {
  const row = await prisma.allianceTreasury.findUnique({
    where: { allianceId },
  });
  const raw = (row?.balances ?? {}) as Record<string, unknown>;
  const out: TreasuryBalances = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * Increment (or decrement with negatives) the alliance treasury.
 * Creates the AllianceTreasury row if it doesn't exist yet.
 * Returns the new balances object.
 */
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: Record<string, number>
): Promise<TreasuryBalances> {
  // Ensure a row exists
  const existing = await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });

  const balances = { ...(existing.balances as Record<string, unknown>) } as TreasuryBalances;

  for (const [k, v] of Object.entries(delta)) {
    const inc = Number(v) || 0;
    const cur = Number(balances[k] ?? 0) || 0;
    const next = cur + inc;
    // Keep only finite numbers; drop NaNs
    if (Number.isFinite(next)) balances[k] = next;
  }

  const updated = await prisma.allianceTreasury.update({
    where: { allianceId },
    data: { balances },
  });

  // Normalize to numbers on return
  const raw = updated.balances as Record<string, unknown>;
  const out: TreasuryBalances = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}
