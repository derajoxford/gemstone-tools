// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { resourceEmbed } from "../lib/embeds";
import { getPnwCursor } from "../utils/pnw_cursor";

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}
function formatDelta(delta: Record<string, number>): string {
  const keys = Object.keys(delta || {});
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr =
      k === "money"
        ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview PnW *automated tax* receipts (stored key), no changes.")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("last_seen").setDescription("Override cursor: only id > last_seen")
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("Recent rows to scan (default 500)")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const overrideLastSeen = interaction.options.getInteger("last_seen");
    const limit = interaction.options.getInteger("limit") ?? 500;

    const storedCursor = await getPnwCursor(allianceId);
    const lastSeenId = overrideLastSeen ?? (storedCursor ?? 0);

    const preview = await previewAllianceTaxCreditsStored(
      allianceId,
      lastSeenId || null,
      limit
    );

    const block = formatDelta(preview.delta || {});
    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        `**Scan limit:** ${limit}`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestId ?? "—"}`,
      ].join("\n"),
      fields: [{ name: "Tax delta (sum)", value: codeBlock(block), inline: false }],
      color: 0x5865f2,
      footer: "Preview only. Use /pnw_apply confirm:true to apply and advance cursor.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    console.error("[/pnw_preview] error:", err);
    await interaction.editReply(
      `❌ Failed to preview: ${err?.message ?? String(err)}`
    );
  }
}
