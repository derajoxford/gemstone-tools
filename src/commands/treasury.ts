// src/commands/treasury.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, Colors } from 'discord.js';
import { prisma } from '../db';
import { getTreasury } from '../utils/treasury';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show alliance treasury balances')
  .addStringOption(opt =>
    opt.setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const guildId = interaction.guildId || undefined;
    const arg = interaction.options.getString('alliance') || undefined;

    // resolve alliance
    let alliance: { id: number; name: string | null } | null = null;
    if (arg) {
      const asNum = Number(arg);
      if (Number.isInteger(asNum)) alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      if (!alliance) alliance = await prisma.alliance.findFirst({ where: { name: { contains: arg, mode: 'insensitive' } } });
    } else if (guildId) {
      alliance = await prisma.alliance.findFirst({ where: { guildId } });
    }
    if (!alliance) return interaction.reply({ content: 'Alliance not found for this server. Run /setup_alliance.', ephemeral: true });

    const balances = await getTreasury(prisma, alliance.id);
    const lines = Object.entries(balances)
      .filter(([, v]) => (Number(v) || 0) !== 0)
      .map(([k, v]) => `• **${k}**: ${Number(v).toLocaleString()}`);

    const embed = new EmbedBuilder()
      .setTitle(`🏦 Alliance Treasury — ${alliance.name ?? `#${alliance.id}`}`)
      .setDescription(lines.length ? lines.join('\n') : '_No balances recorded yet_')
      .setColor(Colors.Blurple);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err: any) {
    return interaction.reply({ content: 'Error: ' + (err?.message || String(err)), ephemeral: true });
  }
}

export default { data, execute };
