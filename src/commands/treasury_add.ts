// src/commands/treasury_add.ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { prisma } from '../db';

const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

type Resource = typeof RESOURCES[number];

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

export async function execute(i: ChatInputCommandInteraction) {
  try {
    const resource = i.options.getString('resource', true) as Resource;
    const amount = i.options.getNumber('amount', true) || 0;
    const allianceArg = i.options.getString('alliance') || undefined;
    const note = i.options.getString('note') || undefined;

    if (amount <= 0) {
      return i.reply({ content: 'Amount must be > 0.', ephemeral: true });
    }

    // Figure out which alliance
    let alliance: { id: number; name: string | null } | null = null;
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
      if (!alliance) {
        return i.reply({ content: `Alliance not found: ${allianceArg}`, ephemeral: true });
      }
    } else {
      alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
      if (!alliance) {
        return i.reply({ content: 'This server is not linked to an alliance. Run /setup_alliance first.', ephemeral: true });
      }
    }

    // Ensure treasury row exists, then update balances JSON
    const row = await prisma.allianceTreasury.upsert({
      where: { allianceId: alliance.id },
      update: {},
      create: { allianceId: alliance.id, balances: {} },
    });

    const balances = (row.balances as Record<string, number>) || {};
    const prev = Number(balances[resource] || 0);
    balances[resource] = prev + amount;

    await prisma.allianceTreasury.update({
      where: { allianceId: alliance.id },
      data: { balances },
    });

    const label = alliance.name ? alliance.name : `#${alliance.id}`;
    const noteLine = note ? ` Note: ${note}` : '';
    return i.reply({
      content: `Added **${amount.toLocaleString()}** **${resource}** to **${label}**.${noteLine}`,
      ephemeral: true,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    return i.reply({ content: 'Error: ' + msg, ephemeral: true });
  }
}

export default { data, execute };
