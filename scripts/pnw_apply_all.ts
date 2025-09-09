// scripts/pnw_apply_all.ts
// Apply PnW tax credits for ALL alliances that have a stored PnW key.
// Adds a *wide* fallback: if a normal pass finds 0 records, re-scan last 7 days.

import "dotenv/config";
import { prisma } from "../src/db";
import { getAllianceCursor, setAllianceCursor, getPnwSummaryChannel } from "../src/utils/pnw_cursor";
import {
  previewAllianceTaxCredits,
  applyAllianceTaxCredits,
  formatDeltaForEmbed,
} from "../src/integrations/pnw/tax";
import { Client, EmbedBuilder, TextBasedChannel } from "discord.js";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const WIDE_LOOKBACK_HOURS = Number(process.env.PNW_TAX_WIDE_LOOKBACK_HOURS || 24 * 7); // 7d
const NORMAL_MODE = "normal";
const WIDE_MODE = "wide";

type RunResult = {
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: Record<string, number>;
  applied: boolean;
  mode: "normal" | "wide";
};

async function listAllAlliancesWithKeys(): Promise<number[]> {
  // We only store a single provider now; just grab all alliance IDs present
  const rows = await prisma.allianceKey.findMany({
    select: { allianceId: true },
  });
  return [...new Set(rows.map((r) => r.allianceId))];
}

function buildEmbed(res: RunResult) {
  const fmt = (v: any) => (v ?? "none");
  const e = new EmbedBuilder()
    .setTitle("PnW Tax Apply — Hourly")
    .setColor(res.records > 0 ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: "Alliance ID", value: `\`${res.allianceId}\``, inline: false },
      { name: "Mode", value: `\`${res.mode}\``, inline: true },
      { name: "Records", value: `\`${res.records}\``, inline: true },
      {
        name: "Cursor",
        value: `\`${fmt(res.lastSeenId)}\`  →  \`${fmt(res.newestId)}\``,
        inline: false,
      },
    )
    .setTimestamp(new Date());

  if (res.records > 0) {
    const lines = formatDeltaForEmbed(res.delta);
    e.addFields({ name: "Delta", value: lines.length ? lines.join("\n") : "_none_", inline: false });
    e.setFooter({ text: res.applied ? "Applied (logged)" : "Preview only (logged)" });
  } else {
    e.addFields({ name: "Delta", value: "_no deltas_", inline: false });
    e.setFooter({ text: "No-op (logged)" });
  }
  return e;
}

async function notify(guildClient: Client, allianceId: number, embed: EmbedBuilder) {
  try {
    const channelId = await getPnwSummaryChannel(allianceId);
    if (!channelId) return;

    const ch = await guildClient.channels.fetch(channelId);
    if (!ch) return;
    // @ts-ignore: text/thread both support send
    if ("send" in ch && typeof (ch as any).send === "function") {
      await (ch as TextBasedChannel).send({ embeds: [embed] });
    }
  } catch (e) {
    log.warn({ err: (e as Error).message, allianceId }, "notify failed");
  }
}

async function runOnce(confirm: boolean): Promise<{ confirm: boolean; alliances: RunResult[] }> {
  // Spin up a minimal Discord client for posting embeds (no intents needed for sends)
  const botToken = process.env.DISCORD_TOKEN;
  const client = new Client({ intents: [] });
  if (botToken) await client.login(botToken);

  const out: RunResult[] = [];
  const allianceIds = await listAllAlliancesWithKeys();
  log.info({ allianceIds }, "pnw_apply_all: start");

  for (const allianceId of allianceIds) {
    // 1) Normal pass — use cursor (or recent-window if cursor missing)
    const lastSeenId = await getAllianceCursor(allianceId);
    const prev = await previewAllianceTaxCredits({
      allianceId,
      lastSeenId: lastSeenId ?? undefined,
    });

    let mode: "normal" | "wide" = NORMAL_MODE;
    let found = prev.count;
    let newestId = prev.newestId ?? lastSeenId ?? null;
    let delta = prev.delta;
    let applied = false;

    // 2) Fallback: if *nothing* found, try a wide (7d) scan ignoring the cursor
    if (found === 0) {
      const wide = await previewAllianceTaxCredits({
        allianceId,
        ignoreCursor: true,
        lookbackHours: WIDE_LOOKBACK_HOURS,
      });
      if (wide.count > 0) {
        mode = WIDE_MODE;
        found = wide.count;
        newestId = wide.newestId ?? newestId;
        delta = wide.delta;
      }
    }

    // 3) Apply if we found records
    if (confirm && found > 0) {
      await applyAllianceTaxCredits({ allianceId, delta });
      if (newestId) await setAllianceCursor(allianceId, newestId);
      applied = true;
    }

    const res: RunResult = {
      allianceId,
      lastSeenId: lastSeenId ?? null,
      newestId,
      records: found,
      delta,
      applied,
      mode,
    };
    out.push(res);

    // Notify (per-alliance)
    try {
      const embed = buildEmbed(res);
      if (client.isReady()) await notify(client, allianceId, embed);
    } catch (e) {
      log.warn({ err: (e as Error).message, allianceId }, "embed/notify error");
    }
  }

  if (botToken && client.isReady()) await client.destroy();
  log.info({ out }, "pnw_apply_all: done");
  return { confirm, alliances: out };
}

// Entry point
(async () => {
  const confirm = process.argv.includes("--confirm") || process.env.PNW_APPLY_CONFIRM === "1";
  const result = await runOnce(confirm);
  // Emit machine-readable JSON for systemd logs/tests
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})();
