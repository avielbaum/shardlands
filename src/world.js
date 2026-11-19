/**
 * @file Seed-based procedural world: the Sunken Observatory (starting sanctuary), the
 * chunk-streamed overworld (three biomes, roads, two towns, shrines, a chasm-ringed spire),
 * delvable dungeons, plus grid collision, line of sight and fog-of-war exploration.
 */

/** @param {number} seed @returns {() => number} uniform [0, 1) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash in [0, 1). @param {number} x @param {number} y @param {number} [seed] */
export function hash2(x, y, seed = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. @param {number} x @param {number} y @param {number} [seed] */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = x - ix;
  const ty = y - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal value noise in [0, 1]. @param {number} x @param {number} y @param {number} [seed] @param {number} [oct] */
export function fbm(x, y, seed = 0, oct = 4) {
  let amp = 0.5;
  let f = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * noise2(x * f, y * f, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** @param {number} v @param {number} a @param {number} b */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** @param {number} a @param {number} b @param {number} v */
const sstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** World texture tiles (indices into the world atlas). */
export const TILE = Object.freeze({
  BRASS: 0, CONDUIT: 1, OBS_FLOOR: 2, STAR_CEIL: 3, ASTRO_DOOR: 4, GATE: 5, LEY_FLOOR: 6, GEAR: 7,
  LIMESTONE: 8, MOSSY: 9, FLAGSTONE: 10, CAVE_CEIL: 11, TIMBER: 12, PLANK: 13, ROOF: 14, COBBLE: 15,
  WOOD_DOOR: 16, PLASTER: 17, GRASS: 18, FEN: 19, BASALT: 20, DUST: 21, WATER: 22, CLIFF: 23,
});
/** Cell hazards. */
export const HAZARD = Object.freeze({ NONE: 0, CHASM: 1, DEEP: 2, VENT: 3 });
/** Highest floor rise an actor can step onto. */
export const STEP = 0.55;
/** Chunk edge in cells. */
export const CHUNK = 16;
export const BIOME = Object.freeze({ FEN: 0, BADLANDS: 1, WOOD: 2 });
export const BIOME_NAMES = ['Whispering Brass Fen', 'Basalt Badlands', 'Ley-Wood'];
export const OVERWORLD_SIZE = 256;

/**
 * Overworld points of interest. Towns and shrines are stamped here; the gate is where the
 * Great Astrolabe Gate surfaces from the Sunken Observatory.
 */
export const SITES = Object.freeze({
  gate: { name: 'Astrolabe Gate Ruin', x: 128, z: 134 },
  oakhaven: { name: 'Oakhaven', x: 84, z: 70 },
  cinderwick: { name: 'Cinderwick', x: 188, z: 130 },
  drowned: { name: 'The Drowned Shrine', x: 50, z: 192 },
  ember: { name: 'The Ember Vault', x: 206, z: 204 },
  verdant: { name: 'The Verdant Reliquary', x: 142, z: 36 },
  spire: { name: 'The Hollow Spire', x: 224, z: 70 },
});

/** @typedef {{x:number, y:number, z:number, r:number, g:number, b:number, flicker?:number}} Light */
/** @typedef {{level:string, x:number|null, z:number|null, yaw:number}} Portal */
/**
 * @typedef {Object} Door
 * @property {string} key
 * @property {number} i
 * @property {number} j
 * @property {'x'|'z'} axis direction the panel spans (and slides along)
 * @property {number} open 0 shut .. 1 fully slid aside
 * @property {number} hold seconds an NPC keeps it open
 * @property {boolean} shut player-chosen state (true = closed)
 * @property {boolean} locked
 * @property {string|null} keyId item that opens it
 * @property {number} lockLevel 0 = no lock; compared against Artificing
 * @property {boolean} magic sealed: only the Unlock rune opens it
 * @property {boolean} puzzle opened by the observatory anchor puzzle
 * @property {number} tex
 * @property {number} height panel height
 * @property {number} top lintel top
 * @property {number} base floor height
 * @property {string} name
 * @property {Portal|null} portal walking through it changes level
 */
/**
 * @typedef {Object} Prop
 * @property {string} key stable id for persistence
 * @property {string} kind chest|book|bed|campfire|lever|anchor|item|herb|stairs|landmark|notice|gatecore|decor
 * @property {string} sprite sprite name in the atlas
 * @property {number} x
 * @property {number} z
 * @property {number} size billboard edge in world units
 * @property {number} lift height above the floor
 * @property {number} solid collision radius (0 = walk-through)
 * @property {boolean} gone removed (looted, harvested)
 * @property {Object<string, any>} data
 */
/** @typedef {{key:string, kind:string, x:number, z:number, tier:number, boss?:boolean, training?:boolean}} Spawn */
/** @typedef {{x:number, z:number}} Spot */
/**
 * @typedef {Object} NpcDef
 * @property {string} id
 * @property {string} name
 * @property {string} role guildmaster|merchant|innkeeper|guard|folk
 * @property {string} town
 * @property {string} sprite base sprite (the walk frame is sprite + '_walk')
 * @property {number} voice pitch multiplier
 * @property {string|null} faction
 * @property {string|null} shop merchant stock id
 * @property {{home:Spot, work:Spot, tavern:Spot, patrol?:Spot[]}} spots
 * @property {number[]} hours [workStart, workEnd, bedtime]
 */
/** @typedef {{id:string, name:string, kind:'town'|'shrine'|'landmark'|'gate', x:number, z:number, r:number}} Landmark */

export class Level {
  /** @param {string} id @param {string} name @param {number} w @param {number} h @param {boolean} outdoor */
  constructor(id, name, w, h, outdoor) {
    this.id = id;
    this.name = name;
    this.w = w;
    this.h = h;
    this.outdoor = outdoor;
    /** Smooth levels take floor height from shared vertex heights (terrain). */
    this.smooth = outdoor;
    const n = w * h;
    this.vh = new Float32Array((w + 1) * (h + 1));
    this.floorH = new Float32Array(n);
    /** 0 = open; otherwise TILE + 1 */
    this.wall = new Uint8Array(n);
    this.wallTop = new Float32Array(n);
    this.floorTex = new Uint8Array(n);
    /** 0 = open sky; otherwise ceiling height */
    this.ceil = new Float32Array(n);
    this.ceilTex = new Uint8Array(n);
    this.hazard = new Uint8Array(n);
    this.zone = new Int16Array(n).fill(-1);
    this.explored = new Uint8Array(n);
    this.doorAt = new Int16Array(n).fill(-1);
    /** @type {Door[]} */
    this.doors = [];
    /** @type {Prop[]} */
    this.props = [];
    /** @type {Light[]} */
    this.lights = [];
    /** @type {Spawn[]} */
    this.spawns = [];
    /** @type {NpcDef[]} */
    this.npcDefs = [];
    /** @type {Landmark[]} */
    this.landmarks = [];
    /** Building footprints (outer wall extents) that get pitched roofs. @type {{x0:number, z0:number, x1:number, z1:number, base:number}[]} */
    this.roofs = [];
    /** @type {Map<number, Prop[]>} */
    this.solidGrid = new Map();
    /** @type {Map<number, Prop[]>} */
    this.propChunks = new Map();
    /** @type {Map<number, Light[]>} */
    this.lightChunks = new Map();
    /** @type {((x:number, z:number) => number)|null} */
    this.biomeAt = null;
    this.waterLevel = -1e9;
    this.fog = [0.03, 0.03, 0.07];
    this.fogDensity = 0.06;
    this.ambient = [0.1, 0.1, 0.15];
    /** @type {{x:number, z:number, yaw:number}} */
    this.spawn = { x: w / 2, z: h / 2, yaw: 0 };
    /** @type {number} Tile used for indoor floor-step faces. */
    this.stepTex = TILE.BRASS;
  }

  /** @param {number} i @param {number} j */
  idx(i, j) {
    return j * this.w + i;
  }

  /** @param {number} i @param {number} j */
  inBounds(i, j) {
    return i >= 0 && j >= 0 && i < this.w && j < this.h;
  }

  /** @param {number} cx @param {number} cz */
  static chunkKey(cx, cz) {
    return cz * 1024 + cx;
  }

  /** @param {number} x @param {number} z */
  chunkOf(x, z) {
    return Level.chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
  }

  /** Recompute derived data (cell heights, prop/light indexes). Call after generation. */
  finalize() {
    const W = this.w + 1;
    if (this.smooth) {
      for (let j = 0; j < this.h; j++) {
        for (let i = 0; i < this.w; i++) {
          const v = this.vh;
          this.floorH[this.idx(i, j)] = (v[j * W + i] + v[j * W + i + 1] + v[(j + 1) * W + i] + v[(j + 1) * W + i + 1]) / 4;
        }
      }
    }
    this.solidGrid.clear();
    this.propChunks.clear();
    this.lightChunks.clear();
    for (const p of this.props) this._indexProp(p);
    for (const l of this.lights) {
      const k = this.chunkOf(l.x, l.z);
      const list = this.lightChunks.get(k);
      if (list) list.push(l);
      else this.lightChunks.set(k, [l]);
    }
  }

  /** @param {Prop} p */
  _indexProp(p) {
    const ck = this.chunkOf(p.x, p.z);
    const list = this.propChunks.get(ck);
    if (list) list.push(p);
    else this.propChunks.set(ck, [p]);
    if (!p.solid) return;
    const k = this.idx(Math.floor(p.x), Math.floor(p.z));
    const cell = this.solidGrid.get(k);
    if (cell) cell.push(p);
    else this.solidGrid.set(k, [p]);
  }

  /**
   * @param {string} kind @param {string} sprite @param {number} x @param {number} z
   * @param {{size?:number, lift?:number, solid?:number, data?:Object<string, any>}} [o]
   * @returns {Prop}
   */
  addProp(kind, sprite, x, z, o = {}) {
    let key = `${this.id}:${kind}:${Math.round(x * 4)}:${Math.round(z * 4)}`;
    while (this.props.some((p) => p.key === key)) key += '+';
    /** @type {Prop} */
    const p = { key, kind, sprite, x, z, size: o.size ?? 1, lift: o.lift ?? 0, solid: o.solid ?? 0, gone: false, data: o.data ?? {} };
    this.props.push(p);
    return p;
  }

  /**
   * Turn a cell into a door.
   * @param {number} i @param {number} j @param {Partial<Door>} o
   * @returns {Door}
   */
  addDoor(i, j, o) {
    const k = this.idx(i, j);
    this.wall[k] = 0;
    const axis = this.wall[this.idx(i - 1, j)] && this.wall[this.idx(i + 1, j)] ? 'x' : 'z';
    const base = this.smooth ? this.floorH[k] : this.floorH[k];
    /** @type {Door} */
    const d = {
      key: `${this.id}:door:${i}:${j}`, i, j, axis, open: 0, hold: 0, shut: true, locked: false, keyId: null,
      lockLevel: 0, magic: false, puzzle: false, tex: TILE.WOOD_DOOR, height: 2.4, top: base + 3, base, name: 'Door', portal: null, ...o,
    };
    this.doorAt[k] = this.doors.length;
    this.doors.push(d);
    return d;
  }

  /** Floor height under a world point. @param {number} x @param {number} z */
  heightAt(x, z) {
    if (!this.smooth) {
      const i = Math.floor(x);
      const j = Math.floor(z);
      return this.inBounds(i, j) ? this.floorH[this.idx(i, j)] : 0;
    }
    const i = clamp(Math.floor(x), 0, this.w - 1);
    const j = clamp(Math.floor(z), 0, this.h - 1);
    const fx = clamp(x - i, 0, 1);
    const fz = clamp(z - j, 0, 1);
    const W = this.w + 1;
    const h00 = this.vh[j * W + i];
    const h10 = this.vh[j * W + i + 1];
    const h01 = this.vh[(j + 1) * W + i];
    const h11 = this.vh[(j + 1) * W + i + 1];
    // Same diagonal split as the renderer: (0,0)-(1,1).
    if (fx >= fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  /** True when the cell has a roof or the whole level is underground. @param {number} x @param {number} z */
  covered(x, z) {
    if (!this.outdoor) return true;
    const i = Math.floor(x);
    const j = Math.floor(z);
    return this.inBounds(i, j) && this.ceil[this.idx(i, j)] > 0;
  }

  /** @param {number} x @param {number} z */
  hazardAt(x, z) {
    const i = Math.floor(x);
    const j = Math.floor(z);
    return this.inBounds(i, j) ? this.hazard[this.idx(i, j)] : HAZARD.NONE;
  }

  /**
   * Whether a cell blocks an actor whose feet are at footY.
   * @param {number} i @param {number} j @param {number} footY
   * @param {boolean} flying levitating actors cross chasms and ignore step height
   * @param {boolean} cautious AI actors also refuse hazard cells
   */
  blocked(i, j, footY, flying, cautious) {
    if (!this.inBounds(i, j)) return true;
    const k = this.idx(i, j);
    if (this.wall[k]) return true;
    const d = this.doorAt[k];
    if (d >= 0 && this.doors[d].open < 0.6) return true;
    const hz = this.hazard[k];
    if (hz === HAZARD.CHASM && !flying) return true;
    if (cautious && hz !== HAZARD.NONE) return true;
    return !flying && this.floorH[k] - footY > STEP;
  }

  /**
   * Push a circle out of blocking cells and solid props.
   * @param {{x:number, z:number}} p @param {number} r @param {number} footY @param {boolean} flying @param {boolean} cautious
   */
  collide(p, r, footY, flying, cautious) {
    for (let it = 0; it < 2; it++) {
      for (let j = Math.floor(p.z - r); j <= Math.floor(p.z + r); j++) {
        for (let i = Math.floor(p.x - r); i <= Math.floor(p.x + r); i++) {
          if (this.blocked(i, j, footY, flying, cautious)) {
            const nx = clamp(p.x, i, i + 1);
            const nz = clamp(p.z, j, j + 1);
            const dx = p.x - nx;
            const dz = p.z - nz;
            const d2 = dx * dx + dz * dz;
            if (d2 < r * r) {
              if (d2 > 1e-9) {
                const d = Math.sqrt(d2);
                p.x += (dx / d) * (r - d);
                p.z += (dz / d) * (r - d);
              } else {
                const m = Math.min(p.x - i, i + 1 - p.x, p.z - j, j + 1 - p.z);
                if (m === p.x - i) p.x = i - r;
                else if (m === i + 1 - p.x) p.x = i + 1 + r;
                else if (m === p.z - j) p.z = j - r;
                else p.z = j + 1 + r;
              }
            }
          }
          const solids = this.solidGrid.get(this.idx(i, j));
          if (!solids) continue;
          for (const s of solids) {
            if (s.gone) continue;
            const dx = p.x - s.x;
            const dz = p.z - s.z;
            const d = Math.hypot(dx, dz);
            const min = r + s.solid;
            if (d < min && d > 1e-6) {
              p.x += (dx / d) * (min - d);
              p.z += (dz / d) * (min - d);
            }
          }
        }
      }
    }
  }

  /**
   * Move with wall sliding, in sub-steps no longer than the radius.
   * @param {{x:number, z:number}} p @param {number} dx @param {number} dz @param {number} r
   * @param {number} footY @param {boolean} [flying] @param {boolean} [cautious]
   */
  move(p, dx, dz, r, footY, flying = false, cautious = false) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / (r * 0.8)));
    for (let s = 0; s < n; s++) {
      p.x += dx / n;
      p.z += dz / n;
      this.collide(p, r, footY, flying, cautious);
    }
  }

  /** Line of sight through walls and closed doors. @param {number} ax @param {number} az @param {number} bx @param {number} bz */
  los(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.25);
    for (let s = 1; s < steps; s++) {
      const i = Math.floor(ax + (dx * s) / steps);
      const j = Math.floor(az + (dz * s) / steps);
      if (!this.inBounds(i, j)) return false;
      const k = this.idx(i, j);
      if (this.wall[k]) return false;
      const d = this.doorAt[k];
      if (d >= 0 && this.doors[d].open < 0.6) return false;
    }
    return true;
  }

  /** True if the cell stops projectiles (wall, closed door, or terrain above the given height). @param {number} x @param {number} z @param {number} y */
  solidAt(x, z, y) {
    const i = Math.floor(x);
    const j = Math.floor(z);
    if (!this.inBounds(i, j)) return true;
    const k = this.idx(i, j);
    if (this.wall[k]) return y < this.wallTop[k] || !this.outdoor;
    const d = this.doorAt[k];
    if (d >= 0 && this.doors[d].open < 0.6) return true;
    return this.heightAt(x, z) > y;
  }

  /** Mark cells around a point as explored (automap fog-of-war). @param {number} x @param {number} z @param {number} r */
  reveal(x, z, r) {
    for (let j = Math.floor(z - r); j <= Math.floor(z + r); j++) {
      for (let i = Math.floor(x - r); i <= Math.floor(x + r); i++) {
        if (this.inBounds(i, j) && (i + 0.5 - x) ** 2 + (j + 0.5 - z) ** 2 <= r * r) this.explored[this.idx(i, j)] = 1;
      }
    }
  }
}

/** Tracks which chunks around the player are live; the renderer and game stream on its events. */
export class ChunkStreamer {
  /** @param {Level} level @param {number} radius in chunks */
  constructor(level, radius) {
    this.level = level;
    this.radius = radius;
    /** @type {Set<number>} */
    this.active = new Set();
  }

  /** @param {number} x @param {number} z @returns {{load:number[], unload:number[]}} */
  update(x, z) {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const maxX = Math.ceil(this.level.w / CHUNK);
    const maxZ = Math.ceil(this.level.h / CHUNK);
    /** @type {Set<number>} */
    const want = new Set();
    /** @type {number[][]} */
    const order = [];
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        if (dx * dx + dz * dz > (this.radius + 0.5) ** 2) continue;
        const a = cx + dx;
        const b = cz + dz;
        if (a < 0 || b < 0 || a >= maxX || b >= maxZ) continue;
        const k = Level.chunkKey(a, b);
        want.add(k);
        if (!this.active.has(k)) order.push([dx * dx + dz * dz, k]);
      }
    }
    const unload = [...this.active].filter((k) => !want.has(k));
    this.active = want;
    return { load: order.sort((p, q) => p[0] - q[0]).map((p) => p[1]), unload };
  }
}

// ---------------------------------------------------------------------------
// Shared carving helpers
// ---------------------------------------------------------------------------

/**
 * Open a rectangle of floor cells (inclusive bounds).
 * @param {Level} L @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {{floor?:number, tex:number, ceil:number, ceilTex:number, zone?:number}} o
 */
function carve(L, x0, z0, x1, z1, o) {
  for (let j = z0; j <= z1; j++) {
    for (let i = x0; i <= x1; i++) {
      const k = L.idx(i, j);
      L.wall[k] = 0;
      L.floorH[k] = o.floor ?? 0;
      L.floorTex[k] = o.tex;
      L.ceil[k] = o.ceil;
      L.ceilTex[k] = o.ceilTex;
      if (o.zone !== undefined) L.zone[k] = o.zone;
    }
  }
}

/** Fill every cell with wall. @param {Level} L @param {number} tex @param {number} top */
function fillWalls(L, tex, top) {
  L.wall.fill(tex + 1);
  L.wallTop.fill(top);
}

/**
 * Re-texture the walls that border open cells, with a sprinkling of variants.
 * @param {Level} L @param {() => number} rnd @param {number} base @param {[number, number][]} variants [tile, probability]
 */
function styleWalls(L, rnd, base, variants) {
  for (let j = 0; j < L.h; j++) {
    for (let i = 0; i < L.w; i++) {
      const k = L.idx(i, j);
      if (!L.wall[k]) continue;
      let tex = base;
      let r = rnd();
      for (const [t, p] of variants) {
        if (r < p) { tex = t; break; }
        r -= p;
      }
      L.wall[k] = tex + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// The Sunken Observatory (starting sanctuary)
// ---------------------------------------------------------------------------

/** Where the observatory's Gate Hall puts you when you come back down. */
export const OBSERVATORY_RETURN = Object.freeze({ x: 26.5, z: 18.5, yaw: -Math.PI / 2 });

/**
 * Four rooms: Awakening Chamber (Resonance Brazier, starter chest, the Archivist), the
 * Atrium (training automaton), Ley-Conduit Room (levers, locked chest) and Gate Hall.
 * Three levers drive three anchors; lighting all three unseals the Great Astrolabe Gate.
 * @param {number} seed @returns {Level}
 */
export function buildObservatory(seed) {
  const L = new Level('observatory', 'The Sunken Observatory', 34, 23, false);
  const rnd = mulberry32(seed ^ 0x0b5e);
  fillWalls(L, TILE.BRASS, 4);
  const room = { tex: TILE.OBS_FLOOR, ceil: 4, ceilTex: TILE.STAR_CEIL };
  carve(L, 1, 1, 8, 8, { ...room, zone: 0 });
  carve(L, 10, 1, 19, 8, { ...room, zone: 1 });
  carve(L, 21, 1, 32, 8, { ...room, zone: 2 });
  carve(L, 21, 10, 32, 20, { ...room, zone: 3 });
  // Ley inlay lines down the middle of each room, and a raised dais in the Gate Hall.
  for (const [x0, z0, x1, z1] of [[1, 1, 8, 8], [10, 1, 19, 8], [21, 1, 32, 8], [21, 10, 32, 20]]) {
    const cx = Math.floor((x0 + x1) / 2);
    const cz = Math.floor((z0 + z1) / 2);
    for (let i = x0; i <= x1; i++) L.floorTex[L.idx(i, cz)] = TILE.LEY_FLOOR;
    for (let j = z0; j <= z1; j++) L.floorTex[L.idx(cx, j)] = TILE.LEY_FLOOR;
  }
  for (let j = 13; j <= 17; j++) for (let i = 25; i <= 29; i++) L.floorH[L.idx(i, j)] = 0.45;
  styleWalls(L, rnd, TILE.BRASS, [[TILE.CONDUIT, 0.14], [TILE.GEAR, 0.1]]);
  L.stepTex = TILE.BRASS;

  const door = { tex: TILE.ASTRO_DOOR, height: 2.8, top: 4, name: 'Astrolabe Door' };
  L.addDoor(9, 4, { ...door });
  L.addDoor(20, 4, { ...door });
  L.addDoor(26, 9, { ...door });
  for (const [i, j] of [[9, 4], [20, 4], [26, 9], [26, 21]]) {
    const k = L.idx(i, j);
    L.floorTex[k] = TILE.OBS_FLOOR;
    L.ceil[k] = 4;
    L.ceilTex[k] = TILE.STAR_CEIL;
  }
  L.addDoor(26, 21, {
    tex: TILE.GATE, height: 3.2, top: 4, name: 'Great Astrolabe Gate', locked: true, puzzle: true,
    portal: { level: 'overworld', x: SITES.gate.x + 0.5, z: SITES.gate.z + 3.5, yaw: Math.PI / 2 },
  });

  // Awakening Chamber: the glowing Resonance Brazier, the starter chest and the Archivist.
  L.addProp('bed', 'bed', 2.6, 2.6, { size: 1.6, data: {} });
  // Far enough from the waking spot (3.6, 4.5) that reaching it means walking there.
  L.addProp('brazier', 'brazier', 6.6, 7.1, { size: 1.5, solid: 0.45, data: {} });
  L.lights.push({ x: 6.6, y: 1.4, z: 7.1, r: 0.5, g: 1.2, b: 1.5, flicker: 0.2 });
  L.addProp('chest', 'chest', 7.5, 1.7, { size: 1, solid: 0.35, data: { starter: true, loot: [['fork', 1], ['lantern', 1], ['rune_lux', 1], ['draught', 2], ['lockpick', 3], ['bread', 2]] } });
  L.addProp('book', 'tablet', 4.5, 7.6, { size: 1.4, data: { book: 'keeper_log' } });
  const archivist = { x: 2.3, z: 7.2 };
  L.npcDefs.push({
    id: 'archivist', name: 'The Archivist', role: 'archivist', town: 'observatory', sprite: 'archivist', voice: 0.6,
    faction: null, shop: null, hours: [0, 24, 24], spots: { home: archivist, work: archivist, tavern: archivist },
  });
  // The Atrium (Hall of Instruments): a training automaton to practise on.
  L.addProp('book', 'tablet', 11.5, 1.7, { size: 1.4, data: { book: 'on_resonance' } });
  L.addProp('decor', 'barrel', 10.7, 7.4, { size: 1, solid: 0.35 });
  L.addProp('decor', 'barrel', 11.6, 7.6, { size: 1, solid: 0.35 });
  L.spawns.push({ key: 'obs:training', kind: 'mite', x: 16.5, z: 5.5, tier: 0, training: true });
  // Ley-Conduit Room: levers and a locked chest.
  for (let n = 0; n < 3; n++) L.addProp('lever', 'lever_up', 24.5 + n * 2, 1.6, { size: 1.2, data: { index: n } });
  L.addProp('chest', 'chest', 22.5, 7.5, { size: 1, solid: 0.35, data: { lockLevel: 1, loot: [['shards', 25], ['tonic', 1], ['fen_lotus', 1], ['ember_moss', 1]] } });
  L.spawns.push({ key: 'obs:mite:0', kind: 'mite', x: 26.5, z: 5.5, tier: 0 });
  L.spawns.push({ key: 'obs:mite:1', kind: 'mite', x: 29.5, z: 4.5, tier: 0 });
  // Gate Hall: anchors, the Great Astrolabe on the dais, and a hint tablet.
  for (const [n, x, z] of [[0, 23.5, 12], [1, 27, 11.5], [2, 30.5, 12]]) L.addProp('anchor', 'anchor', x, z, { size: 1.8, solid: 0.4, data: { index: n } });
  L.addProp('gatecore', 'gate_core', 27, 15.5, { size: 2.4, solid: 0.6, data: {} });
  L.addProp('book', 'tablet', 22.5, 19.5, { size: 1.4, data: { book: 'anchor_hint' } });

  for (const [x, z, r, g, b] of [[4.5, 4.5, 0.9, 0.55, 0.25], [15, 4.5, 0.8, 0.5, 0.25], [26.5, 4.5, 0.25, 0.7, 1.0], [27, 15.5, 0.3, 0.8, 1.2], [23, 19, 0.7, 0.45, 0.2]]) {
    L.lights.push({ x, y: 3.2, z, r, g, b });
  }
  L.fog = [0.03, 0.03, 0.07];
  L.fogDensity = 0.07;
  L.ambient = [0.07, 0.07, 0.12];
  L.spawn = { x: 3.6, z: 4.5, yaw: 0 };
  L.finalize();
  return L;
}

// ---------------------------------------------------------------------------
// Overworld
// ---------------------------------------------------------------------------

const BIOME_CENTERS = [[58, 182], [205, 165], [100, 62]];
const LANDMARKS = [
  { id: 'pylon_fen', name: 'Fen Ley Pylon', x: 34, z: 150, sprite: 'pylon' },
  { id: 'pylon_wood', name: 'Ley-Wood Pylon', x: 58, z: 30, sprite: 'pylon' },
  { id: 'pylon_bad', name: 'Badlands Ley Pylon', x: 165, z: 226, sprite: 'pylon' },
  { id: 'stones', name: 'The Listening Stones', x: 120, z: 206, sprite: 'stones' },
  { id: 'colossus', name: 'Fallen Brass Colossus', x: 158, z: 100, sprite: 'stones' },
];

/** Site radius used for terrain flattening and keeping scatter away. */
const SITE_R = { gate: 8, oakhaven: 21, cinderwick: 21, drowned: 6, ember: 6, verdant: 6, spire: 9.5 };

/**
 * Raw terrain height before sites/roads: three biome height fields blended by distance.
 * @param {number} x @param {number} z @param {number} seed @returns {{h:number, biome:number}}
 */
function terrain(x, z, seed) {
  const wx = x + (noise2(x / 40, z / 40, seed + 7) - 0.5) * 50;
  const wz = z + (noise2(x / 40, z / 40, seed + 9) - 0.5) * 50;
  let sum = 0;
  let h = 0;
  let best = 0;
  let bestD = Infinity;
  BIOME_CENTERS.forEach(([cx, cz], b) => {
    const d = Math.hypot(wx - cx, wz - cz);
    if (d < bestD) { bestD = d; best = b; }
    const wgt = Math.exp(-((d / 75) ** 2));
    let hb;
    if (b === BIOME.FEN) hb = -0.42 + fbm(x / 18, z / 18, seed + 1) * 1.25 - Math.max(0, fbm(x / 9, z / 9, seed + 2) - 0.6) * 5;
    else if (b === BIOME.BADLANDS) {
      const v = fbm(x / 26, z / 26, seed + 3) * 7;
      const f = Math.floor(v);
      hb = 0.6 + f + clamp((v - f - 0.72) / 0.28, 0, 1);
    } else hb = 0.3 + fbm(x / 30, z / 30, seed + 4) * 2.6;
    h += wgt * hb;
    sum += wgt;
  });
  h /= sum || 1;
  const edge = Math.min(x, z, OVERWORLD_SIZE - x, OVERWORLD_SIZE - z);
  if (edge < 14) h += (14 - edge) ** 2 * 0.09;
  return { h, biome: best };
}

/** Deterministic syllable names for townsfolk. @param {() => number} rnd */
function folkName(rnd) {
  const a = ['Ara', 'Bel', 'Cor', 'Dun', 'Eli', 'Fen', 'Gar', 'Hal', 'Iso', 'Jory', 'Kes', 'Lio', 'Mab', 'Nev', 'Orr', 'Pim', 'Ros', 'Sel', 'Tam', 'Ula'];
  const b = ['wick', 'ra', 'den', 'mar', 'son', 'ette', 'is', 'o', 'wyn', 'ley'];
  const c = ['Cogsworth', 'Ashby', 'Fenwright', 'Holloway', 'Pennick', 'Quill', 'Rookwood', 'Tallow', 'Vane', 'Wexley'];
  return `${a[Math.floor(rnd() * a.length)]}${b[Math.floor(rnd() * b.length)]} ${c[Math.floor(rnd() * c.length)]}`;
}

/**
 * Stamp a timber building with a door facing the plaza.
 * @param {Level} L @param {number} x0 @param {number} z0 @param {number} w @param {number} d
 * @param {'N'|'S'|'E'|'W'} side wall that holds the door @param {number} f floor height
 * @param {number} zone town index @param {Partial<Door>} doorOpts
 * @returns {{x0:number, z0:number, x1:number, z1:number, door:Door}}
 */
function building(L, x0, z0, w, d, side, f, zone, doorOpts) {
  const x1 = x0 + w - 1;
  const z1 = z0 + d - 1;
  for (let j = z0; j <= z1; j++) {
    for (let i = x0; i <= x1; i++) {
      const k = L.idx(i, j);
      const edge = i === x0 || i === x1 || j === z0 || j === z1;
      L.wall[k] = edge ? TILE.TIMBER + 1 : 0;
      L.wallTop[k] = f + 3.3;
      L.floorTex[k] = TILE.PLANK;
      L.ceil[k] = f + 3;
      L.ceilTex[k] = TILE.PLASTER;
      L.zone[k] = zone;
    }
  }
  L.roofs.push({ x0, z0, x1: x1 + 1, z1: z1 + 1, base: f + 3.3 });
  const di = side === 'N' || side === 'S' ? x0 + Math.floor(w / 2) : side === 'E' ? x1 : x0;
  const dj = side === 'E' || side === 'W' ? z0 + Math.floor(d / 2) : side === 'S' ? z1 : z0;
  const door = L.addDoor(di, dj, { tex: TILE.WOOD_DOOR, height: 2.3, top: f + 3.3, base: f, ...doorOpts });
  return { x0: x0 + 1, z0: z0 + 1, x1: x1 - 1, z1: z1 - 1, door };
}

/**
 * Lay out a town: cobbled plaza with stalls and well, eight timber buildings, lamps, NPCs.
 * @param {Level} L @param {'oakhaven'|'cinderwick'} id @param {number} zone @param {number} f floor height @param {() => number} rnd
 */
function stampTown(L, id, zone, f, rnd) {
  const site = SITES[id];
  const cx = site.x;
  const cz = site.z;
  for (let j = cz - 20; j <= cz + 20; j++) {
    for (let i = cx - 20; i <= cx + 20; i++) {
      const k = L.idx(i, j);
      const inPlaza = Math.abs(i - cx + 0.5) <= 10 && Math.abs(j - cz + 0.5) <= 10;
      const lane = Math.abs(i - cx) <= 1 || Math.abs(j - cz) <= 1;
      if (inPlaza || lane) L.floorTex[k] = TILE.COBBLE;
      L.zone[k] = zone;
    }
  }
  const T = (/** @type {number} */ x, /** @type {number} */ z) => ({ x: cx + x, z: cz + z });
  /** @type {[number, number, number, number, 'N'|'S'|'E'|'W'][]} */
  const slots = [
    [-9, -18, 8, 7, 'S'], [2, -18, 8, 7, 'S'], [11, -9, 7, 8, 'W'], [11, 2, 7, 8, 'W'],
    [-18, -9, 7, 8, 'E'], [-18, 2, 7, 8, 'E'], [-9, 11, 8, 7, 'N'], [2, 11, 8, 7, 'N'],
  ];
  const kinds = ['tavern', 'guild', 'shop', 'shop2', 'house', 'house', 'house', 'house'];
  const names = id === 'cinderwick'
    ? { tavern: 'The Molten Mug', guild: "Artificers' Guildhall", shop: "Gearwright's Sundries", shop2: 'Flint Forge' }
    : { tavern: 'The Rooted Lantern', guild: "Wardens' Lodge", shop: "Rowan's Apothecary", shop2: 'Quill & Quiver' };
  /** @type {Record<string, {x0:number, z0:number, x1:number, z1:number, door:Door}[]>} */
  const b = { tavern: [], guild: [], shop: [], shop2: [], house: [] };
  slots.forEach(([x, z, w, d, side], n) => {
    const kind = kinds[n];
    const name = /** @type {Record<string, string>} */ (names)[kind] || 'House';
    const locked = kind === 'house';
    b[kind].push(building(L, cx + x, cz + z, w, d, side, f, zone, { name, locked, lockLevel: locked ? 2 : 0 }));
  });
  const tav = b.tavern[0];
  const guild = b.guild[0];
  const shop = b.shop[0];
  const shop2 = b.shop2[0];
  const houses = b.house;
  /** @param {{x0:number, z0:number, x1:number, z1:number}} r @param {number} fx @param {number} fz */
  const at = (r, fx, fz) => ({ x: r.x0 + 0.5 + (r.x1 - r.x0) * fx, z: r.z0 + 0.5 + (r.z1 - r.z0) * fz });
  // Furniture and interior lights.
  for (const [r, kind] of [[tav, 'tavern'], [guild, 'guild'], [shop, 'shop'], [shop2, 'shop2'], ...houses.map((h) => [h, 'house'])]) {
    const room = /** @type {{x0:number, z0:number, x1:number, z1:number}} */ (r);
    const c = at(room, 0.5, 0.5);
    L.lights.push({ x: c.x, y: f + 2.4, z: c.z, r: 1.0, g: 0.62, b: 0.3, flicker: 0.15 });
    if (kind === 'tavern') {
      for (const fx of [0.15, 0.85]) L.addProp('bed', 'bed', at(room, fx, 0).x, at(room, fx, 0).z, { size: 1.6, data: { rent: id } });
      for (const fx of [0.25, 0.75]) L.addProp('decor', 'table', at(room, fx, 0.7).x, at(room, fx, 0.7).z, { size: 1.2, solid: 0.45 });
      L.addProp('decor', 'barrel', at(room, 1, 1).x, at(room, 1, 1).z, { size: 1, solid: 0.35 });
    } else if (kind === 'guild') {
      L.addProp('decor', 'table', c.x, c.z - 0.6, { size: 1.2, solid: 0.45 });
      L.addProp('book', 'tablet', at(room, 0, 0).x, at(room, 0, 0).z, { size: 1.3, data: { book: id === 'cinderwick' ? 'artificer_charter' : 'warden_oath' } });
    } else if (kind === 'house') {
      L.addProp('bed', 'bed', at(room, 0.2, 0.2).x, at(room, 0.2, 0.2).z, { size: 1.6, data: { owned: true } });
      L.addProp('chest', 'chest', at(room, 0.9, 0.9).x, at(room, 0.9, 0.9).z, { size: 1, solid: 0.35, data: { lockLevel: 2, loot: [['shards', 6 + Math.floor(rnd() * 14)], [rnd() < 0.5 ? 'bread' : 'apple', 1], [rnd() < 0.4 ? 'scrap' : 'salt', 1]] } });
    } else {
      L.addProp('decor', 'table', c.x, c.z, { size: 1.2, solid: 0.45 });
      L.addProp('decor', 'barrel', at(room, 0, 1).x, at(room, 0, 1).z, { size: 1, solid: 0.35 });
    }
  }
  // Plaza: well, stalls, lamps, notice board.
  L.addProp('decor', 'well', cx + 0.5, cz + 0.5, { size: 2.2, solid: 0.9 });
  L.addProp('decor', 'stall', cx - 5.5, cz + 0.5, { size: 2.6, solid: 0.8 });
  L.addProp('decor', 'stall', cx + 6.5, cz + 0.5, { size: 2.6, solid: 0.8 });
  L.addProp('notice', 'notice', cx + 3.5, cz - 9.5, { size: 2, solid: 0.3, data: { guild: id === 'cinderwick' ? 'artificers' : 'wardens' } });
  for (const [x, z] of [[-9, -9], [9, -9], [-9, 9], [9, 9], [-2.5, -6], [3.5, 7]]) {
    L.addProp('decor', 'lamp_post', cx + x + 0.5, cz + z + 0.5, { size: 3, solid: 0.15 });
    L.lights.push({ x: cx + x + 0.5, y: f + 2.7, z: cz + z + 0.5, r: 1.1, g: 0.75, b: 0.35, flicker: 0.08 });
  }
  // People.
  const tavernSeats = [at(tav, 0.25, 0.45), at(tav, 0.75, 0.45), at(tav, 0.5, 0.9), at(tav, 0.15, 0.9), at(tav, 0.85, 0.9)];
  let seat = 0;
  const nextSeat = () => tavernSeats[seat++ % tavernSeats.length];
  const H = (/** @type {number} */ n) => at(houses[n % houses.length], 0.3, 0.3);
  /** @param {Partial<NpcDef> & {id:string, name:string, role:string, sprite:string}} o */
  const npc = (o) => L.npcDefs.push({
    town: id, voice: 1, faction: null, shop: null, hours: [8, 18, 22],
    spots: { home: H(L.npcDefs.length), work: T(0, 0), tavern: nextSeat() }, ...o,
  });
  if (id === 'cinderwick') {
    npc({ id: 'vance', name: 'Master Vance', role: 'guildmaster', sprite: 'master', voice: 0.8, faction: 'artificers', spots: { home: H(0), work: at(guild, 0.5, 0.35), tavern: nextSeat() }, hours: [7, 20, 23] });
    npc({ id: 'tobin', name: 'Tobin Gearwright', role: 'merchant', sprite: 'merchant', voice: 1.1, shop: 'sundries', spots: { home: H(1), work: at(shop, 0.5, 0.3), tavern: nextSeat() } });
    npc({ id: 'brann', name: 'Brann Flint', role: 'merchant', sprite: 'merchant', voice: 0.75, shop: 'forge', spots: { home: H(2), work: T(-5.5, 2), tavern: nextSeat() } });
    npc({ id: 'mirela', name: 'Mirela Ash', role: 'innkeeper', sprite: 'keeper', voice: 1.3, shop: 'tavern_c', spots: { home: at(tav, 0.15, 0.1), work: at(tav, 0.5, 0.15), tavern: at(tav, 0.5, 0.15) }, hours: [9, 24, 24] });
    npc({ id: 'odda', name: 'Odda Fenwright', role: 'folk', sprite: 'folk_a', voice: 1.2, spots: { home: H(3), work: T(2.5, 2.5), tavern: nextSeat() } });
  } else {
    npc({ id: 'ilsa', name: 'Warden-Captain Ilsa Marr', role: 'guildmaster', sprite: 'captain', voice: 1.15, faction: 'wardens', spots: { home: H(0), work: at(guild, 0.5, 0.35), tavern: nextSeat() }, hours: [6, 19, 23] });
    npc({ id: 'pell', name: 'Pell Rowan', role: 'merchant', sprite: 'merchant', voice: 1.0, shop: 'apothecary', spots: { home: H(1), work: at(shop, 0.5, 0.3), tavern: nextSeat() } });
    npc({ id: 'quill', name: 'Quill Ashby', role: 'merchant', sprite: 'merchant', voice: 1.25, shop: 'quiver', spots: { home: H(2), work: T(-5.5, 2), tavern: nextSeat() } });
    npc({ id: 'dorrin', name: 'Dorrin Vale', role: 'innkeeper', sprite: 'keeper', voice: 0.85, shop: 'tavern_o', spots: { home: at(tav, 0.15, 0.1), work: at(tav, 0.5, 0.15), tavern: at(tav, 0.5, 0.15) }, hours: [9, 24, 24] });
    npc({ id: 'fenna', name: 'Fenna Rook', role: 'folk', sprite: 'folk_b', voice: 1.3, spots: { home: H(3), work: T(-3, -4), tavern: nextSeat() } });
  }
  for (let g = 0; g < 2; g++) {
    const day = g === 0;
    npc({
      id: `${id}_guard${g}`, name: `${id === 'cinderwick' ? 'Cinderwick' : 'Oakhaven'} Guard`, role: 'guard', sprite: 'guard', voice: 0.7,
      hours: day ? [6, 20, 22] : [20, 30, 32],
      spots: { home: H(g + 2), work: T(-8, -8), tavern: nextSeat(), patrol: [T(-8, -8), T(8, -8), T(8, 8), T(-8, 8)] },
    });
  }
  const folkSprites = ['folk_a', 'folk_b', 'folk_c'];
  for (let n = 0; n < 3; n++) {
    npc({
      id: `${id}_folk${n}`, name: folkName(rnd), role: 'folk', sprite: folkSprites[(n + (id === 'cinderwick' ? 1 : 0)) % 3], voice: 0.85 + rnd() * 0.5,
      spots: { home: H(n), work: T(-6 + rnd() * 12, -6 + rnd() * 12), tavern: nextSeat() }, hours: [7 + Math.floor(rnd() * 2), 17 + Math.floor(rnd() * 2), 22],
    });
  }
}

/**
 * The overworld: three blended biomes, flattened sites, graded cobbled roads, a chasm ring
 * around the Hollow Spire, water, towns, shrines, landmarks, flora, herbs, camps and spawns.
 * @param {number} seed @returns {Level}
 */
export function buildOverworld(seed) {
  const N = OVERWORLD_SIZE;
  const L = new Level('overworld', 'The Shardlands', N, N, true);
  const rnd = mulberry32(seed ^ 0x5eed);
  const W = N + 1;
  const biomeGrid = new Uint8Array(N * N);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) L.vh[j * W + i] = terrain(i, j, seed).h;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) biomeGrid[j * N + i] = terrain(i + 0.5, j + 0.5, seed).biome;
  L.biomeAt = (x, z) => biomeGrid[clamp(Math.floor(z), 0, N - 1) * N + clamp(Math.floor(x), 0, N - 1)];

  /** @param {number} x @param {number} z */
  const vAt = (x, z) => L.vh[clamp(Math.round(z), 0, N) * W + clamp(Math.round(x), 0, N)];
  /** Flatten vertices around a point toward a target height. @param {number} x @param {number} z @param {number} r @param {number} target */
  const flatten = (x, z, r, target) => {
    for (let j = Math.floor(z - r - 4); j <= Math.ceil(z + r + 4); j++) {
      for (let i = Math.floor(x - r - 4); i <= Math.ceil(x + r + 4); i++) {
        if (i < 0 || j < 0 || i > N || j > N) continue;
        const t = 1 - sstep(r, r + 4, Math.hypot(i - x, j - z));
        L.vh[j * W + i] += (target - L.vh[j * W + i]) * t;
      }
    }
  };
  /** @type {Record<string, number>} */
  const siteH = {};
  for (const [id, s] of Object.entries(SITES)) {
    const raw = vAt(s.x, s.z);
    siteH[id] = id === 'spire' ? Math.max(4.5, raw) : Math.max(0.35, raw);
    flatten(s.x, s.z, /** @type {Record<string, number>} */ (SITE_R)[id], siteH[id]);
  }
  for (const m of LANDMARKS) flatten(m.x, m.z, 2.5, Math.max(0.3, vAt(m.x, m.z)));

  // Roads: graded polylines between sites; towns are entered through their cross lanes.
  const spireEdge = { x: SITES.spire.x - 17, z: SITES.spire.z + 10 };
  /** @type {[{x:number, z:number}, {x:number, z:number}][]} */
  const roads = [
    [SITES.gate, SITES.oakhaven], [SITES.gate, SITES.cinderwick], [SITES.oakhaven, SITES.verdant],
    [SITES.gate, SITES.drowned], [SITES.cinderwick, SITES.ember], [SITES.cinderwick, spireEdge], [SITES.oakhaven, SITES.drowned],
  ];
  const roadW = new Float32Array(W * W);
  const roadT = new Float32Array(W * W);
  const roadCell = new Uint8Array(N * N);
  /** @type {{x:number, z:number}[]} */
  const campSpots = [];
  /** Entry point on a town's cross lanes facing another point. @param {{x:number, z:number}} town @param {{x:number, z:number}} other */
  const townGate = (town, other) => {
    const dx = other.x - town.x;
    const dz = other.z - town.z;
    return Math.abs(dx) > Math.abs(dz) ? { x: town.x + Math.sign(dx) * 23, z: town.z } : { x: town.x, z: town.z + Math.sign(dz) * 23 };
  };
  const isTown = (/** @type {{x:number, z:number}} */ p) => p === SITES.oakhaven || p === SITES.cinderwick;
  roads.forEach(([a, b], n) => {
    /** @type {{x:number, z:number}[]} */
    const pts = [a];
    if (isTown(a)) pts.push(townGate(a, b));
    if (isTown(b)) pts.push(townGate(b, a));
    pts.push(b);
    const ha = vAt(a.x, a.z);
    const hb = vAt(b.x, b.z);
    let total = 0;
    for (let s = 1; s < pts.length; s++) total += Math.hypot(pts[s].x - pts[s - 1].x, pts[s].z - pts[s - 1].z);
    let run = 0;
    for (let s = 1; s < pts.length; s++) {
      const p = pts[s - 1];
      const q = pts[s];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const nx = -(q.z - p.z) / len;
      const nz = (q.x - p.x) / len;
      for (let t = 0; t <= len; t += 0.5) {
        const f = t / len;
        const wob = Math.sin(f * Math.PI * 2 + n) * Math.min(5, len * 0.06) * Math.sin(f * Math.PI);
        const x = p.x + (q.x - p.x) * f + nx * wob;
        const z = p.z + (q.z - p.z) * f + nz * wob;
        const target = Math.max(0.15, ha + (hb - ha) * ((run + t) / total));
        for (let j = Math.floor(z - 4); j <= Math.ceil(z + 4); j++) {
          for (let i = Math.floor(x - 4); i <= Math.ceil(x + 4); i++) {
            if (i < 1 || j < 1 || i >= N || j >= N) continue;
            const d = Math.hypot(i - x, j - z);
            const wgt = d < 1.8 ? 1 : 1 - sstep(1.8, 4, d);
            if (wgt > roadW[j * W + i]) { roadW[j * W + i] = wgt; roadT[j * W + i] = target; }
            if (Math.hypot(i + 0.5 - x, j + 0.5 - z) < 1.4) roadCell[j * N + i] = 1;
          }
        }
        if (s === 1 && Math.abs(t - Math.floor(len / 2)) < 0.25 && !isTown(a)) campSpots.push({ x: x + nx * 3, z: z + nz * 3 });
      }
      run += len;
    }
  });
  for (let k = 0; k < W * W; k++) if (roadW[k] > 0) L.vh[k] += (roadT[k] - L.vh[k]) * roadW[k];

  // Chasm ring around the Hollow Spire: only Feather Step crosses it.
  const sp = SITES.spire;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const d = Math.hypot(i - sp.x, j - sp.z);
      if (d >= 9.5 && d <= 12.5) L.vh[j * W + i] = -9;
    }
  }
  // Mountain wall at the world edge.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (i < 2 || j < 2 || i >= N - 2 || j >= N - 2) {
        const k = L.idx(i, j);
        L.wall[k] = TILE.CLIFF + 1;
        L.wallTop[k] = 30;
      }
    }
  }
  L.waterLevel = 0;
  L.finalize();

  // Hazards and ground textures.
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = L.idx(i, j);
      const v = [L.vh[j * W + i], L.vh[j * W + i + 1], L.vh[(j + 1) * W + i], L.vh[(j + 1) * W + i + 1]];
      const lo = Math.min(...v);
      const hi = Math.max(...v);
      if (lo <= -8.9) L.hazard[k] = HAZARD.CHASM;
      else if (L.floorH[k] < -0.55) L.hazard[k] = HAZARD.DEEP;
      const biome = biomeGrid[k];
      /** @type {number} */
      let tex = biome === BIOME.FEN ? TILE.FEN : biome === BIOME.WOOD ? TILE.GRASS : noise2(i / 6, j / 6, seed + 11) > 0.55 ? TILE.DUST : TILE.BASALT;
      if (biome === BIOME.FEN && L.floorH[k] > 0.45) tex = TILE.GRASS;
      if (hi - lo > 0.9 || L.hazard[k] === HAZARD.CHASM) tex = TILE.CLIFF;
      if (roadCell[k]) tex = TILE.COBBLE;
      L.floorTex[k] = tex;
    }
  }

  // Towns.
  stampTown(L, 'oakhaven', 0, siteH.oakhaven, rnd);
  stampTown(L, 'cinderwick', 1, siteH.cinderwick, rnd);

  // The Astrolabe Gate ruin: a broken brass ring around the stairway back down.
  const g = SITES.gate;
  for (let j = g.z - 8; j <= g.z + 8; j++) {
    for (let i = g.x - 8; i <= g.x + 8; i++) {
      const d = Math.hypot(i + 0.5 - g.x - 0.5, j + 0.5 - g.z - 0.5);
      const k = L.idx(i, j);
      if (d < 6.5) L.floorTex[k] = TILE.LEY_FLOOR;
      if (Math.abs(d - 6.5) < 0.55 && Math.abs(i - g.x) > 1 && Math.abs(j - g.z) > 1) {
        L.wall[k] = (hash2(i, j, seed) < 0.3 ? TILE.CONDUIT : TILE.BRASS) + 1;
        L.wallTop[k] = siteH.gate + 1.2 + hash2(j, i, seed) * 2.6;
      }
    }
  }
  L.addProp('stairs', 'stairs', g.x + 0.5, g.z + 0.5, {
    size: 2.6, solid: 0.6, data: { label: 'Descend to the Sunken Observatory', portal: { level: 'observatory', x: OBSERVATORY_RETURN.x, z: OBSERVATORY_RETURN.z, yaw: OBSERVATORY_RETURN.yaw } },
  });
  L.lights.push({ x: g.x + 0.5, y: siteH.gate + 2, z: g.z + 0.5, r: 0.3, g: 0.8, b: 1.2 });

  // Shrine entrances: a small limestone ruin around a stairway.
  for (const id of /** @type {const} */ (['drowned', 'ember', 'verdant', 'spire'])) {
    const s = SITES[id];
    for (let j = s.z - 2; j <= s.z + 2; j++) {
      for (let i = s.x - 2; i <= s.x + 2; i++) {
        const k = L.idx(i, j);
        L.floorTex[k] = TILE.FLAGSTONE;
        const edge = Math.abs(i - s.x) === 2 || Math.abs(j - s.z) === 2;
        if (edge && !(j === s.z + 2 && Math.abs(i - s.x) <= 0)) {
          L.wall[k] = (hash2(i, j, seed + 3) < 0.4 ? TILE.MOSSY : TILE.LIMESTONE) + 1;
          L.wallTop[k] = siteH[id] + 1.6 + hash2(i, j, seed + 5) * 1.6;
        }
      }
    }
    L.addProp('stairs', 'stairs', s.x + 0.5, s.z + 0.5, { size: 2.6, solid: 0.6, data: { label: `Enter ${s.name}`, portal: { level: `dungeon:${id}`, x: null, z: null, yaw: 0 } } });
    L.lights.push({ x: s.x + 0.5, y: siteH[id] + 1.8, z: s.z + 0.5, r: 0.5, g: 0.8, b: 0.9 });
  }

  // Landmarks.
  for (const m of LANDMARKS) {
    L.addProp('landmark', m.sprite, m.x + 0.5, m.z + 0.5, { size: m.sprite === 'pylon' ? 4.5 : 3.2, solid: 0.7, data: { id: m.id, name: m.name } });
    if (m.sprite === 'pylon') L.lights.push({ x: m.x + 0.5, y: vAt(m.x, m.z) + 4, z: m.z + 0.5, r: 0.3, g: 0.9, b: 1.3 });
    L.landmarks.push({ id: m.id, name: m.name, kind: 'landmark', x: m.x + 0.5, z: m.z + 0.5, r: 7 });
  }
  L.addProp('chest', 'chest', LANDMARKS[4].x + 2.5, LANDMARKS[4].z + 0.5, { size: 1, solid: 0.35, data: { lockLevel: 2, loot: [['shards', 40], ['crystal', 2], ['ammo_flare', 8]] } });
  L.addProp('chest', 'chest', LANDMARKS[3].x - 1.5, LANDMARKS[3].z + 1.5, { size: 1, solid: 0.35, data: { lockLevel: 3, loot: [['shards', 60], ['amulet', 1], ['tonic', 2]] } });
  for (const [id, kind] of [['gate', 'gate'], ['oakhaven', 'town'], ['cinderwick', 'town'], ['drowned', 'shrine'], ['ember', 'shrine'], ['verdant', 'shrine'], ['spire', 'shrine']]) {
    const s = /** @type {{name:string, x:number, z:number}} */ (/** @type {Record<string, any>} */ (SITES)[id]);
    L.landmarks.push({ id, name: s.name, kind: /** @type {Landmark['kind']} */ (kind), x: s.x + 0.5, z: s.z + 0.5, r: kind === 'town' ? 24 : 10 });
  }

  // Campfires beside the roads.
  for (const c of campSpots) {
    L.addProp('campfire', 'campfire_a', c.x, c.z, { size: 1.1, solid: 0.4 });
    L.lights.push({ x: c.x, y: vAt(c.x, c.z) + 1, z: c.z, r: 1.4, g: 0.7, b: 0.25, flicker: 0.3 });
  }

  // Flora, herbs, salvage and enemies, kept off roads, water, chasms and sites.
  /** @param {number} i @param {number} j @param {number} pad */
  const free = (i, j, pad) => {
    const k = L.idx(i, j);
    if (L.wall[k] || roadCell[k] || L.hazard[k] || L.zone[k] >= 0 || L.floorTex[k] === TILE.CLIFF) return false;
    for (const [id, s] of Object.entries(SITES)) if (Math.hypot(i - s.x, j - s.z) < /** @type {Record<string, number>} */ (SITE_R)[id] + pad) return false;
    for (const m of LANDMARKS) if (Math.hypot(i - m.x, j - m.z) < 4) return false;
    return true;
  };
  for (let j = 3; j < N - 3; j++) {
    for (let i = 3; i < N - 3; i++) {
      const r = hash2(i, j, seed + 21);
      const biome = biomeGrid[L.idx(i, j)];
      const wet = L.floorH[L.idx(i, j)] < 0.05;
      const dens = biome === BIOME.WOOD ? 0.075 : biome === BIOME.FEN ? (wet ? 0.07 : 0.025) : 0.03;
      if (r > dens || !free(i, j, 2)) continue;
      const x = i + 0.25 + hash2(j, i, seed) * 0.5;
      const z = j + 0.25 + hash2(i + 7, j, seed) * 0.5;
      const pick = hash2(i, j, seed + 33);
      if (biome === BIOME.WOOD) L.addProp('decor', pick < 0.6 ? 'tree_ley' : 'tree_pine', x, z, { size: 5 + pick * 1.5, solid: 0.35 });
      else if (biome === BIOME.FEN) {
        if (wet || pick < 0.6) L.addProp('decor', 'reeds', x, z, { size: 1.3 });
        else L.addProp('decor', 'tree_dead', x, z, { size: 4, solid: 0.3 });
      } else if (pick < 0.75) L.addProp('decor', 'rock', x, z, { size: 1.2 + pick, solid: 0.5 });
      else L.addProp('decor', 'tree_dead', x, z, { size: 3.6, solid: 0.3 });
    }
  }
  for (let n = 0, tries = 0; n < 60 && tries < 6000; tries++) {
    const i = 4 + Math.floor(rnd() * (N - 8));
    const j = 4 + Math.floor(rnd() * (N - 8));
    if (!free(i, j, 3)) continue;
    const cluster = 1 + Math.floor(rnd() * 3);
    for (let c = 0; c < cluster; c++) {
      const x = i + 0.5 + (rnd() - 0.5) * 3;
      const z = j + 0.5 + (rnd() - 0.5) * 3;
      if (free(Math.floor(x), Math.floor(z), 3)) L.addProp('decor', 'ruin', x, z, { size: 2.2 + rnd() * 1.4, solid: 0.45 });
    }
    n++;
  }
  const herbFor = ['fen_lotus', 'ember_moss', 'ley_bloom'];
  const herbSprite = ['herb_lotus', 'herb_moss', 'herb_bloom'];
  for (let n = 0, tries = 0; n < 110 && tries < 8000; tries++) {
    const i = 4 + Math.floor(rnd() * (N - 8));
    const j = 4 + Math.floor(rnd() * (N - 8));
    if (!free(i, j, 1)) continue;
    const biome = biomeGrid[L.idx(i, j)];
    if (biome === BIOME.FEN && L.floorH[L.idx(i, j)] > 0.3) continue;
    L.addProp('herb', herbSprite[biome], i + 0.5, j + 0.5, { size: 0.8, data: { item: herbFor[biome] } });
    n++;
  }
  for (let n = 0, tries = 0; n < 26 && tries < 4000; tries++) {
    const i = 4 + Math.floor(rnd() * (N - 8));
    const j = 4 + Math.floor(rnd() * (N - 8));
    if (!free(i, j, 1)) continue;
    const item = rnd() < 0.55 ? 'scrap' : rnd() < 0.6 ? 'crystal' : 'salt';
    L.addProp('item', item === 'scrap' ? 'i_scrap' : item === 'crystal' ? 'i_crystal' : 'i_salt', i + 0.5, j + 0.5, { size: 0.6, data: { item, qty: 1 } });
    n++;
  }
  for (let n = 0, tries = 0; n < 40 && tries < 6000; tries++) {
    const i = 6 + Math.floor(rnd() * (N - 12));
    const j = 6 + Math.floor(rnd() * (N - 12));
    if (!free(i, j, 12) || Math.hypot(i - SITES.gate.x, j - SITES.gate.z) < 26) continue;
    const biome = biomeGrid[L.idx(i, j)];
    const r = rnd();
    const kind = biome === BIOME.FEN ? (r < 0.6 ? 'wisp' : 'sentinel') : biome === BIOME.BADLANDS ? (r < 0.3 ? 'golem' : r < 0.8 ? 'sentinel' : 'wisp') : (r < 0.7 ? 'sentinel' : 'wisp');
    const tier = Math.min(3, 1 + Math.floor(Math.hypot(i - SITES.gate.x, j - SITES.gate.z) / 60));
    L.spawns.push({ key: `ow:sp:${n}`, kind, x: i + 0.5, z: j + 0.5, tier });
    if (kind !== 'golem' && rnd() < 0.5) L.spawns.push({ key: `ow:sp:${n}b`, kind, x: i + 1.5, z: j + 1, tier });
    n++;
  }

  L.fog = [0.55, 0.62, 0.7];
  L.fogDensity = 0.028;
  L.ambient = [0.35, 0.36, 0.42];
  L.spawn = { x: SITES.gate.x + 0.5, z: SITES.gate.z + 3.5, yaw: Math.PI / 2 };
  L.finalize();
  return L;
}

// ---------------------------------------------------------------------------
// Dungeons
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DungeonDef
 * @property {string} name
 * @property {number} tier
 * @property {number} wall
 * @property {boolean} [pool] a flooded room with deep water
 * @property {boolean} [vents] scalding ley vents
 * @property {string|null} prize item on the boss-room pedestal
 */
/** @type {Record<string, DungeonDef>} */
export const DUNGEONS = {
  drowned: { name: 'The Drowned Shrine', tier: 1, wall: TILE.MOSSY, pool: true, prize: 'core' },
  ember: { name: 'The Ember Vault', tier: 2, wall: TILE.LIMESTONE, vents: true, prize: 'rune_vis' },
  verdant: { name: 'The Verdant Reliquary', tier: 1, wall: TILE.MOSSY, prize: 'rune_vita' },
  spire: { name: 'The Hollow Spire', tier: 3, wall: TILE.LIMESTONE, vents: true, pool: true, prize: 'rune_aperio' },
};

/**
 * Six rooms on a 3x2 slot grid linked by a random spanning tree (+1 loop). A leaf room
 * becomes a rune-sealed vault. Start room has the exit stairs; the far room holds the boss.
 * @param {number} seed @param {string} id key of DUNGEONS @returns {Level}
 */
export function buildDungeon(seed, id) {
  const def = DUNGEONS[id];
  const SW = 15;
  const SH = 15;
  const L = new Level(`dungeon:${id}`, def.name, SW * 3 + 1, SH * 2 + 1, false);
  const rnd = mulberry32(seed ^ (id.charCodeAt(0) * 7919) ^ (id.length * 104729));
  fillWalls(L, def.wall, 3.2);
  const C = { tex: TILE.FLAGSTONE, ceil: 3.2, ceilTex: TILE.CAVE_CEIL };
  /** @type {{x0:number, z0:number, x1:number, z1:number, cx:number, cz:number}[]} */
  const rooms = [];
  for (let s = 0; s < 6; s++) {
    const ox = (s % 3) * SW + 1;
    const oz = Math.floor(s / 3) * SH + 1;
    const w = 7 + Math.floor(rnd() * 5);
    const d = 7 + Math.floor(rnd() * 5);
    const x0 = ox + 1 + Math.floor(rnd() * (SW - 2 - w));
    const z0 = oz + 1 + Math.floor(rnd() * (SH - 2 - d));
    carve(L, x0, z0, x0 + w - 1, z0 + d - 1, { ...C, zone: s });
    rooms.push({ x0, z0, x1: x0 + w - 1, z1: z0 + d - 1, cx: x0 + w / 2, cz: z0 + d / 2 });
  }
  const edges = [[0, 1], [1, 2], [3, 4], [4, 5], [0, 3], [1, 4], [2, 5]];
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const parent = [0, 1, 2, 3, 4, 5];
  /** @param {number} x @returns {number} */
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tree = [];
  const spare = [];
  for (const e of edges) {
    const a = find(e[0]);
    const b = find(e[1]);
    if (a !== b) { parent[a] = b; tree.push(e); } else spare.push(e);
  }
  const degree = [0, 0, 0, 0, 0, 0];
  for (const [a, b] of tree) { degree[a]++; degree[b]++; }
  const start = 0;
  const boss = 5;
  const vault = [1, 2, 3, 4].find((r) => degree[r] === 1) ?? -1;
  const loop = spare.find((e) => !e.includes(vault));
  const links = loop ? [...tree, loop] : tree;
  for (const [a0, b0] of links) {
    const a = Math.min(a0, b0);
    const b = Math.max(a0, b0);
    const A = rooms[a];
    const B = rooms[b];
    const sealed = a === vault || b === vault;
    // Three-segment corridor: out of A, across at the gap's midline, into B. The door sits on
    // the first corridor cell, which always has wall on both flanks.
    if (b === a + 1) {
      const za = A.z0 + 1 + Math.floor(rnd() * (A.z1 - A.z0 - 1));
      const zb = B.z0 + 1 + Math.floor(rnd() * (B.z1 - B.z0 - 1));
      const mid = Math.floor((A.x1 + B.x0) / 2);
      for (let x = A.x1 + 1; x <= mid; x++) carve(L, x, za, x, za, C);
      for (let z = Math.min(za, zb); z <= Math.max(za, zb); z++) carve(L, mid, z, mid, z, C);
      for (let x = mid; x < B.x0; x++) carve(L, x, zb, x, zb, C);
      L.addDoor(A.x1 + 1, za, doorFor(sealed, rnd, def, id));
    } else {
      const xa = A.x0 + 1 + Math.floor(rnd() * (A.x1 - A.x0 - 1));
      const xb = B.x0 + 1 + Math.floor(rnd() * (B.x1 - B.x0 - 1));
      const mid = Math.floor((A.z1 + B.z0) / 2);
      for (let z = A.z1 + 1; z <= mid; z++) carve(L, xa, z, xa, z, C);
      for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) carve(L, x, mid, x, mid, C);
      for (let z = mid; z < B.z0; z++) carve(L, xb, z, xb, z, C);
      L.addDoor(xa, A.z1 + 1, doorFor(sealed, rnd, def, id));
    }
  }
  // Ensure each door sits between two walls so its panel and lintel read correctly.
  for (const d of L.doors) {
    const k = L.idx(d.i, d.j);
    L.floorTex[k] = TILE.FLAGSTONE;
    L.ceil[k] = 3.2;
    L.ceilTex[k] = TILE.CAVE_CEIL;
    d.axis = L.wall[L.idx(d.i - 1, d.j)] && L.wall[L.idx(d.i + 1, d.j)] ? 'x' : 'z';
  }
  styleWalls(L, rnd, def.wall, [[def.wall === TILE.MOSSY ? TILE.LIMESTONE : TILE.MOSSY, 0.3]]);
  L.stepTex = def.wall;

  const S = rooms[start];
  L.spawn = { x: S.cx, z: S.cz + 1, yaw: -Math.PI / 2 };
  L.addProp('stairs', 'stairs', S.cx, S.z0 + 1, { size: 2.6, solid: 0.6, data: { label: 'Climb back to the surface', portal: { level: 'overworld', x: /** @type {Record<string, any>} */ (SITES)[id].x + 0.5, z: /** @type {Record<string, any>} */ (SITES)[id].z + 4, yaw: Math.PI / 2 } } });
  // A previous delver's key, so locked doors never strand someone without lockpicks.
  L.addProp('decor', 'barrel', S.x1 - 0.2, S.z1 - 0.2, { size: 1, solid: 0.35 });
  L.addProp('item', 'i_key', S.x1 - 1.2, S.z1 - 0.3, { size: 0.6, data: { item: `key_${id}`, qty: 1 } });
  /** @param {number} r @param {number} m */
  const spot = (r, m) => {
    const R = rooms[r];
    return { x: R.x0 + m + rnd() * (R.x1 - R.x0 + 1 - 2 * m), z: R.z0 + m + rnd() * (R.z1 - R.z0 + 1 - 2 * m) };
  };
  const kinds = ['sentinel', 'wisp', 'sentinel', 'golem'];
  let sn = 0;
  rooms.forEach((R, r) => {
    L.lights.push({ x: R.cx, y: 2.6, z: R.cz, r: 0.9, g: 0.55, b: 0.25, flicker: 0.2 });
    if (r === start) return;
    const count = r === boss ? 2 : 1 + Math.floor(rnd() * (1 + def.tier));
    for (let n = 0; n < count; n++) {
      const p = spot(r, 1.5);
      L.spawns.push({ key: `${L.id}:sp:${sn++}`, kind: kinds[Math.floor(rnd() * (def.tier >= 2 ? 4 : 3))], x: p.x, z: p.z, tier: def.tier });
    }
    if (r !== vault && r !== boss && rnd() < 0.6) L.addProp('decor', 'barrel', R.x0 + 0.6, R.z1 + 0.4, { size: 1, solid: 0.35 });
  });
  const B = rooms[boss];
  L.spawns.push({ key: `${L.id}:boss`, kind: 'golem', x: B.cx + 1.5, z: B.cz, tier: def.tier + 1, boss: true });
  if (def.prize) {
    L.addProp('decor', 'pedestal', B.cx, B.cz, { size: 1.1, solid: 0.3 });
    L.addProp('item', def.prize === 'core' ? 'i_core' : def.prize, B.cx, B.cz, { size: 0.75, lift: 0.95, data: { item: def.prize, qty: 1 } });
  }
  L.addProp('chest', 'chest', B.x1 - 0.5, B.z0 + 0.6, { size: 1, solid: 0.35, data: { lockLevel: 1 + def.tier, loot: [['shards', 30 + def.tier * 20], ['draught', 2], ['tonic', 1], [def.tier >= 2 ? 'ammo_frost' : 'ammo_shard', 10]] } });
  if (vault >= 0) {
    const V = rooms[vault];
    const vaultLoot = { drowned: [['buckler', 1], ['shards', 50]], ember: [['scatter', 1], ['ammo_flare', 12]], verdant: [['crossbow', 1], ['ammo_shard', 15]], spire: [['cuirass', 1], ['charm', 1]] };
    L.addProp('chest', 'chest', V.cx, V.cz, { size: 1, solid: 0.35, data: { loot: /** @type {Record<string, any>} */ (vaultLoot)[id] } });
  }
  const tabletRoom = [1, 2, 3, 4].find((r) => r !== vault) ?? 1;
  const tp = spot(tabletRoom, 1);
  L.addProp('book', 'tablet', tp.x, tp.z, { size: 1.4, data: { book: `tablet_${id}` } });
  const midRoom = [2, 3, 4, 1].find((r) => r !== vault) ?? 2;
  const M = rooms[midRoom];
  if (def.pool) {
    L.waterLevel = -0.25;
    for (let j = Math.ceil(M.cz) - 2; j <= Math.ceil(M.cz) + 1; j++) {
      for (let i = M.x0 + 1; i <= M.x1 - 1; i++) {
        const k = L.idx(i, j);
        L.floorH[k] = -0.9;
        L.hazard[k] = HAZARD.DEEP;
      }
    }
    for (let i = M.x0 + 1; i <= M.x1 - 1; i++) {
      for (const j of [Math.ceil(M.cz) - 3, Math.ceil(M.cz) + 2]) if (!L.wall[L.idx(i, j)]) L.floorH[L.idx(i, j)] = -0.4;
    }
  }
  if (def.vents) {
    const ventRoom = rooms[[3, 4, 2, 1].find((r) => r !== vault && r !== midRoom) ?? 3];
    for (let n = 0; n < 5; n++) {
      const i = ventRoom.x0 + 1 + Math.floor(rnd() * (ventRoom.x1 - ventRoom.x0 - 1));
      const j = ventRoom.z0 + 1 + Math.floor(rnd() * (ventRoom.z1 - ventRoom.z0 - 1));
      L.hazard[L.idx(i, j)] = HAZARD.VENT;
      L.addProp('decor', 'vent', i + 0.5, j + 0.5, { size: 1.2 });
      L.lights.push({ x: i + 0.5, y: 0.6, z: j + 0.5, r: 1.2, g: 0.45, b: 0.15, flicker: 0.4 });
    }
  }
  L.fog = [0.02, 0.025, 0.03];
  L.fogDensity = 0.09;
  L.ambient = [0.06, 0.07, 0.07];
  L.finalize();
  return L;
}

/** @param {boolean} sealed @param {() => number} rnd @param {DungeonDef} def @param {string} id @returns {Partial<Door>} */
function doorFor(sealed, rnd, def, id) {
  if (sealed) return { tex: TILE.ASTRO_DOOR, height: 2.4, top: 3.2, name: 'Rune-sealed Door', locked: true, magic: true };
  const locked = rnd() < 0.25;
  return { tex: TILE.WOOD_DOOR, height: 2.4, top: 3.2, name: locked ? 'Locked Door' : 'Door', locked, lockLevel: locked ? def.tier : 0, keyId: locked ? `key_${id}` : null };
}
