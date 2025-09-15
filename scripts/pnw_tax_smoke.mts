#!/usr/bin/env -S node --enable-source-maps
import { PrismaClient } from "@prisma/client";
import { previewTaxes } from "../src/integrations/pnw/tax.js";

const prisma = new PrismaClient();

const ALLIANCE_ID = 14258;

(async () => {
  try {
    const prev = await previewTaxes(prisma, ALLIANCE_ID);
    const out = {
      count: prev.count,
      newestId: prev.newestId,
      delta: prev.delta,
      sampleIds: prev.sample.map((r) => r.id),
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
