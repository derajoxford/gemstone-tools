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

/** Robust extractor that tries multiple common shapes. */
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
        if (Number.isFinite(n) && n !== 0) { v = n; break; }
      }
    }
    out[k] = Number.isFinite(v) ? v : 0;
  }

  // Also check typical nested objects some feeds use
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

function cleanPreview(obj: any) {
  // show key shape without flooding: core ids, types, note, date, plus any resource-ish keys we see
  const keep = new Set([
    "id","date","note","sender_type","sender_id","receiver_type","receiver_id",
    "money","cash","money_amount","food","coal","oil","uranium","lead","iron",
    "bauxite","gasoline","gas","munitions","ammo","steel","aluminum","aluminium",
  ]);
  const out: Record<string, any> = {};
  for (const [k,v] of Object.entries(obj || {})) {
    if (keep.has(k)) {
      out[k] = typeof v === "string" && v.length > 200 ? v.slice(0,200)+"…" : v;
    }
  }
  // also show nested candidates if present
  for (const nest of ["resources","delta","amounts"]) {
    if (obj && obj[nest]) {
      out[nest] = {};
      for (const [k,v] of Object.entries(obj[nest])) {
        if (typeof v === "number" || typeof v === "string") {
          (out[nest] as any)[k] = v;
        }
      }
    }
  }
  return out;
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Scan nation→alliance deposits (incl. Automated Tax) and credit the alliance treasury")
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

    // Pull BOTH feeds, concat, and de-dupe by id
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

    const depositRows = merged.filter(r => isNationToAlliance(r, allianceId));
    if (!depositRows.length) {
      await interaction.editReply(`No nation→alliance deposits found for alliance ${allianceId}.`);
      return;
    }

    // Try to apply rows with non-zero deltas
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
      // --- NEW: show sample rows so we can adapt extractor to your exact shape ---
      const samples = depositRows.slice(0, 3).map(cleanPreview);
      const block = "```json\n" + JSON.stringify(samples, null, 2).slice(0, 1800) + "\n```";
      await interaction.editReply(
        [
          `No tax-like bank records **with amounts** found for alliance ${allianceId}.`,
          `Here are sample rows I received (first ${samples.length}):`,
          block,
          `Reply here with which keys hold the amounts and I’ll lock the parser to them.`,
        ].join("\n")
      );
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
