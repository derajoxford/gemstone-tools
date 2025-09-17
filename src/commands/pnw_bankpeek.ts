// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs } from "../lib/pnw.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Preview recent bank records for an alliance")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addStringOption(o =>
    o
      .setName("filter")
      .setDescription("Filter by type")
      .addChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" },
        { name: "nontax", value: "nontax" },
      )
      .setRequired(true),
  )
  .addIntegerOption(o =>
    o.setName("after_id").setDescription("Only show records after this bankrec ID").setRequired(false),
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("Max rows (default 50, max 200)").setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

function isTax(tax_id: any) {
  return tax_id != null && tax_id !== 0 && tax_id !== "0";
}

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const filter = (i.options.getString("filter", true) as "all" | "tax" | "nontax");
    const afterId = i.options.getInteger("after_id") ?? null;
    const limit = Math.min(200, Math.max(1, i.options.getInteger("limit") ?? 50));

    const rows = await fetchBankrecs(prisma, allianceId, { afterId, filter, limit });

    const header = `Alliance ${allianceId} • after_id=${afterId ?? "-"} • filter=${filter} • limit=${limit}`;
    if (!rows || rows.length === 0) {
      await i.editReply(`${header}\n\nNo bank records found.`);
      return;
    }

    const lines = rows
      .map(r => {
        const bracket = isTax(r.tax_id) ? `TAX#${String(r.tax_id)}` : "NONTAX";
        const note = (r.note ?? "").replace(/&bull;/g, "•");
        return `${r.id} • ${r.date} • ${bracket} • ${note}`.trim();
      })
      .join("\n");

    // Keep it simple text to avoid truncation; switch to embed if you prefer.
    await i.editReply(`${header}\n\n${lines}`);
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
