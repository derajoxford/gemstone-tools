// src/commands/treasury_add.ts
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
    const arg = interaction.options.getString('alliance') || undefined;

    if (!RESOURCES.includes(resource as any)) {
      return interaction.editReply({ content: 'Unknown resource.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return interaction.editReply({ content: 'Amount must be a positive number.' });
    }

    const guildId = interaction.guildId || undefined;
    let alliance: { id: number; name: string | null } | null = null;
    if (arg) {
      const asNum = Number(arg);
      if (Number.isInteger(asNum)) alliance = await prisma.alliance.findUnique({ where: { id: asNum } });
      if (!alliance) alliance = await prisma.alliance.findFirst({ where: { name: { contains: arg, mode: 'insensitive' } } });
    } else if (guildId) {
      alliance = await prisma.alliance.findFirst({ where: { guildId } });
    }
    if (!alliance) return interaction.editReply({ content: 'Alliance not found for this server. Run /setup_alliance.' });

    const delta: Record<string, number> = { [resource]: amount };
    const balances = await addToTreasury(prisma, alliance.id, delta);

    const label = alliance.name ?? `#${alliance.id}`;
    const newAmt = Number(balances[resource] || 0);

    return interaction.editReply(
      `Added **${amount.toLocaleString()}** **${resource}** to **${label}**.\n` +
      `New **${resource}** balance: **${newAmt.toLocaleString()}**`
    );
  } catch (err: any) {
    return interaction.editReply({ content: 'Error: ' + (err?.message || String(err)) });
  }
}

export default { data, execute };
