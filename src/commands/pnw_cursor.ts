// src/commands/pnw_cursor.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getPnwCursor, setPnwCursor } from "../utils/pnw_cursor";

export const data = new SlashCommandBuilder()
  .setName("pnw_cursor")
  .setDescription("View or modify the stored PnW bankrec cursor (admin).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("Show the stored cursor for an alliance.")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set")
      .setDescription("Set/override the stored cursor (requires confirm:true).")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("cursor").setDescription("Bankrec id to store").setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName("confirm")
          .setDescription("Must be true to save the new cursor.")
          .setRequired(false)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription("Clear the stored cursor (requires confirm:true).")
      .addIntegerOption((opt) =>
        opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
      .addBooleanOption((opt) =>
        opt
          .setName("confirm")
          .setDescription("Must be true to clear the cursor.")
          .setRequired(false)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand(true);
  const allianceId = interaction.options.getInteger("alliance_id", true);

  if (sub === "view") {
    const cur = await getPnwCursor(allianceId);
    const embed = new EmbedBuilder()
      .setTitle("PnW Cursor")
      .setColor(0x0984e3)
      .setDescription(
        `**Alliance ID:** \`${allianceId}\`\n**Stored cursor:** \`${cur ?? "none"}\``
      );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "set") {
    const cursor = interaction.options.getInteger("cursor", true);
    const confirm = interaction.options.getBoolean("confirm", false) ?? false;
    if (!confirm) {
      await interaction.editReply(
        `Preview: would set cursor for alliance \`${allianceId}\` to \`${cursor}\`.\nRe-run with \`confirm:true\` to save.`
      );
      return;
    }
    await setPnwCursor(allianceId, cursor);
    await interaction.editReply(`✅ Cursor saved for alliance \`${allianceId}\`: \`${cursor}\`.`);
    return;
  }

  if (sub === "clear") {
    const confirm = interaction.options.getBoolean("confirm", false) ?? false;
    if (!confirm) {
      await interaction.editReply(
        `Preview: would clear cursor for alliance \`${allianceId}\`.\nRe-run with \`confirm:true\` to clear.`
      );
      return;
    }
    await setPnwCursor(allianceId, undefined as any); // remove by writing undefined
    await interaction.editReply(`✅ Cursor cleared for alliance \`${allianceId}\`.`);
    return;
  }
}

export default { data, execute };
