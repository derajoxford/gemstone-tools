// src/commands/pnw_tax_ids.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { resourceEmbed } from "../lib/embeds";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}
type Delta = Record<string, number>;

function formatDelta(delta: Delta): string {
  const keys = Object.keys(delta || {});
  if (!keys.length) return "—";
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
  .setName("pnw_tax_ids")
  .setDescription("Legacy tax-id utilities (diagnostic).")
  .addSubcommand((s) =>
    s
      .setName("get")
      .setDescription("Show the current (legacy) tax-id filter (deprecated).")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("Set a (legacy) tax-id filter (deprecated; no-op).")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("value").setDescription("Ignored").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("clear")
      .setDescription("Clear the (legacy) tax-id filter (deprecated; no-op).")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("sniff")
      .setDescription("Diagnose automated-tax detection by scanning recent bankrecs.")
      .addIntegerOption((o) =>
        o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
      )
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("How many recent bankrecs to scan (default 300, max 1000)")
          .setRequired(false)
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  const sub = i.options.getSubcommand(true);
  const allianceId = i.options.getInteger("alliance_id", true);

  try {
    if (sub === "get") {
      const embed = resourceEmbed({
        title: "PnW Tax Filter (Legacy)",
        subtitle: `**Alliance:** ${allianceId}`,
        fields: [
          {
            name: "Status",
            value:
              "We no longer use a numeric tax-id filter. Detection is by **note includes** (e.g., `Automated Tax`).",
            inline: false,
          },
        ],
        color: 0x5865f2,
        footer:
          "Tip: Use /pnw_preview or /pnw_apply — they already apply the new detection.",
      });
      return i.editReply({ embeds: [embed] });
    }

    if (sub === "set") {
      const embed = resourceEmbed({
        title: "PnW Tax Filter Set (Legacy, No-Op)",
        subtitle: `**Alliance:** ${allianceId}`,
        fields: [
          {
            name: "Result",
            value:
              "This setting is deprecated and not used anymore. We detect by **note** text now.",
            inline: false,
          },
        ],
        color: 0xffa500,
        footer: "Use /pnw_preview to verify detection on live data.",
      });
      return i.editReply({ embeds: [embed] });
    }

    if (sub === "clear") {
      const embed = resourceEmbed({
        title: "PnW Tax Filter Cleared (Legacy, No-Op)",
        subtitle: `**Alliance:** ${allianceId}`,
        fields: [
          {
            name: "Result",
            value:
              "There is no stored numeric tax-id in use. Nothing to clear.",
            inline: false,
          },
        ],
        color: 0xaaaaaa,
        footer: "Use /pnw_preview to verify detection on live data.",
      });
      return i.editReply({ embeds: [embed] });
    }

    // sniff
    const limitOpt = i.options.getInteger("limit") ?? 300;
    const LIMIT = Math.max(1, Math.min(1000, limitOpt));

    // Reuse the same preview routine the apply/preview commands use.
    // It fetches bankrecs via GraphQL and filters by automated-tax note patterns.
    const preview = await previewAllianceTaxCreditsStored(allianceId, 0, LIMIT);

    const count = preview?.count ?? 0;
    const newestId = preview?.newestId ?? "—";
    const delta = (preview?.delta ?? {}) as Record<string, number>;

    const embed = resourceEmbed({
      title: "PnW Tax Sniff (Diagnostic)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Scan limit:** ${LIMIT}`,
        `**Records detected:** ${count}`,
        `**Newest bankrec id:** ${newestId}`,
      ].join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(formatDelta(delta)),
          inline: false,
        },
        {
          name: "Detector",
          value:
            "Matches **incoming member ➜ alliance** rows whose note contains “Automated Tax” (case-insensitive).",
          inline: false,
        },
      ],
      color: 0x2ecc71,
      footer:
        count > 0
          ? "Looks good. Use /pnw_apply to credit to treasury."
          : "No automated-tax rows found in this window.",
    });

    return i.editReply({ embeds: [embed] });
  } catch (err: any) {
    console.error("[/pnw_tax_ids]", err);
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    return i.editReply(msg);
  }
}
