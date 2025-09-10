// src/jobs/pnw_auto_apply.ts
import cron from "node-cron";
import type { Client, TextBasedChannel } from "discord.js";
import { previewAllianceTaxCreditsStored } from "../integrations/pnw/tax";
import { addToTreasury } from "../utils/treasury_store";
import {
  getPnwCursor,
  setPnwCursor,
  appendPnwApplyLog,
  getPnwSummaryChannel,
} from "../utils/pnw_cursor";
import { resourceEmbed } from "../lib/embeds";

type ResourceDelta = Record<string, number>;

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
    lines.push(`${k}: +${asStr}`);
  }
  return lines.join(" • ");
}

async function postToSummaryChannel(
  client: Client<true>,
  allianceId: number,
  content: string,
  embedFields?: { title?: string; subtitle?: string; delta?: ResourceDelta },
) {
  try {
    const chId = await getPnwSummaryChannel(allianceId);
    if (!chId) return;

    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch || !("send" in ch)) return;

    const embed =
      embedFields
        ? resourceEmbed({
            title: embedFields.title ?? "PnW Tax Apply",
            subtitle: embedFields.subtitle ?? "",
            fields: embedFields.delta
              ? [
                  {
                    name: "Delta",
                    value: "```\n" + formatDelta(embedFields.delta) + "\n```",
                    inline: false,
                  },
                ]
              : [],
            color: 0x2ecc71,
            footer: "Auto-applied via hourly job",
          })
        : undefined;

    await (ch as TextBasedChannel).send(
      embed ? { content, embeds: [embed] } : { content },
    );
  } catch {
    /* no-op */
  }
}

export function startAutoApply(client: Client<true>) {
  const cronExpr = process.env.PNW_AUTO_APPLY_CRON || "0 * * * *"; // top of hour
  const tz = process.env.TZ || "UTC";

  // Where to pull alliance IDs from:
  // Set env PNW_ALLIANCES="14258,12345" in your systemd drop-in.
  const idsEnv = process.env.PNW_ALLIANCES || "";
  const allianceIds = idsEnv
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!allianceIds.length) {
    console.warn(
      "[auto-apply] No alliances configured. Set PNW_ALLIANCES env (e.g. 14258,12345).",
    );
    return;
  }

  console.log(
    `[auto-apply] Scheduling cron '${cronExpr}' TZ=${tz} for alliances: ${allianceIds.join(
      ", ",
    )}`,
  );

  cron.schedule(
    cronExpr,
    async () => {
      for (const allianceId of allianceIds) {
        try {
          const lastSeen = (await getPnwCursor(allianceId)) ?? 0;

          const preview = await previewAllianceTaxCreditsStored(
            allianceId,
            lastSeen || null,
          );

          const count = preview?.count ?? 0;
          const newestId = preview?.newestId ?? null;
          const delta = (preview?.delta ?? {}) as ResourceDelta;

          // Any positive totals?
          const hasDelta = Object.values(delta).some((v) => Number(v || 0) > 0);

          if (!count || !hasDelta) {
            await postToSummaryChannel(
              client,
              allianceId,
              `🕘 [${new Date().toISOString()}] No new tax deltas (count=${count}).`,
              undefined,
            );
            continue;
          }

          // Apply
          await addToTreasury(allianceId, delta);
          if (typeof newestId === "number" && newestId > lastSeen) {
            await setPnwCursor(allianceId, newestId);
          }
          await appendPnwApplyLog({
            allianceId,
            at: new Date().toISOString(),
            mode: "apply",
            lastSeenId: lastSeen || null,
            newestId: newestId ?? null,
            records: count,
            delta,
          } as any);

          await postToSummaryChannel(
            client,
            allianceId,
            `✅ [${new Date().toISOString()}] Applied tax deltas for alliance ${allianceId}.`,
            {
              title: "PnW Tax Apply (Auto)",
              subtitle: [
                `**Alliance:** ${allianceId}`,
                `**Cursor:** id > ${lastSeen ?? 0}`,
                `**Records counted:** ${count}`,
                `**Newest bankrec id:** ${newestId ?? "—"}`,
              ].join("\n"),
              delta,
            },
          );
        } catch (err) {
          console.error(`[auto-apply] alliance ${allianceId} failed:`, err);
          await postToSummaryChannel(
            client,
            allianceId,
            `❌ Auto-apply failed for alliance ${allianceId}: ${
              (err as Error)?.message || String(err)
            }`,
          );
        }
      }
    },
    { timezone: tz },
  );
}
