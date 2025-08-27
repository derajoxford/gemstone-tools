import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seal } from '../src/lib/crypto.js';

const prisma = new PrismaClient();
const AID = parseInt(process.env.AID || '', 10);
const APIKEY = process.env.APIKEY || '';

if (!AID || !APIKEY) {
  console.error('Missing AID or APIKEY envs.');
  process.exit(1);
}

(async () => {
  const { ciphertext, iv } = seal(APIKEY);
  await prisma.alliance.upsert({
    where: { id: AID },
    update: {},
    create: { id: AID }
  });
  await prisma.allianceKey.create({
    data: {
      allianceId: AID,
      encryptedApiKey: ciphertext,
      nonceApi: iv,
      addedBy: 'cli'
    }
  });
  console.log(`✅ Saved API key for alliance ${AID}.`);
})();
