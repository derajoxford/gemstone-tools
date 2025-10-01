import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Returns the numeric allianceId for a Discord guild, or null if none linked. */
export async function resolveAllianceIdFromGuild(guildId: string): Promise<number | null> {
  const row = await prisma.allianceGuild.findUnique({ where: { guildId } });
  return row?.allianceId ?? null;
}

/** Bind this Discord guild to a specific allianceId. Replaces any prior binding. */
export async function linkGuildToAlliance(guildId: string, allianceId: number) {
  // If someone tries to bind a guild already used, upsert will replace it.
  return prisma.allianceGuild.upsert({
    where: { guildId },
    update: { allianceId },
    create: { guildId, allianceId },
  });
}

/** Remove binding for this Discord guild. */
export async function unlinkGuild(guildId: string) {
  await prisma.allianceGuild.delete({ where: { guildId } }).catch(() => {});
}
