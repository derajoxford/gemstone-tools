import { PrismaClient } from "@prisma/client";
import type { Client } from "discord.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const POLL_MS = Number(process.env.PNW_AUTO_APPLY_POLL_MS ?? 5 * 60 * 1000); // 5m
const WINDOW_MS = Number(process.env.PNW_AUTO_APPLY_WINDOW_MS ?? 2 * 24 * 60 * 60 * 1000); // 48h

// PnW type enums we use
const SENDER_NATION = 1 as const;
const RECEIVER_ALLIANCE_BANK = 2 as const; // internal “alliance bank” type in PnW
const RECEIVER_ALLIANCE = 3 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type DepositResource =
  | "money" | "food" | "coal" | "oil" | "uranium"
  | "lead"  | "iron" | "bauxite" | "gasoline"
  | "munitions" | "steel" | "aluminum";

/**
 * Credit exactly one deposit bankrec, once, per resource.
 * - Idempotent via SafeTxn.reason = "BR:<bankrecId>:<resource>"
 * - Credits "money" at face value (no market pricing)
 */
async function creditSingleDepositRow(
  p: PrismaClient,
  row: any,
  allianceId: number,
  client?: Client
) {
  // Only deposits from nation → alliance or nation → alliance-bank
  const st = Number(row?.sender_type);
  const rt = Number(row?.receiver_type);
  const rid = Number(row?.receiver_id);

  if (st !== SENDER_NATION) return;
  if (rt !== RECEIVER_ALLIANCE && rt !== RECEIVER_ALLIANCE_BANK) return;
  if (rid !== Number(allianceId)) return;

  const nationId = Number(row?.sender_id);
  if (!nationId) return;

  // Find member by nation id (adjust fields if your schema differs)
  const member = await p.member.findFirst({
    where: { pnwNationId: nationId, allianceId },
    select: { id: true, discordUserId: true },
  });

  if (!member) {
    console.log(`[auto-credit] skip bankrec=${row?.id} — no member for nation ${nationId}`);
    return;
  }

  // List of resources from the bankrec (credit these at face value)
  const resources: Array<[DepositResource, number]> = [
    ["money", Number(row.money) || 0],
    ["food", Number(row.food) || 0],
    ["coal", Number(row.coal) || 0],
    ["oil", Number(row.oil) || 0],
    ["uranium", Number(row.uranium) || 0],
    ["lead", Number(row.lead) || 0],
    ["iron", Number(row.iron) || 0],
    ["bauxite", Number(row.bauxite) || 0],
    ["gasoline", Number(row.gasoline) || 0],
    ["munitions", Number(row.munitions) || 0],
    ["steel", Number(row.steel) || 0],
    ["aluminum", Number(row.aluminum) || 0],
  ];

  for (const [res, amtRaw] of resources) {
    const amt = Number(amtRaw);
    if (!amt || amt <= 0) continue;

    // One SafeTxn per (bankrec, resource) to guarantee idempotency
    const reason = `BR:${String(row.id)}:${res}`;

    const exists = await p.safeTxn.count({ where: { reason } });
    if (exists) {
      // Already credited earlier
      continue;
    }

    const creditAmount = amt; // face value

    await p.safeTxn.create({
      data: {
        memberId: member.id,
        type: "AUTO_CREDIT",
        amount: creditAmount,
        reason,
        meta: {
          bankrecId: String(row.id),
          resource: res,
          sender_nation_id: nationId,
          receiver_type: rt,
          note: String(row?.note ?? ""),
          date: String(row?.date ?? ""),
          source: "pnw_auto_apply",
        } as any,
      },
    });

    console.log(
      `[auto-credit] credited member=${member.id} bankrec=${row.id} res=${res} amount=${creditAmount}`
    );

    // DM (best-effort)
    try {
      if (client && member.discordUserId) {
        const user = await client.users.fetch(member.discordUserId).catch(() => null);
        if (user) {
          const lines = [
            `💎 Safekeeping credit: +${creditAmount} ${res} (bankrec ${row.id})`,
          ];
          if (row?.note) lines.push(`Note: ${row.note}`);
          await user.send(lines.join("\n")).catch(() => {});
        }
      }
    } catch (e) {
      console.warn(`[auto-credit] DM failed for member=${member.id} bankrec=${row.id}`, e);
    }
  }
}

/**
 * Live PnW fetch — alliances(id:[AID]) { data { bankrecs(...) { ... } } }
 * - Uses correct AlliancePaginator → data → Alliance shape.
 * - Filters to Nation→(Alliance|Alliance-Bank), limited result count.
 * - No "after" to dodge the server's strict DateTime parsing nuances; we filter in code.
 */
async function fetchAllianceDepositsFromPnWAPI(prisma: PrismaClient, allianceId: number, since: Date) {
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

    // On Alliance.bankrecs: `limit` is valid (per introspection), returns LIST not paginator
    // We ask for stype 1 (nation) and rtype 2|3 (alliance bank or alliance), then filter by date locally.
    const query = `
    {
      alliances(id:[${allianceId}]) {
        data {
          id
          bankrecs(stype:[1], rtype:[2,3], limit: 100) {
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
    }`;

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

    // alliances → data[] → [0] → bankrecs[]
    const recs: any[] =
      json?.data?.alliances?.data?.[0]?.bankrecs ??
      [];

    const cutoff = since.getTime();

    const mapped = recs
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
        };
      })
      .filter((r) =>
        r.sender_type === SENDER_NATION &&
        (r.receiver_type === RECEIVER_ALLIANCE || r.receiver_type === RECEIVER_ALLIANCE_BANK) &&
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

/**
 * Pulls rows from:
 *   1) new cache table: allianceBankrec
 *   2) legacy table:    bankrec
 *   3) live PnW API:    alliances→data→bankrecs
 * Merges, de-dupes by id, sorts by time asc, and returns with a source tag.
 */
async function fetchRecentRows(p: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) New cached table
  const cache = await p.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [RECEIVER_ALLIANCE, RECEIVER_ALLIANCE_BANK] },
    },
    orderBy: { created_at: "asc" },
    take: 1000,
  });

  // 2) Legacy table
  const legacy = await p.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [RECEIVER_ALLIANCE, RECEIVER_ALLIANCE_BANK] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  // 3) Live PnW API and merge
  const live = await fetchAllianceDepositsFromPnWAPI(p, allianceId, since);

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
    const ta = (a.created_at ? new Date(a.created_at).getTime() : new Date(a.date).getTime());
    const tb = (b.created_at ? new Date(b.created_at).getTime() : new Date(b.date).getTime());
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

// ─────────────────────────────────────────────────────────────────────────────
// Job runner
// ─────────────────────────────────────────────────────────────────────────────

async function tickOnce(p: PrismaClient, client: Client | undefined) {
  const alliances = await p.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map(a => a.id).join(", ")}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map(a => a.id).join(", ")}`);

  for (const a of alliances) {
    const { rows, source } = await fetchRecentRows(p, a.id);
    console.log(`[auto-credit] alliance ${a.id} fetched ${rows.length} rows (source=${source})`);

    // credit per-bankrec, idempotent
    for (const row of rows) {
      await creditSingleDepositRow(p, row, a.id, client);
    }

    // A short micro-gap to be polite with rate limits/Discord DMs
    await new Promise((r) => setTimeout(r, 50));
  }
}

export default async function runAutoCredit(client?: Client) {
  const prisma = new PrismaClient();
  console.log(
    `[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`
  );

  // initial tick
  await tickOnce(prisma, client);

  // subsequent ticks
  setInterval(async () => {
    try {
      await tickOnce(prisma, client);
    } catch (e) {
      console.warn("[auto-credit] tick error:", e);
    }
  }, POLL_MS);
}
