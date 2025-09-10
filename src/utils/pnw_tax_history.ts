// src/utils/pnw_tax_history.ts
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "var");
const FILE = path.join(DATA_DIR, "pnw_tax_history.json");

// Keep the resource list in one place
export const RES_FIELDS = [
  "money",
  "food",
  "munitions",
  "gasoline",
  "steel",
  "aluminum",
  "oil",
  "uranium",
  "bauxite",
  "coal",
  "iron",
  "lead",
] as const;

export type RawTaxRec = {
  id: number;
  date?: string | null;
  note?: string | null;
  tax_id?: number | null;
} & { [K in (typeof RES_FIELDS)[number]]?: number | null };

type StoreShape = Record<string, RawTaxRec[]>;

async function readStore(): Promise<StoreShape> {
  try {
    const text = await fs.readFile(FILE, "utf8");
    const json = JSON.parse(text);
    return json && typeof json === "object" ? (json as StoreShape) : {};
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(data: StoreShape): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Append new tax records for an alliance, deduping by id.
 * Called by /pnw_apply after a successful apply.
 */
export async function appendTaxHistory(allianceId: number, recs: RawTaxRec[]): Promise<void> {
  if (!recs?.length) return;
  const key = String(allianceId);
  const db = await readStore();
  const cur = db[key] ?? [];

  const seen = new Set(cur.map((r) => r.id));
  const toAdd: RawTaxRec[] = [];
  for (const r of recs) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const clean: RawTaxRec = { id: r.id, date: r.date ?? null, note: r.note ?? null, tax_id: r.tax_id ?? null };
    for (const f of RES_FIELDS) clean[f] = Number(r[f] ?? 0) || 0;
    toAdd.push(clean);
  }
  if (!toAdd.length) return;

  // Keep ascending by id
  const next = [...cur, ...toAdd].sort((a, b) => a.id - b.id);
  db[key] = next;
  await writeStore(db);
}

/** Read all stored tax records for an alliance (ascending by id). */
export async function getTaxHistory(allianceId: number): Promise<RawTaxRec[]> {
  const db = await readStore();
  const list = db[String(allianceId)] ?? [];
  // ensure sorted
  return [...list].sort((a, b) => a.id - b.id);
}

/** Summarize a subset by id/date/limit. */
export async function summarizeTaxHistory(opts: {
  allianceId: number;
  sinceId?: number | null;
  sinceDate?: string | null; // ISO like "2025-09-01"
  untilDate?: string | null; // ISO
  limit?: number | null;     // cap processed count (take most recent N after filtering)
}) {
  const { allianceId, sinceId = null, sinceDate = null, untilDate = null, limit = 1000 } = opts;
  const all = await getTaxHistory(allianceId);

  let filtered = all;

  if (sinceId != null) {
    filtered = filtered.filter((r) => r.id > Number(sinceId));
  }
  const sinceTs = sinceDate ? Date.parse(sinceDate) : NaN;
  const untilTs = untilDate ? Date.parse(untilDate) : NaN;
  if (!Number.isNaN(sinceTs)) {
    filtered = filtered.filter((r) => {
      const ts = r.date ? Date.parse(r.date) : NaN;
      return !Number.isNaN(ts) ? ts >= sinceTs : true;
    });
  }
  if (!Number.isNaN(untilTs)) {
    filtered = filtered.filter((r) => {
      const ts = r.date ? Date.parse(r.date) : NaN;
      return !Number.isNaN(ts) ? ts <= untilTs : true;
    });
  }

  // If a limit is given, keep the most recent N by id
  if (limit && limit > 0 && filtered.length > limit) {
    filtered = filtered.slice(-limit);
  }

  // Sum resources and find newest id
  const delta: Record<string, number> = {};
  let newestId: number | null = null;
  for (const r of filtered) {
    if (newestId === null || r.id > newestId) newestId = r.id;
    for (const f of RES_FIELDS) {
      const v = Number(r[f] ?? 0);
      if (!v) continue;
      delta[f] = (delta[f] ?? 0) + v;
    }
  }
  return { count: filtered.length, newestId, delta };
}
