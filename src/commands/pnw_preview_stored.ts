// src/commands/pnw_preview_stored.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getAlliancePnwKey } from "../integrations/pnw/store";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";

export const data = new SlashCommandBuilder()
  .setName("pnw_preview_stored")
  .setDescription("Preview PnW tax credits using the stored key (read-only).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("PnW Alliance ID (numeric).")
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("last_seen_id")
      .setDescription("Only count bankrecs with id > this value (optional).")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const lastSeenIdVal = interaction.options.getInteger("last_seen_id", false);
  const lastSeenId = typeof lastSeenIdVal === "number" ? lastSeenIdVal : undefined;

  try {
    const apiKey = await getAlliancePnwKey(allianceId!);
    if (!apiKey) {
      await interaction.editReply(
        "No stored PnW key for this alliance. Use `/pnw_set` first to link and store one."
      );
      return;
    }

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
      lines.push("**Tax delta (sum):**");
      for (const line of preview.previewLines.slice(0, 30)) lines.push(line);
      if (preview.previewLines.length > 30) {
        lines.push(`…and ${preview.previewLines.length - 30} more lines`);
      }
    }

    if (preview.warnings.length) {
      lines.push("");
      lines.push("**Warnings:**");
      for (const w of preview.warnings) lines.push("• " + w);
    }

    await interaction.editReply(lines.join("\n"));
  } catch (err: any) {
    await interaction.editReply(
      "Failed to preview via stored key: " + (err?.message ?? String(err)) +
      "\nIf this persists, re-link with `/pnw_set`."
    );
  }
}

export default { data, execute };
