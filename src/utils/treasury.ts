// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

/** Read current balances (empty object if none yet) */
export async function getTreasury(prisma: PrismaClient, allianceId: number) {
  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  return (row?.balances as Record<string, number>) ?? {};
}

/** Apply +/- deltas to balances (creates row if missing) */
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: Record<string, number>
) {
  // Load existing
  const existing = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  const balances: Record<string, number> = { ...(existing?.balances as any) };

  // Merge deltas
  for (const [k, raw] of Object.entries(delta)) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v === 0) continue;
    const cur = Number(balances[k] ?? 0);
    balances[k] = cur + v;
  }

  // Upsert
  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: { balances },
    create: { allianceId, balances },
  });

  return balances;
}
