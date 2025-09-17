// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecs, type Bankrec } from "../lib/pnw.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Fetch recent alliance bank records (optionally filter to tax/non-tax).")
  .addIntegerOption(o =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID")
      .setRequired(true),
  )
  .addIntegerOption(o =>
    o
      .setName("after_id")
      .setDescription("Only records after this bankrec ID (optional)")
      .setRequired(false),
  )
  .addStringOption(o =>
    o
      .setName("filter")
      .setDescription("Filter: all | tax | nontax")
      .setChoices(
        { name: "all", value: "all" },
        { name: "tax", value: "tax" },
        { name: "nontax", value: "nontax" },
      )
      .setRequired(false),
  )
  .addIntegerOption(o =>
    o
      .setName("limit")
      .setDescription("Max rows (default 50, max 200)")
      .setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const afterId = i.options.getInteger("after_id") ?? null;
    const filter = (i.options.getString("filter") as "all" | "tax" | "nontax" | null) ?? "all";
    const limitRaw = i.options.getInteger("limit") ?? 50;
    const limit = Math.max(1, Math.min(200, limitRaw));

    const rows: Bankrec[] = await fetchBankrecs(prisma, allianceId, { afterId, filter, limit });

    if (!rows.length) {
      await i.editReply(`No bank records found (alliance ${allianceId}${afterId ? `, after ${afterId}` : ""}, filter=${filter}).`);
      return;
    }

    // Show a compact preview (most recent first)
    const sample = rows
      .slice()
      .reverse()
      .map(r => {
        const t = r.tax_id != null ? "TAX" : "NT";
        const amt = (r.amount ?? 0).toLocaleString();
        const note = (r.note ?? "").replace(/\s+/g, " ").slice(0, 80);
        return `${r.id} • ${r.date} • ${t} • $${amt} • ${note}`;
      })
      .slice(-20) // cap display
      .join("\n");

    await i.editReply(
      "```" +
        `Alliance ${allianceId} • after_id=${afterId ?? "-"} • filter=${filter} • limit=${limit}\n\n` +
        sample +
      "```",
    );
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
