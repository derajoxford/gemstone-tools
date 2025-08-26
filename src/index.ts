import 'dotenv/config';
import {
  Client, GatewayIntentBits, Routes, Partials, REST, ModalBuilder, TextInputBuilder,
  TextInputStyle, ActionRowBuilder, SlashCommandBuilder, ChatInputCommandInteraction,
  EmbedBuilder, Colors, PermissionFlagsBits
} from 'discord.js';
import pino from 'pino';
import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { seal, open } from './lib/crypto.js';
import { RES_EMOJI, ORDER } from './lib/emojis.js';
import { fetchBankrecs } from './lib/pnw.js';

const log = pino({ level: 'info' });
const prisma = new PrismaClient();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

// --- Slash command registration (global) ---
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
const commands = [
  new SlashCommandBuilder().setName('setup_alliance')
    .setDescription('Link this Discord to a PnW Alliance banking setup')
    .addIntegerOption(o=>o.setName('alliance_id').setDescription('PnW Alliance ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('link_nation')
    .setDescription('Link your Discord to your PnW nation for safekeeping')
    .addIntegerOption(o=>o.setName('nation_id').setDescription('Your nation id').setRequired(true))
    .addStringOption(o=>o.setName('nation_name').setDescription('Your nation name').setRequired(true)),
  new SlashCommandBuilder().setName('balance')
    .setDescription('Show your safekeeping balance'),
  new SlashCommandBuilder().setName('withdraw')
    .setDescription('Request a withdrawal from your safekeeping')
    .addStringOption(o=>o.setName('payload').setDescription('JSON of resources {money:1000000, steel:500}').setRequired(true))
].map(c => c.toJSON());

async function register() {
  const appId = process.env.DISCORD_CLIENT_ID!;
  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    log.info('Slash commands registered');
  } catch (e) {
    log.error(e);
  }
}

client.once('ready', async () => {
  log.info({ tag: client.user?.tag }, 'Gemstone Tools online ✨');
  await register();
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === 'setup_alliance') return handleSetupAlliance(i);
    if (i.commandName === 'link_nation') return handleLinkNation(i);
    if (i.commandName === 'balance') return handleBalance(i);
    if (i.commandName === 'withdraw') return handleWithdraw(i);
  } catch (err) {
    console.error(err);
    if (i.isRepliable()) await i.reply({ content: 'Something went wrong.', ephemeral: true });
  }
});

// --- handlers ---
async function handleSetupAlliance(i: ChatInputCommandInteraction) {
  const allianceId = i.options.getInteger('alliance_id', true);
  const modal = new ModalBuilder().setCustomId(`alliancekeys:${allianceId}`).setTitle('Alliance API Keys');
  const api = new TextInputBuilder().setCustomId('apiKey').setLabel('Alliance API Key').setStyle(TextInputStyle.Short).setRequired(true);
  const bot = new TextInputBuilder().setCustomId('botKey').setLabel('Alliance Bot (Mutations) Key').setStyle(TextInputStyle.Short).setRequired(false);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(api), new ActionRowBuilder<TextInputBuilder>().addComponents(bot));
  await i.showModal(modal);
}

client.on('interactionCreate', async (i) => {
  if (!i.isModalSubmit()) return;
  if (!i.customId.startsWith('alliancekeys:')) return;
  const allianceId = parseInt(i.customId.split(':')[1]!, 10);
  const apiKey = i.fields.getTextInputValue('apiKey');
  const botKey = i.fields.getTextInputValue('botKey');
  const { ciphertext: encApi, iv: ivApi } = seal(apiKey);
  const encBot = botKey ? seal(botKey) : null;
  await prisma.alliance.upsert({
    where: { id: allianceId },
    update: { guildId: i.guildId ?? undefined },
    create: { id: allianceId, guildId: i.guildId ?? undefined }
  });
  await prisma.allianceKey.create({ data: {
    allianceId,
    encryptedApiKey: encApi,
    nonceApi: ivApi,
    encryptedBotKey: encBot?.ciphertext,
    nonceBot: encBot?.iv,
    addedBy: i.user.id
  }});
  await i.reply({ content: `✅ Keys saved for alliance ${allianceId}. Bank monitor will start shortly.`, ephemeral: true });
});

async function handleLinkNation(i: ChatInputCommandInteraction) {
  const nationId = i.options.getInteger('nation_id', true);
  const nationName = i.options.getString('nation_name', true);
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'This server is not linked to an alliance yet. Run /setup_alliance first.', ephemeral: true });

  await prisma.member.upsert({
    where: { allianceId_discordId: { allianceId: alliance.id, discordId: i.user.id } },
    update: { nationId, nationName },
    create: { allianceId: alliance.id, discordId: i.user.id, nationId, nationName }
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

async function handleWithdraw(i: ChatInputCommandInteraction) {
  const payloadRaw = i.options.getString('payload', true);
  const alliance = await prisma.alliance.findFirst({ where: { guildId: i.guildId ?? '' } });
  if (!alliance) return i.reply({ content: 'No alliance linked to this server yet.', ephemeral: true });
  const member = await prisma.member.findFirst({ where: { allianceId: alliance.id, discordId: i.user.id } });
  if (!member) return i.reply({ content: 'Link your nation first with /link_nation.', ephemeral: true });

  let payload: any;
  try { payload = JSON.parse(payloadRaw); }
  catch { return i.reply({ content: 'Invalid JSON.', ephemeral: true }); }

  const req = await prisma.withdrawalRequest.create({ data: {
    allianceId: alliance.id,
    memberId: member.id,
    payload,
    createdBy: i.user.id
  }});

  const embed = new EmbedBuilder()
    .setTitle('💸 Withdrawal Request')
    .setDescription(`Request **${req.id}** from <@${i.user.id}>`)
    .addFields(
      Object.entries(payload).map(([k,v]) => ({ name: `${RES_EMOJI[k]||''} ${k}`, value: String(v), inline: true }))
    )
    .setColor(Colors.Gold);

  await i.reply({ content: '✅ Request submitted for review by bankers.', ephemeral: true });
  const ch = await client.channels.fetch(i.channelId);
  if (ch && ch.isTextBased()) {
    await ch.send({ embeds: [embed] });
  }
}

// --- CRON: bank monitor (every 2 minutes) ---
cron.schedule('*/2 * * * *', async () => {
  const alliances = await prisma.alliance.findMany({ include: { keys: { orderBy: { id: 'desc' }, take: 1 } } });
  for (const a of alliances) {
    try {
      const k = a.keys[0];
      const apiKey = k ? open(k.encryptedApiKey as any, k.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY||'');
      if (!apiKey) continue;

      const alliancesData = await fetchBankrecs({ apiKey }, [a.id]);
      const al = alliancesData[0];
      if (!al || !al.bankrecs) continue;

      let last = a.lastBankrecId || 0;
      const rows = (al.bankrecs as any[]).filter(r => r.id > last).sort((x,y)=>x.id-y.id);
      for (const r of rows) {
        await prisma.bankrec.upsert({
          where: { id: r.id },
          update: {},
          create: {
            id: r.id,
            allianceId: a.id,
            date: new Date(r.date),
            note: r.note || null,
            senderType: r.sender_type,
            senderId: r.sender_id,
            receiverType: r.receiver_type,
            receiverId: r.receiver_id,
            money: r.money || 0,
            food: r.food || 0,
            coal: r.coal || 0,
            oil: r.oil || 0,
            uranium: r.uranium || 0,
            lead: r.lead || 0,
            iron: r.iron || 0,
            bauxite: r.bauxite || 0,
            gasoline: r.gasoline || 0,
            munitions: r.munitions || 0,
            steel: r.steel || 0,
            aluminum: r.aluminum || 0,
          }
        });

        // If nation -> alliance deposit, auto-credit member safekeeping
        const isDeposit = r.sender_type === 1 && r.receiver_type === 2 && r.receiver_id === a.id;
        if (isDeposit) {
          const member = await prisma.member.findFirst({ where: { allianceId: a.id, nationId: r.sender_id } });
          if (member) {
            await prisma.safekeeping.upsert({
              where: { memberId: member.id },
              update: {
                money: { increment: r.money || 0 },
                food: { increment: r.food || 0 },
                coal: { increment: r.coal || 0 },
                oil: { increment: r.oil || 0 },
                uranium: { increment: r.uranium || 0 },
                lead: { increment: r.lead || 0 },
                iron: { increment: r.iron || 0 },
                bauxite: { increment: r.bauxite || 0 },
                gasoline: { increment: r.gasoline || 0 },
                munitions: { increment: r.munitions || 0 },
                steel: { increment: r.steel || 0 },
                aluminum: { increment: r.aluminum || 0 },
              },
              create: { memberId: member.id }
            });

            // Optional: DM confirmation (ignore failures)
            try {
              const user = await client.users.fetch(member.discordId);
              await user.send(`💎 Deposit credited to your safekeeping. Note: ${r.note||''}`);
            } catch {}
          }
        }
        last = Math.max(last, r.id);
      }

      if (last && last !== (a.lastBankrecId||0)) {
        await prisma.alliance.update({ where: { id: a.id }, data: { lastBankrecId: last } });
      }
    } catch (err) {
      log.error({ err }, 'bank monitor failed for alliance');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
