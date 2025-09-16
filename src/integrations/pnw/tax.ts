// src/integrations/pnw/tax.ts

// ---- Resource types & helpers (single source of truth) ----
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

// ---- Temporary no-op exports to satisfy existing imports ----
// These keep the bot online; tax features are neutralized for now.
// They return shapes that existing commands expect. We can flesh
// them out later without changing import sites.

type PreviewResult = {
  delta: ResourceDelta;
  items?: any[];
  message?: string;
};

type ApplyResult = {
  applied: number;
  delta: ResourceDelta;
  items?: any[];
  message?: string;
};

// Preview taxes computed live
export async function previewTaxes(
  /* prisma */ _prisma?: any,
  /* allianceId */ _allianceId?: number,
  /* opts */ _opts?: Record<string, any>
): Promise<PreviewResult> {
  return { delta: zeroDelta(), items: [], message: "Tax preview is temporarily disabled." };
}

// Preview taxes from previously stored credits
export async function previewAllianceTaxCreditsStored(
  /* prisma */ _prisma?: any,
  /* allianceId */ _allianceId?: number,
  /* opts */ _opts?: Record<string, any>
): Promise<PreviewResult> {
  return { delta: zeroDelta(), items: [], message: "Stored tax preview is temporarily disabled." };
}

// Apply taxes (no-op)
export async function applyTaxes(
  /* prisma */ _prisma?: any,
  /* allianceId */ _allianceId?: number,
  /* opts */ _opts?: Record<string, any>
): Promise<ApplyResult> {
  return { applied: 0, delta: zeroDelta(), items: [], message: "Apply taxes is temporarily disabled." };
}
