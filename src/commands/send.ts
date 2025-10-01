// src/commands/send.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  Colors,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open } from "../lib/crypto.js";

const prisma = new PrismaClient();

function parseNumericIdFromInput(input: string): number | null {
  const raw = input.trim();
  const match = raw.match(/id\s*=\s*(\d+)/i);
  if (match?.[1]) {
    const n = Number(match[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length) {
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function nice(n: number) {
  return n.toLocaleString("en-US");
}

async function getAllianceByGuild(guildId?: string | null) {
  if (!guildId) return null;
  return prisma.alliance.findFirst({
    where: { guildId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
}
async function getMember(allianceId: number, discordId: string) {
  return prisma.member.findFirst({
    where: { allianceId, discordId },
    include: { balance: true },
  });
}
async function ensureSafekeeping(memberId: number) {
  let sk = await prisma.safekeeping.findFirst({ where: { memberId } });
  if (!sk) {
    sk = await prisma.safekeeping.create({
      data: {
        memberId,
        money: 0, food: 0, coal: 0, oil: 0, uranium: 0,
        lead: 0, iron: 0, bauxite: 0, gasoline: 0,
        munitions: 0, steel: 0, aluminum: 0,
      },
    });
  }
  return sk;
}

export const data = new SlashCommandBuilder()
  .setName("send")
  .setDescription("Send from your Safekeeping: pick Nation or Alliance, then fill the modal.");

export async function execute(i: ChatInputCommandInteraction) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("send:pick:nation").setLabel("Send to Nation").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("send:pick:alliance").setLabel("Send to Alliance").setStyle(ButtonStyle.Secondary),
  );
  await i.reply({
    content: "Choose where to send funds from your Safekeeping:",
    components: [row],
    ephemeral: true,
  });
}

export async function handleButton(i: ButtonInteraction) {
  if (i.customId === "send:pick:nation") {
    const modal = new ModalBuilder().setCustomId("send:modal:nation").setTitle("Send to Nation");
    const amount = new TextInputBuilder()
      .setCustomId("send:amount")
      .setLabel("Amount (money)")
      .setPlaceholder("e.g., 500000 or 2,000,000")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20);
    const nation = new TextInputBuilder()
      .setCustomId("send:recipient")
      .setLabel("Nation ID or Nation Link")
      .setPlaceholder("123456 or https://politicsandwar.com/nation/id=123456")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);
    const note = new TextInputBuilder()
      .setCustomId("send:note")
      .setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
      new ActionRowBuilder<TextInputBuilder>().addComponents(nation),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
    await i.showModal(modal);
    return;
  }

  if (i.customId === "send:pick:alliance") {
    const modal = new ModalBuilder().setCustomId("send:modal:alliance").setTitle("Send to Alliance");
    const amount = new TextInputBuilder()
      .setCustomId("send:amount")
      .setLabel("Amount (money)")
      .setPlaceholder("e.g., 500000 or 2,000,000")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20);
    const alliance = new TextInputBuilder()
      .setCustomId("send:recipient")
      .setLabel("Alliance ID or Alliance Link")
      .setPlaceholder("10304 or https://politicsandwar.com/alliance/id=10304")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(200);
    const note = new TextInputBuilder()
      .setCustomId("send:note")
      .setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(500);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
      new ActionRowBuilder<TextInputBuilder>().addComponents(alliance),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
    await i.showModal(modal);
    return;
  }
}

export async function handleModal(i: ModalSubmitInteraction) {
  const isNation = i.customId === "send:modal:nation";
  const isAlliance = i.customId === "send:modal:alliance";
  if (!isNation && !isAlliance) return;

  const rawAmt = (i.fields.getTextInputValue("send:amount") || "").trim();
  const rawRecipient = (i.fields.getTextInputValue("send:recipient") || "").trim();
  const note = (i.fields.getTextInputValue("send:note") || "").trim();

  const amount = Number(rawAmt.replace(/[,$\s_]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    await i.reply({ ephemeral: true, content: "❌ Amount must be a positive number." });
    return;
  }
  const recipientId = parseNumericIdFromInput(rawRecipient);
  if (!recipientId) {
    await i.reply({
      ephemeral: true,
      content: isNation
        ? "❌ Please provide a valid **Nation** ID or nation link containing `id=...`."
        : "❌ Please provide a valid **Alliance** ID or alliance link containing `id=...`.",
    });
    return;
  }

  const alliance = await getAllianceByGuild(i.guildId);
  if (!alliance) return i.reply({ content: "This server is not linked yet. Run /setup_alliance first.", ephemeral: true });
  const member = await getMember(alliance.id, i.user.id);
  if (!member) return i.reply({ content: "❌ You’re not linked to a Member yet. Use /link_nation first.", ephemeral: true });

  const sk = await ensureSafekeeping(member.id);
  if ((sk.money ?? 0) < amount) {
    return i.reply({
      ephemeral: true,
      content: `❌ Insufficient Safekeeping balance.\nAvailable: $${nice(sk.money ?? 0)} • Requested: $${nice(amount)}`,
    });
  }

  // Create PENDING request with metadata.
  const data: any = {
    allianceId: alliance.id,
    memberId: member.id,
    createdBy: i.user.id,
    status: "PENDING",
    payload: { money: amount },
    note: note || null,                 // if present in your schema
    kind: isNation ? "NATION" : "ALLIANCE", // if enum present
  };
  if (isNation) data.recipientNationId = recipientId;          // if column exists
  if (isAlliance) data.recipientAllianceId = recipientId;      // if column exists

  const wr = await prisma.withdrawalRequest.create({ data });

  // Post to review channel with Approve/Reject buttons **specific to send**
  const title = isNation ? "💸 Send Request — Nation" : "💸 Send Request — Alliance";
  const desc = isNation
    ? `From <@${i.user.id}> → Nation ID **${recipientId}**`
    : `From <@${i.user.id}> → Alliance ID **${recipientId}**`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .addFields(
      { name: "Amount (money)", value: `$${nice(amount)}`, inline: true },
      { name: "Request ID", value: String(wr.id), inline: true },
      { name: "Note", value: note ? note : "—", inline: false },
    )
    .setColor(Colors.Gold)
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`s:approve:${wr.id}`).setLabel("Approve Send").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`s:deny:${wr.id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

  const targetChannelId = alliance.reviewChannelId || i.channelId;
  try {
    const ch = await i.client.channels.fetch(targetChannelId);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error("[send] failed to post review", err);
  }

  // Ephemeral confirmation
  const conf = new EmbedBuilder()
    .setTitle("Send Request Submitted")
    .setDescription("Your request is pending banker review.")
    .addFields(
      { name: "Amount", value: `$${nice(amount)}`, inline: true },
      { name: isNation ? "Nation ID" : "Alliance ID", value: String(recipientId), inline: true },
      { name: "Request ID", value: String(wr.id), inline: true },
    )
    .setColor(Colors.Blurple);
  await i.reply({ embeds: [conf], ephemeral: true });
}

// --- Banker Approve/Reject buttons for SEND requests ---
export async function handleApprovalButton(i: ButtonInteraction) {
  // IDs look like: s:approve:<id> or s:deny:<id>
  const [prefix, action, id] = i.customId.split(":");
  if (prefix !== "s" || !id) return;

  if (!i.memberPermissions?.has("ManageGuild" as any)) {
    return i.reply({ content: "You lack permission to approve/deny.", ephemeral: true });
  }

  const req = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!req) return i.reply({ content: "Request not found.", ephemeral: true });
  if (req.status !== "PENDING") return i.reply({ content: `Already ${req.status}.`, ephemeral: true });

  if (action === "deny") {
    await prisma.withdrawalRequest.update({
      where: { id },
      data: { status: "REJECTED", reviewerId: i.user.id },
    });

    // disable buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`s:approve:${id}`).setLabel("Approve Send").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`s:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    const embed = new EmbedBuilder().setTitle("❌ Send Request Rejected").setDescription(`Request **${id}**`).setColor(Colors.Red);
    await i.update({ embeds: [embed], components: [row] });

    // attempt DM
    try {
      const member = await prisma.member.findUnique({ where: { id: req.memberId } });
      if (member) {
        const user = await i.client.users.fetch(member.discordId);
        await user.send({ embeds: [new EmbedBuilder().setTitle("❌ Send Request Rejected").setDescription(`Request **${id}**`).setColor(Colors.Red)] });
      }
    } catch {}
    return;
  }

  // APPROVE → attempt to pay in-game
  const alliance = await prisma.alliance.findUnique({
    where: { id: req.allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const member = await prisma.member.findUnique({ where: { id: req.memberId } });

  // resolve keys
  const apiKeyEnc = alliance?.keys?.[0];
  const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  const botKey = process.env.PNW_BOT_KEY || "";

  if (!member || !apiKey || !botKey) {
    await prisma.withdrawalRequest.update({
      where: { id },
      data: { status: "APPROVED", reviewerId: i.user.id },
    });
    return i.reply({ content: "⚠️ Approved, but missing API/Bot key; manual pay required.", ephemeral: true });
  }

  const payload = (req.payload as any) || {};
  const money = Number(payload.money || 0);
  if (!(money > 0)) {
    return i.reply({ content: "Invalid payload: no money amount.", ephemeral: true });
  }

  // determine recipient (Nation vs Alliance)
  const kind: string = (req as any).kind || "NATION";
  const nationId = (req as any).recipientNationId as number | null;
  const allianceId = (req as any).recipientAllianceId as number | null;

  const isNation = kind === "NATION" && Number(nationId) > 0;
  const isAlliance = kind === "ALLIANCE" && Number(allianceId) > 0;
  if (!isNation && !isAlliance) {
    return i.reply({ content: "Missing or invalid recipient.", ephemeral: true });
  }

  // Build GraphQL mutation
  const fields: string[] = [`money:${money}`];
  const note = (req as any).note ? String((req as any).note) : `GemstoneTools SEND ${req.id} • reviewer ${i.user.id}`;
  fields.push(`note:${JSON.stringify(note)}`);

  const receiver = isNation ? nationId! : allianceId!;
  const receiver_type = isNation ? 1 : 2; // 1=nation, 2=alliance

  const q = `mutation{
    bankWithdraw(receiver:${receiver}, receiver_type:${receiver_type}, ${fields.join(",")}) { id }
  }`;

  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Bot-Key": botKey,
    },
    body: JSON.stringify({ query: q }),
  });
  const data = await res.json().catch(() => ({} as any));
  const ok = res.ok && !(data as any).errors && (data as any)?.data?.bankWithdraw;

  if (!ok) {
    console.error("SEND_AUTOPAY_ERR", res.status, JSON.stringify(data));
    await prisma.withdrawalRequest.update({
      where: { id },
      data: { status: "APPROVED", reviewerId: i.user.id },
    });
    return i.reply({ content: "⚠️ Approved, but in-game send failed. Please pay manually.", ephemeral: true });
  }

  // Deduct from Safekeeping and mark PAID
  const dec: any = { money: { decrement: money } };
  await prisma.safekeeping.update({ where: { memberId: member.id }, data: dec });
  await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PAID", reviewerId: i.user.id } });

  // disable buttons + update message
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`s:approve:${id}`).setLabel("Approve Send").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`s:deny:${id}`).setLabel("Deny").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
  );
  const embed = new EmbedBuilder()
    .setTitle("✅ Send Approved & Paid")
    .setDescription(`Request **${id}** — sent ${isNation ? `to Nation ${nationId}` : `to Alliance ${allianceId}`}`)
    .addFields({ name: "Amount", value: `$${nice(money)}` })
    .setColor(Colors.Green);
  await i.update({ embeds: [embed], components: [row] });

  // DM requester
  try {
    const u = await i.client.users.fetch(member.discordId);
    const dm = new EmbedBuilder()
      .setTitle("💵 Send Completed")
      .setDescription(`Your request **${id}** has been sent in-game.`)
      .addFields(
        { name: "Recipient", value: isNation ? `Nation ${nationId}` : `Alliance ${allianceId}`, inline: true },
        { name: "Amount", value: `$${nice(money)}`, inline: true },
      )
      .setColor(Colors.Blurple);
    await u.send({ embeds: [dm] });
  } catch {}
}
