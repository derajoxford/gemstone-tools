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
import { creditTreasury } from "../utils/treasury";

type Row = Record<string, any>;
const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];

// read snakeOrCamel from row
function getNum(row: Row, snake: string, camel: string): number {
  const v = row[snake] ?? row[camel] ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasAnyResources(row: Row): boolean {
  for (const k of RES_KEYS) {
    const camel = k;
    const snake = k; // our ingest tends to store snake; keep both lookups below
    if (getNum(row, snake, camel) > 0) return true;
  }
  return false;
}

function sumResources(rows: Row[]) {
  const totals: Record<ResKey, number> = Object.fromEntries(
    RES_KEYS.map(k => [k, 0])
  ) as Record<ResKey, number>;

  for (const r of rows) {
    for (const k of RES_KEYS) {
      totals[k] += getNum(r, k, k);
    }
  }
  return totals;
}

function fmtTotals(t: Record<ResKey, number>) {
  const parts = RES_KEYS
    .filter(k => (t[k] || 0) !== 0)
    .map(k => `${k}: ${Number(t[k] || 0).toLocaleString()}`);
  return parts.join(" · ") || "—";
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Credit automated tax bank records into the alliance treasury")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("limit")
      .setDescription("Max rows to pull (default 500, up to 5000)")
      .setMinValue(1)
      .setMaxValue(5000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Defer **once** (ephemeral via flags)
  await interaction.deferReply({ flags: 64 });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true);
    const limit = interaction.options.getInteger("limit") ?? 500;

    // pull tax-only rows
    const rows = await queryAllianceBankrecs(
      allianceId,
      limit,
      BankrecFilter.TAX
    );

    if (!rows?.length) {
      await interaction.editReply(
        `No tax-like bank records found for alliance ${allianceId}.`
      );
      return;
    }

    // Keep only rows that actually have amounts
    const withAmts = rows.filter(hasAnyResources);
    if (!withAmts.length) {
      await interaction.editReply(
        `No tax-like bank records with amounts found for alliance ${allianceId}.`
      );
      return;
    }

    // Sum and credit treasury
    const totals = sumResources(withAmts);
    const note = `pnw_tax_apply: ${withAmts.length}/${rows.length} rows`;
    await creditTreasury(prisma, allianceId, totals, note);

    const embed = new EmbedBuilder()
      .setTitle(`✅ Applied ${withAmts.length} tax rows`)
      .setDescription(`Alliance **${allianceId}**\nTotals credited:\n${fmtTotals(totals)}`)
      .setColor(Colors.Blurple);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
