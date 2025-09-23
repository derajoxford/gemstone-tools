import { PrismaClient } from "@prisma/client";
import fetch from "node-fetch";
import * as cryptoMod from "../src/lib/crypto.js";

const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;

const prisma = new PrismaClient();
const k = await prisma.allianceKey.findFirst({ where: { allianceId: 14258 }, orderBy: { id: "desc" } });
if (!k) { console.error("No key saved for alliance 14258"); process.exit(1); }

const api = open(k.encryptedApiKey, k.nonceApi);
const body = { query: '{ __type(name:"Bankrec"){ name fields { name } } }' };

const res = await fetch(`https://api.politicsandwar.com/graphql?api_key=${api}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log(await res.text());
