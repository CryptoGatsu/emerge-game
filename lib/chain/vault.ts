/**
 * The $EMERGE vault.
 *
 * The bridge between the token and the world's Gold. Deposits fund a
 * settlement's treasury; a settlement that runs a surplus can be drawn back out
 * to $EMERGE, minus a burn.
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
  depositedGold: number;
  withdrawnEmerge: number;
  burnedEmerge: number;
}

export const NEW_LEDGER: VaultLedger = {
  balance: LOCAL_TEST_ALLOCATION,
  depositedGold: 0,
  withdrawnEmerge: 0,
  burnedEmerge: 0,
};

/** Tolerate ledgers saved before this feature existed. */
export function normaliseLedger(ledger: Partial<VaultLedger> | undefined | null): VaultLedger {
  return {
    balance: Number.isFinite(ledger?.balance) ? Number(ledger!.balance) : LOCAL_TEST_ALLOCATION,
    depositedGold: Number(ledger?.depositedGold) || 0,
    withdrawnEmerge: Number(ledger?.withdrawnEmerge) || 0,
    burnedEmerge: Number(ledger?.burnedEmerge) || 0,
  };
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
    },
  };
}

/** Convert a world's Gold back into $EMERGE, burning a share of it. */
export function withdraw(ledger: VaultLedger, gold: number, treasury: number, config: ChainConfig = ACTIVE_CHAIN): VaultResult {
  const amount = Math.floor(gold);
  if (!(amount > 0)) {
    return { ok: false, settled: false, txHash: null, message: 'Enter an amount to withdraw.', ledger };
  }
  if (amount > Math.floor(treasury)) {
    return { ok: false, settled: false, txHash: null, message: 'The treasury does not hold that much Gold.', ledger };
  }
  const quote = quoteWithdraw(amount);
  return {
    ok: true,
    settled: false,
    txHash: null,
    message: `Withdrew ${amount} Gold for ${quote.received.toLocaleString()} ${TOKEN.ticker}, burning ${quote.burned.toLocaleString()}. ${unsettledNote(config)}`,
    ledger: {
      ...ledger,
      balance: ledger.balance + quote.received,
      withdrawnEmerge: ledger.withdrawnEmerge + quote.received,
      burnedEmerge: ledger.burnedEmerge + quote.burned,
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
