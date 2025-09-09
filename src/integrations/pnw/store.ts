// src/integrations/pnw/store.ts
import { PrismaClient } from "@prisma/client";
import { encryptToString, decryptFromString } from "../../utils/secret";

const prisma = new PrismaClient();

/**
 * Internal: get the latest AllianceKey row for an alliance (since allianceId is not unique).
 */
async function getLatestAllianceKeyRow(allianceId: number) {
  return prisma.allianceKey.findFirst({
    where: { allianceId },
    orderBy: { createdAt: "desc" as const },
  });
}

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
  // Encrypt with AES-GCM. Helper returns base64 of [IV(12)][TAG(16)][CIPHERTEXT]
  const packedB64 = encryptToString(params.apiKey);
  const packed = Buffer.from(packedB64, "base64");
  const iv = packed.subarray(0, 12); // store IV in nonceApi (optional)

  // Update latest row if exists, else create a new one
  const existing = await getLatestAllianceKeyRow(params.allianceId);

  if (existing) {
    const row = await prisma.allianceKey.update({
      where: { id: existing.id },
      data: {
        encryptedApiKey: packed,
        nonceApi: iv,
        // addedBy: params.actorDiscordId ?? existing.addedBy, // keep existing unless you want to override
      } as any,
    });
    return { id: row.id, allianceId: row.allianceId };
  }

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
 * Returns null if not found or undecryptable.
 */
export async function getAlliancePnwKey(allianceId: number): Promise<string | null> {
  const row = await getLatestAllianceKeyRow(allianceId);
  if (!row?.encryptedApiKey) return null;

  // We stored raw bytes; convert back to base64 for the decrypt helper.
  const packedB64 = Buffer.from(row.encryptedApiKey as any).toString("base64");
  try {
    const plaintext = decryptFromString(packedB64);
    return (plaintext ?? "").trim() || null;
  } catch {
    // Likely GT_SECRET changed since save time.
    return null;
  }
}

/**
 * Strict read accessor for the stored PnW key.
 * Throws if missing or cannot be decrypted, so reads never fall back to env keys.
 */
export async function getAllianceReadKey(allianceId: number): Promise<string> {
  const key = await getAlliancePnwKey(allianceId);
  if (!key) {
    // Provide a clear operator message for the two common causes.
    throw new Error(
      "No valid stored PnW user API key for this alliance. " +
        "Run /pnw_set again (and ensure GT_SECRET/ENCRYPTION_KEY matches the one used when saving)."
    );
  }
  return key;
}
