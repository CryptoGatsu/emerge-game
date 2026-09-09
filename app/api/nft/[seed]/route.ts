/**
 * A plot's token metadata, as OpenSea and every wallet read it.
 *
 * `tokenURI(seed)` on the land contract points here. The name is what its
 * owner called the world, the picture is drawn from the land itself, and
 * the attributes are what the settlement has become — so the token is a
 * living record of the plot, not a stock image.
 */

import { NextResponse } from 'next/server';
import { biomeKindFor, biomeProfile } from '@/lib/world/biomes';
import { ERAS } from '@/lib/world/eras';
import { claimOf, readWorld } from '@/lib/server/registry';
import { holderOnChain, nftLive } from '@/lib/server/nft';

export const dynamic = 'force-dynamic';

const origin = (request: Request) => {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, '');
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};

export async function GET(request: Request, context: { params: Promise<{ seed: string }> }) {
  const { seed: raw } = await context.params;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed <= 0) return NextResponse.json({ error: 'No such plot.' }, { status: 404 });
  const claim = await claimOf(seed).catch(() => null);
  let holder: string | null = null;
  if (!claim && nftLive()) holder = await holderOnChain(seed).catch(() => null);
  if (!claim && !holder) return NextResponse.json({ error: 'Nobody holds that plot.' }, { status: 404 });
  const world = await readWorld(seed).catch(() => null);
  const biome = biomeProfile(biomeKindFor(seed));
  const era = claim?.era ?? 1;
  const base = origin(request);
  const name = claim ? `${claim.worldName} · ${claim.region}` : `Plot #${seed}`;
  const attributes: { trait_type: string; value: string | number; display_type?: string }[] = [
    { trait_type: 'Biome', value: biome.label },
    { trait_type: 'Region', value: claim?.region ?? 'Unnamed' },
    { trait_type: 'Era', value: ERAS[Math.max(0, Math.min(ERAS.length - 1, era - 1))]?.name ?? 'Settlement' },
    { trait_type: 'Expanded', value: claim?.expandedAt ? 'Yes' : 'No' },
  ];
  if (world) {
    if (typeof world.level === 'number') attributes.push({ trait_type: 'City level', value: world.level, display_type: 'number' });
    attributes.push({ trait_type: 'Population', value: world.population, display_type: 'number' });
    if (typeof world.buildings === 'number') attributes.push({ trait_type: 'Buildings', value: world.buildings, display_type: 'number' });
    attributes.push({ trait_type: 'Days settled', value: world.day, display_type: 'number' });
  }
  if (claim?.banner) attributes.push({ trait_type: 'Banner', value: claim.banner });
  if (claim?.at) attributes.push({ trait_type: 'Claimed', value: Math.floor(claim.at / 1000), display_type: 'date' });
  const body = {
    name,
    description: claim
      ? `${claim.worldName}, a settlement on ${claim.region} in the ${biome.label.toLowerCase()} of Emerge. ${biome.blurb} Holding this token holds the land: the world, its people and its buildings go with it, and it earns its holder's share of the game's dividends.`
      : `A plot of Emerge land on the ${biome.label.toLowerCase()}.`,
    image: `${base}/api/nft/${seed}/image`,
    external_url: `${base}/?plot=${seed}`,
    attributes,
  };
  return NextResponse.json(body, { headers: { 'cache-control': 'public, max-age=300, s-maxage=300' } });
}
