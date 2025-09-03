import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { logBankEvent } from '../utils/bankLog.js';

export const data = new SlashCommandBuilder()
  .setName('banklog_test')
  .setDescription('Emit a test bank log message')
  .addStringOption(o =>
    o.setName('account').setDescription('Account type').setRequired(true).addChoices(
      { name: 'ALLIANCE', value: 'ALLIANCE' },
      { name: 'SAFEKEEPING', value: 'SAFEKEEPING' },
    )
  )
  .addStringOption(o =>
    o.setName('kind').setDescription('Event kind').setRequired(true).addChoices(
      { name: 'DEPOSIT', value: 'DEPOSIT' },
      { name: 'WITHDRAW', value: 'WITHDRAW' },
      { name: 'TRANSFER', value: 'TRANSFER' },
      { name: 'ADJUST', value: 'ADJUST' },
    )
  )
  .addStringOption(o =>
    o.setName('amount').setDescription('Whole dollars').setRequired(true)
  )
  .addStringOption(o =>
    o.setName('note').setDescription('Optional note (use #ignore to test skip)')
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  if (!interaction.guild) {
    await interaction.editReply('Run this in a server.');
    return;
  }
  const account = interaction.options.getString('account', true) as 'ALLIANCE'|'SAFEKEEPING';
  const kind = interaction.options.getString('kind', true) as 'DEPOSIT'|'WITHDRAW'|'TRANSFER'|'ADJUST';
  const amountRaw = interaction.options.getString('amount', true);
  const note = interaction.options.getString('note') ?? undefined;

  if (!/^\d+$/.test(amountRaw)) {
    await interaction.editReply('Amount must be a whole number of dollars.');
    return;
  }

  await logBankEvent(interaction.guild, {
    account,
    kind,
    amount: BigInt(amountRaw),
    note,
    actorDiscordId: interaction.user.id,
  });

  await interaction.editReply('✅ Emitted (or ignored if #ignore + ALLIANCE DEPOSIT).');
}
