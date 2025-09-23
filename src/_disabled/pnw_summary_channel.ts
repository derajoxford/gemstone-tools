// src/commands/pnw_summary_channel.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ChannelType,
  type GuildBasedChannel,
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
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set")
      .setDescription("Set the summary channel for an alliance (sends a test message).")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
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
            ChannelType.AnnouncementThread,
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription("Clear the summary channel for an alliance.")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand(true);
  const allianceId = interaction.options.getInteger("alliance_id", true);

  // VIEW
  if (sub === "view") {
    const cur = await getPnwSummaryChannel(allianceId);
    const embed = new EmbedBuilder()
      .setTitle("PnW Summary Channel")
      .setColor(0x00a8ff)
      .setDescription(
        cur
          ? `**Alliance ID:** \`${allianceId}\`\n**Channel:** <#${cur}> \`(${cur})\``
          : `**Alliance ID:** \`${allianceId}\`\n**Channel:** _not set_`,
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // SET
  if (sub === "set") {
    const ch = interaction.options.getChannel("channel", true) as GuildBasedChannel;

    // Ensure same guild
    if (!interaction.guildId || ch.guildId !== interaction.guildId) {
      await interaction.editReply(
        "That channel isn’t in this server. Pick a channel from the current server.",
      );
      return;
    }

    // Permission preflight
    const meId = interaction.client.user?.id;
    if (!meId) {
      await interaction.editReply("Bot user not ready; try again in a moment.");
      return;
    }
    const perms = ch.permissionsFor(meId);
    if (!perms) {
      await interaction.editReply("Could not resolve my permissions for that channel.");
      return;
    }

    const needs: string[] = [];
    if (!perms.has("ViewChannel")) needs.push("View Channel");
    if (
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread
    ) {
      if (!perms.has("SendMessagesInThreads")) needs.push("Send Messages in Threads");
    } else {
      if (!perms.has("SendMessages")) needs.push("Send Messages");
    }

    if (needs.length) {
      await interaction.editReply(
        `I’m missing required permission(s) in <#${ch.id}>: **${needs.join(", ")}**.\n` +
          "Please adjust channel/server permissions, then try again.",
      );
      return;
    }

    // Save the channel id
    await setPnwSummaryChannel(allianceId, ch.id);

    // Try to post a small test embed so admins immediately see it’s wired up
    const test = new EmbedBuilder()
      .setTitle("PnW Tax — Summary Channel Linked")
      .setColor(0x2ecc71)
      .setDescription(
        `This channel is now configured for **hourly** PnW tax summaries.\n` +
          `**Alliance ID:** \`${allianceId}\`\n` +
          `**Guild:** \`${interaction.guildId}\``,
      )
      .setFooter({ text: "You’ll get a heartbeat every hour (applied/no-op/preview)." })
      .setTimestamp(new Date());

    // Use discord.js send if possible (thread/text/news all implement TextBasedChannel)
    try {
      // @ts-ignore: send exists for text-based channels and threads
      if ("send" in ch && typeof (ch as any).send === "function") {
        await (ch as any).send({ embeds: [test] });
      }
    } catch (e: any) {
      // Keep the setting but surface the error to the admin
      await interaction.editReply(
        `Saved, but I failed to post a test message in <#${ch.id}>: \`${e?.message ?? e}\`\n` +
          `Double-check channel permissions for the bot and try \`/pnw_summary_channel set\` again if needed.`,
      );
      return;
    }

    await interaction.editReply(`✅ Summary channel set to <#${ch.id}> and test message posted.`);
    return;
  }

  // CLEAR
  if (sub === "clear") {
    await setPnwSummaryChannel(allianceId, undefined);
    await interaction.editReply(`✅ Summary channel cleared for alliance \`${allianceId}\`.`);
    return;
  }
}

export default { data, execute };
