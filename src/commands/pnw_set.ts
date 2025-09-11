// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Colors,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { seal, open } from "../lib/crypto.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Save an alliance-scoped READ API key (used for validation only).")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true)!;

  const modal = new ModalBuilder()
    .setCustomId(`pnwset:${allianceId}`)
    .setTitle("PnW Alliance Read API Key");

  const apiKey = new TextInputBuilder()
    .setCustomId("api")
    .setLabel("Alliance API Key")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(apiKey));
  await interaction.showModal(modal);

  const submitted = await interaction
    .awaitModalSubmit({ time: 60_000, filter: i => i.customId === `pnwset:${allianceId}` })
    .catch(() => null);

  if (!submitted) return;

  try {
    const key = submitted.fields.getTextInputValue("api").trim();
    const { ciphertext: enc, iv } = seal(key);

    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: {},
      create: { id: allianceId },
    });

    await prisma.allianceKey.create({
      data: { allianceId, encryptedApiKey: enc, nonceApi: iv, addedBy: submitted.user.id },
    });

    // Sanity: try to decrypt back (guards ENCRYPTION_KEY mismatch)
    open(enc as any, iv as any);

    // Quick validation: run a preview (won’t error if zero)
    const preview = await previewAllianceTaxCreditsStored(allianceId, { lastSeenTs: 0, limit: 50 });

    const embed = new EmbedBuilder()
      .setTitle("✅ Alliance linked to PnW key.")
      .setDescription([
        `**Alliance ID:** ${allianceId}`,
        "",
        `Validation: preview returned **${preview.count}** tax-related bank record(s) in the recent window.`,
      ].join("\n"))
      .setColor(Colors.Green);

    await submitted.reply({ embeds: [embed], ephemeral: true });
  } catch (e: any) {
    await submitted.reply({ content: `❌ Failed to save key: ${e?.message || e}`, ephemeral: true });
  }
}
