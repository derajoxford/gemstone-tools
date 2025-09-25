// src/utils/treasury.ts
import type { PrismaClient } from "@prisma/client";

export const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
export type ResKey = typeof RES_KEYS[number];
export type ResTotals = Partial<Record<ResKey, number>>;

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
 * Upserts a Treasury row for the alliance and adds (credits) resource deltas
 * into the JSON `balances` field. Returns the updated balances.
 *
 * Schema expectation:
 *   model Treasury {
 *     allianceId  Int   @unique
 *     balances    Json
 *     createdAt   DateTime @default(now())
 *     updatedAt   DateTime @updatedAt
 *   }
 */
export async function creditTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: ResTotals,
  _reason?: string
): Promise<Record<ResKey, number>> {
  // Ensure a row exists first (create empty if missing)
  await prisma.treasury.upsert({
    where: { allianceId },
    update: {},
    create: { allianceId, balances: {} },
  });

  // Read current balances
  const currentRow = await prisma.treasury.findUnique({ where: { allianceId } });
  const current = normalizeBalances(currentRow?.balances ?? {});

  // Apply delta
  for (const k of RES_KEYS) {
    const add = toNumber((delta as any)[k] ?? 0);
    if (add) current[k] = toNumber(current[k]) + add;
  }

  // Write back
  await prisma.treasury.update({
    where: { allianceId },
    data: { balances: current },
  });

  return current;
}
