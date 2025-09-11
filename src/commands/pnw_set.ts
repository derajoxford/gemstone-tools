// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { seal } from "../lib/crypto.js";
import { getPnwCursor } from "../utils/pnw_cursor";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Link this alliance to a PnW user API key (for tax reads).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  const allianceId = interaction.options.getInteger("alliance_id", true)!;

  const modal = new ModalBuilder()
    .setCustomId(`pnwset:${allianceId}`)
    .setTitle("PnW User API Key");

  const api = new TextInputBuilder()
    .setCustomId("apiKey")
    .setLabel("User API Key")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(api)
  );

  await interaction.showModal(modal);
}

// Handle the modal submission in your index.ts (you already have a pattern there).
// Example handler (if you need it):
// client.on('interactionCreate', async (i) => {
//   if (!i.isModalSubmit()) return;
//   if (!i.customId.startsWith('pnwset:')) return;
//   const allianceId = Number(i.customId.split(':')[1] || 0);
//   const apiKey = i.fields.getTextInputValue('apiKey');
//   const { ciphertext: encApi, iv: ivApi } = seal(apiKey);
//   await prisma.alliance.upsert({ where: { id: allianceId }, update: {}, create: { id: allianceId } });
//   await prisma.allianceKey.create({ data: { allianceId, encryptedApiKey: encApi, nonceApi: ivApi, addedBy: i.user.id } });
//   const cursor = (await getPnwCursor(allianceId)) ?? 0;
//   await i.reply({ content: `✅ Alliance linked to PnW key.\nAlliance ID: ${allianceId}\n(Stored cursor: id > ${cursor})`, ephemeral: true });
// });
