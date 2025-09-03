import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '../db';
import { RESOURCES } from '../utils/treasury';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show alliance treasury balances')
  .addStringOption(o =>
    o.setName('alliance')
     .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
     .setRequired(false)
  );

async function resolveAlliance(interaction: ChatInputCommandInteraction, arg?: string) {
  if (arg) {
    const asNum = Number(arg);
    if (Number.isInteger(asNum)) {
      const a = await prisma.alliance.findUnique({ where: { id: asNum } });
      if (a) return a;
    }
    const a2 = await prisma.alliance.findFirst({
      where: { name: { contains: arg, mode: 'insensitive' } },
    });
    if (a2) return a2;
  }
  if (!interaction.guildId) return null;
  return prisma.alliance.findFirst({ where: { guildId: interaction.guildId } });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const arg = interaction.options.getString('alliance') ?? undefined;
    const alliance = await resolveAlliance(interaction, arg);
    if (!alliance) {
      return interaction.reply({
        content: 'Alliance not found for this server. Use /setup_alliance first or pass an alliance.',
        flags: 64,
      });
    }

    const t = await prisma.allianceTreasury.findUnique({ where: { allianceId: alliance.id } });
    const balances = (t?.balances as Record<string, number>) ?? {};
    const nonzero = Object.entries(balances).filter(([,v]) => (Number(v)||0) !== 0);

    const ordered = nonzero.sort(([a],[b]) => {
      const ia = RESOURCES.indexOf(a as any); const ib = RESOURCES.indexOf(b as any);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    const desc = ordered.length
      ? ordered.map(([k,v]) => `• **${k}**: ${Number(v).toLocaleString()}`).join('\n')
      : '_No balances recorded yet._';

    const embed = new EmbedBuilder()
      .setTitle(`Alliance Treasury — ${alliance.name ?? `#${alliance.id}`}`)
      .setDescription(desc);

    return interaction.reply({ embeds: [embed], flags: 64 });
  } catch (err) {
    return interaction.reply({ content: `Error: ${String(err)}`, flags: 64 });
  }
}

export default { data, execute };
