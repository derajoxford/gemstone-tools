// scripts/tax_preview.ts
//
// Interactive CLI to preview Politics & War tax credits (no writes).
// - Prompts for PNW_API_KEY if not set
// - Prompts for PnW Alliance ID
// - Optional lastSeenId (only show records with id > lastSeenId)
// - Prints a clean preview and the newest bankrec id we should store as our cursor.
//
// Run: npx tsx scripts/tax_preview.ts

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { previewAllianceTaxCredits } from "../src/integrations/pnw/tax";

async function main() {
  const rl = readline.createInterface({ input, output });

  let apiKey = process.env.PNW_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    apiKey = await rl.question("Paste your PNW API key (input hidden is not supported here): ");
    apiKey = apiKey.trim();
    if (!apiKey) {
      console.error("PNW API key is required.");
      rl.close();
      process.exit(1);
    }
  }

  const idStr = await rl.question("Enter the PnW Alliance ID (number): ");
  const allianceId = Number(idStr.trim());
  if (!Number.isFinite(allianceId) || allianceId <= 0) {
    console.error("Alliance ID must be a positive number.");
    rl.close();
    process.exit(1);
  }

  const lastStr = await rl.question("Optional lastSeenId (bankrec id). Press Enter to skip: ");
  const lastSeenId = lastStr.trim() ? Number(lastStr.trim()) : undefined;
  if (lastStr.trim() && (!Number.isFinite(lastSeenId!) || lastSeenId! < 0)) {
    console.error("lastSeenId must be a non-negative number if provided.");
    rl.close();
    process.exit(1);
  }

  console.log("\nFetching recent bank records from PnW and building tax preview...\n");
  try {
    const preview = await previewAllianceTaxCredits({
      apiKey,
      allianceId,
      lastSeenId,
    });

    console.log("=== TAX PREVIEW ===");
    console.log(`Alliance ID: ${allianceId}`);
    console.log(`Records counted: ${preview.count}`);
    console.log(`Newest bankrec id (cursor): ${preview.newestId ?? "none"}`);
    console.log("");

    if (preview.previewLines.length === 0) {
      console.log("No positive tax deltas detected.");
    } else {
      for (const line of preview.previewLines) {
        console.log(line);
      }
    }

    if (preview.warnings.length) {
      console.log("\nWarnings:");
      for (const w of preview.warnings) console.log("- " + w);
    }

    console.log("\nNext steps:");
    console.log("• Save the 'Newest bankrec id' as the cursor to avoid double-crediting.");
    console.log("• We’ll add an automatic importer with a persistent cursor and cron in the next step.");
  } catch (err: any) {
    console.error("Failed to preview tax credits:");
    console.error(err?.message ?? err);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
