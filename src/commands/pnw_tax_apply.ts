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

// -------------------- constants / helpers --------------------
const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type ResTotals = Partial<Record<ResKey, number>>;
type AnyRow = Record<string, any>;

const TAG = "[tax_apply]";

// Convert snake_case to camelCase
function toCamel(k: string) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Parse numbers robustly, including "$2,611,448.89" style strings
function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.+-]/g, ""); // strip $, commas, spaces, units
    if (!cleaned) return 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(v as any);
  return Number.isFinite(n) ? n : 0;
}

function getAmount(row: AnyRow, k: ResKey): number {
  return num(row[k] ?? row[toCamel(k)] ?? 0);
}

function hasAnyResources(row: AnyRow): boolean {
  return RES_KEYS.some(k => getAmount(row, k) !== 0);
}

// Try to detect a PnW “tax” row (nation -> alliance, or note mentions tax)
function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  // nation(3) -> alliance(2) and receiver matches alliance, or note contains "tax"
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

function normalizeRow(raw: AnyRow): AnyRow {
  // Map a minimal set of stable fields and leave resource columns in place (snake/camel tolerated)
  const out: AnyRow = { ...raw };
  // Standardize some id fields if available
  if (out.bankrec_id && !out.id) out.id = out.bankrec_id;
  // Stabilize date/time fields if present
  if (!out.date && out.time) out.date = out.time;
  return out;
}

// ---- safe reply helpers (avoid crashing client on “Unknown interaction” or double ack) ----
async function safeDefer(i: ChatInputCommandInteraction, ephemeral = true) {
  try {
    // Discord.js v14 deprecates { ephemeral } at deferReply; flags=64 is the equivalent
    // We’ll still try ephemeral: true first, then fallback to flags if needed.
    try {
      await i.deferReply({ ephemeral });
    } catch {
      await i.deferReply({ flags: 64 as any }).catch(() => {});
    }
  } catch { /* ignore */ }
}

async function safeEdit(i: ChatInputCommandInteraction, data: any) {
  try {
    await i.editReply(data);
  } catch {
    try { await i.followUp({ ...data, ephemeral: true }); } catch { /* ignore */ }
  }
}

// -------------------- slash command metadata --------------------
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

// -------------------- main execution --------------------
export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitOpt = interaction.options.getInteger("limit");
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  console.log(`${TAG} GQL fetch TAX rows for alliance=${allianceId} limit=${limit}`);
  await safeDefer(interaction, true);

  try {
    // 1) Primary source: GraphQL
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);
    rows = Array.isArray(rows) ? rows.map(normalizeRow) : [];
    console.log(`${TAG} GQL returned ${rows.length} rows`);

    const gqlHasAmounts = rows.some(r => hasAnyResources(r));
    const needLegacy = !gqlHasAmounts;

    console.log(`${TAG} GQL had no amounts; fallback=${needLegacy}`);
    if (needLegacy) {
      const apiKey = process.env.PNW_DEFAULT_API_KEY || "";
      if (apiKey) {
        // Try multiple signatures because the legacy helper has varied in the codebase.
        let legacyRows: AnyRow[] = [];
        const attempts: Array<{ label: string; call: () => Promise<any> }> = [
          {
            label: "fn(optsObj,arrayIds)",
            call: () => (fetchBankrecs as any)({ apiKey }, [allianceId]),
          },
          {
            label: "fn(limit,arrayIds)",
            call: () => (fetchBankrecs as any)(limit, [allianceId]),
          },
          {
            label: "fn(arrayIds,optsObj)",
            call: () => (fetchBankrecs as any)([allianceId], { apiKey }),
          },
        ];

        for (const a of attempts) {
          try {
            const legacy: any = await a.call().catch(() => null);
            // Expect an array of alliances; pick the one matching our allianceId then take .bankrecs
            const arr = Array.isArray(legacy) ? legacy : [];
            const chosen = arr.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId);
            const br = (chosen?.bankrecs ?? []) as any[];
            legacyRows = Array.isArray(br) ? br.map(normalizeRow) : [];
            const withAmts = legacyRows.filter(hasAnyResources).length;
            console.log(`${TAG}[legacy attempt ${attempts.indexOf(a)+1} ${a.label}] rows=${legacyRows.length} withAmounts=${withAmts}`);
            if (legacyRows.length > 0) break;
          } catch (e) {
            console.log(`${TAG} legacy attempt failed:`, e);
          }
        }

        if (legacyRows.length > 0) {
          // Use only up to `limit`
          rows = legacyRows.slice(0, limit);
          console.log(`${TAG} legacy chosen rows: ${rows.length}`);
        } else {
          console.log(`${TAG} legacy returned 0 rows`);
        }
      }
    }

    // 2) Filter to tax-like rows for this alliance
    const taxRows = rows.filter(r => looksLikeTax(r, allianceId));
    console.log(`${TAG} tax-like rows: ${taxRows.length}`);

    // 3) Require that at least some rows have amounts > 0
    const anyAmounts = taxRows.some(r => hasAnyResources(r));
    if (!taxRows.length || !anyAmounts) {
      await safeEdit(interaction, { content: `No tax-like bank records with amounts found for alliance ${allianceId}.` });
      return;
    }

    // 4) Deduplicate by bankrec id (in case of mixed sources)
    const seen = new Set<number | string>();
    const uniq = taxRows.filter(r => {
      const id = r.id ?? r.bankrec_id ?? `${r.sender_id}:${r.receiver_id}:${r.date ?? r.time ?? ""}`;
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

    const nonZeroKeys = RES_KEYS.filter(k => (totals[k] || 0) !== 0);
    console.log(`${TAG} non-zero keys: ${nonZeroKeys.join(", ") || "(none)"}`);

    // 6) Credit the alliance treasury
    await creditTreasury(prisma, allianceId, totals, "tax");
    console.log(`${TAG} credited treasury for alliance=${allianceId}`);

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

    await safeEdit(interaction, { embeds: [embed] });

  } catch (err: any) {
    await safeEdit(interaction, { content: `❌ Error: ${err?.message ?? String(err)}` });
  }
}
