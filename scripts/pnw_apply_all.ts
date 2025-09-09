// scripts/pnw_apply_all.ts
// Apply PnW tax credits for ALL alliances that have a stored PnW key.
// Self-contained: previews via integrations/pnw/tax, applies by updating AllianceTreasury,
// and posts an embed to the alliance's configured summary channel.
// Includes a wide (7d, configurable) fallback if the normal pass finds 0 records.

import "dotenv/config";
import { prisma } from "../src/db";
import { Client, EmbedBuilder, TextBasedChannel } from "discord.js";
import pino from "pino";

import {
  previewAllianceTaxCredits,
  // NOTE: we intentionally do NOT import applyAllianceTaxCredits here.
} from "../src/integrations/pnw/tax";

import {
  getAllianceCursor,
  setAllianceCursor,
  getPnwSummaryChannel,
} from "../src/utils/pnw_cursor";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const WIDE_LOOKBACK_HOURS = Number(process.env.PNW_TAX_WIDE_LOOKBACK_HOURS || 24 * 7); // default 7d
const CONFIRM = process.argv.includes("--confirm") || process.env.PNW_APPLY_CONFIRM === "1";

type Delta = Record<string, number>;

type RunResult = {
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: Delta;
  applied: boolean;
  mode: "normal" | "wide" | "noop";
};

function formatDelta(delta: Delta): string[] {
  const keys = Object.keys(delta).sort();
  if (!keys.length) return [];
  return keys.map((k) => {
    const v = delta[k];
    const sign = v >= 0 ? "+" : "";
    return `\`${k}\`: ${sign}${v}`;
  });
}

async function applyDeltaToTreasury(allianceId: number, delta: Delta) {
  // Merge deltas into AllianceTreasury.balances JSON
  const current = await prisma.allianceTreasury.findUnique({
    where: { allianceId },
  });

  const balances: Record<string, number> = { ...(current?.balances as any) };
  for (const [k, v] of Object.entries(delta)) {
    if (!Number.isFinite(v as number)) continue;
    balances[k] = (Number(balances[k]) || 0) + Number(v);
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    create: { allianceId, balances },
    update: { balances },
  });
}

function buildEmbed(res: RunResult) {
  const fmt = (v: any) => (v == null ? "none" : String(v));
  const e = new EmbedBuilder()
    .setTitle("PnW Tax Apply — Hourly")
    .setColor(res.records > 0 ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: "Alliance ID", value: `\`${res.allianceId}\``, inline: false },
      { name: "Mode", value: `\`${res.mode}\``, inline: true },
      { name: "Records", value: `\`${res.records}\``, inline: true },
      { name: "Cursor", value: `\`${fmt(res.lastSeenId)}\`  →  \`${fmt(res.newestId)}\``, inline: false },
    )
    .setTimestamp(new Date());

  const lines = formatDelta(res.delta);
  if (res.records > 0 && lines.length) {
    e.addFields({ name: "Delta", value: lines.join("\n"), inline: false });
    e.setFooter({ text: res.applied ? "Applied (logged)" : "Preview only (logged)" });
  } else {
    e.addFields({ name: "Delta", value: "_no deltas_", inline: false });
    e.setFooter({ text: "No-op (logged)" });
  }
  return e;
}

async function notify(client: Client, allianceId: number, embed: EmbedBuilder) {
  try {
    const channelId = await getPnwSummaryChannel(allianceId);
    if (!channelId) return;
    const ch = await client.channels.fetch(channelId);
    if (!ch) return;
    if ("send" in (ch as any) && typeof (ch as any).send === "function") {
      await (ch as unknown as TextBasedChannel).send({ embeds: [embed] });
    }
  } catch (e) {
    log.warn({ err: (e as Error).message, allianceId }, "notify failed");
  }
}

async function listAllAlliancesWithKeys(): Promise<number[]> {
  const rows = await prisma.allianceKey.findMany({ select: { allianceId: true } });
  return [...new Set(rows.map((r) => r.allianceId))];
}

async function runOnce(confirm: boolean) {
  // Minimal Discord client purely for posting embeds
  const botToken = process.env.DISCORD_TOKEN;
  const client = new Client({ intents: [] });
  if (botToken) await client.login(botToken);

  const allianceIds = await listAllAlliancesWithKeys();
  const results: RunResult[] = [];

  for (const allianceId of allianceIds) {
    const lastSeenId = await getAllianceCursor(allianceId);

    // Pass 1: normal (cursor or recent-window if no cursor)
    const prev = await previewAllianceTaxCredits({
      allianceId,
      lastSeenId: lastSeenId ?? undefined,
    });

    let mode: RunResult["mode"] = "normal";
    let found = prev.count;
    let newestId = prev.newestId ?? lastSeenId ?? null;
    let delta = prev.delta as Delta;

    // Pass 2: wide fallback if nothing found
    if (found === 0) {
      const wide = await previewAllianceTaxCredits({
        allianceId,
        ignoreCursor: true,
        lookbackHours: WIDE_LOOKBACK_HOURS,
      });
      if (wide.count > 0) {
        mode = "wide";
        found = wide.count;
        newestId = wide.newestId ?? newestId;
        delta = wide.delta as Delta;
      } else {
        mode = "noop";
      }
    }

    let applied = false;
    if (confirm && found > 0) {
      await applyDeltaToTreasury(allianceId, delta);
      if (newestId != null) await setAllianceCursor(allianceId, newestId);
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
    results.push(res);

    try {
      if (client.isReady()) await notify(client, allianceId, buildEmbed(res));
    } catch (e) {
      log.warn({ err: (e as Error).message, allianceId }, "embed/notify error");
    }
  }

  if (client.isReady()) await client.destroy();
  const out = { confirm, alliances: results };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

(async () => {
  await runOnce(CONFIRM);
  process.exit(0);
})();
