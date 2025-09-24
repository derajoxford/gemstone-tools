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
  KEYS,
} from "../utils/treasury";

/**
 * Some PnW bankrec shapes differ. This extracts numeric amounts robustly.
 * It checks common field names, plus a few alternates seen in the wild.
 */
function extractAmounts(row: any): Record<string, number> {
  const out: Record<string, number> = {};
  const candidates: Record<string, string[]> = {
    money:     ["money", "cash", "money_amount"],
    food:      ["food"],
    coal:      ["coal"],
    oil:       ["oil"],
    uranium:   ["uranium"],
    lead:      ["lead"],
    iron:      ["iron"],
    bauxite:   ["bauxite"],
    gasoline:  ["gasoline", "gas"],
    munitions: ["munitions", "ammo"],
    steel:     ["steel"],
    aluminum:  ["aluminum", "aluminium"],
  };

  for (const k of KEYS) {
    let v = 0;
    for (const name of candidates[k] || []) {
      const raw = (row as any)[name];
      if (raw !== undefined && raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n)) { v = n; break; }
      }
    }
    out[k] = Number.isFinite(v) ? v : 0;
  }

  // Some APIs return a nested object like row.resources or row.delta
  const nested = (row?.resources ?? row?.delta ?? row?.amounts ?? {}) as Record<string, unknown>;
  for (const k of KEYS) {
    const n = Number(nested[k as keyof typeof nested]);
    if (Number.isFinite(n) && n !== 0) out[k] = n;
  }

  return out;
}

function isNationToAlliance(row: any, allianceId: number): boolean {
  const st = Number(row?.sender_type ?? 0);   // 3 = nation
  const rt = Number(row?.receiver_type ?? 0); // 2 = alliance
  const rid = Number(row?.receiver_id ?? 0);
  return st === 3 && rt === 2 && rid === allianceId;
}

function anyNonZero(d: Record<string, number>) {
  return KEYS.some(k => Number(d[k] || 0) !== 0);
}

function detectModel(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Scan recent nation→alliance deposits (incl. Automated Tax) and credit the alliance treasury")
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

    // Pull BOTH feeds, concat, and de-dupe by id (some installs only return one side)
    const [rowsAll, rowsTax] = await Promise.all([
      queryAllianceBankrecs(allianceId, limit, BankrecFilter.ALL).catch(() => [] as any[]),
      queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX).catch(() => [] as any[]),
    ]);

    const byId = new Map<string | number, any>();
    for (const r of [...(rowsAll || []), ...(rowsTax || [])]) {
      if (!r) continue;
      const id = (r as any).id ?? `${(r as any).date}-${(r as any).sender_id}-${(r as any).receiver_id}`;
      if (!byId.has(id)) byId.set(id, r);
    }
    const merged = Array.from(byId.values());

    // Filter to nation -> alliance rows, then extract amounts
    const depositRows = merged.filter(r => isNationToAlliance(r, allianceId));
    if (!depositRows.length) {
      await interaction.editReply(`No nation→alliance deposits found for alliance ${allianceId}.`);
      return;
    }

    // Apply only rows that actually move resources (non-zero amounts)
    const totals: Record<string, number> = Object.fromEntries(KEYS.map(k => [k, 0])) as any;
    let applied = 0;

    for (const r of depositRows) {
      const d = extractAmounts(r);
      if (!anyNonZero(d)) continue;

      for (const k of KEYS) totals[k] += Number(d[k] || 0);
      await applyDeltaToTreasury(prisma as any, model, allianceId, d);
      applied++;
    }

    if (applied === 0) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    const prettyTotals =
      KEYS.filter(k => Number(totals[k] || 0) !== 0)
          .map(k => `**${k}**: ${Number(totals[k]).toLocaleString()}`)
          .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle("✅ Deposits credited to treasury")
      .setDescription(
        [
          `Alliance **${allianceId}**`,
          `Scanned rows: **${merged.length}** (ALL+TAX)`,
          `Candidate nation→alliance: **${depositRows.length}**`,
          `Applied (non-zero): **${applied}**`,
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
