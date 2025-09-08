// src/commands/treasury_bulk.ts
import {
  SlashCommandBuilder, Colors, EmbedBuilder,
  PermissionFlagsBits, ChatInputCommandInteraction
} from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { RES_EMOJI, ORDER } from '../lib/emojis.js';
import { addToTreasury, getTreasury } from '../utils/treasury';

const prisma = new PrismaClient();
const RES_SET = new Set(ORDER);

function fmtAdjLine(k: string, v: number) {
  const e = (RES_EMOJI as any)[k] || '';
  const sign = v >= 0 ? '+' : '−';
  return `${e} **${k}**: ${sign}${Math.abs(v).toLocaleString()}`;
}

export const data = new SlashCommandBuilder()
  .setName('treasury_bulk')
  .setDescription('Adjust multiple resources in the alliance treasury using JSON')
  .addStringOption(o =>
    o
      .setName('payload')
      .setDescription('e.g. {"money": 1000000, "steel": 500, "munitions": -10}')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  // Permissions guard
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: 'You need Manage Server to use this.', ephemeral: true });
  }

  // Alliance for this guild
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) {
    return i.reply({ content: 'This server is not linked yet. Run /setup_alliance first.', ephemeral: true });
  }

  // Parse JSON payload
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(i.options.getString('payload', true));
  } catch {
    return i.reply({ content: 'Invalid JSON. Example: `{"money":1000000,"steel":500,"munitions":-10}`', ephemeral: true });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return i.reply({ content: 'Payload must be a JSON object of resource→amount.', ephemeral: true });
  }

  // Collect adjustments
  const deltas: Array<[string, number]> = [];
  const unknown: string[] = [];
  const nonNums: string[] = [];

  for (const [k, v] of Object.entries(body)) {
    if (!RES_SET.has(k)) { unknown.push(k); continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) { nonNums.push(k); continue; }
    deltas.push([k, n]); // positive = add, negative = subtract
  }

  if (!deltas.length) {
    const warn = [
      unknown.length ? `Unknown keys: ${unknown.join(', ')}` : '',
      nonNums.length ? `Invalid/zero amounts: ${nonNums.join(', ')}` : ''
    ].filter(Boolean).join('\n');
    return i.reply({ content: warn || 'Nothing to change.', ephemeral: true });
  }

  // Apply adjustments
  for (const [k, delta] of deltas) {
    await addToTreasury(prisma, alliance.id, k as any, delta); // prisma-first signature
  }

  // Show results
  const t = await getTreasury(prisma, alliance.id); // prisma-first signature
  const adjLines = deltas.map(([k, v]) => fmtAdjLine(k, v)).join(' · ');

  const totals = ORDER
    .map((k) => {
      const v = Number((t as any)[k] || 0);
      return v ? `${(RES_EMOJI as any)[k] || ''} **${k}**: ${v.toLocaleString()}` : undefined;
    })
    .filter(Boolean)
    .join(' · ') || '—';

  const embed = new EmbedBuilder()
    .setTitle(`🏦 Alliance Treasury — #${alliance.id}`)
    .addFields(
      { name: 'Adjustments Applied', value: adjLines, inline: false },
      { name: 'New Totals', value: totals, inline: false },
    )
    .setColor(Colors.Blurple);

  return i.reply({ embeds: [embed], ephemeral: true });
}
