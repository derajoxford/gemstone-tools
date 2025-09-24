// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { prisma } from "../utils/db";
import {
  queryAllianceBankrecs,
  BankrecFilter,
} from "../lib/pnw_bank_ingest";
import {
  ensureAllianceTreasury,
  applyDeltaToTreasury,
  deltaFromBankrec,
  KEYS,
} from "../utils/treasury";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply recent taxrecs to the alliance treasury")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("How many tax rows to apply (1–2000)")
      .setMinValue(1)
      .setMaxValue(2000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit", false) ?? 100;

  await interaction.deferReply({ ephemeral: true });

  try {
    // Ensure a treasury row exists (works for scalar- or JSON-based schema)
    await ensureAllianceTreasury(prisma, "treasury", allianceId);

    // NOTE: PnW API typically caps a single page (≈200). We’ll add pagination next step.
    const rows = await queryAllianceBankrecs(
      allianceId,
      Math.min(2000, Math.max(1, limit)),
      BankrecFilter.TAX
    );

    if (!rows?.length) {
      await interaction.editReply(`No tax records found for alliance ${allianceId}.`);
      return;
    }

    let applied = 0;
    const totals: Record<string, number> = {};
    for (const k of KEYS) totals[k] = 0;

    for (const r of rows) {
      // Convert the bankrec into a delta shape
      const d = deltaFromBankrec(r);

      // Sum for reporting
      for (const k of KEYS) {
        if (d[k as any]) totals[k] += Number(d[k as any] || 0);
      }

      // Credit to treasury
      await applyDeltaToTreasury(prisma, "treasury", allianceId, d);
      applied++;
    }

    const lines = KEYS
      .filter(k => totals[k] && Number(totals[k]) !== 0)
      .map(k => `**${k}**: ${Number(totals[k]).toLocaleString()}`)
      .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle(`✅ Applied ${applied} tax rows`)
      .setDescription(`Alliance **${allianceId}**\nTotals credited:\n${lines}`)
      .setColor(Colors.Green);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
