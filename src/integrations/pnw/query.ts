// src/integrations/pnw/query.ts
import https from "node:https";

type GqlResult = { data?: any; errors?: Array<{ message?: string }>; };

function postJson<T = any>(url: string, body: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = JSON.parse(text);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`PnW GraphQL non-JSON response (status ${res.statusCode}): ${text}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Low-level GraphQL POST. Throws on GraphQL `errors`. */
export async function pnwQuery(apiKey: string, query: string, variables: any): Promise<any> {
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const json = (await postJson<GqlResult>(url, { query, variables })) as GqlResult;
  if (json?.errors?.length) {
    const msg = json.errors.map(e => e?.message || "GraphQL error").join(" | ");
    throw new Error(`PnW GraphQL error (status 200): ${msg}`);
  }
  return json?.data;
}

/**
 * Fetch recent bank records for a single alliance.
 * Tries the Paginator shape first, then falls back to the legacy non-paginator.
 * We intentionally do NOT use any date/after arguments (schemas vary). We just
 * `limit` and filter by id in application code.
 */
export async function fetchAllianceBankrecs(
  apiKey: string,
  allianceId: number,
  limit: number
): Promise<any[]> {
  // Variant A: AlliancePaginator (alliances(id: [Int], first) { data { ... } })
  const qA = `
    query A($ids: [Int!]!, $limit: Int!) {
      alliances(id: $ids, first: 1) {
        data {
          id
          bankrecs(limit: $limit) {
            id
            date
            note
            stype
            rtype
            tax_id
            money
            food
            munitions
            gasoline
            steel
            aluminum
            oil
            uranium
            bauxite
            coal
            iron
            lead
          }
        }
      }
    }
  ` as const;

  try {
    const dA: any = await pnwQuery(apiKey, qA, { ids: [allianceId], limit });
    const recsA: any[] = dA?.alliances?.data?.[0]?.bankrecs ?? [];
    return recsA;
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // If the server doesn't understand the paginator shape, try legacy.
    // (e.g., "Unknown argument 'first' on field 'alliances'" or "Cannot query field 'data' on type 'Alliance'")
    const fallback = /Unknown argument .*first|Cannot query field .*data|Variable "\$ids".*Int.*position expecting type "Int"!/i.test(
      msg,
    );
    if (!fallback) throw err;
  }

  // Variant B: Non-paginator (alliances(id: Int) { ... })
  const qB = `
    query B($id: Int!, $limit: Int!) {
      alliances(id: $id) {
        id
        bankrecs(limit: $limit) {
          id
          date
          note
          stype
          rtype
          tax_id
          money
          food
          munitions
          gasoline
          steel
          aluminum
          oil
          uranium
          bauxite
          coal
          iron
          lead
        }
      }
    }
  ` as const;

  const dB: any = await pnwQuery(apiKey, qB, { id: allianceId, limit });
  const recsB: any[] = dB?.alliances?.[0]?.bankrecs ?? [];
  return recsB;
}
