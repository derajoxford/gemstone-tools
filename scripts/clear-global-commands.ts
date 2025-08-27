import 'dotenv/config';
import { REST, Routes } from 'discord.js';
const token = process.env.DISCORD_TOKEN!;
const appId = process.env.DISCORD_CLIENT_ID!;
const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  await rest.put(Routes.applicationCommands(appId), { body: [] });
  console.log('🧹 Cleared GLOBAL commands');
})();
