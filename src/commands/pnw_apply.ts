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

function codeBlock(s: string) {
  return s ? "```\n" + s + "\n```" : "—";
}

function formatDelta(delta: ResourceDelta): string {
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
  .setName("pnw_apply")
  .setDescription(
    "Fetch PnW bank *tax* records (stored key), sum deltas, and (optionally) apply to treasury."
  )
  .addIntegerOption((o) =>
    o.setName("alliance_id").setDescription("Alliance ID").setRequired(true)
  )
  .addBooleanOption((o) =>
    o
      .setName("confirm")
      .setDescription("If true, credit to treasury and advance cursor")
      .setRequired(true)
  )
  .addIntegerOption((o) =>
    o
      .setName("last_seen")
      .setDescription("Override cursor: only records with id > last_seen are counted")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const allianceId = interaction.options.getInteger("alliance_id", true)!;
    const confirm = interaction.options.getBoolean("confirm", true) ?? false;

    const overrideLastSeen = interaction.options.getInteger("last_seen") ?? null;

    // Read stored cursor unless overridden (used for display + to decide if we should advance)
    const storedCursor = await getPnwCursor(allianceId);
    const lastSeenId = overrideLastSeen ?? (storedCursor ?? 0);

    // Preview recent tax-only bank records using the stored key.
    // NOTE: The preview function already applies the cursor internally and returns newestId.
    const preview = await previewAllianceTaxCreditsStored(allianceId, 500);
    const count = preview?.count ?? 0;
    const newestId = preview?.newestId ?? null;
    const delta = (preview?.delta ?? {}) as ResourceDelta;

    const totalsBlock = formatDelta(delta);
    const hasPositive = totalsBlock.trim().length > 0;

    let applied = false;
    let cursorAdvancedTo: number | null = null;

    if (confirm && count > 0 && hasPositive) {
      // 1) credit to our local treasury store
      await addToTreasury(allianceId, delta);

      // 2) advance cursor to newestId (if present and beyond current)
      if (typeof newestId === "number" && newestId > (lastSeenId ?? 0)) {
        await setPnwCursor(allianceId, newestId);
        cursorAdvancedTo = newestId;
      }

      // 3) log the apply event
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "apply",
        lastSeenId: lastSeenId ?? null,
        newestId: newestId ?? null,
        records: count,
        delta,
      } as any);

      applied = true;
    } else {
      // preview-only log (useful for traceability)
      await appendPnwApplyLog({
        allianceId,
        at: new Date().toISOString(),
        mode: "preview",
        lastSeenId: lastSeenId ?? null,
        newestId: newestId ?? null,
        records: count,
        delta,
      } as any);
    }

    // Build embed response
    const embed = resourceEmbed({
      title: `PnW Tax ${applied ? "Apply" : "Preview"} (Stored Key)`,
      subtitle: [
        `**Alliance:** ${allianceId}`,
        `**Cursor:** id > ${lastSeenId ?? 0}`,
        `**Records counted:** ${count}`,
        `**Newest bankrec id:** ${newestId ?? "—"}`,
      ].join("\n"),
      fields: [
        {
          name: applied ? "Applied delta (sum)" : "Tax delta (sum)",
          value: codeBlock(totalsBlock || ""),
          inline: false,
        },
      ],
      color: applied ? 0x2ecc71 : 0x5865f2,
      footer: applied
        ? cursorAdvancedTo
          ? `Credited to treasury. Cursor saved as ${cursorAdvancedTo}.`
          : `Credited to treasury.`
        : `Preview only. Use confirm:true to apply and advance cursor.`,
    });

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    const msg =
      err?.message?.startsWith("PnW GraphQL error")
        ? `❌ ${err.message}`
        : `❌ ${err?.message ?? String(err)}`;
    console.error("[/pnw_apply] error:", err);
    await interaction.editReply(msg);
  }
}
