// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open } from "../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL, isLikelyTaxRow } from "../lib/pnw";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: fetch recent bankrecs from PnW GQL for an alliance")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Rows to fetch (default 100, max 500)"))
  .addStringOption(o =>
    o.setName("filter")
      .setDescription("Optional filter")
      .addChoices({ name: "tax", value: "tax" })
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  const allianceId = i.options.getInteger("alliance_id", true);
  const limit = Math.max(1, Math.min(500, i.options.getInteger("limit") ?? 100));
  const filter = i.options.getString("filter") ?? "";

  try {
    const k = await prisma.allianceKey.findFirst({
      where: { allianceId },
      orderBy: { id: "desc" },
    });
    if (!k) {
      return i.editReply("❌ No stored API key. Run **/pnw_set** first.");
    }
    const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);

    const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
    const picked = filter === "tax" ? rows.filter(r => isLikelyTaxRow(r, allianceId)) : rows;

    const lastFew = picked.slice(0, 5).map(r => {
      const goods = ["money","food","coal","oil","uranium","lead","iron","bauxite","gasoline","munitions","steel","aluminum"]
        .map(k => ({ k, v: Number((r as any)[k] || 0) }))
        .filter(x => x.v);
      const top = goods.slice(0, 3).map(x => `${x.k}:${x.v.toLocaleString()}`).join(" · ") || "—";
      return `#${r.id} • ${new Date(r.date).toLocaleString()} • sender ${r.sender_type}:${r.sender_id} → receiver ${r.receiver_type}:${r.receiver_id}\n${r.note || "—"}\n${top}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`Bankpeek ${filter ? `(filter=${filter})` : ""}`)
      .setDescription(
        [
          `Alliance: **${allianceId}**`,
          `Fetched: **${picked.length}** (raw: ${rows.length}, limit: ${limit})`,
          "",
          lastFew.length ? lastFew.join("\n\n") : "— none —",
        ].join("\n")
      )
      .setColor(Colors.Blurple);

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    console.error("[/pnw_bankpeek] error", err);
    await i.editReply(`❌ Fetch failed: ${err?.message || String(err)}`);
  }
}
