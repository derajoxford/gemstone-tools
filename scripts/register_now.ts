// scripts/register_now.ts
// Register slash commands without restarting the bot.
// Uses your registry's extraCommandsJSON.

import { REST, Routes } from "discord.js";
import { extraCommandsJSON } from "../src/commands/registry";

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APPLICATION_ID; // your Application (Client) ID
  const guildId = process.env.TEST_GUILD_ID;        // optional: for instant, per-guild registration

  if (!token) throw new Error("DISCORD_TOKEN is required (env).");
  if (!appId) throw new Error("DISCORD_APPLICATION_ID is required (env).");

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    console.log(`Registering ${extraCommandsJSON.length} commands to guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(appId, guildId), {
      body: extraCommandsJSON,
    });
    console.log("✅ Guild command registration complete.");
  } else {
    console.log(`Registering ${extraCommandsJSON.length} commands globally (may take time to appear)...`);
    await rest.put(Routes.applicationCommands(appId), {
      body: extraCommandsJSON,
    });
    console.log("✅ Global command registration submitted.");
  }
}

main().catch((e) => {
  console.error("Registration failed:", e?.message ?? e);
  process.exit(1);
});
