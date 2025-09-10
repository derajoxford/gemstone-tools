// src/utils/pnw_cursor.ts
import { promises as fs } from "fs";
import path from "path";

/**
 * File-backed state for:
 *  - alliance apply cursor (last seen bankrec id)
 *  - apply logs
 *  - per-alliance summary channel
 *
 * No Prisma. Safe to use from commands.
 */

const DATA_DIR = path.join(process.cwd(), "var");
const FILE = path.join(DATA_DIR, "pnw_state.json");

export type ResourceDelta = Record<string, number>;

export type PnwApplyLogEntry = {
  ts: string; // ISO
  allianceId: number;
  lastSeenId: number | null;
  newestId: number | null;
  records: number;
  delta: ResourceDelta;
  applied: boolean;
  reason?: string;
};

type State = {
  cursors: Record<string, number>; // allianceId -> newestId
  logs: PnwApplyLogEntry[];        // newest-first
  summaryChannels: Record<string, string>; // allianceId -> discord channel id
};

async function readState(): Promise<State> {
  try {
    const text = await fs.readFile(FILE, "utf8");
    const json = JSON.parse(text);
    if (!json || typeof json !== "object") throw new Error("bad state");
    const s = json as Partial<State>;
    return {
      cursors: typeof s.cursors === "object" && s.cursors ? s.cursors as Record<string, number> : {},
      logs: Array.isArray(s.logs) ? (s.logs as PnwApplyLogEntry[]) : [],
      summaryChannels: typeof s.summaryChannels === "object" && s.summaryChannels
        ? s.summaryChannels as Record<string, string>
        : {},
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { cursors: {}, logs: [], summaryChannels: {} };
    throw err;
  }
}

async function writeState(s: State): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
}

/** ---------------- Cursors ---------------- */

export async function getPnwCursor(allianceId: number): Promise<number | null> {
  const s = await readState();
  const v = s.cursors[String(allianceId)];
  return Number.isFinite(v) ? Number(v) : null;
}

export async function setPnwCursor(allianceId: number, newestId: number | null): Promise<void> {
  const s = await readState();
  if (newestId === null || newestId === undefined) {
    delete s.cursors[String(allianceId)];
  } else {
    s.cursors[String(allianceId)] = Number(newestId);
  }
  await writeState(s);
}

/** ---------------- Apply Logs ---------------- */

export async function appendPnwApplyLog(entry: PnwApplyLogEntry): Promise<void> {
  const s = await readState();
  // newest-first
  s.logs.unshift(entry);
  // cap to something reasonable
  if (s.logs.length > 2000) s.logs.length = 2000;
  await writeState(s);
}

export async function getPnwLogs(allianceId?: number): Promise<PnwApplyLogEntry[]> {
  const s = await readState();
  if (!allianceId) return s.logs;
  return s.logs.filter((e) => e.allianceId === Number(allianceId));
}

/** ---------------- Summary Channel per alliance ---------------- */

export async function getPnwSummaryChannel(allianceId: number): Promise<string | null> {
  const s = await readState();
  return s.summaryChannels[String(allianceId)] ?? null;
}

export async function setPnwSummaryChannel(allianceId: number, channelId: string | null): Promise<void> {
  const s = await readState();
  const k = String(allianceId);
  if (!channelId) {
    delete s.summaryChannels[k];
  } else {
    s.summaryChannels[k] = channelId;
  }
  await writeState(s);
}
