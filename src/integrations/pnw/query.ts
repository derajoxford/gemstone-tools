// src/integrations/pnw/query.ts
import https from "https";

type GqlResp = { data?: any; errors?: Array<{ message?: string }> };

export async function pnwQuery(
  apiKey: string,
  query: string,
  variables?: Record<string, any>
): Promise<any> {
  if (!apiKey) throw new Error("PnW API key missing");

  const body = JSON.stringify({ query, variables: variables ?? {} });
  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;

  const respText: string = await new Promise((resolve, reject) => {
    const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  let parsed: GqlResp;
  try {
    parsed = JSON.parse(respText);
  } catch {
    throw new Error(`PnW GraphQL parse error: ${respText.slice(0, 300)}`);
  }

  if (parsed.errors?.length) {
    const msg = parsed.errors.map(e => e.message || "unknown").join(" | ");
    throw new Error(`PnW GraphQL error (status 200): ${msg}`);
  }
  return parsed.data;
}
