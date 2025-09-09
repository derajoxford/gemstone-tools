// scripts/pnw_apply_now.ts
// Headless tax apply using stored key + auto-cursor.
// Usage:
//   npx tsx scripts/pnw_apply_now.ts --alliance 14258 --confirm
//   npx tsx scripts/pnw_apply_now.ts -a 14258                 (preview)
// Env alternatives: ALLIANCE_ID, PNW_CONFIRM=true, PNW_OVERRIDE_CURSOR=123

import { previewAllianceTaxCredits } from "../src/integrations/pnw/tax";
import { getAlliancePnwKey } from "../src/integrations/pnw/store";
import { addToTreasury } from "../src/utils/treasury";
import { getPnwCursor, setPnwCursor, appendPnwApplyLog } from "../src/utils/pnw_cursor";

function parseArgs() {
  const argv = process.argv.slice(2);
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "-a" || a === "--alliance") && argv[i + 1]) out.alliance = argv[++i];
    else if (a === "--confirm") out.confirm = true;
    else if (a === "--cursor" && argv[i + 1]) out.cursor = argv[++i];
  }
  const allianceId = Number(out.alliance ?? process.env.ALLIANCE_ID);
  const confirm = Boolean(out.confirm ?? (process.env.PNW_CONFIRM === "true"));
  const cursor = out.cursor ?? process.env.PNW_OVERRIDE_CURSOR;
  const overrideCursor = cursor != null ? Number(cursor) : undefined;
  if (!Number.isFinite(allianceId)) throw new Error("Alliance id required (-a/--alliance or ALLIANCE_ID).");
  return { allianceId, confirm, overrideCursor };
}

(async () => {
  const { allianceId, confirm, overrideCursor } = parseArgs();

  const apiKey = await getAlliancePnwKey(allianceId);
  if (!apiKey) throw new Error(`No stored key for alliance ${allianceId}. Use /pnw_set in Discord.`);

  const storedCursor = await getPnwCursor(allianceId);
  const lastSeenId = typeof overrideCursor === "number" ? overrideCursor : storedCursor;

  const preview = await previewAllianceTaxCredits({ apiKey, allianceId, lastSeenId });

  const nonZeroDelta: Record<string, number> = {};
  for (const [k, v] of Object.entries(preview.delta)) if (v) nonZeroDelta[k] = v;

  console.log(
    JSON.stringify(
      {
        allianceId,
        lastSeenId: lastSeenId ?? null,
        newestId: preview.newestId ?? null,
        records: preview.count,
        delta: nonZeroDelta,
        confirm,
      },
      null,
      2
    )
  );

  if (!confirm || Object.keys(nonZeroDelta).length === 0) {
    console.log("Preview only (or nothing to apply).");
    return;
  }

  await addToTreasury(allianceId, preview.delta as Record<string, number>, {
    source: "pnw",
    kind: "tax",
    note: `Applied via pnw_apply_now.ts; fromCursor=${lastSeenId ?? "none"} toCursor=${preview.newestId ?? "none"}`,
  } as any);

  if (typeof preview.newestId === "number") {
    await setPnwCursor(allianceId, preview.newestId);
  }

  await appendPnwApplyLog(allianceId, {
    ts: new Date().toISOString(),
    actorId: "systemd",
    actorTag: "systemd",
    fromCursor: lastSeenId ?? null,
    toCursor: preview.newestId ?? null,
    records: preview.count,
    delta: nonZeroDelta,
  });

  console.log("Applied and logged.");
})().catch((err) => {
  console.error("ERROR:", err?.message ?? err);
  process.exit(1);
});
