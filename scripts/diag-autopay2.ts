import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const receiver = Number(process.argv[2]);
  if (!Number.isFinite(receiver)) {
    console.error('Usage: npx tsx scripts/diag-autopay2.ts <RECEIVER_NATION_ID>');
    process.exit(1);
  }

  const a = await prisma.alliance.findFirst({ include: { keys: { orderBy: { id: 'desc' }, take: 1 } } });
  if (!a || !a.keys[0]) throw new Error('No alliance + API key saved. Run /setup_alliance and save the banker nation API key.');
  const { open } = await import('../src/lib/crypto.js');
  const apiKey = open(a.keys[0].encryptedApiKey as any, a.keys[0].nonceApi as any) as string;
  const botKey = process.env.PNW_BOT_KEY || '';
  const url = 'https://api.politicsandwar.com/graphql?api_key=' + encodeURIComponent(apiKey);

  console.log('Has API key:', !!apiKey, 'Has Bot key:', !!botKey);

  async function call(label: string, query: string) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // P&W docs say both headers are required for mutations:
        // X-Api-Key = acting nation’s API key, X-Bot-Key = your verified bot key.
        'X-Api-Key': apiKey,
        'X-Bot-Key': botKey
      },
      body: JSON.stringify({ query })
    });
    const text = await r.text();
    console.log(`\n=== ${label} HTTP ${r.status} ===\n${text}\n`);
  }

  // Introspect mutation signature so we can see exact arg names/types
  const introspect = `query{
    __schema { mutationType { name fields { name args { name type { kind name ofType { kind name } } } } } }
  }`;
  await call('Introspection(Mutation fields)', introspect);

  // Try likely shapes
  const qA = `mutation { bankWithdraw(receiver:${receiver}, money:1) }`;
  const qB = `mutation { bankWithdraw(receiver:${receiver}, resources:{ money:1 }) }`;
  await call('Attempt A (args inline)', qA);
  await call('Attempt B (resources input)', qB);
}

main().catch(e => { console.error(e); process.exit(1); });
