// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { resourceEmbed } from "../lib/embeds";
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
  .setName("pnw_preview")
  .setDescription("Preview PnW tax credits using the stored key (no apply).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("last_seen")
      .setDescription("Override cursor: only records with id > last_seen"),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const lastSeen = interaction.options.getInteger("last_seen") ?? null;

    const preview = await previewAllianceTaxCreditsStored(allianceId, lastSeen);
    const count = preview?.count ?? 0;
    const newestId = preview?.newestId ?? null;
    const delta = (preview?.delta ?? {}) as ResourceDelta;

    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeen ?? 0}`,
        `**Records counted:** ${count}`,
        `**Newest bankrec id:** ${newestId ?? "—"}`,
      ].join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(formatDelta(delta)),
        },
      ],
      color: 0x5865f2,
      footer: "Preview only. Use /pnw_apply confirm:true to apply and advance cursor.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(
      `❌ Failed to preview: ${err?.message || String(err)}`,
    );
  }
}
