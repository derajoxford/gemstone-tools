// src/integrations/pnw/query.ts
import https from "node:https";

type Params = { apiKey: string; query: string; variables?: Record<string, any> };

/** Flexible call signature: pnwQuery(params) OR pnwQuery(apiKey, query, variables) */
export function pnwQuery<T>(params: Params): Promise<T>;
export function pnwQuery<T>(apiKey: string, query: string, variables?: Record<string, any>): Promise<T>;
export function pnwQuery<T>(
  a: string | Params,
  b?: string,
  c?: Record<string, any>
): Promise<T> {
  const { apiKey, query, variables } =
    typeof a === "string" ? { apiKey: a, query: b!, variables: c } : a;

  const body = JSON.stringify({ query, variables });

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.politicsandwar.com",
        path: `/graphql?api_key=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.errors?.length) {
              return reject(new Error(parsed.errors.map((e: any) => e.message).join("; ")));
            }
            resolve(parsed.data as T);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export default pnwQuery;
