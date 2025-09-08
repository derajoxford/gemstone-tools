// src/integrations/pnw/store.ts
import { PrismaClient } from "@prisma/client";
import { encryptToString, decryptFromString } from "../../utils/secret";

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
  const iv = packed.subarray(0, 12); // store the IV separately in nonceApi (optional)

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
        // addedBy: params.actorDiscordId ?? existing.addedBy, // uncomment if desired and column exists
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

/**
 * Retrieve and decrypt the alliance's PnW API key.
 * Returns null if not found.
 */
export async function getAlliancePnwKey(allianceId: number): Promise<string | null> {
  const row = await prisma.allianceKey.findFirst({ where: { allianceId } });
  if (!row?.encryptedApiKey) return null;
  // We stored raw bytes; convert back to base64 for the decrypt helper.
  const packedB64 = Buffer.from(row.encryptedApiKey as any).toString("base64");
  return decryptFromString(packedB64);
}
