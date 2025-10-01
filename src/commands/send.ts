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

/** We stash all send metadata under payload.__send to avoid schema changes */
type SendMeta = {
  kind: "NATION" | "ALLIANCE";
  recipientId: number;
  note?: string | null;
};

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
  if (i.customId === "send:pick:nation" || i.customId === "send:pick:alliance") {
    const isNation = i.customId === "send:pick:nation";
    const modal = new ModalBuilder()
      .setCustomId(isNation ? "send:modal:nation" : "send:modal:alliance")
      .setTitle(isNation ? "Send to Nation" : "Send to Alliance");

    const amount = new TextInputBuilder()
      .setCustomId("send:amount").setLabel("Amount (money)")
      .setPlaceholder("e.g., 500000 or 2,000,000").setStyle(TextInputStyle.Short)
      .setRequired(true).setMaxLength(20);

    const recip = new TextInputBuilder()
      .setCustomId("send:recipient")
      .setLabel(isNation ? "Nation ID or Nation Link" : "Alliance ID or Alliance Link")
      .setPlaceholder(isNation ? "123456 or https://politicsandwar.com/nation/id=123456"
                               : "10304 or https://politicsandwar.com/alliance/id=10304")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);

    const note = new TextInputBuilder()
      .setCustomId("send:note").setLabel("Note (optional)")
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(amount),
      new ActionRowBuilder<TextInputBuilder>().addComponents(recip),
      new ActionRowBuilder<TextInputBuilder>().addComponents(note),
    );
    await i.showModal(modal);
  }
}

// ------------------ modal submit → create request + POST FOR REVIEW ------------------
export async function handleModal(i: ModalSubmitInteraction) {
  const isNation = i.customId === "send:modal:nation";
  const isAlliance = i.customId === "send:modal:alliance";
  if (!isNation && !isAlliance) return;

  try {
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
    if (!alliance) { await i.reply({ ephemeral: true, content: "This server is not linked yet. Run /setup_alliance first." }); return; }

    const member = await getMember(alliance.id, i.user.id);
    if (!member) { await i.reply({ ephemeral: true, content: "❌ You’re not linked to a Member yet. Use /link_nation first." }); return; }

    const sk = await ensureSafekeeping(member.id);
    if ((sk.money ?? 0) < amount) {
      await i.reply({
        ephemeral: true,
        content: `❌ Insufficient Safekeeping balance.\nAvailable: $${nice(sk.money ?? 0)} • Requested: $${nice(amount)}`,
      });
      return;
    }

    // Build payload with embedded send meta
    const meta: SendMeta = {
      kind: isNation ? "NATION" : "ALLIANCE",
      recipientId,
      note: note || null,
    };
    const payload: any = { money: amount, __send: meta };

    const wr = await prisma.withdrawalRequest.create({
      data: {
        allianceId: alliance.id,
        memberId: member.id,
        createdBy: i.user.id,
        status: "PENDING",
        payload,
      },
    });

    // Post to review channel with send-specific approve/deny
    const e = new EmbedBuilder()
      .setTitle(isNation ? "💸 Send Request — Nation" : "💸 Send Request — Alliance")
      .setDescription(`From <@${i.user.id}> — ${member.nationName} (${member.nationId})`)
      .addFields(
        { name: "Amount", value: `$${nice(amount)}`, inline: true },
        { name: isNation ? "Nation ID" : "Alliance ID", value: String(recipientId), inline: true },
        { name: "Note", value: note || "—", inline: false },
        { name: "Request ID", value: String(wr.id), inline: true },
        { name: "Kind", value: meta.kind, inline: true },
      )
      .setColor(Colors.Gold)
      .setTimestamp(new Date());

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${wr.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`send:req:deny:${wr.id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger),
    );

    await i.reply({ ephemeral: true, content: "✅ Your send request has been submitted for banker review." });

    const targetChannelId = alliance.reviewChannelId || i.channelId!;
    try {
      const ch = await i.client.channels.fetch(targetChannelId);
      if (ch?.isTextBased()) await (ch as any).send({ embeds: [e], components: [row] });
    } catch (err) {
      console.error("send post error", err);
    }
  } catch (err) {
    console.error("send modal fatal", err);
    try { await i.reply({ ephemeral: true, content: "Something went wrong." }); } catch {}
  }
}

// ------------------ banker Approve/Reject buttons (execute payment) ------------------
export async function handleApprovalButton(i: ButtonInteraction) {
  if (!i.guildId) return i.reply({ content: "Guild only.", ephemeral: true });
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You lack permission to approve/deny.", ephemeral: true });
  }

  try {
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

    const money = Number((req.payload as any)?.money || 0);
    const meta: SendMeta | undefined = (req.payload as any)?.__send;
    if (!Number.isFinite(money) || money <= 0 || !meta?.recipientId || !meta?.kind) {
      return i.reply({ content: "Invalid send payload.", ephemeral: true });
    }

    if (!approve) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "REJECTED", reviewerId: i.user.id } });
      try {
        const user = await i.client.users.fetch(member.discordId);
        await user.send({
          embeds: [new EmbedBuilder()
            .setTitle("❌ Send Request Rejected")
            .setDescription(`Request **${id}** was rejected by <@${i.user.id}>`)
            .setColor(Colors.Red)],
        });
      } catch {}
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
      );
      await i.update({ components: [row] });
      return;
    }

    // APPROVE → attempt autopay to nation (1) or alliance (2)
    const apiKeyEnc = alliance.keys?.[0];
    // Lazy import crypto.open only when needed
    const { open } = await import("../lib/crypto.js");
    const apiKey = apiKeyEnc ? open(apiKeyEnc.encryptedApiKey as any, apiKeyEnc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
    const botKey = process.env.PNW_BOT_KEY || "";
    if (!apiKey || !botKey) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });
      return i.reply({ content: "⚠️ Missing API/Bot key. Marked APPROVED; pay manually.", ephemeral: true });
    }

    const receiverType: 1 | 2 = meta.kind === "ALLIANCE" ? 2 : 1;
    const note = `GemstoneTools SEND ${id} • reviewer ${i.user.id}${meta.note ? " • " + meta.note : ""}`;

    const ok = await pnwBankWithdraw({
      apiKey, botKey, receiverId: meta.recipientId, receiverType, money, note,
    });

    if (!ok) {
      await prisma.withdrawalRequest.update({ where: { id }, data: { status: "APPROVED", reviewerId: i.user.id } });
      return i.reply({ content: "⚠️ PnW transfer failed. Left as APPROVED; retry manually.", ephemeral: true });
    }

    // Deduct from safekeeping, mark PAID
    try {
      await prisma.safekeeping.update({ where: { memberId: member.id }, data: { money: { decrement: money } } });
    } catch (e) {
      console.error("safekeeping decrement failed", e);
    }
    await prisma.withdrawalRequest.update({ where: { id }, data: { status: "PAID", reviewerId: i.user.id } });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`send:req:approve:${id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`send:req:deny:${id}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger).setDisabled(true),
    );
    const emb = new EmbedBuilder()
      .setTitle("✅ Send Approved & Paid")
      .setDescription(`Request **${id}** sent in-game.`)
      .addFields(
        { name: "Amount", value: `$${nice(money)}`, inline: true },
        { name: "Recipient", value: `${meta.kind} ${String(meta.recipientId)}`, inline: true },
      )
      .setColor(Colors.Green);
    await i.update({ embeds: [emb], components: [row] });

    try {
      const user = await i.client.users.fetch(member.discordId);
      await user.send({
        embeds: [new EmbedBuilder()
          .setTitle("💵 Send Paid")
          .setDescription(`Your send request **${id}** has been executed.`)
          .addFields({ name: "Amount", value: `$${nice(money)}` })
          .setColor(Colors.Blurple)],
      });
    } catch {}

  } catch (err) {
    console.error("send approval fatal", err);
    try { await i.reply({ content: "Something went wrong.", ephemeral: true }); } catch {}
  }
}
