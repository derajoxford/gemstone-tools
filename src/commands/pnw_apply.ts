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
  const lines: string[] = [];
  for (const k of Object.keys(delta || {})) {
    const v = Number(delta[k] ?? 0);
    if (!v) continue;
    const asStr = k === "money" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.round(v).toLocaleString();
    lines.push(`${k.padEnd(10)} +${asStr}`);
  }
  return lines.join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("pnw_apply")
  .setDescription("Fetch tax-only bankrecs (GQL tax_id), sum, and optionally apply to treasury.")
  .addIntegerOption(o => o.setName("alliance_id").setDescription("Alliance ID").setRequired(true))
  .addBooleanOption(o => o.setName("confirm").setDescription("If true, credit to treasury and advance cursor").setRequired(true))
  .addIntegerOption(o => o.setName("limit").setDescription("Max rows to scan (default 300, max 500)").setRequired(false))
  .addIntegerOption(o => o.setName("last_seen").setDescription("Override cursor: only records with id > last_seen").setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(i: ChatInputCommandInteraction) {
  await i.deferReply({ ephemeral: true });

  try {
    const allianceId = i.options.getInteger("alliance_id", true)!;
    const confirm = i.options.getBoolean("confirm", true) ?? false;
    const limit = Math.max(1, Math.min(500, i.options.getInteger("limit") ?? 300));
    const overrideLastSeen = i.options.getInteger("last_seen") ?? null;

    const storedCursor = await getPnwCursor(allianceId);
    const lastSeenId = overrideLastSeen ?? (storedCursor ?? 0);

    const preview = await previewAllianceTaxCreditsStored(allianceId, lastSeenId, limit);
    const totalsBlock = formatDelta(preview.delta);
    const hasPositive = totalsBlock.trim().length > 0;

    let applied = false;
    let cursorAdvancedTo: number | null = null;

    if (confirm && preview.count > 0 && hasPositive) {
      await addToTreasury(allianceId, preview.delta);
      if (typeof preview.newestId === "number" && preview.newestId > (lastSeenId ?? 0)) {
        await setPnwCursor(allianceId, preview.newestId);
        cursorAdvancedTo = preview.newestId;
      }
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "apply",
        lastSeenId: lastSeenId ?? null,
        newestId: preview.newestId ?? null,
        records: preview.count,
        delta: preview.delta,
      } as any);
      applied = true;
    } else {
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "preview",
        lastSeenId: lastSeenId ?? null,
        newestId: preview.newestId ?? null,
        records: preview.count,
        delta: preview.delta,
      } as any);
    }

    const embed = resourceEmbed({
      title: `PnW Tax ${applied ? "Apply" : "Preview"} (Stored Key / GQL)`,
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        `**Scan limit:** ${limit}`,
        `**Records counted:** ${preview.count}`,
        `**Newest bankrec id:** ${preview.newestId ?? "—"}`,
      ].join("\n"),
      fields: [{ name: applied ? "Applied delta (sum)" : "Tax delta (sum)", value: codeBlock(totalsBlock || ""), inline: false }],
      color: applied ? 0x2ecc71 : 0x5865f2,
      footer: applied
        ? cursorAdvancedTo
          ? `Credited to treasury. Cursor saved as ${cursorAdvancedTo}.`
          : `Credited to treasury.`
        : `Preview only. Use confirm:true to apply and advance cursor.`,
    });

    await i.editReply({ embeds: [embed] });
  } catch (err: any) {
    await i.editReply(`❌ ${err?.message ?? String(err)}`);
  }
}
