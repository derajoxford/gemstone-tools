// src/utils/treasury.ts
import type { PrismaClient } from '@prisma/client';

export const RESOURCES = [
  'money','coal','oil','uranium','iron','bauxite','lead',
  'gasoline','munitions','steel','aluminum','food'
] as const;

type Bag = Record<string, number>;

function cleanDelta(delta: Record<string, number>): Bag {
  const out: Bag = {};
  for (const [k, raw] of Object.entries(delta || {})) {
    const v = Number(raw);
    if (Number.isFinite(v) && v !== 0) out[k] = (out[k] || 0) + v;
  }
  return out;
}

async function getSettingRow(prisma: PrismaClient, key: string) {
  try {
    // prefer unique lookup if schema supports it
    const u = await (prisma as any).setting.findUnique?.({ where: { key } });
    if (u) return u;
  } catch {}
  // fallback to first matching
  return await (prisma as any).setting.findFirst({ where: { key } });
}

export async function getTreasury(prisma: PrismaClient, allianceId: number): Promise<Bag> {
  const key = `treasury:${allianceId}`;
  const row = await getSettingRow(prisma, key);
  const val = (row?.value as any) ?? {};
  const out: Bag = {};
  for (const r of RESOURCES) {
    const v = Number(val?.[r] ?? 0);
    if (Number.isFinite(v) && v !== 0) out[r] = v;
  }
  return out;
}

export async function addToTreasury(
  prisma: PrismaClient,
  allianceId: number,
  deltaRaw: Record<string, number>
): Promise<Bag> {
  const key = `treasury:${allianceId}`;
  const delta = cleanDelta(deltaRaw);

  // load existing
  let row = await getSettingRow(prisma, key);
  const curr: Bag = ((row?.value as any) ?? {}) as Bag;

  // apply
  for (const [k, v] of Object.entries(delta)) {
    curr[k] = (Number(curr[k]) || 0) + Number(v);
  }

  // save
  if (row) {
    row = await (prisma as any).setting.update({ where: { id: row.id }, data: { value: curr } });
  } else {
    row = await (prisma as any).setting.create({ data: { key, value: curr } });
  }
  return curr;
}
