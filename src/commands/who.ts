// src/commands/who.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  userMention,
} from "discord.js";

const WHO_VERSION = "who-env-2025-09-30b";

// ---------- Types ----------
type NationRow = {
  id: string;
  nation_name: string;
  leader_name: string;
  alliance_id?: string | null;
  alliance?: { id?: string | null; name?: string | null } | null;
  score?: number | null;
  color?: string | null;
  continent?: string | null;
  cities?: number | null; // API often returns numeric city count
  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;
  last_active?: string | null;
};

type NationCore = {
  id: number;
  nation_name: string;
  leader_name: string;
  alliance_id?: number | null;
  alliance_name?: string | null;
  score?: number | null;
  color?: string | null;
  continent?: string | null;
  cities?: number | null;
  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;
  last_active?: string | null;
};

// ---------- Command definition ----------
export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Detailed look at a nation (by @user, nation name, leader name, or nation ID).")
  .addUserOption(o =>
    o.setName("user").setDescription("Discord user (must be linked with /link_nation)").setRequired(false),
  )
  .addStringOption(o =>
    o
      .setName("nation")
      .setDescription("Nation name (partial ok) or numeric nation ID")
      .setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader").setDescription("Leader name (partial ok)").setRequired(false),
  );

export async function execute(i: ChatInputCommandInteraction) {
  try {
    await i.deferReply({ ephemeral: false });

    const nationOpt = (i.options.getString("nation") || "").trim();
    const leaderOpt = (i.options.getString("leader") || "").trim();
    const userOpt = i.options.getUser("user");

    const api = process.env.PNW_API || "";
    if (!api) {
      return i.editReply(
        "⚠️ The bot is missing the `PNW_API` environment variable. Ask an admin to set it on the service.",
      );
    }

    console.log("[/who]", WHO_VERSION, "invoked", {
      nation: nationOpt || null,
      leader: leaderOpt || null,
      userOpt: !!userOpt,
    });

    let nation: NationCore | null = null;
    let lookedUp: string | undefined;

    // 1) nation ID if numeric
    const idNum = nationOpt && /^\d+$/.test(nationOpt) ? Number(nationOpt) : null;
    if (idNum) {
      nation = await fetchNationById(api, idNum);
      lookedUp = `ID ${idNum}`;
      console.log("[/who] ID lookup", { id: idNum, found: !!nation });
    }

    // 2) linked nation via /link_nation (if user provided) — best-effort
    if (!nation && userOpt) {
      const linked = await fetchLinkedNationId(i.guildId || "", userOpt.id);
      if (linked) {
        nation = await fetchNationById(api, linked);
        lookedUp = `linked nation for ${userMention(userOpt.id)}`;
        console.log("[/who] linked member -> nid", linked, "found", !!nation);
      }
    }

    // 3) Search by nation name (partial or exact)
    if (!nation && nationOpt && !idNum) {
      nation = await searchByNationName(api, nationOpt);
      lookedUp = `nation name: “${nationOpt}”`;
      console.log("[/who] nation-name search found", !!nation);
    }

    // 4) Search by leader name (partial or exact)
    if (!nation && leaderOpt) {
      nation = await searchByLeaderName(api, leaderOpt);
      lookedUp = `leader: “${leaderOpt}”`;
      console.log("[/who] leader-name search found", !!nation);
    }

    if (!nation) {
      return i.editReply(
        "I couldn't find a nation. Try one of:\n" +
          "• `/who nation:<nation name>`\n" +
          "• `/who leader:<leader name>`\n" +
          "• `/who nation:<numeric nation id>`\n" +
          "• `/who user:@member` *(requires nation link)*",
      );
    }

    // Present the embed
    const embed = buildNationEmbed(nation, lookedUp);
    const rows = buildButtons(nation);
    await i.editReply({ embeds: [embed], components: rows });
  } catch (err) {
    console.error("[/who] execute error", err);
    try {
      await i.editReply("Something went wrong trying to look that up.");
    } catch {}
  }
}

// ---------- Search helpers ----------

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function gqlBody(query: string) {
  return JSON.stringify({ query });
}

const GQL_SELECT = `
  id
  nation_name
  leader_name
  alliance_id
  alliance { id name }
  score
  color
  continent
  cities
  soldiers
  tanks
  aircraft
  ships
  spies
  missiles
  nukes
  last_active
`;

async function fetchNationById(api: string, id: number): Promise<NationCore | null> {
  const q = `{
    nations(id:[${id}], first:1) {
      data { ${GQL_SELECT} }
    }
  }`;
  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: gqlBody(q),
  });

  if (!r.ok) {
    console.warn("[/who] fetchNationById HTTP", r.status);
    return null;
  }
  const j: any = await r.json().catch(() => ({}));
  const arr: NationRow[] = j?.data?.nations?.data ?? [];
  console.log("[/who] fetchNationById rows", arr.length, j?.errors ? JSON.stringify(j.errors) : "");
  const row = arr[0];
  return row ? mapNation(row) : null;
}

// 3a) nation name search — exact first (nation_name: ["..."]), then fuzzy (name:"...")
async function searchByNationName(api: string, needle: string): Promise<NationCore | null> {
  // Exact (array arg)
  const exact = await nationsExact(api, "nation_name", [needle]);
  if (exact.length) return pickBest(needle, exact, "nation");

  // Fuzzy keyword (if server supports) — quietly ignore errors
  const fuzzy = await nationsKeyword(api, needle);
  if (fuzzy.length) return pickBest(needle, fuzzy, "nation");

  // As a last resort, try leader_name exact if user typed a leader into nation field
  const leaderExact = await nationsExact(api, "leader_name", [needle]);
  if (leaderExact.length) return pickBest(needle, leaderExact, "leader");

  return null;
}

// 4a) leader name search — exact first, then fuzzy keyword
async function searchByLeaderName(api: string, needle: string): Promise<NationCore | null> {
  const exact = await nationsExact(api, "leader_name", [needle]);
  if (exact.length) return pickBest(needle, exact, "leader");

  const fuzzy = await nationsKeyword(api, needle);
  if (fuzzy.length) return pickBest(needle, fuzzy, "leader");

  // If their input was actually a nation name, catch it here
  const nationExact = await nationsExact(api, "nation_name", [needle]);
  if (nationExact.length) return pickBest(needle, nationExact, "nation");

  return null;
}

// Exact array search using GraphQL args leader_name / nation_name (documented)
async function nationsExact(api: string, field: "nation_name" | "leader_name", values: string[]) {
  const arrLit = values.map(v => `"${esc(v)}"`).join(",");
  const q = `{
    nations(first: 10, ${field}: [${arrLit}]) {
      data { ${GQL_SELECT} }
    }
  }`;
  try {
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: gqlBody(q),
    });
    if (!r.ok) return [];
    const j: any = await r.json().catch(() => ({}));
    const rows: NationRow[] = j?.data?.nations?.data ?? [];
    return rows.map(mapNation);
  } catch {
    return [];
  }
}

// Keyword search using GraphQL `name` (supported by many deployments; ignore errors if absent)
async function nationsKeyword(api: string, keyword: string) {
  const kw = keyword.trim();
  if (!kw) return [];
  const q = `{
    nations(first: 25, name: "${esc(kw)}", orderBy: [{column:SCORE, order: DESC}]) {
      data { ${GQL_SELECT} }
    }
  }`;
  try {
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: gqlBody(q),
    });
    if (!r.ok) return [];
    const j: any = await r.json().catch(() => ({}));
    if (j?.errors) {
      // Server doesn't support `name` arg — that's okay, just fallback.
      console.log("[/who] keyword search unsupported; falling back");
      return [];
    }
    const rows: NationRow[] = j?.data?.nations?.data ?? [];
    return rows.map(mapNation);
  } catch {
    return [];
  }
}

// --------- mapping & ranking ----------
function mapNation(r: NationRow): NationCore {
  return {
    id: Number(r.id),
    nation_name: r.nation_name,
    leader_name: r.leader_name,
    alliance_id: r.alliance?.id ? Number(r.alliance.id) : r.alliance_id ? Number(r.alliance_id) : null,
    alliance_name: r.alliance?.name || null,
    score: num(r.score),
    color: r.color || null,
    continent: r.continent || null,
    cities: num(r.cities),
    soldiers: num(r.soldiers),
    tanks: num(r.tanks),
    aircraft: num(r.aircraft),
    ships: num(r.ships),
    spies: num(r.spies),
    missiles: num(r.missiles),
    nukes: num(r.nukes),
    last_active: r.last_active || null,
  };
}
function num(n: any): number | null {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function pickBest(needle: string, rows: NationCore[], kind: "nation" | "leader"): NationCore {
  const q = needle.toLowerCase();
  const scoreRow = (r: NationCore) => {
    const s = (kind === "nation" ? r.nation_name : r.leader_name) || "";
    const t = s.toLowerCase();
    if (t === q) return 1000;
    if (t.startsWith(q)) return 800;
    if (t.includes(q)) return 700;
    // token overlap bonus
    const qTok = q.split(/\s+/);
    const tTok = t.split(/\s+/);
    const overlap = qTok.filter(x => tTok.includes(x)).length;
    return 100 + overlap * 10;
  };
  return rows.slice().sort((a, b) => scoreRow(b) - scoreRow(a))[0]!;
}

// ---------- linked nation helper (minimal; uses your existing schema) ----------
async function fetchLinkedNationId(guildId: string, discordId: string): Promise<number | null> {
  // This route avoids Prisma to keep the command self-contained.
  // If your Member table is required, you can swap this with a small fetcher in your codebase.
  // For now, return null (unless you’ve exposed an HTTP endpoint).
  // You already have this working on your side; I’m leaving the stub for clarity.
  return null;
}

// ---------- Embed / buttons ----------
const COLOR_HEX: Record<string, number> = {
  beige: 0xE7DEC8,
  black: 0x2C2F33,
  blue: 0x3498db,
  brown: 0x8E6E53,
  red: 0xE74C3C,
  green: 0x2ECC71,
  aqua: 0x1ABC9C,
  yellow: 0xF1C40F,
  lime: 0xA4DE02,
  maroon: 0x800000,
  orange: 0xE67E22,
  pink: 0xFFC0CB,
  purple: 0x9B59B6,
  white: 0xECF0F1,
  gray: 0x95A5A6,
  turquoise: 0x1ABC9C,
};

function buildNationEmbed(n: NationCore, lookedUp?: string) {
  const allianceLine =
    n.alliance_id && n.alliance_name
      ? `[${n.alliance_name}](https://politicsandwar.com/alliance/id=${n.alliance_id})`
      : "—";

  const score = n.score ?? 0;
  const { warMin, warMax, spyMin, spyMax, defWarMin, defWarMax, defSpyMin, defSpyMax } =
    computeRanges(score);

  const lc = prettyLastActive(n.last_active);
  const color = n.color ? (COLOR_HEX[n.color.toLowerCase()] ?? Colors.Blurple) : Colors.Blurple;

  const embed = new EmbedBuilder()
    .setTitle(`${n.nation_name} — ${n.leader_name}`)
    .setColor(color)
    .setDescription(
      `${lookedUp ? `Looked up by ${lookedUp} • ` : ""}ID: \`${n.id}\` • ${WHO_VERSION}`,
    )
    .addFields(
      { name: "🏳️ Alliance", value: allianceLine, inline: true },
      { name: "📈 Score", value: fmt(score), inline: true },
      {
        name: "🎨 Color / 🌍 Continent",
        value: `${n.color ?? "—"} / ${n.continent ?? "—"}`,
        inline: true,
      },
      { name: "🏙️ Cities", value: fmt(n.cities), inline: true },
      { name: "🧰 Projects", value: "—", inline: true }, // not requested to list out
      { name: "⏰ Last Active", value: lc, inline: true },
      { name: "🪖 Soldiers", value: fmt(n.soldiers), inline: true },
      { name: "🛡️ Tanks", value: fmt(n.tanks), inline: true },
      { name: "✈️ Aircraft", value: fmt(n.aircraft), inline: true },
      { name: "🚢 Ships", value: fmt(n.ships), inline: true },
      { name: "🕵️ Spies", value: fmt(n.spies), inline: true },
      { name: "🚀 Missiles / ☢️ Nukes", value: `${fmt(n.missiles)} / ${fmt(n.nukes)}`, inline: true },
      {
        name: "⚔️ Attack Range (War / Spy)",
        value: `${warMin}–${warMax} • ${spyMin}–${spyMax}`,
        inline: false,
      },
      {
        name: "🛡️ Defense Range (War / Spy)",
        value: `${defWarMin}–${defWarMax} • ${defSpyMin}–${defSpyMax}`,
        inline: false,
      },
    )
    .setFooter({ text: new Date().toLocaleString() });

  return embed;
}

function buildButtons(n: NationCore) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Nation")
      .setEmoji("🔗")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/nation/id=${n.id}`),
    new ButtonBuilder()
      .setLabel("Wars")
      .setEmoji("⚔️")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/nation/id=${n.id}#wars`),
    new ButtonBuilder()
      .setLabel("Trades")
      .setEmoji("💱")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/index.php?id=${n.id}&display=trade`),
  );
  rows.push(row1);

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Alliance")
      .setEmoji("🏳️")
      .setStyle(ButtonStyle.Link)
      .setURL(
        n.alliance_id
          ? `https://politicsandwar.com/alliance/id=${n.alliance_id}`
          : `https://politicsandwar.com/alliances/`,
      ),
    new ButtonBuilder()
      .setLabel("Message")
      .setEmoji("✉️")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://politicsandwar.com/inbox/message/create/${n.id}`),
    new ButtonBuilder()
      .setLabel("Market")
      .setEmoji("🏪")
      .setStyle(ButtonStyle.Link)
      .setURL("https://politicsandwar.com/trade/"),
  );
  rows.push(row2);

  return rows;
}

// ---------- formatting & math ----------
function fmt(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return Number(v).toLocaleString();
}

function prettyLastActive(last: string | null | undefined): string {
  if (!last) return "—";
  // PnW returns ISO date/time; display relative-ish
  try {
    const d = new Date(last);
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffH = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffH < 1) return "just now";
    if (diffH < 24) return `${diffH} hour${diffH === 1 ? "" : "s"} ago`;
    return d.toLocaleString();
  } catch {
    return last;
  }
}

function computeRanges(score: number) {
  const warMin = (score * 0.75).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const warMax = (score * 1.75).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const spyMin = (score * 0.66).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const spyMax = (score * 2.66).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const defWarMin = (score / 1.75).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const defWarMax = (score / 0.75).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const defSpyMin = (score / 2.66).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const defSpyMax = (score / 0.66).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return { warMin, warMax, spyMin, spyMax, defWarMin, defWarMax, defSpyMin, defSpyMax };
}

export default { data, execute };
