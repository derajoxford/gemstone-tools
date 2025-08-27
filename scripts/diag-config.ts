import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.alliance.findMany({
    where: { guildId: { not: null } },
  });
  if (!rows.length) {
    console.log('No alliances linked (run /setup_alliance).');
    process.exit(0);
  }
  for (const a of rows) {
    const cfg = await prisma.allianceConfig.findUnique({ where: { allianceId: a.id } });
    console.log(JSON.stringify({
      allianceId: a.id,
      guildId: a.guildId,
      reviewChannelId: a.reviewChannelId,
      hasConfig: !!cfg,
      reviewerRoleId: cfg?.reviewerRoleId || null,
      autopayEnabled: cfg?.autopayEnabled ?? null,
    }, null, 2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
