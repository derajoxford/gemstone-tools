// src/commands/offshore.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Colors,
} from "discord.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ---------- Bot-admins (for set_default) ----------
function botAdminIds(): string[] {
  const raw = process.env.BOT_ADMIN_IDS || "";
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function isBotAdmin(discordId: string | null | undefined): boolean {
  if (!discordId) return false;
  return botAdminIds().includes(discordId);
}

// ---------- Helpers ----------
async function getAllianceForGuild(i: ChatInputCommandInteraction) {
  if (!i.guildId) return null;
  return prisma.alliance.findFirst({ where: { guildId: i.guildId } });
}

async function getDefaultOffshore(): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: "offshore.default" } });
  const v = (row?.value as any)?.allianceId ?? null;
  return typeof v === "number" && v > 0 ? v : null;
}

async function setDefaultOffshore(aid: number | null) {
  if (aid && aid > 0) {
    await prisma.setting.upsert({
      where: { key: "offshore.default" },
      update: { value: { allianceId: aid } as any },
      create: { key: "offshore.default", value: { allianceId: aid } as any },
    });
  } else {
    // clear
    await prisma.setting.delete({ where: { key: "offshore.default" } }).catch(() => {});
  }
}

function fmtAid(aid: number | null | undefined): string {
  return aid && aid > 0 ? `ID ${aid}` : "— none —";
}

function effectiveOffshore(defaultAid: number | null, overrideAid: number | null) {
  return overrideAid && overrideAid > 0 ? overrideAid : defaultAid ?? null;
}

// ---------- Slash command builder ----------
export const data = new SlashCommandBuilder()
  .setName("offshore")
  .setDescription("Offshore controls (show, set default, set override, send)")
  .addSubcommand((sc) =>
    sc.setName("show").setDescription("Show effective offshore (override and default)")
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_default")
      .setDescription("Set global default offshore alliance id (0 to clear)")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID for global default (0 to clear)")
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("set_override")
      .setDescription("Set per-alliance offshore override (0 to clear)")
      .addIntegerOption((o) =>
        o
          .setName("alliance_id")
          .setDescription("Alliance ID for override (0 to clear)")
          .setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("send")
      .setDescription("Send this alliance treasury to its effective offshore")
  );

// ---------- Execute ----------
export async function execute(i: ChatInputCommandInteraction) {
  try {
    const sub = i.options.getSubcommand();
    if (sub === "show") return handleShow(i);
    if (sub === "set_default") return handleSetDefault(i);
    if (sub === "set_override") return handleSetOverride(i);
    if (sub === "send") return handleSend(i);
    return i.reply({ content: "Unknown subcommand.", ephemeral: true });
  } catch (err) {
    console.error("[offshore] handler error:", err);
    return i.reply({ content: "Something went wrong in /offshore. Check logs for details.", ephemeral: true });
  }
}

// ---------- Subhandlers ----------
async function handleShow(i: ChatInputCommandInteraction) {
  const alliance = await getAllianceForGuild(i);
  if (!alliance) {
    return i.reply({ content: "This Discord server isn’t linked to an alliance. Use /guild_link_alliance first.", ephemeral: true });
  }

  const def = await getDefaultOffshore();
  const ov = alliance.offshoreOverrideAllianceId ?? null;
  const eff = effectiveOffshore(def, ov);

  const embed = new EmbedBuilder()
    .setTitle("🏝️ Offshore — Current Settings")
    .addFields(
      { name: "Alliance", value: `ID ${alliance.id}`, inline: true },
      { name: "Default", value: def ? `ID ${def}` : "— not set —", inline: true },
      { name: "Override", value: fmtAid(ov), inline: true },
      { name: "Effective", value: fmtAid(eff), inline: false }
    )
    .setColor(Colors.Blurple);

  await i.reply({ embeds: [embed], ephemeral: true });
}

async function handleSetDefault(i: ChatInputCommandInteraction) {
  if (!isBotAdmin(i.user?.id)) {
    return i.reply({ content: "Only the **bot admin** can set the global default offshore.", ephemeral: true });
  }
  const aid = i.options.getInteger("alliance_id", true);
  await setDefaultOffshore(aid && aid > 0 ? aid : null);
  if (aid && aid > 0) {
    await i.reply({ content: `✅ Set global default offshore to alliance **${aid}**.`, ephemeral: true });
  } else {
    await i.reply({ content: "✅ Cleared global default offshore.", ephemeral: true });
  }
}

async function handleSetOverride(i: ChatInputCommandInteraction) {
  const alliance = await getAllianceForGuild(i);
  if (!alliance) {
    return i.reply({ content: "This Discord server isn’t linked to an alliance. Use /guild_link_alliance first.", ephemeral: true });
  }
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You need **Manage Server** to set or clear the override.", ephemeral: true });
  }

  const aid = i.options.getInteger("alliance_id", true);
  await prisma.alliance.update({
    where: { id: alliance.id },
    data: { offshoreOverrideAllianceId: aid && aid > 0 ? aid : null },
  });

  if (aid && aid > 0) {
    await i.reply({ content: `✅ Set offshore override for alliance **${alliance.id}** → **${aid}**.`, ephemeral: true });
  } else {
    await i.reply({ content: `✅ Cleared offshore override for alliance **${alliance.id}**.`, ephemeral: true });
  }
}

async function handleSend(i: ChatInputCommandInteraction) {
  const alliance = await getAllianceForGuild(i);
  if (!alliance) {
    return i.reply({ content: "This Discord server isn’t linked to an alliance. Use /guild_link_alliance first.", ephemeral: true });
  }
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return i.reply({ content: "You need **Manage Server** to send treasury to offshore.", ephemeral: true });
  }

  const def = await getDefaultOffshore();
  const ov = alliance.offshoreOverrideAllianceId ?? null;
  const eff = effectiveOffshore(def, ov);
  if (!eff) {
    return i.reply({ content: "No effective offshore is set (neither default nor override).", ephemeral: true });
  }

  // TODO: integrate the actual transfer logic (PnW API bulk withdrawal to target alliance).
  // For now, just acknowledge the target.
  const embed = new EmbedBuilder()
    .setTitle("⏩ Offshore Send (Preview)")
    .setDescription(
      `Would send alliance **${alliance.id}** treasury to offshore alliance **${eff}**.\n` +
      `• Default: ${def ? `ID ${def}` : "— not set —"}\n` +
      `• Override: ${fmtAid(ov)}\n` +
      `• Effective: ${fmtAid(eff)}`
    )
    .setColor(Colors.Gold);

  await i.reply({ embeds: [embed], ephemeral: true });
}

