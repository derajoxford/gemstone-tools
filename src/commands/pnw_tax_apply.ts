// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import prisma from "../utils/db";
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

function detectModel(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

function hasAnyAmounts(row: any): boolean {
  // rely on the standard PnW bankrec numeric fields via deltaFromBankrec
  const d = deltaFromBankrec(row);
  return KEYS.some(k => Number((d as any)[k] ?? 0) !== 0);
}

function isNationToAlliance(row: any, allianceId: number): boolean {
  const st = Number(row?.sender_type ?? 0);
  const rt = Number(row?.receiver_type ?? 0);
  const rid = Number(row?.receiver_id ?? 0);
  return st === 3 && rt === 2 && rid === allianceId;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply nation→alliance deposits (incl. Automated Tax) to the alliance treasury")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("How many recent rows to scan (1–5000)")
      .setMinValue(1)
      .setMaxValue(5000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const rawLimit = interaction.options.getInteger("limit", false) ?? 2000;
  const limit = Math.max(1, Math.min(5000, rawLimit));

  await interaction.deferReply({ ephemeral: true });

  try {
    const model = detectModel(prisma as any);
    await ensureAllianceTreasury(prisma as any, model, allianceId);

    // Pull from the ALL feed so amounts are present
    const rows = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.ALL);

    // Filter to nation -> alliance deposits with any non-zero amounts
    const taxish = (rows || []).filter(r => isNationToAlliance(r, allianceId) && hasAnyAmounts(r));

    if (!taxish.length) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    const totals = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<ResKey, number>;
    let applied = 0;

    for (const r of taxish) {
      const d = deltaFromBankrec(r);
      // accumulate totals
      for (const k of KEYS) {
        const v = Number((d as any)[k] ?? 0);
        if (v) totals[k] += v;
      }
      await applyDeltaToTreasury(prisma as any, model, allianceId, d);
      applied++;
    }

    const prettyTotals =
      KEYS.filter((k) => Number(totals[k]) !== 0)
        .map((k) => `**${k}**: ${Number(totals[k]).toLocaleString()}`)
        .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle("✅ Deposits credited to treasury")
      .setDescription(
        [
          `Alliance **${allianceId}**`,
          `Scanned (ALL feed): **${limit}** rows`,
          `Matched rows: **${taxish.length}**`,
          `Applied: **${applied}**`,
          ``,
          `**Totals credited**`,
          `${prettyTotals}`,
        ].join("\n")
      )
      .setColor(Colors.Green);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
