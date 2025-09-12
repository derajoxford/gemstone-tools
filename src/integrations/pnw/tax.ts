// src/integrations/pnw/tax.ts
import { PrismaClient } from "@prisma/client";
import { open } from "../../lib/crypto.js";

const prisma = new PrismaClient();

// Canonical resource keys we’ll sum over
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

type BankrecRow = {
  id: string | number;
  date?: string;
  note?: string | null;
  sender_type?: number | string;
  sender_id?: number | string;
  receiver_type?: number | string;
  receiver_id?: number | string;
  tax_id?: number | string | null;
  money?: number | string;
  food?: number | string;
  coal?: number | string;
  oil?: number | string;
  uranium?: number | string;
  lead?: number | string;
  iron?: number | string;
  bauxite?: number | string;
  gasoline?: number | string;
  munitions?: number | string;
  steel?: number | string;
  aluminum?: number | string;
};

type PreviewOut = {
  count: number;
  newestId: number | null;
  delta: Record<string, number>;
  rows?: BankrecRow[];
};

function toInt(v: any): number {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}
function toNum(v: any): number {
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

// --- Low level: GraphQL POST (keeps api_key both in URL and header for compatibility)
async function gqlBankrecs(opts: {
  apiKey: string;
  allianceId: number;
  limit: number;
  minId?: number | null;
}): Promise<BankrecRow[]> {
  const { apiKey, allianceId, limit, minId } = opts;

  const query = `
    query Bankrecs($aid:Int!, $limit:Int!, $minId:Int) {
      bankrecs(alliance_id: $aid, limit: $limit, min_id: $minId) {
        id
        date
        note
        sender_type
        sender_id
        receiver_type
        receiver_id
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
  `;

  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
    body: JSON.stringify({
      query,
      variables: {
        aid: allianceId,
        limit,
        minId: minId ?? null,
      },
    }),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PnW GraphQL error (status ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok || json?.errors) {
    throw new Error(
      `PnW GraphQL error (status ${res.status}): ` +
        (json?.errors?.[0]?.message || text.slice(0, 200))
    );
  }

  const rows = (json?.data?.bankrecs ?? []) as BankrecRow[];
  return Array.isArray(rows) ? rows : [];
}

// --- Core: preview using the stored key, with cursor + filtering on tax_id>0 inbound to alliance
export async function previewAllianceTaxCreditsStored(
  allianceId: number,
  lastSeenId: number | null = null,
  limit = 600
): Promise<PreviewOut> {
  // 1) pull the latest stored key for this alliance
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    include: { keys: { orderBy: { id: "desc" }, take: 1 } },
  });
  const enc = a?.keys?.[0];
  const apiKey =
    enc ? open(enc.encryptedApiKey as any, enc.nonceApi as any) : (process.env.PNW_DEFAULT_API_KEY || "");

  if (!apiKey) throw new Error("No API key saved for this alliance.");

  // 2) fetch recent bankrecs window
  const rows = await gqlBankrecs({
    apiKey,
    allianceId,
    limit: Math.max(50, Math.min(limit || 600, 1000)),
    minId: lastSeenId && lastSeenId > 0 ? lastSeenId : null,
  });

  // 3) filter to inbound-to-alliance AND tax rows
  const filtered = rows.filter((r) => {
    const rt = toInt(r.receiver_type);
    const rid = toInt(r.receiver_id);
    const taxId = toInt(r.tax_id);
    return rt === 2 && rid === allianceId && taxId > 0;
  });

  // 4) apply cursor client-side too (defensive, in case server min_id wasn’t honored)
  const cursor = lastSeenId || 0;
  const withCursor = filtered.filter((r) => toInt(r.id) > cursor);

  // 5) sum deltas
  const delta: Record<string, number> = {};
  for (const k of RES_KEYS) delta[k] = 0;

  let newestId: number | null = null;

  for (const r of withCursor) {
    // in tax deposits, resources should be positive into the alliance
    for (const k of RES_KEYS) {
      const v = toNum((r as any)[k]);
      if (v) delta[k] += v;
    }
    const idn = toInt(r.id);
    if (!newestId || idn > newestId) newestId = idn;
  }

  // prune zero keys for cleaner UI (your embed code tolerates missing keys)
  for (const k of Object.keys(delta)) {
    if (!delta[k]) delete delta[k];
  }

  return {
    count: withCursor.length,
    newestId: newestId ?? null,
    delta,
    rows: withCursor.slice(-5), // last few for potential debug views
  };
}
