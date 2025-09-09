// src/utils/pnw_cursor.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * We store small bot state in a simple KV table.
 * This helper tries a few common model names so we don't have to know your exact Prisma model.
 * Valid shapes (any of these work):
 *   - Setting   { id, key, json? | value? }
 *   - BotSetting{ id, key, json? | value? }
 *   - Kv        { id, key, json? | value? }
 *   - KvStore   { id, key, json? | value? }
 */
function getKVModel(): any {
  const p = prisma as any;
  return (
    p.setting ??
    p.botSetting ??
    p.kv ??
    p.kvStore ??
    p.Config ??
    p.config ??
    null
  );
}

async function readKV(key: string): Promise<any | null> {
  const T = getKVModel();
  if (!T) throw new Error("KV model not found in Prisma Client.");

  // Prefer unique find; fall back to first
  let row: any = null;
  try {
    if (typeof T.findUnique === "function") {
      row = await T.findUnique({ where: { key } });
    }
  } catch {}
  if (!row && typeof T.findFirst === "function") {
    row = await T.findFirst({ where: { key } });
  }
  if (!row) return null;

  // Try common value fields in order of preference
  if (row.json !== undefined && row.json !== null) return row.json;
  if (row.valueJson !== undefined && row.valueJson !== null) return row.valueJson;
  if (row.value !== undefined && row.value !== null) {
    // if string, try to parse JSON; else return as-is
    try {
      if (typeof row.value === "string") return JSON.parse(row.value);
      return row.value;
    } catch {
      return row.value;
    }
  }
  if (row.data !== undefined && row.data !== null) {
    try {
      if (typeof row.data === "string") return JSON.parse(row.data);
      return row.data;
    } catch {
      return row.data;
    }
  }
  return null;
}

async function writeKV(key: string, val: any): Promise<void> {
  const T = getKVModel();
  if (!T) throw new Error("KV model not found in Prisma Client.");

  const existing = typeof T.findFirst === "function" ? await T.findFirst({ where: { key } }) : null;
  const payload =
    T.fields?.json || "json" in (existing ?? {}) // detect json field loosely
      ? { json: val }
      : T.fields?.value || "value" in (existing ?? {})
      ? { value: typeof val === "string" ? val : JSON.stringify(val) }
      : { json: val }; // default to json

  if (existing) {
    // Prefer update by id when present; else by key
    const where =
      existing.id !== undefined
        ? { id: existing.id }
        : { key };
    await T.update({ where, data: { key, ...payload } });
  } else {
    await T.create({ data: { key, ...payload } });
  }
}

/** -----------------------------
 *  Keys
 *  ----------------------------- */
const CURSOR_KEY = (allianceId: number) => `pnw:cursor:${allianceId}`;
const LOGS_KEY = `pnw:apply_logs`;
const SUMMARY_CH_KEY = `pnw:summary_channel`;
const TAX_IDS_KEY = (allianceId: number) => `pnw:tax_ids:${allianceId}`;

/** -----------------------------
 *  Types for logs
 *  ----------------------------- */
export type PnwApplyLogEntry = {
  ts: string; // ISO8601
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: Record<string, number>;
  applied: boolean;
  mode: "apply" | "noop";
};

/** -----------------------------
 *  Cursor helpers
 *  ----------------------------- */
export async function getPnwCursor(allianceId: number): Promise<number | null> {
  const v = await readKV(CURSOR_KEY(allianceId));
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function setPnwCursor(allianceId: number, newestId: number | null): Promise<void> {
  await writeKV(CURSOR_KEY(allianceId), newestId ?? null);
}

/** -----------------------------
 *  Logs helpers
 *  ----------------------------- */
export async function appendPnwApplyLog(entry: PnwApplyLogEntry): Promise<void> {
  const arr = (await readKV(LOGS_KEY)) ?? [];
  const list = Array.isArray(arr) ? arr : [];
  list.push(entry);
  // Keep last 500 entries to bound storage
  const trimmed = list.slice(-500);
  await writeKV(LOGS_KEY, trimmed);
}

export async function getPnwLogs(limit = 50): Promise<PnwApplyLogEntry[]> {
  const arr = (await readKV(LOGS_KEY)) ?? [];
  const list = Array.isArray(arr) ? arr : [];
  const n = Math.max(1, Math.min(limit, 200));
  return list.slice(-n);
}

/** -----------------------------
 *  Summary channel
 *  ----------------------------- */
export async function getPnwSummaryChannel(): Promise<string | null> {
  const v = await readKV(SUMMARY_CH_KEY);
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export async function setPnwSummaryChannel(channelId: string | null): Promise<void> {
  await writeKV(SUMMARY_CH_KEY, channelId ?? null);
}

/** -----------------------------
 *  Tax ID list per alliance
 *  ----------------------------- */
export async function getAllianceTaxIds(allianceId: number): Promise<number[]> {
  const v = await readKV(TAX_IDS_KEY(allianceId));
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

export async function setPnwTaxIds(allianceId: number, ids: number[]): Promise<void> {
  const unique = Array.from(new Set(ids.map((x) => Number(x)).filter((n) => Number.isFinite(n))));
  await writeKV(TAX_IDS_KEY(allianceId), unique);
}

export async function clearAllianceTaxIds(allianceId: number): Promise<void> {
  await writeKV(TAX_IDS_KEY(allianceId), []);
}
