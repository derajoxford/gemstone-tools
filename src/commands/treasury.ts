// src/commands/treasury.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import { prisma } from '../db';
import { ORDER, RES_EMOJI } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show alliance treasury balances')
  .addStringOption(o =>
    o
      .setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false)
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const arg = i.options.getString('alliance');
  let alliance:
    | { id: number; name: string | null }
    | null = null;

  if (arg) {
    // Try numeric ID first
    const asId = Number(arg);
    if (Number.isFinite(asId)) {
      alliance = await prisma.alliance.findUnique({ where: { id: asId } });
    }
    // Fallback: exact name match
    if (!alliance) {
      alliance = await prisma.alliance.findFirst({ where: { name: arg } });
    }
  } else if (i.guildId) {
    alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
  }

  if (!alliance) {
    return i.editReply(
      'No alliance found. Run **/setup_alliance** first or pass an alliance id/name.'
    );
  }

  // Read balances directly from the AllianceTreasury table
  const treas = await prisma.allianceTreasury.findUnique({
    where: { allianceId: alliance.id },
  });

  const balances = (treas?.balances as Record<string, number>) || {};

  const lines: string[] = [];
  for (const k of ORDER) {
    const v = Number(balances[k] || 0);
    if (v) {
      const emoji = RES_EMOJI[k as keyof typeof RES_EMOJI] ?? '';
      lines.push(`${emoji} **${k}**: ${v.toLocaleString()}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`🏛️ Alliance Treasury — #${alliance.id}${alliance.name ? ` (${alliance.name})` : ''}`)
    .setDescription(lines.length ? lines.join('\n') : 'No balances recorded yet.')
    .setColor(Colors.Blurple)
    .setFooter({ text: 'Use /treasury_add to adjust.' });

  await i.editReply({ embeds: [embed] });
}
