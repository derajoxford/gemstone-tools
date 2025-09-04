// src/commands/treasury_bulk.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { RES_EMOJI, ORDER } from '../lib/emojis.js';

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName('treasury_bulk')
  .setDescription('Adjust multiple treasury resources in one go.')
  .addStringOption(o =>
    o
      .setName('op')
      .setDescription('add or subtract')
      .setRequired(true)
      .addChoices({ name: 'add', value: 'add' }, { name: 'subtract', value: 'subtract' })
  )
  .addStringOption(o =>
    o
      .setName('changes')
      .setDescription('Comma-separated pairs, e.g. "money:100000, steel:250, gasoline:10"')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const alliance = await prisma.alliance.findFirst({
    where: { guildId: i.guildId ?? '' },
  });
  if (!alliance) {
    return i.editReply('No alliance linked here. Run **/setup_alliance** first.');
  }

  const op = i.options.getString('op', true) as 'add' | 'subtract';
  const raw = i.options.getString('changes', true);

  const allowed = new Set<string>(ORDER as string[]);
  const deltas: Record<string, number> = {};

  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z_]+)\s*[:=]\s*(-?\d+(?:\.\d+)?)$/i);
    if (!m) {
      return i.editReply(`Couldn't parse \`${part}\`. Use \`resource:amount\` (comma-separated).`);
    }
    const key = m[1].toLowerCase();
    if (!allowed.has(key)) {
      return i.editReply(`Unknown resource: \`${key}\`.`);
    }
    const amt = Number(m[2]);
    if (!Number.isFinite(amt) || amt <= 0) {
      return i.editReply(`Invalid amount for \`${key}\`: \`${m[2]}\`.`);
    }
    deltas[key] = (deltas[key] || 0) + (op === 'subtract' ? -amt : amt);
  }

  if (!Object.keys(deltas).length) {
    return i.editReply('No valid changes provided.');
  }

  const row = await prisma.allianceTreasury.findUnique({
    where: { allianceId: alliance.id },
  });
  const balances: Record<string, number> = { ...(row?.balances as any || {}) };

  const lines: string[] = [];
  for (const [k, delta] of Object.entries(deltas)) {
    const before = Number(balances[k] || 0);
    const after = Math.max(0, before + delta);
    balances[k] = after;
    const prettyDelta = `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`;
    lines.push(`${RES_EMOJI[k as any] ?? ''} **${k}**: ${before.toLocaleString()} → ${after.toLocaleString()} (${prettyDelta})`);
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId: alliance.id },
    update: { balances },
    create: { allianceId: alliance.id, balances },
  });

  const embed = new EmbedBuilder()
    .setTitle('🏦 Alliance Treasury — Bulk Update')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Alliance #${alliance.id} • ${op}` })
    .setColor(op === 'add' ? Colors.Green : Colors.Red);

  return i.editReply({ embeds: [embed] });
}
