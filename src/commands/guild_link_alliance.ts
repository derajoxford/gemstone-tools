// src/commands/guild_link_alliance.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("guild_link_alliance")
  .setDescription("Link THIS Discord server to a PnW alliance (banking/safekeeping scope)")
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("PnW Alliance ID (e.g. 14364)")
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  // Always answer quickly so Discord doesn’t sit in “thinking”
  await i.deferReply({ ephemeral: true });

  try {
    if (!i.guildId) {
      return i.editReply("This command can only be used inside a server.");
    }

    const allianceId = i.options.getInteger("alliance_id", true);

    // Ensure the Alliance exists (or create a minimal row)
    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: { updatedAt: new Date() },
      create: { id: allianceId },
    });

    // Create/Update the Guild→Alliance link (unique per guild)
    await prisma.allianceGuild.upsert({
      where: { guildId: i.guildId },
      update: { allianceId },
      create: { guildId: i.guildId, allianceId },
    });

    // Also store the allianceId on the Alliance row for convenience (optional)
    await prisma.alliance.update({
      where: { id: allianceId },
      data: { guildId: i.guildId },
    });

    await i.editReply(
      `✅ Linked this server to PnW alliance **${allianceId}**.\n` +
      `Members here can now use **/link_nation** and safekeeping will scope to this alliance.\n\n` +
      `If you want a review channel for approvals, set it with **/set_review_channel**.`
    );
  } catch (err: any) {
    console.error("[guild_link_alliance] error:", err);
    try {
      await i.editReply("❌ Something went wrong linking this guild. Check bot logs for details.");
    } catch {}
  }
}
