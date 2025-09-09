// scripts/pnw_apply_all.ts
// Apply PnW taxes for ALL alliances that have a stored AllianceKey row.
// Uses auto-cursor per alliance and records logs, then posts a summary embed
// to the alliance's configured summary channel (if set).
// Usage:
//   npx tsx scripts/pnw_apply_all.ts           (preview only; still logs a heartbeat & posts "preview")
//   npx tsx scripts/pnw_apply_all.ts --confirm (apply + save cursor + log + post)

import { PrismaClient } from "@prisma/client";
import { getAlliancePnwKey } from "../src/integrations/pnw/store";
import { previewAllianceTaxCredits } from "../src/integrations/pnw/tax";
import { addToTreasury } from "../src/utils/treasury";
import {
  getPnwCursor,
  setPnwCursor,
  appendPnwApplyLog,
  getPnwSummaryChannel,
} from "../src/utils/pnw_cursor";
import https from "node:https";

function parseArgs() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes("--confirm") || process.env.PNW_CONFIRM === "true";
  return { confirm };
}

const prisma = new PrismaClient();

type AllianceResult = {
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: Record<string, number>;
  applied: boolean;
  mode: "confirm" | "preview" | "noop";
  error?: string;
};

function fmtMoney(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n: number) {
  return Math.round(n).toLocaleString();
}
function summarizeDelta(delta: Record<string, number>): string {
  const keys = Object.keys(delta);
  if (!keys.length) return "_no deltas_";
  const order = [
    "money","food","munitions","gasoline","aluminum","steel",
    "oil","uranium","bauxite","coal","iron","lead",
  ];
  const parts: string[] = [];
  for (const k of order) {
    const v = delta[k];
    if (!v) continue;
    parts.push(`+${k}:${k === "money" ? fmtMoney(v) : fmtInt(v)}`);
    if (parts.length >= 8) break;
  }
  const extras = keys.filter(k => (delta as any)[k] && !order.includes(k));
  if (extras.length) parts.push(`+${extras.length} more`);
  return parts.join("  ");
}

async function postDiscordEmbed(channelId: string, embed: any) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN not set in environment for posting summaries.");
  const body = JSON.stringify({ embeds: [embed] });

  return new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "discord.com",
        path: `/api/v10/channels/${channelId}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // drain
          res.on("data", () => {});
          res.on("end", resolve);
        } else {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            reject(
              new Error(`Discord POST ${res.statusCode}: ${data || "<no body>"}`)
            )
          );
        }
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const { confirm } = parseArgs();

  const keys = await prisma.allianceKey.findMany({
    select: { allianceId: true },
  });

  const uniqueAllianceIds = [...new Set(keys.map((k) => k.allianceId))];

  const results: AllianceResult[] = [];

  for (const allianceId of uniqueAllianceIds) {
    try {
      const apiKey = await getAlliancePnwKey(allianceId);
      if (!apiKey) {
        // heartbeat: no stored key
        await appendPnwApplyLog(allianceId, {
          ts: new Date().toISOString(),
          actorId: "systemd",
          actorTag: "systemd",
          fromCursor: null,
          toCursor: null,
          records: 0,
          delta: {},
        });
        results.push({
          allianceId,
          lastSeenId: null,
          newestId: null,
          records: 0,
          delta: {},
          applied: false,
          mode: confirm ? "noop" : "preview",
          error: "no stored key",
        });
        continue;
      }

      const storedCursor = await getPnwCursor(allianceId);
      const preview = await previewAllianceTaxCredits({
        apiKey,
        allianceId,
        lastSeenId: storedCursor,
      });

      const nonZero: Record<string, number> = {};
      for (const [k, v] of Object.entries(preview.delta)) if (v) nonZero[k] = v;

      const willApply = confirm && Object.keys(nonZero).length > 0;

      if (willApply) {
        await addToTreasury(allianceId, preview.delta as Record<string, number>, {
          source: "pnw",
          kind: "tax",
          note: `pnw_apply_all.ts; fromCursor=${storedCursor ?? "none"} toCursor=${preview.newestId ?? "none"}`,
        } as any);

        if (typeof preview.newestId === "number") {
          await setPnwCursor(allianceId, preview.newestId);
        }

        await appendPnwApplyLog(allianceId, {
          ts: new Date().toISOString(),
          actorId: "systemd",
          actorTag: "systemd",
          fromCursor: storedCursor ?? null,
          toCursor: preview.newestId ?? null,
          records: preview.count,
          delta: nonZero,
        });

        results.push({
          allianceId,
          lastSeenId: storedCursor ?? null,
          newestId: preview.newestId ?? null,
          records: preview.count,
          delta: nonZero,
          applied: true,
          mode: "confirm",
        });
      } else {
        await appendPnwApplyLog(allianceId, {
          ts: new Date().toISOString(),
          actorId: "systemd",
          actorTag: confirm ? "systemd/no-op" : "systemd/preview",
          fromCursor: storedCursor ?? null,
          toCursor: preview.newestId ?? null,
          records: preview.count,
          delta: {},
        });

        results.push({
          allianceId,
          lastSeenId: storedCursor ?? null,
          newestId: preview.newestId ?? null,
          records: preview.count,
          delta: nonZero,
          applied: false,
          mode: confirm ? "noop" : "preview",
        });
      }
    } catch (err: any) {
      try {
        await appendPnwApplyLog(allianceId, {
          ts: new Date().toISOString(),
          actorId: "systemd",
          actorTag: "systemd/error",
          fromCursor: null,
          toCursor: null,
          records: 0,
          delta: {},
        });
      } catch {}
      results.push({
        allianceId,
        lastSeenId: null,
        newestId: null,
        records: 0,
        delta: {},
        applied: false,
        mode: confirm ? "noop" : "preview",
        error: err?.message ?? String(err),
      });
    }
  }

  // Post one embed per alliance to its configured channel (if any)
  const now = new Date();
  for (const r of results) {
    const channelId = await getPnwSummaryChannel(r.allianceId);
    if (!channelId) continue;

    const color =
      r.mode === "preview" ? 0x8e44ad : r.applied ? 0x2ecc71 : 0xf1c40f;

    const deltaText = Object.keys(r.delta).length ? summarizeDelta(r.delta) : "_no deltas_";
    const desc = [
      `**Alliance ID:** \`${r.allianceId}\``,
      `**Mode:** \`${r.mode}\`${r.error ? ` — **error:** \`${r.error}\`` : ""}`,
      `**Records:** \`${r.records}\``,
      `**Cursor:** \`${r.lastSeenId ?? "none"} → ${r.newestId ?? "none"}\``,
    ].join("\n");

    const embed = {
      title: "PnW Tax Apply — Hourly",
      color,
      description: desc,
      fields: [{ name: "Delta", value: deltaText }],
      timestamp: now.toISOString(),
      footer: { text: r.applied ? "Applied & logged" : (r.mode === "preview" ? "Preview (not applied)" : "No-op (logged)") },
    };

    try {
      await postDiscordEmbed(channelId, embed);
    } catch (e: any) {
      // Keep going if posting fails
      console.error(`Post failed for alliance ${r.allianceId} -> ${channelId}:`, e?.message ?? e);
    }
  }

  // Also print JSON to journal
  console.log(JSON.stringify({ confirm, alliances: results }, null, 2));

  // Non-zero exit if any error (useful for monitoring)
  if (results.some((s) => s.error)) process.exit(2);
})().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
