import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';

const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.TEST_GUILD_ID!;
if (!token || !appId || !guildId) {
  console.error('Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or TEST_GUILD_ID in env.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('setup_alliance')
    .setDescription('Link this Discord to a PnW Alliance banking setup')
    .addIntegerOption(o=>o.setName('alliance_id').setDescription('PnW Alliance ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('set_review_channel')
    .setDescription('Set the channel for withdrawal approvals (buttons)')
    .addChannelOption(o =>
      o.setName('channel')
       .setDescription('Channel to post approvals (defaults to current)')
       .addChannelTypes(ChannelType.GuildText)
       .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('link_nation')
    .setDescription('Link your Discord to your PnW nation for safekeeping')
    .addIntegerOption(o=>o.setName('nation_id').setDescription('Your nation id').setRequired(true))
    .addStringOption(o=>o.setName('nation_name').setDescription('Your nation name').setRequired(true)),

  new SlashCommandBuilder().setName('balance')
    .setDescription('Show your safekeeping balance'),

  new SlashCommandBuilder().setName('withdraw')
    .setDescription('Request a withdrawal via modal (only shows what you have)'),

  new SlashCommandBuilder().setName('withdraw_json')
    .setDescription('Request a withdrawal using JSON (advanced)')
    .addStringOption(o=>o.setName('payload').setDescription('{"money":1000000,"steel":500}').setRequired(true)),

  new SlashCommandBuilder().setName('withdraw_list')
    .setDescription('List recent withdrawal requests (default: PENDING)')
    .addStringOption(o =>
      o.setName('status')
       .setDescription('Filter by status')
       .addChoices(
         { name: 'PENDING', value: 'PENDING' },
         { name: 'APPROVED', value: 'APPROVED' },
         { name: 'REJECTED', value: 'REJECTED' },
         { name: 'PAID', value: 'PAID' },
         { name: 'CANCELED', value: 'CANCELED' }
       )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('withdraw_set')
    .setDescription('Set the status of a withdrawal request')
    .addStringOption(o=>o.setName('id').setDescription('Request ID (UUID)').setRequired(true))
    .addStringOption(o =>
      o.setName('status')
       .setDescription('New status')
       .setRequired(true)
       .addChoices(
         { name: 'APPROVED', value: 'APPROVED' },
         { name: 'REJECTED', value: 'REJECTED' },
         { name: 'PAID', value: 'PAID' },
         { name: 'CANCELED', value: 'CANCELED' }
       )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log('✅ Guild slash commands registered:', guildId);
})();
