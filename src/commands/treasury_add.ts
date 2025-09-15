// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { addToTreasury } from "../utils/treasury_store";
import { resourceEmbed } from "../lib/embeds";

export const data = new SlashCommandBuilder()
  .setName("treasury_add")
  .setDescription("Admin: add (or subtract) amounts to the alliance treasury (JSON payload).")
  // REQUIRED FIRST
  .addStringOption(o =>
    o
      .setName("payload")
      .setDescription('JSON like {"money":1000000,"steel":500} (negative values allowed)')
      .setRequired(true),
  )
  // OPTIONAL AFTER
  .addIntegerOption(o =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID (defaults to this server's linked alliance)")
      .setRequired(false),
  )
  .addStringOption(o =>
    o.setName("note").setDescription("Optional note to include in the reply").setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const payload = i.options.getString("payload", true)!;
    const allianceId = i.options.getInteger("alliance_id") ?? 0; // your env/linking may override 0 elsewhere
    const note = i.options.getString("note") ?? "";

    const obj = JSON.parse(payload);
    await addToTreasury(allianceId, obj);

    const lines = Object.entries(obj)
      .map(([k, v]) =>
        `${String(k).padEnd(10)} ${Number(v) >= 0 ? "+" : ""}${Number(v).toLocaleString()}`,
      )
      .join("\n");

    const embed = resourceEmbed({
      title: "Treasury Updated",
      subtitle: `Alliance: ${allianceId || "default"}`,
      fields: [{ name: "Delta", value: "```\n" + lines + "\n```" }],
      color: 0x2ecc71,
      footer: note || undefined,
    });
    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
