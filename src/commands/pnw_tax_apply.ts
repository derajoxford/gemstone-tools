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
import { fetchBankrecs } from "../lib/pnw";

// --- constants / helpers ---
const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type ResTotals = Partial<Record<ResKey, number>>;

type AnyRow = Record<string, any>;

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function getAmount(row: AnyRow, k: ResKey): number {
  // support both snake_case and camelCase just in case
  return num(row[k] ?? row[toCamel(k)] ?? 0);
}
function toCamel(k: string) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function hasAnyResources(row: AnyRow): boolean {
  return RES_KEYS.some(k => getAmount(row, k) !== 0);
}
function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  // PnW tax is typically nation(3) -> alliance(2), receiver matches alliance
  // Also accept note containing 'tax'
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

// --- slash command metadata ---
export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Credit recent tax rows into the alliance treasury")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("Max rows to scan (default 200)")
      .setMinValue(1)
      .setMaxValue(2000)
  );

// --- main execution ---
export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitOpt = interaction.options.getInteger("limit");
  // default to 200, allow up to 2000. (GQL may still page; we’ll request the max it allows)
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1) Try GQL ingest first (fastest, consistent with /pnw_bankpeek)
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);

    // If rows exist but have no amounts, fallback to legacy top-level fetch (HTML scrape/API)
    const gqlHasAmounts = rows.some(r => hasAnyResources(r));
    if (!gqlHasAmounts) {
      // fetchBankrecs signature: fetchBankrecs({ apiKey }, [allianceId]) or similar is used elsewhere
      // We only need amounts; legacy fetch returns full amounts on each row.
      const apiKey = process.env.PNW_DEFAULT_API_KEY || "";
      if (!apiKey) {
        // Keep going with GQL rows if no default key; better than nothing
      } else {
        const legacy = await fetchBankrecs({ apiKey }, [allianceId]).catch(() => null);
        // shape (based on existing usage in index.ts): array with items per alliance, each having bankrecs[]
        // Normalize to a flat array if available
        const legacyRows = Array.isArray(legacy)
          ? (legacy.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId)?.bankrecs ?? [])
          : [];
        if (Array.isArray(legacyRows) && legacyRows.length) {
          rows = legacyRows.slice(0, limit);
        }
      }
    }

    // Filter to tax-like rows for this alliance
    const taxRows = rows.filter(r => looksLikeTax(r, allianceId));

    // If still nothing with amounts, bail early
    const anyAmounts = taxRows.some(r => hasAnyResources(r));
    if (!taxRows.length || !anyAmounts) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    // 2) Deduplicate by bankrec id (in case of mixed sources)
    const seen = new Set<number | string>();
    const uniq = taxRows.filter(r => {
      const id = r.id ?? r.bankrec_id ?? `${r.sender_id}:${r.receiver_id}:${r.date ?? r.time ?? ""}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // 3) Sum resource columns
    const totals: ResTotals = {};
    for (const k of RES_KEYS) totals[k] = 0;
    for (const r of uniq) {
      for (const k of RES_KEYS) {
        const v = getAmount(r, k);
        if (v) totals[k]! = (totals[k] || 0) + v;
      }
    }

    // 4) Credit the alliance treasury (upserts a treasury row & increments balances JSON)
    await creditTreasury(prisma, allianceId, totals, "tax");

    // 5) Reply with a summary
    const lines = RES_KEYS
      .map(k => ({ k, v: Number(totals[k] || 0) }))
      .filter(x => x.v !== 0)
      .map(x => `**${x.k}**: ${x.v.toLocaleString()}`);

    const embed = new EmbedBuilder()
      .setTitle(`✅ Applied ${uniq.length} tax rows`)
      .setDescription(lines.length ? lines.join(" · ") : "—")
      .setColor(Colors.Green)
      .setFooter({ text: `Alliance ${allianceId}` });

    await interaction.editReply({ embeds: [embed] });

  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
