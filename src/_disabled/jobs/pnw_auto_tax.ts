// src/jobs/pnw_auto_tax.ts
import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { applyAllianceTaxes } from "../lib/pnw_tax";

export function startAutoTaxSync(allianceIds: number[]) {
  const prisma = new PrismaClient();

  // top of every hour UTC
  const task = cron.schedule("0 * * * *", async () => {
    for (const aid of allianceIds) {
      try {
        const res = await applyAllianceTaxes(prisma, aid, 50);
        console.log("[auto-tax] AID=%s applied=%s newest=%s reason=%s", aid, res.applied, res.newestId, res.reason);
      } catch (e) {
        console.error("[auto-tax] AID=%s error: %s", aid, (e as any)?.message || e);
      }
    }
  }, { timezone: "UTC" });

  task.start();
  return task;
}
