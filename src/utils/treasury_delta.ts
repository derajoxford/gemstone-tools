// src/utils/treasury_delta.ts
//
// Shared helpers for validating/applying resource deltas to the Alliance Treasury.
// Reusable for /treasury_bulk *and* for automatic tax ingestion later.
//
// Assumes you already have:
//   addToTreasury(allianceId: number, resource: string, delta: number)
// in src/utils/treasury.ts

import { addToTreasury } from "./treasury";

export type DeltaMap = Record<string, number>;

export type PreviewResult = {
  ok: boolean;
  clean: DeltaMap;        // normalized (numeric, combined, no zeros)
  positives: DeltaMap;    // > 0
  negatives: DeltaMap;    // < 0
  zeroes: string[];       // keys that normalized to 0 (dropped)
  unknownKeys: string[];  // not in KNOWN_RESOURCES (warning only)
  errors: string[];       // hard validation errors
  warnings: string[];     // non-fatal issues (unknown keys, dropped zeroes)
};

/** Soft-validate against both Gemstone & PnW resource names. */
const KNOWN_RESOURCES = new Set<string>([
  // Gemstone / your schema
  "money",
  "coal",
  "oil",
  "uranium",
  "steel",
  "aluminum",
  "food",
  "gasoline",
  "diesel",
  "aircraft_fuel",
  // PnW-specific
  "munitions",
  "iron",
  "bauxite",
  "lead",
]);

/**
 * Validate & normalize a delta map:
 * - Accepts numbers or numeric strings
 * - Drops zeros
 * - Sums duplicate keys
 * - Flags unknown keys (warning only)
 * - Rejects NaN/Infinity or non-finite values
 */
export function validateAndNormalizeDelta(input: unknown): PreviewResult {
  const result: PreviewResult = {
    ok: true,
    clean: {},
    positives: {},
    negatives: {},
    zeroes: [],
    unknownKeys: [],
    errors: [],
    warnings: [],
  };

  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    result.ok = false;
    result.errors.push("Delta must be a plain object like { resource: amount, ... }.");
    return result;
  }

  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey).trim();
    if (!key) continue;

    const num =
      typeof rawVal === "number"
        ? rawVal
        : typeof rawVal === "string"
        ? Number(rawVal.trim())
        : NaN;

    if (!Number.isFinite(num)) {
      result.ok = false;
      result.errors.push(`Value for "${key}" must be a finite number. Received: ${String(rawVal)}`);
      continue;
    }

    result.clean[key] = (result.clean[key] ?? 0) + num;
  }

  for (const [k, v] of Object.entries(result.clean)) {
    if (v === 0) {
      result.zeroes.push(k);
      delete result.clean[k];
      continue;
    }
    if (v > 0) result.positives[k] = v;
    else result.negatives[k] = v;

    if (!KNOWN_RESOURCES.has(k)) {
      result.unknownKeys.push(k);
    }
  }

  if (result.zeroes.length) {
    result.warnings.push(`Dropped zero-valued keys: ${result.zeroes.join(", ")}`);
  }
  if (result.unknownKeys.length) {
    result.warnings.push(`Unknown resource keys (will still apply): ${result.unknownKeys.join(", ")}`);
  }

  return result;
}

/** Pretty preview lines for embeds/DMs/logs. */
export function formatPreviewLines(res: PreviewResult, opts?: { mode?: "credit" | "debit" | "mixed" }): string[] {
  const mode = opts?.mode ?? "mixed";
  const lines: string[] = [];

  const addSet = (prefix: string, map: DeltaMap) => {
    for (const [k, v] of Object.entries(map)) {
      lines.push(`${prefix}${k}: ${v}`);
    }
  };

  if (mode === "credit") {
    addSet("+", res.positives);
  } else if (mode === "debit") {
    const absNeg = Object.fromEntries(Object.entries(res.negatives).map(([k, v]) => [k, Math.abs(v)]));
    addSet("-", absNeg);
  } else {
    addSet("+", res.positives);
    const absNeg = Object.fromEntries(Object.entries(res.negatives).map(([k, v]) => [k, Math.abs(v)]));
    addSet("-", absNeg);
  }

  if (res.unknownKeys.length) lines.push(`(unknown keys: ${res.unknownKeys.join(", ")})`);
  if (res.zeroes.length) lines.push(`(dropped zeroes: ${res.zeroes.join(", ")})`);
  if (res.errors.length) lines.push(`ERRORS: ${res.errors.join(" | ")}`);

  return lines;
}

/**
 * Credit-only apply for tax revenue or other income.
 * - Ignores negatives/zeroes
 * - Validates inputs
 * - Uses addToTreasury(allianceId, resource, amount)
 *
 * Returns the applied positive map plus any non-fatal warnings.
 */
export async function creditTaxRevenue(
  allianceId: number,
  delta: unknown,
  meta?: {
    source?: "income_tax" | "trade_tax" | "other_tax";
    note?: string;
    actorDiscordId?: string;
    actorMemberId?: number;
  }
): Promise<{ applied: DeltaMap; warnings: string[] }> {
  const v = validateAndNormalizeDelta(delta);

  if (!v.ok) {
    const msg = v.errors.join("; ");
    throw new Error(`Invalid tax revenue delta: ${msg}`);
  }

  const positives = v.positives;

  if (Object.keys(positives).length === 0) {
    return { applied: {}, warnings: ["No positive amounts to credit."] };
  }

  for (const [resource, amount] of Object.entries(positives)) {
    await addToTreasury(allianceId, resource as any, amount);
  }

  // In a later step we’ll attach an audit write (Bankrec) here using meta.
  return { applied: positives, warnings: v.warnings };
}

/** Non-mutating helper: just returns the structured validation result. */
export function previewDelta(delta: unknown, mode: "credit" | "debit" | "mixed" = "mixed"): PreviewResult {
  const v = validateAndNormalizeDelta(delta);
  return v;
}
