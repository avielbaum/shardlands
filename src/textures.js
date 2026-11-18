/**
 * @file Procedural pixel-art generator. Paints 128x128 world tiles (brass observatory,
 * mossy limestone, timber towns, cobbles, biome ground, water) and sculpts lit, palette-
 * ramped 128x128 sprites (constructs, townsfolk, flora, props, item icons) plus 256x256
 * weapon viewmodels with a tiny z-buffered rasterizer. Uploads as NEAREST textures.
 */
import { mulberry32, hash2, TILE } from './world.js';

export const TILE_SIZE = 128;
const WORLD_COLS = 6;
const WORLD_ROWS = 4;
export const SPRITE_FRAME = 128;
const SPRITE_COLS = 8;
const ATLAS_W = 1024;
const ATLAS_H = 2048;
const VIEW_Y = 1536;

/** Sprite frame names, in atlas order. */
export const SPRITE_NAMES = Object.freeze([
  'sentinel_idle', 'sentinel_walk', 'sentinel_windup', 'sentinel_lunge', 'wisp_a', 'wisp_b', 'wisp_charge', 'golem_idle',
  'golem_slam', 'anchor', 'anchor_cracked', 'orb_enemy', 'orb_player', 'shard', 'bolt', 'flare',
  'frost', 'spark', 'bead', 'folk_a', 'folk_a_walk', 'folk_b', 'folk_b_walk', 'folk_c',
  'folk_c_walk', 'merchant', 'merchant_walk', 'guard', 'guard_walk', 'master', 'master_walk', 'keeper',
  'keeper_walk', 'captain', 'captain_walk', 'tree_ley', 'tree_pine', 'tree_dead', 'reeds', 'rock',
  'chest', 'chest_open', 'campfire_a', 'campfire_b', 'bed', 'lever_up', 'lever_down', 'stall',
  'well', 'lamp_post', 'pylon', 'stones', 'stairs', 'barrel', 'table', 'notice',
  'pedestal', 'gate_core', 'herb_lotus', 'herb_moss', 'herb_bloom', 'tablet', 'vent', 'i_fork',
  'i_scatter', 'i_crossbow', 'i_lantern', 'i_buckler', 'i_coat', 'i_cuirass', 'i_charm', 'i_amulet',
  'i_draught', 'i_tonic', 'i_oil_ember', 'i_oil_frost', 'i_bread', 'i_apple', 'i_scrap', 'i_crystal',
  'i_salt', 'i_lockpick', 'i_key', 'i_book', 'rune_lux', 'rune_vita', 'rune_vis', 'rune_aperio',
  'rune_levis', 'i_ammo_shard', 'i_ammo_flare', 'i_ammo_frost', 'i_core', 'i_relic', 'i_parcel', 'i_shards',
]);
/** @type {Readonly<Record<string, number>>} sprite name -> frame index */
export const SPR = Object.freeze(Object.fromEntries(SPRITE_NAMES.map((n, i) => [n, i])));
/** Weapon / hand viewmodels (256x256, below the sprite frames). */
export const VIEW = Object.freeze({ FORK: 0, FORK_SLASH: 1, SCATTER: 2, SCATTER_FIRE: 3, CROSSBOW: 4, CROSSBOW_FIRE: 5, LANTERN: 6, CAST: 7 });

/** Pixel rectangle of a sprite frame in the atlas canvas (for UI icons). @param {number} frame */
export function spriteRect(frame) {
  return { sx: (frame % SPRITE_COLS) * SPRITE_FRAME, sy: Math.floor(frame / SPRITE_COLS) * SPRITE_FRAME, size: SPRITE_FRAME };
}

/** @param {number} frame @returns {number[]} [u0, v0, u1, v1] */
export function spriteUV(frame) {
  const { sx, sy } = spriteRect(frame);
  return [(sx + 0.5) / ATLAS_W, (sy + 0.5) / ATLAS_H, (sx + SPRITE_FRAME - 0.5) / ATLAS_W, (sy + SPRITE_FRAME - 0.5) / ATLAS_H];
}

/** Source rectangle of a viewmodel frame in the sprite atlas canvas. @param {number} view */
export function viewRect(view) {
  return { sx: (view % 4) * 256, sy: VIEW_Y + Math.floor(view / 4) * 256, size: 256 };
}


/** @param {number} w @param {number} h */
function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return { c, ctx };
}

/**
 * Tileable 3-octave value noise in [0, 1].
 * @param {number} seed @returns {(x:number, y:number) => number}
 */
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const L = new Float32Array(32 * 32);
  for (let i = 0; i < L.length; i++) L[i] = rnd();
  /** @param {number} x @param {number} y @param {number} cells */
  const n = (x, y, cells) => {
    const fx = (x / 128) * cells;
    const fy = (y / 128) * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    /** @param {number} i @param {number} j */
    const v = (i, j) => L[(((j % cells) + cells) % cells) * 32 + (((i % cells) + cells) % cells)];
    const a = v(ix, iy);
    const b = v(ix + 1, iy);
    const c = v(ix, iy + 1);
    const d = v(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  return (x, y) => 0.5 * n(x, y, 4) + 0.3 * n(x, y, 8) + 0.2 * n(x, y, 16);
}

/**
 * Per-pixel fill of a 128x128 tile.
 * @param {CanvasRenderingContext2D} ctx @param {number} ox @param {number} oy
 * @param {(x:number, y:number, out:number[]) => void} fn writes [r, g, b] into out
 */
function paint(ctx, ox, oy, fn) {
  const img = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const d = img.data;
  const out = [0, 0, 0];
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      fn(x, y, out);
      const i = (y * TILE_SIZE + x) * 4;
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, ox, oy);
}

/**
 * Run fn with the context translated to (ox, oy) and clipped to a w x h box.
 * @param {CanvasRenderingContext2D} ctx @param {number} ox @param {number} oy @param {number} w @param {number} h @param {() => void} fn
 */
function region(ctx, ox, oy, w, h, fn) {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  fn();
  ctx.restore();
}

/** @param {CanvasRenderingContext2D} c @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function line(c, x0, y0, x1, y1) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.stroke();
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r @param {string} fill */
function disc(c, x, y, r, fill) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r @param {string} stroke @param {number} width */
function ring(c, x, y, r, stroke, width) {
  c.strokeStyle = stroke;
  c.lineWidth = width;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
}

/** @param {CanvasRenderingContext2D} c @param {number[]} pts flat x,y list @param {string} fill */
function poly(c, pts, fill) {
  c.fillStyle = fill;
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
  c.fill();
}

/** @param {CanvasRenderingContext2D} c @param {number} cx @param {number} cy @param {number} r0 @param {number} turns @param {number} dir @param {number} start */
function spiral(c, cx, cy, r0, turns, dir, start) {
  c.beginPath();
  for (let s = 0; s <= 60; s++) {
    const t = s / 60;
    const a = start + dir * t * turns * Math.PI * 2;
    const r = r0 * (1 - t * 0.85);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (s) c.lineTo(x, y);
    else c.moveTo(x, y);
  }
  c.stroke();
}

/** @param {CanvasRenderingContext2D} c @param {number} cx @param {number} cy @param {number} r @param {number} teeth @param {string} body @param {string} hi */
function gear(c, cx, cy, r, teeth, body, hi) {
  c.fillStyle = body;
  for (let k = 0; k < teeth; k++) {
    c.save();
    c.translate(cx, cy);
    c.rotate((k * Math.PI * 2) / teeth);
    c.fillRect(-5, -r - 6, 10, 10);
    c.restore();
  }
  disc(c, cx, cy, r, body);
  ring(c, cx, cy, r - 4, hi, 3);
  c.lineWidth = 3;
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    line(c, cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
  }
  disc(c, cx, cy, 8, '#2a1a06');
  disc(c, cx, cy, 3, hi);
}

/** Tarnished brass base shading. @param {(x:number,y:number)=>number} na @param {(x:number,y:number)=>number} nb */
function brassFn(na, nb) {
  return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ o) => {
    const q = Math.round(na(x, y) * 5) / 5;
    const tarn = Math.max(0, Math.min(0.8, (y / 128 - 0.45) * 2.2 * nb(x, y)));
    let r = 105 + q * 90;
    let g = 74 + q * 64;
    let b = 30 + q * 30;
    r = r * (1 - tarn) + 56 * tarn;
    g = g * (1 - tarn) + 118 * tarn;
    b = b * (1 - tarn) + 96 * tarn;
    if (x < 3 || y < 3) { r += 45; g += 36; b += 18; } else if (x > 124 || y > 124) { r *= 0.45; g *= 0.45; b *= 0.45; }
    o[0] = r; o[1] = g; o[2] = b;
  };
}

/** Polished obsidian base. @param {(x:number,y:number)=>number} na */
function obsidianFn(na) {
  return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ o) => {
    const q = Math.round(na(x, y) * 6) / 6;
    const streak = (x + y * 0.5) % 37 < 1.3 ? 18 : 0;
    o[0] = 14 + q * 22 + streak;
    o[1] = 12 + q * 18 + streak;
    o[2] = 24 + q * 32 + streak;
  };
}

/** Rivets in the four corners of a tile. @param {CanvasRenderingContext2D} c */
function rivets(c) {
  for (const [x, y] of [[9, 9], [119, 9], [9, 119], [119, 119]]) {
    disc(c, x + 1, y + 1, 3.5, '#2a1a06');
    disc(c, x, y, 3, '#f2d98f');
  }
}

/** Glowing ley channel (dark groove, cyan body, white core). @param {CanvasRenderingContext2D} c @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function leyLine(c, x0, y0, x1, y1) {
  c.strokeStyle = '#0b3c4a'; c.lineWidth = 10; line(c, x0, y0, x1, y1);
  c.strokeStyle = '#3fe6ff'; c.lineWidth = 5; line(c, x0, y0, x1, y1);
  c.strokeStyle = '#e6ffff'; c.lineWidth = 1.5; line(c, x0, y0, x1, y1);
}


/** Shard Runner tile names mapped onto this atlas, so the observatory painters carry over. */
const OT = { BRASS: TILE.BRASS, CONDUIT: TILE.CONDUIT, FLOOR: TILE.OBS_FLOOR, CEILING: TILE.STAR_CEIL, DOOR: TILE.ASTRO_DOOR, GATE: TILE.GATE, FLOOR_LEY: TILE.LEY_FLOOR, BRASS_GEAR: TILE.GEAR };

/**
 * Tileable Voronoi over a 128px tile.
 * @param {number} x @param {number} y @param {number} cells per tile edge @param {number} seed @param {number} [jitter]
 * @returns {number[]} [nearest distance, second distance, cell id]
 */
function voronoi(x, y, cells, seed, jitter = 0.6) {
  const s = 128 / cells;
  const cx = Math.floor(x / s);
  const cy = Math.floor(y / s);
  let d1 = 1e9;
  let d2 = 1e9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const off = (1 - jitter) / 2;
      const px = (gx + off + jitter * hash2(wx, wy, seed)) * s;
      const py = (gy + off + jitter * hash2(wy, wx, seed + 1)) * s;
      const d = Math.hypot(x - px, y - py);
      if (d < d1) { d2 = d1; d1 = d; id = wy * cells + wx; } else if (d < d2) d2 = d;
    }
  }
  return [d1, d2, id];
}

/**
 * Paint the 6x4 world atlas: the brass observatory set plus limestone ruins, timber town
 * buildings, cobbles and biome ground.
 * @returns {HTMLCanvasElement}
 */
export function buildWorldAtlas() {
  const { c: canvas, ctx } = canvas2d(WORLD_COLS * TILE_SIZE, WORLD_ROWS * TILE_SIZE);
  const rnd = mulberry32(0xa37e);
  const na = makeNoise(11);
  const nb = makeNoise(29);
  /** @param {number} t */
  const at = (t) => [(t % WORLD_COLS) * TILE_SIZE, Math.floor(t / WORLD_COLS) * TILE_SIZE];
  // Brass filigree wall.
  let [ox, oy] = at(OT.BRASS);
  paint(ctx, ox, oy, brassFn(na, nb));
  region(ctx, ox, oy, 128, 128, () => {
    for (const [col, off, w] of [['#3d2a0c', 1, 3], ['#f2d98f', 0, 2]]) {
      ctx.save();
      ctx.translate(/** @type {number} */ (off), /** @type {number} */ (off));
      ctx.strokeStyle = /** @type {string} */ (col);
      ctx.lineWidth = /** @type {number} */ (w);
      spiral(ctx, 36, 64, 22, 1.6, 1, Math.PI);
      spiral(ctx, 92, 64, 22, 1.6, -1, 0);
      ctx.beginPath();
      ctx.moveTo(36, 42);
      ctx.bezierCurveTo(60, 30, 68, 98, 92, 86);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(64, 20, 10, Math.PI * 0.1, Math.PI * 0.9);
      ctx.arc(64, 108, 10, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
      ctx.restore();
    }
    poly(ctx, [64, 52, 72, 64, 64, 76, 56, 64], '#3fe6ff');
    poly(ctx, [64, 56, 68, 64, 64, 72, 60, 64], '#e6ffff');
    rivets(ctx);
  });

  // Obsidian wall with glowing ley-line conduits.
  [ox, oy] = at(OT.CONDUIT);
  paint(ctx, ox, oy, obsidianFn(na));
  region(ctx, ox, oy, 128, 128, () => {
    leyLine(ctx, 64, 10, 64, 118);
    leyLine(ctx, 64, 36, 128, 36);
    leyLine(ctx, 0, 88, 64, 88);
    leyLine(ctx, 96, 36, 96, 70);
    for (const [x, y] of [[64, 36], [64, 88], [96, 70]]) {
      disc(ctx, x, y, 8, '#0b3c4a');
      disc(ctx, x, y, 6, '#3fe6ff');
      disc(ctx, x, y, 2.5, '#ffffff');
    }
    ctx.fillStyle = '#8a6326'; ctx.fillRect(0, 0, 128, 10); ctx.fillRect(0, 118, 128, 10);
    ctx.fillStyle = '#d9b468'; ctx.fillRect(0, 0, 128, 2); ctx.fillRect(0, 118, 128, 2);
    ctx.fillStyle = '#3d2a0c'; ctx.fillRect(0, 8, 128, 2); ctx.fillRect(0, 126, 128, 2);
  });

  // Basalt floor slabs (plain and ley-inlaid).
  for (const tile of [OT.FLOOR, OT.FLOOR_LEY]) {
    [ox, oy] = at(tile);
    paint(ctx, ox, oy, (x, y, o) => {
      const q = Math.round(na(x + 37, y + 11) * 5) / 5;
      let v = 30 + q * 30;
      const row = Math.floor(y / 32);
      const sx = (x + (row % 2) * 32) % 64;
      if (y % 32 < 2 || sx < 2) v *= 0.45;
      o[0] = v; o[1] = v - 2; o[2] = v + 9;
    });
    region(ctx, ox, oy, 128, 128, () => {
      ctx.strokeStyle = '#141219';
      ctx.lineWidth = 1;
      for (let k = 0; k < 5; k++) {
        let x = rnd() * 128;
        let y = rnd() * 128;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 6; s++) { x += (rnd() - 0.5) * 18; y += (rnd() - 0.5) * 18; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.fillStyle = '#8e88a8';
      for (let k = 0; k < 40; k++) ctx.fillRect(Math.floor(rnd() * 128), Math.floor(rnd() * 128), 1, 1);
      if (tile === OT.FLOOR_LEY) {
        leyLine(ctx, 64, -4, 64, 132);
        leyLine(ctx, -4, 64, 132, 64);
        disc(ctx, 64, 64, 9, '#3fe6ff');
        disc(ctx, 64, 64, 4, '#ffffff');
      }
    });
  }

  // Star-chart ceiling.
  [ox, oy] = at(OT.CEILING);
  paint(ctx, ox, oy, (x, y, o) => {
    const q = Math.round(na(x + 64, y + 64) * 5) / 5;
    o[0] = 10 + q * 12; o[1] = 12 + q * 14; o[2] = 28 + q * 28;
    if (x < 4 || y < 4) { o[0] = 120; o[1] = 86; o[2] = 36; }
  });
  region(ctx, ox, oy, 128, 128, () => {
    /** @type {number[][]} */
    const stars = [];
    for (let k = 0; k < 50; k++) {
      const x = 6 + Math.floor(rnd() * 118);
      const y = 6 + Math.floor(rnd() * 118);
      stars.push([x, y]);
      ctx.fillStyle = rnd() < 0.5 ? '#ffe9a8' : '#ffffff';
      ctx.fillRect(x, y, 1, 1);
      if (k % 9 === 0) { ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3); }
    }
    ctx.strokeStyle = '#34488a';
    ctx.lineWidth = 1;
    for (let k = 0; k < 4; k++) line(ctx, stars[k * 2][0], stars[k * 2][1], stars[k * 2 + 1][0], stars[k * 2 + 1][1]);
  });

  // Astrolabe doors (brass for normal doors, obsidian/cyan for the gate).
  for (const tile of [OT.DOOR, OT.GATE]) {
    [ox, oy] = at(tile);
    const gate = tile === OT.GATE;
    paint(ctx, ox, oy, gate ? obsidianFn(nb) : brassFn(na, nb));
    region(ctx, ox, oy, 128, 128, () => {
      const lineCol = gate ? '#3fe6ff' : '#f0d48a';
      for (const r of [56, 40, 24]) { ring(ctx, 64, 64, r, '#1e1406', 5); ring(ctx, 64, 64, r, lineCol, 2); }
      ctx.lineWidth = 2;
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6;
        ctx.strokeStyle = lineCol;
        line(ctx, 64 + Math.cos(a) * 43, 64 + Math.sin(a) * 43, 64 + Math.cos(a) * 53, 64 + Math.sin(a) * 53);
        disc(ctx, 64 + Math.cos(a + 0.26) * 32, 64 + Math.sin(a + 0.26) * 32, 2, gate ? '#bff8ff' : '#3fe6ff');
      }
      ctx.strokeStyle = lineCol;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(64, 64, 52, 18, -0.4, 0, Math.PI * 2);
      ctx.stroke();
      disc(ctx, 64, 64, 10, '#0b3c4a');
      disc(ctx, 64, 64, 8, '#3fe6ff');
      disc(ctx, 62, 62, 3, '#ffffff');
      ctx.fillStyle = '#120c04';
      ctx.fillRect(63, 0, 2, 54);
      ctx.fillRect(63, 74, 2, 54);
      if (!gate) rivets(ctx);
    });
  }

  // Brass wall with a great gear.
  [ox, oy] = at(OT.BRASS_GEAR);
  paint(ctx, ox, oy, brassFn(na, nb));
  region(ctx, ox, oy, 128, 128, () => {
    gear(ctx, 66, 66, 38, 14, '#2a1a06', '#2a1a06');
    gear(ctx, 64, 64, 38, 14, '#7a5520', '#d9b468');
    gear(ctx, 108, 22, 14, 8, '#5a3d12', '#c99a48');
    rivets(ctx);
  });
  paintLandTiles(ctx, at, rnd, na, nb);
  return canvas;
}

/**
 * @param {CanvasRenderingContext2D} ctx @param {(t:number) => number[]} at @param {() => number} rnd
 * @param {(x:number, y:number) => number} na @param {(x:number, y:number) => number} nb
 */
function paintLandTiles(ctx, at, rnd, na, nb) {
  /** @param {number} v @param {number} s */
  const q = (v, s) => Math.round(v * s) / s;

  // Limestone blocks and the mossy variant with hanging vines.
  for (const mossy of [false, true]) {
    const [ox, oy] = at(mossy ? TILE.MOSSY : TILE.LIMESTONE);
    paint(ctx, ox, oy, (x, y, o) => {
      const row = Math.floor(y / 32);
      const bx = (x + (row % 2) * 32) % 64;
      let v = 142 + q(na(x, y), 5) * 62;
      if (y % 32 < 2 || bx < 2) v *= 0.45;
      else if (y % 32 < 4 || bx < 4) v *= 1.12;
      else if (y % 32 > 29 || bx > 61) v *= 0.82;
      let r = v * 1.02;
      let g = v * 0.97;
      let b = v * 0.84;
      if (mossy) {
        const m = nb(x, y) * (0.5 + 0.7 * (y / 128));
        if (m > 0.5) {
          const t = Math.min(1, (m - 0.5) * 4);
          r = r * (1 - t) + 62 * t;
          g = g * (1 - t) + 112 * t;
          b = b * (1 - t) + 48 * t;
        }
      }
      o[0] = r; o[1] = g; o[2] = b;
    });
    region(ctx, ox, oy, 128, 128, () => {
      if (mossy) {
        for (let k = 0; k < 7; k++) {
          let x = rnd() * 128;
          const len = 30 + rnd() * 70;
          ctx.strokeStyle = '#2f5a24';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          for (let y = 0; y < len; y += 6) { x += (rnd() - 0.5) * 4; ctx.lineTo(x, y); }
          ctx.stroke();
          ctx.fillStyle = '#5a9a3c';
          for (let y = 6; y < len; y += 9) ctx.fillRect(Math.round(x + (rnd() - 0.5) * 6), y, 3, 2);
        }
      } else {
        ctx.strokeStyle = '#4a4438';
        ctx.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          let x = rnd() * 128;
          let y = rnd() * 128;
          ctx.beginPath();
          ctx.moveTo(x, y);
          for (let s = 0; s < 5; s++) { x += (rnd() - 0.5) * 16; y += rnd() * 10; ctx.lineTo(x, y); }
          ctx.stroke();
        }
      }
    });
  }

  // Dungeon flagstones (irregular slabs) and the rough cave ceiling with roots.
  let [ox, oy] = at(TILE.FLAGSTONE);
  paint(ctx, ox, oy, (x, y, o) => {
    const [d1, d2, id] = voronoi(x, y, 4, 71, 0.5);
    const edge = d2 - d1;
    let v = 70 + hash2(id, 3, 9) * 34 + q(na(x, y), 4) * 26;
    if (edge < 2.5) v *= 0.4;
    else if (edge < 5) v *= 0.85;
    o[0] = v * 1.02; o[1] = v * 0.96; o[2] = v * 0.88;
  });
  [ox, oy] = at(TILE.CAVE_CEIL);
  paint(ctx, ox, oy, (x, y, o) => {
    const v = 26 + q(na(x + 50, y), 6) * 38 + q(nb(x, y), 3) * 10;
    o[0] = v; o[1] = v * 0.94; o[2] = v * 0.86;
  });
  region(ctx, ox, oy, 128, 128, () => {
    ctx.strokeStyle = '#3a2a1a';
    ctx.lineWidth = 2;
    for (let k = 0; k < 6; k++) {
      let x = rnd() * 128;
      let y = rnd() * 128;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) { x += (rnd() - 0.5) * 22; y += (rnd() - 0.5) * 22; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  });

  // Half-timbered plaster wall.
  [ox, oy] = at(TILE.TIMBER);
  paint(ctx, ox, oy, (x, y, o) => {
    const v = 200 + q(na(x, y), 6) * 40;
    o[0] = v; o[1] = v * 0.93; o[2] = v * 0.78;
  });
  region(ctx, ox, oy, 128, 128, () => {
    /** @param {number[]} pts */
    const beam = (pts) => {
      for (const [col, w] of [['#2a1608', 11], ['#5a3418', 8], ['#7a4a24', 3]]) {
        ctx.strokeStyle = /** @type {string} */ (col);
        ctx.lineWidth = /** @type {number} */ (w);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
        ctx.stroke();
      }
    };
    beam([0, 5, 128, 5]);
    beam([0, 123, 128, 123]);
    beam([5, 0, 5, 128]);
    beam([123, 0, 123, 128]);
    beam([10, 118, 118, 10]);
    beam([64, 10, 64, 118]);
    ctx.fillStyle = '#1a1a1a';
    for (const [x, y] of [[5, 5], [123, 5], [5, 123], [123, 123], [64, 64]]) ctx.fillRect(x - 2, y - 2, 4, 4);
  });

  // Plank floor, wooden door and beamed plaster ceiling.
  [ox, oy] = at(TILE.PLANK);
  paint(ctx, ox, oy, (x, y, o) => {
    const plank = Math.floor(y / 16);
    const seam = (x + plank * 37) % 96;
    const grain = Math.sin((x + hash2(plank, 1, 4) * 300) * 0.15 + na(x, y) * 6) * 0.5 + 0.5;
    let v = 96 + hash2(plank, 2, 5) * 30 + grain * 22;
    if (y % 16 < 1 || seam < 1) v *= 0.4;
    if ((seam === 4 || seam === 91) && (y % 16 === 4 || y % 16 === 11)) v = 40;
    o[0] = v * 1.05; o[1] = v * 0.72; o[2] = v * 0.45;
  });
  [ox, oy] = at(TILE.WOOD_DOOR);
  paint(ctx, ox, oy, (x, y, o) => {
    const plank = Math.floor(x / 21);
    const grain = Math.sin(y * 0.2 + hash2(plank, 7, 1) * 40 + na(x, y) * 5) * 0.5 + 0.5;
    let v = 88 + hash2(plank, 3, 8) * 26 + grain * 20;
    if (x % 21 < 2) v *= 0.45;
    o[0] = v * 1.05; o[1] = v * 0.7; o[2] = v * 0.42;
  });
  region(ctx, ox, oy, 128, 128, () => {
    for (const y of [22, 100]) {
      ctx.fillStyle = '#2a2a30'; ctx.fillRect(0, y - 5, 128, 10);
      ctx.fillStyle = '#6a6a76'; ctx.fillRect(0, y - 5, 128, 2);
      ctx.fillStyle = '#9a9aa6';
      for (let x = 10; x < 128; x += 24) ctx.fillRect(x, y - 1, 3, 3);
    }
    ring(ctx, 100, 64, 7, '#1a1a1e', 4);
    ring(ctx, 100, 64, 7, '#b8893a', 2);
    disc(ctx, 100, 57, 3, '#3d2a0c');
  });
  [ox, oy] = at(TILE.PLASTER);
  paint(ctx, ox, oy, (x, y, o) => {
    let v = 196 + q(na(x, y), 5) * 34;
    const beamPos = y % 64;
    const isBeam = beamPos < 12;
    if (isBeam) v = 70 + (beamPos < 2 ? -20 : beamPos > 9 ? -15 : 10) + q(nb(x, y), 4) * 20;
    o[0] = v; o[1] = isBeam ? v * 0.68 : v * 0.94; o[2] = isBeam ? v * 0.42 : v * 0.8;
  });

  // Scalloped roof shingles.
  [ox, oy] = at(TILE.ROOF);
  paint(ctx, ox, oy, (x, y, o) => {
    const row = Math.floor(y / 16);
    const sx = (x + (row % 2) * 8) % 16;
    const dy = (y % 16) / 16;
    const curve = Math.abs(sx - 8) / 8;
    const lip = dy > 0.75 - curve * curve * 0.4;
    const tone = hash2(Math.floor((x + (row % 2) * 8) / 16), row, 6);
    let v = 120 + tone * 40 + q(na(x, y), 4) * 20;
    if (lip) v *= 0.55;
    else if (dy < 0.15) v *= 1.15;
    if (sx < 1) v *= 0.6;
    o[0] = v * 1.08; o[1] = v * 0.52; o[2] = v * 0.38;
  });

  // Rounded cobblestones.
  [ox, oy] = at(TILE.COBBLE);
  paint(ctx, ox, oy, (x, y, o) => {
    const [d1, d2, id] = voronoi(x, y, 8, 33, 0.7);
    const edge = d2 - d1;
    const dome = Math.max(0, 1 - d1 / 9);
    let v = 92 + hash2(id, 1, 2) * 40 + dome * 40 + q(na(x, y), 4) * 12;
    if (edge < 2) v = 40;
    o[0] = v * 0.98; o[1] = v * 0.95; o[2] = v * 0.92;
  });

  // Biome ground.
  [ox, oy] = at(TILE.GRASS);
  paint(ctx, ox, oy, (x, y, o) => {
    const n = q(na(x, y), 5);
    const blade = hash2(x, y, 41) < 0.12 ? 22 : 0;
    o[0] = 38 + n * 30 + blade * 0.5; o[1] = 82 + n * 50 + blade; o[2] = 52 + n * 26;
    if (hash2(x >> 1, y >> 1, 99) > 0.996) { o[0] = 140; o[1] = 255; o[2] = 230; }
  });
  [ox, oy] = at(TILE.FEN);
  paint(ctx, ox, oy, (x, y, o) => {
    const n = q(na(x, y), 5);
    const wet = nb(x, y) > 0.6;
    o[0] = (wet ? 46 : 70) + n * 26; o[1] = (wet ? 58 : 78) + n * 30; o[2] = (wet ? 44 : 38) + n * 14;
    if (hash2(x, y, 13) < 0.05) { o[0] += 20; o[1] += 26; }
  });
  [ox, oy] = at(TILE.BASALT);
  paint(ctx, ox, oy, (x, y, o) => {
    const [d1, d2, id] = voronoi(x, y, 5, 57, 0.25);
    const edge = d2 - d1;
    let v = 46 + hash2(id, 4, 4) * 22 + q(na(x, y), 5) * 16;
    if (edge < 2.5) v *= 0.45;
    else if (edge < 6 && x - y > 0) v *= 1.2;
    o[0] = v * 0.92; o[1] = v * 0.92; o[2] = v * 1.08;
  });
  [ox, oy] = at(TILE.DUST);
  paint(ctx, ox, oy, (x, y, o) => {
    const n = q(na(x + 9, y + 3), 6);
    let v = 120 + n * 50;
    if (hash2(x, y, 77) < 0.03) v *= 0.6;
    o[0] = v * 1.1; o[1] = v * 0.72; o[2] = v * 0.52;
  });
  region(ctx, ox, oy, 128, 128, () => {
    ctx.strokeStyle = '#5a3820';
    ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) {
      let x = rnd() * 128;
      let y = rnd() * 128;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) { x += (rnd() - 0.5) * 20; y += (rnd() - 0.5) * 20; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  });
  [ox, oy] = at(TILE.WATER);
  paint(ctx, ox, oy, (x, y, o) => {
    const n = q(na(x, y), 6);
    const ripple = Math.sin((y + Math.sin(x * 0.09) * 6) * 0.35) > 0.93 ? 40 : 0;
    o[0] = 18 + n * 20 + ripple; o[1] = 70 + n * 40 + ripple; o[2] = 86 + n * 44 + ripple;
  });
  [ox, oy] = at(TILE.CLIFF);
  paint(ctx, ox, oy, (x, y, o) => {
    const strata = Math.floor((y + na(x, y) * 14) / 11);
    let v = 70 + hash2(strata, 2, 12) * 40 + q(nb(x, y), 5) * 20;
    if ((y + na(x, y) * 14) % 11 < 1.5) v *= 0.5;
    o[0] = v * 1.05; o[1] = v * 0.9; o[2] = v * 0.78;
  });
}

// ---------------------------------------------------------------------------
// Pixel sculptor: a tiny z-buffered rasterizer that lights analytic primitives
// (spheres, capsules, bevelled boxes, faceted polygons, torus rings). Art is
// authored in "unit" coordinates (128 for sprites, 256 for viewmodels) and
// rasterized at a higher pixel size. Shading uses hue-shifted material ramps
// (cool shadows, warm lights) with surface micro-texture, ordered dithering,
// specular glints and a cyan floor-bounce rim light; finish() adds ambient
// occlusion, depth-crease lines and a light-aware ("sel-out") outline.
// ---------------------------------------------------------------------------

/** @typedef {number[][] & {mat?: string}} Ramp dark -> bright RGB steps; the last step is the specular glint */
/**
 * @typedef {Object} ShadeOpts
 * @property {boolean} [emit] self-lit: brightness follows facing, ignores the light
 * @property {number} [sx] ellipsoid x scale (sphere)
 * @property {number} [sy] ellipsoid y scale (sphere)
 * @property {(x:number, y:number) => boolean} [clip] keep a pixel only when true (unit coordinates)
 * @property {number} [from] ring start angle
 * @property {number} [to] ring end angle
 */

/** @param {...string} hex @returns {Ramp} */
function ramp(...hex) {
  return hex.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
}

/**
 * Expand a ramp to ~2x the steps with hue shifting (shadows toward indigo, lights toward
 * warm ivory) and tag it with a surface material for micro-texture.
 * @param {Ramp} base @param {string} name @returns {Ramp}
 */
function material(base, name) {
  const n = base.length;
  const steps = (n - 1) * 2 - 1;
  /** @type {Ramp} */
  const out = [];
  for (let i = 0; i < steps; i++) {
    const t = i / 2;
    const a = base[Math.floor(t)];
    const b = base[Math.ceil(t)];
    const f = t - Math.floor(t);
    const u = i / (steps - 1);
    out.push(a.map((v, j) => {
      let c = v + (b[j] - v) * f;
      c += ([46, 30, 90][j] - c) * 0.3 * (1 - u) ** 2;
      c += ([255, 236, 190][j] - c) * 0.18 * u ** 3;
      return Math.round(c);
    }));
  }
  out.push(base[n - 1]);
  out.mat = name;
  return out;
}

/** Palette ramps shared by every sprite (lit materials are expanded and hue-shifted). */
const PAL = {
  brass: material(ramp('#1e1204', '#3d2a0c', '#6b4a17', '#9a7130', '#c99a48', '#e8c779', '#fff2c4'), 'brass'),
  steel: material(ramp('#15181d', '#2c323b', '#4a525e', '#6d7682', '#939ca6', '#b5bcc4', '#f4f7fa'), 'steel'),
  basalt: material(ramp('#0c0b10', '#1b1922', '#2b2834', '#3e3a4a', '#55506a', '#6e6886', '#a49cc2'), 'stone'),
  obsidian: material(ramp('#050408', '#0e0c14', '#1a1726', '#28243a', '#3a3552', '#8a84b0'), 'stone'),
  crystal: material(ramp('#06303c', '#0b5566', '#127f94', '#1fb0c8', '#3fe6ff', '#9ff6ff', '#ffffff'), 'crystal'),
  leather: material(ramp('#140a05', '#2e1a0e', '#4a2c18', '#6b4226', '#8f5c36', '#c08a5a'), 'leather'),
  crimson: material(ramp('#3a0614', '#7a1030', '#c21f4a', '#ff4d6d', '#ff9aa8', '#ffe0e6'), 'crystal'),
  glass: material(ramp('#3a5262', '#5f8092', '#93b4c6', '#c6e2f0', '#ffffff'), 'crystal'),
  verdigris: material(ramp('#0f2a24', '#1f4a3e', '#2f6b58', '#4a9479', '#7fc7a8', '#d0f5e4'), 'stone'),
  smoke: material(ramp('#1e1a2c', '#3a3350', '#5a5270', '#8a82a6', '#c8c0e0'), 'smoke'),
  gCyan: ramp('#127f94', '#3fe6ff', '#9ff6ff', '#ffffff'),
  gBead: ramp('#0b5566', '#127f94', '#1fb0c8', '#3fe6ff'),
  gViolet: ramp('#4a1680', '#7a2bd6', '#b45cff', '#e3b8ff', '#ffffff'),
  gAmber: ramp('#7a3a08', '#ff9a3c', '#ffd27a', '#fff6e0'),
  gGold: ramp('#8a5a10', '#e8b64a', '#fff2b0', '#ffffff'),
  gWhite: ramp('#9ff6ff', '#e6ffff', '#ffffff'),
  gRose: ramp('#7a1030', '#ff4d6d', '#ffb3c0', '#ffffff'),
};
/** Prismatic ray ramps (red -> violet) for the scattergun flash. */
const SPECTRUM = [
  ramp('#7a1010', '#ff5a5a', '#ffd0d0'), ramp('#7a3a08', '#ffb347', '#ffe6c0'), ramp('#6b6008', '#fff36b', '#fffbd0'),
  ramp('#0e5a20', '#6bff8a', '#d0ffd8'), ramp('#0b5566', '#3fe6ff', '#d0faff'), ramp('#3a1680', '#b36bff', '#ecd8ff'),
];
/** Inlay colours. */
const INK = {
  cyan: [63, 230, 255], pale: [159, 246, 255], white: [240, 255, 255], gold: [242, 217, 143],
  amber: [255, 170, 80], violet: [200, 130, 255], stitch: [214, 170, 110],
};
const RIM = [96, 200, 228];

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** @param {number[]} v */
const unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
/** Key light from upper-left-front (x right, y down, z toward the viewer). */
const LIGHT = unit([-0.5, -0.65, 0.58]);
const HALF = unit([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
/** Cyan bounce light rising from the ley-lined floor, lower right. */
const BOUNCE = unit([0.45, 0.89]);


/** Smooth value noise with cell size s. @param {number} x @param {number} y @param {number} s */
function vnoise(x, y, s) {
  const fx = x / s;
  const fy = y / s;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Spiral polyline (unit coords). @param {number} cx @param {number} cy @param {number} r0 @param {number} turns @param {number} dir @param {number} start @returns {number[]} */
function spiralPts(cx, cy, r0, turns, dir, start) {
  /** @type {number[]} */
  const pts = [];
  for (let s = 0; s <= 40; s++) {
    const t = s / 40;
    const a = start + dir * t * turns * Math.PI * 2;
    const r = r0 * (1 - t * 0.8);
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/** Elliptical arc polyline. @param {number} cx @param {number} cy @param {number} rx @param {number} ry @param {number} a0 @param {number} a1 @param {number} [n] @returns {number[]} */
function arcPts(cx, cy, rx, ry, a0, a1, n = 24) {
  /** @type {number[]} */
  const pts = [];
  for (let s = 0; s <= n; s++) {
    const a = a0 + ((a1 - a0) * s) / n;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return pts;
}

class Sculpt {
  /** @param {number} size pixel edge @param {number} unitSize authored coordinate edge */
  constructor(size, unitSize) {
    this.size = size;
    this.k = size / unitSize;
    this.rgba = new Uint8ClampedArray(size * size * 4);
    this.depth = new Float32Array(size * size).fill(-1e9);
    /** @type {{c:number, s:number, px:number, py:number}|null} */
    this.rot = null;
  }

  /** Rotate subsequent primitives about (px, py) in unit space; angle 0 clears. @param {number} angle @param {number} [px] @param {number} [py] */
  rotate(angle, px = 0, py = 0) {
    this.rot = angle ? { c: Math.cos(angle), s: Math.sin(angle), px, py } : null;
  }

  /** Unit -> pixel. @param {number} x @param {number} y @returns {number[]} */
  _p(x, y) {
    const r = this.rot;
    const k = this.k;
    if (!r) return [x * k, y * k];
    const dx = x - r.px;
    const dy = y - r.py;
    return [(r.px + dx * r.c - dy * r.s) * k, (r.py + dx * r.s + dy * r.c) * k];
  }

  /** Pixel -> unit (inverse of _p). @param {number} px @param {number} py @returns {number[]} */
  _inv(px, py) {
    const x = px / this.k;
    const y = py / this.k;
    const r = this.rot;
    if (!r) return [x, y];
    const dx = x - r.px;
    const dy = y - r.py;
    return [r.px + dx * r.c + dy * r.s, r.py - dx * r.s + dy * r.c];
  }

  /** @param {ShadeOpts} o @param {number} x @param {number} y */
  _clipped(o, x, y) {
    return !!o.clip && !o.clip((x + 0.5) / this.k, (y + 0.5) / this.k);
  }

  /** @param {number} x @param {number} y @param {number} z @param {number[]} c */
  _put(x, y, z, c) {
    const S = this.size;
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = y * S + x;
    if (z < this.depth[i]) return;
    this.depth[i] = z;
    const o = i * 4;
    this.rgba[o] = c[0];
    this.rgba[o + 1] = c[1];
    this.rgba[o + 2] = c[2];
    this.rgba[o + 3] = 255;
  }

  /**
   * Pick a ramp colour for a surface normal at pixel (x, y).
   * @param {number} x @param {number} y @param {number} nx @param {number} ny @param {number} nz @param {Ramp} rmp @param {ShadeOpts} o
   * @returns {number[]}
   */
  _shade(x, y, nx, ny, nz, rmp, o) {
    const n = rmp.length;
    if (o.emit) return rmp[Math.min(n - 1, Math.max(0, Math.round((0.25 + 0.75 * nz) * (n - 1))))];
    const k = this.k;
    const m = rmp.mat;
    let jitter = 0;
    if (m === 'brass' || m === 'stone') {
      const s = (m === 'brass' ? 2.4 : 3.2) * k;
      const amp = ((m === 'brass' ? 0.2 : 0.55) * s) / 2;
      nx += (vnoise(x + 1, y, s) - vnoise(x - 1, y, s)) * amp;
      ny += (vnoise(x, y + 1, s) - vnoise(x, y - 1, s)) * amp;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      jitter = (hash2(x, y) - 0.5) * (m === 'stone' ? 0.6 : 0.15);
    } else if (m === 'steel') jitter = (hash2(Math.floor(x / (4 * k)), y) - 0.5) * 0.55;
    else if (m === 'leather') jitter = (hash2(x >> 1, y >> 1) - 0.5) * 0.6;
    else if (m === 'smoke') jitter = (vnoise(x, y, 3 * k) - 0.5) * 0.8;
    if (nx * HALF[0] + ny * HALF[1] + nz * HALF[2] > 0.955 && n > 3) return rmp[n - 1];
    const d = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const f = (0.14 + 0.86 * d) * (n - 2) + jitter;
    const idx = Math.floor(f + 0.2 + (BAYER[(y & 3) * 4 + (x & 3)] / 16) * 0.6);
    const c = rmp[Math.max(0, Math.min(n - 2, idx))];
    let out = c;
    const rim = (1 - Math.max(0, nz)) ** 1.5 * Math.max(0, nx * BOUNCE[0] + ny * BOUNCE[1]);
    if (rim >= 0.3) {
      const t = Math.min(0.6, (rim - 0.3) * 1.6);
      out = [c[0] + (RIM[0] - c[0]) * t, c[1] + (RIM[1] - c[1]) * t, c[2] + (RIM[2] - c[2]) * t];
    }
    // Warm key rim from upper-right behind: lamplight catching edges.
    const warm = (1 - Math.max(0, nz)) ** 2 * Math.max(0, nx * 0.6 - ny * 0.5);
    if (warm >= 0.3) {
      const t = Math.min(0.42, (warm - 0.3) * 1.3);
      out = [out[0] + (255 - out[0]) * t, out[1] + (200 - out[1]) * t, out[2] + (135 - out[2]) * t];
    }
    return out;
  }

  /** @param {number} cx @param {number} cy @param {number} cz @param {number} r @param {Ramp} rmp @param {ShadeOpts} [o] */
  sphere(cx, cy, cz, r, rmp, o = {}) {
    const [px, py] = this._p(cx, cy);
    const pr = r * this.k;
    const pz = cz * this.k;
    const sx = o.sx || 1;
    const sy = o.sy || 1;
    for (let y = Math.floor(py - pr * sy); y <= Math.ceil(py + pr * sy); y++) {
      for (let x = Math.floor(px - pr * sx); x <= Math.ceil(px + pr * sx); x++) {
        const dx = (x + 0.5 - px) / (pr * sx);
        const dy = (y + 0.5 - py) / (pr * sy);
        const d2 = dx * dx + dy * dy;
        if (d2 > 1 || this._clipped(o, x, y)) continue;
        const dz = Math.sqrt(1 - d2);
        this._put(x, y, pz + dz * pr, this._shade(x, y, dx, dy, dz, rmp, o));
      }
    }
  }

  /** Tapered capsule between two 3D unit points. @param {number[]} a @param {number[]} b @param {number} r0 @param {number} r1 @param {Ramp} rmp @param {ShadeOpts} [o] */
  capsule(a, b, r0, r1, rmp, o = {}) {
    const k = this.k;
    const [ax, ay] = this._p(a[0], a[1]);
    const [bx, by] = this._p(b[0], b[1]);
    const az = (a[2] || 0) * k;
    const bz = (b[2] || 0) * k;
    const q0 = r0 * k;
    const q1 = r1 * k;
    const rm = Math.max(q0, q1);
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1e-6;
    for (let y = Math.floor(Math.min(ay, by) - rm); y <= Math.ceil(Math.max(ay, by) + rm); y++) {
      for (let x = Math.floor(Math.min(ax, bx) - rm); x <= Math.ceil(Math.max(ax, bx) + rm); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
        const dx = px - (ax + vx * t);
        const dy = py - (ay + vy * t);
        const r = q0 + (q1 - q0) * t;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r || this._clipped(o, x, y)) continue;
        const dz = Math.sqrt(r * r - d2);
        this._put(x, y, az + (bz - az) * t + dz, this._shade(x, y, dx / r, dy / r, dz / r, rmp, o));
      }
    }
  }

  /** Flat-shaded polygon facet. @param {number[]} pts flat unit x,y list @param {number} z @param {number[]} nrm @param {Ramp} rmp @param {ShadeOpts} [o] */
  poly(pts, z, nrm, rmp, o = {}) {
    /** @type {number[]} */
    const p = [];
    for (let i = 0; i < pts.length; i += 2) p.push(...this._p(pts[i], pts[i + 1]));
    const [nx, ny, nz] = unit(nrm);
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        if (!inPoly(p, x + 0.5, y + 0.5) || this._clipped(o, x, y)) continue;
        this._put(x, y, z * this.k, this._shade(x, y, nx, ny, nz, rmp, o));
      }
    }
  }

  /** Pillow-shaded box with bevelled edges (unit coords). @param {number} x @param {number} y @param {number} w @param {number} h @param {number} z @param {Ramp} rmp @param {number} bevel @param {ShadeOpts} [o] */
  box(x, y, w, h, z, rmp, bevel, o = {}) {
    const cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => this._p(px, py));
    const r = this.rot;
    for (let py = Math.floor(Math.min(...cs.map((c) => c[1]))); py <= Math.ceil(Math.max(...cs.map((c) => c[1]))); py++) {
      for (let px = Math.floor(Math.min(...cs.map((c) => c[0]))); px <= Math.ceil(Math.max(...cs.map((c) => c[0]))); px++) {
        const [lx, ly] = this._inv(px + 0.5, py + 0.5);
        if (lx < x || lx > x + w || ly < y || ly > y + h || this._clipped(o, px, py)) continue;
        const ex = Math.min(lx - x, x + w - lx);
        const ey = Math.min(ly - y, y + h - ly);
        let nx = ex < bevel ? (lx - x < x + w - lx ? -1 : 1) * (1 - ex / bevel) : 0;
        let ny = ey < bevel ? (ly - y < y + h - ly ? -1 : 1) * (1 - ey / bevel) : 0;
        if (r) [nx, ny] = [nx * r.c - ny * r.s, nx * r.s + ny * r.c];
        const l = Math.hypot(nx, ny, 1);
        this._put(px, py, (z + Math.min(ex, ey, bevel)) * this.k, this._shade(px, py, nx / l, ny / l, 1 / l, rmp, o));
      }
    }
  }

  /**
   * Torus (or arc) built from a capsule chain, so its back half hides behind what it orbits.
   * @param {number} cx @param {number} cy @param {number} cz @param {number} R major radius @param {number} r tube radius
   * @param {number} tilt 0 = facing viewer, ~PI/2 = edge-on @param {number} spin in-plane rotation @param {Ramp} rmp @param {ShadeOpts} [o]
   */
  ring(cx, cy, cz, R, r, tilt, spin, rmp, o = {}) {
    const from = o.from ?? 0;
    const to = o.to ?? Math.PI * 2;
    const seg = Math.max(12, Math.ceil(((to - from) * R) / 3));
    /** @param {number} a */
    const pt = (a) => {
      const lx = R * Math.cos(a);
      const ly = R * Math.sin(a) * Math.cos(tilt);
      return [cx + lx * Math.cos(spin) - ly * Math.sin(spin), cy + lx * Math.sin(spin) + ly * Math.cos(spin), cz + R * Math.sin(a) * Math.sin(tilt)];
    };
    for (let s = 0; s < seg; s++) this.capsule(pt(from + ((to - from) * s) / seg), pt(from + ((to - from) * (s + 1)) / seg), r, r, rmp, o);
  }

  /**
   * Paint along a polyline over pixels already drawn: a number darkens (engraving, cracks),
   * an RGB array replaces the colour (inlays, glowing seams, stitching).
   * @param {number[]} pts flat unit x,y list @param {number|number[]} ink @param {number} [width] unit width
   */
  inlay(pts, ink, width = 1) {
    const rr = Math.max(0.5, (width * this.k) / 2);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const [x0, y0] = this._p(pts[i], pts[i + 1]);
      const [x1, y1] = this._p(pts[i + 2], pts[i + 3]);
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) || 1;
      for (let s = 0; s <= n; s++) {
        const cx = x0 + ((x1 - x0) * s) / n;
        const cy = y0 + ((y1 - y0) * s) / n;
        for (let y = Math.floor(cy - rr); y <= Math.floor(cy + rr); y++) {
          for (let x = Math.floor(cx - rr); x <= Math.floor(cx + rr); x++) {
            if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rr * rr) this._paint(x, y, ink);
          }
        }
      }
    }
  }

  /** Darken along a polyline. @param {number[]} pts @param {number} factor @param {number} [width] */
  scratch(pts, factor, width = 1) {
    this.inlay(pts, factor, width);
  }

  /** @param {number} x @param {number} y @param {number|number[]} ink */
  _paint(x, y, ink) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const o = (y * this.size + x) * 4;
    if (!this.rgba[o + 3]) return;
    if (typeof ink === 'number') for (let c = 0; c < 3; c++) this.rgba[o + c] *= ink;
    else for (let c = 0; c < 3; c++) this.rgba[o + c] = ink[c];
  }

  /** Tiny four-point star glint. @param {number} x @param {number} y @param {number} r */
  sparkle(x, y, r) {
    this.inlay([x - r, y, x + r, y], INK.white, 0.8);
    this.inlay([x, y - r, x, y + r], INK.white, 0.8);
  }

  /** Erase a polygon (chipped crystal). @param {number[]} pts unit coords */
  carve(pts) {
    const p = pts.map((v) => v * this.k);
    const S = this.size;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (!inPoly(p, x + 0.5, y + 0.5)) continue;
        this.rgba[(y * S + x) * 4 + 3] = 0;
        this.depth[y * S + x] = -1e9;
      }
    }
  }

  /** Ambient occlusion, crease lines at depth breaks, a light-aware outline, then a feathered silhouette. */
  finish() {
    const S = this.size;
    const k = this.k;
    const a = this.rgba;
    const z = this.depth;
    const ao = new Uint8ClampedArray(a);
    const r1 = Math.round(2 * k);
    const r2 = Math.round(4 * k);
    // Eight directions at two reaches, as (dx, dy) pairs.
    const D = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, -1, 1, -1, -1, 1];
    const lim = 1.2 * k;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (!a[i * 4 + 3]) continue;
        const zi = z[i] + lim;
        let occ = 0;
        for (let d = 0; d < 16; d += 2) {
          for (let reach = r1; reach <= r2; reach += r2 - r1 || 1) {
            const nx = x + D[d] * reach;
            const ny = y + D[d + 1] * reach;
            if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
            const j = ny * S + nx;
            if (a[j * 4 + 3] && z[j] > zi) occ++;
          }
        }
        const f = 1 - Math.min(0.5, occ * 0.045);
        ao[i * 4] = a[i * 4] * f;
        ao[i * 4 + 1] = a[i * 4 + 1] * f;
        ao[i * 4 + 2] = a[i * 4 + 2] * f;
      }
    }
    const out = new Uint8ClampedArray(ao);
    const crease = 2.5 * k;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        if (ao[i * 4 + 3]) {
          for (let d = 0; d < 8; d += 2) {
            const nx = x + D[d];
            const ny = y + D[d + 1];
            if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
            const j = ny * S + nx;
            if (ao[j * 4 + 3] && z[j] - z[i] > crease) {
              out[i * 4] = ao[i * 4] * 0.5;
              out[i * 4 + 1] = ao[i * 4 + 1] * 0.5;
              out[i * 4 + 2] = ao[i * 4 + 2] * 0.5;
              break;
            }
          }
          continue;
        }
        for (let d = 0; d < 8; d += 2) {
          const nx = x + D[d];
          const ny = y + D[d + 1];
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const j = (ny * S + nx) * 4;
          if (!ao[j + 3]) continue;
          // Outline pixels on the lit (upper-left) side keep some of the surface hue.
          const lit = D[d] > 0 || D[d + 1] > 0 ? 0.42 : 0.14;
          out[i * 4] = ao[j] * lit;
          out[i * 4 + 1] = ao[j + 1] * lit;
          out[i * 4 + 2] = ao[j + 2] * lit + 8;
          out[i * 4 + 3] = 255;
          break;
        }
      }
    }
    // Feathered silhouette: a half-transparent ring outside the outline, so sprite edges
    // blend softly into the scene instead of stair-stepping.
    const soft = new Uint8ClampedArray(out);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        if (out[i + 3]) continue;
        for (let d = 0; d < 16; d += 2) {
          const nx = x + D[d];
          const ny = y + D[d + 1];
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const j = (ny * S + nx) * 4;
          if (out[j + 3] !== 255) continue;
          soft[i] = out[j] * 0.7;
          soft[i + 1] = out[j + 1] * 0.7;
          soft[i + 2] = out[j + 2] * 0.7;
          soft[i + 3] = 84;
          break;
        }
      }
    }
    this.rgba = soft;
  }

  /** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y */
  blit(ctx, x, y) {
    ctx.putImageData(new ImageData(this.rgba, this.size, this.size), x, y);
  }
}

/** Even-odd point-in-polygon. @param {number[]} p flat x,y list @param {number} px @param {number} py */
function inPoly(p, px, py) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > py) !== (p[j + 1] > py) && px < ((p[j] - p[i]) * (py - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
}

/** Deterministic three-stroke rune on a 3x3 grid. @param {Sculpt} S @param {number} x @param {number} y @param {number} s @param {number} seed @param {number|number[]} ink @param {number} [width] */
function glyph(S, x, y, s, seed, ink, width = 1) {
  const r = mulberry32(seed);
  /** @param {number} i */
  const P = (i) => [x + ((i % 3) * s) / 2, y + (Math.floor(i / 3) * s) / 2];
  let cur = Math.floor(r() * 9);
  for (let k = 0; k < 4; k++) {
    const nxt = Math.floor(r() * 9);
    if (nxt !== cur) S.inlay([...P(cur), ...P(nxt)], ink, width);
    cur = nxt;
  }
}

/** Two-facet blade with a fuller groove and edge notches. @param {Sculpt} S @param {number[]} a @param {number[]} b @param {number} w */
function blade(S, a, b, w) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const px = -dy / l;
  const py = dx / l;
  const z = (a[2] + b[2]) / 2 + 3;
  S.poly([a[0] + px * w, a[1] + py * w, a[0], a[1], b[0], b[1]], z, [px * 0.8, py * 0.8, 0.6], PAL.steel);
  S.poly([a[0] - px * w * 0.6, a[1] - py * w * 0.6, a[0], a[1], b[0], b[1]], z, [-px * 0.8, -py * 0.8, 0.6], PAL.steel);
  S.capsule([a[0], a[1], z], [b[0], b[1], z], 0.8, 0.4, PAL.steel);
  S.scratch([a[0] + px * w * 0.45 + dx * 0.1, a[1] + py * w * 0.45 + dy * 0.1, a[0] + px * w * 0.2 + dx * 0.6, a[1] + py * w * 0.2 + dy * 0.6], 0.55, 0.8);
  for (let t = 0.2; t < 0.7; t += 0.12) {
    const x = a[0] + dx * t + px * w * (1 - t);
    const y = a[1] + dy * t + py * w * (1 - t);
    S.scratch([x, y, x - px * 1.6 + dx * 0.02, y - py * 1.6 + dy * 0.02], 0.4, 0.8);
  }
}

/** Ring of rivets on an ellipse. @param {Sculpt} S @param {number} cx @param {number} cy @param {number} cz @param {number} rx @param {number} ry @param {number} n @param {number} r */
function rivetRing(S, cx, cy, cz, rx, ry, n, r) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    S.sphere(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, cz + Math.sin(a) * 2, r, PAL.brass);
  }
}

/** Pendulum Stalker. @param {Sculpt} S @param {number} pose 0 idle, 1 walk, 2 windup, 3 lunge */
function sculptStalker(S, pose) {
  const walk = pose === 1;
  const wind = pose === 2;
  const lunge = pose === 3;
  const by = walk ? -2 : lunge ? 3 : 0;
  const core = wind ? PAL.gWhite : PAL.gCyan;
  for (const side of [-1, 1]) {
    const stride = walk ? side * 7 : 0;
    const hip = [64 + side * 8, 76 + by, 0];
    const knee = [64 + side * 13 + stride * 0.4, 95 + by * 0.5, 8];
    const ankle = [64 + side * 10 + stride, 112, 2];
    const toe = [64 + side * 13 + stride, 123, 10];
    S.capsule(hip, knee, 5.5, 4, PAL.brass);
    S.inlay([hip[0] - 2, hip[1] + 4, knee[0] - 2, knee[1] - 4], 0.6, 0.7);
    S.sphere(knee[0], knee[1], knee[2] + 1, 4.5, PAL.brass);
    S.sphere(knee[0], knee[1], knee[2] + 5, 1.4, PAL.steel);
    S.capsule(knee, ankle, 3.2, 2.4, PAL.steel);
    S.capsule([knee[0] - side * 3, knee[1] + 2, 4], [ankle[0] - side * 2, ankle[1] - 5, 0], 1.3, 1.3, PAL.obsidian);
    S.sphere(ankle[0], ankle[1], ankle[2], 3, PAL.brass);
    S.capsule(ankle, toe, 2.6, 1.6, PAL.steel);
    S.capsule(ankle, [ankle[0] - side * 7, 123, 0], 1.8, 1, PAL.steel);
    S.capsule(ankle, [ankle[0] + side * 2, 124, 6], 1.4, 0.8, PAL.steel);
  }
  // Pelvis: toothed gear with hub.
  S.ring(64, 76 + by, 3, 10, 2.4, 1.25, 0, PAL.brass);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    S.sphere(64 + Math.cos(a) * 12.5, 76 + by + Math.sin(a) * 12.5 * Math.cos(1.25), 3 + Math.sin(a) * 12.5 * Math.sin(1.25), 1.5, PAL.brass);
  }
  S.sphere(64, 76 + by, 4, 4, PAL.brass);
  // Pendulum with an etched glyph ring around its glowing gem.
  const sw = wind ? 15 : lunge ? -9 : walk ? 4 : 0;
  S.capsule([64, 78 + by, 6], [64 + sw, 101, 10], 1.3, 1.3, PAL.steel);
  S.sphere(64 + sw, 104, 10, 7, PAL.brass, { sx: 1.6, sy: 0.7 });
  S.inlay(arcPts(64 + sw, 104, 8.5, 3.2, 0, Math.PI * 2, 20), 0.55, 0.7);
  S.sphere(64 + sw, 104, 14, 2.4, core, { emit: true });
  // Torso: chassis plate with filigree, ribs, rivets, cables and a caged resonance core.
  S.box(50, 36 + by, 28, 36, 2, PAL.brass, 7);
  S.scratch(spiralPts(56.5, 43 + by, 4.5, 1.3, 1, Math.PI), 0.55, 0.8);
  S.scratch(spiralPts(71.5, 43 + by, 4.5, 1.3, -1, 0), 0.55, 0.8);
  S.inlay(spiralPts(56, 42.5 + by, 4.5, 1.3, 1, Math.PI), INK.gold, 0.5);
  S.inlay(spiralPts(71, 42.5 + by, 4.5, 1.3, -1, 0), INK.gold, 0.5);
  for (let k = 0; k < 3; k++) S.capsule([54, 60 + k * 4 + by, 8], [74, 60 + k * 4 + by, 8], 1.5, 1.5, PAL.brass);
  S.sphere(64, 49 + by, 7, 6.5, PAL.obsidian);
  S.sphere(64, 49 + by, 10, 4.2, core, { emit: true });
  for (let k = -1; k <= 1; k++) S.capsule([64 + k * 3, 43 + by, 13], [64 + k * 3, 55 + by, 13], 0.7, 0.7, PAL.brass);
  for (const [x, y] of [[53, 39], [75, 39], [53, 71], [75, 71], [64, 39]]) S.sphere(x, y + by, 9, 1.4, PAL.brass);
  S.capsule([51, 52 + by, 6], [44, 44 + by, 3], 1.1, 1.1, PAL.obsidian);
  S.capsule([77, 52 + by, 6], [84, 44 + by, 3], 1.1, 1.1, PAL.obsidian);
  // Neck and head: riveted dome, visor with vents, single eye and crest.
  S.capsule([64, 37 + by, 2], [64, 28 + by, 2], 3.2, 2.6, PAL.steel);
  for (let k = 0; k < 3; k++) S.inlay([61, 30 + k * 2.5 + by, 67, 30 + k * 2.5 + by], 0.55, 0.6);
  S.sphere(64, 19 + by, 2, 11, PAL.brass, { sy: 1.05 });
  S.scratch(arcPts(64, 19 + by, 10, 10.5, Math.PI * 1.05, Math.PI * 1.95), 0.55, 0.7);
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (1.1 + (i / 6) * 0.8);
    S.sphere(64 + Math.cos(a) * 8.5, 19 + by + Math.sin(a) * 9, 9, 0.9, PAL.brass);
  }
  S.box(55, 16 + by, 18, 7, 9, PAL.obsidian, 2);
  S.inlay([57, 18 + by, 60, 18 + by], wind ? INK.white : INK.amber, 0.6);
  S.inlay([68, 18 + by, 71, 18 + by], wind ? INK.white : INK.amber, 0.6);
  S.sphere(64, 19.5 + by, 13, wind ? 3.4 : 2.6, wind ? PAL.gWhite : PAL.gAmber, { emit: true });
  S.poly([64, 4 + by, 68, 10 + by, 64, 13 + by, 60, 10 + by], 9, [0, -0.6, 0.8], PAL.brass);
  S.inlay([64, 6 + by, 64, 12 + by], 0.6, 0.6);
  for (const side of [-1, 1]) {
    const m = (/** @type {number} */ x) => (side < 0 ? x : 128 - x);
    const sh = [m(48), 40 + by, 4];
    /** @type {number[]} */ let el;
    /** @type {number[]} */ let wr;
    /** @type {number[]} */ let tip;
    if (wind) { el = [m(36), 24 + by, 4]; wr = [m(38), 12 + by, 6]; tip = [m(62), 3, 10]; }
    else if (lunge) { el = [m(30), 46 + by, 10]; wr = [m(18), 52 + by, 16]; tip = [m(3), 62, 30]; }
    else {
      const s = walk ? -side * 3 : 0;
      el = [m(40), 60 + by + s, 4]; wr = [m(37), 72 + by + s, 6]; tip = [m(33), 112 + s, 10];
    }
    S.sphere(sh[0], sh[1], sh[2] + 2, 6, PAL.brass, { sy: 0.85 });
    rivetRing(S, sh[0], sh[1] - 1, sh[2] + 6, 3.6, 2.4, 6, 0.8);
    S.capsule(sh, el, 3.6, 3, PAL.steel);
    S.sphere(el[0], el[1], el[2] + 1, 3.8, PAL.brass);
    S.sphere(el[0], el[1], el[2] + 4.5, 1.2, PAL.steel);
    S.capsule(el, wr, 3.4, 3.8, PAL.brass);
    S.ring(wr[0], wr[1], wr[2], 4, 1, 1.2, Math.atan2(wr[1] - el[1], wr[0] - el[0]) + Math.PI / 2, PAL.steel);
    blade(S, wr, tip, 5);
  }
}

/** Censer Weaver. @param {Sculpt} S @param {number} pose 0/1 swing, 2 charging */
function sculptWeaver(S, pose) {
  const off = pose === 0 ? -3 : pose === 1 ? 3 : 0;
  const hot = pose === 2;
  const holes = hot ? PAL.gWhite : PAL.gViolet;
  const cx = 64 + off;
  const cy = 68;
  const r = 26;
  // Chains of interlocking links.
  for (const ex of [-15, 0, 15]) {
    const a = [64, 4];
    const b = [cx + ex, cy - r + 4 + Math.abs(ex) * 0.4];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3.6);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      S.ring(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, -3, 2.2, 0.75, k % 2 ? 1.45 : 0.35, ang, PAL.brass);
    }
  }
  // Crown with finial and petals.
  S.sphere(cx, cy - r - 5, 6, 3.5, PAL.brass);
  S.capsule([cx, cy - r - 3, 6], [cx, cy - r + 1, 6], 1.6, 2.4, PAL.brass);
  S.sphere(cx, cy - r + 3, 4, 11, PAL.brass, { sy: 0.5 });
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * (0.05 + i * 0.18);
    S.sphere(cx + Math.cos(a) * 10, cy - r + 4 + Math.sin(a) * 2, 8, 2, PAL.brass, { sy: 0.7 });
  }
  // Body with engraved latitude bands.
  S.sphere(cx, cy, 0, r, PAL.brass);
  for (const lat of [-0.27, 0.25, 0.7]) {
    const yy = cy + lat * r;
    const rr = Math.sqrt(1 - lat * lat) * r;
    S.scratch(arcPts(cx, yy - 2, rr * 0.97, 3, 0.05 * Math.PI, 0.95 * Math.PI, 28), 0.55, 0.8);
  }
  // Perforations: violet glow with a hot ember inside each.
  for (const [lat, n] of [[-0.5, 5], [0.0, 7], [0.48, 5]]) {
    const yy = cy + lat * r;
    const rr = Math.sqrt(1 - lat * lat) * r;
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + ((k + 0.5) / n) * Math.PI;
      const x = cx + Math.sin(a) * rr * 0.9;
      const dx = x - cx;
      const dy = yy - cy;
      const zs = Math.sqrt(Math.max(0, r * r - dx * dx - dy * dy));
      const hr = 2.8 * (0.45 + 0.55 * Math.cos(a)) + 0.5;
      S.sphere(x, yy, zs - hr * 0.7, hr, PAL.obsidian);
      S.sphere(x, yy, zs - hr * 0.4, hr * 0.75, holes, { emit: true });
      S.sphere(x - hr * 0.15, yy - hr * 0.15, zs + hr * 0.2, hr * 0.32, PAL.gWhite, { emit: true });
    }
  }
  // Equatorial band with rivets, verdigris collar.
  S.ring(cx, cy + 5, 0, r + 1.5, 2.2, 1.35, 0, PAL.brass);
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.08 + (i / 8) * 0.84);
    const R = r + 2.4;
    S.sphere(cx + Math.cos(a) * R, cy + 5 + Math.sin(a) * R * Math.cos(1.35), Math.sin(a) * R * Math.sin(1.35) + 1.6, 0.9, PAL.brass);
  }
  S.ring(cx, cy - 10, 0, r - 4, 1.4, 1.4, 0, PAL.verdigris);
  // Lower finial and glowing drip.
  S.capsule([cx, cy + r - 3, 4], [cx, cy + r + 12, 4], 5, 1.5, PAL.brass);
  S.ring(cx, cy + r + 1, 4, 4.5, 1, 1.35, 0, PAL.brass);
  S.sphere(cx, cy + r + 14, 6, 3, holes, { emit: true });
  // Incense smoke curling from the crown.
  for (const [dx, dy, s] of [[-7, -32, 3.2], [-10, -37, 2.6], [-8, -42, 2], [8, -34, 2.6], [11, -39, 2]]) {
    S.sphere(cx + dx + off * 0.5, cy + dy, -2, s, PAL.smoke);
  }
  if (hot) {
    S.ring(cx, cy, 0, r + 10, 1.6, 0.25, 0.3, PAL.gViolet, { emit: true });
    S.ring(cx, cy, 0, r + 15, 1.2, 0.55, -0.4, PAL.gViolet, { emit: true });
  }
}

/** Obelisk Warden. @param {Sculpt} S @param {boolean} slam */
function sculptWarden(S, slam) {
  for (const [x, y, s] of [[50, 120, 5], [64, 123, 4], [78, 119, 5], [42, 114, 2.5], [86, 112, 2], [58, 126, 2]]) S.sphere(x, y, 0, s, PAL.basalt, { sy: 0.7 });
  S.poly([46, 114, 64, 114, 64, 18, 54, 22], 0, [-0.55, 0, 0.83], PAL.basalt);
  S.poly([64, 114, 82, 114, 74, 22, 64, 18], 0, [0.55, 0, 0.83], PAL.basalt);
  // Masonry joints and weathering.
  for (const y of [30, 58, 84]) {
    S.scratch([46, y, 82, y], 0.5, 0.8);
    S.scratch([46, y + 1, 82, y + 1], 1.25, 0.6);
  }
  for (const [x, y0, y1] of [[57, 30, 40], [71, 58, 84], [58, 84, 96]]) S.scratch([x, y0, x, y1], 0.5, 0.8);
  S.poly([54, 22, 64, 18, 64, 4], 2, [-0.5, -0.5, 0.7], PAL.brass);
  S.poly([64, 18, 74, 22, 64, 4], 2, [0.5, -0.4, 0.75], PAL.brass);
  S.inlay([64, 5, 64, 18], INK.gold, 0.6);
  for (const [x, y, s] of [[52, 104, 3], [57, 110, 2.5], [75, 100, 3], [70, 108, 2], [79, 70, 2], [49, 46, 2]]) S.sphere(x, y, 1, s, PAL.verdigris, { sy: 0.5 });
  // Glowing fracture seeping aether.
  S.inlay([75, 62, 72, 68, 76, 74, 73, 80, 77, 88], INK.cyan, 1);
  S.inlay([75, 62, 72, 68, 76, 74, 73, 80, 77, 88], INK.white, 0.4);
  S.scratch([52, 70, 55, 78, 51, 86], 0.45, 0.9);
  // Carved side glyphs.
  for (let k = 0; k < 4; k++) {
    glyph(S, 50, 34 + k * 14, 6, 101 + k, 0.45, 0.8);
    glyph(S, 74, 34 + k * 14, 6, 201 + k, 0.45, 0.8);
  }
  // Brass bands with a meander of rivets.
  S.box(50, 40, 28, 5, 2, PAL.brass, 2);
  S.box(47, 96, 34, 6, 2, PAL.brass, 2);
  for (let x = 52; x <= 76; x += 4) S.sphere(x, 42.5, 4.4, 0.8, PAL.brass);
  for (let x = 50; x <= 78; x += 4) S.sphere(x, 99, 4.4, 0.8, PAL.brass);
  // Rune column.
  for (let k = 0; k < 7; k++) {
    const y = 50 + k * 6.3;
    S.box(61, y, 6, 3.5, 3, PAL.gCyan, 1, { emit: true });
    if (k % 2) S.box(58, y + 1, 12, 1.5, 3, PAL.gCyan, 0.5, { emit: true });
  }
  S.poly([64, 26, 69, 32, 64, 38, 59, 32], 4, [0, 0, 1], slam ? PAL.gWhite : PAL.gCyan, { emit: true });
  S.inlay([64, 28, 64, 36], INK.white, 0.6);
  // Floating stone hands with brass knuckle bands and finger joints.
  const hy = slam ? 14 : 56;
  for (const hx of [26, 102]) {
    S.box(hx - 9, hy, 18, 22, 6, PAL.basalt, 4);
    for (const fx of [-4.5, 0, 4.5]) S.scratch([hx + fx, hy + 14, hx + fx, hy + 22], 0.45, 0.8);
    S.box(hx - 10, hy + 3, 20, 3.5, 10, PAL.brass, 1.5);
    S.box(hx - 10, hy + 10, 20, 3.5, 10, PAL.brass, 1.5);
    for (const fx of [-6, 0, 6]) { S.sphere(hx + fx, hy + 4.7, 12, 0.8, PAL.brass); S.sphere(hx + fx, hy + 11.7, 12, 0.8, PAL.brass); }
    S.capsule([hx - 5, hy + 17, 14], [hx + 5, hy + 17, 14], 1.2, 1.2, PAL.gCyan, { emit: true });
    if (slam) {
      S.ring(hx, hy + 11, 8, 17, 1.5, 0.3, 0, PAL.gCyan, { emit: true });
      S.ring(hx, hy + 11, 8, 12, 0.8, 0.5, 0.6, PAL.gWhite, { emit: true });
    }
  }
}

/** Harmonic Anchor: faceted crystal on a brass pedestal with orbiting rings. @param {Sculpt} S @param {boolean} cracked */
function sculptAnchor(S, cracked) {
  S.sphere(64, 118, 0, 26, PAL.brass, { sy: 0.28 });
  S.scratch(arcPts(64, 118, 22, 5.5, 0.1, Math.PI - 0.1), 0.55, 0.8);
  for (let i = 0; i < 9; i++) {
    const a = 0.25 + (i / 8) * (Math.PI - 0.5);
    S.inlay([64 + Math.cos(a) * 19, 118 + Math.sin(a) * 4.5, 64 + Math.cos(a) * 24, 118 + Math.sin(a) * 6], INK.gold, 0.6);
  }
  S.box(46, 104, 36, 12, 2, PAL.brass, 4);
  for (let k = 0; k < 4; k++) glyph(S, 49 + k * 8.5, 107, 5, 300 + k, INK.cyan, 0.7);
  S.sphere(64, 104, 4, 18, PAL.brass, { sy: 0.3 });
  S.ring(64, 110, 0, 22, 1.6, 1.4, 0, PAL.verdigris);
  const T = [64, 6];
  const L = [44, 52];
  const R = [84, 52];
  const B = [64, 100];
  const C = [64, 54];
  const ML = [54, 50];
  const MR = [74, 50];
  /** @type {[number[][], number, number[]][]} */
  const facets = [
    [[T, L, ML], 8, [-0.75, -0.35, 0.55]], [[T, ML, C], 12, [-0.3, -0.3, 0.9]],
    [[T, C, MR], 12, [0.3, -0.3, 0.9]], [[T, MR, R], 8, [0.75, -0.3, 0.6]],
    [[L, B, ML], 8, [-0.7, 0.4, 0.6]], [[ML, B, C], 12, [-0.25, 0.35, 0.9]],
    [[C, B, MR], 12, [0.25, 0.35, 0.9]], [[MR, B, R], 8, [0.7, 0.4, 0.6]],
  ];
  for (const [pts, z, n] of facets) S.poly(pts.flat(), z, n, PAL.crystal);
  // Internal refraction lines and glints.
  S.inlay([60, 18, 56, 44, 60, 70, 58, 88], INK.pale, 0.6);
  S.inlay([68, 24, 71, 46, 67, 66], INK.pale, 0.5);
  S.inlay([50, 52, 62, 60, 78, 52], [31, 176, 200], 0.5);
  S.sphere(64, 54, 13, 4.5, PAL.gWhite, { emit: true });
  // Brass claws gripping the base of the crystal.
  for (const [x0, x1, z] of [[50, 56, 6], [78, 72, 6], [64, 64, 10]]) {
    S.capsule([x0, 104, z], [x1, 92, z + 2], 2.2, 1.2, PAL.brass);
    S.sphere(x1, 91, z + 2, 1.3, PAL.brass);
  }
  S.ring(64, 50, 10, 30, 2, 1.25, 0.15, PAL.brass);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const lx = 30 * Math.cos(a);
    const ly = 30 * Math.sin(a) * Math.cos(1.25);
    S.sphere(64 + lx * Math.cos(0.15) - ly * Math.sin(0.15), 50 + lx * Math.sin(0.15) + ly * Math.cos(0.15), 10 + 30 * Math.sin(a) * Math.sin(1.25) + 1.5, 0.9, PAL.brass);
  }
  S.ring(64, 68, 10, 22, 1.6, 1.3, -0.2, PAL.brass);
  if (cracked) {
    for (const seg of [[56, 20, 63, 36], [63, 36, 58, 50], [58, 50, 68, 66], [68, 66, 62, 84], [63, 36, 72, 42], [58, 50, 50, 54], [68, 66, 74, 70]]) S.scratch(seg, 0.25, 0.9);
    S.inlay([63, 36, 58, 50, 68, 66], INK.white, 0.35);
    S.carve([76, 40, 85, 52, 77, 55]);
  } else {
    S.sparkle(58, 26, 2.5);
    S.sparkle(71, 70, 2);
  }
}


// ---------------------------------------------------------------------------
// Shardlands sprite set: people, flora, props, item icons and hand viewmodels.
// ---------------------------------------------------------------------------

/** Extra material ramps for townsfolk, flora and props. */
const PAL2 = {
  skin: material(ramp('#3a1e14', '#6b3a26', '#a0634a', '#c98a6a', '#e8b496', '#fff0e0'), 'leather'),
  skinDark: material(ramp('#1e0f0a', '#3a2014', '#5e3624', '#82503a', '#a8735a', '#e0b8a0'), 'leather'),
  hair: material(ramp('#120a06', '#2a180e', '#4a2c18', '#6b4226', '#8f6040'), 'leather'),
  hairGrey: material(ramp('#2a2a30', '#4a4a52', '#77777f', '#a8a8b0', '#e0e0e6'), 'leather'),
  hairRed: material(ramp('#2a0a04', '#5a1a08', '#8a3010', '#b8501c', '#e08040'), 'leather'),
  crimson: material(ramp('#2a0610', '#5a1020', '#8a1c30', '#b83040', '#e05a5a', '#ffb0a0'), 'leather'),
  teal: material(ramp('#04201e', '#0a3a38', '#145a56', '#1f7f78', '#36a89e', '#9ee8dc'), 'leather'),
  ochre: material(ramp('#2a1a04', '#5a3a0c', '#8a5c18', '#b8862a', '#e0b04a', '#fff0b0'), 'leather'),
  slate: material(ramp('#101420', '#1e2434', '#2e3850', '#44506e', '#64729a', '#b0bce0'), 'leather'),
  forest: material(ramp('#08180c', '#123018', '#1e4a26', '#2c6a36', '#48924e', '#a8e0a0'), 'leather'),
  cream: material(ramp('#3a3020', '#6a5a40', '#9a8a68', '#c8b892', '#ece0c0', '#ffffff'), 'leather'),
  wood: material(ramp('#140a04', '#2e1a0a', '#4e2e14', '#704420', '#946030', '#c09060'), 'leather'),
  bark: material(ramp('#0e0a08', '#22180f', '#3a2a1a', '#544028', '#70583a'), 'stone'),
  leaf: material(ramp('#04140f', '#0a2a20', '#124232', '#1c5e46', '#2a7e5c', '#5ab08a', '#b0f0c8'), 'stone'),
  pine: material(ramp('#030c08', '#081a12', '#0f2c1e', '#18402c', '#245a3c', '#5a9070'), 'stone'),
  reed: material(ramp('#141206', '#2e2a10', '#4e4820', '#706830', '#9a9050', '#d0c890'), 'leather'),
  stone: material(ramp('#18161a', '#2e2c32', '#48464e', '#66636e', '#8a8794', '#b8b4c4'), 'stone'),
  lime: material(ramp('#2a2620', '#4e483c', '#787060', '#a49a84', '#cac0a6', '#f0e8d4'), 'stone'),
  lotus: material(ramp('#3a1020', '#7a2a50', '#c05a8a', '#ee9ac0', '#ffd8ea', '#ffffff'), 'crystal'),
  pad: material(ramp('#06180a', '#0e3014', '#1a4a20', '#2a6a30', '#4a9050'), 'leather'),
  mana: material(ramp('#06103a', '#0e2070', '#1a3ab0', '#3a6ae0', '#7aa0ff', '#d0e0ff'), 'crystal'),
  frost: material(ramp('#0a2a40', '#1a5070', '#3a88b0', '#7ac0e0', '#c0eaff', '#ffffff'), 'crystal'),
  paper: material(ramp('#4a4030', '#7a6a50', '#a89878', '#d0c4a4', '#f0e8d0'), 'leather'),
  fire: ramp('#7a1a04', '#d84a10', '#ff9a3c', '#ffd27a', '#fff6e0'),
  ember: ramp('#5a1004', '#a82808', '#e85a14', '#ff9a3c', '#ffd27a'),
  gGreen: ramp('#0e5a20', '#3ad06a', '#a0ffb8', '#ffffff'),
  gRed: ramp('#5a0a0a', '#e03a3a', '#ffa0a0', '#ffffff'),
  gIce: ramp('#1a5070', '#7ac0e0', '#e0f6ff', '#ffffff'),
};

/**
 * A front-facing townsperson.
 * @param {Sculpt} S
 * @param {{coat:Ramp, legs?:Ramp, skin?:Ramp, hair?:Ramp, hat?:'cap'|'helm'|'hood'|'tophat'|'none', apron?:boolean,
 *   robe?:boolean, goggles?:boolean, spear?:boolean, mug?:boolean, beard?:boolean, sash?:Ramp, walk?:boolean}} o
 */
function sculptPerson(S, o) {
  const skin = o.skin || PAL2.skin;
  const hair = o.hair || PAL2.hair;
  const walk = !!o.walk;
  const by = walk ? -1.5 : 0;
  if (o.robe) {
    S.capsule([64, 60 + by, 0], [64, 112, 0], 13, 21, o.coat);
    for (let k = -2; k <= 2; k++) {
      S.inlay([64 + k * 4.5, 70 + by, 64 + k * 7.5, 116], 0.68, 1);
      S.inlay([65.5 + k * 4.5, 70 + by, 65.5 + k * 7.5, 116], 1.2, 0.7);
    }
    for (const side of [-1, 1]) S.sphere(64 + side * 8 + (walk ? side * 2 : 0), 119, 6, 5, PAL.leather, { sy: 0.6 });
  } else {
    for (const side of [-1, 1]) {
      const swing = walk ? side * 5 : 0;
      const hip = [64 + side * 6, 72 + by, 0];
      const knee = [64 + side * 7 + swing * 0.5, 95, 4];
      const ankle = [64 + side * 7 + swing, 114, 2];
      S.capsule(hip, knee, 5.5, 4.6, o.legs || PAL2.slate);
      S.capsule(knee, ankle, 4.6, 4, o.legs || PAL2.slate);
      S.capsule([ankle[0], 108, 4], [ankle[0], 117, 6], 5, 5, PAL.leather);
      S.sphere(ankle[0], 120, 9, 4.2, PAL.leather, { sy: 0.7 });
    }
  }
  S.capsule([64, 40 + by, 2], [64, 66 + by, 2], 13, 14, o.coat);
  // Fabric folds: paired shadow and highlight creases down the coat.
  for (const fx of [56, 64, 72]) {
    S.inlay([fx, 45 + by, fx - 1.5, 64 + by], 0.7, 0.9);
    S.inlay([fx + 1.2, 45 + by, fx - 0.3, 64 + by], 1.18, 0.6);
  }
  S.ring(64, 66 + by, 2, 13.5, 1.6, 1.35, 0, PAL.leather);
  S.sphere(64, 67 + by, 16, 2.2, PAL.brass);
  if (o.sash) S.capsule([53, 42 + by, 14], [76, 64 + by, 14], 2.6, 2.6, o.sash);
  if (o.apron) {
    S.box(54, 50 + by, 20, 34, 13, PAL2.cream, 4);
    S.inlay([56, 62 + by, 72, 62 + by], 0.7, 0.8);
  } else for (let k = 0; k < 4; k++) S.sphere(64, 46 + by + k * 5, 15, 1.1, PAL.brass);
  S.ring(64, 38 + by, 4, 8, 2.2, 1.25, 0, o.coat);
  for (const side of [-1, 1]) {
    const sw = walk ? -side * 3 : 0;
    const sh = [64 + side * 13, 42 + by, 2];
    const el = [64 + side * 17, 60 + by + sw, 4];
    const hand = [64 + side * 16, 76 + by + sw, 8];
    S.sphere(sh[0], sh[1], sh[2] + 2, 5.5, o.coat);
    S.capsule(sh, el, 5, 4.2, o.coat);
    S.capsule(el, hand, 4.2, 3.6, o.coat);
    S.sphere(hand[0], hand[1] + 2, hand[2] + 2, 3.6, skin);
    if (o.spear && side > 0) {
      S.capsule([hand[0] + 2, 122, 10], [hand[0] + 2, 6, 10], 1.4, 1.4, PAL2.wood);
      S.poly([hand[0] + 2, -2, hand[0] + 6, 10, hand[0] + 2, 14, hand[0] - 2, 10], 12, [0.4, -0.3, 0.8], PAL.steel);
      S.ring(hand[0] + 2, 15, 11, 2.2, 0.8, 1.3, 0, PAL.brass);
    }
    if (o.mug && side < 0) {
      S.capsule([hand[0] - 2, hand[1] - 3, 14], [hand[0] - 2, hand[1] + 7, 14], 4.5, 4.5, PAL2.wood);
      S.ring(hand[0] - 2, hand[1], 16, 4.6, 0.8, 1.3, 0, PAL.brass);
      S.sphere(hand[0] - 2, hand[1] - 4, 15, 4, PAL2.cream, { sy: 0.5 });
    }
  }
  S.capsule([64, 38 + by, 0], [64, 29 + by, 0], 4.2, 4.2, skin);
  S.sphere(64, 21 + by, 0, 10, skin, { sy: 1.08 });
  S.sphere(60, 21 + by, 9, 1.3, PAL.obsidian);
  S.sphere(68, 21 + by, 9, 1.3, PAL.obsidian);
  S.sphere(64, 24.5 + by, 10, 1.6, skin);
  S.inlay([61.5, 28 + by, 66.5, 28 + by], 0.55, 0.8);
  S.sphere(64, 16 + by, -1, 10.6, hair, { sy: 0.8, clip: (_x, y) => y < 18 + by });
  for (const side of [-1, 1]) S.capsule([64 + side * 9.5, 15 + by, -2], [64 + side * 9, 26 + by, -2], 2.4, 1.6, hair);
  if (o.beard) S.sphere(64, 30 + by, 5, 7.5, hair, { sy: 0.75, clip: (_x, y) => y > 26 + by });
  if (o.goggles) {
    S.capsule([54, 18 + by, 6], [74, 18 + by, 6], 1.2, 1.2, PAL.leather);
    for (const x of [59.5, 68.5]) { S.ring(x, 18.5 + by, 9, 3.2, 1.1, 0, 0, PAL.brass); S.sphere(x, 18.5 + by, 9, 2.4, PAL.gCyan, { emit: true }); }
  }
  if (o.hat === 'cap') {
    S.sphere(64, 13 + by, 0, 10.8, o.sash || PAL2.forest, { sy: 0.55, clip: (_x, y) => y < 15 + by });
    S.sphere(64, 14 + by, 6, 9, o.sash || PAL2.forest, { sy: 0.2 });
  } else if (o.hat === 'helm') {
    S.sphere(64, 15 + by, 0, 11.4, PAL.brass, { sy: 0.7, clip: (_x, y) => y < 18 + by });
    S.ring(64, 17 + by, 0, 11.2, 1.2, 1.3, 0, PAL.brass);
    S.capsule([64, 4 + by, 4], [64, 14 + by, 8], 1.6, 1.6, PAL2.crimson);
  } else if (o.hat === 'hood') {
    S.sphere(64, 20 + by, -4, 13.5, o.sash || o.coat, { sy: 1.1, clip: (_x, y) => y < 17 + by || Math.abs(_x - 64) > 9.5 });
  } else if (o.hat === 'tophat') {
    S.capsule([64, 10 + by, 0], [64, -2 + by, 0], 7.5, 7, PAL.obsidian);
    S.ring(64, 10 + by, 0, 12, 1.4, 1.35, 0, PAL.obsidian);
    S.ring(64, 7 + by, 0, 7.8, 1.2, 1.35, 0, PAL.brass);
  }
}

/** Ley-wood tree with glowing blossoms. @param {Sculpt} S */
function sculptLeyTree(S) {
  S.capsule([64, 126, 0], [64, 70, 0], 8, 5, PAL2.bark);
  for (const [x, y] of [[40, 52], [90, 48], [60, 40], [74, 58]]) S.capsule([64, 80, 2], [x, y, 4], 3, 1.6, PAL2.bark);
  for (const [x, y, r] of [[40, 46, 20], [88, 42, 21], [64, 30, 24], [52, 60, 16], [78, 62, 16], [64, 14, 15]]) S.sphere(x, y, 0, r, PAL2.leaf);
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    S.sphere(64 + Math.cos(a) * (26 + (k % 3) * 7), 40 + Math.sin(a) * 22, 22, 1.8, PAL.gCyan, { emit: true });
  }
}

/** Dark pine of the Ley-Wood. @param {Sculpt} S */
function sculptPine(S) {
  S.capsule([64, 126, 0], [64, 80, 0], 5, 3.5, PAL2.bark);
  for (const [top, base, half] of [[8, 54, 22], [30, 82, 30], [54, 108, 38]]) {
    S.poly([64, top, 64 - half, base, 64, base + 4], 6, [-0.6, -0.2, 0.75], PAL2.pine);
    S.poly([64, top, 64, base + 4, 64 + half, base], 6, [0.6, -0.2, 0.75], PAL2.pine);
    S.inlay([64 - half * 0.6, base - 2, 64, base + 2, 64 + half * 0.6, base - 2], 0.6, 1);
  }
}

/** Twisted dead tree with hanging moss. @param {Sculpt} S */
function sculptDeadTree(S) {
  S.capsule([64, 126, 0], [60, 60, 0], 7, 4, PAL2.bark);
  S.capsule([60, 60, 0], [70, 20, 2], 4, 2, PAL2.bark);
  for (const [x0, y0, x1, y1] of [[61, 78, 30, 50], [62, 66, 96, 40], [64, 40, 44, 16], [68, 30, 92, 12], [30, 50, 18, 46], [96, 40, 108, 46]]) S.capsule([x0, y0, 2], [x1, y1, 4], 2.4, 1.2, PAL2.bark);
  for (const [x, y] of [[34, 52], [92, 44], [48, 20]]) S.capsule([x, y, 6], [x + 1, y + 16, 6], 1.6, 0.6, PAL2.reed);
}

/** @param {Sculpt} S */
function sculptReeds(S) {
  for (let k = 0; k < 11; k++) {
    const x = 34 + k * 6;
    const top = 30 + ((k * 37) % 30);
    const lean = ((k * 13) % 9) - 4;
    S.capsule([x, 126, 0], [x + lean, top, 2], 1.6, 0.8, PAL2.reed);
    if (k % 3 === 0) S.sphere(x + lean, top + 6, 4, 2.4, PAL2.wood, { sy: 2.2 });
  }
}

/** @param {Sculpt} S */
function sculptRock(S) {
  S.sphere(52, 92, 0, 28, PAL2.stone, { sy: 0.75 });
  S.sphere(80, 98, 4, 22, PAL2.stone, { sy: 0.7 });
  S.sphere(66, 76, 2, 18, PAL2.stone, { sy: 0.8 });
  for (const [x, y] of [[44, 74], [58, 64], [86, 84]]) S.sphere(x, y, 20, 4, PAL.verdigris, { sy: 0.5 });
  S.scratch([40, 96, 54, 88, 62, 100], 0.55, 1);
}

/** @param {Sculpt} S @param {boolean} open */
function sculptChest(S, open) {
  S.box(30, 70, 68, 42, 0, PAL2.wood, 4);
  if (open) {
    S.poly([30, 72, 98, 72, 92, 40, 36, 40], -6, [0, -0.3, 0.9], PAL2.wood);
    S.box(34, 66, 60, 8, 6, PAL.obsidian, 2);
    for (const [x, r] of [[48, 5], [60, 6], [74, 5], [84, 4]]) S.sphere(x, 68, 14, r, PAL.gGold, { emit: true });
  } else {
    S.box(30, 50, 68, 22, 2, PAL2.wood, 6);
    S.box(60, 64, 8, 12, 14, PAL.brass, 2);
    S.inlay([64, 68, 64, 72], 0.3, 1.2);
  }
  for (const x of [36, 88]) S.box(x, open ? 70 : 50, 6, open ? 42 : 62, 8, PAL.brass, 1.5);
  for (const [x, y] of [[33, 74], [95, 74], [33, 108], [95, 108]]) S.sphere(x, y, 10, 1.4, PAL.brass);
}

/** @param {Sculpt} S @param {number} phase */
function sculptCampfire(S, phase) {
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    S.sphere(64 + Math.cos(a) * 30, 112 + Math.sin(a) * 8, Math.sin(a) * 8, 6, PAL2.stone, { sy: 0.7 });
  }
  S.capsule([40, 116, 4], [88, 100, 2], 4.5, 4, PAL2.wood);
  S.capsule([88, 116, 4], [40, 100, 2], 4.5, 4, PAL2.wood);
  const f = phase ? 4 : -3;
  for (const [x, y, r] of [[64, 96, 14], [60 + f, 80, 11], [68 - f, 66, 8], [62 + f, 54, 5], [70, 86, 9]]) S.sphere(x, y, 10, r, PAL2.fire, { emit: true });
  S.sphere(64, 98, 22, 5, PAL.gWhite, { emit: true });
}

/** @param {Sculpt} S */
function sculptBed(S) {
  S.box(12, 46, 104, 30, -6, PAL2.wood, 4);
  S.box(16, 72, 96, 40, 0, PAL2.wood, 3);
  S.box(20, 64, 88, 34, 6, PAL2.crimson, 5);
  S.box(24, 56, 30, 14, 10, PAL2.cream, 5);
  S.inlay([22, 80, 106, 80], 0.65, 1);
  for (const x of [16, 108]) S.capsule([x, 110, 4], [x, 122, 4], 3, 3, PAL2.wood);
}

/** @param {Sculpt} S @param {boolean} up */
function sculptLever(S, up) {
  S.box(44, 96, 40, 26, 0, PAL.brass, 5);
  S.ring(64, 104, 8, 8, 1.6, 0, 0, PAL.obsidian);
  const tip = up ? [52, 50, 14] : [84, 116, 20];
  S.capsule([64, 104, 10], tip, 2.6, 2.2, PAL.steel);
  S.sphere(tip[0], tip[1], tip[2] + 2, 6, PAL2.crimson);
  S.inlay([48, 100, 56, 100], up ? INK.cyan : 0.5, 1.5);
}

/** @param {Sculpt} S */
function sculptStall(S) {
  for (const x of [22, 106]) S.capsule([x, 124, 0], [x, 34, 0], 3, 3, PAL2.wood);
  S.box(14, 82, 100, 30, 4, PAL2.wood, 4);
  for (let k = 0; k < 7; k++) {
    const x0 = 10 + k * 15.5;
    S.poly([x0, 26, x0 + 15.5, 26, x0 + 15.5 + 2, 46, x0 + 2, 46], 10, [0, -0.6, 0.8], k % 2 ? PAL2.cream : PAL2.crimson);
  }
  const goods = [PAL2.crimson, PAL2.crimson, PAL2.ochre, PAL2.ochre, PAL2.forest, PAL2.crimson];
  [30, 42, 58, 72, 88, 98].forEach((x, k) => S.sphere(x, 80, 12, 5, goods[k]));
}

/** @param {Sculpt} S */
function sculptWell(S) {
  S.capsule([64, 118, 0], [64, 92, 0], 34, 34, PAL2.lime);
  for (let k = 0; k < 4; k++) S.scratch([30, 96 + k * 6, 98, 96 + k * 6], 0.6, 0.8);
  S.sphere(64, 92, 6, 30, PAL.obsidian, { sy: 0.25 });
  for (const x of [34, 94]) S.capsule([x, 96, 20], [x, 30, 20], 3, 3, PAL2.wood);
  S.poly([24, 34, 104, 34, 64, 8], 22, [0, -0.5, 0.85], PAL2.wood);
  S.capsule([34, 44, 24], [94, 44, 24], 1.6, 1.6, PAL2.wood);
  S.capsule([64, 44, 26], [64, 62, 26], 0.6, 0.6, PAL2.reed);
  S.box(58, 62, 12, 10, 26, PAL2.wood, 2);
}

/** @param {Sculpt} S */
function sculptLampPost(S) {
  S.capsule([64, 126, 0], [64, 30, 0], 3.2, 2.4, PAL.obsidian);
  S.ring(64, 120, 0, 6, 1.6, 1.3, 0, PAL.brass);
  S.capsule([64, 30, 2], [78, 26, 2], 1.6, 1.6, PAL.obsidian);
  S.capsule([78, 26, 4], [78, 32, 4], 0.8, 0.8, PAL.obsidian);
  S.box(70, 32, 16, 20, 6, PAL.gAmber, 4, { emit: true });
  S.poly([68, 33, 88, 33, 78, 24], 10, [0, -0.5, 0.85], PAL.brass);
  for (const x of [70, 86]) S.capsule([x, 32, 12], [x, 52, 12], 0.9, 0.9, PAL.brass);
}

/** @param {Sculpt} S */
function sculptPylon(S) {
  S.box(40, 112, 48, 14, 0, PAL2.stone, 4);
  S.capsule([64, 114, 0], [64, 30, 0], 11, 5, PAL.brass);
  for (let k = 0; k < 5; k++) S.ring(64, 100 - k * 16, 2, 13 - k * 1.4, 1.6, 1.25, 0, PAL.gCyan, { emit: true });
  for (let k = 0; k < 4; k++) glyph(S, 60, 98 - k * 16, 7, 900 + k, INK.cyan, 1);
  S.poly([64, 0, 74, 18, 64, 34, 54, 18], 12, [0.3, -0.3, 0.9], PAL.crystal);
  S.poly([64, 0, 64, 34, 54, 18], 12, [-0.6, -0.3, 0.7], PAL.crystal);
  S.sphere(62, 16, 16, 3, PAL.gWhite, { emit: true });
}

/** @param {Sculpt} S */
function sculptStones(S) {
  for (const [x0, w, top, z, seed] of [[18, 24, 30, 0, 1], [52, 26, 8, 4, 2], [88, 22, 36, 0, 3]]) {
    S.poly([x0, 124, x0 + w, 124, x0 + w - 3, top + 6, x0 + w / 2, top, x0 + 3, top + 6], z, [-0.2, -0.1, 0.95], PAL2.stone);
    S.poly([x0 + w / 2, top, x0 + w - 3, top + 6, x0 + w, 124, x0 + w / 2 + 2, 124], z + 0.5, [0.6, -0.1, 0.75], PAL2.stone);
    for (let k = 0; k < 3; k++) glyph(S, x0 + w / 2 - 4, top + 20 + k * 22, 8, seed * 10 + k, INK.cyan, 1.2);
  }
  for (const [x, y] of [[30, 120], [100, 118]]) S.sphere(x, y, 6, 4, PAL.verdigris, { sy: 0.4 });
}

/** @param {Sculpt} S */
function sculptStairs(S) {
  for (const x of [18, 92]) {
    S.box(x, 30, 18, 94, 0, PAL2.lime, 4);
    for (let y = 42; y < 120; y += 14) S.scratch([x, y, x + 18, y], 0.6, 0.8);
  }
  S.ring(64, 34, 0, 37, 7, 0, 0, PAL2.lime, { from: Math.PI, to: Math.PI * 2 });
  S.box(36, 34, 56, 90, -10, PAL.obsidian, 2);
  for (let k = 0; k < 5; k++) S.box(38 + k * 2, 112 - k * 12, 52 - k * 4, 10, -6 - k * 2, PAL2.stone, 2);
  glyph(S, 58, 6, 12, 77, INK.cyan, 1.5);
}

/** @param {Sculpt} S */
function sculptBarrel(S) {
  S.sphere(64, 88, 0, 30, PAL2.wood, { sx: 0.82, sy: 1.15 });
  for (let x = 44; x <= 84; x += 8) S.scratch([x, 58, x, 118], 0.65, 0.8);
  for (const y of [66, 110]) S.ring(64, y, 0, 23.5, 2, 1.38, 0, PAL.steel);
  S.ring(64, 88, 0, 25, 2, 1.38, 0, PAL.steel);
}

/** @param {Sculpt} S */
function sculptTable(S) {
  for (const x of [26, 102]) S.capsule([x, 70, 0], [x, 124, 0], 3.5, 3.5, PAL2.wood);
  S.box(14, 58, 100, 14, 4, PAL2.wood, 4);
  S.capsule([46, 52, 16], [46, 58, 16], 5, 5, PAL2.wood);
  S.sphere(78, 54, 16, 6, PAL2.ochre, { sx: 1.4, sy: 0.7 });
}

/** @param {Sculpt} S */
function sculptNotice(S) {
  for (const x of [30, 98]) S.capsule([x, 126, 0], [x, 18, 0], 3, 3, PAL2.wood);
  S.box(22, 24, 84, 60, 4, PAL2.wood, 4);
  for (const [x, y, w, h] of [[30, 30, 24, 30], [58, 34, 22, 26], [84, 30, 16, 22], [40, 64, 30, 16], [74, 58, 24, 20]]) {
    S.box(x, y, w, h, 10, PAL2.paper, 1.5);
    for (let k = 4; k < h - 3; k += 4) S.inlay([x + 3, y + k, x + w - 3, y + k], 0.6, 0.6);
    S.sphere(x + w / 2, y + 2, 13, 1.4, PAL2.crimson);
  }
}

/** @param {Sculpt} S */
function sculptPedestal(S) {
  S.box(38, 112, 52, 14, 0, PAL2.lime, 3);
  S.capsule([64, 112, 0], [64, 46, 0], 14, 12, PAL2.lime);
  for (let k = -2; k <= 2; k++) S.scratch([64 + k * 5, 50, 64 + k * 5.5, 108], 0.65, 0.8);
  S.box(40, 36, 48, 12, 6, PAL2.lime, 3);
}

/** Armillary sphere: the Great Astrolabe core. @param {Sculpt} S */
function sculptGateCore(S) {
  S.sphere(64, 122, 0, 22, PAL.brass, { sy: 0.25 });
  S.capsule([64, 120, 0], [64, 100, 0], 10, 3, PAL.brass);
  S.sphere(64, 56, 0, 14, PAL.crystal);
  S.sphere(59, 51, 10, 5, PAL.gWhite, { emit: true });
  S.ring(64, 56, 0, 44, 2.4, 0, 0, PAL.brass);
  for (let k = 0; k < 36; k++) {
    const a = (k * Math.PI) / 18;
    S.inlay([64 + Math.cos(a) * 42.5, 56 + Math.sin(a) * 42.5, 64 + Math.cos(a) * 45.5, 56 + Math.sin(a) * 45.5], k % 3 ? 0.55 : INK.gold, 0.6);
  }
  S.ring(64, 56, 0, 44, 2.2, 1.2, 0.9, PAL.brass);
  S.ring(64, 56, 0, 44, 2.2, 1.2, -0.9, PAL.brass);
  S.ring(64, 56, 0, 36, 1.8, 1.35, 0.35, PAL.gGold, { emit: true });
}

/** @param {Sculpt} S @param {number} kind 0 lotus, 1 ember moss, 2 ley bloom */
function sculptHerb(S, kind) {
  if (kind === 0) {
    S.sphere(64, 108, 0, 30, PAL2.pad, { sy: 0.3 });
    S.scratch([64, 108, 92, 104], 0.5, 1);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      S.sphere(64 + Math.cos(a) * 9, 92 + Math.sin(a) * 4, 6 + Math.sin(a) * 4, 7, PAL2.lotus, { sy: 1.3 });
    }
    S.sphere(64, 90, 14, 4, PAL.gGold, { emit: true });
  } else if (kind === 1) {
    for (let k = 0; k < 9; k++) {
      const x = 36 + ((k * 23) % 56);
      const y = 96 + ((k * 11) % 20);
      S.capsule([x, 124, 0], [x + 2, y, 4], 1.4, 1, PAL2.bark);
      S.sphere(x + 2, y - 4, 8, 5 + (k % 3), PAL2.ember, { emit: true });
    }
  } else {
    for (let k = 0; k < 5; k++) {
      const x = 40 + k * 12;
      const top = 54 + ((k * 17) % 24);
      S.capsule([x, 124, 0], [x + (k % 2 ? 6 : -6), top, 4], 1.5, 1, PAL2.forest);
      S.sphere(x + (k % 2 ? 6 : -6), top + 4, 10, 5, PAL.gCyan, { emit: true, sy: 1.3 });
      S.sphere(x + (k % 2 ? 4 : -8), 104, 6, 5, PAL2.leaf, { sx: 1.6, sy: 0.6 });
    }
  }
}

/** @param {Sculpt} S */
function sculptTablet(S) {
  S.box(30, 112, 68, 14, 0, PAL2.lime, 3);
  S.box(36, 20, 56, 94, 4, PAL2.lime, 6);
  S.ring(64, 20, 4, 28, 3, 0, 0, PAL2.lime, { from: Math.PI, to: Math.PI * 2 });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) glyph(S, 44 + c * 14, 30 + r * 18, 9, r * 3 + c + 50, INK.cyan, 1.1);
}

/** @param {Sculpt} S */
function sculptVent(S) {
  S.sphere(64, 112, 0, 36, PAL.obsidian, { sy: 0.3 });
  S.inlay([36, 112, 50, 108, 62, 114, 76, 106, 92, 112], [255, 140, 60], 2.2);
  S.inlay([50, 108, 54, 116], [255, 200, 120], 1.2);
  for (const [x, y, r] of [[60, 86, 9], [70, 66, 7], [58, 48, 6], [66, 32, 4]]) S.sphere(x, y, 4, r, PAL.smoke);
}

/** @param {Sculpt} S @param {Ramp} liquid @param {boolean} slim */
function sculptFlask(S, liquid, slim) {
  const r = slim ? 18 : 26;
  const cy = slim ? 82 : 78;
  S.sphere(64, cy, 0, r, liquid, { sx: slim ? 0.8 : 1, clip: (_x, y) => y > cy - r * 0.35 });
  S.ring(64, cy, 0, r + 1, 2.2, 0, 0, PAL.glass);
  S.capsule([64, cy - r + 4, 0], [64, cy - r - 16, 0], 7, 6, PAL.glass);
  S.box(56, cy - r - 30, 16, 13, 2, PAL2.wood, 3);
  S.ring(64, cy - r - 14, 4, 8, 1.4, 1.3, 0, PAL.brass);
  S.sphere(52, cy - 10, 24, 3, PAL.gWhite, { emit: true });
}

/** @param {Sculpt} S @param {string} rune */
function sculptRune(S, rune) {
  const glow = { rune_lux: PAL.gGold, rune_vita: PAL2.gGreen, rune_vis: PAL2.gRed, rune_aperio: PAL.gCyan, rune_levis: PAL2.gIce }[rune] || PAL.gCyan;
  S.sphere(64, 66, 0, 38, PAL2.stone, { sy: 0.92 });
  S.ring(64, 66, 20, 30, 1.6, 0, 0, glow, { emit: true });
  const seed = rune.length * 31 + rune.charCodeAt(5);
  glyph(S, 48, 50, 32, seed, glow[1], 3);
  S.inlay(arcPts(64, 66, 34, 31, Math.PI * 1.1, Math.PI * 1.4), 1.3, 1.5);
}

/** Fill every sprite frame, keyed by name. @param {CanvasRenderingContext2D} ctx */
function sculptSprites(ctx) {
  /** @type {Record<string, (S: Sculpt) => void>} */
  const art = {
    sentinel_idle: (S) => sculptStalker(S, 0), sentinel_walk: (S) => sculptStalker(S, 1),
    sentinel_windup: (S) => sculptStalker(S, 2), sentinel_lunge: (S) => sculptStalker(S, 3),
    wisp_a: (S) => sculptWeaver(S, 0), wisp_b: (S) => sculptWeaver(S, 1), wisp_charge: (S) => sculptWeaver(S, 2),
    golem_idle: (S) => sculptWarden(S, false), golem_slam: (S) => sculptWarden(S, true),
    anchor: (S) => sculptAnchor(S, false), anchor_cracked: (S) => sculptAnchor(S, true),
    orb_enemy: (S) => {
      S.sphere(64, 64, 0, 22, PAL.gViolet, { emit: true });
      S.inlay(spiralPts(64, 64, 17, 1.4, 1, 0), INK.white, 1.2);
      S.ring(64, 64, 0, 29, 2, 1.1, 0.5, PAL.gViolet, { emit: true });
    },
    orb_player: (S) => {
      S.sphere(64, 64, 0, 22, PAL.gCyan, { emit: true });
      S.inlay(spiralPts(64, 64, 17, 1.4, -1, 0), INK.gold, 1.2);
      S.ring(64, 64, 0, 29, 2.4, 1.1, 0.5, PAL.gGold, { emit: true });
    },
    shard: (S) => {
      S.poly([64, 28, 50, 64, 64, 64], 4, [-0.6, -0.4, 0.7], PAL.crystal);
      S.poly([64, 28, 64, 64, 78, 64], 4, [0.5, -0.4, 0.75], PAL.crystal);
      S.poly([50, 64, 64, 100, 64, 64], 4, [-0.5, 0.4, 0.75], PAL.crystal);
      S.poly([64, 64, 64, 100, 78, 64], 4, [0.6, 0.45, 0.65], PAL.crystal);
      S.sparkle(62, 54, 4);
    },
    bolt: (S) => {
      S.capsule([30, 98, 0], [96, 32, 0], 2.4, 2.4, PAL2.wood);
      S.poly([96, 32, 108, 20, 100, 36, 92, 28], 4, [0.3, -0.3, 0.9], PAL.steel);
      for (const s of [-1, 1]) S.poly([30, 98, 26 + s * 8, 106 - s * 2, 38, 92], 2, [s * 0.4, 0, 0.9], PAL.brass);
    },
    flare: (S) => {
      S.sphere(64, 64, 0, 20, PAL2.fire, { emit: true });
      for (let k = 0; k < 6; k++) S.sphere(64 + Math.cos(k) * 18, 64 + Math.sin(k * 1.7) * 18, 6, 7, PAL2.ember, { emit: true });
      S.sphere(60, 60, 20, 6, PAL.gWhite, { emit: true });
    },
    frost: (S) => {
      for (const [a, b] of [[[64, 22], [64, 106]], [[28, 44], [100, 84]], [[28, 84], [100, 44]]]) S.capsule([a[0], a[1], 0], [b[0], b[1], 0], 4, 4, PAL2.gIce, { emit: true });
      S.sphere(64, 64, 6, 10, PAL2.frost);
      S.sparkle(58, 58, 5);
    },
    spark: (S) => {
      S.capsule([64, 34, 0], [64, 94, 0], 4, 4, PAL.gGold, { emit: true });
      S.capsule([34, 64, 0], [94, 64, 0], 4, 4, PAL.gGold, { emit: true });
      S.sphere(64, 64, 6, 9, PAL.gWhite, { emit: true });
    },
    bead: (S) => { S.sphere(64, 64, 0, 15, PAL.gBead, { emit: true }); S.sphere(62, 62, 12, 4, PAL.gWhite, { emit: true }); },
    tree_ley: sculptLeyTree, tree_pine: sculptPine, tree_dead: sculptDeadTree, reeds: sculptReeds, rock: sculptRock,
    chest: (S) => sculptChest(S, false), chest_open: (S) => sculptChest(S, true),
    campfire_a: (S) => sculptCampfire(S, 0), campfire_b: (S) => sculptCampfire(S, 1), bed: sculptBed,
    lever_up: (S) => sculptLever(S, true), lever_down: (S) => sculptLever(S, false),
    stall: sculptStall, well: sculptWell, lamp_post: sculptLampPost, pylon: sculptPylon, stones: sculptStones,
    stairs: sculptStairs, barrel: sculptBarrel, table: sculptTable, notice: sculptNotice, pedestal: sculptPedestal,
    gate_core: sculptGateCore, herb_lotus: (S) => sculptHerb(S, 0), herb_moss: (S) => sculptHerb(S, 1),
    herb_bloom: (S) => sculptHerb(S, 2), tablet: sculptTablet, vent: sculptVent,
    i_fork: (S) => {
      S.rotate(0.6, 64, 64);
      S.capsule([64, 96, 4], [64, 122, 2], 6, 7, PAL.leather);
      for (const s of [-1, 1]) S.capsule([64 + s * 10, 80, 4], [64 + s * 9, 10, -6], 4.5, 3, PAL.steel);
      for (let k = 0; k < 8; k++) {
        const a0 = (Math.PI * k) / 8;
        const a1 = (Math.PI * (k + 1)) / 8;
        S.capsule([64 + 10 * Math.cos(a0), 80 + 12 * Math.sin(a0), 4], [64 + 10 * Math.cos(a1), 80 + 12 * Math.sin(a1), 4], 4.5, 4.5, PAL.steel);
      }
      S.sphere(64, 94, 8, 5, PAL.brass);
      S.rotate(0);
    },
    i_scatter: (S) => {
      S.box(36, 60, 56, 40, 0, PAL.brass, 8);
      S.capsule([92, 74, 2], [118, 66, -4], 7, 6, PAL.brass);
      S.poly([40, 60, 88, 60, 64, 22], 12, [0.3, -0.4, 0.85], PAL.crystal);
      S.poly([40, 60, 64, 60, 64, 22], 12, [-0.6, -0.3, 0.7], PAL.crystal);
      S.capsule([44, 100, 6], [34, 122, 2], 6, 6, PAL2.wood);
      S.sphere(54, 80, 14, 5, PAL.glass);
    },
    i_crossbow: (S) => {
      S.capsule([36, 112, 0], [92, 30, 0], 6, 5, PAL2.wood);
      S.ring(78, 50, 2, 40, 3, 0.9, -0.9, PAL.steel, { from: Math.PI * 0.85, to: Math.PI * 1.65 });
      S.capsule([90, 32, 6], [40, 104, 6], 1.6, 1.6, PAL2.wood);
      S.poly([92, 28, 100, 18, 96, 34], 8, [0.3, -0.3, 0.9], PAL.steel);
      S.box(52, 70, 14, 12, 8, PAL.brass, 2);
    },
    i_lantern: (S) => {
      S.ring(64, 22, 0, 12, 2.2, 0, 0, PAL.brass, { from: Math.PI, to: Math.PI * 2 });
      S.poly([44, 40, 84, 40, 64, 22], 4, [0, -0.5, 0.85], PAL.brass);
      S.box(46, 40, 36, 52, 0, PAL.gAmber, 6, { emit: true });
      for (const x of [46, 64, 82]) S.capsule([x, 40, 8], [x, 92, 8], 1.6, 1.6, PAL.brass);
      S.box(42, 92, 44, 12, 4, PAL.brass, 3);
      S.sphere(64, 66, 14, 6, PAL2.fire, { emit: true });
    },
    i_buckler: (S) => {
      S.sphere(64, 64, 0, 46, PAL2.wood, { sy: 1 });
      for (let k = -2; k <= 2; k++) S.scratch([64 + k * 16, 22, 64 + k * 16, 106], 0.6, 1);
      S.ring(64, 64, 20, 44, 3, 0, 0, PAL.brass);
      S.sphere(64, 64, 34, 12, PAL.brass);
      rivetRing(S, 64, 64, 30, 36, 36, 10, 1.6);
    },
    i_coat: (S) => {
      S.capsule([64, 30, 0], [64, 104, 0], 22, 26, PAL.leather);
      for (const s of [-1, 1]) S.capsule([64 + s * 22, 34, 0], [64 + s * 36, 96, 2], 8, 7, PAL.leather);
      for (let k = 0; k < 5; k++) S.inlay([44, 44 + k * 13, 84, 44 + k * 13], 0.6, 1);
      S.inlay([64, 26, 64, 110], 0.5, 1.2);
    },
    i_cuirass: (S) => {
      S.box(30, 22, 68, 88, 0, PAL.brass, 18);
      S.capsule([64, 26, 22], [64, 104, 22], 2.4, 2.4, PAL.brass);
      rivetRing(S, 64, 66, 18, 30, 40, 12, 1.5);
      S.scratch(spiralPts(48, 50, 8, 1.2, 1, Math.PI), 0.55, 1);
      S.scratch(spiralPts(80, 50, 8, 1.2, -1, 0), 0.55, 1);
    },
    i_charm: (S) => {
      S.ring(64, 30, -4, 26, 1.4, 0, 0, PAL.brass, { from: Math.PI * 1.05, to: Math.PI * 1.95 });
      S.ring(64, 76, 0, 30, 4, 0, 0, PAL.brass);
      S.sphere(64, 76, 0, 27, PAL2.cream, { sy: 1 });
      S.poly([64, 54, 70, 76, 64, 98, 58, 76], 28, [0, 0, 1], PAL2.crimson);
      S.sphere(64, 76, 30, 3, PAL.brass);
      for (let k = 0; k < 12; k++) S.inlay([64 + Math.cos(k * 0.52) * 21, 76 + Math.sin(k * 0.52) * 21, 64 + Math.cos(k * 0.52) * 25, 76 + Math.sin(k * 0.52) * 25], 0.4, 1);
    },
    i_amulet: (S) => {
      S.ring(64, 30, -4, 26, 1.4, 0, 0, PAL.brass, { from: Math.PI * 1.05, to: Math.PI * 1.95 });
      S.ring(64, 76, 0, 22, 4, 0, 0, PAL.brass);
      S.sphere(64, 76, 4, 18, PAL2.fire, { emit: true });
      S.sphere(58, 70, 18, 5, PAL.gWhite, { emit: true });
    },
    i_draught: (S) => sculptFlask(S, PAL.crimson, false),
    i_tonic: (S) => sculptFlask(S, PAL2.mana, false),
    i_oil_ember: (S) => sculptFlask(S, material(PAL2.ember, 'crystal'), true),
    i_oil_frost: (S) => sculptFlask(S, PAL2.frost, true),
    i_bread: (S) => {
      S.sphere(64, 74, 0, 40, PAL2.ochre, { sx: 1.25, sy: 0.6 });
      for (let k = -1; k <= 1; k++) S.scratch([52 + k * 18, 60, 64 + k * 18, 76], 0.5, 2);
    },
    i_apple: (S) => {
      S.sphere(64, 72, 0, 32, PAL2.crimson);
      S.capsule([64, 44, 10], [68, 30, 10], 2, 1.4, PAL2.wood);
      S.sphere(78, 36, 10, 8, PAL2.forest, { sx: 1.4, sy: 0.6 });
    },
    i_scrap: (S) => {
      S.ring(52, 70, 0, 22, 6, 0.4, 0, PAL.brass);
      for (let k = 0; k < 10; k++) S.sphere(52 + Math.cos(k * 0.63) * 30, 70 + Math.sin(k * 0.63) * 28, 2, 4, PAL.brass);
      S.capsule([70, 96, 6], [110, 82, 10], 4, 3, PAL.brass);
      S.capsule([80, 40, 6], [108, 60, 2], 3, 3, PAL.steel);
    },
    i_crystal: (S) => {
      for (const [x, top, w] of [[50, 30, 14], [70, 18, 16], [88, 44, 12]]) {
        S.poly([x, top, x - w, 106, x, 110], 4, [-0.6, -0.2, 0.75], PAL.crystal);
        S.poly([x, top, x, 110, x + w, 106], 4, [0.6, -0.2, 0.75], PAL.crystal);
      }
      S.sparkle(66, 48, 5);
    },
    i_salt: (S) => {
      for (let k = 0; k < 16; k++) S.sphere(36 + ((k * 29) % 56), 78 + ((k * 13) % 34), k, 7 + (k % 3) * 2, PAL2.lime);
      S.sparkle(58, 82, 4);
    },
    i_lockpick: (S) => {
      for (const s of [-1, 1]) {
        S.capsule([40 + s * 6, 106, 0], [86 + s * 6, 26, 0], 2, 1.6, PAL.steel);
        S.capsule([86 + s * 6, 26, 0], [92 + s * 6, 32, 0], 1.6, 1.4, PAL.steel);
      }
      S.box(30, 90, 30, 18, 4, PAL.leather, 4);
    },
    i_key: (S) => {
      S.ring(42, 46, 0, 18, 5, 0, 0, PAL.brass);
      S.capsule([56, 58, 0], [104, 102, 0], 4.5, 4.5, PAL.brass);
      for (const t of [0.7, 0.88]) S.box(56 + 48 * t, 58 + 44 * t, 10, 12, 4, PAL.brass, 2);
    },
    i_book: (S) => {
      S.box(26, 22, 76, 90, 0, PAL2.crimson, 6);
      S.box(98, 26, 8, 84, -2, PAL2.paper, 2);
      for (const [x, y] of [[26, 22], [92, 22], [26, 102], [92, 102]]) S.box(x, y, 10, 10, 8, PAL.brass, 2);
      glyph(S, 50, 44, 26, 404, INK.gold, 2);
    },
    rune_lux: (S) => sculptRune(S, 'rune_lux'), rune_vita: (S) => sculptRune(S, 'rune_vita'),
    rune_vis: (S) => sculptRune(S, 'rune_vis'), rune_aperio: (S) => sculptRune(S, 'rune_aperio'),
    rune_levis: (S) => sculptRune(S, 'rune_levis'),
    i_ammo_shard: (S) => {
      for (const dx of [-14, 0, 14]) {
        S.poly([64 + dx, 20, 56 + dx, 70, 64 + dx, 110], 4 + dx * 0.1, [-0.6, 0, 0.8], PAL.crystal);
        S.poly([64 + dx, 20, 64 + dx, 110, 72 + dx, 70], 4 + dx * 0.1, [0.6, 0, 0.8], PAL.crystal);
      }
      S.ring(64, 80, 8, 26, 2, 1.3, 0, PAL.leather);
    },
    i_ammo_flare: (S) => {
      for (const dx of [-16, 0, 16]) { S.capsule([64 + dx, 110, 0], [64 + dx, 40, 0], 3, 3, PAL2.wood); S.sphere(64 + dx, 34, 6, 9, PAL2.fire, { emit: true }); }
      S.ring(64, 86, 4, 24, 2, 1.3, 0, PAL.leather);
    },
    i_ammo_frost: (S) => {
      for (const dx of [-16, 0, 16]) {
        S.capsule([64 + dx, 110, 0], [64 + dx, 44, 0], 3, 3, PAL2.wood);
        S.poly([64 + dx, 18, 72 + dx, 40, 64 + dx, 50, 56 + dx, 40], 8, [0.3, -0.3, 0.9], PAL2.frost);
      }
      S.ring(64, 86, 4, 24, 2, 1.3, 0, PAL.leather);
    },
    i_core: (S) => {
      S.sphere(64, 64, 0, 22, PAL.gCyan, { emit: true });
      S.sphere(58, 58, 18, 7, PAL.gWhite, { emit: true });
      for (const [tilt, spin] of [[1.2, 0.5], [1.2, -0.5], [0, 0]]) S.ring(64, 64, 0, 32, 2.6, tilt, spin, PAL.brass);
      rivetRing(S, 64, 64, 6, 32, 32, 8, 2);
    },
    i_relic: (S) => {
      S.ring(64, 64, 0, 40, 4, 0, 0, PAL.gGold, { emit: true, from: 0.3, to: Math.PI * 1.4 });
      S.ring(64, 64, 4, 28, 3, 1.1, 0.4, PAL.brass, { from: 0, to: Math.PI * 1.6 });
      S.sphere(64, 64, 10, 10, PAL2.crimson);
      for (let k = 0; k < 8; k++) S.inlay([64 + Math.cos(k * 0.8) * 34, 64 + Math.sin(k * 0.8) * 34, 64 + Math.cos(k * 0.8) * 44, 64 + Math.sin(k * 0.8) * 44], 0.4, 1.4);
    },
    i_parcel: (S) => {
      S.box(24, 34, 80, 66, 0, PAL2.paper, 8);
      S.inlay([64, 34, 64, 100], [140, 90, 50], 3);
      S.inlay([24, 66, 104, 66], [140, 90, 50], 3);
      S.sphere(64, 66, 14, 6, PAL2.crimson);
    },
    i_shards: (S) => {
      for (const [x, y, s] of [[44, 90, 1], [64, 84, 1.3], [84, 92, 1], [56, 104, 0.8], [76, 106, 0.9]]) {
        S.poly([x, y - 26 * s, x - 9 * s, y, x, y + 8 * s], y * 0.1, [-0.6, -0.2, 0.75], PAL.crystal);
        S.poly([x, y - 26 * s, x, y + 8 * s, x + 9 * s, y], y * 0.1, [0.6, -0.2, 0.75], PAL.crystal);
      }
      S.sparkle(62, 64, 5);
    },
  };
  const people = /** @type {[string, Parameters<typeof sculptPerson>[1]][]} */ ([
    ['folk_a', { coat: PAL2.crimson, legs: PAL2.ochre, hat: 'cap', sash: PAL2.ochre }],
    ['folk_b', { coat: PAL2.teal, legs: PAL2.slate, hair: PAL2.hairGrey, apron: true }],
    ['folk_c', { coat: PAL2.ochre, legs: PAL2.forest, hair: PAL2.hairRed, hat: 'hood', sash: PAL2.forest, skin: PAL2.skinDark }],
    ['merchant', { coat: PAL2.forest, legs: PAL2.slate, apron: true, hat: 'tophat' }],
    ['guard', { coat: PAL2.slate, legs: PAL2.slate, hat: 'helm', spear: true, sash: PAL2.crimson }],
    ['master', { coat: PAL2.crimson, robe: true, goggles: true, hair: PAL2.hairGrey, beard: true, sash: PAL.brass }],
    ['keeper', { coat: PAL2.cream, legs: PAL2.wood, apron: true, mug: true, skin: PAL2.skinDark, beard: true }],
    ['captain', { coat: PAL2.forest, legs: PAL.leather, hat: 'cap', sash: PAL.leather, spear: true, hair: PAL2.hairRed }],
  ]);
  for (const [name, o] of people) {
    art[name] = (S) => sculptPerson(S, o);
    art[`${name}_walk`] = (S) => sculptPerson(S, { ...o, walk: true });
  }
  SPRITE_NAMES.forEach((name, f) => {
    const S = new Sculpt(SPRITE_FRAME, 128);
    art[name](S);
    S.finish();
    const r = spriteRect(f);
    S.blit(ctx, r.sx, r.sy);
  });
}

/** Alchemical Crossbow viewmodel. @param {Sculpt} S @param {boolean} fired */
function sculptCrossbow(S, fired) {
  S.capsule([186, 262, 14], [138, 120, -20], 15, 9, PAL2.wood);
  for (let k = 0; k < 4; k++) S.inlay([180 - k * 11, 236 - k * 30, 168 - k * 11, 240 - k * 30], 0.55, 1.4);
  S.box(150, 170, 26, 34, 16, PAL.brass, 6);
  S.sphere(163, 186, 32, 4, PAL.crystal);
  S.ring(136, 112, -20, 74, 4.5, 1.15, 0.05, PAL.steel, { from: Math.PI * 1.02, to: Math.PI * 1.98 });
  S.ring(136, 112, -20, 74, 2, 1.15, 0.05, PAL.brass, { from: Math.PI * 1.45, to: Math.PI * 1.55 });
  const sy = fired ? 98 : 136;
  S.inlay([64, 104, 136, sy, 208, 104], [220, 210, 180], 1.4);
  if (!fired) {
    S.capsule([136, 134, -14], [128, 58, -30], 2.6, 2.6, PAL2.wood);
    S.poly([128, 44, 134, 58, 128, 64, 122, 58], -10, [0.3, -0.3, 0.9], PAL.steel);
  } else {
    S.sphere(128, 60, 10, 12, PAL.gGold, { emit: true });
    S.sparkle(128, 60, 14);
  }
}

/** Lantern held in the off hand. @param {Sculpt} S */
function sculptLanternHand(S) {
  S.capsule([30, 270, 10], [92, 196, 8], 16, 12, PAL.leather);
  S.sphere(96, 190, 14, 12, PAL2.skin);
  S.ring(100, 160, 10, 18, 3, 0, 0, PAL.brass, { from: Math.PI, to: Math.PI * 2 });
  S.poly([74, 170, 126, 170, 100, 150], 14, [0, -0.5, 0.85], PAL.brass);
  S.box(78, 170, 44, 62, 6, PAL.gAmber, 8, { emit: true });
  for (const x of [78, 100, 122]) S.capsule([x, 170, 16], [x, 232, 16], 2, 2, PAL.brass);
  S.box(74, 230, 52, 14, 12, PAL.brass, 4);
  S.sphere(100, 202, 18, 9, PAL2.fire, { emit: true });
  S.sphere(98, 198, 26, 4, PAL.gWhite, { emit: true });
}

/** Casting hand with a glowing rune circle. @param {Sculpt} S */
function sculptCastHand(S) {
  S.capsule([200, 270, 10], [160, 190, 8], 18, 13, PAL2.crimson);
  S.ring(196, 250, 12, 20, 3, 1.1, -0.4, PAL.brass);
  S.sphere(150, 176, 12, 15, PAL2.skin);
  for (const [dx, dy] of [[-18, -14], [-10, -24], [0, -26], [10, -22], [16, -8]]) S.capsule([150 + dx * 0.4, 170 + dy * 0.3, 14], [150 + dx, 168 + dy, 16], 4, 3, PAL2.skin);
  S.ring(128, 112, 30, 46, 2.4, 0.5, 0.3, PAL.gCyan, { emit: true });
  S.ring(128, 112, 30, 34, 1.6, 0.5, -0.3, PAL.gCyan, { emit: true });
  for (let k = 0; k < 6; k++) glyph(S, 128 + Math.cos(k * 1.05) * 40 - 5, 112 + Math.sin(k * 1.05) * 24 - 5, 10, 600 + k, INK.cyan, 2);
  S.sparkle(118, 104, 8);
}

/**
 * Sculpt the sprite atlas: every named sprite frame plus the weapon and hand viewmodels.
 * @returns {HTMLCanvasElement}
 */
export function buildSpriteAtlas() {
  const { c: canvas, ctx } = canvas2d(ATLAS_W, ATLAS_H);
  sculptSprites(ctx);
  /** @type {[number, (S: Sculpt) => void][]} */
  const views = [
    [VIEW.FORK, (S) => sculptFork(S, false)],
    [VIEW.FORK_SLASH, (S) => sculptFork(S, true)],
    [VIEW.SCATTER, (S) => sculptScatter(S, false)],
    [VIEW.SCATTER_FIRE, (S) => sculptScatter(S, true)],
    [VIEW.CROSSBOW, (S) => sculptCrossbow(S, false)],
    [VIEW.CROSSBOW_FIRE, (S) => sculptCrossbow(S, true)],
    [VIEW.LANTERN, sculptLanternHand],
    [VIEW.CAST, sculptCastHand],
  ];
  for (const [v, fn] of views) {
    const r = viewRect(v);
    const S = new Sculpt(r.size, 256);
    fn(S);
    S.finish();
    S.blit(ctx, r.sx, r.sy);
  }
  return canvas;
}


/** Resonance Tuning Fork viewmodel. @param {Sculpt} S @param {boolean} swing */
function sculptFork(S, swing) {
  if (swing) S.rotate(-0.5, 168, 256);
  // Leather-wrapped grip with stitching and a gem pommel.
  S.capsule([150, 184, 10], [172, 262, 0], 15, 17, PAL.brass);
  for (let k = 0; k < 5; k++) {
    const t = 0.25 + k * 0.15;
    const x = 150 + 22 * t;
    const y = 184 + 78 * t;
    S.capsule([x - 15, y + 4, 20], [x + 16, y - 4, 20], 3.4, 3.4, PAL.leather);
    for (let s = -12; s <= 12; s += 4) S.inlay([x + s, y - s * 0.26 - 2.4, x + s + 1.2, y - s * 0.26 - 2.7], INK.stitch, 0.7);
  }
  // Engraved collar.
  S.ring(149, 182, 14, 16, 3, 1.2, 0.28, PAL.brass);
  S.sphere(148, 178, 12, 13, PAL.brass);
  S.scratch(spiralPts(144, 174, 7, 1.3, 1, Math.PI), 0.55, 1);
  S.inlay(spiralPts(143.5, 173.5, 7, 1.3, 1, Math.PI), INK.gold, 0.6);
  S.sphere(152, 182, 22, 3.5, PAL.crystal);
  // Yoke and tines.
  for (let k = 0; k < 12; k++) {
    const a0 = (Math.PI * k) / 12;
    const a1 = (Math.PI * (k + 1)) / 12;
    S.capsule([148 + 30 * Math.cos(a0), 150 + 28 * Math.sin(a0), 6], [148 + 30 * Math.cos(a1), 150 + 28 * Math.sin(a1), 6], 10, 10, PAL.steel);
  }
  S.scratch(arcPts(148, 150, 30, 28, 0.15, Math.PI - 0.15), 0.6, 1.2);
  S.capsule([118, 150, 6], [100, 20, -30], 10, 6.5, PAL.steel);
  S.capsule([178, 150, 6], [172, 14, -30], 10, 6.5, PAL.steel);
  // Glowing runes inlaid along each tine.
  for (let k = 0; k < 4; k++) {
    glyph(S, 107 - k * 3.2, 104 - k * 24, 8, 400 + k, INK.cyan, 1.2);
    glyph(S, 171 - k * 1.4, 102 - k * 24, 8, 500 + k, INK.cyan, 1.2);
  }
  S.inlay([116, 140, 101, 26], INK.white, 0.8);
  S.inlay([176, 140, 171, 20], INK.white, 0.8);
  // Standing resonance waves.
  for (let k = 0; k < 4; k++) S.ring(140, 62 + k * 24, -8, 24, 1.8, 0, 0, PAL.gCyan, { emit: true, from: Math.PI * 1.15, to: Math.PI * 1.85 });
  S.rotate(0);
  if (swing) {
    for (const r of [70, 92, 114]) S.ring(80, 116, 40, r, r === 92 ? 3 : 2, 0, 0, r === 92 ? PAL.gWhite : PAL.gCyan, { emit: true, from: Math.PI * 1.05, to: Math.PI * 1.6 });
  }
}

/** Prism Scattergun viewmodel. @param {Sculpt} S @param {boolean} fire */
function sculptScatter(S, fire) {
  if (fire) {
    SPECTRUM.forEach((rmp, k) => S.capsule([160, 30, 40], [40 + k * 36, -4, 40], 4, 1.5, rmp, { emit: true }));
    S.sphere(160, 32, 44, 18, PAL.gWhite, { emit: true });
  }
  // Housing: engraved filigree plate, screws, twin pressure gauges.
  S.box(118, 168, 84, 100, 0, PAL.brass, 14);
  S.scratch(spiralPts(132, 228, 10, 1.4, 1, Math.PI), 0.55, 1.2);
  S.scratch(spiralPts(188, 228, 10, 1.4, -1, 0), 0.55, 1.2);
  S.inlay(spiralPts(131, 227, 10, 1.4, 1, Math.PI), INK.gold, 0.7);
  S.inlay(spiralPts(187, 227, 10, 1.4, -1, 0), INK.gold, 0.7);
  S.box(128, 184, 64, 26, 14, PAL.obsidian, 5);
  for (const [x, dir] of [[148, 1], [174, -1]]) {
    S.sphere(x, 197, 20, 8, PAL.glass);
    for (let t = 0; t < 9; t++) {
      const a = Math.PI * (0.8 + t * 0.175);
      S.inlay([x + Math.cos(a) * 5.5, 197 + Math.sin(a) * 5.5, x + Math.cos(a) * 7, 197 + Math.sin(a) * 7], t > 6 ? [194, 31, 74] : [20, 30, 40], 0.6);
    }
    S.ring(x, 197, 20, 9, 1.6, 0, 0, PAL.brass);
    S.capsule([x, 197, 28], [x + dir * 5, 191, 28], 1, 0.6, PAL.crimson);
    S.sparkle(x - 3, 194, 1.5);
  }
  for (const [x, y] of [[124, 176], [196, 176], [124, 250], [196, 250]]) {
    S.sphere(x, y, 14, 3, PAL.brass);
    S.scratch([x - 2, y + 1, x + 2, y - 1], 0.4, 0.8);
  }
  // Pipes with joint collars.
  S.capsule([112, 240, 12], [124, 150, -4], 6, 6, PAL.brass);
  S.capsule([210, 240, 12], [198, 150, -4], 6, 6, PAL.brass);
  for (const t of [0.3, 0.7]) {
    S.ring(112 + 12 * t, 240 - 90 * t, 12 - 16 * t + 2, 6.5, 1.6, 1.35, 0.13, PAL.steel);
    S.ring(210 - 12 * t, 240 - 90 * t, 12 - 16 * t + 2, 6.5, 1.6, 1.35, -0.13, PAL.steel);
  }
  // Barrel shroud and muzzle.
  S.box(134, 102, 52, 72, -6, PAL.brass, 10);
  for (let k = 0; k < 3; k++) S.capsule([134, 118 + k * 18, 4], [186, 118 + k * 18, 4], 3, 3, PAL.steel);
  for (let k = 0; k < 2; k++) glyph(S, 150 + k * 12, 125, 8, 600 + k, INK.cyan, 1);
  S.ring(160, 104, -6, 26, 4, 1.35, 0, PAL.steel);
  // Prism with refraction lines and glints.
  const A = [160, 22];
  const BL = [118, 100];
  const BR = [202, 100];
  const BF = [160, 110];
  const C = [160, 72];
  S.poly([...A, ...BL, ...C], 16, [-0.7, -0.3, 0.65], PAL.crystal);
  S.poly([...A, ...C, ...BR], 16, [0.6, -0.35, 0.7], PAL.crystal);
  S.poly([...BL, ...BF, ...C], 16, [-0.3, 0.5, 0.8], PAL.crystal);
  S.poly([...C, ...BF, ...BR], 16, [0.3, 0.5, 0.8], PAL.crystal);
  S.capsule([160, 26, 18], [160, 72, 18], 1, 1, PAL.crystal);
  S.inlay([146, 46, 138, 86, 150, 100], INK.pale, 0.8);
  S.inlay([172, 52, 184, 92], INK.pale, 0.7);
  S.inlay([130, 92, 160, 80, 190, 94], [255, 140, 200], 0.6);
  S.sphere(148, 62, 20, 4, PAL.gWhite, { emit: true });
  S.sparkle(176, 76, 4);
  S.capsule([114, 106, 18], [126, 84, 22], 4, 3, PAL.brass);
  S.capsule([206, 106, 18], [194, 84, 22], 4, 3, PAL.brass);
}

// ---------------------------------------------------------------------------
// Surface synthesis: tileable gradient (Perlin) noise, Worley cells and fBm,
// used to grow each 128px painted tile into 256x256 albedo + normal +
// roughness/specular/cavity/metal maps with grain, scratches, mortar,
// creeping moss, patina, wood fibre and wetness layers.
// ---------------------------------------------------------------------------

/** Material texture edge, in texels. */
export const MAT_SIZE = 256;

/**
 * Tileable Perlin gradient noise over a period of `cells` lattice cells per unit square.
 * @param {number} cells @param {number} seed @returns {(u:number, v:number) => number} value in about [-1, 1]
 */
export function makePerlin(cells, seed) {
  const gx = new Float32Array(cells * cells);
  const gy = new Float32Array(cells * cells);
  for (let k = 0; k < cells * cells; k++) {
    const a = hash2(k % cells, Math.floor(k / cells), seed) * Math.PI * 2;
    gx[k] = Math.cos(a);
    gy[k] = Math.sin(a);
  }
  /** @param {number} i @param {number} j @param {number} dx @param {number} dy */
  const dot = (i, j, dx, dy) => {
    const k = (((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells);
    return gx[k] * dx + gy[k] * dy;
  };
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = dot(i, j, fx, fy);
    const b = dot(i + 1, j, fx - 1, fy);
    const c = dot(i, j + 1, fx, fy - 1);
    const d = dot(i + 1, j + 1, fx - 1, fy - 1);
    return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 1.4;
  };
}

/**
 * Tileable fractional Brownian motion: octaves of Perlin noise, each doubling frequency.
 * @param {number} cells base lattice cells @param {number} octaves @param {number} seed
 * @returns {(u:number, v:number) => number} value in about [-1, 1]
 */
export function makeFbm(cells, octaves, seed) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(makePerlin(cells << o, seed + o * 977));
  return (u, v) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (const n of layers) {
      sum += n(u, v) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

/**
 * Tileable Worley (cellular) noise.
 * @param {number} cells feature cells per unit square @param {number} seed
 * @returns {(u:number, v:number) => number[]} [F1, F2, cell id], distances in cell units
 */
export function makeWorley(cells, seed) {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let k = 0; k < cells * cells; k++) {
    px[k] = 0.15 + 0.7 * hash2(k, 1, seed);
    py[k] = 0.15 + 0.7 * hash2(k, 2, seed);
  }
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const ci = Math.floor(x);
    const cj = Math.floor(y);
    let f1 = 9;
    let f2 = 9;
    let id = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gi = ci + i;
        const gj = cj + j;
        const k = (((gj % cells) + cells) % cells) * cells + (((gi % cells) + cells) % cells);
        const d = Math.hypot(x - gi - px[k], y - gj - py[k]);
        if (d < f1) { f2 = f1; f1 = d; id = k; } else if (d < f2) f2 = d;
      }
    }
    return [f1, f2, id];
  };
}

/**
 * @typedef {Object} SurfaceDef
 * @property {'stone'|'brass'|'obsidian'|'wood'|'plaster'|'timber'|'clay'|'grass'|'mud'|'soil'|'water'} kind
 * @property {number} bump normal-map strength
 * @property {number} rough base roughness 0..1
 * @property {number} spec specular intensity 0..1
 * @property {number} [moss] moss coverage 0..1
 * @property {boolean} [floor] horizontal surface: moss follows seams rather than climbing from the floor
 * @property {boolean} [vertical] wood grain runs vertically
 */

/** Per-tile surface recipe, indexed by TILE id. */
/** @type {Record<number, SurfaceDef>} */
const SURFACES = {
  [TILE.BRASS]: { kind: 'brass', bump: 3, rough: 0.32, spec: 0.9 },
  [TILE.CONDUIT]: { kind: 'obsidian', bump: 2, rough: 0.16, spec: 0.8 },
  [TILE.OBS_FLOOR]: { kind: 'stone', bump: 3, rough: 0.55, spec: 0.3, floor: true, moss: 0.1 },
  [TILE.STAR_CEIL]: { kind: 'plaster', bump: 1.5, rough: 0.8, spec: 0.1 },
  [TILE.ASTRO_DOOR]: { kind: 'brass', bump: 3, rough: 0.3, spec: 0.9 },
  [TILE.GATE]: { kind: 'obsidian', bump: 2.5, rough: 0.18, spec: 0.8 },
  [TILE.LEY_FLOOR]: { kind: 'stone', bump: 3, rough: 0.5, spec: 0.3, floor: true },
  [TILE.GEAR]: { kind: 'brass', bump: 3.5, rough: 0.34, spec: 0.85 },
  [TILE.LIMESTONE]: { kind: 'stone', bump: 4, rough: 0.82, spec: 0.12, moss: 0.35 },
  [TILE.MOSSY]: { kind: 'stone', bump: 4, rough: 0.85, spec: 0.1, moss: 0.85 },
  [TILE.FLAGSTONE]: { kind: 'stone', bump: 4, rough: 0.7, spec: 0.2, floor: true, moss: 0.45 },
  [TILE.CAVE_CEIL]: { kind: 'stone', bump: 4.5, rough: 0.9, spec: 0.08 },
  [TILE.TIMBER]: { kind: 'timber', bump: 2.5, rough: 0.8, spec: 0.08 },
  [TILE.PLANK]: { kind: 'wood', bump: 2.5, rough: 0.6, spec: 0.25 },
  [TILE.ROOF]: { kind: 'clay', bump: 3.5, rough: 0.7, spec: 0.18 },
  [TILE.COBBLE]: { kind: 'stone', bump: 4.5, rough: 0.65, spec: 0.25, floor: true, moss: 0.3 },
  [TILE.WOOD_DOOR]: { kind: 'wood', bump: 2.5, rough: 0.65, spec: 0.2, vertical: true },
  [TILE.PLASTER]: { kind: 'plaster', bump: 1.5, rough: 0.85, spec: 0.06 },
  [TILE.GRASS]: { kind: 'grass', bump: 2.5, rough: 0.85, spec: 0.12 },
  [TILE.FEN]: { kind: 'mud', bump: 2, rough: 0.7, spec: 0.45 },
  [TILE.BASALT]: { kind: 'stone', bump: 4, rough: 0.6, spec: 0.3, floor: true },
  [TILE.DUST]: { kind: 'soil', bump: 3, rough: 0.92, spec: 0.06 },
  [TILE.WATER]: { kind: 'water', bump: 1.2, rough: 0.05, spec: 1 },
  [TILE.CLIFF]: { kind: 'stone', bump: 5, rough: 0.85, spec: 0.12, moss: 0.2 },
};

/**
 * @typedef {Object} WorldMaterials
 * @property {number} size layer edge in texels
 * @property {number} layers number of layers (one per TILE id)
 * @property {Uint8Array} albedo RGBA layers
 * @property {Uint8Array} normal tangent-space normals, xyz*0.5+0.5
 * @property {Uint8Array} mat R roughness, G specular, B cavity, A metalness
 */

/**
 * Grow every painted 128px world tile into 256px albedo / normal / material layers.
 * @param {HTMLCanvasElement} base the painted world atlas from buildWorldAtlas()
 * @returns {WorldMaterials}
 */
export function buildWorldMaterials(base) {
  const N = MAT_SIZE;
  const M = N - 1;
  const layers = WORLD_COLS * WORLD_ROWS;
  const bctx = base.getContext('2d');
  if (!bctx) throw new Error('2D canvas is not available');
  const src = bctx.getImageData(0, 0, base.width, base.height).data;
  const BW = base.width;
  const albedo = new Uint8Array(N * N * 4 * layers);
  const normal = new Uint8Array(N * N * 4 * layers);
  const mat = new Uint8Array(N * N * 4 * layers);
  // Noise fields are identical for every tile, so sample each once and share it.
  /** @param {(u:number, v:number) => number} fn */
  const field = (fn) => {
    const a = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) a[y * N + x] = fn(x / N, y / N);
    return a;
  };
  /** @type {Map<string, Float32Array>} */
  const cache = new Map();
  /** @param {string} key @param {() => (u:number, v:number) => number} make */
  const lazy = (key, make) => {
    let a = cache.get(key);
    if (!a) { a = field(make()); cache.set(key, a); }
    return a;
  };
  const grainF = field(makeFbm(32, 3, 101));
  const midF = field(makeFbm(6, 4, 202));
  const lowF = field(makeFbm(3, 3, 303));
  const h = new Float32Array(N * N);
  const rough = new Float32Array(N * N);
  const spec = new Float32Array(N * N);
  const metal = new Float32Array(N * N);
  const col = new Float32Array(N * N * 3);

  for (let t = 0; t < layers; t++) {
    const S = SURFACES[t] ?? { kind: 'stone', bump: 3, rough: 0.8, spec: 0.1 };
    const ox = (t % WORLD_COLS) * TILE_SIZE;
    const oy = Math.floor(t / WORLD_COLS) * TILE_SIZE;
    const isStone = S.kind === 'stone' || S.kind === 'clay';
    const pitF = isStone ? lazy('pit', () => { const w = makeWorley(24, 404); return (u, v) => w(u, v)[0]; }) : null;
    const lichenF = S.kind === 'clay' ? lazy('lichen', () => { const w = makeWorley(18, 707); return (u, v) => w(u, v)[0]; }) : null;
    const knotF = S.kind === 'brass' || S.kind === 'wood' || S.kind === 'timber' ? lazy('knot', () => { const w = makeWorley(5, 505); return (u, v) => w(u, v)[0]; }) : null;
    const crackF = S.kind === 'plaster' || S.kind === 'timber' || S.kind === 'soil' ? lazy('crack', () => { const w = makeWorley(7, 606); return (u, v) => { const r = w(u, v); return r[1] - r[0]; }; }) : null;
    const scratchF = S.kind === 'brass' ? lazy('scratch', () => {
      const a = makePerlin(6, 808);
      const b = makePerlin(10, 909);
      return (u, v) => Math.min(Math.abs(a(u * 0.25 + v * 0.02, v * 6 + u * 0.3)) / 0.035, Math.abs(b(u * 5 + v * 0.4, v * 0.3 - u * 0.05)) / 0.025);
    }) : null;
    const fibreF = S.kind === 'wood' || S.kind === 'timber' ? lazy(S.vertical ? 'fibreV' : 'fibreH', () => {
      const f = makeFbm(4, 3, 1001);
      return S.vertical
        ? (u, v) => Math.sin((u * 48 + f(v * 0.5, u * 4) * 3) * Math.PI * 2)
        : (u, v) => Math.sin((v * 48 + f(u * 0.5, v * 4) * 3) * Math.PI * 2);
    }) : null;
    const pebbleF = S.kind === 'soil' ? lazy('pebble', () => { const w = makeWorley(18, 707); return (u, v) => { const r = w(u, v); return r[0] + Math.floor(r[2]) * 4; }; }) : null;
    const rippleF = S.kind === 'water' ? lazy('ripple', () => makeFbm(5, 3, 1102)) : null;

    for (let y = 0; y < N; y++) {
      const v = y / N;
      const fy = v * TILE_SIZE - 0.5;
      const iy = Math.floor(fy);
      const ay = fy - iy;
      const r0 = (oy + ((iy + TILE_SIZE) % TILE_SIZE)) * BW;
      const r1 = (oy + ((iy + 1 + TILE_SIZE) % TILE_SIZE)) * BW;
      for (let x = 0; x < N; x++) {
        const p = y * N + x;
        const u = x / N;
        // Bilinear, wrapping upsample of the painted 128px tile (unrolled).
        const fx = u * TILE_SIZE - 0.5;
        const ix = Math.floor(fx);
        const ax = fx - ix;
        const c0 = (ox + ((ix + TILE_SIZE) % TILE_SIZE)) * 4;
        const c1 = (ox + ((ix + 1 + TILE_SIZE) % TILE_SIZE)) * 4;
        const w00 = (1 - ax) * (1 - ay);
        const w10 = ax * (1 - ay);
        const w01 = (1 - ax) * ay;
        const w11 = ax * ay;
        const a00 = r0 * 4 + c0;
        const a10 = r0 * 4 + c1;
        const a01 = r1 * 4 + c0;
        const a11 = r1 * 4 + c1;
        let r = src[a00] * w00 + src[a10] * w10 + src[a01] * w01 + src[a11] * w11;
        let g = src[a00 + 1] * w00 + src[a10 + 1] * w10 + src[a01 + 1] * w01 + src[a11 + 1] * w11;
        let b = src[a00 + 2] * w00 + src[a10 + 2] * w10 + src[a01 + 2] * w01 + src[a11 + 2] * w11;
        const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
        const gr = grainF[p];
        const md = midF[p];
        let hh = lum + gr * 0.06;
        let ro = S.rough;
        let sp = S.spec;
        let me = 0;
        let shade = 1 + gr * 0.1;
        const crevice = Math.max(0, 0.42 - lum) * 2.4;

        if (pitF) {
          const f1 = pitF[p];
          if (f1 < 0.2) { shade *= 0.82 + f1; hh -= (0.2 - f1) * 0.6; }
          if (hash2(x, y, 7 + t) > 0.985) shade *= 1.18;
          ro += gr * 0.08 + crevice * 0.1;
          if (lichenF && lichenF[p] < 0.12 && md > 0.1) { r = r * 0.5 + 120; g = g * 0.5 + 130; b = b * 0.5 + 60; ro = 0.9; }
        } else if (S.kind === 'brass' && scratchF && knotF) {
          me = 1;
          if (scratchF[p] < 1) { shade *= 1.16; hh -= 0.025; ro -= 0.12; }
          hh += Math.max(0, 0.35 - knotF[p]) * 0.12;
          const patina = Math.min(1, Math.max(0, crevice * 1.2 + md * 0.8 + (v - 0.6) * 0.8 - 0.35));
          if (patina > 0) {
            const k = Math.min(0.85, patina * 1.6);
            r = r * (1 - k) + 66 * k;
            g = g * (1 - k) + 136 * k;
            b = b * (1 - k) + 112 * k;
            ro += k * 0.5;
            sp *= 1 - k * 0.7;
            me *= 1 - k;
          }
        } else if (S.kind === 'obsidian') {
          shade *= 1 + md * 0.08;
        } else if (fibreF && knotF) {
          if (S.kind === 'wood' || lum < 0.45) {
            const w = fibreF[p];
            shade *= 0.9 + w * 0.1;
            hh += w * 0.04;
            const k1 = knotF[p];
            if (k1 < 0.09) { shade *= 0.6 + k1 * 3; hh -= 0.08; }
            ro += 0.1;
          } else {
            shade *= 1 + md * 0.05;
            if (crackF && crackF[p] < 0.025 && lowF[p] > 0.05) { shade *= 0.72; hh -= 0.06; }
            ro = 0.88;
            sp = 0.05;
          }
        } else if (S.kind === 'plaster') {
          shade *= 1 + md * 0.06;
          if (crackF && crackF[p] < 0.02 && lowF[p] > 0.1) { shade *= 0.7; hh -= 0.06; }
        } else if (S.kind === 'grass') {
          const blade = hash2(x >> 1, (y >> 2) + (x & 1), 31);
          shade *= 0.86 + blade * 0.3;
          hh += blade * 0.1;
          g *= 1 + lowF[p] * 0.12;
          r *= 1 - lowF[p] * 0.08;
        } else if (S.kind === 'mud') {
          const wet = md + lowF[p] * 0.5;
          if (wet > 0.08) {
            const k = Math.min(1, (wet - 0.08) * 4);
            shade *= 1 - k * 0.22;
            ro = ro * (1 - k) + 0.12 * k;
            sp = sp * (1 - k) + 0.75 * k;
            hh -= k * 0.08;
          }
        } else if (pebbleF) {
          const pv = pebbleF[p];
          const p1 = pv % 4;
          if (p1 < 0.3) { shade *= 1.05 + hash2(Math.floor(pv / 4), 3, 5) * 0.2; hh += (0.3 - p1) * 0.5; }
          if (crackF && crackF[p] < 0.03) { shade *= 0.7; hh -= 0.08; }
        } else if (rippleF) {
          hh = rippleF[p] * 0.5 + 0.5;
          shade *= 1 + rippleF[p] * 0.08;
        }

        // Moss: climbs from the floor seam on walls, follows mortar seams on floors.
        if (S.moss) {
          const climb = S.floor ? 0 : Math.max(0, (v - 0.55) * 2.2);
          const m = Math.min(1, Math.max(0, (climb + crevice * 0.9) * (0.65 + md * 1.2) * S.moss * 1.6 - 0.25));
          if (m > 0) {
            const k = Math.min(1, m * 1.4);
            const mg = 0.75 + gr * 0.5;
            r = r * (1 - k) + 54 * mg * k;
            g = g * (1 - k) + 96 * mg * k;
            b = b * (1 - k) + 40 * mg * k;
            hh += k * 0.08;
            ro = ro * (1 - k) + 0.95 * k;
            sp *= 1 - k * 0.8;
            me = 0;
          }
        }
        col[p * 3] = r * shade;
        col[p * 3 + 1] = g * shade;
        col[p * 3 + 2] = b * shade;
        h[p] = hh;
        rough[p] = ro;
        spec[p] = sp;
        metal[p] = me;
      }
    }
    // Normals from height (wrapping central differences) and cavity from local height deficit.
    const base4 = t * N * N * 4;
    for (let y = 0; y < N; y++) {
      const ym = ((y - 1) & M) * N;
      const yp = ((y + 1) & M) * N;
      const y2m = ((y - 2) & M) * N;
      const y2p = ((y + 2) & M) * N;
      const y3m = ((y - 3) & M) * N;
      const y3p = ((y + 3) & M) * N;
      const yr = y * N;
      for (let x = 0; x < N; x++) {
        const p = yr + x;
        const xm = (x - 1) & M;
        const xp = (x + 1) & M;
        const x2m = (x - 2) & M;
        const x2p = (x + 2) & M;
        const dx = (h[yr + xp] - h[yr + xm]) * S.bump;
        const dy = (h[yp + x] - h[ym + x]) * S.bump;
        const l = Math.hypot(dx, dy, 1);
        const avg = (h[yr + ((x - 3) & M)] + h[yr + ((x + 3) & M)] + h[y3m + x] + h[y3p + x] + h[y2m + x2m] + h[y2p + x2p] + h[y2p + x2m] + h[y2m + x2p]) / 8;
        const cav = Math.max(0.45, Math.min(1, 1 - (avg - h[p]) * 2.2));
        const ao = 0.75 + 0.25 * cav;
        const o = base4 + p * 4;
        albedo[o] = Math.min(255, col[p * 3] * ao);
        albedo[o + 1] = Math.min(255, col[p * 3 + 1] * ao);
        albedo[o + 2] = Math.min(255, col[p * 3 + 2] * ao);
        albedo[o + 3] = 255;
        normal[o] = (-dx / l) * 127.5 + 127.5;
        normal[o + 1] = (-dy / l) * 127.5 + 127.5;
        normal[o + 2] = (1 / l) * 127.5 + 127.5;
        normal[o + 3] = 255;
        mat[o] = Math.max(0.04, Math.min(1, rough[p])) * 255;
        mat[o + 1] = Math.max(0, Math.min(1, spec[p])) * 255;
        mat[o + 2] = cav * 255;
        mat[o + 3] = metal[p] * 255;
      }
    }
  }
  return { size: N, layers, albedo, normal, mat };
}

/**
 * Tileable world-space grunge for the shader's detail pass: R fine grain, G broad
 * discolouration, B roughness variation.
 * @returns {Uint8Array} RGBA, MAT_SIZE x MAT_SIZE
 */
export function buildDetailTexture() {
  const N = MAT_SIZE;
  const fine = makeFbm(16, 4, 4242);
  const broad = makeFbm(2, 4, 4343);
  const cells = makeWorley(9, 4444);
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const [f1, f2] = cells(u, v);
      const o = (y * N + x) * 4;
      out[o] = Math.max(0, Math.min(255, 128 + fine(u, v) * 150 - (f2 - f1 < 0.04 ? 40 : 0)));
      out[o + 1] = Math.max(0, Math.min(255, 128 + broad(u, v) * 170));
      out[o + 2] = Math.max(0, Math.min(255, 128 + fine(v, u) * 120));
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Upload a canvas as a mipmapped 2D texture. Magnification stays LINEAR; the shader's
 * pixel-art sampler keeps texel edges crisp while mips stop distant shimmer.
 * @param {WebGL2RenderingContext} gl @param {HTMLCanvasElement} canvas @param {number} maxLevel highest mip level
 * @param {number} aniso anisotropy (1 = off) @returns {WebGLTexture}
 */
export function uploadTexture(gl, canvas, maxLevel, aniso) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
  gl.generateMipmap(gl.TEXTURE_2D);
  setFilters(gl, gl.TEXTURE_2D, gl.CLAMP_TO_EDGE, aniso);
  return tex;
}

/**
 * Upload stacked RGBA layers as a mipmapped, repeating 2D texture array.
 * @param {WebGL2RenderingContext} gl @param {Uint8Array} data @param {number} size @param {number} layers @param {number} aniso
 * @returns {WebGLTexture}
 */
export function uploadArray(gl, data, size, layers, aniso) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, size, size, layers, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  setFilters(gl, gl.TEXTURE_2D_ARRAY, gl.REPEAT, aniso);
  return tex;
}

/**
 * Upload a square RGBA buffer as a mipmapped, repeating 2D texture.
 * @param {WebGL2RenderingContext} gl @param {Uint8Array} data @param {number} size @param {number} aniso @returns {WebGLTexture}
 */
export function uploadRepeating(gl, data, size, aniso) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Could not create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  setFilters(gl, gl.TEXTURE_2D, gl.REPEAT, aniso);
  return tex;
}

/** @param {WebGL2RenderingContext} gl @param {number} target @param {number} wrap @param {number} aniso */
function setFilters(gl, target, wrap, aniso) {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
  if (aniso > 1) gl.texParameterf(target, 0x84fe /* TEXTURE_MAX_ANISOTROPY_EXT */, aniso);
}
