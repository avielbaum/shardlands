/**
 * @file three.js renderer (the default; ?renderer=webgl falls back to the raw WebGL one).
 * three.js owns the GPU work: the WebGL renderer and its state, buffers and VAOs (BufferGeometry,
 * InstancedBufferGeometry), textures (DataArrayTexture for the world materials), render targets
 * with depth textures, and the passes. The look is unchanged: the game's own GLSL runs as
 * RawShaderMaterials, and everything that needs no GPU (chunks, props, the per-frame gather,
 * lights, rigs, the shadow box, the viewmodel pose) comes from RendererBase in renderer.js.
 */
import * as THREE from 'three';
import { buildWorldAtlas, buildSpriteAtlas, buildWorldMaterials, buildDetailTexture } from './textures.js';
import { CHUNK } from './world.js';
import { Mesh, VERT, MAX_BONES, ident, mul, trs, VARIANTS, getRig, poseRig, getViewmodel, RIG_NAMES } from './models.js';
import { NPC_CHARS, GLB_BONES, poseGlb, viewHands } from './meshes.js';
import {
  RendererBase, HUMAN_VARIANTS, NEAR, FAR, INST, CHAR_LOD_DIST, VIEW_DEPTH, WHITE,
  MESH_VS, GLB_VS, DEPTH_FS, MESH_FS, POST_VS, FX_VS, FX_FS, SKY_FS, COMPOSITE_FS, SSAO_FS, AO_BLUR_FS, BRIGHT_FS, BLUR_FS, RAIN_VS, RAIN_FS,
  glsl, perspective, viewMatrix, invert, weld, lin3, buildChunk, FloatList,
} from './renderer.js';

// The game's shaders work in linear light and tone-map themselves: no colour conversions.
THREE.ColorManagement.enabled = false;

/** @typedef {import('./renderer.js').RenderView} RenderView */
/** @typedef {import('./renderer.js').SpriteDesc} SpriteDesc */
/** @typedef {import('./models.js').ModelDesc} ModelDesc */
/** @typedef {{[name: string]: THREE.IUniform}} Uniforms */

/** The game's shaders as three.js GLSL3 sources (three adds the version line). @param {string} src @param {string[]} [defs] */
const src3 = (src, defs = []) => glsl(src.replace(/^#version 300 es\n/, ''), defs).replace(/^#version 300 es\n/, '');

/** Mesh vertex layout (VERT floats): name, size, offset in floats. */
const LAYOUT = /** @type {const} */ ([['aPos', 3, 0], ['aNormal', 3, 3], ['aUV', 2, 6], ['aCol', 3, 8], ['aMat', 4, 11], ['aMisc', 3, 15]]);

/**
 * GPU side of one instanced model: a geometry drawing all n instances and one drawing the first
 * ns (the shadow casters, from the low-poly LOD where there is one).
 * @typedef {Object} Model3
 * @property {Float32Array} inst
 * @property {number} n
 * @property {number} ns
 * @property {boolean} caster
 * @property {THREE.BufferGeometry} base
 * @property {THREE.BufferGeometry} shadowBase
 * @property {THREE.InstancedInterleavedBuffer} buf
 * @property {THREE.Mesh} mesh
 * @property {THREE.Mesh} shadow
 */

/**
 * One reusable draw for a per-frame object (character, .glb part, viewmodel): its lit mesh and
 * shadow mesh, each with its own material so their per-object uniforms don't collide.
 * @typedef {{mesh: THREE.Mesh, shadow: THREE.Mesh|null}} Slot
 */

export class Renderer extends RendererBase {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    super(canvas);
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, powerPreference: 'high-performance' });
    r.autoClear = false;
    r.sortObjects = false;
    r.setPixelRatio(1);
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.three = r;
    /** Half-float scene buffer when the GPU can render to it; otherwise 8-bit at half scale. */
    this.hdr = r.extensions.has('EXT_color_buffer_float');
    this.store = this.hdr ? 1 : 0.5;
    this.aniso = Math.min(16, r.capabilities.getMaxAnisotropy());
    this.camera = new THREE.Camera();

    const mats = buildWorldMaterials(buildWorldAtlas());
    /** @param {Uint8Array} data */
    const array = (data) => {
      const t = new THREE.DataArrayTexture(data, mats.size, mats.size, mats.layers);
      return this._repeat(t);
    };
    const detail = this._repeat(new THREE.DataTexture(buildDetailTexture(), mats.size, mats.size));
    /** The 2D sprite atlas, kept for UI icons and dialogue portraits. */
    this.spriteAtlas = buildSpriteAtlas();

    // Sun shadow map: a depth texture with hardware comparison (sampler2DShadow, bilinear PCF).
    const sm = new THREE.DepthTexture(this.shadowSize, this.shadowSize, THREE.UnsignedIntType);
    sm.compareFunction = THREE.LessEqualCompare;
    sm.minFilter = sm.magFilter = THREE.LinearFilter;
    this.shadowRT = new THREE.WebGLRenderTarget(this.shadowSize, this.shadowSize, { depthTexture: sm });
    // Allocate it now: indoors it is never drawn, but every lit shader samples it.
    r.setRenderTarget(this.shadowRT);
    r.clear();
    r.setRenderTarget(null);
    const sceneDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthTexture: sceneDepth,
    });

    // Half-resolution ambient occlusion and quarter-resolution bloom, each ping-ponged by a blur.
    const lin = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.aoA = new THREE.WebGLRenderTarget(1, 1, lin);
    this.aoB = new THREE.WebGLRenderTarget(1, 1, lin);
    const hdrLin = { ...lin, type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType };
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, hdrLin);
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, hdrLin);

    // Uniforms every lit material shares (by reference), and those of the shadow pass.
    /** @type {Uniforms} */
    this.U = {
      uViewProj: { value: new Float32Array(16) }, uTime: { value: 0 }, uWind: { value: 0 },
      uAlbedo: { value: array(mats.albedo) }, uNormal: { value: array(mats.normal) }, uMat: { value: array(mats.mat) }, uDetail: { value: detail },
      uShadowMap: { value: sm }, uShadowMat: { value: this.shadowMat }, uShadowOn: { value: 0 },
      uLightPos: { value: this.lightPos }, uLightCol: { value: this.lightCol }, uLightCount: { value: 0 },
      uEye: { value: [0, 0, 0] }, uFog: { value: [0, 0, 0] }, uZenith: { value: [0, 0, 0] }, uFogDensity: { value: 0 },
      uAmbient: { value: [0, 0, 0] }, uSunDir: { value: [0, 1, 0] }, uSunCol: { value: [0, 0, 0] }, uStore: { value: this.store }, uWet: { value: 0 },
    };
    /** @type {Uniforms} */
    this.S = { uViewProj: { value: new Float32Array(16) }, uTime: this.U.uTime, uWind: this.U.uWind };
    const identBones = new Float32Array(MAX_BONES * 16);
    for (let i = 0; i < MAX_BONES; i++) identBones.set(ident(), i * 16);
    this.identBones = identBones;

    // World chunks and doors: one material, identity bones.
    this.worldMat = this._litMat();
    this.worldDepth = this._depthMat(false);

    this.scene = new THREE.Scene();
    this.shadowScene = new THREE.Scene();
    for (const sc of [this.scene, this.shadowScene]) sc.matrixWorldAutoUpdate = false;
    // Draw order (sortObjects is off): world, characters, viewmodel, .glb NPCs, instanced models,
    // then the blended contact shadows, glows and through-wall markers.
    const group = (/** @type {THREE.Scene} */ sc) => { const g = new THREE.Group(); sc.add(g); return g; };
    this.gChunks = group(this.scene);
    this.gChars = group(this.scene);
    this.gView = group(this.scene);
    this.gGlb = group(this.scene);
    this.gModels = group(this.scene);
    this.gFx = group(this.scene);
    this.sChunks = group(this.shadowScene);
    this.sChars = group(this.shadowScene);
    this.sModels = group(this.shadowScene);

    this.chunkMesh = new Mesh(16384);
    // Doors are rebuilt every frame into one dynamic buffer.
    this.doorBuf = new THREE.InterleavedBuffer(new Float32Array(2048 * VERT), VERT).setUsage(THREE.DynamicDrawUsage);
    this.doorGeo = this._layoutGeo(new THREE.BufferGeometry(), this.doorBuf);
    this.gChunks.add(this._obj(new THREE.Mesh(this.doorGeo, this.worldMat)));
    this.sChunks.add(this._obj(new THREE.Mesh(this.doorGeo, this.worldDepth)));

    /** @type {Map<string, Model3>} */
    this.models = new Map();
    /** Welded rig and viewmodel geometry. @type {Map<string, THREE.BufferGeometry>} */
    this.skinned = new Map();
    /** @type {Slot[]} */ this.charSlots = [];
    /** @type {Slot[]} */ this.glbSlots = [];
    /** @type {Slot[]} */ this.viewSlots = [];
    /** @type {Slot[]} */ this.handSlots = [];
    /** .glb models on the GPU: textures by image index and geometry per part, full and far. */
    /** @type {Map<import('./meshes.js').GlbModel, {tex: THREE.Texture[], parts: THREE.BufferGeometry[], far: THREE.BufferGeometry[]}>} */
    this.glbGpu = new Map();
    this.glbBones = new Float32Array(GLB_BONES * 16);
    this.glbRoot = new Float32Array(16);
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;

    // Effect billboards: contact shadows (alpha blend), glows (additive), markers (no depth test).
    this.fxShadow = this._fxMesh(THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, true, -1);
    this.fxGlow = this._fxMesh(THREE.OneFactor, THREE.OneFactor, true, 0);
    this.fxXray = this._fxMesh(THREE.OneFactor, THREE.OneFactor, false, 0);
    // GPU rain: every drop placed in the vertex shader from its instance id.
    const rg = new THREE.InstancedBufferGeometry();
    rg.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]), 2));
    rg.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    this.rainU = /** @type {Uniforms} */ ({
      uViewProj: this.U.uViewProj, uEye: this.U.uEye, uTime: this.U.uTime, uWind: { value: [0, 0] }, uCamRight: { value: [1, 0] }, uRainCol: { value: [0, 0, 0] }, uStore: this.U.uStore,
    });
    this.rain = this._obj(new THREE.Mesh(rg, this._raw({
      vertexShader: src3(RAIN_VS), fragmentShader: src3(RAIN_FS), uniforms: this.rainU, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    })));
    this.gFx.add(this.rain);

    // Fullscreen passes: a single triangle (the shaders place it from gl_VertexID).
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    /** @param {string} fs @param {Uniforms} uniforms */
    const pass = (fs, uniforms) => {
      const sc = new THREE.Scene();
      sc.add(this._obj(new THREE.Mesh(tri, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: src3(POST_VS), fragmentShader: src3(fs), uniforms, depthTest: false, depthWrite: false,
      }))));
      return sc;
    };
    this.skyU = /** @type {Uniforms} */ ({ uInvViewProj: { value: new Float32Array(16) }, uEye: this.U.uEye, uFog: this.U.uFog, uZenith: this.U.uZenith, uSunDir: this.U.uSunDir, uSunCol: this.U.uSunCol, uStore: this.U.uStore });
    this.skyScene = pass(SKY_FS, this.skyU);
    this.ssaoU = /** @type {Uniforms} */ ({ uDepth: { value: sceneDepth }, uProj: { value: [1, 1] }, uNF: { value: [NEAR, FAR] }, uTexel: { value: [1, 1] } });
    this.ssaoScene = pass(SSAO_FS, this.ssaoU);
    this.aoBlurU = /** @type {Uniforms} */ ({ uAO: { value: null }, uDepth: { value: sceneDepth }, uDir: { value: [0, 0] }, uNF: this.ssaoU.uNF });
    this.aoBlurScene = pass(AO_BLUR_FS, this.aoBlurU);
    this.brightU = /** @type {Uniforms} */ ({ uScene: { value: this.sceneRT.texture }, uTexel: { value: [1, 1] }, uThreshold: { value: 1 }, uStore: this.U.uStore });
    this.brightScene = pass(BRIGHT_FS, this.brightU);
    this.blurU = /** @type {Uniforms} */ ({ uSrc: { value: null }, uDir: { value: [0, 0] } });
    this.blurScene = pass(BLUR_FS, this.blurU);
    this.compU = /** @type {Uniforms} */ ({
      uScene: { value: this.sceneRT.texture }, uBloom: { value: this.bloomA.texture }, uAO: { value: this.aoA.texture }, uRes: { value: [1, 1] },
      uDash: { value: 0 }, uParry: { value: 0 }, uHurt: { value: 0 }, uFlash: { value: 0 }, uTime: this.U.uTime, uStore: this.U.uStore, uExposure: { value: 1 },
    });
    this.compScene = pass(COMPOSITE_FS, this.compU);

    // Build rigs, trees and viewmodels in small steps while the title screen is up.
    /** @type {(() => void)[]} */
    const warm = [];
    for (const n of RIG_NAMES) {
      for (let v = 0; v < (HUMAN_VARIANTS.has(n) ? 2 : 1); v++) warm.push(() => getRig(n, false, v), () => getRig(n, true, v));
    }
    for (const n of ['tree_ley', 'tree_pine', 'tree_dead', 'rock', 'ruin']) for (let k = 0; k < 4; k++) warm.push(() => this._cpuModel(`${n}#${k}`), () => this._cpuModel(`${n}#${k}~`));
    for (const id of ['fork', 'scatter', 'crossbow', 'cast', 'lantern']) warm.push(() => getViewmodel(id, !viewHands.model));
    if (viewHands.model) warm.push(() => this._glbGpu(/** @type {import('./meshes.js').GlbModel} */ (viewHands.model)));
    for (const c of NPC_CHARS.values()) warm.push(() => this._glbGpu(c));
    const step = () => {
      const job = warm.shift();
      if (!job) return;
      job();
      setTimeout(step, 16);
    };
    setTimeout(step, 300);
  }

  /** Mipmapped, anisotropic, repeating, linear-data texture. @template {THREE.Texture} T @param {T} t @returns {T} */
  _repeat(t) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.aniso;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** Objects are placed by their shaders and culled by the game. @template {THREE.Object3D} T @param {T} o @returns {T} */
  _obj(o) {
    o.frustumCulled = false;
    o.matrixAutoUpdate = false;
    return o;
  }

  /** @param {Partial<THREE.ShaderMaterialParameters>} p */
  _raw(p) {
    return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, side: THREE.DoubleSide, ...p });
  }

  /** Lit material for skinned (or static) meshes, with its own per-object uniforms. */
  _litMat() {
    return this._raw({
      vertexShader: src3(MESH_VS), fragmentShader: src3(MESH_FS),
      uniforms: { ...this.U, uBones: { value: this.identBones.slice() }, uSky: { value: 1 }, uTint: { value: WHITE }, uEmit: { value: 1 }, uBase: { value: -1e4 } },
    });
  }

  /** Depth-only material for the shadow pass. @param {boolean} instanced */
  _depthMat(instanced) {
    return this._raw({
      vertexShader: src3(MESH_VS, instanced ? ['INSTANCED'] : []), fragmentShader: src3(DEPTH_FS), colorWrite: false,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
      uniforms: instanced ? { ...this.S } : { ...this.S, uBones: { value: this.identBones.slice() } },
    });
  }

  /** Point the mesh attributes at an interleaved vertex buffer. @param {THREE.BufferGeometry} g @param {THREE.InterleavedBuffer} buf */
  _layoutGeo(g, buf) {
    for (const [name, size, off] of LAYOUT) g.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, size, off));
    return g;
  }

  /** Weld a Mesh into an indexed geometry. @param {Mesh} m */
  _geo(m) {
    const { verts, idx } = weld(m.data, m.n);
    const g = this._layoutGeo(new THREE.BufferGeometry(), new THREE.InterleavedBuffer(verts, VERT));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  /** Instanced copy of a geometry reading (x, y, z, yaw) (scale, sky) (tint, emit) from buf. @param {THREE.BufferGeometry} base @param {THREE.InstancedInterleavedBuffer} buf */
  _instGeo(base, buf) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const [name, a] of Object.entries(base.attributes)) g.setAttribute(name, a);
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.setAttribute('iC', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    g.instanceCount = 0;
    return g;
  }

  /** Instanced model for a key, built on first use. @param {string} key @returns {Model3} */
  _model(key) {
    let g = this.models.get(key);
    if (g) return g;
    const base = this._geo(this._cpuModel(key));
    // Nature props cast shadows from their low-poly LOD: same instances, fewer triangles.
    const shadowBase = !key.endsWith('~') && VARIANTS.has(key.split('#')[0]) ? this._model(`${key}~`).base : base;
    const inst = new Float32Array(64 * INST);
    const buf = new THREE.InstancedInterleavedBuffer(inst, INST).setUsage(THREE.DynamicDrawUsage);
    const mesh = this._obj(new THREE.Mesh(this._instGeo(base, buf), this._raw({ vertexShader: src3(MESH_VS, ['INSTANCED']), fragmentShader: src3(MESH_FS), uniforms: this.U })));
    const shadow = this._obj(new THREE.Mesh(this._instGeo(shadowBase, buf), this._depthMat(true)));
    this.gModels.add(mesh);
    this.sModels.add(shadow);
    g = { inst, n: 0, ns: 0, caster: !key.startsWith('grass'), base, shadowBase, buf, mesh, shadow };
    this.models.set(key, g);
    return g;
  }

  /** Send this frame's instances to their buffers (re-made when a list outgrew its buffer). */
  _uploadModels() {
    for (const g of this.models.values()) {
      if (g.buf.array !== g.inst) {
        g.mesh.geometry.dispose();
        g.shadow.geometry.dispose();
        g.buf = new THREE.InstancedInterleavedBuffer(g.inst, INST).setUsage(THREE.DynamicDrawUsage);
        g.mesh.geometry = this._instGeo(g.base, g.buf);
        g.shadow.geometry = this._instGeo(g.shadowBase, g.buf);
      }
      /** @type {THREE.InstancedBufferGeometry} */ (g.mesh.geometry).instanceCount = g.n;
      /** @type {THREE.InstancedBufferGeometry} */ (g.shadow.geometry).instanceCount = g.caster ? g.ns : 0;
      g.mesh.visible = g.n > 0;
      g.shadow.visible = g.caster && g.ns > 0;
      if (!g.n) continue;
      g.buf.clearUpdateRanges();
      g.buf.addUpdateRange(0, g.n * INST);
      g.buf.needsUpdate = true;
    }
  }

  /**
   * Effect billboards: the shared quad, instanced from a (pos, size) (rgb, mode) list.
   * @param {THREE.BlendingSrcFactor} src @param {THREE.BlendingDstFactor} dst @param {boolean} depthTest @param {number} offset polygon offset
   */
  _fxMesh(src, dst, depthTest, offset) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]), 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(256 * 8), 8).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('iCol', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    if (!this.fxU) this.fxU = /** @type {Uniforms} */ ({ uViewProj: this.U.uViewProj, uCamRight: { value: [1, 0, 0] }, uCamUp: { value: [0, 1, 0] }, uStore: this.U.uStore });
    const m = this._obj(new THREE.Mesh(g, this._raw({
      vertexShader: src3(FX_VS), fragmentShader: src3(FX_FS), uniforms: this.fxU, transparent: true, depthWrite: false, depthTest,
      blending: THREE.CustomBlending, blendSrc: src, blendDst: dst, polygonOffset: offset !== 0, polygonOffsetFactor: offset, polygonOffsetUnits: offset * 4,
    })));
    this.gFx.add(m);
    return m;
  }

  /** Upload one effect list into its billboard mesh. @param {THREE.Mesh} m @param {FloatList} list */
  _fxUpload(m, list) {
    const g = /** @type {THREE.InstancedBufferGeometry} */ (m.geometry);
    const buf = /** @type {THREE.InterleavedBufferAttribute} */ (g.getAttribute('iPos')).data;
    m.visible = list.n > 0;
    if (!list.n) return;
    if (list.n > buf.array.length) {
      g.dispose();
      const nb = new THREE.InstancedInterleavedBuffer(new Float32Array(list.data.length), 8).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(nb, 4, 0));
      g.setAttribute('iCol', new THREE.InterleavedBufferAttribute(nb, 4, 4));
      return this._fxUpload(m, list);
    }
    /** @type {Float32Array} */ (buf.array).set(list.data.subarray(0, list.n));
    buf.clearUpdateRanges();
    buf.addUpdateRange(0, list.n);
    buf.needsUpdate = true;
    g.instanceCount = list.n / 8;
  }

  /** Build and upload one chunk's mesh and clutter. @param {number} key */
  loadChunk(key) {
    if (!this.level || this.chunks.has(key)) return;
    const cx = key % 1024;
    const cz = Math.floor(key / 1024);
    buildChunk(this.level, cx, cz, this.chunkMesh, this.roofMask, this.roofs);
    const geo = this._geo(this.chunkMesh);
    const mesh = this._obj(new THREE.Mesh(geo, this.worldMat));
    const shadow = this._obj(new THREE.Mesh(geo, this.worldDepth));
    this.gChunks.add(mesh);
    this.sChunks.add(shadow);
    this.chunks.set(key, /** @type {any} */ ({ mesh, shadow, cx, cz, ...this._buildClutter(this.level, key, cx, cz) }));
  }

  /** @param {number} key */
  unloadChunk(key) {
    const c = /** @type {any} */ (this.chunks.get(key));
    if (!c) return;
    this.gChunks.remove(c.mesh);
    this.sChunks.remove(c.shadow);
    c.mesh.geometry.dispose();
    this.chunks.delete(key);
  }

  /** Match the drawing buffer to the canvas' CSS size (times DPR and render scale). */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) this.three.setSize(w, h, false);
    if (this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.sceneRT.setSize(w, h);
    for (const t of [this.aoA, this.aoB]) t.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    for (const t of [this.bloomA, this.bloomB]) t.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  /** Rebuild the sliding door panels into the dynamic door buffer. @param {import('./world.js').Door[]} doors @param {number} time */
  _buildDoors(doors, time) {
    this._buildDoorMesh(doors, time);
    const b = this.doorMesh;
    if (b.n > this.doorBuf.array.length) {
      this.doorGeo.dispose();
      this.doorBuf = new THREE.InterleavedBuffer(new Float32Array(b.data.length), VERT).setUsage(THREE.DynamicDrawUsage);
      this._layoutGeo(this.doorGeo, this.doorBuf);
    }
    /** @type {Float32Array} */ (this.doorBuf.array).set(b.data.subarray(0, b.n));
    this.doorBuf.clearUpdateRanges();
    this.doorBuf.addUpdateRange(0, b.n);
    this.doorBuf.needsUpdate = true;
    this.doorGeo.setDrawRange(0, b.count);
  }

  /** Reusable lit + shadow draw @param {Slot[]} pool @param {number} i @param {THREE.Group} lit @param {THREE.Group|null} shadow @param {() => THREE.Material} litMat @param {(() => THREE.Material)|null} shadowMat @returns {Slot} */
  _slot(pool, i, lit, shadow, litMat, shadowMat) {
    let s = pool[i];
    if (!s) {
      s = { mesh: this._obj(new THREE.Mesh(undefined, litMat())), shadow: shadowMat ? this._obj(new THREE.Mesh(undefined, shadowMat())) : null };
      lit.add(s.mesh);
      if (s.shadow && shadow) shadow.add(s.shadow);
      pool[i] = s;
    }
    return s;
  }

  /** Welded geometry for a rig or viewmodel. @param {string} key @param {() => Mesh} make */
  _skinnedGeo(key, make) {
    let g = this.skinned.get(key);
    if (!g) {
      g = this._geo(make());
      this.skinned.set(key, g);
    }
    return g;
  }

  /**
   * Pose the procedural characters: the sculpted rig close up, its LOD far away and in the shadow pass.
   * @param {{s: SpriteDesc, m: ModelDesc}[]} chars @param {{x:number, z:number}} eye @param {boolean} shadows
   */
  _poseChars(chars, eye, shadows) {
    let i = 0;
    for (const { s, m } of chars) {
      if (m.glb) continue;
      const v = m.variant ?? 0;
      const slot = this._slot(this.charSlots, i++, this.gChars, this.sChars, () => this._litMat(), () => this._depthMat(false));
      const far = Math.hypot(s.x - eye.x, s.z - eye.z) > CHAR_LOD_DIST;
      for (const [o, lod] of /** @type {[THREE.Mesh, boolean][]} */ ([[slot.mesh, far], [/** @type {THREE.Mesh} */ (slot.shadow), true]])) {
        const rig = getRig(m.rig, lod, v);
        o.geometry = this._skinnedGeo(`rig:${m.rig}#${v}${lod ? '~' : ''}`, () => rig.mesh);
        const n = poseRig(rig, m, s.x, s.y, s.z, this.bones);
        const u = /** @type {THREE.RawShaderMaterial} */ (o.material).uniforms;
        u.uBones.value.set(this._skin(rig, n));
        if (o === slot.mesh) {
          u.uSky.value = s.sky;
          u.uTint.value = s.tint;
          u.uEmit.value = 1;
          u.uBase.value = s.y;
        }
      }
      slot.mesh.visible = true;
      /** @type {THREE.Mesh} */ (slot.shadow).visible = shadows;
    }
    for (; i < this.charSlots.length; i++) {
      this.charSlots[i].mesh.visible = false;
      /** @type {THREE.Mesh} */ (this.charSlots[i].shadow).visible = false;
    }
  }

  /** Upload a rigged model's textures and per-part geometry. @param {import('./meshes.js').GlbModel} c */
  _glbGpu(c) {
    let g = this.glbGpu.get(c);
    if (g) return g;
    const tex = c.bitmaps.map((bm) => {
      const t = this._repeat(new THREE.Texture(bm));
      t.flipY = false;
      this.three.initTexture(t);
      bm.close();
      return t;
    });
    c.bitmaps = [];
    /** @param {import('./meshes.js').GlbPart} p */
    const geo = (p) => {
      const b = new THREE.BufferGeometry();
      b.setAttribute('aPos', new THREE.BufferAttribute(p.pos, 3));
      b.setAttribute('aNormal', new THREE.BufferAttribute(p.nrm, 3));
      b.setAttribute('aUV', new THREE.BufferAttribute(p.uv, 2));
      const j = new THREE.BufferAttribute(p.joints, 4);
      j.gpuType = THREE.IntType;
      b.setAttribute('aJoints', j);
      b.setAttribute('aWeights', new THREE.BufferAttribute(p.weights, 4));
      b.setIndex(new THREE.BufferAttribute(p.pos.length / 3 <= 65536 ? Uint16Array.from(p.idx) : p.idx, 1));
      b.userData.mat = c.materials[p.mat] ?? null;
      return b;
    };
    g = { tex, parts: c.parts.map(geo), far: c.far.map(geo) };
    this.glbGpu.set(c, g);
    return g;
  }

  _glbMat() {
    const u = { ...this.U };
    delete u.uAlbedo; delete u.uNormal; delete u.uMat;
    return this._raw({
      vertexShader: src3(GLB_VS), fragmentShader: src3(MESH_FS, ['GLB']),
      uniforms: {
        ...u, uBones: { value: new Float32Array(GLB_BONES * 16) }, uUseSkinning: { value: true }, uSky: { value: 1 }, uTint: { value: WHITE },
        uGlbAlbedo: { value: this.white }, uGlbNormal: { value: this.white }, uGlbMR: { value: this.white }, uGlbFactor: { value: [1, 1, 1, 1] }, uGlbMRF: { value: [0, 0.6, 0] },
      },
    });
  }

  /**
   * Per-part uniforms of a .glb material: pose, lighting and the part's own maps.
   * @param {THREE.RawShaderMaterial} m @param {{tex: THREE.Texture[]}} g @param {THREE.BufferGeometry} geo
   * @param {Float32Array} bones @param {boolean} skinned @param {number} sky @param {number[]} tint
   */
  _glbUniforms(m, g, geo, bones, skinned, sky, tint) {
    const u = m.uniforms;
    const mt = geo.userData.mat;
    u.uBones.value.set(bones);
    u.uUseSkinning.value = skinned;
    u.uSky.value = sky;
    u.uTint.value = tint;
    u.uGlbAlbedo.value = g.tex[mt?.base ?? -1] ?? this.white;
    u.uGlbNormal.value = g.tex[mt?.normal ?? -1] ?? this.white;
    u.uGlbMR.value = g.tex[mt?.mr ?? -1] ?? this.white;
    u.uGlbFactor.value = mt?.color ?? [1, 1, 1, 1];
    u.uGlbMRF.value = [mt?.metal ?? 0, mt?.rough ?? 0.6, mt && g.tex[mt.normal] ? 1 : 0];
  }

  _glbDepthMat() {
    return this._raw({
      vertexShader: src3(GLB_VS), fragmentShader: src3(DEPTH_FS), colorWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
      uniforms: { uViewProj: this.S.uViewProj, uBones: { value: new Float32Array(GLB_BONES * 16) }, uUseSkinning: { value: true } },
    });
  }

  /**
   * Pose the rigged .glb characters into part slots: the far LOD at a distance and for shadows.
   * @param {{s: SpriteDesc, m: ModelDesc}[]} chars @param {{x:number, z:number}} eye @param {boolean} shadows
   */
  _poseGlb(chars, eye, shadows) {
    let i = 0;
    for (const { s, m } of chars) {
      if (!m.glb) continue;
      const c = m.glb.model;
      const g = this._glbGpu(c);
      const gaze = m.gaze ?? 0;
      const n = poseGlb(c, m.glb.layers, trs(s.x, s.y, s.z, Math.PI / 2 - m.yaw, 0, 0, m.scale, this.glbRoot), this.glbBones, -(m.look ?? 0) * gaze, -(m.lookUp ?? 0) * gaze);
      const bones = this.glbBones.subarray(0, n * 16);
      const far = Math.hypot(s.x - eye.x, s.z - eye.z) > CHAR_LOD_DIST;
      const lit = far ? g.far : g.parts;
      for (let p = 0; p < Math.max(lit.length, g.far.length); p++) {
        const slot = this._slot(this.glbSlots, i++, this.gGlb, this.sChars, () => this._glbMat(), () => this._glbDepthMat());
        const sh = /** @type {THREE.Mesh} */ (slot.shadow);
        slot.mesh.visible = p < lit.length;
        sh.visible = shadows && p < g.far.length;
        if (slot.mesh.visible) {
          slot.mesh.geometry = lit[p];
          this._glbUniforms(/** @type {THREE.RawShaderMaterial} */ (slot.mesh.material), g, lit[p], bones, c.skinned, s.sky, s.tint);
        }
        if (sh.visible) {
          sh.geometry = g.far[p];
          const u = /** @type {THREE.RawShaderMaterial} */ (sh.material).uniforms;
          u.uBones.value.set(bones);
          u.uUseSkinning.value = c.skinned;
        }
      }
    }
    for (; i < this.glbSlots.length; i++) {
      this.glbSlots[i].mesh.visible = false;
      /** @type {THREE.Mesh} */ (this.glbSlots[i].shadow).visible = false;
    }
  }

  /** First-person items, drawn into the front of the depth range. @param {RenderView} v @param {Float32Array} view @param {number} sky */
  _poseViewmodel(v, view, sky) {
    const parts = v.view ? this._viewmodelParts(v, view) : [];
    const vm = v.view;
    const hands = viewHands.model;
    const hg = hands && this._glbGpu(hands);
    /** @param {THREE.Mesh} o */
    const near = (o) => {
      if (o.userData.near) return;
      // three.js leaves gl.depthRange alone, so the viewmodel can squeeze into the front of it.
      const gl = this.three.getContext();
      o.onBeforeRender = () => gl.depthRange(0, VIEW_DEPTH);
      o.onAfterRender = () => gl.depthRange(0, 1);
      o.userData.near = true;
    };
    let nh = 0;
    parts.forEach(([id, m], i) => {
      const o = this._slot(this.viewSlots, i, this.gView, null, () => this._litMat(), null).mesh;
      near(o);
      o.geometry = this._skinnedGeo(`view:${id}${hands ? '-' : ''}`, () => getViewmodel(id, !hands));
      const u = /** @type {THREE.RawShaderMaterial} */ (o.material).uniforms;
      u.uBones.value.set(m, 0);
      u.uSky.value = sky;
      u.uEmit.value = vm && vm.item === 'cast' ? 1 + vm.cast * 2 : 1;
      o.visible = true;
      // The hand holding it, placed by the same matrix.
      const p = hands ? hands.parts.findIndex((q) => q.name === `hand_${id}`) : -1;
      if (!hands || !hg || p < 0) return;
      const h = this._slot(this.handSlots, nh++, this.gView, null, () => this._glbMat(), null).mesh;
      near(h);
      h.geometry = hg.parts[p];
      this._glbUniforms(/** @type {THREE.RawShaderMaterial} */ (h.material), hg, h.geometry, m, false, sky, WHITE);
      h.visible = true;
    });
    for (let i = parts.length; i < this.viewSlots.length; i++) this.viewSlots[i].mesh.visible = false;
    for (let i = nh; i < this.handSlots.length; i++) this.handSlots[i].mesh.visible = false;
  }

  /** Render one frame. @param {RenderView} v */
  render(v) {
    this.resize();
    const r = this.three;
    const U = this.U;
    const L = this.level;
    const w = this.sceneRT.width;
    const h = this.sceneRT.height;
    const cp = Math.cos(v.pitch);
    const fwd = [Math.cos(v.yaw) * cp, Math.sin(v.pitch), Math.sin(v.yaw) * cp];
    const proj = perspective((70 * Math.PI) / 180, w / h, NEAR, FAR);
    const view = viewMatrix([v.eye.x, v.eye.y, v.eye.z], fwd);
    const viewProj = mul(proj, view);
    const env = v.env;
    const rain = v.weather ? v.weather.rain : 0;
    const wind = v.weather ? v.weather.wind : 0;
    const outdoor = !!(L && L.outdoor);
    const eyeSky = outdoor && L && !L.covered(v.eye.x, v.eye.z) ? 1 : 0;
    const day = Math.min(1, Math.max(0, env.sunCol[1]));
    const zenD = [env.fog[0] * 0.35 + (0.3 - env.fog[0] * 0.35) * day, env.fog[1] * 0.4 + (0.5 - env.fog[1] * 0.4) * day, env.fog[2] * 0.6 + (0.86 - env.fog[2] * 0.6) * day];
    const fog = lin3(env.fog);

    U.uViewProj.value = viewProj;
    U.uTime.value = v.time;
    U.uWind.value = 0.3 + wind;
    U.uLightCount.value = this._packLights(v.lights, v.eye, v.time);
    U.uEye.value = [v.eye.x, v.eye.y, v.eye.z];
    U.uFog.value = fog;
    U.uZenith.value = lin3(zenD);
    U.uFogDensity.value = env.fogDensity;
    U.uAmbient.value = lin3(env.ambient, outdoor ? 2.4 : 3.4);
    U.uSunDir.value = env.sunDir;
    U.uSunCol.value = lin3(env.sunCol, 2.7);
    U.uWet.value = outdoor ? rain : 0;

    const chars = this._gather(v, Math.cos(v.yaw), Math.sin(v.yaw));
    this._uploadModels();
    this._buildDoors(v.doors, v.time);
    const shadows = outdoor && Math.max(...env.sunCol) > 0.02;
    this._poseChars(chars, v.eye, shadows);
    this._poseGlb(chars, v.eye, shadows);
    this._poseViewmodel(v, view, eyeSky);
    this._fxUpload(this.fxShadow, this.shadowList);
    this._fxUpload(this.fxGlow, this.fxList);
    this._fxUpload(this.fxXray, this.xrayList);
    const fx = Math.cos(v.yaw);
    const fz = Math.sin(v.yaw);
    this.fxU.uCamRight.value = [-fz, 0, fx];
    this.fxU.uCamUp.value = [-Math.sin(v.pitch) * fx, Math.cos(v.pitch), -Math.sin(v.pitch) * fz];

    // Sun/moon shadow map.
    U.uShadowOn.value = 0;
    if (shadows) {
      this.S.uViewProj.value = this._shadowViewProj(v, fwd);
      for (const c of /** @type {any[]} */ ([...this.chunks.values()])) c.shadow.visible = Math.hypot((c.cx + 0.5) * CHUNK - v.eye.x, (c.cz + 0.5) * CHUNK - v.eye.z) <= 52;
      r.setRenderTarget(this.shadowRT);
      r.clear(false, true, false);
      r.render(this.shadowScene, this.camera);
      U.uShadowOn.value = 1;
    }

    for (const c of /** @type {any[]} */ ([...this.chunks.values()])) {
      const dx = (c.cx + 0.5) * CHUNK - v.eye.x;
      const dz = (c.cz + 0.5) * CHUNK - v.eye.z;
      const d = Math.hypot(dx, dz);
      c.mesh.visible = !(d > CHUNK * 1.5 && (dx * fx + dz * fz) / d < -0.35);
    }
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(new THREE.Color(fog[0] * this.store, fog[1] * this.store, fog[2] * this.store), 1);
    r.clear(true, true, false);
    if (outdoor) {
      this.skyU.uInvViewProj.value = invert(viewProj);
      r.render(this.skyScene, this.camera);
    }
    const raining = outdoor && L && rain > 0.01 && !L.covered(v.eye.x, v.eye.z);
    this.rain.visible = !!raining;
    if (raining) {
      /** @type {THREE.InstancedBufferGeometry} */ (this.rain.geometry).instanceCount = Math.round(rain * 2400);
      this.rainU.uWind.value = [wind * 2.5, wind * 1.2];
      this.rainU.uCamRight.value = [-fz, fx];
      this.rainU.uRainCol.value = lin3([env.ambient[0] * 1.8 + env.sunCol[0] * 0.3, env.ambient[1] * 1.8 + env.sunCol[1] * 0.3, env.ambient[2] * 2 + env.sunCol[2] * 0.3], 1.2);
    }
    r.render(this.scene, this.camera);

    /** @param {THREE.Scene} sc @param {THREE.WebGLRenderTarget} rt */
    const post = (sc, rt) => {
      r.setRenderTarget(rt);
      r.render(sc, this.camera);
    };
    // SSAO at half resolution, then a depth-aware blur in both directions.
    const aw = this.aoA.width;
    const ah = this.aoA.height;
    this.ssaoU.uProj.value = [proj[0], proj[5]];
    this.ssaoU.uTexel.value = [1 / aw, 1 / ah];
    post(this.ssaoScene, this.aoA);
    this.aoBlurU.uAO.value = this.aoA.texture;
    this.aoBlurU.uDir.value = [1 / aw, 0];
    post(this.aoBlurScene, this.aoB);
    this.aoBlurU.uAO.value = this.aoB.texture;
    this.aoBlurU.uDir.value = [0, 1 / ah];
    post(this.aoBlurScene, this.aoA);
    // Bloom: bright pass to quarter resolution, then a horizontal and a vertical Gaussian.
    this.brightU.uTexel.value = [1 / w, 1 / h];
    post(this.brightScene, this.bloomA);
    this.blurU.uSrc.value = this.bloomA.texture;
    this.blurU.uDir.value = [1 / this.bloomA.width, 0];
    post(this.blurScene, this.bloomB);
    this.blurU.uSrc.value = this.bloomB.texture;
    this.blurU.uDir.value = [0, 1 / this.bloomA.height];
    post(this.blurScene, this.bloomA);

    const cu = this.compU;
    cu.uRes.value = [w, h];
    cu.uDash.value = v.fx.dash;
    cu.uParry.value = v.fx.parry;
    cu.uHurt.value = v.fx.hurt;
    cu.uFlash.value = v.fx.flash ?? 0;
    r.setRenderTarget(null);
    r.render(this.compScene, this.camera);
  }

  /**
   * Head-and-shoulders portrait of a character for the dialogue panel, lit like a lantern-lit study
   * (warm key, cool fill, rim from behind), rendered offscreen at twice the size, then tone-mapped
   * to a transparent PNG. Cached per rig and size.
   * @param {string} rigName @param {number} [size] CSS pixels @param {number} [variant] which look
   * @returns {string} data URL, or '' if it could not be drawn
   */
  portrait(rigName, size = 112, variant = 0) {
    const cacheKey = `${rigName}#${variant}@${size}`;
    const hit = this.portraits.get(cacheKey);
    if (hit !== undefined) return hit;
    const r = this.three;
    const px = size * 2;
    let url = '';
    /** @type {THREE.WebGLRenderTarget|null} */
    let rt = null;
    /** @type {THREE.Material[]} */
    const mats = [];
    try {
      rt = new THREE.WebGLRenderTarget(px, px, { type: this.hdr ? THREE.FloatType : THREE.UnsignedByteType });
      const { glbM, rig, n, fc, eye, vp, t } = this._portraitView(rigName, variant);
      // The shared uniforms are all set again by the next frame.
      const U = this.U;
      const lights = [[-0.62, 0.36, 0.3, 2.2, 1.4, 0.72], [0.62, 0.0, 0.4, 0.2, 0.27, 0.42], [0.25, 0.3, -0.55, 1.3, 1.1, 0.85]];
      lights.forEach((l, i) => {
        this.lightPos.set([fc[0] + l[0], fc[1] + l[1], fc[2] + l[2]], i * 3);
        this.lightCol.set([l[3], l[4], l[5]], i * 3);
      });
      U.uViewProj.value = vp;
      U.uLightCount.value = lights.length;
      U.uEye.value = eye;
      U.uTime.value = t;
      U.uWind.value = 0;
      U.uFog.value = [0, 0, 0];
      U.uZenith.value = [0, 0, 0];
      U.uFogDensity.value = 0;
      U.uAmbient.value = [0.05, 0.05, 0.065];
      U.uSunDir.value = [0, 1, 0];
      U.uSunCol.value = [0, 0, 0];
      U.uWet.value = 0;
      U.uShadowOn.value = 0;
      const scene = new THREE.Scene();
      if (glbM) {
        const g = this._glbGpu(glbM);
        for (const geo of g.parts) {
          const m = this._glbMat();
          this._glbUniforms(m, g, geo, this.glbBones.subarray(0, n * 16), glbM.skinned, 0, WHITE);
          mats.push(m);
          scene.add(this._obj(new THREE.Mesh(geo, m)));
        }
      } else {
        const m = this._litMat();
        m.uniforms.uBones.value.set(this._skin(rig, n));
        m.uniforms.uSky.value = 0;
        m.uniforms.uBase.value = 0;
        mats.push(m);
        scene.add(this._obj(new THREE.Mesh(this._skinnedGeo(`rig:${rigName}#${variant}`, () => rig.mesh), m)));
      }
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(scene, this.camera);
      const raw = this.hdr ? new Float32Array(px * px * 4) : new Uint8Array(px * px * 4);
      r.readRenderTargetPixels(rt, 0, 0, px, px, raw);
      url = this._portraitPng(raw, px, size, this.hdr);
    } catch (err) {
      console.warn('Portrait unavailable:', err);
      url = '';
    } finally {
      r.setRenderTarget(null);
      rt?.dispose();
      for (const m of mats) m.dispose();
    }
    this.portraits.set(cacheKey, url);
    return url;
  }
}
