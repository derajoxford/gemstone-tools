// src/integrations/pnw/query.ts
/**
 * Thin GraphQL client for Politics & War.
 * - Sends key via ?api_key=...
 * - Drops null/undefined variables (some resolvers 500 on nulls)
 * - Surfaces GraphQL error messages clearly
 */

type GraphQLErrorItem = { message: string; path?: (string | number)[]; extensions?: any };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLErrorItem[] };

function cleanVars(input?: Record<string, unknown>) {
  if (!input) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function pnwQuery<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query,
      variables: cleanVars(variables),
    }),
  });

  const text = await resp.text();
  let parsed: GraphQLResponse<T>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`PnW GraphQL returned non-JSON (status ${resp.status}): ${text}`);
  }

  if (!resp.ok || (parsed.errors && parsed.errors.length)) {
    const msgs = (parsed.errors || []).map(e => e.message).join(" | ");
    throw new Error(`PnW GraphQL error (status ${resp.status}): ${msgs || text}`);
  }

  if (!parsed.data) {
    throw new Error(`PnW GraphQL: empty 'data' (status ${resp.status})`);
  }

  return parsed.data;
}
