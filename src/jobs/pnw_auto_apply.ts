// src/jobs/pnw_auto_apply.ts
import { Client, EmbedBuilder, Colors } from "discord.js";
import { PrismaClient, SafeTxnType, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

// --- constants --------------------------------------------------------------
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 48h lookback
const POLL_MS = Number(process.env.AUTO_APPLY_POLL_MS ?? 5 * 60 * 1000); // 5m default

// PnW type ids
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 2;
const RECEIVER_TREASURY = 3;

const RESOURCE_LIST = [
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
type Resource = (typeof RESOURCE_LIST)[number];

const EMOJI: Record<Resource, string> = {
  money: "💵",
  food: "🍞",
  coal: "🪨",
  oil: "🛢️",
  uranium: "☢️",
  lead: "🧪",
  iron: "⚙️",
  bauxite: "⛏️",
  gasoline: "⛽",
  munitions: "💣",
  steel: "🔧",
  aluminum: "🧰",
};

// --- helpers ---------------------------------------------------------------
function fmtAmount(resource: Resource, n: number) {
  if (resource === "money")
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toLocaleString();
}
function isPositive(n: any) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) && v > 0;
}
function dmLines(changes: Array<{ resource: Resource; amount: number }>) {
  return changes
    .map(({ resource, amount }) => `• ${EMOJI[resource]} **${resource}** — ${fmtAmount(resource, amount)}`)
    .join("\n");
}

// --- DM embed --------------------------------------------------------------
async function sendDepositEmbedDM(
  client: Client,
  discordId: string | null,
  items: Array<{ resource: Resource; amount: number }>,
  bankrecId: string
) {
  if (!discordId) return;
  const user = await client.users.fetch(discordId).catch(() => null);
  if (!user) return;

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("Deposit Credited to Safekeeping")
    .setDescription(
      `**Alliance deposit detected**\n\n${dmLines(items)}\n\nUse \`/balance\` to view your updated safekeeping.`
    )
    .setFooter({ text: `Bank record ${bankrecId}` });

  await user.send({ embeds: [embed] }).catch(() => null);
}

// --- PnW v3 GraphQL fetch (augment) ----------------------------------------
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
          id
          bankrecs(limit: 200) {
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
          ...r,
          id: String(r.id),
          created_at,
          alliance_id_derived: allianceId,
          sender_type: Number(r.sender_type),
          receiver_type: Number(r.receiver_type),
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

    console.log(`[auto-credit] PnW API fallback fetched ${mapped.length} rows for alliance ${allianceId}`);
    return mapped;
  } catch (e) {
    console.warn("[auto-credit] PnW API fallback error:", e);
    return [];
  }
}

// --- DB fetch & merge -------------------------------------------------------
async function fetchRecentRows(allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  const cache = await prisma.allianceBankrec.findMany({
    where: {
      alliance_id_derived: allianceId,
      created_at: { gt: since },
      sender_type: SENDER_NATION,
      receiver_type: { in: [RECEIVER_ALLIANCE, RECEIVER_TREASURY] },
    },
    orderBy: { created_at: "asc" },
    take: 1000,
  });

  const legacy = await prisma.bankrec.findMany({
    where: {
      allianceId,
      date: { gt: since },
      senderType: SENDER_NATION,
      receiverType: { in: [RECEIVER_ALLIANCE, RECEIVER_TREASURY] },
    },
    orderBy: { date: "asc" },
    take: 1000,
  });

  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  const combined: any[] = [...cache, ...legacy, ...live];
  const seen = new Set<string>();
  const deduped = combined.filter((r: any) => {
    const k = String(r.id);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

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

// --- core crediting ---------------------------------------------------------
async function creditOneResource(
  memberId: number,
  resource: Resource,
  amount: number,
  reason: string
) {
  // Prisma client currently does NOT have reason marked unique in your build,
  // so we do a find-then-create (best-effort idempotency).
  await prisma.$transaction(async (tx) => {
    const existing = await tx.safeTxn.findFirst({ where: { reason } });
    if (!existing) {
      await tx.safeTxn.create({
        data: {
          memberId,
          resource,
          amount: new Prisma.Decimal(amount),
          type: SafeTxnType.AUTO_CREDIT,
          reason,
        },
      });
    }

    await tx.safekeeping.upsert({
      where: { memberId },
      create: {
        memberId,
        money: resource === "money" ? new Prisma.Decimal(amount) : new Prisma.Decimal(0),
        food: resource === "food" ? amount : 0,
        coal: resource === "coal" ? amount : 0,
        oil: resource === "oil" ? amount : 0,
        uranium: resource === "uranium" ? amount : 0,
        lead: resource === "lead" ? amount : 0,
        iron: resource === "iron" ? amount : 0,
        bauxite: resource === "bauxite" ? amount : 0,
        gasoline: resource === "gasoline" ? amount : 0,
        munitions: resource === "munitions" ? amount : 0,
        steel: resource === "steel" ? amount : 0,
        aluminum: resource === "aluminum" ? amount : 0,
      },
      update:
        resource === "money"
          ? { money: { increment: new Prisma.Decimal(amount) } }
          : { [resource]: { increment: amount } as any },
    });
  });
}

async function processAllianceRows(client: Client, allianceId: number) {
  const { rows, source } = await fetchRecentRows(allianceId);
  console.log(`[auto-credit] alliance ${allianceId} fetched ${rows.length} rows (source=${source})`);

  let processed = 0;

  for (const r of rows) {
    const bankrecId = String(r.id);
    const senderNationId = Number((r as any).sender_id ?? r.senderId ?? 0);
    if (!senderNationId) continue;

    const member = await prisma.member.findFirst({
      where: { allianceId, nationId: senderNationId },
      select: { id: true, discordId: true },
    });
    if (!member) continue;

    const changes: Array<{ resource: Resource; amount: number }> = [];
    for (const resource of RESOURCE_LIST) {
      const raw = (r as any)[resource];
      if (isPositive(raw)) {
        const amount = Number(raw);
        const reason = `BR:${bankrecId}:${resource}`;
        try {
          await creditOneResource(member.id, resource, amount, reason);
          changes.push({ resource, amount });
        } catch {
          // ignore (duplicate, etc.)
        }
      }
    }

    if (changes.length > 0) {
      processed += 1;
      await sendDepositEmbedDM(client, member.discordId, changes, bankrecId);
    }
  }

  console.log(`[auto-credit] processed ${processed} deposit rows`);
}

// --- public entry -----------------------------------------------------------
export function startAutoApply(client: Client) {
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);

  const tick = async () => {
    try {
      const alliances = await prisma.alliance.findMany({ select: { id: true } });
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
      for (const a of alliances) await processAllianceRows(client, a.id);
    } catch (e) {
      console.warn("[auto-credit] tick error:", e);
    }
  };

  // run now, then on interval
  tick().catch(() => null);
  setInterval(() => tick().catch(() => null), POLL_MS);
}
