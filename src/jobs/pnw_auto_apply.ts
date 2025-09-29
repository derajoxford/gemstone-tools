/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client, TextBasedChannel } from "discord.js";
import { PrismaClient, SafeTxnType } from "@prisma/client";

const prisma = new PrismaClient();

/** Poll window and cadence */
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h
const POLL_MS = 5 * 60 * 1000;             // 5m

/** PnW constants */
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 2;

/** Simple sleep */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** DM helper */
async function dmUser(client: Client | undefined, discordId: string, content: string) {
  if (!client || !discordId) return;
  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return;
    await user.send({ content });
  } catch {
    /* ignore DM failures */
  }
}

/** --- LIVE PnW API (GraphQL) fallback ------------------------------- */
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    // Politics & War v3 GraphQL:
    // - endpoint usually: https://api.politicsandwar.com/graphql
    // - accepts ?api_key= in query (safer for some proxies)
    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // Important: bankrecs accepts `limit:` on Alliance type (not `first:`).
    // We request enough and filter locally by `since`.
    const query = `
      {
        alliances(id:[${allianceId}]) {
          id
          bankrecs(limit: 250) {
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

    const mapped = recs
      .map((r) => {
        const d = new Date(String(r.date));
        const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
        return {
          id: String(r.id),
          date: created_at,
          note: String(r.note ?? ""),
          sender_type: Number(r.sender_type),
          sender_id: String(r.sender_id ?? ""),
          receiver_type: Number(r.receiver_type),
          receiver_id: String(r.receiver_id ?? ""),
          alliance_id_derived: allianceId,
          money: Number(r.money ?? 0),
          food: Number(r.food ?? 0),
          coal: Number(r.coal ?? 0),
          oil: Number(r.oil ?? 0),
          uranium: Number(r.uranium ?? 0),
          lead: Number(r.lead ?? 0),
          iron: Number(r.iron ?? 0),
          bauxite: Number(r.bauxite ?? 0),
          gasoline: Number(r.gasoline ?? 0),
          munitions: Number(r.munitions ?? 0),
          steel: Number(r.steel ?? 0),
          aluminum: Number(r.aluminum ?? 0),
        };
      })
      .filter(
        (r) =>
          r.sender_type === SENDER_NATION &&
          r.receiver_type === RECEIVER_ALLIANCE &&
          r.date instanceof Date &&
          !Number.isNaN(r.date.getTime()) &&
          r.date.getTime() > cutoff
      )
      .sort((a, b) => (a.date as Date).getTime() - (b.date as Date).getTime());

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

/** --- Merge recent rows from DB caches + live API ------------------- */
async function fetchRecentRows(allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) New cached table
  const cache = await prisma.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      date: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: RECEIVER_ALLIANCE,
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  // 2) Legacy table
  const legacy = await prisma.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: RECEIVER_ALLIANCE,
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  // 3) Live fallback
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  // Normalize legacy shape → the same keys as `live`
  const legacyNorm = legacy.map((r: any) => ({
    id: String(r.id),
    date: r.date,
    note: String(r.note ?? ""),
    sender_type: Number(r.senderType),
    sender_id: String(r.senderId ?? ""),
    receiver_type: Number(r.receiverType),
    receiver_id: String(r.receiverId ?? ""),
    alliance_id_derived: allianceId,
    money: Number(r.money ?? 0),
    food: Number(r.food ?? 0),
    coal: Number(r.coal ?? 0),
    oil: Number(r.oil ?? 0),
    uranium: Number(r.uranium ?? 0),
    lead: Number(r.lead ?? 0),
    iron: Number(r.iron ?? 0),
    bauxite: Number(r.bauxite ?? 0),
    gasoline: Number(r.gasoline ?? 0),
    munitions: Number(r.munitions ?? 0),
    steel: Number(r.steel ?? 0),
    aluminum: Number(r.aluminum ?? 0),
  }));

  const cacheNorm = cache.map((r: any) => ({
    id: String(r.id),
    date: r.date,
    note: String(r.note ?? ""),
    sender_type: Number(r.sender_type),
    sender_id: String(r.sender_id ?? ""),
    receiver_type: Number(r.receiver_type),
    receiver_id: String(r.receiver_id ?? ""),
    alliance_id_derived: allianceId,
    money: Number(r.money ?? 0),
    food: Number(r.food ?? 0),
    coal: Number(r.coal ?? 0),
    oil: Number(r.oil ?? 0),
    uranium: Number(r.uranium ?? 0),
    lead: Number(r.lead ?? 0),
    iron: Number(r.iron ?? 0),
    bauxite: Number(r.bauxite ?? 0),
    gasoline: Number(r.gasoline ?? 0),
    munitions: Number(r.munitions ?? 0),
    steel: Number(r.steel ?? 0),
    aluminum: Number(r.aluminum ?? 0),
  }));

  const combined: any[] = [...cacheNorm, ...legacyNorm, ...live];

  // Dedupe by bankrec id
  const seen = new Set<string>();
  const deduped = combined.filter((r) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  deduped.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const source = live.length
    ? (legacy.length || cache.length ? "union_legacy+pnw_api" : "pnw_api")
    : (cache.length ? "alliance_bankrec" : (legacy.length ? "bankrec" : "empty"));

  return { rows: deduped, source };
}

/** --- Apply a single bankrec deposit to safekeeping ----------------- */
async function applyOneDeposit(client: Client | undefined, allianceId: number, rec: any) {
  const bankrecId = String(rec.id);
  const nationId = Number(rec.sender_id || 0);

  // Find member by nationId & alliance
  const member = await prisma.member.findFirst({
    where: { nationId, allianceId },
    select: { id: true, discordId: true, nationId: true, allianceId: true },
  });

  if (!member) {
    console.log(`[auto-credit] skip bankrec ${bankrecId} — no member for nation ${nationId} (a=${allianceId})`);
    return false;
  }

  // Collect positive deltas (only credits)
  const deltas: Record<string, number> = {};
  const RES_KEYS = [
    "money", "food", "coal", "oil", "uranium", "lead",
    "iron", "bauxite", "gasoline", "munitions", "steel", "aluminum",
  ] as const;

  for (const k of RES_KEYS) {
    const v = Number(rec[k] ?? 0);
    if (v > 0) deltas[k] = v;
  }

  // Nothing to credit?
  if (Object.keys(deltas).length === 0) return false;

  // For each delta: upsert a SafeTxn (unique by reason) and increment the balance atomically
  let creditedSomething = false;

  for (const [resource, amount] of Object.entries(deltas)) {
    const reason = `BR:${bankrecId}:${resource}`;

    // SafeTxn upsert (unique on reason)
    await prisma.safeTxn.upsert({
      where: { reason },                        // relies on @unique on `reason`
      create: {
        memberId: member.id,
        resource,
        amount: amount.toFixed(2),
        type: SafeTxnType.AUTO_CREDIT,
        reason,
      },
      update: {},                               // if exists, do nothing
    });

    // Atomic increment on Safekeeping — **NO MULTIPLY** (the bug you saw)
    const updateData: any = {};
    updateData[resource] = { increment: amount };

    console.log(`[auto-credit] increment member=${member.id} resource=${resource} by ${amount} (reason=${reason})`);

    await prisma.safekeeping.upsert({
      where: { memberId: member.id },
      create: {
        member: { connect: { id: member.id } },
        // initialize with zeros then set deltas
        money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0,
        bauxite: 0, gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
        ...Object.fromEntries(Object.entries(deltas).map(([k, v]) => [k, v])),
      },
      update: updateData,
    });

    creditedSomething = true;

    // DM for money only (keep DMs tame)
    if (resource === "money") {
      await dmUser(
        client,
        member.discordId,
        [
          `**Deposit Credited to Safekeeping**`,
          `Alliance deposit detected`,
          `• 💵 money — ${amount} 💵`,
          ``,
          `Use /balance to view your updated safekeeping.`,
          `Bank record ${bankrecId}`,
        ].join("\n")
      );
    }
  }

  return creditedSomething;
}

/** --- Process once for all alliances in DB -------------------------- */
async function tickOnce(client?: Client) {
  let processed = 0;

  const alliances = await prisma.alliance.findMany({ select: { id: true } });
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
  console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);

  for (const a of alliances) {
    const { rows, source } = await fetchRecentRows(a.id);
    console.log(`[auto-credit] alliance ${a.id} fetched ${rows.length} rows (source=${source})`);

    for (const r of rows) {
      const ok = await applyOneDeposit(client, a.id, r);
      if (ok) processed += 1;
    }
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
}

/** --- Public entry used by src/index.ts ----------------------------- */
export function startAutoApply(client?: Client) {
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);

  // Kick once on boot (non-blocking)
  tickOnce(client).catch((e) => console.warn("[auto-credit] tick error:", e));

  // Schedule
  setInterval(() => {
    tickOnce(client).catch((e) => console.warn("[auto-credit] tick error:", e));
  }, POLL_MS);
}
