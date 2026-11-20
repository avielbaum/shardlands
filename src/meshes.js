/**
 * @file Binary glTF 2.0 (.glb) loading for the character base meshes, with no dependencies: a
 * GLB container parser, accessor decoding, node-hierarchy transforms, and normalization of a
 * human base mesh (scaled to a real height, feet on y = 0, centred, turned to face +Z).
 * Works in the browser (fetch) and in node (pass an ArrayBuffer).
 */

/** Human base meshes shipped in /assets, by body type. */
export const BODY_ASSETS = { male: 'assets/man_base_mesh_1k.glb', female: 'assets/female_base_mesh.glb' };
/** Standing heights the base meshes are scaled to, in metres. */
export const BODY_HEIGHT = { male: 1.78, female: 1.66 };

/**
 * @typedef {Object} GlbPrimitive
 * @property {string} name mesh name
 * @property {number} material material index (-1 if none)
 * @property {boolean} blend material is alpha-blended (hair cards, lashes)
 * @property {Float32Array} pos xyz, world space (node transforms applied)
 * @property {Float32Array|null} nrm xyz
 * @property {Float32Array|null} uv
 * @property {Uint32Array} idx triangle indices
 */

/** @type {Record<number, [any, number]>} */
const COMPONENT = {
  5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4],
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Required extensions the loader handles: WebP images decode through createImageBitmap like PNG and JPEG. */
const SUPPORTED_EXTENSIONS = ['EXT_texture_webp'];

/**
 * Split a .glb into its JSON document and binary chunk, validating the container.
 * @param {ArrayBuffer} buf @returns {{json: any, bin: DataView}}
 */
export function parseGLB(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a binary glTF file');
  if (dv.getUint32(4, true) !== 2) throw new Error(`Unsupported glTF version ${dv.getUint32(4, true)}`);
  const total = Math.min(dv.getUint32(8, true), buf.byteLength);
  let off = 12;
  let json = null;
  /** @type {DataView|null} */
  let bin = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (off + 8 + len > total) throw new Error('Truncated glTF chunk');
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)));
    else if (type === 0x004e4942) bin = new DataView(buf, off + 8, len);
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error('glTF is missing its JSON or BIN chunk');
  const unsupported = (json.extensionsRequired ?? []).filter((/** @type {string} */ e) => !SUPPORTED_EXTENSIONS.includes(e));
  if (unsupported.length) throw new Error(`glTF requires unsupported extensions: ${unsupported.join(', ')}`);
  return { json, bin };
}

/**
 * Decode an accessor into a flat Float32Array (or Uint32Array for indices), honouring byte
 * strides and normalized integer components.
 * @param {any} json @param {DataView} bin @param {number} i @param {boolean} [asIndex]
 */
function readAccessor(json, bin, i, asIndex = false) {
  const a = json.accessors[i];
  if (a.sparse) throw new Error('Sparse accessors are not supported');
  const [Arr, size] = COMPONENT[a.componentType] ?? [null, 0];
  const width = WIDTH[/** @type {keyof typeof WIDTH} */ (a.type)];
  if (!Arr || !width) throw new Error(`Unsupported accessor ${a.componentType}/${a.type}`);
  const out = asIndex ? new Uint32Array(a.count * width) : new Float32Array(a.count * width);
  if (a.bufferView === undefined) return out;
  const bv = json.bufferViews[a.bufferView];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride || size * width;
  const norm = a.normalized && !asIndex ? 2 ** (size * 8 - (Arr === Int8Array || Arr === Int16Array ? 1 : 0)) - 1 : 0;
  for (let e = 0; e < a.count; e++) {
    for (let c = 0; c < width; c++) {
      const o = base + e * stride + c * size;
      let v;
      switch (a.componentType) {
        case 5126: v = bin.getFloat32(o, true); break;
        case 5125: v = bin.getUint32(o, true); break;
        case 5123: v = bin.getUint16(o, true); break;
        case 5122: v = bin.getInt16(o, true); break;
        case 5121: v = bin.getUint8(o); break;
        default: v = bin.getInt8(o);
      }
      out[e * width + c] = norm ? Math.max(v / norm, -1) : v;
    }
  }
  return out;
}

/** Column-major 4x4 multiply. @param {Float64Array} a @param {Float64Array} b */
function mul4(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/** A node's local matrix from `matrix` or translation/rotation(quaternion)/scale. @param {any} n */
function nodeMatrix(n) {
  if (n.matrix) return Float64Array.from(n.matrix);
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/**
 * Every triangle primitive in the default scene, transformed by its node hierarchy (normals by
 * the inverse transpose), with indices (generated for non-indexed primitives).
 * @param {ArrayBuffer} buf @returns {GlbPrimitive[]}
 */
export function loadGLB(buf) {
  const { json, bin } = parseGLB(buf);
  /** @type {GlbPrimitive[]} */
  const out = [];
  const scene = json.scenes?.[json.scene ?? 0] ?? { nodes: (json.nodes ?? []).map((/** @type {any} */ _, /** @type {number} */ i) => i) };
  /** @param {number} ni @param {Float64Array} parent */
  const visit = (ni, parent) => {
    const node = json.nodes[ni];
    const M = mul4(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      // Normal matrix: inverse transpose of the upper 3x3.
      const a = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
      const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[3] * (a[1] * a[8] - a[2] * a[7]) + a[6] * (a[1] * a[5] - a[2] * a[4]);
      const inv = det ? 1 / det : 0;
      const Nm = [
        (a[4] * a[8] - a[5] * a[7]) * inv, (a[5] * a[6] - a[3] * a[8]) * inv, (a[3] * a[7] - a[4] * a[6]) * inv,
        (a[2] * a[7] - a[1] * a[8]) * inv, (a[0] * a[8] - a[2] * a[6]) * inv, (a[1] * a[6] - a[0] * a[7]) * inv,
        (a[1] * a[5] - a[2] * a[4]) * inv, (a[2] * a[3] - a[0] * a[5]) * inv, (a[0] * a[4] - a[1] * a[3]) * inv,
      ];
      for (const p of mesh.primitives) {
        if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
        const src = /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.POSITION));
        const n = src.length / 3;
        const pos = new Float32Array(src.length);
        for (let v = 0; v < n; v++) {
          const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
          pos[v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
          pos[v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
          pos[v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        }
        let nrm = null;
        if (p.attributes.NORMAL !== undefined) {
          const sn = /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.NORMAL));
          nrm = new Float32Array(sn.length);
          for (let v = 0; v < n; v++) {
            const x = sn[v * 3], y = sn[v * 3 + 1], z = sn[v * 3 + 2];
            const X = Nm[0] * x + Nm[1] * y + Nm[2] * z;
            const Y = Nm[3] * x + Nm[4] * y + Nm[5] * z;
            const Z = Nm[6] * x + Nm[7] * y + Nm[8] * z;
            const l = Math.hypot(X, Y, Z) || 1;
            nrm[v * 3] = X / l;
            nrm[v * 3 + 1] = Y / l;
            nrm[v * 3 + 2] = Z / l;
          }
        }
        const uv = p.attributes.TEXCOORD_0 !== undefined ? /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.TEXCOORD_0)) : null;
        const idx = p.indices !== undefined ? /** @type {Uint32Array} */ (readAccessor(json, bin, p.indices, true)) : Uint32Array.from({ length: n }, (_, i) => i);
        // Flip winding when the node transform mirrors.
        if (det < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        const mat = p.material ?? -1;
        out.push({ name: mesh.name ?? `mesh${node.mesh}`, material: mat, blend: mat >= 0 && json.materials?.[mat]?.alphaMode === 'BLEND', pos, nrm, uv, idx });
      }
    }
    for (const c of node.children ?? []) visit(c, M);
  };
  const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const ni of scene.nodes) visit(ni, I);
  if (!out.length) throw new Error('glTF has no triangle meshes');
  return out;
}

/**
 * @typedef {Object} BodyMesh
 * @property {Float32Array} pos xyz metres, feet on y = 0, centred on x/z, facing +Z
 * @property {Float32Array} nrm xyz unit normals
 * @property {Uint32Array} idx triangles
 * @property {number} height metres
 */

/**
 * Normalize a human base mesh: take the largest opaque primitive (the body), find its up axis
 * (the longest extent), scale it to `height`, stand it on y = 0, centre it, and turn it to face
 * +Z (toes point forward of the heels, so the feet decide which way is front).
 * @param {GlbPrimitive[]} prims @param {number} height @returns {BodyMesh}
 */
export function normalizeBody(prims, height) {
  const body = prims.filter((p) => !p.blend).sort((a, b) => b.pos.length - a.pos.length)[0];
  if (!body) throw new Error('No opaque body mesh in the glTF');
  const n = body.pos.length / 3;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], body.pos[v * 3 + k]); hi[k] = Math.max(hi[k], body.pos[v * 3 + k]); }
  const ext = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const up = ext.indexOf(Math.max(...ext));
  // Remaining axes: the wider is left-right (arms), the narrower front-back.
  const rest = [0, 1, 2].filter((k) => k !== up).sort((a, b) => ext[b] - ext[a]);
  const [ax, az] = rest;
  const s = height / ext[up];
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    pos[v * 3] = (body.pos[v * 3 + ax] - c[ax]) * s;
    pos[v * 3 + 1] = (body.pos[v * 3 + up] - lo[up]) * s;
    pos[v * 3 + 2] = (body.pos[v * 3 + az] - c[az]) * s;
    if (body.nrm) {
      nrm[v * 3] = body.nrm[v * 3 + ax];
      nrm[v * 3 + 1] = body.nrm[v * 3 + up];
      nrm[v * 3 + 2] = body.nrm[v * 3 + az];
    }
  }
  const idx = body.idx.slice();
  // The axis remap is a permutation; an odd one mirrors the mesh, so restore the handedness.
  const perm = [ax, up, az];
  const odd = (perm[0] > perm[1]) !== (perm[1] > perm[2]) !== (perm[0] > perm[2]);
  if (odd) for (let v = 0; v < n; v++) { pos[v * 3] = -pos[v * 3]; nrm[v * 3] = -nrm[v * 3]; }
  // Face +Z: toes reach forward of the shins.
  let toe = 0;
  let toeN = 0;
  let shin = 0;
  let shinN = 0;
  for (let v = 0; v < n; v++) {
    const y = pos[v * 3 + 1] / height;
    if (y < 0.03) { toe += pos[v * 3 + 2]; toeN++; } else if (y > 0.12 && y < 0.2) { shin += pos[v * 3 + 2]; shinN++; }
  }
  if (toeN && shinN && toe / toeN < shin / shinN) {
    for (let v = 0; v < n; v++) {
      pos[v * 3] = -pos[v * 3];
      pos[v * 3 + 2] = -pos[v * 3 + 2];
      nrm[v * 3] = -nrm[v * 3];
      nrm[v * 3 + 2] = -nrm[v * 3 + 2];
    }
  }
  if (!body.nrm) vertexNormals(pos, idx, nrm);
  // Some exporters ship inward-facing normals: point them away from the body's axis.
  let score = 0;
  for (let v = 0; v < n; v++) score += pos[v * 3] * nrm[v * 3] + pos[v * 3 + 2] * nrm[v * 3 + 2];
  if (score < 0) for (let v = 0; v < nrm.length; v++) nrm[v] = -nrm[v];
  return { pos, nrm, idx, height };
}

/**
 * @typedef {Object} BodyInfo
 * @property {number} H standing height
 * @property {number} chin chin height
 * @property {number} crown crown height
 * @property {number[][]} eyes eye centres [left (+x), right]
 * @property {number} eyeR eyeball radius
 * @property {boolean} eyeHoles the mesh has open eye slits with sculpted lids
 * @property {number[]} hips pelvis pivot
 * @property {number[]} spine torso pivot
 * @property {number[]} neck head pivot (base of the neck)
 * @property {number[][]} shoulder [left, right] joint centres
 * @property {number[][]} armDir [left, right] unit directions down the arms in the bind pose
 * @property {number[]} armLen [upper arm, forearm, hand] lengths
 * @property {number[][]} hip [left, right] hip joints
 * @property {number[][]} knee [left, right]
 * @property {number} ankleY
 * @property {number} backZ the back's z at the shoulder blades
 * @property {(y: number) => {rx: number, rz: number, cz: number}} girth body cross-section (no arms) at a height
 * @property {{y0: number, z0: number, sx: number, sy: number, sz: number}} headFit maps the procedural head frame onto this head
 */

/**
 * Measure a normalized human body: chin, crown and eyes; joint centres for the skeleton (hips,
 * spine, neck, shoulders, elbows, wrists, hip joints, knees); arm directions in the bind pose;
 * girths; and the transform that fits the procedural head frame onto this head.
 * @param {BodyMesh} b @returns {BodyInfo}
 */
export function analyzeBody(b) {
  const H = b.height;
  const P = b.pos;
  const n = P.length / 3;
  // Midline profile: the front of the face, from the nose tip down to the chin.
  let crown = 0;
  for (let v = 0; v < n; v++) crown = Math.max(crown, P[v * 3 + 1]);
  /** Frontmost z of the midline in a 1 cm band. @param {number} y0 */
  const midZ = (y0) => {
    let z = -Infinity;
    for (let v = 0; v < n; v++) if (Math.abs(P[v * 3]) < 0.012 && Math.abs(P[v * 3 + 1] - y0) < 0.006) z = Math.max(z, P[v * 3 + 2]);
    return z;
  };
  let noseY = crown;
  let noseZ = -Infinity;
  for (let y = crown - 0.04; y > 0.8 * H; y -= 0.004) { const z = midZ(y); if (z > noseZ) { noseZ = z; noseY = y; } }
  let chin = noseY - 0.06;
  for (let y = noseY - 0.02; y > 0.78 * H; y -= 0.003) { if (midZ(y) < noseZ * 0.72) { chin = y + 0.003; break; } }
  // Eyes: open slits in the mesh (sculpted lids) if it has them, else halfway from chin to crown.
  const holes = boundaryLoops(b).filter((L) => L.c[1] > chin && L.c[1] < crown - 0.05 && L.c[2] > 0 && Math.abs(L.c[0]) > 0.015 && Math.abs(L.c[0]) < 0.06 && L.size[0] > 0.012 && L.size[0] < 0.04 && L.size[1] < 0.02);
  const pick = (/** @type {number} */ s) => holes.filter((L) => Math.sign(L.c[0]) === s).sort((p, q) => q.c[2] - p.c[2])[0];
  const hl = pick(1);
  const hr = pick(-1);
  const eyeHoles = !!(hl && hr);
  const eyeR = 0.0072 * H;
  /** @type {number[][]} */
  let eyes;
  if (eyeHoles) {
    // Cornea just behind the slit, the eyeball's centre a radius behind that.
    eyes = [hl, hr].map((L) => [L.c[0], L.c[1], L.c[2] + 0.002 - eyeR]);
  } else {
    const ey = chin + 0.48 * (crown - chin);
    const ex = 0.0176 * H;
    eyes = [ex, -ex].map((x) => [x, ey, frontAt(b, x, ey) - eyeR + 0.0035]);
  }

  const neckY = chin - 0.017 * H;
  const spineY = 0.565 * H;
  const hipsY = 0.53 * H;
  // Arms: from the shoulder joint toward the farthest fingertip.
  const shY = neckY - 0.035 * H;
  const shX = 0.103 * H;
  let tip = 0;
  for (let v = 0; v < n; v++) if (P[v * 3] > P[tip * 3]) tip = v;
  const ft = [P[tip * 3], P[tip * 3 + 1], P[tip * 3 + 2]];
  const sh = [shX, shY, 0];
  const d = [ft[0] - sh[0], ft[1] - sh[1], ft[2] - sh[2]];
  const L = Math.hypot(d[0], d[1], d[2]);
  const dir = d.map((c) => c / L);
  const armLen = [0.42 * L, 0.33 * L, 0.25 * L];
  /** Within reach of an arm's axis (either side). @param {number} x @param {number} y @param {number} z */
  const onArm = (x, y, z) => {
    const s = x >= 0 ? 1 : -1;
    const q = [x - s * sh[0], y - sh[1], z - sh[2]];
    const t = q[0] * s * dir[0] + q[1] * dir[1] + q[2] * dir[2];
    return t > 0.02 && Math.hypot(q[0] - s * dir[0] * t, q[1] - dir[1] * t, q[2] - dir[2] * t) < 0.075 * (H / 1.75);
  };
  /** Cross-section of the trunk and legs (arms excluded) at a height, from triangle edges cut by the plane. @param {number} y0 */
  const girth = (y0) => {
    let rx = 0.02;
    let fz = -Infinity;
    let bz = Infinity;
    const I = b.idx;
    for (let t = 0; t < I.length; t += 3) {
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        const a = I[t + i] * 3;
        const c = I[t + j] * 3;
        const ya = P[a + 1];
        const yc = P[c + 1];
        if ((ya - y0) * (yc - y0) > 0 || ya === yc) continue;
        const f = (y0 - ya) / (yc - ya);
        const x = P[a] + (P[c] - P[a]) * f;
        const z = P[a + 2] + (P[c + 2] - P[a + 2]) * f;
        if (Math.abs(x) > 0.24 * (H / 1.75) || onArm(x, y0, z)) continue;
        rx = Math.max(rx, Math.abs(x));
        fz = Math.max(fz, z);
        bz = Math.min(bz, z);
      }
    }
    if (!Number.isFinite(fz)) return { rx, rz: 0.1, cz: 0 };
    return { rx, rz: (fz - bz) / 2, cz: (fz + bz) / 2 };
  };
  // Legs: centres of the left leg's cross-section at the hip joint and the knee.
  /** @param {number} y0 */
  const legX = (y0) => {
    let lo = Infinity;
    let hi = -Infinity;
    let z = 0;
    let c = 0;
    for (let v = 0; v < n; v++) {
      const x = P[v * 3], y = P[v * 3 + 1];
      if (Math.abs(y - y0) > 0.03 || x < 0.01) continue;
      // Skip the hands hanging beside the thighs.
      const q = [x - sh[0], y - sh[1], P[v * 3 + 2] - sh[2]];
      const t = q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2];
      if (t > 0 && Math.hypot(q[0] - dir[0] * t, q[1] - dir[1] * t, q[2] - dir[2] * t) < 0.07) continue;
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      z += P[v * 3 + 2];
      c++;
    }
    return c ? [(lo + hi) / 2, z / c] : [0.09, 0];
  };
  // The shoulder joint sits mid-depth of the upper chest.
  sh[2] = girth(shY - 0.08 * (H / 1.75)).cz;
  const neck = [0, neckY, girth(neckY - 0.02).cz];
  const spine = [0, spineY, girth(spineY).cz];
  const hips = [0, hipsY, girth(hipsY).cz];
  const hipY = 0.51 * H;
  const kneeY = 0.285 * H;
  const [hx, hz] = legX(hipY - 0.04 * H);
  const [kx, kz] = legX(kneeY);
  let backZ = 0;
  for (let v = 0; v < n; v++) if (Math.abs(P[v * 3 + 1] - (shY - 0.06)) < 0.03 && Math.abs(P[v * 3]) < 0.12) backZ = Math.min(backZ, P[v * 3 + 2]);
  // Head frame: chin-to-crown height, width at the eyes (ears excluded), front and back.
  let hw = 0.05;
  let back = 0;
  for (let v = 0; v < n; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (y < chin) continue;
    // Above the ears, so they do not widen the skull.
    if (Math.abs(y - eyes[0][1] - 0.045 * (H / 1.75)) < 0.008) hw = Math.max(hw, Math.abs(x));
    back = Math.min(back, z);
  }
  const front = frontAt(b, 0, eyes[0][1] + 0.03);
  const sy = (crown - chin) / 0.24;
  const sz = (front - back) / 0.201;
  return {
    H, chin, crown, eyes, eyeR, eyeHoles, hips, spine, neck,
    shoulder: [sh, [-sh[0], sh[1], sh[2]]], armDir: [dir, [-dir[0], dir[1], dir[2]]], armLen,
    hip: [[hx, hipY, hz], [-hx, hipY, hz]], knee: [[kx, kneeY, kz], [-kx, kneeY, kz]], ankleY: 0.045 * H, backZ, girth,
    headFit: { y0: chin - 0.028 * sy, z0: back + 0.104 * sz, sx: hw / 0.086, sy, sz },
  };
}

/** Frontmost z of the surface at (x, y), by testing every triangle. @param {BodyMesh} b @param {number} x @param {number} y */
export function frontAt(b, x, y) {
  const P = b.pos;
  const I = b.idx;
  let best = -Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, c = I[t + 1] * 3, e = I[t + 2] * 3;
    const d = (P[c] - P[a]) * (P[e + 1] - P[a + 1]) - (P[e] - P[a]) * (P[c + 1] - P[a + 1]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((x - P[a]) * (P[e + 1] - P[a + 1]) - (P[e] - P[a]) * (y - P[a + 1])) / d;
    const w = ((P[c] - P[a]) * (y - P[a + 1]) - (x - P[a]) * (P[c + 1] - P[a + 1])) / d;
    if (u < 0 || w < 0 || u + w > 1) continue;
    best = Math.max(best, P[a + 2] + (P[c + 2] - P[a + 2]) * u + (P[e + 2] - P[a + 2]) * w);
  }
  return best;
}

/**
 * Open boundary loops of the mesh (welded by position): eye slits, mouths, nostrils, ears.
 * @param {BodyMesh} b @returns {{c: number[], size: number[], verts: number[]}[]}
 */
export function boundaryLoops(b) {
  const P = b.pos;
  const n = P.length / 3;
  const ids = weldIds(b);
  /** @type {Map<number, number>} */
  const cnt = new Map();
  for (let t = 0; t < b.idx.length; t += 3) {
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const a = ids[b.idx[t + i]];
      const c = ids[b.idx[t + j]];
      const k = a < c ? a * n + c : c * n + a;
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
  }
  /** @type {Map<number, number[]>} */
  const adj = new Map();
  for (const [k, c] of cnt) {
    if (c !== 1) continue;
    const a = Math.floor(k / n);
    const d = k % n;
    for (const [p, q] of [[a, d], [d, a]]) {
      const l = adj.get(p);
      if (l) l.push(q);
      else adj.set(p, [q]);
    }
  }
  const seen = new Set();
  const out = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const verts = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const v = /** @type {number} */ (st.pop());
      verts.push(v);
      for (const u of adj.get(v) ?? []) if (!seen.has(u)) { seen.add(u); st.push(u); }
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); }
    out.push({ c: lo.map((l, k) => (l + hi[k]) / 2), size: lo.map((l, k) => hi[k] - l), verts });
  }
  return out;
}

/** For each vertex, the first vertex sharing its position (UV seams duplicate vertices). @param {BodyMesh} b */
export function weldIds(b) {
  const P = b.pos;
  const n = P.length / 3;
  const ids = new Int32Array(n);
  /** @type {Map<string, number>} */
  const first = new Map();
  for (let v = 0; v < n; v++) {
    const k = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
    const f = first.get(k);
    if (f === undefined) { first.set(k, v); ids[v] = v; } else ids[v] = f;
  }
  return ids;
}

/**
 * Press soft eye sockets into a face that has none (so the eyeballs sit in the skull instead
 * of on it): vertices around each eye move back along their normals, deepest just under the brow.
 * @param {BodyMesh} b @param {BodyInfo} info
 */
export function carveSockets(b, info) {
  if (info.eyeHoles) return;
  const P = b.pos;
  const N = b.nrm;
  const k = info.H / 1.75;
  for (let v = 0; v < P.length / 3; v++) {
    if (P[v * 3 + 2] <= 0) continue;
    let d = 0;
    for (const e of info.eyes) {
      const dx = (P[v * 3] - e[0]) / (0.017 * k);
      const dy = (P[v * 3 + 1] - e[1] - 0.002 * k) / (0.012 * k);
      d += 0.0075 * k * Math.exp(-(dx * dx + dy * dy));
    }
    if (d < 1e-5) continue;
    for (let c = 0; c < 3; c++) P[v * 3 + c] -= N[v * 3 + c] * d;
  }
  // Keep the eyeballs a little proud of the carved floor.
  for (const e of info.eyes) e[2] = frontAt(b, e[0], e[1]) - info.eyeR + 0.0045;
  vertexNormals(P, b.idx, N);
}

/**
 * Smooth two-bone skin weights from the body's anatomy, for the humanoid skeleton in models.js
 * (0 hips, 1 torso, 2 head, 3/4 left upper/fore arm, 5/6 right, 7/8 left thigh/shin, 9/10 right):
 * arms by distance along and around each arm's axis (blending torso-shoulder and elbow), the
 * neck blending torso into head, the waist torso into hips, hips into thighs, and the knees.
 * @param {BodyMesh} b @param {BodyInfo} info
 * @returns {{b0: Uint8Array, b1: Uint8Array, w: Float32Array}} per vertex: main bone, second bone, second bone's weight
 */
export function skinWeights(b, info) {
  const P = b.pos;
  const n = P.length / 3;
  const b0 = new Uint8Array(n);
  const b1 = new Uint8Array(n);
  const w = new Float32Array(n);
  const ss = (/** @type {number} */ e0, /** @type {number} */ e1, /** @type {number} */ x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const k = info.H / 1.75;
  // Trunk half-widths every centimetre (arms excluded), so arm-adjacent torso stays torso.
  const step = 0.01;
  const trunk = Float32Array.from({ length: Math.ceil(info.H / step) + 1 }, (_, i) => info.girth(i * step).rx);
  /** @param {number} v @param {number} a @param {number} c @param {number} wt */
  const set = (v, a, c, wt) => {
    if (wt > 0.5) { b0[v] = c; b1[v] = a; w[v] = 1 - wt; } else { b0[v] = a; b1[v] = c; w[v] = wt; }
  };
  for (let v = 0; v < n; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    const side = x >= 0 ? 0 : 1;
    // Arms.
    const sh = info.shoulder[side];
    const dir = info.armDir[side];
    const q = [x - sh[0], y - sh[1], z - sh[2]];
    const t = q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2];
    const r = Math.hypot(q[0] - dir[0] * t, q[1] - dir[1] * t, q[2] - dir[2] * t);
    // Arm: near its axis (generously: the axis runs to the fingertip, not down the bone), but
    // past the shoulder cap anything inside the trunk's girth is the torso's side, not the arm.
    const inTrunk = Math.abs(x) < trunk[Math.min(trunk.length - 1, Math.max(0, Math.round(y / step)))] + 0.004 * k;
    const nearArm = t < 0.05 * k ? r < 0.075 * k + Math.max(0, -t) * 0.6 : r < 0.06 * k || (r < 0.11 * k && !inTrunk);
    if (Math.abs(x) > 0.05 * k && t > -0.035 * k && nearArm && y < info.neck[1] + 0.02) {
      const up = side ? 5 : 3;
      const fo = side ? 6 : 4;
      const el = info.armLen[0];
      if (t < 0.07 * k) set(v, 1, up, ss(-0.035 * k, 0.07 * k, t));
      else set(v, up, fo, ss(el - 0.035 * k, el + 0.035 * k, t));
      continue;
    }
    // Head and neck.
    if (y > info.neck[1] - 0.012 * k) { set(v, 1, 2, ss(info.neck[1] - 0.012 * k, info.neck[1] + 0.03 * k, y)); continue; }
    // Legs.
    const hip = info.hip[side];
    if (y < hip[1] + 0.03 * k && Math.abs(x) > 0.004) {
      const th = side ? 9 : 7;
      const sn = side ? 10 : 8;
      const kn = info.knee[side][1];
      if (y > kn + 0.05 * k) set(v, 0, th, ss(hip[1] + 0.03 * k, hip[1] - 0.07 * k, y));
      else set(v, th, sn, ss(kn + 0.05 * k, kn - 0.04 * k, y));
      continue;
    }
    // Trunk: hips into torso across the waist.
    set(v, 0, 1, ss(info.spine[1] - 0.06 * k, info.spine[1] + 0.07 * k, y));
  }
  return { b0, b1, w };
}

/**
 * @typedef {Object} Body
 * @property {BodyMesh} mesh
 * @property {BodyInfo} info
 * @property {{b0: Uint8Array, b1: Uint8Array, w: Float32Array}} skin
 */

/** Normalize, measure, carve and skin one base mesh. @param {ArrayBuffer} buf @param {number} height @returns {Body} */
export function prepareBody(buf, height) {
  const mesh = normalizeBody(loadGLB(buf), height);
  const info = analyzeBody(mesh);
  carveSockets(mesh, info);
  return { mesh, info, skin: skinWeights(mesh, info) };
}

/**
 * Fetch and prepare both base meshes in the browser.
 * @returns {Promise<{male: Body, female: Body}>}
 */
export async function loadBodies() {
  /** @param {'male'|'female'} g */
  const one = async (g) => {
    const r = await fetch(BODY_ASSETS[g]);
    if (!r.ok) throw new Error(`${BODY_ASSETS[g]}: HTTP ${r.status}`);
    return prepareBody(await r.arrayBuffer(), BODY_HEIGHT[g]);
  };
  const [male, female] = await Promise.all([one('male'), one('female')]);
  return { male, female };
}

/** Area-weighted vertex normals. @param {Float32Array} pos @param {Uint32Array} idx @param {Float32Array} out */
export function vertexNormals(pos, idx, out) {
  out.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const v of [a, b, c]) { out[v] += nx; out[v + 1] += ny; out[v + 2] += nz; }
  }
  for (let v = 0; v < out.length; v += 3) {
    const l = Math.hypot(out[v], out[v + 1], out[v + 2]) || 1;
    out[v] /= l; out[v + 1] /= l; out[v + 2] /= l;
  }
}

// ---------------------------------------------------------------------------
// Rigged, animated NPC models (assets/models/*.glb)
// ---------------------------------------------------------------------------

/**
 * Rigged NPC models by role (the NPC's sprite name: archivist, merchant, guard, folk_a, ...).
 * Once a role's .glb is in assets/models/, add one line here; roles without one keep their
 * procedural rig, and so does any role whose file fails to load.
 * @type {Record<string, string>}
 */
export const NPC_MODELS = { archivist: 'assets/models/archivist.glb' };
/** Most joints one rigged model may use: the skinned shader's uniform budget (4 vectors each). */
export const GLB_BONES = 32;
/** Grid cells across a rigged model's largest extent for its far LOD (see clusterLod). */
const LOD_CELLS = 48;
/** Rigged models loaded by loadNpcModels(), by role. @type {Map<string, GlbModel>} */
export const NPC_CHARS = new Map();
/** Crossfade between animation clips, seconds. */
const FADE = 0.3;
/** Keywords that pick each animation state's clip (Meshy names them Idle, Casual_Walk, Talk_with_Hands_Open...). */
const STATE_CLIPS = { idle: /idle|stand|breath/i, walk: /walk|stroll/i, talk: /talk|speak|convers|gestur/i };

/**
 * @typedef {Object} GlbChannel
 * @property {number} node
 * @property {number} off offset into a node's 10 local floats: 0 translation, 3 rotation, 7 scale
 * @property {number} w 3 or 4 components
 * @property {Float32Array} times
 * @property {Float32Array} values w floats per key
 * @property {boolean} step STEP interpolation
 */
/**
 * @typedef {Object} GlbClip
 * @property {string} name
 * @property {number} dur seconds
 * @property {GlbChannel[]} ch
 * @property {number} speed ground speed of the feet at rate 1, m/s (set for the walk clip)
 */
/**
 * @typedef {Object} GlbMaterial
 * @property {number} base image index of baseColorTexture, or -1
 * @property {number} normal image index of normalTexture, or -1
 * @property {number} mr image index of metallicRoughnessTexture (G roughness, B metal), or -1
 * @property {number[]} color baseColorFactor
 * @property {number} metal metallicFactor
 * @property {number} rough roughnessFactor
 */
/**
 * @typedef {Object} GlbPart
 * @property {Float32Array} pos
 * @property {Float32Array} nrm
 * @property {Float32Array} uv
 * @property {Uint16Array} joints 4 per vertex, into GlbModel.joints
 * @property {Float32Array} weights 4 per vertex, summing to 1
 * @property {Uint32Array} idx
 * @property {number} mat material index, or -1
 */
/**
 * A rigged model ready to pose. Pose matrices map the file's space through `fit` (feet at y = 0,
 * centred, scaled to a human height) and then the entity's placement.
 * @typedef {Object} GlbModel
 * @property {GlbPart[]} parts
 * @property {GlbPart[]} far simplified parts for distant draws and shadows
 * @property {GlbMaterial[]} materials
 * @property {{bytes: Uint8Array, mime: string}[]} images embedded PNG/JPEG, until decoded
 * @property {ImageBitmap[]} bitmaps decoded images (browser only)
 * @property {boolean} skinned false: a static model drawn with one matrix
 * @property {Int16Array} parent node parent, -1 at a root
 * @property {number[]} order nodes with parents first
 * @property {Float32Array} rest local TRS per node (t3 r4 s3)
 * @property {(Float32Array|null)[]} fixed local matrix of nodes given as a matrix
 * @property {Int32Array} joints node of each joint
 * @property {Float32Array} ibm inverse bind matrix per joint
 * @property {Float32Array} fit
 * @property {number} height metres, after fit
 * @property {Record<string, GlbClip>} clips
 * @property {{idle: GlbClip|null, walk: GlbClip|null, talk: GlbClip|null}} states
 * @property {number} head node of the head joint, or -1
 * @property {number} neck node of the neck joint, or -1
 * @property {Float32Array} headPos head joint position after the last pose
 * @property {{a: Float32Array, b: Float32Array, world: Float32Array, m: Float32Array, rf: Float32Array}} tmp
 */

/** o[oo..] = a[ao..] * b[bo..], column-major 4x4. Out must not alias the inputs. @param {Float32Array} a @param {number} ao @param {Float32Array} b @param {number} bo @param {Float32Array} o @param {number} oo */
function mulM(a, ao, b, bo, o, oo) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
    for (let r = 0; r < 4; r++) o[oo + c * 4 + r] = a[ao + r] * b0 + a[ao + 4 + r] * b1 + a[ao + 8 + r] * b2 + a[ao + 12 + r] * b3;
  }
}

/** Matrix from local TRS (10 floats at s[so]). @param {Float32Array} s @param {number} so @param {Float32Array} o @param {number} oo */
function trsMat(s, so, o, oo) {
  const x = s[so + 3], y = s[so + 4], z = s[so + 5], w = s[so + 6];
  const sx = s[so + 7], sy = s[so + 8], sz = s[so + 9];
  o[oo] = (1 - 2 * (y * y + z * z)) * sx; o[oo + 1] = 2 * (x * y + z * w) * sx; o[oo + 2] = 2 * (x * z - y * w) * sx; o[oo + 3] = 0;
  o[oo + 4] = 2 * (x * y - z * w) * sy; o[oo + 5] = (1 - 2 * (x * x + z * z)) * sy; o[oo + 6] = 2 * (y * z + x * w) * sy; o[oo + 7] = 0;
  o[oo + 8] = 2 * (x * z + y * w) * sz; o[oo + 9] = 2 * (y * z - x * w) * sz; o[oo + 10] = (1 - 2 * (x * x + y * y)) * sz; o[oo + 11] = 0;
  o[oo + 12] = s[so]; o[oo + 13] = s[so + 1]; o[oo + 14] = s[so + 2]; o[oo + 15] = 1;
}

/** Sample a clip at time t over the local TRS buffer. @param {GlbClip} clip @param {number} t @param {Float32Array} out */
function sampleClip(clip, t, out) {
  for (const ch of clip.ch) {
    const T = ch.times;
    const last = T.length - 1;
    let k = 0;
    let f = 0;
    if (t >= T[last]) k = last;
    else if (t > T[0]) {
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (T[mid] <= t) lo = mid; else hi = mid;
      }
      k = lo;
      if (!ch.step) f = (t - T[lo]) / (T[hi] - T[lo] || 1);
    }
    const V = ch.values;
    const w = ch.w;
    const a = k * w;
    const b = Math.min(k + 1, last) * w;
    const o = ch.node * 10 + ch.off;
    if (w === 4) {
      // Normalised lerp along the shorter arc; keys are dense enough that it matches slerp.
      const s = V[a] * V[b] + V[a + 1] * V[b + 1] + V[a + 2] * V[b + 2] + V[a + 3] * V[b + 3] < 0 ? -1 : 1;
      let l = 0;
      for (let i = 0; i < 4; i++) { out[o + i] = V[a + i] * (1 - f) + V[b + i] * s * f; l += out[o + i] * out[o + i]; }
      l = 1 / Math.sqrt(l || 1);
      for (let i = 0; i < 4; i++) out[o + i] *= l;
    } else {
      for (let i = 0; i < 3; i++) out[o + i] = V[a + i] * (1 - f) + V[b + i] * f;
    }
  }
}

/** Blend local TRS buffer b into a by w (crossfade). @param {Float32Array} a @param {Float32Array} b @param {number} w */
function mixTRS(a, b, w) {
  for (let o = 0; o < a.length; o += 10) {
    for (const i of [0, 1, 2, 7, 8, 9]) a[o + i] += (b[o + i] - a[o + i]) * w;
    const s = a[o + 3] * b[o + 3] + a[o + 4] * b[o + 4] + a[o + 5] * b[o + 5] + a[o + 6] * b[o + 6] < 0 ? -1 : 1;
    let l = 0;
    for (let i = 3; i < 7; i++) { a[o + i] += (b[o + i] * s - a[o + i]) * w; l += a[o + i] * a[o + i]; }
    l = 1 / Math.sqrt(l || 1);
    for (let i = 3; i < 7; i++) a[o + i] *= l;
  }
}

/**
 * Turn a node's world matrix (in place, about its own origin) by yaw about the model's up axis
 * and pitch about its side axis: the file's scene space, where models face +Z.
 * @param {Float32Array} w @param {number} o @param {number} yaw @param {number} pitch
 */
function aimNode(w, o, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = Ry(yaw) * Rx(pitch), applied to the rotation/scale columns; the translation (pivot) stays.
  for (let k = 0; k < 3; k++) {
    const x = w[o + k * 4], y = w[o + k * 4 + 1], z = w[o + k * 4 + 2];
    const y1 = cp * y - sp * z;
    const z1 = sp * y + cp * z;
    w[o + k * 4] = cy * x + sy * z1;
    w[o + k * 4 + 1] = y1;
    w[o + k * 4 + 2] = -sy * x + cy * z1;
  }
}

/**
 * Pose a rigged model: crossfaded clip layers, the node hierarchy, then one skinning matrix per
 * joint (root x fit x joint world x inverse bind) into out. A static model gets one matrix.
 * yaw and pitch turn the head toward something on top of the clip (neck 35%, head 65%);
 * +yaw turns toward the model's left, +pitch tips the face down.
 * @param {GlbModel} c @param {{clip: GlbClip, time: number, weight: number}[]} layers base first; each later one blends in by its weight
 * @param {Float32Array} root entity placement @param {Float32Array} out
 * @param {number} [yaw] radians @param {number} [pitch] radians
 * @returns {number} matrices written
 */
export function poseGlb(c, layers, root, out, yaw = 0, pitch = 0) {
  const { a, b, world, m, rf } = c.tmp;
  a.set(c.rest);
  layers.forEach((L, i) => {
    if (i === 0) { sampleClip(L.clip, L.time, a); return; }
    b.set(c.rest);
    sampleClip(L.clip, L.time, b);
    mixTRS(a, b, L.weight);
  });
  for (const i of c.order) {
    const p = c.parent[i];
    const fx = c.fixed[i];
    if (fx) m.set(fx); else trsMat(a, i * 10, m, 0);
    if (p < 0) world.set(m, i * 16); else mulM(world, p * 16, m, 0, world, i * 16);
    // Children are composed after their parent, so they follow the turn.
    if ((yaw || pitch) && (i === c.neck || i === c.head)) {
      const k = i === c.head ? 0.65 : 0.35;
      aimNode(world, i * 16, yaw * k, pitch * k);
    }
  }
  mulM(root, 0, c.fit, 0, rf, 0);
  if (c.head >= 0) {
    const h = c.head * 16;
    for (let r = 0; r < 3; r++) c.headPos[r] = rf[r] * world[h + 12] + rf[4 + r] * world[h + 13] + rf[8 + r] * world[h + 14] + rf[12 + r];
  }
  if (!c.skinned) { out.set(rf); return 1; }
  for (let j = 0; j < c.joints.length; j++) {
    mulM(world, c.joints[j] * 16, c.ibm, j * 16, m, 0);
    mulM(rf, 0, m, 0, out, j * 16);
  }
  return c.joints.length;
}

/**
 * Parse a rigged (or static) .glb: every triangle primitive, its PBR material and embedded
 * images, the skeleton and inverse binds, and every animation clip. Mesh parts without a skin
 * in a rigged model ride their node rigidly, as an extra joint.
 * @param {ArrayBuffer} buf @returns {GlbModel}
 */
export function parseCharacter(buf) {
  const { json, bin } = parseGLB(buf);
  const nodes = json.nodes ?? [];
  const N = nodes.length;
  const parent = new Int16Array(N).fill(-1);
  nodes.forEach((/** @type {any} */ n, /** @type {number} */ i) => { for (const ch of n.children ?? []) parent[ch] = i; });
  /** @type {number[]} */
  const order = [];
  /** @param {number} i */
  const visit = (i) => { order.push(i); for (const ch of nodes[i].children ?? []) visit(ch); };
  for (let i = 0; i < N; i++) if (parent[i] < 0) visit(i);
  const rest = new Float32Array(N * 10);
  /** @type {(Float32Array|null)[]} */
  const fixed = [];
  nodes.forEach((/** @type {any} */ n, /** @type {number} */ i) => {
    rest.set([...(n.translation ?? [0, 0, 0]), ...(n.rotation ?? [0, 0, 0, 1]), ...(n.scale ?? [1, 1, 1])], i * 10);
    fixed[i] = n.matrix ? Float32Array.from(n.matrix) : null;
  });
  const skin = json.skins?.[0];
  if ((json.skins?.length ?? 0) > 1) console.warn('glTF has several skins; only the first is used.');
  /** @type {number[]} */
  const joints = skin ? [...skin.joints] : [];
  /** @type {number[]} */
  const ibm = skin?.inverseBindMatrices !== undefined ? [...readAccessor(json, bin, skin.inverseBindMatrices)] : joints.flatMap(() => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  /** @type {GlbPart[]} */
  const parts = [];
  if (skin) {
    for (const ni of order) {
      const node = nodes[ni];
      if (node.mesh === undefined) continue;
      let rigid = -1;
      if (node.skin === undefined) {
        // Rigid part: one more joint that is the node itself, with an identity inverse bind.
        rigid = joints.length;
        joints.push(ni);
        ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
      }
      for (const p of json.meshes[node.mesh].primitives) {
        if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
        const pos = /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.POSITION));
        const n = pos.length / 3;
        const idx = p.indices !== undefined ? /** @type {Uint32Array} */ (readAccessor(json, bin, p.indices, true)) : Uint32Array.from({ length: n }, (_, i) => i);
        const nrm = p.attributes.NORMAL !== undefined ? /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.NORMAL)) : normalsOf(pos, idx);
        const uv = p.attributes.TEXCOORD_0 !== undefined ? /** @type {Float32Array} */ (readAccessor(json, bin, p.attributes.TEXCOORD_0)) : new Float32Array(n * 2);
        const jo = new Uint16Array(n * 4);
        const we = new Float32Array(n * 4);
        if (rigid >= 0 || p.attributes.JOINTS_0 === undefined) {
          for (let v = 0; v < n; v++) { jo[v * 4] = rigid >= 0 ? rigid : 0; we[v * 4] = 1; }
        } else {
          const sj = readAccessor(json, bin, p.attributes.JOINTS_0, true);
          const sw = readAccessor(json, bin, p.attributes.WEIGHTS_0);
          for (let v = 0; v < n; v++) {
            const sum = sw[v * 4] + sw[v * 4 + 1] + sw[v * 4 + 2] + sw[v * 4 + 3];
            for (let k = 0; k < 4; k++) {
              jo[v * 4 + k] = sj[v * 4 + k];
              we[v * 4 + k] = sum > 0 ? sw[v * 4 + k] / sum : +(k === 0);
            }
          }
        }
        parts.push({ pos, nrm, uv, joints: jo, weights: we, idx, mat: p.material ?? -1 });
      }
    }
  } else {
    // Static model: node transforms baked in, one matrix places it.
    for (const g of loadGLB(buf)) {
      const n = g.pos.length / 3;
      const we = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) we[v * 4] = 1;
      parts.push({ pos: g.pos, nrm: g.nrm ?? normalsOf(g.pos, g.idx), uv: g.uv ?? new Float32Array(n * 2), joints: new Uint16Array(n * 4), weights: we, idx: g.idx, mat: g.material });
    }
  }
  if (!parts.length) throw new Error('glTF has no triangle meshes');
  if (joints.length > GLB_BONES) throw new Error(`Model has ${joints.length} joints; at most ${GLB_BONES} are supported`);
  for (const p of parts) for (const j of p.joints) if (j >= Math.max(joints.length, 1)) throw new Error(`Vertex joint ${j} is outside the skin`);

  /** @param {any} ref @returns {number} */
  const image = (ref) => {
    const t = ref === undefined ? null : json.textures?.[ref.index];
    return t?.extensions?.EXT_texture_webp?.source ?? t?.source ?? -1;
  };
  /** @type {GlbMaterial[]} */
  const materials = (json.materials ?? []).map((/** @type {any} */ mt) => {
    const pbr = mt.pbrMetallicRoughness ?? {};
    return { base: image(pbr.baseColorTexture), normal: image(mt.normalTexture), mr: image(pbr.metallicRoughnessTexture), color: pbr.baseColorFactor ?? [1, 1, 1, 1], metal: pbr.metallicFactor ?? 1, rough: pbr.roughnessFactor ?? 1 };
  });
  // shortcut: only images embedded in the BIN chunk; external or data-URI images are skipped (drawn untextured).
  const images = (json.images ?? []).map((/** @type {any} */ im) => {
    if (im.bufferView === undefined) return { bytes: new Uint8Array(0), mime: '' };
    const bv = json.bufferViews[im.bufferView];
    return { bytes: new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength).slice(), mime: im.mimeType ?? 'image/png' };
  });

  const PATH = { translation: [0, 3], rotation: [3, 4], scale: [7, 3] };
  /** @type {Record<string, GlbClip>} */
  const clips = {};
  (json.animations ?? []).forEach((/** @type {any} */ an, /** @type {number} */ ai) => {
    /** @type {GlbChannel[]} */
    const ch = [];
    let dur = 0;
    for (const c of an.channels) {
      const pw = PATH[/** @type {keyof typeof PATH} */ (c.target.path)];
      if (!pw || c.target.node === undefined) continue;
      const s = an.samplers[c.sampler];
      const times = /** @type {Float32Array} */ (readAccessor(json, bin, s.input));
      let values = /** @type {Float32Array} */ (readAccessor(json, bin, s.output));
      const w = pw[1];
      if (s.interpolation === 'CUBICSPLINE') {
        // Keep each key's value (in-tangent, value, out-tangent) and interpolate it linearly.
        const v = new Float32Array(times.length * w);
        for (let k = 0; k < times.length; k++) v.set(values.subarray((k * 3 + 1) * w, (k * 3 + 2) * w), k * w);
        values = v;
      }
      dur = Math.max(dur, times[times.length - 1] ?? 0);
      ch.push({ node: c.target.node, off: pw[0], w, times, values, step: s.interpolation === 'STEP' });
    }
    const name = an.name || `clip${ai}`;
    clips[name] = { name, dur, ch, speed: 0 };
  });
  const list = Object.values(clips);
  /** @param {RegExp} re */
  const pick = (re) => list.find((cl) => re.test(cl.name)) ?? null;
  const idle = pick(STATE_CLIPS.idle) ?? list[0] ?? null;
  const states = { idle, walk: pick(STATE_CLIPS.walk) ?? idle, talk: pick(STATE_CLIPS.talk) ?? idle };
  const head = joints.find((j) => /^head$/i.test(nodes[j].name ?? '')) ?? joints.find((j) => /head/i.test(nodes[j].name ?? '')) ?? -1;
  const neck = joints.find((j) => /neck/i.test(nodes[j].name ?? '')) ?? -1;

  /** @type {GlbModel} */
  const c = {
    parts, far: clusterLod(parts), materials, images, bitmaps: [], skinned: !!skin, parent, order, rest, fixed,
    joints: Int32Array.from(joints), ibm: Float32Array.from(ibm), fit: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    height: 0, clips, states, head, neck, headPos: new Float32Array(3),
    tmp: { a: new Float32Array(N * 10), b: new Float32Array(N * 10), world: new Float32Array(N * 16), m: new Float32Array(16), rf: new Float32Array(16) },
  };
  fitModel(c);
  if (states.walk && states.walk !== idle) states.walk.speed = clipSpeed(c, states.walk, nodes);
  return c;
}

/**
 * Far LOD by vertex clustering in the bind pose: vertices in one grid cell (1/LOD_CELLS of the
 * model's coordinate range) facing the same octant merge into the first one, keeping its UV, normal and skin
 * weights, and triangles that collapse are dropped.
 * shortcut: clustering smears UV seams and thin parts, fine past CHAR_LOD_DIST; bake an offline (meshoptimizer) LOD into the .glb if far NPCs must look sharper.
 * @param {GlbPart[]} parts @returns {GlbPart[]}
 */
export function clusterLod(parts) {
  let lo = Infinity, hi = -Infinity;
  for (const p of parts) for (const v of p.pos) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const cell = (hi - lo) / LOD_CELLS || 1;
  return parts.map((p) => {
    const n = p.pos.length / 3;
    const map = new Uint32Array(n);
    /** @type {Map<number, number>} */
    const cells = new Map();
    /** @type {number[]} */
    const keep = [];
    for (let v = 0; v < n; v++) {
      const [x, y, z] = [0, 1, 2].map((k) => Math.floor((p.pos[v * 3 + k] - lo) / cell));
      // The normal's octant keeps the two sides of thin cloth and plates from fusing into holes.
      const side = (p.nrm[v * 3] > 0 ? 1 : 0) + (p.nrm[v * 3 + 1] > 0 ? 2 : 0) + (p.nrm[v * 3 + 2] > 0 ? 4 : 0);
      const key = ((x * 64 + y) * 64 + z) * 8 + side;
      let r = cells.get(key);
      if (r === undefined) { r = keep.length; cells.set(key, r); keep.push(v); }
      map[v] = r;
    }
    /** @type {number[]} */
    const idx = [];
    for (let t = 0; t < p.idx.length; t += 3) {
      const a = map[p.idx[t]], b = map[p.idx[t + 1]], d = map[p.idx[t + 2]];
      if (a !== b && b !== d && a !== d) idx.push(a, b, d);
    }
    /** @template {Float32Array|Uint16Array} T @param {T} src @param {number} w @returns {T} */
    const pick = (src, w) => {
      const out = /** @type {T} */ (new /** @type {any} */ (src.constructor)(keep.length * w));
      keep.forEach((v, i) => out.set(src.subarray(v * w, v * w + w), i * w));
      return out;
    };
    return { pos: pick(p.pos, 3), nrm: pick(p.nrm, 3), uv: pick(p.uv, 2), joints: pick(p.joints, 4), weights: pick(p.weights, 4), idx: Uint32Array.from(idx), mat: p.mat };
  });
}

/** Fresh area-weighted normals. @param {Float32Array} pos @param {Uint32Array} idx */
function normalsOf(pos, idx) {
  const out = new Float32Array(pos.length);
  vertexNormals(pos, idx, out);
  return out;
}

/** Skinned vertex positions of a pose (CPU, for measuring). @param {GlbModel} c @param {Float32Array} mats @param {(x:number, y:number, z:number) => void} f */
function eachSkinned(c, mats, f) {
  for (const p of c.parts) {
    for (let v = 0; v < p.pos.length / 3; v++) {
      const x = p.pos[v * 3], y = p.pos[v * 3 + 1], z = p.pos[v * 3 + 2];
      let X = 0, Y = 0, Z = 0;
      for (let k = 0; k < 4; k++) {
        const w = p.weights[v * 4 + k];
        if (!w) continue;
        const o = (c.skinned ? p.joints[v * 4 + k] : 0) * 16;
        X += w * (mats[o] * x + mats[o + 4] * y + mats[o + 8] * z + mats[o + 12]);
        Y += w * (mats[o + 1] * x + mats[o + 5] * y + mats[o + 9] * z + mats[o + 13]);
        Z += w * (mats[o + 2] * x + mats[o + 6] * y + mats[o + 10] * z + mats[o + 14]);
      }
      f(X, Y, Z);
    }
  }
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Measure the idle pose and set fit: feet on y = 0, centred over the origin, human height. @param {GlbModel} c */
function fitModel(c) {
  const mats = new Float32Array(Math.max(c.joints.length, 1) * 16);
  poseGlb(c, c.states.idle ? [{ clip: c.states.idle, time: 0, weight: 1 }] : [], IDENT, mats);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  eachSkinned(c, mats, (x, y, z) => {
    lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
    hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
  });
  const h = hi[1] - lo[1];
  if (!(h > 0)) throw new Error('Model has no height');
  // Models already in metres at a human height keep their size; others are scaled to 1.75 m.
  const k = h > 1.2 && h < 2.4 ? 1 : 1.75 / h;
  c.fit.set([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, -k * (lo[0] + hi[0]) / 2, -k * lo[1], -k * (lo[2] + hi[2]) / 2, 1]);
  c.height = h * k;
}

/**
 * Ground speed of a walk clip at rate 1: how fast the planted (lowest) foot slides back
 * relative to the hips, averaged over the cycle. Playback is scaled by it so feet don't skate.
 * @param {GlbModel} c @param {GlbClip} clip @param {any[]} nodes @returns {number} m/s
 */
function clipSpeed(c, clip, nodes) {
  const feet = [...c.joints].filter((j) => /foot|toe|ankle/i.test(nodes[j].name ?? ''));
  if (!feet.length || !clip.dur) return 0;
  const hips = c.joints[0];
  const mats = new Float32Array(c.joints.length * 16);
  const S = 60;
  const dt = clip.dur / S;
  /** @param {number} t @returns {number[][]} per foot [x, y, z] minus the hips' x, z */
  const at = (t) => {
    poseGlb(c, [{ clip, time: t, weight: 1 }], IDENT, mats);
    const W = c.tmp.world;
    const F = c.fit;
    /** @param {number} n */
    const P = (n) => [0, 1, 2].map((r) => F[r] * W[n * 16 + 12] + F[4 + r] * W[n * 16 + 13] + F[8 + r] * W[n * 16 + 14] + F[12 + r]);
    const hp = P(hips);
    return feet.map((f) => { const p = P(f); return [p[0] - hp[0], p[1], p[2] - hp[2]]; });
  };
  let sum = 0;
  let prev = at(0);
  for (let s = 1; s <= S; s++) {
    const cur = at(Math.min(s * dt, clip.dur));
    let low = 0;
    for (let f = 1; f < feet.length; f++) if (prev[f][1] < prev[low][1]) low = f;
    sum += Math.hypot(cur[low][0] - prev[low][0], cur[low][2] - prev[low][2]) / dt;
    prev = cur;
  }
  return sum / S;
}

/**
 * Per-entity animation state for a rigged model: plays the clip for idle, walk or talk and
 * crossfades over FADE seconds when the state changes. The walk plays at the rate that matches
 * the entity's ground speed.
 */
export class GlbAnimator {
  /** @param {GlbModel} model */
  constructor(model) {
    this.model = model;
    /** @type {GlbClip|null} */
    this.cur = null;
    /** @type {GlbClip|null} */
    this.prev = null;
    this.t = 0;
    this.pt = 0;
    this.prate = 1;
    this.rate = 1;
    this.fade = 1;
    /** Layers for poseGlb, base first. @type {{clip: GlbClip, time: number, weight: number}[]} */
    this.layers = [];
    this._base = { clip: /** @type {GlbClip} */ (/** @type {unknown} */ (null)), time: 0, weight: 1 };
    this._top = { clip: /** @type {GlbClip} */ (/** @type {unknown} */ (null)), time: 0, weight: 1 };
  }

  /** @param {'idle'|'walk'|'talk'} state @param {number} dt @param {number} [speed] ground speed, m/s */
  update(state, dt, speed = 0) {
    const clip = this.model.states[state];
    if (clip !== this.cur) {
      this.prev = this.cur;
      this.pt = this.t;
      this.prate = this.rate;
      this.cur = clip;
      this.t = 0;
      this.fade = this.prev ? 0 : 1;
    }
    this.rate = state === 'walk' && clip?.speed ? Math.max(0.4, Math.min(2.5, speed / clip.speed)) : 1;
    this.layers.length = 0;
    if (!clip) return;
    this.t = clip.dur ? (this.t + dt * this.rate) % clip.dur : 0;
    this.fade = Math.min(1, this.fade + dt / FADE);
    if (this.prev && this.fade < 1) {
      this.pt = this.prev.dur ? (this.pt + dt * this.prate) % this.prev.dur : 0;
      Object.assign(this._base, { clip: this.prev, time: this.pt, weight: 1 });
      Object.assign(this._top, { clip, time: this.t, weight: this.fade * this.fade * (3 - 2 * this.fade) });
      this.layers.push(this._base, this._top);
    } else {
      this.prev = null;
      Object.assign(this._base, { clip, time: this.t, weight: 1 });
      this.layers.push(this._base);
    }
  }
}

/**
 * Fetch, parse and decode every model in NPC_MODELS into NPC_CHARS. A model that is missing or
 * broken is skipped with a warning, so its role keeps the procedural rig. Never rejects.
 */
export async function loadNpcModels() {
  await Promise.all(Object.entries(NPC_MODELS).map(async ([role, url]) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c = parseCharacter(await r.arrayBuffer());
      // Raw texels: no colour-space conversion (normal and metal/rough maps are data) or premultiplying.
      c.bitmaps = await Promise.all(c.images.map((im) => createImageBitmap(new Blob([/** @type {BlobPart} */ (im.bytes)], { type: im.mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })));
      c.images = [];
      NPC_CHARS.set(role, c);
    } catch (err) {
      console.warn(`${url}: rigged model unavailable; ${role} keeps the procedural rig.`, err);
    }
  }));
}
