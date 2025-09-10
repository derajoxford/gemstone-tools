// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

function fmtDelta(delta: Record<string, number> | undefined) {
  const d = delta ?? {};
  const keys = Object.keys(d).filter((k) => d[k]);
  if (!keys.length) return "—";
  return keys.map((k) => `• ${k}: ${d[k]}`).join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview alliance tax credits using the stored PnW key")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("since_id")
      .setDescription("Only consider bankrecs with id > since_id")
      .setRequired(false),
  )
  // restrict to managers to avoid spam
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const sinceId = interaction.options.getInteger("since_id") ?? null;

    const preview = await previewAllianceTaxCreditsStored(allianceId, sinceId);

    await interaction.editReply(
      [
        `**Alliance:** ${allianceId}`,
        `**Records counted:** ${preview.count}`,
        `**newestId:** ${preview.newestId ?? "—"}`,
        `**Delta:**`,
        fmtDelta(preview.delta),
      ].join("\n"),
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    await interaction.editReply(`❌ ${msg}`);
    console.error("[/pnw_preview] error:", err);
  }
}
