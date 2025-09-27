import type { Client } from "discord.js";
import { PrismaClient, SafeTxnType } from "@prisma/client";
import {
  RESOURCE_KEYS,
  type ResourceKey,
  fmtAmount,
  RESOURCE_META,
  COLORS,
  resourceLabel,
} from "../utils/pretty.js";

const prisma = new PrismaClient();

// Poll every 5 minutes by default; override via env (ms)
const POLL_MS = Math.max(
  60_000,
  Number.isFinite(Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS))
    ? Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS)
    : 300_000
);

const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3;

type Amounts = Partial<Record<ResourceKey, number>>;

function parseCursorDate(raw: string | null | undefined) {
  if (!raw || /^\s*$/.test(raw)) return { date: new Date(0), invalid: true };
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return { date: new Date(0), invalid: true };
  return { date: new Date(t), invalid: false };
}

async function sendCreditDM(
  client: Client | undefined,
  memberDiscordId: string,
  allianceName: string | null | undefined,
  bankrecId: string,
  createdAt: Date,
  amounts: Amounts,
  note?: string | null
) {
  if (!client) return; // DM optional
  try {
    const user = await client.users.fetch(memberDiscordId);
    if (!user) return;

    const lines: string[] = [];
    for (const [res, amt] of Object.entries(amounts) as [ResourceKey, number][]) {
      if (amt > 0) {
        const meta = RESOURCE_META[res];
        lines.push(`• ${resourceLabel(res)} — **${fmtAmount(amt)}** ${meta.emoji}`);
      }
    }
    const desc =
      (note ? `> _${note}_\n\n` : "") +
      lines.join("\n") +
      `\n\nUse \`/balance\` to view your updated safekeeping.`;

    await user.send({
      embeds: [
        {
          color: COLORS.green,
          author: { name: "Deposit Credited to Safekeeping" },
          title: allianceName ? `Alliance: ${allianceName}` : "Alliance deposit detected",
          description: desc,
          footer: { text: `Bank record ${bankrecId}` },
          timestamp: createdAt.toISOString(),
        },
      ],
    });
  } catch {
    // DMs may be closed; ignore
  }
}

async function creditDepositForRow(p: PrismaClient, client: Client | undefined, row: any) {
  const allianceId = Number(row.alliance_id_derived);
  const nationId = Number(row.sender_id);
  if (!Number.isFinite(allianceId) || !Number.isFinite(nationId)) return false;

  const member = await p.member.findFirst({
    where: { allianceId, nationId },
    orderBy: { id: "desc" },
  });
  if (!member) return false;

  const increments: Record<string, any> = {};
  const amounts: Amounts = {};
  for (const res of RESOURCE_KEYS) {
    const v = Number(row[res] ?? 0);
    if (v > 0) {
      increments[res] = { increment: v };
      amounts[res] = v;
    }
  }
  if (Object.keys(increments).length === 0) return false;

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

    // Idempotent SafeTxn per (row, resource)
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

  const alliance = await p.alliance.findUnique({ where: { id: allianceId } });
  await sendCreditDM(
    client,
    member.discordId,
    alliance?.name,
    row.id,
    row.created_at,
    amounts,
    row.note
  );

  return true;
}

async function tickOnce(p: PrismaClient, client: Client | undefined) {
  let processed = 0;
  const alliances = await p.alliance.findMany({ select: { id: true } });

  for (const a of alliances) {
    const cursor = await p.allianceBankCursor.upsert({
      where: { allianceId: a.id },
      create: { allianceId: a.id, lastSeenId: "1970-01-01T00:00:00.000Z" },
      update: {},
      select: { lastSeenId: true },
    });

    const { date: sinceDate, invalid } = parseCursorDate(cursor.lastSeenId);

    // Fetch rows newer than the watermark
    const rows = await p.allianceBankrec.findMany({
      where: {
        alliance_id_derived: a.id,
        created_at: { gt: sinceDate },
        sender_type: SENDER_NATION,
        receiver_type: RECEIVER_ALLIANCE,
      },
      orderBy: { created_at: "asc" },
      take: 500,
    });

    if (rows.length === 0) {
      // Self-heal bad cursors so we don't keep logging "Invalid Date"
      if (invalid) {
        await p.allianceBankCursor.update({
          where: { allianceId: a.id },
          data: { lastSeenId: new Date().toISOString() },
        });
      }
      continue;
    }

    for (const row of rows) {
      try {
        const ok = await creditDepositForRow(p, client, row);
        if (ok) processed++;
      } catch (e) {
        console.error("[auto-credit] error for row", row.id, e);
      }
    }

    // Advance watermark to newest processed timestamp (valid ISO)
    const newest = rows[rows.length - 1]!.created_at as Date;
    await p.allianceBankCursor.update({
      where: { allianceId: a.id },
      data: { lastSeenId: new Date(newest).toISOString() },
    });
  }

  if (processed > 0) {
    console.log(`[auto-credit] processed ${processed} deposit rows`);
  }
}

export async function startAutoApply(client?: Client, external?: PrismaClient) {
  const p = external ?? prisma;

  // Kick once immediately
  tickOnce(p, client).catch((e) => console.error("[auto-credit] initial tick failed:", e));

  // Then schedule every POLL_MS (safe loop)
  const loop = async () => {
    const start = Date.now();
    try {
      await tickOnce(p, client);
    } catch (e) {
      console.error("[auto-credit] tick failed:", e);
    } finally {
      const elapsed = Date.now() - start;
      const wait = Math.max(10_000, POLL_MS - elapsed);
      setTimeout(loop, wait);
    }
  };
  setTimeout(loop, POLL_MS);
}

export default { startAutoApply };
