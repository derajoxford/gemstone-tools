// src/commands/guild_link_alliance.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ChatInputCommandInteraction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("guild_link_alliance")
  .setDescription("Link THIS Discord server to a PnW Alliance for banking/safekeeping.")
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("PnW Alliance ID (number)")
      .setRequired(true)
  )
  .addChannelOption(o =>
    o.setName("review_channel")
      .setDescription("Channel for banker approvals (optional)")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  const tag = "[guild_link_alliance]";
  try {
    if (!i.guildId) {
      return i.reply({ content: "This command can only be used in a server.", ephemeral: true });
    }

    const allianceId = i.options.getInteger("alliance_id", true);
    const reviewCh = i.options.getChannel("review_channel");
    const reviewChannelId =
      reviewCh && reviewCh.type === ChannelType.GuildText ? reviewCh.id : undefined;

    // 1) Ensure Alliance exists (legacy field guildId retained but we use mapping table AllianceGuild)
    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: { guildId: i.guildId ?? undefined, reviewChannelId: reviewChannelId ?? undefined },
      create: {
        id: allianceId,
        guildId: i.guildId ?? undefined,
        reviewChannelId: reviewChannelId ?? undefined,
      },
    });

    // 2) Link this Guild -> Alliance via mapping table
    await prisma.allianceGuild.upsert({
      where: { guildId: i.guildId },
      update: { allianceId },
      create: { guildId: i.guildId, allianceId },
    });

    // 3) Optional: if user passed a review channel, store it
    if (reviewChannelId) {
      await prisma.alliance.update({
        where: { id: allianceId },
        data: { reviewChannelId },
      });
    }

    await i.reply({
      content: `✅ Linked this guild to alliance **${allianceId}**${reviewChannelId ? `.\nApproval channel: <#${reviewChannelId}>` : "."}`,
      ephemeral: true,
    });
  } catch (err: any) {
    console.error(`${tag} error:`, err);
    const msg =
      err?.code === "P2021"
        ? "Database table missing (did you run `npx prisma db push`?)."
        : err?.code === "P2022"
        ? "Database column missing/mismatched (run `npx prisma generate && npx prisma db push`)."
        : "Something went wrong. Check bot logs for details.";
    try {
      await i.reply({ content: `❌ ${msg}`, ephemeral: true });
    } catch {}
  }
}

