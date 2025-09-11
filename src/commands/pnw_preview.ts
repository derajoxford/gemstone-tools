// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { getPnwCursor } from "../utils/pnw_cursor";
import { resourceEmbed } from "../lib/embeds";

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}
function formatDelta(delta: Record<string, number>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(delta || {})) {
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
  .setDescription("Preview PnW tax deltas since the saved cursor (no apply).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Scan window (best effort), e.g. 600")
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const limit = interaction.options.getInteger("limit") ?? undefined;

    const lastSeenId = (await getPnwCursor(allianceId)) ?? 0;

    const preview = await previewAllianceTaxCreditsStored(
      allianceId,
      lastSeenId || null,
      { limit, sampleSize: 3 }
    );

    const totals = formatDelta(preview.delta || {});
    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        limit ? `**Scan limit:** ${limit}` : `**Scan window:** default`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestId ?? "—"}`,
      ].join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(totals || ""),
          inline: false,
        },
      ],
      color: 0x5865f2,
      footer: "Preview only.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    console.error("[/pnw_preview] error:", err);
    await interaction.editReply(msg);
  }
}
