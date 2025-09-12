// src/commands/pnw_tax_debug.ts
import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

export const data = new SlashCommandBuilder()
  .setName("pnw_tax_debug")
  .setDescription("Fetch and parse the PnW bank taxes HTML; print parser diagnostics.")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  );

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  try {
    const allianceId = i.options.getInteger("alliance_id", true);
    const preview = await previewAllianceTaxCreditsStored(allianceId, null, null);

    const d = preview.debug || {};
    const lines = [
      `**Alliance:** ${allianceId}`,
      `**Rows parsed:** ${preview.count}`,
      `**Blocked:** ${d.blocked ? "yes" : "no"}`,
      `**Matched bank taxes table:** ${d.matchedTable ? "yes" : "no"}`,
      `**Fetched bytes:** ${d.fetchedBytes ?? "?"}`,
      d.savedFile ? `**Saved HTML:** \`${d.savedFile}\`` : undefined,
    ].filter(Boolean).join("\n");

    const lastFew = preview.count
      ? "— showing first row only —"
      : "— none —";

    await i.editReply({
      content: `**PnW Tax Debug**\n${lines}\n\n**Last few rows**\n${lastFew}`,
    });
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message || String(err)}`);
  }
}
