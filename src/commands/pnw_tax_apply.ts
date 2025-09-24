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

function detectTreasuryModelName(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")       // tags
    .replace(/&nbsp;/g, " ")
    .replace(/&bull;/g, "•")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Heuristic: is this a TAX marker line? (works for ALL or TAX feeds) */
function isTaxish(row: any): boolean {
  const note = stripHtml(String(row?.note ?? "")).toLowerCase();
  const st = String(row?.sender_type ?? "");
  const rt = String(row?.receiver_type ?? "");
  const senderNation = st === "3" || Number(st) === 3;   // 3 = nation
  const recvAlliance = rt === "2" || Number(rt) === 2;   // 2 = alliance
  // PnW commonly writes "Automated Tax 100%/100%" or similar
  const mentionsTax = note.includes("automated tax") || note.includes("tax");
  return mentionsTax && senderNation && recvAlliance;
}

/** Any non-zero amounts after deriving the delta from the bankrec row */
function rowHasAnyAmounts(row: any): boolean {
  const d = deltaFromBankrec(row);
  return KEYS.some((k) => Number((d as any)[k] ?? 0) !== 0);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Apply alliance tax deposits to the treasury (credits nation→alliance tax lines)")
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
    const modelName = detectTreasuryModelName(prisma as any);
    await ensureAllianceTreasury(prisma as any, modelName, allianceId);

    // Strategy:
    // 1) Pull ALL recent bankrecs (not TAX feed) so we can see the credited amounts.
    // 2) Filter to “tax-like” nation→alliance rows mentioning Automated Tax.
    // 3) Apply deltas to the alliance treasury.
    const allRows = await queryAllianceBankrecs(
      allianceId,
      limit,
      BankrecFilter.ALL
    );

    const candidates = (allRows || []).filter(isTaxish);
    const rowsWithAmounts = candidates.filter(rowHasAnyAmounts);

    if (!rowsWithAmounts.length) {
      await interaction.editReply(
        `No tax-like bank records with amounts found for alliance ${allianceId}.`
      );
      return;
    }

    // Aggregate totals + apply one-by-one (idempotent upserts in treasury helper)
    const totals = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<ResKey, number>;
    let applied = 0;

    for (const r of rowsWithAmounts) {
      const d = deltaFromBankrec(r);
      for (const k of KEYS) {
        const v = Number((d as any)[k] ?? 0);
        if (v) totals[k] += v;
      }
      await applyDeltaToTreasury(prisma as any, modelName, allianceId, d);
      applied++;
    }

    const prettyTotals =
      KEYS.filter((k) => Number(totals[k]) !== 0)
        .map((k) => `**${k}**: ${Number(totals[k]).toLocaleString()}`)
        .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle("✅ Tax deposits credited to treasury")
      .setDescription(
        [
          `Alliance **${allianceId}**`,
          `Scanned: **${limit}** rows (ALL feed)`,
          `Tax-like rows: **${candidates.length}**`,
          `Rows with amounts: **${rowsWithAmounts.length}**`,
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
