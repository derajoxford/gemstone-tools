import { GraphQLClient, gql } from 'graphql-request';

export type PnwKeys = { apiKey: string; botKey?: string };

export function pnwClient(keys: PnwKeys) {
  const client = new GraphQLClient('https://api.politicsandwar.com/graphql', {
    headers: {
      'X-Api-Key': keys.apiKey,
      ...(keys.botKey ? { 'X-Bot-Key': keys.botKey } : {})
    },
    timeout: 30000
  });
  return client;
}

export const BANKRECS_QUERY = gql`
  query AllianceBankrecs($ids: [Int!]) {
    alliances(id: $ids) {
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
        tax_id
      }
    }
  }
`;

export async function fetchBankrecs(keys: PnwKeys, allianceIds: number[]) {
  const client = pnwClient(keys);
  const data = await client.request(BANKRECS_QUERY, { ids: allianceIds });
  return (data as any).alliances ?? [];
}
