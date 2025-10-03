// src/commands/offshore.ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChatInputCommandInteraction,
  CommandInteraction,
  Interaction,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import type { CommandModule } from "./registry";
import { getTreasury } from "../utils/treasury.js"; // existing util in your codebase
import { prisma } from "../lib/prisma.js";          // your shared prisma client (adjust path if different)

// ---------- Types & helpers ----------

type OffshoreContext = {
  allianceId: number;
  guildId: string;
};

// NOTE: replace this with your real implementation.
// This is intentionally verbose so errors are crystal clear in logs.
async function sendToOffshore(opts: {
  allianceId: number;
  guildId: string;
  amountMoney: number;
  reason?: string;
  actorDiscordId: string;
}) {
  // Wire your real logic here. For now we only log to prove the flow.
  // If you need the default/override offshore target, fetch it here (AllianceKey/AllianceGuild/etc.)
  console.log("[OFFSHORE] sendToOffshore called", {
    allianceId: opts.allianceId,
    guildId: opts.guildId,
    amountMoney: opts.amountMoney,
    reason: opts.reason,
    actorDiscordId: opts.actorDiscordId,
  });

  // Example: sanity guard
  if (!Number.isFinite(opts.amountMoney) || opts.amountMoney <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  // TODO: (re)use your existing withdrawal auto-pay path or PnW mutation here.
  // Return a shape that the caller can show to the user.
  return {
    ok: true,
    txId: `OFFSH-${Date.now()}`,
  };
}

// Convert raw string to money number, forgiving commas/whitespace/$
function parseMoney(input: string): number {
  const cleaned = input.replace(/[,$\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Single-reply helper: always prefer replying to *this* interaction;
// if it’s already replied/deferred, edit the original instead.
async function safeReply(i: CommandInteraction, content: string, ephemeral = true) {
  if (i.deferred || i.replied) {
    return i.editReply({ content });
  }
  return i.reply({ content, ephemeral });
}

// ---------- Slash command definition ----------

export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore tools")
  .addSubcommand((sc) =>
    sc
      .setName("show")
      .setDescription("Show offshore actions and quick buttons"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("holdings")
      .setDescription("Show current offshore holdings"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("send")
      .setDescription("Open send modal for offshore transfer"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_default")
      .setDescription("Set the default offshore destination (BOT_ADMIN only)"),
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_override")
      .setDescription("Set a guild-specific offshore override (BOT_ADMIN only)"),
  );

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();

  // Resolve allianceId the same way the rest of your bot does.
  // If you already have a helper to get “current alliance” from guild, use that instead:
  const ctx: OffshoreContext = {
    allianceId: await resolveAllianceId(i),
    guildId: i.guildId!,
  };

  if (sub === "show") {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("offshore:send")
        .setStyle(ButtonStyle.Primary)
        .setLabel("Send to Offshore"),
      new ButtonBuilder()
        .setCustomId("offshore:holdings")
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Show Holdings"),
    );
    await i.reply({ content: "Offshore controls:", components: [row], ephemeral: true });
    return;
  }

  if (sub === "holdings") {
    // TODO: wire to your real holdings fetch
    await i.reply({ content: "Offshore holdings: (coming from your data source)", ephemeral: true });
    return;
  }

  if (sub === "send") {
    // IMPORTANT: for modals, do NOT defer. Build and show immediately.
    const { availableText, initialValue } = await computeAvailableText(ctx);
    const modal = buildSendModal({ availableText, initialValue });

    await i.showModal(modal);
    // We DO NOT reply to the slash interaction; the reply happens on the modal submit.
    return;
  }

  if (sub === "set_default" || sub === "set_override") {
    // TODO: plug into your BOT_ADMIN-gated setters
    await i.reply({ content: "Setter stubs are in place. Wire to your storage layer.", ephemeral: true });
    return;
  }
}

// ---------- Button & Modal handling (interactionCreate) ----------

// Register this from your global interaction dispatcher (the file that routes all interactions).
// If you already forward to each command file, export this and invoke it there.
export async function handleComponent(i: Interaction) {
  if (i.isButton()) {
    if (i.customId === "offshore:send") {
      // Button → Modal path: DO NOT defer or reply. Show modal within 3s.
      const ctx: OffshoreContext = {
        allianceId: await resolveAllianceId(i),
        guildId: i.guildId!,
      };
      const { availableText, initialValue } = await computeAvailableText(ctx);
      const modal = buildSendModal({ availableText, initialValue });
      await i.showModal(modal);
      return;
    }

    if (i.customId === "offshore:holdings") {
      // Button can safely reply ephemerally right away.
      await i.reply({ content: "Offshore holdings: (coming from your data source)", ephemeral: true });
      return;
    }
  }

  if (i.isModalSubmit() && i.customId === "offshore:send:modal") {
    try {
      // Parse inputs
      const amountRaw = i.fields.getTextInputValue("offshore_amount_money")?.trim() ?? "";
      const reason = i.fields.getTextInputValue("offshore_reason")?.trim() || undefined;

      const amountMoney = parseMoney(amountRaw);
      if (!Number.isFinite(amountMoney) || amountMoney <= 0) {
        return i.reply({ content: "❌ Enter a valid positive money amount.", ephemeral: true });
      }

      const ctx: OffshoreContext = {
        allianceId: await resolveAllianceId(i),
        guildId: i.guildId!,
      };

      // Acknowledge quickly to avoid 3s timeout, then edit with result.
      await i.deferReply({ ephemeral: true });

      const res = await sendToOffshore({
        allianceId: ctx.allianceId,
        guildId: ctx.guildId,
        amountMoney,
        reason,
        actorDiscordId: i.user.id,
      });

      if ((res as any)?.ok) {
        await i.editReply(`✅ Offshore send queued/sent. Tx: ${(res as any).txId}`);
      } else {
        await i.editReply(`⚠️ Offshore send returned without ok=true: ${JSON.stringify(res)}`);
      }
    } catch (err: any) {
      console.error("[OFFSHORE] send modal failure:", {
        message: err?.message,
        stack: err?.stack,
      });
      if (i.deferred || i.replied) {
        await i.editReply(`❌ Offshore send failed: ${err?.message ?? String(err)}`);
      } else {
        await i.reply({ content: `❌ Offshore send failed: ${err?.message ?? String(err)}`, ephemeral: true });
      }
    }
    return;
  }
}

// ---------- Internals ----------

function buildSendModal(opts: { availableText: string; initialValue: string }) {
  const modal = new ModalBuilder().setCustomId("offshore:send:modal").setTitle("Send to Offshore");

  const inputAmount = new TextInputBuilder()
    .setCustomId("offshore_amount_money")
    .setLabel(`Money Amount — ${opts.availableText}`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g., 1,000,000")
    .setRequired(true);

  // Pre-fill with a hint (Discord v14 TextInput supports setValue)
  if (opts.initialValue) {
    inputAmount.setValue(opts.initialValue);
  }

  const inputReason = new TextInputBuilder()
    .setCustomId("offshore_reason")
    .setLabel("Reason / Note (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Why are we sending this?")
    .setRequired(false);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(inputAmount);
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(inputReason);

  modal.addComponents(row1, row2);
  return modal;
}

async function computeAvailableText(ctx: OffshoreContext): Promise<{ availableText: string; initialValue: string }> {
  try {
    const t = await getTreasury(ctx.allianceId);
    const money = (t?.money ?? 0);
    const fmt = money.toLocaleString("en-US", { maximumFractionDigits: 0 });
    return { availableText: `Available: $${fmt}`, initialValue: "" };
  } catch (e) {
    console.warn("[OFFSHORE] Could not fetch treasury for available balance", e);
    return { availableText: "Available: (unknown)", initialValue: "" };
  }
}

// Replace this with your normal alliance resolution logic if different.
async function resolveAllianceId(i: Interaction): Promise<number> {
  // If you already have a table mapping guild→alliance, use it here.
  // Example against your schema (adjust model/field names as needed):
  if (!i.guildId) throw new Error("No guildId on interaction.");
  const ag = await prisma.allianceGuild.findFirst({
    where: { guildId: i.guildId },
    orderBy: { id: "desc" },
  });
  if (!ag?.allianceId) throw new Error("This guild is not linked to an alliance. Use /setup_alliance first.");
  return ag.allianceId;
}

export const command: CommandModule = { data, execute };
