// src/commands/pnw_logs.ts
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { getPnwLogs, type PnwApplyLogEntry } from "../utils/pnw_cursor";

export const data = new SlashCommandBuilder()
  .setName("pnw_logs")
  .setDescription("Show recent PnW tax apply logs (admin).")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((opt) =>
    opt.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("limit")
      .setDescription("How many logs (1-20). Default 10.")
      .setRequired(false)
  );

function fmtDelta(d: Record<string, number>): string {
  const keys = Object.keys(d);
  if (!keys.length) return "_no deltas_";
  // show up to 6 keys to keep tidy
  const shown = keys.slice(0, 6).map((k) => {
    const v = d[k];
    const money = k === "money";
    const num = money
      ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString();
    return `+${k}:${num}`;
  });
  const suffix = keys.length > 6 ? ` …(+${keys.length - 6} more)` : "";
  return shown.join("  ") + suffix;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const allianceId = interaction.options.getInteger("alliance_id", true);
  const limitRaw = interaction.options.getInteger("limit", false);
  const limit = Math.max(1, Math.min(20, limitRaw ?? 10));

  const logs = await getPnwLogs(allianceId, limit);

  const embed = new EmbedBuilder()
    .setTitle("PnW Apply Logs")
    .setColor(0x6c5ce7)
    .setDescription(`**Alliance ID:** \`${allianceId}\`\n**Entries:** \`${logs.length}\``);

  if (!logs.length) {
    embed.addFields({ name: "Logs", value: "_no apply logs yet_", inline: false });
  } else {
    const lines = logs.map((e: PnwApplyLogEntry) => {
      const who = e.actorTag ? `${e.actorTag} (${e.actorId})` : e.actorId;
      const range =
        e.fromCursor != null || e.toCursor != null
          ? `cursor ${e.fromCursor ?? "none"} → ${e.toCursor ?? "none"}`
          : "cursor none";
      return `• ${e.ts} — ${who} — ${range} — records:${e.records} — ${fmtDelta(e.delta)}`;
    });
    embed.addFields({ name: "Recent", value: lines.join("\n"), inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
