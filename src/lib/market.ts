// src/lib/market.ts
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js"; // same folder

const prisma = new PrismaClient();
// Your crypto.open expects Uint8Array/Buffer inputs.
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
    // Pass raw Buffers directly to open()
    const cipher = k.encryptedApiKey as unknown as Uint8Array;
    const nonce = k.nonceApi as unknown as Uint8Array;
    return open(cipher, nonce);
  } catch {
    return null;
  }
}

/** Primary: GraphQL tradeprices (average market prices, daily). */
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return null;
    const json: any = await resp.json().catch(() => null);
    const row = json?.data?.tradeprices?.data?.[0];
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

/**
 * Fallback: REST /tradeprice per resource (deprecated, returns avgprice).
 * Tries with key first; if that fails, retries without a key. Keeps any successes.
 */
async function fetchAveragePricesREST(apiKey: string): Promise<PriceResult | null> {
  const base = "https://api.politicsandwar.com/tradeprice/";
  const prices: PriceMap = { money: 1 };
  let gotAny = false;

  for (const res of RESOURCES_FOR_REST) {
    // 1) Try with key
    let url = `${base}?resource=${encodeURIComponent(res)}&key=${encodeURIComponent(apiKey)}&format=json`;
    let r: any = null;
    try { r = await fetch(url); } catch { r = null; }

    // 2) If failed or non-200, retry without key (public)
    if (!r || !r.ok) {
      url = `${base}?resource=${encodeURIComponent(res)}&format=json`;
      try { r = await fetch(url); } catch { r = null; }
    }

    if (!r || !r.ok) continue;

    const json: any = await r.json().catch(() => null);
    const avg = normalize(json?.avgprice);
    if (avg !== null) {
      (prices as any)[res] = avg;
      gotAny = true;
    }
  }

  return gotAny
    ? { prices, asOf: new Date().toISOString(), source: "REST avg" }
    : null;
}

/** Public: GraphQL first, then REST; final money-only fallback so command never fails. */
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
