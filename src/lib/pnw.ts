// src/lib/pnw.ts
import fetch from "node-fetch";
import { PrismaClient } from "@prisma/client";

// ---------------------------
// Resource Keys + Delta Utils
// ---------------------------
export const RESOURCE_KEYS = [
  "money",
  "coal",
  "oil",
  "uranium",
  "iron",
  "bauxite",
  "lead",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
  "food",
] as const;

export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Record<ResourceKey, number>;

export function zeroDelta(): ResourceDelta {
  return Object.fromEntries(RESOURCE_KEYS.map(k => [k, 0])) as ResourceDelta;
}

export function sumDelta(deltas: ResourceDelta[]): ResourceDelta {
  const out = zeroDelta();
  for (const d of deltas) {
    for (const k of RESOURCE_KEYS) out[k] += d[k];
  }
  return out;
}

export function signedDeltaFor(rec: any): ResourceDelta {
  const out = zeroDelta();
  for (const k of RESOURCE_KEYS) {
    const v = rec[k] ?? 0;
    // incoming -> positive, outgoing -> negative
    out[k] = rec.receiver_type === 2 ? v : -v;
  }
  return out;
}

// ---------------------------
// GraphQL Bankrec Fetch
// ---------------------------
export async function fetchAllianceBankrecsViaGQL(
  prisma: PrismaClient,
  allianceId: number,
  opts: { afterId?: string; limit?: number; filter?: "all" | "tax" | "nontax" } = {}
) {
  const keyRec = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!keyRec) throw new Error(`No API key stored for alliance ${allianceId}`);
  const apiKey = keyRec.decrypted || keyRec.apiKey || null;
  if (!apiKey) throw new Error(`Alliance key record missing usable apiKey`);

  const { afterId, limit = 50 } = opts;
  const query = `
    query($aid:Int!,$limit:Int){
      alliances(ids:[$aid]){
        data{
          id
          name
          bankrecs(limit:$limit,after_id:$afterId){
            id
            date
            note
            tax_id
            sender_type
            receiver_type
            sender_id
            receiver_id
            money
            coal
            oil
            uranium
            iron
            bauxite
            lead
            gasoline
