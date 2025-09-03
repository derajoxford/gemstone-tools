import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

export async function setSetting(guildId: string, key: string, value: string) {
  await prisma.setting.upsert({
    where: { guildId_key: { guildId, key } },
    update: { value },
    create: { guildId, key, value },
  });
}

export async function getSetting(guildId: string, key: string) {
  const row = await prisma.setting.findUnique({
    where: { guildId_key: { guildId, key } },
  });
  return row?.value ?? null;
}
