// src/integrations/pnw/tax.ts
import { fetchAllianceBankrecs, type PnwBankrec } from "./client";

type Resource =
  | "money" | "food" | "munitions" | "gasoline" | "aluminum" | "steel"
  | "coal" | "oil" | "uranium" | "iron" | "bauxite" | "lead";

const RESOURCES: Resource[] = [
  "money","food","munitions","gasoline","aluminum","steel",
  "coal","oil","uranium","iron","bauxite","lead",
];

export type TaxPreview = {
  count: number;            // number of bankrecs considered after filters
  newestId: number | null;  // max id from the filtered set (cursor)
  delta: Record<Resource, number>;
  previewLines: string[];   // formatted "+resource: amount"
  warnings: string[];
};

function isIncomingToAlliance(rec: PnwBankrec, allianceId: number): boolean {
  return rec.receiver_type === 2 && rec.receiver_id === allianceId;
}

function positivePart(n: number): number {
  return n > 0 ? n : 0;
}

export async function previewAllianceTaxCredits(params: {
  apiKey: string;
  allianceId: number;
  lastSeenId?: number;
}): Promise<TaxPreview> {
  const { apiKey, allianceId, lastSeenId } = params;
  const bankrecs = await fetchAllianceBankrecs(apiKey, allianceId);

  // Strict filters:
  //  1) tax_id present (tax record),
  //  2) incoming to this alliance (receiver_type == 2 and receiver_id == allianceId),
  //  3) respects lastSeenId cursor when provided.
  let recs = bankrecs.filter((r) => r.tax_id != null && isIncomingToAlliance(r, allianceId));
  if (typeof lastSeenId === "number") {
    recs = recs.filter((r) => r.id > lastSeenId);
  }

  const newestId = recs.length ? Math.max(...recs.map((r) => r.id)) : null;

  const delta: Record<Resource, number> = Object.fromEntries(RESOURCES.map((k) => [k, 0])) as any;

  for (const r of recs) {
    // Sum only the positive portion (incoming to the alliance)
    delta.money     += positivePart(Number(r.money)     || 0);
    delta.food      += positivePart(Number(r.food)      || 0);
    delta.munitions += positivePart(Number(r.munitions) || 0);
    delta.gasoline  += positivePart(Number(r.gasoline)  || 0);
    delta.aluminum  += positivePart(Number(r.aluminum)  || 0);
    delta.steel     += positivePart(Number(r.steel)     || 0);
    delta.coal      += positivePart(Number(r.coal)      || 0);
    delta.oil       += positivePart(Number(r.oil)       || 0);
    delta.uranium   += positivePart(Number(r.uranium)   || 0);
    delta.iron      += positivePart(Number(r.iron)      || 0);
    delta.bauxite   += positivePart(Number(r.bauxite)   || 0);
    delta.lead      += positivePart(Number(r.lead)      || 0);
  }

  const previewLines: string[] = [];
  const moneyFmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const unitFmt  = (n: number) => Math.round(n).toLocaleString();

  if (delta.money)     previewLines.push(`+money: ${moneyFmt(delta.money)}`);
  if (delta.food)      previewLines.push(`+food: ${unitFmt(delta.food)}`);
  if (delta.munitions) previewLines.push(`+munitions: ${unitFmt(delta.munitions)}`);
  if (delta.gasoline)  previewLines.push(`+gasoline: ${unitFmt(delta.gasoline)}`);
  if (delta.aluminum)  previewLines.push(`+aluminum: ${unitFmt(delta.aluminum)}`);
  if (delta.steel)     previewLines.push(`+steel: ${unitFmt(delta.steel)}`);
  if (delta.oil)       previewLines.push(`+oil: ${unitFmt(delta.oil)}`);
  if (delta.uranium)   previewLines.push(`+uranium: ${unitFmt(delta.uranium)}`);
  if (delta.bauxite)   previewLines.push(`+bauxite: ${unitFmt(delta.bauxite)}`);
  if (delta.coal)      previewLines.push(`+coal: ${unitFmt(delta.coal)}`);
  if (delta.iron)      previewLines.push(`+iron: ${unitFmt(delta.iron)}`);
  if (delta.lead)      previewLines.push(`+lead: ${unitFmt(delta.lead)}`);

  const warnings: string[] = [];
  if (!recs.length) {
    warnings.push("No incoming tax records found. If you just created a bracket, remember taxes post at turn change.");
  }

  return { count: recs.length, newestId, delta, previewLines, warnings };
}
