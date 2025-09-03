import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '../db';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show alliance treasury balances')
  .addStringOption(o =>
    o.setName('alliance')
     .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
     .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const arg = interaction.options.getString('alliance') ?? undefined;

    let alliance: { id: number; name: string | null } | null = null;
    if (arg) {
      const asNum = Number(arg);
      if (Number.isInteger(asNum)) {
        alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      }
      if (!alliance) {
        alliance = await prisma.alliance.findFirst({
          where: { name: { contains: arg, mode: 'insensitive' } },
        });
      }
    } else {
      if (!interaction.guildId) return interaction.editReply('Use this in a server, or specify an alliance.');
      alliance = await prisma.alliance.findFirst({ where: { guildId: interaction.guildId } });
    }

    if (!alliance) return interaction.editReply('Alliance not found here. Use /setup_alliance first.');

    const t = await prisma.allianceTreasury.findUnique({ where: { allianceId: alliance.id } });
    const balances = (t?.balances as Record<string, number>) ?? {};
    const pairs = Object.entries(balances).filter(([, v]) => (Number(v) || 0) !== 0);

    const desc = pairs.length
      ? pairs.map(([k, v]) => '• **' + k + '**: ' + Number(v).toLocaleString()).join('\n')
      : '_No balances recorded yet_';

    const title = 'Alliance Treasury — ' + (alliance.name ?? ('#' + alliance.id));
    const embed = new EmbedBuilder().setTitle(title).setDescription(desc);

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (interaction.deferred || interaction.replied)
      ? interaction.editReply('Error: ' + msg)
      : interaction.reply({ content: 'Error: ' + msg, ephemeral: true });
  }
}

export default { data, execute };
