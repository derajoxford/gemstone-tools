import { PrismaClient } from "@prisma/client";
import { fetchBankrecs } from "../src/lib/pnw.ts";
import * as cryptoMod from "../src/lib/crypto.js";

const open = (cryptoMod as any).open as (cipher: string, nonce: string) => string;
const prisma = new PrismaClient();

async function main() {
  const AID = 14258;

  const k = await prisma.allianceKey.findFirst({
    where: { allianceId: AID },
    orderBy: { id: "desc" },
  });

  if (!k) {
    console.error(`No AllianceKey found for alliance ${AID}. Use your Discord key command to add one.`);
    process.exit(1);
  }

  const apiKey = open(k.encryptedApiKey, k.nonce);
  if (!apiKey) {
    console.error("Failed to decrypt API key.");
    process.exit(1);
  }

  const out = await fetchBankrecs({ apiKey }, [AID]);
  const rows = (out.find(x => Number((x as any)?.id ?? (x as any)?.alliance_id) === AID)?.bankrecs) || [];

  console.log("count=", rows.length);
  if (rows[0]) {
    console.log("keys=", Object.keys(rows[0]));
    console.log("sample=", rows[0]);
  } else {
    console.log("no rows");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
