// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";

const prisma = new PrismaClient();

// ---- Types ----
export type Bankrec = {
  id: number;
  date: string;
  note?: string | null;

  sender_id: number;
  sender_type: number;
  receiver_id: number;
  receiver_type: number;

  tax_id?: number | null;

  money: number;
  food: number;
  coal: number;
  oil: number;
  uranium: number;
  lead: number;
  iron: number;
  bauxite: number;
  gasoline: number;
  munitions: number;
  steel: number;
  aluminum: number;
};

type Delta = Record<string, number>;

// ---- GraphQL ----
// IMPORTANT: $limit is nullable in the schema on many installs, but some nodes expect it set.
// We always pass a numeric limit to avoid "Int! must not be null" regressions.
const BANKRECS_Q = `
query AllianceBankrecs($ids:[Int!], $min_id:Int, $limit:Int) {
  alliances(id:$ids) {
    id
    bankrecs(min_id:$min_id, limit:$limit) {
      id
      date
      note
      sender_id
      sender_type
      receiver_id
      receiver_type
      tax_id
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
`;

async function gqlPost(apiKey: string, query: string, variables: any) {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || (data as any)?.errors) {
    throw new Error(
      `PnW GraphQL error (status ${res.status}): ${(data as any)?.errors?.[0]?.message || res.statusText}`
    );
  }
  return data?.data;
}

async function getStoredAllianceApiKey(allianceId: number): Promise<string> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const enc = a?.keys?.[0];
  if (!enc) throw new Error("No stored API key for this alliance.");
  const apiKey = open(enc.encryptedApiKey as any, enc.nonceApi as any);
  if (!apiKey) throw new Error("Failed to decrypt stored API key.");
  return apiKey;
}

// Utility: sum resource fields into a delta object
function sumInto(delta: Delta, row: Partial<Bankrec>) {
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
  ] as const;

  for (const k of keys) {
    const v = Number((row as any)[k] || 0);
    if (!v) continue;
    delta[k] = (delta[k] || 0) + v;
  }
}

// Core filter: ONLY automated tax credits to this alliance
function isAutomatedTaxToAlliance(r: Bankrec, allianceId: number) {
  return (
    Number(r.receiver_type) === 2 &&
    Number(r.receiver_id) === Number(allianceId) &&
    Number(r.tax_id || 0) > 0
  );
}

// ---- Public: preview using a *provided* apiKey (rarely used) ----
export async function previewAllianceTaxCredits(
  apiKey: string,
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 600
): Promise<{ count: number; newestId: number | null; delta: Delta; rows: Bankrec[] }> {
  const data = await gqlPost(apiKey, BANKRECS_Q, {
    ids: [allianceId],
    min_id: lastSeenId ?? 0,
    limit: Math.max(1, limit),
  });

  const rows: Bankrec[] = (data?.alliances?.[0]?.bankrecs || []).map((r: any) => ({
    id: Number(r.id),
    date: r.date,
    note: r.note ?? null,
    sender_id: Number(r.sender_id),
    sender_type: Number(r.sender_type),
    receiver_id: Number(r.receiver_id),
    receiver_type: Number(r.receiver_type),
    tax_id: r.tax_id != null ? Number(r.tax_id) : 0,
    money: Number(r.money) || 0,
    food: Number(r.food) || 0,
    coal: Number(r.coal) || 0,
    oil: Number(r.oil) || 0,
    uranium: Number(r.uranium) || 0,
    lead: Number(r.lead) || 0,
    iron: Number(r.iron) || 0,
    bauxite: Number(r.bauxite) || 0,
    gasoline: Number(r.gasoline) || 0,
    munitions: Number(r.munitions) || 0,
    steel: Number(r.steel) || 0,
    aluminum: Number(r.aluminum) || 0,
  }));

  // keep only automated tax deposits to this alliance
  const taxRows = rows.filter(r => isAutomatedTaxToAlliance(r, allianceId));

  const delta: Delta = {};
  for (const r of taxRows) sumInto(delta, r);

  const newestId = taxRows.length ? Math.max(...taxRows.map(r => r.id)) : null;

  return {
    count: taxRows.length,
    newestId,
    delta,
    rows: taxRows,
  };
}

// ---- Public: preview using the *stored* alliance key (what your commands use) ----
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 600
): Promise<{ count: number; newestId: number | null; delta: Delta; rows: Bankrec[] }> {
  const apiKey = await getStoredAllianceApiKey(allianceId);
  return previewAllianceTaxCredits(apiKey, allianceId, lastSeenId, limit);
}

// ---- Optional helper used by /pnw_bankpeek (so `filter:tax` shows something useful) ----
export async function bankPeekTaxRowsStored(
  allianceId: number,
  lastSeenId: number | null,
  limit: number = 200
): Promise<Bankrec[]> {
  const { rows } = await previewAllianceTaxCreditsStored(allianceId, lastSeenId, limit);
  return rows;
}
