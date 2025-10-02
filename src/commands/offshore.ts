// src/commands/offshore.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, Colors, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import { getAllianceForGuild, getDefaultOffshore, setDefaultOffshore, setAllianceOffshoreOverride, getEffectiveOffshore, auditOffshore } from '../lib/offshore';
import { bankWithdrawAlliance, PnwResourcePayload } from '../lib/pnw';
import { open } from '../lib/crypto';

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName('offshore')
  .setDescription('Offshore treasury helpers')
  .addSubcommand(s => s
    .setName('show')
    .setDescription('Show effective offshore (override and default)'))
  .addSubcommand(s => s
    .setName('set_default')
    .setDescription('Set global default offshore alliance id (0 to clear)')
    .addIntegerOption(o => o.setName('aid').setDescription('Alliance ID for default offshore (0 to clear)').setRequired(true)))
  .addSubcommand(s => s
    .setName('set_override')
    .setDescription('Set per-alliance offshore override (0 to clear)')
    .addIntegerOption(o => o.setName('aid').setDescription('Alliance ID for override (0 to clear)').setRequired(true)))
  .addSubcommand(s => s
    .setName('send')
    .setDescription('Send this alliance treasury to its effective offshore')
    .addStringOption(o => o.setName('payload').setDescription('JSON like {"money":1000000,"steel":2}').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Optional note').setRequired(false))
  )
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);
  const alliance = await getAllianceForGuild(i.guildId || '');
  if (!alliance && sub !== 'set_default') {
    return i.reply({ content: 'This server is not linked. Run /setup_alliance first.', ephemeral: true });
  }

  if (sub === 'show') {
    await i.deferReply({ ephemeral: true });
    const eff = alliance ? await getEffectiveOffshore(alliance.id) : null;
    const def = await getDefaultOffshore();
    const emb = new EmbedBuilder()
      .setTitle('🌊 Offshore Status')
      .setColor(Colors.Blurple)
      .addFields(
        { name: 'Alliance', value: alliance ? `${alliance.name ?? ''} (${alliance.id})` : '—', inline: false },
        { name: 'Per-Alliance Override', value: String((alliance as any)?.offshoreOverrideAllianceId ?? '—'), inline: true },
        { name: 'Global Default', value: String(def ?? '—'), inline: true },
        { name: 'Effective Offshore', value: String(eff ?? '—'), inline: false },
      );
    return i.editReply({ embeds: [emb] });
  }

  if (sub === 'set_default') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: 'You need Manage Guild to set default offshore.', ephemeral: true });
    }
    const aid = i.options.getInteger('aid', true);
    await setDefaultOffshore(aid && aid > 0 ? aid : null, i.user.id);
    return i.reply({ content: `✅ Default offshore set to ${aid || 'cleared'}.`, ephemeral: true });
  }

  if (sub === 'set_override') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return i.reply({ content: 'You need Manage Guild to set per-alliance override.', ephemeral: true });
    }
    const aid = i.options.getInteger('aid', true);
    await setAllianceOffshoreOverride(alliance!.id, aid && aid > 0 ? aid : null);
    return i.reply({ content: `✅ Override set to ${aid || 'cleared'}.`, ephemeral: true });
  }

  // send
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: 'You need Manage Guild to send to offshore.', ephemeral: true });
  }

  let payload: PnwResourcePayload = {};
  try {
    payload = JSON.parse(i.options.getString('payload', true));
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('bad');
  } catch {
    return i.reply({ content: 'Invalid payload JSON.', ephemeral: true });
  }
  const note = i.options.getString('note') ?? undefined;

  await i.deferReply({ ephemeral: true });

  const eff = await getEffectiveOffshore(alliance!.id);
  if (!eff) return i.editReply('No effective offshore configured (set override or default).');

  // get keys: prefer AllianceKey (encrypted), else env fallbacks
  let apiKey = process.env.PNW_DEFAULT_API_KEY || '';
  let botKey = process.env.PNW_BOT_KEY || '';
  try {
    const keyrec = await prisma.allianceKey.findFirst({
      where: { allianceId: alliance!.id },
      orderBy: { id: 'desc' },
    });
    if (keyrec?.encryptedApiKey && keyrec?.nonceApi) {
      apiKey = open(keyrec.encryptedApiKey as any, keyrec.nonceApi as any) || apiKey;
    }
    if (keyrec?.encryptedBotKey && keyrec?.nonceBot) {
      botKey = open(keyrec.encryptedBotKey as any, keyrec.nonceBot as any) || botKey;
    }
  } catch {}

  if (!apiKey || !botKey) return i.editReply('Missing API/Bot key. Save them with /setup_alliance first.');

  const result = await bankWithdrawAlliance(apiKey, botKey, eff, payload, note ?? `Offshore from ${alliance!.id} by ${i.user.id}`);
  await auditOffshore({
    sourceAid: alliance!.id,
    targetAid: eff,
    payload: (payload as any) || {},
    actorId: i.user.id,
    note: 'offshore.send',
    result: result.ok ? 'OK' : (result.error || 'ERR'),
  });

  if (result.ok) {
    const emb = new EmbedBuilder()
      .setTitle('🏦 Offshore Transfer Sent')
      .setColor(Colors.Green)
      .addFields(
        { name: 'From Alliance', value: `${alliance!.id}`, inline: true },
        { name: 'To Offshore', value: `${eff}`, inline: true },
        { name: 'Payload', value: Object.entries(payload).map(([k, v]) => `• ${k}: ${Number(v).toLocaleString()}`).join('\n') || '—', inline: false },
      );
    return i.editReply({ embeds: [emb] });
  }
  return i.editReply(`⚠️ Offshore send failed: ${result.error || 'unknown error'}`);
}
