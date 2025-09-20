import type { ChatInputCommandInteraction, CacheType } from "discord.js";
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

/**
 * /who — scaffold
 * Search a player by Discord name, Nation name, or Leader name.
 * Step 1: UI scaffold only (compiles & registers).
 * Step 2: We'll wire data sources (DB + PnW GraphQL) and visuals.
 */
export const data = new SlashCommandBuilder()
  .setName("who")
  .setDescription("Search a player by Discord name, Nation name, or Leader name.")
  .addStringOption(o =>
    o.setName("query")
      .setDescription("What are you searching for?")
      .setRequired(true)
  )
  .addStringOption(o =>
    o.setName("type")
      .setDescription("Choose the field to search")
      .addChoices(
        { name: "Discord", value: "discord" },
        { name: "Nation", value: "nation" },
        { name: "Leader", value: "leader" },
      )
  )
  .addBooleanOption(o =>
    o.setName("ephemeral")
      .setDescription("Show the result only to you (default: on)")
  );

export async function execute(interaction: ChatInputCommandInteraction<CacheType>) {
  const query = interaction.options.getString("query", true);
  const type  = interaction.options.getString("type") as "discord" | "nation" | "leader" | null;
  const ephemeral = interaction.options.getBoolean("ephemeral") ?? true;

  await interaction.deferReply({ ephemeral });

  const title = type
    ? `Search • ${type.charAt(0).toUpperCase() + type.slice(1)}`
    : "Search • Smart";

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription("We’ll show rich player cards here (nation, leader, alliance, units, timers, etc.).")
    .addFields(
      { name: "Query", value: `\`${query}\``, inline: true },
      { name: "Mode", value: type ? `\`${type}\`` : "`auto`", inline: true },
    )
    .setFooter({ text: "Gemstone Tools — /who" })
    .setTimestamp()
    .setColor(0x39A6FF);

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
