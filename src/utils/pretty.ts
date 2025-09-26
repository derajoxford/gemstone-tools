// src/utils/pretty.ts
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
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  blurple: 0x5865f2,
  gray: 0x95a5a6,
  dark: 0x2c2f33,
} as const;

export const RESOURCE_META: Record<
  ResourceKey,
  { emoji: string; color: number; label: string }
> = {
  money: { emoji: "💵", color: 0x27ae60, label: "money" },
  food: { emoji: "🍖", color: 0x9b59b6, label: "food" },
  coal: { emoji: "🪨", color: 0x34495e, label: "coal" },
  oil: { emoji: "🛢️", color: 0x8e44ad, label: "oil" },
  uranium: { emoji: "☢️", color: 0xf1c40f, label: "uranium" },
  lead: { emoji: "⚙️", color: 0x7f8c8d, label: "lead" },
  iron: { emoji: "⛓️", color: 0x95a5a6, label: "iron" },
  bauxite: { emoji: "🧱", color: 0xd35400, label: "bauxite" },
  gasoline: { emoji: "⛽", color: 0xc0392b, label: "gasoline" },
  munitions: { emoji: "💣", color: 0xe74c3c, label: "munitions" },
  steel: { emoji: "🏗️", color: 0x7f8c8d, label: "steel" },
  aluminum: { emoji: "🔩", color: 0xbdc3c7, label: "aluminum" },
};

export function fmtAmount(n: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(n);
}

export function resourceLabel(key: ResourceKey): string {
  const m = RESOURCE_META[key];
  return `${m.emoji} ${m.label}`;
}

export function colorForDelta(delta: number, fallback: number = COLORS.blurple): number {
  if (delta > 0) return COLORS.green;
  if (delta < 0) return COLORS.red;
  return fallback;
}

export function discordRelative(ts: Date | number): string {
  const ms = typeof ts === "number" ? ts : ts.getTime();
  const s = Math.floor(ms / 1000);
  return `<t:${s}:R>`;
}
