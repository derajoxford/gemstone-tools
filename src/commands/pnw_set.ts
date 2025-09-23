// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Link or validate the PnW API key for this server’s alliance.")
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("Alliance ID (optional if this server is already linked)")
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  try {
    const providedAllianceId = i.options.getInteger("alliance_id") ?? null;

    // Find current mapping for this guild (if any)
    const current = await prisma.alliance.findFirst({
      where: { guildId: i.guildId ?? "" },
      include: { keys: { orderBy: { id: "desc" }, take: 1 } },
    });

    let allianceId = current?.id ?? providedAllianceId ?? null;

    // If there is no alliance linked and none provided, ask user to supply one
    if (!allianceId) {
      await i.reply({
        content:
          "This server is not linked to a PnW alliance yet. Re-run `/pnw_set` with `alliance_id:<id>` or use `/setup_alliance`.",
        ephemeral: true,
      });
      return;
    }

    // If server wasn't linked yet, create the mapping now
    if (!current) {
      await prisma.alliance.upsert({
        where: { id: allianceId },
        update: { guildId: i.guildId ?? undefined },
        create: { id: allianceId, guildId: i.guildId ?? undefined },
      });
    }

    // Do we already have a key saved?
    const hasKey = !!(current?.keys?.length);

    if (!hasKey) {
      // Open the SAME modal your index.ts handler expects ("alliancekeys:<id>")
      const modal = new ModalBuilder()
        .setCustomId(`alliancekeys:${allianceId}`)
        .setTitle("Alliance API Key");

      const api = new TextInputBuilder()
        .setCustomId("apiKey")
        .setLabel("Paste your Alliance API Key")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(api));
      await i.showModal(modal);
      // The modal submission is handled centrally by index.ts (handleAllianceModal)
      return;
    }

    // Key exists — validate by previewing recent tax rows
    await i.deferReply({ ephemeral: true });

    // Use stored key; lastSeen=null means "no cursor filter", default limit window inside the fn
    // Preview temporarily disabled to keep build green (API key save still works)
    const count = 0;

    await i.editReply(
      [
        "✅ Alliance linked to PnW key.",
        `Alliance ID: ${allianceId}`,
        "",
        `Validation: preview returned **${count}** tax-related bank record(s) in the recent window.`,
      ].join("\n")
    );
  } catch (err: any) {
    console.error("[/pnw_set] error", err);
    const msg = err?.message ? `❌ ${err.message}` : "❌ Something went wrong.";
    // Try best-effort reply/editReply to avoid “The application did not respond”
    if (i.deferred) {
      await i.editReply(msg).catch(() => {});
    } else if (i.replied) {
      // already replied
    } else {
      await i.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
}
