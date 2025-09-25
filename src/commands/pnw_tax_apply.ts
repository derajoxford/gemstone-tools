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
import { open as decrypt } from "../lib/crypto";

// --- constants / helpers ---
const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type ResTotals = Partial<Record<ResKey, number>>;
type AnyRow = Record<string, any>;

/** parse numbers like "$2,611,448.89" -> 2611448.89, also tolerates null/undefined */
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
  // support snake/camel and a couple of odd fallbacks we've seen in dumps
  const alt1 = row[k];
  const alt2 = row[toCamel(k)];
  const alt3 = row[`bankrec_${k}`];        // some scraped sources
  const alt4 = row?.amounts?.[k];          // nested blob fallback
  return toNum(alt1 ?? alt2 ?? alt3 ?? alt4 ?? 0);
}
function hasAnyResources(row: AnyRow): boolean {
  return RES_KEYS.some(k => getAmount(row, k) !== 0);
}
function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  // PnW tax: nation(3) -> alliance(2) with receiver matching the alliance, or note mentions tax
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

async function getAllianceApiKey(allianceId: number): Promise<string | null> {
  // prefer env default if present
  if (process.env.PNW_DEFAULT_API_KEY) return process.env.PNW_DEFAULT_API_KEY;

  // else use the latest stored alliance key
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const k = a?.keys?.[0];
  if (!k) return null;
  try {
    return decrypt(k.encryptedApiKey as any, k.nonceApi as any);
  } catch {
    return null;
  }
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

  // v14-compatible ephemeral
  await interaction.deferReply({ flags: 64 });

  try {
    // 1) Try GQL ingest first (fast, matches /pnw_bankpeek)
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);

    // If rows exist but lack amounts (current issue), fallback to legacy fetch
    const gqlHasAmounts = rows.some(r => hasAnyResources(r));
    if (!gqlHasAmounts) {
      const apiKey = await getAllianceApiKey(allianceId);
      if (apiKey) {
        // use the top-level legacy fetch (returns an array with one entry per alliance id)
        const legacy: any = await (fetchBankrecs as any)({ apiKey }, [allianceId]).catch(() => null);
        const legacyRows: any[] = Array.isArray(legacy)
          ? (legacy.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId)?.bankrecs ?? [])
          : [];
        if (legacyRows.length) {
          rows = legacyRows.slice(0, limit);
        }
      }
    }

    // 2) Filter to tax-like rows for this alliance
    const taxRows = rows.filter(r => looksLikeTax(r, allianceId));

    // 3) If still nothing with amounts, bail early with a clear message
    const anyAmounts = taxRows.some(r => hasAnyResources(r));
    if (!taxRows.length || !anyAmounts) {
      await interaction.editReply(`No tax-like bank records with amounts found for alliance ${allianceId}.`);
      return;
    }

    // 4) Deduplicate by bankrec id (in case of mixed sources)
    const seen = new Set<string>();
    const uniq = taxRows.filter(r => {
      const id =
        String(r.id ?? r.bankrec_id ??
          `${r.sender_id ?? r.senderId}:${r.receiver_id ?? r.receiverId}:${r.date ?? r.time ?? ""}`);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // 5) Sum resource columns
    const totals: ResTotals = {};
    for (const k of RES_KEYS) totals[k] = 0;
    for (const r of uniq) {
      for (const k of RES_KEYS) {
        const v = getAmount(r, k);
        if (v) totals[k]! = (totals[k] || 0) + v;
      }
    }

    // 6) Credit the alliance treasury (upsert + increment JSON balances)
    await creditTreasury(prisma, allianceId, totals, "tax");

    // 7) Reply with a summary
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
