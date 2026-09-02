/**
 * The $EMERGE vault.
 *
 * There are two doors here and they are deliberately different sizes.
 *
 * **Principal.** $EMERGE deposited becomes Gold in a settlement's treasury at a
 * fixed rate, and the same Gold can be taken back out again, minus a burn. That
 * is the player's own money and moving it mints nothing.
 *
 * **Yield.** The only new $EMERGE a player can earn is the stewardship yield
 * the simulation accrues, capped per day and scaled by how well the settlement
 * is run and how recently the player did anything about it.
 *
 * The treasury itself is *not* a withdrawal source. It used to be: any Gold the
 * town had piled up converted straight to tokens, and a settlement nobody was
 * watching ran a surplus of up to three hundred and sixty Gold a day. An
 * untouched grassland minted eighty million $EMERGE in sixty game days. Gold is
 * the settlement's money — what it pays its people and buys its grain with —
 * and letting it out of the world was the whole problem.
 *
 *   1,000,000 $EMERGE = 100 Gold        (10,000 $EMERGE per Gold)
 *   withdrawals burn 5%
 *
 * Nothing here settles on chain yet. With no vault contract deployed the
 * balance is held locally against the claimed world and every surface says so,
 * so a player is never shown a transfer that did not happen. When the contract
 * exists, `deposit` and `withdraw` are where the transfer and burn go.
 */

import { ACTIVE_CHAIN, TOKEN, chainConfigured, type ChainConfig } from './emerge';

/** $EMERGE per unit of in-world Gold. */
export const EMERGE_PER_GOLD = 10_000;
/** Share of a withdrawal that is burned rather than returned. */
export const WITHDRAW_BURN_RATE = 0.05;
/** Renaming a world costs tokens, so a name means something. */
export const RENAME_COST_EMERGE = 50_000;
/** Renaming one of the beings who live there. */
export const RENAME_CITIZEN_EMERGE = 20_000;
/** Surveying a brand-new plot into existence. */
export const PROSPECT_COST_EMERGE = 120_000;

/**
 * What a new world starts with while claims are local.
 *
 * This is a development allocation, not a token grant, and the interface labels
 * it as such. Once the vault settles on chain this goes away and the balance is
 * read from the wallet.
 */
export const LOCAL_TEST_ALLOCATION = 2_000_000;

export interface VaultLedger {
  /** Local, unsettled $EMERGE balance for this world. */
  balance: number;
  /** Gold deposited over all time, for the record. */
  depositedGold: number;
  /**
   * Gold still standing as principal: what the player put in and has not taken
   * back. This is the ceiling on principal withdrawals, and it is the reason
   * the treasury's own surplus is not one.
   */
  principalGold: number;
  /** $EMERGE earned from stewardship and not yet withdrawn. */
  earnedEmerge: number;
  /** $EMERGE earned from stewardship over all time. */
  lifetimeEarned: number;
  withdrawnEmerge: number;
  burnedEmerge: number;
  /**
   * How much has been minted today, and which day that was.
   *
   * The per-world pacing already ties yield to the wall clock, but a player
   * holding several plots would otherwise collect that rate once per plot.
   * This is the backstop: a ceiling on what one player can mint in a real day,
   * across everything they own.
   */
  earnedToday: number;
  earnedOn: string;
}

/** The most one player can mint in a real day, across every world they hold. */
export const DAILY_EARN_CEILING = 30_000;

/** Today, as a plain date key in the player's own timezone. */
const todayKey = () => new Date().toISOString().slice(0, 10);

export const NEW_LEDGER: VaultLedger = {
  balance: LOCAL_TEST_ALLOCATION,
  depositedGold: 0,
  principalGold: 0,
  earnedEmerge: 0,
  lifetimeEarned: 0,
  withdrawnEmerge: 0,
  burnedEmerge: 0,
  earnedToday: 0,
  earnedOn: '',
};

/** Tolerate ledgers saved before this feature existed. */
export function normaliseLedger(ledger: Partial<VaultLedger> | undefined | null): VaultLedger {
  const deposited = Number(ledger?.depositedGold) || 0;
  return {
    balance: Number.isFinite(ledger?.balance) ? Number(ledger!.balance) : LOCAL_TEST_ALLOCATION,
    depositedGold: deposited,
    // A save written before principal was tracked has its whole deposit history
    // treated as principal still standing. That is the generous reading, and it
    // errs toward letting a player take back money they really did put in.
    principalGold: Number.isFinite(ledger?.principalGold) ? Number(ledger!.principalGold) : deposited,
    earnedEmerge: Number(ledger?.earnedEmerge) || 0,
    lifetimeEarned: Number(ledger?.lifetimeEarned) || 0,
    withdrawnEmerge: Number(ledger?.withdrawnEmerge) || 0,
    burnedEmerge: Number(ledger?.burnedEmerge) || 0,
    earnedToday: Number(ledger?.earnedToday) || 0,
    earnedOn: typeof ledger?.earnedOn === 'string' ? ledger.earnedOn : '',
  };
}

/**
 * Credit stewardship yield, up to the player's ceiling for the real day.
 *
 * Anything past the ceiling is not banked for later — it is simply not minted.
 * The point of a daily ceiling is that a day is a day.
 */
export function accrue(ledger: VaultLedger, emerge: number): VaultLedger {
  if (!(emerge > 0)) return ledger;
  const today = todayKey();
  const spentToday = ledger.earnedOn === today ? ledger.earnedToday : 0;
  const room = Math.max(0, DAILY_EARN_CEILING - spentToday);
  const minted = Math.min(emerge, room);
  if (minted <= 0) {
    return { ...ledger, earnedOn: today, earnedToday: spentToday };
  }
  return {
    ...ledger,
    earnedEmerge: ledger.earnedEmerge + minted,
    lifetimeEarned: ledger.lifetimeEarned + minted,
    earnedToday: spentToday + minted,
    earnedOn: today,
  };
}

/** How much of today's ceiling is left. */
export function earnRoomToday(ledger: VaultLedger) {
  const spent = ledger.earnedOn === todayKey() ? ledger.earnedToday : 0;
  return { spent, ceiling: DAILY_EARN_CEILING, left: Math.max(0, DAILY_EARN_CEILING - spent) };
}

export const goldForEmerge = (emerge: number) => Math.floor((emerge / EMERGE_PER_GOLD) * 100) / 100;
export const emergeForGold = (gold: number) => Math.round(gold * EMERGE_PER_GOLD);

export interface WithdrawQuote {
  /** Gold leaving the treasury. */
  gold: number;
  /** $EMERGE that Gold is worth before the burn. */
  gross: number;
  burned: number;
  received: number;
}

export function quoteWithdraw(gold: number): WithdrawQuote {
  const gross = emergeForGold(gold);
  const burned = Math.round(gross * WITHDRAW_BURN_RATE);
  return { gold, gross, burned, received: gross - burned };
}

export interface VaultResult {
  ok: boolean;
  /** True only when the movement was written to the chain. */
  settled: boolean;
  txHash: string | null;
  message: string;
  ledger: VaultLedger;
}

const unsettledNote = (config: ChainConfig) =>
  chainConfigured(config)
    ? 'The vault contract is not deployed yet, so this moved locally.'
    : `${config.label} is not configured in this build, so this moved locally.`;

/** Convert $EMERGE into Gold for a world's treasury. */
export function deposit(ledger: VaultLedger, emerge: number, config: ChainConfig = ACTIVE_CHAIN): VaultResult {
  const amount = Math.floor(emerge);
  if (!(amount > 0)) {
    return { ok: false, settled: false, txHash: null, message: 'Enter an amount to deposit.', ledger };
  }
  if (amount > ledger.balance) {
    return { ok: false, settled: false, txHash: null, message: `Not enough ${TOKEN.ticker}.`, ledger };
  }
  const gold = goldForEmerge(amount);
  if (gold < 0.01) {
    return { ok: false, settled: false, txHash: null, message: `${EMERGE_PER_GOLD.toLocaleString()} ${TOKEN.ticker} buys 1 Gold.`, ledger };
  }
  return {
    ok: true,
    settled: false,
    txHash: null,
    message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} for ${gold} Gold. ${unsettledNote(config)}`,
    ledger: {
      ...ledger,
      balance: ledger.balance - amount,
      depositedGold: ledger.depositedGold + gold,
      principalGold: ledger.principalGold + gold,
    },
  };
}

/**
 * Take principal back out: Gold the player put in, converted to $EMERGE and
 * burned at the usual rate.
 *
 * Two ceilings, and both matter. The principal still standing, because this
 * door returns your own money and not the town's; and the treasury, because
 * you cannot take Gold out of a purse that does not hold it.
 */
export function withdraw(ledger: VaultLedger, gold: number, treasury: number, config: ChainConfig = ACTIVE_CHAIN): VaultResult {
  const amount = Math.floor(gold);
  if (!(amount > 0)) {
    return { ok: false, settled: false, txHash: null, message: 'Enter an amount to withdraw.', ledger };
  }
  if (amount > Math.floor(ledger.principalGold)) {
    return {
      ok: false, settled: false, txHash: null, ledger,
      message: ledger.principalGold < 1
        ? `Nothing to withdraw here: this door returns Gold you deposited, and you have not deposited any. ${TOKEN.ticker} you earn by running the world is collected below.`
        : `You have ${Math.floor(ledger.principalGold)} Gold of principal standing. The settlement's own Gold stays in the settlement.`,
    };
  }
  if (amount > Math.floor(treasury)) {
    return { ok: false, settled: false, txHash: null, message: 'The treasury does not hold that much Gold.', ledger };
  }
  const quote = quoteWithdraw(amount);
  return {
    ok: true,
    settled: false,
    txHash: null,
    message: `Withdrew ${amount} Gold of principal for ${quote.received.toLocaleString()} ${TOKEN.ticker}, burning ${quote.burned.toLocaleString()}. ${unsettledNote(config)}`,
    ledger: {
      ...ledger,
      balance: ledger.balance + quote.received,
      principalGold: ledger.principalGold - amount,
      withdrawnEmerge: ledger.withdrawnEmerge + quote.received,
      burnedEmerge: ledger.burnedEmerge + quote.burned,
    },
  };
}

/**
 * Collect stewardship earnings as spendable $EMERGE.
 *
 * This is the only door that puts new tokens in a player's hands, and what
 * comes through it was minted a day at a time against how well the world was
 * run. It does not touch the treasury: the settlement's Gold is the
 * settlement's, and the player's earnings are for their work.
 */
export function claimEarnings(ledger: VaultLedger, emerge: number, config: ChainConfig = ACTIVE_CHAIN): VaultResult {
  const amount = Math.floor(emerge);
  if (!(amount > 0)) {
    return { ok: false, settled: false, txHash: null, message: 'Enter an amount to collect.', ledger };
  }
  if (amount > Math.floor(ledger.earnedEmerge)) {
    return {
      ok: false, settled: false, txHash: null, ledger,
      message: `You have earned ${Math.floor(ledger.earnedEmerge).toLocaleString()} ${TOKEN.ticker} here so far.`,
    };
  }
  const burned = Math.round(amount * WITHDRAW_BURN_RATE);
  const received = amount - burned;
  return {
    ok: true,
    settled: false,
    txHash: null,
    message: `Collected ${received.toLocaleString()} ${TOKEN.ticker} of earnings, burning ${burned.toLocaleString()}. ${unsettledNote(config)}`,
    ledger: {
      ...ledger,
      balance: ledger.balance + received,
      earnedEmerge: ledger.earnedEmerge - amount,
      withdrawnEmerge: ledger.withdrawnEmerge + received,
      burnedEmerge: ledger.burnedEmerge + burned,
    },
  };
}

/** Charge a fee. Returns null when the balance will not cover it. */
export function charge(ledger: VaultLedger, cost: number): VaultLedger | null {
  if (ledger.balance < cost) return null;
  return { ...ledger, balance: ledger.balance - cost };
}

/** Credit a sale or refund back to the local balance. */
export function credit(ledger: VaultLedger, amount: number): VaultLedger {
  return { ...ledger, balance: ledger.balance + amount };
}
