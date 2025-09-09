import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getAlliancePnwKey } from "../integrations/pnw/store";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";
import { addToTreasury } from "../utils/treasury";

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
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return Math.round(n).toLocaleString();
}

export const data = new SlashCommandBuilder()
  .setName("pnw_apply")
  .setDescription("Apply PnW tax credits to the Alliance Treasury (uses stored key).")
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
      .setDescription("Only include bankrecs with id > this value (optional, for idempotency).")
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName("confirm")
      .setDescription("Set true to actually apply the credits. Default: false (preview only).")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const lastSeenIdVal = interaction.options.getInteger("last_seen_id", false);
  const confirm = interaction.options.getBoolean("confirm", false) ?? false;
  const lastSeenId = typeof lastSeenIdVal === "number" ? lastSeenIdVal : undefined;

  try {
    const apiKey = await getAlliancePnwKey(allianceId!);
    if (!apiKey) {
      await interaction.editReply(
        "No stored PnW key for this alliance. Use `/pnw_set` first to link and store one."
      );
      return;
    }

    // Compute strict tax delta (incoming to alliance, tax_id != null, > last_seen_id if provided)
    const preview = await previewAllianceTaxCredits({
      apiKey,
      allianceId: allianceId!,
      lastSeenId,
    });

    // Build a pretty embed
    const embed = new EmbedBuilder()
      .setTitle(confirm ? "PnW Tax Apply (Stored Key)" : "PnW Tax Apply — PREVIEW (Stored Key)")
      .setColor(confirm ? 0x0984e3 : 0xf9a825)
      .setDescription(
        [
          `**Alliance ID:** \`${allianceId}\``,
          lastSeenId != null ? `**Filter:** bankrecs with \`id > ${lastSeenId}\`` : "",
          `**Records counted:** \`${preview.count}\``,
          `**Newest bankrec id (cursor):** \`${preview.newestId ?? "none"}\``,
          "",
          "_This sums **incoming tax bank records** (to this alliance) from PnW’s recent window._",
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

    // If not confirmed or nothing to apply, just show the preview with next-step hint.
    if (!confirm || lines.length === 0) {
      embed.setFooter({
        text:
          preview.newestId != null
            ? `Preview only. To apply, rerun with confirm:true and last_seen_id:${lastSeenId ?? 0} (will apply up to ${preview.newestId}).`
            : `Preview only. No new records to apply.`,
      });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Apply: credit to Alliance Treasury via existing addToTreasury utility
    const delta = preview.delta as Record<string, number>;
    // Note: addToTreasury signature is tolerant; extra metadata is ignored if not supported.
    await addToTreasury(allianceId!, delta, {
      source: "pnw",
      kind: "tax",
      note: `Applied via /pnw_apply by ${interaction.user.tag} (${interaction.user.id}); cursor=${preview.newestId ?? "none"}`,
    } as any);

    embed.setColor(0x00b894);
    embed.addFields([
      {
        name: "Applied",
        value:
          preview.newestId != null
            ? `✅ Credited to treasury. **Next cursor:** \`${preview.newestId}\`\nRerun later with \`last_seen_id:${preview.newestId}\` to avoid duplicates.`
            : "✅ Credited to treasury.",
        inline: false,
      },
    ]);
    embed.setFooter({ text: "Tip: we’ll persist a cursor and add a timer next so this runs automatically." });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(
      "Failed to apply PnW tax credits: " + (err?.message ?? String(err)) +
      "\nIf this persists, try previewing with `/pnw_preview_stored` first."
    );
  }
}

export default { data, execute };
