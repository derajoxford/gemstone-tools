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

// Node 18+ global fetch
const log = pino({ level: process.env.LOG_LEVEL || "info" });
const prisma = new PrismaClient();

const WHO_VERSION = "who-env-2025-10-01c"; // fixes duplicate 'lookedUp' and render call

// ---------- Slash command ----------
export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Detailed nation card (by nation name, leader name, @user, or nation ID)")
  .addStringOption(o =>
    o.setName("nation").setDescription("Nation name (partial) OR numeric nation id").setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader").setDescription("Leader name (partial)").setRequired(false),
  )
  .addUserOption(o =>
    o.setName("user").setDescription("@member linked via /link_nation").setRequired(false),
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
  citiesCount: number | null;
};

// ---------- Execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply();

  const optNation = (i.options.getString("nation") || "").trim();
  const optLeader = (i.options.getString("leader") || "").trim();
  const optUser = i.options.getUser("user");

  log.info({ nation: optNation || null, leader: optLeader || null, userOpt: !!optUser }, "[/who] invoked");

  const api = getApi();
  if (!api) {
    await i.editReply("⚠️ PNW API key missing. Set **PNW_API** in the service environment and restart.");
    return;
  }
  log.info({ len: api.length }, "[/who] using PNW_API from environment");

  let target: NationCore | null = null;
  let lookupHow = ""; // <— renamed from 'lookedUp' to avoid collisions

  try {
    // A) explicit user link first (if provided)
    if (optUser) {
      const linkedId = await findLinkedNationId(i.guildId, optUser.id);
      log.info({ hasMember: !!linkedId, nationId: linkedId || null }, "[/who] linked member");
      if (linkedId) {
        target = await fetchNationById(api, linkedId);
        lookupHow = `linked nation for <@${optUser.id}>`;
      }
    }

    // B) nation arg
    if (!target && optNation) {
      if (/^\d+$/.test(optNation)) {
        const id = Number(optNation);
        target = await fetchNationById(api, id);
        lookupHow = `ID ${id}`;
        log.info({ id, found: !!target }, "[/who] ID lookup");
      } else {
        const { match, count, method } = await searchByName(api, optNation, "nation");
        log.info({ which: "nation", count, method, raw: optNation }, "[/who] search final");
        target = match;
        lookupHow = `nation “${optNation}”`;
      }
    }

    // C) leader arg
    if (!target && optLeader) {
      const { match, count, method } = await searchByName(api, optLeader, "leader");
      log.info({ which: "leader", count, method, raw: optLeader }, "[/who] search final");
      target = match;
      lookupHow = `leader “${optLeader}”`;
    }

    // D) if no args, try self link
    if (!target && !optNation && !optLeader) {
      const linkedId = await findLinkedNationId(i.guildId, i.user.id);
      if (linkedId) {
        target = await fetchNationById(api, linkedId);
        lookupHow = `linked nation for <@${i.user.id}>`;
      }
    }

    if (!target) {
      await i.editReply(
        "I couldn't find a nation. Try one of:\n" +
          "• `/who nation:<nation name>`\n" +
          "• `/who leader:<leader name>`\n" +
          "• `/who nation:<numeric nation id>`\n" +
          "• `/who user:@member`",
      );
      return;
    }

    const { embed, row } = renderCardSeparate(target, lookupHow); // <— fixed call
    await i.editReply({ embeds: [embed], components: [row] });
  } catch (err) {
    log.error({ err }, "[/who] execute error");
    await i.editReply("Something went wrong.");
  }
}

// ---------- Utilities ----------
function getApi(): string | null {
  return process.env.PNW_API ? String(process.env.PNW_API).trim() : null;
}

async function findLinkedNationId(guildId: string | null, discordId: string): Promise<number | null> {
  if (!guildId) return null;
  const alliance = await prisma.alliance.findFirst({ where: { guildId } });
  if (!alliance) return null;
  const m = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId } });
  return m?.nationId ?? null;
}

function nnum(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ---------- GraphQL ----------
function mapNationGraphQL(row: any): NationCore {
  return {
    id: Number(row.id),
    nation_name: String(row.nation_name),
    leader_name: String(row.leader_name),
    alliance_id: row?.alliance?.id ? Number(row.alliance.id) : row?.alliance_id ? Number(row.alliance_id) : null,
    alliance_name: row?.alliance?.name ?? null,

    score: nnum(row.score),
    color: row?.color ?? null,
    continent: row?.continent ?? null,

    soldiers: nnum(row.soldiers),
    tanks: nnum(row.tanks),
    aircraft: nnum(row.aircraft),
    ships: nnum(row.ships),
    spies: nnum(row.spies),
    missiles: nnum(row.missiles),
    nukes: nnum(row.nukes),

    last_active: row?.last_active ?? null,
    citiesCount: Array.isArray(row?.cities) ? row.cities.length : nnum(row?.cities) ?? null,
  };
}

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
        cities { id }
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
  const arr: any[] = j?.data?.nations?.data || [];
  log.info({ rows: arr.length }, "[/who] fetchNationById rows");
  return arr.length ? mapNationGraphQL(arr[0]) : null;
}

async function fetchManyById(api: string, ids: number[]): Promise<NationCore[]> {
  if (!ids.length) return [];
  const list = ids.join(",");
  const gql = `{ nations(id:[${list}], first:${Math.min(50, ids.length)}) { data { 
    id nation_name leader_name alliance_id alliance{ id name } score color continent
    soldiers tanks aircraft ships spies missiles nukes last_active cities { id }
  } } }`;
  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });
  const j: any = await r.json().catch(() => ({}));
  const rows: any[] = j?.data?.nations?.data || [];
  return rows.map(mapNationGraphQL);
}

// ---------- Name/Leader search (scrape → hydrate) ----------
async function searchByName(
  api: string,
  query: string,
  mode: "nation" | "leader",
): Promise<{ match: NationCore | null; count: number; method: string }> {
  const ids = await scrapeNationSearchForIds(query);
  if (!ids.length) return { match: null, count: 0, method: "scrape:none" };

  const rows = await fetchManyById(api, ids.slice(0, 12));
  const needle = query.toLowerCase();
  const filtered =
    mode === "leader"
      ? rows.filter(r => r.leader_name.toLowerCase().includes(needle))
      : rows.filter(r => r.nation_name.toLowerCase().includes(needle));

  const pick =
    (filtered.length ? filtered : rows).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

  return { match: pick, count: rows.length, method: `scrape+gql(${rows.length})` };
}

/** Scrape public nation search page to get nation IDs from anchors `/nation/id=XXXX` */
async function scrapeNationSearchForIds(keyword: string): Promise<number[]> {
  const url = `https://politicsandwar.com/nations/?keyword=${encodeURIComponent(
    keyword,
  )}&minimum=0&ob=score&od=DESC`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      log.warn({ status: r.status }, "[/who] nation search HTTP");
      return [];
    }
    const html = await r.text();
    const ids = new Set<number>();
    const re = /\/nation\/id=(\d+)/g;
    for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
      const id = parseInt(m[1], 10);
      if (Number.isFinite(id)) ids.add(id);
    }
    const out = Array.from(ids);
    log.info({ count: out.length, kw: keyword }, "[/who] scraped ID count");
    return out;
  } catch (e) {
    log.warn({ e: String(e) }, "[/who] nation search exception");
    return [];
  }
}

// ---------- Ranges & formatting ----------
function fmtScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
}
function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : Intl.NumberFormat().format(Math.round(n));
}
function range(score: number | null | undefined, lo: number, hi: number) {
  if (score == null) return "—";
  const a = score * lo,
    b = score * hi;
  const fmt = (x: number) =>
    Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
  return `${fmt(a)}–${fmt(b)}`;
}
function warRanges(score?: number | null) {
  return {
    atkWar: range(score, 0.75, 2.5),
    atkSpy: range(score, 0.4, 2.5),
    defWar: range(score, 0.4, 4 / 3),
    defSpy: range(score, 0.4, 2.5),
  };
}
function discordRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${t}:R>`;
}
const COLOR_HEX: Record<string, number> = {
  turquoise: 0x1abc9c,
  blue: 0x3498db,
  red: 0xe74c3c,
  green: 0x2ecc71,
  purple: 0x9b59b6,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  black: 0x2c3e50,
  white: 0xecf0f1,
  grey: 0x95a5a6,
  gray: 0x95a5a6,
};
function hexForBloc(c?: string | null): number {
  return COLOR_HEX[c?.toLowerCase() || ""] ?? Colors.Blurple;
}

// ---------- Card (separate military fields) ----------
function renderCardSeparate(n: NationCore, lookupHow: string) {
  const nationUrl = `https://politicsandwar.com/nation/id=${n.id}`;
  const warsUrl = `https://politicsandwar.com/nation/id=${n.id}&display=war`;
  const aaUrl = n.alliance_id ? `https://politicsandwar.com/alliance/id=${n.alliance_id}` : null;

  const alliance = n.alliance_name && aaUrl ? `[${n.alliance_name}](${aaUrl})` : n.alliance_name ?? "None";
  const ranges = warRanges(n.score);

  const embed = new EmbedBuilder()
    .setColor(hexForBloc(n.color))
    .setTitle(`${n.nation_name} — ${n.leader_name}`)
    .setURL(nationUrl)
    .setDescription(`🔎 Looked up by ${lookupHow} • 🆔 \`${n.id}\` • ${WHO_VERSION}`)
    .addFields(
      { name: "🏛️ Alliance", value: alliance, inline: true },
      { name: "📈 Score", value: fmtScore(n.score), inline: true },
      { name: "🎨 / 🌍", value: `${n.color ?? "—"} / ${n.continent ?? "—"}`, inline: true },

      { name: "🏙️ Cities", value: fmtInt(n.citiesCount), inline: true },
      { name: "⏱️ Last Active", value: discordRelative(n.last_active), inline: true },
      { name: "\u200b", value: "\u200b", inline: true }, // spacer

      { name: "🪖 Soldiers", value: fmtInt(n.soldiers), inline: true },
      { name: "🛡️ Tanks", value: fmtInt(n.tanks), inline: true },
      { name: "✈️ Aircraft", value: fmtInt(n.aircraft), inline: true },

      { name: "🚢 Ships", value: fmtInt(n.ships), inline: true },
      { name: "🕵️ Spies", value: fmtInt(n.spies), inline: true },
      { name: "🚀 Missiles", value: fmtInt(n.missiles), inline: true },

      { name: "☢️ Nukes", value: fmtInt(n.nukes), inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "\u200b", value: "\u200b", inline: true },

      { name: "⚔️ Attack Range (War / Spy)", value: `${ranges.atkWar} • ${ranges.atkSpy}`, inline: false },
      { name: "🛡️ Defense Range (War / Spy)", value: `${ranges.defWar} • ${ranges.defSpy}`, inline: false },
    )
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🔎 Nation").setURL(nationUrl),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("⚔️ Wars").setURL(warsUrl),
    ...(aaUrl ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🏛️ Alliance").setURL(aaUrl)] : []),
  );

  return { embed, row };
}

// ---------- default export (for command registry) ----------
export default { data, execute };
