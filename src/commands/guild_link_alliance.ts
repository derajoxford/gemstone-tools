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
  .setDescription("Link THIS Discord server to a PnW Alliance ID")
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("PnW Alliance ID")
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  if (!i.guildId) {
    return i.reply({ content: "This can only be used in a server.", ephemeral: true });
  }

  const hasPerm =
    i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
  if (!hasPerm) {
    return i.reply({
      content: "You need **Manage Server** to run this.",
      ephemeral: true,
    });
  }

  const allianceId = i.options.getInteger("alliance_id", true);

  await i.deferReply({ ephemeral: true });
  console.log(
    `[guild_link_alliance] invoked by ${i.user.id} in guild ${i.guildId} -> alliance ${allianceId}`
  );

  try {
    // 1) Ensure the Alliance row exists
    await prisma.alliance.upsert({
      where: { id: allianceId },
      update: { updatedAt: new Date(), guildId: i.guildId },
      create: {
        id: allianceId,
        guildId: i.guildId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // 2) Upsert the guild link using the UNIQUE guildId key
    await prisma.allianceGuild.upsert({
      where: { guildId: i.guildId }, // <-- UNIQUE in schema
      update: { allianceId, createdAt: undefined },
      create: { allianceId, guildId: i.guildId },
    });

    console.log(
      `[guild_link_alliance] linked guild ${i.guildId} -> alliance ${allianceId}`
    );
    await i.editReply(
      `✅ Linked this server to alliance **${allianceId}**.`
    );
  } catch (err: any) {
    console.error("[guild_link_alliance] error:", err);
    const msg =
      err?.code === "P2002"
        ? "Database unique constraint error (duplicate)."
        : err?.code === "P2021"
        ? "DB table missing—did you run the migrations?"
        : err?.code === "P2022"
        ? "DB column mismatch—schema vs. DB out of sync."
        : "Unexpected error. Check bot logs.";
    await i.editReply(`❌ Failed to link: ${msg}`);
  }
}
