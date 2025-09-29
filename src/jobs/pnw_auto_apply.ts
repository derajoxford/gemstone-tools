// src/jobs/pnw_auto_apply.ts
// FULL FILE — compiles with Prisma 5.x, Node 20+

import { PrismaClient, Prisma } from '@prisma/client';

// Types we normalize bank rows into
type BankRow = {
  id: string;
  date: string | Date;
  note?: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
  money: number;
  // optional normalized fields
  alliance_id_derived?: number;
  created_at?: Date;
};

// Constants (PnW type ids)
const SENDER_NATION = 1;
// Alliance appears as 2 or 3 in different sources; accept both.
const RECEIVER_ALLIANCE_PRIMARY = 2;
const RECEIVER_ALLIANCE_ALT = 3;

const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h rolling window
const POLL_MS = 5 * 60 * 1000; // 5 minutes

// ---- Live PnW GraphQL fetch (alliances -> bankrecs) ------------------------

async function fetchAllianceDepositsFromPnWAPI(prisma: PrismaClient, allianceId: number, since: Date) {
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

    // We avoid "after" due to server-side parsing issues; pull recent block and filter client-side.
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
        json.errors.map((e: any) => e?.message ?? e)
      );
      return [];
    }

    const recs: any[] = json?.data?.alliances?.[0]?.bankrecs ?? [];
    const cutoff = since.getTime();

    const mapped: BankRow[] = recs
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          id: String(r.id),
          date: r.date,
          note: r.note ?? null,
          sender_type: Number(r.sender_type),
          sender_id: String(r.sender_id),
          receiver_type: Number(r.receiver_type),
          receiver_id: String(r.receiver_id),
          money: Number(r.money ?? 0),
          alliance_id_derived: allianceId,
          created_at,
        } as BankRow;
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&
          (r.receiver_type === RECEIVER_ALLIANCE_PRIMARY ||
            r.receiver_type === RECEIVER_ALLIANCE_ALT) &&
          r.created_at instanceof Date &&
          !Number.isNaN(r.created_at.getTime()) &&
          r.created_at.getTime() > cutoff
      )
      .sort((a, b) => (a.created_at!.getTime() - b.created_at!.getTime()));

    console.log(`[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`);
    return mapped;
  } catch (e) {
    console.warn('[auto-credit] PnW API fallback error:', e);
    return [];
  }
}

// ---- Local recent fetch (cache + legacy + live union) ----------------------

async function fetchRecentRows(prisma: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) New cached table
  const cache = await prisma.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      date: { gt: since },
      sender_type: SENDER_NATION,
      // allow receiver_type 2 or 3
      receiver_type: { in: [RECEIVER_ALLIANCE_PRIMARY, RECEIVER_ALLIANCE_ALT] },
    },
    orderBy: { date: 'asc' },
    take: 1000,
  });

  // 2) Legacy table
  const legacy = await prisma.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [RECEIVER_ALLIANCE_PRIMARY, RECEIVER_ALLIANCE_ALT] },
    },
    orderBy: { date: 'asc' },
    take: 1000,
  });

  // 3) Live API
  const live = await fetchAllianceDepositsFromPnWAPI(prisma, allianceId, since);

  // Merge and dedupe
  const combined: any[] = [
    ...cache.map((r) => ({
      id: String(r.id),
      date: r.date,
      note: r.note,
      sender_type: r.sender_type,
      sender_id: String(r.sender_id),
      receiver_type: r.receiver_type,
      receiver_id: String(r.receiver_id),
      money: Number(r.money ?? 0),
      alliance_id_derived: r.alliance_id_derived,
      created_at: r.date,
    })),
    ...legacy.map((r) => ({
      id: String(r.id),
      date: r.date,
      note: r.note,
      sender_type: r.senderType,
      sender_id: String(r.senderId),
      receiver_type: r.receiverType,
      receiver_id: String(r.receiverId),
      money: Number(r.money ?? 0),
      alliance_id_derived: r.allianceId,
      created_at: r.date,
    })),
    ...live,
  ];

  const seen = new Set<string>();
  const deduped: BankRow[] = combined.filter((r: any) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => {
    const ta = new Date(a.created_at ?? a.date).getTime();
    const tb = new Date(b.created_at ?? b.date).getTime();
    return ta - tb;
  });

  const source = live.length
    ? 'union_local+pnw_api'
    : cache.length
    ? 'alliance_bankrec'
    : legacy.length
    ? 'bankrec'
    : 'empty';

  return { rows: deduped, source };
}

// ---- One tick --------------------------------------------------------------

async function tickOnce(prisma: PrismaClient) {
  let processed = 0;

  const alliances = await prisma.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(', ')}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(', ')}`);

  for (const a of alliances) {
    const { rows, source } = await fetchRecentRows(prisma, a.id);
    console.log(`[auto-credit] alliance ${a.id} fetched ${rows.length} rows (source=${source})`);

    for (const r of rows) {
      try {
        // Ignore zero/negative money rows
        const amt = Number(r.money ?? 0);
        if (!(amt > 0)) continue;

        // Who deposited? sender_id is nation id
        const nationId = Number(r.sender_id);
        if (!Number.isFinite(nationId)) continue;

        // Find the member row
        const member = await prisma.member.findFirst({
          where: { nationId },
          select: { id: true, discordId: true, allianceId: true },
        });
        if (!member) continue;

        // Idempotency key
        const reason = `BR:${String(r.id)}:money`;

        // De-dupe WITHOUT relying on a unique index on reason
        const existing = await prisma.safeTxn.findFirst({ where: { reason } });
        if (existing) continue;

        // Create SafeTxn
        await prisma.safeTxn.create({
          data: {
            memberId: member.id,
            resource: 'money',
            amount: new Prisma.Decimal(amt),
            type: 'AUTO_CREDIT',
            actorDiscordId: null,
            reason,
          },
        });

        // Upsert/increment Safekeeping balance
        await prisma.safekeeping.upsert({
          where: { memberId: member.id },
          update: { money: { increment: amt } },
          create: { memberId: member.id, money: new Prisma.Decimal(amt) },
        });

        processed += 1;
      } catch (e) {
        console.warn('[auto-credit] row process error:', e);
      }
    }

    console.log(`[auto-credit] alliance ${a.id} rows=${rows.length} source=${source}`);
    console.log(`[auto-credit] processed ${processed} deposit rows`);
    if (rows.length === 0) {
      console.log(`[auto-credit] no recent deposit rows found for alliance ${a.id} (source=${source})`);
    }
  }
}

// ---- Public API ------------------------------------------------------------

export function startAutoApply(prisma: PrismaClient) {
  console.log(
    `[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`
  );

  // Run immediately once, then on interval
  tickOnce(prisma).catch((e) => console.warn('[auto-credit] initial tick error:', e));

  setInterval(() => {
    tickOnce(prisma).catch((e) => console.warn('[auto-credit] tick error:', e));
  }, POLL_MS);
}
