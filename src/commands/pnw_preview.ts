import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { previewTaxes, formatDelta } from "../integrations/pnw/tax.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_preview")
  .setDescription("Preview un-applied PnW tax credits (cursor-safe).")
  .addIntegerOption((opt) =>
    opt
      .setName("alliance_id")
      .setDescription("Alliance ID (default 14258)")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id") ?? 14258;

  await interaction.deferReply({ ephemeral: true });

  const prev = await previewTaxes(prisma, allianceId);

  const embed = new EmbedBuilder()
    .setTitle(`PnW Tax Preview — Alliance ${allianceId}`)
    .addFields(
      { name: "Rows", value: String(prev.count), inline: true },
      { name: "Newest Bankrec ID", value: String(prev.newestId ?? "—"), inline: true },
      { name: "Delta", value: "```txt\n" + formatDelta(prev.delta) + "\n```" }
    )
    .setFooter({ text: "Use /pnw_apply to post to treasury and advance cursor." });

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
