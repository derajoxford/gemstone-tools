// src/integrations/pnw/store.ts
import { PrismaClient } from "@prisma/client";
import { encryptToString } from "../../utils/secret";

const prisma = new PrismaClient();

/**
 * Store (or update) an alliance's PnW API key, encrypted at rest.
 * Your AllianceKey schema uses:
 *   - encryptedApiKey: Bytes
 *   - nonceApi: Bytes
 *   - addedBy: String
 * There is no "provider" column and allianceId is not unique.
 */
export async function saveAlliancePnwKey(params: {
  allianceId: number;
  apiKey: string;
  actorDiscordId?: string;
}) {
  // Encrypt with AES-GCM. Our helper returns base64 of [IV(12)][TAG(16)][CIPHERTEXT].
  const packedB64 = encryptToString(params.apiKey);
  const packed = Buffer.from(packedB64, "base64");
  const iv = packed.subarray(0, 12); // store the IV separately in nonceApi

  // Find existing row by allianceId; if found, update by id
  const existing = await prisma.allianceKey.findFirst({
    where: { allianceId: params.allianceId },
  });

  if (existing) {
    const row = await prisma.allianceKey.update({
      where: { id: existing.id },
      data: {
        encryptedApiKey: packed,
        nonceApi: iv,
        // If you track updater, uncomment the next line and ensure the column exists:
        // addedBy: params.actorDiscordId ?? existing.addedBy,
      } as any,
    });
    return { id: row.id, allianceId: row.allianceId };
  }

  // Otherwise create a new row
  const row = await prisma.allianceKey.create({
    data: {
      allianceId: params.allianceId,
      encryptedApiKey: packed,
      nonceApi: iv,
      addedBy: params.actorDiscordId ?? "discord",
    } as any,
  });
  return { id: row.id, allianceId: row.allianceId };
}
