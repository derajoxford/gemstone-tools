import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';
import { addToTreasury, RESOURCES } from '../utils/treasury';

const resourceChoices = RESOURCES.map(r => ({ name: r, value: r }));

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Add a resource amount to an alliance treasury (manual adjustment)')
  .addStringOption(opt =>
    opt.setName('resource')
      .setDescription('Resource to add')
      .setRequired(true)
      .addChoices(...resourceChoices)
  )
  .addNumberOption(opt =>
    opt.setName('amount')
      .setDescription('Amount to add (positive)')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName('note')
      .setDescription('Optional note for context')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    await interaction.deferReply({ ephemeral: true });

    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const arg = interaction.options.getString('alliance') ?? undefined;

    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.editReply('Amount must be a positive number.');
    }

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

    if (!alliance) {
      return interaction.editReply('Alliance not found here. Use /setup_alliance or pass an alliance.');
    }

    await addToTreasury(prisma, alliance.id, { [resource]: amount });

    const who = alliance.name ?? ('#' + alliance.id);
    return interaction.editReply(`Added **${amount.toLocaleString()}** **${resource}** to **${who}**.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (interaction.deferred || interaction.replied)
      ? interaction.editReply(`Error: ${msg}`)
      : interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
  }
}

export default { data, execute };
