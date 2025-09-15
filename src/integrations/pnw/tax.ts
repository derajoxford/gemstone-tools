import { PrismaClient } from "@prisma/client";
import {
  Bankrec,
  fetchBankrecsSince,
  RESOURCE_KEYS,
  ResourceDelta,
  signedDeltaFor,
  sumDelta,
  zeroDelta,
} from "../../lib/pnw.js";
import { readTaxCursor, writeTaxCursor } from "../../utils/cursor.js";
import { addToTreasury } from "../../utils/treasury.js";

export type PreviewResult = {
  count: number;
  newestId: number | null;
  delta: ResourceDelta;
  sample: Bankrec[];
};

/**
 * Preview tax credits since the stored cursor (exclusive).
 */
export async function previewTaxes(
  prisma: PrismaClient,
  allianceId: number
): Promise<PreviewResult> {
  const sinceId = await readTaxCursor(prisma, allianceId);
  const rows = await fetchBankrecsSince(prisma, allianceId, sinceId, 500, 5000);

  let delta = zeroDelta();
  let newestId: number | null = sinceId ?? null;

  for (const r of rows) {
    const d = signedDeltaFor(allianceId, r);
    delta = sumDelta(delta, d);
    if (newestId === null || r.id > newestId) newestId = r.id;
  }

  return {
    count: rows.length,
    newestId: newestId ?? null,
    delta,
    sample: rows.slice(-5), // last few for quick human sanity
  };
}

/**
 * Apply the previewed delta to treasury and advance the cursor.
 * Idempotent: because the cursor only advances AFTER treasury mutation.
 */
export async function applyTaxes(
  prisma: PrismaClient,
  allianceId: number
): Promise<PreviewResult> {
  const prev = await previewTaxes(prisma, allianceId);

  if (prev.count === 0) {
    // Nothing to do; do not advance cursor
    return prev;
  }

  // Apply to treasury (server-side addition)
  await addToTreasury(prisma, allianceId, prev.delta, `PnW taxes (bankrecs up to #${prev.newestId})`);

  // Now that the mutation succeeded, advance the cursor
  if (prev.newestId) {
    await writeTaxCursor(prisma, allianceId, prev.newestId);
  }

  return prev;
}

/**
 * Pretty print a delta object into aligned lines.
 */
export function formatDelta(delta: ResourceDelta): string {
  const lines: string[] = [];
  for (const k of RESOURCE_KEYS) {
    const v = delta[k];
    if (v !== 0) lines.push(`${k}: ${v}`);
  }
  return lines.length ? lines.join("\n") : "(all zero)";
}
