// src/commands/treasury_add.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { resourceEmbed } from "../lib/embeds";
import { addToTreasury } from "../utils/treasury_store";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type Delta = Record<string, number>;
const RES_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

function asCleanDelta(input: any): Delta {
  const out: Delta = {};
  for (const k of RES_KEYS) {
    const v = Number(input?.[k] ?? 0);
    if (Number.isFinite(v) && v !== 0) out[k] = v;
  }
  return out;
}

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}

function formatDelta(delta: Delta): string {
  const keys = Object.keys(delta);
  if (!keys.length) return "—";
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr =
      k === "money"
        ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : Math.round(v).toLocaleString();
    const sign = v >= 0 ? "+" : "";
    lines.push(`${k.padEnd(10)} ${sign}${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("treasury_add")
  .setDescription("Admin: add (or subtract) amounts to the alliance treasury (JSON payload).")
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID (defaults to this server's linked alliance)")
      .setRequired(false),
  )
  .addStringOption((o) =>
    o
      .setName("payload")
      .setDescription('JSON like {"money":1000000,"steel":500} (negative values allowed)')
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("note")
      .setDescription("Optional note to include in the reply")
      .setRequired(false),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Resolve alliance
    let allianceId = interaction.options.getInteger("alliance_id") ?? null;
    if (!allianceId) {
      const a = await prisma.alliance.findFirst({
        where: { guildId: interaction.guildId ?? "" },
        select: { id: true },
      });
      if (!a) {
        return interaction.editReply(
          "This server is not linked to an alliance. Run **/setup_alliance** first."
        );
      }
      allianceId = a.id;
    }

    // Parse payload JSON
    let raw: any;
    try {
      raw = JSON.parse(interaction.options.getString("payload", true));
    } catch {
      return interaction.editReply("❌ Invalid JSON in `payload`.");
    }
    const delta = asCleanDelta(raw);
    if (!Object.keys(delta).length) {
      return interaction.editReply("Nothing to add — your payload is all zeros or empty.");
    }

    // Apply to treasury
    await addToTreasury(allianceId, delta);

    // Build embed
    const note = interaction.options.getString("note") || undefined;
    const embed = resourceEmbed({
      title: "🏛️ Treasury Adjusted",
      subtitle: `**Alliance:** ${allianceId}`,
      fields: [
        { name: "Delta", value: codeBlock(formatDelta(delta)), inline: false },
        ...(note ? [{ name: "Note", value: note, inline: false }] : []),
      ],
      color: 0x2ecc71,
      footer: `Invoker: ${interaction.user.tag}`,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    console.error("[/treasury_add] error:", err);
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    await interaction.editReply(msg);
  }
}
