import 'dotenv/config';
import readline from 'node:readline';
import { GraphQLClient, gql } from 'graphql-request';
import { PrismaClient } from '@prisma/client';
import { seal } from '../src/lib/crypto.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q:string, hidden=false)=> new Promise<string>(res=>{
  if (!hidden) rl.question(q, a=>res(a));
  else {
    // hide input
    // @ts-ignore
    const onData = (char:Buffer)=>{ const ch = char+"";
      if (["\n","\r","\u0004"].includes(ch)) { process.stdout.write("\n"); process.stdin.removeListener('data', onData); }
      else process.stdout.write("*");
    };
    process.stdin.on('data', onData);
    rl.question(q, a=>{ process.stdin.removeListener('data', onData); res(a); });
  }
});

(async () => {
  const raw = (await ask("Paste a NATION API key (hidden): ", true)).trim();
  const key = raw.replace(/\s+/g,''); // strip whitespace
  console.log(`Key length: ${key.length} (should be nonzero)`);
  if (!key) { console.error("No key entered."); process.exit(1); }

  const client = new GraphQLClient('https://api.politicsandwar.com/graphql', {
    headers: { 'X-Api-Key': key },
    timeout: 20000,
  });
  const Q = gql`query { alliances(id:[14258]) { id name } }`; // harmless probe

  try {
    const data = await client.request(Q);
    console.log("✅ POST+Header auth works. Sample:", JSON.stringify(data));
  } catch (e:any) {
    const status = e?.response?.status || e?.code || e?.message;
    console.error("❌ Header auth failed:", status, e?.response?.errors ?? '');
    console.log("Trying GET with ?api_key=... to double-check…");
    try {
      const url = 'https://api.politicsandwar.com/graphql?api_key='+encodeURIComponent(key)+'&query='+encodeURIComponent('query{alliances(id:[14258]){id name}}');
      const res = await fetch(url, { method:'GET' });
      const txt = await res.text();
      console.log("GET status:", res.status, "body:", txt.slice(0,200));
      if (res.status !== 200) throw new Error("GET failed "+res.status);
      console.log("⚠️ Your key might be scoped/invalid for header POST, check DO/Cloudflare differences.");
    } catch (e2:any) {
      console.error("❌ GET check also failed.", e2?.message || e2);
      console.log("\nHints:\n- Make sure this is the **nation API key** from Account → API Key (NOT the bot/mutations key).\n- Regenerate and copy EXACTLY (no spaces/newlines).\n- The nation must be in your alliance for bank access.\n");
      process.exit(2);
    }
  }

  // Optionally save to DB for your alliance
  const save = (await ask("Save this API key for an alliance now? (y/N): ")).trim().toLowerCase()==='y';
  if (!save) { rl.close(); return; }
  const aidStr = await ask("Alliance ID (number): ");
  const allianceId = parseInt(aidStr, 10);
  if (!allianceId) { console.error("Invalid alliance id"); process.exit(3); }

  const prisma = new PrismaClient();
  const { ciphertext, iv } = seal(key);
  await prisma.alliance.upsert({ where:{ id: allianceId }, update:{}, create:{ id: allianceId } });
  await prisma.allianceKey.create({
    data: { allianceId, encryptedApiKey: ciphertext, nonceApi: iv, addedBy: 'cli' }
  });
  console.log(`✅ Saved key for alliance ${allianceId}.`);
  rl.close();
})();
