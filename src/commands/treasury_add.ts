// src/commands/treasury_add.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';
import { addToTreasury, RESOURCES } from '../utils/treasury';

export const data = new SlashCommandBuilder()
  .setName('treasury_add')
  .setDescription('Add a resource amount to an alliance treasury (manual adjustment)')
  .addStringOption(o =>
    o
      .setName('resource')
      .setDescription('Resource to add')
      .setRequired(true)
      .addChoices(...RESOURCES.map(r => ({ name: r, value: r })))
  )
  .addNumberOption(o =>
    o
      .setName('amount')
      .setDescription('Amount to add (positive)')
      .setRequired(true)
  )
  .addStringOption(o =>
    o
      .setName('alliance')
      .setDescription('Alliance (ID or name). If omitted, uses this server’s alliance.')
      .setRequired(false)
  )
  .addStringOption(o =>
    o
      .setName('note')
      .setDescription('Optional note for context')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const resource = interaction.options.getString('resource', true);
    const amount = interaction.options.getNumber('amount', true);
    const allianceArg = interaction.options.getString('alliance') ?? undefined;
    const note = interaction.options.getString('note') ?? undefined;

    if (!RESOURCES.includes(resource as any)) {
      return interaction.reply({ content: 'Unknown resource.', ephemeral: true });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.reply({ content: 'Amount must be a positive number.', ephemeral: true });
    }

    // Resolve alliance by id/name or by this guild's configured alliance
    let alliance: { id: number; name: string | null } | null = null;
    if (allianceArg) {
      const asNum = Number(allianceArg);
      if (Number.isInteger(asNum)) {
        alliance = await prisma.alliance.findUnique({ where: { id: asNum }, select: { id: true, name: true } });
      }
      if (!alliance) {
        alliance = await prisma.alliance.findFirst({
          where: { name: { contains: allianceArg, mode: 'insensitive' } },
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
      return interaction.reply({
        content: 'Alliance not found. Pass an ID/name or link this server with **/setup_alliance**.',
        ephemeral: true,
      });
    }

    await addToTreasury(prisma, alliance.id, { [resource]: amount });

    const label = alliance.name ?? `#${alliance.id}`;
    return interaction.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${label}**.` + (note ? `\n_note:_ ${note}` : ''),
      ephemeral: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { await interaction.reply({ content: 'Error: ' + msg, ephemeral: true }); } catch {}
  }
}

export default { data, execute };
