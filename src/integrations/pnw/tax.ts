// src/integrations/pnw/tax.ts

// ---- Resource types & helpers kept here (single source of truth) ----
export const RESOURCE_KEYS = [
  "money",
  "food",
  "coal",
  "oil",
  "uranium",
  "lead",
  "iron",
  "bauxite",
  "gasoline",
  "munitions",
  "steel",
  "aluminum",
] as const;

export type ResourceKey = typeof RESOURCE_KEYS[number];
export type ResourceDelta = Partial<Record<ResourceKey, number>>;

export function zeroDelta(): ResourceDelta {
  const z: Partial<Record<ResourceKey, number>> = {};
  for (const k of RESOURCE_KEYS) z[k] = 0;
  return z;
}

export function sumDelta(...items: ResourceDelta[]): ResourceDelta {
  const out = zeroDelta();
  for (const it of items) {
    for (const k of RESOURCE_KEYS) {
      const v = Number((it as any)[k] ?? 0);
      if (Number.isFinite(v) && v !== 0) out[k]! += v;
    }
  }
  return out;
}

export function signedDeltaFor(delta: ResourceDelta): string {
  const lines: string[] = [];
  for (const k of RESOURCE_KEYS) {
    const v = Number((delta as any)[k] ?? 0);
    if (!Number.isFinite(v) || v === 0) continue;
    lines.push(`${k.padEnd(10)} ${v >= 0 ? "+" : ""}${v.toLocaleString()}`);
  }
  return lines.length ? "```\n" + lines.join("\n") + "\n```" : "_no change_";
}

export function formatDelta(delta: ResourceDelta): string {
  return signedDeltaFor(delta);
}

// ---- (If this file also contains other PnW-tax-related logic in your repo,
// keep it below; we intentionally removed any imports from ../../lib/pnw.js)
// ----
