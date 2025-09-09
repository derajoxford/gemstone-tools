// src/integrations/pnw/query.ts
// A resilient wrapper that finds a callable in ./client by several names
// and falls back to the first exported function if needed.
import * as client from "./client";

function resolvePnW(): (apiKey: string, query: string, variables?: any) => Promise<any> {
  const candidates = [
    (client as any).pnwQuery,
    (client as any).default,
    (client as any).query,
    (client as any).request,
    (client as any).graphql,
    (client as any).graphQL,
    (client as any).gql,
  ].filter(Boolean);

  // If none of the common names exist, try the first exported function
  if (!candidates.length) {
    for (const v of Object.values(client)) {
      if (typeof v === "function") {
        candidates.push(v);
        break;
      }
    }
  }

  const fn = candidates.find((f) => typeof f === "function");
  if (!fn) {
    throw new Error("PnW client export not found (looking for pnwQuery/default/etc).");
  }
  return fn as any;
}

export async function pnwQuery(apiKey: string, query: string, variables?: any) {
  const fn = resolvePnW();
  return fn(apiKey, query, variables);
}
