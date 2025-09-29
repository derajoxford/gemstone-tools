// src/jobs/pnw_auto_apply.ts
import { Client, EmbedBuilder, Colors } from "discord.js";
import { PrismaClient, SafeTxnType, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

// --- constants --------------------------------------------------------------
const WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // rolling lookback window (48h)
const POLL_MS = Number(process.env.AUTO_APPLY_POLL_MS ?? 5 * 60 * 1000); // 5m default

// PnW type ids (stable)
const SENDER_NATION = 1;
const RECEIVER_ALLIANCE = 2;
const RECEIVER_TREASURY = 3;

// Supported resources we will read from bankrecs and credit to Safekeeping.
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

// --- small helpers ----------------------------------------------------------
function fmtAmount(resource: Resource, n: number) {
  if (resource === "money") return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// --- DM embed ---------------------------------------------------------------
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
    .setDescription(`**Alliance deposit detected**\n\n${dmLines(items)}\n\nUse \`/balance\` to view your updated safekeeping.`)
    .setFooter({ text: `Bank record ${bankrecId}` });

  await user.send({ embeds: [embed] }).catch(() => null);
}

// --- PnW v3 GraphQL live fetch (fallback/augment) --------------------------
async function fetchAllianceDepositsFromPnWAPI(allianceId: number, since: Date) {
  try {
    const keyrec = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    const apiKey = keyrec?.apiKey?.trim();
    if (!apiKey) {
      console.warn(`[auto-credit] no API key saved for alliance ${allianceId}`);
      return [];
    }

    // Build URL with ?api_key=... (works reliably for PnW v3 GraphQL)
    const base = process.env.PNW_GRAPHQL_URL || "https://api.politicsandwar.com/graphql";
    const url = new URL(base);
    url.searchParams.set("api_key", apiKey);

    // bankrecs(limit:..., offset:...) on alliances(id:[...])
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

// --- DB fetch & merge (cache + legacy + live) ------------------------------
async function fetchRecentRows(allianceId: number) {
  const since = new Date(Date.now() - WINDOW_MS);

  // 1) Cached table
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

  // 2) Legacy table
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

  // 3) Live augment
  const live = await fetchAllianceDepositsFromPnWAPI(allianceId, since);

  // Merge & dedupe by raw id
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
    ? "union_legacy+pnw_api"
    : cache.length
    ? "alliance_bankrec"
    : legacy.length
    ? "bankrec"
    : "empty";

  return { rows: deduped, source };
}

// --- core crediting logic ---------------------------------------------------
async function creditOneResource(
  memberId: number,
  resource: Resource,
  amount: number,
  reason: string
) {
  // idempotency: rely on unique reason on SafeTxn.reason
  await prisma.$transaction(async (tx) => {
    // Upsert the journal line (unique on reason)
    await tx.safeTxn.upsert({
      where: { reason }, // unique
      create: {
        memberId,
        resource,
        amount: resource === "money" ? new Prisma.Decimal(amount) : new Prisma.Decimal(amount), // stored as Decimal
        type: SafeTxnType.AUTO_CREDIT,
        reason,
      },
      update: {}, // nothing to update; if it exists, we stop here
    });

    // Apply the increment to Safekeeping
    await tx.safekeeping.upsert({
      where: { memberId },
      create: {
        memberId,
        money: resource === "money" ? new Prisma.Decimal(amount) : new Prisma.Decimal(0),
        food: resource === "food" ? 1 * amount : 0,
        coal: resource === "coal" ? 1 * amount : 0,
        oil: resource === "oil" ? 1 * amount : 0,
        uranium: resource === "uranium" ? 1 * amount : 0,
        lead: resource === "lead" ? 1 * amount : 0,
        iron: resource === "iron" ? 1 * amount : 0,
        bauxite: resource === "bauxite" ? 1 * amount : 0,
        gasoline: resource === "gasoline" ? 1 * amount : 0,
        munitions: resource === "munitions" ? 1 * amount : 0,
        steel: resource === "steel" ? 1 * amount : 0,
        aluminum: resource === "aluminum" ? 1 * amount : 0,
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

    // Find the member by nationId in this alliance
    const member = await prisma.member.findFirst({
      where: { allianceId, nationId: senderNationId },
      select: { id: true, discordId: true },
    });
    if (!member) continue;

    // Gather resource deltas from this row
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
          // unique reason hit -> already credited, skip
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

// --- public entrypoint ------------------------------------------------------
export function startAutoApply(client: Client) {
  console.log(`[auto-credit] mode=rolling-window windowMs=${WINDOW_MS} pollMs=${POLL_MS}`);

  const tick = async () => {
    try {
      const alliances = await prisma.alliance.findMany({ select: { id: true } });
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);
      console.log(`[auto-credit] alliances in DB: ${alliances.map((a) => a.id).join(", ")}`);

      for (const a of alliances) {
        await processAllianceRows(client, a.id);
      }
    } catch (e) {
      console.warn("[auto-credit] tick error:", e);
    }
  };

  // run immediately, then interval
  tick().catch(() => null);
  setInterval(() => tick().catch(() => null), POLL_MS);
}
