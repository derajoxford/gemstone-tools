import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const argNation = Number(process.argv[2]);
  if (!Number.isFinite(argNation)) {
    console.error('Usage: npx tsx scripts/diag-autopay.ts <RECEIVER_NATION_ID>');
    process.exit(1);
  }

  // Get latest alliance API key from DB
  const a = await prisma.alliance.findFirst({
    include: { keys: { orderBy: { id: 'desc' }, take: 1 } }
  });
  if (!a || !a.keys[0]) throw new Error('No alliance + API key saved. Run /setup_alliance and save a nation API key.');
  const { open } = await import('../src/lib/crypto.js');
  const apiKey = open(a.keys[0].encryptedApiKey as any, a.keys[0].nonceApi as any) as string;
  const botKey = process.env.PNW_BOT_KEY || '';

  console.log('Has API key:', apiKey ? 'yes' : 'no', ' Has Bot key:', botKey ? 'yes' : 'no');

  // Introspect the mutation signature (helps verify arg names)
  const introspect = await fetch('https://api.politicsandwar.com/graphql?api_key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `query{
      __type(name:"Mutation"){ fields{name args{name type{name kind ofType{name kind}}} } }
    }` })
  });
  const introspectJson = await introspect.json().catch(()=> ({}));
  const bw = introspectJson?.data?.__type?.fields?.find((f:any)=>f.name==='bankWithdraw');
  console.log('bankWithdraw field:', JSON.stringify(bw, null, 2).slice(0, 900) + '...');

  // Try mutation SHAPE A: bankWithdraw(receiver:..., money:..., steel:...)
  const qA = `mutation {
    bankWithdraw(receiver:${argNation}, money:1)
  }`;

  // Try mutation SHAPE B: bankWithdraw(receiver:...){ money:..., steel:... }
  const qB = `mutation {
    bankWithdraw(receiver:${argNation}){ money:1 }
  }`;

  for (const [label, query] of [['A', qA], ['B', qB]] as const) {
    const r = await fetch('https://api.politicsandwar.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Bot-Key': botKey
      },
      body: JSON.stringify({ query })
    });

    const text = await r.text();
    console.log(`\n=== Attempt ${label} HTTP ${r.status} ===\n${text}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
