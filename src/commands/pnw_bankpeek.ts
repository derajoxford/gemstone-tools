import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { fetchBankrecsSince } from "../lib/pnw.js";
import { readTaxCursor } from "../utils/cursor.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_bankpeek")
  .setDescription("Peek raw PnW bankrecs (tax-only) since stored cursor.")
  .addIntegerOption((opt) =>
    opt.setName("alliance_id").setDescription("Alliance ID (default 14258)").setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("limit")
      .setDescription("Max rows to show (default 10)")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id") ?? 14258;
  const limit = interaction.options.getInteger("limit") ?? 10;

  await interaction.deferReply({ ephemeral: true });

  const sinceId = await readTaxCursor(prisma, allianceId);
  const rows = await fetchBankrecsSince(prisma, allianceId, sinceId, 500, 2000);

  const last = rows.slice(-limit);
  const lines = last.map(
    (r) =>
      `#${r.id}  tax_id=${r.tax_id}  ${r.sender_type}:${r.sender_id} → ${r.receiver_type}:${r.receiver_id}  money=${r.money}`
  );

  const embed = new EmbedBuilder()
    .setTitle(`Bankpeek — Alliance ${allianceId}`)
    .setDescription(
      lines.length
        ? "```txt\n" + lines.join("\n") + "\n```"
        : "(no tax rows since cursor)"
    )
    .addFields(
      { name: "Since Cursor", value: String(sinceId ?? "none"), inline: true },
      { name: "Fetched (tax)", value: String(rows.length), inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
