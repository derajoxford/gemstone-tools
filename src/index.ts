// src/index.ts
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder,
  PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ChatInputCommandInteraction, EmbedBuilder, Colors, ButtonBuilder, ButtonStyle,
  ChannelType, ButtonInteraction, Interaction
} from 'discord.js';
import pino from 'pino';
// @ts-ignore - types may not be installed; not needed for runtime
import cron from 'node-cron';
import { PrismaClient, WithdrawStatus } from '@prisma/client';
import { seal, open } from './lib/crypto.js';
import { RES_EMOJI, ORDER } from './lib/emojis.js';
import { fetchBankrecs } from './lib/pnw.js';
import { extraCommandsJSON, findCommandByName } from './commands/registry';
import { buildCommandsFinal, tryExecuteRegistry } from './commands/registry_runtime';

// Import external command modules (one time only)
import * as treasury from './commands/treasury';
import * as treasury_add from './commands/treasury_add';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const prisma = new PrismaClient();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

// ----- Slash Commands (base) -----
const baseCommands = [
  new SlashCommandBuilder().setName('setup_alliance')
    .setDescription('Link this Discord to a PnW Alliance banking setup')
    .addIntegerOption(o => o.setName('alliance_id').setDescription('PnW Alliance ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('set_review_channel')
    .setDescription('Set the channel for withdrawal approvals (buttons)')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to post approvals (defaults to current)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('link_nation')
    .setDescription('Link your Discord to your PnW nation for safekeeping')
    .addIntegerOption(o => o.setName('nation_id').setDescription('Your nation id').setRequired(true))
    .addStringOption(o => o.setName('nation_name').setDescription('Your nation name').setRequired(true)),

  new SlashCommandBuilder().setName('balance')
    .setDescription('Show your safekeeping balance'),

  new SlashCommandBuilder().setName('withdraw')
    .setDescription('Start a guided withdrawal (press Start to open the form)'),

  new SlashCommandBuilder().setName('withdraw_json')
    .setDescription('Request a withdrawal using JSON (advanced)')
    .addStringOption(o => o.setName('payload').setDescription('{"money":1000000,"steel":500}').setRequired(true)),

  new SlashCommandBuilder().setName('withdraw_list')
    .setDescription('List recent withdrawal requests (default: PENDING)')
    .addStringOption(o =>
      o.setName('status')
        .setDescription('Filter by status')
        .addChoices(
          { name: 'PENDING', value: 'PENDING' },
          { name: 'APPROVED', value: 'APPROVED' },
          { name: 'REJECTED', value: 'REJECTED' },
          { name: 'PAID', value: 'PAID' },
          { name: 'CANCELED', value: 'CANCELED' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder().setName('withdraw_set')
    .setDescription('Set the status of a withdrawal request')
    .addStringOption(o => o.setName('id').setDescription('Request ID (UUID)').setRequired(true))
    .addStringOption(o =>
      o.setName('status')
        .setDescription('New status')
        .setRequired(true)
        .addChoices(
          { name: 'APPROVED', value: 'APPROVED' },
          { name: 'REJECTED', value: 'REJECTED' },
          { name: 'PAID', value: 'PAID' },
          { name: 'CANCELED', value: 'CANCELED' }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Admin-friendly guided safekeeping editor
  new SlashCommandBuilder().setName('safekeeping_edit')
    .setDescription('Admin: edit a member’s safekeeping (guided)')
    .addUserOption(o => o.setName('user').setDescription('Member to edit').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

// Convert to JSON for registration
const baseCommandsJSON = baseCommands.map(c => c.toJSON());

// Pull in external modules' .data as JSON
const extraCommandsJSON = [treasury, treasury_add]
  .filter((m: any) => m?.data?.toJSON)
  .map((m: any) => m.data.toJSON());

// Combine + de-duplicate by name (prevents Discord 50035 duplicate-name error)
const commands = (() => {
  const seen = new Set<string>();
  return [...baseCommandsJSON, ...extraCommandsJSON].filter((c: any) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
})();

async function register() {
  const appId = process.env.DISCORD_CLIENT_ID!;
  const guildId = process.env.TEST_GUILD_ID;
  try {
    if (guildId) {
      log.info({ appId, guildId, commands: (commands as any[]).map((x: any) => x.name) }, 'REGISTER guild');
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
      log.info('Guild slash commands registered');
    } else {
      log.info({ appId, commands: (commands as any[]).map((x: any) => x.name) }, 'REGISTER global');
      await rest.put(Routes.applicationCommands(appId), { body: commands });
      log.info('Global slash commands registered');
    }
  } catch (e) { log.error(e); }
}

client.once('ready', async () => {
  log.info({ tag: client.user?.tag }, 'Gemstone Tools online ✨');
  await register();
});

// ---------- Helpers ----------
function fmtLine(k: string, v: number) {
  return `${RES_EMOJI[k as keyof typeof RES_EMOJI] || ''} **${k}**: ${v.toLocaleString()}`;
}
function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/[, _]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

// Keep per-user withdraw modal session (paged amounts)
const wdSessions: Map<string, { data: Record<string, number>, createdAt: number }> = new Map();

// Keep per-admin safekeeping edit session (target + working values)
const skSessions: Map<string, { targetMemberId: number, data: Record<string, number>, createdAt: number }> = new Map();

// ---------- Interaction Handling ----------
client.on('interactionCreate', async (i: Interaction) => {
  try {
    if (i.isChatInputCommand()) {
      log.info({ cmd: i.commandName, user: (i as any).user?.id }, 'CMD_RCVD');

      if (i.commandName === 'setup_alliance') return handleSetupAlliance(i);
      if (i.commandName === 'set_review_channel') return handleSetReviewChannel(i);
      if (i.commandName === 'link_nation') return handleLinkNation(i);
      if (i.commandName === 'balance') return handleBalance(i);
      if (i.commandName === 'withdraw') return handleWithdrawStart(i);
      if (i.commandName === 'withdraw_json') return handleWithdrawJson(i);
      if (i.commandName === 'withdraw_list') return handleWithdrawList(i);
      if (i.commandName === 'withdraw_set') return handleWithdrawSet(i);
      if (i.commandName === 'safekeeping_edit') return handleSafekeepingStart(i);

      // Wire new commands exactly once
      if (i.commandName === 'treasury') return (treasury as any).execute(i);
      if (i.commandName === 'treasury_add') return (treasury_add as any).execute(i);

    } else if (i.isModalSubmit()) {
      if (i.customId.startsWith('wd:modal:')) return handleWithdrawPagedModal(i as any);
      // Removed legacy handleWithdrawModalSubmit (not defined)
      if (i.customId.startsWith('alliancekeys:')) return handleAllianceModal(i as any);
      if (i.customId.startsWith('sk:modal:')) return handleSafekeepingModalSubmit(i as any);

    } else if (i.isButton()) {
      if (i.customId.startsWith('wd:open:')) return handleWithdrawOpenButtonPaged(i as any);
      if (i.customId === 'wd:done') return handleWithdrawDone(i as any);

      if (i.customId.startsWith('sk:open:')) return handleSafekeepingOpenPaged(i as any);
      if (i.customId === 'sk:done') return handleSafekeepingDone(i as any);

      return handleApprovalButton(i);
    }
  } catch (err) {
    console.error(err);
    if ('isRepliable' in i && i.isRepliable()) {
      try { await (i as any).reply({ content: 'Something went wrong.', ephemeral: true }); } catch {}
    }
  }
});

// ---------- Slash handlers ----------
async function handleSetupAlliance(i: ChatInputCommandInteraction) {
  const allianceId = i.options.getInteger('alliance_id', true);
  const modal = new ModalBuilder().setCustomId(`alliancekeys:${allianceId}`).setTitle('Alliance API Key');
  const api = new TextInputBuilder()
    .setCustomId('apiKey')
    .setLabel('Alliance API Key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(api));
  await i.showModal(modal);
}
async function handleAllianceModal(i: any) {
  const allianceId = parseInt(i.customId.split(':')[1]!, 10);
  const apiKey = i.fields.getTextInputValue('apiKey');
  const { ciphertext: encApi, iv: ivApi } = seal(apiKey);
  await prisma.alliance.upsert({
    where: { id: allianceId },
    update: { guildId: i.guildId ?? undefined },
    create: { id: allianceId, guildId: i.guildId ?? undefined },
  });
  await prisma.allianceKey.create({ data: { allianceId, encryptedApiKey: encApi, nonceApi: ivApi, addedBy: i.user.id } });
  await i.reply({ content: `✅ API key saved for alliance ${allianceId}.`, ephemeral: true });
}

async function handleSetReviewChannel(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'This server is not linked yet. Run /setup_alliance first.', ephemeral: true });
  const channel = i.options.getChannel('channel') ?? i.channel;
  if (!channel || channel.type !== ChannelType.GuildText) return i.reply({ content: 'Pick a text channel.', ephemeral: true });
  await prisma.alliance.update({ where: { id: alliance.id }, data: { reviewChannelId: channel.id } });
  await i.reply({ content: `✅ Review channel set to #${(channel as any).name}.`, ephemeral: true });
}

async function handleLinkNation(i: ChatInputCommandInteraction) {
  const nationId = i.options.getInteger('nation_id', true);
  const nationName = i.options.getString('nation_name', true);
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'This server is not linked yet. Run /setup_alliance first.', ephemeral: true });
  await prisma.member.upsert({
    where: { allianceId_discordId: { allianceId: alliance.id, discordId: i.user.id } },
    update: { nationId, nationName },
    create: { allianceId: alliance.id, discordId: i.user.id, nationId, nationName },
  });
  const member = await prisma.member.findFirstOrThrow({ where: { allianceId: alliance.id, discordId: i.user.id } });
  await prisma.safekeeping.upsert({ where: { memberId: member.id }, update: {}, create: { memberId: member.id } });
  await i.reply({ content: '🔗 Nation linked for safekeeping.', ephemeral: true });
}

async function handleBalance(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked to this server yet.', ephemeral: true });
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id }, include: { balance: true } });
  if (!member || !member.balance) return i.reply({ content: 'No safekeeping account found. Run /link_nation first.', ephemeral: true });

  const bal: any = member.balance as any;
  const lines = ORDER.map(k => {
    const v = Number((bal as any)[k] || 0);
    return v ? `${RES_EMOJI[k]} **${k}**: ${v.toLocaleString()}` : undefined;
  }).filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle('💎 Gemstone Safekeeping')
    .setDescription(lines.join('\n') || 'No resources held.')
    .setFooter({ text: `Nation: ${member.nationName} (${member.nationId})` })
    .setColor(Colors.Blurple);

  await i.reply({ embeds: [embed], ephemeral: true });
}

// ---- Withdraw flow (paged: modal pages of ORDER by 5) ----
const WD_PAGE_SIZE = 5;
function wdPageCountAll() { return Math.ceil(ORDER.length / WD_PAGE_SIZE); }
function wdSliceAll(page: number) { const s = page * WD_PAGE_SIZE; return ORDER.slice(s, s + WD_PAGE_SIZE); }

async function handleWithdrawStart(i: ChatInputCommandInteraction) {
  wdSessions.set(i.user.id, { data: {}, createdAt: Date.now() });
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked yet. Run /setup_alliance first.', ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle('💸 Start a Withdrawal')
    .setDescription('Press **Start** to open a guided form. It will only show resources you have available.')
    .setColor(Colors.Gold);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('wd:open:0').setLabel('Start').setEmoji('✨').setStyle(ButtonStyle.Primary)
  );

  await i.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function wdOpenModalPaged(i: ButtonInteraction, page: number) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked here.', ephemeral: true });
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id }, include: { balance: true } });
  if (!member || !member.balance) return i.reply({ content: 'No safekeeping found. Run /link_nation first.', ephemeral: true });

  const bal: any = member.balance as any;
  const keys = wdSliceAll(page);
  const total = wdPageCountAll();
  const modal = new ModalBuilder().setCustomId(`wd:modal:${page}`).setTitle(`💸 Withdrawal (${page + 1}/${total})`);

  for (const k of keys) {
    const avail = Number(bal[k] || 0);
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k] ?? ''} ${k} (avail: ${avail.toLocaleString()})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('0');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  await i.showModal(modal);
}

async function handleWithdrawOpenButtonPaged(i: any) {
  const m = String(i.customId).match(/^wd:open:(\d+)$/);
  const page = m && m[1] ? Math.max(0, parseInt(m[1], 10)) : 0;
  return wdOpenModalPaged(i as ButtonInteraction, page);
}

async function handleWithdrawPagedModal(i: any) {
  try {
    const m = String(i.customId).match(/^wd:modal:(\d+)$/);
    if (!m) return;
    const page = Number(m[1]);

    const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
    if (!alliance) return i.reply({ content: 'No alliance linked here.', ephemeral: true });
    const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id }, include: { balance: true } });
    if (!member || !member.balance) return i.reply({ content: 'No safekeeping found.', ephemeral: true });

    const bal: any = member.balance as any;
    const keys = wdSliceAll(page);

    const sess = wdSessions.get(i.user.id) || { data: {}, createdAt: Date.now() };
    for (const k of keys) {
      const raw = i.fields.getTextInputValue(k) || '';
      const num = parseNum(raw);
      if (Number.isNaN(num) || num < 0) return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
      if (num > Number(bal[k] || 0)) return i.reply({ content: `Requested ${num.toLocaleString()} ${k}, but only ${Number(bal[k] || 0).toLocaleString()} available.`, ephemeral: true });
      if (num > 0) sess.data[k] = num; else delete sess.data[k];
    }
    wdSessions.set(i.user.id, sess);

    const total = wdPageCountAll();
    const summary = Object.entries(sess.data)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${RES_EMOJI[k as any] ?? ''}${k}: ${Number(v).toLocaleString()}`)
      .join('  •  ') || '— none yet —';

    const btns: ButtonBuilder[] = [];
    if (page > 0) btns.push(new ButtonBuilder().setCustomId(`wd:open:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel('Prev'));
    if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`wd:open:${page + 1}`).setStyle(ButtonStyle.Primary).setLabel(`Next (${page + 2}/${total})`));
    btns.push(new ButtonBuilder().setCustomId('wd:done').setStyle(ButtonStyle.Success).setLabel('Done'));

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
    await i.reply({ content: `Saved so far:\n${summary}`, components: [row], ephemeral: true });
  } catch (err) {
    console.error('[wd modal submit]', err);
    try { await i.reply({ content: 'Something went wrong.', ephemeral: true }); } catch {}
  }
}

async function handleWithdrawDone(i: any) {
  const sess = wdSessions.get(i.user.id);
  if (!sess || !Object.keys(sess.data).length) {
    return i.reply({ content: 'Nothing to submit — all zero. Start again with **/withdraw**.', ephemeral: true });
  }

  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked here.', ephemeral: true });
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id }, include: { balance: true } });
  if (!member || !member.balance) return i.reply({ content: 'No safekeeping found.', ephemeral: true });

  try {
    await submitWithdraw(i, alliance.id, member, sess.data);
    wdSessions.delete(i.user.id);
  } catch (e) {
    console.error('[wd:done][err]', e);
    return i.reply({ content: 'Something went wrong submitting your request.', ephemeral: true });
  }
}

async function handleWithdrawJson(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked to this server yet.', ephemeral: true });
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id }, include: { balance: true } });
  if (!member || !member.balance) return i.reply({ content: 'No safekeeping found. Run /link_nation first.', ephemeral: true });

  let payload: any;
  try { payload = JSON.parse(i.options.getString('payload', true)); }
  catch { return i.reply({ content: 'Invalid JSON.', ephemeral: true }); }

  const bal: any = member.balance as any;
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!ORDER.includes(k as any)) return i.reply({ content: `Unknown resource: ${k}`, ephemeral: true });
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) return i.reply({ content: `Invalid amount for ${k}`, ephemeral: true });
    if (num > Number(bal[k] || 0)) return i.reply({ content: `Requested ${num} ${k}, but only ${Number(bal[k] || 0)} available.`, ephemeral: true });
    if (num > 0) clean[k] = num;
  }
  if (!Object.keys(clean).length) return i.reply({ content: 'Nothing requested.', ephemeral: true });

  await submitWithdraw(i, alliance.id, member, clean);
}

async function submitWithdraw(i: any, allianceId: number, member: any, payload: Record<string, number>) {
  const req = await prisma.withdrawalRequest.create({ data: { allianceId, memberId: member.id, payload, createdBy: i.user.id } });

  const reqLine = Object.entries(payload).map(([k, v]) => fmtLine(k, v)).join(' · ');
  const bal: any = member.balance || {};
  const availLine = ORDER.map(k => {
    const v = Number(bal[k] || 0);
    return v ? fmtLine(k, v) : undefined;
  }).filter(Boolean).join(' · ') || '—';

  const nationUrl = `https://politicsandwar.com/nation/id=${member.nationId}`;
  const embed = new EmbedBuilder()
    .setTitle('💸 Withdrawal Request')
    .setDescription(`From <@${i.user.id}> — [${member.nationName}](${nationUrl})`)
    .addFields(
      { name: 'Requested', value: reqLine || '—', inline: false },
      { name: 'Available', value: availLine, inline: false }
    )
    .setColor(Colors.Gold);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`w:approve:${req.id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`w:deny:${req.id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );

  await i.reply({ content: '✅ Request submitted for review by bankers.', ephemeral: true });

  const a = await prisma.alliance.findFirst({ where: { id: allianceId } });
  const targetChannelId = a?.reviewChannelId || i.channelId;
  try {
    const ch = await client.channels.fetch(targetChannelId);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed], components: [row] });
  } catch {}
}

// --- list / set ---
async function handleWithdrawList(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked here.', ephemeral: true });

  const statusStr = i.options.getString('status') as WithdrawStatus | null;
  const status = statusStr ?? 'PENDING';

  const rows = await prisma.withdrawalRequest.findMany({
    where: { allianceId: alliance.id, status },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  if (!rows.length) return i.reply({ content: `No ${status} requests.`, ephemeral: true });

  const embed = new EmbedBuilder()
    .setTitle(`📜 Withdrawal Requests — ${status}`)
    .setColor(status === 'PENDING' ? Colors.Yellow : status === 'APPROVED' ? Colors.Green : status === 'REJECTED' ? Colors.Red : Colors.Greyple);

  for (const r of rows) {
    const m = await prisma.member.findUnique({ where: { id: r.memberId }, include: { balance: true } });
    const nationUrl = m ? `https://politicsandwar.com/nation/id=${m.nationId}` : undefined;
    const reqFields = Object.entries(r.payload as any).map(([k, v]) => `${RES_EMOJI[k as any] || ''} ${k}: ${v}`).join(' · ') || '—';
    const availLine = m && m.balance ? ORDER.map(k => {
      const v = Number((m.balance as any)[k] || 0);
      return v ? `${RES_EMOJI[k as any] || ''} **${k}**: ${v.toLocaleString()}` : undefined;
    }).filter(Boolean).join(' · ') : '—';

    const name = nationUrl ? `[${m?.nationName}](${nationUrl})` : (m?.nationName || 'Member');
    const value = `<@${r.createdBy}>\nRequested: ${reqFields}\nAvailable: ${availLine}`;

    embed.addFields({ name, value, inline: false });
  }
  await i.reply({ embeds: [embed], ephemeral: true });
}

async function handleWithdrawSet(i: ChatInputCommandInteraction) {
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked here.', ephemeral: true });

  const id = i.options.getString('id', true);
  const status = i.options.getString('status', true) as WithdrawStatus;

  try {
    const updated = await prisma.withdrawalRequest.update({
      where: { id },
      data: { status, reviewerId: i.user.id },
    });

    const color = status === 'APPROVED' ? Colors.Green
      : status === 'REJECTED' ? Colors.Red
      : status === 'PAID' ? Colors.Blue
      : Colors.Greyple;

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Withdrawal Status Updated')
      .setDescription(`Request **${updated.id}** → **${status}** by <@${i.user.id}>`)
      .setColor(color);

    await i.reply({ embeds: [embed], ephemeral: true });
  } catch {
    await i.reply({ content: 'Could not update. Check the ID.', ephemeral: true });
  }
}

// --- Button approvals + DMs + Auto-Pay ---
async function handleApprovalButton(i: ButtonInteraction) {
  if (!i.guildId) return i.reply({ content: 'Guild only.', ephemeral: true });
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: 'You lack permission to approve/deny.', ephemeral: true });
  }
  const [prefix, action, id] = i.customId.split(':');
  if (prefix !== 'w' || !id) return;
  const status: WithdrawStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
  const req = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!req) return i.reply({ content: 'Request not found.', ephemeral: true });
  if (req.status !== 'PENDING') return i.reply({ content: `Already ${req.status}.`, ephemeral: true });

  await prisma.withdrawalRequest.update({ where: { id }, data: { status, reviewerId: i.user.id } });

  // disable buttons on the message
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`w:approve:${id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`w:deny:${id}`).setLabel('Deny').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(true),
  );
  const embed = new EmbedBuilder()
    .setTitle(status === 'APPROVED' ? '✅ Withdrawal Approved' : '❌ Withdrawal Rejected')
    .setDescription(`Request **${id}**`)
    .setColor(status === 'APPROVED' ? Colors.Green : Colors.Red);
  await i.update({ embeds: [embed], components: [row] });
  await i.followUp({ content: `Set to **${status}** by <@${i.user.id}>`, ephemeral: true });

  // DM requester with details
  try {
    const member = await prisma.member.findUnique({ where: { id: req.memberId } });
    if (member) {
      const user = await client.users.fetch(member.discordId);
      const reqLine = Object.entries(req.payload as any).map(([k, v]) => fmtLine(k, Number(v))).join(' · ') || '—';
      const dm = new EmbedBuilder()
        .setTitle(status === 'APPROVED' ? '✅ Withdrawal Approved' : '❌ Withdrawal Rejected')
        .setDescription(`Request **${id}** — reviewed by <@${i.user.id}>`)
        .addFields({ name: 'Requested', value: reqLine })
        .setColor(status === 'APPROVED' ? Colors.Green : Colors.Red);
      await user.send({ embeds: [dm] });
    }
  } catch {}

  // --- Optional Auto-Pay on APPROVE ---
  if (status === 'APPROVED' && process.env.AUTOPAY_ENABLED === '1') {
    try {
      const alliance = await prisma.alliance.findUnique({
        where: { id: req.allianceId },
        include: { keys: { orderBy: { id: 'desc' }, take: 1 } }
      });
      const member = await prisma.member.findUnique({ where: { id: req.memberId } });
      const apiKeyEnc = alliance?.keys[0];
      const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || '');
      const botKey = process.env.PNW_BOT_KEY || '';

      if (!member || !apiKey || !botKey) {
        await i.followUp({ content: '⚠️ Auto-pay skipped (missing nation API key or bot key).', ephemeral: true });
        return;
      }

      const note = `GemstoneTools ${req.id} • reviewer ${i.user.id}`;
      const ok = await pnwAutoPay({
        apiKey, botKey, receiverNationId: member.nationId,
        payload: req.payload as Record<string, number>, note
      });

      if (ok) {
        const dec: any = {};
        for (const [k, v] of Object.entries(req.payload as any)) dec[k] = { decrement: Number(v) || 0 };
        await prisma.safekeeping.update({ where: { memberId: member.id }, data: dec });
        await prisma.withdrawalRequest.update({ where: { id }, data: { status: 'PAID' } });

        try {
          const user = await client.users.fetch(member.discordId);
          const paidLine = Object.entries(req.payload as any).map(([k, v]) => fmtLine(k, Number(v))).join(' · ') || '—';
          const emb = new EmbedBuilder()
            .setTitle('💵 Paid')
            .setDescription(`Your withdrawal **${id}** has been sent in-game.`)
            .addFields({ name: 'Amount', value: paidLine })
            .setColor(Colors.Blurple);
          await user.send({ embeds: [emb] });
        } catch {}

        await i.followUp({ content: '💸 Auto-pay sent and marked **PAID**.', ephemeral: true });
      } else {
        await i.followUp({ content: '⚠️ Auto-pay failed. Left as **APPROVED**.', ephemeral: true });
      }
    } catch {
      await i.followUp({ content: '⚠️ Auto-pay error. Left as **APPROVED**.', ephemeral: true });
    }
  }
}

// ---- Minimal PnW bankWithdraw helper (POST + headers) ----
async function pnwAutoPay(opts: {
  apiKey: string; botKey: string; receiverNationId: number;
  payload: Record<string, number>; note?: string;
}): Promise<boolean> {
  const fields = Object.entries(opts.payload)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k}:${Number(v)}`);
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);

  const q = `mutation{
    bankWithdraw(receiver:${opts.receiverNationId}, receiver_type:1, ${fields.join(',')}) { id }
  }`;

  const url = 'https://api.politicsandwar.com/graphql?api_key=' + encodeURIComponent(opts.apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': opts.apiKey,
      'X-Bot-Key': opts.botKey
    },
    body: JSON.stringify({ query: q })
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || (data as any).errors) {
    console.error('AUTOPAY_ERR', res.status, JSON.stringify(data));
  }
  return res.ok && !(data as any).errors && (data as any)?.data?.bankWithdraw;
}

// ---------- Admin: /safekeeping_edit (paged, absolute set) ----------
const SK_PAGE_SIZE = 5;
function skPageCountAll() { return Math.ceil(ORDER.length / SK_PAGE_SIZE); }
function skSliceAll(page: number) { const s = page * SK_PAGE_SIZE; return ORDER.slice(s, s + SK_PAGE_SIZE); }

async function handleSafekeepingStart(i: ChatInputCommandInteraction) {
  // Immediate ack to avoid timeouts
  await i.deferReply({ ephemeral: true });

  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.editReply({ content: 'No alliance linked yet. Run /setup_alliance first.' });

  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.editReply({ content: 'You lack permission to edit safekeeping.' });
  }

  const target = i.options.getUser('user', true);
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: target.id }, include: { balance: true } });
  if (!member) return i.editReply({ content: 'That user is not linked in this alliance.' });

  // Ensure a safekeeping row exists
  if (!member.balance) {
    await prisma.safekeeping.create({ data: { memberId: member.id } });
  }

  // start/clear session for this admin
  skSessions.set(i.user.id, { targetMemberId: member.id, data: {}, createdAt: Date.now() });

  const embed = new EmbedBuilder()
    .setTitle('🧰 Safekeeping Editor')
    .setDescription(`Editing <@${target.id}>'s safekeeping. Use **Start** to open page 1.`)
    .setColor(Colors.Blurple);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sk:open:${member.id}:0`).setLabel('Start').setEmoji('✨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sk:done').setLabel('Done').setStyle(ButtonStyle.Success).setDisabled(true)
  );

  await i.editReply({ embeds: [embed], components: [row] });
}

async function handleSafekeepingOpenPaged(i: any) {
  const parts = i.customId.split(':'); // sk:open:<memberId>:<page>
  const memberId = Number(parts[2] || 0);
  const page = Math.max(0, Number(parts[3] || 0) || 0);
  const total = skPageCountAll();

  const sess = skSessions.get(i.user.id);
  if (!sess || sess.targetMemberId !== memberId) {
    return i.reply({ content: 'Session expired. Run /safekeeping_edit again.', ephemeral: true });
  }

  // Show a modal for this page
  return skOpenModalPaged(i as ButtonInteraction, memberId, page, total);
}

async function skOpenModalPaged(i: ButtonInteraction, memberId: number, page: number, total: number) {
  // Load current balance of the target member (not the button clicker)
  const member = await prisma.member.findUnique({ where: { id: memberId }, include: { balance: true } });
  if (!member) return i.reply({ content: 'Member not found.', ephemeral: true });
  const bal: any = member.balance as any || {};

  const keys = skSliceAll(page);
  const modal = new ModalBuilder().setCustomId(`sk:modal:${memberId}:${page}`).setTitle(`🧰 Edit (${page + 1}/${total})`);

  for (const k of keys) {
    const curr = Number(bal[k] || 0);
    const input = new TextInputBuilder()
      .setCustomId(k)
      .setLabel(`${RES_EMOJI[k] ?? ''} ${k} (current: ${curr.toLocaleString()})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder(String(curr));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  await i.showModal(modal);
}

async function handleSafekeepingModalSubmit(i: any) {
  // customId: sk:modal:<memberId>:<page>
  const m = String(i.customId).match(/^sk:modal:(\d+):(\d+)$/);
  if (!m) return;
  const memberId = Number(m[1]);
  const page = Number(m[2]);
  const total = skPageCountAll();

  const sess = skSessions.get(i.user.id);
  if (!sess || sess.targetMemberId !== memberId) {
    return i.reply({ content: 'Session expired. Run /safekeeping_edit again.', ephemeral: true });
  }

  const keys = skSliceAll(page);
  for (const k of keys) {
    const raw = (i.fields.getTextInputValue(k) || '').trim();
    if (raw === '') { delete sess.data[k]; continue; }
    const num = parseNum(raw);
    if (!Number.isFinite(num) || num < 0) {
      return i.reply({ content: `Invalid number for ${k}.`, ephemeral: true });
    }
    sess.data[k] = num;
  }
  skSessions.set(i.user.id, sess);

  // Build navigation + Done
  const btns: ButtonBuilder[] = [];
  if (page > 0) btns.push(new ButtonBuilder().setCustomId(`sk:open:${memberId}:${page - 1}`).setStyle(ButtonStyle.Secondary).setLabel(`◀ Prev (${page}/${total})`));
  btns.push(new ButtonBuilder().setCustomId(`sk:open:${memberId}:${page}`).setStyle(ButtonStyle.Primary).setLabel(`Open Page ${page + 1}/${total}`));
  if (page < total - 1) btns.push(new ButtonBuilder().setCustomId(`sk:open:${memberId}:${page + 1}`).setStyle(ButtonStyle.Secondary).setLabel(`Next (${page + 2}/${total}) ▶`));
  btns.push(new ButtonBuilder().setCustomId('sk:done').setStyle(ButtonStyle.Success).setLabel('Done ✅'));

  const summary = Object.entries(sess.data)
    .map(([k, v]) => `${k}:${Number(v).toLocaleString()}`)
    .join(' · ') || '— none yet —';

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...btns);
  await i.reply({ content: `Saved (absolute values to set):\n${summary}`, components: [row], ephemeral: true });
}

async function handleSafekeepingDone(i: any) {
  const sess = skSessions.get(i.user.id);
  if (!sess) return i.reply({ content: 'Session expired. Run /safekeeping_edit again.', ephemeral: true });

  // Apply absolute sets for provided keys only
  const target = await prisma.member.findUnique({ where: { id: sess.targetMemberId }, include: { balance: true } });
  if (!target) return i.reply({ content: 'Target member not found.', ephemeral: true });

  const data: any = {};
  for (const [k, v] of Object.entries(sess.data)) {
    if (!ORDER.includes(k as any)) continue;
    data[k] = { set: Number(v) };
  }
  if (!Object.keys(data).length) {
    skSessions.delete(i.user.id);
    return i.reply({ content: 'Nothing to update — no values entered.', ephemeral: true });
  }

  try {
    await prisma.safekeeping.update({
      where: { memberId: target.id },
      data,
    });
    skSessions.delete(i.user.id);

    const setLine = Object.entries(sess.data)
      .map(([k, v]) => `${RES_EMOJI[k as any] ?? ''}${k}: ${Number(v).toLocaleString()}`)
      .join(' · ');

    const embed = new EmbedBuilder()
      .setTitle('✅ Safekeeping Updated')
      .setDescription(`Edited for <@${target.discordId}>`)
      .addFields({ name: 'Set To', value: setLine || '—' })
      .setColor(Colors.Green);

    await i.reply({ embeds: [embed], ephemeral: true });
  } catch (e) {
    console.error('[sk:done] update error', e);
    await i.reply({ content: 'Failed to update safekeeping.', ephemeral: true });
  }
}

// ---------- Cron: bank monitor ----------
cron.schedule('*/2 * * * *', async () => {
  const toInt = (v: any) => Number.parseInt(String(v), 10) || 0;
  const toNum = (v: any) => Number.parseFloat(String(v)) || 0;

  const alliances = await prisma.alliance.findMany({ include: { keys: { orderBy: { id: 'desc' }, take: 1 } } });
  for (const a of alliances) {
    try {
      const k = a.keys[0];
      const apiKey = k ? open(k.encryptedApiKey as any, k.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || '');
      if (!apiKey) continue;

      const alliancesData = await fetchBankrecs({ apiKey }, [a.id]);
      const al = (alliancesData || [])[0];
      if (!al || !al.bankrecs) continue;

      let last = a.lastBankrecId || 0;
      const rows = (al.bankrecs as any[]).filter(r => toInt(r.id) > last).sort((x: any, y: any) => toInt(x.id) - toInt(y.id));
      for (const r of rows) {
        await prisma.bankrec.upsert({
          where: { id: toInt(r.id) },
          update: {},
          create: {
            id: toInt(r.id),
            allianceId: a.id,
            date: new Date(r.date),
            note: r.note || null,
            senderType: toInt(r.sender_type),
            senderId: toInt(r.sender_id),
            receiverType: toInt(r.receiver_type),
            receiverId: toInt(r.receiver_id),
            money: toNum(r.money),
            food: toNum(r.food),
            coal: toNum(r.coal),
            oil: toNum(r.oil),
            uranium: toNum(r.uranium),
            lead: toNum(r.lead),
            iron: toNum(r.iron),
            bauxite: toNum(r.bauxite),
            gasoline: toNum(r.gasoline),
            munitions: toNum(r.munitions),
            steel: toNum(r.steel),
            aluminum: toNum(r.aluminum),
          },
        });

        const isDeposit = toInt(r.sender_type) === 1 && toInt(r.receiver_type) === 2 && toInt(r.receiver_id) === a.id;
        if (isDeposit) {
          const member = await prisma.member.findFirst({ where: { allianceId: a.id, nationId: toInt(r.sender_id) } });
          if (member) {
            await prisma.safekeeping.upsert({
              where: { memberId: member.id },
              update: {
                money: { increment: toNum(r.money) },
                food: { increment: toNum(r.food) },
                coal: { increment: toNum(r.coal) },
                oil: { increment: toNum(r.oil) },
                uranium: { increment: toNum(r.uranium) },
                lead: { increment: toNum(r.lead) },
                iron: { increment: toNum(r.iron) },
                bauxite: { increment: toNum(r.bauxite) },
                gasoline: { increment: toNum(r.gasoline) },
                munitions: { increment: toNum(r.munitions) },
                steel: { increment: toNum(r.steel) },
                aluminum: { increment: toNum(r.aluminum) },
              },
              create: { memberId: member.id },
            });

            // DM with FULL breakdown
            try {
              const user = await client.users.fetch(member.discordId);
              const lines: string[] = [];
              for (const k2 of ORDER) {
                const val = toNum((r as any)[k2]);
                if (val) lines.push(fmtLine(k2, val));
              }
              const nationUrl = `https://politicsandwar.com/nation/id=${member.nationId}`;
              const embed = new EmbedBuilder()
                .setTitle('💎 Deposit Credited to Safekeeping')
                .setDescription(`[${member.nationName}](${nationUrl})`)
                .addFields(
                  { name: 'Deposit', value: lines.join(' · ') || '—', inline: false },
                  { name: 'Note', value: r.note || '—', inline: false }
                )
                .setFooter({ text: `Bankrec #${r.id} • ${new Date(r.date).toLocaleString()}` })
                .setColor(Colors.Blurple);
              await user.send({ embeds: [embed] });
            } catch {}
          }
        }
        last = Math.max(last, Number(r.id));
      }

      if (last && last !== (a.lastBankrecId || 0)) {
        await prisma.alliance.update({ where: { id: a.id }, data: { lastBankrecId: last } });
      }
    } catch (err) {
      log.error({ err }, 'bank monitor failed for alliance');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
