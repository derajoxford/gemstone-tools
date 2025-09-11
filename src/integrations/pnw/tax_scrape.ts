// src/integrations/pnw/tax_scrape.ts
// Scrapes https://politicsandwar.com/alliance/id=<ID>&display=banktaxes
// and extracts rows whose Note/Reason contains "Automated Tax".

import crypto from "node:crypto";

export type ResourceKey =
  | "money" | "food" | "coal" | "oil" | "uranium" | "lead" | "iron"
  | "bauxite" | "gasoline" | "munitions" | "steel" | "aluminum";

export type ResourceDelta = Partial<Record<ResourceKey, number>>;

export type TaxRow = {
  at: number;              // epoch ms
  note: string;            // raw note/reason text
  delta: ResourceDelta;    // amounts credited to alliance
  keyHash: string;         // stable hash for this row (used for debugging if needed)
};

const ORDER: ResourceKey[] = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
];

function stripTags(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, "")
             .replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&bull;/g, "•")
             .trim();
}

function parseNumberLike(s: string) {
  // Accept $ for money, commas, percent, etc.; keep digits, dot, minus
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseUsDateLike(s: string): number {
  // e.g. "09/09/2025 6:00 pm"
  // try Date.parse first; then manual fallback
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;

  const m = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (m) {
    let [ , mm, dd, yyyy, hh, mi, ap ] = m;
    const year = Number(yyyy.length === 2 ? "20" + yyyy : yyyy);
    let hour = Number(hh);
    const min = Number(mi);
    const pm = ap.toLowerCase() === "pm";
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    const dt = new Date(year, Number(mm) - 1, Number(dd), hour, min, 0, 0);
    return dt.getTime();
  }
  return Date.now();
}

function sha1(s: string) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// Map table header text -> resource key / special columns
const HEADER_MAP: Record<string, ResourceKey | "_date" | "_note" | "_ignore"> = {
  "date": "_date",
  "time": "_date",
  "nation": "_ignore",
  "tax bracket": "_ignore",
  "reason": "_note",
  "note": "_note",
  "money": "money",
  "food": "food",
  "coal": "coal",
  "oil": "oil",
  "uranium": "uranium",
  "lead": "lead",
  "iron": "iron",
  "bauxite": "bauxite",
  "gasoline": "gasoline",
  "munitions": "munitions",
  "steel": "steel",
  "aluminum": "aluminum",
};

function normHeader(h: string) {
  return stripTags(h).toLowerCase().replace(/\s+/g, " ").trim();
}

export async function scrapeAllianceAutomatedTaxes(allianceId: number): Promise<TaxRow[]> {
  const url = `https://politicsandwar.com/alliance/id=${encodeURIComponent(allianceId)}&display=banktaxes`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "GemstoneTools/1.0 (+pnw tax scrape)",
    },
  });
  const html = await res.text();

  // Find the first <table> on the page that appears to be the tax table
  // (has headers including "Money" and "Food").
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);
  let target: string | null = null;

  for (const t of tables) {
    const headerBlock = (t.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || t.match(/<tr[\s\S]*?<\/tr>/i)?.[0] || "");
    const headerCells = [...headerBlock.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1]);
    const headerText = headerCells.map(c => normHeader(c));
    if (headerText.some(h => h === "money") && headerText.some(h => h === "food")) {
      target = t; break;
    }
  }
  if (!target) return [];

  // Build column map
  const thead = target.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || target;
  const headerCells = [...thead.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1]);
  const headers = headerCells.map(c => normHeader(c));

  const colMap = headers.map((h) => {
    // pick exact match, else try loose
    if (HEADER_MAP[h]) return HEADER_MAP[h];
    const loose = Object.keys(HEADER_MAP).find(k => h.includes(k));
    return loose ? HEADER_MAP[loose] : "_ignore";
  });

  // Get body rows
  const tbody = target.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || target;
  const rowHtmls = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);

  const out: TaxRow[] = [];

  for (const rowHtml of rowHtmls) {
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);

    if (!tds.length) continue;

    // Build per-row values
    let atMs = 0;
    let noteText = "";
    const deltas: ResourceDelta = {};

    for (let idx = 0; idx < tds.length && idx < colMap.length; idx++) {
      const tag = colMap[idx];
      const cellRaw = tds[idx] || "";
      const cell = stripTags(cellRaw);

      if (tag === "_date") {
        atMs = parseUsDateLike(cell);
      } else if (tag === "_note") {
        noteText = cell;
      } else if (tag !== "_ignore") {
        // Resource column
        const v = parseNumberLike(cell);
        if (v) deltas[tag] = (deltas[tag] ?? 0) + v;
      }
    }

    // Only count "Automated Tax" rows
    if (!/automated\s+tax/i.test(noteText)) continue;

    // Guard: need a timestamp
    if (!atMs) continue;

    // Normalize: ensure all ORDER keys exist (as numbers, default 0)
    for (const k of ORDER) deltas[k] = Number(deltas[k] ?? 0);

    // Row key for debugging
    const keyHash = sha1(`${allianceId}|${atMs}|${ORDER.map(k => deltas[k]).join("|")}|${noteText}`);

    out.push({ at: atMs, note: noteText, delta: deltas, keyHash });
  }

  // Sort ascending by time (oldest first)
  out.sort((a, b) => a.at - b.at);
  return out;
}
