// src/utils/pnw_cursor.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type PnwApplyLogEntry = {
  ts: string;               // ISO timestamp
  actorId: string;          // Discord user id
  actorTag?: string;        // "name#1234" at apply time
  fromCursor?: number | null;
  toCursor?: number | null;
  records: number;          // records counted/applied
  delta: Record<string, number>; // non-zero deltas applied
};

type Json = any;

async function getBalancesObj(allianceId: number): Promise<Json> {
  const row = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  const b = (row?.balances ?? {}) as Json;
  return typeof b === "object" && b !== null ? b : {};
}

async function saveBalancesObj(allianceId: number, balances: Json): Promise<void> {
  const exists = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  if (exists) {
    await prisma.allianceTreasury.update({ where: { allianceId }, data: { balances } });
  } else {
    await prisma.allianceTreasury.create({ data: { allianceId, balances } });
  }
}

/** Read stored PnW cursor from balances._meta.pnw.cursor */
export async function getPnwCursor(allianceId: number): Promise<number | undefined> {
  const balances = await getBalancesObj(allianceId);
  const cur = balances?._meta?.pnw?.cursor;
  return typeof cur === "number" ? cur : undefined;
}

/** Write PnW cursor to balances._meta.pnw.cursor (creates row if needed) */
export async function setPnwCursor(allianceId: number, cursor: number): Promise<void> {
  const balances = await getBalancesObj(allianceId);
  const next = {
    ...balances,
    _meta: {
      ...(balances._meta ?? {}),
      pnw: { ...(balances._meta?.pnw ?? {}), cursor },
    },
  };
  await saveBalancesObj(allianceId, next);
}

/** Append an apply log entry under balances._meta.pnw.logs (keeps last 100) */
export async function appendPnwApplyLog(allianceId: number, entry: PnwApplyLogEntry): Promise<void> {
  const balances = await getBalancesObj(allianceId);
  const prev: PnwApplyLogEntry[] = (balances?._meta?.pnw?.logs ?? []) as any[];
  const logs = [...prev, entry];
  while (logs.length > 100) logs.shift(); // keep last 100
  const next = {
    ...balances,
    _meta: {
      ...(balances._meta ?? {}),
      pnw: { ...(balances._meta?.pnw ?? {}), logs },
    },
  };
  await saveBalancesObj(allianceId, next);
}

/** Get the most recent N apply log entries (default 10) */
export async function getPnwLogs(allianceId: number, limit = 10): Promise<PnwApplyLogEntry[]> {
  const balances = await getBalancesObj(allianceId);
  const prev: PnwApplyLogEntry[] = (balances?._meta?.pnw?.logs ?? []) as any[];
  const slice = prev.slice(Math.max(0, prev.length - Math.min(limit, 50))); // hard cap 50
  return slice.reverse(); // newest first
}
