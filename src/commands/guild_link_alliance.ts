import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { PrismaClient } from "@prisma/client";
import { linkGuildToAlliance, resolveAllianceIdFromGuild } from "../utils/guildAlliance.js";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("guild_link_alliance")
  .setDescription("Link THIS Discord server to a Politics & War alliance ID.")
  .addIntegerOption(o =>
    o.setName("alliance_id")
      .setDescription("Numeric Alliance ID (AID) to link this server to")
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(i: any) {
  await i.deferReply({ ephemeral: true });

  if (!i.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return i.editReply("You need Administrator permission to use this command.");
  }

  const guildId = i.guild?.id;
  if (!guildId) return i.editReply("This command must be used inside a server.");

  const allianceId = i.options.getInteger("alliance_id", true);
  if (allianceId <= 0) return i.editReply("Alliance ID must be a positive number.");

  await linkGuildToAlliance(guildId, allianceId);

  const current = await resolveAllianceIdFromGuild(guildId);
  return i.editReply(`✅ This server is now linked to alliance **AID=${current}**.`);
}
