// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { open } from "../lib/crypto.js";
import { fetchAllianceBankrecsViaGQL } from "../lib/pnw";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Raw peek at recent alliance bankrecs (debug).")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Rows to fetch (default 50)"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const allianceId = i.options.getInteger("alliance_id", true);
  const limit = Math.max(1, Math.min(1000, i.options.getInteger("limit") ?? 50));

  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) return i.editReply("❌ No stored API key. Run **/pnw_set** first.");

  const apiKey = open(k.encryptedApiKey as any, k.nonceApi as any);

  try {
    const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, { limit });
    if (!rows.length) return i.editReply("No rows returned.");
    const head = rows.slice(0, 5).map(r =>
      `#${r.id}  ${new Date(r.date).toISOString()}  s:${r.sender_type}/${r.sender_id} → r:${r.receiver_type}/${r.receiver_id}  ${r.note || ""}`
    ).join("\n");
    await i.editReply("```\n" + head + "\n```");
  } catch (e: any) {
    await i.editReply(`❌ Fetch failed: ${e?.message || String(e)}`);
  }
}
