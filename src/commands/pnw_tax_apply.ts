// src/commands/pnw_tax_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import prisma from "../utils/db";
import { queryAllianceBankrecs, BankrecFilter } from "../lib/pnw_bank_ingest";
import { fetchBankrecs } from "../lib/pnw";
import { creditTreasury } from "../utils/treasury";

const RES_KEYS = [
  "money", "food", "coal", "oil", "uranium", "lead", "iron",
  "bauxite", "gasoline", "munitions", "steel", "aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type AnyRow = Record<string, any>;
type Totals = Partial<Record<ResKey, number>>;

function toCamel(k: string) { return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function getAmount(row: AnyRow, k: ResKey): number { return num(row[k] ?? row[toCamel(k)] ?? 0); }
function hasAnyResources(r: AnyRow): boolean { return RES_KEYS.some(k => getAmount(r, k) !== 0); }
function looksLikeTax(r: AnyRow, allianceId: number): boolean {
  const sType = Number(r.sender_type ?? r.senderType ?? 0);
  const rType = Number(r.receiver_type ?? r.receiverType ?? 0);
  const rId   = Number(r.receiver_id ?? r.receiverId ?? 0);
  const note  = String(r.note ?? "").toLowerCase();
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

// ---- interaction safety helpers ----
async function safeDefer(i: ChatInputCommandInteraction, ephemeral = true) {
  try {
    if (!i.deferred && !i.replied) {
      await i.deferReply({ ephemeral });
    }
  } catch (e: any) {
    if (e?.code === 10062 || e?.code === 40060) return false; // already acked / unknown
    throw e;
  }
  return true;
}
async function safeEdit(i: ChatInputCommandInteraction, payload: any) {
  try {
    if (i.deferred) return await i.editReply(payload);
    if (!i.replied)  return await i.reply({ ...payload, ephemeral: true });
    return await i.followUp({ ...payload, ephemeral: true });
  } catch (e: any) {
    if (e?.code === 10062 || e?.code === 40060) {
      try { return await i.followUp({ ...payload, ephemeral: true }); } catch {}
      return;
    }
    throw e;
  }
}

/**
 * Normalize any plausible legacy response shape to an array of bankrec rows.
 */
function normalizeLegacyResult(res: any, allianceId: number): AnyRow[] {
  if (!res) return [];

  // Case A: direct array of bankrec rows
  if (Array.isArray(res)) {
    // If elements look like bankrec rows (have sender/receiver), take them
    if (res.length && (res[0]?.sender_type !== undefined || res[0]?.senderType !== undefined)) {
      return res;
    }
    // If elements are packs: [{ id, bankrecs:[...] }, ...]
    const pack = res.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId);
    if (pack?.bankrecs && Array.isArray(pack.bankrecs)) return pack.bankrecs;
    return [];
  }

  // Case B: object with .bankrecs
  if (Array.isArray(res.bankrecs)) return res.bankrecs;

  // Case C: object with .rows
  if (Array.isArray(res.rows)) return res.rows;

  return [];
}

/**
 * Try legacy fetchBankrecs with several known/observed signatures.
 * Returns an array of raw bankrec rows (with possible amounts) or [].
 */
async function tryLegacyFetch(allianceId: number, limit: number, apiKey: string): Promise<AnyRow[]> {
  const attempts: Array<[string, () => Promise<any>]> = [
    ["fn(optsObj,arrayIds)",   () => (fetchBankrecs as any)({ apiKey }, [allianceId])],
    ["fn(limit,arrayIds)",      () => (fetchBankrecs as any)(limit, [allianceId])],
    ["fn(arrayIds,optsObj)",    () => (fetchBankrecs as any)([allianceId], { apiKey, limit })],
    ["fn(opts union)",          () => (fetchBankrecs as any)({ apiKey, limit, allianceIds: [allianceId] })],
    ["fn(allianceIdOnly?)",     () => (fetchBankrecs as any)(allianceId)],
  ];

  for (let idx = 0; idx < attempts.length; idx++) {
    const [label, call] = attempts[idx];
    try {
      const res = await call();
      const rows = normalizeLegacyResult(res, allianceId).slice(0, limit);
      const withAmounts = rows.filter(hasAnyResources).length;
      console.log(`[tax_apply][legacy attempt ${idx + 1} ${label}] rows=${rows.length} withAmounts=${withAmounts}`);
      if (rows.length) return rows;
    } catch (e) {
      console.log(`[tax_apply][legacy attempt ${idx + 1} ${label}] error`, e);
    }
  }
  return [];
}

// ---------------- slash metadata ----------------
export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Credit recent tax rows into the alliance treasury")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption(o =>
    o.setName("limit")
     .setDescription("Max rows to scan (default 200, up to 2000)")
     .setMinValue(1)
     .setMaxValue(2000)
  );

// ---------------- main ----------------
export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitOpt = interaction.options.getInteger("limit");
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  await safeDefer(interaction, true);

  try {
    // 1) GQL first
    console.log(`[tax_apply] GQL fetch TAX rows for alliance=${allianceId} limit=${limit}`);
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX)
      .catch((e: any) => { console.error("[tax_apply] GQL error:", e); return []; });

    console.log(`[tax_apply] GQL returned ${rows.length} rows`);
    const gqlHasAmounts = rows.some(hasAnyResources);

    // 2) Fallback to legacy when GQL rows lack amounts
    if (!gqlHasAmounts) {
      const apiKey = process.env.PNW_DEFAULT_API_KEY || "";
      console.log(`[tax_apply] GQL had no amounts; fallback=${!!apiKey}`);
      if (apiKey) {
        const legacyRows = await tryLegacyFetch(allianceId, limit, apiKey);
        if (legacyRows.length) rows = legacyRows;
        console.log(`[tax_apply] legacy chosen rows: ${rows.length}`);
      }
    }

    // 3) Filter to tax-like rows for this alliance
    const taxRows = rows.filter(r => looksLikeTax(r, allianceId));
    console.log(`[tax_apply] tax-like rows: ${taxRows.length}`);

    // If still nothing with amounts, bail
    const anyAmounts = taxRows.some(hasAnyResources);
    if (!taxRows.length || !anyAmounts) {
      await safeEdit(interaction, { content: `No tax-like bank records with amounts found for alliance ${allianceId}.` });
      return;
    }

    // 4) Deduplicate
    const seen = new Set<string|number>();
    const uniq = taxRows.filter(r => {
      const id = r.id ?? r.bankrec_id ?? `${r.sender_id}:${r.receiver_id}:${r.date ?? r.time ?? ""}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    console.log(`[tax_apply] unique rows after dedupe: ${uniq.length}`);

    // 5) Sum amounts
    const totals: Totals = {};
    for (const k of RES_KEYS) totals[k] = 0;
    for (const r of uniq) {
      for (const k of RES_KEYS) {
        const v = getAmount(r, k);
        if (v) totals[k]! = (totals[k] || 0) + v;
      }
    }
    const nonZero = RES_KEYS.filter(k => (totals[k] || 0) !== 0);
    console.log(`[tax_apply] non-zero keys: ${nonZero.join(", ") || "(none)"}`);

    // 6) Credit treasury
    await creditTreasury(prisma, allianceId, totals as Record<ResKey, number>, "tax");
    console.log(`[tax_apply] credited treasury for alliance=${allianceId}`);

    // 7) Reply
    const lines = nonZero.map(k => `**${k}**: ${Number(totals[k]).toLocaleString()}`);
    const embed = new EmbedBuilder()
      .setTitle(`✅ Applied ${uniq.length} tax rows`)
      .setDescription(lines.length ? lines.join(" · ") : "—")
      .setFooter({ text: `Alliance ${allianceId}` })
      .setColor(Colors.Green);

    await safeEdit(interaction, { embeds: [embed] });

  } catch (err: any) {
    console.error("[tax_apply] unexpected error:", err);
    await safeEdit(interaction, { content: `❌ Error: ${err?.message ?? String(err)}` });
  }
}
