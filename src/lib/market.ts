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

const RESOURCES_FOR_REST: Exclude<Resource, "money">[] = [
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
  // "credits", // REST /tradeprice historically doesn’t support credits; leave off unless confirmed
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

/** Try GraphQL tradeprices (avg market prices, daily). Returns null on failure. */
async function fetchAveragePricesGraphQL(apiKey: string): Promise<{ prices: PriceMap; asOf: string } | null> {
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
    credits: normalize(row.credits) ?? undefined,
  };

  return { prices, asOf: String(row.date) };
}

/** Fallback: REST /tradeprice per resource (deprecated, but returns avgprice). */
async function fetchAveragePricesREST(apiKey: string): Promise<{ prices: PriceMap; asOf: string } | null> {
  try {
    const base = "https://api.politicsandwar.com/tradeprice/";
    const queries = RESOURCES_FOR_REST.map(async (res) => {
      const u = `${base}?resource=${encodeURIComponent(res)}&key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`REST ${res} http ${r.status}`);
      const txt = await r.text();
      // The legacy API can return non-minified single quotes; try to parse safely:
      const json = JSON.parse(
        txt
          .replace(/'/g, '"') // normalize quotes
          .replace(/,\s*}/g, "}") // trailing commas safety
          .replace(/,\s*]/g, "]"),
      );
      const avg = normalize((json as any).avgprice);
      return [res, avg] as const;
    });

    const pairs = await Promise.all(queries);
    const p: PriceMap = { money: 1 };
    for (const [res, avg] of pairs) {
      if (avg !== null) (p as any)[res] = avg;
    }
    // REST doesn’t return a date; synthesize “as of now”.
    return { prices: p, asOf: new Date().toISOString() };
  } catch {
    return null;
  }
}

/**
 * Public: fetch average prices with GraphQL first, fallback to REST.
 * Returns null only if both sources fail.
 */
export async function fetchAveragePrices(): Promise<{ prices: PriceMap; asOf: string } | null> {
  const apiKey = await getAnyPnwApiKey();
  if (!apiKey) return null;

  // Primary: GraphQL
  const g = await fetchAveragePricesGraphQL(apiKey);
  if (g) return g;

  // Fallback: REST per-resource avgprice
  const r = await fetchAveragePricesREST(apiKey);
  if (r) return r;

  return null;
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
