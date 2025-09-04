// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

// Read (and lazily create) an alliance’s treasury row, returning a plain object of balances
export async function getTreasury(prisma: PrismaClient, allianceId: number) {
  const row = await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });
  return (row.balances as Record<string, number>) || {};
}

// Increment/decrement one or more resource balances
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: Record<string, number>
) {
  const row = await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });

  const balances = (row.balances as Record<string, number>) || {};
  for (const [k, raw] of Object.entries(delta)) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) continue;
    balances[k] = (Number(balances[k]) || 0) + v;
  }

  await prisma.allianceTreasury.update({
    where: { allianceId },
    data: { balances },
  });
}
