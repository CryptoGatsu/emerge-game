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

import { BaseError, ContractFunctionRevertedError, decodeErrorResult, encodeAbiParameters, encodePacked, keccak256, type Abi, type Hex } from 'viem';

/**
 * Uniswap on Robinhood Chain (4663), as @uniswap/sdk-core and
 * @uniswap/universal-router-sdk publish it. Defaults for anything the
 * environment does not name.
 */
export const UNISWAP_ON_ROBINHOOD = {
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
  v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  v4Quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
} as const;

/** The v3 factory's pool lookup, and the v4 StateView's pool reads. */
export const V3_FACTORY = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] },
] as const;
/** A v3 pool's standing liquidity: a pool the factory knows can still be empty. */
export const V3_POOL = [
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const;
/** Native ETH, as v4 names it: a currency of no address. */
export const NATIVE: Hex = '0x0000000000000000000000000000000000000000';
export const V4_STATE_VIEW = [
  { type: 'function', name: 'getSlot0', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }] },
  { type: 'function', name: 'getLiquidity', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'liquidity', type: 'uint128' }] },
] as const;

/**
 * The v4 PositionManager remembers the key of every pool anybody has added
 * liquidity to through it, by the first 25 bytes of the pool's id: one call
 * where the PoolManager's events would take a scan of the chain.
 */
export const V4_POSITION_MANAGER = [
  {
    type: 'function', name: 'poolKeys', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes25' }],
    outputs: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }],
  },
] as const;

/** The PoolManager's record of every pool it has made: the one place a pool's key is written down. */
export const POOL_INITIALIZE = {
  type: 'event', name: 'Initialize',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'currency0', type: 'address', indexed: true }, { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24', indexed: false }, { name: 'tickSpacing', type: 'int24', indexed: false }, { name: 'hooks', type: 'address', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false }, { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

/** A v4 pool's id: the hash of its key, currencies in address order, no hooks. */
export function v4PoolId(a: Hex, b: Hex, fee: number, tickSpacing: number, hooks: Hex = '0x0000000000000000000000000000000000000000'): Hex {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [c0, c1, fee, tickSpacing, hooks],
  ));
}

/** Permit2's own transfer, the call the router makes to pay a swap. */
export const PERMIT2_TRANSFER = [
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'token', type: 'address' }], outputs: [] },
] as const;

/** Permit2, deployed at the same address on every chain Uniswap ships to. */
export const PERMIT2_ADDRESS: Hex = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** The Universal Router's command byte for a V3 exact-input swap. */
export const V3_SWAP_EXACT_IN = 0x00;
/** And for a V4 swap, whose input is a list of actions of its own. */
export const V4_SWAP = 0x10;
/** The v4 router actions a plain exact-input swap needs, from v4-periphery's Actions. */
export const V4_ACTIONS = { SWAP_EXACT_IN: 0x07, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;

/**
 * What the router and Permit2 can throw. Without these the client only
 * says `"execute" reverted`, which is what the casino showed a winner
 * whose GLD could not be bought; with them the reason has a name.
 */
export const ROUTER_ERRORS = [
  { type: 'error', name: 'ExecutionFailed', inputs: [{ name: 'commandIndex', type: 'uint256' }, { name: 'message', type: 'bytes' }] },
  { type: 'error', name: 'TransactionDeadlinePassed', inputs: [] },
  { type: 'error', name: 'ETHNotAccepted', inputs: [] },
  { type: 'error', name: 'LengthMismatch', inputs: [] },
  { type: 'error', name: 'InvalidCommandType', inputs: [{ name: 'commandType', type: 'uint256' }] },
  { type: 'error', name: 'BalanceTooLow', inputs: [] },
  { type: 'error', name: 'InvalidBips', inputs: [] },
  { type: 'error', name: 'InvalidReserves', inputs: [] },
  { type: 'error', name: 'InvalidPath', inputs: [] },
  { type: 'error', name: 'V2TooLittleReceived', inputs: [] },
  { type: 'error', name: 'V2TooMuchRequested', inputs: [] },
  { type: 'error', name: 'V3TooLittleReceived', inputs: [] },
  { type: 'error', name: 'V3TooMuchRequested', inputs: [] },
  { type: 'error', name: 'V3InvalidSwap', inputs: [] },
  { type: 'error', name: 'V3InvalidCaller', inputs: [] },
  { type: 'error', name: 'V3InvalidAmountOut', inputs: [] },
  { type: 'error', name: 'V4TooLittleReceived', inputs: [{ name: 'minAmountOutReceived', type: 'uint256' }, { name: 'amountReceived', type: 'uint256' }] },
  { type: 'error', name: 'V4TooMuchRequested', inputs: [{ name: 'maxAmountInRequested', type: 'uint256' }, { name: 'amountRequested', type: 'uint256' }] },
  { type: 'error', name: 'InsufficientToken', inputs: [] },
  { type: 'error', name: 'InsufficientETH', inputs: [] },
  { type: 'error', name: 'FromAddressIsNotOwner', inputs: [] },
  { type: 'error', name: 'ContractLocked', inputs: [] },
  { type: 'error', name: 'InputLengthMismatch', inputs: [] },
  { type: 'error', name: 'UnsupportedAction', inputs: [{ name: 'action', type: 'uint256' }] },
  { type: 'error', name: 'NotPoolManager', inputs: [] },
  { type: 'error', name: 'CurrencyNotSettled', inputs: [] },
  { type: 'error', name: 'PoolNotInitialized', inputs: [] },
  { type: 'error', name: 'DeltaNotPositive', inputs: [{ name: 'currency', type: 'address' }] },
  { type: 'error', name: 'DeltaNotNegative', inputs: [{ name: 'currency', type: 'address' }] },
  { type: 'error', name: 'ManagerLocked', inputs: [] },
  { type: 'error', name: 'UnsafeCast', inputs: [] },
  // The quoters wrap the pool's revert in one of their own.
  { type: 'error', name: 'UnexpectedRevertBytes', inputs: [{ name: 'revertData', type: 'bytes' }] },
  { type: 'error', name: 'NotEnoughLiquidity', inputs: [{ name: 'poolId', type: 'bytes32' }] },
  { type: 'error', name: 'NotSelf', inputs: [] },
  { type: 'error', name: 'UnexpectedCallSuccess', inputs: [] },
  // Permit2
  { type: 'error', name: 'AllowanceExpired', inputs: [{ name: 'deadline', type: 'uint256' }] },
  { type: 'error', name: 'InsufficientAllowance', inputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'error', name: 'InvalidNonce', inputs: [] },
  { type: 'error', name: 'SignatureExpired', inputs: [{ name: 'signatureDeadline', type: 'uint256' }] },
  // ERC-20s that use custom errors
  { type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ name: 'sender', type: 'address' }, { name: 'balance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
  { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [{ name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
] as const;

/** Revert bytes, in words: the error's name and arguments, nested through the router's wrapper. */
export function explainRevertData(raw: Hex | undefined): string {
  if (!raw || raw === '0x') return 'reverted without a reason (the node returned no revert data: a v3 call to a pool that is not there does this, and so does a node that strips reasons)';
  try {
    // Widened: viem also decodes Solidity's own Error(string) and Panic, which
    // the typed ABI does not name.
    const decoded = decodeErrorResult({ abi: ROUTER_ERRORS as unknown as Abi, data: raw }) as { errorName: string; args?: readonly unknown[] };
    if (decoded.errorName === 'ExecutionFailed') {
      const [index, inner] = decoded.args as readonly [bigint, Hex];
      return `ExecutionFailed at command ${index}: ${explainRevertData(inner)}`;
    }
    if (decoded.errorName === 'UnexpectedRevertBytes') {
      return `the quoter's pool call reverted: ${explainRevertData(decoded.args?.[0] as Hex)}`;
    }
    if (decoded.errorName === 'Error') return `"${String(decoded.args?.[0] ?? '')}"`;
    const args = (decoded.args ?? []).map((a) => String(a)).join(', ');
    return args ? `${decoded.errorName}(${args})` : decoded.errorName;
  } catch {
    return `revert data ${raw.slice(0, 10)}… (${(raw.length - 2) / 2} bytes)`;
  }
}

/** What a viem call error means, for a log line or a player's screen. */
export function explainRevert(error: unknown): string {
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : String(error).slice(0, 160);
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!reverted) return error.shortMessage.split('\n')[0].slice(0, 160);
  return explainRevertData(reverted.raw ?? (reverted.data ? undefined : '0x'));
}

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
  /** One tick spacing per hop, for v4 pools; the usual spacing for the fee unless the route says. */
  ticks: number[];
  /** One hook per hop, for v4 pools a launchpad made; none unless the route says. */
  hooks: Hex[];
  /** The tokens passed through between the ends, one fewer than the fees. */
  via: Hex[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const FEE_TIERS = new Set([100, 500, 3000, 10000]);
/** The tick spacing each standard fee tier was created with. */
const TICK_FOR_FEE: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/**
 * Read a route out of `EMERGE_SWAP_PATH`: fees and the tokens between them,
 * comma-separated, starting and ending with a fee. `3000` is one hop at
 * 0.3%; `3000,0xUSDG…,3000` sells into USDG and buys GLD with it. Nothing
 * set means one hop at `fallbackFee`.
 */
export function parseRoute(spec: string | undefined, fallbackFee = 3000): Route {
  const parts = (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) { const fee = FEE_TIERS.has(fallbackFee) ? fallbackFee : 3000; return { fees: [fee], ticks: [TICK_FOR_FEE[fee]], hooks: [NATIVE], via: [] }; }
  const fees: number[] = [];
  const ticks: number[] = [];
  const hooks: Hex[] = [];
  const via: Hex[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      // `3000` is a standard tier; `3000/60` names the tick spacing too,
      // which a v4 pool made with an unusual fee needs; `3000/60/0xHook`
      // names the hook a launchpad attached. A dynamic-fee pool is written
      // with its flag, 8388608, as the fee.
      const [feeText, tickText, hookText] = part.split('/');
      const fee = Number(feeText);
      if (!Number.isInteger(fee) || fee < 0 || fee > 0x800000) throw new Error(`Not a fee: ${part}`);
      const tick = tickText !== undefined ? Number(tickText) : TICK_FOR_FEE[fee];
      if (!Number.isInteger(tick) || tick <= 0) throw new Error(`No tick spacing for fee ${fee}: write it as ${fee}/<spacing>`);
      if (hookText !== undefined && !ADDRESS.test(hookText)) throw new Error(`Not a hook address: ${hookText}`);
      fees.push(fee); ticks.push(tick); hooks.push((hookText ?? NATIVE) as Hex);
    } else {
      if (!ADDRESS.test(part)) throw new Error(`Not a token address: ${part}`);
      via.push(part as Hex);
    }
  });
  if (parts.length % 2 === 0) throw new Error('A route starts and ends with a fee.');
  return { fees, ticks, hooks, via };
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

/** A v4 path key per hop: the currency arrived at, and the pool it is reached through. */
export interface PathKey { intermediateCurrency: Hex; fee: number; tickSpacing: number; hooks: Hex; hookData: Hex }
const NO_HOOKS: Hex = '0x0000000000000000000000000000000000000000';

export function v4PathKeys(route: Route, tokenOut: Hex): PathKey[] {
  const arrivals = [...route.via, tokenOut];
  if (arrivals.length !== route.fees.length) throw new Error('The route does not fit its tokens.');
  return arrivals.map((currency, i) => ({ intermediateCurrency: currency, fee: route.fees[i], tickSpacing: route.ticks[i], hooks: route.hooks?.[i] ?? NO_HOOKS, hookData: '0x' }));
}

const PATH_KEY = { type: 'tuple', components: [
  { name: 'intermediateCurrency', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }, { name: 'hookData', type: 'bytes' },
] } as const;

/**
 * One `execute` call that swaps `amountIn` of `tokenIn` along v4 pools: swap
 * exact-in along the path, settle the whole input from the caller through
 * Permit2, take every unit of the output to the caller.
 */
export function universalSwapV4(tokenIn: Hex, amountIn: bigint, minOut: bigint, path: PathKey[]): { commands: Hex; inputs: Hex[] } {
  const tokenOut = path[path.length - 1].intermediateCurrency;
  const actions = `0x${[V4_ACTIONS.SWAP_EXACT_IN, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL].map((a) => a.toString(16).padStart(2, '0')).join('')}` as Hex;
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'currencyIn', type: 'address' }, { ...PATH_KEY, name: 'path', type: 'tuple[]' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }] }],
    [{ currencyIn: tokenIn, path, amountIn, amountOutMinimum: minOut }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenIn, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenOut, minOut]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  return { commands: `0x${V4_SWAP.toString(16).padStart(2, '0')}` as Hex, inputs: [input] };
}

/** The v4 quoter's exact-input quote, simulated rather than sent. */
export const V4_QUOTER = [
  {
    type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'exactCurrency', type: 'address' }, { ...PATH_KEY, name: 'path', type: 'tuple[]' }, { name: 'exactAmount', type: 'uint128' },
    ] }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;
