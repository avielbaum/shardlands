/**
 * @file Game state and rules, fixed-timestep loop, game-state machine (EXPLORE, DIALOGUE,
 * INVENTORY, SKILLS, JOURNAL, MAP, TRADE, LOOT, READ, REST, PAUSE, DEAD, ENDING), the guided
 * tutorial coordinator, dynamic weather, input
 * orchestration (keyboard, mouse with Pointer Lock plus a free-look fallback, dual touch
 * joysticks), the diegetic HUD, modal UIs and the localStorage save/load manager.
 */
import {
  buildObservatory, buildOverworld, buildDungeon, Level, ChunkStreamer, HAZARD, STEP, TILE,
  BIOME_NAMES, SITES, mulberry32,
} from './world.js';
import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { SPR, spriteRect } from './textures.js';
import { Player, Enemy, Orb, NPC, Particle, angleDiff } from './entities.js';
import {
  Character, QuestLog, Dialogue, ITEMS, RECIPES, SPELLS, SKILLS, ATTRIBUTES, PERKS, FACTIONS, SHOPS, BOOKS,
  makeContract, buyPrice, sellPrice, craft, spellFor, PROFESSIONS, BIRTHSIGNS, DESTINY_QUIZ, OMENS, omenChoices, readDestiny,
  randomName, applyOrigin,
} from './rpg.js';

/** @typedef {import('./entities.js').FrameInput} FrameInput */
/** @typedef {import('./entities.js').Projectile} Projectile */
/** @typedef {import('./world.js').Prop} Prop */
/** @typedef {import('./world.js').Door} Door */
/** @typedef {import('./world.js').Portal} Portal */
/** @typedef {import('./world.js').Light} Light */
/** @typedef {import('./renderer.js').SpriteDesc} SpriteDesc */
/** @typedef {import('./renderer.js').Env} Env */
/** @typedef {import('./rpg.js').Contract} Contract */
/** @typedef {import('./rpg.js').Marker} Marker */
/** @typedef {{kind:'npc', ref:NPC, label:string}|{kind:'prop', ref:Prop, label:string}|{kind:'door', ref:Door, label:string}} Interactable */

const STEP_DT = 1 / 60;
const SAVE_KEY = 'aetherium-shardlands-save-v1';
/** Last character identity chosen, to pre-fill the next creation screen. */
const IDENTITY_KEY = 'shardlands-identity';
/** Lever -> anchors it toggles (left, heart, right). */
const LEVER_MAP = [[0, 1], [1], [1, 2]];
const ANCHOR_START = [false, true, false];

/**
 * Guided tutorial steps. Each has a title and desktop / touch prompts; the coordinator in
 * Game.updateTutorial() advances them automatically as the player completes each action.
 */
export const TUTORIAL_STEPS = Object.freeze([
  {
    title: 'Look & Move',
    desktop: 'Look around with the mouse and walk with WASD to the glowing Resonance Brazier.',
    touch: 'Aim with your right thumb and walk with your left thumb to the glowing Resonance Brazier.',
  },
  {
    title: 'Interact & Loot',
    desktop: 'Face the chest by the north wall and press E. Take the Tuning Fork, Aether Lantern and Lumina Runestone, and the tools of your old trade.',
    touch: 'Face the chest by the north wall and tap USE. Take the Tuning Fork, Aether Lantern and Lumina Runestone, and the tools of your old trade.',
  },
  {
    title: 'Equip',
    desktop: 'Open your pack with I or Tab, check the Tuning Fork and Aether Lantern are equipped, then close it. Your Birthsign Power waits on R; resting recharges it.',
    touch: 'Tap PACK, check the Tuning Fork and Aether Lantern are equipped, then close it with ✕. Your Birthsign Power waits on POWER; resting recharges it.',
  },
  {
    title: 'Combat, Parry & Dash',
    desktop: 'Open the east door into the Atrium. Strike the training automaton with Left Click, parry its lunge with Right Click, Phase Dash with Shift.',
    touch: 'Open the east door into the Atrium. Strike the training automaton with ATTACK, parry its lunge with PARRY, dodge with DASH.',
  },
  {
    title: 'Runes & the Gate',
    desktop: 'Inscribe Lumina in Skills (K) and cast it in the Gate Hall, or pull the Harmonic Levers in the Conduit Room until all three anchors sing. Then step through the Great Astrolabe Gate.',
    touch: 'Inscribe Lumina in SKILLS and cast it in the Gate Hall, or pull the Harmonic Levers in the Conduit Room until all three anchors sing. Then step through the Great Astrolabe Gate.',
  },
]);

/** Weather kinds: target rain and wind, and the label shown under the clock. */
const WEATHER = {
  clear: { rain: 0, wind: 0.15, label: 'Clear' },
  cloudy: { rain: 0, wind: 0.35, label: 'Overcast' },
  rain: { rain: 0.6, wind: 0.4, label: 'Rain' },
  storm: { rain: 1, wind: 0.85, label: 'Storm' },
};
/** Chance of each weather kind per biome (fen, badlands, wood). */
const WEATHER_ODDS = [
  [['clear', 0.3], ['cloudy', 0.25], ['rain', 0.3], ['storm', 0.15]],
  [['clear', 0.5], ['cloudy', 0.35], ['rain', 0.1], ['storm', 0.05]],
  [['clear', 0.4], ['cloudy', 0.3], ['rain', 0.22], ['storm', 0.08]],
];
/** @param {number} v @param {number} a @param {number} b */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** @param {number[]} a @param {number[]} b @param {number} t */
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Pack a 0/1 byte array into base64 bits. @param {Uint8Array} a */
function packBits(a) {
  let s = '';
  for (let i = 0; i < a.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) if (a[i + k]) b |= 1 << k;
    s += String.fromCharCode(b);
  }
  return btoa(s);
}

/** @param {string} b64 @param {Uint8Array} out */
function unpackBits(b64, out) {
  const s = atob(b64);
  for (let i = 0; i < out.length; i++) out[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
}

export class Game {
  /** @param {AudioEngine} audio @param {number} seed */
  constructor(audio, seed) {
    this.audio = audio;
    this.seed = seed;
    this.char = new Character();
    this.quests = new QuestLog();
    this.factions = { rep: /** @type {Record<string, number>} */ ({ artificers: 0, wardens: 0, cinderwick: 0, oakhaven: 0 }), member: { artificers: false, wardens: false } };
    /** @type {Record<string, any>} */
    this.flags = { levers: [false, false, false], rent: null, rentUntil: 0, pumpFixed: false, gateOpen: false, ending: false, levisGiven: false };
    /** @type {{artificers: Contract|null, wardens: Contract|null, n: number}} */
    this.contracts = { artificers: null, wardens: null, n: 0 };
    /** @type {Set<string>} */
    this.discovered = new Set();
    /** Persistent world changes, keyed by stable ids. */
    this.world = {
      /** @type {Record<string, {locked:boolean, shut:boolean}>} */ doors: {},
      /** @type {Record<string, [string, number][]>} */ loot: {},
      /** @type {Record<string, boolean>} */ gone: {},
      /** @type {Record<string, boolean>} */ killed: {},
    };
    /** @type {{level:string, x:number, z:number, label:string}[]} */
    this.markers = [];
    /** @type {Record<string, {day:number, items:[string, number][]}>} */
    this.shopStock = {};
    this.minutes = 7.5 * 60;
    this.time = 0;
    /** @type {Map<string, Level>} */
    this.levels = new Map();
    /** @type {Level} */
    this.level = this.getLevel('observatory');
    this.player = new Player(this.level.spawn.x, 0, this.level.spawn.z, this.level.spawn.yaw);
    /** @type {Enemy[]} */
    this.enemies = [];
    /** Slain enemies still playing their collapse animation. @type {Enemy[]} */
    this.fallen = [];
    /** @type {NPC[]} */
    this.npcs = [];
    /** @type {Orb[]} */
    this.orbs = [];
    /** @type {Projectile[]} */
    this.projectiles = [];
    /** @type {Particle[]} */
    this.particles = [];
    this.streamer = new ChunkStreamer(this.level, 3);
    /** @type {number[]} chunk keys the renderer should build */
    this.chunkLoads = [];
    /** @type {number[]} */
    this.chunkUnloads = [];
    this.levelChanged = true;
    this.streamT = 0;
    this.revealT = 0;
    this.flowT = 0;
    this.flowOx = 0;
    this.flowOz = 0;
    this.flow = new Int16Array(48 * 48);
    this.fx = { dash: 0, parry: 0, hurt: 0, flash: 0 };
    /** Dynamic weather (saved; thunderT is transient). */
    this.weather = { kind: /** @type {keyof typeof WEATHER} */ ('clear'), rain: 0, wind: 0.15, next: 0, thunderT: 8 };
    /** @type {{text:string, t:number}[]} */
    this.notes = [];
    this.hotIndex = 0;
    this.dead = false;
    /** @type {Portal|null} */
    this.pendingTravel = null;
    /** @type {Env} */
    this.env = { fog: [0.03, 0.03, 0.07], fogDensity: 0.07, ambient: [0.07, 0.07, 0.12], sunDir: [0, 1, 0], sunCol: [0, 0, 0] };
    this.ambienceKey = '';
    this.hitmarker = 0;
    /** Props the Astrolabe birthsign has already chimed for (this session). @type {Set<string>} */
    this.pinged = new Set();
  }

  /** Start a fresh run: awaken in the Sunken Observatory. @param {boolean} [tutorial] guided tutorial on */
  /**
   * Start a fresh run. With an origin, the profession's bonuses and the birthsign apply, and the
   * profession's gear waits in the starter chest beside the core tools (ending the tutorial
   * early hands over the whole chest).
   * @param {boolean} [tutorial] @param {import('./rpg.js').Origin|null} [origin]
   */
  newRun(tutorial = false, origin = null) {
    this.flags.tutorial = { active: tutorial, step: 0, sawInventory: false, parried: false };
    if (origin) {
      applyOrigin(this.char, origin);
      const chest = this.level.props.find((pr) => pr.kind === 'chest' && pr.data.starter);
      const gear = PROFESSIONS[this.char.profession]?.gear ?? [];
      if (chest) this.world.loot[chest.key] = [...chest.data.loot, ...gear];
      if (this.char.birthsign === 'crown') for (const f of Object.keys(this.factions.rep)) this.factions.rep[f] += 15;
    }
    this.quests.start('main', 'The Unquiet Ley', 'main');
    this.setMain(10, 'I awoke in the Sunken Observatory. The Great Astrolabe Gate is sealed; the Keeper\'s log speaks of a Fork, three levers and three anchors.');
    this.enterLevel('observatory', this.level.spawn.x, this.level.spawn.z, this.level.spawn.yaw);
  }

  get hour() {
    return (this.minutes % 1440) / 60;
  }

  get day() {
    return Math.floor(this.minutes / 1440) + 1;
  }

  get tutorialActive() {
    return !!this.flags.tutorial?.active;
  }

  get mainStage() {
    return this.quests.get('main')?.stage ?? 0;
  }

  // -------------------------------------------------------------------------
  // Levels
  // -------------------------------------------------------------------------

  /** Build (or fetch) a level and apply persistent world state to it. @param {string} id */
  getLevel(id) {
    const cached = this.levels.get(id);
    if (cached) return cached;
    const L = id === 'observatory' ? buildObservatory(this.seed) : id === 'overworld' ? buildOverworld(this.seed) : buildDungeon(this.seed, id.slice(8));
    for (const d of L.doors) {
      const s = this.world.doors[d.key];
      if (s) { d.locked = s.locked; d.shut = s.shut; d.open = s.shut ? 0 : 1; }
    }
    if (id === 'observatory' && this.flags.gateOpen) {
      const gate = L.doors.find((d) => d.puzzle);
      if (gate) { gate.locked = false; gate.shut = false; gate.open = 1; }
    }
    for (const p of L.props) if (this.world.gone[p.key]) p.gone = true;
    this.levels.set(id, L);
    return L;
  }

  /** Place a contract relic in its dungeon if it is not there yet. @param {Level} L */
  _placeRelic(L) {
    const c = this.contracts.artificers;
    if (!c || c.kind !== 'relic' || L.id !== `dungeon:${c.dungeon}` || this.char.inventory.count('relic')) return;
    const key = `${L.id}:relic:${c.id}`;
    if (this.world.gone[key] || L.props.some((p) => p.key === key)) return;
    const boss = L.spawns.find((s) => s.boss) ?? L.spawns[0];
    const p = L.addProp('item', 'i_relic', boss.x - 1, boss.z + 0.5, { size: 0.7, data: { item: 'relic', qty: 1 } });
    p.key = key;
    L.finalize();
  }

  /** @param {string} id @param {number} x @param {number} z @param {number} yaw */
  enterLevel(id, x, z, yaw) {
    const L = this.getLevel(id);
    this._placeRelic(L);
    this.level = L;
    const p = this.player;
    p.x = x;
    p.z = z;
    p.y = L.heightAt(x, z);
    p.yaw = yaw;
    p.pitch = 0;
    p.vx = 0;
    p.vz = 0;
    p.vy = 0;
    p.fallFrom = p.y;
    p.lastSafe = { x, z, y: p.y };
    this.enemies = L.spawns.filter((s) => !this.world.killed[s.key]).map((s) => new Enemy(s, L.heightAt(s.x, s.z)));
    this.npcs = L.npcDefs.map((d) => new NPC(d, L));
    this.fallen = [];
    this.orbs = [];
    this.projectiles = [];
    this.particles = [];
    this.streamer = new ChunkStreamer(L, L.outdoor ? 4 : 3);
    this.chunkLoads = [];
    this.chunkUnloads = [];
    this.levelChanged = true;
    this.streamT = 0;
    this.flowT = 0;
    this.ambienceKey = '';
    if (id === 'overworld' && this.mainStage === 10) {
      this.setMain(20, 'I escaped the Sunken Observatory into the Shardlands. The Keeper\'s log mentioned the Artificers; I should seek Master Vance in Cinderwick, east along the road.');
    }
    this.notify(L.outdoor ? 'The Shardlands' : L.name);
    this.save(true);
  }

  /** @param {Portal} portal */
  travel(portal) {
    const L = this.getLevel(portal.level);
    this.enterLevel(portal.level, portal.x ?? L.spawn.x, portal.z ?? L.spawn.z, portal.yaw ?? L.spawn.yaw);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** @param {number} dt @param {FrameInput} input */
  update(dt, input) {
    if (this.dead) return;
    this.minutes += dt;
    this.time += dt;
    const p = this.player;
    const L = this.level;
    const c = this.char;
    p.update(dt, input, this);
    c.powerCD = Math.max(0, c.powerCD - dt);
    // Temporal Stasis: enemies and their orbs move at 35% speed.
    const edt = c.effects.stasis ? dt * 0.35 : dt;

    for (const d of L.doors) {
      d.hold = Math.max(0, d.hold - dt);
      const want = !d.shut || d.hold > 0 ? 1 : 0;
      d.open = clamp(d.open + clamp(want - d.open, -dt * 2, dt * 2.5), 0, 1);
    }
    const di = L.inBounds(Math.floor(p.x), Math.floor(p.z)) ? L.doorAt[L.idx(Math.floor(p.x), Math.floor(p.z))] : -1;
    if (di >= 0 && L.doors[di].portal && L.doors[di].open > 0.6) this.pendingTravel = L.doors[di].portal;

    this.streamT -= dt;
    if (this.streamT <= 0) {
      this.streamT = 0.25;
      const ev = this.streamer.update(p.x, p.z);
      this.chunkLoads.push(...ev.load);
      this.chunkUnloads.push(...ev.unload);
      this.audio.setEmitters(this._soundEmitters());
    }
    this.flowT -= dt;
    if (this.flowT <= 0) {
      this.flowT = 0.35;
      this._computeFlow();
    }

    this._shields();
    for (const e of this.enemies) if (e.alive && (e.x - p.x) ** 2 + (e.z - p.z) ** 2 < 4900) e.update(edt, this);
    this._separate();
    for (const e of this.enemies) if (!e.alive && e.state !== 'fall') this.fallen.push(e);
    this.fallen = this.fallen.filter((e) => (e.deadT += dt) < 1.6);
    this.enemies = this.enemies.filter((e) => e.alive);
    for (const n of this.npcs) n.update(dt, this, Math.hypot(n.x - p.x, n.z - p.z) < 50);
    for (const o of this.orbs) o.update(o.owner === 'enemy' ? edt : dt, this);
    for (const s of this.projectiles) s.update(dt, this);
    for (const q of this.particles) q.update(dt, L.heightAt(q.x, q.z));
    this.orbs = this.orbs.filter((o) => o.alive);
    this.projectiles = this.projectiles.filter((s) => s.alive);
    this.particles = this.particles.filter((q) => q.alive).slice(-300);

    this.revealT -= dt;
    if (this.revealT <= 0) {
      this.revealT = 0.3;
      L.reveal(p.x, p.z, (L.outdoor ? 14 : 6) * (c.profession === 'strider' ? 1.4 : 1));
      if (c.birthsign === 'astrolabe') this._astrolabePing();
      for (const lm of L.landmarks) {
        if (!this.discovered.has(lm.id) && Math.hypot(lm.x - p.x, lm.z - p.z) < lm.r) this.discover(lm.id, lm.name);
      }
      if (this.flags.rent && this.minutes > this.flags.rentUntil) this.flags.rent = null;
      if (this.tutorialActive) this.updateTutorial();
    }
    this.fx.dash = Math.max(0, this.fx.dash - dt * 3);
    this.fx.parry = Math.max(0, this.fx.parry - dt * 2.5);
    this.fx.hurt = Math.max(0, this.fx.hurt - dt * 1.8);
    this.hitmarker = Math.max(0, this.hitmarker - dt);
    for (const n of this.notes) n.t -= dt;
    this.notes = this.notes.filter((n) => n.t > 0);

    this.audio.setListener(p.x, p.y + p.eye, p.z, p.yaw, p.pitch);
    let near = 0;
    for (const e of this.enemies) if (e.awake && e.state !== 'home' && Math.hypot(e.x - p.x, e.z - p.z) < 14) near++;
    this.audio.setIntensity(near * 0.3);
    const amb = this.ambienceName();
    const night = this.hour < 6 || this.hour >= 20;
    if (amb + night !== this.ambienceKey) {
      this.ambienceKey = amb + night;
      this.audio.setAmbience(amb, night);
    }
    this._updateWeather(dt);
    this._updateEnv(dt);
    if (c.hp <= 0) this._die();
    if (this.pendingTravel) {
      const t = this.pendingTravel;
      this.pendingTravel = null;
      this.travel(t);
    }
  }

  ambienceName() {
    const L = this.level;
    if (L.id === 'observatory') return 'observatory';
    if (!L.outdoor) return 'dungeon';
    const p = this.player;
    if (L.zone[L.idx(Math.floor(p.x), Math.floor(p.z))] >= 0) return 'town';
    return ['fen', 'badlands', 'wood'][L.biomeAt ? L.biomeAt(p.x, p.z) : 2];
  }

  locationName() {
    const L = this.level;
    if (!L.outdoor) return L.name;
    const p = this.player;
    const z = L.zone[L.idx(Math.floor(p.x), Math.floor(p.z))];
    if (z === 0) return 'Oakhaven';
    if (z === 1) return 'Cinderwick';
    return BIOME_NAMES[L.biomeAt ? L.biomeAt(p.x, p.z) : 2];
  }

  /** Fog, ambient and sun by level, biome and time of day (eased). @param {number} dt */
  _updateEnv(dt) {
    const L = this.level;
    /** @type {Env} */
    let target;
    if (!L.outdoor) {
      const healed = L.id === 'observatory' && this.flags.ending;
      target = { fog: L.fog, fogDensity: L.fogDensity, ambient: healed ? [0.16, 0.18, 0.24] : L.ambient, sunDir: [0, 1, 0], sunCol: [0, 0, 0] };
    } else {
      const h = this.hour;
      const ang = ((h - 6) / 12) * Math.PI;
      const sy = Math.sin(ang);
      const day = clamp(sy * 1.6 + 0.25, 0, 1);
      const dusk = clamp(1 - Math.abs(sy) * 2.5, 0, 1) * (h > 4 && h < 21 ? 1 : 0);
      const biome = L.biomeAt ? L.biomeAt(this.player.x, this.player.z) : 2;
      const dayFog = [[0.5, 0.58, 0.54], [0.7, 0.57, 0.46], [0.46, 0.6, 0.6]][biome];
      // exp2 fog: visibility tuned to the ~64-unit streaming radius.
      const dens = [0.026, 0.016, 0.02][biome];
      let fog = mix3([0.06, 0.07, 0.13], dayFog, day);
      fog = mix3(fog, [0.75, 0.42, 0.28], dusk * 0.45);
      // After dark the key light is a cool, dim moon opposite the sun's arc.
      const moon = day < 0.05 ? clamp(-sy * 1.5, 0, 1) : 0;
      const sunCol = moon > 0 ? [0.13 * moon, 0.16 * moon, 0.26 * moon] : mix3([0, 0, 0], [1.0, 0.9, 0.75], day).map((v, k) => v + [0.5, 0.2, 0.05][k] * dusk * 0.6);
      const ldx = moon > 0 ? -Math.cos(ang) : Math.cos(ang);
      const ldy = Math.max(0.15, moon > 0 ? -sy : sy);
      const ldz = moon > 0 ? -0.25 : 0.35;
      const l = Math.hypot(ldx, ldy, ldz);
      // Weather greys the haze, thickens it, dims the sun and the sky light.
      const wet = this.weather.rain;
      const overcast = Math.max(wet, this.weather.kind === 'cloudy' ? 0.45 : 0);
      fog = mix3(fog, [0.42 * day + 0.05, 0.45 * day + 0.06, 0.5 * day + 0.1], overcast * 0.6);
      target = {
        fog, fogDensity: dens * (day < 0.3 ? 1.4 : 1) * (1 + wet * 0.9),
        ambient: mix3([0.15, 0.16, 0.26], [0.36, 0.37, 0.42], Math.max(day, dusk * 0.6)).map((v) => v * (1 - overcast * 0.25)),
        sunCol: sunCol.map((v) => v * (1 - overcast * 0.65)),
        sunDir: [ldx / l, ldy / l, ldz / l],
      };
    }
    const k = 1 - Math.exp(-dt * 2.5);
    const e = this.env;
    e.fog = mix3(e.fog, target.fog, k);
    e.ambient = mix3(e.ambient, target.ambient, k);
    e.sunCol = mix3(e.sunCol, target.sunCol, k);
    e.sunDir = target.sunDir;
    e.fogDensity += (target.fogDensity - e.fogDensity) * k;
  }

  /**
   * Weather: every few in-game hours roll a new kind from the current biome's odds, ease
   * rain and wind toward it, and throw lightning (flash + distance-delayed thunder) in storms.
   * @param {number} dt
   */
  _updateWeather(dt) {
    const w = this.weather;
    const L = this.level;
    if (this.minutes >= w.next) {
      const biome = L.outdoor && L.biomeAt ? L.biomeAt(this.player.x, this.player.z) : 2;
      let r = Math.random();
      const odds = WEATHER_ODDS[biome];
      w.kind = /** @type {keyof typeof WEATHER} */ ((odds.find(([, pr]) => (r -= /** @type {number} */ (pr)) < 0) ?? odds[0])[0]);
      w.next = this.minutes + 120 + Math.random() * 180;
    }
    const target = WEATHER[w.kind];
    w.rain += clamp(target.rain - w.rain, -dt * 0.05, dt * 0.05);
    w.wind += clamp(target.wind - w.wind, -dt * 0.05, dt * 0.05);
    this.fx.flash = Math.max(0, this.fx.flash - dt * 3);
    if (w.kind === 'storm' && w.rain > 0.6) {
      w.thunderT -= dt;
      if (w.thunderT <= 0) {
        w.thunderT = 6 + Math.random() * 12;
        const delay = 0.2 + Math.random() * 2.5;
        if (L.outdoor) this.fx.flash = 1 - delay / 3.5;
        this.audio.thunder(delay);
      }
    }
    this.audio.setWeather(w.rain, w.wind, !L.outdoor || L.covered(this.player.x, this.player.z));
  }

  // -------------------------------------------------------------------------
  // Guided tutorial
  // -------------------------------------------------------------------------

  /** Advance the tutorial when the current step's action is done. */
  updateTutorial() {
    const t = this.flags.tutorial;
    const c = this.char;
    const L = this.level;
    const done = [
      () => L.props.some((pr) => pr.kind === 'brazier' && Math.hypot(pr.x - this.player.x, pr.z - this.player.z) < 2.6),
      () => c.inventory.count('fork') > 0 && c.inventory.count('lantern') > 0 && c.inventory.count('rune_lux') > 0,
      () => t.sawInventory && c.equip.main === 'fork' && c.equip.off === 'lantern',
      () => !!this.world.killed['obs:training'] || t.parried,
      () => L.id === 'overworld',
    ][t.step];
    if (!done || !done()) return;
    t.step++;
    this.audio.chime(1320 + t.step * 120);
    if (t.step >= TUTORIAL_STEPS.length) {
      t.active = false;
      this.notify('Tutorial complete. The Shardlands are yours.');
      this.audio.quest();
    }
  }

  /**
   * End the tutorial now: open the Great Astrolabe Gate and hand over any starter gear still
   * in the starter chest (Tuning Fork, Aether Lantern, Lumina Runestone, 2 Healing Draughts).
   */
  endTutorial() {
    const t = this.flags.tutorial;
    if (!t || !t.active) return;
    t.active = false;
    const obs = this.getLevel('observatory');
    const chest = obs.props.find((pr) => pr.kind === 'chest' && pr.data.starter);
    if (chest) {
      const loot = this.world.loot[chest.key] ?? chest.data.loot ?? [];
      for (const [id, n] of loot) this.give(id, n);
      this.world.loot[chest.key] = [];
      chest.sprite = 'chest_open';
    }
    this._openGate(obs, 'Tutorial ended. The Great Astrolabe Gate stands open.');
  }

  /**
   * Unseal the Great Astrolabe Gate (lever puzzle, a rune in the Gate Hall, or ending the tutorial).
   * @param {Level} obs the observatory level @param {string} message
   */
  _openGate(obs, message) {
    if (this.flags.gateOpen) return;
    this.flags.gateOpen = true;
    const gate = obs.doors.find((d) => d.puzzle);
    if (gate) {
      gate.locked = false;
      gate.shut = false;
      this.world.doors[gate.key] = { locked: false, shut: false };
    }
    this.audio.gateOpen();
    this.notify(message);
  }

  /** A rune spoken in the Gate Hall resonates the anchors: an alternative to the levers. @param {string} spell */
  onSpellCast(spell) {
    const L = this.level;
    if (L.id !== 'observatory' || this.flags.gateOpen) return;
    if (L.zone[L.idx(Math.floor(this.player.x), Math.floor(this.player.z))] !== 3) return;
    this._openGate(L, `The anchors answer your ${SPELLS[spell].name}. The Great Astrolabe Gate grinds open!`);
  }

  /** Breadth-first distance field (48x48 window around the player) for enemies without sight. */
  _computeFlow() {
    const L = this.level;
    const p = this.player;
    const N = 48;
    const ox = Math.floor(p.x) - N / 2;
    const oz = Math.floor(p.z) - N / 2;
    this.flowOx = ox;
    this.flowOz = oz;
    const f = this.flow;
    f.fill(32767);
    const q = [];
    const si = Math.floor(p.x) - ox;
    const sj = Math.floor(p.z) - oz;
    f[sj * N + si] = 0;
    q.push(sj * N + si);
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const i = cur % N;
      const j = (cur / N) | 0;
      const ch = L.floorH[L.idx(clamp(i + ox, 0, L.w - 1), clamp(j + oz, 0, L.h - 1))];
      for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const n = nj * N + ni;
        if (f[n] <= f[cur] + 1) continue;
        if (L.blocked(ni + ox, nj + oz, ch, false, true)) continue;
        f[n] = f[cur] + 1;
        q.push(n);
      }
    }
  }

  /** Unit direction down the flow field, or null. @param {number} x @param {number} z */
  flowDir(x, z) {
    const N = 48;
    const i = Math.floor(x) - this.flowOx;
    const j = Math.floor(z) - this.flowOz;
    if (i < 0 || j < 0 || i >= N || j >= N) return null;
    const here = this.flow[j * N + i];
    if (here >= 32767) return null;
    let tx = this.player.x;
    let tz = this.player.z;
    if (here > 0) {
      let best = here;
      for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const v = this.flow[nj * N + ni];
        if (v < best) { best = v; tx = ni + this.flowOx + 0.5; tz = nj + this.flowOz + 0.5; }
      }
      if (best === here) return null;
    }
    const dx = tx - x;
    const dz = tz - z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d };
  }

  /**
   * Grid path for townsfolk (BFS inside a box around both ends; doors count as open).
   * @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1 @returns {{x:number, z:number}[]}
   */
  findPath(x0, z0, x1, z1) {
    const L = this.level;
    const pad = 8;
    const ax = Math.max(0, Math.floor(Math.min(x0, x1)) - pad);
    const az = Math.max(0, Math.floor(Math.min(z0, z1)) - pad);
    const bx = Math.min(L.w - 1, Math.floor(Math.max(x0, x1)) + pad);
    const bz = Math.min(L.h - 1, Math.floor(Math.max(z0, z1)) + pad);
    const W = bx - ax + 1;
    const H = bz - az + 1;
    const prev = new Int32Array(W * H).fill(-1);
    const s = (Math.floor(z0) - az) * W + (Math.floor(x0) - ax);
    const goal = (Math.floor(z1) - az) * W + (Math.floor(x1) - ax);
    if (s < 0 || goal < 0 || s >= W * H || goal >= W * H) return [];
    prev[s] = s;
    const q = [s];
    for (let h = 0; h < q.length && prev[goal] < 0; h++) {
      const cur = q[h];
      const i = (cur % W) + ax;
      const j = Math.floor(cur / W) + az;
      const ch = L.floorH[L.idx(i, j)];
      for (const [ni, nj] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
        if (ni < ax || nj < az || ni > bx || nj > bz) continue;
        const n = (nj - az) * W + (ni - ax);
        if (prev[n] >= 0) continue;
        const k = L.idx(ni, nj);
        if (L.wall[k] || L.hazard[k] || Math.abs(L.floorH[k] - ch) > STEP) continue;
        prev[n] = cur;
        q.push(n);
      }
    }
    if (prev[goal] < 0) return [];
    const path = [{ x: x1, z: z1 }];
    for (let cur = prev[goal]; cur !== s; cur = prev[cur]) path.unshift({ x: (cur % W) + ax + 0.5, z: Math.floor(cur / W) + az + 0.5 });
    return path;
  }

  /** NPCs open doors on their path. @param {number} x @param {number} z */
  holdDoorAt(x, z) {
    const L = this.level;
    const i = Math.floor(x);
    const j = Math.floor(z);
    if (!L.inBounds(i, j)) return;
    const d = L.doorAt[L.idx(i, j)];
    if (d >= 0) L.doors[d].hold = 1.2;
  }

  /** Basalt Wardens shield nearby allies. */
  _shields() {
    for (const e of this.enemies) e.shielded = false;
    for (const g of this.enemies) {
      if (!g.alive || g.kind !== 'golem' || !g.awake) continue;
      for (const e of this.enemies) if (e !== g && e.kind !== 'golem' && e.alive && Math.hypot(e.x - g.x, e.z - g.z) < 5.5) e.shielded = true;
    }
  }

  _separate() {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2;
        this.level.move(a, (-dx / d) * push, (-dz / d) * push, a.radius, a.y, false, true);
        this.level.move(b, (dx / d) * push, (dz / d) * push, b.radius, b.y, false, true);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  /**
   * @param {Enemy} e @param {number} amt @param {number} sx @param {number} sz @param {number} knock
   * @param {{burn?:boolean, slow?:boolean, quiet?:boolean, player?:boolean}} o player: the player's own attack
   */
  damageEnemy(e, amt, sx, sz, knock, o) {
    if (!e.alive || e.state === 'fall') return;
    if (o.player) {
      const c = this.char;
      if (c.effects.supernova) {
        amt *= 3;
        delete c.effects.supernova;
        this.notify('Supernova!');
        this.burst(e.x, e.y + 1, e.z, 24, [1.8, 0.9, 1.4], 4);
      } else if (c.birthsign === 'star' && Math.random() < 0.25) {
        amt *= 2;
        this.hitmarker = 0.35;
        this.burst(e.x, e.y + 1.2, e.z, 8, [1.6, 0.7, 1.2], 2);
      }
    }
    e.hp -= e.shielded ? amt * 0.25 : amt;
    e.flash = 0.1;
    e.wake();
    if (o.burn) e.burn = 3;
    if (o.slow) e.slow = 3;
    if (!o.quiet) {
      this.audio.enemyHit(e);
      this.hitmarker = 0.15;
    }
    if (knock) {
      const dx = e.x - sx;
      const dz = e.z - sz;
      const d = Math.hypot(dx, dz) || 1;
      const k = e.kind === 'golem' ? knock * 0.3 : knock;
      e.kx += (dx / d) * k;
      e.kz += (dz / d) * k;
    }
    if (e.hp <= 0) this.killEnemy(e, '');
  }

  /** @param {Enemy} e @param {string} how */
  killEnemy(e, how) {
    if (!e.alive) return;
    e.alive = false;
    this.world.killed[e.key] = true;
    this.audio.enemyDie(e);
    this.burst(e.x, e.y + 1, e.z, 16, [1.4, 1.0, 0.45], 3);
    if (how) this.notify(`The ${e.name} ${how}.`);
    if (e.state !== 'fall' && Math.random() < 0.4) {
      const drop = ['scrap', 'crystal', 'salt', 'ammo_shard'][Math.floor(Math.random() * 4)];
      const p = this.level.addProp('item', ITEMS[drop].sprite, e.x, e.z, { size: 0.6, data: { item: drop, qty: drop === 'ammo_shard' ? 6 : 1 } });
      this.level._indexProp(p);
    }
    if (this.contracts.wardens?.kind === 'bounty' && this.contractReady(this.contracts.wardens)) this.notify('Bounty complete: report to Captain Marr.');
  }

  /** Knocked-back constructs meet hazards. @param {Enemy} e */
  hazardCheck(e) {
    const hz = this.level.hazardAt(e.x, e.z);
    if (hz === HAZARD.CHASM) {
      e.state = 'fall';
      e.t = 1;
      e.pushed = 0;
      this.audio.thud();
    } else if (hz === HAZARD.DEEP) {
      e.pushed = 0;
      this.audio.splash();
      this.burst(e.x, e.y + 0.5, e.z, 14, [0.5, 0.9, 1.4], 3);
      this.damageEnemy(e, 70, e.x, e.z, 0, {});
      if (!e.alive) this.notify(`The ${e.name} shorted out in the water.`);
    } else if (hz === HAZARD.VENT) {
      e.pushed = 0;
      this.damageEnemy(e, 35, e.x, e.z, 0, { burn: true });
    }
  }

  /**
   * Resolve an attack on the player: timed parry, block, armour, then damage.
   * @param {number} dmg @param {Enemy|null} attacker null for hazards and orbs @returns {boolean} damage landed
   */
  hurtPlayer(dmg, attacker) {
    const p = this.player;
    const c = this.char;
    if (this.dead || p.iframes > 0) return false;
    if (attacker && p.parryT > 0) {
      attacker.stagger = (c.has('riposte') ? 2 : 1.2) * (c.birthsign === 'pendulum' ? 1.25 : 1);
      if (c.birthsign === 'pendulum') c.stamina = Math.min(c.maxStamina, c.stamina + 10);
      attacker.flash = 0.1;
      if (c.has('riposte')) p.riposte = true;
      this.audio.block();
      this.fx.parry = 1;
      this.exercise('blade', 1.5);
      this.notify('Parried!');
      if (this.flags.tutorial) this.flags.tutorial.parried = true;
      return false;
    }
    if (attacker && p.blocking) {
      dmg *= 0.35;
      c.stamina = Math.max(0, c.stamina - dmg * 2);
      this.audio.block();
    }
    if (attacker) dmg *= 25 / (25 + c.armor);
    else if (c.birthsign === 'crucible') dmg *= 0.75;
    c.hp -= dmg;
    p.iframes = 0.25;
    this.fx.hurt = 1;
    this.audio.hurt();
    return true;
  }

  /** Turn enemy orbs in front of the player. @param {number} range */
  tryDeflect(range) {
    const p = this.player;
    const fx = Math.cos(p.yaw);
    const fz = Math.sin(p.yaw);
    let any = false;
    for (const o of this.orbs) {
      if (o.owner !== 'enemy') continue;
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > range || (d > 0.6 && (dx * fx + dz * fz) / d < 0.2)) continue;
      o.owner = 'player';
      o.angle = p.yaw;
      o.speed *= 2;
      o.life = 4;
      any = true;
      this.burst(o.x, o.y, o.z, 8, [1.6, 1.3, 0.5], 2);
    }
    if (any) {
      if (this.flags.tutorial) this.flags.tutorial.parried = true;
      this.audio.deflect();
      this.fx.parry = 1;
      this.exercise('blade', 1);
    }
  }

  /** @param {Enemy} e @param {number} angle */
  spawnOrb(e, angle) {
    this.orbs.push(new Orb(e.x + Math.cos(angle) * 0.5, e.y + 1.2, e.z + Math.sin(angle) * 0.5, angle, e.dmg));
    this.audio.enemyShoot(e);
  }

  /** @param {number} x @param {number} z @param {number} maxD @returns {Enemy|null} */
  nearestEnemy(x, z, maxD) {
    let best = null;
    let bd = maxD;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - x, e.z - z);
      if (e.alive && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /** Kinetic Push spell: cone of force that shoves constructs into hazards. @param {number} power */
  kineticPush(power) {
    const p = this.player;
    const fx = Math.cos(p.yaw);
    const fz = Math.sin(p.yaw);
    for (const e of this.enemies) {
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 4 || (d > 0.3 && (dx * fx + dz * fz) / d < 0.5)) continue;
      const k = (e.kind === 'golem' ? 5 : 10) * power;
      e.kx += (dx / (d || 1)) * k;
      e.kz += (dz / (d || 1)) * k;
      e.pushed = 1;
      e.stagger = 0.6;
      e.wake();
    }
  }

  /** Unlock spell on the lock in front of the player. @param {number} lore @returns {boolean} */
  castUnlock(lore) {
    const t = this.findInteract();
    const target = t?.kind === 'door' ? t.ref : t?.kind === 'prop' && t.ref.kind === 'chest' ? t.ref : null;
    if (!target) {
      this.notify('There is no lock before you.');
      return false;
    }
    const door = t?.kind === 'door' ? /** @type {Door} */ (target) : null;
    const prop = t?.kind === 'prop' ? /** @type {Prop} */ (target) : null;
    const level = door ? door.lockLevel : prop?.data.lockLevel ?? 0;
    const locked = door ? door.locked && !door.puzzle : (prop?.data.lockLevel ?? 0) > 0 && !this.world.loot[prop?.key ?? ''];
    if (!locked) {
      this.notify('That is not locked.');
      return false;
    }
    if (!(door?.magic) && level > 1 + Math.floor(lore / 2)) {
      this.notify('The lock resists your Unlock. Train Aether Lore.');
      return false;
    }
    this._unlocked(door, prop);
    return true;
  }

  /** @param {Door|null} door @param {Prop|null} prop */
  _unlocked(door, prop) {
    this.audio.lockOpen();
    if (door) {
      door.locked = false;
      door.magic = false;
      this.world.doors[door.key] = { locked: false, shut: door.shut };
    }
    if (prop) {
      prop.data.lockLevel = 0;
      this.world.loot[prop.key] = this.world.loot[prop.key] ?? prop.data.loot ?? [];
    }
    this.notify('Unlocked.');
  }

  /** @param {number} x @param {number} y @param {number} z @param {number} n @param {number[]} tint @param {number} speed */
  burst(x, y, z, n, tint, speed) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push(new Particle(x, y, z, Math.cos(a) * s, 1 + Math.random() * speed, Math.sin(a) * s, 0.4 + Math.random() * 0.5, 0.25, tint));
    }
  }

  /** @param {number} x @param {number} z @param {boolean} deep */
  footstep(x, z, deep) {
    const t = this.level.floorTex[this.level.idx(Math.floor(x), Math.floor(z))];
    const surface = deep || (this.level.waterLevel > this.level.heightAt(x, z)) ? 'water'
      : t === TILE.PLANK ? 'wood' : t === TILE.FEN ? 'mud' : t === TILE.GRASS ? 'grass' : t === TILE.DUST || t === TILE.BASALT ? 'dirt'
        : t === TILE.OBS_FLOOR || t === TILE.LEY_FLOOR ? 'metal' : 'stone';
    this.audio.footstep(surface);
  }


  /**
   * Looping positional sounds near the player: fires crackle, ley vents hiss.
   * @returns {{key: string, kind: 'fire'|'vent', x: number, y: number, z: number}[]}
   */
  _soundEmitters() {
    const L = this.level;
    const p = this.player;
    /** @type {{key: string, kind: 'fire'|'vent', x: number, y: number, z: number}[]} */
    const out = [];
    for (const k of this.streamer.active) {
      for (const pr of L.propChunks.get(k) ?? []) {
        const kind = pr.kind === 'campfire' || pr.kind === 'brazier' ? 'fire' : pr.sprite === 'vent' ? 'vent' : null;
        if (!kind || pr.gone || (pr.x - p.x) ** 2 + (pr.z - p.z) ** 2 > 24 * 24) continue;
        out.push({ key: `${L.id}:${pr.key}`, kind, x: pr.x, y: L.heightAt(pr.x, pr.z), z: pr.z });
      }
    }
    return out;
  }

  _die() {
    this.dead = true;
    this.char.hp = 0;
    this.audio.defeat();
  }

  // -------------------------------------------------------------------------
  // Character helpers used by dialogue, UI and entities
  // -------------------------------------------------------------------------

  /** @param {string} text */
  notify(text) {
    this.notes.push({ text, t: 4.5 });
    if (this.notes.length > 6) this.notes.shift();
  }

  /** @param {string} skill @param {number} amount */
  exercise(skill, amount) {
    const r = this.char.exercise(skill, amount * (this.char.fated ? 1.05 : 1));
    for (const t of r.text) this.notify(t);
    if (r.levelUp) this.audio.levelUp();
    else if (r.skillUp) this.audio.skillUp();
  }

  /** @param {number} n */
  addShards(n) {
    this.char.shards = Math.max(0, this.char.shards + n);
    if (n > 0) this.notify(`+${n} Aether Shards`);
  }

  /** @param {string} faction @param {number} n */
  changeRep(faction, n) {
    this.factions.rep[faction] = (this.factions.rep[faction] || 0) + n;
    this.notify(`${FACTIONS[faction]} reputation ${n >= 0 ? '+' : ''}${n}`);
  }

  /** Add items (shards go to the purse), wire weapons into the hotbar, fire quest hooks. @param {string} id @param {number} qty */
  give(id, qty) {
    const c = this.char;
    if (id === 'shards') {
      this.addShards(c.birthsign === 'star' ? Math.round(qty * 1.3) : qty);
      return;
    }
    c.inventory.add(id, qty);
    this.notify(`+${qty > 1 ? `${qty} ` : ''}${ITEMS[id].name}`);
    const def = ITEMS[id];
    if (def.type === 'weapon' && !c.hotbar.some((s) => s && s.id === id)) {
      const free = c.hotbar.indexOf(null);
      if (free >= 0) c.hotbar[free] = { kind: 'item', id };
      if (!c.equip.main) this.selectSlot(c.hotbar.findIndex((s) => s?.id === id));
    }
    if (def.type === 'offhand' && !c.equip.off) c.equip.off = id;
    if (def.type === 'rune') this.notify('Inscribe runes into spells from the Skills panel (K).');
    if (id === 'core' && this.mainStage === 30) this.setMain(40, 'I recovered the Resonant Core from the Drowned Shrine. Master Vance will want to see it.');
  }

  /** @param {number} i */
  selectSlot(i) {
    const s = this.char.hotbar[i];
    if (!s) return;
    if (this.hotIndex !== i) this.audio.swap();
    this.hotIndex = i;
    if (s.kind === 'item' && ITEMS[s.id]?.type === 'weapon') this.char.equip.main = s.id;
  }

  /** @param {number} d */
  cycleSlot(d) {
    const hb = this.char.hotbar;
    for (let k = 1; k <= hb.length; k++) {
      const i = (this.hotIndex + d * k + hb.length * 6) % hb.length;
      if (hb[i]) { this.selectSlot(i); return; }
    }
  }

  selectedSlot() {
    const s = this.char.hotbar[this.hotIndex];
    if (s && s.kind === 'item' && !this.char.inventory.count(s.id)) return null;
    return s;
  }

  /** First-person viewmodel state for the renderer. @returns {import('./renderer.js').ViewDesc} */
  viewState() {
    const p = this.player;
    const slot = this.selectedSlot();
    const item = !slot ? null : slot.kind === 'item' ? (['fork', 'scatter', 'crossbow'].includes(slot.id) ? slot.id : null) : 'cast';
    return {
      item, swing: p.swingT / 0.28, recoil: p.recoil, cast: p.castT / 0.4, block: p.blocking, bob: p.bob,
      lantern: this.char.equip.off === 'lantern',
    };
  }

  /** @param {string} id @param {string} title @param {string} text @param {Marker|null} [marker] */
  startQuest(id, title, text, marker = null) {
    this.quests.start(id, title, id.startsWith('contract') ? 'guild' : 'town');
    this.quests.update(id, 10, text, this.day, marker);
    this.audio.quest();
    this.notify(`New quest: ${title}`);
  }

  /** @param {string} id @param {string} text */
  finishQuest(id, text) {
    this.quests.complete(id, text, this.day);
    this.audio.quest();
    this.notify(`Quest complete: ${this.quests.get(id)?.title}`);
  }

  /** Advance the main quest with a journal entry and a compass marker. @param {number} stage @param {string} text */
  setMain(stage, text) {
    const vance = () => {
      const def = this.getLevel('overworld').npcDefs.find((d) => d.id === 'vance');
      return def ? { level: 'overworld', x: def.spots.work.x, z: def.spots.work.z } : null;
    };
    /** @type {Record<number, () => Marker|null>} */
    const markers = {
      10: () => ({ level: 'observatory', x: 26.5, z: 20.5 }),
      20: vance,
      30: () => ({ level: 'overworld', x: SITES.drowned.x + 0.5, z: SITES.drowned.z + 0.5 }),
      40: vance,
      50: () => ({ level: 'overworld', x: SITES.gate.x + 0.5, z: SITES.gate.z + 0.5 }),
    };
    if (stage >= 100) {
      const q = this.quests.get('main');
      if (q) q.stage = stage;
      this.quests.complete('main', text, this.day);
    } else {
      this.quests.update('main', stage, text, this.day, markers[stage]?.() ?? null);
      this.notify('Journal updated (J)');
    }
    this.audio.quest();
  }

  /** @param {string} id @param {string} name */
  discover(id, name) {
    this.discovered.add(id);
    this.exercise('wayfaring', 3 * (this.char.birthsign === 'astrolabe' ? 1.15 : 1));
    this.notify(`Discovered: ${name}`);
    const c = this.contracts.wardens;
    if (c && c.kind === 'scout' && c.landmark === id) this.notify('Survey complete: report to Captain Marr.');
  }

  // -------------------------------------------------------------------------
  // Contracts
  // -------------------------------------------------------------------------

  /** @param {'artificers'|'wardens'} guild @returns {Contract} */
  offerContract(guild) {
    const n = ++this.contracts.n;
    const c = makeContract(guild, n, this.seed);
    this.contracts[guild] = c;
    /** @type {Marker|null} */
    let marker = null;
    if (c.dungeon) marker = { level: 'overworld', x: SITES[/** @type {'drowned'} */ (c.dungeon)].x + 0.5, z: SITES[/** @type {'drowned'} */ (c.dungeon)].z + 0.5 };
    if (c.landmark) {
      const lm = this.getLevel('overworld').landmarks.find((l) => l.id === c.landmark);
      if (lm) marker = { level: 'overworld', x: lm.x, z: lm.z };
    }
    if (c.npc) {
      const def = this.getLevel('overworld').npcDefs.find((d) => d.id === c.npc);
      if (def) marker = { level: 'overworld', x: def.spots.work.x, z: def.spots.work.z };
      this.give('parcel', 1);
    }
    this.startQuest(c.id, c.title, c.brief, marker);
    return c;
  }

  /** @param {Contract} c */
  contractReady(c) {
    if (c.kind === 'relic') return this.char.inventory.count('relic') > 0;
    if (c.kind === 'gather') return this.char.inventory.count(c.item ?? '') >= (c.count ?? 1);
    if (c.kind === 'scout') return this.discovered.has(c.landmark ?? '');
    if (c.kind === 'delivery') return !!c.delivered;
    return this.getLevel(`dungeon:${c.dungeon}`).spawns.every((s) => this.world.killed[s.key]);
  }

  /** @param {'artificers'|'wardens'} guild @returns {string} */
  completeContract(guild) {
    const c = this.contracts[guild];
    if (!c || !this.contractReady(c)) return 'The work is not finished.';
    if (c.kind === 'relic') this.char.inventory.remove('relic', 1);
    if (c.kind === 'gather') this.char.inventory.remove(c.item ?? '', c.count ?? 1);
    this.addShards(c.reward);
    this.changeRep(guild, 10);
    this.exercise('wayfaring', 2);
    this.finishQuest(c.id, `Completed: ${c.title}.`);
    this.contracts[guild] = null;
    if (guild === 'wardens' && !this.flags.levisGiven) {
      this.flags.levisGiven = true;
      this.give('rune_levis', 1);
      return 'Good work, Warden. Take my Levis stone; with Vis it will carry you across the chasm to the Hollow Spire.';
    }
    return 'Good work. The ledger is square.';
  }

  /** @param {'artificers'|'wardens'} guild */
  abandonContract(guild) {
    const c = this.contracts[guild];
    if (!c) return;
    if (c.kind === 'delivery') this.char.inventory.remove('parcel', 1);
    this.quests.complete(c.id, 'Abandoned.', this.day);
    this.contracts[guild] = null;
    this.changeRep(guild, -5);
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /** Best thing to interact with in front of the player. @returns {Interactable|null} */
  findInteract() {
    const p = this.player;
    const L = this.level;
    const fx = Math.cos(p.yaw);
    const fz = Math.sin(p.yaw);
    /** @type {Interactable|null} */
    let best = null;
    let bd = 2.6;
    /** @param {number} x @param {number} z @param {number} r */
    const score = (x, z, r) => {
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > r) return Infinity;
      if (d > 0.9 && (dx * fx + dz * fz) / d < 0.55) return Infinity;
      return d;
    };
    for (const n of this.npcs) {
      const d = score(n.x, n.z, 2.6);
      if (d < bd) { bd = d; best = { kind: 'npc', ref: n, label: `Speak to ${n.def.name}` }; }
    }
    for (const k of this.streamer.active) {
      for (const pr of L.propChunks.get(k) ?? []) {
        if (pr.gone || pr.kind === 'decor') continue;
        const d = score(pr.x, pr.z, 2.4);
        if (d < bd) { bd = d; best = { kind: 'prop', ref: pr, label: this._propLabel(pr) }; }
      }
    }
    for (const t of [0.7, 1.3, 1.9]) {
      const i = Math.floor(p.x + fx * t);
      const j = Math.floor(p.z + fz * t);
      if (!L.inBounds(i, j)) continue;
      const di = L.doorAt[L.idx(i, j)];
      if (di < 0) continue;
      const d = L.doors[di];
      if (t < bd) best = { kind: 'door', ref: d, label: this._doorLabel(d) };
      break;
    }
    return best;
  }

  /** @param {Prop} p */
  _propLabel(p) {
    const lockLevel = p.data.lockLevel ?? 0;
    switch (p.kind) {
      case 'chest': return lockLevel > 0 && !this.world.loot[p.key] ? `Pick Lock (Lv ${lockLevel}) - Chest` : 'Open Chest';
      case 'book': return 'Read Tablet';
      case 'bed': return p.data.rent ? 'Sleep (rented bed)' : p.data.owned ? 'Sleep (someone\'s bed)' : 'Rest';
      case 'campfire': return 'Rest by the fire';
      case 'brazier': return 'Warm yourself at the Resonance Brazier';
      case 'lever': return 'Pull Lever';
      case 'item': return `Take ${ITEMS[p.data.item]?.name ?? 'item'}`;
      case 'herb': return `Harvest ${ITEMS[p.data.item].name}`;
      case 'stairs': return p.data.label;
      case 'landmark': return `Study ${p.data.name}`;
      case 'notice': return 'Read the notice board';
      case 'gatecore': return 'Examine the Great Astrolabe';
      case 'anchor': return 'Examine Anchor';
      default: return 'Use';
    }
  }

  /** @param {Door} d */
  _doorLabel(d) {
    if (d.puzzle && d.locked) return `${d.name} (sealed by the anchors)`;
    if (d.locked && d.magic) return `${d.name} (rune-sealed)`;
    if (d.locked) return this.char.inventory.count(d.keyId ?? '') ? `Unlock ${d.name}` : `Pick Lock (Lv ${d.lockLevel}) - ${d.name}`;
    return d.shut ? `Open ${d.name}` : `Close ${d.name}`;
  }

  /**
   * Use whatever is in front of the player. Returns a UI request for the app, if any.
   * @returns {{open:string, data?:any}|null}
   */
  interact() {
    const t = this.findInteract();
    if (!t) return null;
    if (t.kind === 'npc') return { open: 'dialogue', data: t.ref };
    if (t.kind === 'door') {
      this._useDoor(t.ref);
      return null;
    }
    const p = t.ref;
    switch (p.kind) {
      case 'chest':
        if ((p.data.lockLevel ?? 0) > 0 && !this.world.loot[p.key]) {
          if (!this._tryLock(p.data.lockLevel, null)) return null;
          this._unlocked(null, p);
        }
        this.world.loot[p.key] = this.world.loot[p.key] ?? p.data.loot ?? [];
        p.sprite = 'chest_open';
        this.audio.creak('chest');
        return { open: 'loot', data: p };
      case 'book':
        return { open: 'read', data: p.data.book };
      case 'notice':
        return { open: 'read', data: `notice_${p.data.guild}` };
      case 'bed':
        if (p.data.owned) { this.notify('This bed belongs to someone.'); return null; }
        if (p.data.rent && this.flags.rent !== p.data.rent) { this.notify('Rent a bed from the innkeeper first.'); return null; }
        return { open: 'rest' };
      case 'campfire':
      case 'brazier':
        return { open: 'rest' };
      case 'lever':
        this._pullLever(p);
        return null;
      case 'item':
      case 'herb':
        this.give(p.data.item, p.data.qty ?? 1);
        p.gone = true;
        this.world.gone[p.key] = true;
        this.audio.pickup();
        return null;
      case 'stairs':
        this.pendingTravel = p.data.portal;
        return null;
      case 'landmark':
        if (!this.discovered.has(p.data.id)) this.discover(p.data.id, p.data.name);
        this.notify(`${p.data.name}: the ley hums here.`);
        this.char.mana = this.char.maxMana;
        return null;
      case 'gatecore':
        this._useGateCore();
        return null;
      case 'anchor':
        this.notify(this._anchors()[p.data.index] ? 'The anchor sings.' : 'The anchor is dark.');
        return null;
      default:
        return null;
    }
  }

  /** @param {Door} d */
  _useDoor(d) {
    if (d.puzzle && d.locked) {
      this.notify('The Great Astrolabe Gate will not move while its anchors are dark.');
      return;
    }
    if (d.locked) {
      if (d.magic) { this.notify('A rune seal holds this door. Only the Unlock rune will open it.'); return; }
      if (!this._tryLock(d.lockLevel, d.keyId)) return;
      this._unlocked(d, null);
    }
    d.shut = !d.shut;
    this.world.doors[d.key] = { locked: d.locked, shut: d.shut };
    this.audio.creak('door');
  }

  /**
   * Key, or lockpick attempt scaled by Artificing and Finesse.
   * @param {number} level @param {string|null} keyId @returns {boolean} unlocked
   */
  _tryLock(level, keyId) {
    const c = this.char;
    if (keyId && c.inventory.count(keyId)) return true;
    if (!c.inventory.count('lockpick')) {
      this.notify(`Locked (Lv ${level}). You need a key, a lockpick, or the Unlock rune.`);
      return false;
    }
    for (let k = 0; k < 3; k++) setTimeout(() => this.audio.lockClick(), k * 90);
    const chance = clamp(0.35 + 0.15 * (c.skill('artificing') - level) + c.attrs.finesse * 0.02 + (c.has('steady') ? 0.15 : 0), 0.05, 0.95);
    if (Math.random() < chance) {
      this.exercise('artificing', (1 + level) * (c.birthsign === 'astrolabe' ? 1.15 : 1));
      return true;
    }
    this.exercise('artificing', 0.3);
    if (Math.random() < (c.has('steady') ? 0.25 : 0.5)) {
      c.inventory.remove('lockpick', 1);
      this.audio.lockBreak();
      this.notify('Your lockpick snapped.');
    } else this.notify('The pick slips. Try again.');
    return false;
  }

  _anchors() {
    const lit = [...ANCHOR_START];
    this.flags.levers.forEach((/** @type {boolean} */ on, /** @type {number} */ i) => {
      if (on) for (const a of LEVER_MAP[i]) lit[a] = !lit[a];
    });
    return lit;
  }

  /** @param {Prop} p */
  _pullLever(p) {
    const i = p.data.index;
    this.flags.levers[i] = !this.flags.levers[i];
    this.audio.creak('lever');
    this.audio.chime(this.flags.levers[i] ? 1320 : 990);
    if (this._anchors().every(Boolean)) this._openGate(this.level, 'All three anchors sing. The Great Astrolabe Gate grinds open!');
  }

  _useGateCore() {
    if (this.mainStage >= 100) { this.notify('The Great Astrolabe turns, true and steady.'); return; }
    if (this.mainStage !== 50 || !this.char.inventory.count('core')) {
      this.notify(this.mainStage < 50 ? 'The armillary is still. Its heart is missing.' : 'You need the attuned Resonant Core.');
      return;
    }
    this.char.inventory.remove('core', 1);
    this.flags.ending = true;
    this.setMain(100, 'I seated the Resonant Core in the Great Astrolabe. The ley-lines are drawing true again across the Shardlands.');
    this.exercise('aether', 6);
    this.addShards(150);
    this.audio.victory();
    this.burst(27, 2, 15.5, 40, [0.5, 1.4, 1.8], 5);
  }

  /** Sleep: advance the clock and recover. @param {number} hours @returns {string|null} error */
  rest(hours) {
    const p = this.player;
    if (this.enemies.some((e) => e.awake && e.state !== 'home' && Math.hypot(e.x - p.x, e.z - p.z) < 20)) return 'You cannot rest with enemies nearby.';
    const c = this.char;
    this.minutes += hours * 60;
    c.hp = Math.min(c.maxHp, c.hp + hours * 14);
    c.mana = Math.min(c.maxMana, c.mana + hours * 20);
    c.stamina = c.maxStamina;
    c.powerCD = 0;
    this.notify(`You rested ${hours} hour${hours > 1 ? 's' : ''}.`);
    for (const n of this.npcs) n.thinkT = 0;
    this.save(true);
    return null;
  }

  // -------------------------------------------------------------------------
  // Trade
  // -------------------------------------------------------------------------

  /** @param {string} shop */
  stock(shop) {
    const s = this.shopStock[shop];
    if (!s || s.day !== this.day) this.shopStock[shop] = { day: this.day, items: SHOPS[shop].items.map(([id, n]) => [id, n]) };
    return this.shopStock[shop].items;
  }

  /** @param {string} shop @param {string} id @returns {string|null} error */
  buy(shop, id) {
    const items = this.stock(shop);
    const row = items.find((r) => r[0] === id);
    const price = buyPrice(this.char, id, this.factions.rep[SHOPS[shop].town] || 0);
    if (!row || row[1] <= 0) return 'Sold out.';
    if (this.char.shards < price) return 'Not enough Aether Shards.';
    this.char.shards -= price;
    row[1]--;
    this.give(id, 1);
    this.audio.coins();
    this.exercise('wayfaring', 0.5);
    return null;
  }

  /** @param {string} shop @param {string} id @returns {string|null} error */
  sell(shop, id) {
    const c = this.char;
    if (ITEMS[id].value <= 0) return 'They will not buy that.';
    if (Object.values(c.equip).includes(id) && c.inventory.count(id) <= 1) return 'Unequip it first.';
    if (!c.inventory.remove(id, 1)) return null;
    c.shards += sellPrice(c, id, this.factions.rep[SHOPS[shop].town] || 0);
    const row = this.stock(shop).find((r) => r[0] === id);
    if (row) row[1]++;
    else this.stock(shop).push([id, 1]);
    this.audio.coins();
    this.exercise('wayfaring', 0.5);
    return null;
  }

  /** Use, equip or read an inventory item. @param {string} id @returns {{open:string, data?:any}|null} */
  useItem(id) {
    const c = this.char;
    const def = ITEMS[id];
    if (def.type === 'weapon') {
      c.equip.main = id;
      const slot = c.hotbar.findIndex((s) => s?.id === id);
      if (slot >= 0) this.hotIndex = slot;
    } else if (def.type === 'offhand') c.equip.off = c.equip.off === id ? null : id;
    else if (def.type === 'armor') c.equip.armor = c.equip.armor === id ? null : id;
    else if (def.type === 'relic') {
      c.equip.relic = c.equip.relic === id ? null : id;
      c.mana = Math.min(c.mana, c.maxMana);
    } else if (def.type === 'ammo') {
      c.ammo = id;
      this.notify(`Loaded ${def.name}.`);
    } else if (def.type === 'book') return { open: 'read', data: def.book };
    else if (def.type === 'consumable') {
      if (!c.inventory.remove(id, 1)) return null;
      // The Crucible's potions (not plain food) are 30% stronger.
      const k = c.birthsign === 'crucible' && (def.mana || (def.heal ?? 0) >= 20) ? 1.3 : 1;
      if (def.heal) c.hp = Math.min(c.maxHp, c.hp + def.heal * k);
      if (def.mana) c.mana = Math.min(c.maxMana, c.mana + def.mana * k);
      if (def.oil) c.effects[`oil_${def.oil}`] = def.oil === 'whet' ? 120 : 90;
      if (def.heal && def.value < 5) this.audio.eat();
      else this.audio.brew();
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Rendering feeds
  // -------------------------------------------------------------------------

  /** Trigger the Birthsign Power if it has recharged (resting recharges it too). */
  usePower() {
    const c = this.char;
    const sign = BIRTHSIGNS[c.birthsign];
    if (!sign) {
      this.notify('You were born under no sign the Astrolabe recognises.');
      return;
    }
    if (c.powerCD > 0) {
      this.notify(`${sign.power} recharges in ${Math.ceil(c.powerCD)}s, or rest.`);
      return;
    }
    const p = this.player;
    if (c.birthsign === 'pendulum') c.effects.stasis = 4;
    else if (c.birthsign === 'crucible') {
      for (const e of this.enemies) {
        if (!e.alive || Math.hypot(e.x - p.x, e.z - p.z) > 5) continue;
        this.damageEnemy(e, 28 + c.attrs.intellect * 3, p.x, p.z, 9, { burn: true });
        e.pushed = 1;
      }
      this.burst(p.x, p.y + 1, p.z, 40, [1.8, 0.8, 0.3], 6);
      this.audio.slam(p);
    } else if (c.birthsign === 'astrolabe') c.effects.sight = 12;
    else if (c.birthsign === 'spire') {
      c.mana = c.maxMana;
      c.effects.surge = 5;
    } else if (c.birthsign === 'hound') c.effects.stride = 6;
    else if (c.birthsign === 'crown') {
      const near = this.enemies.filter((e) => e.alive && !e.boss).map((e) => ({ e, d: Math.hypot(e.x - p.x, e.z - p.z) })).filter((o) => o.d < 12).sort((a, b) => a.d - b.d)[0];
      if (!near) {
        this.notify('No construct is close enough to hear your command.');
        return;
      }
      near.e.charmT = 15;
    } else if (c.birthsign === 'star') c.effects.supernova = 6;
    c.powerCD = sign.cd;
    this.audio.cast(c.birthsign === 'spire' ? 'mending' : c.birthsign === 'crucible' ? 'push' : 'lumina');
    this.fx.parry = Math.max(this.fx.parry, 0.8);
    this.notify(`${sign.power}!`);
  }

  /** The Astrolabe birthsign chimes once for each unlooted chest or scalding vent that comes near. */
  _astrolabePing() {
    const L = this.level;
    const p = this.player;
    for (const pr of L.props) {
      const loot = this.world.loot[pr.key];
      const chest = pr.kind === 'chest' && pr.sprite !== 'chest_open' && !(loot && loot.length === 0);
      const trap = pr.sprite === 'vent';
      if ((!chest && !trap) || (pr.x - p.x) ** 2 + (pr.z - p.z) ** 2 > 49) continue;
      const key = `${L.id}:${pr.key}`;
      if (this.pinged.has(key)) continue;
      this.pinged.add(key);
      this.audio.chime(trap ? 990 : 1760);
      this.burst(pr.x, L.heightAt(pr.x, pr.z) + 0.8, pr.z, 12, trap ? [1.6, 0.6, 0.3] : [1.6, 1.4, 0.6], 2);
      this.notify(trap ? 'The Astrolabe stirs: a scalding vent ahead.' : 'The Astrolabe stirs: an unlooted chest nearby.');
    }
  }

  /** @returns {SpriteDesc[]} */
  collectSprites() {
    const L = this.level;
    const p = this.player;
    /** @type {SpriteDesc[]} */
    const out = [];
    const lit = this._anchors();
    const glowy = new Set(['brazier', 'pylon', 'stones', 'herb_bloom', 'herb_moss', 'tablet', 'anchor', 'gate_core', 'vent', 'campfire_a', 'stairs', 'rune_lux', 'rune_vita', 'rune_vis', 'rune_aperio', 'rune_levis', 'i_core', 'i_crystal']);
    for (const k of this.streamer.active) {
      for (const pr of L.propChunks.get(k) ?? []) {
        // Decor (trees, rocks, ruins, stalls, lamps...) is hardware-instanced by the renderer per chunk.
        if (pr.gone || pr.kind === 'decor') continue;
        if ((pr.x - p.x) ** 2 + (pr.z - p.z) ** 2 > 75 * 75) continue;
        let sprite = pr.sprite;
        let tint = [1, 1, 1];
        if (pr.kind === 'lever') sprite = this.flags.levers[pr.data.index] ? 'lever_down' : 'lever_up';
        if (pr.kind === 'chest' && this.world.loot[pr.key] && (this.world.loot[pr.key].length === 0 || pr.sprite === 'chest_open')) sprite = 'chest_open';
        if (pr.kind === 'campfire') sprite = Math.floor(this.time * 6) % 2 ? 'campfire_b' : 'campfire_a';
        if (pr.kind === 'anchor') tint = lit[pr.data.index] ? [1.3, 1.3, 1.4] : [0.3, 0.35, 0.45];
        if (pr.kind === 'gatecore') tint = this.flags.ending ? [1.4, 1.4, 1.4] : [0.55, 0.6, 0.7];
        const emit = glowy.has(sprite) && !(pr.kind === 'anchor' && !lit[pr.data.index]) ? 1 : pr.kind === 'item' ? 1 : 0;
        out.push({ x: pr.x, y: L.heightAt(pr.x, pr.z) + pr.lift, z: pr.z, w: pr.size, h: pr.size, frame: SPR[sprite], emit, tint, sky: L.covered(pr.x, pr.z) ? 0 : 1 });
      }
    }
    for (const e of this.enemies) if (e.alive && (e.x - p.x) ** 2 + (e.z - p.z) ** 2 < 75 * 75) out.push(e.getSprite());
    for (const e of this.fallen) out.push(e.getSprite());
    for (const n of this.npcs) if ((n.x - p.x) ** 2 + (n.z - p.z) ** 2 < 75 * 75) out.push(n.getSprite(L));
    for (const o of this.orbs) out.push(o.getSprite());
    for (const s of this.projectiles) out.push(s.getSprite());
    for (const q of this.particles) out.push(q.getSprite());
    // Astral Sight: glowing markers drawn through walls.
    if (this.char.effects.sight) {
      for (const e of this.enemies) if (e.alive && (e.x - p.x) ** 2 + (e.z - p.z) ** 2 < 45 * 45) out.push({ x: e.x, y: e.y + 0.6, z: e.z, w: 1.1, h: 1.1, frame: SPR.orb_enemy, emit: 2, tint: [1.2, 0.5, 0.4], sky: 1, xray: true });
      for (const pr of L.props) {
        const loot = this.world.loot[pr.key];
        if (pr.kind !== 'chest' || pr.sprite === 'chest_open' || (loot && loot.length === 0) || (pr.x - p.x) ** 2 + (pr.z - p.z) ** 2 > 45 * 45) continue;
        out.push({ x: pr.x, y: L.heightAt(pr.x, pr.z) + 0.3, z: pr.z, w: 0.9, h: 0.9, frame: SPR.bead, emit: 2, tint: [1.4, 1.2, 0.5], sky: 1, xray: true });
      }
      const qm = this.quests.trackedMarker();
      if (qm && qm.level === L.id) for (let k = 0; k < 6; k++) out.push({ x: qm.x, y: L.heightAt(qm.x, qm.z) + k * 0.7, z: qm.z, w: 1.4, h: 1.4, frame: SPR.shard, emit: 2, tint: [0.5, 1.2, 1.4], sky: 1, xray: true });
    }
    return out;
  }

  /** @returns {Light[]} */
  collectLights() {
    const L = this.level;
    const p = this.player;
    const c = this.char;
    /** @type {Light[]} */
    const out = [];
    for (const k of this.streamer.active) for (const l of L.lightChunks.get(k) ?? []) out.push(l);
    const hand = { x: p.x + Math.cos(p.yaw) * 0.3, y: p.y + 1.4, z: p.z + Math.sin(p.yaw) * 0.3 };
    if (c.equip.off === 'lantern') out.push({ ...hand, r: 1.5, g: 1.05, b: 0.55, flicker: 0.06 });
    if (c.effects.lumina) out.push({ x: p.x, y: p.y + 2.2, z: p.z, r: 1.3, g: 1.6, b: 1.8 });
    if (p.flash > 0) out.push({ ...hand, r: 1.6 * p.flash, g: 1.2 * p.flash, b: 0.8 * p.flash });
    if (this.flags.ending && L.id === 'observatory') out.push({ x: 27, y: 2.5, z: 15.5, r: 0.6, g: 1.5, b: 2 });
    for (const o of this.orbs) out.push(o.owner === 'enemy' ? { x: o.x, y: o.y, z: o.z, r: 0.7, g: 0.25, b: 1 } : { x: o.x, y: o.y, z: o.z, r: 0.2, g: 0.9, b: 1.1 });
    for (const s of this.projectiles) if (s.ammo !== 'shard') out.push(s.ammo === 'flare' ? { x: s.x, y: s.y, z: s.z, r: 1.4, g: 0.6, b: 0.2 } : { x: s.x, y: s.y, z: s.z, r: 0.4, g: 0.8, b: 1.4 });
    return out;
  }

  // -------------------------------------------------------------------------
  // Save / load
  // -------------------------------------------------------------------------

  /** @param {boolean} [quiet] */
  save(quiet = false) {
    const p = this.player;
    /** @type {Record<string, string>} */
    const explored = {};
    for (const [id, L] of this.levels) explored[id] = packBits(L.explored);
    const data = {
      v: 1, seed: this.seed, minutes: this.minutes, levelId: this.level.id,
      player: { x: p.x, z: p.z, yaw: p.yaw }, char: this.char.toJSON(), quests: { quests: this.quests.quests, tracked: this.quests.tracked },
      factions: this.factions, flags: this.flags, contracts: this.contracts, discovered: [...this.discovered], world: this.world,
      markers: this.markers, explored, hotIndex: this.hotIndex, shopStock: this.shopStock,
      weather: { kind: this.weather.kind, rain: this.weather.rain, wind: this.weather.wind, next: this.weather.next },
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      if (!quiet) this.notify('Game saved.');
    } catch {
      this.notify('Could not save: browser storage is unavailable.');
    }
  }

  static hasSave() {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }

  /** @param {AudioEngine} audio @returns {Game|null} */
  static load(audio) {
    let data;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || data.v !== 1) return null;
    const g = new Game(audio, data.seed);
    g.minutes = data.minutes;
    g.char = Character.fromJSON(data.char);
    g.quests.quests = data.quests.quests;
    g.quests.tracked = data.quests.tracked;
    g.factions = data.factions;
    g.flags = data.flags;
    g.contracts = data.contracts;
    g.discovered = new Set(data.discovered);
    g.world = data.world;
    g.markers = data.markers || [];
    g.hotIndex = data.hotIndex || 0;
    g.shopStock = data.shopStock || {};
    g.levels.clear();
    for (const [id, b64] of Object.entries(data.explored || {})) unpackBits(/** @type {string} */ (b64), g.getLevel(id).explored);
    // Older saves have no weather: keep the defaults, which roll a fresh kind on the first tick.
    const sw = data.weather;
    if (sw && Object.hasOwn(WEATHER, sw.kind) && [sw.rain, sw.wind, sw.next].every(Number.isFinite)) {
      Object.assign(g.weather, { kind: sw.kind, rain: clamp(sw.rain, 0, 1), wind: clamp(sw.wind, 0, 1), next: sw.next });
    }
    g.enterLevel(data.levelId, data.player.x, data.player.z, data.player.yaw);
    g.notify('Game loaded.');
    return g;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const MOUSE_SENS = 0.0022;
/** @type {Record<string, {x:number, y:number}>} */
const TAP_DIRS = { KeyW: { x: 0, y: 1 }, KeyS: { x: 0, y: -1 }, KeyA: { x: -1, y: 0 }, KeyD: { x: 1, y: 0 } };

export class Input {
  constructor() {
    /** @type {Set<string>} */
    this.keys = new Set();
    this.attackHeld = false;
    this.attackPressed = false;
    this.parryHeld = false;
    this.parry = false;
    this.dash = false;
    this.jump = false;
    this.slot = -1;
    this.cycle = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.touchMove = { x: 0, y: 0 };
    this.touchLook = { x: 0, y: 0 };
    this.lastTap = { code: '', t: 0 };
  }

  /** @param {KeyboardEvent} e */
  keyDown(e) {
    if (e.repeat) return;
    this.keys.add(e.code);
    const dir = TAP_DIRS[e.code];
    if (dir) {
      const now = performance.now();
      if (this.lastTap.code === e.code && now - this.lastTap.t < 250) {
        this.dash = true;
        this.lastTap.code = '';
      } else this.lastTap = { code: e.code, t: now };
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.dash = true;
    if (e.code === 'Space') this.jump = true;
    if (/^Digit[1-6]$/.test(e.code)) this.slot = Number(e.code.slice(5)) - 1;
    if (e.code === 'KeyQ') this.cycle = 1;
  }

  /** @param {KeyboardEvent} e */
  keyUp(e) {
    this.keys.delete(e.code);
  }

  /** @returns {FrameInput} */
  sample() {
    const k = this.keys;
    const right = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const curve = (/** @type {number} */ v) => Math.sign(v) * v * v;
    /** @type {FrameInput} */
    const s = {
      moveX: right + this.touchMove.x, moveY: fwd - this.touchMove.y,
      lookX: this.lookX + curve(this.touchLook.x) * 3.2 * STEP_DT, lookY: this.lookY + curve(this.touchLook.y) * 2.0 * STEP_DT,
      attack: this.attackHeld, attackPressed: this.attackPressed, parry: this.parry, parryHeld: this.parryHeld,
      dash: this.dash, jump: this.jump, slot: this.slot, cycle: this.cycle,
    };
    this.lookX = 0;
    this.lookY = 0;
    this.attackPressed = false;
    this.parry = false;
    this.dash = false;
    this.jump = false;
    this.slot = -1;
    this.cycle = 0;
    return s;
  }

  clearHeld() {
    this.keys.clear();
    this.attackHeld = false;
    this.parryHeld = false;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers & icons
// ---------------------------------------------------------------------------

/**
 * @param {string} tag @param {Record<string, any>} [props] @param {...any} kids
 * @returns {HTMLElement}
 */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'disabled') /** @type {any} */ (el).disabled = true;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat(3)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** @param {string} id */
function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

/** @type {Map<string, string>} */
const iconCache = new Map();
/** @type {HTMLCanvasElement|null} */
let ATLAS = null;

/**
 * A birthsign's constellation emblem: a seeded scatter of stars joined into a figure, on a
 * dark disc ringed in brass and tinted with the sign's hue.
 * @param {string} sign @param {number} [size] CSS pixels
 */
function emblem(sign, size = 48) {
  const def = BIRTHSIGNS[sign];
  const px = size * 2;
  const cv = /** @type {HTMLCanvasElement} */ (h('canvas', { width: String(px), height: String(px), class: 'emblem', style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' }));
  const c = cv.getContext('2d');
  if (!c || !def) return cv;
  const r = px / 2;
  const bg = c.createRadialGradient(r, r * 0.8, 0, r, r, r);
  bg.addColorStop(0, '#1b2140');
  bg.addColorStop(1, '#07060f');
  c.fillStyle = bg;
  c.beginPath();
  c.arc(r, r, r - 2, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = '#c99a48';
  c.lineWidth = px * 0.035;
  c.stroke();
  let seed = 7;
  for (const ch of sign) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = mulberry32(seed);
  for (let k = 0; k < 18; k++) {
    c.fillStyle = `rgba(246,231,193,${0.15 + rnd() * 0.3})`;
    c.fillRect(r + (rnd() - 0.5) * r * 1.5, r + (rnd() - 0.5) * r * 1.5, 1.5, 1.5);
  }
  /** @type {number[][]} */
  const stars = [];
  const n = 5 + Math.floor(rnd() * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd() * 0.9;
    const d = r * (0.18 + rnd() * 0.5);
    stars.push([r + Math.cos(a) * d, r + Math.sin(a) * d]);
  }
  c.strokeStyle = def.hue;
  c.globalAlpha = 0.7;
  c.lineWidth = px * 0.018;
  c.beginPath();
  stars.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.lineTo(stars[Math.floor(n / 2)][0], stars[Math.floor(n / 2)][1]);
  c.stroke();
  c.globalAlpha = 1;
  for (const [x, y] of stars) {
    const g = c.createRadialGradient(x, y, 0, x, y, px * 0.07);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.3, def.hue);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, px * 0.07, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

/** Small <img> of a sprite frame. @param {string} sprite @param {number} [size] */
function icon(sprite, size = 40) {
  let url = iconCache.get(sprite);
  if (!url && ATLAS) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      g.imageSmoothingEnabled = false;
      const r = spriteRect(SPR[sprite] ?? 0);
      g.drawImage(ATLAS, r.sx, r.sy, r.size, r.size, 0, 0, 64, 64);
    }
    url = c.toDataURL();
    iconCache.set(sprite, url);
  }
  return h('img', { src: url ?? '', width: size, height: size, class: 'icon', alt: '' });
}

/** @param {string} label @param {() => void} fn @param {boolean} [disabled] */
const btn = (label, fn, disabled = false) => h('button', { class: 'brass-btn', type: 'button', onclick: fn, disabled }, label);

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const IVORY = '#f6e7c1';
const BRASS = '#c99a48';
const CYAN = '#3fe6ff';

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} w @param {number} frac @param {string} col @param {string} label */
function tube(c, x, y, w, frac, col, label) {
  c.fillStyle = 'rgba(12,8,20,0.75)';
  c.fillRect(x - 2, y - 2, w + 4, 14);
  c.fillStyle = col;
  c.fillRect(x, y, w * clamp(frac, 0, 1), 10);
  c.fillStyle = 'rgba(255,255,255,0.25)';
  c.fillRect(x, y + 1, w * clamp(frac, 0, 1), 2);
  c.strokeStyle = BRASS;
  c.lineWidth = 2;
  c.strokeRect(x - 2, y - 2, w + 4, 14);
  c.fillStyle = IVORY;
  c.font = '600 9px Georgia, serif';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(label, x + 4, y + 5.5);
}

/**
 * @param {CanvasRenderingContext2D} c @param {Game} g
 * @param {number} w @param {number} h @param {boolean} touch @param {Interactable|null} target
 */
function drawHud(c, g, w, h, touch, target) {
  const tutorialOn = g.tutorialActive;
  const p = g.player;
  const ch = g.char;
  // Weapon and lantern viewmodels are 3D, drawn by the renderer (Game.viewState).
  const slot = g.selectedSlot();
  const sign = BIRTHSIGNS[ch.birthsign];
  if (sign && !touch) {
    // Birthsign Power dial: a ring that fills as the power recharges.
    const px = w - 46;
    const py = h - 120;
    const ready = ch.powerCD <= 0;
    c.fillStyle = 'rgba(12,8,20,0.7)';
    c.beginPath();
    c.arc(px, py, 22, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = ready ? sign.hue : 'rgba(201,154,72,0.5)';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(px, py, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (ready ? 1 : 1 - ch.powerCD / sign.cd));
    c.stroke();
    c.fillStyle = ready ? IVORY : 'rgba(246,231,193,0.55)';
    c.font = '700 13px Georgia, serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(ready ? 'R' : String(Math.ceil(ch.powerCD)), px, py);
    c.font = '600 9px Georgia, serif';
    c.fillText(sign.power, px - 30, py + 34);
  }
  // Crosshair and hit marker.
  c.strokeStyle = p.parryT > 0 ? '#ffd36b' : 'rgba(246,231,193,0.85)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(w / 2, h / 2, slot?.kind === 'spell' ? 9 : 5, 0, Math.PI * 2);
  c.stroke();
  if (g.hitmarker > 0) {
    c.strokeStyle = '#ffd36b';
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      c.beginPath();
      c.moveTo(w / 2 + dx * 7, h / 2 + dy * 7);
      c.lineTo(w / 2 + dx * 13, h / 2 + dy * 13);
      c.stroke();
    }
  }
  // Vitals.
  const vx = 16;
  // Touch layout stacks top-down: compass, HTML hotbar (34-84px), vitals | clock, then notes beside the drawer.
  const vy = touch ? 96 : h - 70;
  tube(c, vx, vy, 170, ch.hp / ch.maxHp, '#d8374a', `HEALTH ${Math.ceil(ch.hp)}/${ch.maxHp}`);
  tube(c, vx, vy + 18, 170, ch.mana / ch.maxMana, '#3a7ae0', `AETHER ${Math.floor(ch.mana)}/${ch.maxMana}`);
  tube(c, vx, vy + 36, 170, ch.stamina / ch.maxStamina, '#3aa860', `STAMINA ${Math.floor(ch.stamina)}`);
  if (ch.encumbered) {
    c.fillStyle = '#ff8a5a';
    c.font = '600 11px Georgia, serif';
    c.fillText('OVER-ENCUMBERED', vx, vy - 12);
  }
  // Compass.
  const half = Math.min(220, w / 2 - 20);
  const cx = w / 2;
  const y = touch ? 18 : 22;
  c.fillStyle = 'rgba(12,8,20,0.7)';
  c.fillRect(cx - half, y - 12, half * 2, 24);
  c.strokeStyle = BRASS;
  c.lineWidth = 2;
  c.strokeRect(cx - half, y - 12, half * 2, 24);
  /** @param {number} a */
  const toX = (a) => {
    const d = angleDiff(a, p.yaw);
    return { x: cx + (d / (Math.PI / 2)) * half, off: Math.abs(d) > Math.PI / 2, d };
  };
  c.font = '600 11px Georgia, serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (const [a, label] of [[0, 'E'], [Math.PI / 2, 'S'], [Math.PI, 'W'], [-Math.PI / 2, 'N']]) {
    const m = toX(/** @type {number} */ (a));
    if (m.off) continue;
    c.fillStyle = label === 'N' ? '#ff9a7a' : IVORY;
    c.fillText(/** @type {string} */ (label), m.x, y);
  }
  /** @param {number} tx @param {number} tz @param {string} col @param {number} sizePx */
  const marker = (tx, tz, col, sizePx) => {
    const m = toX(Math.atan2(tz - p.z, tx - p.x));
    const x = m.off ? cx + Math.sign(m.d) * (half - 6) : m.x;
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x, y - sizePx);
    c.lineTo(x + sizePx * 0.7, y);
    c.lineTo(x, y + sizePx);
    c.lineTo(x - sizePx * 0.7, y);
    c.closePath();
    c.fill();
  };
  const L = g.level;
  if (L.outdoor) {
    for (const lm of L.landmarks) {
      if ((lm.kind === 'town' || g.discovered.has(lm.id)) && Math.hypot(lm.x - p.x, lm.z - p.z) < 160) marker(lm.x, lm.z, lm.kind === 'town' ? '#e8c779' : '#8fb0c0', 4);
    }
  }
  for (const m of g.markers) if (m.level === L.id) marker(m.x, m.z, '#ff8ab0', 4);
  const qm = g.quests.trackedMarker();
  if (qm && qm.level === L.id) marker(qm.x, qm.z, CYAN, 7);
  else if (qm) {
    c.fillStyle = CYAN;
    c.font = '600 9px Georgia, serif';
    c.fillText('quest marker: another region', cx, y + 20);
  }
  // Clock and location.
  const hh = Math.floor(g.hour);
  const mm = Math.floor((g.hour - hh) * 60);
  c.textAlign = 'right';
  c.fillStyle = IVORY;
  c.font = '600 12px Georgia, serif';
  c.fillText(`Day ${g.day}  ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, w - 16, touch ? 100 : 22);
  c.fillText(g.locationName(), w - 16, touch ? 116 : 38);
  if (g.level.outdoor) {
    c.fillStyle = 'rgba(246,231,193,0.75)';
    c.font = '600 11px Georgia, serif';
    c.fillText(WEATHER[g.weather.kind].label, w - 16, touch ? 129 : 51);
    c.fillStyle = IVORY;
    c.font = '600 12px Georgia, serif';
  }
  let ey = touch ? 146 : 68;
  for (const [k, v] of Object.entries(ch.effects)) {
    const name = { lumina: 'Lumina', feather: 'Feather Step', oil_ember: 'Ember oil', oil_frost: 'Frost oil' }[/** @type {'lumina'} */ (k)] ?? k;
    c.fillStyle = k === 'feather' && v < 3 ? '#ff8a5a' : CYAN;
    c.fillText(`${name} ${Math.ceil(v)}s`, w - 16, ey);
    ey += 15;
  }
  // Notifications.
  c.textAlign = 'left';
  const nx = touch ? 70 : 12;
  // Notifications sit below the tutorial card while it is showing.
  const ny = (touch ? 186 : 60) + (tutorialOn ? (touch ? 70 : 96) : 0);
  g.notes.forEach((n, i) => {
    c.globalAlpha = Math.min(1, n.t);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(nx, ny + i * 20 - 9, Math.min(touch ? w - nx - 8 : w * 0.5, 9 + n.text.length * 6.6), 18);
    c.fillStyle = IVORY;
    c.font = '600 12px Georgia, serif';
    c.fillText(n.text, nx + 4, ny + i * 20, (touch ? w - nx - 8 : w * 0.5) - 8);
  });
  c.globalAlpha = 1;
  // Interaction prompt and ammo readout.
  c.textAlign = 'center';
  // On touch, sit above the crosshair and between the left drawer and the right-hand buttons.
  const py = touch ? Math.max(310, h / 2 - 40) : h * 0.62;
  const maxW = touch ? w - 140 : w - 24;
  if (target) {
    c.font = '600 15px Georgia, serif';
    const text = `${touch ? '' : '[E] '}${target.label}`;
    const tw = Math.min(c.measureText(text).width, maxW);
    c.fillStyle = 'rgba(12,8,20,0.7)';
    c.fillRect(w / 2 - tw / 2 - 10, py - 13, tw + 20, 26);
    c.fillStyle = IVORY;
    c.fillText(text, w / 2, py, maxW);
  }
  if (slot?.kind === 'item' && ITEMS[slot.id]?.weapon === 'ranged') {
    c.font = '600 12px Georgia, serif';
    c.fillStyle = IVORY;
    c.fillText(`${ITEMS[ch.ammo].name}: ${ch.inventory.count(ch.ammo)}  (R to switch)`, w / 2, touch ? py + 26 : h - 84);
  }
}

// ---------------------------------------------------------------------------
// App: state machine, modals, loop
// ---------------------------------------------------------------------------

/** @typedef {'TITLE'|'EXPLORE'|'DIALOGUE'|'INVENTORY'|'SKILLS'|'JOURNAL'|'MAP'|'TRADE'|'LOOT'|'READ'|'REST'|'PAUSE'|'DEAD'|'ENDING'} AppState */

class App {
  constructor() {
    /**
     * Character creation in progress (null otherwise).
     * @type {{name: string, profession: string, birthsign: string, tab: string, step: number, answers: number[],
     *   reading: {profession: string, birthsign: string}|null, accepted: boolean, tutorial: boolean}|null}
     */
    this.creation = null;
    this.canvas = /** @type {HTMLCanvasElement} */ ($('view'));
    this.hud = /** @type {HTMLCanvasElement} */ ($('hud'));
    const hctx = this.hud.getContext('2d');
    if (!hctx) throw new Error('2D canvas is not available');
    this.hctx = hctx;
    this.renderer = new Renderer(this.canvas);
    ATLAS = this.renderer.spriteAtlas;
    this.audio = new AudioEngine();
    this.input = new Input();
    const params = new URLSearchParams(location.search);
    this.fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : 0;
    // ?debug exposes the running app for console inspection and automated playtests.
    if (params.has('debug')) /** @type {any} */ (window).__app = this;
    this.game = new Game(this.audio, this.fixedSeed || 1 + Math.floor(Math.random() * 999999));
    /** @type {AppState} */
    this.state = 'TITLE';
    this.touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.lockFailed = false;
    /** @type {number|null} */
    this.cursorX = null;
    this.expectUnlock = false;
    /** @type {Interactable|null} */
    this.target = null;
    /** @type {Dialogue|null} */
    this.dialogue = null;
    /** @type {NPC|null} */
    this.talkNpc = null;
    this.invTab = 'pack';
    /** @type {string|null} */
    this.selItem = null;
    /** @type {string[]} */
    this.runeSel = [];
    this.modal = $('modal');
    /** Guided tutorial preference for the next New Game (remembered between visits). */
    this.tutorialPref = true;
    try { this.tutorialPref = localStorage.getItem('shardlands-tutorial') !== '0'; } catch { /* storage blocked: default on */ }
    this.tutCard = $('tutorial');
    for (const ev of ['click', 'pointerdown']) {
      $('tut-end').addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.endTutorial();
      });
    }
    /** Render-scale ceiling for this device; adaptive resolution works below it. */
    this.baseScale = 1;
    /** Smoothed frame time (seconds) and countdown to the next resolution adjustment. */
    this.frameAvg = 1 / 60;
    this.scaleT = 1;
    this.setTouch(this.touch);
    this._bind();
    this.showTitle();
    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame((t) => this.frame(t));
  }

  /** @param {boolean} on */
  setTouch(on) {
    this.touch = on;
    document.body.classList.toggle('touch', on);
    this.baseScale = on ? 0.7 : 1;
    this.renderer.renderScale = this.baseScale;
    this.renderer.maxLights = on ? 8 : 16;
  }

  lock() {
    if (this.touch || this.lockFailed) return;
    try {
      const r = /** @type {any} */ (this.canvas.requestPointerLock());
      if (r && r.catch) r.catch(() => {});
    } catch { /* unsupported: free-look fallback handles it */ }
  }

  /** @param {AppState} s */
  setState(s) {
    const was = this.state;
    this.state = s;
    this.input.clearHeld();
    if (s !== 'EXPLORE' && document.pointerLockElement) {
      this.expectUnlock = true;
      document.exitPointerLock();
    }
    if (s === 'EXPLORE') {
      this.modal.classList.add('hidden');
      this.modal.innerHTML = '';
      if (this.talkNpc) this.talkNpc.talking = false;
      this.talkNpc = null;
      this.dialogue = null;
      if (was !== 'EXPLORE') this.lock();
    }
    this._refreshHotbar();
  }

  /** Show a modal panel. @param {AppState} s @param {string} title @param {...any} body */
  panel(s, title, ...body) {
    this.state !== s && this.setState(s);
    this.modal.innerHTML = '';
    this.modal.classList.remove('hidden');
    const close = s === 'DEAD' || s === 'TITLE' ? null : h('button', { class: 'close brass-btn', type: 'button', onclick: () => this.setState('EXPLORE') }, '✕');
    this.modal.append(h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title), close), h('div', { class: 'panel-body' }, ...body)));
  }

  _bind() {
    const cv = this.canvas;
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== cv && this.state === 'EXPLORE' && !this.touch && !this.expectUnlock) this.showPause();
      this.expectUnlock = false;
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.lockFailed) return;
      this.lockFailed = true;
      document.body.classList.add('free-look');
      this.game.notify('Free mouse look: rest the cursor at an edge to keep turning.');
    });
    cv.addEventListener('click', () => { if (this.state === 'EXPLORE') this.lock(); });
    cv.addEventListener('mouseleave', () => { this.cursorX = null; });
    document.addEventListener('mousemove', (e) => {
      const locked = document.pointerLockElement === cv;
      const free = this.lockFailed && this.state === 'EXPLORE' && !this.touch;
      if (!locked && !free) return;
      this.input.lookX += e.movementX * MOUSE_SENS;
      this.input.lookY += e.movementY * MOUSE_SENS;
      if (free) {
        const r = cv.getBoundingClientRect();
        this.cursorX = ((e.clientX - r.left) / r.width) * 2 - 1;
      }
    });
    cv.addEventListener('mousedown', (e) => {
      if (this.state !== 'EXPLORE' || this.touch) return;
      if (e.button === 0) { this.input.attackHeld = true; this.input.attackPressed = true; }
      if (e.button === 2) { this.input.parryHeld = true; this.input.parry = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.attackHeld = false;
      if (e.button === 2) this.input.parryHeld = false;
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      if (this.state === 'EXPLORE') this.input.cycle = e.deltaY > 0 ? 1 : -1;
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('keydown', (e) => this._key(e));
    window.addEventListener('keyup', (e) => this.input.keyUp(e));
    window.addEventListener('blur', () => this.input.clearHeld());
    $('mute').addEventListener('click', () => {
      this.audio.init();
      $('mute').textContent = this.audio.toggleMute() ? 'Sound: off' : 'Sound: on';
    });
    $('touch-toggle').addEventListener('click', () => this.setTouch(!this.touch));
    this._bindStick($('zone-move'), this.input.touchMove);
    this._bindStick($('zone-look'), this.input.touchLook);
    for (const b of Array.from(document.querySelectorAll('[data-act]'))) {
      const act = /** @type {HTMLElement} */ (b).dataset.act ?? '';
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.audio.init();
        if (act === 'attack') { this.input.attackHeld = true; this.input.attackPressed = true; }
        else if (act === 'parry') { this.input.parryHeld = true; this.input.parry = true; }
        else if (act === 'dash') this.input.dash = true;
        else if (act === 'jump') this.input.jump = true;
        else if (act === 'interact') this.doInteract();
        else if (act === 'power') this.game.usePower();
        else this.openPanel(act);
      });
      const release = () => {
        if (act === 'attack') this.input.attackHeld = false;
        if (act === 'parry') this.input.parryHeld = false;
      };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('pointerleave', release);
    }
  }

  /** Floating virtual joystick. @param {HTMLElement} zone @param {{x:number, y:number}} target */
  _bindStick(zone, target) {
    const base = /** @type {HTMLElement} */ (zone.querySelector('.stick-base'));
    const knob = /** @type {HTMLElement} */ (zone.querySelector('.stick-knob'));
    const R = 50;
    /** @type {number|null} */
    let id = null;
    let ox = 0;
    let oy = 0;
    zone.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      zone.setPointerCapture(id);
      const rect = zone.getBoundingClientRect();
      ox = e.clientX;
      oy = e.clientY;
      base.style.left = `${ox - rect.left}px`;
      base.style.top = `${oy - rect.top}px`;
      base.classList.add('active');
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = (e.clientX - ox) / R;
      let dy = (e.clientY - oy) / R;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      target.x = dx;
      target.y = dy;
      knob.style.transform = `translate(${dx * R}px, ${dy * R}px)`;
    });
    const end = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== id) return;
      id = null;
      target.x = 0;
      target.y = 0;
      knob.style.transform = '';
      base.classList.remove('active');
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  /** @param {KeyboardEvent} e */
  _key(e) {
    if (e.target instanceof HTMLInputElement) return;
    const code = e.code;
    if (code === 'Tab' || code === 'Space' || code === 'F5' || code === 'F9') e.preventDefault();
    if (this.state === 'TITLE' || this.state === 'DEAD' || this.state === 'ENDING') return;
    const panels = { Tab: 'inventory', KeyI: 'inventory', KeyK: 'skills', KeyJ: 'journal', KeyM: 'map' };
    const want = /** @type {Record<string, string>} */ (panels)[code];
    if (code === 'Escape') {
      // Esc ends a running tutorial immediately; otherwise it pauses (with pointer lock the
      // browser's own Esc release opens the pause menu, which also offers End Tutorial).
      if (this.game.tutorialActive && (this.state === 'EXPLORE' || this.state === 'PAUSE')) {
        this.endTutorial();
        return;
      }
      if (this.state === 'EXPLORE' && !document.pointerLockElement) this.showPause();
      else if (this.state !== 'EXPLORE' && this.state !== 'PAUSE') this.setState('EXPLORE');
      return;
    }
    if (want) {
      const map = { inventory: 'INVENTORY', skills: 'SKILLS', journal: 'JOURNAL', map: 'MAP' };
      if (this.state === /** @type {Record<string, string>} */ (map)[want]) this.setState('EXPLORE');
      else if (this.state === 'EXPLORE' || this.state in { INVENTORY: 1, SKILLS: 1, JOURNAL: 1, MAP: 1 }) this.openPanel(want);
      return;
    }
    if (code === 'F5') { this.game.save(); return; }
    if (code === 'F9') { this.loadGame(); return; }
    if (this.state !== 'EXPLORE') return;
    if (code === 'KeyE') { this.doInteract(); return; }
    if (code === 'KeyR') { this.game.usePower(); return; }
    if (code === 'KeyT') { this.cycleAmmo(); return; }
    this.input.keyDown(e);
  }

  cycleAmmo() {
    const c = this.game.char;
    const kinds = ['ammo_shard', 'ammo_flare', 'ammo_frost'].filter((a) => c.inventory.count(a) > 0);
    if (!kinds.length) return;
    c.ammo = kinds[(kinds.indexOf(c.ammo) + 1) % kinds.length];
    this.game.notify(`Loaded ${ITEMS[c.ammo].name}.`);
  }

  doInteract() {
    if (this.state !== 'EXPLORE') return;
    const r = this.game.interact();
    if (!r) return;
    if (r.open === 'dialogue') this.openDialogue(r.data);
    else if (r.open === 'loot') this.openLoot(r.data);
    else if (r.open === 'read') this.openRead(r.data);
    else if (r.open === 'rest') this.openRest();
  }

  /** @param {string} name inventory|skills|journal|map|pause */
  openPanel(name) {
    if (name === 'inventory') this.openInventory();
    else if (name === 'skills') this.openSkills();
    else if (name === 'journal') this.openJournal();
    else if (name === 'map') this.openMap();
    else if (name === 'pause') this.showPause();
  }

  // ----- Title / pause / death / ending -----

  showTitle() {
    this.state = 'TITLE';
    this.modal.classList.remove('hidden');
    this.modal.innerHTML = '';
    const start = () => {
      this.audio.init();
      this.showCreation();
    };
    this.modal.append(h('div', { class: 'panel title' },
      h('h1', {}, 'AETHERIUM'), h('h3', {}, 'SHARDLANDS'),
      h('p', {}, 'You wake beneath a brass sky of painted stars. The Sunken Observatory is silent, its Great Astrolabe Gate sealed, and far above, the ley-lines of the Shardlands have begun to drift.'),
      h('div', { class: 'row' }, btn('New Game', start), btn('Continue', () => this.loadGame(), !Game.hasSave())),
      h('div', { class: 'controls desktop-only' },
        ...[['WASD', 'Move · double-tap to Phase Dash'], ['Mouse', 'Look (click to lock pointer)'], ['Left click', 'Attack / cast (strafe = sweep, forward = thrust, still = chop)'],
          ['Right click', 'Parry (tap) / block (hold)'], ['E', 'Interact, talk, loot'], ['Shift / Space', 'Phase Dash / jump'], ['1-6 · wheel · Q · T', 'Hotbar · cycle · switch ammo'], ['R', 'Birthsign Power'],
          ['Tab/I · K · J · M', 'Inventory · Skills · Journal · Map'], ['F5 / F9', 'Quick save / load']].map(([k, v]) => [h('b', {}, k), h('span', {}, v)])),
      h('p', { class: 'small touch-only' }, 'Left thumb moves, right thumb aims. Buttons attack, parry, interact, dash, jump and use your Birthsign POWER; the drawer opens your pack, skills, journal and map.'),
      h('p', { class: 'small' }, 'Progress autosaves when you change regions and when you rest.'),
    ));
  }

  /** Open the Astrolabe character creation screen (state stays TITLE, so the pointer is free). */
  showCreation() {
    /** @type {{name?: string, profession?: string, birthsign?: string}} */
    let last = {};
    try { last = JSON.parse(localStorage.getItem(IDENTITY_KEY) || '{}') || {}; } catch { /* storage blocked or corrupt: start fresh */ }
    this.creation = {
      name: typeof last.name === 'string' && last.name.trim() ? last.name.slice(0, 32) : randomName(),
      profession: last.profession && last.profession in PROFESSIONS ? last.profession : 'leywright',
      birthsign: last.birthsign && last.birthsign in BIRTHSIGNS ? last.birthsign : 'pendulum',
      tab: 'direct', step: 0, answers: /** @type {number[]} */ ([]), reading: /** @type {{profession:string, birthsign:string}|null} */ (null),
      accepted: false, tutorial: this.tutorialPref,
    };
    this._renderCreation();
  }

  /** Rebuild the creation screen from this.creation. */
  _renderCreation() {
    const st = /** @type {NonNullable<App['creation']>} */ (this.creation);
    const fated = !!(st.accepted && st.reading && st.reading.profession === st.profession && st.reading.birthsign === st.birthsign);
    this.state = 'TITLE';
    this.modal.classList.remove('hidden');
    this.modal.innerHTML = '';
    const name = h('input', { type: 'text', value: st.name, maxlength: '32', class: 'name-input', 'aria-label': 'Character name', autocomplete: 'off', spellcheck: 'false',
      oninput: (/** @type {Event} */ e) => { st.name = /** @type {HTMLInputElement} */ (e.target).value; this._refreshSummaryName(); } });
    const tab = (/** @type {string} */ id, /** @type {string} */ label) => h('button', { class: `brass-btn tab${st.tab === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(st.tab === id),
      onclick: () => { st.tab = id; this._renderCreation(); } }, label);
    this.modal.append(h('div', { class: 'panel create' },
      h('h2', {}, 'The Astrolabe Turns'),
      h('p', { class: 'small' }, 'Before you wake, the Observatory remembers who you were. Choose your past and your sign, or let the Astral Oracle read them from your answers.'),
      h('div', { class: 'row wrap' },
        h('label', { class: 'row grow' }, h('span', {}, 'Name'), name),
        btn('Random name', () => { st.name = randomName(); this._renderCreation(); }),
        h('button', { class: 'brass-btn', type: 'button', 'aria-pressed': String(st.tutorial), onclick: () => { st.tutorial = !st.tutorial; this._renderCreation(); } }, `Guided Tutorial: ${st.tutorial ? 'ON' : 'OFF'}`)),
      h('div', { class: 'row tabs', role: 'tablist' }, tab('direct', 'Direct Selection'), tab('quiz', 'Consult the Astrolabe')),
      h('div', { class: 'create-grid' }, st.tab === 'direct' ? this._creationDirect(st) : this._creationQuiz(st), this._creationSummary(st, fated)),
      h('div', { class: 'row' }, btn('Back', () => this.showTitle()), btn('Awaken in the Observatory', () => this._awaken(fated)))));
    const focus = /** @type {HTMLElement|null} */ (this.modal.querySelector('.tab.on'));
    if (focus && document.activeElement === document.body) focus.focus({ preventScroll: true });
  }

  /** Keep the summary's name in step with typing, without rebuilding (which would steal focus). */
  _refreshSummaryName() {
    const el = this.modal.querySelector('.summary .who');
    if (el && this.creation) el.textContent = this.creation.name.trim() || 'Wanderer';
  }

  /** @param {NonNullable<App['creation']>} st */
  _creationDirect(st) {
    const card = (/** @type {boolean} */ on, /** @type {() => void} */ pick, /** @type {any[]} */ ...kids) =>
      h('button', { type: 'button', class: `card${on ? ' sel' : ''}`, 'aria-pressed': String(on), onclick: pick }, ...kids);
    return h('div', { class: 'create-main' },
      h('h4', {}, 'Profession'),
      h('div', { class: 'cards' }, Object.entries(PROFESSIONS).map(([k, p]) => card(st.profession === k, () => { st.profession = k; this._renderCreation(); },
        h('b', {}, p.name), h('div', { class: 'small' }, p.title),
        h('div', { class: 'small dim' }, Object.entries(p.skills).map(([id, v]) => `+${v} ${SKILLS[id].name}`).join(' · '))))),
      h('h4', {}, 'Mythic Birthsign'),
      h('div', { class: 'cards' }, Object.entries(BIRTHSIGNS).map(([k, b]) => card(st.birthsign === k, () => { st.birthsign = k; this._renderCreation(); },
        emblem(k, 40), h('b', {}, b.name), h('div', { class: 'small' }, b.epithet)))));
  }

  /** The Astral Oracle: four dilemmas, then the birth omen, then the reading. @param {NonNullable<App['creation']>} st */
  _creationQuiz(st) {
    const restart = btn('Begin again', () => { st.step = 0; st.answers = []; st.reading = null; st.accepted = false; this._renderCreation(); });
    if (st.step >= 5 && st.reading) {
      const r = st.reading;
      const p = PROFESSIONS[r.profession];
      const b = BIRTHSIGNS[r.birthsign];
      return h('div', { class: 'create-main oracle' },
        h('h4', {}, 'The Oracle reads your stars'),
        h('div', { class: 'row' }, emblem(r.birthsign, 64), h('div', {}, h('p', {}, `You were a ${p.name}, ${p.title.toLowerCase()}, born under ${b.name}.`), h('p', { class: 'small' }, p.desc))),
        st.accepted && st.profession === r.profession && st.birthsign === r.birthsign
          ? h('p', { class: 'small' }, 'You have accepted the reading: Fated Alignment (+5% skill gain). You may still change either choice under Direct Selection, but the alignment holds only while both match.')
          : btn('Accept the reading', () => { st.profession = r.profession; st.birthsign = r.birthsign; st.accepted = true; this._renderCreation(); }),
        restart);
    }
    if (st.step === 4) {
      return h('div', { class: 'create-main oracle' },
        h('div', { class: 'small dim' }, 'Question 5 of 5'), h('h4', {}, 'The Astral Omen'),
        h('p', {}, 'On the night of your birth, a rare alignment crossed the heavens. Which vision lingers in your memory?'),
        h('div', { class: 'col' }, omenChoices(st.answers).map((k) => h('button', { type: 'button', class: 'brass-btn answer',
          onclick: () => { st.reading = readDestiny(st.answers, k); st.step = 5; this._renderCreation(); } }, emblem(k, 28), h('span', {}, OMENS[/** @type {keyof typeof OMENS} */ (k)])))),
        restart);
    }
    const q = DESTINY_QUIZ[st.step];
    return h('div', { class: 'create-main oracle' },
      h('div', { class: 'small dim' }, `Question ${st.step + 1} of 5`), h('h4', {}, q.title), h('p', {}, q.text),
      h('div', { class: 'col' }, q.answers.map((a, i) => h('button', { type: 'button', class: 'brass-btn answer',
        onclick: () => { st.answers.push(i); st.step++; this._renderCreation(); } }, a.text))),
      st.step ? restart : null);
  }

  /** Live mechanical summary of the current choices. @param {NonNullable<App['creation']>} st @param {boolean} fated */
  _creationSummary(st, fated) {
    const c = new Character();
    applyOrigin(c, { name: st.name, profession: st.profession, birthsign: st.birthsign, fated });
    const p = PROFESSIONS[st.profession];
    const b = BIRTHSIGNS[st.birthsign];
    const gear = ['Resonance Tuning Fork', 'Aether Lantern', 'Lumina Runestone', 'Healing Draughts', 'Lockpicks', ...p.gear.map(([id, n]) => (id === 'shards' ? `${n} Aether Shards` : `${ITEMS[id].name}${n > 1 ? ` ×${n}` : ''}`))];
    return h('aside', { class: 'summary', 'aria-live': 'polite' },
      h('div', { class: 'row' }, emblem(st.birthsign, 56), h('div', {}, h('b', { class: 'who' }, st.name.trim() || 'Wanderer'), h('div', { class: 'small' }, `${p.name} · ${b.name}`))),
      h('div', { class: 'small' }, Object.entries(ATTRIBUTES).map(([id, a]) => `${a.name} ${/** @type {Record<string, number>} */ (c.attrs)[id]}`).join(' · ')),
      h('div', { class: 'small' }, Object.entries(SKILLS).map(([id, s]) => `${s.name} ${c.skills[id].level}`).join(' · ')),
      h('div', { class: 'small' }, `Health ${c.maxHp} · Aether ${c.maxMana} · Stamina ${c.maxStamina} · Carry ${c.carryCap}`),
      h('p', { class: 'small' }, h('b', {}, 'Starting gear: '), gear.join(', '), '.'),
      h('p', { class: 'small' }, h('b', {}, `${p.name}: `), p.perk),
      h('p', { class: 'small' }, h('b', {}, `${b.name} (${b.epithet}): `), b.boon),
      h('p', { class: 'small' }, h('b', {}, `Power, ${b.power}: `), `${b.powerDesc} Recharges in ${b.cd}s or when you rest.`),
      h('p', { class: `small ${fated ? 'fated' : 'dim'}` }, fated ? 'Fated Alignment: +5% skill gain.' : st.reading ? 'Your choices differ from the Oracle\'s reading: no Fated Alignment.' : 'Consult the Astrolabe and accept its reading for a Fated Alignment (+5% skill gain).'));
  }

  /** Start the run with the chosen identity, remembered for next time. @param {boolean} fated */
  _awaken(fated) {
    const st = /** @type {NonNullable<App['creation']>} */ (this.creation);
    this.audio.init();
    this.tutorialPref = st.tutorial;
    try {
      localStorage.setItem('shardlands-tutorial', st.tutorial ? '1' : '0');
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name: st.name.trim(), profession: st.profession, birthsign: st.birthsign }));
    } catch { /* storage blocked: the identity still lives in this run's save */ }
    this.game = new Game(this.audio, this.fixedSeed || 1 + Math.floor(Math.random() * 999999));
    this.game.newRun(st.tutorial, { name: st.name, profession: st.profession, birthsign: st.birthsign, fated });
    this.creation = null;
    this.setState('EXPLORE');
    this.game.notify(`${this.game.char.name} wakes beneath a brass sky.`);
  }

  showPause() {
    this.panel('PAUSE', 'Paused',
      h('div', { class: 'col' },
        btn('Resume', () => this.setState('EXPLORE')),
        this.game.tutorialActive ? btn('End Tutorial', () => this.endTutorial()) : null,
        btn('Save game', () => { this.game.save(); this.setState('EXPLORE'); }),
        btn('Load last save', () => this.loadGame(), !Game.hasSave()),
        btn('Quit to title', () => this.showTitle()),
        h('div', { class: 'col volumes' }, ...[['Master', 'master'], ['Music', 'music'], ['SFX / Ambience', 'sfx']].map(([label, key]) => {
          const k = /** @type {'master'|'music'|'sfx'} */ (key);
          return h('label', { class: 'row' }, h('span', { class: 'grow' }, label),
            h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(this.audio.volumes[k] * 100)), 'aria-label': `${label} volume`,
              oninput: (/** @type {Event} */ e) => this.audio.setVolume(k, Number(/** @type {HTMLInputElement} */ (e.target).value) / 100) }));
        }))));
  }

  /** Terminate the tutorial now and return to unrestricted play. */
  endTutorial() {
    this.game.endTutorial();
    this._refreshTutorial();
    if (this.state !== 'EXPLORE') this.setState('EXPLORE');
  }

  /** Show, hide and fill the tutorial card for the current step and input mode. */
  _refreshTutorial() {
    const t = this.game.flags.tutorial;
    const show = !!t?.active && this.state !== 'TITLE';
    this.tutCard.classList.toggle('hidden', !show);
    if (!show) return;
    const step = TUTORIAL_STEPS[t.step];
    const key = `${t.step}:${this.touch}`;
    if (this.tutCard.dataset.key === key) return;
    this.tutCard.dataset.key = key;
    $('tut-step').textContent = `Tutorial ${t.step + 1}/${TUTORIAL_STEPS.length}: ${step.title}`;
    $('tut-text').textContent = this.touch ? step.touch : step.desktop;
    $('tut-end').textContent = this.touch ? 'End Tutorial [Tap]' : 'End Tutorial [Esc]';
  }

  loadGame() {
    this.audio.init();
    const g = Game.load(this.audio);
    if (!g) return;
    this.game = g;
    this.setState('EXPLORE');
  }

  // ----- Dialogue -----

  /** @param {NPC} npc */
  openDialogue(npc) {
    this.talkNpc = npc;
    npc.talking = true;
    npc.working = npc.scheduleAt(this.game.hour).phase === 'work';
    this.dialogue = new Dialogue(this.game, npc);
    this.game.audio.voice(npc.def.voice, 4);
    this.renderDialogue(this.dialogue.greeting(), []);
  }

  /** @param {string} text @param {import('./rpg.js').DialogueOption[]} options */
  renderDialogue(text, options) {
    const d = /** @type {Dialogue} */ (this.dialogue);
    const npc = /** @type {NPC} */ (this.talkNpc);
    const role = { guildmaster: 'Guildmaster', merchant: 'Merchant', innkeeper: 'Innkeeper', guard: 'Guard', folk: 'Townsfolk' }[npc.def.role] ?? '';
    this.panel('DIALOGUE', npc.def.name,
      h('div', { class: 'dlg' },
        h('div', { class: 'dlg-side' }, icon(npc.def.sprite, 96), h('div', { class: 'small' }, role), h('div', { class: 'topics' }, d.topics().map((t) => btn(t.label, () => this.dlgReply(d.ask(t.id)))))),
        h('div', { class: 'dlg-main' },
          h('p', { class: 'dlg-text' }, text),
          h('div', { class: 'col' }, options.map((o) => btn(o.label, () => this.dlgReply(d.choose(o.id)), !o.enabled))),
          btn('Goodbye', () => this.setState('EXPLORE')))));
  }

  /** @param {import('./rpg.js').DialogueReply} r */
  dlgReply(r) {
    if (r.action === 'trade') {
      this.openTrade();
      return;
    }
    this.renderDialogue(r.text, r.options);
  }

  // ----- Trade -----

  openTrade() {
    const g = this.game;
    const npc = /** @type {NPC} */ (this.talkNpc);
    const shop = npc.def.shop ?? '';
    const rep = g.factions.rep[SHOPS[shop].town] || 0;
    let msg = '';
    const render = () => {
      const c = g.char;
      this.panel('TRADE', SHOPS[shop].name,
        h('p', {}, `Your purse: ${c.shards} Aether Shards. `, h('span', { class: 'warn' }, msg)),
        h('div', { class: 'cols' },
          h('div', {}, h('h4', {}, 'For sale'), g.stock(shop).filter((r) => r[1] > 0).map(([id, n]) => h('div', { class: 'row item-row' },
            icon(ITEMS[id].sprite, 32), h('span', { class: 'grow' }, `${ITEMS[id].name} ×${n}`),
            btn(`Buy ${buyPrice(c, id, rep)}`, () => { msg = g.buy(shop, id) ?? ''; render(); })))),
          h('div', {}, h('h4', {}, 'Your pack'), c.inventory.items.filter((it) => ITEMS[it.id].value > 0).map((it) => h('div', { class: 'row item-row' },
            icon(ITEMS[it.id].sprite, 32), h('span', { class: 'grow' }, `${ITEMS[it.id].name} ×${it.qty}`),
            btn(`Sell ${sellPrice(c, it.id, rep)}`, () => { msg = g.sell(shop, it.id) ?? ''; render(); }))))),
        btn('Back to conversation', () => this.renderDialogue('Anything else?', [])));
    };
    render();
  }

  // ----- Loot / read / rest -----

  /** @param {Prop} chest */
  openLoot(chest) {
    const g = this.game;
    const render = () => {
      const loot = g.world.loot[chest.key];
      const take = (/** @type {number} */ i) => {
        const [id, n] = loot[i];
        g.give(id, n);
        loot.splice(i, 1);
        g.audio.pickup();
        render();
      };
      this.panel('LOOT', 'Chest',
        loot.length ? loot.map(([id, n], i) => h('div', { class: 'row item-row' },
          icon(id === 'shards' ? 'i_shards' : ITEMS[id].sprite, 32), h('span', { class: 'grow' }, `${id === 'shards' ? 'Aether Shards' : ITEMS[id].name} ×${n}`), btn('Take', () => take(i))))
          : h('p', {}, 'Empty.'),
        h('div', { class: 'row' }, btn('Take all', () => { while (loot.length) take(0); }, !loot.length), btn('Close', () => this.setState('EXPLORE'))));
    };
    render();
  }

  /** @param {string} id */
  openRead(id) {
    if (id.startsWith('notice_')) {
      const guild = id.slice(7);
      const c = this.game.contracts[/** @type {'artificers'} */ (guild)];
      this.panel('READ', guild === 'artificers' ? "Artificers' Notice Board" : "Wardens' Notice Board",
        h('p', {}, guild === 'artificers' ? 'WORK FOR MENDERS: relics recovered, supplies brought, parcels carried. Speak to Master Vance in the Guildhall.' : 'WARDENS WANTED: vaults to clear, landmarks to survey, parcels to carry. Speak to Captain Marr in the Lodge.'),
        h('p', {}, c ? `Your current contract: ${c.title}. ${c.brief}` : 'You hold no contract with this guild.'));
      return;
    }
    const b = BOOKS[id];
    this.panel('READ', b.title, ...b.text.split('\n\n').map((t) => h('p', { class: 'book' }, t)));
  }

  openRest() {
    const g = this.game;
    const until = Math.round(((6 - g.hour + 24) % 24) || 24);
    const go = (/** @type {number} */ n) => {
      const err = g.rest(n);
      if (err) this.panel('REST', 'Rest', h('p', {}, err));
      else this.setState('EXPLORE');
    };
    this.panel('REST', 'Rest', h('p', {}, 'How long will you rest?'), h('div', { class: 'row' }, btn('1 hour', () => go(1)), btn('4 hours', () => go(4)), btn('8 hours', () => go(8)), btn(`Until dawn (${until}h)`, () => go(until))));
  }

  // ----- Inventory & crafting -----

  openInventory() {
    const g = this.game;
    if (g.flags.tutorial) g.flags.tutorial.sawInventory = true;
    const c = g.char;
    const tabs = h('div', { class: 'row tabs' }, btn('Pack', () => { this.invTab = 'pack'; this.openInventory(); }), btn('Alchemy & Tinkering', () => { this.invTab = 'craft'; this.openInventory(); }));
    if (this.invTab === 'craft') {
      this.panel('INVENTORY', 'Alchemy & Tinkering', tabs, h('p', { class: 'small' }, 'Combine gathered ingredients. Crafting trains Artificing.'),
        RECIPES.map((r) => {
          const out = ITEMS[r.makes[0]];
          const can = c.skill('artificing') >= r.level && r.needs.every(([id, n]) => c.inventory.count(id) >= n);
          return h('div', { class: 'row item-row' }, icon(out.sprite, 36),
            h('div', { class: 'grow' }, h('b', {}, `${out.name}${r.makes[1] > 1 ? ` ×${r.makes[1]}` : ''}`), h('div', { class: 'small' },
              r.needs.map(([id, n]) => `${ITEMS[id].name} ${c.inventory.count(id)}/${n}`).join(' · '), r.level > 1 ? ` · Artificing ${r.level}` : '')),
            btn('Craft', () => {
              const err = craft(c, r);
              if (err) g.notify(err);
              else {
                g.audio.brew();
                g.exercise('artificing', 1);
                g.notify(`Crafted ${out.name}.`);
              }
              this.openInventory();
            }, !can));
        }));
      return;
    }
    const weight = c.inventory.weight();
    const sel = this.selItem && c.inventory.count(this.selItem) ? this.selItem : null;
    const equipped = (/** @type {string} */ id) => Object.values(c.equip).includes(id) || c.ammo === id;
    /** @type {any[]} */
    let details = [h('p', { class: 'small' }, 'Select an item.')];
    if (sel) {
      const d = ITEMS[sel];
      const isEq = equipped(sel);
      /** @type {any[]} */
      const actions = [];
      if (['weapon', 'offhand', 'armor', 'relic'].includes(d.type)) actions.push(btn(isEq && d.type !== 'weapon' ? 'Unequip' : 'Equip', () => { g.useItem(sel); this.openInventory(); }));
      if (d.type === 'consumable') actions.push(btn('Use', () => { g.useItem(sel); this.openInventory(); }));
      if (d.type === 'ammo') actions.push(btn('Load', () => { g.useItem(sel); this.openInventory(); }));
      if (d.type === 'book') actions.push(btn('Read', () => this.openRead(d.book ?? '')));
      if (d.type === 'weapon') {
        actions.push(h('div', { class: 'row' }, h('span', { class: 'small' }, 'Hotbar: '), [0, 1, 2, 3, 4, 5].map((i) => btn(String(i + 1), () => {
          c.hotbar = c.hotbar.map((s) => (s?.id === sel ? null : s));
          c.hotbar[i] = { kind: 'item', id: sel };
          this.openInventory();
        }))));
      }
      if (d.type !== 'quest' && !(isEq && c.inventory.count(sel) <= 1)) {
        actions.push(btn('Drop', () => {
          c.inventory.remove(sel, 1);
          const p = g.player;
          const prop = g.level.addProp('item', d.sprite, p.x + Math.cos(p.yaw) * 0.8, p.z + Math.sin(p.yaw) * 0.8, { size: 0.6, data: { item: sel, qty: 1 } });
          g.level._indexProp(prop);
          this.openInventory();
        }));
      }
      details = [h('div', { class: 'row' }, icon(d.sprite, 64), h('div', {}, h('b', {}, d.name), h('div', { class: 'small' }, `${d.type} · weight ${d.weight} · value ${d.value}`))), h('p', {}, d.desc), h('div', { class: 'row wrap' }, actions)];
    }
    const slotNames = { main: 'Main Hand', off: 'Off-Hand / Lantern', armor: 'Armor', relic: 'Relic' };
    this.panel('INVENTORY', 'Inventory', tabs,
      h('div', { class: 'cols' },
        h('div', {},
          h('div', { class: 'grid' }, c.inventory.items.map((it) => h('button', { class: `cell${it.id === sel ? ' sel' : ''}${equipped(it.id) ? ' eq' : ''}`, type: 'button', title: ITEMS[it.id].name, onclick: () => { this.selItem = it.id; this.openInventory(); } },
            icon(ITEMS[it.id].sprite, 44), it.qty > 1 ? h('span', { class: 'qty' }, String(it.qty)) : null))),
          h('p', { class: weight > c.carryCap ? 'warn' : 'small' }, `Weight ${weight.toFixed(1)} / ${c.carryCap}${weight > c.carryCap ? ' (over-encumbered: slow, no dash)' : ''} · ${c.shards} Aether Shards`)),
        h('div', {},
          h('h4', {}, 'Equipment'),
          Object.entries(slotNames).map(([k, label]) => {
            const id = /** @type {Record<string, string|null>} */ (c.equip)[k];
            return h('div', { class: 'row item-row' }, id ? icon(ITEMS[id].sprite, 28) : h('span', { class: 'empty-slot' }), h('span', {}, `${label}: ${id ? ITEMS[id].name : '(empty)'}`));
          }),
          h('div', { class: 'small' }, `Armour ${c.armor} · Ammo: ${ITEMS[c.ammo].name}`),
          h('hr', {}), ...details)));
  }

  // ----- Skills, attributes, perks, runes -----

  openSkills() {
    const g = this.game;
    const c = g.char;
    const owned = Object.keys(ITEMS).filter((id) => ITEMS[id].type === 'rune' && c.inventory.count(id));
    const spell = spellFor(this.runeSel);
    const prof = PROFESSIONS[c.profession];
    const sign = BIRTHSIGNS[c.birthsign];
    const profile = prof && sign
      ? h('div', { class: 'row profile' }, emblem(c.birthsign, 56), h('div', { class: 'grow' },
        h('b', {}, c.name), h('div', { class: 'small' }, `${prof.name} (${prof.title}) · born under ${sign.name}${c.fated ? ' · Fated Alignment (+5% skill gain)' : ''}`),
        h('div', { class: 'small' }, `${sign.boon} ${prof.perk}`),
        h('div', { class: 'small' }, h('b', {}, `Power [R], ${sign.power}: `), sign.powerDesc, c.powerCD > 0 ? ` Recharging: ${Math.ceil(c.powerCD)}s, or rest.` : ' Ready.')))
      : h('div', { class: 'small dim' }, `${c.name}: this traveller woke before the Astrolabe read the stars (an older save).`);
    this.panel('SKILLS', `Level ${c.level}  ·  ${c.skillUps % 10}/10 skill increases to next level`, profile,
      h('div', { class: 'cols' },
        h('div', {},
          h('h4', {}, `Attributes (${c.attrPoints} points)`),
          Object.entries(ATTRIBUTES).map(([id, a]) => h('div', { class: 'row item-row' }, h('span', { class: 'grow' }, h('b', {}, `${a.name} ${/** @type {Record<string, number>} */ (c.attrs)[id]}`), h('div', { class: 'small' }, a.desc)),
            btn('+', () => { /** @type {Record<string, number>} */ (c.attrs)[id]++; c.attrPoints--; this.openSkills(); }, c.attrPoints <= 0))),
          h('h4', {}, 'Skills (improve by use)'),
          Object.entries(SKILLS).map(([id, s]) => {
            const sk = c.skills[id];
            const need = 3 + sk.level * 2;
            return h('div', { class: 'item-row' }, h('b', {}, `${s.name} ${c.skill(id)}`), h('div', { class: 'bar' }, h('div', { style: `width:${(sk.xp / need) * 100}%` })), h('div', { class: 'small' }, s.desc));
          })),
        h('div', {},
          h('h4', {}, `Perks (${c.perkPoints} points)`),
          PERKS.map((p) => {
            const has = c.has(p.id);
            const ok = !has && c.perkPoints > 0 && c.skill(p.skill) >= p.need;
            return h('div', { class: 'row item-row' }, h('span', { class: 'grow' }, h('b', {}, `${p.name}${has ? ' ✓' : ''}`), h('div', { class: 'small' }, `${SKILLS[p.skill].name} ${p.need}: ${p.desc}`)),
              has ? null : btn('Learn', () => { c.perks.push(p.id); c.perkPoints--; this.openSkills(); }, !ok));
          }),
          h('h4', {}, 'Runecasting'),
          owned.length ? h('div', { class: 'row wrap' }, owned.map((id) => h('button', { class: `cell${this.runeSel.includes(id) ? ' sel' : ''}`, type: 'button', title: ITEMS[id].name, onclick: () => {
            this.runeSel = this.runeSel.includes(id) ? this.runeSel.filter((r) => r !== id) : [...this.runeSel, id];
            this.openSkills();
          } }, icon(id, 40)))) : h('p', { class: 'small' }, 'You carry no runestones yet.'),
          h('div', { class: 'row' }, h('span', { class: 'grow small' }, this.runeSel.length ? `Combination: ${spell ? SPELLS[spell].name : 'nothing known'}` : 'Select runestones to combine.'),
            btn('Inscribe', () => {
              if (!spell) return;
              if (!c.spells.includes(spell)) {
                c.spells.push(spell);
                const free = c.hotbar.indexOf(null);
                if (free >= 0) c.hotbar[free] = { kind: 'spell', id: spell };
                g.notify(`Learned ${SPELLS[spell].name}.`);
                g.audio.cast(spell);
              }
              this.runeSel = [];
              this.openSkills();
            }, !spell || c.spells.includes(spell ?? ''))),
          c.spells.map((id) => h('div', { class: 'row item-row' }, h('span', { class: 'grow' }, h('b', {}, `${SPELLS[id].name} (${SPELLS[id].cost} Aether)`), h('div', { class: 'small' }, SPELLS[id].desc)),
            h('span', { class: 'small' }, 'Hotbar:'), [0, 1, 2, 3, 4, 5].map((i) => btn(String(i + 1), () => {
              c.hotbar = c.hotbar.map((s) => (s?.id === id ? null : s));
              c.hotbar[i] = { kind: 'spell', id };
              this.openSkills();
            })))))));
  }

  // ----- Journal -----

  openJournal() {
    this.game.audio.page();
    const g = this.game;
    const quests = Object.values(g.quests.quests);
    const active = quests.filter((q) => !q.done);
    const done = quests.filter((q) => q.done);
    this.panel('JOURNAL', 'Quest Journal',
      h('div', { class: 'cols' },
        h('div', {},
          h('h4', {}, 'Active'),
          active.length ? active.map((q) => h('div', { class: 'quest' },
            h('div', { class: 'row' }, h('b', { class: 'grow' }, `${q.kind === 'main' ? '★ ' : ''}${q.title}`), g.quests.tracked === q.id ? h('span', { class: 'small' }, 'tracked') : btn('Track', () => { g.quests.tracked = q.id; this.openJournal(); })),
            [...q.entries].reverse().map((e) => h('p', { class: 'small' }, `Day ${e.day}: ${e.text}`)))) : h('p', { class: 'small' }, 'Nothing pressing.'),
          done.length ? h('details', {}, h('summary', {}, `Completed (${done.length})`), done.map((q) => h('p', { class: 'small' }, `✓ ${q.title}`))) : null),
        h('div', {},
          h('h4', {}, 'Factions'),
          Object.entries(FACTIONS).map(([id, name]) => h('div', { class: 'row item-row' }, h('span', { class: 'grow' }, name), h('span', {}, `${g.factions.rep[id] || 0}${id in g.factions.member && g.factions.member[/** @type {'artificers'} */ (id)] ? ' · member' : ''}`))),
          h('h4', {}, 'Contracts'),
          ['artificers', 'wardens'].map((k) => {
            const c = g.contracts[/** @type {'artificers'} */ (k)];
            return h('p', { class: 'small' }, `${FACTIONS[k]}: ${c ? `${c.title}${g.contractReady(c) ? ' (ready to report)' : ''}` : 'none'}`);
          }),
          h('h4', {}, 'Discoveries'),
          h('p', { class: 'small' }, g.discovered.size ? [...g.discovered].map((id) => g.getLevel('overworld').landmarks.find((l) => l.id === id)?.name ?? id).join(', ') : 'None yet.'))));
  }

  // ----- Automap -----

  openMap() {
    this.game.audio.page();
    const g = this.game;
    const L = g.level;
    const size = Math.min(520, window.innerWidth - 60, window.innerHeight - 180);
    const scale = size / Math.max(L.w, L.h);
    const cv = /** @type {HTMLCanvasElement} */ (h('canvas', { width: L.w, height: L.h, class: 'map', style: `width:${L.w * scale}px;height:${L.h * scale}px` }));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(L.w, L.h);
    /** @type {Record<number, number[]>} */
    const COL = {
      [TILE.GRASS]: [46, 90, 58], [TILE.FEN]: [74, 90, 52], [TILE.BASALT]: [58, 58, 70], [TILE.DUST]: [138, 96, 64], [TILE.COBBLE]: [150, 142, 128],
      [TILE.CLIFF]: [90, 74, 58], [TILE.PLANK]: [122, 80, 48], [TILE.LEY_FLOOR]: [42, 106, 128], [TILE.FLAGSTONE]: [106, 100, 88], [TILE.OBS_FLOOR]: [110, 86, 46],
    };
    for (let j = 0; j < L.h; j++) {
      for (let i = 0; i < L.w; i++) {
        const k = L.idx(i, j);
        const o = k * 4;
        let col = [13, 11, 16];
        if (L.explored[k]) {
          col = L.wall[k] ? [26, 20, 16] : COL[L.floorTex[k]] ?? [96, 90, 80];
          if (L.hazard[k] === HAZARD.CHASM) col = [0, 0, 0];
          else if (L.hazard[k] === HAZARD.DEEP || L.floorH[k] < L.waterLevel) col = [30, 70, 110];
          else if (L.hazard[k] === HAZARD.VENT) col = [200, 80, 30];
          if (L.doorAt[k] >= 0) col = [220, 180, 90];
          if (L.ceil[k] > 0 && L.outdoor) col = col.map((v) => v * 0.7);
        }
        img.data[o] = col[0];
        img.data[o + 1] = col[1];
        img.data[o + 2] = col[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const p = g.player;
    const overlay = /** @type {HTMLCanvasElement} */ (h('canvas', { width: L.w * scale, height: L.h * scale, class: 'map-overlay' }));
    const oc = overlay.getContext('2d');
    const draw = () => {
      if (!oc) return;
      oc.clearRect(0, 0, overlay.width, overlay.height);
      oc.font = '600 11px Georgia, serif';
      oc.textAlign = 'center';
      /** @param {number} x @param {number} z @param {string} col @param {string} label */
      const pin = (x, z, col, label) => {
        oc.fillStyle = col;
        oc.beginPath();
        oc.arc(x * scale, z * scale, 4, 0, Math.PI * 2);
        oc.fill();
        oc.fillStyle = '#f6e7c1';
        oc.fillText(label, x * scale, z * scale - 8);
      };
      for (const lm of L.landmarks) if (lm.kind === 'town' || g.discovered.has(lm.id)) pin(lm.x, lm.z, lm.kind === 'town' ? '#e8c779' : '#8fb0c0', lm.name);
      for (const m of g.markers) if (m.level === L.id) pin(m.x, m.z, '#ff8ab0', m.label);
      const qm = g.quests.trackedMarker();
      if (qm && qm.level === L.id) pin(qm.x, qm.z, CYAN, 'Quest');
      oc.save();
      oc.translate(p.x * scale, p.z * scale);
      oc.rotate(p.yaw);
      oc.fillStyle = '#ff5a5a';
      oc.beginPath();
      oc.moveTo(9, 0);
      oc.lineTo(-6, 5);
      oc.lineTo(-6, -5);
      oc.closePath();
      oc.fill();
      oc.restore();
    };
    draw();
    overlay.addEventListener('click', (e) => {
      const r = overlay.getBoundingClientRect();
      const x = (e.clientX - r.left) / scale;
      const z = (e.clientY - r.top) / scale;
      const hit = g.markers.findIndex((m) => m.level === L.id && Math.hypot(m.x - x, m.z - z) < 6 / scale + 2);
      if (hit >= 0) g.markers.splice(hit, 1);
      else {
        let label = `Marker ${g.markers.length + 1}`;
        try {
          const typed = window.prompt('Name this marker', label);
          if (typed === null) return;
          label = typed.trim() || label;
        } catch { /* prompt blocked: keep the default label */ }
        g.markers.push({ level: L.id, x, z, label });
      }
      draw();
    });
    this.panel('MAP', L.outdoor ? 'The Shardlands' : L.name,
      h('div', { class: 'map-wrap', style: `width:${L.w * scale}px;height:${L.h * scale}px` }, cv, overlay),
      h('p', { class: 'small' }, 'Click the map to place a marker; click a marker to remove it. Discovered places are labelled.'));
  }

  // ----- Hotbar (HTML, tappable) -----

  _refreshHotbar() {
    const bar = $('hotbar');
    const c = this.game.char;
    const key = JSON.stringify([c.hotbar, this.game.hotIndex]);
    if (bar.dataset.key === key) return;
    bar.dataset.key = key;
    bar.innerHTML = '';
    c.hotbar.forEach((s, i) => {
      const sprite = !s ? null : s.kind === 'item' ? ITEMS[s.id].sprite : SPELLS[s.id].runes[0];
      bar.append(h('button', { class: `slot${i === this.game.hotIndex ? ' sel' : ''}`, type: 'button', title: s ? (s.kind === 'item' ? ITEMS[s.id].name : SPELLS[s.id].name) : '', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); this.game.selectSlot(i); } },
        h('span', { class: 'key' }, String(i + 1)), sprite ? icon(sprite, 36) : null));
    });
  }

  // ----- Loop -----

  /** @param {number} now */
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const g = this.game;
    // Adaptive resolution: trade internal resolution (down to 55% of the device ceiling)
    // for frame rate when frames run long, and climb back when there is headroom.
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.scaleT -= dt;
    if (this.scaleT <= 0 && !document.hidden) {
      this.scaleT = 0.5;
      const r = this.renderer;
      if (this.frameAvg > 1 / 50 && r.renderScale > this.baseScale * 0.55) r.renderScale = Math.max(this.baseScale * 0.55, r.renderScale - 0.05);
      else if (this.frameAvg < 1 / 58 && r.renderScale < this.baseScale) r.renderScale = Math.min(this.baseScale, r.renderScale + 0.05);
    }
    if (this.state === 'EXPLORE') {
      if (this.lockFailed && !this.touch && this.cursorX !== null && Math.abs(this.cursorX) > 0.8) {
        this.input.lookX += Math.sign(this.cursorX) * ((Math.abs(this.cursorX) - 0.8) / 0.2) * 2.6 * dt;
      }
      this.acc += dt;
      let steps = 0;
      while (this.acc >= STEP_DT && steps < 6) {
        g.update(STEP_DT, this.input.sample());
        this.acc -= STEP_DT;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      this.target = g.findInteract();
      if (g.dead) {
        this.panel('DEAD', 'You have fallen', h('p', {}, 'The brass falls silent around you.'),
          h('div', { class: 'row' }, btn('Load last save', () => this.loadGame(), !Game.hasSave()), btn('New game', () => this.showTitle())));
      } else if (g.flags.ending && !g.flags.endingShown) {
        g.flags.endingShown = true;
        g.save(true);
        this.panel('ENDING', 'The Astrolabe Turns True',
          h('p', {}, 'The Resonant Core settles into the armillary with a sound like a held breath let go. Ring by ring the Great Astrolabe turns, and far above, every ley-line in the Shardlands draws back to true.'),
          h('p', {}, 'The lamps of Cinderwick and Oakhaven burn steady tonight. The roads, the vaults and the guilds are still yours to explore.'),
          btn('Continue exploring', () => this.setState('EXPLORE')));
      }
    } else if (this.state === 'TITLE') {
      g.player.yaw += dt * 0.1;
      g.time += dt;
      g._updateEnv(dt);
      if (!g.streamer.active.size) {
        const ev = g.streamer.update(g.player.x, g.player.z);
        g.chunkLoads.push(...ev.load);
      }
    }
    if (g.levelChanged) {
      g.levelChanged = false;
      this.renderer.setLevel(g.level);
    }
    for (const k of g.chunkUnloads.splice(0)) this.renderer.unloadChunk(k);
    for (let n = 0; n < 3 && g.chunkLoads.length; n++) this.renderer.loadChunk(/** @type {number} */ (g.chunkLoads.shift()));
    this._refreshHotbar();
    this._refreshTutorial();

    const p = g.player;
    this.renderer.render({
      eye: { x: p.x, y: p.y + p.eye + Math.sin(p.bob * 2) * 0.03, z: p.z }, yaw: p.yaw, pitch: p.pitch, time: g.time,
      sprites: g.collectSprites(), lights: g.collectLights(), doors: g.level.doors, fx: g.fx, env: g.env,
      weather: { rain: g.weather.rain, wind: g.weather.wind }, view: this.state === 'TITLE' ? undefined : g.viewState(),
    });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.hud.clientWidth;
    const hh = this.hud.clientHeight;
    if (this.hud.width !== Math.round(w * dpr) || this.hud.height !== Math.round(hh * dpr)) {
      this.hud.width = Math.round(w * dpr);
      this.hud.height = Math.round(hh * dpr);
    }
    this.hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.hctx.clearRect(0, 0, w, hh);
    if (this.state !== 'TITLE') drawHud(this.hctx, g, w, hh, this.touch, this.state === 'EXPLORE' ? this.target : null);
    if (this.touch) {
      // Touch POWER button shows its countdown while recharging.
      const label = g.char.powerCD > 0 ? String(Math.ceil(g.char.powerCD)) : 'POWER';
      const pb = $('power-btn');
      if (pb.textContent !== label) pb.textContent = label;
    }
  }
}

// Two frames let the "Forging…" status paint before texture synthesis blocks the thread.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const msg = document.getElementById('boot-error');
  try {
    new App();
    if (msg) msg.textContent = '';
  } catch (err) {
    if (msg) msg.textContent = String(/** @type {Error} */ (err).message || err);
    throw err;
  }
}));
