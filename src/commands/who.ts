// src/commands/who.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import pino from "pino";
import { PrismaClient } from "@prisma/client";

// Uses Node 18+ global fetch (no node-fetch import)
const log = pino({ level: process.env.LOG_LEVEL || "info" });
const prisma = new PrismaClient();

const WHO_VERSION = "who-2025-09-30-name-search-fix";

// ---------- Slash command builder ----------
export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Show detailed info about a PnW nation")
  .addStringOption(o =>
    o
      .setName("nation")
      .setDescription("Nation name (partial) OR numeric nation id")
      .setRequired(false)
  )
  .addStringOption(o =>
    o
      .setName("leader")
      .setDescription("Leader name (partial)")
      .setRequired(false)
  )
  .addUserOption(o =>
    o
      .setName("user")
      .setDescription("@member linked via /link_nation")
      .setRequired(false)
  );

// ---------- Types ----------
type NationCore = {
  id: number;
  nation_name: string;
  leader_name: string;
  alliance_id: number | null;
  alliance_name: string | null;
  score: number | null;
  color: string | null;
  continent: string | null;
  soldiers: number | null;
  tanks: number | null;
  aircraft: number | null;
  ships: number | null;
  spies: number | null;
  missiles: number | null;
  nukes: number | null;
  last_active: string | null;
};

// ---------- Execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: false });

  const optNation = (i.options.getString("nation") || "").trim();
  const optLeader = (i.options.getString("leader") || "").trim();
  const optUser = i.options.getUser("user");

  const raw = { nation: optNation || null, leader: optLeader || null, userOpt: !!optUser };
  log.info({ raw }, "[/who] invoked");

  const api = getApi();
  if (!api) {
    await i.editReply(
      "⚠️ PNW API key missing. Set **PNW_API** in the service environment."
    );
    return;
  }
  log.info({ len: api.length }, "[/who] using PNW_API from environment");

  let target: NationCore | null = null;
  let lookedUp = "";

  try {
    // 1) If @user provided, prefer their linked nation
    if (optUser) {
      const linkedId = await findLinkedNationId(i.guildId, optUser.id);
      log.info({ hasMember: !!linkedId, nationId: linkedId || null }, "[/who] linked member");
      if (linkedId) {
        target = await fetchNationById(api, linkedId);
        lookedUp = `linked nation for <@${optUser.id}>`;
      }
    }

    // 2) If explicit nation param given
    if (!target && optNation) {
      const maybeId = parseInt(optNation, 10);
      if (Number.isFinite(maybeId)) {
        // numeric -> id
        target = await fetchNationById(api, maybeId);
        lookedUp = "ID";
        log.info({ id: maybeId, found: !!target }, "[/who] ID lookup");
      } else {
        // nation name (partial)
        const { match, count, method } = await searchByName(api, optNation, "nation");
        log.info({ which: "nation", count, method, raw: optNation }, "[/who] search final");
        target = match;
        lookedUp = `nation:“${optNation}”`;
      }
    }

    // 3) If explicit leader param given
    if (!target && optLeader) {
      const { match, count, method } = await searchByName(api, optLeader, "leader");
      log.info({ which: "leader", count, method, raw: optLeader }, "[/who] search final");
      target = match;
      lookedUp = `leader:“${optLeader}”`;
    }

    // 4) If still nothing and only @user was provided, we already tried their link
    if (!target) {
      await i.editReply(
        "I couldn't find a nation. Try one of:\n• `/who nation:<nation name>`\n• `/who leader:<leader name>`\n• `/who nation:<numeric nation id>`\n• `/who user:@member`"
      );
      return;
    }

    // Render pretty embed
    const embed = toEmbed(target, lookedUp);
    const row = toButtons(target);
    await i.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    log.error({ err }, "[/who] execute error");
    await i.editReply("Something went wrong. Try again in a moment.");
  }
}

// ---------- Helpers ----------
function getApi(): string | null {
  return process.env.PNW_API ? String(process.env.PNW_API).trim() : null;
}

async function findLinkedNationId(
  guildId: string | null,
  discordId: string
): Promise<number | null> {
  if (!guildId) return null;
  const alliance = await prisma.alliance.findFirst({ where: { guildId } });
  if (!alliance) return null;
  const member = await prisma.member.findFirst({
    where: { allianceId: alliance.id, discordId },
  });
  return member?.nationId ?? null;
}

function num(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toEmbed(n: NationCore, lookedUp: string): EmbedBuilder {
  const aaPart =
    n.alliance_id && n.alliance_name
      ? ` • AA: [${n.alliance_name}](https://politicsandwar.com/alliance/id=${n.alliance_id})`
      : " • AA: None";

  const desc =
    `👤 **Leader:** ${n.leader_name}\n` +
    `🗺️ **Continent:** ${n.continent ?? "—"} • 🎨 **Color:** ${n.color ?? "—"}\n` +
    `⭐ **Score:** ${n.score?.toLocaleString() ?? "—"}${aaPart}\n` +
    `🆔 **Nation ID:** \`${n.id}\``;

  // Split each military stat into its own tidy field (inline)
  const fields = [
    { name: "🪖 Soldiers", value: fmt(n.soldiers), inline: true },
    { name: "🛡️ Tanks", value: fmt(n.tanks), inline: true },
    { name: "✈️ Aircraft", value: fmt(n.aircraft), inline: true },
    { name: "🚢 Ships", value: fmt(n.ships), inline: true },
    { name: "🕵️ Spies", value: fmt(n.spies), inline: true },
    { name: "🚀 Missiles", value: fmt(n.missiles), inline: true },
    { name: "☢️ Nukes", value: fmt(n.nukes), inline: true },
  ];

  const title = `💎 ${n.nation_name}`;
  const url = `https://politicsandwar.com/nation/id=${n.id}`;

  return new EmbedBuilder()
    .setTitle(title)
    .setURL(url)
    .setDescription(desc)
    .addFields(fields)
    .setFooter({
      text: `Lookup: ${lookedUp} • Last Active: ${n.last_active ?? "—"} • ${WHO_VERSION}`,
    })
    .setColor(Colors.Blurple);
}

function toButtons(n: NationCore) {
  const nationUrl = `https://politicsandwar.com/nation/id=${n.id}`;
  const warsUrl = `https://politicsandwar.com/nation/id=${n.id}&display=war`;
  const aaUrl = n.alliance_id
    ? `https://politicsandwar.com/alliance/id=${n.alliance_id}`
    : null;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Nation").setStyle(ButtonStyle.Link).setURL(nationUrl),
    new ButtonBuilder().setLabel("Wars").setStyle(ButtonStyle.Link).setURL(warsUrl)
  );

  if (aaUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel("Alliance").setStyle(ButtonStyle.Link).setURL(aaUrl)
    );
  }
  return row;
}

function fmt(v: number | null): string {
  return v == null ? "—" : v.toLocaleString();
}

// ---------- GraphQL core ----------
function mapNationGraphQL(row: any): NationCore {
  return {
    id: Number(row.id),
    nation_name: String(row.nation_name),
    leader_name: String(row.leader_name),
    alliance_id: row?.alliance?.id ? Number(row.alliance.id) : row?.alliance_id ? Number(row.alliance_id) : null,
    alliance_name: row?.alliance?.name ?? null,
    score: num(row.score),
    color: row?.color ?? null,
    continent: row?.continent ?? null,
    soldiers: num(row.soldiers),
    tanks: num(row.tanks),
    aircraft: num(row.aircraft),
    ships: num(row.ships),
    spies: num(row.spies),
    missiles: num(row.missiles),
    nukes: num(row.nukes),
    last_active: row?.last_active ?? null,
  };
}

/**
 * Query by exact nation ID
 * Only scalar fields supported by the current schema.
 */
async function fetchNationById(api: string, id: number): Promise<NationCore | null> {
  const gql = `
    {
      nations(id:[${id}], first:1) {
        data {
          id
          nation_name
          leader_name
          alliance_id
          alliance { id name }
          score
          color
          continent
          soldiers
          tanks
          aircraft
          ships
          spies
          missiles
          nukes
          last_active
        }
      }
    }`;

  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });

  if (!r.ok) {
    log.warn({ status: r.status }, "[/who] fetchNationById HTTP");
    return null;
  }
  const j: any = await r.json().catch(() => ({}));
  const count = j?.data?.nations?.data?.length || 0;
  log.info({ count, errors: j?.errors || null }, "[/who] fetchNationById rows");
  const row = count ? j.data.nations.data[0] : null;
  return row ? mapNationGraphQL(row) : null;
}

// ---------- Name/Leader search strategy ----------
/**
 * Attempts multiple strategies:
 * 1) (If supported) strict GraphQL equals on nation_name / leader_name
 * 2) Fallback: scrape public Nation Search page to collect IDs, then fetch via GraphQL
 */
async function searchByName(
  api: string,
  query: string,
  mode: "nation" | "leader"
): Promise<{ match: NationCore | null; count: number; method: string }> {
  const trimmed = query.trim();
  if (!trimmed) return { match: null, count: 0, method: "empty" };

  // 1) Try strict GraphQL equals (if arg is supported in current schema)
  // NOTE: Some schemas accept leader_name, but not nation_name — we guard errors.
  const argName = mode === "leader" ? "leader_name" : "nation_name";
  const tryExact = await tryGraphQLEquals(api, argName, trimmed);
  if (tryExact.ok && tryExact.rows.length) {
    return {
      match: mapNationGraphQL(tryExact.rows[0]),
      count: tryExact.rows.length,
      method: `gql:${argName}=`,
    };
  }

  // 2) Fallback: scrape the Nation Search page (keyword) and pick best match
  const ids = await scrapeNationSearchForIds(trimmed);
  if (!ids.length) {
    return { match: null, count: 0, method: "scrape:none" };
  }

  // Fetch up to first 10 IDs, score-desc pick best "includes" match
  const topIds = ids.slice(0, 10);
  const rows = await fetchManyById(api, topIds);
  const needle = trimmed.toLowerCase();

  const filtered =
    mode === "leader"
      ? rows.filter(r => r.leader_name.toLowerCase().includes(needle))
      : rows.filter(r => r.nation_name.toLowerCase().includes(needle));

  const pick = (filtered.length ? filtered : rows).sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  )[0] || null;

  return { match: pick, count: rows.length, method: `scrape+gql(${rows.length})` };
}

async function tryGraphQLEquals(
  api: string,
  arg: string,
  value: string
): Promise<{ ok: boolean; rows: any[] }> {
  const safe = value.replace(/"/g, '\\"');
  const gql = `{ nations(${arg}:"${safe}", first:5) { data { id nation_name leader_name alliance_id alliance{ id name } score color continent soldiers tanks aircraft ships spies missiles nukes last_active } } }`;
  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (j?.errors) {
    log.warn({ arg, errs: j.errors }, "[/who] GQL equals not supported");
    return { ok: false, rows: [] };
  }
  const rows = j?.data?.nations?.data || [];
  return { ok: true, rows };
}

async function fetchManyById(api: string, ids: number[]): Promise<NationCore[]> {
  if (!ids.length) return [];
  const list = ids.join(",");
  const gql = `{ nations(id:[${list}], first:${Math.min(50, ids.length)}) { data { id nation_name leader_name alliance_id alliance{ id name } score color continent soldiers tanks aircraft ships spies missiles nukes last_active } } }`;
  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  const j: any = await r.json().catch(() => ({}));
  const rows = j?.data?.nations?.data || [];
  return rows.map(mapNationGraphQL);
}

/**
 * Scrape nation IDs from the public nation search HTML.
 * We only extract `/nation/id=XXXX` anchors — no heavy HTML parsing.
 */
async function scrapeNationSearchForIds(keyword: string): Promise<number[]> {
  const url =
    "https://politicsandwar.com/nations/?keyword=" +
    encodeURIComponent(keyword) +
    "&minimum=0&ob=score&od=DESC";
  let html = "";
  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) {
      log.warn({ status: r.status }, "[/who] nation search HTTP");
      return [];
    }
    html = await r.text();
  } catch (e) {
    log.warn({ e: String(e) }, "[/who] nation search exception");
    return [];
  }

  const ids = new Set<number>();
  const re = /\/nation\/id=(\d+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    const id = parseInt(m[1], 10);
    if (Number.isFinite(id)) ids.add(id);
  }
  const out = Array.from(ids);
  log.info({ count: out.length, kw: keyword }, "[/who] scraped ID count");
  return out;
}

// ---------- default export to satisfy registry ----------
export default { data, execute };
