import type { Client } from "discord.js";
import { PrismaClient, SafeTxnType } from "@prisma/client";
import { RESOURCE_KEYS, type ResourceKey } from "../utils/pretty.js";

const prisma = new PrismaClient();

// Poll interval (default 5 minutes); override with PNW_AUTO_APPLY_INTERVAL_MS=300000
const POLL_MS = Math.max(
  60_000,
  Number.isFinite(Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS))
    ? Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS)
    : 300_000
);

const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3;

async function creditDepositForRow(p: PrismaClient, row: any) {
  const allianceId = Number(row.alliance_id_derived);
  const nationId = Number(row.sender_id);
  if (!Number.isFinite(allianceId) || !Number.isFinite(nationId)) return;

  const member = await p.member.findFirst({
    where: { allianceId, nationId },
    orderBy: { id: "desc" },
  });
  if (!member) return;

  const increments: Record<string, any> = {};
  const amounts: Partial<Record<ResourceKey, number>> = {};
  for (const res of RESOURCE_KEYS) {
    const v = Number(row[res] ?? 0);
    if (v > 0) {
      increments[res] = { increment: v };
      amounts[res] = v;
    }
  }
  if (Object.keys(increments).length === 0) return;

  await p.$transaction(async (tx) => {
    const existing = await tx.safekeeping.findUnique({ where: { memberId: member.id } });
    if (existing) {
      await tx.safekeeping.update({ where: { id: existing.id }, data: increments });
    } else {
      const base: any = {
        memberId: member.id,
        money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0, bauxite: 0,
        gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
      };
      for (const [k, v] of Object.entries(amounts)) base[k] = v;
      await tx.safekeeping.create({ data: base });
    }

    // idempotent: 1 SafeTxn per (member, bankrec_id, resource)
    for (const [res, amt] of Object.entries(amounts) as [ResourceKey, number][]) {
      const marker = `BR:${row.id}:${res}`;
      const dup = await tx.safeTxn.findFirst({
        where: { memberId: member.id, type: SafeTxnType.AUTO_CREDIT, reason: marker },
        select: { id: true },
      });
      if (!dup) {
        await tx.safeTxn.create({
          data: {
            memberId: member.id,
            resource: res,
            amount: amt,
            type: SafeTxnType.AUTO_CREDIT,
            actorDiscordId: null,
            reason: marker,
          },
        });
      }
    }
  });
}

async function tickOnce(p: PrismaClient) {
  let processed = 0;
  const alliances = await p.alliance.findMany({ select: { id: true } });
  for (const a of alliances) {
    const cursor = await p.allianceBankCursor.upsert({
      where: { allianceId: a.id },
      create: { allianceId: a.id, lastSeenId: "1970-01-01T00:00:00.000Z" },
      update: {},
      select: { lastSeenId: true },
    });
    const sinceISO = cursor.lastSeenId || "1970-01-01T00:00:00.000Z";

    const rows = await p.allianceBankrec.findMany({
      where: {
        alliance_id_derived: a.id,
        created_at: { gt: new Date(sinceISO) },
        sender_type: SENDER_NATION,
        receiver_type: RECEIVER_ALLIANCE,
      },
      orderBy: { created_at: "asc" },
      take: 500,
    });
    if (rows.length === 0) continue;

    for (const row of rows) {
      try {
        await creditDepositForRow(p, row);
        processed++;
      } catch (e) {
        console.error("[auto-credit] error for row", row.id, e);
      }
    }

    const newest = rows[rows.length - 1]!.created_at as Date;
    await p.allianceBankCursor.update({
      where: { allianceId: a.id },
      data: { lastSeenId: new Date(newest).toISOString() },
    });
  }
  if (processed > 0) {
    console.log(`[auto-credit] processed ${processed} deposit rows across ${alliances.length} alliances`);
  }
}

export async function startAutoApply(_client?: Client, external?: PrismaClient) {
  const p = external ?? prisma;

  // Run immediately once at startup (non-blocking schedule after)
  tickOnce(p).catch((e) => console.error("[auto-credit] initial tick failed:", e));

  // Safe loop: schedule next run after the previous finishes
  const schedule = async () => {
    const started = Date.now();
    try {
      await tickOnce(p);
    } catch (e) {
      console.error("[auto-credit] tick failed:", e);
    } finally {
      const elapsed = Date.now() - started;
      const wait = Math.max(10_000, POLL_MS - elapsed);
      setTimeout(schedule, wait);
    }
  };
  setTimeout(schedule, POLL_MS);
}

export default { startAutoApply };
