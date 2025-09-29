// src/jobs/pnw_auto_apply.ts

import { Client, EmbedBuilder } from "discord.js";
import { PrismaClient, Prisma, SafeTxnType } from "@prisma/client";

const prisma = new PrismaClient();

// --- tunables ---
const POLL_MS = Number(process.env.AUTO_APPLY_POLL_MS ?? 5 * 60 * 1000); // 5m
const WINDOW_MS = Number(process.env.AUTO_APPLY_WINDOW_MS ?? 2 * 24 * 60 * 60 * 1000); // 48h rolling

// sender/receiver numeric types from PnW
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 2;
const RECEIVER_TREASURY = 3;

// resources we care about (keys align with GraphQL fields & DB columns)
const RESOURCE_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

type ResourceKey = (typeof RESOURCE_KEYS)[number];

type LiveBankrec = {
  id: string;
  date: string;
  note: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
  money?: string | number | null;
  food?: string | number | null;
  coal?: string | number | null;
  oil?: string | number | null;
  uranium?: string | number | null;
  lead?: string | number | null;
  iron?: string | number | null;
  bauxite?: string | number | null;
  gasoline?: string | number | null;
  munitions?: string | number | null;
  steel?: string | number | null;
  aluminum?: string | number | null;
};

function asNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE (GraphQL) FETCH — robust to schema variations
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  const cutoff = since.getTime();

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

    const queries: string[] = [
      // Variant A: array shape with id: [...]
      `
      {
        alliances(id:[${allianceId}]) {
          id
          bankrecs(limit: 100) {
            id date note sender_type sender_id receiver_type receiver_id
            money food coal oil uranium lead iron bauxite gasoline munitions steel aluminum
          }
        }
      }`,
      // Variant B: paginator with filter
      `
      {
        alliances(first: 1, filter: { id: { in: [${allianceId}] } }) {
          data {
            id
            bankrecs(limit: 100) {
              id date note sender_type sender_id receiver_type receiver_id
              money food coal oil uranium lead iron bauxite gasoline munitions steel aluminum
            }
          }
        }
      }`,
      // Variant C: paginator without filter (client-side filter)
      `
      {
        alliances(first: 5) {
          data {
            id
            bankrecs(limit: 100) {
              id date note sender_type sender_id receiver_type receiver_id
              money food coal oil uranium lead iron bauxite gasoline munitions steel aluminum
            }
          }
        }
      }`,
    ];

    let mapped: any[] = [];
    let lastErrors: any[] | null = null;

    for (const query of queries) {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });

      if (!resp.ok) {
        console.warn(`[auto-credit] PnW API HTTP ${resp.status} for alliance ${allianceId}`);
        continue;
      }

      const json: any = await resp.json();
      if (Array.isArray(json?.errors) && json.errors.length > 0) {
        lastErrors = json.errors;
        continue; // try next variant
      }

      const alliancesArr: any[] =
        Array.isArray(json?.data?.alliances)
          ? json.data.alliances
          : Array.isArray(json?.data?.alliances?.data)
          ? json.data.alliances.data
          : [];

      const alliance =
        alliancesArr.find((a: any) => String(a?.id) === String(allianceId)) || alliancesArr[0];

      const recs: LiveBankrec[] = alliance?.bankrecs ?? [];
      mapped = recs
        .map((r) => {
          const d = new Date(String(r.date));
          const created_at = Number.isNaN(d.getTime()) ? new Date(0) : d;
          return {
            ...r,
            id: String(r.id),
            alliance_id_derived: allianceId,
            created_at,
            sender_type: Number(r.sender_type),
            receiver_type: Number(r.receiver_type),
            sender_id: String((r as any).sender_id ?? ""),
            receiver_id: String((r as any).receiver_id ?? ""),
            // amounts as numbers
            money: Number((r as any).money ?? 0),
            food: Number((r as any).food ?? 0),
            coal: Number((r as any).coal ?? 0),
            oil: Number((r as any).oil ?? 0),
            uranium: Number((r as any).uranium ?? 0),
            lead: Number((r as any).lead ?? 0),
            iron: Number((r as any).iron ?? 0),
            bauxite: Number((r as any).bauxite ?? 0),
            gasoline: Number((r as any).gasoline ?? 0),
            munitions: Number((r as any).munitions ?? 0),
            steel: Number((r as any).steel ?? 0),
            aluminum: Number((r as any).aluminum ?? 0),
          };
        })
        .filter(
          (r) =>
            r.sender_type === SENDER_NATION &&
            (r.receiver_type === RECEIVER_ALLIANCE || r.receiver_type === RECEIVER_TREASURY) &&
            r.created_at instanceof Date &&
            !Number.isNaN(r.created_at.getTime()) &&
            r.created_at.getTime() > cutoff
        )
        .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime());

      break; // parsed OK, stop trying others
    }

    if (mapped.length === 0 && lastErrors) {
      console.warn(
        "[auto-credit] PnW API GraphQL errors:",
        lastErrors.map((e: any) => e?.message ?? e)
      );
    }

    console.log(
      `[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`
    );
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE RECENT (cache + legacy + live)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRecentRows(p: PrismaClient, allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) Cached table: it does NOT have resource columns — set them to 0
  const cache = await p.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [RECEIVER_ALLIANCE, RECEIVER_TREASURY] },
    },
    orderBy: { created_at: "asc" },
    take: 1000,
  });

  const zeros = Object.fromEntries(RESOURCE_KEYS.map((k) => [k, 0]));

  // 2) Legacy table: has resource columns
  const legacy = await p.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [RECEIVER_ALLIANCE, RECEIVER_TREASURY] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  // 3) Live API
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  // Merge & dedupe by raw bankrec id
  const combined: any[] = [
    ...cache.map((r) => ({
      id: String(r.id),
      date: r.created_at ?? (r as any).date,
      created_at: r.created_at ?? (r as any).date,
      sender_type: r.sender_type,
      sender_id: String(r.sender_id),
      receiver_type: r.receiver_type,
      receiver_id: String(r.receiver_id),
      alliance_id_derived: r.alliance_id_derived,
      note: r.note ?? "",
      ...zeros, // cache rows carry NO amounts
    })),
    ...legacy.map((r) => ({
      id: String(r.id),
      date: r.date,
      created_at: r.date,
      sender_type: r.senderType,
      sender_id: String(r.senderId),
      receiver_type: r.receiverType,
      receiver_id: String(r.receiverId),
      alliance_id_derived: r.allianceId,
      note: r.note ?? "",
      money: r.money ?? 0,
      food: r.food ?? 0,
      coal: r.coal ?? 0,
      oil: r.oil ?? 0,
      uranium: r.uranium ?? 0,
      lead: r.lead ?? 0,
      iron: r.iron ?? 0,
      bauxite: r.bauxite ?? 0,
      gasoline: r.gasoline ?? 0,
      munitions: r.munitions ?? 0,
      steel: r.steel ?? 0,
      aluminum: r.aluminum ?? 0,
    })),
    ...live,
  ];

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
    ? "union_legacy+pnw_api"
    : cache.length
    ? "alliance_bankrec"
    : legacy.length
    ? "bankrec"
    : "empty";

  return { rows: deduped, source };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT ONE RESOURCE
// ─────────────────────────────────────────────────────────────────────────────
async function creditOneResource(
  memberId: number,
  resource: ResourceKey,
  rawAmount: number,
  reason: string
) {
  const amount = asNumber(rawAmount);
  if (amount <= 0) return false;

  // idempotency: if we already wrote a SafeTxn with this reason, skip
  const existing = await prisma.safeTxn.findFirst({ where: { reason } });
  if (existing) return false;

  // 1) write the ledger row
  await prisma.safeTxn.create({
    data: {
      memberId,
      resource,
      amount: new Prisma.Decimal(amount),
      type: SafeTxnType.AUTO_CREDIT,
      actorDiscordId: "system",
      reason,
    },
  });

  // 2) apply to safekeeping; create if missing
  const sk = await prisma.safekeeping.findUnique({ where: { memberId } });
  if (sk) {
    await prisma.safekeeping.update({
      where: { memberId },
      data: { [resource]: { increment: amount } } as any,
    });
  } else {
    // create with 0 for all resources, then set this one
    const createData: any = { member: { connect: { id: memberId } } };
    for (const key of RESOURCE_KEYS) createData[key] = 0;
    createData[resource] = amount;
    await prisma.safekeeping.create({ data: createData });
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DM (embed)
// ─────────────────────────────────────────────────────────────────────────────
async function sendDepositDM(
  discord: Client | undefined,
  discordId: string | null | undefined,
  fields: Array<{ name: string; value: string }>
) {
  if (!discord || !discordId) return;
  try {
    const user = await discord.users.fetch(discordId);
    if (!user) return;

    const embed = new EmbedBuilder()
      .setTitle("Deposit Credited to Safekeeping")
      .setDescription("Alliance deposit detected")
      .addFields(fields)
      .setTimestamp(new Date());

    await user.send({ embeds: [embed] }).catch(() => {});
  } catch {
    // ignore DM failures
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function processAlliance(p: PrismaClient, discord: Client | undefined, allianceId: number) {
  const { rows, source } = await fetchRecentRows(p, allianceId);
  console.log(`[auto-credit] alliance ${allianceId} fetched ${rows.length} rows (source=${source})`);

  let processed = 0;

  for (const r of rows) {
    const senderNationId = Number(r.sender_id);
    if (!Number.isFinite(senderNationId)) continue;

    // Resolve member by nationId (prefer same alliance, else any)
    const member =
      (await p.member.findFirst({
        where: { nationId: senderNationId, allianceId },
        select: { id: true, discordId: true },
      })) ||
      (await p.member.findFirst({
        where: { nationId: senderNationId },
        select: { id: true, discordId: true },
      }));

    if (!member) continue;

    // For each resource with positive amount, credit
    const credited: { resource: ResourceKey; amount: number }[] = [];

    for (const key of RESOURCE_KEYS) {
      const amt = asNumber((r as any)[key]);
      if (amt <= 0) continue;

      const reason = `BR:${String(r.id)}:${key}`;
      const ok = await creditOneResource(member.id, key, amt, reason);
      if (ok) credited.push({ resource: key, amount: amt });
    }

    if (credited.length > 0) {
      processed += credited.length;

      // money first for readability
      const moneyFirst = credited.sort((a, b) =>
        a.resource === "money" ? -1 : b.resource === "money" ? 1 : a.resource.localeCompare(b.resource)
      );

      const dmFields = moneyFirst.map(({ resource, amount }) => ({
        name: `• ${emojiFor(resource)} ${resource}`,
        value: `— ${fmt(amount)}`,
      }));

      await sendDepositDM(discord, member.discordId, dmFields);
    }
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
}

function emojiFor(res: ResourceKey): string {
  switch (res) {
    case "money":
      return "💵";
    case "food":
      return "🍞";
    case "coal":
      return "🪨";
    case "oil":
      return "🛢️";
    case "uranium":
      return "☢️";
    case "lead":
      return "🔩";
    case "iron":
      return "⛓️";
    case "bauxite":
      return "🧱";
    case "gasoline":
      return "⛽";
    case "munitions":
      return "💣";
    case "steel":
      return "🔧";
    case "aluminum":
      return "🧲";
    default:
      return "•";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC START
// ─────────────────────────────────────────────────────────────────────────────
let _timer: NodeJS.Timeout | null = null;
let _running = false;

export function startAutoApply(discordClient?: Client) {
  if (_timer) return;
  const tick = async () => {
    if (_running) return;
    _running = true;
    try {
      const alliances = await prisma.alliance.findMany({ select: { id: true } });
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);

      for (const a of alliances) {
        await processAlliance(prisma, discordClient, a.id);
      }
    } catch (e) {
      console.warn("[auto-credit] tick error:", e);
    } finally {
      _running = false;
    }
  };

  console.log(
    `[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`
  );
  // run immediately, then on interval
  tick().catch(() => {});
  _timer = setInterval(() => tick().catch(() => {}), POLL_MS);
}
