// scripts/pnw_apply_all.ts
// Apply PnW taxes for ALL alliances that have a stored PnW key (provider:'pnw').
// Uses auto-cursor per alliance and records logs. Safe to run hourly.
// Usage:
//   npx tsx scripts/pnw_apply_all.ts          (preview only)
//   npx tsx scripts/pnw_apply_all.ts --confirm (apply + save cursor + log)

import { PrismaClient } from "@prisma/client";
import { getAlliancePnwKey } from "../src/integrations/pnw/store";
import { previewAllianceTaxCredits } from "../src/integrations/pnw/tax";
import { addToTreasury } from "../src/utils/treasury";
import { getPnwCursor, setPnwCursor, appendPnwApplyLog } from "../src/utils/pnw_cursor";

function parseArgs() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes("--confirm") || process.env.PNW_CONFIRM === "true";
  return { confirm };
}

const prisma = new PrismaClient();

(async () => {
  const { confirm } = parseArgs();

  const keys = await prisma.allianceKey.findMany({
    where: { provider: "pnw" },
    select: { allianceId: true },
  });

  const uniqueAllianceIds = [...new Set(keys.map((k) => k.allianceId))];

  const summary: Array<{
    allianceId: number;
    lastSeenId: number | null;
    newestId: number | null;
    records: number;
    delta: Record<string, number>;
    applied: boolean;
    error?: string;
  }> = [];

  for (const allianceId of uniqueAllianceIds) {
    try {
      const apiKey = await getAlliancePnwKey(allianceId);
      if (!apiKey) {
        summary.push({
          allianceId,
          lastSeenId: null,
          newestId: null,
          records: 0,
          delta: {},
          applied: false,
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

      const nonZeroDelta: Record<string, number> = {};
      for (const [k, v] of Object.entries(preview.delta)) if (v) nonZeroDelta[k] = v;

      const shouldApply = confirm && Object.keys(nonZeroDelta).length > 0;

      if (shouldApply) {
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
          delta: nonZeroDelta,
        });
      }

      summary.push({
        allianceId,
        lastSeenId: storedCursor ?? null,
        newestId: preview.newestId ?? null,
        records: preview.count,
        delta: nonZeroDelta,
        applied: shouldApply,
      });
    } catch (err: any) {
      summary.push({
        allianceId,
        lastSeenId: null,
        newestId: null,
        records: 0,
        delta: {},
        applied: false,
        error: err?.message ?? String(err),
      });
      // continue to next alliance
    }
  }

  console.log(JSON.stringify({ confirm, alliances: summary }, null, 2));
  // Exit nonzero if any entry errored (useful for monitoring)
  if (summary.some((s) => s.error)) process.exit(2);
})().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
