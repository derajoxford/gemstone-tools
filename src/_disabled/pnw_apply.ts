import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { applyTaxes, formatDelta } from "../integrations/pnw/tax.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_apply")
  .setDescription("Apply PnW tax credits to treasury and advance cursor.")
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("Alliance ID (default 14258)")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id") ?? 14258;

  await interaction.deferReply({ ephemeral: true });

  const result = await applyTaxes(prisma, allianceId);

  const embed = new EmbedBuilder()
    .setTitle(`PnW Tax Apply — Alliance ${allianceId}`)
    .addFields(
      { name: "Applied Rows", value: String(result.count), inline: true },
      { name: "New Cursor", value: String(result.newestId ?? "unchanged"), inline: true },
      { name: "Delta Posted", value: "```txt\n" + formatDelta(result.delta) + "\n```" }
    )
    .setFooter({ text: "Taxes posted to treasury. Cursor advanced (if any rows)." });

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
