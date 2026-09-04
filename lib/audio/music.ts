/**
 * The soundtrack.
 *
 * Six loops, one for each mood the game has: the settlement by day, dusk
 * round the fire, night, danger, the world map, and somebody else's town.
 * Which one plays is a function of where the player is and what the world
 * is doing, decided a few times a second and crossfaded when it changes, so
 * a tornado arriving or the sun going down is heard as well as seen.
 *
 * One shared player rather than one per screen: the map and a world are
 * different screens but the same session, and a track that restarted every
 * time the player stepped between them would never get past its intro.
 *
 * Browsers will not play audio nobody asked for, so nothing starts until the
 * player presses the note. The choice is remembered, and once they have
 * pressed it once in a session the switch between screens is free.
 */

export type MusicMode = 'none' | 'settlement' | 'dusk' | 'night' | 'danger' | 'map' | 'visiting';

const TRACKS: Record<Exclude<MusicMode, 'none'>, string> = {
  settlement: '/music/settlement.mp3',
  dusk: '/music/dusk.mp3',
  night: '/music/night.mp3',
  danger: '/music/danger.mp3',
  map: '/music/world-map.mp3',
  visiting: '/music/visiting.mp3',
};

/** How loud the music sits under the world's own sounds. */
const LEVEL = 0.32;
/** Seconds to fade one track out and the next in. */
const FADE = 1.8;
const KEY = 'emerge.music.v1';

/** The mood for a world at this hour with these dangers. */
export function moodFor(hour: number, inDanger: boolean, visiting: boolean): MusicMode {
  if (inDanger) return 'danger';
  if (visiting) return 'visiting';
  if (hour >= 21 || hour < 5) return 'night';
  if (hour >= 17) return 'dusk';
  return 'settlement';
}

class Music {
  private current: HTMLAudioElement | null = null;
  private mode: MusicMode = 'none';
  private wanted: MusicMode = 'none';
  private on = false;
  private fades = new Set<number>();
  private listeners = new Set<(on: boolean) => void>();

  constructor() {
    if (typeof window === 'undefined') return;
    try { this.on = window.localStorage.getItem(KEY) === 'on'; } catch { /* no storage */ }
  }

  get enabled() { return this.on; }

  /** Watch the switch, for buttons on more than one screen. */
  subscribe(listener: (on: boolean) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Turn the music on or off. Call from a click: that is what lets it play at all. */
  set(on: boolean) {
    this.on = on;
    try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* no storage */ }
    for (const l of this.listeners) l(on);
    if (on) this.play(this.wanted); else this.play('none');
  }

  toggle() { this.set(!this.on); }

  /** Say what should be playing. Plays it if the music is on; remembers it if not. */
  want(mode: MusicMode) {
    this.wanted = mode;
    if (this.on) this.play(mode);
  }

  private play(mode: MusicMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const old = this.current;
    this.current = null;
    if (old) this.fadeOut(old);
    if (mode === 'none' || typeof window === 'undefined') return;
    const el = new Audio(TRACKS[mode]);
    el.loop = true;
    el.volume = 0;
    el.preload = 'auto';
    this.current = el;
    el.play().then(() => this.fadeIn(el)).catch(() => {
      // Refused: no gesture yet, or the file is missing. Stay quiet and try
      // again on the next change of mood rather than nagging.
      if (this.current === el) { this.current = null; this.mode = 'none'; }
    });
  }

  private fadeIn(el: HTMLAudioElement) {
    const start = performance.now();
    const step = () => {
      if (this.current !== el) return;
      const t = Math.min(1, (performance.now() - start) / (FADE * 1000));
      el.volume = LEVEL * t;
      if (t < 1) window.requestAnimationFrame(step);
    };
    step();
  }

  private fadeOut(el: HTMLAudioElement) {
    const start = performance.now();
    const from = el.volume;
    const id = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / (FADE * 1000));
      el.volume = from * (1 - t);
      if (t >= 1) {
        window.clearInterval(id);
        this.fades.delete(id);
        el.pause();
        el.src = '';
      }
    }, 50);
    this.fades.add(id);
  }

  /** What is playing, for tests and the guide. */
  get playing(): { mode: MusicMode; src: string | null } {
    return { mode: this.mode, src: this.current?.currentSrc ?? null };
  }
}

/** The one player. */
export const music = new Music();
