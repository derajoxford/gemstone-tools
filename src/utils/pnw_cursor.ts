// src/utils/pnw_cursor.ts
import { PrismaClient } from "@prisma/client";

const cursorKey  = (aid: number) => `pnw:tax_cursor:${aid}`;
const logsKey    = (aid: number) => `pnw:apply_logs:${aid}`;
const summaryKey = (aid: number) => `pnw:summary_channel:${aid}`;

/* -------------------- Cursor helpers -------------------- */
export async function getPnwCursor(
  prisma: PrismaClient,
  allianceId: number
): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: cursorKey(allianceId) } }).catch(() => null);
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

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

/* Back-compat aliases used by some call sites */
export const readTaxCursor  = getPnwCursor;
export const writeTaxCursor = async (prisma: PrismaClient, allianceId: number, newestId: number) =>
  setPnwCursor(prisma, allianceId, newestId);

/* -------------------- Apply logs -------------------- */
export type PnwApplyLogEntry = {
  at: string;                // ISO timestamp
  allianceId: number;
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
  note?: string | null;
};

export async function appendPnwLog(
  prisma: PrismaClient,
  allianceId: number,
  entry: PnwApplyLogEntry
): Promise<void> {
  const key = logsKey(allianceId);
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const arr: PnwApplyLogEntry[] = row?.value ? safeParseArray(row.value) : [];
  arr.push(entry);
  while (arr.length > 50) arr.shift(); // keep last 50
  await prisma.setting.upsert({
    where: { key },
    update: { value: JSON.stringify(arr) },
    create: { key, value: JSON.stringify(arr) },
  });
}

export async function getPnwLogs(
  prisma: PrismaClient,
  allianceId: number,
  limit = 10
): Promise<PnwApplyLogEntry[]> {
  const key = logsKey(allianceId);
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null);
  const arr: PnwApplyLogEntry[] = row?.value ? safeParseArray(row.value) : [];
  return arr.slice(-Math.max(1, Math.min(50, limit)));
}

function safeParseArray(s: string): PnwApplyLogEntry[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

/* Back-compat alias name some jobs import */
export const appendPnwApplyLog = appendPnwLog;

/* -------------------- Summary channel -------------------- */
export async function getPnwSummaryChannel(
  prisma: PrismaClient,
  allianceId: number
): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: summaryKey(allianceId) } }).catch(() => null);
  return row?.value ?? null;
}

export async function setPnwSummaryChannel(
  prisma: PrismaClient,
  allianceId: number,
  channelId: string | null
): Promise<void> {
  const key = summaryKey(allianceId);
  if (!channelId) { try { await prisma.setting.delete({ where: { key } }); } catch {} return; }
  await prisma.setting.upsert({
    where: { key },
    update: { value: channelId },
    create: { key, value: channelId },
  });
}
