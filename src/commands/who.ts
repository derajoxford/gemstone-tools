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

const WHO_VERSION = "who-env-2025-09-30c";

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

  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;

  lastActive?: string | null;
  citiesCount?: number | null;
  projectsCount?: number | null;
};

export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Look up a nation by nation name, leader name, Discord user (linked), or nation ID.")
  .addStringOption(o =>
    o.setName("nation")
      .setDescription("Nation name (partial is ok) OR numeric ID")
      .setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader")
      .setDescription("Leader name (partial is ok)")
      .setRequired(false),
  )
  .addUserOption(o =>
    o.setName("user")
      .setDescription("Discord user (uses their linked nation if available)")
      .setRequired(false),
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

    // 0) numeric ID fast-path
    if (nationArg && /^\d+$/.test(nationArg)) {
      const id = Number(nationArg);
      nation = await fetchNationById(api, id);
      lookedUp = `ID ${id}`;
    }

    // 1) nation name search (robust multi-try)
    if (!nation && nationArg) {
      const res = await robustNationSearch(api, { nationName: nationArg });
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 2) leader name search (robust multi-try)
    if (!nation && leaderArg) {
      const res = await robustNationSearch(api, { leaderName: leaderArg });
      if (res.length) {
        nation = res[0];
        lookedUp = `leader name "${leaderArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 3) linked Discord user (or self)
    if (!nation && (user || (!nationArg && !leaderArg))) {
      const targetUser = user ?? i.user;
      const member = await prisma.member.findFirst({
        where: { discordId: targetUser.id },
        select: { nationId: true },
      });
      if (member?.nationId) {
        nation = await fetchNationById(api, member.nationId);
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

    const { embed, components } = buildWhoCard(nation, { lookedUp, multiNote });
    await i.editReply({ embeds: [embed], components });
  } catch (err: any) {
    console.error("who execute error:", err);
    await i.editReply("Sorry — something went wrong looking that up.");
  }
}

/* ===================== Formatting helpers ===================== */

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat().format(Math.round(n));
}
function fmtScore(n: number | null | undefined): string {
  if (n == null) return "—";
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
}
function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toB64(b: any): string {
  // normalize Buffer/Uint8Array/ArrayBuffer to base64
  // @ts-ignore
  return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
}
function discordRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = Math.floor(new Date(iso).getTime() / 1000);
  return `<t:${t}:R>`;
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

// Ranges (Locutus-like)
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

/* ===================== API keys ===================== */

async function getApiKey(): Promise<string | null> {
  const env = process.env.PNW_API?.trim();
  if (env) return env;

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

const BASE_FIELDS = `
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
`;

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
    citiesCount: Array.isArray(n?.cities) ? n.cities.length : safeNum(n?.cities) ?? null,
    projectsCount: safeNum(n?.projects),
  };
}

async function gqlReq<T=any>(api: string, query: string, variables?: Record<string, any>): Promise<{ ok: boolean; data?: T; errors?: any }> {
  try {
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
    if (!r.ok) return { ok: false, errors: `HTTP ${r.status}` };
    const j: any = await r.json().catch(() => ({}));
    if (j?.errors) return { ok: false, errors: j.errors };
    return { ok: true, data: j?.data };
  } catch (e) {
    return { ok: false, errors: String(e) };
  }
}

/**
 * IMPORTANT:
 *  - Embed numeric ID literally; variables sometimes return 0 rows on this endpoint.
 *  - Use schema-safe scalars; arrays need sub-selection.
 */
async function fetchNationById(api: string, id: number): Promise<NationCore | null> {
  const q = `{ nations(id:[${id}], first:1) { data { ${BASE_FIELDS} } } }`;
  const { ok, data, errors } = await gqlReq(api, q);
  if (!ok) {
    console.warn("[/who] fetchNationById error:", JSON.stringify(errors));
    return null;
  }
  const row = (data as any)?.nations?.data?.[0];
  return row ? mapNationGraphQL(row) : null;
}

/* ===================== Robust name/leader search ===================== */
/**
 * Tries multiple GraphQL shapes in order:
 *   1) keyword
 *   2) filter like
 *   3) filter contains
 *   4) simple name/leader args
 * Then REST keyword → hydrate by ID
 */
async function robustNationSearch(
  api: string,
  opts: { nationName?: string; leaderName?: string }
): Promise<NationCore[]> {
  const kw = (opts.nationName ?? opts.leaderName ?? "").trim();
  if (kw.length < 2) return [];

  const like = `%${kw}%`;
  const which = opts.nationName ? "nation" : "leader";

  const variants: Array<{ tag: string; query: string; vars?: Record<string, any> }> = [
    // 1) keyword (partial on both nation & leader)
    { tag: "keyword", query: `query($q:String){ nations(first:5, keyword:$q, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: kw } },

    // 2) filter like
    { tag: "filter_like_nation", query: `query($q:String){ nations(first:5, filter:{ nation_name:{ like:$q } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: like } },
    { tag: "filter_like_leader", query: `query($q:String){ nations(first:5, filter:{ leader_name:{ like:$q } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: like } },

    // 3) filter contains
    { tag: "filter_contains_nation", query: `query($q:String){ nations(first:5, filter:{ nation_name:{ contains:$q } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: kw } },
    { tag: "filter_contains_leader", query: `query($q:String){ nations(first:5, filter:{ leader_name:{ contains:$q } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: kw } },

    // 4) plain args (exact or server-side fuzzy)
    { tag: "arg_name", query: `query($q:String){ nations(first:5, name:$q, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: kw } },
    { tag: "arg_leader", query: `query($q:String){ nations(first:5, leader_name:$q, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`, vars: { q: kw } },
  ];

  // Select which side we try first (nation or leader)
  const order = which === "nation"
    ? ["keyword","filter_like_nation","filter_contains_nation","arg_name","filter_like_leader","filter_contains_leader","arg_leader"]
    : ["keyword","filter_like_leader","filter_contains_leader","arg_leader","filter_like_nation","filter_contains_nation","arg_name"];

  const seen = new Map<number, NationCore>();
  for (const key of order) {
    const v = variants.find(v => v.tag === key)!;
    const { ok, data } = await gqlReq(api, v.query, v.vars);
    if (!ok) continue;
    const arr: any[] = (data as any)?.nations?.data ?? [];
    if (arr.length) {
      for (const row of arr) seen.set(Number(row.id), mapNationGraphQL(row));
      break; // stop on first successful non-empty variant
    }
  }

  // REST keyword fallback (hydrate by ID)
  if (seen.size === 0) {
    try {
      const ids = await restKeywordSearch(api, kw, 5);
      for (const id of ids) {
        const n = await fetchNationById(api, id);
        if (n) seen.set(n.id, n);
      }
    } catch { /* ignore */ }
  }

  return Array.from(seen.values()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
}

async function restKeywordSearch(api: string, kw: string, limit = 5): Promise<number[]> {
  const url = `https://api.politicsandwar.com/v3/nations?api_key=${encodeURIComponent(api)}&keyword=${encodeURIComponent(kw)}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j: any = await r.json().catch(() => ({}));
  const arr = Array.isArray(j?.data) ? j.data : [];
  return arr.slice(0, limit).map((n: any) => Number(n?.id)).filter(Boolean);
}

/* ===================== Card renderer (prettier) ===================== */

function fmtPair(a?: number | null, b?: number | null) {
  return `${fmtInt(a)} / ${fmtInt(b)}`;
}

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
    `🔎 Looked up by ${meta.lookedUp} • 🆔 \`${n.id}\` • ${WHO_VERSION}`
  ].filter(Boolean);

  const ranges = warRanges(n.score);

  const embed = new EmbedBuilder()
    .setColor(hexForBloc(n.color))
    .setTitle(`${n.name} — ${n.leader}`)
    .setURL(urlNation)
    .setDescription(descBits.join(" • "))
    .addFields(
      { name: "🏛️ Alliance", value: alliance, inline: true },
      { name: "📈 Score", value: fmtScore(n.score), inline: true },
      { name: "🎨 / 🌍", value: `${n.color ?? "—"} / ${n.continent ?? "—"}`, inline: true },

      { name: "🏙️ Cities", value: fmtInt(n.citiesCount), inline: true },
      { name: "🧪 Projects", value: fmtInt(n.projectsCount), inline: true },
      { name: "⏱️ Last Active", value: discordRelative(n.lastActive), inline: true },

      { name: "🪖 Soldiers / 🛡️ Tanks", value: fmtPair(n.soldiers, n.tanks), inline: true },
      { name: "✈️ Aircraft / 🚢 Ships", value: fmtPair(n.aircraft, n.ships), inline: true },
      { name: "🕵️ Spies / 🚀 Missiles / ☢️ Nukes", value: `${fmtInt(n.spies)} / ${fmtInt(n.missiles)} / ${fmtInt(n.nukes)}`, inline: true },

      { name: "⚔️ Attack Range (War / Spy)",  value: `${ranges.atkWar}  •  ${ranges.atkSpy}`, inline: false },
      { name: "🛡️ Defense Range (War / Spy)", value: `${ranges.defWar}  •  ${ranges.defSpy}`, inline: false },
    )
    .setTimestamp(new Date());

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🔎 Nation").setURL(urlNation),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("⚔️ Wars").setURL(urlWars),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("💱 Trades").setURL(urlTrades),
  ));

  if (urlAlliance) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🏛️ Alliance").setURL(urlAlliance),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("✉️ Message").setURL(`https://politicsandwar.com/nation/message/${n.id}`),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("🛒 Market").setURL("https://politicsandwar.com/index.php?id=90"),
    ));
  }

  return { embed, components: rows as [ActionRowBuilder<ButtonBuilder>, ...ActionRowBuilder<ButtonBuilder>[]] };
}
