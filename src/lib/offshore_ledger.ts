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
 *  - Treat sender/receiver types 2 **or** 3 as alliance-level bank records
 */
export async function catchUpLedgerForPair(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number,
) {
  const ledger = await getOrCreateLedger(prisma, allianceId, offshoreId);

  const sinceId = ledger.lastSeenBankrecId ?? 0;

  const rows = await prisma.allianceBankrec.findMany({
    where: {
      alliance_id_derived: { in: [allianceId, offshoreId] },
    },
    orderBy: { date: "asc" },
    take: 5000, // safety cap
  });

  let maxSeen = sinceId;
  const delta = zeroDelta();

  for (const r of rows) {
    // Skip already-seen ids
    const numericId = parseInt(r.id, 10);
    if (!Number.isFinite(numericId) || numericId <= sinceId) continue;

    if (typeof r.note !== "string" || !r.note.toLowerCase().includes(BOT_TAG.toLowerCase())) {
      maxSeen = Math.max(maxSeen, numericId);
      continue;
    }

    // Treat 2 or 3 as "alliance-level" (matches your live scan logic)
    const sType = Number(r.sender_type);
    const tType = Number(r.receiver_type);

    const sId = parseInt(r.sender_id, 10);
    const tId = parseInt(r.receiver_id, 10);

    const isAtoOff = (sType === 2 || sType === 3) && (tType === 2 || tType === 3) && sId === allianceId && tId === offshoreId;
    const isOffToA = (sType === 2 || sType === 3) && (tType === 2 || tType === 3) && sId === offshoreId && tId === allianceId;

    if (!isAtoOff && !isOffToA) {
      maxSeen = Math.max(maxSeen, numericId);
      continue;
    }

    const sign = isAtoOff ? 1 : -1;

    for (const res of RESOURCES) {
      // @ts-ignore resource columns are lowercase in your cache table
      const raw = (r as any)[res];
      const n = raw == null ? 0 : Number(raw);
      if (!n) continue;

      (delta[res] as Prisma.Decimal) = (delta[res] as Prisma.Decimal).add(new Prisma.Decimal(sign * n));
    }

    maxSeen = Math.max(maxSeen, numericId);
  }

  const touched = RESOURCES.some((k) => !(delta[k] as Prisma.Decimal).isZero());
  if (!touched && maxSeen === sinceId) return;

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

/** Read the current held balances (already netted). */
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

/**
 * Immediate bump used right after a successful /offshore send.
 * Positive values increase holdings; negative decrease.
 */
export async function applyImmediateDelta(
  prisma: PrismaClient,
  allianceId: number,
  offshoreId: number,
  payload: Partial<Record<Resource, number>>
) {
  await getOrCreateLedger(prisma, allianceId, offshoreId);
  const data: any = {};
  for (const r of RESOURCES) {
    const v = Number(payload[r] || 0);
    if (v) data[r] = { increment: v };
  }
  if (Object.keys(data).length === 0) return;
  await prisma.offshoreLedger.update({
    where: { allianceId_offshoreId: { allianceId, offshoreId } },
    data,
  });
}
