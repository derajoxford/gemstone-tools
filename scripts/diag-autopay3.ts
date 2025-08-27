import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const receiver = Number(process.argv[2]);
  if (!Number.isFinite(receiver)) {
    console.error('Usage: npx tsx scripts/diag-autopay3.ts <RECEIVER_NATION_ID>');
    process.exit(1);
  }
  const a = await prisma.alliance.findFirst({
    include: { keys: { orderBy: { id: 'desc' }, take: 1 } }
  });
  if (!a || !a.keys[0]) throw new Error('No alliance + API key saved. Run /setup_alliance with a banker nation API key.');

  const { open } = await import('../src/lib/crypto.js');
  const apiKey = open(a.keys[0].encryptedApiKey as any, a.keys[0].nonceApi as any) as string;
  const botKey = process.env.PNW_BOT_KEY || '';
  const url = 'https://api.politicsandwar.com/graphql?api_key=' + encodeURIComponent(apiKey);

  console.log('Has API key:', !!apiKey, 'Has Bot key:', !!botKey);

  const query = `mutation {
    bankWithdraw(receiver:${receiver}, receiver_type:1, money:1, note:"Gemstone diag")
    { id }
  }`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Bot-Key': botKey
    },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  console.log('HTTP', res.status, '→', text);
}

main().catch(e => { console.error(e); process.exit(1); });
