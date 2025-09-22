// src/lib/pnw_bank_ingest.ts
// Back-compat shim to satisfy old command imports and route to working GraphQL shapes.
// Uses Node 20 global fetch (no node-fetch needed).

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Minimal filter enum to match existing command imports.
export enum BankrecFilter {
  ALL = "all",
  TAX = "tax",
}

// Helper: pick API key from env or DB (AllianceApiKey) if present.
export async function getAllianceApiKey(allianceId: number): Promise<string> {
  const envKey =
    process.env[`PNW_API_KEY_${allianceId}`] ||
    process.env.PNW_API_KEY ||
    null;

  if (envKey) return envKey;

  // Optional fallback to DB
  try {
    const row = await prisma.allianceApiKey.findUnique({
      where: { allianceId },
    });
    if (row?.apiKey) return row.apiKey;
  } catch {
    // ignore if table not present / prisma not migrated
  }

  throw new Error(
    `No API key found. Set PNW_API_KEY_${allianceId} or PNW_API_KEY (or insert into AllianceApiKey).`
  );
}

// Cursor helpers backed by AllianceBankCursor (new schema)
export async function getAllianceCursor(allianceId: number): Promise<string | null> {
  try {
    const cur = await prisma.allianceBankCursor.findUnique({
      where: { allianceId },
    });
    return cur?.lastSeenId ?? null;
  } catch {
    return null;
  }
}

export async function setAllianceCursor(allianceId: number, id: string | number | null): Promise<void> {
  const lastSeenId = id == null ? "" : String(id);
  await prisma.allianceBankCursor.upsert({
    where: { allianceId },
    update: { lastSeenId },
    create: { allianceId, lastSeenId },
  });
}

// --- GraphQL helpers ---

type RawRow = {
  id: string;
  date: string;
  note?: string | null;
  sender_type: number;
  sender_id: string;
  receiver_type: number;
  receiver_id: string;
};

type AlliancePayload = {
  id: string;
  name: string;
  bankrecs?: RawRow[];
  taxrecs?: RawRow[];
};

async function gql<T>(apiKey: string, query: string, variables: Record<string, any>): Promise<T> {
  const url = "https://api.politicsandwar.com/graphql?api_key=" + encodeURIComponent(apiKey);
  const r = await (globalThis as any).fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    throw new Error("PnW GraphQL errors: " + JSON.stringify(j.errors || { status: r.status }));
  }
  return j.data as T;
}

// Fetch latest alliance bankrecs (limit only; paging not supported on alliance field)
async function fetchAllianceBankrecs(allianceId: number, limit = 25, apiKey: string): Promise<RawRow[]> {
  const q = `query($aid:[Int!],$limit:Int){
    alliances(id:$aid){
      data{ id name bankrecs(limit:$limit){
        id date note sender_type sender_id receiver_type receiver_id
      }}
    }
  }`;
  type Resp = { alliances: { data: AlliancePayload[] } };
  const data = await gql<Resp>(apiKey, q, { aid: [allianceId], limit });
  const a = data?.alliances?.data?.[0];
  return a?.bankrecs ?? [];
}

// Fetch latest alliance taxrecs (limit only)
async function fetchAllianceTaxrecs(allianceId: number, limit = 25, apiKey: string): Promise<RawRow[]> {
  const q = `query($aid:[Int!],$limit:Int){
    alliances(id:$aid){
      data{ id name taxrecs(limit:$limit){
        id date note sender_type sender_id receiver_type receiver_id
      }}
    }
  }`;
  type Resp = { alliances: { data: AlliancePayload[] } };
  const data = await gql<Resp>(apiKey, q, { aid: [allianceId], limit });
  const a = data?.alliances?.data?.[0];
  return a?.taxrecs ?? [];
}

// Back-compat signature: either options object or positional args.
// Old commands call queryAllianceBankrecs(allianceId, limit?, filter?)
type QueryOpts = {
  allianceId: number;
  limit?: number;
  filter?: BankrecFilter | "all" | "tax";
};

export async function queryAllianceBankrecs(
  allianceIdOrOpts: number | QueryOpts,
  maybeLimit?: number,
  maybeFilter?: BankrecFilter | "all" | "tax"
): Promise<RawRow[]> {
  let allianceId: number;
  let limit = 25;
  let filter: BankrecFilter | "all" | "tax" = BankrecFilter.ALL;

  if (typeof allianceIdOrOpts === "number") {
    allianceId = allianceIdOrOpts;
    if (typeof maybeLimit === "number") limit = maybeLimit;
    if (maybeFilter) filter = maybeFilter;
  } else {
    allianceId = allianceIdOrOpts.allianceId;
    if (allianceIdOrOpts.limit) limit = allianceIdOrOpts.limit;
    if (allianceIdOrOpts.filter) filter = allianceIdOrOpts.filter;
  }

  if (!Number.isFinite(allianceId)) {
    throw new Error("Invalid alliance_id: " + allianceId);
  }

  const apiKey = await getAllianceApiKey(allianceId);
  if (filter === BankrecFilter.TAX || filter === "tax") {
    return await fetchAllianceTaxrecs(allianceId, limit, apiKey);
  } else {
    return await fetchAllianceBankrecs(allianceId, limit, apiKey);
  }
}
