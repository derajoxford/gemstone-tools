// src/commands/treasury_add.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';

const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

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
    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const allianceArg = interaction.options.getString('alliance') || undefined;

    if (!RESOURCES.includes(resource as any)) {
      return interaction.reply({ content: 'Unknown resource.', ephemeral: true });
    }
    if (!(Number.isFinite(amount) && amount > 0)) {
      return interaction.reply({ content: 'Amount must be a positive number.', ephemeral: true });
    }

    // Resolve alliance (by server, id, or name)
    let alliance = null as null | { id: number; name: string | null };
    if (allianceArg) {
      const asNum = Number(allianceArg);
      if (Number.isInteger(asNum)) {
        alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      }
      if (!alliance) {
        alliance = await prisma.alliance.findFirst({
          where: { name: { contains: allianceArg, mode: 'insensitive' } },
        });
      }
    } else if (interaction.guildId) {
      alliance = await prisma.alliance.findFirst({ where: { guildId: interaction.guildId } });
    }

    if (!alliance) {
      return interaction.reply({ content: 'Alliance not found. Use /setup_alliance or pass an alliance.', ephemeral: true });
    }

    // Ensure treasury row, then increment chosen resource
    await prisma.allianceTreasury.upsert({
      where: { allianceId: alliance.id },
      update: { [resource]: { increment: amount } as any },
      create: { allianceId: alliance.id, balances: {}, [resource]: amount } as any,
    });

    return interaction.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${alliance.name ?? `#${alliance.id}`}**.`,
      ephemeral: true,
    });
  } catch (err) {
    return interaction.reply({ content: `Error: ${String(err)}`, ephemeral: true });
  }
}

export default { data, execute };
