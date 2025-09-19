// src/lib/pnw_bank_ingest.ts
/* Phase A: Alliance bank intake via root-level bankrecs
   - Never touch alliances(...).bankrecs (often 500s)
   - Pull bankrecs(first,page) pages and filter client-side
   - Cache into Prisma tables: AllianceBankCursor, AllianceBankrec
*/

import type { Prisma, AllianceBankrec as ABR, AllianceBankCursor as ABC } from "@prisma/client";
import { prisma } from "./prisma.js"; // see src/lib/prisma.ts below

// --- Small helpers -----------------------------------------------------------

function getApiKeyForAlliance(aid: number): string {
  const envKey = process.env[`PNW_API_KEY_${aid}`] || process.env.PNW_API_KEY;
  if (!envKey) throw new Error("Alliance key record missing usable apiKey");
  return envKey.trim();
}

type BankrecRaw = {
  id: string;
  date: string; // ISO
  note: string | null;
  tax_id: string; // "0" or a bracket id
  sender_type: number;    // 1=nation, 2=alliance, ...
  receiver_type: number;  // 1=nation, 2=alliance, ...
  sender_id: string;
  receiver_id: string;
};

type BankrecsPage = {
  data: BankrecRaw[];
  paginatorInfo: { currentPage: number; hasMorePages: boolean };
};

async function gql<T>(aid: number, query: string, variables: Record<string, any>): Promise<T> {
  const key = getApiKeyForAlliance(aid);
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`PnW GraphQL HTTP ${r.status}: ${txt}`);
  const parsed = JSON.parse(txt);
  if (parsed.errors?.length) throw new Error(`PnW GraphQL error: ${txt}`);
  return parsed.data as T;
}

function isAllianceRow(aid: number, row: BankrecRaw): boolean {
  const sA = row.sender_type === 2 && row.sender_id === String(aid);
  const rA = row.receiver_type === 2 && row.receiver_id === String(aid);
  return sA || rA;
}

function isIgnored(row: BankrecRaw): boolean {
  return (row.note ?? "").toLowerCase().includes("#ignore");
}

function isTaxGuess(aid: number, row: BankrecRaw): boolean {
  const note = row.note ?? "";
  if (row.tax_id && row.tax_id !== "0") return true;
  if (/\(#\d+\)/.test(note)) return true; // bracket tag in note like "(#27291)"
  // nation -> alliance looks like a tax deposit frequently
  const memberToAlliance = row.sender_type === 1 && row.receiver_type === 2 && row.receiver_id === String(aid);
  return memberToAlliance;
}

// --- Public API --------------------------------------------------------------

export type PeekFilter = "all" | "tax" | "nontax";

export async function ingestAllianceBankrecs(aid: number, opts?: { maxPages?: number; pageSize?: number }): Promise<{ pagesScanned: number; inserted: number }> {
  const maxPages = Math.max(1, Math.min(50, opts?.maxPages ?? 10));
  const first = Math.max(1, Math.min(100, opts?.pageSize ?? 50));

  // Get (or create) cursor
  const cur = await prisma.allianceBankCursor.upsert({
    where: { alliance_id: aid },
    update: {},
    create: { alliance_id: aid, last_seen_bankrec_id: "" },
  });

  // Pull pages until maxPages
  let page = 1;
  let inserted = 0;

  const query = `
    query($first:Int!, $page:Int!){
      bankrecs(first:$first, page:$page){
        data{
          id date note tax_id sender_type receiver_type sender_id receiver_id
        }
        paginatorInfo{ currentPage hasMorePages }
      }
    }`;

  let keepGoing = true;
  while (keepGoing && page <= maxPages) {
    const data = await gql<{ bankrecs: BankrecsPage }>(aid, query, { first, page });
    const rows = data.bankrecs.data;

    // Map, filter to this alliance, ignore flagged, stop at known id if seen
    let reachedKnown = false;

    const ours = rows
      .filter((r) => isAllianceRow(aid, r))
      .filter((r) => {
        if (cur.last_seen_bankrec_id && r.id === cur.last_seen_bankrec_id) {
          reachedKnown = true;
          return false;
        }
        return true;
      })
      .filter((r) => !isIgnored(r));

    // Upsert new rows
    if (ours.length) {
      const toCreate: Prisma.AllianceBankrecCreateManyInput[] = ours.map((r) => ({
        id: r.id,
        date: new Date(r.date),
        note: r.note ?? "",
        tax_id: r.tax_id ?? "0",
        sender_type: r.sender_type,
        receiver_type: r.receiver_type,
        sender_id: r.sender_id,
        receiver_id: r.receiver_id,
        alliance_id_derived: aid,
        is_tax_guess: isTaxGuess(aid, r),
        is_ignored: false,
      }));

      // createMany with skipDuplicates
      const res = await prisma.allianceBankrec.createMany({ data: toCreate, skipDuplicates: true });
      inserted += res.count;

      // Update cursor to newest row we observed (highest id within this page)
      // Bankrec IDs increase over time; set cursor to max id we just processed (ours and possibly non-ours on page)
      const newestOnPage = rows.reduce((m, r) => (BigInt(r.id) > BigInt(m) ? r.id : m), cur.last_seen_bankrec_id || "0");
      if (BigInt(newestOnPage) > BigInt(cur.last_seen_bankrec_id || "0")) {
        await prisma.allianceBankCursor.update({
          where: { alliance_id: aid },
          data: { last_seen_bankrec_id: newestOnPage, updated_at: new Date() },
        });
        cur.last_seen_bankrec_id = newestOnPage;
      }
    }

    // Stop if we reached known cursor OR no more pages
    keepGoing = !reachedKnown && data.bankrecs.paginatorInfo.hasMorePages;
    page++;
    // Gentle pacing
    if (keepGoing) await new Promise((r) => setTimeout(r, 250));
  }

  return { pagesScanned: page - 1, inserted };
}

export async function queryAllianceBankrecs(aid: number, params: { filter: PeekFilter; limit: number; afterId?: string }) {
  const whereBase: Prisma.AllianceBankrecWhereInput = {
    alliance_id_derived: aid,
    is_ignored: false,
  };

  let where: Prisma.AllianceBankrecWhereInput = whereBase;
  if (params.filter === "tax") where = { ...whereBase, is_tax_guess: true };
  if (params.filter === "nontax") where = { ...whereBase, is_tax_guess: false };

  const take = Math.min(100, Math.max(1, params.limit || 25));

  const list = await prisma.allianceBankrec.findMany({
    where,
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take,
    ...(params.afterId
      ? {
          cursor: { id: params.afterId },
          skip: 1,
        }
      : {}),
  });

  return list;
}
