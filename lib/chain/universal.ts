/**
 * Uniswap's Universal Router, the shape the vault's dividend swap has to
 * take on Robinhood Chain.
 *
 * The router the Uniswap app trades through there is the Universal Router:
 * one `execute(commands, inputs, deadline)` call carrying encoded commands,
 * with no `swapExactTokensForTokens` and no `exactInputSingle` on it. And
 * GLD's pool is against USDG, not against $EMERGE, so the trade is routed:
 * $EMERGE into the pool it trades in, then on into GLD, as one V3 exact-input
 * swap along a packed path.
 *
 * Pure encoding, no chain access, so the harness can check every byte.
 */

import { encodeAbiParameters, encodePacked, type Hex } from 'viem';

/** Permit2, deployed at the same address on every chain Uniswap ships to. */
export const PERMIT2_ADDRESS: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** The Universal Router's command byte for a V3 exact-input swap. */
export const V3_SWAP_EXACT_IN = 0x00;

export const UNIVERSAL_ROUTER = [
  {
    type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }],
    outputs: [],
  },
] as const;

export const PERMIT2 = [
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
    outputs: [],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
] as const;

/**
 * QuoterV2's `quoteExactInput`, declared `view` so it can be read with a
 * plain call: it is written as a state-changing function that reverts with
 * the answer, and every client calls it rather than sending it.
 */
export const QUOTER_V2 = [
  {
    type: 'function', name: 'quoteExactInput', stateMutability: 'view',
    inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [
      { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export interface Route {
  /** One fee tier per hop, in hundredths of a basis point: 500, 3000, 10000. */
  fees: number[];
  /** The tokens passed through between the ends, one fewer than the fees. */
  via: Hex[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FEE_TIERS = new Set([100, 500, 3000, 10000]);

/**
 * Read a route out of `EMERGE_SWAP_PATH`: fees and the tokens between them,
 * comma-separated, starting and ending with a fee. `3000` is one hop at
 * 0.3%; `3000,0xUSDG…,3000` sells into USDG and buys GLD with it. Nothing
 * set means one hop at `fallbackFee`.
 */
export function parseRoute(spec: string | undefined, fallbackFee = 3000): Route {
  const parts = (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { fees: [FEE_TIERS.has(fallbackFee) ? fallbackFee : 3000], via: [] };
  const fees: number[] = [];
  const via: Hex[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      const fee = Number(part);
      if (!FEE_TIERS.has(fee)) throw new Error(`Not a fee tier: ${part}`);
      fees.push(fee);
    } else {
      if (!ADDRESS.test(part)) throw new Error(`Not a token address: ${part}`);
      via.push(part as Hex);
    }
  });
  if (parts.length % 2 === 0) throw new Error('A route starts and ends with a fee.');
  return { fees, via };
}

/** The packed V3 path: token, fee, token, fee, … token. */
export function v3Path(tokenIn: Hex, route: Route, tokenOut: Hex): Hex {
  const tokens = [tokenIn, ...route.via, tokenOut];
  if (tokens.length !== route.fees.length + 1) throw new Error('The route does not fit its tokens.');
  const types: ('address' | 'uint24')[] = [];
  const values: (Hex | number)[] = [];
  tokens.forEach((token, i) => {
    types.push('address'); values.push(token);
    if (i < route.fees.length) { types.push('uint24'); values.push(route.fees[i]); }
  });
  return encodePacked(types, values);
}

/**
 * One `execute` call that swaps `amountIn` along `path` to `recipient`,
 * paid out of the caller's own balance through Permit2 (`payerIsUser`), so
 * the tokens never sit in the router where anybody could sweep them.
 */
export function universalSwap(recipient: Hex, amountIn: bigint, minOut: bigint, path: Hex): { commands: Hex; inputs: Hex[] } {
  const inputs = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [recipient, amountIn, minOut, path, true],
  );
  return { commands: `0x${V3_SWAP_EXACT_IN.toString(16).padStart(2, '0')}` as Hex, inputs: [inputs] };
}
