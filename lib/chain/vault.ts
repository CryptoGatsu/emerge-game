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
 * **Both directions are real transfers, and neither needs a person.**
 *
 * *Out of the player's wallet* is signed by the player: a deposit transfers to
 * the vault wallet, a charge transfers to the burn address.
 *
 * *Back into it* is signed by the vault, server-side, the moment it is asked
 * for. What makes that safe is that the server stopped believing this file.
 * Principal is credited only from deposits it verifies against the chain, so
 * principal out can never exceed principal in; earnings are capped per wallet
 * per day, gated on holding land, and held under a global budget. The numbers
 * below are what the player is shown — the numbers that move money are
 * recomputed on the server from the amount asked for.
 *
 * The withdrawal burn share is the one thing that does not move: it stays in
 * the vault, to be burned deliberately rather than sent anywhere.
 */

import { ERA_YIELD_STEP, eraYield, advanceCost, charterCost } from '../world/eras';
import {
  ACTIVE_CHAIN, TOKEN, VAULT_ADDRESS, chainConfigured, tokenBalance, tokenLive, transferTokens,
  vaultLive, type ChainConfig,
} from './emerge';
import { creditDeposit, withdrawFromVault } from '../net/payouts';
import { clientKey } from '../limits';

/** $EMERGE per unit of in-world Gold. */
export const EMERGE_PER_GOLD = 10_000;
/** Share of a withdrawal that is burned rather than returned. */
export const WITHDRAW_BURN_RATE = 0.1;
/** Renaming a world costs tokens, so a name means something. */
export const RENAME_COST_EMERGE = 100_000;
/** Renaming one of the beings who live there. */
export const RENAME_CITIZEN_EMERGE = 40_000;
/** Surveying a brand-new plot into existence. */
export const PROSPECT_COST_EMERGE = 240_000;
/** Changing your own name, after the first change, which is free. */
export const RENAME_PLAYER_EMERGE = 60_000;
/**
 * What it costs to expand a plot, once, opening its outer belt for building.
 * Burned like every other charge. Set high on purpose: it is the one thing a
 * player can buy that makes a plot itself bigger, and it should read as a
 * decision rather than an upgrade.
 */
export const EXPAND_COST_EMERGE = 1_000_000;
/**
 * What it costs to advance a plot to the next era. The same at every step,
 * burned, and only ever payable once the settlement has earned the step:
 * the gate is days lived and things built, and the charge is the last word.
 */
export const ADVANCE_COST_EMERGE = 1_000_000;
/** The step is dearer the further along it is: see advanceCost in world/eras. */
export { advanceCost, charterCost };

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
   * $EMERGE asked for and never paid.
   *
   * From the round when payouts waited for somebody to sign them. Nothing adds
   * to it any more — a withdrawal now either sends or refuses — but a ledger
   * saved back then may still carry a figure, and it is shown until it is
   * settled rather than quietly dropped.
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
  /** The share of this player's charges that stayed in the vault to pay withdrawals. */
  fundedEmerge: number;
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
export const EARNING_PLOT_LIMIT = 5;

/**
 * The most one player can mint in a real day, across every world they hold:
 * four settlements' worth, which is the same limit stated as a number.
 */
export const WALLET_DAILY_CEILING = 1_000_000;
export const DAILY_EARN_CEILING = WALLET_DAILY_CEILING;

/**
 * Where a charge goes.
 *
 * Every $EMERGE the game charges is paid into the vault in one transfer. The
 * vault then burns CHARGE_VAULT_SHARE's complement itself and keeps the rest,
 * so the same money that leaves players as charges is there to pay them as
 * withdrawals: a vault that only ever paid out would empty, and a game whose
 * charges only ever burned would have nothing to pay with. Three quarters
 * burned, a quarter kept.
 */
export const CHARGE_VAULT_SHARE = 0.25;
/**
 * The dividend: a share of every charge set aside, swapped into GLD once a
 * week and paid to the people who hold land and the people who hold the
 * token. The burn takes what is left, so the three add up to the charge.
 */
export const CHARGE_DIVIDEND_SHARE = 0.15;
export const CHARGE_BURN_SHARE = 1 - CHARGE_VAULT_SHARE - CHARGE_DIVIDEND_SHARE;
export const chargeSplit = (cost: number) => {
  const whole = Math.max(0, Math.floor(cost));
  const kept = Math.floor(whole * CHARGE_VAULT_SHARE);
  const dividend = Math.floor(whole * CHARGE_DIVIDEND_SHARE);
  return { whole, kept, dividend, burned: whole - kept - dividend };
};
/** How the dividend pool is shared out each week. */
export const DIVIDEND_LAND_SHARE = 0.55;
export const DIVIDEND_STAKE_SHARE = 0.15;
export const DIVIDEND_DEV_SHARE = 0.3;
/** Soft stake: a registered wallet's lowest balance through the week counts, above a floor and up to a cap. */
export const STAKE_MIN_EMERGE = 100_000;
export const STAKE_CAP_EMERGE = 5_000_000;

/** Boons: paid for in $EMERGE, applied to the world at once. */
export type BoonKind = 'settlers' | 'shipment' | 'restore' | 'monument' | 'banner';
export const BOON_COST_EMERGE: Record<BoonKind, number> = { settlers: 50_000, shipment: 40_000, restore: 100_000, monument: 250_000, banner: 100_000 };

/**
 * Rewards grow with the era.
 *
 * Each era a plot advances to lifts its daily ceiling by this share of the
 * base: a township earns up to 15% more than a settlement, an AI-era city up
 * to 60% more. Modest on purpose: the point is that developing a city is
 * worth more than claiming another, not that the emission doubles. The
 * multiplier is judged from the claim row, which only the gated, burn-verified
 * advance route can raise.
 */
export { ERA_YIELD_STEP, eraYield };
/** A charter on a plot: burned, for CHARTER_DAYS of a fifth more on its ceiling. */
/** Kept as the floor a charter never goes below. */
export const CHARTER_COST_EMERGE = 160_000;
/** Master builders on a plot: burned like the rest, for BUILDERS_DAYS of cheaper building. */
export const BUILDERS_COST_EMERGE = 120_000;
/** Insurance on a plot: burned, for INSURANCE_DAYS of half damage from trouble. */
export const INSURANCE_COST_EMERGE = 150_000;
/** A wallet's daily ceiling across its earning plots, at the highest era it holds. */
export const eraCeiling = (era: number) => Math.round(DAILY_EARN_CEILING * eraYield(era));

/*
 * Hired hands: earning without land.
 *
 * A player with no plot can take a job attending somebody else's, and is paid
 * a share of what that settlement's stewardship comes to while they are
 * actually watching it. The numbers are set so the door is real but narrow:
 * a wallet must hold at least `HAND_MIN_EMERGE` to be hired at all, so an
 * identity costs something to make; a hand takes `HAND_SHARE` of the plot's
 * yield, paid from the vault and never out of the owner's; and the ceiling per
 * hand per day is a tenth of a landholder's. One job per wallet, one hand per
 * plot, so the whole scheme cannot emit more than the plots in the game times
 * a small number — and the global daily budget caps it regardless.
 */
export const HAND_MIN_EMERGE = 50_000;
/** Opening a job for a hand costs the owner this, paid like any charge. */
export const HIRE_FEE_EMERGE = 10_000;
/** The registry's fee on a resale, paid by the buyer into the vault. */
export const RESALE_FEE_RATE = 0.05;
export const resaleFee = (price: number) => Math.ceil(price * RESALE_FEE_RATE);
/** Prestige: a monument in the square, and a banner on the world map. */
export const MONUMENT_COST_EMERGE = 250_000;
export const BANNER_COST_EMERGE = 100_000;
export const HAND_SHARE = 0.1;
export const HAND_DAILY_CEILING = 25_000;

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
  fundedEmerge: 0,
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
    fundedEmerge: Number(ledger?.fundedEmerge) || 0,
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
export function accrue(ledger: VaultLedger, emerge: number, ceiling = DAILY_EARN_CEILING): VaultLedger {
  if (!(emerge > 0)) return ledger;
  const today = todayKey();
  const spentToday = ledger.earnedOn === today ? ledger.earnedToday : 0;
  const room = Math.max(0, ceiling - spentToday);
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
/** How much a ledger will still take today against a given ceiling. */
export function earnRoom(ledger: VaultLedger, ceiling: number) {
  const spent = ledger.earnedOn === todayKey() ? ledger.earnedToday : 0;
  return Math.max(0, ceiling - spent);
}

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

const refuse = (ledger: VaultLedger, message: string): VaultResult =>
  ({ ok: false, settled: false, txHash: null, message, ledger });

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
      ok: true, settled: false, txHash: null, ledger: banked,
      message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} for ${gold} Gold. ${localNote(config)}`,
    };
  }
  if (!who.address) return refuse(ledger, 'Connect a wallet to deposit.');
  if (!vaultLive(config)) {
    return refuse(ledger, 'The vault address is not configured in this build, so there is nowhere for a deposit to go.');
  }

  const sent = await transferTokens(who.address, VAULT_ADDRESS, amount, config);
  if (!sent.ok) return refuse(ledger, sent.message);

  /*
   * Tell the server, so it can go and read the transfer off the chain.
   *
   * This is what makes the withdrawal door safe: the server credits principal
   * only from deposits it has verified itself, so what it will pay back is
   * bounded by what the chain says actually arrived. Until this lands, the
   * tokens are in the vault and the server does not know they are the player's.
   */
  const credited = await settleDeposit(who.address, sent.txHash!);

  // The chain is the authority once it exists. The optimistic figure is only
  // used if the read fails, and the balance poll corrects it either way.
  const fresh = await tokenBalance(who.address, config);
  const done: VaultLedger = { ...banked, balance: fresh ?? banked.balance };

  if (!credited.ok) {
    /*
     * The tokens moved but the credit did not. The Gold is still granted —
     * the player really did pay for it — and the transaction is kept so the
     * Bank can finish crediting it next time it opens. Losing a deposit
     * because a fetch failed after the transfer would be unforgivable.
     */
    rememberDeposit(who.address, sent.txHash!);
    return {
      ok: true, settled: true, txHash: sent.txHash, ledger: done,
      message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} for ${gold} Gold. ${credited.reason} Your deposit is safe and will be credited for withdrawal automatically.`,
    };
  }

  return {
    ok: true, settled: true, txHash: sent.txHash, ledger: done,
    message: `Deposited ${amount.toLocaleString()} ${TOKEN.ticker} into the vault for ${gold} Gold.`,
  };
}

/**
 * How long to keep asking the server to credit a deposit.
 *
 * The first attempt almost always comes back "the chain has not seen that
 * yet" — the node has the transaction but has not mined it. A handful of
 * tries a couple of seconds apart covers an ordinary block; anything longer
 * than that is not worth making somebody watch, and the retry on next open
 * catches it.
 */
const CREDIT_TRIES = 6;
const CREDIT_GAP_MS = 2_500;

async function settleDeposit(address: string, txHash: string) {
  for (let attempt = 0; attempt < CREDIT_TRIES; attempt++) {
    const result = await creditDeposit(address, txHash);
    // Already credited counts as credited: a retry finding its own earlier
    // success is the expected end of the loop, not a failure.
    if (result.ok || result.already) return { ok: true as const, reason: '' };
    if (!result.retry) return { ok: false as const, reason: result.reason };
    await new Promise((resolve) => setTimeout(resolve, CREDIT_GAP_MS));
  }
  return { ok: false as const, reason: 'The chain is taking a while to confirm it.' };
}

/* ------------------------------------------------------------------ *
 * Deposits waiting to be credited
 * ------------------------------------------------------------------ */

const pendingKey = (address: string) => clientKey(`deposits.${address.toLowerCase()}`);

/** Keep a deposit whose credit did not land, so it can be finished later. */
export function rememberDeposit(address: string, txHash: string): void {
  try {
    const held = pendingDeposits(address);
    if (held.includes(txHash)) return;
    window.localStorage.setItem(pendingKey(address), JSON.stringify([...held, txHash].slice(-20)));
  } catch { /* private browsing; the retry on next open is what is lost */ }
}

/** Deposits this browser knows about that the server has not confirmed. */
export function pendingDeposits(address: string): string[] {
  try {
    const raw = window.localStorage.getItem(pendingKey(address));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function forgetDeposit(address: string, txHash: string): void {
  try {
    const left = pendingDeposits(address).filter((h) => h !== txHash);
    if (left.length) window.localStorage.setItem(pendingKey(address), JSON.stringify(left));
    else window.localStorage.removeItem(pendingKey(address));
  } catch { /* as above */ }
}

/**
 * Finish crediting anything left over, and say how much landed.
 *
 * Called when the Bank opens. A deposit whose credit failed because the chain
 * had not caught up is the common case, and it costs a player nothing as long
 * as somebody eventually asks again — this is that.
 */
export async function creditPendingDeposits(address: string): Promise<number> {
  let credited = 0;
  for (const txHash of pendingDeposits(address)) {
    const result = await creditDeposit(address, txHash);
    if (result.ok) { credited += result.credited; forgetDeposit(address, txHash); }
    // A deposit the server will never accept is not worth asking about for
    // ever; only a "come back later" keeps its place in the queue.
    else if (!result.retry) forgetDeposit(address, txHash);
  }
  return credited;
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
      ok: true, settled: false, txHash: null,
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
  const paid = await withdrawFromVault({
    address: who.address, name: who.name, seed: who.seed, worldName: who.worldName,
    kind: 'principal', gold: amount, emerge: 0,
  });
  // Nothing is taken when the vault refuses: the principal is still standing
  // and the treasury still holds its Gold.
  if (!paid.ok) return refuse(ledger, paid.reason);

  /*
   * The tokens are in the player's wallet now, so the balance is re-read from
   * the chain rather than added to. `withdrawnEmerge` counts what was actually
   * received; `vaultBurn` counts the share that stayed behind, which still
   * exists and so is deliberately not called burned.
   */
  const fresh = await tokenBalance(who.address, config);
  return {
    ok: true, settled: true, txHash: paid.txHash,
    message: `Sent ${paid.payout.net.toLocaleString()} ${TOKEN.ticker} to your wallet. ${paid.payout.burned.toLocaleString()} stayed in the vault to be burned.`,
    ledger: {
      ...ledger,
      balance: fresh ?? ledger.balance + paid.payout.net,
      principalGold: ledger.principalGold - amount,
      withdrawnEmerge: ledger.withdrawnEmerge + paid.payout.net,
      vaultBurn: ledger.vaultBurn + paid.payout.burned,
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
      ok: true, settled: false, txHash: null,
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
  const paid = await withdrawFromVault({
    address: who.address, name: who.name, seed: who.seed, worldName: who.worldName,
    kind: 'earnings', gold: 0, emerge: amount,
  });
  if (!paid.ok) return refuse(ledger, paid.reason);

  const fresh = await tokenBalance(who.address, config);
  return {
    ok: true, settled: true, txHash: paid.txHash,
    message: `Sent ${paid.payout.net.toLocaleString()} ${TOKEN.ticker} of earnings to your wallet. ${paid.payout.burned.toLocaleString()} stayed in the vault to be burned.`,
    ledger: {
      ...ledger,
      balance: fresh ?? ledger.balance + paid.payout.net,
      earnedEmerge: ledger.earnedEmerge - amount,
      withdrawnEmerge: ledger.withdrawnEmerge + paid.payout.net,
      vaultBurn: ledger.vaultBurn + paid.payout.burned,
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
  // Booked the way the chain would book it: most burned, a share kept.
  const split = chargeSplit(cost);
  return {
    ...ledger,
    balance: ledger.balance - cost,
    burnedEmerge: ledger.burnedEmerge + split.burned,
    fundedEmerge: (ledger.fundedEmerge ?? 0) + split.kept + split.dividend,
  };
}

/** Credit a sale or refund back to the local balance. */
export function credit(ledger: VaultLedger, amount: number): VaultLedger {
  return { ...ledger, balance: ledger.balance + amount };
}
