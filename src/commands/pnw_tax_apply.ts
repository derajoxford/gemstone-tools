// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";

import {
  queryAllianceBankrecs,
  BankrecFilter,
  type BankrecRow,
} from "../lib/pnw_bank_ingest";

import { creditTreasuryTotals } from "../utils/treasury";
import { fetchBankrecs } from "../lib/pnw"; // legacy helper that returns amounts

const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];

function n(x: any): number {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}
function hasAnyAmounts(r: Partial<Record<ResKey, any>> | null | undefined) {
  if (!r) return false;
  for (const k of RES_KEYS) {
    if (n((r as any)[k]) > 0) return true;
  }
  return false;
}
function isTaxNote(note: string | null | undefined): boolean {
  const s = (note || "").toLowerCase();
  return s.includes("automated tax");
}

// Summation helper into a plain object
function addInto(sum: Record<ResKey, number>, row: Partial<Record<ResKey, any>>) {
  for (const k of RES_KEYS) sum[k] += n((row as any)[k]);
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Credit alliance treasury from recent Automated Tax bank records")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("How many rows to scan (1–5000)")
      .setMinValue(1)
      .setMaxValue(5000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = interaction.options.getInteger("limit", false) ?? 200;

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1) Try GraphQL (TAX filter) first
    let rows: BankrecRow[] = await queryAllianceBankrecs(
      allianceId,
      Math.min(5000, Math.max(1, limit)),
      BankrecFilter.TAX
    ).catch(() => []);

    // If GQL TAX returns nothing or no amounts, try GQL ALL + tax-note filter
    if (!rows.length || rows.every(r => !hasAnyAmounts(r))) {
      const all = await queryAllianceBankrecs(
        allianceId,
        Math.min(5000, Math.max(1, limit)),
        BankrecFilter.ALL
      ).catch(() => []);
      const taxLike = all.filter(r => isTaxNote(r.note));
      if (taxLike.length && taxLike.some(hasAnyAmounts)) {
        rows = taxLike;
      }
    }

    // If still nothing with amounts, fall back to legacy fetchBankrecs (which returns amounts)
    if (!rows.length || rows.every(r => !hasAnyAmounts(r))) {
      const apiKey = process.env.PNW_DEFAULT_API_KEY || process.env.PNW_API_KEY || "";
      if (!apiKey) {
        await interaction.editReply("❌ Error: No PNW API key configured on the server.");
        return;
      }
      // fetchBankrecs({ apiKey }, [allianceId]) → returns an array for each alliance id
      const alliancesData: any[] = await fetchBankrecs({ apiKey }, [allianceId]).catch(() => []);
      const al = Array.isArray(alliancesData) ? alliancesData.find((a: any) => a?.id == allianceId) : null;

      const legacyRows: any[] = (al?.bankrecs || []).slice(0, Math.min(5000, Math.max(1, limit)));
      // Normalize legacy rows into BankrecRow-ish objects
      rows = legacyRows
        .filter((r: any) => isTaxNote(r?.note))
        .map((r: any) => ({
          id: n(r.id),
          date: r.date,
          note: r.note ?? null,
          sender_type: n(r.sender_type),
          sender_id: n(r.sender_id),
          receiver_type: n(r.receiver_type),
          receiver_id: n(r.receiver_id),
          money: n(r.money),
          food: n(r.food),
          coal: n(r.coal),
          oil: n(r.oil),
          uranium: n(r.uranium),
          lead: n(r.lead),
          iron: n(r.iron),
          bauxite: n(r.bauxite),
          gasoline: n(r.gasoline),
          munitions: n(r.munitions),
          steel: n(r.steel),
          aluminum: n(r.aluminum),
        })) as BankrecRow[];
    }

    // Final guard: if we truly have no amounts, quit cleanly
    if (!rows.length || rows.every(r => !hasAnyAmounts(r))) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    // 2) Sum amounts across selected rows
    const totals: Record<ResKey, number> = {
      money: 0, food: 0, coal: 0, oil: 0, uranium: 0, lead: 0, iron: 0,
      bauxite: 0, gasoline: 0, munitions: 0, steel: 0, aluminum: 0,
    };

    let counted = 0;
    for (const r of rows) {
      if (!isTaxNote(r.note)) continue;
      addInto(totals, r);
      counted++;
    }
    if (!counted || !hasAnyAmounts(totals)) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    // 3) Credit treasury
    await creditTreasuryTotals(allianceId, totals);

    // 4) Report success
    const nonZero = RES_KEYS
      .filter(k => n(totals[k]) > 0)
      .map(k => `**${k}**: ${n(totals[k]).toLocaleString()}`)
      .join(" · ");

    const embed = new EmbedBuilder()
      .setTitle("✅ Tax rows applied to Treasury")
      .setColor(Colors.Green)
      .setDescription(`Alliance **${allianceId}**\nRows counted: **${counted}**`)
      .addFields({ name: "Totals credited", value: nonZero || "—" });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
