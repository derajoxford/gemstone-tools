import { PrismaClient } from "@prisma/client";
import * as cryptoMod from "../src/lib/crypto.js";

const prisma = new PrismaClient();
// open expects Uint8Array/Buffer, not base64 strings
const open = (cryptoMod as any).open as (cipher: Uint8Array, nonce: Uint8Array) => string;

async function main() {
  const k = await prisma.allianceKey.findFirst({ orderBy: { id: "desc" } });
  if (!k) {
    console.error("No AllianceKey row found. Add a PnW API key via your setup command.");
    process.exit(2);
  }

  let apiKey: string;
  try {
    const cipher = k.encryptedApiKey as unknown as Uint8Array;
    const nonce  = k.nonceApi as unknown as Uint8Array;
    apiKey = open(cipher, nonce);
  } catch (e) {
    console.error("Decryption failed:", e);
    process.exit(3);
  }
  if (!apiKey) {
    console.error("Decryption returned empty apiKey.");
    process.exit(4);
  }
  console.log("Decrypted API key length:", apiKey.length);

  const url = `https://api.politicsandwar.com/graphql?api_key=${encodeURIComponent(apiKey)}`;
  const query = `
    query LatestTradeprices {
      tradeprices(first: 1, orderBy: [{column: ID, order: DESC}]) {
        data {
          date
          food coal oil uranium lead iron bauxite gasoline munitions steel aluminum credits
        }
      }
    }`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ query }),
  });

  console.log("HTTP status:", resp.status);
  const json = await resp.json().catch(() => ({} as any));
  console.log("GraphQL top keys:", Object.keys(json));

  if ((json as any).errors) {
    console.error("GraphQL errors:", JSON.stringify((json as any).errors, null, 2));
    process.exit(5);
  }

  const row = (json as any)?.data?.tradeprices?.data?.[0];
  if (!row) {
    console.error("No tradeprices row returned.");
    process.exit(6);
  }

  console.log("Tradeprice date:", row.date);
  console.log("Food price:", row.food, "Steel price:", row.steel);
}

main().catch(e => { console.error(e); process.exit(1); });
