// src/jobs/pnw_auto_apply.ts
import { Client } from "discord.js";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- constants --------------------------------------------------------------
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 3; // also accept 2 (bank) below
const WINDOW_MS = Number(process.env.AUTO_CREDIT_WINDOW_MS ?? 2 * 24 * 60 * 60 * 1000); // 48h
const POLL_MS = Number(process.env.AUTO_CREDIT_POLL_MS ?? 5 * 60 * 1000); // 5m

// --- helpers ---------------------------------------------------------------
function parseDateSafe(v: any): Date {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function toDecimal(n: number | string): Prisma.Decimal {
  return new Prisma.Decimal(Number(n) || 0);
}

async function dmUser(
  client: Client | undefined,
  discordId: string | null | undefined,
  lines: string[]
) {
  if (!client || !discordId) return;
  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return;
    await user.send(lines.join("\n")).catch(() => null);
  } catch {
    // ignore DM errors
  }
}

// --- live PnW API fallback --------------------------------------------------
// NOTE: API schema differences:
// - Root field often returns a paginator, so we query: alliances(id:[...]) { data { id bankrecs { ... } } }
// - We also OMIT any args on bankrecs to avoid "first/limit" incompatibility across shards.
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
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

    const query = `
      {
        alliances(id:[${allianceId}]) {
          data {
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

    // works whether API uses paginator or direct array
    const alliancesArr: any[] =
      json?.data?.alliances?.data ??
      json?.data?.alliances ??
      [];

    const recs: any[] = alliancesArr?.[0]?.bankrecs ?? [];
    const cutoff = since.getTime();

    const mapped = recs
      .map((r) => {
        const created_at = parseDateSafe(r.date);
        return {
          id: String(r.id),
          date: created_at,
          created_at,
          note: String(r.note ?? ""),
          sender_type: Number(r.sender_type),
          sender_id: String(r.sender_id ?? ""),
          receiver_type: Number(r.receiver_type),
          receiver_id: String(r.receiver_id ?? ""),
          money: Number(r.money ?? 0),
          alliance_id_derived: allianceId,
        };
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&
          (r.receiver_type === 2 || r.receiver_type === RECEIVER_ALLIANCE) &&
          r.created_at.getTime() > cutoff
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

// --- local DB fetch (recent) ------------------------------------------------
async function fetchRecentRows(p: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // Legacy table (what you already have data in)
  const legacy = await p.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [2, RECEIVER_ALLIANCE] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  const mappedLegacy = legacy.map((r: any) => {
    const created_at = parseDateSafe(r.date);
    return {
      id: String(r.id),
      date: created_at,
      created_at,
      note: String(r.note ?? ""),
      sender_type: Number(r.senderType),
      sender_id: String(r.senderId ?? r.sender_id ?? ""),
      receiver_type: Number(r.receiverType),
      receiver_id: String(r.receiverId ?? r.receiver_id ?? ""),
      money: Number(r.money ?? 0),
      alliance_id_derived: Number(r.allianceId ?? allianceId),
    };
  });

  // Live API fallback merged in
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  const combined: any[] = [...mappedLegacy, ...live];
  const seen = new Set<string>();
  const deduped = combined.filter((r) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

  const source = live.length ? "union_legacy+pnw_api" : (mappedLegacy.length ? "bankrec" : "empty");
  return { rows: deduped, source };
}

// --- per-alliance processing ------------------------------------------------
async function processAlliance(allianceId: number, client: Client | undefined) {
  const { rows, source } = await fetchRecentRows(prisma, allianceId);
  console.log(
    `[auto-credit] alliance ${allianceId} fetched ${rows.length} rows (source=${source})`
  );

  let processed = 0;

  for (const r of rows) {
    const bankrecId = String(r.id);
    const reason = `BR:${bankrecId}:money`;
    const amount = Number(r.money ?? 0);
    if (!amount || amount <= 0) continue;

    // idempotency (if reason exists, skip)
    const existing = await prisma.safeTxn.findFirst({ where: { reason } });
    if (existing) continue;

    // map sender nation -> member in same alliance
    const nationIdNum = Number(r.sender_id);
    if (!nationIdNum || Number.isNaN(nationIdNum)) continue;

    const member = await prisma.member.findFirst({
      where: { allianceId, nationId: nationIdNum },
      select: { id: true, discordId: true },
    });
    if (!member) continue;

    await prisma.$transaction(async (tx) => {
      // 1) ledger
      await tx.safeTxn.create({
        data: {
          memberId: member.id,
          resource: "money",
          amount: toDecimal(amount),
          type: "AUTO_CREDIT" as any,
          reason,
        },
      });

      // 2) balance
      await tx.safekeeping.upsert({
        where: { memberId: member.id },
        create: {
          member: { connect: { id: member.id } },
          money: toDecimal(amount),
          food: toDecimal(0),
          coal: toDecimal(0),
          oil: toDecimal(0),
          uranium: toDecimal(0),
          lead: toDecimal(0),
          iron: toDecimal(0),
          bauxite: toDecimal(0),
          gasoline: toDecimal(0),
          munitions: toDecimal(0),
          steel: toDecimal(0),
          aluminum: toDecimal(0),
        },
        update: { money: { increment: amount } },
      });
    });

    await dmUser(client, member.discordId, [
      `**Deposit Credited to Safekeeping**`,
      `Alliance deposit detected`,
      `• 💵 money — ${amount} 💵`,
      ``,
      `Use /balance to view your updated safekeeping.`,
      `Bank record ${bankrecId}`,
    ]);

    processed += 1;
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
}

// --- main tick --------------------------------------------------------------
async function tickOnce(client: Client | undefined) {
  const alliances = await prisma.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);

  for (const a of alliances) {
    await processAlliance(a.id, client);
  }
}

// --- exported runner --------------------------------------------------------
export function startAutoApply(client: Client | undefined) {
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);

  tickOnce(client).catch((e) => console.warn("[auto-credit] initial tick error", e));

  setInterval(() => {
    tickOnce(client).catch((e) => console.warn("[auto-credit] periodic tick error", e));
  }, POLL_MS);
}
