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
  if (json.extensionsRequired?.length) throw new Error(`glTF requires unsupported extensions: ${json.extensionsRequired.join(', ')}`);
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
