// src/utils/treasury.ts
import type { PrismaClient } from "@prisma/client";

// canonical resource keys we track
export const KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

export type ResourceKey = (typeof KEYS)[number];
export type Delta = Partial<Record<ResourceKey, number>>;

// -- internals ---------------------------------------------------------------

function zeroBalances(): Record<ResourceKey, number> {
  const z: any = {};
  for (const k of KEYS) z[k] = 0;
  return z;
}

/**
 * Try an upsert assuming *scalar* columns exist (money, food, ...).
 * If that fails with "Unknown argument", the caller can fall back to JSON mode.
 */
async function upsertScalarOrThrow(
  prisma: PrismaClient,
  modelName: string,
  allianceId: number
) {
  const model = (prisma as any)[modelName];
  if (!model || typeof model.upsert !== "function") {
    throw new Error(`Prisma model ${modelName} not found`);
  }
  const create: any = { allianceId };
  for (const k of KEYS) create[k] = 0;
  return model.upsert({
    where: { allianceId },
    update: {},
    create,
  });
}

/**
 * Upsert using a JSON {balances} column.
 */
async function upsertJson(
  prisma: PrismaClient,
  modelName: string,
  allianceId: number
) {
  const model = (prisma as any)[modelName];
  if (!model || typeof model.upsert !== "function") {
    throw new Error(`Prisma model ${modelName} not found`);
  }
  return model.upsert({
    where: { allianceId },
    update: {},
    create: {
      allianceId,
      balances: zeroBalances(),
    },
  });
}

async function getByAllianceId(
  prisma: PrismaClient,
  modelName: string,
  allianceId: number
) {
  const model = (prisma as any)[modelName];
  return model.findUnique?.({ where: { allianceId } });
}

// -- public helpers ----------------------------------------------------------

/**
 * Ensure a treasury row exists for the alliance. Works with either schema:
 * - scalar columns (money, food, …)
 * - JSON column { balances }
 */
export async function ensureAllianceTreasury(
  prisma: PrismaClient,
  modelName: string,
  allianceId: number
) {
  // Try scalar first; if that fails due to shape, fall back to JSON.
  try {
    return await upsertScalarOrThrow(prisma, modelName, allianceId);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const looksLikeShapeErr =
      msg.includes("Unknown argument") ||
      msg.includes("Argument") ||
      msg.includes("Invalid") ||
      msg.includes("unknown field");
    if (!looksLikeShapeErr) throw e;
    return upsertJson(prisma, modelName, allianceId);
  }
}

/**
 * Apply a delta (add amounts) to the treasury row.
 * If scalar columns exist, uses { increment }.
 * If only JSON {balances} exists, merges and writes back.
 */
export async function applyDeltaToTreasury(
  prisma: PrismaClient,
  modelName: string,
  allianceId: number,
  delta: Delta
) {
  const model = (prisma as any)[modelName];
  if (!model) throw new Error(`Prisma model ${modelName} not found`);

  // Make sure the row exists
  await ensureAllianceTreasury(prisma, modelName, allianceId);

  // Attempt scalar increment path
  try {
    const data: any = {};
    for (const k of KEYS) {
      const v = Number((delta as any)[k] ?? 0) || 0;
      if (v) data[k] = { increment: v };
    }
    if (Object.keys(data).length === 0) return;
    await model.update({ where: { allianceId }, data });
    return;
  } catch (e: any) {
    const msg = String(e?.message || e);
    const looksLikeShapeErr =
      msg.includes("Unknown argument") ||
      msg.includes("Argument") ||
      msg.includes("Invalid") ||
      msg.includes("unknown field");
    if (!looksLikeShapeErr) throw e;
  }

  // JSON fallback: read, merge, write
  const row = await getByAllianceId(prisma, modelName, allianceId);
  const currentBalances: Record<string, number> = {
    ...(row?.balances ?? zeroBalances()),
  };

  for (const k of KEYS) {
    const add = Number((delta as any)[k] ?? 0) || 0;
    if (add) currentBalances[k] = Number(currentBalances[k] ?? 0) + add;
  }

  await model.update({
    where: { allianceId },
    data: { balances: currentBalances },
  });
}

/**
 * Turn a raw bank/tax row (from PnW) into a {Delta}
 */
export function deltaFromBankrec(row: any): Delta {
  const d: any = {};
  for (const k of KEYS) {
    const v = Number(row?.[k] ?? 0) || 0;
    if (v) d[k] = v;
  }
  return d;
}
