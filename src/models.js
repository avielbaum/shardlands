/**
 * @file Procedural 3D geometry for the renderer. A mesh builder with smooth (or flat) normals for
 * surfaces of revolution, ellipsoids, rounded boxes, tubes and tori; the prop, foliage, item and
 * architecture library that replaces the old billboard sprites; articulated character rigs posed
 * procedurally each frame (breathing idle, walk stride, weapon swing, stagger, collapse); and the
 * first-person viewmodels. Units are metres, +Y is up and every model faces +Z.
 */
import { hash2, mulberry32, TILE } from './world.js';
import { CHAR_LAYER, CHAR_BASE, EYE_TILE, EYE_SPAN, MAT_SIZE } from './textures.js';
import { frontAt, weldIds } from './meshes.js';

/** Floats per vertex: pos3 normal3 uv2 colour3 (layer, rough, metal, emit)4 (sky, bone, sway)3. */
export const VERT = 18;
/** Bone matrices per skinned draw. */
export const MAX_BONES = 16;
/** Tessellation multiplier while building (0.5 for the far LOD). */
let DETAIL = 1;

// ---------------------------------------------------------------------------
// Matrices (column-major Float32Array(16))
// ---------------------------------------------------------------------------

/** @returns {Float32Array} */
export function ident() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major a * b. @param {Float32Array} a @param {Float32Array} b @param {Float32Array} [o] */
export function mul(a, b, o = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}

/**
 * Translate * Ry * Rx * Rz * uniform scale.
 * @param {number} x @param {number} y @param {number} z @param {number} ry @param {number} rx @param {number} rz @param {number} s
 * @param {Float32Array} [o]
 */
export function trs(x, y, z, ry, rx, rz, s, o = new Float32Array(16)) {
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx), cz = Math.cos(rz), sz = Math.sin(rz);
  o[0] = (cy * cz + sy * sx * sz) * s; o[1] = cx * sz * s; o[2] = (-sy * cz + cy * sx * sz) * s; o[3] = 0;
  o[4] = (-cy * sz + sy * sx * cz) * s; o[5] = cx * cz * s; o[6] = (sy * sz + cy * sx * cz) * s; o[7] = 0;
  o[8] = sy * cx * s; o[9] = -sx * s; o[10] = cy * cx * s; o[11] = 0;
  o[12] = x; o[13] = y; o[14] = z; o[15] = 1;
  return o;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Mat
 * @property {number[]} c sRGB albedo 0..1
 * @property {number} r roughness
 * @property {number} m metalness
 * @property {number} e emission strength (albedo-coloured)
 * @property {number} l texture-array layer, or -1 for a plain colour
 */

/** @param {string} hex @returns {number[]} */
const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];

/**
 * @param {string|number[]} c @param {number} r roughness @param {number} [m] metalness @param {number} [e] emission
 * @param {number} [l] texture layer (-1 plain colour) @returns {Mat}
 */
export function mat(c, r, m = 0, e = 0, l = -1) {
  return { c: typeof c === 'string' ? rgb(c) : c, r, m, e, l };
}

/** Same material with its colour scaled. @param {Mat} M @param {number} k @returns {Mat} */
const shade = (M, k) => ({ ...M, c: M.c.map((v) => (M.l >= 0 ? v * k : Math.min(1, v * k))) });

/**
 * Character material on a textured layer (wool, skin, leather, hair): the layer's neutral grey
 * albedo is tinted so it averages to `hex`.
 * @param {string} hex @param {number} layer CHAR_LAYER entry @param {number} [r] roughness (plain-colour LOD hint)
 * @returns {Mat}
 */
function fab(hex, layer, r = 0.8) {
  const base = CHAR_BASE ** 2.2;
  return mat(rgb(hex).map((c) => c ** 2.2 / base), r, 0, 0, layer);
}
const CL = CHAR_LAYER;

/** Muted, weathered palette. */
const M = {
  bark: mat('#4b3b2d', 0.92), barkDark: mat('#30261f', 0.95), barkPale: mat('#6c6255', 0.9),
  leaf: mat('#4e5a32', 0.8), leafDark: mat('#36432a', 0.82), leafLey: mat('#3f5c4e', 0.75), pine: mat('#2c3d30', 0.85),
  reed: mat('#7a7348', 0.8), reedHead: mat('#4a3424', 0.9), moss: mat('#4d5a2e', 0.95),
  stone: mat('#8b877c', 0.85, 0, 0, TILE.LIMESTONE), stoneCliff: mat('#80796d', 0.88, 0, 0, TILE.CLIFF), basalt: mat('#5b5652', 0.7, 0, 0, TILE.BASALT),
  stonePlain: mat('#7b776e', 0.85), slate: mat('#4d5156', 0.75),
  wood: mat('#5f4631', 0.75), woodDark: mat('#3d2d21', 0.8), woodLight: mat('#7d6247', 0.7), plank: mat('#9a8a78', 0.7, 0, 0, TILE.PLANK),
  iron: mat('#3d3e41', 0.55, 1), ironRust: mat('#4e3a2c', 0.8, 0.4), steel: mat('#8a8d92', 0.3, 1),
  brass: mat('#b08a4e', 0.38, 1), bronze: mat('#8a6a3c', 0.45, 1), brassTex: mat('#c8c0b0', 0.4, 1, 0, TILE.BRASS), gearTex: mat('#c8c0b0', 0.4, 1, 0, TILE.GEAR),
  verdigris: mat('#5a7a6a', 0.7, 0.3),
  leather: mat('#4a3324', 0.7), leatherDark: mat('#2e2119', 0.75), rope: mat('#8a7655', 0.95),
  linen: mat('#b7aa92', 0.9), parchment: mat('#c9b88f', 0.92), clay: mat('#8f5f48', 0.8, 0, 0, TILE.ROOF),
  ley: mat('#6fe8ff', 0.2, 0, 3.5), leySoft: mat('#58c8dc', 0.3, 0, 1.6), ember: mat('#ff7a2a', 0.6, 0, 3), flame: mat('#ffb050', 0.6, 0, 2.6),
  coal: mat('#2a1f1a', 0.9), glass: mat('#ffd9a0', 0.15, 0, 3), void: mat('#050608', 1),
  water: mat('#1c2a2c', 0.08), crystal: mat('#8fe3f0', 0.12, 0, 2.2), crystalDim: mat('#3d5a63', 0.25, 0, 0.3),
};

// ---------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------

/** Growable buffer of non-indexed triangles in the renderer's vertex format. */
export class Mesh {
  /** @param {number} [verts] initial capacity */
  constructor(verts = 1024) {
    this.data = new Float32Array(verts * VERT);
    this.n = 0;
    this.m = ident();
    /** @type {Float32Array[]} */
    this.stack = [];
    /**
     * Bind-pose world matrix per bone, for rigs. When set, choosing a bone starts drawing in that
     * bone's frame, so the geometry lands in model space where the skin matrices expect it.
     * @type {Float32Array[]|null}
     */
    this.binds = null;
    this._bone = 0;
    this.sky = 1;
    /** Constant wind-sway weight, plus a weight per metre of model-space height. */
    this.sw = 0;
    this.swY = 0;
    /** UV scale for textured materials. */
    this.uvs = 1;
  }

  get count() {
    return this.n / VERT;
  }

  /** Bone (skinning slot) for the vertices that follow. */
  get bone() {
    return this._bone;
  }

  set bone(b) {
    this._bone = b;
    if (this.binds) this.m = this.binds[b].slice();
  }

  reset() {
    this.n = 0;
    this.m = ident();
    this.stack.length = 0;
    this.bone = 0;
    this.sw = 0;
    this.swY = 0;
    return this;
  }

  push() {
    this.stack.push(this.m);
    this.m = this.m.slice();
    return this;
  }

  pop() {
    this.m = /** @type {Float32Array} */ (this.stack.pop());
    return this;
  }

  /** Append a local transform. @param {number} x @param {number} y @param {number} z @param {number} [ry] @param {number} [rx] @param {number} [rz] @param {number} [s] */
  at(x, y, z, ry = 0, rx = 0, rz = 0, s = 1) {
    this.m = mul(this.m, trs(x, y, z, ry, rx, rz, s));
    return this;
  }

  /** @param {number} floats */
  _reserve(floats) {
    if (this.n + floats <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.n + floats));
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }

  /**
   * One vertex with no transform.
   * @param {number} x @param {number} y @param {number} z @param {number} nx @param {number} ny @param {number} nz
   * @param {number} u @param {number} v @param {number[]} c @param {number} layer @param {number} rough @param {number} metal
   * @param {number} emit @param {number} sky @param {number} bone @param {number} sway
   */
  raw(x, y, z, nx, ny, nz, u, v, c, layer, rough, metal, emit, sky, bone, sway) {
    this._reserve(VERT);
    const d = this.data;
    let i = this.n;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = nx; d[i++] = ny; d[i++] = nz; d[i++] = u; d[i++] = v;
    d[i++] = c[0]; d[i++] = c[1]; d[i++] = c[2]; d[i++] = layer; d[i++] = rough; d[i++] = metal; d[i++] = emit;
    d[i++] = sky; d[i++] = bone; d[i++] = sway;
    this.n = i;
  }

  /** Transformed vertex. @param {number[]} p @param {number[]} n @param {number} u @param {number} v @param {Mat} mt */
  v(p, n, u, v, mt) {
    const m = this.m;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    let nx = m[0] * n[0] + m[4] * n[1] + m[8] * n[2];
    let ny = m[1] * n[0] + m[5] * n[1] + m[9] * n[2];
    let nz = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const sway = this.sw + this.swY * Math.max(0, y);
    this.raw(x, y, z, nx, ny, nz, u * this.uvs, v * this.uvs, mt.c, mt.l, mt.r, mt.m, mt.e, this.sky, this.bone, sway);
  }

  /**
   * Emit a parametric grid of points as triangles with smooth (or flat) normals.
   * @param {number[][][]} P rows (v) of columns (u) of [x, y, z]
   * @param {number[][][]} T matching [u, v] texture coordinates
   * @param {Mat|((row: number) => Mat)} mt material, or one per row
   * @param {boolean} wrapU first and last columns coincide
   * @param {{flat?: boolean, flip?: boolean, smooth?: number, disp?: (x:number, y:number, z:number) => number, tint?: (x:number, y:number, z:number) => number[]}} [o]
   *   smooth: Laplacian iterations; disp: offset along the normal (metres) at a point; tint: colour multiplier at a point
   * @returns {number[][][]} the final (smoothed, displaced) points
   */
  grid(P, T, mt, wrapU, o = {}) {
    const matOf = typeof mt === 'function' ? mt : () => mt;
    const rows = P.length;
    const cols = P[0].length;
    const sign = o.flip ? -1 : 1;
    // Laplacian smoothing: relax interior points toward their four neighbours (end rows stay put
    // so parts still meet their joints).
    for (let it = 0; it < (o.smooth ?? 0); it++) {
      const Q = P.map((r) => r.map((p) => p.slice()));
      for (let j = 1; j < rows - 1; j++) {
        for (let i = 0; i < cols; i++) {
          if (!wrapU && (i === 0 || i === cols - 1)) continue;
          const il = i > 0 ? i - 1 : cols - 2;
          const ir = i < cols - 1 ? i + 1 : 1;
          for (let k = 0; k < 3; k++) Q[j][i][k] = P[j][i][k] * 0.5 + (P[j][il][k] + P[j][ir][k] + P[j - 1][i][k] + P[j + 1][i][k]) * 0.125;
        }
        if (wrapU) Q[j][cols - 1] = Q[j][0].slice();
      }
      P = Q;
    }
    let N = gridNormals(P, wrapU, sign);
    // Organic imperfection: push every point along its normal by a noise field, then re-derive normals.
    if (o.disp) {
      const disp = o.disp;
      P = P.map((r, j) => r.map((p, i) => {
        const d = disp(p[0], p[1], p[2]);
        return [p[0] + N[j][i][0] * d, p[1] + N[j][i][1] * d, p[2] + N[j][i][2] * d];
      }));
      if (wrapU) for (const r of P) r[cols - 1] = r[0].slice();
      N = gridNormals(P, wrapU, sign);
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const q = [[j, i], [j, i + 1], [j + 1, i + 1], [j + 1, i]];
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
          const [a, b, c] = tri.map((k) => q[k]);
          let fn = null;
          if (o.flat) {
            fn = cross(sub(P[c[0]][c[1]], P[a[0]][a[1]]), sub(P[b[0]][b[1]], P[a[0]][a[1]]));
            const l = Math.hypot(fn[0], fn[1], fn[2]);
            if (l < 1e-12) continue;
            fn = [(fn[0] / l) * sign, (fn[1] / l) * sign, (fn[2] / l) * sign];
          }
          for (const [jj, ii] of [a, b, c]) {
            const mt0 = matOf(jj);
            const k = o.tint ? o.tint(P[jj][ii][0], P[jj][ii][1], P[jj][ii][2]) : null;
            this.v(P[jj][ii], fn ?? N[jj][ii], T[jj][ii][0], T[jj][ii][1], k ? { ...mt0, c: [mt0.c[0] * k[0], mt0.c[1] * k[1], mt0.c[2] * k[2]] } : mt0);
          }
        }
      }
    }
    return P;
  }

  /**
   * Surface of revolution around +Y. Profile points are [radius, y], bottom to top.
   * grad shades the colour from the first profile row to the last (self-occlusion for foliage).
   * @param {number[][]} prof @param {number} seg @param {Mat} mt
   * @param {{sx?: number, sz?: number, a0?: number, a1?: number, cap0?: boolean, cap1?: boolean, flat?: boolean,
   *   wob?: (x:number, y:number, z:number) => number, grad?: number[], smooth?: number, disp?: (x:number, y:number, z:number) => number}} [o]
   */
  lathe(prof, seg, mt, o = {}) {
    seg = Math.max(o.flat ? seg : 4, Math.round(seg * DETAIL));
    const sx = o.sx ?? 1;
    const sz = o.sz ?? 1;
    const a0 = o.a0 ?? 0;
    const a1 = o.a1 ?? Math.PI * 2;
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    /** @type {number[][][]} */
    const P = [];
    /** @type {number[][][]} */
    const T = [];
    let arc = 0;
    let rMax = 0;
    for (const [r] of prof) rMax = Math.max(rMax, r);
    const circ = (a1 - a0) * rMax * (sx + sz) * 0.5;
    for (let j = 0; j < prof.length; j++) {
      if (j) arc += Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]);
      const row = [];
      const trow = [];
      for (let i = 0; i <= seg; i++) {
        const a = a0 + ((a1 - a0) * i) / seg;
        const [r, y] = prof[j];
        let x = Math.cos(a) * r * sx;
        let z = Math.sin(a) * r * sz;
        let yy = y;
        if (o.wob) {
          const k = o.wob(x, y, z);
          x *= k;
          z *= k;
          yy = y * (0.6 + 0.4 * k);
        }
        row.push([x, yy, z]);
        trow.push([(circ * i) / seg, arc]);
      }
      if (full) {
        row[seg] = row[0].slice();
      }
      P.push(row);
      T.push(trow);
    }
    const g = o.grad;
    const F = this.grid(P, T, g ? (j) => shade(mt, g[0] + ((g[1] - g[0]) * j) / Math.max(1, prof.length - 1)) : mt, full, { flat: o.flat, smooth: o.smooth, disp: o.disp });
    this._caps(F, seg, mt, o.cap0 && prof[0][0] > 1e-4, o.cap1 && prof[prof.length - 1][0] > 1e-4);
    return this;
  }

  /**
   * Close the first and/or last ring of a grid with a fan.
   * @param {number[][][]} P @param {number} seg @param {Mat} mt @param {boolean|undefined} c0 @param {boolean|undefined} c1
   */
  _caps(P, seg, mt, c0, c1) {
    /** @type {[number, boolean|undefined][]} */
    const caps = [[0, c0], [P.length - 1, c1]];
    for (const [end, on] of caps) {
      if (!on) continue;
      const ring = P[end];
      const c = [0, 1, 2].map((k) => ring.slice(0, seg).reduce((s, p) => s + p[k], 0) / seg);
      const inner = P[end === 0 ? 1 : P.length - 2];
      // Cap faces away from the neighbouring ring.
      const n = norm(sub(c, inner.slice(0, seg).reduce((s, p) => [s[0] + p[0] / seg, s[1] + p[1] / seg, s[2] + p[2] / seg], [0, 0, 0])));
      for (let i = 0; i < seg; i++) {
        this.v(c, n, 0, 0, mt);
        this.v(ring[i], n, ring[i][0], ring[i][2], mt);
        this.v(ring[i + 1], n, ring[i + 1][0], ring[i + 1][2], mt);
      }
    }
  }

  /**
   * Lofted surface through elliptical cross-sections, Catmull-Rom interpolated between rows.
   * rows: [y, rx, rz, cx?, cz?] bottom to top. folds adds gravity drapery that deepens toward
   * the lowest row: [count, depth in metres]. tatter rips the hem into ragged tongues and
   * notches: [depth in metres, seed]. focus (0..0.9, closed lofts only) packs columns toward +Z
   * so a face gets the detail and the back of the skull does not.
   * @param {number[][]} rows @param {number} seg @param {Mat} mt
   * @param {{sub?: number, a0?: number, a1?: number, cap0?: boolean, cap1?: boolean, smooth?: number, flat?: boolean,
   *   disp?: (x:number, y:number, z:number) => number, folds?: number[], grad?: number[], tatter?: number[], focus?: number,
   *   tint?: (x:number, y:number, z:number) => number[]}} [o]
   */
  loft(rows, seg, mt, o = {}) {
    seg = Math.max(6, Math.round(seg * DETAIL));
    const R = crPath(rows.map((r) => [r[0], r[1], r[2], r[3] ?? 0, r[4] ?? 0]), Math.max(1, Math.round((o.sub ?? 3) * DETAIL)));
    const a0 = o.a0 ?? 0;
    const a1 = o.a1 ?? Math.PI * 2;
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const yTop = R[R.length - 1][0];
    const yBot = R[0][0];
    const span = a1 - a0;
    const focus = full ? o.focus ?? 0 : 0;
    // Closed lofts wrap a whole number of texture tiles, so the layer has no seam at the back.
    let rMax = 0;
    for (const r of R) rMax = Math.max(rMax, (r[1] + r[2]) / 2);
    const uLen = Math.max(1, Math.round(span * rMax * this.uvs)) / this.uvs;
    const tat = o.tatter;
    const band = tat ? tat[0] * 2.5 : 0;
    /** @type {number[][][]} */
    const P = [];
    /** @type {number[][][]} */
    const T = [];
    let arc = 0;
    for (let j = 0; j < R.length; j++) {
      const [y, rx, rz, cx, cz] = R[j];
      if (j) arc += Math.hypot(rx - R[j - 1][1], y - R[j - 1][0]);
      const drop = o.folds ? ((yTop - y) / Math.max(1e-6, yTop - yBot)) ** 1.5 : 0;
      // Torn hem: each column is ripped back by its own amount, fading out up the band.
      const rip = tat ? Math.max(0, 1 - (y - yBot) / band) ** 1.4 : 0;
      const row = [];
      const trow = [];
      for (let i = 0; i <= seg; i++) {
        const th = (span * i) / seg;
        const a = a0 + th + focus * Math.cos(th);
        const f = o.folds ? 1 + (o.folds[1] / Math.max(rx, rz)) * drop * Math.sin(a * o.folds[0] + j * 0.15) : 1;
        const tear = rip > 0 ? tat[0] * (0.08 + 0.92 * hash2(i % seg, Math.floor((i % seg) / 3), tat[1]) ** 2) * rip : 0;
        row.push([cx + Math.cos(a) * rx * f, y + tear, cz + Math.sin(a) * rz * f]);
        trow.push([full ? ((a - a0) / span) * uLen : ((a - a0) * (rx + rz)) / 2, arc]);
      }
      if (full) row[seg] = row[0].slice();
      P.push(row);
      T.push(trow);
    }
    const g = o.grad;
    const F = this.grid(P, T, g ? (j) => shade(mt, g[0] + ((g[1] - g[0]) * j) / Math.max(1, R.length - 1)) : mt, full, { smooth: o.smooth, disp: o.disp, flat: o.flat, tint: o.tint });
    if (full) this._caps(F, seg, mt, o.cap0, o.cap1);
    return this;
  }

  /**
   * Sweep a variable elliptical cross-section along a Catmull-Rom spline (limbs, trunks,
   * branches, grips). Frames are parallel-transported so the tube never twists; radii are
   * [across, depth] (or one number), where "across" starts perpendicular to the path and +Z.
   * @param {number[][]} pts control points @param {(number|number[])[]} radii per control point
   * @param {number} seg @param {Mat} mt
   * @param {{sub?: number, cap0?: boolean, cap1?: boolean, smooth?: number, disp?: (x:number, y:number, z:number) => number}} [o]
   */
  sweep(pts, radii, seg, mt, o = {}) {
    seg = Math.max(5, Math.round(seg * DETAIL));
    const ctrl = pts.map((p, k) => {
      const r = radii[k];
      return [p[0], p[1], p[2], typeof r === 'number' ? r : r[0], typeof r === 'number' ? r : r[1]];
    });
    const S = crPath(ctrl, Math.max(1, Math.round((o.sub ?? 4) * DETAIL)));
    let rMax = 0;
    for (const q of S) rMax = Math.max(rMax, (q[3] + q[4]) / 2);
    const uLen = Math.max(1, Math.round(Math.PI * 2 * rMax * this.uvs)) / this.uvs;
    /** @type {number[][][]} */
    const P = [];
    /** @type {number[][][]} */
    const T = [];
    let nPrev = null;
    let arc = 0;
    for (let j = 0; j < S.length; j++) {
      const p = S[j];
      const t = norm(sub(S[Math.min(S.length - 1, j + 1)], S[Math.max(0, j - 1)]));
      let n;
      if (!nPrev) {
        const ref = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        n = norm(cross(t, ref));
      } else {
        // Parallel transport: remove the tangent component from the previous normal.
        const d = nPrev[0] * t[0] + nPrev[1] * t[1] + nPrev[2] * t[2];
        n = norm([nPrev[0] - t[0] * d, nPrev[1] - t[1] * d, nPrev[2] - t[2] * d]);
      }
      nPrev = n;
      const b = cross(t, n);
      if (j) arc += Math.hypot(p[0] - S[j - 1][0], p[1] - S[j - 1][1], p[2] - S[j - 1][2]);
      const row = [];
      const trow = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const c = Math.cos(a) * p[3];
        const s2 = Math.sin(a) * p[4];
        row.push([p[0] + n[0] * c + b[0] * s2, p[1] + n[1] * c + b[1] * s2, p[2] + n[2] * c + b[2] * s2]);
        trow.push([(i / seg) * uLen, arc]);
      }
      row[seg] = row[0].slice();
      P.push(row);
      T.push(trow);
    }
    const F = this.grid(P, T, mt, true, { smooth: o.smooth, disp: o.disp });
    this._caps(F, seg, mt, o.cap0, o.cap1);
    return this;
  }

  /**
   * Ellipsoid centred on the current origin.
   * @param {number} rx @param {number} ry @param {number} rz @param {number} seg @param {number} rings @param {Mat} mt
   * @param {{wob?: (x:number, y:number, z:number) => number, v0?: number, v1?: number, a0?: number, a1?: number, grad?: number[],
   *   smooth?: number, disp?: (x:number, y:number, z:number) => number}} [o]
   */
  ellipsoid(rx, ry, rz, seg, rings, mt, o = {}) {
    const v0 = o.v0 ?? -Math.PI / 2;
    const v1 = o.v1 ?? Math.PI / 2;
    rings = Math.max(3, Math.round(rings * DETAIL));
    /** @type {number[][]} */
    const prof = [];
    for (let j = 0; j <= rings; j++) {
      const t = v0 + ((v1 - v0) * j) / rings;
      prof.push([Math.cos(t), Math.sin(t) * ry]);
    }
    return this.lathe(prof, seg, mt, { sx: rx, sz: rz, wob: o.wob, a0: o.a0, a1: o.a1, grad: o.grad, smooth: o.smooth, disp: o.disp });
  }

  /** Sphere. @param {number} r @param {number} seg @param {Mat} mt */
  sphere(r, seg, mt) {
    return this.ellipsoid(r, r, r, seg, Math.max(3, Math.round(seg * 0.6)), mt);
  }

  /** Torus around +Y. @param {number} R ring radius @param {number} r tube radius @param {number} seg @param {number} tseg @param {Mat} mt */
  torus(R, r, seg, tseg, mt) {
    /** @type {number[][]} */
    const prof = [];
    for (let j = 0; j <= tseg; j++) {
      // Starting at the bottom and moving outward keeps the normals pointing out of the tube.
      const t = -Math.PI / 2 + (j / tseg) * Math.PI * 2;
      prof.push([R + Math.cos(t) * r, Math.sin(t) * r]);
    }
    return this.lathe(prof, seg, mt);
  }

  /**
   * Rounded box (fillet radius r) centred on the current origin, with smooth normals around its edges.
   * @param {number} hx @param {number} hy @param {number} hz half extents @param {number} r @param {Mat} mt
   */
  box(hx, hy, hz, r, mt) {
    r = Math.max(0.002, Math.min(r, hx * 0.95, hy * 0.95, hz * 0.95));
    const h = [hx, hy, hz];
    const inner = h.map((v) => v - r);
    // One bevel strip per edge: its smooth normals read as a rounded fillet under lighting.
    /** @param {number} k */
    const ticks = (k) => [-h[k], -inner[k], inner[k], h[k]];
    const segs = 3;
    for (let ax = 0; ax < 3; ax++) {
      for (const s of [-1, 1]) {
        const ua = (ax + 1) % 3;
        const va = (ax + 2) % 3;
        const U = ticks(ua);
        const V = ticks(va);
        /** @type {number[][][]} */
        const P = [];
        /** @type {number[][][]} */
        const T = [];
        /** @type {number[][][]} */
        const Nn = [];
        for (const vv of V) {
          const row = [];
          const trow = [];
          const nrow = [];
          for (const uu of U) {
            const p = [0, 0, 0];
            p[ax] = s * h[ax];
            p[ua] = uu;
            p[va] = vv;
            const c = p.map((x, k) => Math.max(-inner[k], Math.min(inner[k], x)));
            const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
            const l = Math.hypot(d[0], d[1], d[2]);
            const n = l > 1e-9 ? d.map((x) => x / l) : [0, 0, 0];
            if (l <= 1e-9) n[ax] = s;
            row.push([c[0] + n[0] * r, c[1] + n[1] * r, c[2] + n[2] * r]);
            nrow.push(n);
            trow.push([uu + hx + hz, vv + hy]);
          }
          P.push(row);
          T.push(trow);
          Nn.push(nrow);
        }
        for (let j = 0; j < segs; j++) {
          for (let i = 0; i < segs; i++) {
            for (const [a, b, c] of [[[j, i], [j, i + 1], [j + 1, i + 1]], [[j, i], [j + 1, i + 1], [j + 1, i]]]) {
              for (const [jj, ii] of [a, b, c]) this.v(P[jj][ii], Nn[jj][ii], T[jj][ii][0], T[jj][ii][1], mt);
            }
          }
        }
      }
    }
    return this;
  }

  /**
   * Tapered tube between two points (limbs, branches, chains, posts).
   * @param {number[]} a @param {number[]} b @param {number} r0 @param {number} r1 @param {number} seg @param {Mat} mt
   * @param {{cap?: boolean, mid?: number}} [o] mid bulges the middle ring
   */
  tube(a, b, r0, r1, seg, mt, o = {}) {
    const d = sub(b, a);
    const len = Math.hypot(d[0], d[1], d[2]) || 1e-6;
    const y = d.map((x) => x / len);
    const ref = Math.abs(y[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const x = norm(cross(ref, y));
    const z = cross(x, y);
    const basis = new Float32Array([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, a[0], a[1], a[2], 1]);
    this.push();
    this.m = mul(this.m, basis);
    const prof = o.mid ? [[r0, 0], [(r0 + r1) * 0.5 * o.mid, len * 0.5], [r1, len]] : [[r0, 0], [r1, len]];
    this.lathe(prof, seg, mt, { cap0: o.cap, cap1: o.cap });
    this.pop();
    return this;
  }

  /** Flat quad from four corners (any winding); n is its normal. @param {number[][]} p @param {number[]} n @param {Mat} mt @param {number[][]} [uv] */
  quad(p, n, mt, uv) {
    const t = uv ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) this.v(p[k], n, t[k][0], t[k][1], mt);
    return this;
  }

  /** Flat triangle. @param {number[][]} p @param {Mat} mt @param {number[][]} [uv] */
  tri(p, mt, uv) {
    const n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    const t = uv ?? [[0, 0], [1, 0], [0.5, 1]];
    for (let k = 0; k < 3; k++) this.v(p[k], n, t[k][0], t[k][1], mt);
    return this;
  }

  /**
   * Append another mesh transformed by m (bone forced to 0, sky overridden).
   * @param {Mesh} src @param {Float32Array} m @param {number} sky
   */
  append(src, m, sky) {
    this._reserve(src.n);
    const s = src.data;
    const d = this.data;
    const k = Math.hypot(m[0], m[1], m[2]) || 1;
    for (let i = 0; i < src.n; i += VERT) {
      const x = s[i], y = s[i + 1], z = s[i + 2], nx = s[i + 3], ny = s[i + 4], nz = s[i + 5];
      const o = this.n;
      d[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
      d[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      d[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      d[o + 3] = (m[0] * nx + m[4] * ny + m[8] * nz) / k;
      d[o + 4] = (m[1] * nx + m[5] * ny + m[9] * nz) / k;
      d[o + 5] = (m[2] * nx + m[6] * ny + m[10] * nz) / k;
      for (let f = 6; f < 15; f++) d[o + f] = s[i + f];
      d[o + 15] = sky;
      d[o + 16] = 0;
      d[o + 17] = s[i + 17];
      this.n += VERT;
    }
  }
}

/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a */
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/**
 * Normals of a parametric grid by central differences (poles borrow the neighbouring row).
 * @param {number[][][]} P @param {boolean} wrapU @param {number} sign
 */
function gridNormals(P, wrapU, sign) {
  const rows = P.length;
  const cols = P[0].length;
  /** @type {number[][][]} */
  const N = [];
  for (let j = 0; j < rows; j++) {
    N.push([]);
    for (let i = 0; i < cols; i++) {
      const il = i > 0 ? i - 1 : wrapU ? cols - 2 : 0;
      const ir = i < cols - 1 ? i + 1 : wrapU ? 1 : cols - 1;
      const jd = Math.max(0, j - 1);
      const ju = Math.min(rows - 1, j + 1);
      let n = cross(sub(P[ju][i], P[jd][i]), sub(P[j][ir], P[j][il]));
      let l = Math.hypot(n[0], n[1], n[2]);
      if (l < 1e-9) {
        const jj = j === 0 ? Math.min(1, rows - 1) : Math.max(0, rows - 2);
        n = cross(sub(P[Math.min(rows - 1, jj + 1)][i], P[Math.max(0, jj - 1)][i]), sub(P[jj][ir], P[jj][il]));
        l = Math.hypot(n[0], n[1], n[2]) || 1;
      }
      N[j].push([(n[0] / l) * sign, (n[1] / l) * sign, (n[2] / l) * sign]);
    }
  }
  return N;
}

/**
 * Catmull-Rom resampling of a list of control rows (each an array of numbers), with `sub`
 * samples per span; the curve passes through every control row.
 * @param {number[][]} C @param {number} sub @returns {number[][]}
 */
function crPath(C, sub) {
  if (C.length < 2) return C.map((c) => c.slice());
  /** @type {number[][]} */
  const out = [];
  for (let k = 0; k < C.length - 1; k++) {
    const p0 = C[Math.max(0, k - 1)];
    const p1 = C[k];
    const p2 = C[k + 1];
    const p3 = C[Math.min(C.length - 1, k + 2)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(p1.map((_, i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3)));
    }
  }
  out.push(C[C.length - 1].slice());
  return out;
}

/** Smooth 3D value noise for displacing rocks and foliage. @param {number} x @param {number} y @param {number} z @param {number} seed */
function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  /** @param {number} i @param {number} j @param {number} k */
  const h = (i, j, k) => hash2(i * 157 + k * 31, j * 113 - k * 17, seed);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h(ix, iy, iz), h(ix + 1, iy, iz), sx), l(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), sx), sy),
    l(l(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), sx), l(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), sx), sy),
    sz,
  ) * 2 - 1;
}

/**
 * Fractal (fBm) value noise, about [-1, 1]. @param {number} x @param {number} y @param {number} z
 * @param {number} seed @param {number} [oct]
 */
export function fbm3(x, y, z, seed, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    sum += noise3(x * f, y * f, z * f, seed + o * 31) * amp;
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

/**
 * Normal displacement by fBm: freq in cycles per metre, amp in metres; ridge > 0 sharpens
 * the noise into chips and cracks; stretch elongates it along Y (bark, hair strands).
 * @param {number} freq @param {number} amp @param {number} seed @param {{ridge?: number, stretch?: number}} [o]
 */
const rough = (freq, amp, seed, o = {}) => (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
  const n = fbm3(x * freq, (y * freq) / (o.stretch ?? 1), z * freq, seed);
  return amp * (o.ridge ? n - o.ridge * Math.abs(n) * 2 : n);
};

/** Lumpy displacement for organic shapes. @param {number} freq @param {number} amp @param {number} seed */
const lumpy = (freq, amp, seed) => (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) =>
  1 + amp * (noise3(x * freq, y * freq, z * freq, seed) * 0.7 + noise3(x * freq * 2.3, y * freq * 2.3, z * freq * 2.3, seed + 9) * 0.3);

// ---------------------------------------------------------------------------
// Foliage and nature
// ---------------------------------------------------------------------------

/**
 * Recursive branch: a bending tube, then children, with foliage clumps at the tips.
 * @param {Mesh} m @param {() => number} rnd @param {number[]} p @param {number[]} dir @param {number} len @param {number} r
 * @param {number} depth @param {(m: Mesh, tip: number[], size: number) => void} leaf @param {Mat} barkM
 */
function branch(m, rnd, p, dir, len, r, depth, leaf, barkM) {
  // One continuous curved, tapering limb (a spline sweep), then its children.
  /** @type {number[][]} */
  const pts = [p];
  let d = dir;
  let cur = p;
  for (let s = 0; s < 3; s++) {
    d = norm([d[0] + (rnd() - 0.5) * 0.4, d[1] + 0.08, d[2] + (rnd() - 0.5) * 0.4]);
    cur = [cur[0] + (d[0] * len) / 3, cur[1] + (d[1] * len) / 3, cur[2] + (d[2] * len) / 3];
    pts.push(cur);
  }
  m.sw = Math.max(0, (p[1] - 1.2) * 0.04);
  m.sweep(pts, [r, r * 0.8, r * 0.62, r * 0.45], depth > 1 ? 10 : 6, barkM, { disp: rough(14, r * 0.12, Math.floor(rnd() * 999), { stretch: 3 }), sub: depth > 1 ? 3 : 2 });
  m.sw = 0;
  if (depth <= 0) {
    leaf(m, cur, len);
    return;
  }
  const kids = depth > 1 ? 3 : 2 + Math.floor(rnd() * 2);
  for (let k = 0; k < kids; k++) {
    const a = rnd() * Math.PI * 2;
    const spread = 0.55 + rnd() * 0.35;
    const nd = norm([d[0] + Math.cos(a) * spread, d[1] * 0.8 + 0.25, d[2] + Math.sin(a) * spread]);
    branch(m, rnd, cur, nd, len * (0.62 + rnd() * 0.18), r * 0.55, depth - 1, leaf, barkM);
  }
}

/**
 * A cluster of small, jagged leaf masses around a branch tip, darker underneath, so the
 * canopy reads as layered foliage rather than one smooth blob.
 * @param {Mesh} m @param {() => number} rnd @param {number[]} tip @param {number} size @param {Mat[]} mats
 */
function leafCluster(m, rnd, tip, size, mats) {
  const n = 2 + Math.floor(rnd() * 2);
  m.sw = 0.35;
  m.swY = 0.05;
  for (let k = 0; k < n; k++) {
    const s = (0.42 + rnd() * 0.3) * (0.7 + size * 0.3);
    const a = rnd() * Math.PI * 2;
    const d = k ? s * (0.6 + rnd() * 0.5) : 0;
    const tone = 0.75 + rnd() * 0.35;
    m.push().at(tip[0] + Math.cos(a) * d, tip[1] + 0.1 + (rnd() - 0.3) * s * 0.7, tip[2] + Math.sin(a) * d, rnd() * 6);
    // Leaf masses: broken, clumped silhouettes from ridged fBm, darker underneath.
    m.ellipsoid(s, s * 0.68, s * 0.9, 10, 7, shade(mats[k % mats.length], tone), { disp: rough(3.2, s * 0.32, Math.floor(rnd() * 999), { ridge: 0.25 }), grad: [0.45, 1.05] });
    m.pop();
  }
  m.sw = 0;
  m.swY = 0;
}

/** Broadleaf ley-wood tree, ~5.2 m. @param {Mesh} m @param {() => number} rnd */
function buildLeyTree(m, rnd) {
  /** @param {Mesh} mm @param {number[]} tip @param {number} size */
  const leaf = (mm, tip, size) => {
    leafCluster(mm, rnd, tip, size, [M.leaf, M.leafLey, M.leafDark]);
    // Faint ley blossoms caught in the canopy.
    if (rnd() < 0.5) mm.push().at(tip[0], tip[1] - 0.2, tip[2]).sphere(0.05, 6, M.leySoft).pop();
  };
  // A leaning, flared trunk with vertical bark ridges, and buttress roots into the ground.
  const lean = [(rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.2];
  m.sweep([[0, -0.25, 0], [lean[0] * 0.3, 0.6, lean[1] * 0.3], [lean[0], 1.4, lean[1]], [lean[0] * 0.6, 2.0, lean[1] * 0.6]], [[0.4, 0.38], [0.25, 0.24], [0.2, 0.19], [0.17, 0.16]], 24, M.bark,
    { disp: rough(9, 0.03, 5, { stretch: 4, ridge: 0.3 }), cap1: true });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rnd();
    m.sweep([[Math.cos(a) * 0.12, 0.45, Math.sin(a) * 0.12], [Math.cos(a) * 0.38, 0.05, Math.sin(a) * 0.38], [Math.cos(a) * 0.7, -0.12, Math.sin(a) * 0.7]], [0.12, 0.08, 0.03], 8, M.barkDark,
      { disp: rough(12, 0.012, k + 9, { stretch: 3 }), cap1: true, sub: 2 });
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rnd() * 0.8;
    branch(m, rnd, [lean[0] * 0.8, 1.8, lean[1] * 0.8], norm([Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6]), 1.5 + rnd() * 0.4, 0.15, 1, leaf, M.bark);
  }
  leaf(m, [lean[0] * 0.6, 3.6, lean[1] * 0.6], 1.4);
}

/** Conifer, ~5.6 m. @param {Mesh} m @param {() => number} rnd */
function buildPine(m, rnd) {
  m.sweep([[0, -0.15, 0], [0, 1.5, 0.02], [0.02, 3.5, 0], [0, 5.4, 0]], [0.27, 0.19, 0.13, 0.04], 16, M.barkDark, { disp: rough(10, 0.015, 3, { stretch: 4, ridge: 0.3 }), cap1: true });
  m.sw = 0;
  // Ragged, drooping skirts of needles, darker toward their undersides and slightly askew.
  for (let k = 0; k < 7; k++) {
    const y = 0.9 + k * 0.62;
    const r = (1.6 - k * 0.2) * (0.85 + rnd() * 0.3);
    m.swY = 0.06;
    m.push().at(0, y, 0, rnd() * 6, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12);
    m.lathe([[0.15, 0.1], [r * 0.85, -0.25], [r, -0.12], [r * 0.5, 0.45], [0.05, 0.95]], 20,
      shade(M.pine, 0.8 + rnd() * 0.3), { disp: rough(4.5, r * 0.11, k * 7 + Math.floor(rnd() * 99), { ridge: 0.4 }), grad: [0.4, 1.05] });
    m.pop();
  }
  m.swY = 0;
}

/** Bare, twisted dead tree, ~3.8 m. @param {Mesh} m @param {() => number} rnd */
function buildDeadTree(m, rnd) {
  m.sweep([[0, -0.2, 0], [0.06, 0.6, 0.02], [-0.03, 1.2, 0.05], [0.02, 1.6, 0]], [0.3, 0.22, 0.17, 0.14], 18, M.barkPale, { disp: rough(8, 0.025, 11, { stretch: 3, ridge: 0.45 }), cap1: true });
  const none = () => {};
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rnd();
    branch(m, rnd, [0.02, 1.5, 0], norm([Math.cos(a) * 0.8, 1, Math.sin(a) * 0.8]), 1.2 + rnd() * 0.5, 0.11, 2, none, M.barkPale);
  }
}

/** Cluster of reeds and bulrushes, ~1.2 m. @param {Mesh} m @param {() => number} rnd */
function buildReeds(m, rnd) {
  for (let k = 0; k < 16; k++) {
    const a = rnd() * Math.PI * 2;
    const d = rnd() * 0.35;
    const h = 0.7 + rnd() * 0.55;
    const lean = (rnd() - 0.5) * 0.4;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const w = 0.025;
    const ca = Math.cos(a + 1.57) * w;
    const sa = Math.sin(a + 1.57) * w;
    const tx = x + Math.cos(a) * lean;
    const tz = z + Math.sin(a) * lean;
    const col = shade(M.reed, 0.8 + rnd() * 0.35);
    m.raw(x - ca, 0, z - sa, 0, 1, 0, 0, 0, col.c, -1, col.r, 0, 0, 1, 0, 0);
    m.raw(x + ca, 0, z + sa, 0, 1, 0, 1, 0, col.c, -1, col.r, 0, 0, 1, 0, 0);
    m.raw(tx, h, tz, 0, 1, 0, 0.5, 1, col.c, -1, col.r, 0, 0, 1, 0, 1);
    if (k % 4 === 0) {
      m.push().at(tx * 0.9, h * 0.85, tz * 0.9);
      m.sw = 0.9;
      m.ellipsoid(0.03, 0.09, 0.03, 6, 4, M.reedHead);
      m.sw = 0;
      m.pop();
    }
  }
}

/** Weathered boulder, ~0.8 m tall. @param {Mesh} m @param {() => number} rnd */
function buildRock(m, rnd) {
  const s = Math.floor(rnd() * 999);
  m.push().at(0, 0.12, 0, rnd() * 6);
  // Weathered, fractured boulder: ridged fBm gives chipped faces and cracks.
  m.ellipsoid(0.75, 0.55, 0.62, 22, 14, M.stoneCliff, { disp: rough(1.7, 0.2, s, { ridge: 0.35 }) });
  m.pop();
  if (rnd() < 0.7) m.push().at(0.62, 0.0, 0.35, rnd() * 6).ellipsoid(0.26, 0.17, 0.22, 12, 8, M.stoneCliff, { disp: rough(4, 0.07, s + 1, { ridge: 0.35 }) }).pop();
}

/** Broken colonnade fragment, ~2.6 m. @param {Mesh} m @param {() => number} rnd */
function buildRuin(m, rnd) {
  const seed = Math.floor(rnd() * 99);
  const chips = rough(7, 0.022, seed, { ridge: 0.6 });
  m.push().at(0, 0.12, 0).box(0.55, 0.12, 0.55, 0.05, M.stone).pop();
  const h = 1.5 + rnd() * 0.9;
  // Fluted shaft with a broken, jagged top and chipped, weathered faces.
  m.push().at(0, 0.24, 0);
  m.lathe([[0.38, 0], [0.33, 0.1], [0.29, 0.25], [0.27, h * 0.5], [0.25, h * 0.92], [0.18, h]], 28, M.stone,
    { wob: (x, y, z) => 1 + Math.cos(Math.atan2(z, x) * 12) * 0.035 + (y > h * 0.85 ? (noise3(x * 6, 0, z * 6, seed) - 0.5) * 0.3 : 0), cap1: true, disp: chips });
  m.pop();
  // Fallen capital and a drum.
  m.push().at(0.9, 0.17, 0.4, rnd() * 3, 0.2);
  m.box(0.36, 0.08, 0.36, 0.03, M.stone);
  m.at(0, -0.17, 0).lathe([[0.22, 0], [0.34, 0.09], [0.3, 0.1]], 24, M.stone, { disp: chips });
  m.pop();
  m.push().at(-0.8, 0.25, -0.3, rnd() * 3, 0, 1.45).lathe([[0.27, -0.3], [0.28, -0.1], [0.27, 0.3]], 24, M.stone, { cap0: true, cap1: true, disp: chips }).pop();
  for (let k = 0; k < 4; k++) m.push().at((rnd() - 0.5) * 2, 0.05, (rnd() - 0.5) * 2, rnd() * 6).ellipsoid(0.13, 0.08, 0.1, 10, 6, M.stone, { disp: rough(9, 0.025, seed + k, { ridge: 0.5 }) }).pop();
}

/** Market stall with a striped awning, ~2.4 m. @param {Mesh} m @param {() => number} rnd */
function buildStall(m, rnd) {
  for (const [x, z] of [[-1.1, -0.55], [1.1, -0.55], [-1.1, 0.55], [1.1, 0.55]]) m.tube([x, 0, z], [x, 2.1 + (z < 0 ? 0.3 : 0), z], 0.06, 0.05, 6, M.wood);
  m.push().at(0, 0.85, 0.35).box(1.15, 0.06, 0.32, 0.02, M.woodLight).pop();
  m.push().at(0, 0.45, 0.35).box(1.1, 0.4, 0.28, 0.02, M.woodDark).pop();
  // Awning: alternating stripes, sloping down toward the front.
  const cols = [mat('#8a4a3c', 0.9), mat('#c2b59a', 0.9)];
  for (let k = 0; k < 8; k++) {
    const x0 = -1.25 + k * 0.3125;
    const x1 = x0 + 0.3125;
    m.sw = 0.15;
    m.quad([[x0, 2.45, -0.7], [x1, 2.45, -0.7], [x1, 2.0, 0.85], [x0, 2.0, 0.85]], norm([0, 0.96, 0.28]), cols[k % 2]);
    m.quad([[x0, 2.0, 0.85], [x1, 2.0, 0.85], [x1, 1.85, 0.88], [x0, 1.85, 0.88]], [0, 0, 1], cols[k % 2]);
    m.sw = 0;
  }
  // Produce baskets.
  const fruit = [mat('#8c3a2a', 0.5), mat('#9a7a2c', 0.55), mat('#5a6a2c', 0.6)];
  for (let b = 0; b < 3; b++) {
    const bx = -0.7 + b * 0.7;
    m.push().at(bx, 0.91, 0.35).lathe([[0.16, 0], [0.22, 0.14], [0.23, 0.16]], 10, M.rope, { cap0: true }).pop();
    for (let f = 0; f < 6; f++) m.push().at(bx + (rnd() - 0.5) * 0.25, 1.07 + rnd() * 0.04, 0.35 + (rnd() - 0.5) * 0.25).sphere(0.055, 7, fruit[b]).pop();
  }
}

/** Stone well with a tiled hood, ~2.2 m. @param {Mesh} m */
function buildWell(m) {
  m.lathe([[0.95, 0], [0.98, 0.7], [0.9, 0.78], [0.75, 0.78], [0.72, 0.1]], 20, M.stone, { flat: false });
  m.push().at(0, 0.35, 0).lathe([[0.72, 0], [0, 0]], 20, M.water).pop();
  for (const x of [-0.85, 0.85]) m.tube([x, 0.7, 0], [x, 2.0, 0], 0.07, 0.065, 6, M.wood);
  m.tube([-1.0, 1.75, 0], [1.0, 1.75, 0], 0.06, 0.06, 6, M.woodDark, { cap: true });
  m.tube([0, 1.75, 0], [0, 1.1, 0], 0.012, 0.012, 4, M.rope);
  m.push().at(0, 0.95, 0).lathe([[0.12, 0], [0.15, 0.2]], 10, M.wood, { cap0: true }).pop();
  for (const s of [-1, 1]) {
    m.quad([[-1.15, 2.25, 0], [1.15, 2.25, 0], [1.15, 1.75, s * 0.75], [-1.15, 1.75, s * 0.75]], norm([0, 0.83, s * 0.55]), M.clay);
  }
}

/** Iron lamp post with a glazed lantern cage, ~3 m. @param {Mesh} m */
function buildLampPost(m) {
  m.lathe([[0.16, 0], [0.16, 0.12], [0.09, 0.2], [0.06, 0.4], [0.05, 2.5], [0.08, 2.55], [0.03, 2.62]], 10, M.iron);
  m.tube([0, 2.4, 0], [0.32, 2.55, 0], 0.025, 0.02, 5, M.iron);
  m.push().at(0.38, 2.25, 0);
  m.box(0.1, 0.14, 0.1, 0.01, M.glass);
  for (const [x, z] of [[-0.11, -0.11], [0.11, -0.11], [-0.11, 0.11], [0.11, 0.11]]) m.tube([x, -0.15, z], [x, 0.15, z], 0.012, 0.012, 4, M.iron);
  m.at(0, 0.17, 0).lathe([[0.15, 0], [0.04, 0.12], [0, 0.14]], 8, M.iron);
  m.pop();
}

/** Coopered barrel, ~0.9 m. @param {Mesh} m */
function buildBarrel(m) {
  m.lathe([[0.27, 0], [0.33, 0.25], [0.35, 0.45], [0.33, 0.65], [0.27, 0.9]], 16, M.wood,
    { wob: (x, _y, z) => 1 - Math.max(0, Math.cos(Math.atan2(z, x) * 16)) * 0.012, cap0: true, cap1: true });
  for (const y of [0.1, 0.32, 0.58, 0.8]) {
    const r = 0.27 + Math.sin((y / 0.9) * Math.PI) * 0.08 + 0.008;
    m.push().at(0, y, 0).lathe([[r, -0.025], [r, 0.025]], 16, M.iron).pop();
  }
}

/** Plank table, ~0.8 m. @param {Mesh} m */
function buildTable(m) {
  m.push().at(0, 0.78, 0).box(0.7, 0.035, 0.42, 0.015, M.woodLight).pop();
  for (const [x, z] of [[-0.6, -0.33], [0.6, -0.33], [-0.6, 0.33], [0.6, 0.33]]) m.push().at(x, 0.38, z).box(0.04, 0.38, 0.04, 0.01, M.wood).pop();
  m.push().at(0.2, 0.84, 0.05).lathe([[0.05, 0], [0.06, 0.12], [0.04, 0.14]], 8, M.iron, { cap0: true }).pop();
}

/** Scalding ley vent: a cracked basalt mound around a glowing throat. @param {Mesh} m */
function buildVent(m) {
  m.lathe([[0.9, 0], [0.75, 0.18], [0.45, 0.32], [0.3, 0.25], [0.28, 0.05]], 14, M.basalt, { wob: lumpy(2.2, 0.2, 77) });
  m.push().at(0, 0.12, 0).lathe([[0.3, 0], [0, 0]], 12, M.ley).pop();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.55, 0.2, Math.sin(a) * 0.55, -a).box(0.18, 0.012, 0.015, 0.006, M.leySoft).pop();
  }
}

/** Stone pedestal, ~1.1 m. @param {Mesh} m */
function buildPedestal(m) {
  m.lathe([[0.45, 0], [0.45, 0.12], [0.36, 0.18], [0.27, 0.25], [0.24, 0.9], [0.33, 0.98], [0.4, 1.08], [0.4, 1.14]], 16, M.stone, { cap1: true });
}

/** Ley pylon obelisk with brass bands and a floating crystal, ~4.2 m. @param {Mesh} m @param {() => number} rnd */
function buildPylon(m, rnd) {
  m.push().at(0, 0.2, 0).box(0.75, 0.2, 0.75, 0.06, M.stone).pop();
  for (let k = 0; k < 4; k++) {
    const y = 0.4 + k * 0.75;
    const w = 0.45 - k * 0.06;
    m.push().at(0, y + 0.37, 0, 0.785 * (k % 2) * 0.1).box(w, 0.37, w, 0.04, M.stone).pop();
    m.push().at(0, y + 0.02, 0).box(w + 0.03, 0.04, w + 0.03, 0.015, M.bronze).pop();
  }
  m.push().at(0, 3.9, 0, rnd()).lathe([[0, -0.45], [0.2, 0], [0, 0.55]], 6, M.crystal, { flat: true }).pop();
  for (let k = 0; k < 3; k++) m.push().at(0, 3.9, 0, k * 2.1, 0.4).torus(0.42, 0.012, 20, 4, M.brass).pop();
}

/** Ring of standing stones, ~3 m across. @param {Mesh} m @param {() => number} rnd */
function buildStones(m, rnd) {
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const h = 1.1 + rnd() * 0.9;
    m.push().at(Math.cos(a) * 1.35, h * 0.45, Math.sin(a) * 1.35, -a + Math.PI / 2, (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.12);
    m.box(0.28, h * 0.55, 0.16, 0.08, M.stoneCliff);
    if (k % 2 === 0) m.at(0, h * 0.1, 0.165).box(0.03, h * 0.3, 0.004, 0.003, M.leySoft);
    m.pop();
  }
  m.push().at(0, 0.12, 0).box(0.55, 0.12, 0.4, 0.06, M.stoneCliff).pop();
}

// ---------------------------------------------------------------------------
// Interactable props
// ---------------------------------------------------------------------------

/** @param {Mesh} m @param {boolean} open */
function buildChest(m, open) {
  m.push().at(0, 0.24, 0).box(0.42, 0.22, 0.27, 0.025, M.wood).pop();
  for (const x of [-0.3, 0.3]) m.push().at(x, 0.24, 0).box(0.03, 0.225, 0.28, 0.01, M.iron).pop();
  // Barrel-vaulted lid hinged at the back edge; its axis runs along X.
  m.push().at(0, 0.46, -0.27, 0, open ? -1.9 : 0);
  m.push().at(0, 0, 0.27, 0, 0, Math.PI / 2).lathe([[0.27, -0.42], [0.27, 0.42]], 10, M.wood, { sx: 0.6, a0: -Math.PI / 2, a1: Math.PI / 2, cap0: true, cap1: true }).pop();
  for (const x of [-0.3, 0.3]) m.push().at(x, 0, 0.27, 0, 0, Math.PI / 2).lathe([[0.28, -0.03], [0.28, 0.03]], 10, M.iron, { sx: 0.62, a0: -Math.PI / 2, a1: Math.PI / 2 }).pop();
  m.pop();
  m.push().at(0, 0.38, 0.28).box(0.05, 0.06, 0.02, 0.01, M.brass).pop();
  if (open) m.push().at(0, 0.44, 0).box(0.36, 0.02, 0.22, 0.01, mat('#c9a050', 0.35, 1, 0.6)).pop();
}

/** @param {Mesh} m @param {boolean} alt second flame frame */
function buildCampfire(m, alt) {
  const rnd = mulberry32(41);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.45, 0.05, Math.sin(a) * 0.45, rnd() * 6).ellipsoid(0.12, 0.08, 0.1, 7, 5, M.stoneCliff, { wob: lumpy(6, 0.25, k) }).pop();
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI + 0.3;
    m.tube([Math.cos(a) * 0.38, 0.03, Math.sin(a) * 0.38], [-Math.cos(a) * 0.1, 0.22, -Math.sin(a) * 0.1], 0.05, 0.04, 6, M.barkDark);
  }
  m.push().at(0, 0.05, 0).ellipsoid(0.24, 0.07, 0.24, 9, 4, M.ember).pop();
  flames(m, 3, 0.07, alt ? 0.45 : 0.6, alt ? 1 : 0, [M.flame, M.ember]);
}

/** @param {Mesh} m */
function buildBed(m) {
  m.push().at(0, 0.2, 0).box(0.5, 0.06, 1.0, 0.02, M.woodDark).pop();
  for (const [x, z] of [[-0.46, -0.96], [0.46, -0.96], [-0.46, 0.96], [0.46, 0.96]]) m.push().at(x, 0.15, z).box(0.04, 0.15 + (z < 0 ? 0.25 : 0.1), 0.04, 0.01, M.woodDark).pop();
  m.push().at(0, -0.04 + 0.42, -0.97).box(0.48, 0.18, 0.025, 0.01, M.wood).pop();
  m.push().at(0, 0.33, 0.02).box(0.46, 0.08, 0.95, 0.06, M.linen).pop();
  m.push().at(0, 0.39, 0.25).box(0.48, 0.05, 0.72, 0.05, mat('#5a4a5e', 0.95)).pop();
  m.push().at(0, 0.44, -0.75).box(0.3, 0.06, 0.13, 0.06, mat('#c4b8a2', 0.95)).pop();
}

/** @param {Mesh} m @param {boolean} down */
function buildLever(m, down) {
  m.push().at(0, 0.18, 0).box(0.22, 0.18, 0.16, 0.03, M.brassTex).pop();
  m.push().at(0, 0.36, 0, 0, down ? 0.75 : -0.75);
  m.tube([0, 0, 0], [0, 0.65, 0], 0.03, 0.025, 6, M.iron);
  m.at(0, 0.7, 0).sphere(0.06, 8, mat('#7a2a24', 0.4));
  m.pop();
  m.push().at(0, 0.36, 0, 0, 0, Math.PI / 2).lathe([[0.06, -0.24], [0.06, 0.24]], 10, M.brass, { cap0: true, cap1: true }).pop();
}

/** @param {Mesh} m @param {boolean} cracked */
function buildAnchor(m, cracked) {
  m.lathe([[0.45, 0], [0.45, 0.12], [0.3, 0.2], [0.22, 0.3], [0.2, 1.0], [0.32, 1.1], [0.3, 1.18]], 14, M.brassTex, { cap1: true });
  m.push().at(0, 0.62, 0).torus(0.27, 0.035, 16, 6, M.brass).pop();
  m.push().at(0, 1.55, 0, 0.4, cracked ? 0.35 : 0, cracked ? 0.2 : 0).lathe([[0, -0.35], [0.16, 0], [0, 0.45]], 6, cracked ? M.crystalDim : M.crystal, { flat: true }).pop();
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    m.tube([Math.cos(a) * 0.28, 1.15, Math.sin(a) * 0.28], [Math.cos(a) * 0.12, 1.35, Math.sin(a) * 0.12], 0.025, 0.018, 5, M.brass);
  }
}

/** @param {Mesh} m */
function buildGateCore(m) {
  m.lathe([[0.9, 0], [0.9, 0.15], [0.6, 0.3], [0.45, 0.4]], 16, M.brassTex, { cap1: true });
  const rnd = mulberry32(5);
  m.push().at(0, 1.2, 0).lathe([[0, -0.85], [0.42, -0.1], [0.35, 0.4], [0, 1.0]], 7, M.crystal, { flat: true }).pop();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.35, 0.6, Math.sin(a) * 0.35, -a, 0.5 * Math.cos(a), 0.5 * Math.sin(a)).lathe([[0, -0.1], [0.1, 0.05], [0, 0.4 + rnd() * 0.2]], 5, M.crystal, { flat: true }).pop();
  }
  for (let k = 0; k < 2; k++) m.push().at(0, 1.2, 0, k * 1.6, 1.2 - k * 0.7).torus(0.95, 0.04, 28, 6, M.brass).pop();
}

/** Dungeon stair entrance: a stone portal over descending steps. @param {Mesh} m */
function buildStairs(m) {
  for (let k = 0; k < 5; k++) m.push().at(0, 0.32 - k * 0.07, 0.5 - k * 0.25).box(0.65, 0.05, 0.14, 0.02, M.stone).pop();
  for (const x of [-0.82, 0.82]) {
    m.push().at(x, 1.0, -0.1).box(0.17, 1.0, 0.2, 0.04, M.stone).pop();
    m.push().at(x, 2.06, -0.1).box(0.21, 0.06, 0.24, 0.02, M.stone).pop();
  }
  // Segmental arch of voussoirs.
  for (let k = 0; k < 7; k++) {
    const a = Math.PI * (0.12 + (k / 6) * 0.76);
    m.push().at(Math.cos(a) * 0.82, 2.0 + Math.sin(a) * 0.5, -0.1, 0, 0, a - Math.PI / 2).box(0.13, 0.11, 0.2, 0.025, M.stone).pop();
  }
  m.quad([[-0.66, 0, -0.25], [0.66, 0, -0.25], [0.66, 2.3, -0.25], [-0.66, 2.3, -0.25]], [0, 0, 1], M.void);
  m.push().at(0, 0.18, 0.2).box(0.9, 0.18, 0.55, 0.05, M.stone).pop();
}

/** @param {Mesh} m */
function buildNotice(m) {
  for (const x of [-0.8, 0.8]) m.tube([x, 0, 0], [x, 2.2, 0], 0.06, 0.05, 6, M.wood);
  m.push().at(0, 1.45, 0.03).box(0.78, 0.45, 0.03, 0.01, M.woodLight).pop();
  const rnd = mulberry32(17);
  for (let k = 0; k < 5; k++) {
    m.push().at(-0.5 + k * 0.25 + (rnd() - 0.5) * 0.05, 1.45 + (rnd() - 0.5) * 0.3, 0.065, 0, 0, (rnd() - 0.5) * 0.15).box(0.09, 0.12, 0.004, 0.002, M.parchment).pop();
  }
  m.quad([[-0.95, 2.3, -0.25], [0.95, 2.3, -0.25], [0.95, 2.05, 0.3], [-0.95, 2.05, 0.3]], norm([0, 0.9, 0.42]), M.clay);
}

/** Stone lectern with a glowing inscribed slab. @param {Mesh} m */
function buildTablet(m) {
  m.lathe([[0.32, 0], [0.32, 0.08], [0.18, 0.15], [0.14, 0.75], [0.22, 0.82]], 12, M.stone, { cap1: true });
  m.push().at(0, 0.95, 0, 0, -0.5);
  m.box(0.34, 0.24, 0.04, 0.02, M.stone);
  for (let r = 0; r < 4; r++) m.push().at(-0.04 * (r % 2), 0.13 - r * 0.08, 0.042).box(0.22 - (r % 2) * 0.05, 0.008, 0.003, 0.002, M.ley).pop();
  m.pop();
}

/** @param {Mesh} m */
function buildBrazier(m) {
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    m.tube([Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4], [Math.cos(a) * 0.18, 0.75, Math.sin(a) * 0.18], 0.03, 0.025, 5, M.iron);
  }
  m.push().at(0, 0.7, 0).lathe([[0.1, 0], [0.32, 0.12], [0.42, 0.3], [0.38, 0.32]], 16, M.brassTex).pop();
  m.push().at(0, 0.95, 0).ellipsoid(0.33, 0.06, 0.33, 12, 4, M.ember).pop();
  m.push().at(0, 0.88, 0);
  flames(m, 4, 0.1, 0.5, 0, [M.ember, mat('#7fe9ff', 0.6, 0, 2.4)]);
  m.pop();
}

/**
 * Licking flame tongues: thin, twisted, lumpy teardrops that sway (the renderer adds a glow).
 * @param {Mesh} m @param {number} count @param {number} ring @param {number} h @param {number} phase @param {Mat[]} mats
 */
function flames(m, count, ring, h, phase, mats) {
  m.sw = 1.4;
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + phase;
    const hk = h * (1 - k * 0.12);
    m.push().at(Math.cos(a) * ring, 0.08, Math.sin(a) * ring, a, 0.12 * Math.cos(a), 0.12 * Math.sin(a));
    m.lathe([[0.075, 0], [0.085, hk * 0.15], [0.05, hk * 0.5], [0.02, hk * 0.82], [0, hk]], 7, mats[k % mats.length], { wob: lumpy(9, 0.35, k + 3) });
    m.pop();
  }
  m.sw = 0;
}

/** @param {Mesh} m @param {string} kind lotus | moss | bloom */
function buildHerb(m, kind) {
  const rnd = mulberry32(kind.length * 31);
  if (kind === 'lotus') {
    for (let k = 0; k < 3; k++) m.push().at((rnd() - 0.5) * 0.4, 0.01, (rnd() - 0.5) * 0.4, rnd() * 6).lathe([[0.18, 0], [0, 0.005]], 12, mat('#3f5a35', 0.5), { a0: 0, a1: 5.6 }).pop();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      m.push().at(0, 0.04, 0, -a, -0.9).ellipsoid(0.04, 0.12, 0.012, 6, 4, mat('#d9c4c8', 0.6, 0, 0.25)).pop();
    }
    m.push().at(0, 0.07, 0).sphere(0.04, 6, mat('#e8d27a', 0.5, 0, 0.6)).pop();
  } else if (kind === 'moss') {
    for (let k = 0; k < 6; k++) m.push().at((rnd() - 0.5) * 0.5, 0.02, (rnd() - 0.5) * 0.5).ellipsoid(0.12, 0.07, 0.11, 8, 4, mat('#7a3a24', 0.95, 0, 0.35), { wob: lumpy(9, 0.3, k) }).pop();
    for (let k = 0; k < 10; k++) m.push().at((rnd() - 0.5) * 0.5, 0.08, (rnd() - 0.5) * 0.5).sphere(0.015, 4, M.ember).pop();
  } else {
    for (let k = 0; k < 7; k++) {
      const x = (rnd() - 0.5) * 0.35;
      const z = (rnd() - 0.5) * 0.35;
      const h = 0.3 + rnd() * 0.25;
      m.sw = 0.5;
      m.tube([x, 0, z], [x * 1.3, h, z * 1.3], 0.01, 0.007, 4, M.leaf);
      m.push().at(x * 1.3, h, z * 1.3).ellipsoid(0.05, 0.035, 0.05, 6, 4, mat('#6a5a9a', 0.6, 0, 0.5)).pop();
      m.sw = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Items and runestones (lying on the ground, spun by the renderer)
// ---------------------------------------------------------------------------

/** @param {Mesh} m @param {Mat} liquid */
function flask(m, liquid) {
  m.lathe([[0, 0], [0.09, 0.01], [0.11, 0.08], [0.09, 0.16], [0.035, 0.2], [0.03, 0.27]], 10, mat('#9fb8b0', 0.08, 0, 0.15));
  m.lathe([[0, 0.01], [0.085, 0.02], [0.1, 0.08], [0.08, 0.13]], 10, liquid, { cap1: true });
  m.push().at(0, 0.28, 0).lathe([[0.035, 0], [0.032, 0.04]], 6, M.woodLight, { cap1: true }).pop();
}

/** @param {Mesh} m */
function tuningFork(m) {
  m.push().at(0, 0.03, 0, 0, 0, Math.PI / 2);
  m.tube([0, -0.3, 0], [0, -0.05, 0], 0.025, 0.025, 6, M.leather);
  m.tube([0, -0.05, 0], [0, 0.02, 0], 0.045, 0.03, 8, M.brass);
  for (const z of [-0.035, 0.035]) m.push().at(0, 0.02, z).box(0.012, 0.28, 0.012, 0.005, M.steel).at(0, 0.28, 0).box(0.006, 0.01, 0.005, 0.003, M.ley).pop();
  m.pop();
}

/** @param {Mesh} m @param {string} name sprite name */
function buildItem(m, name) {
  const id = name.slice(2);
  switch (id) {
    case 'fork': tuningFork(m); break;
    case 'scatter':
      m.push().at(0, 0.05, 0, 0, 0, Math.PI / 2).lathe([[0.05, -0.25], [0.045, 0.1], [0.07, 0.22], [0.09, 0.25]], 10, M.brass).pop();
      m.push().at(-0.3, 0.05, 0).box(0.12, 0.04, 0.03, 0.015, M.wood).pop();
      m.push().at(-0.05, 0.1, 0).lathe([[0, -0.05], [0.04, 0], [0, 0.06]], 6, M.crystal, { flat: true }).pop();
      break;
    case 'crossbow':
      m.push().at(0, 0.04, 0).box(0.3, 0.03, 0.035, 0.012, M.wood).pop();
      m.push().at(0.22, 0.05, 0, 0, Math.PI / 2).torus(0.2, 0.012, 12, 4, M.iron).pop();
      break;
    case 'lantern':
      m.push().at(0, 0.12, 0).box(0.08, 0.1, 0.08, 0.01, M.glass).pop();
      m.push().at(0, 0.24, 0).lathe([[0.1, 0], [0.03, 0.06], [0, 0.07]], 8, M.brass).pop();
      m.push().at(0, 0.01, 0).lathe([[0.1, 0], [0.1, 0.02]], 8, M.brass, { cap1: true }).pop();
      break;
    case 'buckler':
      m.push().at(0, 0.04, 0).lathe([[0.2, 0], [0.19, 0.03], [0.12, 0.05], [0, 0.07]], 14, M.bronze).pop();
      break;
    case 'coat':
      m.push().at(0, 0.05, 0).box(0.22, 0.05, 0.16, 0.04, mat('#4a2e2a', 0.9)).pop();
      m.push().at(0, 0.11, -0.08).box(0.18, 0.02, 0.06, 0.02, M.leather).pop();
      break;
    case 'cuirass':
      m.push().at(0, 0.1, 0, 0, Math.PI / 2).lathe([[0.15, -0.18], [0.17, 0], [0.14, 0.18]], 12, M.steel, { a0: Math.PI, a1: Math.PI * 2 }).pop();
      break;
    case 'charm': case 'amulet':
      m.push().at(0, 0.02, 0).lathe([[0.07, 0], [0.07, 0.015]], 12, M.brass, { cap1: true }).pop();
      m.push().at(0, 0.04, 0).sphere(0.03, 8, id === 'amulet' ? mat('#9a2a3a', 0.15, 0, 0.8) : M.crystal).pop();
      m.push().at(0, 0.01, -0.12).torus(0.07, 0.006, 12, 3, M.brass).pop();
      break;
    case 'draught': flask(m, mat('#a8323a', 0.1, 0, 0.6)); break;
    case 'tonic': flask(m, mat('#3a7ab8', 0.1, 0, 0.6)); break;
    case 'oil_ember': flask(m, mat('#d0702a', 0.1, 0, 1)); break;
    case 'oil_frost': flask(m, mat('#8ad8f0', 0.1, 0, 1)); break;
    case 'bread': m.push().at(0, 0.07, 0).ellipsoid(0.16, 0.07, 0.09, 10, 6, mat('#a4733e', 0.8), { wob: lumpy(10, 0.08, 3) }).pop(); break;
    case 'apple':
      m.push().at(0, 0.07, 0).ellipsoid(0.07, 0.065, 0.07, 10, 7, mat('#8a2f24', 0.45)).pop();
      m.tube([0, 0.13, 0], [0.01, 0.17, 0], 0.006, 0.005, 4, M.bark);
      break;
    case 'scrap':
      for (let k = 0; k < 3; k++) m.push().at((k - 1) * 0.1, 0.02, (k % 2) * 0.06, k).torus(0.05, 0.015, 10, 4, k % 2 ? M.iron : M.brass).pop();
      break;
    case 'crystal': case 'shards':
      for (let k = 0; k < 4; k++) m.push().at((k - 1.5) * 0.05, 0, (k % 2) * 0.05, k, 0.3 * Math.sin(k * 2), 0.3 * Math.cos(k * 3)).lathe([[0, 0], [0.035, 0.05], [0, 0.18 - k * 0.025]], 5, M.crystal, { flat: true }).pop();
      break;
    case 'salt': m.push().at(0, 0.08, 0).ellipsoid(0.11, 0.09, 0.1, 9, 6, M.linen, { wob: lumpy(8, 0.1, 2) }).pop(); m.tube([0, 0.15, 0], [0, 0.2, 0], 0.03, 0.025, 6, M.rope); break;
    case 'lockpick': for (const z of [-0.02, 0.02]) m.tube([-0.15, 0.01, z], [0.15, 0.01, z * 2], 0.005, 0.004, 4, M.steel); break;
    case 'key':
      m.push().at(-0.1, 0.01, 0).torus(0.04, 0.01, 10, 4, M.ironRust).pop();
      m.tube([-0.06, 0.01, 0], [0.14, 0.01, 0], 0.012, 0.012, 5, M.ironRust);
      m.push().at(0.12, 0.01, 0.03).box(0.02, 0.008, 0.03, 0.004, M.ironRust).pop();
      break;
    case 'book': m.push().at(0, 0.03, 0).box(0.12, 0.03, 0.16, 0.012, mat('#5a2e26', 0.7)).pop(); m.push().at(0.005, 0.03, 0).box(0.11, 0.024, 0.155, 0.006, M.parchment).pop(); break;
    case 'ammo_shard': case 'ammo_flare': case 'ammo_frost': {
      const tip = id === 'ammo_flare' ? M.ember : id === 'ammo_frost' ? mat('#9ae0ff', 0.2, 0, 2) : M.crystal;
      m.push().at(0, 0.05, 0).box(0.12, 0.05, 0.08, 0.01, M.woodDark).pop();
      for (let k = 0; k < 3; k++) m.push().at((k - 1) * 0.06, 0.12, 0).sphere(0.025, 6, tip).pop();
      break;
    }
    case 'core': m.push().at(0, 0.12, 0).sphere(0.08, 10, M.crystal).pop(); for (let k = 0; k < 3; k++) m.push().at(0, 0.12, 0, k * 2.1, 1.2).torus(0.11, 0.008, 14, 3, M.brass).pop(); break;
    case 'relic':
      m.lathe([[0.09, 0], [0.06, 0.05], [0.04, 0.2], [0.07, 0.25], [0, 0.32]], 10, M.brass, { cap0: true });
      m.push().at(0, 0.25, 0).sphere(0.04, 8, mat('#c47aff', 0.2, 0, 1.4)).pop();
      break;
    case 'parcel': m.push().at(0, 0.09, 0).box(0.14, 0.09, 0.11, 0.015, mat('#8a7050', 0.9)).pop(); m.push().at(0, 0.09, 0).box(0.145, 0.095, 0.012, 0.004, M.rope).pop(); break;
    default:
      m.push().at(0, 0.06, 0).box(0.1, 0.06, 0.1, 0.02, M.brass).pop();
  }
}

/** Runestones: a flat river stone with an emissive glyph in the rune's colour. */
const RUNE_COL = { lux: '#ffe9a8', vita: '#8af0a0', vis: '#ff9a6a', aperio: '#c49aff', levis: '#9ad8ff' };

/** @param {Mesh} m @param {string} rune */
function buildRune(m, rune) {
  m.push().at(0, 0.04, 0).ellipsoid(0.13, 0.045, 0.1, 10, 5, M.slate, { wob: lumpy(7, 0.08, rune.length) }).pop();
  const g = mat(/** @type {Record<string,string>} */ (RUNE_COL)[rune] ?? '#9ad8ff', 0.4, 0, 3);
  m.push().at(0, 0.085, 0).box(0.06, 0.004, 0.008, 0.003, g).box(0.008, 0.004, 0.05, 0.003, g).pop();
}

// ---------------------------------------------------------------------------
// Prop registry
// ---------------------------------------------------------------------------

/**
 * Every sprite name that has a 3D model, with the sprite size its geometry was built for
 * (the renderer scales each instance by the prop's size / nominal).
 * @type {Record<string, {n: number, b: (m: Mesh, rnd: () => number) => void}>}
 */
const PROPS = {
  tree_ley: { n: 5.6, b: buildLeyTree },
  tree_pine: { n: 6, b: buildPine },
  tree_dead: { n: 4, b: buildDeadTree },
  reeds: { n: 1.3, b: buildReeds },
  rock: { n: 1.4, b: buildRock },
  ruin: { n: 2.8, b: buildRuin },
  stall: { n: 2.6, b: buildStall },
  well: { n: 2.2, b: buildWell },
  lamp_post: { n: 3, b: buildLampPost },
  barrel: { n: 1, b: buildBarrel },
  table: { n: 1.2, b: buildTable },
  vent: { n: 1.4, b: buildVent },
  pedestal: { n: 1.4, b: buildPedestal },
  pylon: { n: 4.5, b: buildPylon },
  stones: { n: 3.2, b: buildStones },
  chest: { n: 1, b: (m) => buildChest(m, false) },
  chest_open: { n: 1, b: (m) => buildChest(m, true) },
  campfire_a: { n: 1.1, b: (m) => buildCampfire(m, false) },
  campfire_b: { n: 1.1, b: (m) => buildCampfire(m, true) },
  bed: { n: 1.6, b: buildBed },
  lever_up: { n: 1.2, b: (m) => buildLever(m, false) },
  lever_down: { n: 1.2, b: (m) => buildLever(m, true) },
  anchor: { n: 1.8, b: (m) => buildAnchor(m, false) },
  anchor_cracked: { n: 1.8, b: (m) => buildAnchor(m, true) },
  gate_core: { n: 2.4, b: buildGateCore },
  stairs: { n: 2.6, b: buildStairs },
  notice: { n: 2, b: buildNotice },
  tablet: { n: 1.4, b: buildTablet },
  brazier: { n: 1.5, b: buildBrazier },
  herb_lotus: { n: 0.8, b: (m) => buildHerb(m, 'lotus') },
  herb_moss: { n: 0.8, b: (m) => buildHerb(m, 'moss') },
  herb_bloom: { n: 0.8, b: (m) => buildHerb(m, 'bloom') },
};

/** Sprite names drawn as loose items: spun slowly and lifted a little. */
export const isItemModel = (/** @type {string} */ name) => name.startsWith('i_') || name.startsWith('rune_');

/** Whether a sprite name has a 3D model. @param {string} name */
export function hasModel(name) {
  return name in PROPS || isItemModel(name);
}

/** Size the model was built for. @param {string} name */
export function nominalSize(name) {
  return PROPS[name]?.n ?? 0.6;
}

/**
 * Build the model for a sprite name (variant seeds a per-instance shape for nature props;
 * far builds the same shape at half tessellation for distant LOD).
 * @param {string} name @param {number} [variant] @param {boolean} [far] @returns {Mesh}
 */
/** Cosine-weighted hemisphere directions (around +Z) for the AO bake, elevation >= ~15 degrees. */
const AO_DIRS = (() => {
  /** @type {number[][]} */
  const d = [];
  const n = 16;
  for (let k = 0; k < n; k++) {
    const r = Math.sqrt(0.06 + (0.84 * (k + 0.5)) / n);
    const a = k * 2.39996;
    d.push([Math.cos(a) * r, Math.sin(a) * r, Math.sqrt(1 - r * r)]);
  }
  return d;
})();

/**
 * Finish a model: area-weighted smooth normals across coincident vertices (faces more than
 * `crease` degrees apart keep a hard edge), then per-vertex ambient occlusion baked into the
 * vertex colour by marching rays through a voxelized copy of the mesh. `offsets` gives each
 * bone's rest-pose origin so skinned parts are lit as one assembled body.
 * @param {Mesh} m @param {{crease?: number, ao?: number, offsets?: number[][]}} [o] @returns {Mesh}
 */
export function finalize(m, o = {}) {
  const d = m.data;
  const n = m.count;
  if (n < 3) return m;
  const off = o.offsets;
  const P = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const b = off ? off[(d[v * VERT + 16] | 0) & 15] ?? [0, 0, 0] : [0, 0, 0];
    for (let k = 0; k < 3; k++) P[v * 3 + k] = d[v * VERT + k] + b[k];
  }
  // Face normals (unnormalized = area weighted), oriented to agree with the authored normals.
  const F = Math.floor(n / 3);
  const fn = new Float32Array(F * 3);
  for (let f = 0; f < F; f++) {
    const a = f * 3;
    const e1 = [P[(a + 1) * 3] - P[a * 3], P[(a + 1) * 3 + 1] - P[a * 3 + 1], P[(a + 1) * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[(a + 2) * 3] - P[a * 3], P[(a + 2) * 3 + 1] - P[a * 3 + 1], P[(a + 2) * 3 + 2] - P[a * 3 + 2]];
    const c = cross(e1, e2);
    let s = 0;
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) s += c[i] * d[(a + k) * VERT + 3 + i];
    const sg = s < 0 ? -1 : 1;
    for (let i = 0; i < 3; i++) fn[f * 3 + i] = c[i] * sg;
  }
  /** @type {Map<number, number[]>} position (and bone) -> faces touching it */
  const groups = new Map();
  // Exact numeric key: quarter-millimetre coordinates within +-2 m, and the bone (< 16).
  const keyOf = (/** @type {number} */ v) =>
    ((Math.round(P[v * 3] * 4000) + 8192) * 16384 + Math.round(P[v * 3 + 1] * 4000) + 8192) * 262144 + (Math.round(P[v * 3 + 2] * 4000) + 8192) * 16 + ((d[v * VERT + 16] | 0) & 15);
  /** @type {number[][]} faces touching each vertex's position, shared by every vertex there */
  const touch = new Array(F * 3);
  for (let v = 0; v < F * 3; v++) {
    const k = keyOf(v);
    let g = groups.get(k);
    if (g) g.push(Math.floor(v / 3));
    else groups.set(k, (g = [Math.floor(v / 3)]));
    touch[v] = g;
  }
  const cosC = Math.cos(((o.crease ?? 80) * Math.PI) / 180);
  // Unit face normals, once.
  const fu = new Float32Array(F * 3);
  for (let f = 0; f < F; f++) {
    const l = Math.hypot(fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]) || 1;
    for (let i = 0; i < 3; i++) fu[f * 3 + i] = fn[f * 3 + i] / l;
  }
  const N = new Float32Array(n * 3);
  for (let v = 0; v < F * 3; v++) {
    const of = Math.floor(v / 3) * 3;
    const o0 = fu[of];
    const o1 = fu[of + 1];
    const o2 = fu[of + 2];
    // Authored flat shading (crystals, blades) keeps its facet normal.
    if (Math.abs(o0 * d[v * VERT + 3] + o1 * d[v * VERT + 4] + o2 * d[v * VERT + 5]) > 0.9999) {
      for (let i = 0; i < 3; i++) N[v * 3 + i] = d[v * VERT + 3 + i];
      continue;
    }
    const acc = [0, 0, 0];
    for (const f of touch[v]) {
      if (fu[f * 3] * o0 + fu[f * 3 + 1] * o1 + fu[f * 3 + 2] * o2 < cosC) continue;
      for (let i = 0; i < 3; i++) acc[i] += fn[f * 3 + i];
    }
    const l = Math.hypot(acc[0], acc[1], acc[2]);
    for (let i = 0; i < 3; i++) N[v * 3 + i] = l > 1e-12 ? acc[i] / l : d[v * VERT + 3 + i];
    for (let i = 0; i < 3; i++) d[v * VERT + 3 + i] = N[v * 3 + i];
  }
  const strength = o.ao ?? 0.85;
  if (strength <= 0) return m;
  // Voxelize: sample every triangle densely enough to leave no gaps.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-3);
  const vox = Math.max(size / 56, 0.004);
  const dim = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k]) / vox) + 3);
  const grid = new Uint8Array(dim[0] * dim[1] * dim[2]);
  const cell = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
    const i = Math.floor((x - lo[0]) / vox) + 1;
    const j = Math.floor((y - lo[1]) / vox) + 1;
    const k = Math.floor((z - lo[2]) / vox) + 1;
    if (i < 0 || j < 0 || k < 0 || i >= dim[0] || j >= dim[1] || k >= dim[2]) return -1;
    return (k * dim[1] + j) * dim[0] + i;
  };
  for (let f = 0; f < F; f++) {
    const a = f * 9;
    const A = [P[a], P[a + 1], P[a + 2]];
    const Bp = [P[a + 3], P[a + 4], P[a + 5]];
    const C = [P[a + 6], P[a + 7], P[a + 8]];
    const edge = Math.max(Math.hypot(Bp[0] - A[0], Bp[1] - A[1], Bp[2] - A[2]), Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]), Math.hypot(C[0] - Bp[0], C[1] - Bp[1], C[2] - Bp[2]));
    const steps = Math.min(64, Math.ceil(edge / (vox * 0.6)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const u = i / steps;
        const w = j / steps;
        const c = cell(A[0] + (Bp[0] - A[0]) * u + (C[0] - A[0]) * w, A[1] + (Bp[1] - A[1]) * u + (C[1] - A[1]) * w, A[2] + (Bp[2] - A[2]) * u + (C[2] - A[2]) * w);
        if (c >= 0) grid[c] = 1;
      }
    }
  }
  const reach = Math.min(size * 0.4, 0.9);
  const steps = Math.max(4, Math.ceil(reach / vox));
  /** @type {Map<number, number>} AO per cell and normal direction, so shared vertices agree */
  const done = new Map();
  const aoV = new Float32Array(n).fill(1);
  for (let v = 0; v < n; v++) {
    if (d[v * VERT + 14] > 0 && d[v * VERT + 11] < 0) continue; // emissive plain-colour parts stay bright
    // Shared per half-voxel cell and normal direction: finer vertices than the grid resolves
    // (faces, hair, eyes) would only repeat the same rays.
    const hv = vox * 0.5;
    const k = ((((Math.floor((P[v * 3] - lo[0]) / hv) * 512 + Math.floor((P[v * 3 + 1] - lo[1]) / hv)) * 512 + Math.floor((P[v * 3 + 2] - lo[2]) / hv)) * 16 + ((d[v * VERT + 16] | 0) & 15)) * 13 +
      Math.round(N[v * 3] * 6) + 6) * 169 + (Math.round(N[v * 3 + 1] * 6) + 6) * 13 + Math.round(N[v * 3 + 2] * 6) + 6;
    let ao = done.get(k);
    if (ao === undefined) {
      const nz = [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]];
      const tx = norm(cross(Math.abs(nz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], nz));
      const ty = cross(nz, tx);
      let occ = 0;
      for (const r of AO_DIRS) {
        const dir = [tx[0] * r[0] + ty[0] * r[1] + nz[0] * r[2], tx[1] * r[0] + ty[1] * r[1] + nz[1] * r[2], tx[2] * r[0] + ty[2] * r[1] + nz[2] * r[2]];
        for (let s = 2; s <= steps; s++) {
          const t = s * vox;
          const c = cell(P[v * 3] + dir[0] * t, P[v * 3 + 1] + dir[1] * t, P[v * 3 + 2] + dir[2] * t);
          if (c >= 0 && grid[c]) { occ += 1 - t / (reach + vox); break; }
        }
      }
      ao = Math.max(0.3, 1 - (strength * occ) / AO_DIRS.length);
      done.set(k, ao);
    }
    aoV[v] = ao;
  }
  // The grid is coarser than a low-poly mesh's spacing, so neighbouring vertices can disagree
  // sharply and big triangles show it as patches: relax the occlusion over the mesh's neighbours.
  for (let it = 0; it < 2; it++) {
    const prev = aoV.slice();
    for (let v = 0; v < F * 3; v++) {
      let sum = 0;
      let c = 0;
      for (const f of touch[v]) for (let q = 0; q < 3; q++) { sum += prev[f * 3 + q]; c++; }
      if (c) aoV[v] = prev[v] * 0.4 + (sum / c) * 0.6;
    }
  }
  for (let v = 0; v < n; v++) {
    if (d[v * VERT + 14] > 0 && d[v * VERT + 11] < 0) continue;
    let ao = aoV[v];
    // Hair (brows, beards) is fine strands that light scatters through; the voxel grid is too coarse for them.
    if (d[v * VERT + 11] === CHAR_LAYER.HAIR) ao = Math.max(ao, 0.78);
    // Eyeballs carry the lid's shadow in their texture; the coarse grid would black them out.
    if (d[v * VERT + 11] === CHAR_LAYER.EYE) ao = Math.max(ao, 0.9);
    const layered = d[v * VERT + 11] >= 0;
    const kk = layered ? ao : Math.pow(ao, 1 / 2.2);
    for (let i = 8; i < 11; i++) d[v * VERT + i] *= kk;
  }
  return m;
}

export function buildModel(name, variant = 0, far = false) {
  const m = new Mesh(2048);
  const rnd = mulberry32(1000 + variant * 7919 + name.length * 31);
  DETAIL = far ? 0.35 : 1;
  try {
    if (PROPS[name]) PROPS[name].b(m, rnd);
    else if (name.startsWith('rune_')) buildRune(m, name.slice(5));
    else buildItem(m, name);
  } finally {
    DETAIL = 1;
  }
  // Distant LODs keep normals but skip the AO bake; they are small on screen.
  return finalize(m, { ao: far ? 0 : 0.85 });
}

/** Props whose shape varies per instance (seeded); everything else has one shape. */
export const VARIANTS = new Set(['tree_ley', 'tree_pine', 'tree_dead', 'reeds', 'rock', 'ruin', 'stones']);

/**
 * Grass tuft of curved blades, baked by the renderer into chunk meshes.
 * @param {Mesh} m @param {number} x @param {number} y @param {number} z @param {number} s height @param {number} seed @param {number[]} tint
 */
export function grassTuft(m, x, y, z, s, seed, tint) {
  const rnd = mulberry32(seed);
  for (let k = 0; k < 6; k++) {
    const a = rnd() * Math.PI * 2;
    const ox = x + Math.cos(a) * 0.16 * rnd();
    const oz = z + Math.sin(a) * 0.12 * rnd();
    const h = s * (0.55 + rnd() * 0.5);
    const lean = 0.15 + rnd() * 0.25;
    const w = 0.05;
    const px = Math.cos(a + 1.57) * w;
    const pz = Math.sin(a + 1.57) * w;
    const k1 = 0.75 + rnd() * 0.4;
    const c0 = [0.27 * tint[0] * k1, 0.3 * tint[1] * k1, 0.17 * tint[2] * k1];
    const c1 = [0.42 * tint[0] * k1, 0.45 * tint[1] * k1, 0.26 * tint[2] * k1];
    const mx = ox + Math.cos(a) * lean * 0.35;
    const mz = oz + Math.sin(a) * lean * 0.35;
    const tx = ox + Math.cos(a) * lean;
    const tz = oz + Math.sin(a) * lean;
    // Two segments (a quad then the tip), normals tilted up so tufts shade like the ground.
    const N = [Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3];
    /** @type {[number, number, number, number[], number][]} */
    const V = [[ox - px, y, oz - pz, c0, 0], [ox + px, y, oz + pz, c0, 0], [mx + px * 0.7, y + h * 0.55, mz + pz * 0.7, c1, 0.5], [mx - px * 0.7, y + h * 0.55, mz - pz * 0.7, c1, 0.5], [tx, y + h, tz, c1, 1]];
    for (const tri of [[0, 1, 2], [0, 2, 3], [3, 2, 4]]) {
      for (const i of tri) {
        const [vx, vy, vz, c, sway] = V[i];
        m.raw(vx, vy, vz, N[0], N[1], N[2], i & 1, sway, c, -1, 0.85, 0, 0, 1, 0, sway);
      }
    }
  }
}

/**
 * Pitched, tiled gable roof with timber posts and plates over a building footprint.
 * @param {Mesh} m @param {{x0:number, z0:number, x1:number, z1:number, base:number}} r
 */
export function buildRoof(m, r) {
  const sky = m.sky;
  m.sky = 1;
  const alongX = r.x1 - r.x0 >= r.z1 - r.z0;
  const o = 0.35;
  const span = alongX ? r.z1 - r.z0 : r.x1 - r.x0;
  const rise = span * 0.42;
  const y0 = r.base;
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  const eaveDrop = (o * rise) / (span / 2);
  if (alongX) {
    for (const s of [-1, 1]) {
      const zE = s < 0 ? r.z0 - o : r.z1 + o;
      const n = norm([0, span / 2, s * rise]);
      m.quad([[r.x0 - o, y0 - eaveDrop, zE], [r.x1 + o, y0 - eaveDrop, zE], [r.x1 + o, y0 + rise, cz], [r.x0 - o, y0 + rise, cz]], n, M.clay,
        [[0, 0], [r.x1 - r.x0 + 2 * o, 0], [r.x1 - r.x0 + 2 * o, span / 2 + o], [0, span / 2 + o]]);
    }
    // Gable ends, wound so their normals face outward.
    m.tri([[r.x0, y0, r.z0], [r.x0, y0, r.z1], [r.x0, y0 + rise, cz]], M.plank, [[0, 0], [span, 0], [span / 2, rise]]);
    m.tri([[r.x1, y0, r.z1], [r.x1, y0, r.z0], [r.x1, y0 + rise, cz]], M.plank, [[0, 0], [span, 0], [span / 2, rise]]);
    m.tube([r.x0 - o, y0 + rise + 0.05, cz], [r.x1 + o, y0 + rise + 0.05, cz], 0.09, 0.09, 6, M.woodDark, { cap: true });
  } else {
    for (const s of [-1, 1]) {
      const xE = s < 0 ? r.x0 - o : r.x1 + o;
      const n = norm([s * rise, span / 2, 0]);
      m.quad([[xE, y0 - eaveDrop, r.z0 - o], [xE, y0 - eaveDrop, r.z1 + o], [cx, y0 + rise, r.z1 + o], [cx, y0 + rise, r.z0 - o]], n, M.clay,
        [[0, 0], [r.z1 - r.z0 + 2 * o, 0], [r.z1 - r.z0 + 2 * o, span / 2 + o], [0, span / 2 + o]]);
    }
    m.tri([[r.x1, y0, r.z0], [r.x0, y0, r.z0], [cx, y0 + rise, r.z0]], M.plank, [[0, 0], [span, 0], [span / 2, rise]]);
    m.tri([[r.x0, y0, r.z1], [r.x1, y0, r.z1], [cx, y0 + rise, r.z1]], M.plank, [[0, 0], [span, 0], [span / 2, rise]]);
    m.tube([cx, y0 + rise + 0.05, r.z0 - o], [cx, y0 + rise + 0.05, r.z1 + o], 0.09, 0.09, 6, M.woodDark, { cap: true });
  }
  // Timber framing: corner posts and a top plate proud of the walls.
  const e = 0.06;
  for (const [x, z] of [[r.x0 - e, r.z0 - e], [r.x1 + e, r.z0 - e], [r.x0 - e, r.z1 + e], [r.x1 + e, r.z1 + e]]) {
    m.push().at(x, y0 - 1.7, z).box(0.13, 1.7, 0.13, 0.03, M.woodDark).pop();
  }
  for (const [ax, az, bx, bz] of [[r.x0, r.z0 - e, r.x1, r.z0 - e], [r.x0, r.z1 + e, r.x1, r.z1 + e], [r.x0 - e, r.z0, r.x0 - e, r.z1], [r.x1 + e, r.z0, r.x1 + e, r.z1]]) {
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    m.push().at(mx, y0 - 0.12, mz).box(Math.abs(bx - ax) / 2 + 0.1, 0.1, Math.abs(bz - az) / 2 + 0.1, 0.03, M.woodDark).pop();
  }
  // A stone chimney on larger roofs.
  if (span > 5) {
    const px = alongX ? r.x0 + (r.x1 - r.x0) * 0.75 : cx + span * 0.2;
    const pz = alongX ? cz + span * 0.2 : r.z0 + (r.z1 - r.z0) * 0.75;
    m.push().at(px, y0 + rise * 0.7, pz).box(0.35, rise * 0.75, 0.35, 0.04, M.stone).pop();
  }
  m.sky = sky;
}

/**
 * Door surround: timber posts and lintel for wooden doors, a voussoir stone arch otherwise.
 * @param {Mesh} m @param {{i:number, j:number, axis:'x'|'z', base:number, height:number, top:number, tex:number}} d @param {number} sky
 */
export function buildDoorFrame(m, d, sky) {
  const wood = d.tex === TILE.WOOD_DOOR;
  const brass = d.tex === TILE.ASTRO_DOOR || d.tex === TILE.GATE;
  const mt = wood ? M.woodDark : brass ? M.brass : M.stone;
  const prev = m.sky;
  m.sky = sky;
  m.push().at(d.i + 0.5, d.base, d.j + 0.5, d.axis === 'x' ? 0 : Math.PI / 2);
  const h = d.height;
  for (const x of [-0.5, 0.5]) m.push().at(x, h / 2, 0).box(0.08, h / 2, 0.58, 0.025, mt).pop();
  if (wood) m.push().at(0, h + 0.07, 0).box(0.62, 0.08, 0.6, 0.025, mt).pop();
  else {
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (0.08 + (k / 6) * 0.84);
      m.push().at(Math.cos(a) * 0.52, h - 0.08 + Math.sin(a) * 0.24, 0, 0, 0, a - Math.PI / 2).box(0.075, 0.07, 0.57, 0.02, mt).pop();
    }
  }
  m.pop();
  m.sky = prev;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Rig
 * @property {number[]} parent per bone
 * @property {number[][]} pivot per bone, relative to its parent's pivot
 * @property {Mesh} mesh bone-local geometry
 * @property {'human'|'golem'|'wisp'} kind animation family
 * @property {number} scale rig height multiplier
 * @property {number} [stoop] 0 upright .. 1 bent with age
 * @property {number} [armOut] arms' resting angle out from the sides (radians)
 * @property {Float32Array} invBind inverse bind matrix per bone (the mesh is in model space)
 */

/** Humanoid skeleton: hips, torso, head, L arm (2), R arm (2), L leg (2), R leg (2), cloak. */
const HUMAN_PARENT = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9, 1];
const HUMAN_PIVOT = [[0, 0.95, 0], [0, 0.06, 0], [0, 0.52, 0.01], [0.2, 0.46, 0], [0, -0.29, 0], [-0.2, 0.46, 0], [0, -0.29, 0], [0.095, -0.02, 0], [0, -0.44, 0], [-0.095, -0.02, 0], [0, -0.44, 0], [0, 0.48, -0.11]];
const B = { HIPS: 0, TORSO: 1, HEAD: 2, UARM_L: 3, FARM_L: 4, UARM_R: 5, FARM_R: 6, THIGH_L: 7, SHIN_L: 8, THIGH_R: 9, SHIN_R: 10, CLOAK: 11, LID_L: 12, LID_R: 13 };

/**
 * @typedef {Object} Outfit
 * @property {Mat} skin
 * @property {Mat} top tunic/coat
 * @property {Mat} legs
 * @property {Mat} boots
 * @property {Mat} [hair] also brows and beard
 * @property {'cap'|'scarf'|'hood'|'helm'|'goggles'|null} [hat]
 * @property {Mat} [hatM]
 * @property {Mat} [cloak]
 * @property {Mat} [robe] long skirt from the waist
 * @property {Mat} [apron]
 * @property {Mat} [armor] cuirass, pauldrons and leather tassets
 * @property {boolean|'long'} [beard]
 * @property {'spear'|'sword'|'staff'|'hammer'|'book'|null} [held]
 * @property {Mat} [glove]
 * @property {Mat} [glow] emissive accent (lenses, gauntlet, pendant)
 * @property {number} [eye] iris colour band 0..4 (hazel, slate grey, amber, dark brown, muted green); by default from the rig name
 * @property {'tousled'|'parted'|'tied'|'receding'} [hairStyle]
 * @property {number} [age] 0 young .. 1 old: deeper sockets, hollow cheeks, folds, heavier lids
 * @property {number} [stoop] 0 upright .. 1 bent
 * @property {boolean} [tatter] ragged, torn hems
 * @property {Mat} [mantle] shoulder mantle, bunched cowl and scapular over the robe
 * @property {'bell'} [sleeves] wide over-sleeves on the forearms
 * @property {boolean} [rope] rope girdle instead of a belt
 * @property {boolean} [pendant] ley pendant on a cord
 */

/**
 * Head profile keyframes [y, rx, rz, cx, cz], chin to crown (head-local metres, face toward +Z).
 * Keyframes are denser through the eyes and mouth so the relief there has rows to land on.
 */
const HEAD_ROWS = [[0.028, 0.022, 0.028, 0, 0.045], [0.045, 0.045, 0.05, 0, 0.03], [0.065, 0.062, 0.066, 0, 0.016], [0.075, 0.066, 0.072, 0, 0.012],
  [0.085, 0.07, 0.078, 0, 0.008], [0.095, 0.0725, 0.0815, 0, 0.006], [0.105, 0.075, 0.085, 0, 0.004], [0.125, 0.08, 0.091, 0, 0], [0.1375, 0.082, 0.0935, 0, -0.002],
  [0.15, 0.084, 0.096, 0, -0.004], [0.1625, 0.085, 0.0965, 0, -0.0055], [0.175, 0.086, 0.097, 0, -0.007], [0.2, 0.084, 0.094, 0, -0.01],
  [0.225, 0.077, 0.088, 0, -0.012], [0.245, 0.062, 0.074, 0, -0.013], [0.26, 0.038, 0.048, 0, -0.013], [0.268, 0.008, 0.01, 0, -0.013]];
/** Eye line: halfway between the chin and the crown. */
const EYE_Y = (HEAD_ROWS[0][0] + HEAD_ROWS[HEAD_ROWS.length - 1][0]) / 2;
/** Eye centres sit one eye-width apart across the bridge of the nose. */
const EYE_X = 0.032;
/** Eyeball radius (about 1.35 times the earlier eye). */
const EYE_R = 0.016;

/** Skull cross-section at a height, linearly between keyframes: [rx, rz, cz]. @param {number} y */
function headRing(y) {
  let k = 0;
  while (k < HEAD_ROWS.length - 2 && HEAD_ROWS[k + 1][0] < y) k++;
  const A = HEAD_ROWS[k];
  const C = HEAD_ROWS[k + 1];
  const f = Math.min(1, Math.max(0, (y - A[0]) / (C[0] - A[0])));
  return [A[1] + (C[1] - A[1]) * f, A[2] + (C[2] - A[2]) * f, A[4] + (C[4] - A[4]) * f];
}

/**
 * Facial relief, displaced along the skull's normal: an orbital brow ridge overhanging soft
 * sockets that ease into the nose bridge, tear troughs and upper cheeks; nose with its wings;
 * cheekbones; cupid's-bow lips with a mouth line and corner creases; philtrum and chin. With age,
 * sunken temples and cheeks, deep nasolabial folds, jowls, thinner lips and a creased forehead.
 * @param {number} age 0..1 @returns {(x: number, y: number, z: number) => number}
 */
function faceRelief(age) {
  const G = (/** @type {number} */ d, /** @type {number} */ s) => Math.exp(-(d * d) / (s * s));
  /** Distance from (px, py) to the segment a-b. @param {number} px @param {number} py @param {number[]} a @param {number[]} b */
  const segD = (px, py, a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
  };
  const ey = EYE_Y;
  return (x, y, z) => {
    if (z <= 0) return 0;
    const fr = Math.min(1, ((z / Math.hypot(x, z)) ** 2) * 1.3);
    const ax = Math.abs(x);
    let d = 0;
    // Brow ridge: an arc over each socket, heaviest above the outer iris, overhanging the eye.
    const browY = ey + 0.023 - 0.005 * ((ax - 0.03) / 0.028) ** 2;
    d += (0.0095 + 0.002 * age) * G(y - browY, 0.0078) * G(ax - 0.031, 0.027);
    d += 0.003 * G(ax, 0.011) * G(y - ey - 0.015, 0.009);
    // Orbital socket: a soft bowl deepest just under the brow, easing out into bridge and cheek.
    d -= (0.0118 + 0.003 * age) * G(ax - EYE_X, 0.0185) * G(y - ey - 0.002, 0.0128);
    // Tear trough from the inner eye corner down and out over the upper cheek.
    d -= (0.0009 + 0.0022 * age) * G(segD(ax, y, [0.017, ey - 0.012], [0.046, ey - 0.024]), 0.0042);
    // Nose: a bridge rising from between the eyes, widening and gaining to the tip, then tucked under.
    if (y > 0.096 && y < ey + 0.022) {
      const nt = Math.min(1, Math.max(0, (ey + 0.016 - y) / (ey + 0.016 - 0.114)));
      const under = y < 0.114 ? Math.max(0, (y - 0.098) / 0.016) ** 0.8 : 1;
      d += (0.0065 + (0.02 + 0.004 * age) * nt ** 1.5) * under * G(x, 0.0068 + 0.0064 * nt);
    }
    d += 0.0062 * G(ax - 0.0135, 0.0062) * G(y - 0.107, 0.0062);
    // Cheekbones under the outer socket, and the hollows beneath them.
    d += 0.0072 * G(ax - 0.051, 0.016) * G(y - ey + 0.022, 0.012);
    d -= (0.002 + 0.0055 * age) * G(ax - 0.046, 0.013) * G(y - 0.097, 0.013);
    // Nasolabial fold from the nose wing to the mouth corner.
    d -= (0.0012 + 0.0028 * age) * G(segD(ax, y, [0.017, 0.105], [0.028, 0.075]), 0.0035);
    // Philtrum groove and the cupid's-bow lips, mouth line, corner creases, chin and jowls.
    d -= 0.0011 * G(ax, 0.0032) * G(y - 0.0945, 0.0055);
    const lw = Math.max(0, 1 - (ax / 0.025) ** 2);
    const bow = 0.0012 * G(ax - 0.006, 0.004);
    d += (0.0036 - 0.0013 * age) * lw * G(y - 0.0866 - bow, 0.0034);
    d += (0.0048 - 0.0014 * age) * lw * G(y - 0.0772, 0.0044);
    d -= 0.0026 * lw * G(y - 0.0819, 0.0016);
    d -= 0.0016 * G(ax - 0.025, 0.0028) * G(y - 0.0805, 0.0042);
    d -= 0.0018 * G(ax, 0.022) * G(y - 0.066, 0.0045);
    d += 0.0065 * G(ax, 0.017) * G(y - 0.047, 0.012);
    d += 0.0032 * age * G(ax - 0.046, 0.012) * G(y - 0.062, 0.012);
    // Sunken temples and forehead creases.
    d -= 0.003 * age * G(ax - 0.068, 0.014) * G(y - 0.175, 0.016);
    d -= 0.0008 * age * Math.max(0, Math.sin((y - 0.19) * 420)) * G(y - 0.2, 0.014) * G(ax, 0.04);
    return d * fr;
  };
}

/**
 * Skin colouring that rides on the relief: ruddier lips with a shadowed seam and corners, pinker
 * lids and inner sockets, a faint flush on the cheeks, darker under-eyes with age.
 * @param {number} age @returns {(x: number, y: number, z: number) => number[]}
 */
function faceTint(age) {
  const G = (/** @type {number} */ d, /** @type {number} */ s) => Math.exp(-(d * d) / (s * s));
  return (x, y, z) => {
    if (z <= 0) return [1, 1, 1];
    const fr = Math.min(1, ((z / Math.hypot(x, z)) ** 2) * 1.3);
    const ax = Math.abs(x);
    const lw = Math.max(0, 1 - (ax / 0.024) ** 2) ** 0.7;
    const lip = lw * Math.max(G(y - 0.0866, 0.0032), G(y - 0.0772, 0.0042)) * (1 - age * 0.3);
    const seam = lw * G(y - 0.0819, 0.0012) + 0.6 * G(ax - 0.025, 0.0025) * G(y - 0.0808, 0.003);
    const lid = G(ax - EYE_X, 0.017) * G(y - EYE_Y, 0.012);
    const flush = G(ax - 0.05, 0.016) * G(y - 0.118, 0.014);
    const under = age * G(ax - 0.034, 0.012) * G(y - EYE_Y + 0.016, 0.006);
    const k = [1 - 0.14 * lip - 0.45 * seam - 0.06 * lid + 0.03 * flush - 0.12 * under,
      1 - 0.32 * lip - 0.5 * seam - 0.12 * lid - 0.04 * flush - 0.16 * under,
      1 - 0.34 * lip - 0.5 * seam - 0.1 * lid - 0.05 * flush - 0.1 * under];
    return k.map((v) => 1 + (v - 1) * fr);
  };
}

/**
 * An eyeball looking down +Z, its texture projected straight on from the front into the chosen
 * iris colour's tile of the eye layer (pupil at the tile centre, lid shadow along its top). The
 * cornea bulges.
 * @param {Mesh} m @param {number} r @param {number} variant iris colour band 0..4 @param {Mat} mt
 */
function eyeball(m, r, variant, mt) {
  const rings = Math.max(6, Math.round(14 * DETAIL));
  const seg = Math.max(8, Math.round(18 * DETAIL));
  /** @type {number[][][]} */
  const P = [];
  /** @type {number[][][]} */
  const T = [];
  const per = MAT_SIZE / EYE_TILE;
  const cx = ((variant % per) + 0.5) * EYE_TILE;
  const cy = (Math.floor(variant / per) + 0.5) * EYE_TILE;
  for (let j = 0; j <= rings; j++) {
    const th = Math.PI * (j / rings) ** 1.35;
    const bulge = 1 + 0.07 * Math.max(0, (Math.cos(th) - Math.cos(0.55)) / (1 - Math.cos(0.55))) ** 1.5;
    const row = [];
    const trow = [];
    for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * Math.PI * 2;
      const sx = Math.sin(th) * Math.cos(ph);
      const sy = Math.sin(th) * Math.sin(ph);
      row.push([sx * r * bulge, sy * r * bulge, Math.cos(th) * r * bulge]);
      trow.push([(cx + sx * EYE_SPAN) / MAT_SIZE / m.uvs, (cy - sy * EYE_SPAN) / MAT_SIZE / m.uvs]);
    }
    row[seg] = row[0].slice();
    P.push(row);
    T.push(trow);
  }
  m.grid(P, T, mt, true);
}

/**
 * Closed elliptical ribbon along a path, flattened against the scalp: `nrm` is the outward
 * direction at each point (the ribbon's thickness runs along it), widths and thicknesses are
 * half-extents. Strand texture runs along the ribbon.
 * @param {Mesh} m @param {number[][]} pts @param {number[][]} nrm @param {number[]} w @param {number[]} th @param {Mat} mt
 */
function ribbon(m, pts, nrm, w, th, mt) {
  const seg = Math.max(4, Math.round(6 * DETAIL));
  /** @type {number[][][]} */
  const P = [];
  /** @type {number[][][]} */
  const T = [];
  let arc = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const t = norm(sub(pts[Math.min(pts.length - 1, k + 1)], pts[Math.max(0, k - 1)]));
    const b = norm(cross(t, nrm[k]));
    const n = cross(b, t);
    if (k) arc += Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1], p[2] - pts[k - 1][2]);
    const row = [];
    const trow = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a) * w[k];
      const s = Math.sin(a) * th[k];
      row.push([p[0] + b[0] * c + n[0] * s, p[1] + b[1] * c + n[1] * s, p[2] + b[2] * c + n[2] * s]);
      trow.push([(i / seg) * 0.05, arc]);
    }
    row[seg] = row[0].slice();
    P.push(row);
    T.push(trow);
  }
  m.grid(P, T, mt, true);
}

/** Centre of the cranium, where hair directions are measured from (head-local). */
const SKULL_C = [0, 0.15, -0.008];

/** Distance from the cranium centre along a unit direction to the head surface. @param {number[]} d */
function skullHit(d) {
  let lo = 0;
  let hi = 0.2;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    const y = SKULL_C[1] + d[1] * t;
    let inside = false;
    if (y > HEAD_ROWS[0][0] && y < HEAD_ROWS[HEAD_ROWS.length - 1][0]) {
      const [rx, rz, cz] = headRing(y);
      inside = (d[0] * t / rx) ** 2 + ((SKULL_C[2] + d[2] * t - cz) / rz) ** 2 < 1;
    }
    if (inside) lo = t;
    else hi = t;
  }
  return lo;
}

/** Hairline elevation by azimuth: over the brow, above the ears at the sides, the nape at the back. @param {number} ph */
const hairEndE = (ph) => (Math.sin(ph) > 0 ? 0.08 + 0.36 * Math.sin(ph) ** 1.5 : 0.08 - 0.85 * (-Math.sin(ph)) ** 0.8);

/** Unit direction at azimuth ph (0 = model's left, pi/2 = front) and elevation e. @param {number} ph @param {number} e */
const dirOf = (ph, e) => [Math.cos(e) * Math.cos(ph), Math.sin(e), Math.cos(e) * Math.sin(ph)];

/**
 * Real 3D hair: locks laid over the skull from a whorl, a parting or the hairline to their tips,
 * each a tapering ribbon lifted off the scalp with volume through its middle and a flick at the
 * end, over a darker under-layer so no scalp shows between them. Styles: tousled, parted, tied
 * (swept back to a leather tie with a hanging braid), receding (sides and back only), and wisps
 * at the temples under a hood. Caps and coifs cover the crown, so only what shows below them is built.
 * For a base-mesh head, `hit` ray-casts its real scalp (in this procedural head frame) and the
 * under-layer is left to the caller.
 * @param {Mesh} m @param {Outfit} o @param {Mat} mt
 * @param {{hit?: (d: number[]) => number, noUnder?: boolean}} [opt]
 */
function buildHair(m, o, mt, opt = {}) {
  const hitAt = opt.hit ?? skullHit;
  const style = o.hat === 'hood' ? 'wisps' : o.hairStyle ?? 'tousled';
  let seed = 7;
  for (const ch of style + (o.hat ?? '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = mulberry32(seed);
  const j = (/** @type {number} */ k) => (rnd() - 0.5) * k;
  const endE = hairEndE;
  const nlerp = (/** @type {number[]} */ a, /** @type {number[]} */ b, /** @type {number} */ s) => norm([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]);
  /**
   * One lock from direction a to direction b over the scalp.
   * @param {number[]} a @param {number[]} b @param {number} w half-width @param {number} lift tip flick @param {number} vol extra loft off the scalp
   */
  const lock = (a, b, w, lift, vol) => {
    const K = Math.max(4, Math.round(7 * Math.min(1, DETAIL * 1.6)));
    /** @type {number[][]} */
    const pts = [];
    /** @type {number[][]} */
    const nrm = [];
    const ws = [];
    const ts = [];
    const wob = [j(0.05), j(0.05)];
    for (let k = 0; k < K; k++) {
      const s = k / (K - 1);
      const d = nlerp(a, b, s);
      const dd = norm([d[0] + wob[0] * Math.sin(s * 3), d[1], d[2] + wob[1] * Math.sin(s * 3)]);
      const off = 0.0022 + (0.0035 + vol) * Math.sin(Math.PI * Math.min(1, s * 1.15)) ** 0.7 + lift * s * s;
      const t = hitAt(dd) + off;
      pts.push([SKULL_C[0] + dd[0] * t, SKULL_C[1] + dd[1] * t, SKULL_C[2] + dd[2] * t]);
      nrm.push(dd);
      const taper = s < 0.4 ? 0.75 + 0.62 * s : 1 - 0.6 * ((s - 0.4) / 0.6) ** 1.6;
      ws.push(w * taper);
      ts.push(0.0021 * taper + 0.0006);
    }
    ribbon(m, pts, nrm, ws, ts, mt);
  };

  if (style === 'wisps') {
    // A few grey strands escaping the hood at the temples.
    for (const sd of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const ph = Math.PI / 2 - sd * (1.02 + k * 0.08);
        lock(dirOf(ph, 0.5 + k * 0.03), dirOf(ph - sd * 0.05, -0.22 - k * 0.06), 0.0045, 0.004, 0.001);
      }
    }
    return;
  }
  const bare = o.hat === 'cap' || o.hat === 'scarf';
  // Under-layer: a darker skull-hugging shell (back and sides only when receding or covered).
  const under = shade(mt, 0.5);
  if (!opt.noUnder && !bare && style !== 'receding') {
    m.loft([[0.19, 0.088, 0.099, 0, -0.009], [0.225, 0.082, 0.092, 0, -0.012], [0.255, 0.065, 0.076, 0, -0.014], [0.272, 0.012, 0.012, 0, -0.014]], 26, under, { cap1: true, tatter: [0.01, 81] });
  }
  if (!opt.noUnder && o.hat !== 'scarf') m.loft([[0.07, 0.083, 0.094, 0, -0.012], [0.13, 0.089, 0.1, 0, -0.012], [0.2, 0.087, 0.098, 0, -0.01]], 18, under, { a0: Math.PI + 0.3, a1: Math.PI * 2 - 0.3 });

  const whorl = dirOf(-Math.PI / 2, 1.2);
  const partF = dirOf(Math.PI / 2 - 0.42, 0.78);
  const partB = dirOf(-Math.PI / 2 + 0.25, 1.28);
  const tie = dirOf(-Math.PI / 2, 0.18);
  const N = style === 'receding' ? 38 : 54;
  for (let i = 0; i < N; i++) {
    const ph = (i / N) * Math.PI * 2 + j(0.14);
    const sp = Math.sin(ph);
    if (style === 'receding' && sp > 0.2) continue;
    if (o.hat === 'scarf' && sp < 0.55) continue;
    if (o.hat === 'cap' && sp > 0.72) continue;
    const end = dirOf(ph + j(0.18), endE(ph) + j(0.07));
    /** @type {number[]} */
    let start;
    if (o.hat === 'cap') start = dirOf(ph, 0.42);
    else if (o.hat === 'scarf') start = dirOf(ph, 0.86);
    else if (style === 'receding') start = dirOf(ph, 0.95);
    else if (style === 'parted') start = nlerp(partF, partB, (1 - sp) / 2);
    else if (style === 'tied') start = sp < -0.55 ? whorl : dirOf(ph, endE(ph) + 0.03);
    else start = nlerp(whorl, end, 0.04 + rnd() * 0.12);
    const w = 0.0085 + rnd() * 0.004;
    if (style === 'tied' && !bare) lock(start, sp < -0.55 ? tie : nlerp(tie, start, 0.08), w, 0, 0.001);
    else lock(start, end, w, style === 'tousled' ? 0.0015 + rnd() * 0.004 : 0.001, style === 'tousled' ? 0.0012 : 0);
  }
  if (!bare && (style === 'tousled' || style === 'parted')) {
    // A shorter top layer for volume.
    for (let i = 0; i < 14; i++) {
      const ph = (i / 14) * Math.PI * 2 + j(0.3);
      const end = dirOf(ph + j(0.2), 0.62 + j(0.12));
      const start = style === 'parted' ? nlerp(partF, partB, (1 - Math.sin(ph)) / 2) : whorl;
      lock(start, end, 0.009, style === 'tousled' ? 0.003 : 0.001, 0.002);
    }
  }
  if (style === 'tied' && !bare) {
    // Leather tie and a three-strand braid hanging down the back of the neck.
    const tt = hitAt(tie) + 0.011;
    const tp = [SKULL_C[0] + tie[0] * tt, SKULL_C[1] + tie[1] * tt, SKULL_C[2] + tie[2] * tt];
    m.push().at(tp[0], tp[1], tp[2] - 0.004, 0, Math.PI / 2 - 0.5).torus(0.011, 0.0042, 14, 6, CM.leatherDark).pop();
    for (let k = 0; k < 3; k++) {
      /** @type {number[][]} */
      const pts = [];
      const rad = [];
      for (let q = 0; q <= 8; q++) {
        const s = q / 8;
        const a = s * Math.PI * 5 + (k * Math.PI * 2) / 3;
        const amp = 0.0062 * (1 - 0.4 * s);
        pts.push([tp[0] + Math.sin(a) * amp, tp[1] - 0.012 - 0.16 * s, tp[2] - 0.012 - 0.035 * s + Math.cos(a) * amp * 0.6]);
        rad.push([0.0058 * (1 - 0.45 * s), 0.0042 * (1 - 0.45 * s)]);
      }
      m.sweep(pts, rad, 6, mt, { cap1: true, sub: 2 });
    }
  }
}

/**
 * Eyes in the head's frame: wet, texture-mapped eyeballs at the given centres; lower lids with a
 * moist rim; a pink caruncle at each inner corner; an upper-lid crease; and the upper lids on
 * their own bones (pivoting about the eye centres, so they blink), each with a dark lash line.
 * The upper lid rests at upRot over the top of the iris; the lower lid just meets it.
 * @param {Mesh} m @param {Outfit} o @param {number[][]} centres [left, right] in the head's frame
 * @param {number} r eyeball radius @param {number} upRot upper lid's resting turn (radians)
 */
function buildEyes(m, o, centres, r, upRot) {
  const k = r / EYE_R;
  const eyeM = mat([1, 1, 1], 0.08, 0, 0, CL.EYE);
  const lash = mat('#1b130f', 0.6);
  const rimM = { ...o.skin, c: [o.skin.c[0] * 0.86, o.skin.c[1] * 0.62, o.skin.c[2] * 0.6] };
  const R = r + 0.0012 * k;
  const upV = 0.62;
  const loV = -0.78;
  const loRot = -0.28;
  /** Points along a lid's free edge (latitude lat) across the front of the eye. @param {number} lat @param {number} rr @param {number} span */
  const edge = (lat, rr, span) => {
    const pts = [];
    for (let q = 0; q <= 8; q++) {
      const a = Math.PI / 2 - span + (q / 8) * span * 2;
      pts.push([Math.cos(lat) * Math.cos(a) * rr, Math.sin(lat) * rr, Math.cos(lat) * Math.sin(a) * rr]);
    }
    return pts;
  };
  const taper = (/** @type {number} */ a, /** @type {number} */ b) => Array.from({ length: 9 }, (_, q) => {
    const t = Math.sin((q / 8) * Math.PI) ** 0.6;
    return [a * k * (0.35 + 0.65 * t), b * k * (0.35 + 0.65 * t)];
  });
  const head = m.binds ? m.binds[B.HEAD] : null;
  centres.forEach((c, i) => {
    const sd = i === 0 ? 1 : -1;
    const lidBone = i === 0 ? B.LID_L : B.LID_R;
    m.bone = B.HEAD;
    m.push().at(c[0], c[1], c[2]);
    eyeball(m, r, o.eye ?? 0, eyeM);
    m.push().at(0, 0, 0, 0, loRot).ellipsoid(R, R, R, 16, 4, o.skin, { v1: loV });
    m.sweep(edge(loV, R + 0.0003 * k, 1.15), taper(0.0011, 0.0013), 6, rimM, { cap0: true, cap1: true, sub: 2 });
    m.pop();
    m.push().at(-sd * r * 0.8, -0.0012 * k, r * 0.52).ellipsoid(0.0026 * k, 0.0022 * k, 0.0022 * k, 8, 4, mat('#a8665c', 0.35)).pop();
    m.push().at(0, 0, 0, 0, upRot).sweep(edge(upV + 0.3, R + 0.0034 * k, 1.05), taper(0.0016, 0.0016), 6, o.skin, { cap0: true, cap1: true, sub: 2 }).pop();
    m.pop();
    // The lid bone's bind frame sits at the eye centre.
    if (m.binds && head) m.binds[lidBone] = mul(head, trs(c[0], c[1], c[2], 0, 0, 0, 1));
    m.bone = lidBone;
    if (!m.binds) m.at(0, 0, 0);
    m.push().at(0, 0, 0, 0, upRot);
    m.ellipsoid(R, R, R, 16, 6, o.skin, { v0: upV });
    m.sweep(edge(upV, R + 0.0004 * k, 1.2), taper(0.0013, 0.0019), 6, lash, { cap0: true, cap1: true, sub: 2 });
    m.pop();
    m.bone = B.HEAD;
  });
}

/**
 * The head: one continuous sculpted skull and face (columns packed toward the face, rows packed
 * through eyes and mouth) with relief-driven skin tint; texture-mapped eyeballs set in the
 * sockets with pink inner corners; upper lids on their own bones (so they blink) with a dark
 * lash line, lower lids with a moist rim, an upper-lid crease; brows; ears; facial and 3D hair.
 * @param {Mesh} m @param {Outfit} o @returns {number[][]} eye centres [left, right], for the lid bones' pivots
 */
function buildHead(m, o) {
  const age = o.age ?? 0;
  const relief = faceRelief(age);
  const lumps = rough(38, 0.0007, 17);
  m.loft(HEAD_ROWS, 48, o.skin, { sub: 4, cap0: true, cap1: true, focus: 0.62, disp: (x, y, z) => relief(x, y, z) + lumps(x, y, z), tint: faceTint(age) });
  /** Point on the sculpted face surface at (x, y), with the skull's normal there: [x, z, nx, nz]. */
  const surf = (/** @type {number} */ x, /** @type {number} */ y) => {
    const [rx, rz, cz] = headRing(y);
    const z = cz + rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2));
    let nx = x / (rx * rx);
    let nz = (z - cz) / (rz * rz);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const d = relief(x, y, z);
    return [x + nx * d, z + nz * d, nx, nz];
  };
  /** Points just proud of the face. @param {number[][]} xy @param {number} lift */
  const onFace = (xy, lift) => xy.map(([x, y]) => {
    const [px, pz, nx, nz] = surf(x, y);
    return [px + nx * lift, y, pz + nz * lift];
  });

  // Eyes, straight back from the socket floor so the cornea stands proud of the skin.
  /** @type {number[][]} */
  const eyes = [1, -1].map((sd) => [sd * EYE_X, EYE_Y, surf(sd * EYE_X, EYE_Y)[1] - EYE_R + 0.0055]);
  buildEyes(m, o, eyes, EYE_R, 0.35 + 0.09 * age);
  for (const sd of [1, -1]) {
    // Ears, larger with age.
    const ek = 1 + 0.12 * age;
    m.push().at(sd * 0.0875, 0.135, -0.006, 0, 0, sd > 0 ? 0.2 : -0.2).ellipsoid(0.012 * ek, 0.026 * ek, 0.018 * ek, 10, 6, o.skin).pop();
  }

  // Brows follow the ridge; bushier with age.
  const hairM = o.hair ?? fab('#3a2c22', CL.HAIR, 0.6);
  const bk = 1 + age * 0.6;
  const by = EYE_Y + 0.02;
  for (const sd of [-1, 1]) {
    m.sweep(onFace([[0.011, by - 0.002], [0.027, by + 0.004], [0.045, by + 0.002], [0.058, by - 0.005]].map(([x, y]) => [sd * x, y]), 0.0008),
      [[0.0016, 0.0036 * bk], [0.0019, 0.0046 * bk], [0.0016, 0.0038 * bk], [0.001, 0.0018]], 6, hairM, { cap0: true, cap1: true, sub: 3 });
  }

  // Facial hair: cheeks and jaw on each side (leaving the mouth clear), the chin (long beards
  // hang onto the chest with wispy ends), and a moustache over the upper lip.
  if (o.beard) {
    const strands = rough(60, 0.0035, 4, { stretch: 3 });
    const cheeks = [[0.04, 0.05, 0.054, 0, 0.03], [0.065, 0.066, 0.07, 0, 0.019], [0.09, 0.075, 0.082, 0, 0.01], [0.12, 0.083, 0.092, 0, 0.002], [0.14, 0.087, 0.097, 0, -0.003]];
    const thin = rough(60, 0.0018, 4, { stretch: 3 });
    m.loft(cheeks, 16, hairM, { a0: -0.55, a1: 0.8, disp: thin });
    m.loft(cheeks, 16, hairM, { a0: Math.PI - 0.8, a1: Math.PI + 0.55, disp: thin });
    const chin = o.beard === 'long'
      ? [[-0.12, 0.012, 0.01, 0, 0.118], [-0.08, 0.03, 0.022, 0, 0.11], [-0.03, 0.048, 0.034, 0, 0.092], [0.01, 0.058, 0.05, 0, 0.068], [0.04, 0.066, 0.062, 0, 0.046], [0.068, 0.072, 0.074, 0, 0.024]]
      : [[0.02, 0.03, 0.03, 0, 0.06], [0.04, 0.05, 0.05, 0, 0.042], [0.055, 0.062, 0.064, 0, 0.03], [0.068, 0.07, 0.074, 0, 0.022]];
    m.loft(chin, 22, hairM, { a0: -0.3, a1: Math.PI + 0.3, disp: strands, smooth: 1, ...(o.beard === 'long' ? { tatter: [0.03, 41] } : {}) });
    m.sweep(onFace([[-0.033, 0.07], [-0.021, 0.087], [0, 0.093], [0.021, 0.087], [0.033, 0.07]], 0.003),
      [[0.003, 0.002], [0.0055, 0.003], [0.006, 0.0032], [0.0055, 0.003], [0.003, 0.002]], 8, hairM, { cap0: true, cap1: true });
  }
  if (o.hair && o.hat !== 'helm') buildHair(m, o, o.hair);
  return eyes;
}

/** Soft cloth folds strongest toward the face opening of a hood or coif. @param {number} cz0 */
function drape(cz0) {
  const r = rough(20, 0.0016, 37);
  return (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) => {
    const a = Math.atan2(z - cz0, x);
    const w = Math.max(0, Math.sin(a)) ** 1.5;
    return w * (0.0055 * Math.sin(a * 9 + y * 30) + 0.0028 * Math.sin(a * 17 - y * 45)) + r(x, y, z);
  };
}

/**
 * Cap, linen coif, lined hood (with hem and, when tattered, a hanging tail), helm or goggles,
 * in the procedural head's frame (the current transform maps it onto the actual head).
 * @param {Mesh} m @param {Outfit} o @param {Mat} hatM
 */
function buildHeadwear(m, o, hatM) {
  /** @param {number} d @param {number} seed */
  const tat = (d, seed) => (o.tatter ? { tatter: [d, seed] } : {});
  if (o.hat === 'cap') {
    m.loft([[0.19, 0.094, 0.104, 0, -0.006], [0.24, 0.088, 0.098, 0, -0.01], [0.28, 0.05, 0.058, 0, -0.012], [0.29, 0.01, 0.01, 0, -0.012]], 22, hatM, { cap1: true, smooth: 1 });
    m.push().at(0, 0.195, 0.1, 0, -0.15).box(0.072, 0.006, 0.04, 0.005, hatM).pop();
  } else if (o.hat === 'scarf') {
    // Linen coif: open wide around the face and gathered in soft folds toward the opening.
    m.loft([[0.08, 0.104, 0.114, 0, -0.008], [0.2, 0.104, 0.112, 0, -0.012], [0.26, 0.078, 0.088, 0, -0.014], [0.288, 0.02, 0.02, 0, -0.014]], 26, hatM, { a0: Math.PI / 2 + 1.0, a1: Math.PI * 2.5 - 1.0, folds: [6, 0.004], disp: drape(-0.012), smooth: 1 });
    m.sweep([[0, 0.12, -0.1], [0, 0.07, -0.13], [0.02, 0.0, -0.12]], [0.018, 0.022, 0.012], 10, hatM, { cap1: true });
  } else if (o.hat === 'hood') {
    // Hood: outer shell (ragged at the back when tattered), a darker lining so it reads as a
    // thick layer, a rolled hem framing the face, and for the tattered a hanging tail.
    // Wide, soft face opening that frames the forehead and cheekbones, folds gathering toward it.
    const hr = [[0.0, 0.15, 0.16, 0, -0.012], [0.1, 0.142, 0.152, 0, -0.014], [0.2, 0.128, 0.14, 0, -0.02], [0.28, 0.09, 0.108, 0, -0.032], [0.315, 0.024, 0.034, 0, -0.045]];
    const op = o.tatter ? 0.84 : 0.9;
    const a0 = Math.PI / 2 + op;
    const a1 = Math.PI * 2.5 - op;
    const fold = drape(-0.016);
    m.loft(hr, 30, hatM, { a0, a1, folds: [5, 0.008], smooth: 1, disp: fold, ...tat(0.03, 31) });
    m.loft(hr.map(([y, rx, rz, cx, cz]) => [y, rx - 0.008, rz - 0.008, cx, cz]), 24, shade(hatM, 0.62), { a0: a0 + 0.05, a1: a1 - 0.05, smooth: 1, disp: fold });
    // The rolled hem follows the folded edge.
    const edge = (/** @type {number} */ a) => hr.slice(1, 4).map(([y, rx, rz, cx, cz]) => {
      const p = [cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz];
      const f = fold(p[0], p[1], p[2]);
      return [p[0] + Math.cos(a) * f, p[1], p[2] + Math.sin(a) * f];
    });
    const hem = [...edge(a0), ...edge(a1).reverse()];
    m.sweep(hem, hem.map(() => [0.0075, 0.006]), 10, hatM);
    if (o.tatter) {
      m.sweep([[0, 0.3, -0.07], [0, 0.25, -0.14], [0, 0.17, -0.175], [0.01, 0.05, -0.19], [0.02, -0.06, -0.2]], [0.03, 0.028, 0.022, 0.014, 0.007], 12, hatM, { cap1: true, disp: rough(30, 0.002, 33) });
    }
  } else if (o.hat === 'helm') {
    m.loft([[0.12, 0.103, 0.112], [0.18, 0.1, 0.11], [0.24, 0.08, 0.09], [0.285, 0.035, 0.04], [0.3, 0.005, 0.005]], 24, o.armor ?? M.steel, { cap1: true, disp: rough(14, 0.0015, 3) });
    m.loft([[0.115, 0.15, 0.158], [0.13, 0.112, 0.12]], 24, o.armor ?? M.steel);
    m.push().at(0, 0.13, 0.112).box(0.008, 0.04, 0.006, 0.004, o.armor ?? M.steel).pop();
  } else if (o.hat === 'goggles') {
    m.loft([[0.185, 0.093, 0.104, 0, -0.004], [0.205, 0.093, 0.104, 0, -0.006]], 24, CM.leatherDark);
    for (const x of [-0.035, 0.035]) {
      m.push().at(x, 0.197, 0.096, 0, Math.PI / 2).lathe([[0.024, -0.012], [0.027, 0], [0.024, 0.012]], 14, M.brass, { cap1: true }).pop();
      m.push().at(x, 0.197, 0.11, 0, Math.PI / 2).lathe([[0.018, 0], [0, 0.002]], 12, o.glow ?? M.ley).pop();
    }
  }
}

/**
 * The held item, gripped in the right fist and pointing forward (+Z).
 * @param {Mesh} m @param {Outfit} o @param {number[]} grip fist centre in the right forearm's frame
 */
function buildHeld(m, o, grip) {
  m.bone = B.FARM_R;
  m.push().at(grip[0], grip[1], grip[2]);
  if (o.held === 'spear') {
    m.sweep([[0, -0.9, 0], [0, 0, 0], [0, 1.0, 0]], [0.016, 0.018, 0.015], 10, M.wood, { cap0: true });
    m.push().at(0, 1.02, 0).loft([[-0.03, 0.02, 0.012], [0.04, 0.035, 0.006], [0.2, 0.001, 0.001]], 6, M.steel, { flat: true }).pop();
  } else if (o.held === 'sword') {
    m.push().at(0, 0, 0, 0, Math.PI / 2);
    m.sweep([[0, -0.08, 0], [0, 0.05, 0]], [0.016, 0.017], 10, CM.leather);
    m.push().at(0, -0.095, 0).sphere(0.022, 10, M.brass).pop();
    m.push().at(0, 0.06, 0).box(0.085, 0.012, 0.02, 0.008, M.brass).pop();
    m.push().at(0, 0.07, 0).loft([[0, 0.022, 0.005], [0.55, 0.018, 0.004], [0.72, 0.001, 0.001]], 4, M.steel, { flat: true }).pop();
    m.pop();
  } else if (o.held === 'staff') {
    m.sweep([[0, -0.75, 0], [0.02, 0.1, 0], [0, 0.95, 0]], [0.02, 0.022, 0.026], 10, M.woodDark, { cap0: true, disp: rough(30, 0.002, 6, { stretch: 3 }) });
    m.push().at(0, 1.02, 0).sphere(0.05, 12, o.glow ?? M.ley).pop();
  } else if (o.held === 'hammer') {
    m.push().at(0, 0, 0, 0, Math.PI / 2);
    m.sweep([[0, -0.06, 0], [0, 0.46, 0]], [0.016, 0.014], 10, M.wood, { cap0: true });
    m.push().at(0, 0.49, 0).box(0.065, 0.042, 0.042, 0.014, M.iron).pop();
    m.pop();
  } else if (o.held === 'book') {
    // Leather-bound tome with brass corners and page block.
    m.push().at(-0.03, 0.02, 0.05, 0, -0.6).box(0.09, 0.022, 0.12, 0.01, fab('#4e2a24', CL.LEATHER, 0.7)).at(0.004, 0, 0).box(0.082, 0.017, 0.114, 0.004, M.parchment);
    for (const [cx, cz] of [[0.085, 0.115], [0.085, -0.115]]) m.push().at(cx, 0, cz).box(0.012, 0.024, 0.012, 0.004, M.brass).pop();
    m.pop();
  }
  m.pop();
}

/** @param {Mesh} m @param {Outfit} o @returns {number[][]} eye centres (lid bone pivots, relative to the head) */
function buildHuman(m, o) {
  const glove = o.glove ?? o.skin;
  const cloth = o.top;
  const prevUvs = m.uvs;
  // Character layers repeat every third of a metre: wool threads ~5 mm apart, pores ~3 mm.
  m.uvs = 3;
  /** Ragged hem options when the outfit is tattered. @param {number} d @param {number} seed */
  const tat = (d, seed) => (o.tatter ? { tatter: [d, seed] } : {});
  // --- Hips: pelvis, tunic skirt or robe (with a scapular over it), belt or rope girdle, apron, tassets.
  m.bone = B.HIPS;
  m.loft([[-0.14, 0.09, 0.075], [-0.08, 0.145, 0.1], [0, 0.163, 0.108], [0.07, 0.155, 0.103]], 24, o.legs, { cap0: true, smooth: 1 });
  if (o.robe) m.loft([[-0.88, 0.3, 0.23], [-0.55, 0.25, 0.19], [-0.2, 0.2, 0.148], [0.08, 0.17, 0.115]], 30, o.robe, { folds: [11, 0.024], smooth: 1, ...tat(0.07, 11) });
  else m.loft([[-0.24, 0.198, 0.15], [-0.08, 0.18, 0.128], [0.07, 0.167, 0.113]], 26, cloth, { folds: [9, 0.014], smooth: 1, ...tat(0.03, 12) });
  if (o.robe && o.mantle) {
    // Scapular: a narrower, darker over-panel hanging front and back, ragged at the foot.
    for (const c of [Math.PI / 2, -Math.PI / 2]) {
      m.loft([[-0.8, 0.335, 0.262], [-0.5, 0.268, 0.206], [-0.2, 0.214, 0.16], [0.08, 0.182, 0.126]], 12, o.mantle, { a0: c - 0.55, a1: c + 0.55, folds: [3, 0.01], smooth: 1, ...tat(0.05, c > 0 ? 13 : 14) });
    }
  }
  if (o.rope) {
    // Knotted rope girdle with two hanging ends.
    m.push().at(0, 0.075, 0).torus(0.174, 0.011, 30, 6, CM.rope).pop();
    for (const sd of [-1, 1]) {
      m.sweep([[sd * 0.05, 0.075, 0.18], [sd * 0.058, -0.05, 0.2], [sd * 0.07, -0.2, 0.215], [sd * 0.075, -0.34, 0.225]], [0.0085, 0.008, 0.0075, 0.007], 8, CM.rope, { cap1: true, disp: rough(70, 0.001, 19 + sd) });
      m.push().at(sd * 0.075, -0.34, 0.225).ellipsoid(0.014, 0.018, 0.014, 10, 6, CM.rope).pop();
    }
    m.push().at(0, 0.075, 0.186).ellipsoid(0.02, 0.016, 0.014, 10, 6, CM.rope).pop();
  } else {
    m.loft([[0.045, 0.172, 0.118], [0.095, 0.17, 0.116]], 26, CM.leatherDark);
    m.push().at(0, 0.07, 0.118).box(0.026, 0.02, 0.006, 0.004, M.brass).pop();
    m.push().at(-0.135, 0.0, 0.085, -0.55).box(0.032, 0.042, 0.02, 0.012, CM.leather).at(0, 0.035, 0.004).box(0.034, 0.012, 0.022, 0.006, CM.leatherDark).pop();
  }
  if (o.apron) m.loft([[-0.46, 0.205, 0.165], [-0.12, 0.188, 0.14], [0.05, 0.176, 0.122]], 14, o.apron, { a0: Math.PI / 2 - 0.95, a1: Math.PI / 2 + 0.95, folds: [5, 0.004] });
  if (o.armor) {
    // Leather tassets hang from the cuirass over the hips, flaring outward.
    for (let k = 0; k < 7; k++) {
      const a = Math.PI / 2 + (k - 3) * 0.42;
      m.push().at(Math.cos(a) * 0.192, -0.06, Math.sin(a) * 0.142, Math.PI / 2 - a, -0.14).box(0.036, 0.085, 0.006, 0.004, CM.leatherDark);
      m.at(0, 0.06, 0.007).sphere(0.0055, 6, M.brass).pop();
    }
  }

  // --- Torso: one smooth lofted body from waist to neck, tapered waist and sloped shoulders.
  m.bone = B.TORSO;
  m.loft([[-0.07, 0.158, 0.106], [0.04, 0.148, 0.098], [0.15, 0.16, 0.106], [0.27, 0.182, 0.12], [0.37, 0.19, 0.123], [0.44, 0.188, 0.115], [0.49, 0.14, 0.092], [0.535, 0.07, 0.06]], 28, cloth, { smooth: 1 });
  m.sweep([[0, 0.49, 0], [0, 0.56, 0.008], [0, 0.63, 0.014]], [0.056, 0.05, 0.047], 18, o.skin);
  m.loft([[0.495, 0.088, 0.076], [0.53, 0.074, 0.066]], 20, cloth);
  if (o.apron) m.loft([[0.04, 0.156, 0.112], [0.32, 0.19, 0.13]], 12, o.apron, { a0: Math.PI / 2 - 0.7, a1: Math.PI / 2 + 0.7 });
  if (o.armor) {
    m.loft([[0.1, 0.17, 0.12], [0.25, 0.194, 0.135], [0.37, 0.202, 0.136], [0.45, 0.186, 0.123]], 26, o.armor, { disp: rough(9, 0.0025, 7) });
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      m.push().at(Math.cos(a) * 0.171, 0.11, Math.sin(a) * 0.121).sphere(0.005, 5, M.brass).pop();
    }
  }
  if (o.mantle) {
    // Shoulder mantle over the shoulders and upper arms, then a bunched cowl at the throat.
    m.loft([[0.22, 0.345, 0.19], [0.32, 0.335, 0.18], [0.42, 0.315, 0.165], [0.475, 0.27, 0.15], [0.51, 0.19, 0.12], [0.535, 0.1, 0.085]], 32, o.mantle, { folds: [10, 0.018], smooth: 1, ...tat(0.045, 21) });
    m.loft([[0.47, 0.25, 0.17, 0, 0.01], [0.5, 0.215, 0.15, 0, 0.012], [0.53, 0.15, 0.115, 0, 0.012], [0.55, 0.1, 0.09, 0, 0.01]], 28, o.hatM ?? o.mantle, { folds: [9, 0.012], smooth: 1 });
  } else if (o.hat === 'hood') {
    m.loft([[0.34, 0.235, 0.155], [0.45, 0.185, 0.123], [0.52, 0.1, 0.086]], 24, o.hatM ?? cloth, { folds: [8, 0.012], smooth: 1 });
  }
  if (o.pendant) {
    // Ley pendant on a leather cord, worn over the mantle.
    m.sweep([[-0.07, 0.53, 0.1], [-0.06, 0.45, 0.17], [0, 0.37, 0.19], [0.06, 0.45, 0.17], [0.07, 0.53, 0.1]], [0.0028, 0.0028, 0.0028, 0.0028, 0.0028], 6, CM.leatherDark);
    m.push().at(0, 0.352, 0.192, 0, Math.PI / 2 - 0.15);
    m.lathe([[0.02, -0.004], [0.024, 0], [0.02, 0.005]], 18, M.brass, { cap0: true });
    m.at(0, 0.005, 0).lathe([[0.012, 0], [0.007, 0.006], [0, 0.008]], 12, o.glow ?? M.leySoft);
    m.pop();
  }

  // --- Head and headwear.
  m.bone = B.HEAD;
  const eyes = buildHead(m, o);
  buildHeadwear(m, o, o.hatM ?? cloth);

  // --- Arms: deltoid, continuous tapered sleeves (with bell over-sleeves), articulated hands.
  for (const [ub, fb, side] of [[B.UARM_L, B.FARM_L, 1], [B.UARM_R, B.FARM_R, -1]]) {
    m.bone = ub;
    m.push().at(-side * 0.014, -0.03, 0).ellipsoid(0.064, 0.072, 0.066, 18, 12, cloth).pop();
    m.sweep([[0, -0.02, 0], [0, -0.14, 0.004], [0, -0.29, 0]], [[0.057, 0.061], [0.052, 0.056], [0.041, 0.043]], 22, cloth, { smooth: 1, cap0: true });
    if (o.armor) {
      // Riveted, layered pauldron over a leather undershell.
      m.push().at(side * 0.012, -0.005, 0, 0, 0, side * -0.3);
      m.loft([[-0.11, 0.085, 0.083], [-0.07, 0.093, 0.09], [-0.02, 0.098, 0.096]], 22, CM.leatherDark, { tatter: [0.008, 51] });
      m.loft([[-0.06, 0.098, 0.096], [0.0, 0.094, 0.09], [0.04, 0.07, 0.07], [0.065, 0.02, 0.02]], 22, o.armor, { cap1: true, disp: rough(11, 0.002, 5) });
      m.loft([[-0.09, 0.09, 0.086], [-0.055, 0.092, 0.088]], 22, o.armor);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        m.push().at(Math.cos(a) * 0.094, -0.055, Math.sin(a) * 0.09).sphere(0.006, 6, M.brass).pop();
      }
      m.pop();
    }
    m.bone = fb;
    m.sweep([[0, 0.03, 0], [0, -0.09, 0.01], [0, -0.24, 0.005], [0, -0.27, 0.004]], [[0.044, 0.047], [0.046, 0.043], [0.031, 0.027], [0.03, 0.026]], 22, fb === B.FARM_R && o.glow && o.hat === 'goggles' ? M.brassTex : cloth, { smooth: 1 });
    if (o.sleeves === 'bell') {
      m.loft([[-0.275, 0.086, 0.082, 0, 0.012], [-0.18, 0.07, 0.066, 0, 0.006], [-0.06, 0.057, 0.056], [0.04, 0.051, 0.053]], 24, o.robe ?? cloth, { folds: [6, 0.012], smooth: 1, ...tat(0.03, 61 + side) });
    }
    if (o.glove) m.loft([[-0.27, 0.034, 0.03], [-0.2, 0.038, 0.034]], 16, glove);
    m.push().at(0, -0.272, 0.004);
    hand(m, glove, fb === B.FARM_R && o.held ? 0.95 : 0.35, side);
    m.pop();
  }

  // --- Legs: thigh, calf and booted foot with sole.
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.sweep([[0, 0.03, 0], [0, -0.2, 0.012], [0, -0.44, 0.004]], [[0.088, 0.09], [0.07, 0.073], [0.05, 0.052]], 22, o.legs, { smooth: 1 });
    m.bone = sb;
    m.sweep([[0, 0.02, 0.004], [0, -0.13, -0.012], [0, -0.3, -0.004], [0, -0.42, 0]], [[0.052, 0.056], [0.055, 0.062], [0.042, 0.046], [0.036, 0.04]], 22, o.legs, { smooth: 1 });
    m.loft([[-0.445, 0.05, 0.058], [-0.3, 0.057, 0.062], [-0.2, 0.062, 0.066], [-0.17, 0.068, 0.072]], 22, o.boots, { smooth: 1 });
    m.sweep([[0, -0.432, -0.03], [0, -0.448, 0.03], [0, -0.456, 0.1], [0, -0.46, 0.138]], [[0.04, 0.05], [0.036, 0.052], [0.028, 0.046], [0.016, 0.03]], 20, o.boots, { cap0: true, cap1: true, smooth: 1 });
    m.push().at(0, -0.469, 0.045).box(0.05, 0.007, 0.105, 0.005, CM.leatherDark).pop();
  }

  // --- Cloak with gravity folds, hanging from a collar at the shoulders.
  if (o.cloak) {
    m.bone = B.CLOAK;
    m.loft([[-1.02, 0.36, 0.2, 0, 0.04], [-0.6, 0.3, 0.17, 0, 0.05], [-0.2, 0.24, 0.14, 0, 0.06], [0.0, 0.205, 0.12, 0, 0.07]], 28, o.cloak,
      { a0: Math.PI + 0.12, a1: Math.PI * 2 - 0.12, folds: [7, 0.03], smooth: 1, tatter: [0.035, 71] });
    m.loft([[-0.02, 0.21, 0.13, 0, 0.07], [0.03, 0.17, 0.12, 0, 0.08]], 24, o.cloak, { a0: Math.PI - 0.3, a1: Math.PI * 2 + 0.3 });
  }

  // --- Held item, gripped in the right fist and pointing forward (+Z).
  buildHeld(m, o, [0.012, -0.33, 0.01]);
  m.uvs = prevUvs;
  return eyes;
}

/**
 * Articulated hand hanging from the wrist (origin): lofted palm, four finger sweeps that curl
 * toward the palm, and an opposed thumb. side is +1 for the left hand (+X) and -1 for the right.
 * @param {Mesh} m @param {Mat} mt @param {number} curl 0 open .. 1 fist @param {number} side
 */
function hand(m, mt, curl, side) {
  const inward = -side;
  m.loft([[-0.085, 0.016, 0.038, inward * 0.004, 0], [-0.04, 0.019, 0.041], [0.0, 0.017, 0.032]], 16, mt, { cap0: true, smooth: 1 });
  [-0.026, -0.009, 0.008, 0.025].forEach((z, k) => {
    const len = [0.042, 0.048, 0.046, 0.036][k];
    /** @type {number[][]} */
    const pts = [[0, -0.08, z]];
    let ang = 0;
    let p = pts[0];
    for (let j = 0; j < 3; j++) {
      ang += curl * 0.65;
      const l = len * [0.42, 0.33, 0.25][j];
      p = [p[0] + inward * Math.sin(ang) * l, p[1] - Math.cos(ang) * l, z];
      pts.push(p);
    }
    m.sweep(pts, [0.0095, 0.0088, 0.008, 0.0068], 8, mt, { cap1: true, sub: 2 });
  });
  m.sweep([[inward * 0.006, -0.025, 0.032], [inward * 0.012, -0.05, 0.05], [inward * (0.016 + curl * 0.012), -0.07, 0.054 - curl * 0.012]], [0.012, 0.0105, 0.0085], 8, mt, { cap1: true, sub: 2 });
}

/** @param {Mesh} m Clockwork Sentinel (and Brass Mite): brass automaton with blade arms and a ley visor. */
function buildSentinel(m) {
  const plate = M.brassTex;
  const dent = rough(12, 0.0025, 13);
  m.bone = B.HIPS;
  m.loft([[-0.1, 0.1, 0.085], [-0.03, 0.16, 0.12], [0.06, 0.15, 0.11], [0.12, 0.1, 0.08]], 24, M.iron, { cap0: true, smooth: 1 });
  m.push().at(0, 0.02, 0).torus(0.165, 0.022, 28, 8, M.brass).pop();
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.19, 0.02, Math.sin(a) * 0.19, -a).box(0.012, 0.014, 0.01, 0.004, M.brass).pop();
  }
  m.bone = B.TORSO;
  // Barrel chest with riveted bands and a recessed ley core.
  m.loft([[0.0, 0.11, 0.085], [0.12, 0.18, 0.135], [0.28, 0.232, 0.17], [0.4, 0.222, 0.16], [0.5, 0.14, 0.11], [0.55, 0.08, 0.07]], 28, plate, { cap0: true, cap1: true, smooth: 1, disp: dent });
  for (const [y, rx, rz] of [[0.18, 0.205, 0.153], [0.36, 0.232, 0.17]]) {
    m.loft([[y - 0.012, rx, rz], [y + 0.012, rx, rz]], 28, M.bronze);
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      m.push().at(Math.cos(a) * rx, y, Math.sin(a) * rz).sphere(0.0065, 6, M.brass).pop();
    }
  }
  m.push().at(0, 0.29, 0.165, 0, Math.PI / 2);
  m.lathe([[0.075, -0.01], [0.08, 0.012], [0.062, 0.03]], 22, M.iron, { cap1: true });
  m.at(0, 0.02, 0).lathe([[0.052, 0], [0.035, 0.012], [0, 0.016]], 18, M.ley);
  m.pop();
  for (let k = 0; k < 4; k++) m.push().at(-0.06 + k * 0.04, 0.33, -0.165).box(0.008, 0.08, 0.02, 0.005, M.iron).pop();
  for (const x of [-0.22, 0.22]) {
    m.push().at(x, 0.47, 0, 0, 0, x > 0 ? -0.45 : 0.45);
    m.loft([[-0.05, 0.12, 0.11], [0.0, 0.115, 0.105], [0.05, 0.08, 0.075], [0.075, 0.02, 0.02]], 22, plate, { cap1: true, disp: dent });
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      m.push().at(Math.cos(a) * 0.112, -0.035, Math.sin(a) * 0.1).sphere(0.006, 6, M.brass).pop();
    }
    m.pop();
  }
  m.sweep([[0.03, 0.5, 0], [0.03, 0.62, 0.02]], [0.012, 0.012], 8, M.iron);
  m.sweep([[-0.03, 0.5, 0], [-0.03, 0.62, 0.02]], [0.012, 0.012], 8, M.iron);
  m.bone = B.HEAD;
  // Tall sculpted helm with a ley visor slit and a crest.
  m.loft([[0.02, 0.06, 0.07, 0, 0.01], [0.07, 0.095, 0.105, 0, 0.012], [0.15, 0.102, 0.11], [0.22, 0.088, 0.096, 0, -0.008], [0.27, 0.05, 0.06, 0, -0.012], [0.29, 0.005, 0.005, 0, -0.012]], 26, plate, { cap0: true, cap1: true, smooth: 1, disp: dent });
  m.push().at(0, 0.13, 0.102).loft([[-0.012, 0.075, 0.02], [0.012, 0.075, 0.02]], 18, M.ley, { a0: Math.PI / 2 - 0.9, a1: Math.PI / 2 + 0.9 }).pop();
  m.push().at(0, 0.24, -0.02).box(0.008, 0.06, 0.09, 0.006, M.bronze).pop();
  m.sweep([[0, 0.28, -0.01], [0, 0.36, -0.03], [0, 0.4, -0.05]], [0.006, 0.005, 0.003], 6, M.iron);
  m.push().at(0, 0.405, -0.052).sphere(0.016, 10, M.leySoft).pop();
  for (const [ub, fb] of [[B.UARM_L, B.FARM_L], [B.UARM_R, B.FARM_R]]) {
    m.bone = ub;
    m.sphere(0.072, 14, M.brass);
    m.sweep([[0, 0, 0], [0, -0.28, 0]], [0.026, 0.024], 12, M.steel);
    m.loft([[-0.25, 0.04, 0.042], [-0.12, 0.052, 0.054], [-0.03, 0.055, 0.058]], 18, plate, { a0: -0.3, a1: Math.PI + 0.3, disp: dent });
    m.bone = fb;
    m.sphere(0.052, 12, M.brass);
    m.loft([[-0.27, 0.034, 0.04], [-0.12, 0.05, 0.056], [0.0, 0.046, 0.05]], 20, plate, { smooth: 1, disp: dent });
    // Beveled forearm blade with a glowing ley edge.
    m.push().at(0, -0.28, 0.05, 0, 0.35 + Math.PI / 2);
    m.loft([[-0.02, 0.008, 0.035], [0.15, 0.007, 0.03], [0.33, 0.001, 0.004]], 4, M.steel, { flat: true });
    m.pop();
    m.push().at(0, -0.255, 0.07, 0, 0.35 + Math.PI / 2).box(0.002, 0.15, 0.003, 0.001, M.ley).pop();
  }
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.sphere(0.065, 12, M.brass);
    m.loft([[-0.44, 0.045, 0.05], [-0.2, 0.07, 0.075], [0.0, 0.075, 0.08]], 20, plate, { smooth: 1, disp: dent });
    m.bone = sb;
    m.sphere(0.055, 12, M.brass);
    m.sweep([[0.03, 0, 0], [0.03, -0.42, 0]], [0.014, 0.014], 8, M.steel);
    m.sweep([[-0.03, 0, 0], [-0.03, -0.42, 0]], [0.014, 0.014], 8, M.steel);
    m.loft([[-0.4, 0.04, 0.045, 0, 0.01], [-0.22, 0.05, 0.055, 0, 0.012]], 18, plate, { a0: 0, a1: Math.PI, disp: dent });
    for (const a of [-0.45, 0, 0.45]) m.sweep([[0, -0.44, 0.01], [Math.sin(a) * 0.06, -0.462, 0.07], [Math.sin(a) * 0.09, -0.47, 0.13]], [0.02, 0.016, 0.006], 8, plate, { cap1: true });
  }
}

/** @param {Mesh} m Basalt Warden: a hulking stone construct with ember seams. */
function buildGolem(m) {
  const rock = M.basalt;
  const seam = mat('#ff8a3a', 0.6, 0, 3.5);
  /** @param {number} seed @param {number} [amp] */
  const crag = (seed, amp = 0.05) => rough(2.6, amp * 1.9, seed, { ridge: 0.45 });
  m.bone = B.HIPS;
  m.ellipsoid(0.34, 0.2, 0.25, 20, 12, rock, { disp: crag(21, 0.035), smooth: 1 });
  m.bone = B.TORSO;
  m.push().at(0, 0.42, 0).ellipsoid(0.52, 0.44, 0.36, 26, 16, rock, { disp: crag(22), smooth: 1 }).pop();
  for (const x of [-0.46, 0.46]) m.push().at(x, 0.7, 0).ellipsoid(0.25, 0.22, 0.25, 18, 12, rock, { disp: crag(x > 0 ? 3 : 4, 0.04) }).pop();
  // Glowing ember seams running over the chest.
  for (const [a, b] of [[[-0.15, 0.25, 0.33], [-0.05, 0.55, 0.37]], [[0.12, 0.2, 0.34], [0.05, 0.45, 0.37]], [[0.0, 0.6, 0.36], [0.2, 0.7, 0.32]]]) {
    m.sweep([a, [(a[0] + b[0]) / 2 + 0.03, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + 0.012], b], [0.012, 0.014, 0.008], 8, seam, { cap0: true, cap1: true });
  }
  m.bone = B.HEAD;
  m.push().at(0, 0.12, 0.06).ellipsoid(0.17, 0.15, 0.17, 18, 12, rock, { disp: crag(23, 0.03) }).pop();
  for (const x of [-0.06, 0.06]) m.push().at(x, 0.14, 0.215).ellipsoid(0.026, 0.014, 0.012, 8, 5, seam).pop();
  for (const [ub, fb] of [[B.UARM_L, B.FARM_L], [B.UARM_R, B.FARM_R]]) {
    m.bone = ub;
    m.push().at(0, -0.2, 0).ellipsoid(0.17, 0.27, 0.17, 18, 12, rock, { disp: crag(ub, 0.04), smooth: 1 }).pop();
    m.bone = fb;
    m.push().at(0, -0.18, 0).ellipsoid(0.16, 0.26, 0.16, 18, 12, rock, { disp: crag(fb, 0.04), smooth: 1 }).pop();
    m.push().at(0, -0.49, 0.02).ellipsoid(0.19, 0.17, 0.19, 16, 10, rock, { disp: crag(fb + 40, 0.045) }).pop();
    m.sweep([[0, -0.15, 0.15], [0.02, -0.3, 0.16], [0, -0.4, 0.15]], [0.009, 0.011, 0.007], 6, seam, { cap0: true, cap1: true });
  }
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.push().at(0, -0.2, 0).ellipsoid(0.16, 0.26, 0.16, 16, 10, rock, { disp: crag(tb, 0.035), smooth: 1 }).pop();
    m.bone = sb;
    m.push().at(0, -0.22, 0).ellipsoid(0.15, 0.24, 0.16, 16, 10, rock, { disp: crag(sb, 0.035), smooth: 1 }).pop();
    m.push().at(0, -0.44, 0.06).ellipsoid(0.18, 0.07, 0.24, 16, 8, rock, { disp: crag(sb + 50, 0.03) }).pop();
  }
}

/** Golem skeleton: broad shoulders, short thick legs. */
const GOLEM_PIVOT = [[0, 0.88, 0], [0, 0.1, 0], [0, 0.82, 0.08], [0.55, 0.66, 0], [0, -0.44, 0], [-0.55, 0.66, 0], [0, -0.44, 0], [0.2, -0.08, 0], [0, -0.42, 0], [-0.2, -0.08, 0], [0, -0.42, 0], [0, 0.5, -0.1]];

/** Censer Wisp: a floating brass censer with orbiting rings around a ley core. */
const WISP_PARENT = [-1, 0, 0, 0, 0];
const WISP_PIVOT = [[0, 0.5, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0.02, 0]];

/** @param {Mesh} m */
function buildWisp(m) {
  m.bone = 0;
  m.lathe([[0, -0.32], [0.14, -0.28], [0.22, -0.12], [0.24, -0.04], [0.18, -0.02]], 14, M.brassTex);
  m.lathe([[0.16, 0.1], [0.2, 0.12], [0.12, 0.22], [0.04, 0.3], [0, 0.31]], 14, M.brassTex);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    m.tube([Math.cos(a) * 0.19, -0.03, Math.sin(a) * 0.19], [Math.cos(a) * 0.17, 0.11, Math.sin(a) * 0.17], 0.012, 0.012, 4, M.brass);
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    m.tube([Math.cos(a) * 0.1, 0.28, Math.sin(a) * 0.1], [0, 0.55, 0], 0.006, 0.006, 3, M.iron);
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    m.tube([Math.cos(a) * 0.14, -0.28, Math.sin(a) * 0.14], [Math.cos(a) * 0.12, -0.6, Math.sin(a) * 0.12], 0.006, 0.006, 3, M.iron);
  }
  for (let r = 1; r <= 3; r++) {
    m.bone = r;
    m.torus(0.33 + r * 0.05, 0.012, 24, 4, r === 2 ? M.bronze : M.brass);
  }
  m.bone = 4;
  m.sphere(0.12, 12, M.ley);
}

/** Character leathers and cord on the textured layers. */
const CM = { leather: fab('#4a3324', CL.LEATHER, 0.7), leatherDark: fab('#2e2119', CL.LEATHER, 0.75), rope: fab('#7a6a4c', CL.WOOL, 0.95) };
/** Skin tones on the textured skin layer. */
const SKIN = [fab('#c8a084', CL.SKIN, 0.6), fab('#a77b5f', CL.SKIN, 0.6), fab('#7d5641', CL.SKIN, 0.6), fab('#dcb79b', CL.SKIN, 0.6)];
/** Homespun wool of a colour. @param {string} hex */
const W = (hex) => fab(hex, CL.WOOL, 0.9);
/** Hair of a colour. @param {string} hex */
const HAIR = (hex) => fab(hex, CL.HAIR, 0.5);
/** Outfits per NPC sprite name. */
/** @type {Record<string, Outfit>} */
const OUTFITS = {
  folk_a: { hairStyle: 'tousled', skin: SKIN[0], top: W('#5f6a4e'), legs: W('#4a3e33'), boots: CM.leather, hair: HAIR('#4a3426'), hat: 'cap', hatM: W('#6a5a44'), held: null, age: 0.2 },
  folk_b: { hairStyle: 'parted', skin: SKIN[3], top: W('#7a4a40'), legs: W('#4e3f3a'), boots: CM.leatherDark, hair: HAIR('#5a3a26'), robe: W('#6e4a42'), hat: 'scarf', hatM: W('#b3a385'), apron: W('#b8aa90'), held: null, age: 0.35 },
  folk_c: { skin: SKIN[1], top: W('#4e5a66'), legs: W('#3e3a36'), boots: CM.leather, hair: HAIR('#6e5a48'), beard: true, hat: 'hood', hatM: W('#55524a'), held: null, age: 0.45 },
  merchant: { hairStyle: 'parted', skin: SKIN[0], top: W('#8a7342'), legs: W('#4b3c2e'), boots: CM.leatherDark, hair: HAIR('#2e231c'), apron: CM.leather, hat: 'cap', hatM: W('#4a3a2a'), held: null, age: 0.3 },
  guard: { skin: SKIN[1], top: W('#5a4e3e'), legs: W('#3d3833'), boots: CM.leatherDark, hair: HAIR('#3a2a1e'), armor: M.steel, hat: 'helm', cloak: W('#5e3430'), held: 'spear', glove: CM.leatherDark, age: 0.25 },
  master: { hairStyle: 'receding', skin: SKIN[0], top: W('#3a3330'), legs: W('#2f2a26'), boots: CM.leatherDark, hair: HAIR('#9a9288'), beard: true, robe: W('#3a3330'), hat: 'goggles', glow: M.ley, glove: M.brass, held: 'hammer', age: 0.6 },
  keeper: { hairStyle: 'parted', skin: SKIN[2], top: W('#7d6e58'), legs: W('#3e3630'), boots: CM.leather, hair: HAIR('#1e1a17'), hat: 'scarf', hatM: W('#7a3a2e'), apron: W('#c2b59c'), held: null, age: 0.3 },
  captain: { hairStyle: 'tied', skin: SKIN[3], top: W('#3e4a3c'), legs: W('#2e2f2a'), boots: CM.leatherDark, hair: HAIR('#7a4a2c'), armor: M.steel, cloak: W('#3a4a3a'), held: 'sword', glove: CM.leatherDark, age: 0.4 },
  // The Archivist: an old, stooped keeper of records in fraying dark-brown wool, layer on layer.
  archivist: {
    skin: fab('#a98370', CL.SKIN, 0.62), top: W('#3d2f26'), legs: W('#2f2620'), boots: CM.leatherDark, robe: W('#3b2d23'), hat: 'hood', hatM: W('#34281f'),
    mantle: W('#2b211a'), hair: HAIR('#9d968b'), beard: 'long', held: 'book', glow: M.leySoft, eye: 1,
    age: 0.9, stoop: 0.6, tatter: true, sleeves: 'bell', rope: true, pendant: true,
  },
};

// ---------------------------------------------------------------------------
// Townsfolk on the sculpted base meshes (assets/*.glb)
// ---------------------------------------------------------------------------

/** @type {{male: import('./meshes.js').Body, female: import('./meshes.js').Body}|null} */
let BODIES = null;

/**
 * Use the loaded base meshes for every townsperson from now on (rigs built earlier are dropped
 * from the cache). Without them the procedural bodies are used.
 * @param {{male: import('./meshes.js').Body, female: import('./meshes.js').Body}|null} b
 */
export function setBodies(b) {
  BODIES = b;
  rigCache.clear();
}

/** Whether characters are built on the .glb base meshes. */
export const hasBodies = () => !!BODIES;

/**
 * World bind matrices from parent-relative pivots and bind-pose turns about z (arms held out).
 * @param {number[]} parent @param {number[][]} pivot @param {number[]} [rz] @returns {Float32Array[]}
 */
function bindPose(parent, pivot, rz = []) {
  /** @type {Float32Array[]} */
  const W = [];
  for (let i = 0; i < parent.length; i++) {
    const l = trs(pivot[i][0], pivot[i][1], pivot[i][2], 0, 0, rz[i] ?? 0, 1);
    W.push(parent[i] < 0 ? l : mul(W[parent[i]], l));
  }
  return W;
}

/** Inverse of a rotation + translation matrix. @param {Float32Array} m @param {Float32Array} o */
function invRigid(m, o) {
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8]; o[3] = 0;
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9]; o[7] = 0;
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10]; o[11] = 0;
  o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
  o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
  o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
  o[15] = 1;
  return o;
}

/** Non-uniform scale matrix. @param {number} x @param {number} y @param {number} z */
function scaleM(x, y, z) {
  const m = ident();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

/** Roles that are always women; folk_a and folk_c alternate by variant. */
const WOMEN = new Set(['folk_b', 'keeper']);
const EITHER = new Set(['folk_a', 'folk_c']);
const HAIR_TONES = ['#2a1d16', '#4a3426', '#6e4a2c', '#8a6a42', '#1c1714', '#5a3a26', '#7a5236', '#3a2a20'];

/**
 * The outfit and body for one variant of a character: variant 0 is the outfit as written; others
 * vary the skin tone, hair colour, eye colour and garment palette deterministically, and some
 * townsfolk are women.
 * @param {string} name @param {number} variant @returns {{o: Outfit, female: boolean}}
 */
function outfitFor(name, variant) {
  const base = OUTFITS[name] ?? OUTFITS.folk_a;
  let h = 17;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const female = WOMEN.has(name) || (EITHER.has(name) && variant % 2 === 1);
  if (variant === 0 || name === 'archivist') return { o: { ...base, eye: base.eye ?? h % 5 }, female };
  const rnd = mulberry32((h ^ (variant * 2654435761)) >>> 0);
  /** @type {any} */
  const o = { ...base };
  for (const key of ['top', 'legs', 'robe', 'hatM', 'cloak', 'apron', 'mantle']) {
    const mt = o[key];
    if (mt && mt.l >= 0) o[key] = { ...mt, c: mt.c.map((/** @type {number} */ c) => c * (0.8 + rnd() * 0.4)) };
  }
  o.skin = SKIN[Math.floor(rnd() * SKIN.length)];
  if (o.hair && o.hair.c[0] < 2) o.hair = HAIR(HAIR_TONES[Math.floor(rnd() * HAIR_TONES.length)]);
  o.eye = Math.floor(rnd() * 5);
  if (female) {
    o.beard = false;
    if (!o.hair) o.hair = HAIR(HAIR_TONES[Math.floor(rnd() * HAIR_TONES.length)]);
    if (o.hairStyle === 'receding' || !o.hairStyle) o.hairStyle = 'tied';
  }
  return { o, female };
}

/** Garment layers, in the order they cover each other (a triangle takes the highest that claims it). */
const G = { SKIN: 0, LEGS: 1, GLOVE: 2, BOOTS: 3, TOP: 4 };

/**
 * A townsperson on a sculpted base mesh. The body is the real mesh, skinned with smooth two-bone
 * weights. Clothes are shells grown from its own surface (tunic and sleeves, trousers, boots,
 * gloves, a cuirass), so they follow the real shoulders and collarbones; skirts, robes, aprons,
 * belts, mantles and cloaks are lofted around its measured girths; eyes sit in its sockets;
 * beards grow from its jaw; hair is laid over its ray-cast scalp; hats fit its head.
 * @param {Mesh} m @param {Outfit} o @param {import('./meshes.js').Body} body
 */
function buildGlbHuman(m, o, body) {
  const { mesh: bm, info: I, skin: SK } = body;
  const P = bm.pos;
  const NR = bm.nrm;
  const T = bm.idx;
  const H = I.H;
  const k = H / 1.75;
  const nV = P.length / 3;
  const prevUvs = m.uvs;
  m.uvs = 3;
  const age = o.age ?? 0;
  /** @param {number} d @param {number} seed */
  const tat = (d, seed) => (o.tatter ? { tatter: [d, seed] } : {});
  const binds = /** @type {Float32Array[]} */ (m.binds);
  const ss = (/** @type {number} */ e0, /** @type {number} */ e1, /** @type {number} */ x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  // Landmarks.
  const eyeY = I.eyes[0][1];
  const span = I.crown - I.chin;
  const mouthY = I.chin + 0.245 * span;
  const noseY = I.chin + 0.375 * span;
  const kneeY = I.knee[0][1];
  const bootTop = kneeY - 0.075 * k;
  const [upLen, foreLen, handLen] = I.armLen;

  // Zones per vertex: which garment layer claims it.
  /** Arm parameter along the arm's axis (or -1). @param {number} v */
  const armT = (v) => {
    const s = P[v * 3] >= 0 ? 0 : 1;
    const sh = I.shoulder[s];
    const d = I.armDir[s];
    return (P[v * 3] - sh[0]) * d[0] + (P[v * 3 + 1] - sh[1]) * d[1] + (P[v * 3 + 2] - sh[2]) * d[2];
  };
  const layer = new Uint8Array(nV);
  for (let v = 0; v < nV; v++) {
    const b = SK.b0[v];
    const y = P[v * 3 + 1];
    let g = G.SKIN;
    if (b >= 3 && b <= 6) {
      const t = armT(v);
      if (t < upLen + foreLen - 0.004 * k) g = G.TOP;
      else g = o.glove ? G.GLOVE : G.SKIN;
    } else if (b === 1) g = y < I.neck[1] - 0.035 * k ? G.TOP : G.SKIN;
    else if (b === 0) g = G.LEGS;
    else if (b >= 7 && b <= 10) g = y < bootTop ? G.BOOTS : G.LEGS;
    layer[v] = g;
  }
  /** @type {Record<number, {mt: Mat, off: number}>} */
  const garb = {
    [G.SKIN]: { mt: o.skin, off: 0 },
    [G.LEGS]: { mt: o.legs, off: 0.0045 * k },
    [G.GLOVE]: { mt: o.glove ?? o.skin, off: 0.003 * k },
    [G.BOOTS]: { mt: o.boots, off: 0.009 * k },
    [G.TOP]: { mt: o.top, off: 0.0065 * k },
  };
  // Each triangle belongs to the highest layer among its corners; each vertex's lift is the
  // smallest of the layers meeting there, so hems close onto the skin without gaps.
  const ids = weldIds(bm);
  const triL = new Uint8Array(T.length / 3);
  const lift = new Float32Array(nV).fill(Infinity);
  for (let t = 0; t < T.length; t += 3) {
    const g = Math.max(layer[T[t]], layer[T[t + 1]], layer[T[t + 2]]);
    triL[t / 3] = g;
    for (let c = 0; c < 3; c++) lift[ids[T[t + c]]] = Math.min(lift[ids[T[t + c]]], garb[g].off);
  }

  // Cloth bridges hollows instead of hugging them: a tunic vertex down the sternum is lifted
  // toward the lower of the highest points beside it (left and right, within a hand's width), so
  // fabric spans the cleavage rather than outlining every curve; the lift fades out sideways.
  const bridge = new Float32Array(nV);
  /** @type {number[]} */
  const front = [];
  const chestHi = I.shoulder[0][1] - 0.03 * k;
  const chestLo = I.shoulder[0][1] - 0.26 * k;
  for (let v = 0; v < nV; v++) {
    if (layer[v] === G.TOP && SK.b0[v] === 1 && P[v * 3 + 2] > I.spine[2] && P[v * 3 + 1] < chestHi && P[v * 3 + 1] > chestLo) front.push(v);
  }
  for (const v of front) {
    let zl = -Infinity;
    let zr = -Infinity;
    for (const u of front) {
      if (Math.abs(P[u * 3 + 1] - P[v * 3 + 1]) > 0.015 * k) continue;
      const dx = P[u * 3] - P[v * 3];
      if (dx < -0.07 * k || dx > 0.07 * k) continue;
      if (dx < 0) zl = Math.max(zl, P[u * 3 + 2]);
      else if (dx > 0) zr = Math.max(zr, P[u * 3 + 2]);
    }
    const fade = Math.exp(-((P[v * 3] / (0.045 * k)) ** 2));
    bridge[v] = Math.min(0.03 * k, Math.max(0, Math.min(zl, zr) - P[v * 3 + 2]) * 0.85) * fade;
  }
  /** Lift of a vertex in a layer: the layer's offset, eased to nothing at seams, plus any bridge. @param {number} v @param {number} g */
  const liftOf = (v, g) => {
    const l = Math.min(lift[ids[v]], garb[g].off);
    return g === G.TOP && garb[g].off > 0 ? l + bridge[v] * (l / garb[g].off) : l;
  };

  // Skin tone zoning: ruddier lips, nose, cheeks and ears; darker under the eyes with age.
  const Gs = (/** @type {number} */ d, /** @type {number} */ s) => Math.exp(-(d * d) / (s * s));
  /** @param {number} x @param {number} y @param {number} z @returns {number[]} */
  const skinTint = (x, y, z) => {
    if (y < I.chin - 0.04 * k) return [1, 1, 1];
    const ax = Math.abs(x);
    const front = Math.min(1, Math.max(0, (z - I.neck[2]) / (0.04 * k)));
    const lip = front * Gs(ax, 0.022 * k) * Gs(y - mouthY, 0.008 * k);
    const nose = front * Gs(ax, 0.014 * k) * Gs(y - noseY, 0.014 * k);
    const cheek = front * Gs(ax - 0.045 * k, 0.018 * k) * Gs(y - eyeY + 0.03 * k, 0.018 * k);
    const ear = Gs(ax - 0.08 * k, 0.015 * k) * Gs(y - eyeY + 0.01 * k, 0.03 * k);
    const under = age * front * Gs(ax - 0.03 * k, 0.013 * k) * Gs(y - eyeY + 0.016 * k, 0.006 * k);
    const red = lip * 0.9 + nose * 0.35 + cheek * 0.3 + ear * 0.4;
    return [1 + 0.04 * red - 0.1 * under, 1 - 0.16 * red - 0.13 * under, 1 - 0.16 * red - 0.08 * under];
  };

  /**
   * @typedef {{p: number[], n: number[], skin: number[], off: number}} Corner base position,
   *   normal, skin weights [main, second, weight], lift along the normal
   */
  /** @param {number} v @param {number} off @returns {Corner} */
  const corner = (v, off) => ({ p: [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], n: [NR[v * 3], NR[v * 3 + 1], NR[v * 3 + 2]], skin: [SK.b0[v], SK.b1[v], SK.w[v]], off });
  /**
   * Emit one triangle of the body (or of a lifted shell over it), with cylindrical texture
   * coordinates around the axis of the bone it rides on.
   * @param {Corner[]} cs @param {number} bone @param {Mat} mt
   * @param {((x: number, y: number, z: number) => number[])|null} tint
   * @param {((x: number, y: number, z: number) => number)|null} [disp] extra lift (beard strands)
   */
  const emitTri = (cs, bone, mt, tint, disp = null) => {
    let R;
    /** @type {(p: number[]) => number[]} */
    let uvOf;
    if (bone >= 3 && bone <= 6) {
      const s = bone <= 4 ? 0 : 1;
      const d = I.armDir[s];
      const sh = I.shoulder[s];
      const e1 = norm(cross(d, [0, 0, 1]));
      const e2 = cross(d, e1);
      R = 0.045 * k;
      uvOf = (p) => {
        const q = [p[0] - sh[0], p[1] - sh[1], p[2] - sh[2]];
        return [Math.atan2(q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2], q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2]) * R, q[0] * d[0] + q[1] * d[1] + q[2] * d[2]];
      };
    } else if (bone >= 7 && bone <= 10) {
      const s = bone <= 8 ? 0 : 1;
      R = 0.06 * k;
      uvOf = (p) => [Math.atan2(p[0] - I.knee[s][0], p[2] - I.knee[s][2]) * R, p[1]];
    } else {
      // Trunk, neck and head share one frame, so skin texture runs on unbroken across the neck.
      R = 0.12 * k;
      uvOf = (p) => [Math.atan2(p[0], p[2] - I.neck[2]) * R, p[1]];
    }
    const uvs = cs.map((c) => uvOf(c.p));
    // Wrap the seam: a triangle straddling it takes one side's coordinates.
    const C = Math.PI * 2 * R;
    const us = uvs.map((q) => q[0]);
    if (Math.max(...us) - Math.min(...us) > C / 2) for (const q of uvs) if (q[0] < 0) q[0] += C;
    cs.forEach((c, i) => {
      let x = c.p[0] + c.n[0] * c.off;
      let y = c.p[1] + c.n[1] * c.off;
      let z = c.p[2] + c.n[2] * c.off;
      if (disp) {
        const dd = disp(x, y, z);
        x += c.n[0] * dd;
        y += c.n[1] * dd;
        z += c.n[2] * dd;
      }
      if (c.off > 0) y = Math.max(y, 0.001);
      const col = tint ? tint(x, y, z).map((f, q) => mt.c[q] * f) : mt.c;
      const skin = c.skin[0] + 16 * c.skin[1] + 256 * Math.round(c.skin[2] * 255);
      m.raw(x, y, z, c.n[0], c.n[1], c.n[2], uvs[i][0] * m.uvs, uvs[i][1] * m.uvs, col, mt.l, mt.r, mt.m, mt.e, m.sky, skin, 0);
    });
  };
  /**
   * Emit the body triangles a filter selects (or a lifted shell of them).
   * @param {(t: number) => boolean} take triangle filter (by first index)
   * @param {Mat} mt @param {(v: number) => number} offset lift along the normal per vertex
   * @param {((x: number, y: number, z: number) => number[])|null} tint
   * @param {((x: number, y: number, z: number) => number)|null} [disp]
   */
  const emit = (take, mt, offset, tint, disp = null) => {
    for (let t = 0; t < T.length; t += 3) {
      if (take(t)) emitTri([0, 1, 2].map((c) => corner(T[t + c], offset(T[t + c]))), SK.b0[T[t]], mt, tint, disp);
    }
  };

  // --- The body and its fitted garments. Triangles of one layer are emitted whole; triangles
  // that straddle a seam (neckline, wrist, boot top) are cut along it, so hems are clean edges
  // that close onto what lies below them.
  m.bone = B.HIPS;
  m.m = ident();
  const neckCut = I.neck[1] - 0.035 * k;
  const wristT = upLen + foreLen - 0.004 * k;
  /** Signed distance to the seam between two layers (negative on the covering side), or null. @param {number} hi @param {number} lo @param {number} v */
  const seam = (hi, lo, v) => {
    if (hi === G.BOOTS && lo === G.LEGS) return P[v * 3 + 1] - bootTop;
    if (hi === G.TOP && (lo === G.SKIN || lo === G.GLOVE)) return SK.b0[v] >= 3 && SK.b0[v] <= 6 ? armT(v) - wristT : P[v * 3 + 1] - neckCut;
    return null;
  };
  /** Interpolate two corners at fraction f; weights blend when both share bones, else the nearer end's. @param {Corner} a @param {Corner} b @param {number} f @returns {Corner} */
  const mix = (a, b, f) => {
    const n = norm([a.n[0] + (b.n[0] - a.n[0]) * f, a.n[1] + (b.n[1] - a.n[1]) * f, a.n[2] + (b.n[2] - a.n[2]) * f]);
    const same = a.skin[0] === b.skin[0] && a.skin[1] === b.skin[1];
    const skin = same ? [a.skin[0], a.skin[1], a.skin[2] + (b.skin[2] - a.skin[2]) * f] : (f < 0.5 ? a.skin : b.skin).slice();
    return { p: [0, 1, 2].map((q) => a.p[q] + (b.p[q] - a.p[q]) * f), n, skin, off: 0 };
  };
  /** @param {Corner[]} poly @param {number} bone @param {number} g */
  const fan = (poly, bone, g) => {
    for (let i = 1; i + 1 < poly.length; i++) emitTri([poly[0], poly[i], poly[i + 1]], bone, garb[g].mt, g === G.SKIN ? skinTint : null);
  };
  for (let t = 0; t < T.length; t += 3) {
    const vs = [T[t], T[t + 1], T[t + 2]];
    const ls = vs.map((v) => layer[v]);
    const hi = Math.max(...ls);
    const lo = Math.min(...ls);
    const bone = SK.b0[vs[0]];
    const f = hi !== lo ? vs.map((v) => seam(hi, lo, v)) : null;
    if (!f || f.some((x) => x === null)) {
      fan(vs.map((v) => corner(v, liftOf(v, hi))), bone, hi);
      continue;
    }
    // Clip the triangle at the seam: the covering layer below zero, the other above.
    /** @type {Corner[]} */
    const below = [];
    /** @type {Corner[]} */
    const above = [];
    for (let i = 0; i < 3; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % 3];
      const fa = /** @type {number} */ (f[i]);
      const fb = /** @type {number} */ (f[(i + 1) % 3]);
      if (fa < 0) below.push(corner(a, liftOf(a, hi)));
      else above.push(corner(a, 0));
      if ((fa < 0) !== (fb < 0)) {
        const cut = mix(corner(a, 0), corner(b, 0), fa / (fa - fb));
        below.push(cut);
        above.push({ ...cut });
      }
    }
    if (below.length >= 3) fan(below, bone, hi);
    if (above.length >= 3) fan(above, bone, lo);
  }

  if (o.armor) {
    // Steel cuirass over the tunic, grown from the chest and back.
    const chest = (/** @type {number} */ v) => SK.b0[v] === 1 && P[v * 3 + 1] < I.neck[1] - 0.06 * k && P[v * 3 + 1] > I.spine[1] - 0.02 * k;
    emit((t) => chest(T[t]) && chest(T[t + 1]) && chest(T[t + 2]), o.armor, () => 0.017 * k, null);
  }
  if (o.beard) {
    // Beard grown from the jaw, chin and lower cheeks (the mouth left clear), strands combed down.
    const strands = rough(70, 0.0025, 4, { stretch: 3 });
    const beardV = (/** @type {number} */ v) => {
      const x = Math.abs(P[v * 3]), y = P[v * 3 + 1], z = P[v * 3 + 2];
      if (SK.b0[v] !== 2) return false;
      if (z < I.neck[2] + 0.01 * k || y < I.chin - 0.022 * k) return false;
      if (x < 0.026 * k && Math.abs(y - mouthY) < 0.011 * k) return false;
      return y < mouthY - 0.008 * k || (y < noseY - 0.004 * k && x > 0.032 * k) || (y < eyeY - 0.03 * k && x > 0.06 * k);
    };
    emit((t) => beardV(T[t]) && beardV(T[t + 1]) && beardV(T[t + 2]), o.hair ?? M.barkDark, () => 0.006 * k, null, strands);
  }

  // --- Head: eyes in the sockets, brows, hair and headwear fitted to this skull.
  m.bone = B.HEAD;
  const neck = I.neck;
  const toHead = (/** @type {number[]} */ p) => [p[0] - neck[0], p[1] - neck[1], p[2] - neck[2]];
  // The upper lid's resting turn: just above a sculpted lid's rim if the mesh has one.
  const upRot = I.eyeHoles ? 0.24 : 0.35 + 0.09 * age;
  if (DETAIL >= 1) buildEyes(m, o, I.eyes.map(toHead), I.eyeR, upRot);
  const hairM = o.hair ?? fab('#3a2c22', CL.HAIR, 0.6);
  const bk = 1 + age * 0.6;
  /** Point a hair's breadth proud of the face at (x, y), in the head's frame. @param {number} x @param {number} y @param {number} lift */
  const onFace = (x, y, lift) => toHead([x, y, frontAt(bm, x, y) + lift]);
  for (const sd of [-1, 1]) {
    const by = eyeY + 0.019 * k;
    const pts = [[0.011, by - 0.002 * k], [0.027, by + 0.004 * k], [0.045, by + 0.002 * k], [0.058, by - 0.005 * k]].map(([x, y]) => onFace(sd * x * k, y, 0.001));
    m.sweep(pts, [[0.0016, 0.0036 * bk], [0.0019, 0.0046 * bk], [0.0016, 0.0038 * bk], [0.001, 0.0018]].map(([a, b]) => [a * k, b * k]), 6, hairM, { cap0: true, cap1: true, sub: 3 });
  }
  if (o.beard) {
    const ms = [[-0.033, mouthY - 0.008 * k], [-0.021, mouthY + 0.006 * k], [0, mouthY + 0.01 * k], [0.021, mouthY + 0.006 * k], [0.033, mouthY - 0.008 * k]].map(([x, y]) => onFace(x * k, y, 0.003 * k));
    m.sweep(ms, [[0.003, 0.002], [0.0055, 0.003], [0.006, 0.0032], [0.0055, 0.003], [0.003, 0.002]].map(([a, b]) => [a * k, b * k]), 8, hairM, { cap0: true, cap1: true });
  }
  // Procedural head frame fitted onto this head (hair, long beards, hats and hoods are authored there).
  const F = I.headFit;
  const fit = mul(trs(0, F.y0 - neck[1], F.z0 - neck[2], 0, 0, 0, 1), scaleM(F.sx, F.sy, F.sz));
  /** Head triangles in the procedural frame, for ray-casting the scalp. */
  const headTris = [];
  for (let t = 0; t < T.length; t += 3) {
    if (SK.b0[T[t]] !== 2) continue;
    headTris.push(...[0, 1, 2].map((c) => {
      const v = T[t + c];
      return [P[v * 3] / F.sx, (P[v * 3 + 1] - F.y0) / F.sy, (P[v * 3 + 2] - F.z0) / F.sz];
    }));
  }
  /** Distance from the cranium centre to the outermost scalp along d (procedural frame). @param {number[]} d */
  const hit = (d) => {
    let best = 0;
    for (let i = 0; i < headTris.length; i += 3) {
      const a = headTris[i], b = headTris[i + 1], c = headTris[i + 2];
      const e1 = sub(b, a);
      const e2 = sub(c, a);
      const pv = cross(d, e2);
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12) continue;
      const tv = sub(SKULL_C, a);
      const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
      if (u < 0 || u > 1) continue;
      const qv = cross(tv, e1);
      const w = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) / det;
      if (w < 0 || u + w > 1) continue;
      const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det;
      if (t > best) best = t;
    }
    return best || skullHit(d);
  };
  if (o.hair && o.hat !== 'helm') {
    // Darker under-layer: the scalp itself, lifted a touch, above the hairline.
    const bare = o.hat === 'cap' || o.hat === 'scarf';
    if (!bare && o.hat !== 'hood') {
      const recede = o.hairStyle === 'receding';
      const scalpV = (/** @type {number} */ v) => {
        if (SK.b0[v] !== 2) return false;
        const p = [P[v * 3] / F.sx - SKULL_C[0], (P[v * 3 + 1] - F.y0) / F.sy - SKULL_C[1], (P[v * 3 + 2] - F.z0) / F.sz - SKULL_C[2]];
        const l = Math.hypot(p[0], p[1], p[2]) || 1;
        const ph = Math.atan2(p[2], p[0]);
        if (recede && Math.sin(ph) > 0.15) return false;
        return Math.asin(p[1] / l) > hairEndE(ph) + 0.03;
      };
      emit((t) => scalpV(T[t]) && scalpV(T[t + 1]) && scalpV(T[t + 2]), shade(o.hair, 0.5), () => 0.0016 * k, null);
    }
    m.bone = B.HEAD;
    m.m = mul(m.m, fit);
    buildHair(m, o, o.hair, { hit, noUnder: true });
  }
  if (o.beard === 'long') {
    m.bone = B.HEAD;
    m.m = mul(m.m, fit);
    m.loft([[-0.12, 0.012, 0.01, 0, 0.118], [-0.08, 0.03, 0.022, 0, 0.11], [-0.03, 0.048, 0.034, 0, 0.092], [0.01, 0.058, 0.05, 0, 0.068], [0.04, 0.066, 0.062, 0, 0.046]], 22, hairM,
      { a0: -0.3, a1: Math.PI + 0.3, disp: rough(60, 0.0035, 4, { stretch: 3 }), smooth: 1, tatter: [0.03, 41] });
  }
  m.bone = B.HEAD;
  m.m = mul(m.m, fit);
  buildHeadwear(m, o, o.hatM ?? o.top);

  // --- Hips: skirt or robe lofted around the measured girths, scapular, belt or rope, apron, tassets.
  m.bone = B.HIPS;
  const hp = I.hips;
  /** A loft row around the body at model height y, with an extra margin. @param {number} y @param {number} add */
  const ring = (y, add) => {
    const g = I.girth(y);
    return [y - hp[1], g.rx + add, g.rz + add, 0, g.cz - hp[2]];
  };
  const waistY = I.spine[1] + 0.01 * k;
  const crotch = I.hip[0][1] - 0.06 * k;
  if (o.robe) {
    const rows = [ring(I.ankleY + 0.02 * k, 0.11 * k), ring(kneeY - 0.05 * k, 0.07 * k), ring(crotch, 0.035 * k), ring(I.hips[1], 0.02 * k), ring(waistY, 0.012 * k)];
    m.loft(rows, 30, o.robe, { folds: [11, 0.022 * k], smooth: 1, ...tat(0.07 * k, 11) });
    if (o.mantle) {
      for (const c of [Math.PI / 2, -Math.PI / 2]) {
        m.loft(rows.slice(1).map(([y, rx, rz, cx, cz]) => [y, rx + 0.012 * k, rz + 0.012 * k, cx, cz]), 12, o.mantle,
          { a0: c - 0.55, a1: c + 0.55, folds: [3, 0.01], smooth: 1, ...tat(0.05 * k, c > 0 ? 13 : 14) });
      }
    }
  } else {
    m.loft([ring(crotch - 0.13 * k, 0.03 * k), ring(crotch, 0.02 * k), ring(I.hips[1], 0.012 * k), ring(waistY - 0.03 * k, 0.009 * k)], 26, o.top, { folds: [9, 0.012 * k], smooth: 1, ...tat(0.03 * k, 12) });
  }
  const wr = ring(waistY, 0.014 * k);
  if (o.rope) {
    // Knotted rope girdle with two hanging ends.
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push([Math.cos(a) * wr[1], wr[0], wr[4] + Math.sin(a) * wr[2]]);
    }
    m.sweep(pts, pts.map(() => 0.011 * k), 6, CM.rope, { sub: 2 });
    const fz = wr[4] + wr[2];
    for (const sd of [-1, 1]) {
      m.sweep([[sd * 0.04 * k, wr[0], fz], [sd * 0.05 * k, wr[0] - 0.12 * k, fz + 0.02 * k], [sd * 0.06 * k, wr[0] - 0.28 * k, fz + 0.035 * k], [sd * 0.065 * k, wr[0] - 0.4 * k, fz + 0.045 * k]],
        [0.0085, 0.008, 0.0075, 0.007].map((r) => r * k), 8, CM.rope, { cap1: true, disp: rough(70, 0.001, 19 + sd) });
      m.push().at(sd * 0.065 * k, wr[0] - 0.4 * k, fz + 0.045 * k).ellipsoid(0.014 * k, 0.018 * k, 0.014 * k, 10, 6, CM.rope).pop();
    }
    m.push().at(0, wr[0], fz + 0.004).ellipsoid(0.02 * k, 0.016 * k, 0.014 * k, 10, 6, CM.rope).pop();
  } else {
    m.loft([[wr[0] - 0.024 * k, wr[1], wr[2], 0, wr[4]], [wr[0] + 0.024 * k, wr[1] - 0.003, wr[2] - 0.003, 0, wr[4]]], 26, CM.leatherDark);
    m.push().at(0, wr[0], wr[4] + wr[2] + 0.003).box(0.026 * k, 0.02 * k, 0.006, 0.004, M.brass).pop();
    m.push().at(-(wr[1] - 0.01), wr[0] - 0.06 * k, wr[4] + wr[2] * 0.4, -0.55).box(0.032 * k, 0.042 * k, 0.02 * k, 0.012, CM.leather).at(0, 0.035 * k, 0.004).box(0.034 * k, 0.012 * k, 0.022 * k, 0.006, CM.leatherDark).pop();
  }
  if (o.apron) {
    const a0 = ring(waistY, 0.03 * k);
    m.loft([[crotch - 0.25 * k - hp[1], a0[1] + 0.02, a0[2] + 0.04, 0, a0[4]], [crotch - hp[1], a0[1] + 0.012, a0[2] + 0.02, 0, a0[4]], a0], 14, o.apron, { a0: Math.PI / 2 - 0.95, a1: Math.PI / 2 + 0.95, folds: [5, 0.004] });
  }
  if (o.armor) {
    // Leather tassets hang from the cuirass over the hips, flaring outward.
    const tr = ring(I.hips[1] - 0.02 * k, 0.03 * k);
    for (let q = 0; q < 7; q++) {
      const a = Math.PI / 2 + (q - 3) * 0.42;
      m.push().at(Math.cos(a) * tr[1], tr[0] - 0.05 * k, tr[4] + Math.sin(a) * tr[2], Math.PI / 2 - a, -0.14).box(0.036 * k, 0.085 * k, 0.006, 0.004, CM.leatherDark);
      m.at(0, 0.06 * k, 0.007).sphere(0.0055, 6, M.brass).pop();
    }
  }

  // --- Torso: mantle, cowl, hood collar and pendant in the procedural torso frame, scaled to fit.
  m.bone = B.TORSO;
  const chest = I.girth(I.shoulder[0][1] - 0.12 * k);
  const tScale = scaleM(I.shoulder[0][0] / 0.2, (neck[1] - I.spine[1]) / 0.52, chest.rz / 0.123);
  m.m = mul(mul(m.m, trs(0, 0, chest.cz - I.spine[2], 0, 0, 0, 1)), tScale);
  if (o.mantle) {
    m.loft([[0.22, 0.345, 0.19], [0.32, 0.335, 0.18], [0.42, 0.315, 0.165], [0.475, 0.27, 0.15], [0.51, 0.19, 0.12], [0.535, 0.1, 0.085]], 32, o.mantle, { folds: [10, 0.018], smooth: 1, ...tat(0.045, 21) });
    m.loft([[0.47, 0.25, 0.17, 0, 0.01], [0.5, 0.215, 0.15, 0, 0.012], [0.53, 0.15, 0.115, 0, 0.012], [0.55, 0.1, 0.09, 0, 0.01]], 28, o.hatM ?? o.mantle, { folds: [9, 0.012], smooth: 1 });
  } else if (o.hat === 'hood') {
    m.loft([[0.34, 0.235, 0.155], [0.45, 0.185, 0.123], [0.52, 0.1, 0.086]], 24, o.hatM ?? o.top, { folds: [8, 0.012], smooth: 1 });
  }
  if (o.pendant) {
    m.sweep([[-0.07, 0.53, 0.1], [-0.06, 0.45, 0.17], [0, 0.37, 0.19], [0.06, 0.45, 0.17], [0.07, 0.53, 0.1]], [0.0028, 0.0028, 0.0028, 0.0028, 0.0028], 6, CM.leatherDark);
    m.push().at(0, 0.352, 0.192, 0, Math.PI / 2 - 0.15);
    m.lathe([[0.02, -0.004], [0.024, 0], [0.02, 0.005]], 18, M.brass, { cap0: true });
    m.at(0, 0.005, 0).lathe([[0.012, 0], [0.007, 0.006], [0, 0.008]], 12, o.glow ?? M.leySoft);
    m.pop();
  }

  // --- Arms: pauldrons, bell sleeves, and the held item, in each arm's own (bind) frame.
  for (const [ub, fb, side] of [[B.UARM_L, B.FARM_L, 1], [B.UARM_R, B.FARM_R, -1]]) {
    if (o.armor) {
      m.bone = ub;
      m.push().at(side * 0.012, -0.005, 0, 0, 0, side * -0.3);
      m.loft([[-0.11, 0.085, 0.083], [-0.07, 0.093, 0.09], [-0.02, 0.098, 0.096]], 22, CM.leatherDark, { tatter: [0.008, 51] });
      m.loft([[-0.06, 0.098, 0.096], [0.0, 0.094, 0.09], [0.04, 0.07, 0.07], [0.065, 0.02, 0.02]], 22, o.armor, { cap1: true, disp: rough(11, 0.002, 5) });
      m.loft([[-0.09, 0.09, 0.086], [-0.055, 0.092, 0.088]], 22, o.armor);
      for (let q = 0; q < 6; q++) {
        const a = (q / 6) * Math.PI * 2;
        m.push().at(Math.cos(a) * 0.094, -0.055, Math.sin(a) * 0.09).sphere(0.006, 6, M.brass).pop();
      }
      m.pop();
    }
    if (o.sleeves === 'bell') {
      m.bone = fb;
      m.m = mul(m.m, scaleM(1, foreLen / 0.27, 1));
      m.loft([[-0.275, 0.086, 0.082, 0, 0.012], [-0.18, 0.07, 0.066, 0, 0.006], [-0.06, 0.057, 0.056], [0.04, 0.051, 0.053]], 24, o.robe ?? o.top, { folds: [6, 0.012], smooth: 1, ...tat(0.03, 61 + side) });
    }
  }

  // --- Cloak from the shoulder blades.
  if (o.cloak) {
    m.bone = B.CLOAK;
    const cs = I.shoulder[0][0] / 0.2;
    m.m = mul(m.m, scaleM(cs, H / 1.8, cs));
    m.loft([[-1.02, 0.36, 0.2, 0, 0.04], [-0.6, 0.3, 0.17, 0, 0.05], [-0.2, 0.24, 0.14, 0, 0.06], [0.0, 0.205, 0.12, 0, 0.07]], 28, o.cloak,
      { a0: Math.PI + 0.12, a1: Math.PI * 2 - 0.12, folds: [7, 0.03], smooth: 1, tatter: [0.035, 71] });
    m.loft([[-0.02, 0.21, 0.13, 0, 0.07], [0.03, 0.17, 0.12, 0, 0.08]], 24, o.cloak, { a0: Math.PI - 0.3, a1: Math.PI * 2 + 0.3 });
  }

  // --- Held item in the right hand, at the palm.
  buildHeld(m, o, [0.016 * k, -(foreLen + handLen * 0.42), 0.012 * k]);
  m.uvs = prevUvs;
}

/**
 * Skeleton and bind pose for a base mesh: pivots from its measured joints, the arms' bind frames
 * turned out along the mesh's A-pose (so posing them down to the sides is a plain rotation), and
 * the eyelid bones at the eye centres. Also the arm angle that clears the hips at rest.
 * @param {import('./meshes.js').BodyInfo} I
 */
function glbSkeleton(I) {
  const rel = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const [up] = I.armLen;
  const aL = Math.atan2(I.armDir[0][0], -I.armDir[0][1]);
  const cloak = [0, I.shoulder[0][1] + 0.02 * (I.H / 1.75), I.backZ];
  const pivot = [
    I.hips, rel(I.spine, I.hips), rel(I.neck, I.spine),
    rel(I.shoulder[0], I.spine), [0, -up, 0], rel(I.shoulder[1], I.spine), [0, -up, 0],
    rel(I.hip[0], I.hips), rel(I.knee[0], I.hip[0]), rel(I.hip[1], I.hips), rel(I.knee[1], I.hip[1]),
    rel(cloak, I.spine), rel(I.eyes[0], I.neck), rel(I.eyes[1], I.neck),
  ];
  const rz = [0, 0, 0, aL, 0, -aL, 0, 0, 0, 0, 0, 0, 0, 0];
  // Rest the arms just clear of the hips.
  const hipW = I.girth(I.spine[1]).rx;
  const armOut = Math.max(0.08, Math.atan2(hipW + 0.045 * (I.H / 1.75) - I.shoulder[0][0], I.shoulder[0][1] - I.spine[1]));
  return { pivot, rz, armOut };
}

/** @type {Map<string, Rig>} */
const rigCache = new Map();

/** Every character rig, for warming the caches before play. */
export const RIG_NAMES = ['folk_a', 'folk_b', 'folk_c', 'merchant', 'guard', 'master', 'keeper', 'captain', 'archivist', 'sentinel', 'golem', 'wisp'];

/**
 * Rig for a character sprite base name (NPC sprite or enemy kind) and variant; far builds the
 * low-poly LOD. Geometry is in model space (bind pose); skin with pose x invBind.
 * @param {string} name @param {boolean} [far] @param {number} [variant] @returns {Rig}
 */
export function getRig(name, far = false, variant = 0) {
  const key = `${name}#${variant}${far ? '~' : ''}`;
  let r = rigCache.get(key);
  if (r) return r;
  const m = new Mesh(16384);
  DETAIL = far ? 0.45 : 1;
  try {
    r = buildRig(name, m, variant);
  } finally {
    DETAIL = 1;
  }
  // Bake AO on the assembled body in its bind pose, so armpits, chins and cloak folds darken
  // where the body actually crowds them.
  finalize(m, { ao: far ? 0 : 0.9 });
  rigCache.set(key, r);
  return r;
}

/** @param {string} name @param {Mesh} m @param {number} variant @returns {Rig} */
function buildRig(name, m, variant) {
  /** @type {number[]} */
  let parent;
  /** @type {number[][]} */
  let pivot;
  /** @type {number[]} */
  let rz = [];
  /** @type {Rig['kind']} */
  let kind = 'human';
  let scale = 1;
  let armOut = 0.08;
  let stoop = 0;
  /** @type {() => void} */
  let build;
  if (name === 'wisp') {
    parent = WISP_PARENT; pivot = WISP_PIVOT; kind = 'wisp';
    build = () => buildWisp(m);
  } else if (name === 'golem') {
    parent = HUMAN_PARENT; pivot = GOLEM_PIVOT; kind = 'golem'; scale = 1.25;
    build = () => buildGolem(m);
  } else if (name === 'sentinel') {
    parent = HUMAN_PARENT; pivot = HUMAN_PIVOT; scale = 1.1;
    build = () => buildSentinel(m);
  } else {
    const { o, female } = outfitFor(name, variant);
    stoop = o.stoop ?? 0;
    // Two more bones for the blinking upper lids, pivoting about each eye's centre.
    parent = [...HUMAN_PARENT, B.HEAD, B.HEAD];
    const body = BODIES ? (female ? BODIES.female : BODIES.male) : null;
    if (body) {
      const sk = glbSkeleton(body.info);
      pivot = sk.pivot;
      rz = sk.rz;
      armOut = sk.armOut;
      build = () => buildGlbHuman(m, o, body);
    } else {
      pivot = [...HUMAN_PIVOT, [0, 0, 0], [0, 0, 0]];
      build = () => {
        const eyes = buildHuman(m, o);
        pivot[B.LID_L] = eyes[0];
        pivot[B.LID_R] = eyes[1];
      };
    }
  }
  m.binds = bindPose(parent, pivot, rz);
  build();
  const invBind = new Float32Array(parent.length * 16);
  m.binds.forEach((b, i) => invRigid(b, invBind.subarray(i * 16, i * 16 + 16)));
  m.binds = null;
  return { parent, pivot, mesh: m, kind, scale, stoop, armOut, invBind };
}

/**
 * Animation inputs for one character, produced by the entities each frame.
 * @typedef {Object} ModelDesc
 * @property {string} rig sprite base name (NPC sprite) or enemy rig (sentinel, wisp, golem)
 * @property {number} yaw facing angle in the game's convention (forward = cos, sin)
 * @property {number} t animation clock, seconds
 * @property {number} walk 0 standing .. 1 striding
 * @property {number} phase stride phase, radians
 * @property {string} act '' | windup | lunge | recover | charge | talk
 * @property {number} k progress of act, 0..1
 * @property {number} stagger 0..1
 * @property {number} dead collapse progress, 0..1
 * @property {number} scale overall size multiplier
 * @property {number} [gaze] 0..1 how strongly the head tracks a target
 * @property {number} [look] target bearing minus facing, radians (the game's angle convention)
 * @property {number} [lookUp] pitch toward the target, radians (positive is up)
 * @property {number} [variant] which look of the character (skin, hair, palette, body)
 * @property {import('./meshes.js').GlbAnimator} [glb] rigged .glb model and its animation state, drawn instead of the rig
 */

const ease = (/** @type {number} */ x) => x * x * (3 - 2 * x);
const clamp01 = (/** @type {number} */ x) => Math.max(0, Math.min(1, x));

/**
 * Compute every bone's world matrix for one pose into out (MAX_BONES * 16 floats).
 * @param {Rig} rig @param {ModelDesc} a @param {number} x @param {number} y @param {number} z @param {Float32Array} out
 * @returns {number} bones written
 */
export function poseRig(rig, a, x, y, z, out) {
  const n = rig.parent.length;
  const rx = new Float32Array(n);
  const ry = new Float32Array(n);
  const rz = new Float32Array(n);
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  const oz = new Float32Array(n);
  const sc = new Float32Array(n).fill(1);
  const t = a.t;
  const dead = ease(clamp01(a.dead));
  if (rig.kind === 'wisp') {
    const charge = a.act === 'charge' ? a.k : 0;
    oy[0] = Math.sin(t * 2) * 0.06 - dead * 0.5;
    rx[0] = Math.sin(t * 1.3) * 0.08 + dead * 1.2;
    rz[0] = Math.cos(t * 1.1) * 0.08;
    ry[1] = t * 1.6; rx[1] = 0.5;
    ry[2] = -t * 1.2; rz[2] = 1.1;
    ry[3] = t * 2.3 * (1 + charge * 3); rx[3] = -0.9;
    sc[4] = (1 + Math.sin(t * 5) * 0.06 + charge * 0.6) * (1 - dead);
  } else {
    const golem = rig.kind === 'golem';
    const w = a.walk * (1 - dead);
    const ph = a.phase;
    const s = Math.sin(ph);
    const breath = Math.sin(t * 1.7);
    const stride = golem ? 0.38 : 0.55;
    // Idle weight shift: the body settles onto one leg (that hip rises, the other knee softens)
    // and drifts slowly to the other; the torso counter-tilts and twists, the chest breathes.
    const idle = 1 - w;
    const lean = Math.sin(t * 0.21) * (golem ? 0.4 : 1);
    const twist = Math.sin(t * 0.17);
    oy[0] = -Math.abs(Math.cos(ph)) * 0.035 * w + breath * 0.004 - 0.008 * idle * Math.abs(lean);
    ox[0] = -lean * 0.022 * idle;
    rz[0] = -lean * 0.05 * idle + 0.035 * s * w;
    // Walking: hips swing with the stride and the shoulders counter-rotate against them.
    ry[0] = s * 0.13 * w + twist * 0.04 * idle;
    rx[1] = 0.05 * w + breath * 0.015;
    ry[1] = -s * 0.22 * w - twist * 0.06 * idle;
    rz[1] = lean * 0.055 * idle - 0.03 * s * w;
    sc[1] = 1 + breath * 0.012;
    // Gaze: the head (and a little of the chest) turns toward what the character watches, and
    // the idle glancing about fades while it does. +ry turns toward the model's left, which is
    // a smaller bearing in the game's convention.
    const gaze = clamp01(a.gaze ?? 0);
    ry[2] = Math.sin(t * 0.37) * 0.25 * idle * (golem ? 0.3 : 1) * (1 - gaze * 0.85) + s * 0.09 * w - (a.look ?? 0) * 0.72 * gaze;
    ry[1] -= (a.look ?? 0) * 0.28 * gaze;
    rx[2] = Math.sin(t * 0.23) * 0.05 * (1 - gaze * 0.6) - 0.03 * w - (a.lookUp ?? 0) * gaze;
    rz[2] = -lean * 0.03 * idle;
    const onLeft = Math.max(0, -lean);
    const onRight = Math.max(0, lean);
    rx[B.THIGH_L] = -s * stride * w - 0.06 * idle * onRight;
    rx[B.THIGH_R] = s * stride * w - 0.06 * idle * onLeft;
    rz[B.THIGH_L] = lean * 0.05 * idle;
    rz[B.THIGH_R] = lean * 0.05 * idle;
    rx[B.SHIN_L] = w * (0.1 + 0.75 * Math.max(0, Math.sin(ph + 1.7))) + 0.16 * idle * onRight;
    rx[B.SHIN_R] = w * (0.1 + 0.75 * Math.max(0, Math.sin(ph + 1.7 + Math.PI))) + 0.16 * idle * onLeft;
    const sway = Math.sin(t * 0.9) * 0.025 * idle;
    rx[B.UARM_L] = s * 0.45 * w + breath * 0.02 + sway;
    rx[B.UARM_R] = -s * 0.45 * w - breath * 0.02 - sway;
    const out = golem ? 0.18 : rig.armOut ?? 0.08;
    rz[B.UARM_L] = out + lean * 0.03 * idle;
    rz[B.UARM_R] = -out + lean * 0.03 * idle;
    rx[B.FARM_L] = -0.18 - 0.25 * w * Math.max(0, -s) - 0.06 * idle;
    rx[B.FARM_R] = -0.18 - 0.25 * w * Math.max(0, s) - 0.06 * idle;
    // Cloak: trails behind with the stride, flutters, and lags the hips' swing.
    rx[B.CLOAK] = 0.08 + w * 0.3 + Math.sin(t * 1.3) * 0.03 + Math.sin(t * 2.3 + 1) * 0.015 * (0.5 + w);
    rz[B.CLOAK] = -ry[0] * 0.6 + Math.sin(t * 0.9) * 0.03;
    // Age: a stooped spine with the head lifted to compensate, soft knees, arms carried forward.
    const st = rig.stoop ?? 0;
    if (st > 0) {
      rx[0] += 0.06 * st;
      rx[1] += 0.46 * st;
      rx[2] -= 0.38 * st;
      oy[0] -= 0.03 * st;
      rx[B.THIGH_L] -= 0.12 * st;
      rx[B.THIGH_R] -= 0.12 * st;
      rx[B.SHIN_L] += 0.2 * st;
      rx[B.SHIN_R] += 0.2 * st;
      rx[B.UARM_L] -= 0.22 * st;
      rx[B.UARM_R] -= 0.22 * st;
      rx[B.FARM_L] -= 0.3 * st;
      rx[B.FARM_R] -= 0.3 * st;
      rx[B.CLOAK] += 0.2 * st;
    }
    // Blinks every 3-5 s; the animation clock starts at a random time per character, so each
    // blinks on its own rhythm. Lids close when stunned or dead.
    if (n > B.LID_R) {
      const k0 = Math.floor(t / 4);
      let blink = 0;
      for (const kk of [k0 - 1, k0]) {
        const x = t - (kk * 4 + hash2(kk, 7, 4242) * 1.5);
        if (x > 0 && x < 0.18) blink = Math.max(blink, Math.sin((x / 0.18) * Math.PI));
      }
      blink = Math.max(blink, dead, clamp01(a.stagger * 3) * 0.5);
      rx[B.LID_L] = rx[B.LID_R] = blink * 0.98;
    }
    // Actions.
    const k = ease(clamp01(a.k));
    if (a.act === 'talk') {
      rx[B.UARM_R] = -0.45 + Math.sin(t * 2.6) * 0.15;
      rx[B.FARM_R] = -0.9 + Math.sin(t * 3.1) * 0.2;
      rx[2] += Math.sin(t * 4.2) * 0.04;
    } else if (golem) {
      if (a.act === 'windup') {
        rx[B.UARM_L] = rx[B.UARM_R] = -2.9 * k;
        rx[B.FARM_L] = rx[B.FARM_R] = -0.5 * k;
        rx[1] = -0.25 * k;
      } else if (a.act === 'recover') {
        const hit = clamp01(a.k * 6);
        const back = clamp01((a.k - 0.4) / 0.6);
        // Arms smash down from overhead, then settle back to the sides.
        rx[B.UARM_L] = rx[B.UARM_R] = (-2.9 + 2.5 * ease(hit)) * (1 - ease(back));
        rx[1] = 0.45 * ease(hit) * (1 - ease(back));
        oy[0] -= 0.12 * ease(hit) * (1 - ease(back));
      }
    } else if (a.act === 'windup') {
      rx[B.UARM_R] = -0.2 - 2.4 * k;
      rz[B.UARM_R] = -0.08 - 0.35 * k;
      rx[B.FARM_R] = -0.2 - 0.9 * k;
      ry[1] = 0.35 * k;
      rx[B.UARM_L] = -0.6 * k;
      rx[B.FARM_L] = -1.2 * k;
    } else if (a.act === 'lunge') {
      rx[B.UARM_R] = -2.6 + 2.3 * k;
      rz[B.UARM_R] = -0.43 + 0.3 * k;
      rx[B.FARM_R] = -1.1 + 0.9 * k;
      ry[1] = 0.35 - 0.8 * k;
      rx[1] = 0.3 * k;
      rx[B.THIGH_L] = -0.5;
      rx[B.SHIN_L] = 0.4;
      rx[B.THIGH_R] = 0.4;
    } else if (a.act === 'recover') {
      const r = 1 - k;
      rx[B.UARM_R] = -0.3 * r;
      ry[1] = -0.45 * r;
      rx[1] = 0.3 * r;
    }
    if (a.stagger > 0) {
      const st = clamp01(a.stagger * 3);
      rx[1] += -0.35 * st;
      rx[2] += -0.3 * st;
      rz[B.UARM_L] += 0.6 * st;
      rz[B.UARM_R] -= 0.6 * st;
      oz[0] -= 0.06 * st;
    }
    if (dead > 0) {
      const hip = rig.pivot[0][1];
      rx[0] = -1.5 * dead;
      oy[0] += -hip * 0.78 * dead - Math.max(0, a.dead - 0.8) * 1.5;
      rx[B.THIGH_L] += -0.9 * dead;
      rx[B.THIGH_R] += -0.6 * dead;
      rx[B.SHIN_L] += 1.3 * dead;
      rx[B.SHIN_R] += 0.9 * dead;
      rz[B.UARM_L] += 1.1 * dead;
      rz[B.UARM_R] -= 1.1 * dead;
      rx[2] += 0.4 * dead;
    }
  }
  // Hierarchy: root carries the world placement; children follow their parents.
  const S = rig.scale * a.scale;
  const root = trs(x, y, z, Math.PI / 2 - a.yaw, 0, 0, S);
  const local = new Float32Array(16);
  for (let i = 0; i < n; i++) {
    const p = rig.pivot[i];
    trs(p[0] + ox[i], p[1] + oy[i], p[2] + oz[i], ry[i], rx[i], rz[i], sc[i], local);
    const par = rig.parent[i];
    const parent = par < 0 ? root : out.subarray(par * 16, par * 16 + 16);
    mul(parent, local, out.subarray(i * 16, i * 16 + 16));
  }
  return n;
}

// ---------------------------------------------------------------------------
// First-person viewmodels (camera space: +X right, +Y up, -Z forward)
// ---------------------------------------------------------------------------

/**
 * Viewmodel forearm: sleeve, brass bracer and gloved hand.
 * @param {Mesh} m @param {Mat} sleeve @param {number} [curl] 0 open .. 1 fist @param {boolean} [left]
 */
function arm(m, sleeve, curl = 0.95, left = false) {
  // Sleeve and cuff from the wrist back past the camera, then the gloved hand (fingers forward).
  const sx = left ? -1 : 1;
  m.sweep([[0, 0.0, 0.02], [sx * 0.025, -0.06, 0.18], [sx * 0.07, -0.15, 0.4]], [[0.036, 0.034], [0.046, 0.044], [0.058, 0.056]], 20, sleeve, { cap0: true, smooth: 1 });
  m.loft([[-0.012, 0.04, 0.038], [0.025, 0.043, 0.041]], 18, M.brassTex);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.043, 0.006, Math.sin(a) * 0.041).sphere(0.004, 5, M.brass).pop();
  }
  m.push().at(0, 0.0, 0.0, 0, Math.PI / 2);
  hand(m, M.leatherDark, curl, left ? 1 : -1);
  m.pop();
}

/** @type {Record<string, (m: Mesh) => void>} */
const VIEWMODELS = {
  fork(m) {
    arm(m, mat('#5a2a26', 0.85));
    m.push().at(0.018, -0.008, -0.05, 0, -1.2);
    // Leather-wrapped grip with ridged turns, a brass guard and a crystal-core pommel.
    m.sweep([[0, -0.08, 0], [0, 0.07, 0]], [0.019, 0.019], 16, M.leather, { disp: (_x, y) => 0.0018 * Math.sin(y * 260) });
    m.push().at(0, -0.1, 0).lathe([[0, -0.03], [0.022, -0.012], [0.024, 0.0], [0.018, 0.012]], 16, M.brass).pop();
    m.push().at(0, -0.118, 0).lathe([[0, -0.03], [0.016, 0], [0, 0.03]], 6, mat('#5fe0ff', 0.12, 0, 2.2), { flat: true }).pop();
    m.loft([[0.07, 0.03, 0.022], [0.09, 0.05, 0.026], [0.115, 0.052, 0.024], [0.135, 0.046, 0.018]], 20, M.brassTex, { cap0: true, cap1: true, disp: rough(30, 0.0008, 12) });
    m.loft([[0.1, 0.054, 0.027], [0.106, 0.054, 0.027]], 20, M.bronze);
    for (const x of [-0.031, 0.031]) {
      m.push().at(x, 0.13, 0).loft([[0, 0.012, 0.011], [0.18, 0.01, 0.009], [0.33, 0.008, 0.007], [0.36, 0.004, 0.004]], 6, M.steel, { cap0: true, cap1: true, flat: true }).pop();
      m.push().at(x, 0.15, 0.011).box(0.003, 0.15, 0.0015, 0.001, M.ley).pop();
    }
    m.pop();
  },
  scatter(m) {
    arm(m, mat('#5a2a26', 0.85));
    m.push().at(-0.02, 0.045, -0.12, 0, -Math.PI / 2);
    // Beveled brass chamber with banded rings, flared muzzle and a glowing crystal core.
    m.lathe([[0.03, -0.14], [0.036, -0.12], [0.038, 0.0], [0.034, 0.12], [0.036, 0.2], [0.05, 0.28], [0.072, 0.35], [0.068, 0.365], [0.05, 0.37]], 24, M.brassTex, { disp: rough(25, 0.0008, 3) });
    for (const y of [-0.1, 0.02, 0.14, 0.24]) m.push().at(0, y, 0).torus(0.039, 0.006, 24, 6, M.bronze).pop();
    m.push().at(0, 0.0, 0).lathe([[0.055, -0.06], [0.06, -0.04], [0.06, 0.05], [0.055, 0.07]], 24, M.iron).pop();
    m.push().at(0, 0.0, 0.05).lathe([[0, -0.045], [0.026, 0], [0, 0.055]], 6, M.crystal, { flat: true }).pop();
    m.pop();
    m.sweep([[-0.01, -0.01, -0.02], [-0.012, -0.05, 0.06], [-0.01, -0.07, 0.16]], [[0.024, 0.04], [0.026, 0.05], [0.028, 0.055]], 14, M.wood, { cap1: true, disp: rough(40, 0.001, 4, { stretch: 3 }) });
  },
  crossbow(m) {
    arm(m, mat('#5a2a26', 0.85));
    m.sweep([[-0.02, 0.03, 0.02], [-0.02, 0.035, -0.2], [-0.02, 0.04, -0.48]], [[0.022, 0.028], [0.02, 0.026], [0.018, 0.022]], 12, M.wood, { cap0: true, cap1: true });
    for (const s of [-1, 1]) {
      m.sweep([[-0.02, 0.05, -0.47], [-0.02 + s * 0.14, 0.05, -0.47], [-0.02 + s * 0.26, 0.05, -0.38]], [0.016, 0.012, 0.007], 10, M.iron, { cap1: true });
      m.sweep([[-0.02 + s * 0.26, 0.05, -0.38], [-0.02, 0.06, -0.25]], [0.003, 0.003], 4, M.rope);
    }
    m.sweep([[-0.02, 0.07, -0.24], [-0.02, 0.07, -0.55]], [0.007, 0.007], 6, M.woodLight);
    m.push().at(-0.02, 0.07, -0.57, 0, -Math.PI / 2).lathe([[0.012, 0], [0, 0.04]], 4, M.steel, { flat: true }).pop();
  },
  cast(m) {
    arm(m, mat('#5a2a26', 0.85), 0.25);
    // Gathered ley above the open palm; the renderer brightens it while a spell is cast.
    m.push().at(0.035, 0.03, -0.07).sphere(0.03, 16, mat('#7fe9ff', 0.2, 0, 1.6)).pop();
  },
  lantern(m) {
    arm(m, mat('#4a3a2e', 0.85), 0.95, true);
    m.push().at(-0.02, -0.12, -0.04);
    m.sweep([[0, 0.12, 0], [0, 0.16, 0.0]], [0.004, 0.004], 4, M.iron);
    m.box(0.05, 0.07, 0.05, 0.008, M.glass);
    for (const [x, z] of [[-0.058, -0.058], [0.058, -0.058], [-0.058, 0.058], [0.058, 0.058]]) m.sweep([[x, -0.08, z], [x, 0.08, z]], [0.005, 0.005], 6, M.brass);
    m.push().at(0, 0.085, 0).lathe([[0.075, 0], [0.04, 0.03], [0.012, 0.055], [0, 0.06]], 16, M.brass).pop();
    m.push().at(0, -0.1, 0).lathe([[0.075, 0], [0.075, 0.016]], 16, M.brass, { cap0: true }).pop();
    m.pop();
  },
}

/** @type {Map<string, Mesh>} */
const viewCache = new Map();

/** Mesh for a viewmodel id (fork, scatter, crossbow, cast, lantern). @param {string} id */
export function getViewmodel(id) {
  let m = viewCache.get(id);
  if (!m) {
    m = new Mesh(4096);
    (VIEWMODELS[id] ?? VIEWMODELS.cast)(m);
    finalize(m, { ao: 0.7 });
    viewCache.set(id, m);
  }
  return m;
}
