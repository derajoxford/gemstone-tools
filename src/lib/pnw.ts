import { gql } from 'graphql-request';

export type PnwKeys = { apiKey: string; botKey?: string };

// Build a GET URL with ?api_key=...&query=...
async function gqlGet<T>(apiKey: string, query: string): Promise<T> {
  const url =
    'https://api.politicsandwar.com/graphql' +
    '?api_key=' + encodeURIComponent(apiKey) +
    '&query=' + encodeURIComponent(query);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`GQL GET failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// NOTE: 'alliances' returns an AlliancePaginator => use '.data { ... }'
// We inline the alliance IDs to avoid variables on GET.
export async function fetchBankrecs(keys: PnwKeys, allianceIds: number[]) {
  const ids = allianceIds.join(',');
  const query = `
    query {
      alliances(id: [${ids}]) {
        data {
          id
          bankrecs {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
            money
            food
            coal
            oil
            uranium
            lead
            iron
            bauxite
            gasoline
            munitions
            steel
            aluminum
          }
        }
      }
    }`;
  type Resp = { alliances: { data: any[] } };
  const data = await gqlGet<Resp>(keys.apiKey, query);
  return data.alliances?.data ?? [];
}
