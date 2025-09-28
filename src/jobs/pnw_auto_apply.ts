// src/jobs/pnw_auto_apply.ts
import { PrismaClient, Prisma, SafeTxnType } from "@prisma/client";
import type { Client } from "discord.js";

const prisma = new PrismaClient();

// Constants from your earlier code
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3;
// We also treat receiver_type=2 (bank) as an alliance deposit target
const RECEIVER_ALLIANCE_BANK = 2;

// Window & poll (same defaults as logs showed)
const WINDOW_MS = Number(process.env.AUTO_CREDIT_WINDOW_MS ?? 1000 * 60 * 60 * 24 * 2); // 48h
const POLL_MS = Number(process.env.AUTO_CREDIT_POLL_MS ?? 1000 * 60 * 5); // 5m

type PnwBankrec = {
  id: string;
  date: string; // ISO
  note?: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
  money?: number | null;
  // other resources omitted here (we only auto-credit money)
};

async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date): Promise<(PnwBankrec & { created_at: Date; alliance_id_derived: number; })[]> {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // alliances(id:[AID]) { bankrecs { ... } }
    const query = `
      {
        alliances(id:[${allianceId}]) {
          id
          bankrecs {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
            money
          }
        }
      }
    `;

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      console.warn(`[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`);
      return [];
    }

    const json: any = await resp.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      console.warn(
        "[auto-credit] PnW API GraphQL errors:",
        json.errors.map((e: any) => e?.message ?? e)
      );
      return [];
    }

    const recs: any[] = json?.data?.alliances?.[0]?.bankrecs ?? [];
    const cutoff = since.getTime();
    const mapped: (PnwBankrec & { created_at: Date; alliance_id_derived: number; })[] = recs
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          id: String(r.id),
          date: String(r.date),
          note: r.note ?? null,
          sender_type: Number(r.sender_type),
          sender_id: String(r.sender_id),
          receiver_type: Number(r.receiver_type),
          receiver_id: String(r.receiver_id),
          money: r.money == null ? null : Number(r.money),
          created_at,
          alliance_id_derived: allianceId,
        };
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&
          (r.receiver_type === RECEIVER_ALLIANCE || r.receiver_type === RECEIVER_ALLIANCE_BANK) &&
          r.created_at.getTime() > cutoff
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    console.log(`[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`);
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

async function fetchRecentRows(p: PrismaClient, allianceId: number): Promise<{ rows: Array<any>, source: string }> {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) union cache
  const cache = await p.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      date: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [RECEIVER_ALLIANCE_BANK, RECEIVER_ALLIANCE] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  // 2) legacy table
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

  // 3) live PnW API
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  const combined: any[] = [...cache, ...legacy, ...live];
  const seen = new Set<string>();
  const deduped = combined.filter((r: any) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort by time
  deduped.sort((a: any, b: any) => {
    const ta = (a.created_at ? new Date(a.created_at).getTime() : new Date(a.date).getTime());
    const tb = (b.created_at ? new Date(b.created_at).getTime() : new Date(b.date).getTime());
    return ta - tb;
  });

  const source = live.length ? "union_local+pnw_api" : (cache.length ? "alliance_bankrec" : (legacy.length ? "bankrec" : "empty"));
  return { rows: deduped, source };
}

async function processAlliance(prisma: PrismaClient, client: Client | undefined, allianceId: number): Promise<number> {
  const { rows, source } = await fetchRecentRows(prisma, allianceId);
  console.log(`[auto-credit] alliance ${allianceId} fetched ${rows.length} rows (source=${source})`);

  let processed = 0;

  for (const r of rows) {
    // Normalize shapes from different sources
    const sender_type = Number(r.sender_type ?? r.senderType);
    const receiver_type = Number(r.receiver_type ?? r.receiverType);
    const sender_id = String(r.sender_id ?? r.senderId);
    const moneyRaw = r.money ?? r.amount ?? null;

    if (sender_type !== SENDER_NATION) continue;
    if (![RECEIVER_ALLIANCE, RECEIVER_ALLIANCE_BANK].includes(receiver_type)) continue;

    const amount = moneyRaw == null ? 0 : Number(moneyRaw);
    if (!amount || !Number.isFinite(amount) || amount <= 0) continue;

    // Find the depositing member by nationId (and optionally alliance scope)
    const nationIdNum = Number(sender_id);
    const member = await prisma.member.findFirst({
      where: { nationId: nationIdNum, allianceId },
      select: { id: true, discordId: true, nationId: true, allianceId: true },
    });
    if (!member) continue;

    const reason = `BR:${String(r.id)}:money`;

    // Upsert the SafeTxn using the unique reason (avoids double-credit)
    await prisma.safeTxn.upsert({
      where: { reason },
      update: {}, // nothing to change if it already exists
      create: {
        memberId: member.id,
        resource: "money",
        amount: new Prisma.Decimal(amount.toString()),
        type: SafeTxnType.AUTO_CREDIT,
        actorDiscordId: null,
        reason,
      },
    });

    // Upsert Safekeeping; create must supply relation `member`
    await prisma.safekeeping.upsert({
      where: { memberId: member.id },
      create: {
        member: { connect: { id: member.id } },
        money: new Prisma.Decimal(amount.toString()),
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
      update: {
        money: { increment: new Prisma.Decimal(amount.toString()) },
      },
    });

    // Optional DM notify (best-effort)
    try {
      if (client && member.discordId) {
        const user = await client.users.fetch(member.discordId).catch(() => null);
        if (user) {
          await user.send(
            [
              `**Deposit Credited to Safekeeping**`,
              `Alliance deposit detected`,
              `• 💵 money — ${amount} 💵`,
              ``,
              `Use /balance to view your updated safekeeping.`,
              `Bank record ${String(r.id)}`,
            ].join("\n")
          ).catch(() => {});
        }
      }
    } catch {
      // ignore DM failures
    }

    processed++;
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
  return processed;
}

async function tickOnce(prismaArg?: PrismaClient, client?: Client) {
  const p = prismaArg ?? prisma;
  const alliances = await p.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map(a => a.id).join(", ")}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map(a => a.id).join(", ")}`);

  for (const a of alliances) {
    await processAlliance(p, client, a.id);
  }
}

/**
 * Exported entrypoint expected by src/index.ts
 * Starts the rolling window poller and also runs an immediate tick.
 */
export async function startAutoApply(prismaArg?: PrismaClient, client?: Client) {
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);
  await tickOnce(prismaArg ?? prisma, client).catch(() => { /* logged inside */ });

  setInterval(() => {
    tickOnce(prismaArg ?? prisma, client).catch(() => { /* logged inside */ });
  }, POLL_MS);
}
