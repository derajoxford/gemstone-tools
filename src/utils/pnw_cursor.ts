// src/utils/pnw_cursor.ts
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");
const CURSORS_FILE = path.join(DATA_DIR, "pnw_cursors.json");
const LOG_FILE = path.join(DATA_DIR, "pnw_apply_log.json");
const MAX_LOG_ENTRIES = 500;

type CursorMap = Record<string, number | null>;
type ResourceDelta = Record<string, number>;

export type PnwApplyLogEntry = {
  ts: string;                // ISO timestamp
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: ResourceDelta;
  applied: boolean;
  mode: "apply" | "noop";
};

// ---- tiny JSON helpers ------------------------------------------------------

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJSON<T>(file: string, fallback: T): Promise<T> {
  try {
    const buf = await fs.readFile(file);
    return JSON.parse(buf.toString()) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON(file: string, data: any) {
  await ensureDir();
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// ---- public API used by /pnw_apply -----------------------------------------

/** Read the saved cursor for an alliance (last applied bankrec id). */
export async function getPnwCursor(allianceId: number): Promise<number | null> {
  const map = await readJSON<CursorMap>(CURSORS_FILE, {});
  const k = String(allianceId);
  return (k in map) ? (map[k] ?? null) : null;
}

/** Persist/advance the cursor for an alliance. */
export async function setPnwCursor(allianceId: number, newestId: number | null): Promise<void> {
  const map = await readJSON<CursorMap>(CURSORS_FILE, {});
  map[String(allianceId)] = newestId ?? null;
  await writeJSON(CURSORS_FILE, map);
}

/** Append an apply log entry and keep only the latest MAX_LOG_ENTRIES. */
export async function appendPnwApplyLog(entry: PnwApplyLogEntry): Promise<void> {
  const list = await readJSON<PnwApplyLogEntry[]>(LOG_FILE, []);
  list.push({ ...entry, ts: new Date().toISOString() });
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  await writeJSON(LOG_FILE, list);
}

// ---- optional helpers (if you later add a /pnw_logs command) ----------------

export async function readPnwApplyLogs(limit = 50): Promise<PnwApplyLogEntry[]> {
  const list = await readJSON<PnwApplyLogEntry[]>(LOG_FILE, []);
  return list.slice(-limit);
}

// Alias used by /pnw_logs command
export async function getPnwLogs(limit = 50) {
  return readPnwApplyLogs(limit);
}
// --- Add this at the end of src/utils/pnw_cursor.ts ---

// If not already present in this file:
export type PnwApplyLogEntry = {
  ts?: string;                // ISO timestamp
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta?: Record<string, number>;
  applied: boolean;
  mode: "apply" | "noop";
  reason?: string;
};

/**
 * Best-effort fetch of the most recent apply logs.
 * 1) If a Prisma model exists (pnwApplyLog), read from it.
 * 2) Otherwise, try a local JSONL file (storage/pnw-apply.log.ndjson).
 * 3) Fallback to empty list.
 */
export async function getPnwLogs(limit = 20): Promise<PnwApplyLogEntry[]> {
  try {
    // @ts-ignore - Optional model; only use if it exists
    if ((prisma as any)?.pnwApplyLog?.findMany) {
      const rows = await (prisma as any).pnwApplyLog.findMany({
        orderBy: { id: "desc" },
        take: limit,
      });
      return rows.map((r: any) => ({
        ts: r.ts ?? r.createdAt?.toISOString?.() ?? new Date().toISOString(),
        allianceId: Number(r.allianceId ?? 0),
        lastSeenId: r.lastSeenId ?? null,
        newestId: r.newestId ?? null,
        records: Number(r.records ?? 0),
        delta: r.delta ?? {},
        applied: !!r.applied,
        mode: (r.mode as "apply" | "noop") ?? "noop",
        reason: r.reason ?? undefined,
      }));
    }
  } catch {
    // ignore and try file fallback
  }

  // File fallback (optional)
  try {
    const { readFile } = await import("node:fs/promises");
    const path = `${process.cwd()}/storage/pnw-apply.log.ndjson`;
    const text = await readFile(path, "utf8").catch(() => "");
    if (text) {
      const lines = text.trim().split("\n").slice(-limit);
      return lines.map((l) => JSON.parse(l));
    }
  } catch {
    // ignore
  }

  return [];
}

