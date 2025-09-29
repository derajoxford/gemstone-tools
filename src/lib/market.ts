// src/lib/market.ts
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

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

function normalize(n: any): number | null {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

async function getAnyPnwApiKey(): Promise<string | null> {
  const k = await prisma.allianceKey.findFirst({ orderBy: { id: "desc" } });
  if (!k) return null;
  try {
    return open(k.encryptedApiKey, k.nonce);
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent average market prices from PnW GraphQL.
 * Returns a { prices, asOf } pair where asOf is an ISO timestamp string.
 */
export async function fetchAveragePrices(): Promise<{ prices: PriceMap; asOf: string } | null> {
  const apiKey = await getAnyPnwApiKey();
  if (!apiKey) return null;

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

  return { prices, asOf: String(row.date) };
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
