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

const prisma = new PrismaClient();

// ---------- helpers ----------
function parseNumericIdFromInput(input: string): number | null {
  // Accept plain number or any link containing id=12345
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
  return prisma.alliance.findFirst({ where: { guildId } });
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

// ---------- slash command ----------
export const data = new SlashCommandBuilder()
  .setName("send")
  .setDescription("Send from your Safekeeping: pick Nation or Alliance, then fill the modal.");

// On /send => show two buttons (explicit choice; no autodetect)
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

// ---------- buttons → open the correct modal ----------
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

// ---------- modal submit → validate + create request (PENDING) ----------
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
  if (!alliance) {
    await i.reply({ ephemeral: true, content: "This server is not linked yet. Run /setup_alliance first." });
    return;
  }

  const member = await getMember(alliance.id, i.user.id);
  if (!member) {
    await i.reply({ ephemeral: true, content: "❌ You’re not linked to a Member yet. Use /link_nation first." });
    return;
  }

  const sk = await ensureSafekeeping(member.id);
  if ((sk.money ?? 0) < amount) {
    await i.reply({
      ephemeral: true,
      content: `❌ Insufficient Safekeeping balance.\nAvailable: $${nice(sk.money ?? 0)} • Requested: $${nice(amount)}`,
    });
    return;
  }

  // NOTE: We store only money for now; resources later if needed.
  // Matches your schema: WithdrawalRequest { allianceId, memberId, payload, createdBy, status, ... }
  // We also include our extra fields (kind/recipientX/note) if they exist in your Prisma schema.
  const data: any = {
    allianceId: alliance.id,
    memberId: member.id,
    createdBy: i.user.id,
    status: "PENDING",                 // WithdrawStatus
    payload: { money: amount },        // your JSON payload field
    note: note || null,                // if present in schema
    kind: isNation ? "NATION" : "ALLIANCE", // if enum field present (WithdrawalKind)
  };
  if (isNation) data.recipientNationId = recipientId;      // if column exists
  if (isAlliance) data.recipientAllianceId = recipientId;  // if column exists

  const wr = await prisma.withdrawalRequest.create({ data });

  // Ephemeral confirmation to requester. (Banker approval wiring comes next.)
  const e = new EmbedBuilder()
    .setTitle(isNation ? "Send to Nation — Request Submitted" : "Send to Alliance — Request Submitted")
    .setDescription("Your request is pending banker review.")
    .addFields(
      { name: "Amount", value: `$${nice(amount)}`, inline: true },
      { name: isNation ? "Nation ID" : "Alliance ID", value: String(recipientId), inline: true },
      { name: "Note", value: note ? note : "—", inline: false },
      { name: "Request ID", value: String(wr.id), inline: true },
      { name: "Kind", value: isNation ? "NATION" : "ALLIANCE", inline: true },
    )
    .setColor(Colors.Blurple)
    .setTimestamp(new Date());

  await i.reply({ ephemeral: true, embeds: [e] });

  // We intentionally DO NOT post to review channel yet to avoid using your generic
  // w:approve flow (which auto-pays to the requester). Next step will add a dedicated
  // approvals embed + buttons for "send" that pay the correct recipient.
}
