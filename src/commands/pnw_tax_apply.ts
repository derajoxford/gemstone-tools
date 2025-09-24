// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { queryAllianceBankrecs, BankrecFilter } from "../lib/pnw_bank_ingest";
import { addToTreasury, sumRowsToDelta } from "../utils/treasury";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply recent tax records to the alliance treasury (manual run)")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("How many latest tax rows to sum/apply (1–50, default 10)")
      .setMinValue(1)
      .setMaxValue(50)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit") ?? 10;

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1) Pull the latest TAX rows
    const rows = await queryAllianceBankrecs(allianceId, Math.min(50, Math.max(1, limit)), BankrecFilter.TAX);

    if (!rows?.length) {
      await interaction.editReply(`Nothing to apply: no tax rows found for alliance ${allianceId}.`);
      return;
    }

    // 2) Sum rows → delta by resource
    const delta = sumRowsToDelta(rows);

    // 3) Apply to treasury
    await addToTreasury(allianceId, delta);

    // 4) Report back
    const lines: string[] = [];
    const EMOJI: Record<string, string> = {
      money: "💵", food: "🍞", coal: "⚫", oil: "🛢️", uranium: "☢️", lead: "🔩",
      iron: "⛓️", bauxite: "🧱", gasoline: "⛽", munitions: "💣", steel: "🧱", aluminum: "🧪",
    };
    for (const [k, v] of Object.entries(delta)) {
      if (!v) continue;
      const pretty = Number(v).toLocaleString();
      lines.push(`${EMOJI[k] ?? ""} **${k}**: ${pretty}`);
    }

    const emb = new EmbedBuilder()
      .setTitle(`✅ Applied Tax → Treasury`)
      .setDescription(
        [
          `Alliance **${allianceId}**`,
          `Rows considered: **${rows.length}** (latest)`,
          lines.length ? `\n**Delta**\n${lines.join("\n")}` : "\n**Delta**\n— (all zero)",
        ].join("\n")
      )
      .setColor(Colors.Green)
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [emb] });
  } catch (err: any) {
    await interaction.editReply(`❌ Failed to apply tax: ${err?.message ?? String(err)}`);
  }
}
