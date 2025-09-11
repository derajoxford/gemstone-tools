// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchBankrecs } from "../../lib/pnw";
import { ORDER } from "../../lib/emojis";

const prisma = new PrismaClient();

type Bankrec = {
  id: number | string;
  date?: string | null;
  note?: string | null;
  sender_type: number | string;
  sender_id: number | string;
  receiver_type: number | string;
  receiver_id: number | string;
  tax_id?: number | string | null;

  money?: number | string | null;
  food?: number | string | null;
  coal?: number | string | null;
  oil?: number | string | null;
  uranium?: number | string | null;
  lead?: number | string | null;
  iron?: number | string | null;
  bauxite?: number | string | null;
  gasoline?: number | string | null;
  munitions?: number | string | null;
  steel?: number | string | null;
  aluminum?: number | string | null;
};

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
  sample?: Array<{ id: number; note: string; money?: number }>;
  bankrecIds?: number[]; // for dedupe
};

const toInt = (v: any) => Number.parseInt(String(v ?? 0), 10) || 0;
const toNum = (v: any) => Number.parseFloat(String(v ?? 0)) || 0;

function isTaxForAlliance(r: Bankrec, allianceId: number): boolean {
  // Only incoming to this alliance
  const incoming =
    toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === allianceId;
  if (!incoming) return false;

  // Heuristics based on PnW: tax_id can be 0 for older rows, notes include “Automated Tax …”
  const taxId = toInt((r as any).tax_id);
  if (taxId > 0) return true;
  const note = String(r.note || "");
  if (/automated\s*tax/i.test(note)) return true;

  return false;
}

function sumDelta(records: Bankrec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ORDER) out[k] = 0;
  for (const r of records) for (const k of ORDER) out[k] += toNum((r as any)[k]);
  return out;
}

async function openApiKey(allianceId: number): Promise<string> {
  const alliance = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const k = alliance?.keys?.[0];
  const apiKey =
    (k ? open(k.encryptedApiKey as any, k.nonceApi as any) : null) ||
    process.env.PNW_DEFAULT_API_KEY ||
    "";
  return apiKey;
}

/**
 * GraphQL preview of tax bankrecs > lastSeenId.
 * We pass an optional scan limit through so you can widen the window.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null = null,
  opts?: { limit?: number; excludeIds?: Set<number>; sampleSize?: number }
): Promise<PreviewResult> {
  const apiKey = await openApiKey(allianceId);
  if (!apiKey) {
    throw new Error(
      "No valid stored PnW user API key for this alliance. Run /pnw_set again (and ensure GT_SECRET/ENCRYPTION_KEY matches the one used when saving)."
    );
  }

  const scanLimit = Math.max(1, opts?.limit ?? 600);

  const rowsPack = await fetchBankrecs({ apiKey }, [allianceId], scanLimit);
  const rows: Bankrec[] = (rowsPack?.[0]?.bankrecs as any[]) || [];

  if (!rows.length) {
    return { count: 0, newestId: null, delta: {}, sample: [], bankrecIds: [] };
  }

  const minId = lastSeenId || 0;
  let candidates = rows.filter((r) => toInt(r.id) > minId);

  // Tax-only to this alliance
  candidates = candidates.filter((r) => isTaxForAlliance(r, allianceId));

  // Optional dedupe (exclude ids already applied)
  if (opts?.excludeIds?.size) {
    candidates = candidates.filter((r) => !opts.excludeIds!.has(toInt(r.id)));
  }

  if (!candidates.length) {
    return { count: 0, newestId: null, delta: {}, sample: [], bankrecIds: [] };
  }

  // Sort ascending by id for stable newestId, samples
  candidates.sort((a, b) => toInt(a.id) - toInt(b.id));

  const newestId =
    candidates.length > 0 ? Math.max(...candidates.map((r) => toInt(r.id))) : null;
  const delta = sumDelta(candidates);

  const sampleSize = Math.min(5, Math.max(0, opts?.sampleSize ?? 3));
  const sample =
    sampleSize > 0
      ? candidates.slice(-sampleSize).map((r) => ({
          id: toInt(r.id),
          note: String(r.note || ""),
          money: toNum(r.money),
        }))
      : [];

  const ids = candidates.map((r) => toInt(r.id));

  return { count: candidates.length, newestId, delta, sample, bankrecIds: ids };
}
