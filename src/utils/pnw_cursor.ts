// src/utils/pnw_cursor.ts
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const CURSORS_FILE = path.join(DATA_DIR, "pnw_cursors.json");

type MapShape = Record<string, number>; // allianceId -> lastSeen bankrec id

async function readMap(): Promise<MapShape> {
  try {
    const buf = await fs.readFile(CURSORS_FILE);
    return JSON.parse(buf.toString()) as MapShape;
  } catch {
    return {};
  }
}

async function writeMap(m: MapShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CURSORS_FILE, JSON.stringify(m, null, 2));
}

/** Returns the last-seen bankrec id for this alliance, or null if none */
export async function getAllianceCursor(allianceId: number): Promise<number | null> {
  const m = await readMap();
  const v = m[String(allianceId)];
  return Number.isFinite(v) ? v : null;
}

/** Stores the newest bankrec id we’ve processed for this alliance */
export async function setAllianceCursor(allianceId: number, newestId: number): Promise<void> {
  if (!Number.isFinite(newestId)) return;
  const m = await readMap();
  m[String(allianceId)] = newestId;
  await writeMap(m);
}

/** Optional helpers used elsewhere */
export async function clearAllianceCursor(allianceId: number): Promise<void> {
  const m = await readMap();
  delete m[String(allianceId)];
  await writeMap(m);
}

export async function getAllCursors(): Promise<MapShape> {
  return readMap();
}
