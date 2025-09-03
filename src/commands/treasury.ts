// src/commands/treasury.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { prisma } from '../db';

export const data = new SlashCommandBuilder()
  .setName('treasury')
  .setDescription('Show alliance treasury balances')
  .addStringOption((opt) =>
    opt
      .setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const guildId = interaction.guildId ?? undefined;
    const arg = interaction.options.getString('alliance') ?? undefined;

    // Resolve alliance
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
    } else if (guildId) {
      alliance = await prisma.alliance.findFirst({ where: { guildId } });
    }

    if (!alliance) {
      return interaction.reply({
        content:
          'Alliance not found. Provide an ID or name, or link this server with **/setup_alliance**.',
        ephemeral: true,
      });
    }

    // Read balances blob
    const t = await prisma.allianceTreasury.findUnique({
      where: { allianceId: alliance.id },
    });
    const balances = (t?.balances as Record<string, number>) ?? {};
    const nonzero = Object.entries(balances).filter(
      ([, v]) => (Number(v) || 0) !== 0,
    );

    const desc =
      nonzero.length > 0
        ? nonzero
            .map(([k, v]) => `• **${k}**: ${Number(v).toLocaleString()}`)
            .join('\n')
        : '_No balances recorded yet_';

    const embed = new EmbedBuilder()
      .setTitle(`Alliance Treasury — ${alliance.name ?? `#${alliance.id}`}`)
      .setDescription(desc);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    return interaction.reply({
      content: `Error: ${String(err)}`,
      ephemeral: true,
    });
  }
}

export default { data, execute };
