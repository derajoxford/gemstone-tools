// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import prisma from "../utils/db"; // default export
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

type ResKey = (typeof KEYS)[number];

// Detect the treasury model name that exists on this Prisma client
function detectTreasuryModelName(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

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
    // Figure out the model name in THIS schema
    const modelName = detectTreasuryModelName(prisma as any);

    // Ensure a treasury row exists (works for scalar- or JSON-based schema)
    await ensureAllianceTreasury(prisma as any, modelName, allianceId);

    // Pull tax records (server already bumped to allow >50; we cap at 2000 here)
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
    const totals = Object.fromEntries(KEYS.map(k => [k, 0])) as Record<ResKey, number>;

    for (const r of rows) {
      const d = deltaFromBankrec(r); // Partial<Record<ResKey, number>>

      // Sum for reporting
      for (const k of KEYS) {
        const val = (d as any)[k];
        if (val) totals[k] += Number(val) || 0;
      }

      // Credit to treasury
      await applyDeltaToTreasury(prisma as any, modelName, allianceId, d);
      applied++;
    }

    const lines =
      KEYS.filter(k => totals[k] && Number(totals[k]) !== 0)
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
