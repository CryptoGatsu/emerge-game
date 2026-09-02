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
}

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
  private timer = 0;
  private state: SoundState = { hour: 12, weather: 'Clear', activity: 0 };
  private volume = 0.55;

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
