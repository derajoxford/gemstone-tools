import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';
import { RESOURCES, addToTreasury } from '../utils/treasury';

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
    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const arg = interaction.options.getString('alliance') ?? undefined;
    // const note = interaction.options.getString('note') ?? undefined; // reserved for future ledger

    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({ content: 'Amount must be a positive number.', flags: 64 });
    }

    const alliance = await resolveAlliance(interaction, arg);
    if (!alliance) {
      return interaction.reply({
        content: 'Alliance not found for this server. Use /setup_alliance first or pass an alliance.',
        flags: 64,
      });
    }

    await addToTreasury(prisma, alliance.id, { [resource]: amount });

    return interaction.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${alliance.name ?? `#${alliance.id}`}**.`,
      flags: 64,
    });
  } catch (err) {
    return interaction.reply({ content: 'Error: ' + String(err), flags: 64 });
  }
}

export default { data, execute };
