import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { prisma } from '../db';
import { addToTreasury, RESOURCES } from '../utils/treasury';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Add a resource amount to an alliance treasury (manual adjustment)')
  .addStringOption(opt =>
    opt
      .setName('resource')
      .setDescription('Resource to add')
      .setRequired(true)
      .addChoices(...RESOURCES.map(r => ({ name: r, value: r })))
  )
  .addNumberOption(opt =>
    opt
      .setName('amount')
      .setDescription('Amount to add (positive)')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt
      .setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt
      .setName('note')
      .setDescription('Optional note for context')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const guildId = interaction.guildId;
    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const argAlliance = interaction.options.getString('alliance') ?? undefined;
    const note = interaction.options.getString('note') ?? undefined;

    if (!RESOURCES.includes(resource as any)) {
      return interaction.reply({ content: `Unknown resource: ${resource}`, ephemeral: true });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({ content: 'Amount must be a positive number.', ephemeral: true });
    }

    // Resolve alliance
    let alliance: { id: number; name: string | null } | null = null;
    if (argAlliance) {
      const asNum = Number(argAlliance);
      if (Number.isInteger(asNum)) {
        alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      }
      if (!alliance) {
        alliance = await prisma.alliance.findFirst({
          where: { name: { contains: argAlliance, mode: 'insensitive' } },
          select: { id: true, name: true },
        });
      }
    } else if (guildId) {
      alliance = await prisma.alliance.findFirst({
        where: { guildId },
        select: { id: true, name: true },
      });
    }

    if (!alliance) {
      return interaction.reply({
        content: 'Alliance not found. Provide an ID or name, or link this server with /setup_alliance.',
        ephemeral: true,
      });
    }

    // Apply adjustment
    await addToTreasury(prisma, alliance.id, { [resource]: amount });

    // Simple confirmation (include optional note)
    const label = alliance.name ?? `#${alliance.id}`;
    await interaction.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${label}**${note ? ` — ${note}` : ''}.`,
      ephemeral: true,
    });
  } catch (err) {
    return interaction.reply({ content: `Error: ${String(err)}`, ephemeral: true });
  }
}

export default { data, execute };
