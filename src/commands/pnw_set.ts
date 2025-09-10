// src/commands/pnw_set.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { seal } from "../lib/crypto";
import { resourceEmbed } from "../lib/embeds";

const prisma = new PrismaClient();

type ResourceDelta = Record<string, number>;

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}
function formatDelta(delta: ResourceDelta): string {
  const keys = Object.keys(delta || {});
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr =
      k === "money"
        ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_set")
  .setDescription("Link an alliance to a PnW API key (stores encrypted).")
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addStringOption((o) =>
    o.setName("api_key").setDescription("PnW API key").setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const apiKey = interaction.options.getString("api_key", true)!;

    // Save alliance row (if missing)
    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: { guildId: interaction.guildId ?? undefined },
      create: { id: allianceId, guildId: interaction.guildId ?? undefined },
    });

    // Encrypt + store key
    const { ciphertext, iv } = seal(apiKey);
    await prisma.allianceKey.create({
      data: {
        allianceId,
        encryptedApiKey: ciphertext,
        nonceApi: iv,
        addedBy: interaction.user.id,
      },
    });

    // Validate with a quick preview using stored key
    let previewText = "Validation skipped.";
    try {
      const preview = await previewAllianceTaxCreditsStored(allianceId, null);
      const count = preview?.count ?? 0;
      const totalsBlock = formatDelta((preview?.delta ?? {}) as any);
      previewText =
        count > 0
          ? `Validation: preview returned **${count}** tax-related bank record(s) in the recent window.\n` +
            codeBlock(totalsBlock)
          : `Validation: no tax-related records visible in the recent window.`;
    } catch (e: any) {
      previewText = `Validation failed: ${e?.message || String(e)}`;
    }

    const embed = resourceEmbed({
      title: "✅ Alliance linked to PnW key.",
      subtitle: `**Alliance ID:** ${allianceId}`,
      fields: [{ name: "Check", value: previewText }],
      color: 0x2ecc71,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply(
      `❌ Failed to save key: ${err?.message || String(err)}`,
    );
  }
}
