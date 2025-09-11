// src/commands/pnw_preview.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { resourceEmbed } from "../lib/embeds";
import { getPnwCursor } from "../utils/pnw_cursor";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}

function formatDelta(delta: Record<string, number>): string {
  const keys = Object.keys(delta || {});
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
  .setName("pnw_preview")
  .setDescription(
    "Preview PnW automated tax records (stored key), sum deltas (no apply)."
  )
  .addIntegerOption((o) =>
    o
      .setName("alliance_id")
      .setDescription("Alliance ID")
      .setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName("limit")
      .setDescription("Try scanning a larger recent window (best effort)")
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });
  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const limit = i.options.getInteger("limit") ?? undefined;

    const storedCursor = await getPnwCursor(allianceId);
    const lastSeenId = storedCursor ?? 0;

    const preview = await previewAllianceTaxCreditsStored(
      allianceId,
      lastSeenId || null,
      { limit, sampleSize: 3 }
    );

    const totalsBlock = formatDelta(preview.delta);
    const embed = resourceEmbed({
      title: "PnW Tax Preview (Stored Key)",
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        `**Scan window:** ${limit ? `${limit} (best effort)` : "default"}`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestId ?? "—"}`,
        preview.sample?.length
          ? `**Sample:** ${preview.sample
              .map((r) => `#${r.id} — ${r.note || "—"}`)
              .join("  •  ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      fields: [
        {
          name: "Tax delta (sum)",
          value: codeBlock(totalsBlock || ""),
          inline: false,
        },
      ],
      color: 0x5865f2,
      footer: "Preview only.",
    });

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    const msg =
      err?.message?.startsWith("PnW GraphQL error") ||
      err?.message?.includes("No valid stored")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    console.error("[/pnw_preview] error:", err);
    await i.editReply(msg);
  }
}
