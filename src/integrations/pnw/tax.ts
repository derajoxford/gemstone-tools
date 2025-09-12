// src/integrations/pnw/tax.ts
import { ORDER } from "../../lib/emojis";

// Resource keys exactly as used in ORDER
type Resource = typeof ORDER[number];

type Row = {
  when?: string;        // "09/09/2025 6:00 pm" (if found)
  who?: string;         // payer text (best-effort)
  amounts: Record<Resource, number>;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s{2,}/g, " ").trim();
}

/**
 * Hit the alliance bank taxes page. It’s public HTML (Cloudflare can challenge).
 */
async function fetchBankTaxesHtml(allianceId: number): Promise<string> {
  const url = `https://politicsandwar.com/alliance/id=${allianceId}&display=banktaxes`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Use very browser-like headers to avoid anti-bot flaky blocks
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Referer": `https://politicsandwar.com/alliance/id=${allianceId}`,
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
    },
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching banktaxes`);
  }
  // Detect common Cloudflare/blocked patterns
  if (/Just a moment/i.test(text) || /cf-browser-verification/i.test(text) || /Cloudflare/i.test(text) && /challenge/i.test(text)) {
    throw new Error("Blocked by Cloudflare/browser challenge");
  }
  // If page is a login wall for some reason
  if (/Log in/i.test(text) && /Forgot Password/i.test(text) && /Create an account/i.test(text)) {
    throw new Error("Login required (unexpected for banktaxes)");
  }
  return text;
}

/** Normalize whitespace for easier regex work */
function normalize(html: string): string {
  return html
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ");
}

/** Extract table header → index mapping for resource columns */
function headerMap(normHtml: string): Map<number, Resource> {
  // Try to capture <thead> first; fallback to the first row with <th>
  let thead = normHtml.match(/<thead[^>]*>(.*?)<\/thead>/i)?.[1];
  if (!thead) {
    // grab first <tr> that contains <th>
    thead = normHtml.match(/<tr[^>]*>(?=[\s\S]*?<th)([\s\S]*?)<\/tr>/i)?.[1] || "";
  }

  const ths = [...thead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => stripTags(m[1]).toLowerCase());
  const map = new Map<number, Resource>();

  function toKey(h: string): Resource | null {
    const t = h.replace(/[^a-z]/g, ""); // letters only
    if (t.includes("money") || t === "cash" || t === "bank") return "money";
    if (t.includes("food")) return "food";
    if (t.includes("coal")) return "coal";
    if (t === "oil" || t.includes("crudeoil")) return "oil";
    if (t.includes("uranium")) return "uranium";
    if (t.includes("lead")) return "lead";
    if (t.includes("iron")) return "iron";
    if (t.includes("bauxite")) return "bauxite";
    if (t.includes("gasoline") || t === "gas" || t.includes("petrol")) return "gasoline";
    if (t.includes("munitions") || t === "muni" || t === "munition") return "munitions";
    if (t.includes("steel")) return "steel";
    if (t.includes("aluminum") || t.includes("aluminium")) return "aluminum";
    return null;
  }

  ths.forEach((h, idx) => {
    const key = toKey(h);
    if (key && ORDER.includes(key)) map.set(idx, key);
  });

  return map;
}

function parseNumberCell(text: string): number {
  // strip everything except digits, decimal point, and minus
  const cleaned = text.replace(/[\$,]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse all tax rows (those containing “Automated Tax”) and read resource cells
 * using the header index map for accuracy.
 */
function parseTaxRowsFromHtml(html: string): Row[] {
  const out: Row[] = [];
  const norm = normalize(html);

  // Build header mapping once
  const colToResource = headerMap(norm);

  // Split table body rows (prefer <tbody> if present)
  let tbody = norm.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!tbody) {
    // fallback: the whole doc (we'll still split on <tr>)
    tbody = norm;
  }

  const trs = tbody.split(/<tr[\s>]/i).slice(1);
  for (const part of trs) {
    const tr = "<tr " + part;
    if (!/Automated\s*Tax/i.test(tr)) continue;

    // Extract <td> cells in this row
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);

    // Derive when (Date) and who (payer) best-effort
    const plainRow = stripTags(tr);
    const whenMatch = plainRow.match(
      /\b(\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm))/i
    );
    const when = whenMatch?.[1];

    // get the cell that actually contains "Automated Tax" for nearby context
    const who = stripTags(tds.find(td => /Automated\s*Tax/i.test(td)) || "");

    // Initialize amounts
    const amounts: Record<Resource, number> = {} as any;
    ORDER.forEach((k) => (amounts[k as Resource] = 0));

    // Walk through each <td>, and if its index is mapped to a resource, parse number
    tds.forEach((td, idx) => {
      const key = colToResource.get(idx);
      if (!key) return;
      const val = parseNumberCell(stripTags(td));
      if (val) amounts[key] += val;
    });

    // Keep only if any positive amount found
    if (ORDER.some((k) => (amounts[k as Resource] || 0) > 0)) {
      out.push({ when, who, amounts });
    }
  }

  return out;
}

/**
 * Public: preview “Automated Tax” rows by scraping the HTML page.
 * This matches how we previously got non-zero counts/totals.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  _lastSeenIdOrNull?: number | null,
  opts?: { limit?: number } // trims newest N rows (page is newest-first)
): Promise<{ count: number; newestId: number | null; delta: Record<Resource, number>; sample?: Row[] }> {
  const html = await fetchBankTaxesHtml(allianceId);
  const rowsAll = parseTaxRowsFromHtml(html);

  const rows = typeof opts?.limit === "number" && opts.limit > 0
    ? rowsAll.slice(0, opts.limit)
    : rowsAll;

  const delta: Record<Resource, number> = {} as any;
  ORDER.forEach((k) => (delta[k as Resource] = 0));

  for (const r of rows) {
    ORDER.forEach((k) => {
      delta[k as Resource] += Number(r.amounts[k as Resource] || 0);
    });
  }

  return {
    count: rows.length,
    newestId: null, // HTML page doesn’t expose bankrec ids
    delta,
    sample: rows.slice(0, 5),
  };
}

/** Used by /pnw_tax_debug to show what we parsed */
export async function debugScrapeAllianceTaxes(
  allianceId: number
): Promise<{ rows: Row[] }> {
  const html = await fetchBankTaxesHtml(allianceId);
  const rows = parseTaxRowsFromHtml(html);
  return { rows };
}
