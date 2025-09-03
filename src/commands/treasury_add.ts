// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { prisma } from '../db';

const RESOURCES = [
  'money',
  'coal',
  'oil',
  'uranium',
  'iron',
  'bauxite',
  'lead',
  'gasoline',
  'munitions',
  'steel',
  'aluminum',
  'food',
] as const;

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription(
    'Add a resource amount to an alliance treasury (manual adjustment)',
  )
  .addStringOption((opt) =>
    opt
      .setName('resource')
      .setDescription('Resource to add')
      .setRequired(true)
      .addChoices(
        ...RESOURCES.map((r) => ({ name: r, value: r })),
      ),
  )
  .addNumberOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Amount to add (positive)')
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('alliance')
      .setDescription(
        'Alliance (ID or name). If omitted, uses this server’s alliance.',
      )
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt.setName('note').setDescription('Optional note for context').setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const guildId = interaction.guildId ?? undefined;
    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const argAlliance = interaction.options.getString('alliance') ?? undefined;

    if (!RESOURCES.includes(resource as any)) {
      return interaction.reply({ content: 'Unknown resource.', ephemeral: true });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({
        content: 'Amount must be a positive number.',
        ephemeral: true,
      });
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

    // Upsert row and mutate balances blob
    const row = await prisma.allianceTreasury.upsert({
      where: { allianceId: alliance.id },
      update: {},
      create: { allianceId: alliance.id, balances: {} },
    });

    const balances = (row.balances as Record<string, number>) || {};
    balances[resource] = (Number(balances[resource]) || 0) + Number(amount);

    await prisma.allianceTreasury.update({
      where: { allianceId: alliance.id },
      data: { balances },
    });

    return interaction.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${
        alliance.name ?? `#${alliance.id}`
      }**.`,
      ephemeral: true,
    });
  } catch (err) {
    return interaction.reply({
      content: `Error: ${String(err)}`,
      ephemeral: true,
    });
  }
}

export default { data, execute };
