/**
 * City banners: an emblem a plot flies on the world map and over its name.
 * Prestige, bought in $EMERGE; it changes nothing in the economy and that is
 * the point of it.
 */
export const EMBLEMS = ['oak', 'wave', 'star', 'sun', 'stag', 'tower', 'wheat', 'flame'] as const;
export type Emblem = (typeof EMBLEMS)[number];
export const EMBLEM_GLYPH: Record<Emblem, string> = { oak: '♣', wave: '≈', star: '★', sun: '☼', stag: '♞', tower: '♜', wheat: '❋', flame: '♨' };
export const EMBLEM_NAME: Record<Emblem, string> = { oak: 'The Oak', wave: 'The Wave', star: 'The Star', sun: 'The Sun', stag: 'The Stag', tower: 'The Tower', wheat: 'The Wheat', flame: 'The Flame' };
export const isEmblem = (value: unknown): value is Emblem => typeof value === 'string' && (EMBLEMS as readonly string[]).includes(value);
