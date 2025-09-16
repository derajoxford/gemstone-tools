// src/utils/treasury.ts
import { ResourceDelta, RESOURCE_KEYS } from "../integrations/pnw/tax.js";

type Bag = Partial<Record<string, number>>;

export function coerceDelta(obj: any): ResourceDelta {
  const out: Partial<Record<string, number>> = {};
  for (const k of RESOURCE_KEYS) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v) && v !== 0) out[k] = v;
  }
  return out as ResourceDelta;
}

export function applyDelta(bag: Bag, delta: ResourceDelta): Bag {
  for (const k of RESOURCE_KEYS) {
    const d = Number((delta as any)[k] ?? 0);
    if (!Number.isFinite(d) || d === 0) continue;
    const curr = Number(bag[k] ?? 0);
    bag[k] = curr + d;
  }
  return bag;
}
