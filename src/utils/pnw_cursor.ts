// src/utils/pnw_cursor.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const CURSORS = join(DATA_DIR, "pnw_cursors.json");
const LOGFILE = join(DATA_DIR, "pnw_apply.log");

type CursorMap = Record<string, number | null>;
type LogEntry = {
  ts: string;
  allianceId: number;
  action: "noop" | "apply" | "error";
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta?: Record<string, number>;
  note?: string;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readCursors(): Promise<CursorMap> {
  try {
    const raw = await fs.readFile(CURSORS, "utf8");
    return JSON.parse(raw) as CursorMap;
  } catch {
    return {};
  }
}

async function writeCursors(map: CursorMap) {
  await ensureDir();
  await fs.writeFile(CURSORS, JSON.stringify(map, null, 2), "utf8");
}

/** Get the last seen bankrec id for an alliance (or null if none) */
export async function getPnwCursor(allianceId: number): Promise<number | null> {
  const map = await readCursors();
  return map[String(allianceId)] ?? null;
}

/** Update the last seen bankrec id for an alliance */
export async function setPnwCursor(allianceId: number, id: number | null): Promise<void> {
  const map = await readCursors();
  map[String(allianceId)] = id ?? null;
  await writeCursors(map);
}

/** Append a small JSON log line for observability */
export async function appendPnwApplyLog(entry: LogEntry): Promise<void> {
  await ensureDir();
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(LOGFILE, line, "utf8");
}
