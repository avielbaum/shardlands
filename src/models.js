/**
 * @file Procedural 3D geometry for the renderer. A mesh builder with smooth (or flat) normals for
 * surfaces of revolution, ellipsoids, rounded boxes, tubes and tori; the prop, foliage, item and
 * architecture library that replaces the old billboard sprites; articulated character rigs posed
 * procedurally each frame (breathing idle, walk stride, weapon swing, stagger, collapse); and the
 * first-person viewmodels. Units are metres, +Y is up and every model faces +Z.
 */
import { hash2, mulberry32, TILE } from './world.js';

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
const shade = (M, k) => ({ ...M, c: M.c.map((v) => Math.min(1, v * k)) });

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
    this.bone = 0;
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
   * @param {{flat?: boolean, flip?: boolean}} [o]
   */
  grid(P, T, mt, wrapU, o = {}) {
    const matOf = typeof mt === 'function' ? mt : () => mt;
    const rows = P.length;
    const cols = P[0].length;
    /** @type {number[][][]} */
    const N = [];
    const sign = o.flip ? -1 : 1;
    for (let j = 0; j < rows; j++) {
      N.push([]);
      for (let i = 0; i < cols; i++) {
        const il = i > 0 ? i - 1 : wrapU ? cols - 2 : 0;
        const ir = i < cols - 1 ? i + 1 : wrapU ? 1 : cols - 1;
        const jd = Math.max(0, j - 1);
        const ju = Math.min(rows - 1, j + 1);
        const du = sub(P[j][ir], P[j][il]);
        const dv = sub(P[ju][i], P[jd][i]);
        let n = cross(dv, du);
        let l = Math.hypot(n[0], n[1], n[2]);
        if (l < 1e-9) {
          // Degenerate row (a pole): borrow the tangent from the neighbouring row.
          const jj = j === 0 ? Math.min(1, rows - 1) : Math.max(0, rows - 2);
          n = cross(sub(P[Math.min(rows - 1, jj + 1)][i], P[Math.max(0, jj - 1)][i]), sub(P[jj][ir], P[jj][il]));
          l = Math.hypot(n[0], n[1], n[2]) || 1;
        }
        N[j].push([(n[0] / l) * sign, (n[1] / l) * sign, (n[2] / l) * sign]);
      }
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
          for (const [jj, ii] of [a, b, c]) this.v(P[jj][ii], fn ?? N[jj][ii], T[jj][ii][0], T[jj][ii][1], matOf(jj));
        }
      }
    }
    return this;
  }

  /**
   * Surface of revolution around +Y. Profile points are [radius, y], bottom to top.
   * grad shades the colour from the first profile row to the last (self-occlusion for foliage).
   * @param {number[][]} prof @param {number} seg @param {Mat} mt
   * @param {{sx?: number, sz?: number, a0?: number, a1?: number, cap0?: boolean, cap1?: boolean, flat?: boolean,
   *   wob?: (x:number, y:number, z:number) => number, grad?: number[]}} [o]
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
    this.grid(P, T, g ? (j) => shade(mt, g[0] + ((g[1] - g[0]) * j) / Math.max(1, prof.length - 1)) : mt, full, { flat: o.flat });
    /** @type {[number, boolean|undefined, number][]} */
    const caps = [[0, o.cap0, -1], [prof.length - 1, o.cap1, 1]];
    for (const [end, on, ny] of caps) {
      if (!on || prof[end][0] < 1e-4) continue;
      const ring = P[end];
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      for (let i = 0; i < seg; i++) {
        const p0 = ring[i];
        const p1 = ring[i + 1];
        this.v([0, cy, 0], [0, ny, 0], 0, 0, mt);
        this.v(p0, [0, ny, 0], p0[0], p0[2], mt);
        this.v(p1, [0, ny, 0], p1[0], p1[2], mt);
      }
    }
    return this;
  }

  /**
   * Ellipsoid centred on the current origin.
   * @param {number} rx @param {number} ry @param {number} rz @param {number} seg @param {number} rings @param {Mat} mt
   * @param {{wob?: (x:number, y:number, z:number) => number, v0?: number, v1?: number, a0?: number, a1?: number, grad?: number[]}} [o]
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
    return this.lathe(prof, seg, mt, { sx: rx, sz: rz, wob: o.wob, a0: o.a0, a1: o.a1, grad: o.grad });
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
  let cur = p;
  let d = dir;
  const segs = depth > 1 ? 3 : 2;
  for (let s = 0; s < segs; s++) {
    d = norm([d[0] + (rnd() - 0.5) * 0.35, d[1] + 0.06, d[2] + (rnd() - 0.5) * 0.35]);
    const nx = [cur[0] + d[0] * (len / segs), cur[1] + d[1] * (len / segs), cur[2] + d[2] * (len / segs)];
    const r1 = r * (1 - (0.45 * (s + 1)) / segs);
    m.sw = Math.max(0, (cur[1] - 1.2) * 0.04);
    m.tube(cur, nx, r * (1 - (0.45 * s) / segs), r1, depth > 1 ? 7 : 5, barkM);
    cur = nx;
  }
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
    m.ellipsoid(s, s * 0.68, s * 0.9, 8, 5, shade(mats[k % mats.length], tone), { wob: lumpy(4.2, 0.42, Math.floor(rnd() * 999)), grad: [0.45, 1.05] });
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
  // Flared, root-buttressed trunk.
  m.lathe([[0.42, -0.2], [0.34, 0.05], [0.24, 0.4], [0.21, 1.2], [0.19, 1.9]], 9, M.bark, { wob: lumpy(3, 0.12, 5) });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + rnd();
    m.tube([Math.cos(a) * 0.15, 0.25, Math.sin(a) * 0.15], [Math.cos(a) * 0.6, -0.1, Math.sin(a) * 0.6], 0.11, 0.04, 5, M.barkDark);
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rnd() * 0.8;
    branch(m, rnd, [0, 1.8, 0], norm([Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6]), 1.5 + rnd() * 0.4, 0.15, 1, leaf, M.bark);
  }
  leaf(m, [0, 3.6, 0], 1.4);
}

/** Conifer, ~5.6 m. @param {Mesh} m @param {() => number} rnd */
function buildPine(m, rnd) {
  m.lathe([[0.26, -0.1], [0.2, 0.3], [0.08, 5.4]], 8, M.barkDark, { wob: lumpy(4, 0.1, 3) });
  m.sw = 0;
  // Ragged, drooping skirts of needles, darker toward their undersides and slightly askew.
  for (let k = 0; k < 7; k++) {
    const y = 0.9 + k * 0.62;
    const r = (1.6 - k * 0.2) * (0.85 + rnd() * 0.3);
    m.swY = 0.06;
    m.push().at(0, y, 0, rnd() * 6, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12);
    m.lathe([[0.15, 0.1], [r * 0.85, -0.25], [r, -0.12], [r * 0.5, 0.45], [0.05, 0.95]], 11,
      shade(M.pine, 0.8 + rnd() * 0.3), { wob: lumpy(3.4, 0.38, k * 7 + Math.floor(rnd() * 99)), grad: [0.4, 1.05] });
    m.pop();
  }
  m.swY = 0;
}

/** Bare, twisted dead tree, ~3.8 m. @param {Mesh} m @param {() => number} rnd */
function buildDeadTree(m, rnd) {
  m.lathe([[0.3, -0.15], [0.22, 0.25], [0.15, 1.6]], 8, M.barkPale, { wob: lumpy(3.5, 0.18, 11) });
  const none = () => {};
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + rnd();
    branch(m, rnd, [0, 1.5, 0], norm([Math.cos(a) * 0.8, 1, Math.sin(a) * 0.8]), 1.2 + rnd() * 0.5, 0.11, 2, none, M.barkPale);
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
  m.push().at(0, 0.15, 0, rnd() * 6);
  m.ellipsoid(0.75, 0.55, 0.62, 12, 8, M.stoneCliff, { wob: lumpy(1.8, 0.32, s) });
  m.pop();
  if (rnd() < 0.7) m.push().at(0.6, 0.02, 0.35, rnd() * 6).ellipsoid(0.26, 0.17, 0.22, 8, 5, M.stoneCliff, { wob: lumpy(3, 0.3, s + 1) }).pop();
}

/** Broken colonnade fragment, ~2.6 m. @param {Mesh} m @param {() => number} rnd */
function buildRuin(m, rnd) {
  m.push().at(0, 0.12, 0).box(0.55, 0.12, 0.55, 0.05, M.stone).pop();
  const h = 1.5 + rnd() * 0.9;
  const seed = Math.floor(rnd() * 99);
  // Fluted shaft: a wobbly-topped lathe whose fluting comes from a cosine wobble.
  m.push().at(0, 0.24, 0);
  m.lathe([[0.38, 0], [0.33, 0.1], [0.29, 0.25], [0.27, h * 0.5], [0.25, h]], 16, M.stone,
    { wob: (x, y, z) => 1 + Math.cos(Math.atan2(z, x) * 12) * 0.035 + (y > h * 0.85 ? (noise3(x * 6, 0, z * 6, seed) - 0.5) * 0.3 : 0), cap1: true });
  m.pop();
  // Fallen capital and a drum.
  m.push().at(0.9, 0.17, 0.4, rnd() * 3, 0.2);
  m.box(0.36, 0.08, 0.36, 0.03, M.stone);
  m.at(0, -0.17, 0).lathe([[0.22, 0], [0.34, 0.09], [0.3, 0.1]], 14, M.stone);
  m.pop();
  m.push().at(-0.8, 0.25, -0.3, rnd() * 3, 0, 1.45).lathe([[0.27, -0.3], [0.27, 0.3]], 14, M.stone, { cap0: true, cap1: true }).pop();
  for (let k = 0; k < 4; k++) m.push().at((rnd() - 0.5) * 2, 0.05, (rnd() - 0.5) * 2, rnd() * 6).box(0.1 + rnd() * 0.1, 0.07, 0.09, 0.03, M.stone).pop();
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
export function buildModel(name, variant = 0, far = false) {
  const m = new Mesh(2048);
  const rnd = mulberry32(1000 + variant * 7919 + name.length * 31);
  DETAIL = far ? 0.5 : 1;
  try {
    if (PROPS[name]) PROPS[name].b(m, rnd);
    else if (name.startsWith('rune_')) buildRune(m, name.slice(5));
    else buildItem(m, name);
  } finally {
    DETAIL = 1;
  }
  return m;
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
 */

/** Humanoid skeleton: hips, torso, head, L arm (2), R arm (2), L leg (2), R leg (2), cloak. */
const HUMAN_PARENT = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9, 1];
const HUMAN_PIVOT = [[0, 0.95, 0], [0, 0.06, 0], [0, 0.52, 0.01], [0.2, 0.46, 0], [0, -0.29, 0], [-0.2, 0.46, 0], [0, -0.29, 0], [0.095, -0.02, 0], [0, -0.44, 0], [-0.095, -0.02, 0], [0, -0.44, 0], [0, 0.48, -0.11]];
const B = { HIPS: 0, TORSO: 1, HEAD: 2, UARM_L: 3, FARM_L: 4, UARM_R: 5, FARM_R: 6, THIGH_L: 7, SHIN_L: 8, THIGH_R: 9, SHIN_R: 10, CLOAK: 11 };

/**
 * @typedef {Object} Outfit
 * @property {Mat} skin
 * @property {Mat} top tunic/coat
 * @property {Mat} legs
 * @property {Mat} boots
 * @property {Mat} [hair]
 * @property {'cap'|'scarf'|'hood'|'helm'|'goggles'|null} [hat]
 * @property {Mat} [hatM]
 * @property {Mat} [cloak]
 * @property {Mat} [robe] long skirt from the waist
 * @property {Mat} [apron]
 * @property {Mat} [armor] cuirass and pauldrons
 * @property {boolean} [beard]
 * @property {'spear'|'sword'|'staff'|'hammer'|'book'|null} [held]
 * @property {Mat} [glove]
 * @property {Mat} [glow] emissive accent (lenses, gauntlet)
 */

/** @param {Mesh} m @param {Outfit} o */
function buildHuman(m, o) {
  const glove = o.glove ?? o.skin;
  // Hips and belt.
  m.bone = B.HIPS;
  m.push().at(0, 0.02, 0).box(0.16, 0.1, 0.1, 0.06, o.legs).pop();
  m.push().at(0, 0.09, 0).lathe([[0.175, -0.025], [0.178, 0.025]], 14, M.leatherDark, { sz: 0.66 }).pop();
  m.push().at(0.1, 0.09, 0.11).box(0.03, 0.025, 0.008, 0.005, M.brass).pop();
  if (o.robe) m.lathe([[0.31, -0.86], [0.26, -0.45], [0.2, -0.1], [0.18, 0.1]], 16, o.robe, { sz: 0.78 });
  if (o.apron) m.push().at(0, -0.22, 0.13, 0, 0.05).box(0.15, 0.3, 0.01, 0.008, o.apron).pop();
  // Torso: tapered lathe with an oval section, neck.
  m.bone = B.TORSO;
  m.lathe([[0.15, -0.02], [0.16, 0.12], [0.18, 0.3], [0.19, 0.4], [0.15, 0.49], [0.06, 0.54]], 16, o.top, { sz: 0.64, cap0: true });
  m.tube([0, 0.48, 0.005], [0, 0.6, 0.01], 0.05, 0.048, 8, o.skin);
  if (o.apron) m.push().at(0, 0.18, 0.11, 0, -0.1).box(0.13, 0.14, 0.008, 0.006, o.apron).pop();
  if (o.armor) {
    m.lathe([[0.17, 0.12], [0.2, 0.28], [0.205, 0.4], [0.16, 0.48]], 16, o.armor, { sz: 0.7 });
    for (const x of [-0.2, 0.2]) m.push().at(x, 0.48, 0, 0, 0, x > 0 ? -0.35 : 0.35).ellipsoid(0.1, 0.07, 0.1, 10, 5, o.armor, { v0: 0 }).pop();
  }
  // Head.
  m.bone = B.HEAD;
  m.push().at(0, 0.14, 0.01);
  m.ellipsoid(0.092, 0.115, 0.102, 14, 9, o.skin);
  m.push().at(0, -0.005, 0.1).ellipsoid(0.018, 0.028, 0.02, 6, 4, o.skin).pop();
  for (const x of [-0.035, 0.035]) m.push().at(x, 0.02, 0.088).ellipsoid(0.014, 0.01, 0.008, 6, 4, mat('#1c1a18', 0.3)).pop();
  if (o.beard) m.push().at(0, -0.07, 0.06).ellipsoid(0.075, 0.07, 0.06, 10, 6, o.hair ?? M.barkDark, { wob: lumpy(30, 0.1, 4) }).pop();
  if (o.hair && o.hat !== 'hood' && o.hat !== 'helm') m.push().at(0, 0.03, -0.018).ellipsoid(0.1, 0.1, 0.105, 12, 7, o.hair, { v0: -0.2 }).pop();
  const hatM = o.hatM ?? o.top;
  if (o.hat === 'cap') m.push().at(0, 0.075, -0.005).ellipsoid(0.105, 0.06, 0.112, 12, 5, hatM, { v0: 0 }).at(0, 0, 0.09).box(0.07, 0.008, 0.04, 0.006, hatM).pop();
  else if (o.hat === 'scarf') m.push().at(0, 0.04, -0.01).ellipsoid(0.103, 0.1, 0.11, 12, 6, hatM, { v0: -0.1, a0: Math.PI / 2 + 0.9, a1: Math.PI * 2.5 - 0.9 }).pop();
  else if (o.hat === 'hood') {
    m.push().at(0, -0.02, -0.02).ellipsoid(0.135, 0.165, 0.14, 14, 8, hatM, { v0: -0.6, a0: Math.PI / 2 + 0.75, a1: Math.PI * 2.5 - 0.75 }).pop();
  } else if (o.hat === 'helm') {
    m.push().at(0, 0.03, 0).lathe([[0.115, -0.04], [0.12, 0.02], [0.1, 0.08], [0.06, 0.12], [0, 0.135]], 14, o.armor ?? M.steel).pop();
    m.push().at(0, -0.01, 0).lathe([[0.17, 0], [0.12, 0.02]], 14, o.armor ?? M.steel).pop();
  } else if (o.hat === 'goggles') {
    m.push().at(0, 0.06, 0).lathe([[0.104, -0.012], [0.104, 0.012]], 14, M.leatherDark, { sz: 1.08 }).pop();
    for (const x of [-0.04, 0.04]) m.push().at(x, 0.065, 0.1, 0, Math.PI / 2).lathe([[0.03, -0.012], [0.03, 0.012]], 10, M.brass, { cap1: true }).at(0, 0.014, 0).lathe([[0.022, 0], [0, 0.001]], 10, o.glow ?? M.ley).pop();
  }
  m.pop();
  // Arms: sleeve, shoulder, forearm, hand.
  for (const [ub, fb] of [[B.UARM_L, B.FARM_L], [B.UARM_R, B.FARM_R]]) {
    m.bone = ub;
    m.sphere(0.068, 9, o.top);
    m.lathe([[0.052, -0.3], [0.058, -0.2], [0.065, -0.05], [0.06, 0.02]], 10, o.top);
    m.bone = fb;
    m.lathe([[0.04, -0.25], [0.048, -0.15], [0.054, 0.0], [0.05, 0.03]], 10, fb === B.FARM_R && o.glow && o.hat === 'goggles' ? M.brassTex : o.top);
    m.push().at(0, -0.3, 0.005).ellipsoid(0.038, 0.055, 0.03, 8, 6, glove).pop();
  }
  // Legs and boots.
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.lathe([[0.065, -0.44], [0.08, -0.25], [0.088, -0.05], [0.085, 0.03]], 10, o.legs);
    m.bone = sb;
    m.lathe([[0.05, -0.42], [0.06, -0.3], [0.064, -0.15], [0.062, 0.02]], 10, o.legs);
    m.lathe([[0.058, -0.445], [0.062, -0.3], [0.067, -0.2]], 10, o.boots, { cap0: true });
    m.push().at(0, -0.45, 0.04).box(0.05, 0.03, 0.105, 0.025, o.boots).pop();
  }
  // Cloak.
  if (o.cloak) {
    m.bone = B.CLOAK;
    m.lathe([[0.33, -1.02], [0.27, -0.6], [0.2, -0.15], [0.14, 0.02]], 12, o.cloak, { sz: 0.7, a0: Math.PI + 0.25, a1: Math.PI * 2 - 0.25 });
  }
  // Held item in the right hand: built pointing forward along +Z from the grip.
  m.bone = B.FARM_R;
  m.push().at(0, -0.31, 0.01);
  if (o.held === 'spear') {
    m.tube([0, -0.9, 0], [0, 1.0, 0], 0.018, 0.016, 6, M.wood);
    m.push().at(0, 1.08, 0).lathe([[0.02, -0.08], [0.04, 0], [0, 0.2]], 4, M.steel, { flat: true }).pop();
  } else if (o.held === 'sword') {
    m.push().at(0, 0, 0, 0, Math.PI / 2);
    m.tube([0, -0.08, 0], [0, 0.05, 0], 0.018, 0.018, 6, M.leather);
    m.push().at(0, 0.05, 0).box(0.09, 0.012, 0.02, 0.006, M.brass).pop();
    m.push().at(0, 0.42, 0).box(0.025, 0.37, 0.006, 0.004, M.steel).pop();
    m.pop();
  } else if (o.held === 'staff') {
    m.tube([0, -0.75, 0], [0, 0.95, 0], 0.02, 0.025, 6, M.woodDark);
    m.push().at(0, 1.02, 0).sphere(0.05, 8, o.glow ?? M.ley).pop();
  } else if (o.held === 'hammer') {
    m.push().at(0, 0, 0, 0, Math.PI / 2).tube([0, -0.05, 0], [0, 0.45, 0], 0.016, 0.016, 6, M.wood).at(0, 0.48, 0).box(0.06, 0.04, 0.04, 0.012, M.iron).pop();
  } else if (o.held === 'book') {
    m.push().at(0, 0.02, 0.05, 0, -0.6).box(0.09, 0.02, 0.12, 0.01, mat('#4e2a3a', 0.7)).pop();
  }
  m.pop();
}

/** @param {Mesh} m Clockwork Sentinel (and Brass Mite): brass automaton with blade arms and a ley visor. */
function buildSentinel(m) {
  const plate = M.brassTex;
  m.bone = B.HIPS;
  m.lathe([[0.12, -0.08], [0.17, 0], [0.16, 0.1], [0.1, 0.14]], 12, M.iron, { cap0: true });
  m.push().at(0, 0.02, 0, 0, Math.PI / 2).torus(0.11, 0.025, 12, 4, M.brass).pop();
  m.bone = B.TORSO;
  m.lathe([[0.1, 0], [0.18, 0.12], [0.23, 0.3], [0.22, 0.44], [0.12, 0.54]], 14, plate, { sz: 0.75, cap0: true, cap1: true });
  m.push().at(0, 0.3, 0.16, 0, Math.PI / 2).lathe([[0.07, 0], [0.07, 0.03]], 12, M.iron, { cap1: true }).at(0, 0.031, 0).lathe([[0.05, 0], [0, 0.01]], 12, M.ley).pop();
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    m.push().at(Math.cos(a) * 0.235, 0.36, Math.sin(a) * 0.235 * 0.75).sphere(0.012, 5, M.brass).pop();
  }
  for (const x of [-0.22, 0.22]) m.push().at(x, 0.46, 0, 0, 0, x > 0 ? -0.4 : 0.4).ellipsoid(0.12, 0.08, 0.11, 10, 5, plate, { v0: 0 }).pop();
  m.bone = B.HEAD;
  m.push().at(0, 0.1, 0);
  m.lathe([[0.1, -0.06], [0.11, 0.02], [0.09, 0.1], [0.04, 0.15], [0, 0.16]], 12, plate);
  m.push().at(0, 0.02, 0.095).box(0.075, 0.014, 0.02, 0.008, M.ley).pop();
  m.push().at(0, 0.17, 0).lathe([[0.012, 0], [0.008, 0.12]], 5, M.iron).at(0, 0.12, 0).sphere(0.02, 6, M.leySoft).pop();
  m.pop();
  for (const [ub, fb] of [[B.UARM_L, B.FARM_L], [B.UARM_R, B.FARM_R]]) {
    m.bone = ub;
    m.sphere(0.07, 8, M.brass);
    m.tube([0, 0, 0], [0, -0.28, 0], 0.035, 0.03, 7, M.iron);
    m.tube([0.045, -0.02, 0], [0.045, -0.25, 0], 0.012, 0.012, 5, M.steel);
    m.bone = fb;
    m.sphere(0.05, 7, M.brass);
    m.lathe([[0.035, -0.25], [0.05, -0.12], [0.045, 0]], 8, plate);
    // Forearm blade sweeping forward from the wrist.
    m.push().at(0, -0.27, 0.05, 0, 0.35).box(0.008, 0.035, 0.32, 0.006, M.steel).at(0, -0.03, 0).box(0.01, 0.004, 0.31, 0.003, M.ley).pop();
  }
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.sphere(0.06, 7, M.brass);
    m.lathe([[0.04, -0.44], [0.065, -0.2], [0.07, 0]], 8, plate);
    m.bone = sb;
    m.sphere(0.05, 7, M.brass);
    m.tube([0, 0, 0], [0, -0.42, 0], 0.035, 0.03, 7, M.iron);
    m.push().at(0, -0.46, 0.05).box(0.06, 0.025, 0.12, 0.02, plate).pop();
  }
}

/** @param {Mesh} m Basalt Warden: a hulking stone construct with ember seams. */
function buildGolem(m) {
  const rock = M.basalt;
  const seam = mat('#ff8a3a', 0.6, 0, 3.5);
  const w = lumpy(3, 0.12, 21);
  m.bone = B.HIPS;
  m.push().at(0, 0, 0).box(0.32, 0.18, 0.22, 0.1, rock).pop();
  m.bone = B.TORSO;
  m.push().at(0, 0.42, 0).ellipsoid(0.5, 0.42, 0.34, 14, 9, rock, { wob: w }).pop();
  for (let k = 0; k < 3; k++) m.push().at(-0.12 + k * 0.12, 0.45 + (k % 2) * 0.1, 0.33, 0, 0, 0.6 * (k - 1)).box(0.012, 0.13, 0.01, 0.005, seam).pop();
  for (const x of [-0.45, 0.45]) m.push().at(x, 0.68, 0).ellipsoid(0.24, 0.2, 0.24, 10, 7, rock, { wob: lumpy(4, 0.18, x > 0 ? 3 : 4) }).pop();
  m.bone = B.HEAD;
  m.push().at(0, 0.12, 0.06).box(0.15, 0.13, 0.15, 0.06, rock).pop();
  for (const x of [-0.06, 0.06]) m.push().at(x, 0.14, 0.205).ellipsoid(0.025, 0.014, 0.01, 6, 4, seam).pop();
  for (const [ub, fb] of [[B.UARM_L, B.FARM_L], [B.UARM_R, B.FARM_R]]) {
    m.bone = ub;
    m.push().at(0, -0.2, 0).ellipsoid(0.16, 0.26, 0.16, 10, 7, rock, { wob: lumpy(5, 0.15, ub) }).pop();
    m.bone = fb;
    m.push().at(0, -0.18, 0).ellipsoid(0.15, 0.25, 0.15, 10, 7, rock, { wob: lumpy(5, 0.15, fb) }).pop();
    m.push().at(0, -0.48, 0.02).box(0.17, 0.15, 0.17, 0.08, rock).pop();
    m.push().at(0, -0.3, 0.15).box(0.08, 0.01, 0.006, 0.004, seam).pop();
  }
  for (const [tb, sb] of [[B.THIGH_L, B.SHIN_L], [B.THIGH_R, B.SHIN_R]]) {
    m.bone = tb;
    m.push().at(0, -0.2, 0).ellipsoid(0.15, 0.25, 0.15, 9, 6, rock, { wob: lumpy(5, 0.12, tb) }).pop();
    m.bone = sb;
    m.push().at(0, -0.22, 0).box(0.14, 0.22, 0.15, 0.07, rock).pop();
    m.push().at(0, -0.44, 0.06).box(0.17, 0.06, 0.22, 0.05, rock).pop();
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

/** Outfits per NPC sprite name. */
const SKIN = [mat('#c8a084', 0.6), mat('#a77b5f', 0.6), mat('#7d5641', 0.6), mat('#dcb79b', 0.6)];
/** @type {Record<string, Outfit>} */
const OUTFITS = {
  folk_a: { skin: SKIN[0], top: mat('#5f6a4e', 0.9), legs: mat('#4a3e33', 0.9), boots: M.leather, hair: mat('#4a3426', 0.85), hat: 'cap', hatM: mat('#6a5a44', 0.9), held: null },
  folk_b: { skin: SKIN[3], top: mat('#7a4a40', 0.9), legs: mat('#4e3f3a', 0.9), boots: M.leatherDark, robe: mat('#6e4a42', 0.9), hat: 'scarf', hatM: mat('#b3a385', 0.9), apron: mat('#b8aa90', 0.92), held: null },
  folk_c: { skin: SKIN[1], top: mat('#4e5a66', 0.9), legs: mat('#3e3a36', 0.9), boots: M.leather, hair: mat('#6e5a48', 0.85), beard: true, hat: 'hood', hatM: mat('#55524a', 0.92), held: null },
  merchant: { skin: SKIN[0], top: mat('#8a7342', 0.85), legs: mat('#4b3c2e', 0.9), boots: M.leatherDark, hair: mat('#2e231c', 0.85), apron: M.leather, hat: 'cap', hatM: mat('#4a3a2a', 0.85), held: null },
  guard: { skin: SKIN[1], top: mat('#5a4e3e', 0.9), legs: mat('#3d3833', 0.9), boots: M.leatherDark, armor: M.steel, hat: 'helm', cloak: mat('#5e3430', 0.92), held: 'spear', glove: M.leatherDark },
  master: { skin: SKIN[0], top: mat('#3a3330', 0.8), legs: mat('#2f2a26', 0.85), boots: M.leatherDark, hair: mat('#9a9288', 0.8), beard: true, robe: mat('#3a3330', 0.8), hat: 'goggles', glow: M.ley, glove: M.brass, held: 'hammer' },
  keeper: { skin: SKIN[2], top: mat('#7d6e58', 0.9), legs: mat('#3e3630', 0.9), boots: M.leather, hair: mat('#1e1a17', 0.8), hat: 'scarf', hatM: mat('#7a3a2e', 0.9), apron: mat('#c2b59c', 0.92), held: null },
  captain: { skin: SKIN[3], top: mat('#3e4a3c', 0.85), legs: mat('#2e2f2a', 0.9), boots: M.leatherDark, hair: mat('#7a4a2c', 0.85), armor: M.steel, cloak: mat('#3a4a3a', 0.9), held: 'sword', glove: M.leatherDark },
  archivist: { skin: SKIN[0], top: mat('#4a3a4e', 0.85), legs: mat('#3a2e3c', 0.9), boots: M.leatherDark, robe: mat('#4a3a4e', 0.85), hat: 'hood', hatM: mat('#3e3042', 0.85), held: 'book', glow: M.leySoft },
};

/** @type {Map<string, Rig>} */
const rigCache = new Map();

/** Rig for a character sprite base name (NPC sprite or enemy kind). @param {string} name @returns {Rig} */
export function getRig(name) {
  let r = rigCache.get(name);
  if (r) return r;
  const m = new Mesh(8192);
  if (name === 'wisp') {
    buildWisp(m);
    r = { parent: WISP_PARENT, pivot: WISP_PIVOT, mesh: m, kind: 'wisp', scale: 1 };
  } else if (name === 'golem') {
    buildGolem(m);
    r = { parent: HUMAN_PARENT, pivot: GOLEM_PIVOT, mesh: m, kind: 'golem', scale: 1.25 };
  } else if (name === 'sentinel') {
    buildSentinel(m);
    r = { parent: HUMAN_PARENT, pivot: HUMAN_PIVOT, mesh: m, kind: 'human', scale: 1.1 };
  } else {
    buildHuman(m, OUTFITS[name] ?? OUTFITS.folk_a);
    r = { parent: HUMAN_PARENT, pivot: HUMAN_PIVOT, mesh: m, kind: 'human', scale: 1 };
  }
  rigCache.set(name, r);
  return r;
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
    oy[0] = -Math.abs(Math.cos(ph)) * 0.035 * w + breath * 0.004;
    ry[0] = s * 0.08 * w;
    rx[1] = 0.05 * w + breath * 0.015;
    ry[1] = -s * 0.12 * w;
    sc[1] = 1 + breath * 0.008;
    ry[2] = Math.sin(t * 0.37) * 0.25 * (1 - w) * (golem ? 0.3 : 1);
    rx[2] = Math.sin(t * 0.23) * 0.05 - 0.03 * w;
    rx[B.THIGH_L] = -s * stride * w;
    rx[B.THIGH_R] = s * stride * w;
    rx[B.SHIN_L] = w * (0.1 + 0.75 * Math.max(0, Math.sin(ph + 1.7)));
    rx[B.SHIN_R] = w * (0.1 + 0.75 * Math.max(0, Math.sin(ph + 1.7 + Math.PI)));
    rx[B.UARM_L] = s * 0.45 * w + breath * 0.02;
    rx[B.UARM_R] = -s * 0.45 * w - breath * 0.02;
    rz[B.UARM_L] = golem ? 0.18 : 0.08;
    rz[B.UARM_R] = golem ? -0.18 : -0.08;
    rx[B.FARM_L] = -0.18 - 0.25 * w * Math.max(0, -s);
    rx[B.FARM_R] = -0.18 - 0.25 * w * Math.max(0, s);
    rx[B.CLOAK] = 0.08 + w * 0.25 + Math.sin(t * 1.3) * 0.03;
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

/** @param {Mesh} m @param {Mat} sleeve */
function arm(m, sleeve) {
  m.tube([0.06, -0.12, 0.32], [0, 0, 0.02], 0.055, 0.045, 10, sleeve);
  m.push().at(0.065, -0.135, 0.34).torus(0.05, 0.012, 12, 4, M.brass).pop();
  m.push().at(0, 0.0, 0.0).ellipsoid(0.05, 0.045, 0.06, 10, 7, M.leatherDark).pop();
}

/** @type {Record<string, (m: Mesh) => void>} */
const VIEWMODELS = {
  fork(m) {
    const sleeve = mat('#5a2a26', 0.85);
    arm(m, sleeve);
    m.push().at(0, 0.0, -0.02, 0, -1.2);
    m.tube([0, -0.06, 0], [0, 0.07, 0], 0.022, 0.022, 8, M.leather);
    m.push().at(0, -0.08, 0).sphere(0.03, 8, mat('#3fbfd6', 0.15, 0, 1.2)).pop();
    m.push().at(0, 0.09, 0).lathe([[0.03, -0.02], [0.05, 0.02], [0.045, 0.05]], 10, M.brass).pop();
    for (const x of [-0.03, 0.03]) {
      m.push().at(x, 0.36, 0).box(0.011, 0.24, 0.011, 0.006, M.steel).pop();
      m.push().at(x, 0.36, 0.012).box(0.004, 0.22, 0.002, 0.002, M.ley).pop();
    }
    m.push().at(0, 0.13, 0).box(0.045, 0.02, 0.014, 0.008, M.brass).pop();
    m.pop();
  },
  scatter(m) {
    arm(m, mat('#5a2a26', 0.85));
    m.push().at(-0.02, 0.04, -0.12, 0, -Math.PI / 2);
    m.lathe([[0.035, -0.12], [0.034, 0.18], [0.05, 0.3], [0.07, 0.36], [0.065, 0.37]], 14, M.brassTex);
    m.push().at(0, 0.02, 0).lathe([[0.05, -0.05], [0.055, 0.05]], 12, M.iron).pop();
    m.push().at(0, 0.05, 0.05).lathe([[0, -0.04], [0.03, 0], [0, 0.05]], 6, M.crystal, { flat: true }).pop();
    m.pop();
    m.push().at(-0.01, -0.02, 0.06, 0, 0.3).box(0.025, 0.06, 0.12, 0.02, M.wood).pop();
  },
  crossbow(m) {
    arm(m, mat('#5a2a26', 0.85));
    m.push().at(-0.02, 0.03, -0.2).box(0.03, 0.03, 0.3, 0.012, M.wood).pop();
    for (const s of [-1, 1]) {
      m.tube([-0.02, 0.05, -0.47], [-0.02 + s * 0.25, 0.05, -0.38], 0.016, 0.009, 6, M.iron);
      m.tube([-0.02 + s * 0.25, 0.05, -0.38], [-0.02, 0.06, -0.25], 0.003, 0.003, 3, M.rope);
    }
    m.tube([-0.02, 0.07, -0.24], [-0.02, 0.07, -0.55], 0.007, 0.007, 4, M.woodLight);
    m.push().at(-0.02, 0.07, -0.57, 0, -Math.PI / 2).lathe([[0.012, 0], [0, 0.04]], 4, M.steel).pop();
  },
  cast(m) {
    arm(m, mat('#5a2a26', 0.85));
    for (let k = 0; k < 4; k++) m.tube([-0.03 + k * 0.02, 0.02, -0.03], [-0.035 + k * 0.025, 0.06, -0.08], 0.011, 0.009, 5, M.leatherDark);
    m.push().at(0, 0.02, 0.14).lathe([[0.058, -0.06], [0.06, 0.06]], 12, M.brassTex).pop();
    // Gathered ley in the palm; the renderer brightens it while a spell is cast.
    m.push().at(0, 0.075, -0.06).sphere(0.028, 10, mat('#7fe9ff', 0.2, 0, 1.6)).pop();
  },
  lantern(m) {
    arm(m, mat('#4a3a2e', 0.85));
    m.push().at(0, -0.1, -0.02);
    m.box(0.055, 0.075, 0.055, 0.008, M.glass);
    for (const [x, z] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]]) m.tube([x, -0.08, z], [x, 0.08, z], 0.006, 0.006, 4, M.brass);
    m.at(0, 0.09, 0).lathe([[0.075, 0], [0.02, 0.05], [0, 0.06]], 10, M.brass);
    m.at(0, -0.19, 0).lathe([[0.075, 0], [0.075, 0.015]], 10, M.brass, { cap0: true });
    m.pop();
  },
};

/** @type {Map<string, Mesh>} */
const viewCache = new Map();

/** Mesh for a viewmodel id (fork, scatter, crossbow, cast, lantern). @param {string} id */
export function getViewmodel(id) {
  let m = viewCache.get(id);
  if (!m) {
    m = new Mesh(4096);
    (VIEWMODELS[id] ?? VIEWMODELS.cast)(m);
    viewCache.set(id, m);
  }
  return m;
}
