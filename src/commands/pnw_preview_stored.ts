// src/commands/pnw_preview_stored.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

function formatDelta(delta: Record<string, number>) {
  const keys = Object.keys(delta).filter((k) => delta[k]);
  if (!keys.length) return "—";
  return keys
    .map((k) => `${k}: ${delta[k]}`)
    .join("\n");
}

async function replyError(interaction: ChatInputCommandInteraction, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await interaction.editReply(`Failed to preview via stored key: ${msg}\nIf this persists, re-link with \`/pnw_set\`.`);
  console.error("[/pnw_preview_stored] error:", err);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview_stored")
  .setDescription("Preview alliance tax credits using the stored PnW API key and saved tax_id filter")
  .addIntegerOption((o) =>
    o.setName("alliance_id")
      .setDescription("Alliance ID")
      .setRequired(true),
  )
  .addIntegerOption((o) =>
    o.setName("since_id")
      .setDescription("Only include bankrecs with id > since_id (optional)")
      .setMinValue(0),
  )
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const sinceId = interaction.options.getInteger("since_id") ?? null;

    const res = await previewAllianceTaxCreditsStored(allianceId, sinceId);

    await interaction.editReply(
      [
        `**Alliance:** ${allianceId}`,
        `**Records counted:** ${res.count}`,
        `**newestId:** ${res.newestId ?? "—"}`,
        `**Delta:**`,
        formatDelta(res.delta),
      ].join("\n"),
    );
  } catch (err) {
    await replyError(interaction, err);
  }
}
