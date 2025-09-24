// src/utils/treasury.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

/**
 * Increment the alliance treasury by the provided resource deltas.
 * Any missing keys are treated as zero.
 */
export type ResourceKey =
  | "money" | "food" | "coal" | "oil" | "uranium" | "lead" | "iron" | "bauxite"
  | "gasoline" | "munitions" | "steel" | "aluminum";

export type ResourceDelta = Partial<Record<ResourceKey, number>>;

const KEYS: ResourceKey[] = [
  "money","food","coal","oil","uranium","lead","iron","bauxite",
  "gasoline","munitions","steel","aluminum",
];

/**
 * Ensures a treasury row exists and increments it atomically.
 * Assumes a Prisma model `treasury` with a unique constraint on { allianceId } and
 * numeric columns for each resource key above.
 */
export async function addToTreasury(allianceId: number, delta: ResourceDelta) {
  // normalize: coerce all keys to numbers (0 if missing/NaN)
  const inc: Record<string, any> = {};
  for (const k of KEYS) {
    const v = Number(delta[k] ?? 0);
    if (v) inc[k] = { increment: v };
  }

  // if everything is zero, nothing to do
  if (Object.keys(inc).length === 0) return;

  // upsert the row and apply increments
  await prisma.treasury.upsert({
    where: { allianceId },
    update: inc,
    create: {
      allianceId,
      // initialize with zeros + deltas
      money: Number(delta.money ?? 0),
      food: Number(delta.food ?? 0),
      coal: Number(delta.coal ?? 0),
      oil: Number(delta.oil ?? 0),
      uranium: Number(delta.uranium ?? 0),
      lead: Number(delta.lead ?? 0),
      iron: Number(delta.iron ?? 0),
      bauxite: Number(delta.bauxite ?? 0),
      gasoline: Number(delta.gasoline ?? 0),
      munitions: Number(delta.munitions ?? 0),
      steel: Number(delta.steel ?? 0),
      aluminum: Number(delta.aluminum ?? 0),
    },
  });
}

/**
 * Convenience: sum an array of bank/tax rows into a ResourceDelta.
 * Expects row fields to match the KEYS above.
 */
export function sumRowsToDelta(rows: Array<Record<string, any>>): ResourceDelta {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k] = 0;

  for (const r of rows) {
    for (const k of KEYS) {
      const v = Number(r?.[k] ?? 0);
      if (Number.isFinite(v) && v) out[k]! += v;
    }
  }
  return out as ResourceDelta;
}
