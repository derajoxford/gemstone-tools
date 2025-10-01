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
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---------- helpers ----------
function parseNumericIdFromInput(input: string): number | null {
  // Accept either plain number or any link containing id=12345 or /id=12345
  const raw = input.trim();
  const match = raw.match(/id\s*=\s*(\d+)/i);
  if (match?.[1]) {
    const n = Number(match[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // If not a link, permit plain integer
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length) {
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

async function getMemberByDiscord(discordId: string) {
  // Adjust field name if your schema differs (we've used Member.discordId in prior work)
  return prisma.member.findFirst({ where: { discordId } });
}

async function getSafekeeping(memberId: number) {
  // Ensure a row exists; create zeros if missing
  let sk = await prisma.safekeeping.findFirst({ where: { memberId } });
  if (!sk) {
    sk = await prisma.safekeeping.create({
      data: {
        memberId,
        money: 0,
        food: 0,
        coal: 0,
        oil: 0,
        uranium: 0,
        lead: 0,
        iron: 0,
        bauxite: 0,
        gasoline: 0,
        munitions: 0,
        steel: 0,
        aluminum: 0,
      },
    });
  }
  return sk;
}

function nice(n: number) {
  return n.toLocaleString("en-US");
}

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName("send")
  .setDescription("Send from your Safekeeping: choose Nation or Alliance, then fill the modal.");

// On /send => show two buttons (NO autodetect)
export async function execute(i: ChatInputCommandInteraction) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("send:pick:nation")
      .setLabel("Send to Nation")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("send:pick:alliance")
      .setLabel("Send to Alliance")
      .setStyle(ButtonStyle.Secondary),
  );

  await i.reply({
    content: "Choose where to send funds from your Safekeeping:",
    components: [row],
    ephemeral: true,
  });
}

// ---------- button handlers: open modals ----------
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

// ---------- modal handlers: validate + create request ----------
export async function handleModal(i: ModalSubmitInteraction) {
  const isNation = i.customId === "send:modal:nation";
  const isAlliance = i.customId === "send:modal:alliance";
  if (!isNation && !isAlliance) return;

  // Inputs
  const rawAmt = (i.fields.getTextInputValue("send:amount") || "").trim();
  const rawRecipient = (i.fields.getTextInputValue("send:recipient") || "").trim();
  const note = (i.fields.getTextInputValue("send:note") || "").trim();

  // Amount → number
  const amount = Number(rawAmt.replace(/[,$\s_]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    await i.reply({ ephemeral: true, content: "❌ Amount must be a positive number." });
    return;
  }

  // Recipient ID (only numeric parsing; we DO NOT infer type)
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

  // Member + balance
  const member = await getMemberByDiscord(i.user.id);
  if (!member) {
    await i.reply({ ephemeral: true, content: "❌ You’re not linked to a Member yet. Use /link_nation first." });
    return;
  }

  const sk = await getSafekeeping(member.id);
  if ((sk.money ?? 0) < amount) {
    await i.reply({
      ephemeral: true,
      content: `❌ Insufficient Safekeeping balance.\nAvailable: $${nice(sk.money ?? 0)} • Requested: $${nice(amount)}`,
    });
    return;
  }

  // Create PENDING request. We do NOT deduct yet; deduction happens on approval.
  const data: any = {
    memberId: member.id,
    // If your schema uses JSON 'resources', keep as below. If columns, adapt.
    resources: { money: amount },
    status: "PENDING", // your existing WithdrawalStatus enum value
    kind: isNation ? "NATION" : "ALLIANCE", // your WithdrawalKind enum
    note: note || null,
  };
  if (isNation) data.recipientNationId = recipientId;
  if (isAlliance) data.recipientAllianceId = recipientId;

  const wr = await prisma.withdrawalRequest.create({ data });

  // Confirm to requester
  const e = new EmbedBuilder()
    .setTitle(isNation ? "Send to Nation — Request Submitted" : "Send to Alliance — Request Submitted")
    .setDescription("Your request will be reviewed by a Banker before it’s executed in-game.")
    .addFields(
      { name: "Amount", value: `$${nice(amount)}`, inline: true },
      {
        name: isNation ? "Nation ID" : "Alliance ID",
        value: String(recipientId),
        inline: true,
      },
      { name: "Note", value: note ? note : "—", inline: false },
      { name: "Request ID", value: String(wr.id), inline: true },
      { name: "Kind", value: isNation ? "NATION" : "ALLIANCE", inline: true },
    )
    .setFooter({ text: "Gemstone Tools • Safekeeping ➜ Recipient" })
    .setTimestamp(new Date());

  await i.reply({ ephemeral: true, embeds: [e] });

  // Step 3 (next message): I’ll wire this into your approvals channel with Approve/Reject buttons,
  // and on Approve we’ll deduct Safekeeping and mark processed.
}
