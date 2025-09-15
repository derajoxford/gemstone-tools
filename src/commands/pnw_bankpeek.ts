// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";

import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, BankrecRow } from "../lib/pnw";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: fetch recent bankrecs from PnW GQL for an alliance")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Rows to fetch (default 100, max 500)").setRequired(false))
  .addStringOption(o =>
    o
      .setName("filter")
      .setDescription("Optional filter")
      .addChoices(
        { name: "tax_in", value: "tax_in" }, // tax credits to alliance only
        { name: "tax_any", value: "tax_any" } // any row with tax_id > 0
      )
      .setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

function briefRow(r: BankrecRow): string {
  const when = new Date(r.date).toLocaleString();
  const header = `#${r.id} • ${when} • sender ${r.sender_type}:${r.sender_id} → receiver ${r.receiver_type}:${r.receiver_id}`;
  const note = r.note && r.note.trim() ? r.note : "—";
  const parts: string[] = [];
  const keys = ["money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum"] as const;
  for (const k of keys) {
    const v = Number((r as any)[k] ?? 0);
    if (v) parts.push(`${k}:${k==="money"?v.toLocaleString():v.toLocaleString()}`);
  }
  const body = parts.length ? parts.join(" · ") : "—";
  return `${header}\n${note}\n${body}`;
}

function isTaxAny(r: BankrecRow) {
  return r.tax_id != null && Number(r.tax_id) > 0;
}
function isTaxCreditToAlliance(r: BankrecRow, allianceId: number) {
  return isTaxAny(r) && r.receiver_type === 2 && r.receiver_id === allianceId;
}

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const limit = Math.max(1, Math.min(500, i.options.getInteger("limit") ?? 100));
    const filter = (i.options.getString("filter") ?? "").toLowerCase();

    const k = await prisma.allianceKey.findFirst({ where: { allianceId }, orderBy: { id: "desc" } });
    if (!k) throw new Error(`❌ No stored API key. Run /pnw_set first (and ensure secrets match).`);

    const apiKey = open(k.encryptedApiKey, k.nonceApi);
    const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });

    let filtered = rows;
    if (filter === "tax_in") filtered = rows.filter(r => isTaxCreditToAlliance(r, allianceId));
    else if (filter === "tax_any") filtered = rows.filter(isTaxAny);

    const lines: string[] = [];
    for (const r of filtered.slice(0, 20)) lines.push(briefRow(r));

    const embed = new EmbedBuilder()
      .setTitle(`Bankpeek${filter ? ` (filter=${filter})` : ""}`)
      .setDescription(
        [
          `**Alliance:** ${allianceId}`,
          `**Fetched:** ${filtered.length} (raw: ${rows.length}, limit: ${limit})`,
          "",
          lines.join("\n\n") || "—",
        ].join("\n"),
      )
      .setColor(0x00a8ff);

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    await i.editReply(`❌ Fetch failed: ${err?.message ?? String(err)}`);
  }
}
