import { PrismaClient } from "@prisma/client";

/**
 * This module provides legacy-named helpers that other parts of the code import:
 * - getPnwCursor / setPnwCursor          → stored bankrec cursor (id)
 * - getPnwLogs / appendPnwLog            → minimal apply logs (kept in Settings as JSON)
 * - getPnwSummaryChannel / setPnwSummaryChannel → summary channel per alliance
 *
 * It stores values in the `Setting` table using string keys:
 *   pnw:tax_cursor:<allianceId>            (stringified number)
 *   pnw:apply_logs:<allianceId>            (stringified JSON array)
 *   pnw:summary_channel:<allianceId>       (Discord channel id string)
 */

function cursorKey(allianceId: number) {
  return `pnw:tax_cursor:${allianceId}`;
}
function logsKey(allianceId: number) {
  return `pnw:apply_logs:${allianceId}`;
}
function summaryKey(allianceId: number) {
  return `pnw:summary_channel:${allianceId}`;
}

/** Read stored cursor (bankrec id). */
export async function getPnwCursor(
  prisma: PrismaClient,
  allianceId: number
): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: cursorKey(allianceId) } }).catch(() => null);
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Set/advance stored cursor (bankrec id). */
export async function setPnwCursor(
  prisma: PrismaClient,
  allianceId: number,
  id: number
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: cursorKey(allianceId) },
    update: { value: String(id) },
    create: { key: cursorKey(allianceId), value: String(id) },
  });
}

/** Log entry type for tax apply operations. */
export type PnwApplyLogEntry = {
  at: string; // ISO timestamp
  allianceId: number;
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
  note?: string | null;
};

/** Append a log entry (kept as a small JSON array in Settings). */
export async function appendPnwLog(
  prisma: PrismaClient,
  allianceId: number,
  entry: PnwApplyLogEntry
): Promise<void> {
  const key = logsKey(allianceId);
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const arr: PnwApplyLogEntry[] = row?.value ? safeParseArray(row.value) : [];
  arr.push(entry);
  // keep only the most recent 50
  while (arr.length > 50) arr.shift();
  await prisma.setting.upsert({
    where: { key },
    update: { value: JSON.stringify(arr) },
    create: { key, value: JSON.stringify(arr) },
  });
}

/** Retrieve recent logs (default 10). */
export async function getPnwLogs(
  prisma: PrismaClient,
  allianceId: number,
  limit = 10
): Promise<PnwApplyLogEntry[]> {
  const key = logsKey(allianceId);
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const arr: PnwApplyLogEntry[] = row?.value ? safeParseArray(row.value) : [];
  if (limit < 1) return [];
  return arr.slice(-limit);
}

/** Read the configured summary channel id (Discord channel id string). */
export async function getPnwSummaryChannel(
  prisma: PrismaClient,
  allianceId: number
): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: summaryKey(allianceId) } }).catch(() => null);
  return row?.value ?? null;
}

/** Set/clear the summary channel id. Pass null to clear. */
export async function setPnwSummaryChannel(
  prisma: PrismaClient,
  allianceId: number,
  channelId: string | null
): Promise<void> {
  const key = summaryKey(allianceId);
  if (!channelId) {
    // Clear by deleting the row if it exists
    try {
      await prisma.setting.delete({ where: { key } });
    } catch {
      // ignore if not present
    }
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    update: { value: channelId },
    create: { key, value: channelId },
  });
}

function safeParseArray(s: string): PnwApplyLogEntry[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
