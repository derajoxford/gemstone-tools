// src/integrations/pnw/tax.ts
// Preview + sum “automated tax” credits using GraphQL bankrecs nested under alliances.
// Heuristic: treat as tax when it’s Nation(1) -> Alliance(2) to *this* alliance AND (tax_id>0 OR note mentions Automated Tax).
// We also honor a lastSeenId (cursor) so we don’t double count.

import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, Bankrec } from "../../lib/pnw";

const prisma = new PrismaClient();

export type ResourceDelta = Record<string, number>;
export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
};

const RES_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

function blankDelta(): ResourceDelta {
  const d: ResourceDelta = {};
  for (const k of RES_KEYS) d[k] = 0;
  return d;
}

function isAutomatedTaxRow(r: Bankrec, allianceId: number): boolean {
  const fromNationToAlliance =
    Number(r.sender_type) === 1 &&
    Number(r.receiver_type) === 2 &&
    Number(r.receiver_id) === Number(allianceId);

  if (!fromNationToAlliance) return false;

  // Primary signal: tax_id > 0 (when present)
  if (r.tax_id && Number(r.tax_id) > 0) return true;

  // Secondary (fallback) signal: Note mentions Automated Tax (PnW UI copy)
  if ((r.note || "").toLowerCase().includes("automated tax")) return true;

  return false;
}

function addRowToDelta(delta: ResourceDelta, r: Bankrec) {
  for (const k of RES_KEYS) {
    const v = Number((r as any)[k] || 0);
    if (v) delta[k] += v;
  }
}

export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  opts?: { lastSeenId?: number | null }
): Promise<PreviewResult> {
  const lastSeenId = opts?.lastSeenId ?? null;

  // Pull the latest bankrecs for this alliance (server default page size)
  const rows = await fetchAllianceBankrecsViaGQL({ apiKey, allianceId });

  // Apply cursor filter first (only newer than lastSeenId)
  const fresh = rows.filter((r) => (lastSeenId ? Number(r.id) > lastSeenId : true));

  // Keep only tax-looking rows
  const taxRows = fresh.filter((r) => isAutomatedTaxRow(r, allianceId));

  // Sum
  const delta = blankDelta();
  for (const r of taxRows) addRowToDelta(delta, r);

  // newest id we saw among the considered set (to advance cursor)
  const newestId =
    taxRows.length > 0 ? Math.max(...taxRows.map((r) => Number(r.id) || 0)) : null;

  return { count: taxRows.length, newestId, delta };
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId?: number | null
): Promise<PreviewResult> {
  // Find most recent API key for this alliance
  const a = await prisma.alliance.findUnique({
    where: { id: Number(allianceId) },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });

  const enc = a?.keys?.[0];
  const fallback = process.env.PNW_DEFAULT_API_KEY || "";
  if (!enc && !fallback) {
    throw new Error("No API key available for this alliance.");
  }

  const apiKey = enc
    ? open(enc.encryptedApiKey as any, enc.nonceApi as any)
    : fallback;

  if (!apiKey) throw new Error("Failed to decrypt alliance API key.");

  return previewAllianceTaxCredits(apiKey, Number(allianceId), {
    lastSeenId: lastSeenId ?? null,
  });
}
