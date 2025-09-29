// src/lib/market.ts
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js"; // same folder

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

/** Primary: GraphQL tradeprices (avg market prices, daily). */
async function fetchAveragePricesGraphQL(apiKey: string): Promise<{ prices: PriceMap; asOf: string } | null> {
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
      // credits avg sometimes present in GraphQL
      credits: normalize(row.credits) ?? undefined,
    };

    return { prices, asOf: String(row.date) };
  } catch {
    return null;
  }
}

/** Fallback: REST /tradeprice per resource (deprecated, but returns avgprice). */
async function fetchAveragePricesREST(apiKey: string): Promise<{ prices: PriceMap; asOf: string } | null> {
  const base = "https://api.politicsandwar.com/tradeprice/";
  const prices: PriceMap = { money: 1 };
  let gotAny = false;

  try {
    // Fetch each resource independently; keep whatever succeeds.
    for (const res of RESOURCES_FOR_REST) {
      const u = `${base}?resource=${encodeURIComponent(res)}&key=${encodeURIComponent(apiKey)}&format=json`;
      const r = await fetch(u);
      if (!r.ok) continue;
      const json = await r.json().catch(() => null);
      const avg = normalize((json as any)?.avgprice);
      if (avg !== null) {
        (prices as any)[res] = avg;
        gotAny = true;
      }
    }
    // REST doesn’t return a timestamp — synthesize “now”.
    return gotAny ? { prices, asOf: new Date().toISOString() } : null;
  } catch {
    return gotAny ? { prices, asOf: new Date().toISOString() } : null;
  }
}

/**
 * Public: fetch average prices with GraphQL first, then REST.
 * Never returns null if we at least have an API key — we fall back to `{ money: 1 }`.
 */
export async function fetchAveragePrices(): Promise<{ prices: PriceMap; asOf: string } | null> {
  const apiKey = await getAnyPnwApiKey();
  if (!apiKey) return null;

  const g = await fetchAveragePricesGraphQL(apiKey);
  if (g) return g;

  const r = await fetchAveragePricesREST(apiKey);
  if (r) return r;

  // Ultimate fallback so the command still works (values money-only).
  return { prices: { money: 1 }, asOf: new Date().toISOString() };
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
