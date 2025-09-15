// src/lib/pnw.ts
import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "./crypto.js"; // correct relative path in src/lib
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
  "money","coal","oil","uranium","iron","bauxite","lead","gasoline","munitions","steel","aluminum","food",
] as const;
export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Record<ResourceKey, number>;

const PNW_GQL_ENDPOINT = "https://api.politicsandwar.com/graphql";

/** 15s fetch timeout helper */
function withTimeout(signal: AbortSignal | undefined, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(new Error("Upstream aborted"));
  signal?.addEventListener("abort", onAbort);
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function getAllianceApiKey(prisma: PrismaClient, allianceId: number): Promise<string> {
  const k = await prisma.allianceKey.findFirst({ where: { allianceId }, orderBy: { id: "desc" } });
  if (!k) throw new Error(`No saved API key for alliance ${allianceId}`);
  const token = open(k.encryptedApiKey, k.nonce);
  if (!token) throw new Error("Failed to decrypt alliance API key");
  return token;
}

export async function gqlFetch<T = any>(
  token: string,
  query: string,
  variables: Record<string, any>,
  opts?: { timeoutMs?: number }
): Promise<T> {
  const { signal, done } = withTimeout(undefined, opts?.timeoutMs ?? 15000);
  try {
    const res = await fetch(PNW_GQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PnW GraphQL HTTP ${res.status} ${res.statusText}: ${text?.slice(0, 500)}`);
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`PnW GraphQL returned non-JSON body: ${text?.slice(0, 240)}`);
    }
    if (json.errors?.length) {
      const msgs = json.errors.map((e: any) => e?.message ?? "Unknown error").join("; ");
      throw new Error(`PnW GraphQL error(s): ${msgs}`);
    }
    return json.data as T;
  } finally {
    done();
  }
}

const BANKRECS_QUERY = /* GraphQL */ `
  query BankrecsSince($allianceId: Int!, $limit: Int!, $cursorId: Int) {
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
      pageInfo { hasNextPage endCursor }
      nodes {
        id date sender_type sender_id receiver_type receiver_id note
        money coal oil uranium iron bauxite lead gasoline munitions steel aluminum food
        tax_id
      }
    }
  }
`;

/**
 * Fetch bankrecs that involve the alliance, then locally enforce:
 *  - id > sinceId
 *  - tax_id > 0   (strict tax-only)
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
    safety++; if (safety > Math.ceil(hardCap / pageSize)) break;

    const data = await gqlFetch<any>(token, BANKRECS_QUERY, { allianceId, limit: pageSize, cursorId: localCursor || 0 }, { timeoutMs: 15000 });
    const nodes: Bankrec[] = data?.bankrecs?.nodes ?? data?.bankrecs ?? [];

    const batch = nodes.filter((r) => r && typeof r.id === "number" && r.id > (sinceId ?? 0) && (r.tax_id ?? 0) > 0);
    fetched.push(...batch);

    if (!data?.bankrecs?.pageInfo?.hasNextPage) break;
    const last = nodes[nodes.length - 1]; if (!last) break;
    localCursor = Math.max(localCursor, Number(last.id || 0));
    if (fetched.length >= hardCap) break;
  }

  fetched.sort((a, b) => a.id - b.id);
  return fetched;
}

export function signedDeltaFor(allianceId: number, rec: Bankrec): ResourceDelta {
  const isReceive = rec.receiver_type === "alliance" && Number(rec.receiver_id) === Number(allianceId);
  const isSend    = rec.sender_type   === "alliance" && Number(rec.sender_id)   === Number(allianceId);
  const sign = isReceive ? 1 : isSend ? -1 : 0;
  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) out[k] = sign * Number((rec as any)[k] || 0);
  return out;
}

export function sumDelta(a: ResourceDelta, b: ResourceDelta): ResourceDelta {
  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) out[k] = Number(a[k] || 0) + Number(b[k] || 0);
  return out;
}
export function zeroDelta(): ResourceDelta {
  const out = {} as ResourceDelta;
  for (const k of RESOURCE_KEYS) out[k] = 0;
  return out;
}

/* ---------- Back-compat named exports (aliases expected elsewhere) ---------- */
export const fetchAllianceBankrecsViaGQL = fetchBankrecsSince; // used by pnw_tax_ids.ts
export const fetchBankrecs = fetchBankrecsSince;               // used by index.ts
