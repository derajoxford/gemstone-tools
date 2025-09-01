import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const guildId = process.env.TEST_GUILD_ID || '';

if (!guildId) {
  console.error('ERROR: TEST_GUILD_ID missing in .env');
  process.exit(1);
}

try {
  const alliance = await prisma.alliance.findFirst({ where: { guildId } });
  if (!alliance) {
    console.error('NO_ALLIANCE_FOR_GUILD', guildId);
    process.exit(2);
  }

  const cfg = await prisma.allianceConfig.upsert({
    where:  { allianceId: alliance.id },
    update: { autopayEnabled: true },
    create: { allianceId: alliance.id, autopayEnabled: true },
  });

  console.log('OK autopayEnabled=true for alliance', alliance.id, 'guild', guildId);
} catch (err) {
  console.error('SCRIPT_ERR', err);
  process.exit(3);
} finally {
  await prisma.$disconnect();
}
