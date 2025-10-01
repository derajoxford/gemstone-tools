// src/commands/send.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Colors,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ------------------ helpers ------------------
function parseNumericIdFromInput(input: string): number | null {
  const raw = input.trim();
  const m = raw.match(/id\s*=\s*(\d+)/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digits = raw.replace(/[^\d]/g, "");
  if (digits) {
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

// --- minimal GQL caller for PnW bankWithdraw ---
async function pnwBankWithdraw(opts: {
  apiKey: string;
  botKey: string;
  receiverId: number;
  receiverType: 1 | 2; // 1 = Nation, 2 = Alliance
  money: number;
  note?: string;
}): Promise<boolean> {
  const fields = [`money:${Math.floor(opts.money)}`];
  if (opts.note) fields.push(`note:${JSON.stringify(opts.note)}`);
  const query = `mutation{ bankWithdraw(receiver:${opts.receiverId}, receiver_type:${opts.receiverType}, ${fields.join(",")}) { id } }`;
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(opts.apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": opts.apiKey,
      "X-Bot-Key": opts.botKey,
    },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || (data as any)?.errors) {
    console.error("SEND_AUTOPAY_ERR", res.status, JSON.stringify(data));
    return false;
  }
  return Boolean((data as any)?.data?.bankWithdraw);
}

// ------------------ slash command ------------------
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

// ------------------ picker buttons → open modals ------------------
export async function handleButton(i: ButtonInteraction) {
  if (i.customId === "send:pick:nation") {
    const modal = new ModalBuilder().setCustomId("send:modal:nation").setTitle("Send to Nation");
    const amount = new TextInputBuilder()
      .setCustomId("send:amount").setLabel("Amount (money)")
      .setPlaceholder("e.g., 500000 or 2,000,000").setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(20);
    const nation = new TextInputBuilder()
      .setCustomId("send:recipient").setLabel("Nation ID or Nation Link")
      .setPlaceholder("123456 or https://politicsandwar.com/nation/id=123456")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    const note = new TextInputBuilder()
      .setCustomId("send:note").setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);

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
      .setCustomId("send:amount").setLabel("Amount (money)")
      .setPlaceholder("e.g., 500000 or 2,000,000").setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(20);
    const alliance = new TextInputBuilder()
      .setCustomId("send:recipient").setLabel("Alliance ID or Alliance Link")
      .setPlaceholder("10304 or https://politicsandwar.com/alliance/id=10304")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    const note = new TextInputBuilder()
      .setCustomId("send:note").setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
      new ActionRowBuilder<TextInputBuilder>().addComponents(alliance),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
    await i.showModal(modal);
    return;
  }
}

// ------------------ modal submit → create request + POST FOR REVIEW ------------------
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
  if (!alliance) return i.reply({ ephemeral: true, content: "This server is not linked yet. Run /setup_alliance first." });

  const member = await getMember(alliance.id, i.user.id);
  if (!member) return i.reply({ ephemeral: true, content: "❌ You’re not linked to a Member yet. Use /link_nation first." });

  const sk = await ensureSafekeeping(member.id);
  if ((sk.money ?? 0) < amount) {
    await i.reply({
      ephemeral: true,
      content: `❌ Insufficient Safekeeping balance.\nAvailable: $${nice(sk.money ?? 0)} • Requested: $${nice(amount)}`,
    });
    return;
  }

  // Create the pending request; include send-specific metadata if columns exist.
  const data: any = {
    allianceId: alliance.id,
    memberId: member.id,
    createdBy: i.user.id,
    status: "PENDING",
    payload: { money: amount },
    note: note || null,                    // if your schema has this column
    kind: isNation ? "NATION" : "ALLIANCE" // if your schema has this enum
  };
  if (isNation) data.recipientNationId = recipientId;      // if column exists
  if (isAlliance) data.recipientAllianceId = recipientId;  // if column exists

  const wr = await prisma.withdrawalRequest.create({ data });

  // Post to review channel with custom Approve/Reject (send-specific)
  const e = new EmbedBuilder()
    .setTitle(isNation ? "💸 Send Request — Nation" : "💸 Send Request — Alliance")
    .setDescription(`From <@${i.user.id}> — ${member.nationName} (${member.nationId})`)
    .addFields(
      { name: "Amount", value: `$${nice(amount)}`, inline: true },
      { name: isNation ? "Nation ID" : "Alliance ID", value: String(recipientId), inline: true },
      { name: "Note", value: note || "—", inline: false },
      { name: "Request ID", value: String(wr.id), inline: true },
      { name: "Kind", value: isNation ? "NATION" : "ALLIANCE", inline: true },
    )
    .setColor(Colors.Gold)
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:req:approve:${wr.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`send:req:deny:${wr.id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

  // Send confirmation to requester
  await i.reply({ ephemeral: true, content: "✅ Your send request has been submitted for banker review." });

  const targetChannelId = alliance.reviewChannelId || i.channelId!;
  try {
    const ch = await i.client.channels.fetch(targetChannelId);
    if (ch?.isTextBased()) await (ch as any).send({ embeds: [e], components: [row] });
  } catch (err) {
    console.error("send post error", err);
  }
}

// ------------------ banker Approve/Reject buttons (execute payment) ------------------
export async function handleApprovalButton(i: ButtonInteraction) {
  if (!i.guildId) return i.reply({ content: "Guild only.", ephemeral: true });

  // Permission gate
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You lack permission to approve/deny.", ephemeral: true });
  }

  const mApprove = i.customId.match(/^send:req:approve:(.+)$/);
  const mDeny = i.customId.match(/^send:req:deny:(.+)$/);
  if (!mApprove && !mDeny) return;

  const id = String((mApprove || mDeny)![1]);
  const approve = Boolean(mApprove);

  const req = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!req) return i.reply({ content: "Request not found.", ephemeral: true });
  if (req.status !== "PENDING") return i.reply({ content: `Already ${req.status}.`, ephemeral: true });

  const alliance = await getAllianceByGuild(i.guildId);
  if (!alliance) return i.reply({ content: "Alliance not linked in this server.", ephemeral: true });

  const member = await prisma.member.findUnique({ where: { id: req.memberId }, include: { balance: true } });
  if (!member) return i.reply({ content: "Member not found.", ephemeral: true });

  if (!approve) {
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "REJECTED", reviewerId: i.user.id } });
    try {
      const user = await i.client.users.fetch(member.discordId);
      await user.send({ embeds: [new EmbedBuilder()
        .setTitle("❌ Send Request Rejected")
        .setDescription(`Request **${id}** was rejected by <@${i.user.id}>`)
        .setColor(Colors.Red)] });
    } catch {}
    // disable buttons
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    await i.update({ components: [row] });
    return;
  }

  // APPROVE path → attempt autopay to correct recipient
  const money = Number((req.payload as any)?.money || 0);
  if (!Number.isFinite(money) || money <= 0) {
    return i.reply({ content: "Invalid amount in payload.", ephemeral: true });
  }

  // keys
  const apiKeyEnc = alliance.keys?.[0];
  const apiKey = apiKeyEnc ? (await import("../lib/crypto.js")).open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  const botKey = process.env.PNW_BOT_KEY || "";
  if (!apiKey || !botKey) {
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });
    return i.reply({ content: "⚠️ Missing API/Bot key. Marked APPROVED; pay manually.", ephemeral: true });
  }

  // Determine receiver
  let receiverType: 1 | 2;
  let receiverId: number;
  const kind: string = (req as any).kind || "NATION";
  if (kind === "ALLIANCE") {
    const aid = Number((req as any).recipientAllianceId || 0);
    if (!aid) return i.reply({ content: "Missing recipientAllianceId.", ephemeral: true });
    receiverType = 2; receiverId = aid;
  } else {
    const nid = Number((req as any).recipientNationId || 0);
    if (!nid) return i.reply({ content: "Missing recipientNationId.", ephemeral: true });
    receiverType = 1; receiverId = nid;
  }

  const note = `GemstoneTools SEND ${id} • reviewer ${i.user.id}`;
  const ok = await pnwBankWithdraw({
    apiKey, botKey, receiverId, receiverType, money, note,
  });

  if (!ok) {
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });
    return i.reply({ content: "⚠️ PnW transfer failed. Left as APPROVED; retry manually.", ephemeral: true });
  }

  // Deduct from safekeeping, mark PAID
  const dec: any = { money: { decrement: money } };
  try {
    await prisma.safekeeping.update({ where: { memberId: member.id }, data: dec });
  } catch (e) {
    console.error("safekeeping decrement failed", e);
  }
  await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PAID", reviewerId: i.user.id } });

  // Disable buttons + success embed
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
  );
  const emb = new EmbedBuilder()
    .setTitle("✅ Send Approved & Paid")
    .setDescription(`Request **${id}** sent in-game.`)
    .addFields(
      { name: "Amount", value: `$${nice(money)}`, inline: true },
      { name: "Recipient", value: kind === "ALLIANCE" ? `Alliance ${String((req as any).recipientAllianceId)}` : `Nation ${String((req as any).recipientNationId)}`, inline: true },
    )
    .setColor(Colors.Green);
  await i.update({ embeds: [emb], components: [row] });

  // DM requester
  try {
    const user = await i.client.users.fetch(member.discordId);
    await user.send({ embeds: [new EmbedBuilder()
      .setTitle("💵 Send Paid")
      .setDescription(`Your send request **${id}** has been executed.`)
      .addFields({ name: "Amount", value: `$${nice(money)}` })
      .setColor(Colors.Blurple)] });
  } catch {}
}
