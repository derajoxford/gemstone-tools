/* eslint-disable @typescript-eslint/no-explicit-any */

import { PrismaClient, AllianceApiKey, AllianceBankCursor } from '@prisma/client';
import fetch from 'node-fetch';

const prisma = new PrismaClient();

/** PnW constants for bankrec party types (observed) */
const PARTY_TYPE = {
  NATION: 1,
  ALLIANCE: 2,
  TREASURE: 3, // etc., but we only need ALLIANCE checks here
} as const;

type BankrecRow = {
  id: string;
  date?: string;
  note?: string;
  tax_id?: string;
  sender_type: number;
  receiver_type: number;
  sender_id: string;
  receiver_id: string;
};

type BankrecPage = {
  data: BankrecRow[];
  paginatorInfo?: {
    currentPage: number;
    hasMorePages: boolean;
  };
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

const GQL_URL = 'https://api.politicsandwar.com/graphql';

/** Load the API key for an alliance from DB (AllianceApiKey) */
export async function getAllianceApiKey(allianceId: number): Promise<string | null> {
  const row: AllianceApiKey | null = await prisma.allianceApiKey.findUnique({
    where: { allianceId },
  });
  return row?.apiKey ?? null;
}

/** Cursor helpers (ALL camelCase to match prisma schema) */
export async function getAllianceCursor(allianceId: number): Promise<AllianceBankCursor | null> {
  return prisma.allianceBankCursor.findUnique({ where: { allianceId } });
}

export async function setAllianceCursor(allianceId: number, lastSeenId: string): Promise<void> {
  await prisma.allianceBankCursor.upsert({
    where: { allianceId },
    update: { lastSeenId },
    create: { allianceId, lastSeenId },
  });
}

/** Minimal top-level bankrecs page query (no filters available server-side) */
const BANKRECS_PAGE_QUERY = `
  query BankrecsPage($first:Int!,$page:Int!) {
    bankrecs(first:$first, page:$page) {
      data {
        id
        date
        note
        tax_id
        sender_type
        receiver_type
        sender_id
        receiver_id
      }
      paginatorInfo { currentPage hasMorePages }
    }
  }
`;

/** Robust GraphQL fetch with simple retry/backoff for flaky 500/502/ECONNRESET */
async function gql<T>(apiKey: string, query: string, variables: Record<string, any>): Promise<T> {
  const url = `${GQL_URL}?api_key=${encodeURIComponent(apiKey)}`;
  let lastErr: any;
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });

      const text = await res.text();

      if (!res.ok) {
        // Cloudflare sometimes returns HTML (500 page). Surface it as-is.
        throw new Error(`PnW GraphQL HTTP ${res.status}: ${text}`);
      }

      const parsed = JSON.parse(text) as GraphQLResponse<any>;
      if (parsed.errors?.length) {
        throw new Error(`PnW GraphQL errors: ${parsed.errors.map(e => e.message).join('; ')}`);
      }

      return parsed.data as T;
    } catch (err: any) {
      lastErr = err;
      // Backoff: 0.5s, 1s, 2s …
      const waitMs = 500 * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  throw lastErr ?? new Error('PnW GraphQL failed after retries');
}

/** Predicate: does a bankrec involve this alliance? */
function involvesAlliance(rec: BankrecRow, allianceId: number): boolean {
  const isSenderAlliance = rec.sender_type === PARTY_TYPE.ALLIANCE && Number(rec.sender_id) === allianceId;
  const isReceiverAlliance = rec.receiver_type === PARTY_TYPE.ALLIANCE && Number(rec.receiver_id) === allianceId;
  return isSenderAlliance || isReceiverAlliance;
}

/** Optional subfilter: only tax or only non-tax */
export type BankrecFilter = 'all' | 'tax' | 'nontax';

function passesFilter(rec: BankrecRow, filter: BankrecFilter): boolean {
  if (filter === 'all') return true;
  const isTax = rec.tax_id && rec.tax_id !== '0';
  return filter === 'tax' ? !!isTax : !isTax;
}

/**
 * Page through bankrecs until we gather `limit` rows for `allianceId`,
 * honoring `afterId` (exclusive) if provided. Because the API doesn’t expose
 * alliance filters, we scan pages and filter client-side.
 */
export async function queryAllianceBankrecs(params: {
  allianceId: number;
  apiKey: string;
  limit: number;
  afterId?: string; // exclusive cursor
  filter: BankrecFilter;
  pageLimit?: number; // safety cap for how many pages to scan
}): Promise<BankrecRow[]> {
  const { allianceId, apiKey, limit, afterId, filter, pageLimit = 60 } = params;

  const first = 50; // per-page size
  let page = 1;
  const out: BankrecRow[] = [];

  const seenAfterId = new Set<string>();
  if (afterId) seenAfterId.add(afterId);

  while (out.length < limit && page <= pageLimit) {
    const data = await gql<{ bankrecs: BankrecPage }>(apiKey, BANKRECS_PAGE_QUERY, { first, page });
    const rows = data.bankrecs?.data ?? [];

    for (const rec of rows) {
      if (afterId && rec.id === afterId) {
        // Found the cursor id in-stream; all earlier IDs on later pages will be older.
        continue;
      }
      if (!involvesAlliance(rec, allianceId)) continue;
      if (!passesFilter(rec, filter)) continue;

      // Stop if we have already passed the afterId (IDs grow over time; we treat afterId as exclusive)
      if (afterId && rec.id <= afterId) continue;

      out.push(rec);
      if (out.length >= limit) break;
    }

    const more = data.bankrecs?.paginatorInfo?.hasMorePages;
    if (!more) break;
    page += 1;
    // be polite
    await new Promise(r => setTimeout(r, 200));
  }

  return out;
}

/**
 * Monitor job helper:
 * - reads alliance API key
 * - reads cursor
 * - fetches new rows after cursor
 * - updates cursor to newest seen id (max)
 */
export async function pollAndAdvanceCursor(allianceId: number, filter: BankrecFilter = 'all'): Promise<BankrecRow[]> {
  const apiKey = await getAllianceApiKey(allianceId);
  if (!apiKey) throw new Error(`No API key found for alliance ${allianceId}`);

  const cursor = await getAllianceCursor(allianceId);
  const afterId = cursor?.lastSeenId;

  const rows = await queryAllianceBankrecs({
    allianceId,
    apiKey,
    limit: 100,
    afterId,
    filter,
    pageLimit: 80,
  });

  if (rows.length) {
    const newestId = rows.reduce((m, r) => (r.id > m ? r.id : m), afterId ?? '0');
    await setAllianceCursor(allianceId, newestId);
  }

  return rows;
}
