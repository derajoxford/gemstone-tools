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
  .setDescription("Link THIS Discord server to a PnW alliance for Gemstone Tools.")
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("PnW Alliance ID")
      .setRequired(true)
  )
  .addBooleanOption(o =>
    o.setName("force")
      .setDescription("Override if this guild is already linked to a DIFFERENT alliance")
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  if (!i.guildId) {
    return i.reply({ content: "This command can only be used in a server.", ephemeral: true });
  }
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You need **Manage Server** to run this.", ephemeral: true });
  }

  const allianceId = i.options.getInteger("alliance_id", true);
  const force = i.options.getBoolean("force") ?? false;

  // log for journalctl
  console.log("[guild_link_alliance] start", {
    guildId: i.guildId,
    userId: i.user.id,
    allianceId,
    force
  });

  try {
    // Ensure Alliance exists
    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: {},
      create: { id: allianceId, guildId: null },
    });

    // Check current mapping (unique on guildId)
    const existing = await prisma.allianceGuild.findUnique({
      where: { guildId: i.guildId },
    });

    if (!existing) {
      // Not linked yet → create link
      await prisma.allianceGuild.create({
        data: { guildId: i.guildId, allianceId },
      });
      console.log("[guild_link_alliance] linked new", { guildId: i.guildId, allianceId });
      return i.reply({
        content: `✅ Linked this server to alliance **${allianceId}**.`,
        ephemeral: true,
      });
    }

    // Already linked
    if (existing.allianceId === allianceId) {
      console.log("[guild_link_alliance] idempotent", { guildId: i.guildId, allianceId });
      return i.reply({
        content: `✅ Already linked to alliance **${allianceId}** (no change).`,
        ephemeral: true,
      });
    }

    // Linked to a different alliance
    if (!force) {
      console.warn("[guild_link_alliance] already linked to different", {
        guildId: i.guildId,
        existingAllianceId: existing.allianceId,
        requestedAllianceId: allianceId,
      });
      return i.reply({
        content:
          `⚠️ This server is already linked to alliance **${existing.allianceId}**.\n` +
          `If you truly want to re-link to **${allianceId}**, rerun with \`force: true\`.`,
        ephemeral: true,
      });
    }

    // Force relink
    await prisma.allianceGuild.update({
      where: { guildId: i.guildId },
      data: { allianceId },
    });
    console.log("[guild_link_alliance] relinked (force)", { guildId: i.guildId, allianceId });
    return i.reply({
      content: `🔁 Re-linked this server to alliance **${allianceId}** (force).`,
      ephemeral: true,
    });
  } catch (err: any) {
    // Surface friendly info + log the details
    console.error("[guild_link_alliance] error", {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      stack: err?.stack,
    });
    const code = err?.code ? ` (code ${err.code})` : "";
    return i.reply({
      content: `❌ Failed to link. Please try again or contact an admin.${code}`,
      ephemeral: true,
    });
  }
}
