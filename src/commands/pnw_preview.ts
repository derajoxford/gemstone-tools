// src/commands/pnw_preview.ts
// Ephemeral preview of PnW tax credits for a given API key + alliance ID.
// No storage yet. Perfect for multi-tenant verification before we persist.
// Usage: /pnw_preview api_key:<string> alliance_id:<int> [last_seen_id:<int>]

import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview Politics & War tax credits (no changes; no storage).")
  // Limit to users who can manage the bot or roles; tweak as you like:
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName("api_key")
      .setDescription("Your PnW API key (from Account page). Used only for this preview.")
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("PnW Alliance ID (numeric).")
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("last_seen_id")
      .setDescription("Only count bankrecs with id > this value (optional cursor).")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const apiKey = interaction.options.getString("api_key", true).trim();
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const lastSeenIdRaw = interaction.options.getInteger("last_seen_id", false);
  const lastSeenId = typeof lastSeenIdRaw === "number" ? lastSeenIdRaw : undefined;

  if (!apiKey || !Number.isFinite(allianceId!) || allianceId! <= 0) {
    await interaction.editReply("Invalid input. Provide a valid API key and a positive Alliance ID.");
    return;
  }

  try {
    const preview = await previewAllianceTaxCredits({
      apiKey,
      allianceId: allianceId!,
      lastSeenId,
    });

    const lines: string[] = [];
    lines.push(`**Alliance ID:** ${allianceId}`);
    lines.push(`**Records counted:** ${preview.count}`);
    lines.push(`**Newest bankrec id (cursor):** ${preview.newestId ?? "none"}`);
    lines.push("");

    if (preview.previewLines.length === 0) {
      lines.push("_No positive tax deltas detected in the recent window._");
    } else {
      // Keep the message tidy in Discord
      const max = Math.min(preview.previewLines.length, 20);
      lines.push("**Tax delta (sum):**");
      for (let i = 0; i < max; i++) lines.push(preview.previewLines[i]);
      if (preview.previewLines.length > max) {
        lines.push(`…and ${preview.previewLines.length - max} more lines`);
      }
    }

    if (preview.warnings.length) {
      lines.push("");
      lines.push("**Warnings:**");
      for (const w of preview.warnings) lines.push("• " + w);
    }

    lines.push("");
    lines.push("_Next: we’ll add secure storage + automation so you never have to paste this again._");

    await interaction.editReply(lines.join("\n"));
  } catch (err: any) {
    await interaction.editReply(
      "Failed to fetch/preview. " +
        (err?.message ?? String(err)) +
        "\nDouble-check your API key and Alliance ID."
    );
  }
}

// Default export for your registry loader (if it expects { data, execute }).
export default { data, execute };
