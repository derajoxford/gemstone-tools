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

/** parse numbers like "$2,611,448.89" -> 2611448.89 */
function toNum(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[,\s$_]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function toCamel(k: string) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function getAmount(row: AnyRow, k: ResKey): number {
  // support both snake_case and camelCase
  const raw = row[k] ?? row[toCamel(k)];
  return toNum(raw);
}
function hasAnyResources(row: AnyRow): boolean {
  return RES_KEYS.some(k => getAmount(row, k) !== 0);
}
function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  // PnW tax: nation(3) -> alliance(2), receiver matches alliance OR note mentions tax
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
  // default 200, allow up to 2000 (GQL may still page)
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  await interaction.deferReply({ flags: 64 }); // ephemeral (v14-safe)

  try {
    // 1) Try GQL ingest first (fastest, matches /pnw_bankpeek)
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);

    // If rows exist but lack amounts (common right now), fallback to legacy fetch
    const gqlHasAmounts = rows.some(r => hasAnyResources(r));
    if (!gqlHasAmounts) {
      const apiKey = process.env.PNW_DEFAULT_API_KEY || "";
      if (apiKey) {
        const legacy: any = await (fetchBankrecs as any)({ apiKey }, [allianceId]).catch(() => null);
        const legacyRows: any[] = Array.isArray(legacy)
          ? (legacy.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId)?.bankrecs ?? [])
          : [];
        if (legacyRows.length) {
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
    const seen = new Set<string>();
    const uniq = taxRows.filter(r => {
      const id =
        String(r.id ?? r.bankrec_id ??
          `${r.sender_id ?? r.senderId}:${r.receiver_id ?? r.receiverId}:${r.date ?? r.time ?? ""}`);
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

    // 4) Credit the alliance treasury (upsert + increment JSON balances)
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
