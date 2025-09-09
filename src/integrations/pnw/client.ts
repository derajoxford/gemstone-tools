// src/integrations/pnw/client.ts
// Minimal Politics & War GraphQL client over Node https.
// Auth: append ?api_key=KEY to the /graphql endpoint.

import https from "node:https";

export const PNW_GRAPHQL_HOST = process.env.PNW_GRAPHQL_HOST || "api.politicsandwar.com";
export const PNW_GRAPHQL_PATH = "/graphql";

export type PnwBankrec = {
  id: number;
  date: string;
  note: string | null;
  banker_id: number | null;

  // Directionality & targeting
  sender_id: number | null;
  sender_type: number | null;   // 1 = nation, 2 = alliance
  receiver_id: number | null;
  receiver_type: number | null; // 1 = nation, 2 = alliance

  tax_id: number | null; // present when record is from taxation

  // Resources
  money: number;
  food: number;
  munitions: number;
  gasoline: number;
  aluminum: number;
  steel: number;
  coal: number;
  oil: number;
  uranium: number;
  iron: number;
  bauxite: number;
  lead: number;
};

type GraphQLResponse<T> = { data?: T; errors?: { message: string }[] };

function postGraphQL<T>(apiKey: string, body: { query: string; variables?: any }): Promise<T> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      host: PNW_GRAPHQL_HOST,
      path: `${PNW_GRAPHQL_PATH}?api_key=${encodeURIComponent(apiKey)}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as GraphQLResponse<T>;
          if (parsed.errors?.length) {
            return reject(new Error(parsed.errors.map((e) => e.message).join("; ")));
          }
          if (!parsed.data) return reject(new Error("Empty GraphQL response"));
          resolve(parsed.data);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Fetch alliance bank records.
 * PnW returns a paginator; we extract `.data[0].bankrecs` and sort ascending by id
 * so callers can cursor by last seen id.
 */
export async function fetchAllianceBankrecs(apiKey: string, allianceId: number): Promise<PnwBankrec[]> {
  const query = `
    query GetAllianceBankrecs($ids: [Int!]) {
      alliances(id: $ids) {
        data {
          id
          bankrecs {
            id
            date
            note
            banker_id
            sender_id
            sender_type
            receiver_id
            receiver_type
            tax_id
            money
            food
            munitions
            gasoline
            aluminum
            steel
            coal
            oil
            uranium
            iron
            bauxite
            lead
          }
        }
      }
    }
  `;

  type Q = { alliances: { data: { id: number; bankrecs: PnwBankrec[] }[] } };
  const data = await postGraphQL<Q>(apiKey, { query, variables: { ids: [allianceId] } });

  const alliance = data.alliances?.data?.[0];
  if (!alliance) return [];
  return [...(alliance.bankrecs || [])].sort((a, b) => a.id - b.id);
}
