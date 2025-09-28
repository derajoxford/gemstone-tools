/* src/jobs/pnw_auto_apply.ts */

import { Client as DiscordClient } from 'discord.js';
import { PrismaClient, Prisma, SafeTxnType } from '@prisma/client';

const prisma = new PrismaClient();

// ---- constants -------------------------------------------------------------

// PnW type codes we care about
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3;

// rolling window & polling cadence
const WINDOW_MS = Number(process.env.AUTO_CREDIT_WINDOW_MS ?? 2 * 24 * 60 * 60 * 1000); // 48h
const POLL_MS = Number(process.env.AUTO_CREDIT_POLL_MS ?? 5 * 60 * 1000); // 5m

// ---------------------------------------------------------------------------

type ResourceKey =
  | 'money'
  | 'food'
  | 'coal'
  | 'oil'
  | 'uranium'
  | 'lead'
  | 'iron'
  | 'bauxite'
  | 'gasoline'
  | 'munitions'
  | 'steel'
  | 'aluminum';

type BankrecRow = {
  id: string | number;
  date: string;
  note?: string | null;
  sender_type: number | string;
  sender_id: string | number;
  receiver_type: number | string;
  receiver_id: string | number;
  money?: number | string | null;
  food?: number | string | null;
  coal?: number | string | null;
  oil?: number | string | null;
  uranium?: number | string | null;
  lead?: number | string | null;
  iron?: number | string | null;
  bauxite?: number | string | null;
  gasoline?: number | string | null;
  munitions?: number | string | null;
  steel?: number | string | null;
  aluminum?: number | string | null;
  alliance_id_derived?: number;
  created_at?: Date;
};

// ---- atomic credit helper (idempotent via SafeTxn.reason UNIQUE) -----------

async function creditDepositAtomic(
  p: PrismaClient,
  memberId: number,
  resource: ResourceKey,
  amount: Prisma.Decimal | number | string,
  bankrecId: string
) {
  const dAmt = new Prisma.Decimal(amount);
  const reason = `BR:${bankrecId}:${resource}`;

  return p
    .$transaction(async (tx) => {
      // 1) Ledger first (enforces idempotency)
      await tx.safeTxn.create({
        data: {
          memberId,
          resource,
          amount: dAmt,
          type: SafeTxnType.AUTO_CREDIT,
          reason, // UNIQUE when not null
        },
      });

      // 2) Then increment safekeeping (source of truth)
      const updateData: Record<string, any> = {};
      updateData[resource] = { increment: dAmt };

      const createData: Record<string, any> = {
        memberId,
        // initialize all fields to 0; set credited resource to amount
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
      };
      createData[resource] = dAmt;

      await tx.safekeeping.upsert({
        where: { memberId },
        update: updateData,
        create: createData,
      });

      const sk = await tx.safekeeping.findUnique({ where: { memberId } });
      return { reason, balance: sk };
    })
    .catch((e: any) => {
      // If duplicate, it's already been applied (skip)
      if (e?.code === 'P2002') {
        return { reason, duplicate: true as const };
      }
      throw e;
    });
}

// ---- PnW live fetch (alliances -> bankrecs) --------------------------------

async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    const base = process.env.PNW_GRAPHQL_URL || 'https://api.politicsandwar.com/graphql';
    const url = new URL(base);
    url.searchParams.set('api_key', apiKey);

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
      }
    `;

    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      console.warn(`[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`);
      return [];
    }

    const json: any = await resp.json();
    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      console.warn(
        '[auto-credit] PnW API GraphQL errors:',
        json.errors.map((e: any) => e?.message ?? e),
      );
      return [];
    }

    const recs: any[] = json?.data?.alliances?.[0]?.bankrecs ?? [];
    const cutoff = since.getTime();

    const mapped: BankrecRow[] = recs
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          ...r,
          id: String(r.id),
          created_at,
          alliance_id_derived: allianceId,
          sender_type: Number(r.sender_type),
          receiver_type: Number(r.receiver_type),
        } as BankrecRow;
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&
          // Accept alliance-level receives (2) and explicit alliance (3)
          (r.receiver_type === 2 || r.receiver_type === RECEIVER_ALLIANCE) &&
          r.created_at instanceof Date &&
          !Number.isNaN(r.created_at.getTime()) &&
          r.created_at.getTime() > cutoff,
      )
      .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());

    console.log(`[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`);
    return mapped;
  } catch (e) {
    console.warn('[auto-credit] PnW API fallback error:', e);
    return [];
  }
}

// ---- union of cache + legacy + live ----------------------------------------

async function fetchRecentRows(p: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // New cached table
  const cache = await p.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [2, RECEIVER_ALLIANCE] },
    },
    orderBy: { created_at: 'asc' },
    take: 1000,
  });

  // Legacy table
  const legacy = await p.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: RECEIVER_ALLIANCE,
    },
    orderBy: { date: 'asc' },
    take: 1000,
  });

  // Live PnW
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  // Merge & dedupe by raw bankrec id
  const combined: any[] = [...cache, ...legacy, ...live];
  const seen = new Set<string>();
  const deduped = combined.filter((r: any) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort by time (prefer created_at; fallback to date)
  deduped.sort((a: any, b: any) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : new Date(a.date).getTime();
    const tb = b.created_at ? new Date(b.created_at).getTime() : new Date(b.date).getTime();
    return ta - tb;
  });

  const source = live.length
    ? 'union_local+pnw_api'
    : cache.length
    ? 'alliance_bankrec'
    : legacy.length
    ? 'bankrec'
    : 'empty';

  return { rows: deduped as BankrecRow[], source };
}

// ---- small helpers ----------------------------------------------------------

async function sendDM(client: DiscordClient | undefined, discordId: string | null, msg: string) {
  if (!client || !discordId) return;
  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (user) await user.send(msg).catch(() => null);
  } catch {
    /* noop */
  }
}

function fmtAmount(x: Prisma.Decimal | number | string | null | undefined) {
  if (x == null) return '0';
  const d = new Prisma.Decimal(x);
  return d.toFixed(2);
}

// ---- main tick --------------------------------------------------------------

async function processAlliance(p: PrismaClient, client: DiscordClient | undefined, allianceId: number) {
  const { rows, source } = await fetchRecentRows(p, allianceId);
  console.log(`[auto-credit] alliance ${allianceId} fetched ${rows.length} rows (source=${source})`);

  let processed = 0;

  for (const r of rows) {
    // Only nation -> alliance(-bank)
    if (Number(r.sender_type) !== SENDER_NATION) continue;
    if (![2, RECEIVER_ALLIANCE].includes(Number(r.receiver_type))) continue;

    const nationId = Number(r.sender_id);
    if (!nationId || Number.isNaN(nationId)) continue;

    const member = await p.member.findFirst({ where: { nationId } });
    if (!member) continue;

    // MONEY only (extend for other resources if desired)
    const money = r.money ? new Prisma.Decimal(r.money) : null;
    if (money && money.gt(0)) {
      const res = await creditDepositAtomic(p, member.id, 'money', money, String(r.id));
      if (!('duplicate' in res)) {
        processed++;

        // optional: DM
        const newBal = res.balance?.money ? new Prisma.Decimal(res.balance.money).toFixed(2) : '—';
        const msg =
          `**Deposit Credited to Safekeeping**\n` +
          `Alliance deposit detected\n` +
          `• 💵 money — ${fmtAmount(money)} 💵\n\n` +
          `Use /balance to view your updated safekeeping.\n` +
          `Bank record ${r.id} • ${new Date(r.date).toLocaleString('en-US', { timeZone: 'UTC' })} UTC`;

        await sendDM(client, member.discordId, msg);

        // optional: log new balance
        console.log(
          `[auto-credit] credited BR:${r.id} -> member ${member.id} (nation ${nationId}) money=${money.toFixed(
            2,
          )} newBalance=${newBal}`,
        );
      }
    }
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
}

// ---- public entrypoints -----------------------------------------------------

export async function tickOnce(client?: DiscordClient) {
  const alliances = await prisma.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(', ')}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(', ')}`);
  for (const a of alliances) {
    await processAlliance(prisma, client, a.id);
  }
}

export function startRollingWindow(client?: DiscordClient) {
  console.log(
    `[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`,
  );
  // fire immediately, then interval
  tickOnce(client).catch((e) => console.warn('[auto-credit] tickOnce error:', e));
  setInterval(() => {
    tickOnce(client).catch((e) => console.warn('[auto-credit] tickOnce error:', e));
  }, POLL_MS);
}
