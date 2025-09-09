// src/integrations/pnw/query.ts
/**
 * Minimal Politics & War GraphQL client.
 * Call: pnwQuery(apiKey, query, variables?)
 *
 * We deliberately bypass any legacy wrappers so arg order is unambiguous.
 */
const BASE = "https://api.politicsandwar.com/graphql";

export async function pnwQuery<T = any>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  if (!apiKey) {
    throw new Error("Missing PnW apiKey");
  }

  const url = `${BASE}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  // Network / HTTP error
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PnW HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }

  const json = await res.json().catch(() => ({} as any));

  // GraphQL errors
  if (json?.errors?.length) {
    const msg = json.errors.map((e: any) => e?.message || "GraphQL error").join("; ");
    throw new Error(msg);
  }

  return json?.data as T;
}
