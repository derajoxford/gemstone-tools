// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import { prisma } from '../db';
import { addToTreasury } from '../utils/treasury';
import { ORDER as RESOURCES, RES_EMOJI } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Adjust the alliance-wide treasury (add or subtract).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o =>
    o
      .setName('resource')
      .setDescription('Resource to adjust')
      .setRequired(true)
      .addChoices(...RESOURCES.map((r: string) => ({ name: r, value: r })))
  )
  .addStringOption(o =>
    o
      .setName('op')
      .setDescription('Add or subtract')
      .setRequired(false)
      .addChoices({ name: 'add', value: 'add' }, { name: 'subtract', value: 'subtract' })
  )
  .addNumberOption(o =>
    o
      .setName('amount')
      .setDescription('Amount (use positive numbers)')
      .setRequired(true)
  );

export async function execute(i: ChatInputCommandInteraction) {
  const guildId = i.guildId ?? '';
  const alliance = await prisma.alliance.findFirst({ where: { guildId } });
  if (!alliance) {
    return i.reply({
      content: 'This server is not linked yet. Run **/setup_alliance** first.',
      ephemeral: true,
    });
  }

  const resource = i.options.getString('resource', true);
  const op = i.options.getString('op') ?? 'add';
  const amount = i.options.getNumber('amount', true);

  if (!RESOURCES.includes(resource)) {
    return i.reply({ content: `Unknown resource: ${resource}`, ephemeral: true });
  }
  if (amount <= 0) {
    return i.reply({ content: 'Amount must be a positive number.', ephemeral: true });
  }

  const signed = op === 'subtract' ? -amount : amount;

  const updated = await addToTreasury(prisma, alliance.id, { [resource]: signed });
  const newVal = Number(updated[resource] || 0);

  const emoji = (RES_EMOJI as any)[resource] ?? '';
  const emb = new EmbedBuilder()
    .setTitle('🏦 Alliance Treasury Updated')
    .setColor(signed >= 0 ? Colors.Green : Colors.Red)
    .addFields(
      {
        name: 'Change',
        value: `${emoji} **${resource}**: ${signed >= 0 ? '+' : ''}${signed.toLocaleString()}`,
        inline: false,
      },
      {
        name: 'New total',
        value: `${emoji} **${resource}**: ${newVal.toLocaleString()}`,
        inline: false,
      }
    )
    .setFooter({ text: `Alliance #${alliance.id}` });

  await i.reply({ embeds: [emb], ephemeral: true });
}
