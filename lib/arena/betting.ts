/**
 * Betting on a bout.
 *
 * **Why bets settle against the house and not against each other.**
 *
 * The obvious design is a pot: everybody stakes, the winners split it. It is
 * also the one design this game cannot have. Gold is state in a player's own
 * browser — the server has never been able to verify it and deliberately does
 * not try, which is exactly why Gold can never become tokens. A pot would mean
 * one player's Gold paying another's winnings, and a client that lied about its
 * balance would be taking Gold off honest players. That is not a rule anybody
 * could enforce, so it is not a rule worth writing.
 *
 * So a bet is between a player and their own settlement's treasury, at odds the
 * arena publishes for a fight everybody watches together. The social half — the
 * same bout, the same fighters, the same result, on a board with everybody
 * else's calls — is entirely real. Only the money stays at home.
 *
 * **And it cannot be farmed.** The odds carry a house edge, so betting is
 * slightly negative over time; the stake is capped per bout and per day; and
 * the outcome cannot be computed before betting closes, because the arena
 * commits to a secret it only reveals afterwards. The most a very lucky day can
 * produce is a few thousand Gold, which stays in the world like every other
 * Gold in it.
 */

/** The most that may be staked on one bout. */
export const MAX_STAKE = 500;

/** The most that may be staked across a day, so a bad run has a floor. */
export const MAX_STAKE_PER_DAY = 3_000;

/**
 * What the house keeps.
 *
 * Six per cent, taken out of the odds rather than the stake, so what is on
 * screen is what a win pays. It is what makes the arena a place to spend Gold
 * rather than a place to make it.
 */
export const HOUSE_EDGE = 0.06;

/** What the board offers, after the house has taken its cut. */
export function offered(trueOdds: number): number {
  // Floored just above evens: an offer of less than your stake back is not an
  // offer, and rounding to two places keeps the board readable.
  return Math.max(1.05, Math.round(trueOdds * (1 - HOUSE_EDGE) * 100) / 100);
}

/** What a winning stake returns, stake included. */
export function payout(stake: number, offeredOdds: number): number {
  return Math.round(stake * offeredOdds);
}

/**
 * Is this bet allowed?
 *
 * Everything the interface needs to refuse a bet before it is placed, and the
 * same rules the settlement applies when it takes the Gold.
 */
export function refuse(
  stake: number,
  treasury: number,
  stakedToday: number,
): string | null {
  if (!Number.isFinite(stake) || stake <= 0) return 'Stake something first.';
  if (!Number.isInteger(stake)) return 'Whole Gold only.';
  if (stake > MAX_STAKE) return `${MAX_STAKE} Gold is the most on one bout.`;
  if (stake > treasury) return 'Your treasury cannot cover that.';
  if (stakedToday + stake > MAX_STAKE_PER_DAY) {
    return `That is over ${MAX_STAKE_PER_DAY.toLocaleString()} Gold staked today.`;
  }
  return null;
}
