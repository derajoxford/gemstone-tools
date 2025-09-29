// src/lib/market.ts
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js";

const prisma = new PrismaClient();
// crypto.open expects Uint8Array/Buffer inputs.
const open = (cryptoMod as any).open as (cipher: Uint8Array, nonce: Uint8Array) => string;

export type Resource =
  | "money"
  | "food"
  | "coal"
  | "oil"
  | "uranium"
  | "lead"
  | "iron"
  | "bauxite"
  | "gasoline"
  | "munitions"
  | "steel"
  | "aluminum"
  | "credits";

export type PriceMap = Partial<Record<Resource, number>>;
export type PriceResult = {
  prices: PriceMap;
  asOf: string;
  source: "GraphQL avg" | "REST avg" | "money-only";
};

const RESOURCES_FOR_REST: Exclude<Resource, "money" | "credits">[] = [
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

function normalize(n: any): number | null {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function fmtNowISO() {
  return new Date().toISOString();
}

async function getAnyPnwApiKey(): Promise<string | null> {
  const k = await prisma.allianceKey.findFirst({ orderBy: { id: "desc" } });
  if (!k) return null;
  try {
    const cipher = k.encryptedApiKey as unknown as Uint8Array;
    const nonce = k.nonceApi as unknown as Uint8Array;
    return open(cipher, nonce);
  } catch {
    return null;
  }
}

/* ------------------------------- Fetch utils ------------------------------ */

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 2500, ...rest } = opts;
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function safeJson(resp: Response): Promise<any | null> {
  try {
    return await resp.json();
  } catch {
    try {
      const txt = await resp.text();
      return JSON.parse(
        txt.replace(/'/g, '"').replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")
      );
    } catch {
      return null;
    }
  }
}

/* --------------------------- GraphQL tradeprices -------------------------- */
/** Primary: GraphQL `tradeprices` (avg prices, daily) with 4s timeout. */
async function fetchAveragePricesGraphQL(apiKey: string): Promise<PriceResult | null> {
  try {
    const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
    const query = `
      query LatestTradeprices {
        tradeprices(first: 1, orderBy: [{column: ID, order: DESC}]) {
          data {
            date
            aluminum
            bauxite
            coal
            food
            gasoline
            iron
            lead
            munitions
            oil
            steel
            uranium
            credits
          }
        }
      }
    `;
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "User-Agent": "gemstone-tools/0.1 (+discord bot)",
      },
      body: JSON.stringify({ query }),
      timeoutMs: 4000,
    });
    if (!resp.ok) return null;
    const json = await safeJson(resp);
    const row = (json as any)?.data?.tradeprices?.data?.[0];
    if (!row) return null;

    const prices: PriceMap = {
      money: 1,
      food: normalize(row.food) ?? undefined,
      coal: normalize(row.coal) ?? undefined,
      oil: normalize(row.oil) ?? undefined,
      uranium: normalize(row.uranium) ?? undefined,
      lead: normalize(row.lead) ?? undefined,
      iron: normalize(row.iron) ?? undefined,
      bauxite: normalize(row.bauxite) ?? undefined,
      gasoline: normalize(row.gasoline) ?? undefined,
      munitions: normalize(row.munitions) ?? undefined,
      steel: normalize(row.steel) ?? undefined,
      aluminum: normalize(row.aluminum) ?? undefined,
      credits: normalize(row.credits) ?? undefined,
    };

    return { prices, asOf: String(row.date), source: "GraphQL avg" };
  } catch {
    return null;
  }
}

/* ----------------------------- REST tradeprice ---------------------------- */
/**
 * Fallback: `/api/tradeprice` (avgprice). We do **parallel** requests with a strict timeout
 * and try two variants per resource: with key and without key.
 */
async function fetchAveragePricesREST(apiKey: string): Promise<PriceResult | null> {
  const prices: PriceMap = { money: 1 };

  const tasks = RESOURCES_FOR_REST.map(async (res) => {
    const q = encodeURIComponent(res);
    const variants = [
      `https://politicsandwar.com/api/tradeprice/?resource=${q}&key=${encodeURIComponent(apiKey)}&format=json`,
      `https://politicsandwar.com/api/tradeprice/?resource=${q}&format=json`,
    ];

    for (const url of variants) {
      try {
        const r = await fetchWithTimeout(url, {
          headers: {
            Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
            "User-Agent": "gemstone-tools/0.1 (+discord bot)",
          },
          timeoutMs: 2500,
        });
        if (!r.ok) continue;
        const js = await safeJson(r);
        const avg = normalize(js?.avgprice);
        if (avg !== null) {
          (prices as any)[res] = avg;
          return;
        }
      } catch {
        // try next variant
      }
    }
  });

  await Promise.allSettled(tasks);
  const gotAny = Object.keys(prices).length > 1; // money + something
  return gotAny
    ? { prices, asOf: fmtNowISO(), source: "REST avg" }
    : null;
}

/* ------------------------------- Public API ------------------------------- */
/** GraphQL first, then REST; last resort = money-only so the command never fails. */
export async function fetchAveragePrices(): Promise<PriceResult | null> {
  const apiKey = await getAnyPnwApiKey();
  if (!apiKey) return null;

  const g = await fetchAveragePricesGraphQL(apiKey);
  if (g) return g;

  const r = await fetchAveragePricesREST(apiKey);
  if (r) return r;

  return { prices: { money: 1 }, asOf: fmtNowISO(), source: "money-only" };
}

export function computeTotalValue(
  safekeep: Partial<Record<Resource, number>>,
  prices: PriceMap
): number {
  let total = 0;
  (Object.keys(prices) as Resource[]).forEach((res) => {
    const qty = Number(safekeep[res] ?? 0);
    const p = prices[res];
    if (Number.isFinite(qty) && Number.isFinite(p)) total += qty * (p as number);
  });
  return total;
}

export function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
