// src/lib/emojis.ts
// Keep types permissive so indexing like RES_EMOJI[k as any] doesn't TS7053.

export const RES_EMOJI: Record<string, string> = {
  money: '💵',
  food: '🍖',
  coal: '⛏️',
  oil: '🛢️',
  uranium: '☢️',
  lead: '🔩',
  iron: '🧲',
  bauxite: '🧱',
  gasoline: '⛽',
  munitions: '💣',
  steel: '🔗',
  aluminum: '🥫',
};

// The canonical order used everywhere (modals, embeds, math)
export const ORDER: string[] = [
  'money',
  'food',
  'coal',
  'oil',
  'uranium',
  'lead',
  'iron',
  'bauxite',
  'gasoline',
  'munitions',
  'steel',
  'aluminum',
];

// (Optional) legacy default export shape if any code `import emojis from ...`
const defaultExport = { RES_EMOJI, ORDER };
export default defaultExport;
