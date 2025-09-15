// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import {
  fetchAllianceBankrecsViaGQL,
  type BankrecRow,
} from "../../lib/pnw.js";

const prisma = new PrismaClient();

const RESOURCE_KEYS: (keyof BankrecRow)[] = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
];

// Looser, practical tax heuristic:
// Nation (1) -> Alliance (2) to our alliance, unless the note clearly opts out.
// Still matches explicit labels if they exist.
export function isTaxBankrec(row: BankrecRow, allianceId: number): boolean {
  const note = (row.note || "").toLowerCase();
  const explicit =
    /automated\s*tax|bank\s*tax|tax\s*(deposit|payment)/i.test(row.note || "");

  const inboundNationToAlliance =
    row.sender_type === 1 &&
    row.receiver_type === 2 &&
    row.receiver_id === allianceId;

  // obvious opt-outs
  const ignore = /#ignore|safe\s*keep|safekeep|loan|reimburse|gift/i.test(note);

  return (explicit || inboundNationToAlliance) && !ignore;
}

function sumDelta(rows: BankrecRow[]) {
  const out: Record<string, number> = {};
  for (const k of RESOURCE_KEYS) out[k as string] = 0;

  for (const r of rows) {
    for (const k of RESOURCE_KEYS) {
      const v = Number((r as any)[k] ?? 0);
      if (!Number.isFinite(v) || v === 0) continue;
      out[k as string] = (out[k as string] ?? 0) + v;
    }
  }
  // prune zeros
  for (const k of Object.keys(out)) {
    if (!out[k]) delete out[k];
  }
  return out;
}

async function getStoredApiKey(allianceId: number): Promise<string> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) throw new Error("No stored API key. Run /pnw_set first.");
  return open(k.encryptedApiKey, k.nonceApi);
}

export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number = 0,
  limit: number = 200
): Promise<{ count: number; newestId: number | null; delta: Record<string, number> }> {
  const apiKey = await getStoredApiKey(allianceId);
  const rows = await fetchAllianceBankrecsViaGQL(apiKey, allianceId, {
    limit: Math.max(1, Math.min(limit || 200, 500)),
  });

  // Only rows newer than our cursor
  const newer = rows.filter((r) => typeof r.id === "number" && r.id > (lastSeenId || 0));

  // Tax rows by heuristic
  const taxRows = newer.filter((r) => isTaxBankrec(r, allianceId));

  const count = taxRows.length;
  const newestId =
    taxRows.length > 0 ? taxRows.reduce((m, r) => (r.id > m ? r.id : m), taxRows[0].id) : null;

  const delta = sumDelta(taxRows);

  return { count, newestId, delta };
}
