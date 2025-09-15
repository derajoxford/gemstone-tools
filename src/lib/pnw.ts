/* eslint-disable no-restricted-syntax */
import { PrismaClient } from "@prisma/client";

// ✅ Correct path: pnw.ts sits in src/lib next to crypto.js
import * as cryptoMod from "./crypto.js";
// open(cipher, nonce) => plaintext
const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

export type Bankrec = {
  id: number;
  date: string;
  sender_type: string;
  sender_id: number | null;
  receiver_type: string;
  receiver_id: number | null;
  note: string | null;
  money: number;
  coal: number;
  oil: number;
  uranium: number;
  iron: number;
  bauxite: number;
  lead: number;
  gasoline: number;
  munitions: number;
  steel: number;
  aluminum: number;
  food: number;
  tax_id: number | null;
};

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

const PNW_GQL_ENDPOINT = "https://api.politicsandwar.com/graphql";

/**
 * Fetches and decrypts the stored API key for a given alliance.
 */
export async function getAllianceApiKey(
  prisma: PrismaClient,
  allianceId: number
): Promise<string> {
  const k = await prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { id: "desc" },
  });
  if (!k) {
    throw new Error(`No saved API key for alliance ${allianceId}`);
  }
  const token = open(k.encryptedApiKey, k.nonce);
  if (!token) throw new Error("Failed to decrypt alliance API key");
  return token;
}

/**
 * Minimal GraphQL POST helper with Bearer token.
 */
export async function gqlFetch<T = any>(
  token: string,
  query: string,
  variables: Record<string, any>
): Promise<T> {
  const res = await fetch(PNW_GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PnW GraphQL HTTP ${res.status}: ${text}`);
  }
  const json = (await res.json()) as any;
  if (json.errors?.length) {
    const msg = json.errors.map((e: any) => e.message).join("; ");
    throw new Error(`PnW GraphQL error(s): ${msg}`);
  }
  return json.data as T;
}

/**
 * The exact shape may differ slightly across PnW API versions.
 * This query intentionally over-selects known fields and filters on the server
 * by alliance participation (sender or receiver). We still hard-filter locally
 * by tax_id > 0 and id > sinceId for absolute correctness.
 */
const BANKRECS_QUERY = /* GraphQL */ `
  query BankrecsSince(
    $allianceId: Int!
    $limit: Int!
    $cursorId: Int
  ) {
    bankrecs(
      filter: {
        OR: [
          { receiver_type: "alliance", receiver_id: $allianceId }
          { sender_type: "alliance", sender_id: $allianceId }
        ]
        id_gt: $cursorId
      }
      first: $limit
      orderBy: { id: ASC }
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        date
        sender_type
        sender_id
        receiver_type
        receiver_id
        note
        money
        coal
        oil
        uranium
        iron
        bauxite
        lead
        gasoline
        munitions
        steel
        aluminum
        food
        tax_id
      }
    }
  }
`;

/**
 * Fetches bankrecs *participating* with the alliance. We also locally enforce:
 *  - id > sinceId  (cursor exclusive)
 *  - tax_id > 0    (strict tax only)
 *
 * If the server ignores id_gt, we still protect with a local id filter.
 */
export async function fetchBankrecsSince(
  prisma: PrismaClient,
  allianceId: number,
  sinceId: number | null,
  pageSize = 500,
  hardCap = 5000
): Promise<Bankrec[]> {
  const token = await getAllianceApiKey(prisma, allianceId);

  let fetched: Bankrec[] = [];
  let localCursor = sinceId ?? 0;
  let safety = 0;

  while (true) {
    safety++;
    if (safety > Math.ceil(hardCap / pageSize)) break;

    const data = await gqlFetch<any>(token, BANKRECS_QUERY, {
      allianceId,
      limit: pageSize,
      cursorId: localCursor || 0,
    });

    // Accept either {bankrecs:{nodes}} or plain array—be defensive.
    const nodes: Bankrec[] =
      data?.bankrecs?.nodes ??
      data?.bankrecs ??
      [];

    // Local hard filters (id_gt + tax_id > 0)
    const batch = nodes.filter(
      (r) => r && typeof r.id === "number" && r.id > (sinceId ?? 0) && (r.tax_id ?? 0) > 0
    );

    fetched.push(...batch);

    if (!data?.bankrecs?.pageInfo?.hasNextPage) break;

    // Advance local cursor from last node we actually saw
    const last = nodes[nodes.length - 1];
    if (!last) break;
    localCursor = Math.max(localCursor, Number(last.id || 0));
    if (fetched.length >= hardCap) break;
  }

  // Ensure ascending by id just in case
  fetched.sort((a, b) => a.id - b.id);
  return fetched;
}

/**
 * Computes alliance-perspective signed deltas for a single bankrec.
 * + Positive if alliance RECEIVES on the row.
 * - Negative if alliance SENDS on the row.
 */
export function signedDeltaFor(
  allianceId: number,
  rec: Bankrec
): ResourceDelta {
  const isReceive =
    rec.receiver_type === "alliance" && Number(rec.receiver_id) === Number(allianceId);
  const isSend =
    rec.sender_type === "alliance" && Number(rec.sender_id) === Number(allianceId);

  const sign = isReceive ? 1 : isSend ? -1 : 0;

  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) {
    const raw = Number((rec as any)[k] || 0);
    out[k] = sign * raw;
  }
  return out;
}

/**
 * Utility to add two resource delta objects.
 */
export function sumDelta(a: ResourceDelta, b: ResourceDelta): ResourceDelta {
  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) {
    out[k] = Number(a[k] || 0) + Number(b[k] || 0);
  }
  return out;
}

/**
 * Create a zero-initialized delta.
 */
export function zeroDelta(): ResourceDelta {
  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) out[k] = 0;
  return out;
}
