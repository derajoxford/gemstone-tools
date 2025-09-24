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
  type BankrecRow,
} from "../lib/pnw_bank_ingest";
import {
  ensureAllianceTreasury,
  applyDeltaToTreasury,
  deltaFromBankrec,
  KEYS,
} from "../utils/treasury";

type ResKey = (typeof KEYS)[number];

function detectTreasuryModelName(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

function hasAnyResources(row: Partial<Record<ResKey, unknown>>): boolean {
  return KEYS.some(k => Number((row as any)[k] ?? 0) !== 0);
}

/** Heuristic: is this a tax row? */
function isTaxish(row: BankrecRow): boolean {
  const note = (row.note || "").toLowerCase();
  const looksTax = note.includes("tax");
  // In PnW: sender_type 3 = nation, receiver_type 2 = alliance
  const senderNation = Number(row.sender_type) === 3;
  const recvAlliance = Number(row.receiver_type) === 2;
  return looksTax && senderNation && recvAlliance;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply recent tax rows to the alliance treasury (credits deposits)")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("How many rows to apply (1–2000)")
      .setMinValue(1)
      .setMaxValue(2000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit", false) ?? 200;

  await interaction.deferReply({ ephemeral: true });

  try {
    const modelName = detectTreasuryModelName(prisma as any);
    await ensureAllianceTreasury(prisma as any, modelName, allianceId);

    // 1) Try dedicated TAX feed first
    let rows = await queryAllianceBankrecs(
      allianceId,
      Math.min(2000, Math.max(1, limit)),
      BankrecFilter.TAX
    );

    // 2) If the TAX feed lacks resource amounts, fallback to ALL and filter tax-ish rows
    if (!rows?.length || rows.every(r => !hasAnyResources(r))) {
      const fallback = await queryAllianceBankrecs(
        allianceId,
        Math.min(2000, Math.max(1, limit)),
        BankrecFilter.ALL
      );
      rows = (fallback || []).filter(isTaxish);
    }

    if (!rows?.length) {
      await interaction.editReply(`No tax-like bank records found for alliance ${allianceId}.`);
      return;
    }

    let applied = 0;
    const totals = Object.fromEntries(KEYS.map(k => [k, 0])) as Record<ResKey, number>;
    let nonzeroRows = 0;

    for (const r of rows) {
      // Convert the row into a resource delta
      const d = deltaFromBankrec(r);

      // Skip if literally no amounts present (some upstream rows can be just markers)
      const any = KEYS.some(k => Number((d as any)[k] ?? 0) !== 0);
      if (!any) continue;

      nonzeroRows++;

      // Sum for reporting
      for (const k of KEYS) {
        const v = Number((d as any)[k] ?? 0);
        if (v) totals[k] += v;
      }

      // Credit to treasury
      await applyDeltaToTreasury(prisma as any, modelName, allianceId, d);
      applied++;
    }

    const lines =
      KEYS.filter(k => totals[k] && Number(totals[k]) !== 0)
        .map(k => `**${k}**: ${Number(totals[k]).toLocaleString()}`)
        .join(" · ") || "—";

    const desc = [
      `Alliance **${allianceId}**`,
      `Rows considered: **${rows.length}**`,
      `Rows with resources: **${nonzeroRows}**`,
      `Rows credited: **${applied}**`,
      ``,
      `Totals credited:`,
      `${lines}`,
    ].join("\n");

    const embed = new EmbedBuilder()
      .setTitle(`✅ Tax credit applied`)
      .setDescription(desc)
      .setColor(Colors.Green);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
