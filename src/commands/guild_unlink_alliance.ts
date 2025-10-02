// src/commands/guild_unlink_alliance.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("guild_unlink_alliance")
  .setDescription("Unlink THIS Discord server from its PnW Alliance mapping.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  const tag = "[guild_unlink_alliance]";
  try {
    if (!i.guildId) {
      return i.reply({ content: "This command can only be used in a server.", ephemeral: true });
    }

    // Remove Guild mapping
    await prisma.allianceGuild.deleteMany({ where: { guildId: i.guildId } });

    // If any Alliance record still has legacy guildId equal to this guild, clear it
    await prisma.alliance.updateMany({
      where: { guildId: i.guildId },
      data: { guildId: null },
    });

    await i.reply({ content: "✅ Unlinked this guild from any alliance mappings.", ephemeral: true });
  } catch (err: any) {
    console.error(`${tag} error:`, err);
    const msg =
      err?.code === "P2021"
        ? "Database table missing (did you run `npx prisma db push`?)."
        : "Something went wrong. Check bot logs for details.";
    try {
      await i.reply({ content: `❌ ${msg}`, ephemeral: true });
    } catch {}
  }
}
