import 'dotenv/config';
import readline from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { seal, open } from '../src/lib/crypto.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q:string, hidden=false)=> new Promise<string>(res=>{
  if (!hidden) rl.question(q, a=>res(a));
  else {
    const onData = (char:Buffer)=>{
      const ch = char.toString();
      if (["\n","\r","\u0004"].includes(ch)) { process.stdout.write("\n"); process.stdin.off('data', onData); }
      else process.stdout.write("*");
    };
    process.stdin.on('data', onData);
    rl.question(q, a=>{ process.stdin.off('data', onData); res(a); });
  }
});

(async () => {
  const prisma = new PrismaClient();
  const aidStr = await ask("Alliance ID: ");
  const allianceId = parseInt(aidStr.trim(), 10);
  if (!allianceId) { console.error("Invalid Alliance ID"); process.exit(1); }

  const raw = (await ask("Paste a NATION API key (hidden): ", true)).trim();
  const key = raw.replace(/\s+/g,'');
  console.log(`Key length detected: ${key.length}`);
  if (!key) { console.error("No key entered."); process.exit(1); }

  // wipe old keys for this alliance, save new (encrypted)
  await prisma.alliance.upsert({ where: { id: allianceId }, update: {}, create: { id: allianceId } });
  await prisma.allianceKey.deleteMany({ where: { allianceId } });
  const sealed = seal(key);
  await prisma.allianceKey.create({
    data: { allianceId, encryptedApiKey: sealed.ciphertext, nonceApi: sealed.iv, addedBy: 'cli' }
  });
  console.log(`✅ Saved new API key for alliance ${allianceId}. Testing…`);

  // Build GET with ?api_key and correct paginator shape
  const query = `
    query {
      alliances(id:[${allianceId}]) {
        data { id name bankrecs { id } }
      }
    }`;
  const url = 'https://api.politicsandwar.com/graphql'
    + '?api_key=' + encodeURIComponent(key)
    + '&query=' + encodeURIComponent(query);

  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) {
    console.error("HTTP", res.status, text.slice(0,200));
    process.exit(2);
  }
  const json = JSON.parse(text);
  if (json.errors) {
    console.error("GraphQL errors:", JSON.stringify(json.errors));
    process.exit(3);
  }
  const ok = json.data?.alliances?.data?.[0]?.id;
  if (ok) {
    console.log("✅ GraphQL GET ok. Alliance:", ok);
  } else {
    console.error("Unexpected response:", text.slice(0,200));
    process.exit(4);
  }
  rl.close();
})();
