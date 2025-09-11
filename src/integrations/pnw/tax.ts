// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";

const prisma = new PrismaClient();

/** Resources we care about and their numeric fields on PnW bank recs */
const RES_KEYS = [
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
] as const;

type ResKey = (typeof RES_KEYS)[number];

export type TaxPreview = {
  count: number;
  newestId: number | null;
  delta: Record<ResKey, number>;
};

/**
 * Core: fetch the *latest N* bank records for an alliance and filter down to
 * automated tax credits (nation -> alliance, note contains "Automated Tax").
 *
 * We intentionally do *not* pass any legacy cursor args into GraphQL (like
 * after_id / last_id / first / order). Those vary across schema versions.
 * We just ask for the most recent `limit` rows and then filter & post-process
 * locally. Keep it simple and robust.
 */
export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 500
): Promise<TaxPreview> {
  // GraphQL query: alliances -> data -> bankrecs(limit: $limit) { ... }
  const query = `
    query($ids:[Int]!, $limit:Int!) {
      alliances(id: $ids) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
            money
            food
            coal
            oil
            uranium
            lead
            iron
            bauxite
            gasoline
            munitions
            steel
            aluminum
          }
        }
      }
    }
  `;

  const url = "https://api.politicsandwar.com/graphql";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      query,
      variables: { ids: [allianceId], limit: Math.max(50, Math.min(1000, Number(limit) || 500)) },
    }),
  });

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error(`PnW GraphQL error (status ${res.status}): could not parse response JSON`);
  }
  if (!res.ok || json?.errors) {
    const msg = json?.errors?.[0]?.message || "unknown error";
    throw new Error(`PnW GraphQL error (status ${res.status}): ${msg}`);
  }

  const data = json?.data?.alliances?.data;
  const alliance = Array.isArray(data) ? data.find((a: any) => Number(a?.id) === Number(allianceId)) : null;
  const rows: any[] = alliance?.bankrecs || [];

  // Post-filter by cursor (id > lastSeenId) if provided
  const filteredByCursor = rows.filter((r) => {
    const idNum = toInt(r?.id);
    return lastSeenId ? idNum > lastSeenId : true;
  });

  // Tax recognizer:
  //  - sender_type === 1 (nation)
  //  - receiver_type === 2 (alliance)
  //  - receiver_id === allianceId
  //  - note includes "Automated Tax" (case-insensitive)
  const taxRows = filteredByCursor.filter((r) => {
    const senderType = toInt(r?.sender_type);
    const receiverType = toInt(r?.receiver_type);
    const receiverId = toInt(r?.receiver_id);
    const note = String(r?.note || "").toLowerCase();
    const looksLikeTax = note.includes("automated tax");
    return senderType === 1 && receiverType === 2 && receiverId === allianceId && looksLikeTax;
  });

  // Aggregate resource totals
  const delta: Record<ResKey, number> = Object.fromEntries(RES_KEYS.map((k) => [k, 0])) as any;
  for (const r of taxRows) {
    for (const k of RES_KEYS) {
      const v = toNum((r as any)[k]);
      if (v) delta[k] += v;
    }
  }

  // newestId = max id in the *taxRows* we considered
  const newestId = taxRows.length ? taxRows.reduce((m, r) => Math.max(m, toInt(r.id)), 0) : null;

  return {
    count: taxRows.length,
    newestId,
    delta,
  };
}

/**
 * Convenience: pull the latest stored alliance key from DB, decrypt it,
 * and run previewAllianceTaxCredits.
 */
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit?: number
): Promise<TaxPreview> {
  // Get the most recent saved key for this alliance
  const keyRow = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });

  // Fall back to a default env key if none saved for this alliance
  const apiKey =
    (keyRow ? open(keyRow.encryptedApiKey as any, keyRow.nonceApi as any) : null) ||
    process.env.PNW_DEFAULT_API_KEY ||
    "";

  if (!apiKey) {
    throw new Error("No valid stored PnW user API key for this alliance. Run /pnw_set again (and ensure encryption secret matches).");
  }

  return previewAllianceTaxCredits(apiKey, allianceId, lastSeenId, limit ?? 500);
}

// ---------- helpers ----------
function toInt(v: any): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}
function toNum(v: any): number {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
