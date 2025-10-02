// src/lib/offshore.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_KEY = 'default_offshore_aid';

/** Resolve the alliance linked to a Discord guild (via /setup_alliance). */
export async function getAllianceForGuild(guildId: string) {
  if (!guildId) return null;
  return prisma.alliance.findFirst({ where: { guildId } });
}

/** Get the global default offshore (from Setting key=default_offshore_aid). */
export async function getDefaultOffshore(): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: DEFAULT_KEY } });
  const aid = Number((row?.value as any)?.aid ?? (row?.value as any));
  return Number.isFinite(aid) && aid > 0 ? aid : null;
}

/** Set or clear the global default offshore. Pass null/0 to clear. */
export async function setDefaultOffshore(aid: number | null, actorId: string) {
  if (aid && aid > 0) {
    await prisma.setting.upsert({
      where: { key: DEFAULT_KEY },
      update: { value: { aid } },
      create: { key: DEFAULT_KEY, value: { aid } },
    });
  } else {
    // clear
    await prisma.setting.upsert({
      where: { key: DEFAULT_KEY },
      update: { value: {} },
      create: { key: DEFAULT_KEY, value: {} },
    });
  }
  await prisma.offshoreTransfer.create({
    data: {
      sourceAid: 0,
      targetAid: aid ?? 0,
      payload: {},
      note: 'setDefaultOffshore',
      actorId,
      result: 'OK',
    },
  }).catch(() => {});
}

/** Set a per-alliance override offshore AID (or clear if null/0). */
export async function setAllianceOffshoreOverride(sourceAllianceId: number, offshoreAid: number | null) {
  await prisma.alliance.update({
    where: { id: sourceAllianceId },
    data: {
      offshoreOverrideAllianceId: offshoreAid && offshoreAid > 0 ? offshoreAid : null,
    },
  });
}

/** Compute the effective offshore for an alliance: override ?? default ?? null */
export async function getEffectiveOffshore(allianceId: number): Promise<number | null> {
  const a = await prisma.alliance.findUnique({
    where: { id: allianceId },
    select: { offshoreOverrideAllianceId: true },
  });
  if (a?.offshoreOverrideAllianceId) return a.offshoreOverrideAllianceId;

  const def = await getDefaultOffshore();
  return def ?? null;
}

/** Record an audit row for offshore send / config ops (best-effort). */
export async function auditOffshore(opts: {
  sourceAid: number;
  targetAid: number;
  payload: Record<string, number>;
  actorId: string;
  note?: string;
  result: string;
}) {
  try {
    await prisma.offshoreTransfer.create({
      data: {
        sourceAid: opts.sourceAid,
        targetAid: opts.targetAid,
        payload: opts.payload ?? {},
        note: opts.note ?? null,
        actorId: opts.actorId,
        result: String(opts.result),
      },
    });
  } catch {
    // non-fatal
  }
}
