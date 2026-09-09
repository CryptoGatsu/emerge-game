/**
 * Plots as tokens: the operator's door and the cron's.
 *
 * `GET /api/nft` — status, public: whether plots are tokens, how many are
 * minted, what is queued, what royalties wait to be swept.
 *
 * `GET /api/nft?check=1` with the cron secret — the launch pre-flight, as
 * plain text: the chain, the contracts, the vault and this build all agree.
 *
 * `GET /api/nft?sync=1` with the cron secret — bring the rows into line with
 * the chain, mint what is queued, sweep royalties into the vault and the
 * holders' pool. Runs every quarter hour from `vercel.json`.
 *
 * `POST /api/nft` with the cron secret — `{ airdrop: true }` mints every
 * plot anybody holds to them; `{ sync: true }`, `{ mint: true }`,
 * `{ sweep: true }` run one step each; `{ transfers: true }` lists the last
 * moves the sync made.
 */

import { NextResponse } from 'next/server';
import { operator } from '@/lib/server/operator';
import { preflight } from '@/lib/server/preflight';
import { airdrop, flushMints, nftLive, nftStatus, recentTransfers, royaltyBook, sweepRoyalties, syncOwners } from '@/lib/server/nft';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('check')) {
    if (!operator(request)) return NextResponse.json({ error: 'Not for this door.' }, { status: 401 });
    const base = (process.env.NEXT_PUBLIC_SITE_URL ?? `${url.protocol}//${url.host}`).replace(/\/$/, '');
    const report = await preflight(base);
    const text = report.lines.map((l) => `${l.ok ? 'ok  ' : 'FAIL'}  ${l.what}${l.detail ? `  ${l.detail}` : ''}`).join('\n') + `\n\n${report.ok ? 'Everything agrees.' : 'Fix the FAIL lines before minting.'}\n`;
    return new NextResponse(text, { status: report.ok ? 200 : 409, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (url.searchParams.get('sync')) {
    if (!operator(request)) return NextResponse.json({ error: 'Not for this door.' }, { status: 401 });
    if (!nftLive()) return NextResponse.json({ live: false });
    const synced = await syncOwners().catch((e: unknown) => ({ problem: e instanceof Error ? e.message : 'sync failed' }));
    const minted = await flushMints().catch((e: unknown) => ({ problem: e instanceof Error ? e.message : 'mint failed' }));
    const swept = await sweepRoyalties().catch((e: unknown) => ({ problem: e instanceof Error ? e.message : 'sweep failed' }));
    return NextResponse.json({ live: true, synced, minted, swept });
  }
  try {
    return NextResponse.json(await nftStatus());
  } catch (error) {
    return NextResponse.json({ live: nftLive(), error: error instanceof Error ? error.message : 'status failed' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  if (!operator(request)) return NextResponse.json({ error: 'Not for this door.' }, { status: 401 });
  let body: { airdrop?: boolean; sync?: boolean; mint?: boolean; sweep?: boolean; transfers?: boolean; royalties?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Expected JSON.' }, { status: 400 }); }
  if (!nftLive()) return NextResponse.json({ error: 'Plots are not tokens on this build: NEXT_PUBLIC_EMERGE_REGISTRY is not set.' }, { status: 409 });
  try {
    if (body.airdrop) return NextResponse.json(await airdrop());
    if (body.sync) return NextResponse.json(await syncOwners());
    if (body.mint) return NextResponse.json(await flushMints());
    if (body.sweep) return NextResponse.json(await sweepRoyalties());
    if (body.transfers) return NextResponse.json({ transfers: await recentTransfers() });
    if (body.royalties) return NextResponse.json(await royaltyBook());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'failed' }, { status: 502 });
  }
  return NextResponse.json({ error: 'Nothing asked for.' }, { status: 400 });
}
