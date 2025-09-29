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

/* ----------------------------- HTTP helpers ----------------------------- */

async function fetchJsonLenient(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "gemstone-tools/0.1 (+discord bot)",
      },
    });
    if (!r.ok) return null;

    try {
      return await r.json();
    } catch {
      const txt = await r.text();
      try {
        return JSON.parse(
          txt
            .replace(/'/g, '"') // some legacy endpoints reply with single quotes
            .replace(/,\s*}/g, "}")
            .replace(/,\s*]/g, "]")
        );
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/* --------------------------- GraphQL tradeprices -------------------------- */
/** Primary: GraphQL `tradeprices` (avg prices, daily). */
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
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Some clients use header auth; include it to avoid spurious 500s
        "X-Api-Key": apiKey,
        "User-Agent": "gemstone-tools/0.1 (+discord bot)",
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return null;
    const json = await resp.json().catch(() => null);
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
 * Fallback: legacy `/api/tradeprice` endpoint on politicsandwar.com (returns `avgprice`).
 * Tries both `?resource=iron` and `/resource=iron` URL styles, with and without key.
 */
async function fetchAveragePricesREST(apiKey: string): Promise<PriceResult | null> {
  const prices: PriceMap = { money: 1 };
  let gotAny = false;

  for (const res of RESOURCES_FOR_REST) {
    const q = encodeURIComponent(res);
    const candidates = [
      // canonical host (docs/examples)
      `https://politicsandwar.com/api/tradeprice/?resource=${q}&key=${encodeURIComponent(apiKey)}`,
      `https://politicsandwar.com/api/tradeprice?resource=${q}&key=${encodeURIComponent(apiKey)}`,
      `https://politicsandwar.com/api/tradeprice/resource=${q}&key=${encodeURIComponent(apiKey)}`,
      // public (no key)
      `https://politicsandwar.com/api/tradeprice/?resource=${q}`,
      `https://politicsandwar.com/api/tradeprice?resource=${q}`,
      `https://politicsandwar.com/api/tradeprice/resource=${q}`,
    ];

    let avg: number | null = null;
    for (const url of candidates) {
      const json = await fetchJsonLenient(url);
      const candidate = normalize((json as any)?.avgprice);
      if (candidate !== null) {
        avg = candidate;
        break;
      }
    }

    if (avg !== null) {
      (prices as any)[res] = avg;
      gotAny = true;
    }
  }

  return gotAny ? { prices, asOf: new Date().toISOString(), source: "REST avg" } : null;
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

  return { prices: { money: 1 }, asOf: new Date().toISOString(), source: "money-only" };
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
