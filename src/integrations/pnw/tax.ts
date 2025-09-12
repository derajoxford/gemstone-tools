// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, BankrecRow } from "../../lib/pnw.js";

const prisma = new PrismaClient();

export type ResourceDelta = Record<string, number>;
type PreviewResult = { count: number; newestId: number | null; delta: ResourceDelta };

function isPositive(n: any) { return Number.isFinite(n) && Number(n) > 0; }
function toNum(v: any) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function isTaxRow(r: BankrecRow, allianceId: number): boolean {
  // Receiver is the alliance
  if (!(r.receiver_type === 2 && Number(r.receiver_id) === Number(allianceId))) return false;

  // PnW may flag tax rows with tax_id, or just via the note.
  const taxId = Number(r.tax_id ?? 0);
  const note = (r.note || "").toLowerCase();

  return (taxId > 0) || note.includes("automated tax");
}

function applyDelta(acc: ResourceDelta, r: BankrecRow): void {
  acc.money      = (acc.money ?? 0)      + toNum(r.money);
  acc.food       = (acc.food ?? 0)       + toNum(r.food);
  acc.coal       = (acc.coal ?? 0)       + toNum(r.coal);
  acc.oil        = (acc.oil ?? 0)        + toNum(r.oil);
  acc.uranium    = (acc.uranium ?? 0)    + toNum(r.uranium);
  acc.lead       = (acc.lead ?? 0)       + toNum(r.lead);
  acc.iron       = (acc.iron ?? 0)       + toNum(r.iron);
  acc.bauxite    = (acc.bauxite ?? 0)    + toNum(r.bauxite);
  acc.gasoline   = (acc.gasoline ?? 0)   + toNum(r.gasoline);
  acc.munitions  = (acc.munitions ?? 0)  + toNum(r.munitions);
  acc.steel      = (acc.steel ?? 0)      + toNum(r.steel);
  acc.aluminum   = (acc.aluminum ?? 0)   + toNum(r.aluminum);
}

/**
 * Fetch recent bankrecs and compute tax-only delta since lastSeenId.
 * limit is a loose upper bound; we page in chunks of 50.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null = null,
  limit: number = 500
): Promise<PreviewResult> {
  // get stored alliance key
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const enc = a?.keys?.[0];
  const apiKey = enc ? open(enc.encryptedApiKey as any, enc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  if (!apiKey) throw new Error("No alliance API key on file.");

  // Page bankrecs until we either (a) hit older than lastSeenId or (b) collected ~limit rows
  const perPage = 50;
  const maxPages = Math.ceil(Math.max(1, Math.min(limit, 1000)) / perPage);

  const allRows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { perPage, maxPages, pageStart: 1 });

  // Filter & sort newest->oldest
  const taxRows = allRows
    .filter(r => (!lastSeenId || Number(r.id) > Number(lastSeenId)) && isTaxRow(r, allianceId))
    .sort((a, b) => Number(b.id) - Number(a.id));

  // accumulate deltas
  const delta: ResourceDelta = {};
  for (const r of taxRows) applyDelta(delta, r);

  const newestId = taxRows.length ? Number(taxRows[0].id) : null;
  const count = taxRows.length;

  return { count, newestId, delta };
}
