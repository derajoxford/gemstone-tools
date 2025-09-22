// src/commands/pnw_tax_sync.ts
import type { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { PrismaClient } from "@prisma/client";
import { applyAllianceTaxes } from "../lib/pnw_tax";

export const data = {
  name: "pnw_tax_sync",
  description: "Fetch recent tax credits for an alliance and credit the treasury",
  options: [
    {
      type: 4, // Integer
      name: "alliance_id",
      description: "PnW alliance id",
      required: true,
    },
    {
      type: 4, // Integer
      name: "limit",
      description: "How many recent taxrecs to fetch (default 50, max 100)",
      required: false,
    },
  ],
} as unknown as SlashCommandBuilder;

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true);
    const limitOpt = interaction.options.getInteger("limit", false) ?? 50;
    const limit = Math.min(Math.max(limitOpt, 1), 100);

    await interaction.deferReply({ ephemeral: true });

    const prisma = new PrismaClient();
    const res = await applyAllianceTaxes(prisma, allianceId, limit).catch(e => ({ applied: 0, newestId: null, reason: "error:" + String(e?.message || e) }));
    await prisma.$disconnect();

    if ((res as any).reason?.startsWith("missing_api_key")) {
      await interaction.editReply(`❌ Missing API key for alliance ${allianceId}. Set env \`PNW_API_KEY_${allianceId}\` or insert into table \`alliance_api_keys\`.`);
      return;
    }

    const summary = [
      `Alliance **${allianceId}**`,
      `Applied **${(res as any).applied ?? 0}** new taxrecs`,
      (res as any).newestId ? `Cursor → \`${(res as any).newestId}\`` : `Cursor unchanged`,
      (res as any).delta ? `Delta: \`${JSON.stringify((res as any).delta)}\`` : ``,
      (res as any).sampleIds?.length ? `Sample ids: \`${(res as any).sampleIds.join(", ")}\`` : ``,
      `Status: ${(res as any).reason}`,
    ].filter(Boolean).join("\n");

    await interaction.editReply(summary);
  } catch (e: any) {
    await interaction.editReply(`❌ Error: ${e?.message || e}`);
  }
}
