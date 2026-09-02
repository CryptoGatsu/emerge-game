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
 * **Where the tokens actually are.** Money going out of a player's wallet is
 * signed by the player, so it needs nothing from us: a deposit is a real
 * transfer to the vault wallet and a charge is a real transfer to the burn
 * address. Money coming *back* is the hard direction — the vault is a wallet,
 * not a contract, so it cannot pay anybody on its own. A withdrawal therefore
 * books a request in the settlement queue and is paid from the vault by hand,
 * with the burn share left behind in the vault to be burned deliberately.
 * Nothing on any surface says a payout has arrived until it has.
 */

import {
  ACTIVE_CHAIN, TOKEN, VAULT_ADDRESS, chainConfigured, tokenBalance, tokenLive, transferTokens,
  vaultLive, type ChainConfig,
} from './emerge';
import { askForPayout } from '../net/payouts';

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
/** Changing your own name, after the first change, which is free. */
export const RENAME_PLAYER_EMERGE = 30_000;

/**
 * What a player starts with while there is no token to hold.
 *
 * A development allocation, not a token grant, and the interface says so
 * wherever it appears. It exists **only** while `NEXT_PUBLIC_EMERGE_TOKEN` is
 * unset: the moment a real contract is configured this is zero and the balance
 * on screen is whatever the wallet actually holds, read from the chain.
 *
 * That switch is load-bearing rather than cosmetic. Two million free tokens
 * handed to every visitor is harmless against a token that does not exist and
 * ruinous against one that does — nobody would need to buy any, every burn
 * would burn nothing, and every price in the game would be theatre.
 */
export const LOCAL_TEST_ALLOCATION = tokenLive() ? 0 : 2_000_000;

/**
 * True when balances, prices and burns refer to a real token.
 *
 * Everything downstream of this reads differently: the balance comes from the
 * chain rather than this browser, a charge asks the player to sign, and the
 * panels stop saying "recorded locally".
 */
export const liveToken = () => tokenLive();

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
  /**
   * $EMERGE destroyed: transferred to the burn address, or, in a build with no
   * token deployed, notionally destroyed. Every charge the game makes lands
   * here.
   */
  burnedEmerge: number;
  /**
   * $EMERGE asked for and not yet paid.
   *
   * A payout leaves the vault when a person sends it, so between the request
   * and the transfer there is a real sum that is neither in the player's wallet
   * nor in their in-game balance. Counting it as either would be a lie, so it
   * is counted as what it is.
   */
  pendingEmerge: number;
  /**
   * The withdrawal burn share, sitting in the vault.
   *
   * Deliberately not added to `burnedEmerge`: these tokens still exist. They
   * stay behind when a payout is sent and are burned from the vault by hand, so
   * until that happens calling them burned would overstate the burn.
   */
  vaultBurn: number;
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

/**
 * How many of a player's worlds pay.
 *
 * A player may hold as many plots as they can afford, but only the four they
 * claimed first earn — so income tops out at four times one well-run
 * settlement rather than scaling with the size of a wallet. Give one up and
 * the next in line starts earning.
 */
export const EARNING_PLOT_LIMIT = 4;

/**
 * The most one player can mint in a real day, across every world they hold:
 * four settlements' worth, which is the same limit stated as a number.
 */
export const DAILY_EARN_CEILING = 25_000 * EARNING_PLOT_LIMIT;

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
  pendingEmerge: 0,
  vaultBurn: 0,
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
    pendingEmerge: Number(ledger?.pendingEmerge) || 0,
    vaultBurn: Number(ledger?.vaultBurn) || 0,
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
  /** Set when the movement is queued for settlement out of the vault. */
  queued: boolean;
}

const refuse = (ledger: VaultLedger, message: string): VaultResult =>
  ({ ok: false, settled: false, queued: false, txHash: null, message, ledger });

/**
 * Why a movement did not touch the chain.
 *
 * Only ever appended to a *successful* result: a player is entitled to know
 * that the number that just changed is a number in their browser, and saying so
 * every time is the difference between a development build and a lie.
 */
const localNote = (config: ChainConfig) =>
  chainConfigured(config)
    ? `The ${TOKEN.ticker} contract is not deployed yet, so this moved locally.`
    : `${config.label} is not configured in this build, so this moved locally.`;

/** Who is asking, so a queued payout can be attributed and paid. */
export interface Steward {
  address: string | null;
  name: string;
  seed: number;
  worldName: string;
}

/**
 * Convert $EMERGE into Gold for a world's treasury.
 *
 * With a token deployed this is a real transfer from the player's wallet into
 * the vault, signed by them. It is the one movement in the game that is *not*
 * burned, and for a plain reason: this Gold is the player's own money, and the
 * withdrawal door has to be able to give it back. Burning it would mean taking
 * a deposit and having nothing to return.
 *
 * The transfer happens before the ledger moves, so a rejected signature costs
 * nothing and buys nothing.
 */
export async function deposit(
  ledger: VaultLedger,
  emerge: number,
  who: Steward,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<VaultResult> {
  const amount = Math.floor(emerge);
  if (!(amount > 0)) return refuse(ledger, 'Enter an amount to deposit.');
  if (amount > ledger.balance) return refuse(ledger, `Not enough ${TOKEN.ticker}.`);
  const gold = goldForEmerge(amount);
  if (gold < 0.01) {
    return refuse(ledger, `${EMERGE_PER_GOLD.toLocaleString()} ${TOKEN.ticker} buys 1 Gold.`);
  }

  const banked: VaultLedger = {
    ...ledger,
    balance: ledger.balance - amount,
    depositedGold: ledger.depositedGold + gold,
    principalGold: ledger.principalGold + gold,
  };

  if (!tokenLive(config)) {
    return {
      ok: true, settled: false, queued: false, txHash: null, ledger: banked,
      message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} for ${gold} Gold. ${localNote(config)}`,
    };
  }
  if (!who.address) return refuse(ledger, 'Connect a wallet to deposit.');
  if (!vaultLive(config)) {
    return refuse(ledger, 'The vault address is not configured in this build, so there is nowhere for a deposit to go.');
  }

  const sent = await transferTokens(who.address, VAULT_ADDRESS, amount, config);
  if (!sent.ok) return refuse(ledger, sent.message);

  // The chain is the authority once it exists. The optimistic figure is only
  // used if the read fails, and the balance poll corrects it either way.
  const fresh = await tokenBalance(who.address, config);
  return {
    ok: true, settled: true, queued: false, txHash: sent.txHash,
    ledger: { ...banked, balance: fresh ?? banked.balance },
    message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} into the vault for ${gold} Gold.`,
  };
}

/**
 * Take principal back out: Gold the player put in, converted to $EMERGE.
 *
 * Two ceilings, and both matter. The principal still standing, because this
 * door returns your own money and not the town's; and the treasury, because
 * you cannot take Gold out of a purse that does not hold it.
 *
 * With a token deployed this does not move tokens. It cannot: the vault is a
 * wallet, so somebody has to sign the transfer out of it. What it does is book
 * a request in the settlement queue and say so — the Gold leaves the treasury
 * immediately, because that is ours to move, and the tokens arrive when the
 * payout is sent. The burn share is not sent, and stays in the vault to be
 * burned deliberately rather than being counted as burned here.
 */
export async function withdraw(
  ledger: VaultLedger,
  gold: number,
  treasury: number,
  who: Steward,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<VaultResult> {
  const amount = Math.floor(gold);
  if (!(amount > 0)) return refuse(ledger, 'Enter an amount to withdraw.');
  if (amount > Math.floor(ledger.principalGold)) {
    return refuse(ledger, ledger.principalGold < 1
      ? `Nothing to withdraw here: this door returns Gold you deposited, and you have not deposited any. ${TOKEN.ticker} you earn by running the world is collected below.`
      : `You have ${Math.floor(ledger.principalGold)} Gold of principal standing. The settlement's own Gold stays in the settlement.`);
  }
  if (amount > Math.floor(treasury)) {
    return refuse(ledger, 'The treasury does not hold that much Gold.');
  }

  const quote = quoteWithdraw(amount);

  if (!tokenLive(config)) {
    return {
      ok: true, settled: false, queued: false, txHash: null,
      message: `Withdrew ${amount} Gold of principal for ${quote.received.toLocaleString()} ${TOKEN.ticker}, burning ${quote.burned.toLocaleString()}. ${localNote(config)}`,
      ledger: {
        ...ledger,
        balance: ledger.balance + quote.received,
        principalGold: ledger.principalGold - amount,
        withdrawnEmerge: ledger.withdrawnEmerge + quote.received,
        burnedEmerge: ledger.burnedEmerge + quote.burned,
      },
    };
  }

  if (!who.address) return refuse(ledger, 'Connect a wallet to withdraw.');
  const booked = await askForPayout({
    address: who.address, name: who.name, seed: who.seed, worldName: who.worldName,
    kind: 'principal', gold: amount, gross: quote.gross,
  });
  // Nothing is taken when the queue refuses: the principal is still standing
  // and the treasury still holds its Gold.
  if (!booked.ok) return refuse(ledger, booked.reason);

  return {
    ok: true, settled: false, queued: true, txHash: null,
    message: `Queued ${quote.received.toLocaleString()} ${TOKEN.ticker} for settlement from the vault. ${quote.burned.toLocaleString()} stays behind to be burned.`,
    ledger: {
      ...ledger,
      principalGold: ledger.principalGold - amount,
      pendingEmerge: ledger.pendingEmerge + quote.received,
      vaultBurn: ledger.vaultBurn + quote.burned,
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
 *
 * Like a withdrawal, it is paid out of the vault, so with a token deployed it
 * books a request rather than crediting a balance.
 */
export async function claimEarnings(
  ledger: VaultLedger,
  emerge: number,
  who: Steward,
  config: ChainConfig = ACTIVE_CHAIN,
): Promise<VaultResult> {
  const amount = Math.floor(emerge);
  if (!(amount > 0)) return refuse(ledger, 'Enter an amount to collect.');
  if (amount > Math.floor(ledger.earnedEmerge)) {
    return refuse(ledger, `You have earned ${Math.floor(ledger.earnedEmerge).toLocaleString()} ${TOKEN.ticker} here so far.`);
  }
  const burned = Math.round(amount * WITHDRAW_BURN_RATE);
  const received = amount - burned;

  if (!tokenLive(config)) {
    return {
      ok: true, settled: false, queued: false, txHash: null,
      message: `Collected ${received.toLocaleString()} ${TOKEN.ticker} of earnings, burning ${burned.toLocaleString()}. ${localNote(config)}`,
      ledger: {
        ...ledger,
        balance: ledger.balance + received,
        earnedEmerge: ledger.earnedEmerge - amount,
        withdrawnEmerge: ledger.withdrawnEmerge + received,
        burnedEmerge: ledger.burnedEmerge + burned,
      },
    };
  }

  if (!who.address) return refuse(ledger, 'Connect a wallet to collect earnings.');
  const booked = await askForPayout({
    address: who.address, name: who.name, seed: who.seed, worldName: who.worldName,
    kind: 'earnings', gold: 0, gross: amount,
  });
  if (!booked.ok) return refuse(ledger, booked.reason);

  return {
    ok: true, settled: false, queued: true, txHash: null,
    message: `Queued ${received.toLocaleString()} ${TOKEN.ticker} of earnings for settlement from the vault. ${burned.toLocaleString()} stays behind to be burned.`,
    ledger: {
      ...ledger,
      earnedEmerge: ledger.earnedEmerge - amount,
      pendingEmerge: ledger.pendingEmerge + received,
      vaultBurn: ledger.vaultBurn + burned,
    },
  };
}

/**
 * Charge a fee, and burn it.
 *
 * Nothing the game charges is collected by anybody. A claim, a survey, a
 * rename, a pull on the gacha: every one of them takes $EMERGE out of the
 * player's balance and out of circulation entirely. The project takes no cut,
 * and there is no treasury address for one to accumulate in — the only revenue
 * the token carries is the trading fee on the coin itself, which is nothing to
 * do with this file.
 *
 * That makes every action in the game deflationary, and it makes
 * `burnedEmerge` a real running total rather than a decoration.
 *
 * Returns null when the balance will not cover it.
 */
export function charge(ledger: VaultLedger, cost: number): VaultLedger | null {
  if (!(cost > 0)) return ledger;
  if (ledger.balance < cost) return null;
  return {
    ...ledger,
    balance: ledger.balance - cost,
    burnedEmerge: ledger.burnedEmerge + cost,
  };
}

/** Credit a sale or refund back to the local balance. */
export function credit(ledger: VaultLedger, amount: number): VaultLedger {
  return { ...ledger, balance: ledger.balance + amount };
}
