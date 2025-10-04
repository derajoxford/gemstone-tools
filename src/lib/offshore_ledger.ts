import { PrismaClient, Prisma } from "@prisma/client";

// NOTE: only bankrecs whose notes contain this tag are considered "offshore" movements
const BOT_TAG = "Gemstone Offsh";

export type Resource =
  | "money" | "food" | "coal" | "oil" | "uranium" | "lead" | "iron"
  | "bauxite" | "gasoline" | "munitions" | "steel" | "aluminum";

const RESOURCES: Resource[] = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
];

type Delta = Partial<Record<Resource, Prisma.Decimal>>;

function zeroDelta(): Delta {
  const d: any = {};
  for (const r of RESOURCES) d[r] = new Prisma.Decimal(0);
  return d;
}

export async function getOrCreateLedger(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number
) {
  let row = await prisma.offshoreLedger.findUnique({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
  });

  if (!row) {
    row = await prisma.offshoreLedger.create({
      data: { allianceId, offshoreId, lastSeenBankrecId: 0 },
    });
  }
  return row;
}

/**
 * Scan new bankrecs for the (allianceId -> offshoreId) pair since the last seen id,
 * accumulate bot-tagged deltas, and atomically increment the ledger.
 *
 * Rules:
 *  - A -> Off increases the ledger (we hold more on behalf of A)
 *  - Off -> A decreases the ledger (we hold less on behalf of A)
 *  - Only rows whose `note` ILIKE %BOT_TAG% are counted
 */
export async function catchUpLedgerForPair(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number,
) {
  const ledger = await getOrCreateLedger(prisma, allianceId, offshoreId);

  // Pull new bankrecs for both alliances after lastSeen
  // We use the denormalized cache table you already sync (AllianceBankrec)
  // Columns (from your model): id (text), date, note, sender_type, receiver_type, sender_id, receiver_id, ...
  const sinceId = ledger.lastSeenBankrecId ?? 0;

  const rows = await prisma.allianceBankrec.findMany({
    where: {
      // scan both sides (source or target alliance)
      alliance_id_derived: { in: [allianceId, offshoreId] },
      // after last seen numeric id (id is text in the model, so compare by parsed int below)
    },
    orderBy: { date: "asc" },
    take: 5000, // defensive cap
  });

  // Compute max numeric id and delta across only NEW rows, bot-tagged, and relevant directions
  let maxSeen = sinceId;
  const delta = zeroDelta();

  for (const r of rows) {
    // Ignore rows we've already seen
    const numericId = parseInt(r.id, 10);
    if (!Number.isFinite(numericId) || numericId <= sinceId) continue;

    if (typeof r.note !== "string" || !r.note.toLowerCase().includes(BOT_TAG.toLowerCase())) {
      // not a bot-tagged offshoring move
      maxSeen = Math.max(maxSeen, numericId);
      continue;
    }

    // sender/receiver types: 2 == alliance (matches your prior usage)
    const sType = r.sender_type;
    const rType = r.receiver_type;

    const sId = parseInt(r.sender_id, 10);
    const tId = parseInt(r.receiver_id, 10);

    // Only count the two directions that matter for THIS pair:
    // allianceId -> offshoreId  (increase)
    // offshoreId -> allianceId  (decrease)
    const aToOff = sType === 2 && rType === 2 && sId === allianceId && tId === offshoreId;
    const offToA = sType === 2 && rType === 2 && sId === offshoreId && tId === allianceId;

    if (!aToOff && !offToA) {
      maxSeen = Math.max(maxSeen, numericId);
      continue;
    }

    // Apply sign (+ for A→Off, − for Off→A)
    const sign = aToOff ? 1 : -1;

    for (const res of RESOURCES) {
      // @ts-ignore – AllianceBankrec uses snake columns; the resource columns are lowercase in your schema mapping
      const raw = (r as any)[res];
      const n = raw == null ? 0 : Number(raw);
      if (!n) continue;

      (delta[res] as Prisma.Decimal) = (delta[res] as Prisma.Decimal).add(new Prisma.Decimal(sign * n));
    }

    maxSeen = Math.max(maxSeen, numericId);
  }

  // If nothing new, bail early
  const touched = RESOURCES.some((k) => !(delta[k] as Prisma.Decimal).isZero());
  if (!touched && maxSeen === sinceId) return;

  // Atomic increments per column + advance cursor
  // Prisma supports { increment: <Decimal|number> } on Decimal fields.
  const data: any = { lastSeenBankrecId: maxSeen };
  for (const res of RESOURCES) {
    const inc = delta[res] as Prisma.Decimal;
    if (!inc.isZero()) data[res] = { increment: inc };
  }

  await prisma.offshoreLedger.update({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
    data,
  });
}

/**
 * Read the current held balances (already netted).
 */
export async function readHeldBalances(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number
): Promise<Record<Resource, number> & { lastSeenBankrecId: number }> {
  const row = await getOrCreateLedger(prisma, allianceId, offshoreId);
  const out: any = { lastSeenBankrecId: row.lastSeenBankrecId };
  for (const r of RESOURCES) out[r] = Number(row[r] as unknown as Prisma.Decimal) || 0;
  return out;
}
