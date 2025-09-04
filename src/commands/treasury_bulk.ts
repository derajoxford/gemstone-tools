// src/commands/treasury_bulk.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  PermissionFlagsBits,
} from 'discord.js';
import { prisma } from '../db';
import { ORDER, RES_EMOJI } from '../lib/emojis.js';

export const data = new SlashCommandBuilder()
  .setName('treasury_bulk')
  .setDescription('Adjust multiple treasury resources at once (add or subtract).')
  // IMPORTANT: required option first so Discord doesn’t 50035
  .addStringOption(o =>
    o
      .setName('op')
      .setDescription('Add or subtract')
      .addChoices({ name: 'add', value: 'add' }, { name: 'subtract', value: 'subtract' })
      .setRequired(true)
  )
  // Provide an optional number input for every resource (0 = ignore)
  .addNumberOption(o => o.setName('money').setDescription('money').setMinValue(0))
  .addNumberOption(o => o.setName('food').setDescription('food').setMinValue(0))
  .addNumberOption(o => o.setName('coal').setDescription('coal').setMinValue(0))
  .addNumberOption(o => o.setName('oil').setDescription('oil').setMinValue(0))
  .addNumberOption(o => o.setName('uranium').setDescription('uranium').setMinValue(0))
  .addNumberOption(o => o.setName('lead').setDescription('lead').setMinValue(0))
  .addNumberOption(o => o.setName('iron').setDescription('iron').setMinValue(0))
  .addNumberOption(o => o.setName('bauxite').setDescription('bauxite').setMinValue(0))
  .addNumberOption(o => o.setName('gasoline').setDescription('gasoline').setMinValue(0))
  .addNumberOption(o => o.setName('munitions').setDescription('munitions').setMinValue(0))
  .addNumberOption(o => o.setName('steel').setDescription('steel').setMinValue(0))
  .addNumberOption(o => o.setName('aluminum').setDescription('aluminum').setMinValue(0))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  if (!i.guildId) return i.editReply('Guild only.');
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId } });
  if (!alliance) return i.editReply('This server is not linked yet. Run **/setup_alliance** first.');

  const op = (i.options.getString('op', true) as 'add' | 'subtract');

  // gather changes
  const changes: Record<string, number> = {};
  for (const k of ORDER) {
    const v = i.options.getNumber(k as any, false);
    if (v && v > 0) changes[k] = v;
  }
  if (!Object.keys(changes).length) {
    return i.editReply('Nothing to adjust. Provide one or more resource amounts (numbers > 0).');
  }

  // load current
  const treas = await prisma.allianceTreasury.findUnique({ where: { allianceId: alliance.id } });
  const balances = (treas?.balances as Record<string, number>) || {};

  // compute next & validate
  const next = { ...balances };
  for (const [k, amt] of Object.entries(changes)) {
    const cur = Number(next[k] || 0);
    const delta = op === 'subtract' ? -amt : amt;
    const val = cur + delta;
    if (val < 0) {
      return i.editReply(
        `Cannot ${op} **${amt.toLocaleString()} ${k}** — only **${cur.toLocaleString()}** available.`
      );
    }
    next[k] = val;
  }

  // persist
  await prisma.allianceTreasury.upsert({
    where: { allianceId: alliance.id },
    update: { balances: next },
    create: { allianceId: alliance.id, balances: next },
  });

  // pretty embed
  const lines =
    ORDER.map(k => {
      const v = Number(next[k] || 0);
      return v ? `${RES_EMOJI[k as any] ?? ''} **${k}**: ${v.toLocaleString()}` : undefined;
    })
      .filter(Boolean)
      .join('\n') || '—';

  const changed =
    Object.entries(changes)
      .map(([k, v]) => `${RES_EMOJI[k as any] ?? ''}${k}: ${v.toLocaleString()}`)
      .join(' · ');

  const embed = new EmbedBuilder()
    .setTitle(`🏛️ Alliance Treasury — #${alliance.id}${alliance.name ? ` (${alliance.name})` : ''}`)
    .setDescription(lines)
    .setColor(Colors.Blurple)
    .setFooter({ text: 'Use /treasury to view full balances.' });

  await i.editReply({
    content: `✅ ${op === 'subtract' ? 'Decreased' : 'Increased'}: ${changed}`,
    embeds: [embed],
  });
}
