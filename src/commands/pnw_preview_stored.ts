// src/commands/pnw_preview_stored.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { getAllowedTaxIds } from "../utils/pnw_tax_ids";

export const data = new SlashCommandBuilder()
  .setName("pnw_preview_stored")
  .setDescription("Preview alliance tax credits using the stored PnW read key")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption(o =>
    o.setName("since_id").setDescription("Only count records with id > since_id"),
  )
  .setDMPermission(false);

function fmtDelta(delta: Record<string, number>) {
  const keys = Object.keys(delta).filter(k => delta[k]);
  if (!keys.length) return "—";
  return keys.map(k => `${k}: ${delta[k]}`).join(", ");
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const sinceId = interaction.options.getInteger("since_id") ?? null;

    const allowed = await getAllowedTaxIds(allianceId);
    const res = await previewAllianceTaxCreditsStored(allianceId, sinceId);

    await interaction.editReply(
      [
        `**Alliance:** ${allianceId}`,
        `**Filter tax_id(s):** ${allowed.length ? allowed.join(", ") : "none (heuristic)"}`,
        `**Records:** ${res.count}`,
        `**Newest ID:** ${res.newestId ?? "—"}`,
        `**Delta:** ${fmtDelta(res.delta)}`,
      ].join("\n"),
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    await interaction.editReply(`Failed to preview via stored key: ${msg}\nIf this persists, re-link with /pnw_set.`);
    console.error("[/pnw_preview_stored] error:", err);
  }
}
