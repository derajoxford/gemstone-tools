// src/utils/treasury_store.ts
import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "var");
const FILE = path.join(DATA_DIR, "treasury.json");

export const RES_FIELDS = [
  "money","food","munitions","gasoline","steel","aluminum",
  "oil","uranium","bauxite","coal","iron","lead",
] as const;
export type Res = (typeof RES_FIELDS)[number];
export type Balances = Record<Res, number>;

type Store = Record<string, Balances>; // key = allianceId

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const json = JSON.parse(raw);
    return (json && typeof json === "object") ? json as Store : {};
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
}
async function writeStore(s: Store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
}

function empty(): Balances {
  return Object.fromEntries(RES_FIELDS.map(k => [k, 0])) as Balances;
}

export async function getTreasury(allianceId: number): Promise<Balances> {
  const s = await readStore();
  return { ...empty(), ...(s[String(allianceId)] ?? {}) };
}

export async function addToTreasury(allianceId: number, delta: Partial<Balances>) {
  const s = await readStore();
  const key = String(allianceId);
  const cur = { ...empty(), ...(s[key] ?? {}) };
  for (const f of RES_FIELDS) {
    const v = Number((delta as any)[f] ?? 0);
    if (!v) continue;
    cur[f] = Number(cur[f] ?? 0) + v;
  }
  s[key] = cur;
  await writeStore(s);
}

export function formatBalances(b: Balances) {
  // Pretty mono block that fits Discord nicely
  const rows = RES_FIELDS
    .filter(f => (b[f] ?? 0) !== 0)
    .map(f => `${f.padEnd(10)}  ${Number(b[f] ?? 0).toLocaleString()}`);
  return rows.length ? "```\n" + rows.join("\n") + "\n```" : "—";
}
