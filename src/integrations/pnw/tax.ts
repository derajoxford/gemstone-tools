// src/integrations/pnw/tax.ts
// Public helpers used by commands to PREVIEW and APPLY.
// Reads the alliance key only to validate access (optional), but scraping does not require it.

import { open } from "../../lib/crypto.js";
import { PrismaClient } from "@prisma/client";
import { scrapeAllianceAutomatedTaxes, ResourceDelta } from "./tax_scrape";

const prisma = new PrismaClient();

export type PreviewOpts = {
  // Treat stored pnw_cursor as a timestamp (ms). Only rows with at > lastSeenTs are counted.
  lastSeenTs?: number | null;
  limit?: number | null; // maximum rows to scan (most recent)
};

export type PreviewResult = {
  count: number;
  newestTs: number | null;
  delta: ResourceDelta;
  rows: { at: number; note: string; delta: ResourceDelta }[];
};

// Validate we have some readable key stored (optional). We DON'T use it for scraping.
async function ensureAllianceLinked(allianceId: number): Promise<boolean> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  if (!a) return false;
  if (!a.keys.length) return false;
  try {
    // Just confirm decryption succeeds
    open(a.keys[0]!.encryptedApiKey as any, a.keys[0]!.nonceApi as any);
    return true;
  } catch {
    return false;
  }
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  opts?: PreviewOpts
): Promise<PreviewResult> {
  // Optional sanity check: confirm we do have a stored key
  const ok = await ensureAllianceLinked(allianceId);
  if (!ok) {
    return { count: 0, newestTs: null, delta: {}, rows: [] };
  }

  const lastSeen = Number(opts?.lastSeenTs ?? 0) || 0;
  const limit = Math.max(0, Number(opts?.limit ?? 0) || 0);

  const rows = await scrapeAllianceAutomatedTaxes(allianceId);
  let filtered = rows.filter(r => r.at > lastSeen);

  if (limit > 0 && filtered.length > limit) {
    filtered = filtered.slice(-limit); // keep most recent 'limit'
  }

  // Sum deltas
  const delta: ResourceDelta = {};
  let newestTs: number | null = null;

  for (const r of filtered) {
    for (const [k, v] of Object.entries(r.delta)) {
      const num = Number(v || 0);
      if (num) delta[k as keyof ResourceDelta] = Number(delta[k as keyof ResourceDelta] || 0) + num;
    }
    if (!newestTs || r.at > newestTs) newestTs = r.at;
  }

  return {
    count: filtered.length,
    newestTs: newestTs ?? null,
    delta,
    rows: filtered.map(r => ({ at: r.at, note: r.note, delta: r.delta })),
  };
}
