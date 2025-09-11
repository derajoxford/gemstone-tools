// src/integrations/pnw/tax.ts
import { open } from "../../lib/crypto.js";
import { PrismaClient } from "@prisma/client";
import { scrapeAllianceAutomatedTaxes, ResourceDelta } from "./tax_scrape";

const prisma = new PrismaClient();

export type PreviewOpts = { lastSeenTs?: number | null; limit?: number | null; };
export type PreviewResult = {
  count: number; newestTs: number | null; delta: ResourceDelta;
  rows: { at: number; note: string; delta: ResourceDelta }[];
};

async function ensureAllianceLinked(allianceId: number): Promise<boolean> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  if (!a || !a.keys.length) return false;
  try { open(a.keys[0]!.encryptedApiKey as any, a.keys[0]!.nonceApi as any); return true; }
  catch { return false; }
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  opts?: PreviewOpts
): Promise<PreviewResult> {
  const ok = await ensureAllianceLinked(allianceId);
  if (!ok) return { count: 0, newestTs: null, delta: {}, rows: [] };

  const lastSeen = Number(opts?.lastSeenTs ?? 0) || 0;
  const limit = Math.max(0, Number(opts?.limit ?? 0) || 0);

  const rows = await scrapeAllianceAutomatedTaxes(allianceId);
  let filtered = rows.filter(r => r.at > lastSeen);
  if (limit > 0 && filtered.length > limit) filtered = filtered.slice(-limit);

  const delta: ResourceDelta = {};
  let newestTs: number | null = null;

  for (const r of filtered) {
    for (const [k, v] of Object.entries(r.delta)) {
      const num = Number(v || 0);
      if (num) (delta as any)[k] = Number((delta as any)[k] || 0) + num;
    }
    if (!newestTs || r.at > newestTs) newestTs = r.at;
  }

  return { count: filtered.length, newestTs: newestTs ?? null, delta, rows: filtered };
}
