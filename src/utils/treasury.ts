import { PrismaClient } from "@prisma/client";
import { ResourceDelta, RESOURCE_KEYS } from "../lib/pnw.js";

/**
 * Fetches (or initializes) the AllianceTreasury row for an alliance.
 * Assumes the schema has a JSON field `balances` holding resource totals.
 */
export async function getTreasury(
  prisma: PrismaClient,
  allianceId: number
): Promise<{ id: number; allianceId: number; balances: Record<string, number> }> {
  let t = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  if (!t) {
    t = await prisma.allianceTreasury.create({
      data: { allianceId, balances: {} },
    });
  }
  // Ensure all keys exist
  const b = { ...(t.balances || {}) };
  for (const k of RESOURCE_KEYS) if (typeof b[k] !== "number") b[k] = 0;
  return { id: t.id, allianceId: t.allianceId, balances: b };
}

/**
 * Adds a signed delta to the treasury balances and writes it back.
 * Optionally you could log a TreasuryEvent row here as well.
 */
export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  delta: ResourceDelta,
  note?: string
) {
  const t = await getTreasury(prisma, allianceId);
  const next = { ...t.balances };
  for (const k of RESOURCE_KEYS) {
    next[k] = Number(next[k] || 0) + Number(delta[k] || 0);
  }
  await prisma.allianceTreasury.update({
    where: { allianceId },
    data: { balances: next },
  });

  // Optional: write a simple audit row if you have a model for it.
  // await prisma.treasuryEvent.create({ data: { allianceId, delta, note: note ?? null } });
}
