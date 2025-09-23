// src/commands/pnw_preview_stored.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { resourceEmbed } from "../lib/embeds";
import { getPnwCursor } from "../utils/pnw_cursor";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

type ResourceDelta = Record<string, number>;

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}

function formatDelta(delta: ResourceDelta): string {
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
  .setName("pnw_preview_stored")
  .setDescription("Preview *tax-only* bank records using the stored PnW key.")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("last_seen")
      .setDescription("Override cursor: only records with id > last_seen are counted"),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const overrideLastSeen = interaction.options.getInteger("last_seen") ?? null;

    // Use stored cursor unless explicitly overridden
    const storedCursor = await getPnwCursor(allianceId);
    const lastSeenId = overrideLastSeen ?? (storedCursor ?? 0);

    // Ask integrations/pnw/tax to pull *tax-only* rows (note-based) and sum resources
    const preview = await previewAllianceTaxCreditsStored(allianceId, lastSeenId || null);
    const { count = 0, newestId = null, delta = {} } = preview || {};

    const totalsBlock = formatDelta(delta as ResourceDelta);

    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        `**Records counted:** ${count}`,
        `**Newest bankrec id:** ${newestId ?? "—"}`,
      ].join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(totalsBlock || ""),
          inline: false,
        },
      ],
      color: 0x5865f2,
      footer: "Preview only. Use /pnw_apply confirm:true to credit and advance cursor.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    console.error("[/pnw_preview_stored] error:", err);
    await interaction.editReply(msg);
  }
}
