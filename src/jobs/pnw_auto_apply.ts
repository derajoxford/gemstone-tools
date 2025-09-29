// src/jobs/pnw_auto_apply.ts
import type { Client } from "discord.js";
import { PrismaClient, SafeTxnType } from "@prisma/client";

// One local Prisma for this job (matches index.ts calling startAutoApply(client))
const prisma = new PrismaClient();

// PnW constants
const SENDER_NATION = 1;
// PnW uses 2 for "AA" and 3 for "Alliance" depending on context; accept both.
const RECEIVER_AA = 2;
const RECEIVER_ALLIANCE = 3;

// Window & poll
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h
const POLL_MS = 5 * 60 * 1000; // 5m

type DepositRow = {
  id: string;
  created_at: Date;
  date?: Date;
  alliance_id_derived: number;

  sender_type: number;
  sender_id: string; // nation id (string from API/DB)
  receiver_type: number;
  receiver_id?: string | null;

  note?: string | null;
  // resources (we only process money for auto-credit)
  money?: number;
};

function isDepositToAlliance(r: DepositRow): boolean {
  return (
    r.sender_type === SENDER_NATION &&
    (r.receiver_type === RECEIVER_AA || r.receiver_type === RECEIVER_ALLIANCE)
  );
}

/**
 * Live PnW GraphQL fetch. IMPORTANT: alliances -> data[]; bankrecs -> data[]
 */
async function fetchAllianceDepositsFromPnWAPI(
  allianceId: number,
  since: Date
): Promise<DepositRow[]> {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({
      where: { allianceId },
    });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    const base =
      process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    const query = `
      {
        alliances(id:[${allianceId}]) {
          data {
            id
            bankrecs(first: 100) {
              data {
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
      }
    `;

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      console.warn(
        `[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`
      );
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

    const nodes: any[] =
      json?.data?.alliances?.data?.[0]?.bankrecs?.data ?? [];
    const cutoff = since.getTime();

    const mapped: DepositRow[] = nodes
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          id: String(r.id),
          created_at,
          date: created_at,
          alliance_id_derived: allianceId,
          sender_type: Number(r.sender_type),
          sender_id: String(r.sender_id),
          receiver_type: Number(r.receiver_type),
          receiver_id: r.receiver_id != null ? String(r.receiver_id) : null,
          note: r.note ?? null,
          money: r.money != null ? Number(r.money) : 0,
        } as DepositRow;
      })
      .filter(
        (r) =>
          isDepositToAlliance(r) &&
          r.created_at instanceof Date &&
          !Number.isNaN(r.created_at.getTime()) &&
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

/**
 * Pull recent rows from:
 * 1) new cached table allianceBankrec (metadata only; money not present)
 * 2) legacy Bankrec (has money)
 * 3) live API (has money)
 * Merge, dedupe by id, sort by time.
 */
async function fetchRecentRows(allianceId: number): Promise<{
  rows: DepositRow[];
  source: string;
}> {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) New cache (metadata-only)
  const cache = await prisma.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [RECEIVER_AA, RECEIVER_ALLIANCE] },
    },
    orderBy: { created_at: "asc" },
    take: 1000,
  });
  const cacheMapped: DepositRow[] = cache.map((r) => ({
    id: String(r.id),
    created_at: r.created_at,
    date: r.date ?? r.created_at,
    alliance_id_derived: allianceId,
    sender_type: Number(r.sender_type),
    sender_id: String(r.sender_id),
    receiver_type: Number(r.receiver_type),
    receiver_id: r.receiver_id ? String(r.receiver_id) : null,
    note: r.note ?? null,
    money: 0, // cache doesn’t expose resource amounts
  }));

  // 2) Legacy table (has money)
  const legacy = await prisma.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [RECEIVER_AA, RECEIVER_ALLIANCE] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });
  const legacyMapped: DepositRow[] = legacy.map((r) => ({
    id: String(r.id),
    created_at: r.date,
    date: r.date,
    alliance_id_derived: allianceId,
    sender_type: r.senderType,
    sender_id: String(r.senderId),
    receiver_type: r.receiverType,
    receiver_id: String(r.receiverId),
    note: r.note ?? null,
    money: r.money != null ? Number(r.money) : 0,
  }));

  // 3) Live API
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  // Merge + dedupe
  const combined = [...cacheMapped, ...legacyMapped, ...live];
  const seen = new Set<string>();
  const deduped = combined.filter((r) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort final
  deduped.sort((a, b) => {
    const ta = (a.created_at ?? a.date ?? new Date(0)).getTime();
    const tb = (b.created_at ?? b.date ?? new Date(0)).getTime();
    return ta - tb;
  });

  const source = live.length
    ? "union_local+pnw_api"
    : cache.length
    ? "alliance_bankrec"
    : legacy.length
    ? "bankrec"
    : "empty";

  return { rows: deduped, source };
}

/**
 * Process new deposit rows (money only):
 * - find Member by (allianceId, nationId=sender_id)
 * - upsert SafeTxn with reason "BR:<id>:money" (unique)
 * - upsert Safekeeping for that member; create connects member on first write
 * - DM (optional) the depositor
 */
async function processDepositsForAlliance(
  allianceId: number,
  rows: DepositRow[],
  client?: Client
): Promise<number> {
  let processed = 0;

  for (const r of rows) {
    if (!isDepositToAlliance(r)) continue;

    const money = Number(r.money ?? 0);
    if (!(money > 0)) continue;

    const nationId = Number(r.sender_id);
    if (!Number.isFinite(nationId)) continue;

    const member = await prisma.member.findFirst({
      where: { allianceId, nationId },
      select: { id: true, discordId: true },
    });
    if (!member) continue;

    const reason = `BR:${r.id}:money`;

    // idempotent ledger insert
    const existing = await prisma.safeTxn.findFirst({
      where: { reason },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.$transaction(async (tx) => {
      // 1) create ledger row
      await tx.safeTxn.create({
        data: {
          memberId: member.id,
          resource: "money",
          amount: money,
          type: SafeTxnType.AUTO_CREDIT,
          reason,
        },
      });

      // 2) upsert balance
      await tx.safekeeping.upsert({
        where: { memberId: member.id },
        create: {
          member: { connect: { id: member.id } }, // IMPORTANT for typed create
          money: money,
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
          money: { increment: money },
        },
      });
    });

    // DM (best-effort)
    if (client && member.discordId) {
      try {
        const user = await client.users.fetch(member.discordId);
        if (user) {
          await user.send(
            [
              `Deposit Credited to Safekeeping`,
              `Alliance deposit detected`,
              `• 💵 money — ${money} 💵`,
              ``,
              `Use /balance to view your updated safekeeping.`,
              `Bank record ${r.id}`,
            ].join("\n")
          );
        }
      } catch {
        // swallow DM errors
      }
    }

    processed++;
  }

  return processed;
}

/**
 * One tick over all alliances in DB.
 */
async function tickOnce(client?: Client) {
  let totalProcessed = 0;

  const alliances = await prisma.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);

  for (const a of alliances) {
    const { rows, source } = await fetchRecentRows(a.id);
    console.log(`[auto-credit] alliance ${a.id} fetched ${rows.length} rows (source=${source})`);

    const processed = await processDepositsForAlliance(a.id, rows, client);
    console.log(`[auto-credit] processed ${processed} deposit rows`);
    totalProcessed += processed;
  }

  return totalProcessed;
}

/**
 * Public entry — called from index.ts as startAutoApply(client).
 */
export function startAutoApply(client?: Client) {
  console.log(
    `[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`
  );

  // kick one immediately
  tickOnce(client).catch((e) => console.warn("[auto-credit] tick error:", e));

  // then schedule
  setInterval(() => {
    tickOnce(client).catch((e) => console.warn("[auto-credit] tick error:", e));
  }, POLL_MS);
}
