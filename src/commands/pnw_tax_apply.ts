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
import { fetchBankrecs } from "../lib/pnw";
import { creditTreasury } from "../utils/treasury";
import { open } from "../lib/crypto.js";

// ---- interaction safety helpers ----
async function safeDefer(i: ChatInputCommandInteraction, ephemeral = true) {
  try {
    if (!i.deferred && !i.replied) {
      await i.deferReply({ ephemeral }); // flags:64 under the hood
    }
  } catch (e: any) {
    // Ignore "Unknown interaction" (10062) or "already acknowledged" (40060)
    if (e?.code === 10062 || e?.code === 40060) return false;
    throw e;
  }
  return true;
}

async function safeEdit(i: ChatInputCommandInteraction, payload: any) {
  try {
    if (i.deferred) return await i.editReply(payload);
    if (!i.replied) return await i.reply({ ...payload, ephemeral: true });
    return await i.followUp({ ...payload, ephemeral: true });
  } catch (e: any) {
    if (e?.code === 10062 || e?.code === 40060) {
      // Try a last followUp as a fallback
      try { return await i.followUp({ ...payload, ephemeral: true }); } catch {}
      return;
    }
    throw e;
  }
}


type AnyRow = Record<string, any>;

const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type ResTotals = Partial<Record<ResKey, number>>;

function num(v: any): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // tolerate strings with commas/symbols
  const cleaned = String(v).replace(/[^0-9.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
function toCamel(k: string) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function getAmount(row: AnyRow, k: ResKey): number {
  // support snake_case and camelCase
  return num(row[k] ?? row[toCamel(k)]);
}
function hasAnyResources(row: AnyRow): boolean {
  return RES_KEYS.some((k) => getAmount(row, k) !== 0);
}
function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  // Typical PnW tax: nation (3) -> alliance (2), receiver is our alliance.
  // Some rows carry “Automated Tax 100%/100%” in note (we also accept note containing 'tax').
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_apply")
  .setDescription("Credit recent tax rows into the alliance treasury")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Max rows to scan (default 200)")
      .setMinValue(1)
      .setMaxValue(2000)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitOpt = interaction.options.getInteger("limit");
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  await interaction.deferReply({ flags: 64 }); // ephemeral via flags

  try {
    // 1) GQL attempt
    let rows: AnyRow[] = await queryAllianceBankrecs(
      allianceId,
      limit,
      BankrecFilter.TAX
    );

    // If GQL rows have no amounts, try legacy with an API key
    const gqlHasAmounts = rows.some((r) => hasAnyResources(r));
    if (!gqlHasAmounts) {
      // Find the latest stored alliance key, else fallback to env default
      const alliance = await prisma.alliance.findUnique({
        where: { id: allianceId },
        include: { keys: { orderBy: { id: "desc" }, take: 1 } },
      });
      const enc = alliance?.keys?.[0];
      const apiKey = enc
        ? open(enc.encryptedApiKey as any, enc.nonceApi as any)
        : process.env.PNW_DEFAULT_API_KEY || "";

      if (!apiKey) {
        await interaction.editReply(
          "No tax-like bank records with amounts found, and no API key available for legacy fetch. Set an alliance key with **/setup_alliance**."
        );
        return;
      }

      // Legacy top-level fetch returns array of alliances; we need ours
      const legacy: any = await (fetchBankrecs as any)({ apiKey }, [allianceId]).catch(() => null);
      const legacyRows: AnyRow[] = Array.isArray(legacy)
        ? (legacy.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId)?.bankrecs ?? [])
        : [];

      if (legacyRows.length) {
        rows = legacyRows.slice(0, limit);
      }
    }

    // 2) Filter to tax-like rows for this alliance
    const taxRows = rows.filter((r) => looksLikeTax(r, allianceId));

    // 3) Require at least one row with non-zero amounts
    const anyAmounts = taxRows.some((r) => hasAnyResources(r));
    if (!taxRows.length || !anyAmounts) {
      await interaction.editReply(
        `No tax-like bank records with amounts found for alliance ${allianceId}.`
      );
      return;
    }

    // 4) Deduplicate by an id-ish key
    const seen = new Set<number | string>();
    const uniq = taxRows.filter((r) => {
      const id =
        r.id ??
        r.bankrec_id ??
        `${r.sender_id ?? r.senderId}:${r.receiver_id ?? r.receiverId}:${
          r.date ?? r.time ?? ""
        }`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // 5) Sum the resources
    const totals: ResTotals = {};
    for (const k of RES_KEYS) totals[k] = 0;
    for (const r of uniq) {
      for (const k of RES_KEYS) {
        const v = getAmount(r, k);
        if (v) totals[k]! = (totals[k] || 0) + v;
      }
    }

    // 6) Credit treasury
    await creditTreasury(prisma, allianceId, totals, "tax");

    // 7) Reply summary
    const lines = RES_KEYS
      .map((k) => ({ k, v: Number(totals[k] || 0) }))
      .filter((x) => x.v !== 0)
      .map((x) => `**${x.k}**: ${x.v.toLocaleString()}`);

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
