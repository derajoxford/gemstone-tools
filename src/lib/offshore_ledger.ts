// src/lib/offshore_ledger.ts
import { PrismaClient, OffshoreLedger } from "@prisma/client";
import { fetchBankrecs, RESOURCE_KEYS } from "./pnw";

const prisma = new PrismaClient();

// Must match the tag used by offshore send()
export const OFFSH_NOTE_TAG = "Gemstone Offsh";

// Get or create a ledger row for (allianceId, offshoreId)
export async function getOrCreateLedger(allianceId: number, offshoreId: number): Promise<OffshoreLedger> {
  let row = await prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
  });
  if (row) return row;

  row = await prisma.offshoreLedger.create({
    data: {
      allianceId,
      offshoreId,
      lastSeenBankrecId: 0,
      money: 0,
      food: 0,
      coal: 0,
      oil: 0,
      uranium: 0,
      lead: 0,
      iron: 0,
      bauxite: 0,
      gasoline: 0,
      munitions: 0,
      steel: 0,
      aluminum: 0,
    },
  });
  return row;
}

// Apply an additive delta to the ledger and bump lastSeenBankrecId
async function applyDelta(allianceId: number, offshoreId: number, delta: Record<string, number>, newLastSeen: number) {
  const data: any = { lastSeenBankrecId: newLastSeen };
  for (const k of RESOURCE_KEYS) {
    const v = Number(delta[k] || 0);
    if (!v) continue;
    data[k] = { increment: v }; // Prisma Decimal increment
  }

  await prisma.offshoreLedger.update({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
    data,
  });
}

// Incrementally catch up ledger using offshore's latest bankrecs.
// Counts only bot-tagged rows for the specific (A ↔ O) pair.
// Idempotent: processes rows with id > lastSeenBankrecId only.
export async function catchUpLedgerForPair(allianceId: number, offshoreId: number, take = 500): Promise<OffshoreLedger> {
  const ledger = await getOrCreateLedger(allianceId, offshoreId);
  const rows = await fetchBankrecs(offshoreId, { limit: take });

  const lastSeen = Number(ledger.lastSeenBankrecId || 0);
  const A = String(allianceId);
  const O = String(offshoreId);

  const delta: Record<string, number> = Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0]));
  let maxSeen = lastSeen;

  for (const r of rows) {
    const id = Number((r as any).id || 0);
    if (!(id > lastSeen)) continue;

    const sType = Number((r as any).sender_type || 0);
    const rType = Number((r as any).receiver_type || 0);
    const sId = String((r as any).sender_id || "");
    const rId = String((r as any).receiver_id || "");
    const note = String((r as any).note || "");

    if (!note.includes(OFFSH_NOTE_TAG)) continue;

    const isAtoO = (sType === 2 || sType === 3) && sId === A && (rType === 2 || rType === 3) && rId === O;
    const isOtoA = (sType === 2 || sType === 3) && sId === O && (rType === 2 || rType === 3) && rId === A;
    if (!isAtoO && !isOtoA) continue;

    for (const k of RESOURCE_KEYS) {
      const v = Number((r as any)[k] || 0);
      if (!Number.isFinite(v) || v === 0) continue;
      delta[k] += isAtoO ? v : -v;
    }

    if (id > maxSeen) maxSeen = id;
  }

  if (maxSeen > lastSeen) {
    await applyDelta(allianceId, offshoreId, delta, maxSeen);
  }

  return prisma.offshoreLedger.findUniqueOrThrow({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
  });
}
