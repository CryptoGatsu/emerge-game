/**
 * Numbers and key names both halves of the game have to agree on.
 *
 * Kept in a module with no imports of its own so a client component can read a
 * limit the server enforces without dragging the server's storage layer into
 * the browser bundle, and vice versa. A limit checked in one place and printed
 * from another is a limit that drifts.
 */

/**
 * Which generation of the world's data this build reads and writes.
 *
 * Every key that holds game state carries it, on the server and in the
 * browser. Raising it by one abandons the previous generation wholesale —
 * every claim, every surveyed island, every published world, every saved
 * settlement and every chat log — and the game starts from empty land.
 *
 * This is how the world is cleared. It is a deliberate code change rather than
 * an endpoint because an endpoint that wipes the game is a thing that can be
 * called by accident or by somebody else, and because the old generation is
 * still sitting there if a reset turns out to have been a mistake.
 *
 * **Do not raise this once players have paid for land.** With no land contract
 * deployed, the claim rows in the shared store are the only record of who owns
 * what — there is no chain to fall back on. Raising the epoch abandons every
 * one of them, which after launch means taking land people paid real $EMERGE
 * for. The keys of the previous generation still exist and could be read back
 * by hand, but nothing in the game would do it for you.
 *
 * The same goes for the store itself: back up Upstash, and treat losing it as
 * losing the deeds rather than losing a cache.
 *
 * 1 — the first testing round.
 * 2 — cleared before the move to mainnet, so no plot claimed with development
 *     tokens carries over into a world where the token is real.
 */
export const DATA_EPOCH = 2;

/** A key in the shared server store. */
export const serverKey = (name: string) => `emerge:e${DATA_EPOCH}:${name}`;

/**
 * A key in this browser's storage.
 *
 * Preferences deliberately do not go through here: which wallet somebody last
 * used and whether they want chat alerts are not game state, and clearing the
 * world should not disconnect them or forget what they asked for.
 */
export const clientKey = (name: string) => `emerge.e${DATA_EPOCH}.${name}`;

/**
 * The most Gold one gift may carry.
 *
 * Generous against what a settlement spends in a day, and small against what
 * forging a request could be worth. Both halves matter.
 */
export const MAX_GIFT_GOLD = 2_000;
