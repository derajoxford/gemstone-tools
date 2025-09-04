// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { RES_EMOJI, ORDER } from '../lib/emojis.js';

const prisma = new PrismaClient();

/**
 * Required options MUST be declared before optional ones.
 * Order here: resource (required) -> amount (required) -> op (optional).
 */
export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Adjust the alliance-wide treasury (add or subtract).')
  .addStringOption(o =>
    o
      .setName('resource')
      .setDescription('Resource to adjust')
      .setRequired(true)
      .addChoices(
        ...(ORDER as string[]).map((r: string) => ({ name: r, value: r }))
      )
  )
  .addNumberOption(o =>
    o
      .setName('amount')
      .setDescription('Amount (use positive numbers)')
      .setRequired(true)
  )
  .addStringOption(o =>
    o
      .setName('op')
      .setDescription('Add or subtract')
      .setRequired(false)
      .addChoices({ name: 'add', value: 'add' }, { name: 'subtract', value: 'subtract' })
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  // Require Manage Guild just like data.defaultMemberPermissions indicates.
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.editReply('You lack permission to use this command.');
  }

  const alliance = await prisma.alliance.findFirst({
    where: { guildId: i.guildId ?? '' },
  });
  if (!alliance) {
    return i.editReply('No alliance linked here. Run **/setup_alliance** first.');
  }

  const resource = i.options.getString('resource', true);
  const amount = i.options.getNumber('amount', true)!;
  const op = (i.options.getString('op') as 'add' | 'subtract' | null) ?? 'add';

  if (!(ORDER as string[]).includes(resource)) {
    return i.editReply(`Unknown resource: \`${resource}\`.`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return i.editReply('Amount must be a positive number.');
  }

  const delta = op === 'subtract' ? -amount : amount;

  // Load row and update balances JSON
  const row = await prisma.allianceTreasury.findUnique({
    where: { allianceId: alliance.id },
  });
  const balances: Record<string, number> = { ...(row?.balances as any || {}) };

  const before = Number(balances[resource] || 0);
  const after = Math.max(0, before + delta); // never below zero
  balances[resource] = after;

  await prisma.allianceTreasury.upsert({
    where: { allianceId: alliance.id },
    update: { balances },
    create: { allianceId: alliance.id, balances },
  });

  const emoji = RES_EMOJI[resource as keyof typeof RES_EMOJI] ?? '';
  const sign = delta >= 0 ? '+' : '';
  const embed = new EmbedBuilder()
    .setTitle('🏦 Alliance Treasury Updated')
    .setDescription(
      `${emoji} **${resource}**: ${before.toLocaleString()} → ${after.toLocaleString()} ` +
      `(${sign}${delta.toLocaleString()})`
    )
    .setFooter({ text: `Alliance #${alliance.id}` })
    .setColor(delta >= 0 ? Colors.Green : Colors.Red);

  return i.editReply({ embeds: [embed] });
}
