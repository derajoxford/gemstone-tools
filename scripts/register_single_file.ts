// scripts/register_single_file.ts
import https from "node:https";
import { REST, Routes } from "discord.js";
import { pathToFileURL } from "node:url";
import path from "node:path";

async function fetchAppIdWithToken(token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "discord.com", path: "/api/v10/oauth2/applications/@me", method: "GET",
        headers: { Authorization: `Bot ${token}` } },
      (res) => {
        let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => {
          try {
            if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            const parsed = JSON.parse(data);
            if (!parsed?.id) return reject(new Error("No application id in response"));
            resolve(String(parsed.id));
          } catch (e) { reject(e as Error); }
        });
      }
    );
    req.on("error", reject); req.end();
  });
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.TEST_GUILD_ID || "";
  const file = process.env.CMD_FILE || "src/commands/pnw_set.ts";
  if (!token) throw new Error("DISCORD_TOKEN missing.");
  if (!guildId) throw new Error("TEST_GUILD_ID missing (needed for instant guild registration).");

  let appId = process.env.DISCORD_APPLICATION_ID || "";
  if (!appId) {
    console.log("No DISCORD_APPLICATION_ID set; fetching from Discord…");
    appId = await fetchAppIdWithToken(token);
    console.log(`Discovered Application ID: ${appId}`);
  }

  const mod = await import(pathToFileURL(path.resolve(file)).href);
  const cmd = (mod?.default ?? mod);
  if (!cmd?.data?.toJSON || !cmd?.execute) {
    throw new Error(`Module at ${file} did not export { data, execute }`);
  }
  const body = cmd.data.toJSON();
  const name = body?.name;

  const rest = new REST({ version: "10" }).setToken(token);
  const current = (await rest.get(Routes.applicationGuildCommands(appId, guildId))) as any[];
  const existing = current.find((c) => c.name === name);

  if (existing) {
    await rest.patch(Routes.applicationGuildCommand(appId, guildId, existing.id), { body });
    console.log(`✅ Updated guild command: ${name}`);
  } else {
    await rest.post(Routes.applicationGuildCommands(appId, guildId), { body });
    console.log(`✅ Created guild command: ${name}`);
  }
}

main().catch((e) => { console.error("Registration failed:", e?.message ?? e); process.exit(1); });
