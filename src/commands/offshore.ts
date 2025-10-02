// src/commands/offshore.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  Colors,
  EmbedBuilder,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore settings & actions")
  .addSubcommand((s) =>
    s.setName("show").setDescription("Show effective offshore (override & default)")
  )
  .addSubcommand((s) =>
    s
      .setName("set_default")
      .setDescription("Set global default offshore alliance id (0 to clear)")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID (0 to clear)")
          .setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("set_override")
      .setDescription("Set per-alliance offshore override (0 to clear)")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID (0 to clear)")
          .setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s.setName("send").setDescription("Send this alliance treasury to its effective offshore")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(i: ChatInputCommandInteraction) {
  // Always defer so Discord stops showing “is thinking…”
  await i.deferReply({ ephemeral: true });
  const sub = i.options.getSubcommand();
  console.log(`[offshore] ${sub} invoked by ${i.user.id} in guild ${i.guildId}`);

  // Ensure this server is linked to an alliance
  const alliance = await prisma.alliance.findFirst({
    where: { guildId: i.guildId ?? "" },
  });

  if (!alliance) {
    await i.editReply(
      "This server is not linked to an alliance. Run **/setup_alliance alliance_id:<AID>** first."
    );
    return;
  }

  try {
    if (sub === "show") {
      const setting = await prisma.setting.findUnique({ where: { key: "offshore_default" } });
      const defaultId = Number((setting?.value as any)?.allianceId ?? 0) || 0;
      const overrideId = alliance.offshoreOverrideAllianceId ?? 0;
      const effective = overrideId || defaultId || 0;

      const emb = new EmbedBuilder()
        .setTitle("🏝️ Offshore — Current Settings")
        .addFields(
          { name: "Alliance", value: `ID ${alliance.id}`, inline: true },
          { name: "Default", value: defaultId ? String(defaultId) : "— not set —", inline: true },
          { name: "Override", value: overrideId ? String(overrideId) : "— none —", inline: true },
          { name: "Effective", value: effective ? String(effective) : "— none —", inline: true },
        )
        .setColor(Colors.Blurple);

      await i.editReply({ embeds: [emb] });
      return;
    }

    if (sub === "set_default") {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await i.editReply("You lack permission to manage this setting.");
        return;
      }
      const aid = Math.max(0, i.options.getInteger("alliance_id", true));
      if (aid === 0) {
        // clear
        await prisma.setting.upsert({
          where: { key: "offshore_default" },
          update: { value: {} },
          create: { key: "offshore_default", value: {} },
        });
        await i.editReply("✅ Cleared global default offshore.");
        return;
      }
      await prisma.setting.upsert({
        where: { key: "offshore_default" },
        update: { value: { allianceId: aid } },
        create: { key: "offshore_default", value: { allianceId: aid } },
      });
      await i.editReply(`✅ Set global default offshore to alliance **${aid}**.`);
      return;
    }

    if (sub === "set_override") {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await i.editReply("You lack permission to manage this setting.");
        return;
      }
      const aid = Math.max(0, i.options.getInteger("alliance_id", true));
      if (aid === 0) {
        await prisma.alliance.update({
          where: { id: alliance.id },
          data: { offshoreOverrideAllianceId: null },
        });
        await i.editReply("✅ Cleared this alliance’s offshore override.");
        return;
      }
      await prisma.alliance.update({
        where: { id: alliance.id },
        data: { offshoreOverrideAllianceId: aid },
      });
      await i.editReply(`✅ Set this alliance’s offshore override to **${aid}**.`);
      return;
    }

    if (sub === "send") {
      // Stub for now — confirms wiring. We’ll implement actual transfer logic next.
      const setting = await prisma.setting.findUnique({ where: { key: "offshore_default" } });
      const defaultId = Number((setting?.value as any)?.allianceId ?? 0) || 0;
      const overrideId = alliance.offshoreOverrideAllianceId ?? 0;
      const effective = overrideId || defaultId || 0;

      if (!effective) {
        await i.editReply(
          "No effective offshore is set. Use **/offshore set_override** or **/offshore set_default** first."
        );
        return;
      }

      await i.editReply(
        `🧪 Stub: would send this alliance’s treasury to offshore alliance **${effective}**.`
      );
      return;
    }

    // Should never hit
    await i.editReply("Unsupported subcommand.");
  } catch (err) {
    console.error("[offshore] handler error:", err);
    await i.editReply("Something went wrong in /offshore. Check logs for details.");
  }
}
