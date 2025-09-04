// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { prisma } from '../db';
import { addToTreasury } from '../utils/treasury';
import { ORDER as RESOURCES } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Add to the alliance-wide treasury (positive or negative).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(o =>
    o
      .setName('resource')
      .setDescription('Resource to adjust')
      .setRequired(true)
      .addChoices(...RESOURCES.map((r: string) => ({ name: r, value: r })))
  )
  .addNumberOption(o =>
    o
      .setName('amount')
      .setDescription('Amount to add (use negative to subtract)')
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
  const amount = i.options.getNumber('amount', true);

  // Validate resource just in case
  if (!RESOURCES.includes(resource)) {
    return i.reply({ content: `Unknown resource: ${resource}`, ephemeral: true });
  }

  // Apply the delta
  const updated = await addToTreasury(prisma, alliance.id, { [resource]: amount });

  const newVal = Number(updated[resource] || 0);
  await i.reply({
    content: `✅ **${resource}** adjusted by ${amount.toLocaleString()}. New total: **${newVal.toLocaleString()}**`,
    ephemeral: true,
  });
}
