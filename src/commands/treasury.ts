// src/commands/treasury.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from 'discord.js';
import { prisma } from '../db';
import { getTreasury } from '../utils/treasury';
import { ORDER, RES_EMOJI } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show the alliance-wide treasury')
  // change/remove this line if you want everyone to see it:
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  const guildId = i.guildId ?? '';
  const alliance = await prisma.alliance.findFirst({ where: { guildId } });
  if (!alliance) {
    return i.reply({
      content: 'This server is not linked yet. Run **/setup_alliance** first.',
      ephemeral: true,
    });
  }

  const balances = await getTreasury(prisma, alliance.id); // returns Record<string, number>

  // Build pretty inline fields (skip zeros)
  const fields = ORDER
    .map((k) => {
      const v = Number((balances as any)[k] || 0);
      if (!v) return null;
      const emoji = (RES_EMOJI as any)[k] ?? '';
      return { name: `${emoji} ${k}`, value: v.toLocaleString(), inline: true };
    })
    .filter(Boolean) as { name: string; value: string; inline: true }[];

  const titleName = alliance.name ? `${alliance.name} — #${alliance.id}` : `Alliance Treasury — #${alliance.id}`;

  const emb = new EmbedBuilder()
    .setTitle(titleName)
    .setColor(Colors.Blurple)
    .setDescription(fields.length ? '' : '— none —')
    .addFields(fields);

  await i.reply({ embeds: [emb], ephemeral: true });
}
