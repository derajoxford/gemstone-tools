import type { Client } from "discord.js";
import { PrismaClient, SafeTxnType } from "@prisma/client";
import { fetch } from "undici";
import {
  RESOURCE_KEYS,
  type ResourceKey,
  fmtAmount,
  RESOURCE_META,
  COLORS,
  resourceLabel,
} from "../utils/pretty.js";

const prisma = new PrismaClient();

// Poll every 5 minutes (override via PNW_AUTO_APPLY_INTERVAL_MS)
export const POLL_MS = Math.max(
  60_000,
  Number.isFinite(Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS))
    ? Number(process.env.PNW_AUTO_APPLY_INTERVAL_MS)
    : 300_000
);

// Rolling window: look back 48h (override via PNW_AUTO_APPLY_WINDOW_MS)
export const WINDOW_MS = Math.max(
  60_000,
  Number.isFinite(Number(process.env.PNW_AUTO_APPLY_WINDOW_MS))
    ? Number(process.env.PNW_AUTO_APPLY_WINDOW_MS)
    : 48 * 60 * 60 * 1000
);

// PnW enums (sender/receiver types)
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3;

type Amounts = Partial<Record<ResourceKey, number>>;

async function sendCreditDM(
  client: Client | undefined,
  memberDiscordId: string,
  allianceName: string | null | undefined,
  bankrecId: string,
  createdAt: Date,
  amounts: Amounts,
  note?: string | null
) {
  if (!client) return;
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
    if (lines.length === 0) return;

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
    // DM closed or not allowed; ignore
  }
}

async function creditDepositForRow(p: PrismaClient, client: Client | undefined, row: any) {
  const allianceId = Number(row.alliance_id_derived ?? row.allianceId);
  const nationId = Number(row.sender_id ?? row.senderId);
  if (!Number.isFinite(allianceId) || !Number.isFinite(nationId)) return false;

  const member = await p.member.findFirst({
    where: { allianceId, nationId },
    orderBy: { id: "desc" },
  });
  if (!member) return false;

  // Build increments
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

  let createdAny = false;

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

    // Idempotent SafeTxn per (bankrecId, resource)
    for (const [res, amt] of Object.entries(amounts) as [ResourceKey, number][]) {
      const bankrecId = String(row.id);
      const marker = `BR:${bankrecId}:${res}`;
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
        createdAny = true;
      }
    }
  });

  if (createdAny) {
    const alliance = await p.alliance.findUnique({ where: { id: allianceId } });
    await sendCreditDM(
      client,
      member.discordId,
      alliance?.name,
      String(row.id),
      row.created_at ?? row.date,
      amounts,
      row.note
    );
  }

  return createdAny;
}

/** Live PnW API fallback (GraphQL). */
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) return [];

    const url = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";

    // Keep the query simple and filter in code; fewer assumptions about API args
    const query = `
      query {
        bankrecs(alliance_id: ${allianceId}, limit: 200) {
          id
          date
          note
          sender_type
          sender_id
          receiver_type
          receiver_id
          money
          food
          coal
          oil
          uranium
          lead
          iron
          bauxite
          gasoline
          munitions
          steel
          aluminum
        }
      }
    `;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // PnW GraphQL commonly accepts either header or query param; header first:
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      console.warn(`[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`);
      return [];
    }
    const json: any = await resp.json();

    // Try a few common shapes: { data: { bankrecs: [...] } } or { bankrecs: [...] }
    const raw = json?.data?.bankrecs ?? json?.bankrecs ?? [];
    const list: any[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
    const cutoff = since.getTime();

    const mapped = list
      .map((r) => {
        const d = new Date(r.date as string);
        return {
          ...r,
          id: String(r.id),
          created_at: d,
          alliance_id_derived: allianceId,
        };
      })
      .filter(
        (r) =>
          r.sender_type == SENDER_NATION &&
          r.receiver_type == RECEIVER_ALLIANCE &&
          r.created_at instanceof Date &&
          !Number.isNaN(r.created_at.getTime()) &&
          r.created_at.getTime() > cutoff
      )
      .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

async function fetchRecentRows(p: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) Prefer cached table
  const cache = await p.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: RECEIVER_ALLIANCE,
    },
    orderBy: { created_at: "asc" },
    take: 1000,
  });
  if (cache.length > 0) return { rows: cache, source: "alliance_bankrec" as const };

  // 2) Legacy Bankrec
  const legacy = await p.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: RECEIVER_ALLIANCE,
    },
    orderBy: { date: "asc" },
    take: 1000,
  });
  if (legacy.length > 0) return { rows: legacy, source: "bankrec" as const };

  // 3) Live PnW fallback
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);
  return { rows: live, source: "pnw_api" as const };
}

async function tickOnce(p: PrismaClient, client: Client | undefined) {
  let processed = 0;
  const alliances = await p.alliance.findMany({ select: { id: true } });

  for (const a of alliances) {
    const { rows, source } = await fetchRecentRows(p, a.id);
    if (rows.length === 0) {
      console.warn(`[auto-credit] no recent deposit rows found for alliance ${a.id} (source=${source})`);
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
  }

  if (processed > 0) console.log(`[auto-credit] processed ${processed} deposit rows`);
}

export async function startAutoApply(client?: Client, external?: PrismaClient) {
  const p = external ?? prisma;
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);

  // Kick once immediately
  tickOnce(p, client).catch((e) => console.error("[auto-credit] initial tick failed:", e));

  // Then schedule every POLL_MS
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
