/**
 * Numbers both halves of the game have to agree on.
 *
 * Kept in a module with no imports of its own so a client component can read a
 * limit the server enforces without dragging the server's storage layer into
 * the browser bundle, and vice versa. A limit checked in one place and printed
 * from another is a limit that drifts.
 */

/**
 * The most Gold one gift may carry.
 *
 * Generous against what a settlement spends in a day, and small against what
 * forging a request could be worth. Both halves matter.
 */
export const MAX_GIFT_GOLD = 2_000;
