// src/commands/treasury_bulk.ts
import {
  SlashCommandBuilder, Colors, EmbedBuilder, PermissionFlagsBits,
  ChatInputCommandInteraction
} from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { RES_EMOJI, ORDER } from '../lib/emojis.js';
import { getAllianceByGuild } from '../utils/alliance.js'; // used by your other commands
import { addToTreasury, getAllianceTreasury } from '../utils/treasury';

const prisma = new PrismaClient();

const RES_SET = new Set(ORDER); // valid resource keys

function fmtAdjLine(k: string, v: number) {
  const e = (RES_EMOJI as any)[k] || '';
  const sign = v >= 0 ? '+' : '−';
  return `${e} **${k}**: ${sign}${Math.abs(v).toLocaleString()}`;
}

export const data = new SlashCommandBuilder()
  .setName('treasury_bulk')
  .setDescription('Adjust multiple resources in the alliance treasury using JSON')
  .addStringOption(o =>
    o.setName('payload')
      .setDescription('e.g. {"money":1000000,"steel":500,"munitions":-10}')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  // require alliance link
  const alliance = await getAllianceByGuild(i.guildId || '');
  if (!alliance) {
    return i.reply({ content: 'This server is not linked yet. Run **/setup_alliance** first.', ephemeral: true });
  }

  // parse and validate
  let raw: any;
  try {
    raw = JSON.parse(i.options.getString('payload', true));
  } catch {
    return i.reply({ content: 'Invalid JSON. Example: `{"money":1000000,"steel":500,"munitions":-10}`', ephemeral: true });
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    return i.reply({ content: 'Payload must be a JSON object of {resource:number}.', ephemeral: true });
  }

  const adjustments: Record<string, number> = {};
  for (const [k0, v0] of Object.entries(raw)) {
    const k = String(k0).toLowerCase();
    const n = Number(v0);
    if (!RES_SET.has(k as any)) {
      return i.reply({ content: `Unknown resource: \`${k}\`.`, ephemeral: true });
    }
    if (!Number.isFinite(n) || n === 0) continue; // ignore zeros; require finite
    adjustments[k] = n;
  }
  if (!Object.keys(adjustments).length) {
    return i.reply({ content: 'Nothing to change. Provide non-zero amounts.', ephemeral: true });
  }

  // apply adjustments (positive => add, negative => subtract)
  const results: Array<{ k: string; delta: number }> = [];
  for (const [k, delta] of Object.entries(adjustments)) {
    const op = delta >= 0 ? 'add' : 'subtract';
    await addToTreasury(alliance.id, k as any, op as any, Math.abs(delta));
    results.push({ k, delta });
  }

  // fetch new totals to show a nice summary
  const t = await getAllianceTreasury(alliance.id);
  const totalsLine =
    ORDER.map(k => {
      const v = Number((t.balances as any)[k] || 0);
      return v ? `${(RES_EMOJI as any)[k] || ''} **${k}**: ${v.toLocaleString()}` : undefined;
    }).filter(Boolean).join(' · ') || '—';

  const embed = new EmbedBuilder()
    .setTitle(`🏦 Alliance Treasury — #${alliance.id}`)
    .setColor(Colors.Blurple)
    .addFields(
      {
        name: 'Applied',
        value: results.map(r => fmtAdjLine(r.k, r.delta)).join(' · '),
        inline: false,
      },
      {
        name: 'New totals',
        value: totalsLine,
        inline: false,
      }
    );

  await i.reply({ embeds: [embed] });
}
