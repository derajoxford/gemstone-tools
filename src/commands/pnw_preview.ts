// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { getPnwCursor } from "../utils/pnw_cursor";
import { resourceEmbed } from "../lib/embeds";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

function codeBlock(s: string) { return s ? "```\n" + s + "\n```" : "—"; }

function formatDelta(delta: Record<string, number>): string {
  const keys = Object.keys(delta || {});
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr = k === "money"
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview automated tax rows (scraped) and show summed delta without applying.")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("Max rows to scan (most recent)").setMinValue(1).setMaxValue(2000)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limit = interaction.options.getInteger("limit") ?? null;

    // Use stored cursor as a timestamp (ms)
    const lastSeenTs = await getPnwCursor(allianceId).catch(() => 0);

    const preview = await previewAllianceTaxCreditsStored(allianceId, {
      lastSeenTs: lastSeenTs || 0,
      limit: limit ?? undefined,
    });

    const lines = [
      `**Alliance:** ${allianceId}`,
      `**Cursor:** id > ${lastSeenTs || 0}`,
      limit ? `**Scan limit:** ${limit}` : `**Scan window:** default`,
      `**Records counted:** ${preview.count}`,
      `**Newest bankrec id:** ${preview.newestTs ?? "—"}`,
    ];

    const totalsBlock = formatDelta(preview.delta || {});
    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: lines.join("\n"),
      fields: [{ name: "Tax delta (sum)", value: codeBlock(totalsBlock || ""), inline: false }],
      color: 0x5865f2,
      footer: "Preview only.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Failed to preview: ${err?.message || String(err)}`);
  }
}
