// src/commands/who.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type User,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../lib/crypto.js";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipherB64: string, nonceB64: string) => string;

const WHO_VERSION = "who-env-2025-09-30a";

/** Nation model used by the embed */
type NationCore = {
  id: number;
  name: string;
  leader: string;
  allianceId?: number | null;
  allianceName?: string | null;

  score?: number | null;
  color?: string | null;
  continent?: string | null;

  // military
  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;

  // derived / aux
  lastActive?: string | null;
  citiesCount?: number | null;
  projectsCount?: number | null;
  projectNames?: string[]; // best-effort list; may be empty if not available
};

export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Look up a nation by nation name, leader name, Discord user (linked), or nation ID.")
  .addStringOption(o =>
    o.setName("nation").setDescription("Nation name (full/partial) OR numeric ID").setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader").setDescription("Leader name (full/partial)").setRequired(false),
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Discord user (uses linked nation if available)").setRequired(false),
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply();

  try {
    const api = await getApiKey();
    if (!api) {
      await i.editReply(
        "Admin setup required: no PNW API key. Set `PNW_API` in the service env (or save an alliance API key) and restart.",
      );
      return;
    }

    const nationArg = (i.options.getString("nation") || "").trim();
    const leaderArg = (i.options.getString("leader") || "").trim();
    const user: User | null = i.options.getUser("user");

    let nation: NationCore | null = null;
    let lookedUp = "";
    let multiNote = "";

    // 0) numeric ID path (fastest + safest)
    if (nationArg && /^\d+$/.test(nationArg)) {
      const id = Number(nationArg);
      nation = await fetchNationById(api, id);
      // Try to augment with projects list (best-effort; non-fatal)
      if (nation) nation.projectNames = await tryFetchProjectNames(api, nation.id);
      lookedUp = `ID ${id}`;
    }

    // 1) nation name LIKE search (GraphQL)
    if (!nation && nationArg) {
      const res = await searchNations(api, { nationName: nationArg });
      if (res.length) {
        nation = res[0];
        nation.projectNames = await tryFetchProjectNames(api, nation.id);
        lookedUp = `nation name "${nationArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 2) leader name LIKE search
    if (!nation && leaderArg) {
      const res = await searchNations(api, { leaderName: leaderArg });
      if (res.length) {
        nation = res[0];
        nation.projectNames = await tryFetchProjectNames(api, nation.id);
        lookedUp = `leader name "${leaderArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 3) linked Discord user (or self as fallback)
    if (!nation && (user || (!nationArg && !leaderArg))) {
      const targetUser = user ?? i.user;
      const member = await prisma.member.findFirst({
        where: { discordId: targetUser.id },
        select: { nationId: true },
      });
      if (member?.nationId) {
        nation = await fetchNationById(api, member.nationId);
        if (nation) nation.projectNames = await tryFetchProjectNames(api, nation.id);
        lookedUp = `linked nation for <@${targetUser.id}>`;
      }
    }

    if (!nation) {
      await i.editReply(
        "I couldn't find a nation. Try one of:\n" +
          "• `/who nation:<nation name>`\n" +
          "• `/who leader:<leader name>`\n" +
          "• `/who nation:<numeric nation id>`\n" +
          "• `/who user:@member` (requires nation link)",
      );
      return;
    }

    // Build & send pretty card
    const { embed, components } = buildWhoCard(nation, { lookedUp, multiNote });
    await i.editReply({ embeds: [embed], components });
  } catch (err: any) {
    console.error("who execute error:", err);
    await i.editReply("Sorry — something went wrong looking that up.");
  }
}

/* ===================== Helpers & formatting ===================== */

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat().format(Math.round(n));
}
function fmtScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
}
function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
function toB64(b: any): string {
  // normalize Buffer/Uint8Array/ArrayBuffer to base64
  // @ts-ignore
  return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
}
function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Locutus-aligned ranges (based on observed multipliers):
// Attack War: 0.75x – 2.5x
// Attack Spy: 0.40x – 2.5x
// Defense War: 0.40x – 1.333333x  (4/3)
// Defense Spy: 0.40x – 2.5x
function range(score: number | null | undefined, lo: number, hi: number) {
  if (!score && score !== 0) return "—";
  const a = score * lo, b = score * hi;
  const fmt = (x: number) =>
    Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
  return `${fmt(a)}–${fmt(b)}`;
}
function warRanges(score?: number | null) {
  return {
    atkWar: range(score, 0.75, 2.5),
    atkSpy: range(score, 0.40, 2.5),
    defWar: range(score, 0.40, 4 / 3),
    defSpy: range(score, 0.40, 2.5),
  };
}

const COLOR_HEX: Record<string, number> = {
  turquoise: 0x1abc9c, blue: 0x3498db, red: 0xe74c3c, green: 0x2ecc71, purple: 0x9b59b6,
  yellow: 0xf1c40f, orange: 0xe67e22, black: 0x2c3e50, white: 0xecf0f1, grey: 0x95a5a6,
  gray: 0x95a5a6, maroon: 0x800000, pink: 0xff69b4, lime: 0x32cd32, beige: 0xf5f5dc,
};
function hexForBloc(c?: string | null): number {
  if (!c) return 0x5865f2; // Discord blurple fallback
  return COLOR_HEX[c.toLowerCase()] ?? 0x5865f2;
}
function discordRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${t}:R>`; // “x minutes ago”
}

/* ===================== API Keys ===================== */

async function getApiKey(): Promise<string | null> {
  // 1) Prefer global env key
  const env = process.env.PNW_API?.trim();
  if (env) return env;

  // 2) Fallback to latest stored alliance API key (encrypted)
  try {
    const k = await prisma.allianceKey.findFirst({
      orderBy: { id: "desc" },
      select: { encryptedApiKey: true, nonceApi: true },
    });
    if (k?.encryptedApiKey && k?.nonceApi) {
      const api = open(toB64(k.encryptedApiKey as any), toB64(k.nonceApi as any));
      if (api && api.length > 10) return api;
    }
  } catch (e) {
    console.error("[/who] getApiKey DB error:", e);
  }
  return null;
}

/* ===================== GraphQL fetches ===================== */

/**
 * IMPORTANT:
 *  - Embed the numeric ID literally; variables sometimes return 0 rows on this endpoint.
 *  - Only select schema-safe scalars + arrays with proper sub-selection (cities { id }).
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
          cities { id }
          projects
        }
      }
    }`;

  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql }),
  });

  if (!r.ok) return null;
  const j: any = await r.json().catch(() => ({}));
  const arr = j?.data?.nations?.data ?? [];
  const row = arr[0];
  if (!row) return null;

  const base = mapNationGraphQL(row);
  // derive cities count and projects count
  base.citiesCount = Array.isArray(row?.cities) ? row.cities.length : safeNum(row?.cities) ?? null;
  base.projectsCount = safeNum(row?.projects);
  return base;
}

/**
 * LIKE search on nation_name / leader_name (GraphQL).
 * Returns up to 5 matches, sorted by score desc.
 */
async function searchNations(
  api: string,
  opts: { nationName?: string; leaderName?: string },
): Promise<NationCore[]> {
  const kw = (opts.nationName ?? opts.leaderName ?? "").trim();
  if (kw.length < 2) return [];
  const like = `%${kw}%`;

  const run = async (filterLine: string) => {
    const gql = `
      query($q:String) {
        nations(first:5, ${filterLine}, orderBy:[{column:SCORE, order:DESC}]) {
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
            projects
          }
        }
      }`;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { q: like } }),
    });
    if (!r.ok) return [];
    const j: any = await r.json().catch(() => ({}));
    const arr = j?.data?.nations?.data ?? [];
    return arr.map(mapNationGraphQL).map((n: NationCore, idx: number) => {
      // attach derived counts if present
      const raw = arr[idx];
      n.citiesCount = Array.isArray(raw?.cities) ? raw.cities.length : safeNum(raw?.cities) ?? null;
      n.projectsCount = safeNum(raw?.projects);
      return n;
    });
  };

  let out: NationCore[] = [];
  if (opts.nationName) out = await run(`filter:{ nation_name:{ like:$q } }`);
  if (!out.length && opts.leaderName) out = await run(`filter:{ leader_name:{ like:$q } }`);
  // De-dup & rank
  const dedup = new Map<number, NationCore>();
  out.forEach(n => dedup.set(n.id, n));
  return Array.from(dedup.values()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
}

/**
 * Best-effort attempt to get project names.
 * Tries a couple of GraphQL shapes and a REST fallback; returns [] if unavailable.
 */
async function tryFetchProjectNames(api: string, id: number): Promise<string[]> {
  // Attempt #1: GraphQL projects { name abbreviation }
  {
    const q1 = `
      {
        nations(id:[${id}], first:1) {
          data {
            projects_list: projects { name abbreviation }
          }
        }
      }`;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q1 }),
    });
    const j: any = await r.json().catch(() => ({}));
    const list = j?.data?.nations?.data?.[0]?.projects_list;
    if (Array.isArray(list) && list.length) {
      const names = list.map((p: any) => p?.abbreviation || p?.name).filter(Boolean);
      if (names.length) return names;
    }
  }

  // Attempt #2: GraphQL project_names (if exposed as scalar JSON/string list)
  {
    const q2 = `
      {
        nations(id:[${id}], first:1) {
          data {
            project_names
          }
        }
      }`;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q2 }),
    });
    const j: any = await r.json().catch(() => ({}));
    const raw = j?.data?.nations?.data?.[0]?.project_names;
    if (Array.isArray(raw) && raw.length) return raw.filter(Boolean);
    if (typeof raw === "string" && raw.trim()) {
      // comma or space separated
      return raw.split(/[,\s]+/g).map(s => s.trim()).filter(Boolean);
    }
  }

  // Attempt #3: REST v3 nations? (if keyword/id detail works on your key)
  try {
    const rest = await fetch(
      `https://api.politicsandwar.com/v3/nations?api_key=${encodeURIComponent(api)}&id=${id}&limit=1`,
    );
    if (rest.ok) {
      const jj: any = await rest.json().catch(() => ({}));
      const first = Array.isArray(jj?.data) ? jj.data[0] : null;
      const p = first?.projects;
      if (Array.isArray(p) && p.length) {
        const names = p.map((x: any) => x?.abbreviation || x?.name || String(x)).filter(Boolean);
        if (names.length) return names;
      }
      if (typeof p === "string" && p.trim()) {
        return p.split(/[,\s]+/g).map((s: string) => s.trim()).filter(Boolean);
      }
    }
  } catch { /* ignore */ }

  return [];
}

/* ===================== Mapping ===================== */

function mapNationGraphQL(n: any): NationCore {
  return {
    id: Number(n.id),
    name: n.nation_name,
    leader: n.leader_name,
    allianceId: n.alliance?.id ? Number(n.alliance.id) : n.alliance_id ? Number(n.alliance_id) : null,
    allianceName: n.alliance?.name ?? null,
    score: safeNum(n.score),
    color: n.color ?? null,
    continent: n.continent ?? null,
    soldiers: safeNum(n.soldiers),
    tanks: safeNum(n.tanks),
    aircraft: safeNum(n.aircraft),
    ships: safeNum(n.ships),
    spies: safeNum(n.spies),
    missiles: safeNum(n.missiles),
    nukes: safeNum(n.nukes),
    lastActive: n.last_active ?? null,
  };
}

/* ===================== Card renderer (pretty + exhaustive) ===================== */

function buildWhoCard(n: NationCore, meta: { lookedUp: string; multiNote?: string }) {
  const urlNation  = `https://politicsandwar.com/nation/id=${n.id}`;
  const urlWars    = `https://politicsandwar.com/nation/id=${n.id}&display=war`;
  const urlTrades  = `https://politicsandwar.com/nation/id=${n.id}&display=trade`;
  const urlAlliance = n.allianceId ? `https://politicsandwar.com/alliance/id=${n.allianceId}` : undefined;

  const alliance = n.allianceName && urlAlliance
    ? `[${n.allianceName}](${urlAlliance})`
    : (n.allianceName ?? "None");

  const descBits = [
    meta.multiNote ? `${meta.multiNote}` : null,
    `Looked up by ${meta.lookedUp} • ID: \`${n.id}\` • ${WHO_VERSION}`
  ].filter(Boolean);

  const ranges = warRanges(n.score);

  // Projects line (count + list if available, trimmed to stay within embed limits)
  const projCount = n.projectsCount != null ? `${n.projectsCount}` : "—";
  let projList = "";
  if (n.projectNames && n.projectNames.length) {
    const short = [...n.projectNames].slice(0, 34); // generous but safe
    projList = short.join(", ") + (n.projectNames.length > short.length ? " …" : "");
  }

  const embed = new EmbedBuilder()
    .setColor(hexForBloc(n.color))
    .setTitle(`${n.name} — ${n.leader}`)
    .setURL(urlNation)
    .setDescription(descBits.join(" • "))
    .addFields(
      { name: "Alliance", value: alliance, inline: true },
      { name: "Score", value: fmtScore(n.score), inline: true },
      { name: "Color / Continent", value: `${n.color ?? "—"} / ${n.continent ?? "—"}`, inline: true },

      { name: "Cities", value: fmtInt(n.citiesCount), inline: true },
      { name: "Projects", value: projList ? `${projCount} — ${projList}` : projCount, inline: true },
      { name: "Last Active", value: discordRelative(n.lastActive), inline: true },

      { name: "Soldiers", value: fmtInt(n.soldiers), inline: true },
      { name: "Tanks",    value: fmtInt(n.tanks),    inline: true },
      { name: "Aircraft", value: fmtInt(n.aircraft), inline: true },

      { name: "Ships",    value: fmtInt(n.ships),    inline: true },
      { name: "Spies",    value: fmtInt(n.spies),    inline: true },
      { name: "Missiles / Nukes", value: `${fmtInt(n.missiles)} / ${fmtInt(n.nukes)}`, inline: true },

      { name: "Attack Range (War / Spy)",   value: `${ranges.atkWar}  •  ${ranges.atkSpy}`, inline: false },
      { name: "Defense Range (War / Spy)",  value: `${ranges.defWar}  •  ${ranges.defSpy}`, inline: false },
    )
    .setTimestamp(new Date());

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Link set #1
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Nation").setURL(urlNation),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Wars").setURL(urlWars),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Trades").setURL(urlTrades),
  ));

  // Link set #2 (if alliance)
  if (urlAlliance) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Alliance").setURL(urlAlliance),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Message").setURL(`https://politicsandwar.com/nation/message/${n.id}`),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Market").setURL("https://politicsandwar.com/index.php?id=90"),
    ));
  }

  return { embed, components: rows as [ActionRowBuilder<ButtonBuilder>, ...ActionRowBuilder<ButtonBuilder>[]] };
}
