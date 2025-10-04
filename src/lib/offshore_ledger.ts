// src/lib/offshore_ledger.ts
import { PrismaClient } from "@prisma/client";
import { RESOURCE_KEYS } from "../lib/pnw";

// NOTE TAG used to identify bot-driven offshoring transfers
export const OFFSH_NOTE_TAG = "Gemstone Offsh";

export type Totals = Record<string, number>;

export async function getOrCreateLedger(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number,
) {
  let row = await prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
  });
  if (!row) {
    row = await prisma.offshoreLedger.create({
      data: { allianceId, offshoreId },
    });
  }
  return row;
}

/**
 * Catch-up the running ledger using our indexed cache table `alliance_bankrec`.
 * We only consider records that:
 *   - belong to the OFFSHORE alliance (`alliance_id_derived = offshoreId`)
 *   - have id > lastSeenBankrecId
 *   - are Alliance↔Alliance between (allianceId, offshoreId)
 *   - include the OFFSH_NOTE_TAG in note (bot-tagged flows only)
 *
 * Runs in small batches so we can call this opportunistically.
 */
export async function catchUpLedgerForPair(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number,
  opts?: { maxLoops?: number; batchSize?: number }
) {
  const maxLoops = opts?.maxLoops ?? 20;    // up to ~10k recs if batch=500
  const batchSize = opts?.batchSize ?? 500;

  const ledger = await getOrCreateLedger(prisma, allianceId, offshoreId);
  let lastSeen = Number(ledger.lastSeenBankrecId || 0);

  // Running deltas to apply at end
  const delta: Totals = Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0])) as Totals;
  let newestSeen = lastSeen;

  for (let loop = 0; loop < maxLoops; loop++) {
    // Pull from our local cache table (indexed)
    const rows: any[] = await prisma.$queryRawUnsafe(
      `
      select id, sender_type, receiver_type, sender_id, receiver_id, note,
             money, food, coal, oil, uranium, lead, iron, bauxite,
             gasoline, munitions, steel, aluminum
      from alliance_bankrec
      where alliance_id_derived = $1
        and id::bigint > $2
      order by id asc
      limit $3
      `,
      offshoreId,
      String(lastSeen),
      batchSize
    );

    if (!rows.length) break;

    for (const r of rows) {
      const idNum = Number(r.id);
      if (idNum > newestSeen) newestSeen = idNum;

      // Only bot-tagged transfers count toward ledger
      const note: string = (r.note || "").toString();
      if (!note.includes(OFFSH_NOTE_TAG)) continue;

      const sType = Number(r.sender_type || 0);
      const rType = Number(r.receiver_type || 0);
      const sId = String(r.sender_id || "");
      const rcId = String(r.receiver_id || "");

      const A = String(allianceId);
      const O = String(offshoreId);

      const isAtoO =
        (sType === 2 || sType === 3) && sId === A &&
        (rType === 2 || rType === 3) && rcId === O;

      const isOtoA =
        (sType === 2 || sType === 3) && sId === O &&
        (rType === 2 || rType === 3) && rcId === A;

      if (!isAtoO && !isOtoA) continue;

      for (const k of RESOURCE_KEYS) {
        const v = Number(r[k] || 0);
        if (!Number.isFinite(v) || v === 0) continue;
        if (isAtoO) delta[k] += v;
        if (isOtoA) delta[k] -= v;
      }
    }

    lastSeen = newestSeen;
    if (rows.length < batchSize) break;
  }

  // If nothing to apply, still bump lastSeen if advanced
  const touch = Object.values(delta).some(n => n !== 0) || newestSeen > ledger.lastSeenBankrecId;

  if (touch) {
    await prisma.offshoreLedger.update({
      where: { allianceId_offshoreId: { allianceId, offshoreId } },
      data: {
        lastSeenBankrecId: newestSeen,
        money:      (Number(ledger.money)      || 0) + (delta.money      || 0),
        food:       (Number(ledger.food)       || 0) + (delta.food       || 0),
        coal:       (Number(ledger.coal)       || 0) + (delta.coal       || 0),
        oil:        (Number(ledger.oil)        || 0) + (delta.oil        || 0),
        uranium:    (Number(ledger.uranium)    || 0) + (delta.uranium    || 0),
        lead:       (Number(ledger.lead)       || 0) + (delta.lead       || 0),
        iron:       (Number(ledger.iron)       || 0) + (delta.iron       || 0),
        bauxite:    (Number(ledger.bauxite)    || 0) + (delta.bauxite    || 0),
        gasoline:   (Number(ledger.gasoline)   || 0) + (delta.gasoline   || 0),
        munitions:  (Number(ledger.munitions)  || 0) + (delta.munitions  || 0),
        steel:      (Number(ledger.steel)      || 0) + (delta.steel      || 0),
        aluminum:   (Number(ledger.aluminum)   || 0) + (delta.aluminum   || 0),
      },
    });
  }
}

export async function readLedger(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number
) {
  return prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
  });
}
