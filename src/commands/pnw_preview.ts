// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { getPnwCursor } from "../utils/pnw_cursor";
import { resourceEmbed } from "../lib/embeds";

type ResourceDelta = Record<string, number>;
function codeBlock(s: string) { return s ? "```\n" + s + "\n```" : "—"; }
function formatDelta(delta: ResourceDelta): string {
  const keys = Object.keys(delta || {});
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr = k === "money" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview *tax-only* bank records using the stored PnW key.")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Max rows to scan (default 300, max 500)").setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const limit = Math.max(1, Math.min(500, i.options.getInteger("limit") ?? 300));

    const lastSeen = (await getPnwCursor(allianceId)) ?? 0;
    const preview = await previewAllianceTaxCreditsStored(allianceId, lastSeen, limit);

    const embed = resourceEmbed({
      title: `PnW Tax Preview (Stored Key)`,
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeen ?? 0}`,
        `**Scan limit:** ${limit}`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestId ?? "—"}`,
      ].join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(formatDelta(preview.delta) || ""),
          inline: false,
        },
      ],
      color: 0x5865f2,
      footer: `Preview only.`,
    });

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    await i.editReply(`❌ Failed to preview: ${err?.message ?? String(err)}`);
  }
}
