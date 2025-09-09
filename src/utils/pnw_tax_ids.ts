// src/utils/pnw_tax_ids.ts
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "var");
const FILE = path.join(DATA_DIR, "pnw_tax_ids.json");

type StoreShape = Record<string, number[]>;

async function readStore(): Promise<StoreShape> {
  try {
    const text = await fs.readFile(FILE, "utf8");
    const json = JSON.parse(text);
    return (json && typeof json === "object") ? json as StoreShape : {};
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(data: StoreShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf8");
}

function dedupeInts(arr: (number | string)[]): number[] {
  return Array.from(
    new Set(
      arr.map(n => Number(n)).filter(n => Number.isFinite(n))
    )
  );
}

export async function getAllowedTaxIds(allianceId: number): Promise<number[]> {
  const db = await readStore();
  return dedupeInts(db[String(allianceId)] ?? []);
}

export async function setAllowedTaxIds(allianceId: number, ids: (number | string)[]): Promise<void> {
  const db = await readStore();
  db[String(allianceId)] = dedupeInts(ids);
  await writeStore(db);
}

export async function addAllowedTaxId(allianceId: number, id: number | string): Promise<void> {
  const current = await getAllowedTaxIds(allianceId);
  const next = dedupeInts([...current, id]);
  await setAllowedTaxIds(allianceId, next);
}

export async function removeAllowedTaxId(allianceId: number, id: number | string): Promise<void> {
  const current = await getAllowedTaxIds(allianceId);
  const rm = Number(id);
  const next = current.filter(x => x !== rm);
  await setAllowedTaxIds(allianceId, next);
}
