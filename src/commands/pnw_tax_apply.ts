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
import { open } from "../lib/crypto.js";

const TAG = "[tax_apply]";

// -------------------- resource & typing helpers --------------------
const RES_KEYS = [
  "money","food","coal","oil","uranium","lead","iron",
  "bauxite","gasoline","munitions","steel","aluminum",
] as const;
type ResKey = typeof RES_KEYS[number];
type ResTotals = Partial<Record<ResKey, number>>;
type AnyRow = Record<string, any>;

function toCamel(k: string) {
  return k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function num(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.+-]/g, "");
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

function looksLikeTax(row: AnyRow, allianceId: number): boolean {
  const sType = Number(row.sender_type ?? row.senderType ?? 0);
  const rType = Number(row.receiver_type ?? row.receiverType ?? 0);
  const rId   = Number(row.receiver_id ?? row.receiverId ?? 0);
  const note  = String(row.note ?? "").toLowerCase();
  return rType === 2 && rId === allianceId && (sType === 3 || note.includes("tax"));
}

function normalizeRow(raw: AnyRow): AnyRow {
  const out: AnyRow = { ...raw };
  if (out.bankrec_id && !out.id) out.id = out.bankrec_id;
  if (!out.date && out.time) out.date = out.time;
  return out;
}

// -------------------- safe Discord reply helpers --------------------
async function safeDefer(i: ChatInputCommandInteraction, ephemeral = true) {
  try {
    try {
      await i.deferReply({ ephemeral });
    } catch {
      await i.deferReply({ flags: 64 as any }).catch(() => {});
    }
  } catch {}
}
async function safeEdit(i: ChatInputCommandInteraction, data: any) {
  try {
    await i.editReply(data);
  } catch {
    try { await i.followUp({ ...data, ephemeral: true }); } catch {}
  }
}

// -------------------- raw GraphQL fallback (with alliance API key) --------------------
async function fetchBankrecsWithApiKey(allianceId: number, limit: number): Promise<AnyRow[]> {
  // Pull latest saved alliance API key
  const alliance = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });

  const enc = alliance?.keys?.[0];
  const apiKey = enc ? open(enc.encryptedApiKey as any, enc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  if (!apiKey) {
    console.log(`${TAG} rawGQL: no API key available for alliance=${allianceId}`);
    return [];
  }

  // Query: explicitly select resource fields
  const query = `
    query Bankrecs($aid: Int!, $first: Int!) {
      bankrecs(alliance_id: $aid, first: $first, orderBy: { id: DESC }) {
        data {
          id
          date
          note
          sender_type
          sender_id
          receiver_type
          receiver_id
          money
          food
          coal
          oil
          uranium
          lead
          iron
          bauxite
          gasoline
          munitions
          steel
          aluminum
        }
      }
    }
  `;

  try {
    const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        // X-Bot-Key is optional for queries, but include if present
        ...(process.env.PNW_BOT_KEY ? { "X-Bot-Key": process.env.PNW_BOT_KEY } : {}),
      },
      body: JSON.stringify({ query, variables: { aid: allianceId, first: Math.max(1, Math.min(limit, 2000)) } }),
    });

    const data = await res.json().catch(() => ({} as any));
    if (!res.ok || (data as any)?.errors) {
      console.log(`${TAG} rawGQL error`, res.status, JSON.stringify((data as any)?.errors || {}));
      return [];
    }

    const rows: AnyRow[] = data?.data?.bankrecs?.data ?? [];
    console.log(`${TAG} rawGQL returned rows=${Array.isArray(rows) ? rows.length : 0}`);
    return Array.isArray(rows) ? rows.map(normalizeRow) : [];
  } catch (e) {
    console.log(`${TAG} rawGQL fetch failed`, e);
    return [];
  }
}

// -------------------- slash metadata --------------------
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

// -------------------- command handler --------------------
export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitOpt = interaction.options.getInteger("limit");
  const limit = Math.max(1, Math.min(limitOpt ?? 200, 2000));

  console.log(`${TAG} GQL fetch TAX rows for alliance=${allianceId} limit=${limit}`);
  await safeDefer(interaction, true);

  try {
    // 1) Helper GQL
    let rows: AnyRow[] = await queryAllianceBankrecs(allianceId, limit, BankrecFilter.TAX);
    rows = Array.isArray(rows) ? rows.map(normalizeRow) : [];
    console.log(`${TAG} GQL returned ${rows.length} rows`);
    let gqlHasAmounts = rows.some(r => hasAnyResources(r));

    // 2) Legacy fallbacks (three signatures)
    if (!gqlHasAmounts) {
      console.log(`${TAG} GQL had no amounts; fallback=true`);
      const apiKey = process.env.PNW_DEFAULT_API_KEY || "";
      if (apiKey) {
        const attempts: Array<{ label: string; call: () => Promise<any> }> = [
          { label: "fn(optsObj,arrayIds)", call: () => (fetchBankrecs as any)({ apiKey }, [allianceId]) },
          { label: "fn(limit,arrayIds)",   call: () => (fetchBankrecs as any)(limit, [allianceId]) },
          { label: "fn(arrayIds,optsObj)", call: () => (fetchBankrecs as any)([allianceId], { apiKey }) },
        ];
        let legacyRows: AnyRow[] = [];
        for (let idx = 0; idx < attempts.length; idx++) {
          try {
            const a = attempts[idx];
            const legacy: any = await a.call().catch(() => null);
            const arr = Array.isArray(legacy) ? legacy : [];
            const chosen = arr.find((x: any) => Number(x?.id ?? x?.alliance_id) === allianceId);
            const br = (chosen?.bankrecs ?? []) as any[];
            legacyRows = Array.isArray(br) ? br.map(normalizeRow) : [];
            const withAmts = legacyRows.filter(hasAnyResources).length;
            console.log(`${TAG}[legacy attempt ${idx + 1} ${a.label}] rows=${legacyRows.length} withAmounts=${withAmts}`);
            if (legacyRows.length > 0 && withAmts > 0) break;
          } catch (e) {
            console.log(`${TAG} legacy attempt failed`, e);
          }
        }
        if (legacyRows.length > 0) {
          rows = legacyRows.slice(0, limit);
          gqlHasAmounts = rows.some(r => hasAnyResources(r));
        }
      }
    }

    // 3) Raw GraphQL with alliance API key (explicit resource fields)
    if (!rows.length || !rows.some(r => hasAnyResources(r))) {
      console.log(`${TAG} trying rawGQL with alliance API key for amounts…`);
      const raw = await fetchBankrecsWithApiKey(allianceId, limit);
      if (raw.length) {
        rows = raw;
      }
    }

    // 4) Keep only tax-like for this alliance
    const taxRows = rows.filter(r => looksLikeTax(r, allianceId));
    console.log(`${TAG} tax-like rows: ${taxRows.length}`);

    // 5) Require amounts > 0
    const anyAmounts = taxRows.some(r => hasAnyResources(r));
    if (!taxRows.length || !anyAmounts) {
      await safeEdit(interaction, { content: `No tax-like bank records with amounts found for alliance ${allianceId}.` });
      return;
    }

    // 6) Dedup by id
    const seen = new Set<number | string>();
    const uniq = taxRows.filter(r => {
      const id = r.id ?? r.bankrec_id ?? `${r.sender_id}:${r.receiver_id}:${r.date ?? r.time ?? ""}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // 7) Sum resources
    const totals: ResTotals = {};
    for (const k of RES_KEYS) totals[k] = 0;
    for (const r of uniq) {
      for (const k of RES_KEYS) {
        const v = getAmount(r, k);
        if (v) totals[k]! = (totals[k] || 0) + v;
      }
    }
    const nonZero = RES_KEYS.filter(k => (totals[k] || 0) !== 0);
    console.log(`${TAG} non-zero keys: ${nonZero.join(", ") || "(none)"}`);

    // 8) Credit treasury
    await creditTreasury(prisma, allianceId, totals, "tax");
    console.log(`${TAG} credited treasury for alliance=${allianceId}`);

    // 9) Reply
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
