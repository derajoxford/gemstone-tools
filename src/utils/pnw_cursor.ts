// src/utils/pnw_cursor.ts
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * File-backed storage for:
 *  - PnW bankrec cursor per alliance
 *  - Apply logs (/pnw_logs)
 *  - Summary channel per guild (/pnw_summary_channel)
 *
 * Keeps things schema-agnostic and avoids Prisma coupling.
 */

const STORAGE_DIR = path.join(process.cwd(), "storage");
const CURSOR_FILE = path.join(STORAGE_DIR, "pnw-cursor.json");              // { [allianceId]: number }
const LOG_FILE    = path.join(STORAGE_DIR, "pnw-apply-logs.json");          // PnwApplyLogEntry[]
const SUMMARY_FILE= path.join(STORAGE_DIR, "pnw-summary-channels.json");    // { [guildId]: channelId }

type CursorMap = Record<string, number>;

export type PnwApplyLogEntry = {
  ts: string; // ISO timestamp
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: Record<string, number>;
  applied: boolean;
  mode: "apply" | "noop" | "error";
  note?: string;
};

async function ensureDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(file: string, data: T): Promise<void> {
  await ensureDir();
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

/* -------------------- Cursor helpers -------------------- */

export async function getPnwCursor(allianceId: number): Promise<number | null> {
  const map = await readJson<CursorMap>(CURSOR_FILE, {});
  const key = String(allianceId);
  return Object.prototype.hasOwnProperty.call(map, key) ? Number(map[key]) : null;
}

export async function setPnwCursor(allianceId: number, newestId: number | null): Promise<void> {
  const map = await readJson<CursorMap>(CURSOR_FILE, {});
  const key = String(allianceId);
  if (newestId === null || newestId === undefined) {
    delete map[key];
  } else {
    map[key] = Number(newestId);
  }
  await writeJson(CURSOR_FILE, map);
}

/* -------------------- Apply log helpers -------------------- */

export async function appendPnwApplyLog(entry: PnwApplyLogEntry): Promise<void> {
  const arr = await readJson<PnwApplyLogEntry[]>(LOG_FILE, []);
  arr.push({ ...entry, ts: entry.ts ?? new Date().toISOString() });
  // retain last 1000 only
  const sliced = arr.slice(-1000);
  await writeJson(LOG_FILE, sliced);
}

export async function getPnwLogs(limit = 50): Promise<PnwApplyLogEntry[]> {
  const arr = await readJson<PnwApplyLogEntry[]>(LOG_FILE, []);
  arr.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  return arr.slice(0, limit);
}

/* -------------------- Summary channel helpers -------------------- */

export async function getPnwSummaryChannel(guildId: string): Promise<string | null> {
  const map = await readJson<Record<string, string>>(SUMMARY_FILE, {});
  return map[guildId] ?? null;
}

export async function setPnwSummaryChannel(guildId: string, channelId: string): Promise<void> {
  const map = await readJson<Record<string, string>>(SUMMARY_FILE, {});
  map[guildId] = channelId;
  await writeJson(SUMMARY_FILE, map);
}
