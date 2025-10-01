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

const WHO_VERSION = "who-env-2025-09-30e";

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

    // 1) nation name search (robust literal-query + REST fallbacks)
    if (!nation && nationArg) {
      const res = await robustNationSearchLiteral(api, { nationName: nationArg });
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 2) leader name search (robust literal-query + REST fallbacks)
    if (!nation && leaderArg) {
      const res = await robustNationSearchLiteral(api, { leaderName: leaderArg });
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
  };
}

async function gqlReq<T=any>(api: string, query: string): Promise<{ ok: boolean; data?: T; errors?: any }> {
  try {
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
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

/* ===================== Robust literal-search ===================== */
/** Escape a string for safe literal embedding into GraphQL double-quoted scalars */
function gqlStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function robustNationSearchLiteral(
  api: string,
  opts: { nationName?: string; leaderName?: string }
): Promise<NationCore[]> {
  const kwRaw = (opts.nationName ?? opts.leaderName ?? "").trim();
  if (kwRaw.length < 2) return [];
  const kw = gqlStr(kwRaw);
  const like = `%${kw}%`;
  const which = opts.nationName ? "nation" : "leader";

  const variants: Array<{ tag: string; q: string }> = [
    // 1) keyword (server-side partial across name/leader)
    { tag: "keyword", q: `{ nations(first:5, keyword:"${kw}", orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },

    // 2) filter like
    { tag: "like_nation", q: `{ nations(first:5, filter:{ nation_name:{ like:"${like}" } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },
    { tag: "like_leader", q: `{ nations(first:5, filter:{ leader_name:{ like:"${like}" } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },

    // 3) filter contains
    { tag: "contains_nation", q: `{ nations(first:5, filter:{ nation_name:{ contains:"${kw}" } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },
    { tag: "contains_leader", q: `{ nations(first:5, filter:{ leader_name:{ contains:"${kw}" } }, orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },

    // 4) plain args (some servers support loose match here)
    { tag: "arg_name", q: `{ nations(first:5, name:"${kw}", orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },
    { tag: "arg_leader", q: `{ nations(first:5, leader_name:"${kw}", orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }` },
  ];

  const order = which === "nation"
    ? ["keyword","like_nation","contains_nation","arg_name","like_leader","contains_leader","arg_leader"]
    : ["keyword","like_leader","contains_leader","arg_leader","like_nation","contains_nation","arg_name"];

  const seen = new Map<number, NationCore>();
  for (const key of order) {
    const v = variants.find(v => v.tag === key)!;
    const { ok, data } = await gqlReq(api, v.q);
    if (!ok) continue;
    const arr: any[] = (data as any)?.nations?.data ?? [];
    if (arr.length) {
      for (const row of arr) seen.set(Number(row.id), mapNationGraphQL(row));
      break; // stop on first non-empty result
    }
  }

  // If still empty, try each significant word with keyword:
  if (seen.size === 0) {
    const words = kwRaw.split(/\s+/g).map(w => w.trim()).filter(w => w.length >= 3).slice(0, 3);
    for (const w of words) {
      const wq = gqlStr(w);
      const q = `{ nations(first:5, keyword:"${wq}", orderBy:[{column:SCORE,order:DESC}]) { data { ${BASE_FIELDS} } } }`;
      const { ok, data } = await gqlReq(api, q);
      if (!ok) continue;
      const arr: any[] = (data as any)?.nations?.data ?? [];
      for (const row of arr) seen.set(Number(row.id), mapNationGraphQL(row));
      if (seen.size) break;
    }
  }

  // REST fallbacks → hydrate by ID
  if (seen.size === 0) {
    const ids = await restMultiSearchIds(api, kwRaw, 5);
    for (const id of ids) {
      const n = await fetchNationById(api, id);
      if (n) seen.set(n.id, n);
    }
  }

  return Array.from(seen.values()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
}

/* ===================== REST fallbacks ===================== */

async function restMultiSearchIds(api: string, kw: string, limit = 5): Promise<number[]> {
  const bases = [
    `https://api.politicsandwar.com/v3/nations?api_key=${encodeURIComponent(api)}`,
  ];
  const params = [
    `keyword=${encodeURIComponent(kw)}`,
    `name=${encodeURIComponent(kw)}`,
    `nation_name=${encodeURIComponent(kw)}`,
    `leader=${encodeURIComponent(kw)}`,
    `leader_name=${encodeURIComponent(kw)}`,
  ];
  const ids: number[] = [];
  for (const base of bases) {
    for (const p of params) {
      const url = `${base}&${p}&limit=${limit}`;
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const j: any = await r.json().catch(() => ({}));
        const arr = Array.isArray(j?.data) ? j.data : [];
        for (const n of arr) {
          const id = Number(n?.id);
          if (id && !ids.includes(id)) ids.push(id);
        }
        if (ids.length) return ids.slice(0, limit);
      } catch { /* ignore and try next */ }
    }
  }
  return ids.slice(0, limit);
}

/* ===================== Card renderer (prettier; separate military fields) ===================== */

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
      { name: "⏱️ Last Active", value: discordRelative(n.lastActive), inline: true },
      { name: "\u200b", value: "\u200b", inline: true }, // spacer row to keep grid tidy

      { name: "🪖 Soldiers", value: fmtInt(n.soldiers), inline: true },
      { name: "🛡️ Tanks",    value: fmtInt(n.tanks),    inline: true },
      { name: "✈️ Aircraft", value: fmtInt(n.aircraft), inline: true },

      { name: "🚢 Ships",    value: fmtInt(n.ships),    inline: true },
      { name: "🕵️ Spies",    value: fmtInt(n.spies),    inline: true },
      { name: "🚀 Missiles", value: fmtInt(n.missiles), inline: true },

      { name: "☢️ Nukes",    value: fmtInt(n.nukes),    inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "\u200b", value: "\u200b", inline: true },

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
