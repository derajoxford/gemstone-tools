// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

export type Resource = typeof RESOURCES[number];

type Balances = Record<Resource, number>;

/** Read balances for an alliance, returning zeros when no row yet. */
export async function getTreasury(prisma: PrismaClient, allianceId: number): Promise<Balances> {
  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  const raw = (row?.balances ?? {}) as Record<string, number>;
  const out = {} as Balances;
  for (const k of RESOURCES) out[k] = Number(raw[k] ?? 0);
  return out;
}

/** Add deltas to balances (positive or negative). Creates row if missing. */
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: Partial<Record<Resource, number>>
): Promise<Balances> {
  const current = await getTreasury(prisma, allianceId);
  for (const [k, v] of Object.entries(delta)) {
    const key = k as Resource;
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    current[key] = Number(current[key] || 0) + n;
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: { balances: current as any },
    create: { allianceId, balances: current as any },
  });

  return current;
}
