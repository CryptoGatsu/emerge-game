/** A plot's picture, drawn from its own land. See `lib/server/plotImage.ts`. */

import { NextResponse } from 'next/server';
import { plotImage } from '@/lib/server/plotImage';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request: Request, context: { params: Promise<{ seed: string }> }) {
  const { seed: raw } = await context.params;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed <= 0) return NextResponse.json({ error: 'No such plot.' }, { status: 404 });
  try {
    const svg = await plotImage(seed);
    if (!svg) return NextResponse.json({ error: 'No such plot.' }, { status: 404 });
    return new NextResponse(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=600, s-maxage=600' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'The picture could not be drawn.' }, { status: 500 });
  }
}
