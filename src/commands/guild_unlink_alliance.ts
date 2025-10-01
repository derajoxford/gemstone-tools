import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { unlinkGuild, resolveAllianceIdFromGuild } from "../utils/guildAlliance.js";

export const data = new SlashCommandBuilder()
  .setName("guild_unlink_alliance")
  .setDescription("Unlink THIS Discord server from its alliance.")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(i: any) {
  await i.deferReply({ ephemeral: true });

  if (!i.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
    return i.editReply("You need Administrator permission to use this command.");
  }

  const guildId = i.guild?.id;
  if (!guildId) return i.editReply("This command must be used inside a server.");

  const before = await resolveAllianceIdFromGuild(guildId);
  await unlinkGuild(guildId);
  return i.editReply(`✅ Unlinked this server from alliance ${before ? `AID=${before}` : "(none)"}.`);
}
