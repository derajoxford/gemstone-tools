// src/lib/pnw_bank_ingest.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type BankrecRow = {
  id: string;
  date: string;
  note: string;
  tax_id: string | null;
  sender_type: number;
  receiver_type: number;
  sender_id: string;
  receiver_id: string;
};

export type PeekFilter = 'all' | 'tax' | 'nontax';

const PNW_URL = 'https://api.politicsandwar.com/graphql';

function envInt(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Query the *top-level* bankrecs feed and filter for alliance involvement.
 * This path is resilient vs the alliances(...) 500s.
 */
export async function queryAllianceBankrecs(opts: {
  allianceId: number;
  filter: PeekFilter;
  afterId?: string; // exclusive lower bound
  limit: number;    // number of rows to return (after local filtering)
  apiKey: string;
}) {
  const { allianceId, filter, afterId, limit, apiKey } = opts;

  // fail-fast tunables
  const HTTP_TIMEOUT_MS = envInt('PNW_HTTP_TIMEOUT_MS', 7000);
  const MAX_RETRIES = envInt('PNW_MAX_RETRIES', 1); // total attempts = 1 + MAX_RETRIES
  const PAGE_SIZE = Math.min(Math.max(limit, 25), 100); // ask at least 25 to find matches

  // read/update cursor
  const cursor = await prisma.allianceBankCursor.findUnique({
    where: { allianceId },
  });

  const effectiveAfterId = afterId ?? cursor?.lastSeenId ?? '';

  let collected: BankrecRow[] = [];
  let nextPage = 1;
  let attempts = 0;

  // keep paging until we gather enough local matches or we hit a small cap
  while (collected.length < limit && nextPage <= 12) {
    const pageData = await fetchBankrecsPage({
      apiKey,
      page: nextPage,
      first: PAGE_SIZE,
      timeoutMs: HTTP_TIMEOUT_MS,
      retries: MAX_RETRIES,
    });

    if (!pageData) break;

    // stop if server says empty
    const rows: BankrecRow[] = pageData.data ?? [];
    if (!rows.length) break;

    // apply afterId (exclusive)
    const cut = effectiveAfterId
      ? rows.filter((r) => r.id > effectiveAfterId) // IDs are decimal strings; API is monotonic
      : rows;

    // filter for our alliance (type 2 means alliance)
    const mine = cut.filter(
      (x) =>
        (x.sender_type === 2 && x.sender_id === String(allianceId)) ||
        (x.receiver_type === 2 && x.receiver_id === String(allianceId)),
    );

    // apply tax/nontax
    const filtered =
      filter === 'all'
        ? mine
        : filter === 'tax'
          ? mine.filter((x) => x.tax_id && x.tax_id !== '0')
          : mine.filter((x) => !x.tax_id || x.tax_id === '0');

    collected.push(...filtered);

    // if the last item on this page is <= effectiveAfterId, we can stop early
    const maxIdOnPage = rows[rows.length - 1]?.id ?? '';
    if (effectiveAfterId && maxIdOnPage <= effectiveAfterId) break;

    nextPage++;
    attempts++;
    if (attempts > 1) await sleep(250);
  }

  // sort ascending by id, return most recent last
  collected.sort((a, b) => Number(a.id) - Number(b.id));

  // update cursor to newest seen id (if we actually have newer)
  const newest = collected.length ? collected[collected.length - 1].id : undefined;
  if (newest && (!cursor || newest > (cursor.lastSeenId ?? ''))) {
    await prisma.allianceBankCursor.upsert({
      where: { allianceId },
      update: { lastSeenId: newest },
      create: { allianceId, lastSeenId: newest },
    });
  }

  // trim down to exactly limit but keep recency ordering: return last N
  const out =
    collected.length > limit ? collected.slice(collected.length - limit) : collected;

  return out;
}

async function fetchBankrecsPage(params: {
  apiKey: string;
  first: number;
  page: number;
  timeoutMs: number;
  retries: number;
}) {
  const { apiKey, first, page, timeoutMs, retries } = params;

  const query = `
    query($first:Int!,$page:Int!){
      bankrecs(first:$first,page:$page){
        data{
          id
          date
          note
          tax_id
          sender_type
          receiver_type
          sender_id
          receiver_id
        }
        paginatorInfo{
          currentPage
          hasMorePages
        }
      }
    }`;

  let attempt = 0;
  while (true) {
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), timeoutMs);

      const res = await fetch(`${PNW_URL}?api_key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { first, page } }),
        signal: ac.signal,
      });

      clearTimeout(to);

      const text = await res.text();

      if (!res.ok) {
        // Cloudflare sometimes returns HTML 500/502; surface succinctly
        throw new Error(`PnW GraphQL HTTP ${res.status}: ${text.slice(0, 180)}`);
      }

      const json = JSON.parse(text);
      const data = json?.data?.bankrecs;
      if (!data) return null;

      return {
        data: data.data as BankrecRow[],
        pageInfo: data.paginatorInfo as { currentPage: number; hasMorePages: boolean },
      };
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt++;
      await sleep(300 * attempt);
    }
  }
}

/**
 * Get an API key for an alliance:
 *   1) DB (alliance_api_keys)
 *   2) env PNW_API_KEY_<aid>
 *   3) env PNW_API_KEY
 */
export async function resolveAllianceApiKey(allianceId: number): Promise<string | null> {
  const row = await prisma.allianceApiKey.findUnique({
    where: { allianceId },
    select: { apiKey: true },
  });
  if (row?.apiKey) return row.apiKey;

  const envKey = process.env[`PNW_API_KEY_${allianceId}`] || process.env['PNW_API_KEY'];
  return envKey ?? null;
}
