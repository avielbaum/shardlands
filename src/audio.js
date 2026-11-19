/**
 * @file Web Audio engine, fully procedural (no samples).
 *
 * Routing: Music, SFX, Ambience and UI buses -> master volume -> analog-style warmth shelves ->
 * glue compressor -> brick-wall limiter -> speakers. Every bus also sends to two algorithmic
 * convolution reverbs (in-memory stereo impulse responses with early reflections and a diffuse,
 * darkening tail): a cavernous stone hall and an open-air space, crossfaded by environment.
 * Positional sounds (enemy steps, telegraphs, shots, impacts, fires, vents) go through HRTF
 * PannerNodes plus a distance low-pass for air absorption, relative to a listener that follows
 * the camera.
 *
 * Synthesis: layered transient/body/tail foley with ±8% pitch and level variation, modal
 * synthesis (inharmonic sine partials decaying at their own rates) for metal, glass, wood and
 * stone, granular crackle, formant voices, Karplus-Strong plucked strings and detuned, vibrato'd
 * bowed-string ensembles. The score is generative: per-context stems (observatory, day, night,
 * town, dungeon) crossfade over seconds, and a combat layer of war drums, clockwork ticks and a
 * low-string ostinato swells with danger.
 */

/** @typedef {{x:number, y:number, z:number}} Pos */

const VOL_KEY = 'shardlands-audio';
/** Bus trims under the user's volume sliders. */
const TRIM = { music: 0.42, sfx: 0.85, amb: 0.75, ui: 0.6 };
/** ±8% random variation so repeats never sound identical. @param {number} v @param {number} [k] */
const vary = (v, k = 0.08) => v * (1 + (Math.random() * 2 - 1) * k);
/** @param {number} a @param {number} b */
const rnd = (a, b) => a + Math.random() * (b - a);
/** MIDI note to Hz. @param {number} n */
const hz = (n) => 440 * 2 ** ((n - 69) / 12);

/** Modal recipes: [frequency ratio, amplitude, decay seconds]. */
const MODES = {
  bell: [[1, 1, 1.8], [2.76, 0.45, 1.1], [5.4, 0.22, 0.6], [8.93, 0.1, 0.35]],
  fork: [[1, 1, 2.2], [6.27, 0.18, 0.5], [17.55, 0.05, 0.12]],
  plate: [[1, 1, 0.9], [1.59, 0.6, 0.7], [2.14, 0.45, 0.55], [2.65, 0.3, 0.4], [3.52, 0.2, 0.25], [4.79, 0.1, 0.15]],
  glass: [[1, 1, 1.2], [2.32, 0.5, 0.8], [4.25, 0.3, 0.5], [6.63, 0.15, 0.3]],
  wood: [[1, 1, 0.09], [2.57, 0.5, 0.05], [4.1, 0.25, 0.03]],
  slab: [[1, 1, 0.16], [2.31, 0.5, 0.1], [3.9, 0.25, 0.06]],
  coin: [[1, 1, 0.5], [2.4, 0.6, 0.35], [3.9, 0.35, 0.2], [5.6, 0.2, 0.12]],
  celesta: [[1, 1, 2.4], [2, 0.3, 1.2], [3.01, 0.12, 0.6], [4.16, 0.05, 0.3]],
};

/** Vowel formants [F1, F2, F3] (Hz) for the NPC voices. */
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [390, 1990, 2550], [570, 840, 2410], [440, 1020, 2240], [660, 1720, 2410]];

/**
 * Music contexts: tempo, scale (MIDI, one octave from the tonic) and a chord cycle (scale degrees).
 * @type {Record<string, {bpm:number, root:number, scale:number[], chords:number[][]}>}
 */
const SCORE = {
  observatory: { bpm: 52, root: 38, scale: [0, 2, 3, 5, 7, 8, 10], chords: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]] },
  dungeon: { bpm: 48, root: 36, scale: [0, 1, 3, 5, 7, 8, 10], chords: [[0, 2, 4], [1, 3, 5], [0, 2, 4], [6, 1, 3]] },
  day: { bpm: 70, root: 50, scale: [0, 2, 3, 5, 7, 9, 10], chords: [[0, 2, 4], [6, 1, 3], [3, 5, 0], [4, 6, 1]] },
  night: { bpm: 54, root: 53, scale: [0, 2, 4, 6, 7, 9, 11], chords: [[0, 2, 4], [1, 3, 5], [5, 0, 2], [4, 6, 1]] },
  town: { bpm: 92, root: 55, scale: [0, 2, 4, 5, 7, 9, 10], chords: [[0, 2, 4], [3, 5, 0], [6, 1, 3], [0, 2, 4]] },
};

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {GainNode|null} */
    this.music = null;
    /** @type {GainNode|null} */
    this.sfx = null;
    /** @type {GainNode|null} */
    this.ambBus = null;
    /** @type {GainNode|null} */
    this.ui = null;
    /** @type {GainNode|null} reverb send */
    this.send = null;
    /** @type {{cave: GainNode, open: GainNode}|null} reverb returns */
    this.wet = null;
    /** @type {{white: AudioBuffer, pink: AudioBuffer, brown: AudioBuffer}|null} */
    this.noise = null;
    this.muted = false;
    /** User volumes, 0..1, persisted. */
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9 };
    try {
      const v = JSON.parse(localStorage.getItem(VOL_KEY) || 'null');
      if (v) for (const k of /** @type {const} */ (['master', 'music', 'sfx'])) if (Number.isFinite(v[k])) this.vol[k] = Math.max(0, Math.min(1, v[k]));
    } catch { /* storage blocked: defaults for this session */ }
    this.intensity = 0;
    this.targetIntensity = 0;
    /** @type {Record<string, number>} last play time per rate-limited sound */
    this.last = {};
    this.ambience = 'observatory';
    this.night = false;
    /** @type {{filter: BiquadFilterNode, gain: GainNode, low: GainNode}|null} */
    this.amb = null;
    /** @type {{rain: GainNode, rainLow: GainNode, wind: GainNode, windFilter: BiquadFilterNode}|null} */
    this.weather = null;
    this.rainLevel = 0;
    /** Listener pose, for distance absorption. */
    this.lis = { x: 0, y: 0, z: 0 };
    /** @type {Map<string, {kind: string, pos: Pos, panner: PannerNode, air: BiquadFilterNode, gain: GainNode, src: AudioBufferSourceNode}>} */
    this.emitters = new Map();
    /** Music state. */
    this.musicState = 'observatory';
    /** @type {Record<string, GainNode>} */
    this.stems = {};
    /** @type {GainNode|null} */
    this.combat = null;
    this.nextStep = 0;
    this.step = 0;
    this.melodyNote = 4;
    /** @type {Map<string, AudioBuffer>} Karplus-Strong string cache */
    this.plucks = new Map();
    /** @type {number|null} */
    this.timer = null;
    this._armUnlock();
  }

  // -------------------------------------------------------------------------
  // Context, routing and settings
  // -------------------------------------------------------------------------

  /** Create the context on the first user gesture anywhere (desktop and mobile Safari/Chrome). */
  _armUnlock() {
    if (typeof window === 'undefined') return;
    const events = ['pointerdown', 'keydown', 'touchend'];
    const unlock = () => {
      this.init();
      if (this.ctx && this.ctx.state === 'running') for (const e of events) window.removeEventListener(e, unlock, true);
    };
    for (const e of events) window.addEventListener(e, unlock, true);
  }

  /** Create/resume the context. Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    // iOS only unlocks output once a buffer has played inside the gesture.
    const tick = ctx.createBufferSource();
    tick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    tick.connect(ctx.destination);
    tick.start();

    // Mastering chain: gentle low warmth, softened top, glue compression, then a limiter.
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowshelf';
    warm.frequency.value = 180;
    warm.gain.value = 2;
    const soft = ctx.createBiquadFilter();
    soft.type = 'highshelf';
    soft.frequency.value = 6500;
    soft.gain.value = -3;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 12;
    glue.ratio.value = 2.5;
    glue.attack.value = 0.012;
    glue.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -2.5;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.12;
    this.master = ctx.createGain();
    this.master.connect(warm).connect(soft).connect(glue).connect(limit).connect(ctx.destination);

    this.noise = { white: this._noiseBuffer('white'), pink: this._noiseBuffer('pink'), brown: this._noiseBuffer('brown') };

    // Reverb: one send, two impulse responses, crossfaded by environment.
    this.send = ctx.createGain();
    const cave = ctx.createConvolver();
    cave.buffer = this._impulse(3.6, 2.4, 0.08, 18);
    const open = ctx.createConvolver();
    open.buffer = this._impulse(1.4, 4.5, 0.03, 6);
    const caveWet = ctx.createGain();
    const openWet = ctx.createGain();
    caveWet.gain.value = 0;
    openWet.gain.value = 0;
    this.send.connect(cave).connect(caveWet).connect(this.master);
    this.send.connect(open).connect(openWet).connect(this.master);
    this.wet = { cave: caveWet, open: openWet };

    /** @param {number} sendLevel */
    const bus = (sendLevel) => {
      const g = ctx.createGain();
      g.connect(/** @type {GainNode} */ (this.master));
      const s = ctx.createGain();
      s.gain.value = sendLevel;
      g.connect(s).connect(/** @type {GainNode} */ (this.send));
      return g;
    };
    this.music = bus(0.6);
    this.sfx = bus(0.42);
    this.ambBus = bus(0.35);
    this.ui = bus(0.2);
    this._applyVolumes(0);

    const L = ctx.listener;
    if (L.forwardX) {
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    }
    this._startMusic();
    this._startAmbience();
    this.setAmbience(this.ambience, this.night);
  }

  /** @returns {{master:number, music:number, sfx:number}} */
  get volumes() {
    return { ...this.vol };
  }

  /** Set one user volume (0..1) and persist it. @param {'master'|'music'|'sfx'} name @param {number} v */
  setVolume(name, v) {
    this.vol[name] = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    try { localStorage.setItem(VOL_KEY, JSON.stringify(this.vol)); } catch { /* storage blocked: keep for this session */ }
    this._applyVolumes(0.05);
  }

  /** @param {number} tc ramp time constant */
  _applyVolumes(tc) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.music || !this.sfx || !this.ambBus || !this.ui) return;
    const t = ctx.currentTime;
    /** @param {AudioParam} p @param {number} v */
    const set = (p, v) => (tc ? p.setTargetAtTime(v, t, tc) : p.setValueAtTime(v, t));
    // Squared so the sliders feel even across their travel.
    set(this.master.gain, this.muted ? 0 : this.vol.master ** 2);
    set(this.music.gain, this.vol.music ** 2 * TRIM.music);
    set(this.sfx.gain, this.vol.sfx ** 2 * TRIM.sfx);
    set(this.ambBus.gain, this.vol.sfx ** 2 * TRIM.amb);
    set(this.ui.gain, this.vol.sfx ** 2 * TRIM.ui);
  }

  /** @returns {boolean} new muted state */
  toggleMute() {
    this.muted = !this.muted;
    this._applyVolumes(0.03);
    return this.muted;
  }

  /** Smoothly steer the soundtrack between calm (0) and combat (1). @param {number} v */
  setIntensity(v) {
    this.targetIntensity = Math.max(0, Math.min(1, v));
  }

  /**
   * Move the listener with the camera.
   * @param {number} x @param {number} y @param {number} z @param {number} yaw @param {number} pitch
   */
  setListener(x, y, z, yaw, pitch) {
    const ctx = this.ctx;
    if (!ctx || ![x, y, z, yaw, pitch].every(Number.isFinite)) return;
    this.lis = { x, y, z };
    const L = ctx.listener;
    const cp = Math.cos(pitch);
    const f = [Math.cos(yaw) * cp, Math.sin(pitch), Math.sin(yaw) * cp];
    const t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(x, t);
      L.positionY.setValueAtTime(y, t);
      L.positionZ.setValueAtTime(z, t);
      L.forwardX.setValueAtTime(f[0], t);
      L.forwardY.setValueAtTime(f[1], t);
      L.forwardZ.setValueAtTime(f[2], t);
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(f[0], f[1], f[2], 0, 1, 0);
    }
    for (const e of this.emitters.values()) this._air(e.air, e.pos);
  }

  /** True at most once per `gap` seconds for a given key. @param {string} key @param {number} gap */
  _limit(key, gap) {
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (t - (this.last[key] ?? -1e9) < gap) return false;
    this.last[key] = t;
    return true;
  }

  /** One second of looping noise. @param {'white'|'pink'|'brown'} kind */
  _noiseBuffer(kind) {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        // Paul Kellet's pink-noise filter.
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    return buf;
  }

  /**
   * Stereo impulse response: discrete early reflections, then a decorrelated exponential tail
   * that loses high frequencies as it decays (like absorbent stone and air).
   * @param {number} seconds @param {number} decay @param {number} preDelay @param {number} taps early reflections
   */
  _impulse(seconds, decay, preDelay, taps) {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let k = 0; k < taps; k++) {
        const at = Math.floor(sr * (preDelay * 0.3 + Math.random() * preDelay * 1.6));
        if (at < n) d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.9 - k / taps * 0.6);
      }
      let y = 0;
      const start = Math.floor(sr * preDelay);
      for (let i = start; i < n; i++) {
        const t = (i - start) / sr;
        const env = Math.exp((-t * decay * 3) / seconds) * Math.min(1, t * 40);
        const a = 0.85 - 0.75 * Math.min(1, t / seconds);
        y += a * (Math.random() * 2 - 1 - y);
        d[i] += y * env * 0.6;
      }
    }
    return buf;
  }

  /**
   * Output for a sound: its bus, or (with a position) an HRTF panner + air-absorption filter
   * into the bus that disconnects itself once the sound is over.
   * @param {Pos|null|undefined} at @param {number} dur seconds until silent @param {AudioNode|null} [bus]
   * @returns {AudioNode|null}
   */
  _out(at, dur, bus = this.sfx) {
    const ctx = this.ctx;
    if (!ctx || !bus) return null;
    if (!at || ![at.x, at.y, at.z].every(Number.isFinite)) return bus;
    const { panner, air } = this._panner(at, bus);
    setTimeout(() => { panner.disconnect(); air.disconnect(); }, (dur + 0.5) * 1000);
    return panner;
  }

  /** @param {Pos} at @param {AudioNode} bus */
  _panner(at, bus) {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1.6;
    panner.maxDistance = 80;
    panner.rolloffFactor = 1.1;
    if (panner.positionX) {
      panner.positionX.value = at.x;
      panner.positionY.value = at.y + 1;
      panner.positionZ.value = at.z;
    } else panner.setPosition(at.x, at.y + 1, at.z);
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    this._air(air, at);
    panner.connect(air).connect(bus);
    return { panner, air };
  }

  /** Distance low-pass: far sounds lose their top end. @param {BiquadFilterNode} air @param {Pos} at */
  _air(air, at) {
    const d = Math.hypot(at.x - this.lis.x, at.y + 1 - this.lis.y, at.z - this.lis.z);
    const ctx = /** @type {AudioContext} */ (this.ctx);
    air.frequency.setTargetAtTime(Math.max(700, 18000 * Math.exp(-d / 18)), ctx.currentTime, 0.05);
  }

  // -------------------------------------------------------------------------
  // Synthesis primitives (all take an output node and a delay in seconds)
  // -------------------------------------------------------------------------

  /**
   * Enveloped oscillator.
   * @param {AudioNode|null} out @param {number} when @param {OscillatorType} type @param {number} freq @param {number} dur @param {number} gain
   * @param {{attack?: number, freqEnd?: number, detune?: number}} [o]
   */
  _osc(out, when, type, freq, dur, gain, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !out || gain <= 0) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t + dur);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + (o.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /**
   * Filtered noise burst.
   * @param {AudioNode|null} out @param {number} when @param {number} dur @param {number} gain
   * @param {{color?: 'white'|'pink'|'brown', type?: BiquadFilterType, freq?: number, freqEnd?: number, q?: number, attack?: number}} [o]
   */
  _noise(out, when, dur, gain, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !out || !this.noise || gain <= 0) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise[o.color ?? 'white'];
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.frequency.setValueAtTime(o.freq ?? 1000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + dur);
    f.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + (o.attack ?? 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  /**
   * Modal synthesis: inharmonic sine partials, each decaying at its own rate.
   * @param {AudioNode|null} out @param {number} when @param {number} f0 @param {number[][]} modes @param {number} gain @param {number} [len] decay multiplier
   */
  _modal(out, when, f0, modes, gain, len = 1) {
    for (const [r, a, d] of modes) {
      const f = f0 * r * vary(1, 0.006);
      if (f < 20000) this._osc(out, when, 'sine', f, d * len * vary(1, 0.1), gain * a, { attack: 0.0015 });
    }
  }

  /**
   * Grains of crackle: many tiny filtered clicks spread over a span.
   * @param {AudioNode|null} out @param {number} when @param {number} span @param {number} count @param {number} gain @param {number} freq
   */
  _grains(out, when, span, count, gain, freq) {
    for (let k = 0; k < count; k++) this._noise(out, when + Math.random() * span, rnd(0.004, 0.018), vary(gain, 0.4), { freq: vary(freq, 0.35), q: 2.5 });
  }

  /** Air whoosh: pink noise through a swept band-pass. @param {AudioNode|null} out @param {number} when @param {number} dur @param {number} gain @param {number} f0 @param {number} f1 */
  _whoosh(out, when, dur, gain, f0, f1) {
    this._noise(out, when, dur, gain, { color: 'pink', freq: vary(f0), freqEnd: vary(f1), q: 1.6, attack: dur * 0.35 });
  }

  /** Low body thud. @param {AudioNode|null} out @param {number} when @param {number} f @param {number} gain @param {number} [dur] */
  _thud(out, when, f, gain, dur = 0.22) {
    this._osc(out, when, 'sine', vary(f), dur, gain, { freqEnd: f * 0.5, attack: 0.002 });
    this._noise(out, when, dur * 0.6, gain * 0.5, { color: 'brown', type: 'lowpass', freq: f * 5 });
  }

  /**
   * Karplus-Strong plucked string (cached per pitch and brightness).
   * @param {AudioNode|null} out @param {number} when @param {number} freq @param {number} gain @param {number} [bright] 0..1
   */
  _pluck(out, when, freq, gain, bright = 0.5) {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const key = `${Math.round(freq * 2)}:${bright}`;
    let buf = this.plucks.get(key);
    if (!buf) {
      const sr = ctx.sampleRate;
      const n = Math.floor(sr * Math.min(3, 1.2 + 200 / freq));
      buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      const N = Math.max(2, Math.round(sr / freq));
      const line = new Float32Array(N);
      let lp = 0;
      for (let i = 0; i < N; i++) {
        lp += (0.25 + bright * 0.7) * (Math.random() * 2 - 1 - lp);
        line[i] = lp;
      }
      const loss = 0.998 - (1 - bright) * 0.004;
      for (let i = 0; i < n; i++) {
        const j = i % N;
        const v = line[j];
        d[i] = v * Math.min(1, (n - i) / (sr * 0.05));
        line[j] = loss * 0.5 * (v + line[(j + 1) % N]);
      }
      if (this.plucks.size > 160) this.plucks.clear();
      this.plucks.set(key, buf);
    }
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Wooden body resonance.
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 220;
    body.Q.value = 1.2;
    body.gain.value = 5;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(body).connect(g).connect(out);
    src.start(t);
  }

  /**
   * Bowed string: three detuned saws, low-passed, with delayed vibrato and slow swells.
   * @param {AudioNode|null} out @param {number} when @param {number} freq @param {number} dur @param {number} gain
   * @param {{attack?: number, release?: number, bright?: number}} [o]
   */
  _bowed(out, when, freq, dur, gain, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime + when;
    const attack = o.attack ?? 1.2;
    const release = o.release ?? 1.6;
    const end = t + dur + release;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = Math.min(9000, freq * (2.5 + (o.bright ?? 0.5) * 4));
    f.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    f.connect(hp).connect(g).connect(out);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = vary(5.2, 0.1);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(freq * 0.004, t + attack + 0.4);
    lfo.connect(depth);
    for (const det of [-7, 0, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = det + rnd(-2, 2);
      depth.connect(osc.frequency);
      osc.connect(f);
      osc.start(t);
      osc.stop(end + 0.05);
    }
    lfo.start(t);
    lfo.stop(end + 0.05);
  }

  /**
   * Formant voice syllables: a gliding glottal buzz through three vowel resonances.
   * @param {AudioNode|null} out @param {number} when @param {number} f0 @param {number} dur @param {number} gain @param {number[]} vowel
   */
  _syllable(out, when, f0, dur, gain, vowel) {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime + when;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0, t);
    src.frequency.linearRampToValueAtTime(f0 * rnd(0.85, 1.18), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    vowel.forEach((F, k) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = F * vary(1, 0.05);
      bp.Q.value = 8 + k * 4;
      const a = ctx.createGain();
      a.gain.value = [1, 0.5, 0.25][k];
      src.connect(bp).connect(a).connect(g);
    });
    // Breath under the voice.
    this._noise(out, when, dur, gain * 0.15, { color: 'pink', freq: 1800, q: 1 });
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // -------------------------------------------------------------------------
  // Score
  // -------------------------------------------------------------------------

  _startMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.music) return;
    for (const name of Object.keys(SCORE)) {
      const g = ctx.createGain();
      g.gain.value = name === this.musicState ? 1 : 0;
      g.connect(this.music);
      this.stems[name] = g;
    }
    this.combat = ctx.createGain();
    this.combat.gain.value = 0;
    this.combat.connect(this.music);
    this.nextStep = ctx.currentTime + 0.3;
    this.timer = window.setInterval(() => this._schedule(), 100);
  }

  /** Crossfade the score to another context. @param {string} state */
  _setMusic(state) {
    const ctx = this.ctx;
    if (!ctx || state === this.musicState || !this.stems[state]) return;
    const t = ctx.currentTime;
    this.stems[this.musicState].gain.setTargetAtTime(0, t, 2.2);
    this.stems[state].gain.setTargetAtTime(1, t + 0.5, 2.2);
    this.musicState = state;
  }

  /** Lookahead scheduler: sixteenth-note steps for every audible stem, plus ambience events. */
  _schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this._ambientTick();
    this.intensity += (this.targetIntensity - this.intensity) * 0.06;
    if (this.combat) this.combat.gain.setTargetAtTime(Math.min(1, this.intensity * 1.6), ctx.currentTime, 0.6);
    const sc = SCORE[this.musicState];
    const dur16 = 60 / sc.bpm / 4;
    // After a long stall (hidden tab), skip ahead instead of firing a burst of notes.
    if (this.nextStep < ctx.currentTime - 1) this.nextStep = ctx.currentTime + 0.05;
    while (this.nextStep < ctx.currentTime + 0.3) {
      const when = Math.max(0, this.nextStep - ctx.currentTime);
      for (const name of Object.keys(SCORE)) if (name === this.musicState || this.stems[name].gain.value > 0.02) this._stemStep(name, this.step, when, dur16);
      if (this.intensity > 0.04) this._combatStep(sc, this.step, when, dur16);
      this.step++;
      this.nextStep += dur16;
    }
  }

  /**
   * Note in the current context's scale. @param {{root:number, scale:number[]}} sc @param {number} degree
   * @param {number} octave octave offset from the root
   */
  _note(sc, degree, octave) {
    const n = sc.scale.length;
    const d = ((degree % n) + n) % n;
    return hz(sc.root + sc.scale[d] + 12 * (octave + Math.floor(degree / n)));
  }

  /**
   * One sixteenth of one stem.
   * @param {string} name @param {number} step @param {number} when @param {number} dur16
   */
  _stemStep(name, step, when, dur16) {
    const sc = SCORE[name];
    const out = this.stems[name];
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = sc.chords[Math.floor(bar / 2) % sc.chords.length];
    const chordStart = s === 0 && bar % 2 === 0;
    const len = dur16 * 32;
    if (name === 'observatory' || name === 'dungeon') {
      // Deep cello drone, distant metallic chimes, contemplative harp arpeggios.
      if (chordStart) {
        this._bowed(out, when, this._note(sc, chord[0], -1), len, 0.05, { attack: 3, release: 4, bright: 0.2 });
        this._bowed(out, when + 0.3, this._note(sc, chord[2], -1), len, 0.025, { attack: 4, release: 4, bright: 0.25 });
      }
      if (s % 2 === 0 && Math.random() < (name === 'dungeon' ? 0.18 : 0.32)) {
        const deg = chord[Math.floor(Math.random() * 3)] + (Math.random() < 0.4 ? 7 : 0);
        this._pluck(out, when, this._note(sc, deg, 1), 0.16, 0.45);
      }
      if (s === 8 && Math.random() < 0.18) this._modal(out, when, this._note(sc, chord[0], 3) * 1.004, MODES.bell, 0.025, 1.6);
    } else if (name === 'day') {
      // Swelling string pad under a modal lute/harp melody.
      if (chordStart) {
        chord.forEach((d, k) => this._bowed(out, when + k * 0.12, this._note(sc, d, k === 0 ? -1 : 0), len, k === 0 ? 0.04 : 0.028, { attack: 2.2, release: 2.5, bright: 0.45 }));
      }
      if (s % 2 === 0) {
        const phrase = bar % 4;
        const rest = phrase === 3 && s > 8;
        if (!rest && Math.random() < (s % 4 === 0 ? 0.75 : 0.35)) {
          this.melodyNote += Math.random() < 0.6 ? (Math.random() < 0.5 ? 1 : -1) : Math.round(rnd(-3, 3));
          if (s === 0) this.melodyNote = chord[Math.floor(Math.random() * 3)] + 7;
          this.melodyNote = Math.max(3, Math.min(13, this.melodyNote));
          this._pluck(out, when, this._note(sc, this.melodyNote, 0), 0.22, 0.6);
        }
      }
      if (s === 12 && bar % 4 === 1 && Math.random() < 0.5) this._modal(out, when, this._note(sc, chord[1], 3), MODES.celesta, 0.03);
    } else if (name === 'night') {
      // Quiet celesta motifs, wind-chime clusters, a faint high pad.
      if (chordStart) chord.forEach((d, k) => this._bowed(out, when + k * 0.3, this._note(sc, d, 0), len, 0.012, { attack: 4, release: 4, bright: 0.2 }));
      if (s % 4 === 0 && Math.random() < 0.3) this._modal(out, when, this._note(sc, chord[Math.floor(Math.random() * 3)] + (Math.random() < 0.5 ? 7 : 0), 2), MODES.celesta, 0.05, 1.2);
      if (s === 6 && Math.random() < 0.12) for (let k = 0; k < 5; k++) this._modal(out, when + k * rnd(0.08, 0.2), this._note(sc, Math.floor(rnd(0, 7)), 3), MODES.glass, 0.012, 1.5);
    } else if (name === 'town') {
      // Rustic lute: bass on the beat, chord tones on the eighths, a soft frame drum.
      if (s === 0 || s === 8) this._pluck(out, when, this._note(sc, chord[0], -1), 0.24, 0.35);
      if (s % 2 === 0 && s !== 0 && s !== 8 && Math.random() < 0.85) this._pluck(out, when, this._note(sc, chord[(s / 2) % 3], s % 4 === 0 ? 1 : 0), 0.13, 0.55);
      if (s === 4 || s === 12) this._thud(out, when, 95, 0.05, 0.18);
      if (s === 14 && Math.random() < 0.4) this._thud(out, when, 120, 0.025, 0.12);
      if (chordStart) this._bowed(out, when, this._note(sc, chord[0], 0), len, 0.012, { attack: 2, release: 2, bright: 0.4 });
    }
  }

  /**
   * Combat layer: war-drum toms, clockwork ticks and a low-string ostinato in the current key.
   * @param {{root:number, scale:number[], chords:number[][]}} sc @param {number} step @param {number} when @param {number} dur16
   */
  _combatStep(sc, step, when, dur16) {
    const out = this.combat;
    const s = step % 16;
    const chord = sc.chords[Math.floor(step / 32) % sc.chords.length];
    if (s === 0 || s === 6 || s === 10) this._thud(out, when, s === 0 ? 62 : 78, s === 0 ? 0.32 : 0.2, 0.35);
    if (s === 12 || s === 14) this._thud(out, when, 104, 0.14, 0.2);
    if (s % 2 === 1) this._modal(out, when, 2900, [[1, 1, 0.03], [1.7, 0.5, 0.02]], 0.03);
    if (s % 2 === 0) {
      const deg = s % 8 === 6 ? chord[2] : chord[0];
      this._bowed(out, when, this._note(sc, deg, -1), dur16 * 1.4, 0.05, { attack: 0.02, release: 0.12, bright: 0.6 });
    }
  }

  // -------------------------------------------------------------------------
  // Ambience and weather
  // -------------------------------------------------------------------------

  _startAmbience() {
    const ctx = this.ctx;
    if (!ctx || !this.ambBus || !this.noise) return;
    /**
     * @param {AudioBuffer} buffer @param {BiquadFilterType} type @param {number} freq @param {number} q
     * @returns {{f: BiquadFilterNode, g: GainNode}}
     */
    const bed = (buffer, type, freq, q) => {
      const n = ctx.createBufferSource();
      n.buffer = buffer;
      n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      n.connect(f).connect(g).connect(/** @type {GainNode} */ (this.ambBus));
      n.start(0, Math.random());
      return { f, g };
    };
    const air = bed(this.noise.pink, 'bandpass', 600, 0.7);
    const low = bed(this.noise.brown, 'lowpass', 160, 0.7);
    this.amb = { filter: air.f, gain: air.g, low: low.g };
    // Weather: hissing rain plus its low drum on surfaces, and gusting wind.
    const rain = bed(this.noise.pink, 'highpass', 1600, 0.5);
    const rainLow = bed(this.noise.brown, 'lowpass', 500, 0.6);
    const wind = bed(this.noise.pink, 'lowpass', 420, 1.6);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const depth = ctx.createGain();
    depth.gain.value = 300;
    lfo.connect(depth).connect(wind.f.frequency);
    lfo.start();
    this.weather = { rain: rain.g, rainLow: rainLow.g, wind: wind.g, windFilter: wind.f };
  }

  /**
   * Fade the rain and wind beds. Indoors pass sheltered = true for a muffled patter.
   * @param {number} rain 0..1 @param {number} wind 0..1 @param {boolean} sheltered
   */
  setWeather(rain, wind, sheltered) {
    const ctx = this.ctx;
    if (!ctx || !this.weather) return;
    const t = ctx.currentTime;
    this.rainLevel = sheltered ? rain * 0.25 : rain;
    this.weather.rain.gain.setTargetAtTime(rain * (sheltered ? 0.03 : 0.2), t, 0.8);
    this.weather.rainLow.gain.setTargetAtTime(rain * (sheltered ? 0.12 : 0.1), t, 0.8);
    this.weather.wind.gain.setTargetAtTime(wind * (sheltered ? 0.03 : 0.2), t, 1.2);
  }

  /** A thunder crack and rolling rumble, delayed by distance (seconds). @param {number} delay */
  thunder(delay) {
    const out = this.ambBus;
    const near = Math.max(0.25, 1 - delay / 4);
    this._noise(out, delay, 0.35, 0.5 * near, { color: 'white', freq: 1400, freqEnd: 300, q: 0.5 });
    for (let k = 0; k < 4; k++) this._noise(out, delay + 0.1 + k * rnd(0.3, 0.8), rnd(1.2, 2.6), rnd(0.3, 0.55), { color: 'brown', type: 'lowpass', freq: rnd(90, 200), freqEnd: 50, attack: 0.25 });
  }

  /**
   * Switch the continuous soundscape, the reverb space and the score's context.
   * @param {string} name observatory|fen|badlands|wood|town|dungeon @param {boolean} night
   */
  setAmbience(name, night) {
    this.ambience = name;
    this.night = night;
    const ctx = this.ctx;
    if (!ctx || !this.amb || !this.wet) return;
    /** @type {Record<string, [BiquadFilterType, number, number, number]>} type, frequency, air gain, low gain */
    const P = {
      observatory: ['lowpass', 260, 0.05, 0.12], dungeon: ['lowpass', 320, 0.04, 0.16], fen: ['bandpass', 700, 0.05, 0.05],
      badlands: ['bandpass', 420, 0.08, 0.06], wood: ['highpass', 2400, 0.025, 0.03], town: ['bandpass', 900, 0.03, 0.04],
    };
    const [type, freq, gain, low] = P[name] || P.observatory;
    const t = ctx.currentTime;
    this.amb.filter.type = type;
    this.amb.filter.frequency.setTargetAtTime(freq, t, 0.5);
    this.amb.gain.gain.setTargetAtTime(gain * (night ? 0.7 : 1), t, 1.2);
    this.amb.low.gain.setTargetAtTime(low, t, 1.2);
    const cave = name === 'observatory' || name === 'dungeon';
    this.wet.cave.gain.setTargetAtTime(cave ? 0.85 : 0, t, 0.8);
    this.wet.open.gain.setTargetAtTime(cave ? 0 : name === 'town' ? 0.45 : 0.3, t, 0.8);
    this._setMusic(cave ? name : name === 'town' && !night ? 'town' : night ? 'night' : 'day');
  }

  /** Random event sounds for the current ambience, called from the scheduler (~10 Hz). */
  _ambientTick() {
    const r = Math.random();
    const a = this.ambience;
    const out = this.ambBus;
    if ((a === 'observatory' || a === 'dungeon') && r < 0.03) {
      // A drip in the dark, far off in the stone.
      this._modal(out, 0, rnd(1400, 2600), MODES.glass, 0.03, 0.25);
      if (a === 'dungeon' && Math.random() < 0.15) this._noise(out, 0.2, 2.5, 0.05, { color: 'brown', type: 'lowpass', freq: 120, attack: 1 });
    } else if (a === 'fen' && r < 0.04) {
      // Frogs: low throat pulses through a vowel resonance.
      const f = rnd(70, 110);
      for (let k = 0; k < 3; k++) this._syllable(out, k * 0.13, f, 0.09, 0.03, [300, 900, 2200]);
    } else if (a === 'wood' && !this.night && r < 0.05) {
      // Birdsong: quick frequency-swept whistles.
      const base = rnd(2600, 4200);
      for (let k = 0; k < 2 + Math.floor(Math.random() * 3); k++) this._osc(out, k * rnd(0.08, 0.14), 'sine', base * vary(1, 0.1), 0.07, 0.02, { freqEnd: base * rnd(0.7, 1.5) });
    } else if (a === 'badlands' && r < 0.012) {
      this._noise(out, 0, 2.2, 0.08, { color: 'pink', freq: 300, freqEnd: 800, attack: 0.9 });
    } else if (a === 'town' && !this.night && r < 0.05) {
      if (Math.random() < 0.3) this._modal(out, 0, rnd(900, 1300), MODES.plate, 0.015, 0.4);
      else this.voice(rnd(0.7, 1.4), 2 + Math.floor(Math.random() * 3), 0.01);
    }
    if (this.night && a !== 'dungeon' && a !== 'observatory') {
      if (Math.random() < 0.06) for (let k = 0; k < 3; k++) this._osc(out, k * 0.05, 'sine', vary(4300, 0.03), 0.03, 0.006);
      if (a === 'wood' && Math.random() < 0.006) for (let k = 0; k < 2; k++) this._syllable(out, k * 0.45, 380, 0.35, 0.02, [400, 800, 2600]);
    }
    // Individual drops on nearby surfaces while it rains.
    if (this.rainLevel > 0.1 && Math.random() < this.rainLevel) this._modal(out, Math.random() * 0.1, rnd(1800, 4200), MODES.wood, 0.01 * this.rainLevel, 0.6);
    // Crackling fires and hissing vents around the player.
    for (const e of this.emitters.values()) {
      if (e.kind === 'fire' && Math.random() < 0.5) this._grains(e.panner, 0, 0.1, 1 + Math.floor(Math.random() * 3), 0.05, rnd(1500, 4000));
      if (e.kind === 'fire' && Math.random() < 0.04) this._noise(e.panner, 0, 0.25, 0.04, { color: 'brown', type: 'lowpass', freq: 300 });
      if (e.kind === 'vent' && Math.random() < 0.02) this._noise(e.panner, 0, 1.2, 0.06, { color: 'white', type: 'highpass', freq: 2500, freqEnd: 1200, attack: 0.15 });
    }
  }

  /**
   * Keep looping positional sources for nearby fires and vents.
   * @param {{key: string, kind: 'fire'|'vent', x: number, y: number, z: number}[]} list
   */
  setEmitters(list) {
    const ctx = this.ctx;
    if (!ctx || !this.ambBus || !this.noise) return;
    const keep = new Set(list.map((e) => e.key));
    for (const [key, e] of this.emitters) {
      if (keep.has(key)) continue;
      const t = ctx.currentTime;
      e.gain.gain.setTargetAtTime(0, t, 0.2);
      e.src.stop(t + 1);
      e.src.onended = () => { e.panner.disconnect(); e.air.disconnect(); e.gain.disconnect(); };
      this.emitters.delete(key);
    }
    for (const it of list) {
      if (this.emitters.has(it.key) || ![it.x, it.y, it.z].every(Number.isFinite)) continue;
      const { panner, air } = this._panner(it, this.ambBus);
      const src = ctx.createBufferSource();
      src.buffer = it.kind === 'fire' ? this.noise.brown : this.noise.pink;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = it.kind === 'fire' ? 'lowpass' : 'bandpass';
      f.frequency.value = it.kind === 'fire' ? 700 : 3200;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.setTargetAtTime(it.kind === 'fire' ? 0.18 : 0.03, ctx.currentTime, 0.5);
      src.connect(f).connect(gain).connect(panner);
      src.start(0, Math.random());
      this.emitters.set(it.key, { kind: it.kind, pos: { x: it.x, y: it.y, z: it.z }, panner, air, gain, src });
    }
  }

  // -------------------------------------------------------------------------
  // Movement and the player
  // -------------------------------------------------------------------------

  /** Heel-toe footstep with a surface texture. @param {string} surface stone|metal|wood|grass|mud|dirt|water */
  footstep(surface) {
    if (!this._limit('step', 0.18)) return;
    const out = this.sfx;
    const g = vary(1, 0.15);
    const toe = rnd(0.035, 0.06);
    if (surface === 'stone' || surface === 'metal') {
      // Hollow, resonant slabs: a heel thud that rings the stone, then a gritty toe.
      this._thud(out, 0, 95, 0.12 * g, 0.12);
      this._modal(out, 0, vary(surface === 'metal' ? 240 : 170), MODES.slab, 0.035 * g, surface === 'metal' ? 1.8 : 1);
      this._noise(out, toe, 0.04, 0.03 * g, { freq: 2600, q: 1.5 });
    } else if (surface === 'wood') {
      this._thud(out, 0, 110, 0.1 * g, 0.1);
      this._modal(out, toe, vary(320), MODES.wood, 0.05 * g);
      if (Math.random() < 0.15) this.creak('board');
    } else if (surface === 'mud') {
      // Squelch: a low suction sweep and a wet pop as the boot pulls free.
      this._noise(out, 0, 0.18, 0.09 * g, { color: 'brown', type: 'lowpass', freq: 900, freqEnd: 200 });
      this._osc(out, toe + 0.08, 'sine', vary(240), 0.06, 0.03 * g, { freqEnd: 700 });
      this._noise(out, toe, 0.1, 0.03 * g, { color: 'pink', freq: 1800, q: 2 });
    } else if (surface === 'grass') {
      this._noise(out, 0, 0.12, 0.05 * g, { color: 'pink', type: 'highpass', freq: 2200, attack: 0.02 });
      this._thud(out, 0, 80, 0.05 * g, 0.08);
    } else if (surface === 'dirt') {
      // Crunching gravel: a thud and a scatter of grit grains.
      this._thud(out, 0, 85, 0.07 * g, 0.1);
      this._grains(out, 0, 0.09, 9, 0.035 * g, 3000);
    } else {
      this._noise(out, 0, 0.22, 0.1 * g, { color: 'pink', freq: 900, freqEnd: 400, q: 0.8 });
      this._osc(out, 0.05, 'sine', vary(380), 0.08, 0.025, { freqEnd: 900 });
    }
  }

  /** Construct footfalls, placed in 3D. @param {string} kind mite|sentinel|golem|wisp @param {Pos} at */
  enemyStep(kind, at) {
    if (kind === 'wisp') return;
    const out = this._out(at, 0.5);
    if (kind === 'golem') {
      this._thud(out, 0, 48, 0.3, 0.4);
      this._grains(out, 0.02, 0.12, 6, 0.03, 1800);
    } else {
      this._modal(out, 0, vary(kind === 'mite' ? 1500 : 900), MODES.plate, 0.025, 0.3);
      this._noise(out, 0, 0.03, 0.04, { freq: 4000, q: 2 });
    }
  }

  dash() { this._whoosh(this.sfx, 0, 0.3, 0.25, 500, 3000); this._noise(this.sfx, 0, 0.25, 0.05, { color: 'white', type: 'highpass', freq: 5000 }); }
  thud() { this._thud(this.sfx, 0, 70, 0.4, 0.35); this._grains(this.sfx, 0.01, 0.1, 5, 0.03, 1500); }
  splash() {
    this._noise(this.sfx, 0, 0.6, 0.22, { color: 'pink', freq: 900, freqEnd: 300, q: 0.7 });
    for (let k = 0; k < 6; k++) this._osc(this.sfx, rnd(0.05, 0.5), 'sine', rnd(300, 700), 0.05, 0.03, { freqEnd: rnd(800, 1600) });
  }
  hurt() {
    this._thud(this.sfx, 0, 120, 0.25, 0.25);
    this._noise(this.sfx, 0, 0.12, 0.12, { color: 'pink', type: 'lowpass', freq: 900 });
    this._syllable(this.sfx, 0.02, vary(115), 0.18, 0.06, VOWELS[0]);
  }
  eat() { for (let k = 0; k < 3; k++) this._grains(this.sfx, k * 0.13, 0.06, 6, 0.04, 1600); }

  // -------------------------------------------------------------------------
  // Weapons and spells
  // -------------------------------------------------------------------------

  /** Tuning Fork strike: whoosh, impact, and the fork's own modal ring. */
  forkBlast() {
    const out = this.sfx;
    this._whoosh(out, 0, 0.2, 0.2, 700, 2600);
    this._thud(out, 0.06, 110, 0.22, 0.2);
    this._modal(out, 0.06, vary(440, 0.04), MODES.fork, 0.1);
  }
  parrySwing() { this._whoosh(this.sfx, 0, 0.18, 0.16, 1200, 3800); }
  /** A deflected blow: metal-on-metal clang plus the fork singing. */
  deflect() {
    const out = this.sfx;
    this._noise(out, 0, 0.03, 0.25, { color: 'white', freq: 3800, q: 1.2 });
    this._modal(out, 0, vary(520, 0.05), MODES.plate, 0.12, 1.4);
    this._modal(out, 0.01, vary(880, 0.03), MODES.fork, 0.08, 0.8);
  }
  block() {
    this._thud(this.sfx, 0, 140, 0.18, 0.15);
    this._modal(this.sfx, 0, vary(380), MODES.plate, 0.06, 0.6);
  }
  meleeHit() {
    this._thud(this.sfx, 0, 130, 0.25, 0.18);
    this._noise(this.sfx, 0, 0.06, 0.18, { color: 'white', freq: 1800, q: 1.2 });
    this._modal(this.sfx, 0.005, vary(700), MODES.plate, 0.05, 0.5);
  }
  /** Mechanical latch click shared by the ranged weapons. */
  _latch() {
    this._noise(this.sfx, 0, 0.012, 0.15, { color: 'white', type: 'highpass', freq: 3500 });
    this._modal(this.sfx, 0, vary(3100), [[1, 1, 0.03], [1.8, 0.5, 0.02]], 0.06);
  }
  /** Prism Scattergun: latch, pressurized burst, crystalline shimmer. */
  shard() {
    this._latch();
    this._noise(this.sfx, 0.01, 0.22, 0.3, { color: 'pink', freq: 1600, freqEnd: 500, q: 0.9 });
    this._thud(this.sfx, 0.01, 90, 0.18, 0.15);
    for (let k = 0; k < 4; k++) this._modal(this.sfx, 0.02 + k * 0.02, rnd(2400, 5200), MODES.glass, 0.025, 0.4);
  }
  /** Alchemical Crossbow: latch, string snap, bolt whoosh. */
  bow() {
    this._latch();
    this._pluck(this.sfx, 0.01, vary(165), 0.5, 0.9);
    this._noise(this.sfx, 0.01, 0.03, 0.2, { color: 'white', freq: 2500, q: 2 });
    this._whoosh(this.sfx, 0.03, 0.25, 0.12, 2400, 900);
  }
  flare() { this._latch(); this._whoosh(this.sfx, 0.02, 0.35, 0.14, 1200, 400); this._grains(this.sfx, 0.03, 0.4, 14, 0.04, 2500); }
  frostShot() {
    this._latch();
    for (let k = 0; k < 3; k++) this._modal(this.sfx, 0.02 + k * 0.03, rnd(2600, 4400), MODES.glass, 0.03, 0.5);
    this._noise(this.sfx, 0.02, 0.3, 0.08, { color: 'white', type: 'highpass', freq: 5500 });
  }
  /** Ricochet ping off stone, in 3D. @param {Pos} [at] */
  ricochet(at) {
    if (!this._limit('ric', 0.06)) return;
    const out = this._out(at, 0.6);
    const f = rnd(2400, 4200);
    this._osc(out, 0, 'sine', f, 0.25, 0.06, { freqEnd: f * 0.7 });
    this._noise(out, 0, 0.02, 0.1, { color: 'white', freq: 3000, q: 1.5 });
  }
  /** Runecasting: sub-bass swell, crackling static, then a chord voiced for the spell. @param {string} spell */
  cast(spell) {
    const out = this.sfx;
    this._osc(out, 0, 'sine', 42, 0.55, 0.3, { attack: 0.3, freqEnd: 55 });
    this._grains(out, 0, 0.35, 18, 0.03, 4500);
    /** @type {Record<string, number[]>} */
    const CH = { lumina: [76, 80, 83, 88], mending: [64, 67, 71, 74], push: [40, 47, 52], unlock: [69, 72, 76, 81], feather: [79, 83, 86, 91] };
    const notes = CH[spell] ?? [69, 74, 78];
    if (spell === 'push') {
      this._whoosh(out, 0.25, 0.45, 0.3, 300, 1600);
      notes.forEach((n) => this._bowed(out, 0.28, hz(n), 0.25, 0.05, { attack: 0.02, release: 0.5, bright: 0.7 }));
    } else if (spell === 'mending') {
      notes.forEach((n, k) => this._bowed(out, 0.3 + k * 0.05, hz(n), 0.6, 0.03, { attack: 0.3, release: 1.2, bright: 0.4 }));
      notes.forEach((n, k) => this._pluck(out, 0.3 + k * 0.07, hz(n + 12), 0.15, 0.6));
    } else {
      notes.forEach((n, k) => this._modal(out, 0.3 + k * (spell === 'unlock' ? 0.08 : 0.03), hz(n), MODES.celesta, 0.05, 0.8));
      if (spell === 'feather') this._whoosh(out, 0.3, 0.6, 0.08, 1500, 5000);
    }
  }
  /** Enemy attack tells, placed in 3D. @param {'stalker'|'weaver'|'warden'} kind @param {Pos} [at] */
  telegraph(kind, at) {
    const out = this._out(at, 1.5);
    if (kind === 'stalker') {
      // Clockwork ratchet winding up, then a rising ring.
      for (let k = 0; k < 7; k++) this._modal(out, 0.3 * (1 - (1 - k / 7) ** 1.6), vary(1800), [[1, 1, 0.025], [1.9, 0.4, 0.015]], 0.06);
      this._osc(out, 0.1, 'sine', 900, 0.45, 0.04, { freqEnd: 1800, attack: 0.3 });
    } else if (kind === 'weaver') {
      this._osc(out, 0, 'sine', 400, 0.55, 0.06, { freqEnd: 1300, attack: 0.4 });
      this._modal(out, 0.45, 1300, MODES.glass, 0.05);
    } else {
      // Stone groan: grinding brown noise and a deep bell.
      this._noise(out, 0, 0.9, 0.25, { color: 'brown', freq: 140, freqEnd: 90, q: 3, attack: 0.3 });
      this._modal(out, 0.1, 110, MODES.bell, 0.08, 0.8);
    }
  }
  /** @param {Pos} [at] */
  enemyShoot(at) {
    const out = this._out(at, 1);
    this._osc(out, 0, 'sine', 180, 0.3, 0.12, { freqEnd: 520, attack: 0.05 });
    this._modal(out, 0.05, vary(1100), MODES.glass, 0.04, 0.5);
  }
  /** @param {Pos} [at] */
  slam(at) {
    const out = this._out(at, 2.5);
    this._thud(out, 0, 50, 0.55, 0.6);
    this._noise(out, 0, 1.6, 0.35, { color: 'brown', type: 'lowpass', freq: 400, freqEnd: 90 });
    this._noise(out, 0, 0.08, 0.25, { color: 'white', freq: 1100, q: 0.8 });
    this._grains(out, 0.05, 0.6, 16, 0.04, 2000);
  }
  /** @param {Pos} [at] */
  enemyHit(at) {
    if (!this._limit('hit', 0.04)) return;
    const out = this._out(at, 0.8);
    this._noise(out, 0, 0.02, 0.15, { color: 'white', freq: 2600, q: 1.5 });
    this._modal(out, 0, rnd(500, 900), MODES.plate, 0.05, 0.45);
  }
  /** A construct comes apart: springs, gear rattle, a heavy fall. @param {Pos} [at] */
  enemyDie(at) {
    const out = this._out(at, 2);
    for (let k = 0; k < 8; k++) this._modal(out, k * rnd(0.03, 0.06), rnd(1200, 3200), MODES.coin, 0.03, 0.4);
    this._osc(out, 0.05, 'sine', 1400, 0.4, 0.04, { freqEnd: 300 });
    this._thud(out, 0.35, 70, 0.3, 0.35);
    this._grains(out, 0.35, 0.3, 10, 0.03, 2200);
  }

  // -------------------------------------------------------------------------
  // World and UI foley
  // -------------------------------------------------------------------------

  /**
   * Hinges and mechanisms: wooden lids and boards creak, doors groan, levers grind stone on stone.
   * @param {'chest'|'door'|'lever'|'board'} [kind]
   */
  creak(kind = 'door') {
    const ctx = this.ctx;
    const out = this.sfx;
    if (!ctx || !out) return;
    if (kind === 'lever') {
      this._grind(out, 0, 0.6, 0.25);
      this._thud(out, 0.55, 90, 0.2, 0.2);
      return;
    }
    // Stick-slip friction: a buzz whose pitch and level judder, through a wooden resonance.
    const t = ctx.currentTime;
    const dur = kind === 'board' ? 0.2 : kind === 'chest' ? 0.5 : 0.7;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = kind === 'board' ? rnd(150, 230) : rnd(70, 110);
    osc.frequency.setValueAtTime(base, t);
    for (let k = 1; k <= 8; k++) osc.frequency.linearRampToValueAtTime(base * rnd(0.7, 1.3), t + (dur * k) / 8);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = rnd(600, 1100);
    body.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'board' ? 0.03 : 0.07, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(body).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
    if (kind !== 'board') this._thud(out, dur * 0.9, 100, 0.12, 0.15);
  }

  /** Heavy stone sliding on stone. @param {AudioNode|null} out @param {number} when @param {number} dur @param {number} gain */
  _grind(out, when, dur, gain) {
    this._noise(out, when, dur, gain, { color: 'brown', freq: 220, freqEnd: 140, q: 2.5, attack: 0.08 });
    this._grains(out, when, dur, Math.round(dur * 30), gain * 0.15, 1300);
  }

  gateOpen() {
    this._grind(this.sfx, 0, 3, 0.35);
    this._thud(this.sfx, 2.9, 45, 0.45, 0.6);
    [62, 69, 74, 81].forEach((n, k) => this._modal(this.ui, 0.4 + k * 0.25, hz(n), MODES.bell, 0.06, 1.6));
  }
  /** Lockpicking: a tumbler click with the spring's faint tension. */
  lockClick() {
    this._modal(this.sfx, 0, rnd(3800, 5200), [[1, 1, 0.02], [1.6, 0.5, 0.015]], 0.08);
    this._osc(this.sfx, 0, 'sine', rnd(700, 900), 0.12, 0.01, { freqEnd: 1100 });
  }
  lockOpen() {
    this._modal(this.sfx, 0, 2400, [[1, 1, 0.04], [1.7, 0.5, 0.03]], 0.1);
    this._modal(this.sfx, 0.08, 1800, [[1, 1, 0.06], [2.3, 0.4, 0.04]], 0.1);
    this._osc(this.sfx, 0.08, 'sine', 1200, 0.15, 0.02, { freqEnd: 500 });
  }
  lockBreak() {
    this._noise(this.sfx, 0, 0.02, 0.2, { color: 'white', freq: 5000, q: 1 });
    this._modal(this.sfx, 0, 3300, MODES.plate, 0.05, 0.3);
    this._osc(this.sfx, 0.01, 'sine', 2600, 0.25, 0.03, { freqEnd: 900 });
  }
  /** Alchemy: bubbles rising through liquid, then a glass clink. */
  brew() {
    for (let k = 0; k < 14; k++) {
      const f = rnd(250, 700);
      this._osc(this.sfx, k * rnd(0.04, 0.09), 'sine', f, rnd(0.04, 0.08), 0.03, { freqEnd: f * rnd(1.8, 3) });
    }
    this._modal(this.sfx, 0.9, vary(1500), MODES.glass, 0.06, 0.6);
  }
  coins() { for (let k = 0; k < 5; k++) this._modal(this.ui, k * rnd(0.03, 0.07), rnd(2400, 3600), MODES.coin, 0.04, 0.6); }
  /** Parchment rustle for the journal and map. */
  page() {
    this._noise(this.ui, 0, 0.25, 0.08, { color: 'pink', type: 'highpass', freq: 3000, freqEnd: 1500, attack: 0.05 });
    this._grains(this.ui, 0.02, 0.2, 10, 0.02, 4000);
  }
  swap() {
    this._noise(this.sfx, 0, 0.12, 0.05, { color: 'pink', freq: 1400, freqEnd: 2600, q: 1.5, attack: 0.03 });
    this._modal(this.sfx, 0.08, vary(2200), [[1, 1, 0.03], [2.1, 0.4, 0.02]], 0.04);
  }
  pickup() {
    this._noise(this.ui, 0, 0.12, 0.05, { color: 'pink', freq: 1800, q: 1, attack: 0.02 });
    [76, 79, 83].forEach((n, k) => this._pluck(this.ui, 0.04 + k * 0.05, hz(n), 0.12, 0.7));
  }
  /** @param {number} [freq] */
  chime(freq = 1320) { this._modal(this.ui, 0, freq, MODES.celesta, 0.07, 0.7); }
  levelUp() { [62, 66, 69, 74, 78].forEach((n, k) => { this._pluck(this.ui, k * 0.09, hz(n), 0.2, 0.7); this._modal(this.ui, k * 0.09, hz(n + 12), MODES.celesta, 0.03); }); }
  quest() { [69, 74, 76].forEach((n, k) => this._pluck(this.ui, k * 0.12, hz(n), 0.2, 0.6)); this._modal(this.ui, 0.3, hz(81), MODES.celesta, 0.04); }
  skillUp() { this._pluck(this.ui, 0, hz(74), 0.18, 0.7); this._modal(this.ui, 0.08, hz(81), MODES.celesta, 0.05); }
  victory() {
    [62, 66, 69, 74].forEach((n) => this._bowed(this.ui, 0, hz(n), 2, 0.035, { attack: 0.6, release: 2.5, bright: 0.5 }));
    [74, 78, 81, 86].forEach((n, k) => this._modal(this.ui, 0.3 + k * 0.15, hz(n), MODES.celesta, 0.05));
  }
  defeat() { [57, 53, 50, 45].forEach((n, k) => this._bowed(this.ui, k * 0.5, hz(n), 0.8, 0.04, { attack: 0.3, release: 1.5, bright: 0.3 })); }

  /** Murmured syllables in an NPC's register. @param {number} pitch @param {number} syllables @param {number} [gain] */
  voice(pitch, syllables, gain = 0.05) {
    let t = 0;
    const f0 = 120 * pitch;
    for (let k = 0; k < syllables; k++) {
      const d = rnd(0.09, 0.17);
      this._syllable(this.sfx, t, vary(f0, 0.12), d, gain, VOWELS[Math.floor(Math.random() * VOWELS.length)]);
      t += d + rnd(0.02, 0.07);
    }
  }
}
