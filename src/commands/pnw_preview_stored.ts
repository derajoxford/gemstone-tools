// src/commands/pnw_preview_stored.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getAlliancePnwKey } from "../integrations/pnw/store";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";

const RESOURCE_ORDER = [
  "money",
  "food",
  "munitions",
  "gasoline",
  "aluminum",
  "steel",
  "oil",
  "uranium",
  "bauxite",
  "coal",
  "iron",
  "lead",
] as const;

function fmtNumber(n: number, opts?: { money?: boolean }) {
  if (opts?.money) {
    // 2 decimals for money
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // integer for units
  return Math.round(n).toLocaleString();
}

export const data = new SlashCommandBuilder()
  .setName("pnw_preview_stored")
  .setDescription("Preview PnW tax credits using the stored key (read-only).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("PnW Alliance ID (numeric).")
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("last_seen_id")
      .setDescription("Only include bankrecs with id > this value (optional).")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const lastSeenIdVal = interaction.options.getInteger("last_seen_id", false);
  const lastSeenId = typeof lastSeenIdVal === "number" ? lastSeenIdVal : undefined;

  try {
    const apiKey = await getAlliancePnwKey(allianceId!);
    if (!apiKey) {
      await interaction.editReply(
        "No stored PnW key for this alliance. Use `/pnw_set` first to link and store one."
      );
      return;
    }

    const preview = await previewAllianceTaxCredits({
      apiKey,
      allianceId: allianceId!,
      lastSeenId,
    });

    // Build a clean embed
    const embed = new EmbedBuilder()
      .setTitle("PnW Tax Preview (Stored Key)")
      .setColor(0x00b894)
      .setDescription(
        [
          `**Alliance ID:** \`${allianceId}\``,
          lastSeenId != null ? `**Filter:** bankrecs with \`id > ${lastSeenId}\`` : "",
          `**Records counted:** \`${preview.count}\``,
          `**Newest bankrec id (cursor):** \`${preview.newestId ?? "none"}\``,
          "",
          "_Preview sums **incoming tax bank records** (`tax_id != null`, to this alliance) from PnW’s recent window._",
          "_This is **not** your current alliance bank balance._",
        ]
          .filter(Boolean)
          .join("\n")
      );

    // Delta field
    const lines: string[] = [];
    for (const key of RESOURCE_ORDER) {
      const v = (preview.delta as any)[key] ?? 0;
      if (!v) continue;
      lines.push(`• **${key}**: +${fmtNumber(v, { money: key === "money" })}`);
    }
    embed.addFields(
      lines.length
        ? [{ name: "Tax delta (sum)", value: lines.join("\n"), inline: false }]
        : [{ name: "Tax delta (sum)", value: "_No positive tax deltas detected._", inline: false }]
    );

    if (preview.warnings?.length) {
      embed.addFields([{ name: "Warnings", value: preview.warnings.map((w) => `• ${w}`).join("\n") }]);
    }

    embed.setFooter({ text: "When ready, /pnw_apply will credit these into your Alliance Treasury." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(
      "Failed to preview via stored key: " + (err?.message ?? String(err)) +
      "\nIf this persists, re-link with `/pnw_set`."
    );
  }
}

export default { data, execute };
