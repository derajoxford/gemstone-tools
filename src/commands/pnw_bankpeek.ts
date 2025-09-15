// src/commands/pnw_bankpeek.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecsSince } from "../lib/pnw.js";
import { readTaxCursor } from "../utils/pnw_cursor.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Debug: fetch recent bankrecs from PnW GQL for an alliance")
  .setDefaultMemberPermissions(0)
  .setDMPermission(false)
  .addIntegerOption((opt) =>
    opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt.setName("limit").setDescription("Rows to fetch (default 100, max 500)").setRequired(false)
  )
  .addStringOption((opt) =>
    opt
      .setName("filter")
      .setDescription("Optional filter")
      .addChoices({ name: "tax", value: "tax" })
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limit = Math.min(500, Math.max(1, interaction.options.getInteger("limit") ?? 100));

  await interaction.deferReply({ ephemeral: true });

  const sinceId = await readTaxCursor(prisma, allianceId);
  const rows = await fetchBankrecsSince(prisma, allianceId, sinceId, 500, 5000);
  const last = rows.slice(-limit);

  const lines = last.map(
    (r) =>
      `#${r.id}  tax_id=${r.tax_id}  ${r.sender_type}:${r.sender_id} → ${r.receiver_type}:${r.receiver_id}  money=${r.money}`
  );

  const embed = new EmbedBuilder()
    .setTitle(`Bankpeek — Alliance ${allianceId}`)
    .setDescription(lines.length ? "```txt\n" + lines.join("\n") + "\n```" : "(no tax rows since cursor)")
    .addFields(
      { name: "Since Cursor", value: String(sinceId ?? "none"), inline: true },
      { name: "Fetched (tax)", value: String(rows.length), inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
