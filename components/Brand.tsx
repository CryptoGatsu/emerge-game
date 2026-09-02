'use client';

/**
 * The mark, wherever it appears.
 *
 * One component rather than a copy of the markup in each place, because the
 * mark is the thing people recognise the game by, and three near-identical
 * versions of it is how it stops being one mark.
 *
 * It has two forms, and which one is used is a question of size rather than
 * taste. The logo is 1254px of pixel art: an island, a building with lit
 * windows, trees, water, a wordmark. Below about 64px none of that survives —
 * nearest-neighbour downscaling turns it to a dark smudge, and smoothing turns
 * it to a blur. So small marks are drawn as the logo reduced to what actually
 * reads at that size: the disc, its ring, and the sparkle. Above it, the real
 * thing, rendered `pixelated` because that is what it is.
 */

import Image from 'next/image';

/** The size below which the reduced form is drawn instead of the artwork. */
const REDUCTION_BELOW = 64;

export function BrandMark({ size = 42 }: { size?: number }) {
  if (size < REDUCTION_BELOW) {
    return (
      <svg
        className="brand-roundel"
        viewBox="0 0 32 32"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <circle cx="16" cy="16" r="15" fill="#011a11" />
        <circle cx="16" cy="16" r="14.2" fill="none" stroke="#b8e756" strokeWidth="1.3" />
        <path d="M16 5.5 17.9 14.1 26.5 16 17.9 17.9 16 26.5 14.1 17.9 5.5 16 14.1 14.1Z" fill="#b8e756" />
      </svg>
    );
  }
  return (
    <Image
      className="brand-roundel"
      src="/emerge-logo.png"
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

/** The mark with the wordmark beside it, as the headers carry it. */
export function BrandLine({ size = 42 }: { size?: number }) {
  return (
    <div className="brand-line">
      <BrandMark size={size} />
      <div>
        <div className="wordmark">EMERGE</div>
        <div className="tagline">THE AI WORLD</div>
      </div>
    </div>
  );
}
