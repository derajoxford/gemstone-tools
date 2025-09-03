import { EmbedBuilder, Guild } from 'discord.js';
import { getSetting } from './settings.js';

function hasIgnore(note?: string): boolean {
  return !!note && note.toLowerCase().includes('#ignore');
}

export function formatAmount(v: bigint) {
  const s = v.toString();
  return `$${s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export async function logBankEvent(
  guild: Guild,
  payload: {
    kind: 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER' | 'ADJUST';
    account: 'ALLIANCE' | 'SAFEKEEPING';
    amount: bigint;
    note?: string;
    memberDiscordId?: string;
    nation?: string;
    actorDiscordId?: string;
  }
) {
  const channelId = await getSetting(guild.id, 'bankLogChannelId');
  if (!channelId) return;

  // Ignore alliance-bank deposits with "#ignore"
  if (payload.account === 'ALLIANCE' && payload.kind === 'DEPOSIT' && hasIgnore(payload.note)) {
    return;
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(`${payload.account} ${payload.kind}`)
    .addFields(
      { name: 'Amount', value: formatAmount(payload.amount), inline: true },
      ...(payload.memberDiscordId ? [{ name: 'Member', value: `<@${payload.memberDiscordId}>`, inline: true }] : []),
      ...(payload.nation ? [{ name: 'Nation', value: payload.nation, inline: true }] : []),
      ...(payload.actorDiscordId ? [{ name: 'Actor', value: `<@${payload.actorDiscordId}>`, inline: true }] : []),
      ...(payload.note ? [{ name: 'Note', value: payload.note.slice(0, 1024) }] : [])
    )
    .setTimestamp(new Date());

  // Use bracket access to dodge over-narrowing in some TS/discord.js combos
  await (channel as any)['send']({ embeds: [embed] });
}
