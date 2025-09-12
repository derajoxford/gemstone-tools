// src/integrations/pnw/tax.ts
import fs from "node:fs/promises";
import path from "node:path";

export type TaxRow = {
  id?: number;                 // not on the HTML page; left for future use
  dateISO?: string;            // parsed date if present
  nationName?: string | null;  // who paid (if present)
  note?: string | null;        // "Automated Tax ..." etc
  money?: number;
  food?: number;
  coal?: number;
  oil?: number;
  uranium?: number;
  lead?: number;
  iron?: number;
  bauxite?: number;
  gasoline?: number;
  munitions?: number;
  steel?: number;
  aluminum?: number;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;     // HTML page has no ids; always null for now
  delta: Record<string, number>;
  debug?: {
    fetchedBytes: number;
    blocked: boolean;
    matchedTable: boolean;
    matchedRows: number;
    savedFile?: string;
  };
};

const DATA_DIR = path.join(process.cwd(), "var");
const DEBUG_DIR = path.join(DATA_DIR, "pnw_tax_html");
const UA =
  process.env.PNW_SCRAPE_UA ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const COMMON_RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum",
] as const;

function toNum(x: string | number | null | undefined): number {
  if (x == null) return 0;
  const s = String(x).replace(/[,_\s$]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function zeroDelta(): Record<string, number> {
  const d: Record<string, number> = {};
  for (const k of COMMON_RES_KEYS) d[k] = 0;
  return d;
}

// --- fetch the bank taxes HTML with realistic headers and optional cookie ---
export async function fetchBankTaxesHTML(allianceId: number): Promise<string> {
  const url = `https://politicsandwar.com/alliance/id=${allianceId}&display=banktaxes`;
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
  // If you add a cookie in the env (see README/ops), we’ll send it.
  const cookie = process.env.PNW_CF_COOKIE || process.env.PNW_COOKIE;
  if (cookie) headers["Cookie"] = cookie;

  const res = await fetch(url, { headers, redirect: "follow" as RequestRedirect });
  const html = await res.text();
  return html;
}

// --- extremely defensive HTML parser for bank taxes table ---
export function parseBankTaxes(html: string): { rows: TaxRow[], blocked: boolean, matchedTable: boolean } {
  const text = html || "";
  const lc = text.toLowerCase();

  // detect challenge / login / captcha pages in a few common ways
  const blocked =
    lc.includes("just a moment") ||
    lc.includes("cf-") ||
    lc.includes("cloudflare") ||
    lc.includes("cf-chl") ||
    lc.includes("please enable javascript") ||
    lc.includes("login") && lc.includes("password") && lc.includes("username");

  // try to find the bank taxes table by headline/keywords
  const matchedTable =
    lc.includes("bank taxes") ||
    lc.includes("automated tax") ||
    lc.includes("collected taxes");

  // very loose row extraction:
  // - grab lines that contain "Automated Tax"
  // - then extract resource amounts like $12,345,678 or 1,234.56
  const rows: TaxRow[] = [];

  const lineRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const trList = text.match(lineRegex) || [];

  for (const tr of trList) {
    if (!/Automated\s*Tax/i.test(tr)) continue;

    const row: TaxRow = { note: null };

    // note / payer (best-effort)
    const noteMatch = tr.match(/Automated\s*Tax[^<]{0,120}/i);
    row.note = noteMatch ? noteMatch[0].trim() : "Automated Tax";

    // date (best-effort)
    const dateCell =
      tr.match(/<td[^>]*>\s*\d{1,2}\/\d{1,2}\/\d{2,4}[^<]*<\/td>/i) ||
      tr.match(/\d{4}-\d{2}-\d{2}[^<]*/i);
    if (dateCell) {
      const ds = dateCell[0].replace(/<[^>]+>/g, "").trim();
      // let Date try its best:
      const d = new Date(ds);
      if (!isNaN(d.getTime())) row.dateISO = d.toISOString();
    }

    // resources (VERY loose; picks 12,345 or 12,345.67 and $12,345 forms)
    const grab = (re: RegExp) => {
      const m = tr.match(re);
      return m ? toNum(m[1] || m[0]) : 0;
    };

    // money (look for $ first)
    row.money =
      grab(/\$([0-9][0-9,\.]*)/) ||
      grab(/money[^0-9\-]*([0-9][0-9,\.]*)/i);

    // others (look for headings/labels in the row text)
    const lower = tr.replace(/<[^>]+>/g, " ").toLowerCase();

    function pick(label: string) {
      const m =
        lower.match(new RegExp(`${label}[^0-9\\-]*([0-9][0-9,\\.]*)`)) ||
        tr.match(new RegExp(`${label}[^0-9\\-]*([0-9][0-9,\\.]*)`, "i"));
      return m ? toNum(m[1]) : 0;
    }

    row.aluminum = pick("aluminum");
    row.bauxite  = pick("bauxite");
    row.steel    = pick("steel");
    row.munitions= pick("munitions");
    row.gasoline = pick("gasoline");
    row.iron     = pick("iron");
    row.lead     = pick("lead");
    row.uranium  = pick("uranium");
    row.coal     = pick("coal");
    row.oil      = pick("oil");
    row.food     = pick("food");

    // only push if at least one positive value present
    const any =
      (row.money||0)+(row.food||0)+(row.coal||0)+(row.oil||0)+(row.uranium||0)+
      (row.lead||0)+(row.iron||0)+(row.bauxite||0)+(row.gasoline||0)+(row.munitions||0)+
      (row.steel||0)+(row.aluminum||0);

    if (any > 0 || /Automated\s*Tax/i.test(row.note || "")) {
      rows.push(row);
    }
  }

  return { rows, blocked, matchedTable };
}

// main preview used by /pnw_preview and /pnw_apply
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  _lastSeenId?: number | null,  // ignored for HTML (no ids)
  limit?: number | null
): Promise<PreviewResult> {
  const html = await fetchBankTaxesHTML(allianceId);
  const { rows, blocked, matchedTable } = parseBankTaxes(html);

  // (optional) trim to limit most-recent rows if we can infer ordering
  const limited = limit && limit > 0 ? rows.slice(0, limit) : rows;

  const delta = zeroDelta();
  for (const r of limited) {
    for (const k of COMMON_RES_KEYS) {
      const v = toNum((r as any)[k]);
      if (v) delta[k] += v;
    }
  }

  const result: PreviewResult = {
    count: limited.length,
    newestId: null,
    delta,
    debug: {
      fetchedBytes: html.length,
      blocked,
      matchedTable,
      matchedRows: limited.length,
    },
  };

  // if *nothing* matched, save a debug HTML to var/pnw_tax_html/ so we can inspect
  if (limited.length === 0) {
    try {
      await fs.mkdir(DEBUG_DIR, { recursive: true });
      const f = path.join(DEBUG_DIR, `alliance-${allianceId}-${Date.now()}.html`);
      await fs.writeFile(f, html, "utf8");
      result.debug!.savedFile = f;
    } catch {}
  }

  return result;
}
