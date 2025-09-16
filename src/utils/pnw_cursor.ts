// src/utils/pnw_cursor.ts
import { PrismaClient } from "@prisma/client";

/**
 * Try to find a key-value style model on the Prisma client.
 * We support multiple schema names so this works across environments:
 *   - setting / settings
 *   - kv / keyValue / keyvalue
 *   - appSetting / AppSetting
 * The model must expose findUnique, upsert, and delete (normal Prisma CRUD).
 */
function getKVStore(prisma: PrismaClient): any | null {
  const candidates = [
    "setting", "settings",
    "kv", "kvs",
    "keyValue", "keyvalue", "key_values",
    "appSetting", "appSettings",
    "config", "configs",
  ];
  const p: any = prisma as any;
  for (const name of candidates) {
    const m = p?.[name];
    if (m && typeof m.findUnique === "function") {
      return { name, m };
    }
  }
  return null;
}

const cursorKey  = (aid: number) => `pnw:tax_cursor:${aid}`;
const logsKey    = (aid: number) => `pnw:apply_logs:${aid}`;
const summaryKey = (aid: number) => `pnw:summary_channel:${aid}`;

/* -------------------- Cursor helpers -------------------- */
export async function getPnwCursor(
  prisma: PrismaClient,
  allianceId: number
): Promise<number | null> {
  const store = getKVStore(prisma);
  if (!store) return null; // no KV table available -> treat as no cursor
  const row = await store.m.findUnique({ where: { key: cursorKey(allianceId) } }).catch(() => null);
  if (!row) return null;
  const raw = (row as any).value ?? (row as any).val ?? (row as any).data ?? null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setPnwCursor(
  prisma: PrismaClient,
  allianceId: number,
  id: number
): Promise<void> {
  const store = getKVStore(prisma);
  if (!store) throw new Error("No settings/kv store model found in Prisma schema; cannot persist cursor.");
  await store.m.upsert({
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
  const store = getKVStore(prisma);
  if (!store) throw new Error("No settings/kv store model found; cannot write apply logs.");
  const key = logsKey(allianceId);
  const row = await store.m.findUnique({ where: { key } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? "[]";
  const arr: PnwApplyLogEntry[] = safeParseArray(String(raw));
  arr.push(entry);
  while (arr.length > 50) arr.shift(); // keep last 50
  await store.m.upsert({
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
  const store = getKVStore(prisma);
  if (!store) return []; // no store => no logs
  const key = logsKey(allianceId);
  const row = await store.m.findUnique({ where: { key } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? "[]";
  const arr: PnwApplyLogEntry[] = safeParseArray(String(raw));
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
  const store = getKVStore(prisma);
  if (!store) return null;
  const row = await store.m.findUnique({ where: { key: summaryKey(allianceId) } }).catch(() => null);
  const raw = (row as any)?.value ?? (row as any)?.val ?? (row as any)?.data ?? null;
  return raw ? String(raw) : null;
}

export async function setPnwSummaryChannel(
  prisma: PrismaClient,
  allianceId: number,
  channelId: string | null
): Promise<void> {
  const store = getKVStore(prisma);
  if (!store) throw new Error("No settings/kv store model found; cannot persist summary channel.");
  const key = summaryKey(allianceId);
  if (!channelId) {
    try { await store.m.delete({ where: { key } }); } catch {}
    return;
  }
  await store.m.upsert({
    where: { key },
    update: { value: channelId },
    create: { key, value: channelId },
  });
}
