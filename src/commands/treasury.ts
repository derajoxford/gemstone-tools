import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, Colors } from 'discord.js';
import { prisma } from '../db';
import { getTreasury, RESOURCES } from '../utils/treasury';

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
    const arg = interaction.options.getString('alliance') ?? undefined;

    // Resolve alliance by explicit arg OR by this guild
    let alliance: { id: number; name: string | null } | null = null;

    if (arg) {
      const asNum = Number(arg);
      if (Number.isInteger(asNum)) {
        alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      }
      if (!alliance) {
        alliance = await prisma.alliance.findFirst({
          where: { name: { contains: arg, mode: 'insensitive' } },
          select: { id: true, name: true },
        });
      }
    } else if (interaction.guildId) {
      alliance = await prisma.alliance.findFirst({
        where: { guildId: interaction.guildId },
        select: { id: true, name: true },
      });
    }

    if (!alliance) {
      return interaction.reply({ content: 'Alliance not found for this server. Use `/setup_alliance` or pass an ID/name.', ephemeral: true });
    }

    const balances = await getTreasury(prisma, alliance.id);
    const entries = (RESOURCES as readonly string[])
      .map(k => [k, Number((balances as any)[k] || 0)] as const)
      .filter(([, v]) => v !== 0);

    const desc = entries.length
      ? entries.map(([k, v]) => `• **${k}**: ${v.toLocaleString()}`).join('\n')
      : '_No balances recorded yet_';

    const embed = new EmbedBuilder()
      .setTitle(`Alliance Treasury — ${alliance.name ?? `#${alliance.id}`}`)
      .setDescription(desc)
      .setColor(Colors.Blurple);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    return interaction.reply({ content: `Error: ${String(err)}`, ephemeral: true });
  }
}

export default { data, execute };
