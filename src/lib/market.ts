// src/lib/market.ts
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js";

const prisma = new PrismaClient();
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

// Keys line up with your Safekeeping resource columns
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

/**
 * Get any saved PnW API key (most recent). We already store encrypted API keys per Alliance.
 * You’ve been testing with AID=14258; this just picks the most recent valid key so /balance
 * works even outside that specific alliance context.
 */
async function getAnyPnwApiKey(): Promise<string | null> {
  const k = await prisma.allianceKey.findFirst({
    orderBy: { id: "desc" },
  });
  if (!k) return null;
  try {
    return open(k.encryptedApiKey, k.nonce);
  } catch {
    return null;
  }
}

/**
 * Fetch latest average market prices using PnW GraphQL v3 `tradeprices`.
 * We request the most recent row (order by ID desc, first: 1).
 */
export async function fetchAveragePrices(): Promise<PriceMap | null> {
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

  // Map to our safekeeping resource names
  const prices: PriceMap = {
    // money is 1:1
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

  return prices;
}

/**
 * Compute the total $ value of a user's safekeeping given the latest price map.
 * Any missing price in the map is skipped (defensive).
 */
export function computeTotalValue(
  safekeep: Partial<Record<Resource, number>>,
  prices: PriceMap
): number {
  let total = 0;
  const add = (res: Resource) => {
    const qty = Number(safekeep[res] ?? 0);
    const p = prices[res];
    if (Number.isFinite(qty) && Number.isFinite(p)) total += qty * (p as number);
  };

  add("money");
  add("food");
  add("coal");
  add("oil");
  add("uranium");
  add("lead");
  add("iron");
  add("bauxite");
  add("gasoline");
  add("munitions");
  add("steel");
  add("aluminum");
  // Include credits if you ever track them in safekeeping
  if (safekeep.credits !== undefined) add("credits");

  return total;
}

export function fmtMoney(n: number): string {
  // Compact money format with thousands separators
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
