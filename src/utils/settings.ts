// src/utils/settings.ts
// Temporary in-memory guild settings cache (no DB dependency).
// TODO: replace with a real Setting model when available.

const manualAdjustLogChannel = new Map<string, string>(); // guildId -> channelId

export async function getGuildSetting(guildId: string, key: string): Promise<string | null> {
  if (key === "manual_adjust_log_channel_id") {
    return manualAdjustLogChannel.get(guildId) ?? null;
  }
  return null;
}

export async function setGuildSetting(guildId: string, key: string, value: string) {
  if (key === "manual_adjust_log_channel_id") {
    manualAdjustLogChannel.set(guildId, value);
  }
}
