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

/** Primary: GraphQL tradeprices (avg market prices, daily). */
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
