// src/utils/treasury.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite",
  "gasoline","munitions","steel","aluminum",
] as const;

export type TreasuryDelta = Partial<Record<(typeof KEYS)[number], number>>;

/**
 * Sum a set of PnW bank/tax rows into a single delta by resource keys.
 * Rows are expected to have numeric fields named like: money, food, coal, ...
 */
export function sumRowsToDelta(rows: any[]): TreasuryDelta {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k] = 0;
  for (const r of rows || []) {
    for (const k of KEYS) {
      const v = Number((r as any)[k] ?? 0);
      if (Number.isFinite(v) && v) out[k] += v;
    }
  }
  // strip zeros
  const clean: TreasuryDelta = {};
  for (const k of KEYS) if (out[k]) clean[k] = out[k];
  return clean;
}

/**
 * Add a delta to the alliance treasury. This is schema-agnostic:
 * it will try prisma.treasury, prisma.allianceTreasury, or prisma.AllianceTreasury.
 * The model must have a unique `allianceId` and numeric resource columns matching KEYS.
 */
export async function addToTreasury(allianceId: number, delta: TreasuryDelta) {
  if (!allianceId) throw new Error("allianceId required");
  const model =
    (prisma as any).treasury ??
    (prisma as any).allianceTreasury ??
    (prisma as any).AllianceTreasury;

  if (!model) {
    throw new Error(
      "Prisma model for treasury not found. Expected one of: treasury, allianceTreasury, AllianceTreasury",
    );
  }

  // Build increment payload for update
  const inc: Record<string, any> = {};
  for (const k of KEYS) {
    const v = Number((delta as any)[k] ?? 0);
    if (v) inc[k] = { increment: v };
  }

  // Build create payload for first-time upsert
  const create: Record<string, any> = { allianceId };
  for (const k of KEYS) create[k] = Number((delta as any)[k] ?? 0) || 0;

  // Some schemas name the unique field differently; we assume `allianceId` is unique.
  await model.upsert({
    where: { allianceId },
    update: inc,
    create,
  });
}
