// src/commands/treasury_bulk.ts
import {
  SlashCommandBuilder, Colors, EmbedBuilder,
  PermissionFlagsBits, ChatInputCommandInteraction
} from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { RES_EMOJI, ORDER } from '../lib/emojis.js';

const prisma = new PrismaClient();
const RES_SET = new Set(ORDER as readonly string[]);

function fmtChange(k: string, delta: number) {
  const e = (RES_EMOJI as any)[k] || '';
  const sign = delta >= 0 ? '+' : '−';
  return `${e} ${k}: ${sign}${Math.abs(delta).toLocaleString()}`;
}

export const data = new SlashCommandBuilder()
  .setName('treasury_bulk')
  .setDescription('Adjust multiple resources in the alliance treasury using JSON')
  .addStringOption(o =>
    o
      .setName('payload')
      .setDescription('JSON like {"steel":500, "gasoline":-10} (positive=add, negative=subtract)')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  // Validate guild↔alliance link
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) {
    return i.editReply({ content: 'This server is not linked. Run **/setup_alliance** first.' });
  }

  // Parse & validate payload
  const raw = i.options.getString('payload', true);
  let payload: Record<string, number>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return i.editReply({ content: 'Invalid JSON. Example: `{"steel":500,"gasoline":-10}`' });
  }
  if (!payload || typeof payload !== 'object') {
    return i.editReply({ content: 'Payload must be a JSON object of {resource:number}.' });
  }

  const deltas: Record<string, number> = {};
  for (const [k0, v0] of Object.entries(payload)) {
    const k = String(k0).toLowerCase();
    if (!RES_SET.has(k)) return i.editReply({ content: `Unknown resource: **${k}**.` });
    const n = Number(v0);
    if (!Number.isFinite(n) || n === 0) continue; // ignore zeros/bad
    deltas[k] = n;
  }
  const entries = Object.entries(deltas);
  if (!entries.length) return i.editReply({ content: 'Nothing to adjust.' });

  // Apply changes atomically
  const updated = await prisma.$transaction(async (tx) => {
    // ensure row exists
    const current =
      (await tx.allianceTreasury.findUnique({ where: { allianceId: alliance.id } })) ??
      (await tx.allianceTreasury.create({ data: { allianceId: alliance.id, balances: {} } }));

    const balances: Record<string, number> = { ...(current.balances as any || {}) };
    for (const [k, delta] of entries) {
      const prev = Number(balances[k] || 0);
      const next = prev + Number(delta);
      balances[k] = Number.isFinite(next) ? next : prev;
    }

    return tx.allianceTreasury.update({
      where: { allianceId: alliance.id },
      data: { balances },
    });
  });

  // Render nice embed
  const changes = entries.map(([k, d]) => fmtChange(k, d)).join(' · ');
  const balances = (updated.balances as any) as Record<string, number>;
  const lines = ORDER.map(k => {
    const v = Number(balances[k] || 0);
    const e = (RES_EMOJI as any)[k] || '';
    return `${e} **${k}**: ${v.toLocaleString()}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`🏦 Treasury updated — #${alliance.id}`)
    .addFields(
      { name: 'Changes', value: changes || '—', inline: false },
      { name: 'New Balances', value: lines || '—', inline: false },
    )
    .setColor(Colors.Blurple);

  await i.editReply({ embeds: [embed] });
}
