// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from 'discord.js';
import { prisma } from '../db';
import { ORDER, RES_EMOJI } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Adjust the alliance-wide treasury (add or subtract).')
  // REQUIRED options first (fixes Discord 50035)
  .addStringOption(o =>
    o
      .setName('resource')
      .setDescription('Resource to adjust')
      .setRequired(true)
      .addChoices(...ORDER.map(r => ({ name: r, value: r })))
  )
  .addNumberOption(o =>
    o
      .setName('amount')
      .setDescription('Amount (use positive numbers)')
      .setRequired(true)
  )
  // Optional goes AFTER required
  .addStringOption(o =>
    o
      .setName('op')
      .setDescription('Add or subtract')
      .addChoices({ name: 'add', value: 'add' }, { name: 'subtract', value: 'subtract' })
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  if (!i.guildId) {
    return i.editReply('Guild only.');
  }
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
  if (!alliance) {
    return i.editReply('This server is not linked yet. Run **/setup_alliance** first.');
  }

  const resource = i.options.getString('resource', true);
  const amount = Number(i.options.getNumber('amount', true));
  const op = (i.options.getString('op') || 'add') as 'add' | 'subtract';

  if (!ORDER.includes(resource as any)) {
    return i.editReply('Unknown resource.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return i.editReply('Amount must be a positive number.');
  }

  // Load current balances
  const treas = await prisma.allianceTreasury.findUnique({
    where: { allianceId: alliance.id },
  });
  const balances = (treas?.balances as Record<string, number>) || {};

  const current = Number(balances[resource] || 0);
  const delta = op === 'subtract' ? -amount : amount;
  const nextVal = current + delta;

  if (nextVal < 0) {
    return i.editReply(
      `Cannot subtract ${amount.toLocaleString()} ${resource}; only ${current.toLocaleString()} available.`
    );
  }

  const next = { ...balances, [resource]: nextVal };

  await prisma.allianceTreasury.upsert({
    where: { allianceId: alliance.id },
    update: { balances: next },
    create: { allianceId: alliance.id, balances: next },
  });

  // Pretty embed, like safekeeping
  const lines = ORDER.map(k => {
    const v = Number(next[k] || 0);
    return v ? `${RES_EMOJI[k as any] ?? ''} **${k}**: ${v.toLocaleString()}` : undefined;
  })
    .filter(Boolean)
    .join('\n') || '—';

  const embed = new EmbedBuilder()
    .setTitle(`🏛️ Alliance Treasury — #${alliance.id}${alliance.name ? ` (${alliance.name})` : ''}`)
    .setDescription(lines)
    .setColor(Colors.Blurple)
    .setFooter({ text: 'Use /treasury to view. Use /treasury_add again to adjust.' });

  const verb = op === 'subtract' ? 'decreased' : 'increased';
  await i.editReply({
    content: `✅ **${resource}** ${verb} by **${amount}**. New total: **${nextVal.toLocaleString()}**`,
    embeds: [embed],
  });
}
