/**
 * The soundscape.
 *
 * Everything here is generated at runtime with Web Audio — there are no audio
 * files. Wind is filtered noise whose cutoff drifts; rain is the same noise
 * opened up and driven harder; birds are short frequency sweeps by day and
 * crickets are clipped bursts after dark. The interface gets a couple of soft
 * ticks.
 *
 * Nothing starts until a player asks for it: browsers refuse to run an audio
 * context before a gesture, and a world that starts making noise on its own is
 * worse than a silent one.
 */

export type Weather = 'Clear' | 'Cloudy' | 'Rain' | 'Storm' | 'Fog' | 'Snow';

export interface SoundState {
  hour: number;
  weather: Weather;
  /** 0 when nothing is happening nearby, 1 in a busy square. */
  activity: number;
  /** How much water is in the world, 0 to 1. A river is audible; a desert is not. */
  water?: number;
  /** How built-up the place is, 0 to 1. A camp is quieter than a town. */
  settled?: number;
}

/**
 * Everything the world can make a noise about.
 *
 * One vocabulary rather than a method per sound, so the places that trigger
 * them — the feed, the arena, the interface — say *what happened* and this file
 * decides what that sounds like. Adding a sound is adding a row.
 */
export type Cue =
  | 'hammer' | 'saw' | 'anvil' | 'coin' | 'sell' | 'bell'
  | 'birth' | 'death' | 'alarm' | 'discover' | 'levelup'
  | 'crowd' | 'blow' | 'win' | 'lose';

/** A looping buffer of white noise, the source of wind and rain. */
function noiseBuffer(ctx: AudioContext) {
  const length = ctx.sampleRate * 3;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brownian-ish noise: smoother and less hissy than raw white.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

export class Soundscape {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  /** The murmur of a place with people in it: louder in a town, gone at night. */
  private hubbubGain: GainNode | null = null;
  private hubbubFilter: BiquadFilterNode | null = null;
  /** Running water, where there is any. */
  private brookGain: GainNode | null = null;
  /** Cues are throttled so a busy day cannot turn into a machine gun. */
  private lastCue = new Map<string, number>();
  private timer = 0;
  private state: SoundState = { hour: 12, weather: 'Clear', activity: 0 };
  /**
   * Quiet on purpose. The wind, the rain and the murmur of the square sit
   * under the soundtrack, and at the old level they fought it: the music was
   * mixed to be heard over a settlement, not through one.
   */
  private volume = 0.28;

  get running() { return this.ctx !== null && this.ctx.state === 'running'; }

  /**
   * Build the graph and start it. Must be called from a user gesture, which is
   * why the mute button is the only way in.
   */
  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.master = master;

    const buffer = noiseBuffer(ctx);

    const wind = ctx.createBufferSource();
    wind.buffer = buffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 420;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.14;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();
    this.windFilter = windFilter;
    this.windGain = windGain;

    const rain = ctx.createBufferSource();
    rain.buffer = buffer;
    rain.loop = true;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 1900;
    rainFilter.Q.value = 0.6;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    rain.connect(rainFilter).connect(rainGain).connect(master);
    rain.start();
    this.rainFilter = rainFilter;
    this.rainGain = rainGain;

    /*
     * The settlement itself.
     *
     * Not voices — voices synthesised badly are worse than none — but the
     * band they live in, moving slowly, so a busy square has a presence and an
     * empty moor does not. It follows the number of people actually out of
     * doors, which is why it dies away at night on its own.
     */
    const hubbub = ctx.createBufferSource();
    hubbub.buffer = buffer;
    hubbub.loop = true;
    const hubbubFilter = ctx.createBiquadFilter();
    hubbubFilter.type = 'bandpass';
    hubbubFilter.frequency.value = 620;
    hubbubFilter.Q.value = 1.6;
    const hubbubGain = ctx.createGain();
    hubbubGain.gain.value = 0;
    hubbub.connect(hubbubFilter).connect(hubbubGain).connect(master);
    hubbub.start();
    this.hubbubFilter = hubbubFilter;
    this.hubbubGain = hubbubGain;

    // Water, where the world has any. Higher and thinner than rain, and it
    // never stops, because a river does not.
    const brook = ctx.createBufferSource();
    brook.buffer = buffer;
    brook.loop = true;
    const brookFilter = ctx.createBiquadFilter();
    brookFilter.type = 'highpass';
    brookFilter.frequency.value = 2600;
    const brookGain = ctx.createGain();
    brookGain.gain.value = 0;
    brook.connect(brookFilter).connect(brookGain).connect(master);
    brook.start();
    this.brookGain = brookGain;

    await ctx.resume();
  }

  async stop() {
    if (!this.ctx) return;
    await this.ctx.suspend();
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
    }
  }

  get level() { return this.volume; }

  /** Feed the world's current conditions in; call it a few times a second. */
  update(state: SoundState, dt: number) {
    this.state = state;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;

    const stormy = state.weather === 'Storm';
    const wet = stormy || state.weather === 'Rain';
    const night = state.hour < 6 || state.hour >= 20;

    if (this.windFilter && this.windGain) {
      // The wind breathes rather than sitting on one note.
      const gust = 380 + Math.sin(now * 0.21) * 130 + Math.sin(now * 0.07) * 90;
      this.windFilter.frequency.setTargetAtTime(gust * (stormy ? 2.1 : 1), now, 0.6);
      this.windGain.gain.setTargetAtTime(stormy ? 0.3 : night ? 0.1 : 0.15, now, 0.8);
    }
    if (this.rainGain && this.rainFilter) {
      this.rainGain.gain.setTargetAtTime(wet ? (stormy ? 0.2 : 0.12) : 0, now, 1.2);
      this.rainFilter.frequency.setTargetAtTime(stormy ? 2400 : 1800, now, 1.0);
    }

    if (this.hubbubGain && this.hubbubFilter) {
      // People are indoors at night and in a storm, and there are more of them
      // to hear in a town than in a camp.
      const awake = night ? 0.12 : stormy ? 0.35 : 1;
      const town = 0.45 + (state.settled ?? 0) * 0.55;
      this.hubbubGain.gain.setTargetAtTime(state.activity * awake * town * 0.085, now, 1.4);
      this.hubbubFilter.frequency.setTargetAtTime(560 + Math.sin(now * 0.11) * 90, now, 1.2);
    }
    if (this.brookGain) {
      // A river runs harder in the rain.
      this.brookGain.gain.setTargetAtTime((state.water ?? 0) * (wet ? 0.05 : 0.032), now, 1.5);
    }

    // Birds by day, crickets by night, and neither in a downpour.
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.6 + Math.random() * (night ? 1.4 : 2.6);
      if (!stormy) {
        if (night) this.cricket();
        else if (Math.random() < 0.55) this.birdCall();
      }
    }
  }

  /** A short rising-falling whistle. Two or three make a convincing bird. */
  private birdCall() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 2);
    const base = 1900 + Math.random() * 1400;
    for (let i = 0; i < notes; i++) {
      const at = now + i * (0.09 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base * (0.9 + Math.random() * 0.25), at);
      osc.frequency.exponentialRampToValueAtTime(base * (1.15 + Math.random() * 0.3), at + 0.05);
      osc.frequency.exponentialRampToValueAtTime(base * 0.85, at + 0.11);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.05, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      osc.connect(gain).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.16);
    }
  }

  /** A dry chirp, repeated: the sound of a settlement asleep. */
  private cricket() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const at = now + i * 0.07;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 4200 + Math.random() * 700;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.014, at + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
      osc.connect(gain).connect(this.master);
      osc.start(at);
      osc.stop(at + 0.06);
    }
  }

  /* ---------------------------------------------------------------- *
   * Cues
   *
   * Small synthesised sounds for things that happen. Every one is built out
   * of the same three parts — a tone that moves, an envelope, and sometimes a
   * burst of noise — because that is all a settlement needs to be audible and
   * because a game with no audio files loads instantly and works offline.
   * ---------------------------------------------------------------- */

  /**
   * One note.
   *
   * `hold` is how long it takes to die away, which is most of what makes a
   * struck bell sound different from a knocked plank.
   */
  private tone(at: number, from: number, to: number, hold: number, level: number, type: OscillatorType = 'sine') {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, from), at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + hold);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + hold);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + hold + 0.02);
  }

  /** A shaped burst of noise: a saw stroke, a crowd, a splash. */
  private burst(at: number, centre: number, hold: number, level: number, q = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = centre;
    band.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + hold * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + hold);
    src.connect(band).connect(gain).connect(this.master);
    src.start(at);
    src.stop(at + hold + 0.05);
  }

  /**
   * Play a cue, unless one of the same kind just went.
   *
   * The throttle is the whole reason this is one method rather than fifteen
   * public ones: a settlement can fell twenty trees in a second of game time,
   * and twenty saw strokes at once is a noise nobody wants to hear twice.
   */
  cue(kind: Cue, gap = 0.35) {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (now - (this.lastCue.get(kind) ?? -99) < gap) return;
    this.lastCue.set(kind, now);
    const rand = () => Math.random();

    switch (kind) {
      case 'hammer':
        // Two knocks, the second softer, on wood rather than metal.
        this.tone(now, 320 + rand() * 60, 150, 0.09, 0.05, 'triangle');
        this.burst(now, 900, 0.06, 0.03);
        this.tone(now + 0.17, 300, 140, 0.08, 0.032, 'triangle');
        break;
      case 'saw':
        // A rasp, back and forth.
        this.burst(now, 1500, 0.22, 0.028, 3);
        this.burst(now + 0.26, 1250, 0.2, 0.022, 3);
        break;
      case 'anvil':
        // Metal: a hard strike and a long ring above it.
        this.tone(now, 1750, 1700, 0.7, 0.05);
        this.tone(now, 2620, 2600, 0.5, 0.022);
        this.burst(now, 3200, 0.05, 0.03);
        break;
      case 'coin':
        this.tone(now, 2100, 2600, 0.13, 0.035);
        this.tone(now + 0.05, 2800, 3200, 0.1, 0.022);
        break;
      case 'sell':
        // A little rising figure: something went out and money came in.
        this.tone(now, 880, 880, 0.12, 0.035, 'triangle');
        this.tone(now + 0.09, 1320, 1320, 0.14, 0.03, 'triangle');
        this.tone(now + 0.18, 1760, 1760, 0.22, 0.026, 'triangle');
        break;
      case 'bell':
        // Struck, with the inharmonic partials that make a bell a bell.
        this.tone(now, 640, 636, 1.9, 0.05);
        this.tone(now, 1530, 1520, 1.5, 0.02);
        this.tone(now, 2180, 2160, 1.0, 0.012);
        break;
      case 'birth':
        this.tone(now, 660, 660, 0.3, 0.03, 'triangle');
        this.tone(now + 0.12, 990, 990, 0.34, 0.028, 'triangle');
        this.tone(now + 0.26, 1320, 1320, 0.5, 0.024, 'triangle');
        break;
      case 'death':
        // One low note, allowed to hang.
        this.tone(now, 196, 190, 2.4, 0.045);
        this.tone(now, 294, 288, 1.6, 0.016);
        break;
      case 'alarm':
        // Two urgent notes, repeated. Nothing else in the game does this.
        for (let i = 0; i < 3; i += 1) {
          this.tone(now + i * 0.28, 880, 880, 0.12, 0.04, 'square');
          this.tone(now + i * 0.28 + 0.13, 660, 660, 0.12, 0.04, 'square');
        }
        break;
      case 'discover':
        this.tone(now, 1200, 2400, 0.28, 0.03);
        this.tone(now + 0.1, 1800, 3000, 0.3, 0.02);
        break;
      case 'levelup':
        this.tone(now, 523, 523, 0.18, 0.032, 'triangle');
        this.tone(now + 0.11, 659, 659, 0.18, 0.032, 'triangle');
        this.tone(now + 0.22, 784, 784, 0.2, 0.032, 'triangle');
        this.tone(now + 0.33, 1046, 1046, 0.5, 0.03, 'triangle');
        break;
      case 'crowd':
        // A roar: noise swelling and falling away, low and wide.
        this.burst(now, 380, 1.6, 0.055, 0.7);
        this.burst(now + 0.1, 700, 1.3, 0.03, 0.5);
        break;
      case 'blow':
        // A hit landing: a thud with a slap on top.
        this.tone(now, 180, 90, 0.13, 0.05, 'triangle');
        this.burst(now, 1800, 0.07, 0.035, 2);
        break;
      case 'win':
        this.tone(now, 784, 784, 0.16, 0.038, 'triangle');
        this.tone(now + 0.14, 1046, 1046, 0.16, 0.038, 'triangle');
        this.tone(now + 0.28, 1568, 1568, 0.6, 0.034, 'triangle');
        this.burst(now + 0.28, 500, 1.2, 0.03, 0.7);
        break;
      case 'lose':
        this.tone(now, 440, 415, 0.3, 0.035, 'triangle');
        this.tone(now + 0.18, 330, 300, 0.7, 0.03, 'triangle');
        break;
    }
  }

  /** Interface feedback. Soft, short, and never during the same frame twice. */
  tick(kind: 'select' | 'confirm' | 'deny' = 'select') {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    const from = kind === 'deny' ? 320 : kind === 'confirm' ? 520 : 660;
    const to = kind === 'deny' ? 220 : kind === 'confirm' ? 780 : 660;
    osc.frequency.setValueAtTime(from, now);
    osc.frequency.exponentialRampToValueAtTime(to, now + 0.08);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  destroy() {
    void this.state;
    this.ctx?.close().catch(() => { /* already closed */ });
    this.ctx = null;
  }
}
