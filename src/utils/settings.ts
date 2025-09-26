import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

/** Get a guild-scoped string setting (value) by key, or null. */
export async function getGuildSetting(guildId: string, key: string): Promise<string | null> {
  const s = await prisma.setting.findFirst({ where: { guildId, key }, orderBy: { id: "desc" } });
  return s?.value ?? null;
}

/** Upsert a guild-scoped string setting (value) by key. */
export async function setGuildSetting(guildId: string, key: string, value: string) {
  await prisma.setting.create({ data: { guildId, key, value } });
}
