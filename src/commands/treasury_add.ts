import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';
import { addToTreasury, RESOURCES } from '../utils/treasury';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Add a resource amount to an alliance treasury (manual adjustment)')
  .addStringOption(o =>
    o.setName('resource')
     .setDescription('Resource to add')
     .setRequired(true)
     .addChoices(...(RESOURCES as readonly string[]).map(r => ({ name: r, value: r })))
  )
  .addNumberOption(o =>
    o.setName('amount')
     .setDescription('Amount to add (positive)')
     .setRequired(true)
  )
  .addStringOption(o =>
    o.setName('alliance')
     .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
     .setRequired(false)
  )
  .addStringOption(o =>
    o.setName('note')
     .setDescription('Optional note for context')
     .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const resource = interaction.options.getString('resource', true) as (typeof RESOURCES)[number];
    const amount = interaction.options.getNumber('amount', true);
    const arg = interaction.options.getString('alliance') ?? undefined;

    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({ content: 'Amount must be a positive number.', ephemeral: true });
    }

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

    await addToTreasury(prisma, alliance.id, { [resource]: amount });

    const label = alliance.name ?? `#${alliance.id}`;
    return interaction.reply({
      content: `Added ${amount.toLocaleString()} ${resource} to ${label}.`,
      ephemeral: true,
    });
  } catch (err) {
    return interaction.reply({ content: `Error: ${String(err)}`, ephemeral: true });
  }
}

export default { data, execute };
