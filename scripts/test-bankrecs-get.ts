import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { open } from '../src/lib/crypto.js';

const prisma = new PrismaClient();

async function main() {
  const a = await prisma.alliance.findFirst({
    include: { keys: { orderBy: { id: 'desc' }, take: 1 } }
  });
  if (!a || !a.keys[0]) {
    console.error('No alliance or keys saved. Run /setup_alliance first.');
    process.exit(1);
  }
  const apiKey = open(a.keys[0].encryptedApiKey as any, a.keys[0].nonceApi as any);
  const aid = a.id;

  const query = `
    query {
      alliances(id:[${aid}]) {
        data {
          id
          name
          bankrecs {
            id
            date
            note
            sender_type
            sender_id
            receiver_type
            receiver_id
            money
            steel
            aluminum
          }
        }
      }
    }`;

  const url = 'https://api.politicsandwar.com/graphql'
    + '?api_key=' + encodeURIComponent(apiKey)
    + '&query=' + encodeURIComponent(query);

  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) {
    console.error('HTTP', res.status, text.slice(0,200));
    process.exit(2);
  }
  const json = JSON.parse(text);
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors));
    process.exit(3);
  }
  console.log('✅ OK. Sample:', JSON.stringify(json.data?.alliances?.data?.[0]?.bankrecs?.slice(0,2) ?? []));
  const rows = json.data?.alliances?.data?.[0]?.bankrecs ?? null;
  if (rows === null) {
    console.error('bankrecs is NULL (nation for this key likely lacks View Bank permission).');
    process.exit(4);
  }
  if (!rows.length) {
    console.error('bankrecs returned 0 rows (~no activity in ~14 days or perms).');
    process.exit(5);
  }
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(9); });
