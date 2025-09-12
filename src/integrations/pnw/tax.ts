// src/integrations/pnw/tax.ts
import { ORDER } from "../../lib/emojis";

// Keys we sum into (matches ORDER)
type Resource = typeof ORDER[number];
type Row = {
  when?: string;        // e.g., "09/09/2025 6:00 pm" if we can parse it
  who?: string;         // nation/alliance text if present
  amounts: Record<Resource, number>;
};

/**
 * Fetch raw HTML for the alliance banktaxes page.
 */
async function fetchBankTaxesHtml(allianceId: number): Promise<string> {
  const url = `https://politicsandwar.com/alliance/id=${allianceId}&display=banktaxes`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      // Be nice & avoid CF anti-bot heuristics
      "User-Agent":
        "GemstoneTools/1.0 (+https://github.com/derajoxford/gemstone-tools)",
      "Accept": "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} on banktaxes page. Body starts: ${body.slice(0, 160)}`
    );
  }
  return await res.text();
}

/**
 * Very robust HTML -> rows parser:
 * - Finds <tr> blocks that contain "Automated Tax"
 * - Collects right-aligned numeric <td> cells as amounts (money, food, coal... per ORDER)
 * - Tries to pull a timestamp and the payer text, when available
 *
 * NOTE: PnW HTML can change. This is written to be forgiving:
 *   - looks for the literal "Automated Tax" anywhere in a row
 *   - treats any <td class="right">NUMBER</td> as a resource column in ORDER
 */
function parseTaxRowsFromHtml(html: string): Row[] {
  const rows: Row[] = [];

  // Normalize
  const norm = html
    .replace(/\r/g, "")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ");

  // Split into <tr> chunks
  const trParts = norm.split(/<tr[\s>]/i).slice(1);

  for (const part of trParts) {
    const tr = "<tr " + part; // reconstruct

    // Must contain literal Automated Tax text
    if (!/Automated\s*Tax/i.test(tr)) continue;

    // Try to pull a timestamp like "09/09/2025 6:00 pm"
    const whenMatch = tr.match(
      /\b(\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:am|pm))/i
    );
    const when = whenMatch?.[1];

    // Try to pull a "who" (payer) — crude but helpful for debug
    // Look for the cell that contains the "Automated Tax" text and grab sibling text
    let who: string | undefined;
    {
      const whoCell = tr
        .split(/<\/td>/i)
        .find((td) => /Automated\s*Tax/i.test(td));
      if (whoCell) {
        // Sometimes the nation/alliance text is right after that cell in the same row;
        // fallback: strip tags & compress
        who = whoCell
          .replace(/<[^>]*>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
    }

    // Grab every right-aligned number cell
    // Example cell: <td class="right">$250,000,000</td> or <td class="right">4,154.94</td>
    const numCells: number[] = [];
    const re = /<td[^>]*class="[^"]*\bright\b[^"]*"[^>]*>\s*([$])?\s*([0-9][\d,]*(?:\.\d+)?)\s*<\/td>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tr))) {
      const raw = m[2].replace(/,/g, "");
      const val = Number(raw);
      if (Number.isFinite(val)) numCells.push(val);
    }

    // Map onto ORDER. If there are more numeric cells than ORDER,
    // we simply take the first ORDER.length — PnW tax table puts
    // resource columns to the right.
    const amounts: Record<Resource, number> = {} as any;
    for (let idx = 0; idx < ORDER.length; idx++) {
      const key = ORDER[idx] as Resource;
      const val = numCells[idx] ?? 0;
      amounts[key] = Number(val) || 0;
    }

    // Only keep rows that actually have any positive resource
    const anyPos = ORDER.some((k) => (amounts[k] || 0) > 0);
    if (!anyPos) continue;

    rows.push({ when, who, amounts });
  }

  return rows;
}

/**
 * Public: preview tax credits using the stored-key approach in commands,
 * but this function does NOT need the key (the HTML page is public).
 *
 * Returns a sum (delta) and a simple count of matched rows.
 *
 * Note: newestId is null because the HTML table does not expose a bankrec id.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  _lastSeenIdOrNull?: number | null,
  opts?: { limit?: number } // limit rows summed (most-recent first)
): Promise<{ count: number; newestId: number | null; delta: Record<Resource, number>; sample?: Row[] }> {
  const html = await fetchBankTaxesHtml(allianceId);
  const allRows = parseTaxRowsFromHtml(html);

  // Newest-first: the page lists newest first; keep that behavior
  const rows = typeof opts?.limit === "number" && opts.limit > 0
    ? allRows.slice(0, opts.limit)
    : allRows;

  const delta: Record<Resource, number> = {} as any;
  for (const k of ORDER) delta[k as Resource] = 0;

  for (const r of rows) {
    for (const k of ORDER) {
      delta[k as Resource] += Number(r.amounts[k as Resource] || 0);
    }
  }

  return {
    count: rows.length,
    newestId: null, // HTML source — no numeric id
    delta,
    sample: rows.slice(0, 5), // for debug
  };
}

/**
 * Debug helper used by /pnw_tax_debug
 */
export async function debugScrapeAllianceTaxes(
  allianceId: number
): Promise<{ rows: Row[] }> {
  const html = await fetchBankTaxesHtml(allianceId);
  const rows = parseTaxRowsFromHtml(html);
  return { rows };
}
