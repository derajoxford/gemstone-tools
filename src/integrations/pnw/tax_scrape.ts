// src/integrations/pnw/tax_scrape.ts
// Scrapes https://politicsandwar.com/alliance/id=<ID>&display=banktaxes
// and extracts rows whose Note/Reason contains "Automated Tax" (any brackets).

import crypto from "node:crypto";

export type ResourceKey =
  | "money" | "food" | "coal" | "oil" | "uranium" | "lead" | "iron"
  | "bauxite" | "gasoline" | "munitions" | "steel" | "aluminum";

export type ResourceDelta = Partial<Record<ResourceKey, number>>;

export type TaxRow = {
  at: number;              // epoch ms
  note: string;            // raw note/reason text
  delta: ResourceDelta;    // amounts credited to alliance
  keyHash: string;         // stable hash for this row (debug)
};

const ORDER: ResourceKey[] = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
];

function dbg(...args: any[]) {
  if (process.env.DEBUG_TAX === "1") console.log("[TAXSCRAPE]", ...args);
}

function stripTags(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&bull;/g, "•")
             .trim();
}

function parseNumberLike(s: string) {
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseUsDateLike(s: string): number {
  // try native parse first
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;

  // common PnW style: "09/09/2025 6:00 pm"
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
  return 0;
}

function sha1(s: string) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

// Loose header mapping
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

function hasBlockers(html: string) {
  const lo = html.toLowerCase();
  return lo.includes("cloudflare") && lo.includes("enable javascript");
}

export async function scrapeAllianceAutomatedTaxes(allianceId: number): Promise<TaxRow[]> {
  const url = `https://politicsandwar.com/alliance/id=${encodeURIComponent(allianceId)}&display=banktaxes`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "GemstoneTools/1.0 (tax-scrape)",
      "Referer": `https://politicsandwar.com/alliance/id=${encodeURIComponent(allianceId)}`,
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });

  const html = await res.text();
  dbg("status", res.status, "len", html.length);

  if (!res.ok || html.length < 200) {
    dbg("bad response");
    return [];
  }
  if (hasBlockers(html)) {
    dbg("cloudflare/js blocker detected");
    return [];
  }

  // Try to find the tax table:
  // Strategy:
  //  1) Prefer tables that include Money & Food headers
  //  2) Fallback: any <table> with ≥ 8 numeric-looking columns and any row containing "Automated Tax"
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);
  dbg("tables found", tables.length);

  let target: string | null = null;

  // Helper to extract headers
  const getHeaders = (t: string) => {
    const thead = t.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "";
    const headerRow = thead || (t.match(/<tr[\s\S]*?<\/tr>/i)?.[0] || "");
    const headerCells = [...headerRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1]);
    return headerCells.map(c => normHeader(c));
  };

  for (const t of tables) {
    const headers = getHeaders(t);
    if (headers.some(h => h === "money") && headers.some(h => h === "food")) {
      target = t; break;
    }
  }

  if (!target) {
    // fallback: pick the first table that has any row including "Automated Tax"
    for (const t of tables) {
      if (/automated\s+tax/i.test(stripTags(t))) { target = t; break; }
    }
  }

  if (!target) {
    dbg("no suitable table found");
    return [];
  }

  // Build column map (loose)
  const thead = target.match(/<thead[\s\S]*?<\/thead>/i)?.[0] || "";
  const headerRow = thead || (target.match(/<tr[\s\S]*?<\/tr>/i)?.[0] || "");
  const headerCells = [...headerRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(m => m[1]);
  const headers = headerCells.map(c => normHeader(c));
  dbg("headers", headers);

  const colMap = headers.length
    ? headers.map((h) => {
        if (HEADER_MAP[h]) return HEADER_MAP[h];
        const loose = Object.keys(HEADER_MAP).find(k => h.includes(k));
        return loose ? HEADER_MAP[loose] : "_ignore";
      })
    : [];

  // Get body rows
  const tbody = target.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || target;
  const rowHtmls = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  dbg("row candidates", rowHtmls.length);

  // If we had no headers at all, fallback to a fixed column order seen on PnW:
  // [Date, Nation, Tax Bracket, Reason, Money, Food, Coal, Oil, Uranium, Lead, Iron, Bauxite, Gasoline, Munitions, Steel, Aluminum]
  const fallbackColTags: (ResourceKey | "_date" | "_note" | "_ignore")[] = [
    "_date","_ignore","_ignore","_note","money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum"
  ];

  const out: TaxRow[] = [];

  for (const rowHtml of rowHtmls) {
    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (!tds.length) continue;

    // Skip rows that clearly aren’t Automated Tax to reduce work
    if (!/automated\s+tax/i.test(stripTags(rowHtml))) continue;

    const tags = colMap.length ? colMap : fallbackColTags;
    let atMs = 0;
    let noteText = "";
    const deltas: ResourceDelta = {};

    for (let idx = 0; idx < tds.length && idx < tags.length; idx++) {
      const tag = tags[idx];
      const cell = stripTags(tds[idx] || "");

      if (tag === "_date") {
        atMs = parseUsDateLike(cell);
      } else if (tag === "_note") {
        noteText = cell;
      } else if (tag !== "_ignore") {
        const v = parseNumberLike(cell);
        if (v) deltas[tag] = (deltas[tag] ?? 0) + v;
      }
    }

    if (!/automated\s+tax/i.test(noteText)) {
      // If header mapping didn’t align, still allow — we already filtered the row by regex.
    }
    if (!atMs) continue;

    for (const k of ORDER) deltas[k] = Number(deltas[k] ?? 0);
    const keyHash = sha1(`${allianceId}|${atMs}|${ORDER.map(k => deltas[k]).join("|")}|${noteText}`);
    out.push({ at: atMs, note: noteText, delta: deltas, keyHash });
  }

  out.sort((a, b) => a.at - b.at);
  dbg("rows parsed", out.length);
  return out;
}
