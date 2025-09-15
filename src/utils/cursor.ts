import { PrismaClient } from "@prisma/client";

function keyFor(allianceId: number) {
  return `pnw:tax_cursor:${allianceId}`;
}

/**
 * Reads the stored tax cursor (last applied bankrec id) for the alliance.
 * Returns null if not set.
 */
export async function readTaxCursor(
  prisma: PrismaClient,
  allianceId: number
): Promise<number | null> {
  const k = keyFor(allianceId);
  const row = await prisma.setting.findUnique({ where: { key: k } }).catch(() => null);
  if (!row) return null;
  const val = Number(row.value);
  return Number.isFinite(val) && val > 0 ? val : null;
}

/**
 * Writes/advances the tax cursor to the given id (idempotent upsert).
 */
export async function writeTaxCursor(
  prisma: PrismaClient,
  allianceId: number,
  newestId: number
) {
  const k = keyFor(allianceId);
  await prisma.setting.upsert({
    where: { key: k },
    update: { value: String(newestId) },
    create: { key: k, value: String(newestId) },
  });
}
