// src/commands/pnw_apply.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getAlliancePnwKey } from "../integrations/pnw/store";
import { previewAllianceTaxCredits } from "../integrations/pnw/tax";
import { addToTreasury } from "../utils/treasury";
import { getPnwCursor, setPnwCursor, appendPnwApplyLog } from "../utils/pnw_cursor";

const RESOURCE_ORDER = [
  "money","food","munitions","gasoline","aluminum","steel",
  "oil","uranium","bauxite","coal","iron","lead",
] as const;

function fmtNumber(n: number, opts?: { money?: boolean }) {
  return (opts?.money
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(n).toLocaleString()
  );
}

export const data = new SlashCommandBuilder()
  .setName("pnw_apply")
  .setDescription("Apply PnW tax credits to the Alliance Treasury (auto-cursor & logs).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((opt) =>
    opt.setName("alliance_id").setDescription("PnW Alliance ID (numeric).").setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("last_seen_id")
      .setDescription("Override: only include bankrecs with id > this value. Defaults to stored cursor.")
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
  const lastSeenIdOverride = interaction.options.getInteger("last_seen_id", false);
  const confirm = interaction.options.getBoolean("confirm", false) ?? false;

  try {
    const apiKey = await getAlliancePnwKey(allianceId!);
    if (!apiKey) {
      await interaction.editReply("No stored PnW key for this alliance. Use `/pnw_set` first.");
      return;
    }

    // Auto-cursor unless user overrides
    const storedCursor = await getPnwCursor(allianceId!);
    const lastSeenId = typeof lastSeenIdOverride === "number" ? lastSeenIdOverride : storedCursor;

    const preview = await previewAllianceTaxCredits({
      apiKey,
      allianceId: allianceId!,
      lastSeenId,
    });

    // Pretty embed
    const embed = new EmbedBuilder()
      .setTitle(confirm ? "PnW Tax Apply (Stored Key)" : "PnW Tax Apply — PREVIEW (Stored Key)")
      .setColor(confirm ? 0x0984e3 : 0xf9a825)
      .setDescription(
        [
          `**Alliance ID:** \`${allianceId}\``,
          lastSeenId != null
            ? `**Cursor (using ${typeof lastSeenIdOverride === "number" ? "override" : "stored"})**: \`id > ${lastSeenId}\``
            : "**Cursor:** _none_ (all available in recent window)",
          `**Records counted:** \`${preview.count}\``,
          `**Newest bankrec id (next cursor):** \`${preview.newestId ?? "none"}\``,
          "",
          "_This sums **incoming tax bank records** (to this alliance). This is **not** your current bank balance._",
        ]
          .filter(Boolean)
          .join("\n")
      );

    // Delta field
    const nonZeroDelta: Record<string, number> = {};
    const lines: string[] = [];
    for (const key of RESOURCE_ORDER) {
      const v = (preview.delta as any)[key] ?? 0;
      if (!v) continue;
      nonZeroDelta[key] = v;
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

    // If not confirmed or nothing to apply, show preview only
    if (!confirm || lines.length === 0) {
      embed.setFooter({
        text:
          preview.newestId != null
            ? `Preview only. If confirmed, cursor would be saved as ${preview.newestId}, and a log entry recorded.`
            : `Preview only. No new records to apply.`,
      });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // Apply: credit to treasury
    await addToTreasury(allianceId!, preview.delta as Record<string, number>, {
      source: "pnw",
      kind: "tax",
      note: `Applied via /pnw_apply by ${interaction.user.tag} (${interaction.user.id}); fromCursor=${lastSeenId ?? "none"} toCursor=${preview.newestId ?? "none"}`,
    } as any);

    // Persist new cursor (if any)
    if (typeof preview.newestId === "number") {
      await setPnwCursor(allianceId!, preview.newestId);
    }

    // Append log entry (always on confirm)
    await appendPnwApplyLog(allianceId!, {
      ts: new Date().toISOString(),
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      fromCursor: lastSeenId ?? null,
      toCursor: preview.newestId ?? null,
      records: preview.count,
      delta: nonZeroDelta,
    });

    embed.setColor(0x00b894);
    embed.addFields([
      {
        name: "Applied",
        value:
          preview.newestId != null
            ? `✅ Credited to treasury. **Next cursor saved:** \`${preview.newestId}\`.\nLog recorded under _meta.pnw.logs.`
            : "✅ Credited to treasury. Log recorded.",
        inline: false,
      },
    ]);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(
      "Failed to apply PnW tax credits: " + (err?.message ?? String(err)) +
      "\nTry a preview first with `/pnw_preview_stored`."
    );
  }
}

export default { data, execute };
