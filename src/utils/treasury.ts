// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export type Balances = Record<string, number>;

/**
 * Ensure a treasury row exists and return its balances object.
 */
export async function getTreasury(prisma: PrismaClient, allianceId: number): Promise<Balances> {
  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  if (row?.balances && typeof row.balances === 'object') {
    // Prisma returns JSON as unknown; cast to our shape.
    return row.balances as unknown as Balances;
  }
  // create empty if missing
  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    create: { allianceId, balances: {} },
    update: {},
  });
  return {};
}

/**
 * Overwrite the treasury balances with the provided object.
 */
export async function setTreasury(
  prisma: PrismaClient,
  allianceId: number,
  balances: Balances,
): Promise<void> {
  // Normalize numbers
  const clean: Balances = {};
  for (const [k, v] of Object.entries(balances)) {
    const n = Number(v);
    if (Number.isFinite(n)) clean[k] = n;
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    create: { allianceId, balances: clean },
    update: { balances: clean },
  });
}

/**
 * Add deltas to the existing balances (negative or positive numbers).
 * Returns the updated balances.
 */
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: Balances,
): Promise<Balances> {
  const current = await getTreasury(prisma, allianceId);
  const next: Balances = { ...current };

  for (const [k, v] of Object.entries(delta)) {
    const add = Number(v);
    if (!Number.isFinite(add)) continue;
    const prev = Number(next[k] ?? 0);
    next[k] = prev + add;
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    create: { allianceId, balances: next },
    update: { balances: next },
  });

  return next;
}
