import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { setSetting } from '../utils/settings.js';

export const data = new SlashCommandBuilder()
  .setName('set_log_channel')
  .setDescription('Set the bank log channel for this server')
  .addChannelOption(opt =>
    opt
      .setName('channel')
      .setDescription('The text channel to post bank logs in')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guildId) {
    await interaction.editReply('This command must be used in a server.');
    return;
  }
  const ch = interaction.options.getChannel('channel', true);
  await setSetting(interaction.guildId, 'bankLogChannelId', ch.id);
  await interaction.editReply(`✅ Bank log channel set to <#${ch.id}>`);
}
