// src/lib/pnw_tax.ts
import { PrismaClient, AllianceTreasury } from "@prisma/client";

export type TaxrecRow = {
  id: string;
  date: string; // ISO
  note: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
  // amounts may or may not be present depending on API tier
  money?: string | number;
  food?: string | number;
  coal?: string | number;
  oil?: string | number;
  uranium?: string | number;
  lead?: string | number;
  iron?: string | number;
  bauxite?: string | number;
  gasoline?: string | number;
  munitions?: string | number;
  steel?: string | number;
  aluminum?: string | number;
};

type Amounts = Record<string, number>;

const RESOURCE_KEYS: (keyof Amounts)[] = [
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

function zeroes(): Amounts {
  const z: Amounts = {};
  for (const k of RESOURCE_KEYS) z[k] = 0;
  return z;
}

function toNum(x: any): number {
  if (x == null) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve an API key for an alliance:
 * 1) env PNW_API_KEY_<AID>
 * 2) env PNW_API_KEY
 * 3) DB AllianceApiKey.apiKey
 */
export async function resolveAllianceApiKey(prisma: PrismaClient, allianceId: number): Promise<string | null> {
  const envKey = process.env[`PNW_API_KEY_${allianceId}`] || process.env.PNW_API_KEY || null;
  if (envKey) return envKey;

  try {
    const row = await prisma.allianceApiKey.findUnique({ where: { allianceId } });
    return row?.apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch latest taxrecs (up to `limit`) for the alliance via GraphQL.
 * We attempt to request resource amounts; if the API rejects those
 * fields, we gracefully fall back to id/date/note only.
 */
export async function fetchAllianceTaxrecs(apiKey: string, allianceId: number, limit = 50): Promise<TaxrecRow[]> {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);

  // Try with resource fields
  const queryWithAmts = `
    query($aid:[Int!],$limit:Int){
      alliances(id:$aid){
        data{
          id
          taxrecs(limit:$limit){
            id date note sender_type sender_id receiver_type receiver_id
            money food coal oil uranium lead iron bauxite gasoline munitions steel aluminum
          }
        }
      }
    }`;

  const queryNoAmts = `
    query($aid:[Int!],$limit:Int){
      alliances(id:$aid){
        data{
          id
          taxrecs(limit:$limit){
            id date note sender_type sender_id receiver_type receiver_id
          }
        }
      }
    }`;

  const attempt = async (q: string) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { aid: [allianceId], limit } }),
    });
    const j = await r.json();
    if (j.errors) {
      const msg = JSON.stringify(j.errors);
      throw new Error(msg);
    }
    const arr: TaxrecRow[] = j?.data?.alliances?.data?.[0]?.taxrecs ?? [];
    return arr;
  };

  try {
    return await attempt(queryWithAmts);
  } catch {
    // Fall back without amount fields
    return await attempt(queryNoAmts);
  }
}

/**
 * Persist taxrecs into our cache table and update the alliance's treasury balances.
 * Also advances the cursor to the newest seen id.
 *
 * Returns a summary of what changed.
 */
export async function applyAllianceTaxes(prisma: PrismaClient, allianceId: number, limit = 50) {
  const apiKey = await resolveAllianceApiKey(prisma, allianceId);
  if (!apiKey) {
    return { applied: 0, newestId: null as string | null, reason: "missing_api_key" };
  }

  const taxrecs = await fetchAllianceTaxrecs(apiKey, allianceId, limit);

  // Figure out newest id we saw (ids are increasing strings; compare numerically)
  const newestId = taxrecs.reduce<string | null>((acc, x) => {
    if (!x?.id) return acc;
    if (!acc) return x.id;
    return Number(x.id) > Number(acc) ? x.id : acc;
  }, null);

  // Load cursor; skip anything we've already seen
  const cur = await prisma.allianceBankCursor.findUnique({ where: { allianceId } }).catch(() => null);
  const lastSeen = cur?.lastSeenId || null;

  const toApply = taxrecs
    .filter(r => r && r.id && Number(r.id) > Number(lastSeen || 0))
    .sort((a, b) => Number(a.id) - Number(b.id)); // oldest -> newest

  if (toApply.length === 0) {
    // no-op but advance cursor if the newest is ahead
    if (newestId && Number(newestId) > Number(lastSeen || 0)) {
      await prisma.allianceBankCursor.upsert({
        where: { allianceId },
        update: { lastSeenId: newestId },
        create: { allianceId, lastSeenId: newestId },
      });
    }
    return { applied: 0, newestId, reason: "no_new_rows" };
  }

  // Prepare treasury delta
  const delta = zeroes();

  for (const r of toApply) {
    for (const k of RESOURCE_KEYS) {
      delta[k] += toNum((r as any)[k]);
    }
  }

  // Upsert cache table rows (alliance_bankrec)
  // We store the minimal metadata we have; amounts are NOT stored here in this first pass.
  // If you want to keep amounts historically, mirror them into extra columns later.
  const now = new Date();
  await prisma.allianceBankrec.createMany({
    skipDuplicates: true,
    data: toApply.map(r => ({
      id: r.id,
      date: new Date(r.date),
      note: r.note ?? "",
      tax_id: r.id,
      sender_type: r.sender_type,
      receiver_type: r.receiver_type,
      sender_id: String(r.sender_id),
      receiver_id: String(r.receiver_id),
      alliance_id_derived: allianceId,
      is_tax_guess: false,
      is_ignored: false,
      created_at: now,
    })),
  });

  // Update treasury balances JSON
  const treas0 = await prisma.allianceTreasury.findUnique({ where: { allianceId } });
  const current: Amounts = { ...zeroes(), ...(treas0?.balances as any || {}) };

  for (const k of RESOURCE_KEYS) {
    current[k] = toNum(current[k]) + delta[k];
  }

  await prisma.allianceTreasury.upsert({
    where: { allianceId },
    update: { balances: current },
    create: { allianceId, balances: current },
  });

  // Advance cursor
  const finalNewest = newestId ?? toApply[toApply.length - 1]?.id ?? null;
  if (finalNewest) {
    await prisma.allianceBankCursor.upsert({
      where: { allianceId },
      update: { lastSeenId: finalNewest },
      create: { allianceId, lastSeenId: finalNewest },
    });
  }

  return { applied: toApply.length, newestId: finalNewest, reason: "ok", delta, sampleIds: toApply.slice(0, 5).map(x => x.id) };
}
