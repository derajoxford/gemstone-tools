// scripts/register-one.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// load .env if present
const dotenvPath = resolve(process.cwd(), ".env");
if (fs.existsSync(dotenvPath)) {
  const { config } = await import("dotenv");
  config({ path: dotenvPath });
}

function ensureEnv(name, { required = false } = {}) {
  const v = process.env[name];
  if (required && (!v || !v.trim())) {
    console.error(`❌ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

// We need DISCORD_TOKEN to talk to Discord; required.
// TEST_GUILD_ID is optional (if missing, we register globally).
ensureEnv("DISCORD_TOKEN", { required: true });

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/register-one.mjs <commandName> [moreNames...]");
  console.error("Example: npm run reg pnw_tax_ids pnw_preview_stored");
  process.exit(1);
}

// Resolve command names to src files
const toFile = (name) =>
  name.endsWith(".ts") || name.includes("/")
    ? name
    : `src/commands/${name}.ts`;

const useGuild = !!(process.env.TEST_GUILD_ID && process.env.TEST_GUILD_ID.trim());
const childEnv = {
  ...process.env,
  // If TEST_GUILD_ID is absent, force global registration to avoid errors
  ...(useGuild ? {} : { REGISTER_GLOBAL: "1" }),
};

for (const name of args) {
  const file = toFile(name);
  const abs = resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`❌ Cannot find command file: ${file}`);
    process.exit(1);
  }

  console.log(`\n▶ Registering ${name} (${file}) ${useGuild ? "to guild TEST_GUILD_ID" : "globally"}...`);
  const result = spawnSync(
    "npx",
    ["tsx", "scripts/register_single_file.ts"],
    {
      stdio: "inherit",
      env: { ...childEnv, CMD_FILE: file },
      cwd: process.cwd(),
    }
  );

  if (result.status !== 0) {
    console.error(`❌ Registration failed for ${name}.`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n✅ Done.");
