/*
 * What this device can afford to draw.
 *
 * A phone runs the same scene a desktop does, and left to itself it will draw
 * it the same way: full resolution, sixty frames a second, a full-screen bloom
 * pass and every particle pool at capacity. That is how a phone gets hot in
 * ten minutes. So the renderer is handed a tier at boot — read off the
 * device, never guessed from the screen size alone — and every cost that can
 * scale scales with it: the backing store, the frame cap, the size of every
 * particle pool, and whether the frame pass blooms at all.
 *
 * The tier is a starting point. A governor in the scene watches how long
 * frames actually take and sheds load when they run over, so a desktop with a
 * weak integrated GPU ends up where it should be too.
 */

export type QualityTier = 'high' | 'medium' | 'low';

export interface Quality {
  tier: QualityTier;
  /** Backing-store scale, as a fraction of the device pixel ratio the page is shown at. */
  resolution: number;
  /** Frames per second the ticker is capped to; 0 leaves it to the display. */
  maxFPS: number;
  /** Multiplier on every particle pool and spawn rate. */
  particles: number;
  /** The bloom taps in the frame pass: the one thing there that costs real fill rate. */
  bloom: boolean;
  /** The edge softening in the frame pass. */
  soften: boolean;
  /** Puddles and snow patches on the ground, at most. */
  decals: number;
  /** Drifting fog, cloud shadows and light rays: three more screen-sized quads. */
  sky: boolean;
}

const PRESETS: Record<QualityTier, Omit<Quality, 'tier' | 'resolution'>> = {
  high: { maxFPS: 0, particles: 1, bloom: true, soften: true, decals: 260, sky: true },
  medium: { maxFPS: 30, particles: 0.6, bloom: true, soften: true, decals: 160, sky: true },
  low: { maxFPS: 30, particles: 0.35, bloom: false, soften: false, decals: 90, sky: false },
};

/** A tier the player chose by hand, if they did. */
export function storedTier(): QualityTier | 'auto' {
  try {
    const v = localStorage.getItem('emerge.quality');
    return v === 'high' || v === 'medium' || v === 'low' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function storeTier(tier: QualityTier | 'auto') {
  try {
    if (tier === 'auto') localStorage.removeItem('emerge.quality');
    else localStorage.setItem('emerge.quality', tier);
  } catch { /* no storage */ }
}

/** What the device says about itself, reduced to a tier. */
export function detectTier(): QualityTier {
  if (typeof window === 'undefined') return 'high';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  if (reduced) return 'low';
  if (coarse) return cores <= 4 || memory <= 3 ? 'low' : 'medium';
  return cores <= 2 ? 'medium' : 'high';
}

/**
 * The tier's settings for this display.
 *
 * The backing store is the one setting that has to know the device pixel
 * ratio. Pixel art survives one thing only: an integer number of device
 * pixels per texel. So the store is never scaled to an arbitrary fraction —
 * on the low tier a 3x phone draws at 1.5x and is shown at exactly two device
 * pixels per store pixel, which is crisp; 1.3x would be a shimmer.
 */
export function qualityFor(tier: QualityTier, dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1): Quality {
  const preset = PRESETS[tier];
  const capped = Math.min(2, dpr);
  const resolution = tier === 'low' && dpr >= 2 ? dpr / 2 : capped;
  return { tier, resolution, ...preset };
}

export function detectQuality(): Quality {
  const chosen = storedTier();
  return qualityFor(chosen === 'auto' ? detectTier() : chosen);
}
