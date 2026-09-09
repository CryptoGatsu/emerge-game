/** Collection-level metadata, which OpenSea reads from the land contract's `contractURI()`. */

import { NextResponse } from 'next/server';
import { ROYALTIES_ADDRESS, ROYALTY_BPS } from '@/lib/chain/plots';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  const url = new URL(request.url);
  const base = (configured ?? `${url.protocol}//${url.host}`).replace(/\/$/, '');
  return NextResponse.json({
    name: 'Emerge Land',
    description: 'The plots of Emerge, an AI life-sim on Robinhood Chain. Each token is a plot whose id is the seed that grows its land; holding the token holds the settlement on it, and every resale pays a share back to the people who hold land.',
    image: `${base}/emerge-logo.png`,
    external_link: base,
    ...(ROYALTIES_ADDRESS ? { seller_fee_basis_points: ROYALTY_BPS, fee_recipient: ROYALTIES_ADDRESS } : {}),
  }, { headers: { 'cache-control': 'public, max-age=3600' } });
}
