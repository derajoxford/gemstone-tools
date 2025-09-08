// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";
import { saveAlliancePnwKey } from "../integrations/pnw/store";
import { secretConfigured } from "../utils/secret";

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Link an alliance to a PnW API key (validates and stores encrypted).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt
      .setName("api_key")
      .setDescription("PnW API key (from your Account page).")
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("PnW Alliance ID (numeric).")
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!secretConfigured) {
    await interaction.editReply(
      "Encryption secret not configured. Ask an admin to set **GT_SECRET** (or **ENCRYPTION_KEY**) in the service env."
    );
    return;
  }

  const apiKey = interaction.options.getString("api_key", true).trim();
  const allianceId = interaction.options.getInteger("alliance_id", true);

  if (!apiKey || !Number.isFinite(allianceId!) || allianceId! <= 0) {
    await interaction.editReply("Invalid input. Provide a valid API key and a positive Alliance ID.");
    return;
  }

  try {
    // 1) Validate read access by fetching bankrecs (read-only)
    const preview = await previewAllianceTaxCredits({ apiKey, allianceId: allianceId! });

    // 2) Store encrypted
    const saved = await saveAlliancePnwKey({
      allianceId: allianceId!,
      apiKey,
      actorDiscordId: interaction.user.id,
    });

    const lines: string[] = [];
    lines.push("✅ **Alliance linked to PnW key.**");
    lines.push(`Alliance ID: \`${saved.allianceId}\``);
    lines.push("");
    lines.push(`Validation: preview returned \`${preview.count}\` tax-related bank record(s) in the recent window.`);

    await interaction.editReply(lines.join("\n"));
  } catch (err: any) {
    await interaction.editReply(
      "Failed to validate/store PnW key: " + (err?.message ?? String(err)) +
      "\n• Double-check the API key and Alliance ID.\n• Ensure the key has access to alliance bank records."
    );
  }
}

export default { data, execute };
