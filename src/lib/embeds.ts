// src/lib/embeds.ts
import { EmbedBuilder } from "discord.js";

export function resourceEmbed(opts: {
  title: string;
  subtitle?: string;
  body?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
  color?: number;
  footer?: string;
}) {
  const e = new EmbedBuilder().setTitle(opts.title);
  if (opts.subtitle) e.setDescription(opts.subtitle);
  if (opts.fields?.length) e.addFields(opts.fields);
  if (opts.body) e.addFields({ name: "\u200b", value: opts.body });
  e.setColor(opts.color ?? 0x5865F2);
  if (opts.footer) e.setFooter({ text: opts.footer });
  return e;
}
