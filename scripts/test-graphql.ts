import { GraphQLClient, gql } from 'graphql-request';

const key = process.env.APIKEY || '';
if (!key) { console.error('Missing APIKEY env'); process.exit(1); }

const client = new GraphQLClient('https://api.politicsandwar.com/graphql', {
  headers: { 'X-Api-Key': key },
  timeout: 20000,
});

const Q = gql`query { alliances(id:[14258]) { id name } }`;

(async () => {
  try {
    const data = await client.request(Q);
    console.log('✅ Valid key. Sample data:', JSON.stringify(data));
  } catch (e:any) {
    console.error('❌ GraphQL error:', e.response?.status || e.message, e.response?.errors || '');
    process.exit(2);
  }
})();
