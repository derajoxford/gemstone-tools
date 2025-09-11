// src/commands/pnw_tax_debug.ts
import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { scrapeAllianceAutomatedTaxes } from "../integrations/pnw/tax_scrape";
import { resourceEmbed } from "../lib/embeds";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_debug")
  .setDescription("Debug-scrape the banktaxes page and report what we see.")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const rows = await scrapeAllianceAutomatedTaxes(allianceId);

    const previews = rows.slice(-5).map(r =>
      `• ${new Date(r.at).toLocaleString()}  |  note: ${r.note.slice(0,80)}`
    ).join("\n") || "— none —";

    const embed = resourceEmbed({
      title: "PnW Tax Debug",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Rows parsed:** ${rows.length}`,
      ].join("\n"),
      fields: [{ name: "Last few rows", value: "```\n" + previews + "\n```", inline: false }],
      color: 0x99aab5,
      footer: "If rows=0, server might be blocking (Cloudflare/login) or there are no tax rows in the last 14 days.",
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (e: any) {
    await interaction.editReply(`❌ Debug failed: ${e?.message || String(e)}`);
  }
}
