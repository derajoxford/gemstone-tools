// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { resourceEmbed } from "../lib/embeds";
import { RESOURCE_KEYS } from "../integrations/pnw/tax.js";
import { addToTreasury } from "../utils/treasury_store";

export const data = new SlashCommandBuilder()
  .setName("treasury_add")
  .setDescription("Admin: add (or subtract) amounts to the alliance treasury (JSON payload).")
  .addStringOption(o =>
    o
      .setName("payload")
      .setDescription('JSON like {"money":1000000,"steel":500} (negative values allowed)')
      .setRequired(true),
  )
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
    const allianceId = i.options.getInteger("alliance_id") ?? 0;
    const note = i.options.getString("note") ?? "";

    const obj = JSON.parse(payload);
    // Light validation: only allow known resource keys; coerce numbers
    const clean: Record<string, number> = {};
    for (const k of RESOURCE_KEYS) {
      const v = Number(obj?.[k]);
      if (Number.isFinite(v) && v !== 0) clean[k] = v;
    }

    if (Object.keys(clean).length === 0) {
      throw new Error(
        "Payload contained no valid resource keys. Valid keys: " + "`" + RESOURCE_KEYS.join("`, `") + "`",
      );
    }

    await addToTreasury(allianceId, clean);

    const lines = Object.entries(clean)
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
