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

export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Look up a nation by nation name, leader name, or Discord user (linked).")
  .addStringOption(o =>
    o.setName("nation").setDescription("Nation name (full or partial)").setRequired(false),
  )
  .addStringOption(o =>
    o.setName("leader").setDescription("Leader name (full or partial)").setRequired(false),
  )
  .addUserOption(o =>
    o.setName("user").setDescription("Discord user (uses linked nation if available)").setRequired(false),
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply();
  try {
    const nationName = (i.options.getString("nation") || "").trim();
    const leaderName = (i.options.getString("leader") || "").trim();
    const user: User | null = i.options.getUser("user");
    console.log("[/who] start", { nationName, leaderName, user: !!user });

    let nation: NationCore | null = null;
    let lookedUp = "";
    let multiNote = "";

    if (nationName) {
      const res = await searchNations({ nationName }, i.guildId || undefined);
      console.log("[/who] nation search results", res.length);
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationName}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    if (!nation && leaderName) {
      const res = await searchNations({ leaderName }, i.guildId || undefined);
      console.log("[/who] leader search results", res.length);
      if (res.length) {
        nation = res[0];
        lookedUp = `leader name "${leaderName}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    if (!nation && (user || (!nationName && !leaderName))) {
      const targetUser = user ?? i.user;
      const member = await prisma.member.findFirst({
        where: { discordId: targetUser.id },
        select: { nationId: true, discordId: true },
      });
      console.log("[/who] linked member", { hasMember: !!member, nationId: member?.nationId });
      if (member?.nationId) {
        nation = await fetchNationById(member.nationId, i.guildId || undefined);
        lookedUp = `linked nation for <@${targetUser.id}>`;
      }
    }

    if (!nation) {
      await i.editReply({
        content:
          "I couldn't find a nation. Try one of:\n• `/who nation:<nation name>`\n• `/who leader:<leader name>`\n• `/who user:@member` (requires nation link)",
      });
      return;
    }

    const urlNation = `https://politicsandwar.com/nation/id=${nation.id}`;
    const urlWars = `https://politicsandwar.com/nation/id=${nation.id}&display=war`;
    const urlTrades = `https://politicsandwar.com/nation/id=${nation.id}&display=trade`;
    const alliance = nation.allianceName
      ? `[${nation.allianceName}](https://politicsandwar.com/alliance/id=${nation.allianceId})`
      : "None";

    const fields = [
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
    ];

    const embed = new EmbedBuilder()
      .setTitle(`${nation.name} — ${nation.leader}`)
      .setURL(urlNation)
      .setDescription(`${multiNote ? multiNote + " • " : ""}Looked up by ${lookedUp || "ID"} • ID: \`${nation.id}\``)
      .addFields(fields)
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

/* ===================== Helpers ===================== */

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat().format(n);
}

function bufToB64(b: any): string {
  return (Buffer.isBuffer(b) ? b : Buffer.from(b)).toString("base64");
}

async function getApiKeyForGuild(): Promise<string | null> {
  try {
    const k = await prisma.allianceKey.findFirst({
      orderBy: { id: "desc" },
      select: { encryptedApiKey: true, nonceApi: true },
    });
    if (k?.encryptedApiKey && k?.nonceApi) {
      const api = open(bufToB64(k.encryptedApiKey as any), bufToB64(k.nonceApi as any));
      if (api && api.length > 10) {
        console.log("[/who] using AllianceKey from DB");
        return api;
      }
    }
  } catch (e) {
    console.error("[/who] getApiKeyForGuild DB error:", e);
  }
  const env = process.env.PNW_API;
  if (env && env.trim().length) {
    console.log("[/who] using PNW_API from environment");
    return env.trim();
  }
  console.warn("[/who] no API key found (DB or env)");
  return null;
}

async function fetchNationById(id: number): Promise<NationCore | null> {
  const api = await getApiKeyForGuild();

  if (api) {
    const gql = `
      query($id: ID!) {
        nation(id: $id) {
          id
          nation_name
          leader_name
          alliance_id
          alliance { id name }
          score
          cities
          color
          continent
          soldiers
          tanks
          aircraft
          ships
          spies
          missiles
          nukes
          projects
          founded
          last_active
        }
      }
    `;
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables: { id: String(id) } }),
    });
    if (r.ok) {
      const j: any = await r.json();
      if (j?.data?.nation) return mapNationGraphQL(j.data.nation);
    }
  }
  return null;
}

async function searchNations(
  opts: { nationName?: string; leaderName?: string },
): Promise<NationCore[]> {
  const out: NationCore[] = [];
  const api = await getApiKeyForGuild();
  const keyword = (opts.nationName ?? opts.leaderName ?? "").trim();
  console.log("[/who] search input", { keyword, hasApi: !!api });

  if (api && keyword.length >= 2) {
    const gql = `
      query($name: String, $leader: String) {
        nations(
          first: 5,
          filter: {
            ${opts.nationName ? "nation_name: { contains: $name }" : ""}
            ${opts.leaderName ? "leader_name: { contains: $leader }" : ""}
          }
          orderBy: [{ column: SCORE, order: DESC }]
        ) {
          data {
            id
            nation_name
            leader_name
            alliance_id
            alliance { id name }
            score
            cities
            color
            continent
            soldiers
            tanks
            aircraft
            ships
            spies
            missiles
            nukes
            projects
            founded
            last_active
          }
        }
      }
    `;
    const variables: any = {
      name: opts.nationName ? keyword : undefined,
      leader: opts.leaderName ? keyword : undefined,
    };
    const r = await fetch("https://api.politicsandwar.com/graphql?api_key=" + api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: gql, variables }),
    });
    if (r.ok) {
      const j: any = await r.json();
      const arr = j?.data?.nations?.data ?? [];
      console.log("[/who] GraphQL results", arr.length);
      for (const n of arr) out.push(mapNationGraphQL(n));
      if (out.length) {
        out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return out.slice(0, 5);
      }
    } else {
      console.warn("[/who] GraphQL search HTTP", r.status);
    }
  }

  console.warn("[/who] fallback REST (likely to be empty on your host)", { keyword });
  return out.slice(0, 5);
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

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
