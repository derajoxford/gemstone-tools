// src/commands/pnw_tax_history.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import {
  getTaxHistory,
  summarizeTaxHistory,
  RES_FIELDS,
} from "../utils/pnw_tax_history";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_history")
  .setDescription("Summarize saved (local) PnW tax history that survives the 14-day API window")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addIntegerOption((o) =>
    o
      .setName("since_id")
      .setDescription("Only include records with id > since_id"),
  )
  .addStringOption((o) =>
    o
      .setName("since")
      .setDescription('Only include records on/after this date (e.g. "2025-09-01")'),
  )
  .addStringOption((o) =>
    o
      .setName("until")
      .setDescription('Only include records on/before this date (e.g. "2025-09-10")'),
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Cap number of records to process (default 1000, max 5000)")
      .setMinValue(100)
      .setMaxValue(5000),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const since_id = interaction.options.getInteger("since_id") ?? null;
    const since = interaction.options.getString("since") ?? null;
    const until = interaction.options.getString("until") ?? null;
    const limit = interaction.options.getInteger("limit") ?? 1000;

    // Ensure there is any local data
    const all = await getTaxHistory(allianceId);
    if (!all.length) {
      await interaction.editReply(
        `No saved tax history for **${allianceId}** yet.\n` +
          `Run **/pnw_apply** first to fetch from PnW and persist.`,
      );
      return;
    }

    const summary = await summarizeTaxHistory({
      allianceId,
      sinceId: since_id,
      sinceDate: since,
      untilDate: until,
      limit,
    });

    const lines: string[] = [];
    for (const f of RES_FIELDS) {
      const v = Number(summary.delta[f] ?? 0);
      if (!v) continue;
      lines.push(`• ${f}: +${v.toLocaleString()}`);
    }

    await interaction.editReply(
      [
        `**Alliance:** ${allianceId}`,
        `**Records considered:** ${summary.count.toLocaleString()}`,
        `**Newest record id in range:** ${summary.newestId ?? "—"}`,
        "",
        `**Totals**`,
        lines.length ? lines.join("\n") : "—",
        "",
        "_Tip: use `/pnw_apply` regularly to keep history up to date beyond PnW’s 14-day window._",
      ].join("\n"),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`❌ ${msg}`);
    console.error("[/pnw_tax_history] error:", err);
  }
}
