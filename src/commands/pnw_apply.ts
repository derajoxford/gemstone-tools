// src/commands/pnw_apply.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";

import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { getPnwCursor, setPnwCursor, appendPnwApplyLog } from "../utils/pnw_cursor";
import { addToTreasury } from "../utils/treasury_store";
import { resourceEmbed } from "../lib/embeds";

type ResourceDelta = Record<string, number>;
function codeBlock(s: string) { return s ? "```\n" + s + "\n```" : "—"; }

function formatDelta(delta: ResourceDelta): string {
  const keys = Object.keys(delta || {});
  const lines: string[] = [];
  for (const k of keys) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr = k === "money"
      ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_apply")
  .setDescription("Fetch Automated Tax rows (scraped), sum, and optionally apply to treasury.")
  .addIntegerOption(o =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true),
  )
  .addBooleanOption(o =>
    o.setName("confirm").setDescription("If true, credit to treasury and advance cursor").setRequired(true),
  )
  .addIntegerOption(o =>
    o.setName("limit").setDescription("Max rows to scan (most recent)").setMinValue(1).setMaxValue(2000),
  )
  .addIntegerOption(o =>
    o.setName("last_seen").setDescription("Override cursor: rows with timestamp(ms) > last_seen will be counted"),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const confirm = interaction.options.getBoolean("confirm", true) ?? false;
    const limit = interaction.options.getInteger("limit") ?? null;
    const override = interaction.options.getInteger("last_seen") ?? null;

    const storedCursor = await getPnwCursor(allianceId).catch(() => 0);
    const lastSeenTs = override ?? (storedCursor || 0);

    const preview = await previewAllianceTaxCreditsStored(allianceId, {
      lastSeenTs,
      limit: limit ?? undefined,
    });

    const totalsBlock = formatDelta(preview.delta as ResourceDelta);
    const hasAny = (totalsBlock || "").trim().length > 0;

    let applied = false;
    let advancedTo: number | null = null;

    if (confirm && preview.count > 0 && hasAny) {
      // 1) credit to treasury
      await addToTreasury(allianceId, preview.delta as any);

      // 2) advance cursor to newestTs (timestamp in ms)
      if (typeof preview.newestTs === "number" && preview.newestTs > (lastSeenTs || 0)) {
        await setPnwCursor(allianceId, preview.newestTs);
        advancedTo = preview.newestTs;
      }

      // 3) log
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "apply",
        lastSeenId: lastSeenTs || null,
        newestId: preview.newestTs ?? null,
        records: preview.count,
        delta: preview.delta,
      } as any);
      applied = true;
    } else {
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "preview",
        lastSeenId: lastSeenTs || null,
        newestId: preview.newestTs ?? null,
        records: preview.count,
        delta: preview.delta,
      } as any);
    }

    const embed = resourceEmbed({
      title: `PnW Tax ${applied ? "Apply" : "Preview"} (Stored Key)`,
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenTs || 0}`,
        limit ? `**Scan limit:** ${limit}` : `**Scan window:** default`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestTs ?? "—"}`,
      ].join("\n"),
      fields: [
        { name: applied ? "Applied delta (sum)" : "Tax delta (sum)", value: codeBlock(totalsBlock || ""), inline: false },
      ],
      color: applied ? 0x2ecc71 : 0x5865f2,
      footer: applied
        ? (advancedTo ? `Credited to treasury. Cursor saved as ${advancedTo}.` : `Credited to treasury.`)
        : `Preview only. Use confirm:true to apply and advance cursor.`,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    console.error("[/pnw_apply] error:", err);
    await interaction.editReply(`❌ ${err?.message || String(err)}`);
  }
}
