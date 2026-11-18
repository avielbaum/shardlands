/**
 * @file Web Audio procedural synthesizer: weapon impacts, alchemy brews, lockpick clicks,
 * footsteps by surface, NPC voice-chirps, biome ambiences and adaptive combat music. No samples.
 */

/**
 * @typedef {Object} ToneOpts
 * @property {OscillatorType} [type]
 * @property {number} [gain]
 * @property {number} [attack]
 * @property {number} [freqEnd]
 * @property {AudioNode|null} [bus]
 * @property {number} [when] seconds from now
 * @property {number} [detune]
 */
/**
 * @typedef {Object} NoiseOpts
 * @property {number} [gain]
 * @property {BiquadFilterType} [type]
 * @property {number} [freq]
 * @property {number} [freqEnd]
 * @property {number} [q]
 * @property {AudioNode|null} [bus]
 * @property {number} [when]
 * @property {number} [attack]
 */

/** D dorian, two octaves of bell pitches for the ambient arpeggio. */
const SCALE = [293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25, 587.33, 659.25, 783.99];
const MASTER = 0.7;

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {GainNode|null} */
    this.sfx = null;
    /** @type {GainNode|null} */
    this.music = null;
    /** @type {AudioBuffer|null} */
    this.noiseBuf = null;
    /** @type {BiquadFilterNode|null} */
    this.droneFilter = null;
    /** @type {{osc:OscillatorNode[], gain:GainNode}|null} */
    this.lance = null;
    this.muted = false;
    this.intensity = 0;
    this.targetIntensity = 0;
    this.nextNote = 0;
    this.step = 0;
    /** @type {Record<string, number>} last play time per rate-limited sound */
    this.last = {};
    /** @type {GainNode|null} */
    this.ambBus = null;
    /** @type {{filter:BiquadFilterNode, gain:GainNode}|null} */
    this.amb = null;
    /** current ambience profile */
    this.ambience = 'observatory';
    this.night = false;
  }

  /** Create/resume the context. Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(comp);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.32;
    this.music.connect(this.master);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.8;
    this.ambBus.connect(this.master);
    this._startMusic();
    this._startAmbience();
  }

  /** @returns {boolean} new muted state */
  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER, this.ctx.currentTime, 0.03);
    return this.muted;
  }

  /** Smoothly steer the soundtrack between calm (0) and combat (1). @param {number} v */
  setIntensity(v) {
    this.targetIntensity = Math.max(0, Math.min(1, v));
  }

  /** True at most once per `gap` seconds for a given key. @param {string} key @param {number} gap */
  _limit(key, gap) {
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (t - (this.last[key] || -1) < gap) return false;
    this.last[key] = t;
    return true;
  }

  /** @param {number} freq @param {number} dur @param {ToneOpts} [o] */
  _tone(freq, dur, o = {}) {
    const ctx = this.ctx;
    const bus = o.bus === undefined ? this.sfx : o.bus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime + (o.when || 0);
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + dur);
    osc.detune.value = o.detune || 0;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** @param {number} dur @param {NoiseOpts} [o] */
  _noise(dur, o = {}) {
    const ctx = this.ctx;
    const bus = o.bus === undefined ? this.sfx : o.bus;
    if (!ctx || !bus || !this.noiseBuf) return;
    const t = ctx.currentTime + (o.when || 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + dur);
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.3, t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  /** Inharmonic bell partials = crystalline chime. @param {number} freq @param {number} dur @param {number} gain @param {AudioNode|null} [bus] @param {number} [when] */
  _bell(freq, dur, gain, bus, when = 0) {
    const partials = [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]];
    for (const [m, a] of partials) this._tone(freq * m, dur / m ** 0.3, { gain: gain * a, bus, when, attack: 0.002 });
  }

  _startMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.music) return;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 2;
    filter.connect(this.music);
    this.droneFilter = filter;
    for (const [f, d] of [[73.42, -7], [110, 5], [146.83, 9]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = d;
      const g = ctx.createGain();
      g.gain.value = 0.06;
      osc.connect(g).connect(filter);
      osc.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.nextNote = ctx.currentTime + 0.2;
    setInterval(() => this._schedule(), 90);
  }

  /** Lookahead scheduler for the adaptive arpeggio, bass pulse and clockwork ticks. */
  _schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this._ambientTick();
    this.intensity += (this.targetIntensity - this.intensity) * 0.08;
    const i = this.intensity;
    while (this.nextNote < ctx.currentTime + 0.25) {
      const step = this.step++;
      const when = Math.max(0, this.nextNote - ctx.currentTime);
      if (Math.random() < 0.28 + i * 0.5) {
        const idx = (step * 3 + Math.floor(Math.random() * 4)) % SCALE.length;
        this._bell(SCALE[idx] * (Math.random() < 0.2 ? 2 : 1), 1.6, 0.05 + i * 0.03, this.music, when);
      }
      if (i > 0.35 && step % 4 === 0) this._tone(step % 16 < 8 ? 73.42 : 65.41, 0.35, { type: 'triangle', gain: 0.14 * i, bus: this.music, when });
      if (i > 0.6 && step % 2 === 1) this._noise(0.04, { gain: 0.05 * i, type: 'highpass', freq: 6000, bus: this.music, when });
      this.nextNote += 0.25 - i * 0.08;
    }
    if (this.droneFilter) this.droneFilter.frequency.setTargetAtTime(300 + i * 900, ctx.currentTime, 0.5);
  }

  /** @param {number} [freq] */
  chime(freq = 1320) { this._bell(freq, 1.2, 0.18); }
  steam() { this._noise(0.6, { gain: 0.25, type: 'highpass', freq: 2500, freqEnd: 900, attack: 0.04 }); }
  door() {
    if (!this._limit('door', 0.3)) return;
    this._noise(0.45, { gain: 0.12, type: 'highpass', freq: 3000, freqEnd: 1200, attack: 0.03 });
    this._tone(90, 0.25, { type: 'square', gain: 0.06, freqEnd: 60 });
  }
  forkBlast() {
    this._tone(440, 0.5, { gain: 0.22 });
    this._tone(880, 0.35, { gain: 0.12, detune: 6 });
    this._noise(0.08, { gain: 0.18, freq: 2400, q: 2 });
  }
  parrySwing() { this._noise(0.15, { gain: 0.12, freq: 1800, freqEnd: 4000, q: 3 }); }
  deflect() {
    this._bell(1568, 0.9, 0.25);
    this._tone(784, 0.25, { type: 'triangle', gain: 0.15, freqEnd: 1568 });
  }
  shard() {
    this._noise(0.12, { gain: 0.3, freq: 3500, q: 1.5 });
    for (let k = 0; k < 3; k++) this._tone(2200 + Math.random() * 1800, 0.12, { gain: 0.05, when: k * 0.015 });
  }
  ricochet() { if (this._limit('ric', 0.08)) this._tone(3000 + Math.random() * 1500, 0.08, { gain: 0.05, type: 'triangle' }); }
  lanceStart() {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.lance) return;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.08);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 3;
    filter.connect(gain).connect(this.sfx);
    const a = ctx.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = 110;
    const b = ctx.createOscillator();
    b.frequency.value = 330;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain).connect(filter.frequency);
    a.connect(filter);
    b.connect(filter);
    for (const o of [a, b, lfo]) o.start();
    this.lance = { osc: [a, b, lfo], gain };
  }
  lanceStop() {
    const ctx = this.ctx;
    if (!ctx || !this.lance) return;
    const { osc, gain } = this.lance;
    gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.04);
    for (const o of osc) o.stop(ctx.currentTime + 0.2);
    this.lance = null;
  }
  tether() { this._bell(988, 0.8, 0.15); this._bell(1480, 0.8, 0.1, undefined, 0.06); }
  /** @param {'stalker'|'weaver'|'warden'|'wave'} kind */
  telegraph(kind) {
    if (kind === 'stalker') { this._bell(1760, 0.5, 0.16); this._bell(1760, 0.5, 0.12, undefined, 0.12); }
    else if (kind === 'weaver') this._tone(300, 0.5, { type: 'triangle', gain: 0.1, freqEnd: 1200 });
    else if (kind === 'warden') { this._tone(55, 0.9, { type: 'sawtooth', gain: 0.12, attack: 0.2 }); this._bell(220, 0.9, 0.12); }
    else { for (let k = 0; k < 4; k++) this._tone(120 + k * 40, 0.08, { type: 'square', gain: 0.05, when: k * 0.07 }); }
  }
  enemyShoot() { this._tone(520, 0.3, { type: 'triangle', gain: 0.1, freqEnd: 260 }); }
  slam() { this._tone(60, 0.5, { type: 'sine', gain: 0.4, freqEnd: 30 }); this._noise(0.4, { gain: 0.3, type: 'lowpass', freq: 600 }); }
  enemyHit() { if (this._limit('hit', 0.04)) this._tone(1200 + Math.random() * 400, 0.06, { type: 'square', gain: 0.05 }); }
  enemyDie() {
    for (let k = 0; k < 6; k++) this._tone(300 + Math.random() * 900, 0.05, { type: 'square', gain: 0.06, when: k * 0.035 });
    this._noise(0.3, { gain: 0.15, type: 'highpass', freq: 2000 });
  }
  blocked() { if (this._limit('blocked', 0.25)) this._tone(2600, 0.15, { type: 'triangle', gain: 0.08 }); }
  anchorHit() { if (this._limit('ahit', 0.08)) this._bell(660, 0.4, 0.1); }
  anchorShatter() {
    for (let k = 0; k < 9; k++) this._bell(800 + Math.random() * 2400, 1.4, 0.12, undefined, k * 0.03);
    this._noise(1.0, { gain: 0.35, type: 'highpass', freq: 4000, freqEnd: 800 });
  }
  gateOpen() { [293.66, 440, 587.33, 880].forEach((f, k) => this._bell(f, 2.5, 0.16, undefined, k * 0.18)); }
  dash() { this._noise(0.22, { gain: 0.22, freq: 600, freqEnd: 3200, q: 2 }); }
  swap() { this._tone(1400, 0.05, { type: 'square', gain: 0.04 }); this._tone(1900, 0.05, { type: 'square', gain: 0.04, when: 0.05 }); }
  pickup() { [523.25, 659.25, 783.99].forEach((f, k) => this._bell(f, 0.6, 0.12, undefined, k * 0.06)); }
  hurt() { this._tone(110, 0.25, { type: 'sawtooth', gain: 0.2, freqEnd: 55 }); this._noise(0.15, { gain: 0.2, type: 'lowpass', freq: 800 }); }
  victory() { [293.66, 369.99, 440, 587.33, 739.99, 880].forEach((f, k) => this._bell(f, 3, 0.15, undefined, k * 0.15)); }
  defeat() { [440, 349.23, 293.66, 220].forEach((f, k) => this._tone(f, 0.9, { type: 'triangle', gain: 0.15, when: k * 0.3 })); }
  // -------------------------------------------------------------------------
  // Shardlands additions: ambience, footsteps, voices, crafting and locks.
  // -------------------------------------------------------------------------

  _startAmbience() {
    const ctx = this.ctx;
    if (!ctx || !this.ambBus || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.ambBus);
    src.start();
    this.amb = { filter, gain };
    this.setAmbience(this.ambience, this.night);
  }

  /**
   * Switch the continuous soundscape bed.
   * @param {string} name observatory|fen|badlands|wood|town|dungeon @param {boolean} night
   */
  setAmbience(name, night) {
    this.ambience = name;
    this.night = night;
    const ctx = this.ctx;
    if (!ctx || !this.amb) return;
    /** @type {Record<string, [BiquadFilterType, number, number]>} type, frequency, gain */
    const P = {
      observatory: ['lowpass', 220, 0.06], fen: ['bandpass', 600, 0.05], badlands: ['bandpass', 380, 0.09],
      wood: ['highpass', 2600, 0.03], town: ['bandpass', 800, 0.04], dungeon: ['lowpass', 300, 0.05],
    };
    const [type, freq, gain] = P[name] || P.observatory;
    const t = ctx.currentTime;
    this.amb.filter.type = type;
    this.amb.filter.frequency.setTargetAtTime(freq, t, 0.5);
    this.amb.gain.gain.setTargetAtTime(gain * (night ? 0.7 : 1), t, 1.2);
  }

  /** Random event sounds for the current ambience, called from the music scheduler. */
  _ambientTick() {
    const r = Math.random();
    const a = this.ambience;
    const bus = this.ambBus;
    if (a === 'fen' && r < 0.03) {
      for (let k = 0; k < 2; k++) this._tone(150 - k * 30, 0.14, { type: 'square', gain: 0.025, freqEnd: 90, bus, when: k * 0.18 });
    } else if (a === 'wood' && !this.night && r < 0.04) {
      const base = 2400 + Math.random() * 1600;
      for (let k = 0; k < 3; k++) this._tone(base, 0.08, { gain: 0.03, freqEnd: base * 1.5, bus, when: k * 0.11 });
    } else if (a === 'badlands' && r < 0.012) {
      this._noise(1.8, { gain: 0.08, type: 'bandpass', freq: 300, freqEnd: 700, attack: 0.7, bus });
    } else if (a === 'town' && !this.night && r < 0.05) {
      if (Math.random() < 0.3) this._tone(900 + Math.random() * 300, 0.05, { type: 'square', gain: 0.02, bus });
      else this.voice(0.8 + Math.random() * 0.6, 2 + Math.floor(Math.random() * 3), 0.012);
    } else if (a === 'dungeon' && r < 0.03) {
      const f = 1100 + Math.random() * 900;
      this._tone(f, 0.12, { gain: 0.04, freqEnd: f * 0.7, bus });
      this._tone(f, 0.12, { gain: 0.015, freqEnd: f * 0.7, bus, when: 0.22 });
    } else if (a === 'observatory' && r < 0.01) this._bell(1800 + Math.random() * 1400, 2, 0.02, bus);
    if (this.night && a !== 'dungeon' && a !== 'observatory' && Math.random() < 0.05) {
      for (let k = 0; k < 3; k++) this._tone(4200, 0.025, { type: 'square', gain: 0.008, bus, when: k * 0.05 });
    }
  }

  /** @param {string} surface stone|wood|grass|water|metal|dirt */
  footstep(surface) {
    if (!this._limit('step', 0.18)) return;
    if (surface === 'wood') { this._noise(0.07, { gain: 0.07, freq: 500, q: 3 }); this._tone(110, 0.06, { gain: 0.05 }); }
    else if (surface === 'grass') this._noise(0.08, { gain: 0.05, type: 'highpass', freq: 2500 });
    else if (surface === 'water') { this._noise(0.15, { gain: 0.08, freq: 900, q: 1 }); this._tone(400, 0.1, { gain: 0.02, freqEnd: 900 }); }
    else if (surface === 'metal') { this._tone(820 + Math.random() * 120, 0.06, { type: 'triangle', gain: 0.03 }); this._noise(0.04, { gain: 0.05, freq: 3000, q: 2 }); }
    else if (surface === 'dirt') this._noise(0.07, { gain: 0.06, freq: 700, q: 0.8 });
    else { this._noise(0.05, { gain: 0.07, freq: 1800, q: 2 }); this._tone(90, 0.05, { gain: 0.05 }); }
  }

  /** Chirpy syllables in an NPC's pitch. @param {number} pitch @param {number} syllables @param {number} [gain] */
  voice(pitch, syllables, gain = 0.05) {
    let t = 0;
    for (let k = 0; k < syllables; k++) {
      const f = 170 * pitch * (0.8 + Math.random() * 0.5);
      const d = 0.06 + Math.random() * 0.06;
      this._tone(f, d, { type: 'triangle', gain, freqEnd: f * (0.85 + Math.random() * 0.4), when: t });
      this._tone(f * 2.5, d * 0.8, { type: 'sine', gain: gain * 0.4, when: t });
      t += d + 0.03;
    }
  }

  meleeHit() { this._noise(0.08, { gain: 0.25, freq: 1400, q: 1.5 }); this._tone(180, 0.12, { type: 'square', gain: 0.08, freqEnd: 80 }); }
  block() { this._tone(1300, 0.15, { type: 'triangle', gain: 0.12 }); this._noise(0.06, { gain: 0.15, freq: 3000, q: 3 }); }
  bow() { this._tone(220, 0.18, { type: 'triangle', gain: 0.15, freqEnd: 90 }); this._noise(0.1, { gain: 0.12, freq: 2200, freqEnd: 900, q: 2 }); }
  flare() { this._noise(0.4, { gain: 0.15, type: 'lowpass', freq: 1200, freqEnd: 300, attack: 0.02 }); }
  frostShot() { this._bell(2600, 0.5, 0.08); this._noise(0.2, { gain: 0.08, type: 'highpass', freq: 5000 }); }
  splash() { this._noise(0.5, { gain: 0.2, freq: 800, freqEnd: 300, q: 0.7 }); }
  thud() { this._tone(70, 0.3, { gain: 0.3, freqEnd: 40 }); this._noise(0.2, { gain: 0.15, type: 'lowpass', freq: 500 }); }
  lockClick() { this._tone(2600 + Math.random() * 800, 0.03, { type: 'square', gain: 0.05 }); }
  lockOpen() { this._tone(900, 0.06, { type: 'square', gain: 0.06 }); this._tone(1400, 0.08, { type: 'square', gain: 0.06, when: 0.07 }); }
  lockBreak() { this._tone(3200, 0.1, { type: 'square', gain: 0.07, freqEnd: 1200 }); }
  creak() { this._tone(160, 0.5, { type: 'sawtooth', gain: 0.04, freqEnd: 120, attack: 0.1 }); }
  coins() { for (let k = 0; k < 4; k++) this._bell(2600 + Math.random() * 1200, 0.25, 0.05, undefined, k * 0.05); }
  brew() {
    for (let k = 0; k < 6; k++) this._tone(300 + Math.random() * 500, 0.08, { gain: 0.05, freqEnd: 900, when: k * 0.07 });
    this._bell(1046, 0.8, 0.1, undefined, 0.45);
  }
  /** @param {string} spell */
  cast(spell) {
    const base = /** @type {Record<string, number>} */ ({ lumina: 1318, mending: 784, push: 330, unlock: 1046, feather: 1568 })[spell] || 880;
    this._bell(base, 1, 0.14);
    this._noise(0.4, { gain: 0.1, freq: base, freqEnd: base * 2, q: 4 });
  }
  levelUp() { [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, k) => this._bell(f, 1.6, 0.13, undefined, k * 0.1)); }
  quest() { this._bell(880, 1.2, 0.12); this._bell(1318.5, 1.2, 0.1, undefined, 0.15); }
  skillUp() { this._bell(1174.7, 0.9, 0.1); this._bell(1568, 0.9, 0.08, undefined, 0.08); }
  eat() { for (let k = 0; k < 3; k++) this._noise(0.05, { gain: 0.06, freq: 900, q: 2, when: k * 0.12 }); }
}
