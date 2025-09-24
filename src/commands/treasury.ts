// src/commands/treasury.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import prisma from "../utils/db";
import { KEYS } from "../utils/treasury";

function detectModel(p: any): "treasury" | "allianceTreasury" | "alliance_treasury" {
  if (p?.treasury) return "treasury";
  if (p?.allianceTreasury) return "allianceTreasury";
  if (p?.alliance_treasury) return "alliance_treasury";
  throw new Error("Prisma model treasury not found");
}

export const data = new SlashCommandBuilder()
  .setName("treasury")
  .setDescription("Show the alliance treasury balances")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true);
  await interaction.deferReply({ ephemeral: true });

  try {
    const model = detectModel(prisma as any);
    const row =
      model === "treasury"
        ? await (prisma as any).treasury.findUnique({ where: { allianceId } })
        : model === "allianceTreasury"
        ? await (prisma as any).allianceTreasury.findUnique({ where: { allianceId } })
        : await (prisma as any).alliance_treasury.findUnique({ where: { allianceId } });

    const balances: Record<string, number> =
      (row?.balances as any) || Object.fromEntries(KEYS.map(k => [k, 0]));

    const lines = KEYS
      .filter(k => Number(balances[k] || 0) !== 0)
      .map(k => `**${k}**: ${Number(balances[k] || 0).toLocaleString()}`)
      .join(" · ") || "—";

    const embed = new EmbedBuilder()
      .setTitle(`💰 Treasury — Alliance ${allianceId}`)
      .setDescription(lines)
      .setColor(Colors.Blurple);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(`❌ Error: ${err?.message ?? String(err)}`);
  }
}
