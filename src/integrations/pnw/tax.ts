// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";
import { fetchBankrecs } from "../../lib/pnw.js";

const prisma = new PrismaClient();

export type PreviewOut = {
  count: number;
  newestId: number | null;
  // resource deltas
  delta: Record<string, number>;
};

// Normalize numbers safely
function n(v: any): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

// Sum resource columns we care about
function addInto(sum: Record<string, number>, row: Record<string, any>) {
  const keys = [
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
  for (const k of keys) sum[k] = n(sum[k]) + n(row[k]);
}

// Decide if a bankrec is an *automated tax* into the alliance
function isTaxIntoAlliance(r: any, allianceId: number): boolean {
  const senderType = n(r.sender_type);   // 1 = nation
  const receiverType = n(r.receiver_type); // 2 = alliance
  const receiverId = n(r.receiver_id);
  const looksAutomated =
    String(r.note || "").toLowerCase().includes("automated tax") ||
    n((r as any).tax_id) > 0;

  return (
    senderType === 1 &&
    receiverType === 2 &&
    receiverId === allianceId &&
    looksAutomated
  );
}

/**
 * Preview using the *stored* alliance API key.
 * - lastSeenId: only count rows with id > lastSeenId (cursor)
 * - limit: how many rows to ask PnW API for (recent window)
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 500
): Promise<PreviewOut> {
  // Get the newest saved key for this alliance
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const k = a?.keys?.[0];
  const apiKey = k ? open(k.encryptedApiKey as any, k.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");
  if (!apiKey) {
    throw new Error("No valid stored PnW user API key for this alliance. Run /pnw_set again.");
  }

  // Pull recent bankrecs for this alliance; pass limit down to avoid the $limit error.
  // fetchBankrecs expects: ({ apiKey }, [allianceId], { limit })
  const alliancesData = await fetchBankrecs({ apiKey }, [allianceId], { limit });
  const al = (alliancesData || [])[0];
  const rows = (al && Array.isArray(al.bankrecs)) ? al.bankrecs : [];

  // Keep only automated tax rows *into* this alliance
  const taxRows = rows.filter((r: any) => isTaxIntoAlliance(r, allianceId));

  // Apply cursor
  const cutoff = n(lastSeenId) || 0;
  const afterCursor = taxRows.filter((r: any) => n(r.id) > cutoff);

  // Sum deltas and find newest id
  const delta: Record<string, number> = {};
  let newest: number | null = null;
  for (const r of afterCursor) {
    addInto(delta, r);
    const id = n(r.id);
    if (!newest || id > newest) newest = id;
  }

  return {
    count: afterCursor.length,
    newestId: newest,
    delta,
  };
}
