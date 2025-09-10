// src/utils/treasury.ts
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "var");
const FILE = path.join(DATA_DIR, "treasury.json");

export type Treasury = Record<string, number>; // resource -> amount
type DbShape = Record<string, Treasury>;       // allianceId -> treasury

async function readDb(): Promise<DbShape> {
  try {
    const text = await fs.readFile(FILE, "utf8");
    const json = JSON.parse(text);
    return (json && typeof json === "object") ? json as DbShape : {};
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeDb(db: DbShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(db, null, 2), "utf8");
}

function addInto(base: Treasury, delta: Treasury): Treasury {
  const out: Treasury = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    const n = Number(v || 0);
    if (!n) continue;
    out[k] = Number(out[k] || 0) + n;
  }
  return out;
}

export async function getTreasury(allianceId: number): Promise<Treasury> {
  const db = await readDb();
  return db[String(allianceId)] ?? {};
}

/**
 * Merge delta into alliance treasury and persist.
 * Optional 'meta' is ignored here but kept for API compatibility with callers.
 */
export async function addToTreasury(
  allianceId: number,
  delta: Treasury,
  _meta?: any,
): Promise<Treasury> {
  const db = await readDb();
  const cur = db[String(allianceId)] ?? {};
  const next = addInto(cur, delta);
  db[String(allianceId)] = next;
  await writeDb(db);
  return next;
}
