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
import fetch from "node-fetch";
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
    o
      .setName("nation")
      .setDescription("Nation name (exact or partial)")
      .setRequired(false),
  )
  .addStringOption(o =>
    o
      .setName("leader")
      .setDescription("Leader name (exact or partial)")
      .setRequired(false),
  )
  .addUserOption(o =>
    o
      .setName("user")
      .setDescription("Discord user (uses linked nation if available)")
      .setRequired(false),
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply();

  try {
    const nationName = (i.options.getString("nation") || "").trim();
    const leaderName = (i.options.getString("leader") || "").trim();
    const user: User | null = i.options.getUser("user");

    // PRIORITY: nation → leader → linked Discord user (or self)
    let nation: NationCore | null = null;
    let lookedUp = "";
    let multiNote = "";

    if (nationName) {
      const res = await searchNations({ nationName }, i.guildId || undefined);
      if (res.length) {
        nation = res[0];
        lookedUp = `nation name "${nationName}"`;
        if (res.length > 1) multiNote = `Multiple matches (${res.length}). Showing best by score.`;
      }
    }

    if (!nation && leaderName) {
      const res = await searchNations({ leaderName }, i.guildId || undefined);
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
      if (member?.nationId) {
        nation = await fetchNationById(member.nationId, i.guildId || undefined);
        lookedUp = `linked nation for <@${targetUser.id}>`;
      }
    }

    if (!nation) {
      await i.editReply({
        content:
          "I couldn't find a nation. Try one of:\n• `/who nation:<nation name>` (partial ok)\n• `/who leader:<leader name>` (partial ok)\n• `/who user:@member` (requires nation link)",
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

async function getApiKeyForGuild(guildId?: string): Promise<string | null> {
  try {
    if (guildId) {
      const k = await prisma.allianceKey.findFirst({ orderBy: { id: "desc" } });
      if (k) return open(k.encryptedApiKey, k.nonce);
    }
  } catch {}
  const env = process.env.PNW_API;
  return env && env.trim().length ? env.trim() : null;
}

async function fetchNationById(id: number, guildId?: string): Promise<NationCore | null> {
  const api = await getApiKeyForGuild(guildId);

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
          ta
