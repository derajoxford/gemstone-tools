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

// ================== Setup ==================
const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

type NationCore = {
  id: number;
  name: string;
  leader: string;
  allianceId?: number | null;
  allianceName?: string | null;
  score?: number | null;
  cities?: number | null;
  color?: string | null;
  continent?: string | null;
  soldiers?: number | null;
  tanks?: number | null;
  aircraft?: number | null;
  ships?: number | null;
  spies?: number | null;
  missiles?: number | null;
  nukes?: number | null;
  projects?: number | null;
  founded?: string | null;
  lastActive?: string | null;
};

// ================== Command ==================
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
  console.log("[/who] invoked", {
    nation: i.options.getString("nation"),
    leader: i.options.getString("leader"),
    userOpt: !!i.options.getUser("user"),
  });

  try {
    const nationArg = (i.options.getString("nation") || "").trim();
    const leaderArg = (i.options.getString("leader") || "").trim();
    const user: User | null = i.options.getUser("user");

    let nation: NationCore | null = null;
    let lookedUp = "";
    let multiNote = "";

    // 0) numeric ID path (most reliable)
    if (nationArg && /^\d+$/.test(nationArg)) {
      const id = Number(nationArg);
      nation = await fetchNationById(id);
      console.log("[/who] ID lookup", { id, found: !!nation });
      lookedUp = `ID ${id}`;
    }

    // 1) nation name search
    if (!nation && nationArg) {
      const res = await searchNations({ nationName: nationArg });
      console.log("[/who] nation name results", res.length);
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationArg}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    // 2) leader name search
    if (!nation && leaderArg) {
      const res = await searchNations({ leaderName: leaderArg });
      console.log("[/who] leader name results", res.length);
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
      console.log("[/who] linked member", { hasMember: !!member, nationId: member?.nationId });
      if (member?.nationId) {
        nation = await fetchNationById(member.nationId);
        lookedUp = `linked nation for <@${targetUser.id}>`;
      }
    }

    if (!nation) {
      await i.editReply({
        content:
          "I couldn't find a nation. Try one of:\n" +
          "• `/who nation:<nation name>`\n" +
          "• `/who leader:<leader name>`\n" +
          "• `/who nation:<numeric nation id>`\n" +
          "• `/who user:@member` (requires nation link)",
      });
      return;
    }

    // ========== Build embed ==========
    const urlNation = `https://politicsandwar.com/nation/id=${nation.id}`;
    const urlWars = `https://politicsandwar.com/nation/id=${nation.id}&display=war`;
    const urlTrades = `https://politicsandwar.com/nation/id=${nation.id}&display=trade`;
    const alliance = nation.allianceName
      ? `[${nation.allianceName}](https://politicsandwar.com/alliance/id=${nation.allianceId})`
      : "None";

    const embed = new EmbedBuilder()
      .setTitle(`${nation.name} — ${nation.leader}`)
      .setURL(urlNation)
      .setDescription(`${multiNote ? multiNote + " • " : ""}Looked up by ${lookedUp || "ID"} • ID: \`${nation.id}\``)
      .addFields(
        { name: "Alliance", value: alliance, inline: true },
        { name: "Score", value: fmtNum(nation.score), inline: true },
        { name: "Cities", value: fmtNum(nation.cities), inline: true },
        { name: "Soldiers / Tanks", value: `${fmtNum(nation.soldiers)} / ${fmtNum(nation.tanks)}`, inline: true },
        { name: "Aircraft / Ships", value: `${fmtNum(nation.aircraft)} / ${fmtNum(nation.ships)}`, inline: true },
        { name: "Spies / Missiles / Nukes", value: `${fmtNum(nation.spies)} / ${fmtNum(nation.missiles)} / ${fmtNum(nation.nukes)}`, inline: true },
        { name: "Projects", value: fmtNum(nation.projects), inline: true },
        { name: "Color / Continent", value: `${nation.color ?? "—"} / ${nation.continent ?? "—"}`, inline: true },
        {
          name: "Active / Founded",
          value: `${nation.lastActive ? new Date(nation.lastActive).toLocaleString() : "—"}\n${nation.founded ? new Date(nation.founded).toLocaleDateString() : "—"}`,
          inline: true,
        },
      )
      .setFooter({ text: `Requested by ${i.user.username}` })
      .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Nation").setURL(urlNation),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Wars").setURL(urlWars),
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Trades").setURL(urlTrades),
    );

    await i.editReply({ embeds: [embed], components: [row] });
  } catch (err: any) {
    console.error("who execute error:", err);
    await i.editReply("Sorry — something went wrong looking that up.");
  }
}

// ================== Helpers & API ==================
function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat().format(n);
}

function toB64(b: any): string {
  // normalize Buffer/Uint8Array/ArrayBuffer to base64
  // @ts-ignore
  return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
}

async function getApiKey(): Promise<string | null> {
  try {
    const k = await prisma.allianceKey.findFirst({
      orderBy: { id: "desc" },
      select: { encryptedApiKey: true, nonceApi: true },
    });
    if (k?.encryptedApiKey && k?.nonceApi) {
      const api = open(toB64(k.encryptedApiKey as any), toB64(k.nonceApi as any));
      if (api && api.length > 10) {
        console.log("[/who] using AllianceKey from DB");
        return api;
      }
    }
  } catch (e) {
    console.error("[/who] getApiKey DB error:", e);
  }
  const env = process.env.PNW_API;
  if (env && env.trim().length) {
    console.log("[/who] using PNW_API from environment", { len: env.trim().length });
    return env.trim();
  }
  console.warn("[/who] no API key found (DB or env)");
  return null;
}

function mapNationGraphQL(n: any): NationCore {
  return {
    id: Number(n.id),
    name: n.nation_name,
    leader: n.leader_name,
    allianceId: n.alliance?.id ? Number(n.alliance.id) : n.alliance_id ? Number(n.alliance_id) : null,
    allianceName: n.alliance?.name ?? null,
    score: safeNum(n.score),
    cities: safeNum(n.cities),
    color: n.color ?? null,
    continent: n.continent ?? null,
    soldiers: safeNum(n.soldiers),
    tanks: safeNum(n.tanks),
    aircraft: safeNum(n.aircraft),
    ships: safeNum(n.ships),
    spies: safeNum(n.spies),
    missiles: safeNum(n.missiles),
    nukes: safeNum(n.nukes),
    projects: safeNum(n.projects),
    founded: n.founded ?? null,
    lastActive: n.last_active ?? null,
  };
}

function mapNationREST(n: any): NationCore {
  return {
    id: Number(n.id),
    name: n.nation_name ?? n.name ?? "",
    leader: n.leader_name ?? n.leader ?? "",
    allianceId: n.alliance_id ? Number(n.alliance_id) : null,
    allianceName: n.alliance ?? n.alliance_name ?? null,
    score: safeNum(n.score),
    cities: safeNum(n.cities),
    color: n.color ?? null,
    continent: n.continent ?? null,
    soldiers: safeNum(n.soldiers),
    tanks: safeNum(n.tanks),
    aircraft: safeNum(n.aircraft),
    ships: safeNum(n.ships),
    spies: safeNum(n.spies),
    missiles: safeNum(n.missiles),
    nukes: safeNum(n.nukes),
    projects: safeNum(n.projects),
    founded: n.founded ?? null,
    lastActive: n.last_active ?? null,
  };
}

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- GraphQL (correct schema: nations(...)) ----------
async function fetchNationById(id: number): Promise<NationCore | null> {
  const api = await getApiKey();
  if (!api) {
    console.warn("[/who] no API key for fetchNationById");
    return null;
  }

  const gql = `
    query($id:[ID!]) {
      nations(id:$id, first:1) {
        data {
          id nation_name leader_name
          alliance_id alliance { id name }
          score cities color continent soldiers tanks aircraft ships spies missiles nukes projects
          founded last_active
        }
      }
    }`;
  const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: gql, variables: { id: [String(id)] } }),
  });
  if (!r.ok) {
    console.warn("[/who] fetchNationById HTTP", r.status);
    return null;
  }
  const j: any = await r.json();
  const row = j?.data?.nations?.data?.[0];
  console.log("[/who] fetchNationById rows", row ? 1 : 0);
  return row ? mapNationGraphQL(row) : null;
}

/** Returns up to 5 nations; tries name string, then nation_name/leader_name arrays; then REST exact-ish as last resort. */
async function searchNations(
  opts: { nationName?: string; leaderName?: string },
): Promise<NationCore[]> {
  const api = await getApiKey();
  const kw = (opts.nationName ?? opts.leaderName ?? "").trim();
  const out: NationCore[] = [];

  if (!api || kw.length < 2) {
    console.warn("[/who] search: no api or short kw", { hasApi: !!api, kw });
    return out;
  }

  const run = async (variables: any, argLine: string, tag: string) => {
    const gql = `
      query($name:String, $narr:[String!], $larr:[String!]) {
        nations(${argLine}, first:5, orderBy:{column:SCORE, order:DESC}) {
          data {
            id nation_name leader_name
            alliance_id alliance { id name }
            score cities color continent soldiers tanks aircraft ships spies missiles nukes projects
            founded last_active
          }
        }
      }`;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables }),
    });
    if (!r.ok) {
      console.warn("[/who] search HTTP", tag, r.status);
      return;
    }
    const j: any = await r.json();
    const arr = j?.data?.nations?.data ?? [];
    console.log("[/who] GraphQL results", tag, arr.length);
    for (const n of arr) out.push(mapNationGraphQL(n));
  };

  if (opts.nationName) {
    // 1) name:string (server may do partials)
    await run({ name: kw }, "name:$name", "name:string");
    if (out.length === 0) {
      // 2) nation_name:["exact"] (strict)
      await run({ narr: [kw] }, "nation_name:$narr", "nation_name:array");
    }
  }

  if (opts.leaderName && out.length === 0) {
    // 3) leader_name:["exact"]
    await run({ larr: [kw] }, "leader_name:$larr", "leader_name:array");
  }

  // Last-ditch REST (we've seen keyword return 0 on this host)
  if (out.length === 0) {
    for (const url of [
      `https://api.politicsandwar.com/v3/nations?name=${encodeURIComponent(kw)}&limit=5`,
      `https://api.politicsandwar.com/v3/nations?leader_name=${encodeURIComponent(kw)}&limit=5`,
    ]) {
      try {
        const r = await fetch(url);
        if (r.ok) {
          const j: any = await r.json();
          const arr = j?.data ?? [];
          console.log("[/who] REST results", url.includes("leader_") ? "leader_name" : "name", arr.length);
          for (const n of arr) out.push(mapNationREST(n));
          if (out.length) break;
        } else {
          console.warn("[/who] REST HTTP", r.status, url);
        }
      } catch (e) {
        console.warn("[/who] REST error", url, e);
      }
    }
  }

  // dedup + rank
  const dedup = new Map<number, NationCore>();
  for (const n of out) dedup.set(n.id, n);
  const fin = Array.from(dedup.values()).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
  console.log("[/who] search final", fin.length);
  return fin;
}
