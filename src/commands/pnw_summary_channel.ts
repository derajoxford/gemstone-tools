// src/commands/pnw_summary_channel.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import { getPnwSummaryChannel, setPnwSummaryChannel } from "../utils/pnw_cursor";

export const data = new SlashCommandBuilder()
  .setName("pnw_summary_channel")
  .setDescription("View or set the hourly PnW tax summary channel (per alliance).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("Show the current summary channel for an alliance.")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set")
      .setDescription("Set the summary channel for an alliance.")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Target channel (text/news/thread).")
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread
          )
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription("Clear the summary channel for an alliance.")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand(true);
  const allianceId = interaction.options.getInteger("alliance_id", true);

  if (sub === "view") {
    const cur = await getPnwSummaryChannel(allianceId);
    const embed = new EmbedBuilder()
      .setTitle("PnW Summary Channel")
      .setColor(0x00a8ff)
      .setDescription(
        cur
          ? `**Alliance ID:** \`${allianceId}\`\n**Channel:** <#${cur}> \`(${cur})\``
          : `**Alliance ID:** \`${allianceId}\`\n**Channel:** _not set_`
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "set") {
    const ch = interaction.options.getChannel("channel", true);
    await setPnwSummaryChannel(allianceId, ch.id);
    await interaction.editReply(
      `✅ Summary channel for alliance \`${allianceId}\` set to <#${ch.id}>.`
    );
    return;
  }

  if (sub === "clear") {
    await setPnwSummaryChannel(allianceId, undefined);
    await interaction.editReply(`✅ Summary channel cleared for alliance \`${allianceId}\`.`);
    return;
  }
}

export default { data, execute };
