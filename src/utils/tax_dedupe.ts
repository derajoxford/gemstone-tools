// src/utils/tax_dedupe.ts
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.cwd(), "data");
const MAX_IDS = 5000; // keep last 5k applied ids per alliance

function fileFor(allianceId: number) {
  return path.join(DIR, `tax_applied_ids_${allianceId}.json`);
}

export function loadAppliedIds(allianceId: number): Set<number> {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const p = fileFor(allianceId);
    if (!fs.existsSync(p)) return new Set();
    const arr = JSON.parse(fs.readFileSync(p, "utf8")) as number[];
    return new Set(arr.filter((x) => Number.isFinite(x)));
  } catch {
    return new Set();
  }
}

export function saveAppliedIds(allianceId: number, newOnes: number[]) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    const p = fileFor(allianceId);

    const cur = loadAppliedIds(allianceId);
    for (const id of newOnes) cur.add(Number(id) || 0);

    // keep the most recent MAX_IDS numerically
    const arr = Array.from(cur).filter(n => n > 0).sort((a, b) => a - b);
    const trimmed = arr.slice(Math.max(0, arr.length - MAX_IDS));

    fs.writeFileSync(p, JSON.stringify(trimmed), "utf8");
  } catch {}
}
