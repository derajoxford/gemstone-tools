// src/commands/treasury.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
} from "discord.js";
import prisma from "../utils/db";
import { getTreasury, RES_KEYS, type ResKey } from "../utils/treasury";

export const data = new SlashCommandBuilder()
  .setName("treasury")
  .setDescription("Show the alliance treasury balances")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("PnW alliance ID").setRequired(true)
  );

export async function execute(i: ChatInputCommandInteraction) {
  try {
    const allianceId = i.options.getInteger("alliance_id", true);
    await i.deferReply({ ephemeral: true });

    const balances = await getTreasury(prisma, allianceId);

    const lines = RES_KEYS
      .filter((k: ResKey) => Number(balances[k] || 0) !== 0)
      .map((k: ResKey) => `**${k}**: ${Number(balances[k] || 0).toLocaleString()}`);

    const embed = new EmbedBuilder()
      .setTitle(`🏦 Alliance Treasury — ${allianceId}`)
      .setDescription(lines.length ? lines.join("\n") : "_Empty_")
      .setColor(Colors.Blurple);

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    try {
      await (i.deferred || i.replied
        ? i.editReply(`❌ Error: ${err?.message ?? String(err)}`)
        : i.reply({ content: `❌ Error: ${err?.message ?? String(err)}`, ephemeral: true })
      );
    } catch {}
  }
}
