// Resource emojis + canonical ordering used across the bot

export const RES_EMOJI = {
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
} as const;

// Keep this order in sync anywhere resources are iterated (modals, embeds, math)
export const ORDER = [
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
] as const;

export type Resource = typeof ORDER[number];
