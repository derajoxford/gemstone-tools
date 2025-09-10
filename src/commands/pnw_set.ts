// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { seal } from "../lib/crypto.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Link/save a PnW Alliance READ API key for tax previews & applies")
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("PnW Alliance ID")
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("api_key")
      .setDescription("Alliance READ API key (paste here)")
      .setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const apiKey = interaction.options.getString("api_key", true)!.trim();

    if (!apiKey) {
      await interaction.editReply("❌ Please provide a non-empty API key.");
      return;
    }

    // Encrypt & store
    const { ciphertext: encryptedApiKey, iv: nonceApi } = seal(apiKey);

    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: { guildId: interaction.guildId ?? undefined },
      create: { id: allianceId, guildId: interaction.guildId ?? undefined },
    });

    await prisma.allianceKey.create({
      data: {
        allianceId,
        encryptedApiKey,
        nonceApi,
        addedBy: interaction.user.id,
      },
    });

    await interaction.editReply(
      `✅ Alliance linked to PnW key.\nAlliance ID: **${allianceId}**`,
    );

    // Guarded validation preview (small window)
    try {
      const pv = await previewAllianceTaxCreditsStored(allianceId, 0, 50);
      const c = pv?.count ?? 0;
      await interaction.followUp({
        content: `Check\nValidation: preview returned **${c}** tax-related bank record(s) in the recent window.`,
        ephemeral: true,
      });
    } catch (e: any) {
      await interaction.followUp({
        content: `Check\nValidation failed: ${e?.message || String(e)}`,
        ephemeral: true,
      });
    }
  } catch (err: any) {
    await interaction.editReply(
      `❌ Failed to save key: ${err?.message || String(err)}`,
    );
  }
}
