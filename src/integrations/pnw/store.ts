// src/integrations/pnw/store.ts
import { PrismaClient } from "@prisma/client";
import { encryptToString } from "../../utils/secret";

const prisma = new PrismaClient();

/**
 * Save (or update) an alliance's PnW API key, encrypted at rest.
 * Assumes a composite unique on (allianceId, provider) named `allianceId_provider`.
 * If your schema uses a different unique name, we’ll adjust the `where` in Step 2.
 */
export async function saveAlliancePnwKey(params: {
  allianceId: number;
  apiKey: string;
  actorDiscordId?: string;
}) {
  const provider = "pnw";
  const encrypted = encryptToString(params.apiKey);

  const row = await prisma.allianceKey.upsert({
    // If this throws about an unknown unique, tell me the error and we’ll tweak this shape.
    where: { allianceId_provider: { allianceId: params.allianceId, provider } } as any,
    create: {
      allianceId: params.allianceId,
      provider,
      key: encrypted,
      // createdByDiscordId: params.actorDiscordId ?? null, // uncomment if you have these columns
    } as any,
    update: {
      key: encrypted,
      // updatedByDiscordId: params.actorDiscordId ?? null,
    } as any,
  });

  return { id: row.id, allianceId: row.allianceId, provider: row.provider };
}
