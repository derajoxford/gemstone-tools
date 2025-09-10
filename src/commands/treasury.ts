// src/commands/treasury.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from "discord.js";
import { getTreasury, formatBalances } from "../utils/treasury_store";

export const data = new SlashCommandBuilder()
  .setName("treasury")
  .setDescription("Show the saved alliance treasury balances")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID (optional if only one is used)"))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id") ?? 14258; // default your test id if you want
    const bal = await getTreasury(allianceId);

    const embed = new EmbedBuilder()
      .setTitle(`Alliance Treasury`)
      .setDescription(`**Alliance:** ${allianceId}`)
      .addFields({ name: "Balances", value: formatBalances(bal) })
      .setColor(0x2ecc71);

    await i.editReply({ embeds: [embed] });
  } catch (e: any) {
    await i.editReply(`❌ ${e?.message ?? String(e)}`);
  }
}
