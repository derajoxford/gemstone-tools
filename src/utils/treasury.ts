// src/utils/treasury.ts
import type { PrismaClient } from "@prisma/client";

export const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;

export type ResKey = typeof RES_KEYS[number];
export type ResTotals = Partial<Record<ResKey, number>>;

// Back-compat for older code that imported KEYS
export const KEYS = RES_KEYS;

function toNumber(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBalances(bal: any): Record<ResKey, number> {
  const out: Record<ResKey, number> = {} as any;
  for (const k of RES_KEYS) out[k] = toNumber(bal?.[k] ?? 0);
  return out;
}

/**
 * Read treasury balances (JSON) for an alliance. Creates the row if missing.
 * Expects Prisma model: allianceTreasury { allianceId Int @unique, balances Json, ... }
 */
export async function getTreasury(
  prisma: PrismaClient,
  allianceId: number
): Promise<Record<ResKey, number>> {
  // Ensure row exists
  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });

  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  return normalizeBalances(row?.balances ?? {});
}

/**
 * Credit (add) resource amounts into the treasury JSON balances.
 * Returns the updated balances.
 */
export async function creditTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: ResTotals,
  _reason?: string
): Promise<Record<ResKey, number>> {
  // Ensure row exists first
  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });

  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  const balances = normalizeBalances(row?.balances ?? {});

  for (const k of RES_KEYS) {
    const add = toNumber((delta as any)[k] ?? 0);
    if (add) balances[k] = toNumber(balances[k]) + add;
  }

  await prisma.allianceTreasury.update({
    where: { allianceId },
    data: { balances },
  });

  return balances;
}
