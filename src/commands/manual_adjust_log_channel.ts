import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType } from "discord.js";
import { setGuildSetting } from "../utils/settings.js";

export const data = new SlashCommandBuilder()
  .setName("manual_adjust_log_channel")
  .setDescription("Set the channel where manual safekeeping adjustments are logged.")
  .addChannelOption(o =>
    o.setName("channel")
     .setDescription("Pick a text channel for manual adjustment logs")
     .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
     .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  if (!i.guild) return i.editReply("Run this in a server.");

  const ch = i.options.getChannel("channel", true);
  await setGuildSetting(i.guild.id, "manual_adjust_log_channel_id", ch.id);

  return i.editReply(`Manual adjustments will now be logged in <#${ch.id}>. (Note: temporary in-memory setting.)`);
}

export default { data, execute };
