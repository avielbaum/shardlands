/**
 * @file Raw WebGL 2.0 renderer (GLSL ES 3.00), physically based and linear-light.
 * World tiles sample 512px texture-array PBR layers (albedo, tangent-space normal,
 * roughness/specular/cavity/metal). Props, foliage, architecture and items are true 3D meshes
 * (models.js), hardware-instanced per model with CPU distance/facing culling and a far LOD;
 * characters are skinned to up to 16 bones per draw, and rigged .glb NPCs (meshes.js) to up to
 * 32 joints at 4 weights per vertex with their own baked PBR maps. Shading is Cook-Torrance (GGX, Smith,
 * Schlick) for the sun/moon and 16 point lights, plus hemisphere sky/ground ambient and a
 * split-sum environment approximation. A 2048px directional shadow map (DEPTH_COMPONENT24,
 * 3x3 hardware PCF) grounds everything outdoors; SSAO (half-res, bilateral blur) darkens
 * creases indoors and out. Exponential distance fog plus analytic height mist with drifting
 * density, GPU rain, bloom, FXAA, ACES filmic tone mapping and grading finish the frame.
 */
import { buildWorldAtlas, buildSpriteAtlas, buildWorldMaterials, buildDetailTexture, uploadArray, uploadRepeating, SPRITE_NAMES, CHAR_LAYER } from './textures.js';
import { TILE, CHUNK, Level, hash2 } from './world.js';
import {
  Mesh, VERT, MAX_BONES, ident, mul, trs, buildModel, hasModel, nominalSize, isItemModel, VARIANTS, grassTuft, buildRoof,
  buildDoorFrame, getRig, poseRig, getViewmodel, RIG_NAMES,
} from './models.js';
import { NPC_CHARS, GLB_BONES, poseGlb } from './meshes.js';

/** Townsfolk rigs that come in two looks (constructs and the Archivist have one). */
const HUMAN_VARIANTS = new Set(['folk_a', 'folk_b', 'folk_c', 'merchant', 'guard', 'master', 'keeper', 'captain']);

/** @typedef {import('./world.js').Door} Door */
/** @typedef {import('./world.js').Light} Light */
/** @typedef {import('./world.js').Prop} Prop */
/** @typedef {import('./models.js').ModelDesc} ModelDesc */
/**
 * A rigged .glb model on the GPU: its textures (by image index) and one VAO per part.
 * @typedef {{tex: WebGLTexture[], parts: {vao: WebGLVertexArrayObject, count: number, itype: number, mat: import('./meshes.js').GlbMaterial|null}[]}} GlbGPU
 */
/**
 * @typedef {Object} SpriteDesc
 * @property {number} x
 * @property {number} y bottom edge height
 * @property {number} z
 * @property {number} w
 * @property {number} h
 * @property {number} frame sprite frame: picks the prop/item model or the effect colour
 * @property {number} emit 0 none, 1 glowing parts lit, 2 fully emissive effect
 * @property {number[]} tint
 * @property {number} sky 1 under open sky, 0 under a roof
 * @property {ModelDesc} [model] articulated character to draw instead of a prop
 * @property {boolean} [xray] glow marker drawn through walls (Astral Sight)
 */
/**
 * @typedef {Object} Env
 * @property {number[]} fog
 * @property {number} fogDensity
 * @property {number[]} ambient
 * @property {number[]} sunDir unit vector toward the sun (or moon)
 * @property {number[]} sunCol
 */
/**
 * First-person viewmodel state.
 * @typedef {Object} ViewDesc
 * @property {string|null} item fork | scatter | crossbow | cast | null
 * @property {number} swing melee swing remaining, 0..1
 * @property {number} recoil 0..1
 * @property {number} cast casting push, 0..1
 * @property {boolean} block
 * @property {number} bob walk bob phase
 * @property {boolean} lantern lantern in the off hand
 */
/**
 * @typedef {Object} RenderView
 * @property {{x:number, y:number, z:number}} eye
 * @property {number} yaw
 * @property {number} pitch
 * @property {number} time
 * @property {SpriteDesc[]} sprites
 * @property {Light[]} lights
 * @property {Door[]} doors
 * @property {{dash:number, parry:number, hurt:number, flash?:number}} fx flash = lightning
 * @property {Env} env
 * @property {{rain:number, wind:number}} [weather] 0..1 each
 * @property {ViewDesc} [view]
 */

const MAX_LIGHTS = 16;
const NEAR = 0.05;
const FAR = 140;
/** Floats per model instance: (x, y, z, yaw) (scale, sky, -, -) (tint rgb, emission). */
const INST = 12;
/** Beyond this distance nature props switch to their low-poly LOD. */
const LOD_DIST = 20;
/** Props within this distance of the eye are drawn into the shadow map. */
const SHADOW_REACH = 40;
/** Characters beyond this distance use their low-poly rig. */
const CHAR_LOD_DIST = 16;
/** Grass tufts are drawn within this radius. */
const GRASS_DIST = 28;
/** Viewmodels are squeezed into the front of the depth range so they never clip into walls. */
const VIEW_DEPTH = 0.05;
const WHITE = [1, 1, 1];
const FULL_UV = [0, 0, 1, 1];

/** Vertex shader for every lit mesh: skinned (uBones) or, with INSTANCED, placed per instance. */
const MESH_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec3 aCol;
layout(location=4) in vec4 aMat;
layout(location=5) in vec3 aMisc;
#ifdef INSTANCED
layout(location=6) in vec4 iA;
layout(location=7) in vec4 iB;
layout(location=8) in vec4 iC;
#else
uniform mat4 uBones[${MAX_BONES}];
uniform float uSky;
uniform vec3 uTint;
uniform float uEmit;
uniform float uBase;
#endif
uniform mat4 uViewProj;
uniform float uTime;
uniform float uWind;
out vec3 vPos; out vec3 vNormal; out vec2 vUV; out vec3 vCol; out vec4 vMat; out float vSky; out vec4 vTintEmit;
out vec3 vObj; out float vH;
void main() {
#ifdef INSTANCED
  float c = cos(iA.w), s = sin(iA.w);
  vec3 lp = aPos * iB.x;
  vec4 wp = vec4(c * lp.x + s * lp.z + iA.x, lp.y + iA.y, -s * lp.x + c * lp.z + iA.z, 1.0);
  vNormal = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);
  vSky = iB.y;
  vTintEmit = iC;
  vH = wp.y - iA.y;
#else
  // Bone slot packs the main bone, a second bone (x16) and its weight (x256, 0..255).
  int bi = int(aMisc.y + 0.5);
  float bw = float(bi >> 8) / 255.0;
  mat4 B = uBones[bi & 15] * (1.0 - bw) + uBones[(bi >> 4) & 15] * bw;
  vec4 wp = B * vec4(aPos, 1.0);
  vNormal = mat3(B) * aNormal;
  vSky = aMisc.x * uSky;
  vTintEmit = vec4(uTint, uEmit);
  vH = wp.y - uBase;
#endif
  vObj = aPos;
  // Wind sway for foliage, cloth and flames (weight per vertex).
  if (aMisc.z > 0.0) {
    float ph = uTime * 1.9 + wp.x * 0.7 + wp.z * 0.9;
    wp.xz += vec2(sin(ph) + 0.4 * sin(ph * 2.7), cos(ph * 0.8)) * aMisc.z * uWind * 0.07;
  }
  vPos = wp.xyz; vUV = aUV; vCol = aCol; vMat = aMat;
  gl_Position = uViewProj * wp;
}`;

/**
 * Vertex shader for rigged .glb models: 4 joints and weights per vertex (uUseSkinning), or one
 * placement matrix in uBones[0] for a static model. Feeds the same varyings as MESH_VS.
 */
const GLB_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in uvec4 aJoints;
layout(location=4) in vec4 aWeights;
uniform mat4 uBones[${GLB_BONES}];
uniform bool uUseSkinning;
uniform mat4 uViewProj;
uniform float uSky;
uniform vec3 uTint;
out vec3 vPos; out vec3 vNormal; out vec2 vUV; out vec3 vCol; out vec4 vMat; out float vSky; out vec4 vTintEmit;
out vec3 vObj; out float vH;
void main() {
  mat4 B = uBones[0];
  if (uUseSkinning) B = uBones[aJoints.x] * aWeights.x + uBones[aJoints.y] * aWeights.y + uBones[aJoints.z] * aWeights.z + uBones[aJoints.w] * aWeights.w;
  vec4 wp = B * vec4(aPos, 1.0);
  vNormal = mat3(B) * aNormal;
  vPos = wp.xyz; vUV = aUV; vCol = vec3(1.0); vMat = vec4(0.0); vSky = uSky;
  // vH (height above the feet, for ground grime) is unread by the GLB material block. Keep it a
  // constant: a uniform feeding it is optimised out by mobile drivers and fails the uniform check.
  vTintEmit = vec4(uTint, 0.0); vObj = aPos; vH = 0.0;
  gl_Position = uViewProj * wp;
}`;

const DEPTH_FS = `
precision mediump float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

const MESH_FS = `
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;
#define MAX_LIGHTS ${MAX_LIGHTS}
#define PI 3.14159265
in vec3 vPos; in vec3 vNormal; in vec2 vUV; in vec3 vCol; in vec4 vMat; in float vSky; in vec4 vTintEmit; in vec3 vObj; in float vH;
uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormal;
uniform sampler2DArray uMat;
uniform sampler2D uDetail;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMat;
uniform float uShadowOn;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightCol[MAX_LIGHTS];
uniform int uLightCount;
uniform vec3 uEye;
uniform float uTime;
uniform vec3 uFog;
uniform vec3 uZenith;
uniform float uFogDensity;
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uStore;
uniform float uWet;
#ifdef GLB
uniform sampler2D uGlbAlbedo;
uniform sampler2D uGlbNormal;
uniform sampler2D uGlbMR;
uniform vec4 uGlbFactor;
uniform vec3 uGlbMRF;
#endif
out vec4 outColor;

vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

// Normal mapping without tangent attributes: cotangent frame from screen derivatives.
vec3 perturb(vec3 N, vec3 p, vec2 uv, vec3 tn) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 du1 = dFdx(uv);
  vec2 du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float m = max(dot(T, T), dot(B, B));
  if (m < 1e-12) return N;
  float inv = inversesqrt(m);
  return normalize(mat3(T * inv, B * inv, N) * tn);
}

// Bump mapping from a scalar height (Mikkelsen's surface gradient), for plain-colour meshes.
vec3 bump(vec3 N, vec3 p, float h, float k) {
  vec3 dpx = dFdx(p);
  vec3 dpy = dFdy(p);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * N - k * g);
}

float distFog(float d) { return 1.0 - exp(-pow(d * uFogDensity, 2.0)); }

// Exponential distance fog plus analytic height mist whose density drifts with world-space noise.
float fogAmount(float d, vec3 p) {
  float f = distFog(d);
  const float b = 0.3;
  float dy = p.y - uEye.y;
  float hInt = abs(dy) > 0.02 ? (1.0 - exp(-b * dy)) / (b * dy) : 1.0;
  float drift = texture(uDetail, p.xz * 0.013 + vec2(uTime * 0.004, uTime * 0.0027)).g;
  float mist = 1.0 - exp(-uFogDensity * 0.9 * d * hInt * (0.55 + drift * 0.9));
  // Fully fogged by the streaming radius, so distant chunks and the world-edge cliffs never pop.
  return max(clamp(f + mist * (1.0 - f) * 0.6, 0.0, 1.0), smoothstep(44.0, 62.0, d));
}

vec3 fogColor(vec3 dir) {
  return uFog + uSunCol * pow(max(dot(dir, uSunDir), 0.0), 8.0) * 0.12;
}

float shadowAt(vec3 p, vec3 N, float ndl) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 s = uShadowMat * vec4(p + N * (0.03 + 0.07 * (1.0 - ndl)), 1.0);
  vec3 c = s.xyz;
  if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float ts = 1.0 / float(textureSize(uShadowMap, 0).x);
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) sum += texture(uShadowMap, vec3(c.xy + vec2(x, y) * ts * 1.3, c.z - 0.0006));
  vec2 e = smoothstep(0.0, 0.08, c.xy) * smoothstep(1.0, 0.92, c.xy);
  return mix(1.0, sum / 9.0, e.x * e.y);
}

// Split-sum environment BRDF, analytic fit (Karis).
vec3 envBRDF(vec3 F0, float r, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r4 = r * c0 + c1;
  float a004 = min(r4.x * r4.x, exp2(-9.28 * NoV)) * r4.x + r4.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r4.zw;
  return F0 * AB.x + AB.y;
}

// Cook-Torrance: GGX distribution, Smith-Schlick visibility, Schlick Fresnel; Lambert diffuse.
// wrap > 0 marks organic matter (skin, cloth, leaves): light bleeds past the terminator, warmed
// as if scattered beneath the surface, and thin parts glow faintly when backlit.
// sss (skin) widens the red channel's wrap and warms the bleed toward haemoglobin red where the
// surface curves tightly (ears, nostrils, lids), the way pre-integrated skin shading does.
vec3 shade(vec3 N, vec3 V, vec3 L, vec3 diff, vec3 F0, float rough, float wrap, float sss) {
  vec3 H = normalize(L + V);
  float NoLr = dot(N, L);
  float NoL = max(NoLr, 0.0);
  float NoV = max(dot(N, V), 1e-3);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float a = rough * rough;
  float a2 = a * a;
  float dd = NoH * NoH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = a * 0.5;
  float Vis = 0.25 / ((NoV * (1.0 - k) + k) * (NoL * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
  float wrapped = max((NoLr + wrap) / (1.0 + wrap), 0.0);
  float wr = wrap * (1.0 + sss);
  float wrappedR = max((NoLr + wr) / (1.0 + wr), 0.0);
  vec3 bc = mix(vec3(1.0, 0.62, 0.48), vec3(1.0, 0.34, 0.22), sss);
  vec3 bleed = diff * max(vec3(wrappedR, wrapped, wrapped) - NoL, 0.0) * bc;
  vec3 trans = diff * pow(max(dot(-V, L), 0.0), 6.0) * wrap * (0.5 + sss) * mix(vec3(1.0), bc, sss);
  return (diff * (1.0 - F) + PI * D * Vis * F) * NoL + bleed + trans;
}

void main() {
  vec3 toEye = uEye - vPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-4);
  vec3 N = normalize(vNormal);
  float layer = vMat.x;
  vec3 albedo;
  float rough;
  float metal;
  float specK = 1.0;
  float cav = 1.0;
  float wrap = 0.0;
  vec3 emission = vec3(0.0);
  float water = 0.0;
  float sheen = 0.0;
  float sss = 0.0;
  // Character layers (wool, skin, leather, hair) live on moving, two-sided cloth and bodies.
  bool charL = layer > ${CHAR_LAYER.WOOL - 0.5};
#ifdef GLB
  // Rigged .glb character with its own baked maps (glTF: G roughness, B metal; +Y-up normal map,
  // whose green flips for the cotangent frame). One material covers skin and clothes, so skin is
  // told by hue: it gets subsurface scattering that rises with curvature, everything organic
  // keeps the 0.45 light wrap, and fabric gets the grazing fibre sheen.
  if (dot(N, V) < 0.0) N = -N;
  vec3 texel = texture(uGlbAlbedo, vUV).rgb * uGlbFactor.rgb;
  vec4 mr = texture(uGlbMR, vUV);
  rough = clamp(mr.g * uGlbMRF.y, 0.04, 1.0);
  metal = clamp(mr.b * uGlbMRF.x, 0.0, 1.0);
  if (uGlbMRF.z > 0.5) {
    vec3 tn = texture(uGlbNormal, vUV).xyz * 2.0 - 1.0;
    N = perturb(N, vPos, vUV, vec3(tn.x, -tn.y, tn.z));
  }
  albedo = lin(texel);
  float sat = (texel.r - texel.b) / max(texel.r, 1e-3);
  // Soft thresholds: a hard cut flips neighbouring texels of brown cloth between skin and cloth.
  float skin = smoothstep(0.0, 0.04, texel.g - texel.b) * smoothstep(0.0, 0.04, texel.r - texel.g) * smoothstep(0.1, 0.2, sat) * smoothstep(0.75, 0.6, sat) * smoothstep(0.3, 0.5, texel.r) * (1.0 - metal);
  float curv = length(fwidth(normalize(vNormal))) / max(length(fwidth(vPos)), 1e-5);
  sss = skin * clamp(0.3 + curv * 0.009, 0.3, 1.0);
  wrap = 0.45 * (1.0 - metal);
  sheen = 0.45 * (1.0 - skin) * (1.0 - metal);
  rough = mix(rough, clamp(rough, 0.52, 0.65), skin);
#else
  if (layer >= 0.0) {
    if (charL && dot(N, V) < 0.0) N = -N;
    vec2 uv = vUV;
    if (vMat.w > 2.5) { uv += vec2(uTime * 0.035, uTime * 0.021); water = 1.0; }
    vec3 suv = vec3(uv, layer);
    vec3 texel = texture(uAlbedo, suv).rgb;
    vec4 nm = texture(uNormal, suv);
    vec4 mm = texture(uMat, suv);
    rough = mm.r;
    specK = 0.4 + mm.g * 1.6;
    cav = mm.b;
    metal = mm.a;
    N = perturb(N, vPos, uv, nm.xyz * 2.0 - 1.0);
    if (layer > ${CHAR_LAYER.EYE - 0.5}) {
      // Eyes: their own colour and lid shadow, a wet cornea (very low roughness) for catchlights.
      albedo = lin(texel) * vCol;
      wrap = 0.08;
    } else if (layer > ${CHAR_LAYER.SKIN - 0.5} && layer < ${CHAR_LAYER.SKIN + 0.5}) {
      // Skin: isotropic pores and blotches from its own layer (no cloth grunge), subsurface wrap,
      // and scattering that rises with curvature (normal change per metre across the pixel).
      albedo = lin(texel) * vCol;
      float curv = length(fwidth(normalize(vNormal))) / max(length(fwidth(vPos)), 1e-5);
      sss = clamp(0.3 + curv * 0.009, 0.3, 1.0);
      wrap = 0.45;
      rough = clamp(rough, 0.52, 0.65);
    } else if (charL) {
      // Object-space triplanar grunge (sticks to the moving body), dirt climbing the hems and
      // boots, and per-material light wrap: felted wool and skin scatter, leather barely does.
      vec3 w3 = pow(abs(normalize(vNormal)), vec3(4.0));
      w3 /= dot(w3, vec3(1.0));
      vec3 p1 = vObj * 5.0;
      vec4 dd = texture(uDetail, p1.yz) * w3.x + texture(uDetail, p1.xz) * w3.y + texture(uDetail, p1.xy) * w3.z;
      albedo = lin(texel) * (0.88 + dd.g * 0.24) * vCol;
      float grime = clamp(smoothstep(0.5, 0.0, vH) * 0.75 + (dd.g - 0.7) * 0.45, 0.0, 1.0);
      albedo = mix(albedo, albedo * vec3(0.55, 0.47, 0.39), grime * 0.55);
      rough = clamp(rough + (dd.b - 0.5) * 0.12 + grime * 0.1, 0.05, 1.0);
      wrap = layer < ${CHAR_LAYER.SKIN - 0.5} ? 0.5 : (layer < ${CHAR_LAYER.LEATHER - 0.5} ? 0.42 : (layer < ${CHAR_LAYER.HAIR - 0.5} ? 0.18 : 0.3));
      sheen = layer < ${CHAR_LAYER.SKIN - 0.5} ? 0.55 : (layer > ${CHAR_LAYER.HAIR - 0.5} ? 0.25 : 0.0);
    } else {
      // World-space detail grunge, projected on the dominant axis, hides tiling.
      vec3 an = abs(vNormal);
      vec2 duv = an.y > 0.7 ? vPos.xz : (an.x > an.z ? vPos.zy : vPos.xy);
      vec3 d1 = texture(uDetail, duv * 0.23).rgb;
      vec3 d2 = texture(uDetail, duv * 0.047).rgb;
      albedo = lin(texel) * (1.0 + (d1.r - 0.5) * 0.22) * (1.0 + (d2.g - 0.5) * 0.3) * vCol;
      rough = clamp(rough + (d1.b - 0.5) * 0.18, 0.04, 1.0);
    }
    if (vMat.w > 0.5 && vMat.w < 2.5) {
      // Cyan-dominant or near-white texels glow; stone, steel and brass highlights do not.
      float mask = vMat.w > 1.5 ? 1.0 : clamp(smoothstep(0.2, 0.45, max(texel.g, texel.b) - texel.r) + smoothstep(0.9, 0.98, min(texel.r, min(texel.g, texel.b))), 0.0, 1.0);
      float pulse = 0.75 + 0.25 * sin(uTime * 2.5 + vPos.x * 0.7 + vPos.z * 0.5 - vPos.y * 3.0);
      emission = lin(texel) * mask * pulse * 2.4;
    }
  } else {
    // Plain-colour mesh material. Object-space triplanar micro-relief (so it sticks to moving
    // parts): a coarse grain plus a fine weave/pore layer, bump-mapped, never smooth plastic.
    if (dot(N, V) < 0.0) N = -N;
    vec3 w3 = pow(abs(N), vec3(4.0));
    w3 /= dot(w3, vec3(1.0));
    vec3 p1 = vObj * 6.0;
    vec4 d = texture(uDetail, p1.yz) * w3.x + texture(uDetail, p1.xz) * w3.y + texture(uDetail, p1.xy) * w3.z;
    vec3 p2 = vObj * 21.0;
    float fine = texture(uDetail, p2.yz).r * w3.x + texture(uDetail, p2.xz).r * w3.y + texture(uDetail, p2.xy).r * w3.z;
    metal = vMat.z;
    N = bump(N, vPos, d.r * 0.55 + fine * 0.45, (0.005 + vMat.y * 0.012) * (1.0 - metal * 0.55));
    albedo = lin(vCol) * (0.84 + d.g * 0.32);
    // Grime gathers near the ground (boots, hems, trunk bases) and in broad blotches.
    float grime = clamp(smoothstep(0.55, 0.0, vH) * 0.7 + (d.g - 0.55) * 0.7, 0.0, 1.0) * step(vMat.w, 0.0);
    albedo = mix(albedo, albedo * vec3(0.52, 0.45, 0.37), grime * 0.6);
    rough = clamp(vMat.y + (d.b - 0.5) * 0.16 + grime * 0.15, 0.05, 1.0);
    wrap = metal < 0.2 && vMat.y > 0.45 ? 0.45 : 0.0;
    emission = lin(vCol) * vMat.w * vTintEmit.w * (0.9 + 0.1 * sin(uTime * 6.0 + vPos.y * 9.0));
  }
#endif
  albedo *= vTintEmit.rgb;
  emission *= vTintEmit.rgb;

  // Rain darkens and polishes open, upward-facing surfaces.
  float wet = uWet * vSky * smoothstep(0.55, 0.95, N.y);
  albedo *= 1.0 - 0.35 * wet;
  rough = mix(rough, 0.1, wet * 0.85);

  vec3 diff = albedo * (1.0 - metal);
  vec3 F0 = mix(vec3(0.04 * specK), albedo, metal);
  float NoV = max(dot(N, V), 1e-3);

  // Hemisphere ambient: sky above, warm bounce from the ground below.
  vec3 groundA = uAmbient * vec3(0.62, 0.55, 0.47);
  vec3 hemi = mix(groundA, uAmbient, N.y * 0.5 + 0.5) * mix(0.7, 1.0, vSky);
  vec3 R = reflect(-V, N);
  vec3 env = mix(groundA * 0.7, mix(uFog, uZenith, smoothstep(0.0, 0.6, R.y)), smoothstep(-0.25, 0.15, R.y));
  env = mix(uAmbient * 1.4, env, vSky);
  vec3 col = (diff * hemi + env * envBRDF(F0, rough, NoV)) * cav;
  // Grazing Fresnel rim on worn metal, glass and wet or polished surfaces.
  col += env * pow(1.0 - NoV, 5.0) * (metal * 0.5 + (1.0 - rough) * 0.35) * cav;
  // Fibre sheen: wool and hair catch soft light along their silhouettes.
  col += diff * (hemi + uSunCol * vSky * 0.25) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * sheen * cav;

  if (vSky > 0.0) {
    float ndl = dot(N, uSunDir);
    if (ndl > -wrap * (1.0 + sss)) col += shade(N, V, uSunDir, diff, F0, rough, wrap, sss) * uSunCol * shadowAt(vPos, N, max(ndl, 0.0)) * vSky;
  }
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 L = uLightPos[i] - vPos;
    float d2 = dot(L, L);
    if (d2 > 256.0) continue;
    float d = sqrt(d2);
    vec3 Ld = L / max(d, 1e-4);
    float win = clamp(1.0 - d2 * d2 / 65536.0, 0.0, 1.0);
    float att = win * win / (1.0 + 0.3 * d2);
    col += (shade(N, V, Ld, diff, F0, max(rough, 0.07), wrap, sss) + diff * 0.06) * uLightCol[i] * att;
  }
  if (water > 0.0) {
    float fres = pow(1.0 - NoV, 4.0);
    col = mix(col, fogColor(-V) * 1.05, fres * 0.65);
  }
  col += emission;
  col = mix(col, fogColor(-V), fogAmount(dist, vPos));
  outColor = vec4(col * uStore, 1.0);
}`;

const POST_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Glow sprites for effects (orbs, bolts, sparks) and soft contact shadows under characters.
const FX_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPos;
layout(location=2) in vec4 iCol;
uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
out vec2 vC; out vec4 vCol;
void main() {
  vec2 c = vec2(aCorner.x * 2.0, aCorner.y * 2.0 - 1.0);
  vec3 p = iCol.w > 0.5 ? iPos.xyz + vec3(c.x, 0.0, c.y) * iPos.w + vec3(0.0, 0.03, 0.0)
                        : iPos.xyz + (uCamRight * c.x + uCamUp * c.y) * iPos.w * 0.5;
  vC = c; vCol = iCol;
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const FX_FS = `#version 300 es
precision highp float;
in vec2 vC; in vec4 vCol;
uniform float uStore;
out vec4 outColor;
void main() {
  float r2 = dot(vC, vC);
  if (vCol.w > 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(0.15, 1.0, r2)) * 0.5);
    return;
  }
  float g = exp(-r2 * 5.0) + exp(-r2 * 40.0) * 1.5;
  outColor = vec4(vCol.rgb * g * uStore, 0.0);
}`;

// GPU rain: drops are anchored in world space and wrapped in a box around the eye, so no
// CPU work per drop; each instance id hashes to its own column, phase and speed.
const RAIN_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uTime;
uniform vec2 uWind;
uniform vec2 uCamRight;
out vec2 vC;
out float vDist;
float h(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float id = float(gl_InstanceID);
  const float box = 26.0;
  const float tall = 14.0;
  float fx = h(id + 0.13);
  float fz = h(id + 7.31);
  float fy = h(id + 3.77);
  float y = uEye.y + 7.0 - mod(uTime * (11.0 + fy * 4.0) + fy * tall, tall);
  float x = uEye.x - box * 0.5 + mod(fx * box - uEye.x + box * 0.5, box);
  float z = uEye.z - box * 0.5 + mod(fz * box - uEye.z + box * 0.5, box);
  vec3 p = vec3(x, y, z) + vec3(uWind.x * 0.06, 0.55, uWind.y * 0.06) * aCorner.y + vec3(uCamRight.x, 0.0, uCamRight.y) * aCorner.x * 0.035;
  vC = vec2(aCorner.x + 0.5, aCorner.y);
  vDist = length(p - uEye);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const RAIN_FS = `#version 300 es
precision highp float;
in vec2 vC;
in float vDist;
uniform vec3 uRainCol;
uniform float uStore;
out vec4 outColor;
void main() {
  float a = (1.0 - abs(vC.x * 2.0 - 1.0)) * smoothstep(0.0, 0.35, vC.y) * 0.4 * smoothstep(13.0, 3.0, vDist);
  outColor = vec4(uRainCol * uStore, a);
}`;

// Outdoor sky: horizon haze up to a time-of-day zenith, with a sun (or moon) disc and glow.
const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec3 uFog;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uStore;
out vec4 outColor;
void main() {
  vec4 p = uInvViewProj * vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w - uEye);
  float up = clamp(dir.y * 2.2, 0.0, 1.0);
  vec3 col = mix(uFog, uZenith, pow(up, 0.75));
  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunCol * (smoothstep(0.99965, 0.9998, s) * 6.0 + pow(s, 28.0) * 0.22);
  outColor = vec4(col * uStore, 1.0);
}`;

// Screen-space ambient occlusion from the scene depth: 12 hemisphere taps per pixel.
const SSAO_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform highp sampler2D uDepth;
uniform vec2 uProj;
uniform vec2 uNF;
uniform vec2 uTexel;
out vec4 outColor;
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - z * (uNF.y - uNF.x)); }
vec3 vpos(vec2 uv) { float z = linZ(texture(uDepth, uv).r); return vec3((uv * 2.0 - 1.0) / uProj * z, -z); }
void main() {
  float d = texture(uDepth, vUV).r;
  if (d >= 0.99999 || d < ${VIEW_DEPTH.toFixed(3)} + 0.001) { outColor = vec4(1.0); return; }
  vec3 P = vpos(vUV);
  vec3 Pr = vpos(vUV + vec2(uTexel.x, 0.0)), Pl = vpos(vUV - vec2(uTexel.x, 0.0));
  vec3 Pu = vpos(vUV + vec2(0.0, uTexel.y)), Pd = vpos(vUV - vec2(0.0, uTexel.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, -P) < 0.0) N = -N;
  vec3 T = normalize(cross(abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), N));
  vec3 Bt = cross(N, T);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  const float radius = 0.6;
  float occ = 0.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = (fi + noise) * 2.39996;
    float r = sqrt((fi + 0.5) / 12.0);
    vec3 h = vec3(cos(a) * r, sin(a) * r, sqrt(max(0.0, 1.0 - r * r)));
    vec3 S = P + (T * h.x + Bt * h.y + N * h.z) * radius * mix(0.25, 1.0, fract(fi * 0.618 + noise));
    vec2 suv = (S.xy / -S.z) * uProj * 0.5 + 0.5;
    float sz = -linZ(texture(uDepth, suv).r);
    float range = smoothstep(0.0, 1.0, radius / max(abs(P.z - sz), 1e-3));
    occ += (sz >= S.z + 0.025 ? 1.0 : 0.0) * range;
  }
  float ao = 1.0 - occ / 12.0;
  ao = mix(1.0, ao, smoothstep(50.0, 25.0, -P.z));
  outColor = vec4(ao, ao, ao, 1.0);
}`;

// Depth-aware separable blur so occlusion stays inside its own surface.
const AO_BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uAO;
uniform highp sampler2D uDepth;
uniform vec2 uDir;
uniform vec2 uNF;
out vec4 outColor;
float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - z * (uNF.y - uNF.x)); }
void main() {
  float z0 = linZ(texture(uDepth, vUV).r);
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUV + uDir * float(i);
    float w = exp(-float(i * i) * 0.18) * exp(-abs(linZ(texture(uDepth, uv).r) - z0) * 6.0 / max(z0 * 0.1, 0.05));
    sum += texture(uAO, uv).r * w;
    wsum += w;
  }
  float ao = sum / max(wsum, 1e-4);
  outColor = vec4(ao, ao, ao, 1.0);
}`;

// Soft-knee bright pass, downsampling the scene with a 4-tap box filter.
const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uStore;
out vec4 outColor;
void main() {
  vec3 c = vec3(0.0);
  c += texture(uScene, vUV + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uScene, vUV + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uScene, vUV + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uScene, vUV + uTexel * vec2(1.0, 1.0)).rgb;
  c = c * 0.25 / uStore;
  float l = max(c.r, max(c.g, c.b));
  float k = clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
  outColor = vec4(c * k * uStore, 1.0);
}`;

// Separable 9-tap Gaussian blur.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUV).rgb * 0.227027;
  c += texture(uSrc, vUV + uDir * 1.384615).rgb * 0.316216;
  c += texture(uSrc, vUV - uDir * 1.384615).rgb * 0.316216;
  c += texture(uSrc, vUV + uDir * 3.230769).rgb * 0.070270;
  c += texture(uSrc, vUV - uDir * 3.230769).rgb * 0.070270;
  outColor = vec4(c, 1.0);
}`;

// FXAA, ambient occlusion, bloom, gameplay pulses, vignette, ACES tone map, gamma, grade.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uAO;
uniform vec2 uRes;
uniform float uDash, uParry, uHurt, uFlash, uTime, uStore, uExposure;
out vec4 outColor;
vec3 S(vec2 uv) { return texture(uScene, uv).rgb / uStore; }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 fxaa(vec2 uv) {
  vec2 px = 1.0 / uRes;
  vec3 nw = S(uv + vec2(-1.0, -1.0) * px);
  vec3 ne = S(uv + vec2(1.0, -1.0) * px);
  vec3 sw = S(uv + vec2(-1.0, 1.0) * px);
  vec3 se = S(uv + vec2(1.0, 1.0) * px);
  vec3 m = S(uv);
  float lNW = luma(nw), lNE = luma(ne), lSW = luma(sw), lSE = luma(se), lM = luma(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, -8.0, 8.0) * px;
  vec3 a = 0.5 * (S(uv + dir * (1.0 / 3.0 - 0.5)) + S(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (S(uv - dir * 0.5) + S(uv + dir * 0.5));
  float lB = luma(b);
  return (lB < lMin || lB > lMax) ? a : b;
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec2 c = vUV - 0.5;
  float r = length(c);
  vec2 dir = c / max(r, 1e-4);
  vec2 uv = vUV + dir * uParry * sin(r * 60.0 - uTime * 40.0) * 0.006 * smoothstep(0.0, 0.3, r);
  vec3 col = fxaa(uv);
  float ca = uDash * 0.012 * r + uHurt * 0.006;
  if (ca > 0.0) {
    col.r = S(uv + c * ca).r;
    col.b = S(uv - c * ca).b;
  }
  if (uDash > 0.0) {
    vec3 acc = vec3(0.0);
    for (int i = 1; i <= 4; i++) acc += S(uv - c * float(i) * 0.02 * uDash);
    col = mix(col, acc * 0.25, 0.5 * uDash) + vec3(0.0, 0.12, 0.18) * uDash * r;
  }
  col *= mix(1.0, texture(uAO, uv).r, 0.9);
  col += texture(uBloom, vUV).rgb / uStore * 0.35;
  col += vec3(0.6, 0.4, 0.1) * uParry * 0.12 * (1.0 - r);
  col += vec3(0.3, 0.35, 0.5) * uFlash * 0.9;
  col *= mix(0.6, 1.0, smoothstep(0.85, 0.3, r));
  col = mix(col, col * vec3(1.4, 0.3, 0.25) + vec3(0.06, 0.0, 0.0), uHurt * smoothstep(0.2, 0.75, r));
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += vec3(0.03, 0.015, -0.025) * smoothstep(0.45, 1.0, l) + vec3(-0.015, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.4, l));
  col = mix(vec3(l), col, 0.92);
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const SHARED_FS_UNIFORMS = ['uAlbedo', 'uNormal', 'uMat', 'uDetail', 'uShadowMap', 'uShadowMat', 'uShadowOn', 'uLightPos', 'uLightCol', 'uLightCount', 'uEye', 'uFog', 'uZenith', 'uFogDensity', 'uAmbient', 'uSunDir', 'uSunCol', 'uStore', 'uWet'];
/** Every uniform each program declares; checked against the shader sources at startup. */
const UNIFORMS = {
  mesh: ['uViewProj', 'uBones', 'uSky', 'uTint', 'uEmit', 'uBase', 'uTime', 'uWind', ...SHARED_FS_UNIFORMS],
  meshInst: ['uViewProj', 'uTime', 'uWind', ...SHARED_FS_UNIFORMS],
  depth: ['uViewProj', 'uBones', 'uTime', 'uWind'],
  depthInst: ['uViewProj', 'uTime', 'uWind'],
  glb: ['uViewProj', 'uBones', 'uUseSkinning', 'uSky', 'uTint', 'uTime', 'uGlbAlbedo', 'uGlbNormal', 'uGlbMR', 'uGlbFactor', 'uGlbMRF',
    ...SHARED_FS_UNIFORMS.filter((n) => !['uAlbedo', 'uNormal', 'uMat'].includes(n))],
  depthGlb: ['uViewProj', 'uBones', 'uUseSkinning'],
  fx: ['uViewProj', 'uCamRight', 'uCamUp', 'uStore'],
  rain: ['uViewProj', 'uEye', 'uTime', 'uWind', 'uCamRight', 'uRainCol', 'uStore'],
  sky: ['uInvViewProj', 'uEye', 'uFog', 'uZenith', 'uSunDir', 'uSunCol', 'uStore'],
  ssao: ['uDepth', 'uProj', 'uNF', 'uTexel'],
  aoBlur: ['uAO', 'uDepth', 'uDir', 'uNF'],
  bright: ['uScene', 'uTexel', 'uThreshold', 'uStore'],
  blur: ['uSrc', 'uDir'],
  composite: ['uScene', 'uBloom', 'uAO', 'uRes', 'uDash', 'uParry', 'uHurt', 'uFlash', 'uTime', 'uStore', 'uExposure'],
};

/** Effect glow colours (linear HDR) by sprite name. */
const FX_COLOR = {
  orb_enemy: [3.0, 1.0, 0.35], orb_player: [0.6, 2.4, 3.0], shard: [1.2, 2.6, 3.0], bolt: [2.4, 1.9, 0.9],
  flare: [3.2, 1.3, 0.3], frost: [1.2, 2.2, 3.2], spark: [1.6, 1.4, 1.1], bead: [1.5, 2.5, 2.0],
};

/** Soft fire glow over burning props: [height, size] as fractions of the prop size, then linear rgb. */
const FIRE_GLOW = /** @type {Record<string, number[]>} */ ({
  campfire_a: [0.35, 1.3, 0.9, 0.42, 0.12], campfire_b: [0.33, 1.2, 0.85, 0.38, 0.1], brazier: [0.75, 1.1, 0.7, 0.45, 0.2],
});

/** @param {WebGL2RenderingContext} gl @param {number} type @param {string} src */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  if (!s) throw new Error('Could not create shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`);
  return s;
}

/**
 * Link a program and resolve its uniforms, failing loudly on any name the shader lacks.
 * @param {WebGL2RenderingContext} gl @param {string} vs @param {string} fs @param {string[]} names
 * @returns {{prog: WebGLProgram, u: Record<string, WebGLUniformLocation>}}
 */
function createProgram(gl, vs, fs, names) {
  const prog = gl.createProgram();
  if (!prog) throw new Error('Could not create program');
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(prog)}`);
  /** @type {Record<string, WebGLUniformLocation>} */
  const u = {};
  for (const n of names) {
    const l = gl.getUniformLocation(prog, n);
    if (!l) throw new Error(`Uniform ${n} is missing or unused in its shader`);
    u[n] = l;
  }
  return { prog, u };
}

/** Prefix a shader body with the version line and optional defines. @param {string} body @param {string[]} [defs] */
const glsl = (body, defs = []) => `#version 300 es\n${defs.map((d) => `#define ${d}\n`).join('')}${body}`;

/** @param {number} fovy @param {number} aspect @param {number} near @param {number} far */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** @param {number} l @param {number} r @param {number} b @param {number} t @param {number} n @param {number} f */
function ortho(l, r, b, t, n, f) {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

/** @param {number[]} eye @param {number[]} fwd unit forward */
function viewMatrix(eye, fwd) {
  const z = [-fwd[0], -fwd[1], -fwd[2]];
  const xl = Math.hypot(z[2], z[0]) || 1;
  const x = [z[2] / xl, 0, -z[0] / xl];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const dot = (/** @type {number[]} */ a) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x), -dot(y), -dot(z), 1]);
}

/** Inverse of a column-major 4x4 matrix (cofactor expansion). @param {Float32Array} m */
function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06 || 1e-9;
  const k = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * k, (a02 * b10 - a01 * b11 - a03 * b09) * k, (a31 * b05 - a32 * b04 + a33 * b03) * k, (a22 * b04 - a21 * b05 - a23 * b03) * k,
    (a12 * b08 - a10 * b11 - a13 * b07) * k, (a00 * b11 - a02 * b08 + a03 * b07) * k, (a32 * b02 - a30 * b05 - a33 * b01) * k, (a20 * b05 - a22 * b02 + a23 * b01) * k,
    (a10 * b10 - a11 * b08 + a13 * b06) * k, (a01 * b08 - a00 * b10 - a03 * b06) * k, (a30 * b04 - a31 * b02 + a33 * b00) * k, (a21 * b02 - a20 * b04 - a23 * b00) * k,
    (a11 * b07 - a10 * b09 - a12 * b06) * k, (a00 * b09 - a01 * b07 + a02 * b06) * k, (a31 * b01 - a30 * b03 - a32 * b00) * k, (a20 * b03 - a21 * b01 + a22 * b00) * k,
  ]);
}

/**
 * Weld identical vertices (exact float match, FNV hash) into an indexed mesh, so each shared
 * vertex is shaded once instead of once per triangle.
 * @param {Float32Array} data @param {number} n floats used
 * @returns {{verts: Float32Array, idx: Uint16Array|Uint32Array}}
 */
function weld(data, n) {
  const count = n / VERT;
  const bits = new Uint32Array(data.buffer, data.byteOffset, n);
  const out = new Float32Array(n);
  const idx = new Uint32Array(count);
  /** @type {Map<number, number[]>} */
  const seen = new Map();
  let m = 0;
  for (let v = 0; v < count; v++) {
    const o = v * VERT;
    let h = 2166136261;
    for (let f = 0; f < VERT; f++) h = Math.imul(h ^ bits[o + f], 16777619);
    const list = seen.get(h);
    let hit = -1;
    if (list) {
      for (const c of list) {
        let eq = true;
        for (let f = 0; f < VERT; f++) if (out[c * VERT + f] !== data[o + f]) { eq = false; break; }
        if (eq) { hit = c; break; }
      }
    }
    if (hit < 0) {
      hit = m++;
      out.set(data.subarray(o, o + VERT), hit * VERT);
      if (list) list.push(hit);
      else seen.set(h, [hit]);
    }
    idx[v] = hit;
  }
  return { verts: out.slice(0, m * VERT), idx: m < 65536 ? Uint16Array.from(idx) : idx };
}

/** Display colour to linear light (values above 1 stay linear HDR). @param {number} c */
const toLin = (c) => (c <= 1 ? Math.pow(Math.max(0, c), 2.2) : c);
/** @param {number[]} c @param {number} [k] */
const lin3 = (c, k = 1) => [toLin(c[0]) * k, toLin(c[1]) * k, toLin(c[2]) * k];

// ---------------------------------------------------------------------------
// World chunk meshing
// ---------------------------------------------------------------------------

/**
 * World quad from corners top-left, top-right, bottom-right, bottom-left (texture-array material).
 * @param {Mesh} b @param {number[]} p 12 floats @param {number[]} uv [u0, v0, u1, v1] @param {number[]} nrm @param {number} emit
 * @param {number[]} tint @param {number} sky @param {number} layer @param {number[]} [ao] per-corner occlusion
 */
function wquad(b, p, uv, nrm, emit, tint, sky, layer, ao) {
  const us = [uv[0], uv[2], uv[2], uv[0]];
  const vs = [uv[1], uv[1], uv[3], uv[3]];
  for (const c of [0, 1, 2, 0, 2, 3]) {
    const s = ao ? ao[c] : 1;
    b.raw(p[c * 3], p[c * 3 + 1], p[c * 3 + 2], nrm[0], nrm[1], nrm[2], us[c], vs[c], [tint[0] * s, tint[1] * s, tint[2] * s], layer, -1, 0, emit, sky, 0, 0);
  }
}

/**
 * Vertical face between two floor-plan points, split into ~1 unit bands so wall textures
 * keep their proportions; darkened toward the floor seam (and the ceiling seam indoors).
 * @param {Mesh} b @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {number} y0 @param {number} y1 @param {number} tile @param {number[]} nrm @param {number} emit @param {number} sky
 * @param {number} ceilY height of a ceiling seam to shade, or Infinity
 */
function vface(b, x0, z0, x1, z1, y0, y1, tile, nrm, emit, sky, ceilY) {
  if (y1 - y0 < 0.01) return;
  const bands = Math.max(1, Math.round(y1 - y0));
  const step = (y1 - y0) / bands;
  /** @param {number} y */
  const ao = (y) => Math.min(0.6 + 0.4 * Math.min(1, (y - y0) / 0.9), 0.75 + 0.25 * Math.min(1, Math.max(0, ceilY - y) / 0.6));
  for (let s = 0; s < bands; s++) {
    const lo = y0 + s * step;
    const hi = lo + step;
    wquad(b, [x0, hi, z0, x1, hi, z1, x1, lo, z1, x0, lo, z0], FULL_UV, nrm, emit, WHITE, sky, tile, [ao(hi), ao(hi), ao(lo), ao(lo)]);
  }
}

/** Horizontal quad over a cell. @param {Mesh} b @param {number} i @param {number} j @param {number} y @param {number} tile @param {number} ny @param {number} emit @param {number} sky @param {number[]} [ao] */
function hface(b, i, j, y, tile, ny, emit, sky, ao) {
  wquad(b, [i, y, j, i + 1, y, j, i + 1, y, j + 1, i, y, j + 1], FULL_UV, [0, ny, 0], emit, WHITE, sky, tile, ao);
}

/** Emissive flag for a floor/wall tile. @param {number} tile */
const tileEmit = (tile) => (tile === TILE.CONDUIT || tile === TILE.LEY_FLOOR || tile === TILE.GATE || tile === TILE.STAR_CEIL ? 1 : 0);

/**
 * Corner occlusion at a grid vertex: darker the more of its four cells are walls.
 * @param {Level} L @param {number} vx @param {number} vz @param {number} k strength per wall
 */
function cornerAO(L, vx, vz, k) {
  let n = 0;
  for (const [i, j] of [[vx - 1, vz - 1], [vx, vz - 1], [vx - 1, vz], [vx, vz]]) if (!L.inBounds(i, j) || L.wall[L.idx(i, j)]) n++;
  return 1 - Math.min(3, n) * k;
}

/** Smooth terrain normal at a heightfield vertex (central differences). @param {Level} L @param {number} i @param {number} j */
function terrainNormal(L, i, j) {
  const W = L.w + 1;
  /** @param {number} a @param {number} c */
  const h = (a, c) => L.vh[Math.max(0, Math.min(L.h, c)) * W + Math.max(0, Math.min(L.w, a))];
  const nx = h(i - 1, j) - h(i + 1, j);
  const nz = h(i, j - 1) - h(i, j + 1);
  const l = Math.hypot(nx, 2, nz);
  return [nx / l, 2 / l, nz / l];
}

/**
 * Build the static world mesh for one chunk: tiles, smooth terrain, door surrounds and roofs.
 * @param {Level} L @param {number} cx @param {number} cz @param {Mesh} b @param {Uint8Array} roofMask
 * @param {{x0:number, z0:number, x1:number, z1:number, base:number}[]} roofs
 */
function buildChunk(L, cx, cz, b, roofMask, roofs) {
  b.reset();
  const W = L.w + 1;
  const i0 = cx * CHUNK;
  const j0 = cz * CHUNK;
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let j = j0; j < Math.min(j0 + CHUNK, L.h); j++) {
    for (let i = i0; i < Math.min(i0 + CHUNK, L.w); i++) {
      const k = L.idx(i, j);
      const sky = L.outdoor && L.ceil[k] === 0 ? 1 : 0;
      if (L.wall[k]) {
        const tex = L.wall[k] - 1;
        const top = L.wallTop[k];
        for (const [dx, dz] of NB) {
          const ni = i + dx;
          const nj = j + dz;
          if (!L.inBounds(ni, nj)) continue;
          const nk = L.idx(ni, nj);
          if (L.wall[nk]) continue;
          const ex0 = dx === 1 ? i + 1 : i;
          const ez0 = dz === 1 ? j + 1 : j;
          const ex1 = dx !== 0 ? ex0 : i + 1;
          const ez1 = dz !== 0 ? ez0 : j + 1;
          const base = L.smooth ? Math.min(L.vh[ez0 * W + ex0], L.vh[ez1 * W + ex1]) - 0.05 : L.floorH[nk];
          const nsky = L.outdoor && L.ceil[nk] === 0 ? 1 : 0;
          vface(b, ex0, ez0, ex1, ez1, base, top, tex, [dx, 0, dz], tileEmit(tex), nsky, L.ceil[nk] > 0 ? L.ceil[nk] : Infinity);
        }
        if (L.outdoor && !roofMask[k]) hface(b, i, j, top, tex === TILE.TIMBER ? TILE.ROOF : tex, 1, 0, 1);
        continue;
      }
      const ftex = L.floorTex[k];
      const femit = tileEmit(ftex);
      const ao = [cornerAO(L, i, j, 0.16), cornerAO(L, i + 1, j, 0.16), cornerAO(L, i + 1, j + 1, 0.16), cornerAO(L, i, j + 1, 0.16)];
      let low = L.floorH[k];
      if (L.smooth) {
        // Terrain: two triangles with smooth, shared vertex normals so light wraps over hills.
        const H = [L.vh[j * W + i], L.vh[j * W + i + 1], L.vh[(j + 1) * W + i + 1], L.vh[(j + 1) * W + i]];
        low = Math.min(...H);
        const P = [[i, H[0], j], [i + 1, H[1], j], [i + 1, H[2], j + 1], [i, H[3], j + 1]];
        const N = [terrainNormal(L, i, j), terrainNormal(L, i + 1, j), terrainNormal(L, i + 1, j + 1), terrainNormal(L, i, j + 1)];
        const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
        for (const c of [0, 1, 2, 0, 2, 3]) {
          b.raw(P[c][0], P[c][1], P[c][2], N[c][0], N[c][1], N[c][2], UV[c][0], UV[c][1], [ao[c], ao[c], ao[c]], ftex, -1, 0, femit, sky, 0, 0);
        }
      } else {
        hface(b, i, j, L.floorH[k], ftex, 1, femit, sky, ao);
        for (const [dx, dz] of NB) {
          const ni = i + dx;
          const nj = j + dz;
          if (!L.inBounds(ni, nj)) continue;
          const nk = L.idx(ni, nj);
          if (L.wall[nk] || L.floorH[nk] >= L.floorH[k] - 0.01) continue;
          const ex0 = dx === 1 ? i + 1 : i;
          const ez0 = dz === 1 ? j + 1 : j;
          const ex1 = dx !== 0 ? ex0 : i + 1;
          const ez1 = dz !== 0 ? ez0 : j + 1;
          vface(b, ex0, ez0, ex1, ez1, L.floorH[nk], L.floorH[k], L.stepTex, [dx, 0, dz], 0, sky, Infinity);
        }
      }
      const ceil = L.ceil[k];
      if (ceil > 0) {
        const cao = [cornerAO(L, i, j, 0.12), cornerAO(L, i + 1, j, 0.12), cornerAO(L, i + 1, j + 1, 0.12), cornerAO(L, i, j + 1, 0.12)];
        hface(b, i, j, ceil, L.ceilTex[k], -1, tileEmit(L.ceilTex[k]), 0, cao);
        if (L.outdoor && !roofMask[k]) hface(b, i, j, ceil + 0.3, TILE.ROOF, 1, 0, 1);
      }
      if (low < L.waterLevel) hface(b, i, j, L.waterLevel, TILE.WATER, 1, 3, sky);
    }
  }
  for (const d of L.doors) {
    if (Math.floor(d.i / CHUNK) !== cx || Math.floor(d.j / CHUNK) !== cz) continue;
    buildDoorFrame(b, d, L.outdoor && L.ceil[L.idx(d.i, d.j)] === 0 ? 1 : 0);
  }
  for (const r of roofs) {
    if (Math.floor((r.x0 + r.x1) / 2 / CHUNK) !== cx || Math.floor((r.z0 + r.z1) / 2 / CHUNK) !== cz) continue;
    buildRoof(b, r);
  }
}

// ---------------------------------------------------------------------------
// GPU resources
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Target
 * @property {WebGLFramebuffer} fbo
 * @property {WebGLTexture} tex
 * @property {WebGLTexture|null} depth depth texture (sampled by SSAO)
 * @property {number} w
 * @property {number} h
 */

/**
 * One prop instance kept per chunk: model key, placement and lighting.
 * @typedef {{key:string, far:string, x:number, y:number, z:number, yaw:number, s:number, sky:number}} PropInst
 */

/**
 * @typedef {Object} ChunkMesh
 * @property {{vao:WebGLVertexArrayObject, vbo:WebGLBuffer, ebo:WebGLBuffer, count:number, itype:number}} buf static world geometry (indexed)
 * @property {PropInst[]} props decor models (trees, rocks, ruins, stalls...)
 * @property {Float32Array} grass tuft instances (INST floats each)
 * @property {number} cx
 * @property {number} cz
 */

/**
 * GPU copy of one model, drawn instanced from a per-frame list.
 * @typedef {Object} ModelGPU
 * @property {WebGLVertexArrayObject} vao
 * @property {WebGLBuffer} vbo
 * @property {WebGLBuffer} ebo index buffer
 * @property {WebGLBuffer} ibo instance buffer
 * @property {{vao: WebGLVertexArrayObject, count: number, itype: number}|null} shadow low-poly caster geometry
 * @property {number} count indices
 * @property {number} itype index type
 * @property {Float32Array} inst instance data
 * @property {number} n instances this frame
 * @property {number} ns leading instances near enough to cast shadows
 * @property {boolean} caster casts shadows
 */

/** Growable Float32 list. */
class FloatList {
  /** @param {number} cap */
  constructor(cap) {
    this.data = new Float32Array(cap);
    this.n = 0;
  }

  /** @param {number} k */
  grow(k) {
    if (this.n + k <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.n + k));
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }
}

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2.0 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.renderScale = 1;
    /** Point lights per frame (main.js lowers this on touch devices). */
    this.maxLights = MAX_LIGHTS;
    /** Half-float scene buffer when the GPU can render to it; otherwise 8-bit at half scale. */
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.store = this.hdr ? 1 : 0.5;
    const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    const aniso = anisoExt ? Math.min(16, gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.shadowSize = coarse ? 1024 : 2048;
    this.mesh = createProgram(gl, glsl(MESH_VS), glsl(MESH_FS), UNIFORMS.mesh);
    this.meshInst = createProgram(gl, glsl(MESH_VS, ['INSTANCED']), glsl(MESH_FS), UNIFORMS.meshInst);
    this.depth = createProgram(gl, glsl(MESH_VS), glsl(DEPTH_FS), UNIFORMS.depth);
    this.depthInst = createProgram(gl, glsl(MESH_VS, ['INSTANCED']), glsl(DEPTH_FS), UNIFORMS.depthInst);
    // Rigged .glb NPCs are optional: if a GPU can't build their programs, every role keeps its
    // procedural rig (NPCs only get a .glb animator for roles left in NPC_CHARS).
    let glb = null;
    let depthGlb = null;
    try {
      glb = createProgram(gl, glsl(GLB_VS), glsl(MESH_FS, ['GLB']), UNIFORMS.glb);
      depthGlb = createProgram(gl, glsl(GLB_VS), glsl(DEPTH_FS), UNIFORMS.depthGlb);
    } catch (err) {
      console.warn('Rigged NPC models disabled on this GPU; using procedural rigs.', err);
      NPC_CHARS.clear();
    }
    // Only used when NPC_CHARS has models, which the catch above empties.
    this.glb = /** @type {{prog: WebGLProgram, u: Record<string, WebGLUniformLocation>}} */ (glb);
    this.depthGlb = /** @type {{prog: WebGLProgram, u: Record<string, WebGLUniformLocation>}} */ (depthGlb);
    this.anisoExt = anisoExt;
    this.aniso = aniso;
    this.fx = createProgram(gl, FX_VS, FX_FS, UNIFORMS.fx);
    this.rain = createProgram(gl, RAIN_VS, RAIN_FS, UNIFORMS.rain);
    this.sky = createProgram(gl, POST_VS, SKY_FS, UNIFORMS.sky);
    this.ssao = createProgram(gl, POST_VS, SSAO_FS, UNIFORMS.ssao);
    this.aoBlur = createProgram(gl, POST_VS, AO_BLUR_FS, UNIFORMS.aoBlur);
    this.bright = createProgram(gl, POST_VS, BRIGHT_FS, UNIFORMS.bright);
    this.blur = createProgram(gl, POST_VS, BLUR_FS, UNIFORMS.blur);
    this.composite = createProgram(gl, POST_VS, COMPOSITE_FS, UNIFORMS.composite);
    const mats = buildWorldMaterials(buildWorldAtlas());
    this.albedoTex = uploadArray(gl, mats.albedo, mats.size, mats.layers, aniso);
    this.normalTex = uploadArray(gl, mats.normal, mats.size, mats.layers, aniso);
    this.matTex = uploadArray(gl, mats.mat, mats.size, mats.layers, aniso);
    this.detailTex = uploadRepeating(gl, buildDetailTexture(), mats.size, aniso);
    /** The 2D sprite atlas, kept for UI icons and dialogue portraits. */
    this.spriteAtlas = buildSpriteAtlas();
    // Shared unit quad for every instanced billboard: x in [-0.5, 0.5], y in [0, 1].
    this.quadVBO = gl.createBuffer();
    this.quadIBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    this.rainVAO = gl.createVertexArray();
    gl.bindVertexArray(this.rainVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIBO);
    gl.bindVertexArray(null);
    // Effect billboards: shared quad plus per-instance (pos, size) (rgb, mode).
    this.fxVBO = /** @type {WebGLBuffer} */ (gl.createBuffer());
    this.fxVAO = gl.createVertexArray();
    gl.bindVertexArray(this.fxVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIBO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
    for (const [l, off] of [[1, 0], [2, 16]]) {
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 4, gl.FLOAT, false, 32, off);
      gl.vertexAttribDivisor(l, 1);
    }
    gl.bindVertexArray(null);
    this.fxList = new FloatList(256 * 8);
    this.shadowList = new FloatList(64 * 8);
    /** Glow markers drawn with the depth test off. */
    this.xrayList = new FloatList(64 * 8);
    // Directional shadow map: hardware depth comparison gives bilinear PCF per tap.
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Shadow framebuffer is incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.shadowMat = new Float32Array(16);
    /** @type {Map<number, ChunkMesh>} */
    this.chunks = new Map();
    /** @type {Level|null} */
    this.level = null;
    this.roofMask = new Uint8Array(0);
    /** @type {{x0:number, z0:number, x1:number, z1:number, base:number}[]} */
    this.roofs = [];
    /** @type {{x:number, z:number}[]} */
    this.wells = [];
    this.chunkMesh = new Mesh(16384);
    this.doorMesh = new Mesh(2048);
    this.doorBuf = this._makeBuffer();
    /** @type {Map<string, Mesh>} CPU models by key */
    this.cpuModels = new Map();
    /** @type {Map<string, ModelGPU>} GPU models by key */
    this.models = new Map();
    /** @type {Map<string, {vao: WebGLVertexArrayObject, vbo: WebGLBuffer, ebo: WebGLBuffer, count: number, itype: number}>} skinned rigs and viewmodels */
    this.skinned = new Map();
    /** Dialogue portraits by rig and size (PNG data URLs). @type {Map<string, string>} */
    this.portraits = new Map();
    this.bones = new Float32Array(MAX_BONES * 16);
    /** Skinning matrices (pose x inverse bind) uploaded for a rig. */
    this.skinMats = new Float32Array(MAX_BONES * 16);
    this.identBones = new Float32Array(MAX_BONES * 16);
    for (let i = 0; i < MAX_BONES; i++) this.identBones.set(ident(), i * 16);
    /** Rigged .glb models on the GPU. @type {Map<import('./meshes.js').GlbModel, GlbGPU>} */
    this.glbGpu = new Map();
    this.glbBones = new Float32Array(GLB_BONES * 16);
    this.glbRoot = new Float32Array(16);
    /** 1x1 white texture standing in for a map a .glb material lacks. */
    this.whiteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.postVAO = gl.createVertexArray();
    /** @type {Target|null} */
    this.sceneRT = null;
    /** @type {Target|null} */
    this.bloomA = null;
    /** @type {Target|null} */
    this.bloomB = null;
    /** @type {Target|null} */
    this.aoA = null;
    /** @type {Target|null} */
    this.aoB = null;
    this.lightPos = new Float32Array(MAX_LIGHTS * 3);
    this.lightCol = new Float32Array(MAX_LIGHTS * 3);
    /** Viewmodel inertia: last camera angles and the current lag offset. @type {{yaw:number, pitch:number}|null} */
    this.vmLast = null;
    this.vmSway = [0, 0];
    // Sculpting and AO-baking a rig or tree takes 0.1-0.3 s, so build them all in small steps
    // while the title screen is up instead of hitching the first time one comes into view.
    /** @type {(() => void)[]} */
    const warm = [];
    for (const n of RIG_NAMES) {
      for (let v = 0; v < (HUMAN_VARIANTS.has(n) ? 2 : 1); v++) warm.push(() => getRig(n, false, v), () => getRig(n, true, v));
    }
    for (const n of ['tree_ley', 'tree_pine', 'tree_dead', 'rock', 'ruin']) for (let k = 0; k < 4; k++) warm.push(() => this._cpuModel(`${n}#${k}`), () => this._cpuModel(`${n}#${k}~`));
    for (const id of ['fork', 'scatter', 'crossbow', 'cast', 'lantern']) warm.push(() => getViewmodel(id));
    for (const c of NPC_CHARS.values()) warm.push(() => this._glbGpu(c));
    const step = () => {
      const job = warm.shift();
      if (!job) return;
      job();
      setTimeout(step, 16);
    };
    setTimeout(step, 300);
  }

  /**
   * Weld a mesh and upload it into a fresh indexed VAO (optionally paired with an instance buffer).
   * @param {Mesh} m @param {WebGLBuffer|null} [ibo]
   * @returns {{vao: WebGLVertexArrayObject, vbo: WebGLBuffer, ebo: WebGLBuffer, count: number, itype: number}}
   */
  _uploadMesh(m, ibo = null) {
    const gl = this.gl;
    const { vao, vbo } = this._makeBuffer(ibo);
    const { verts, idx } = weld(m.data, m.n);
    const ebo = /** @type {WebGLBuffer} */ (gl.createBuffer());
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, vbo, ebo, count: idx.length, itype: idx instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT };
  }

  /** VAO for the mesh vertex layout, optionally paired with an instance buffer (divisor 1). @param {WebGLBuffer|null} [ibo] */
  _makeBuffer(ibo = null) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Could not allocate GPU buffers');
    gl.bindVertexArray(vao);
    this._layout(vbo, ibo);
    gl.bindVertexArray(null);
    return { vao, vbo };
  }

  /** Point the bound VAO's attributes at a vertex buffer and an optional instance buffer. @param {WebGLBuffer} vbo @param {WebGLBuffer|null} ibo */
  _layout(vbo, ibo) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = VERT * 4;
    for (const [l, size, off] of [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 3, 32], [4, 4, 44], [5, 3, 60]]) {
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
    }
    if (ibo) {
      gl.bindBuffer(gl.ARRAY_BUFFER, ibo);
      for (const [l, off] of [[6, 0], [7, 16], [8, 32]]) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, 4, gl.FLOAT, false, INST * 4, off);
        gl.vertexAttribDivisor(l, 1);
      }
    }
  }

  /** CPU mesh for a model key ('name', 'name#variant', '~' suffix for the far LOD, 'grass'). @param {string} key */
  _cpuModel(key) {
    let m = this.cpuModels.get(key);
    if (!m) {
      const far = key.endsWith('~');
      const base = far ? key.slice(0, -1) : key;
      const [name, v] = base.split('#');
      if (name === 'grass') {
        m = new Mesh(64);
        grassTuft(m, 0, 0, 0, 1, Number(v ?? 0) * 977 + 3, [1, 1, 1]);
      } else m = buildModel(name, Number(v ?? 0), far);
      this.cpuModels.set(key, m);
    }
    return m;
  }

  /** GPU instanced model for a key, built on first use. @param {string} key @returns {ModelGPU} */
  _model(key) {
    let g = this.models.get(key);
    if (g) return g;
    const gl = this.gl;
    const ibo = /** @type {WebGLBuffer} */ (gl.createBuffer());
    const up = this._uploadMesh(this._cpuModel(key), ibo);
    g = {
      vao: up.vao, vbo: up.vbo, ebo: up.ebo, ibo, count: up.count, itype: up.itype, inst: new Float32Array(64 * INST), n: 0, ns: 0,
      caster: !key.startsWith('grass'), shadow: null,
    };
    this.models.set(key, g);
    // Nature props cast shadows from their low-poly LOD: same instances, fewer triangles.
    if (!key.endsWith('~') && VARIANTS.has(key.split('#')[0])) {
      const far = this._model(`${key}~`);
      const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
      gl.bindVertexArray(vao);
      this._layout(far.vbo, ibo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, far.ebo);
      gl.bindVertexArray(null);
      g.shadow = { vao, count: far.count, itype: far.itype };
    }
    return g;
  }

  /** Skinned mesh (character rig or viewmodel) on the GPU. @param {string} key @param {() => Mesh} make */
  _skinned(key, make) {
    let s = this.skinned.get(key);
    if (s) return s;
    s = this._uploadMesh(make());
    this.skinned.set(key, s);
    return s;
  }

  /**
   * Upload a rigged model: one VAO per part, and its embedded images as mipmapped, anisotropic
   * TEXTURE_2Ds (trilinear). The decoded bitmaps are released once on the GPU.
   * @param {import('./meshes.js').GlbModel} c @returns {GlbGPU}
   */
  _glbGpu(c) {
    let g = this.glbGpu.get(c);
    if (g) return g;
    const gl = this.gl;
    const tex = c.bitmaps.map((bm) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1 + Math.floor(Math.log2(Math.max(bm.width, bm.height))), gl.RGBA8, bm.width, bm.height);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (this.anisoExt) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso);
      bm.close();
      return t;
    });
    c.bitmaps = [];
    const parts = c.parts.map((p) => {
      const vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray());
      gl.bindVertexArray(vao);
      /** @param {ArrayBufferView} data @param {number} loc @param {number} size @param {number} type @param {boolean} [int] */
      const attr = (data, loc, size, type, int = false) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc);
        if (int) gl.vertexAttribIPointer(loc, size, type, 0, 0); else gl.vertexAttribPointer(loc, size, type, false, 0, 0);
      };
      attr(p.pos, 0, 3, gl.FLOAT);
      attr(p.nrm, 1, 3, gl.FLOAT);
      attr(p.uv, 2, 2, gl.FLOAT);
      attr(p.joints, 3, 4, gl.UNSIGNED_SHORT, true);
      attr(p.weights, 4, 4, gl.FLOAT);
      const small = p.pos.length / 3 <= 65536;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, small ? Uint16Array.from(p.idx) : p.idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return { vao, count: p.idx.length, itype: small ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT, mat: c.materials[p.mat] ?? null };
    });
    g = { tex, parts };
    this.glbGpu.set(c, g);
    return g;
  }

  /**
   * Draw the characters that have a rigged .glb (ModelDesc.glb), posed by their animator, with
   * the glb or glb-depth program bound.
   * @param {{s: SpriteDesc, m: ModelDesc}[]} chars @param {Record<string, WebGLUniformLocation>} u @param {boolean} lit
   */
  _drawGlb(chars, u, lit) {
    const gl = this.gl;
    for (const { s, m } of chars) {
      if (!m.glb) continue;
      const c = m.glb.model;
      const g = this._glbGpu(c);
      // Head tracking: look is a bearing in the game's convention (positive = toward the model's
      // right), lookUp is positive upward; poseGlb takes +yaw to the left and +pitch down.
      const gaze = m.gaze ?? 0;
      const n = poseGlb(c, m.glb.layers, trs(s.x, s.y, s.z, Math.PI / 2 - m.yaw, 0, 0, m.scale, this.glbRoot), this.glbBones, -(m.look ?? 0) * gaze, -(m.lookUp ?? 0) * gaze);
      this._drawGlbParts(g, u, lit, n, c.skinned, s.sky, s.tint);
    }
  }

  /**
   * @param {GlbGPU} g @param {Record<string, WebGLUniformLocation>} u @param {boolean} lit @param {number} n matrices in glbBones
   * @param {boolean} skinned @param {number} sky @param {number[]} tint
   */
  _drawGlbParts(g, u, lit, n, skinned, sky, tint) {
    const gl = this.gl;
    gl.uniformMatrix4fv(u.uBones, false, this.glbBones.subarray(0, n * 16));
    gl.uniform1i(u.uUseSkinning, skinned ? 1 : 0);
    if (lit) {
      gl.uniform1f(u.uSky, sky);
      gl.uniform3fv(u.uTint, tint);
    }
    for (const p of g.parts) {
      if (lit) {
        const mt = p.mat;
        [mt?.base ?? -1, mt?.normal ?? -1, mt?.mr ?? -1].forEach((i, k) => {
          gl.activeTexture(gl.TEXTURE5 + k);
          gl.bindTexture(gl.TEXTURE_2D, g.tex[i] ?? this.whiteTex);
        });
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform4fv(u.uGlbFactor, mt?.color ?? [1, 1, 1, 1]);
        gl.uniform3f(u.uGlbMRF, mt?.metal ?? 0, mt?.rough ?? 0.6, mt && g.tex[mt.normal] ? 1 : 0);
      }
      gl.bindVertexArray(p.vao);
      gl.drawElements(gl.TRIANGLES, p.count, p.itype, 0);
    }
  }

  /** Drop every chunk mesh and switch to another level. @param {Level} level */
  setLevel(level) {
    for (const key of [...this.chunks.keys()]) this.unloadChunk(key);
    this.level = level;
    this.roofs = level.roofs ?? [];
    this.roofMask = new Uint8Array(level.w * level.h);
    for (const r of this.roofs) {
      for (let j = r.z0; j < r.z1; j++) for (let i = r.x0; i < r.x1; i++) if (level.inBounds(i, j)) this.roofMask[level.idx(i, j)] = 1;
    }
    this.wells = level.props.filter((p) => p.sprite === 'well').map((p) => ({ x: p.x, z: p.z }));
  }

  /**
   * Facing for a decor prop: market furniture turns toward the town well, the rest is seeded.
   * @param {Prop} p
   */
  _propYaw(p) {
    if (p.sprite === 'stall' || p.sprite === 'notice') {
      let best = null;
      let bd = 15 * 15;
      for (const w of this.wells) {
        const d = (w.x - p.x) ** 2 + (w.z - p.z) ** 2;
        if (d < bd) { bd = d; best = w; }
      }
      if (best) return Math.atan2(best.x - p.x, best.z - p.z);
    }
    return hash2(Math.floor(p.x * 13.1), Math.floor(p.z * 7.7), 5) * Math.PI * 2;
  }

  /**
   * Decor model instances and grass tufts for one chunk.
   * @param {Level} L @param {number} key @param {number} cx @param {number} cz
   * @returns {{props: PropInst[], grass: Float32Array}}
   */
  _buildClutter(L, key, cx, cz) {
    /** @type {PropInst[]} */
    const props = [];
    for (const p of L.propChunks.get(key) ?? []) {
      if (p.kind !== 'decor' || p.gone || !hasModel(p.sprite)) continue;
      const variant = VARIANTS.has(p.sprite) ? Math.floor(hash2(Math.floor(p.x * 13.1), Math.floor(p.z * 7.7), 9) * 4) : 0;
      const k = `${p.sprite}#${variant}`;
      props.push({ key: k, far: VARIANTS.has(p.sprite) ? `${k}~` : k, x: p.x, y: L.heightAt(p.x, p.z) + p.lift, z: p.z, yaw: this._propYaw(p), s: p.size / nominalSize(p.sprite), sky: L.covered(p.x, p.z) ? 0 : 1 });
    }
    const grass = new FloatList(256 * INST);
    if (L.outdoor) {
      for (let j = cz * CHUNK; j < Math.min((cz + 1) * CHUNK, L.h); j++) {
        for (let i = cx * CHUNK; i < Math.min((cx + 1) * CHUNK, L.w); i++) {
          const k = L.idx(i, j);
          const t = L.floorTex[k];
          if (L.wall[k] || L.ceil[k] || L.hazard[k] || L.zone[k] >= 0 || L.doorAt[k] >= 0 || L.floorH[k] < L.waterLevel + 0.05) continue;
          const tufts = t === TILE.GRASS ? 2 : t === TILE.FEN ? 1 : 0;
          for (let n = 0; n < tufts; n++) {
            const h1 = hash2(i * 3 + n, j, 77);
            const h2 = hash2(j * 5 + n, i, 91);
            const x = i + 0.1 + h1 * 0.8;
            const z = j + 0.1 + h2 * 0.8;
            grass.grow(INST);
            grass.data.set([x, L.heightAt(x, z) - 0.02, z, h1 * 6.28, 0.4 + h1 * h2 * 0.4, 1, 0, 0, 0.85 + h1 * 0.25, 0.92 + h2 * 0.18, 0.85, 0], grass.n);
            grass.n += INST;
          }
        }
      }
    }
    return { props, grass: grass.data.slice(0, grass.n) };
  }

  /** Build and upload one chunk's mesh and clutter. @param {number} key */
  loadChunk(key) {
    if (!this.level || this.chunks.has(key)) return;
    const cx = key % 1024;
    const cz = Math.floor(key / 1024);
    buildChunk(this.level, cx, cz, this.chunkMesh, this.roofMask, this.roofs);
    this.chunks.set(key, { buf: this._uploadMesh(this.chunkMesh), cx, cz, ...this._buildClutter(this.level, key, cx, cz) });
  }

  /** @param {number} key */
  unloadChunk(key) {
    const c = this.chunks.get(key);
    if (!c) return;
    const gl = this.gl;
    gl.deleteBuffer(c.buf.vbo);
    gl.deleteBuffer(c.buf.ebo);
    gl.deleteVertexArray(c.buf.vao);
    this.chunks.delete(key);
  }

  /** Draw an indexed mesh. @param {{vao: WebGLVertexArrayObject, count: number, itype: number}} b */
  _drawIndexed(b) {
    const gl = this.gl;
    gl.bindVertexArray(b.vao);
    gl.drawElements(gl.TRIANGLES, b.count, b.itype, 0);
  }

  /**
   * (Re)create a render target.
   * @param {Target|null} old @param {number} w @param {number} h @param {boolean} depth @param {boolean} [hdr]
   * @returns {Target}
   */
  _target(old, w, h, depth, hdr = this.hdr) {
    const gl = this.gl;
    if (old) {
      gl.deleteFramebuffer(old.fbo);
      gl.deleteTexture(old.tex);
      if (old.depth) gl.deleteTexture(old.depth);
    }
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('Could not allocate render target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    /** @type {WebGLTexture|null} */
    let dt = null;
    if (depth) {
      dt = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, dt);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dt, 0);
    }
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Render target is incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, depth: dt, w, h };
  }

  /** Match the drawing buffer to the canvas' CSS size (times DPR and render scale). */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.sceneRT && this.sceneRT.w === w && this.sceneRT.h === h) return;
    this.sceneRT = this._target(this.sceneRT, w, h, true);
    const bw = Math.max(1, w >> 2);
    const bh = Math.max(1, h >> 2);
    this.bloomA = this._target(this.bloomA, bw, bh, false);
    this.bloomB = this._target(this.bloomB, bw, bh, false);
    const aw = Math.max(1, w >> 1);
    const ah = Math.max(1, h >> 1);
    this.aoA = this._target(this.aoA, aw, ah, false, false);
    this.aoB = this._target(this.aoB, aw, ah, false, false);
  }

  /** Sliding door panels plus lintels. @param {Door[]} doors @param {number} time */
  _buildDoors(doors, time) {
    const b = this.doorMesh;
    b.reset();
    for (const d of doors) {
      const pulse = Math.sin(time * 4);
      const tint = d.locked && (d.magic || d.puzzle) ? [0.7, 1.0 + 0.3 * pulse, 1.4 + 0.4 * pulse] : WHITE;
      const y0 = d.base;
      const y1 = d.base + d.height;
      const slide = d.open * 0.95;
      const emit = tileEmit(d.tex) || (d.magic ? 1 : 0);
      const sky = this.level && this.level.outdoor && this.level.ceil[this.level.idx(d.i, d.j)] === 0 ? 1 : 0;
      const ao = [1, 1, 0.65, 0.65];
      if (d.axis === 'x') {
        const x0 = d.i + slide;
        const x1 = x0 + 1;
        const za = d.j + 0.42;
        const zb = d.j + 0.58;
        wquad(b, [x0, y1, za, x1, y1, za, x1, y0, za, x0, y0, za], FULL_UV, [0, 0, -1], emit, tint, sky, d.tex, ao);
        wquad(b, [x1, y1, zb, x0, y1, zb, x0, y0, zb, x1, y0, zb], FULL_UV, [0, 0, 1], emit, tint, sky, d.tex, ao);
        wquad(b, [x0, y1, zb, x0, y1, za, x0, y0, za, x0, y0, zb], [0, 0, 0.16, 1], [-1, 0, 0], emit, tint, sky, d.tex, ao);
        vface(b, d.i, d.j, d.i + 1, d.j, y1, d.top, d.tex, [0, 0, -1], emit, sky, Infinity);
        vface(b, d.i, d.j + 1, d.i + 1, d.j + 1, y1, d.top, d.tex, [0, 0, 1], emit, sky, Infinity);
      } else {
        const z0 = d.j + slide;
        const z1 = z0 + 1;
        const xa = d.i + 0.42;
        const xb = d.i + 0.58;
        wquad(b, [xa, y1, z1, xa, y1, z0, xa, y0, z0, xa, y0, z1], FULL_UV, [-1, 0, 0], emit, tint, sky, d.tex, ao);
        wquad(b, [xb, y1, z0, xb, y1, z1, xb, y0, z1, xb, y0, z0], FULL_UV, [1, 0, 0], emit, tint, sky, d.tex, ao);
        wquad(b, [xa, y1, z0, xb, y1, z0, xb, y0, z0, xa, y0, z0], [0, 0, 0.16, 1], [0, 0, -1], emit, tint, sky, d.tex, ao);
        vface(b, d.i, d.j + 1, d.i, d.j, y1, d.top, d.tex, [-1, 0, 0], emit, sky, Infinity);
        vface(b, d.i + 1, d.j, d.i + 1, d.j + 1, y1, d.top, d.tex, [1, 0, 0], emit, sky, Infinity);
      }
      hface(b, d.i, d.j, y1, d.tex, -1, emit, 0);
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.doorBuf.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n), gl.DYNAMIC_DRAW);
  }

  /** Pick the lights nearest the eye, apply flicker, pack into uniform arrays (linear light). @param {Light[]} lights @param {{x:number,y:number,z:number}} eye @param {number} time */
  _packLights(lights, eye, time) {
    const sorted = lights.map((l) => ({ l, d: (l.x - eye.x) ** 2 + (l.z - eye.z) ** 2 })).sort((a, b) => a.d - b.d);
    const n = Math.min(this.maxLights, MAX_LIGHTS, sorted.length);
    for (let i = 0; i < n; i++) {
      const { l } = sorted[i];
      const f = l.flicker ? 1 - l.flicker * (0.5 + 0.5 * Math.sin(time * 13 + l.x) * Math.sin(time * 7.3 + l.z)) : 1;
      this.lightPos.set([l.x, l.y, l.z], i * 3);
      this.lightCol.set(lin3([l.r, l.g, l.b], 2.2 * f), i * 3);
    }
    return n;
  }

  /**
   * Queue one instance of a model for this frame.
   * @param {string} key @param {number} x @param {number} y @param {number} z @param {number} yaw @param {number} s
   * @param {number} sky @param {number[]} tint @param {number} emit
   */
  _queue(key, x, y, z, yaw, s, sky, tint, emit) {
    const g = this._model(key);
    if ((g.n + 1) * INST > g.inst.length) {
      const next = new Float32Array(g.inst.length * 2);
      next.set(g.inst);
      g.inst = next;
    }
    const d = g.inst;
    let i = g.n * INST;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = yaw; d[i++] = s; d[i++] = sky; d[i++] = 0; d[i++] = 0;
    d[i++] = tint[0]; d[i++] = tint[1]; d[i++] = tint[2]; d[i] = emit;
    g.n++;
  }

  /**
   * Gather this frame's instances (decor, grass, interactable props, items), characters and effects.
   * @param {RenderView} v @param {number} fx @param {number} fz view direction on the ground
   */
  _gather(v, fx, fz) {
    for (const g of this.models.values()) g.n = 0;
    const ex = v.eye.x;
    const ez = v.eye.z;
    // Props near enough to cast into the shadow box are queued first, so the shadow pass draws
    // just the leading instances of each model; distant props are queued after.
    /** @type {{p: PropInst, d: number}[]} */
    const far = [];
    /** Keep anything near (it may cast a shadow into view); drop distant things behind the eye. */
    const keep = (/** @type {number} */ x, /** @type {number} */ z, /** @type {number} */ r) => {
      const dx = x - ex;
      const dz = z - ez;
      const d = Math.hypot(dx, dz);
      if (d > 64 + r) return -1;
      if (d > 24 + r && (dx * fx + dz * fz) / d < -0.3) return -1;
      return d;
    };
    for (const c of this.chunks.values()) {
      const ccx = (c.cx + 0.5) * CHUNK;
      const ccz = (c.cz + 0.5) * CHUNK;
      if (keep(ccx, ccz, CHUNK * 0.75) < 0) continue;
      for (const p of c.props) {
        const d = keep(p.x, p.z, 3);
        if (d < 0) continue;
        if (d > SHADOW_REACH) far.push({ p, d });
        else this._queue(d > LOD_DIST ? p.far : p.key, p.x, p.y, p.z, p.yaw, p.s, p.sky, WHITE, 1);
      }
      if (Math.hypot(ccx - ex, ccz - ez) < GRASS_DIST + CHUNK) {
        const gr = c.grass;
        for (let i = 0; i < gr.length; i += INST) {
          const dx = gr[i] - ex;
          const dz = gr[i + 2] - ez;
          const d2 = dx * dx + dz * dz;
          if (d2 > GRASS_DIST * GRASS_DIST || (d2 > 16 && dx * fx + dz * fz < -0.2 * Math.sqrt(d2))) continue;
          const g = this._model(`grass#${(i / INST) & 3}`);
          if ((g.n + 1) * INST > g.inst.length) {
            const next = new Float32Array(g.inst.length * 2);
            next.set(g.inst);
            g.inst = next;
          }
          g.inst.set(gr.subarray(i, i + INST), g.n * INST);
          g.n++;
        }
      }
    }
    /** @type {{s: SpriteDesc, m: ModelDesc}[]} */
    const chars = [];
    const fxl = this.fxList;
    fxl.n = 0;
    this.xrayList.n = 0;
    const shl = this.shadowList;
    shl.n = 0;
    for (const s of v.sprites) {
      if (s.model) {
        if (keep(s.x, s.z, 2) < 0) continue;
        chars.push({ s, m: s.model });
        shl.grow(8);
        shl.data.set([s.x, s.y, s.z, 0.42 * s.model.scale * (1 - Math.min(1, s.model.dead)), 0, 0, 0, 1], shl.n);
        shl.n += 8;
        continue;
      }
      const name = SPRITE_NAMES[s.frame] ?? 'spark';
      if (hasModel(name)) {
        const d = keep(s.x, s.z, 2);
        if (d < 0) continue;
        const seed = hash2(Math.floor(s.x * 31), Math.floor(s.z * 17), 3);
        if (isItemModel(name)) {
          this._queue(name, s.x, s.y + 0.08 + Math.sin(v.time * 2 + seed * 6) * 0.03, s.z, v.time * 0.8 + seed * 6.28, Math.max(0.8, s.h / 0.6), s.sky, s.tint, 1);
        } else {
          const emit = s.emit > 0 || name === 'campfire_b' ? 1 : 0.25;
          this._queue(name, s.x, s.y, s.z, seed * 6.28, s.h / nominalSize(name), s.sky, s.tint, emit);
          const fire = FIRE_GLOW[name];
          if (fire) {
            const flick = 0.85 + 0.15 * Math.sin(v.time * 11 + seed * 9) * Math.sin(v.time * 7.3);
            fxl.grow(8);
            fxl.data.set([s.x, s.y + s.h * fire[0], s.z, s.h * fire[1], fire[2] * flick, fire[3] * flick, fire[4] * flick, 0], fxl.n);
            fxl.n += 8;
          }
        }
        continue;
      }
      const col = /** @type {Record<string, number[]>} */ (FX_COLOR)[name] ?? FX_COLOR.spark;
      const list = s.xray ? this.xrayList : fxl;
      list.grow(8);
      list.data.set([s.x, s.y + s.h / 2, s.z, s.w, col[0] * s.tint[0], col[1] * s.tint[1], col[2] * s.tint[2], 0], list.n);
      list.n += 8;
    }
    for (const g of this.models.values()) g.ns = g.n;
    for (const { p, d } of far) this._queue(d > LOD_DIST ? p.far : p.key, p.x, p.y, p.z, p.yaw, p.s, p.sky, WHITE, 1);
    const gl = this.gl;
    for (const g of this.models.values()) {
      if (!g.n) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.ibo);
      gl.bufferData(gl.ARRAY_BUFFER, g.inst.subarray(0, g.n * INST), gl.STREAM_DRAW);
    }
    return chars;
  }

  /**
   * Draw every queued instanced model with the given program.
   * @param {boolean} shadow shadow pass: skip non-casters
   */
  _drawModels(shadow) {
    const gl = this.gl;
    for (const g of this.models.values()) {
      if (!g.n || (shadow && (!g.caster || !g.ns))) continue;
      const lod = shadow && g.shadow ? g.shadow : g;
      gl.bindVertexArray(lod.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, lod.count, lod.itype, 0, shadow ? g.ns : g.n);
    }
  }

  /**
   * Draw the posed characters with the skinned program bound.
   * Close characters use the full sculpted rig; distant ones and the shadow pass use its LOD.
   * @param {{s: SpriteDesc, m: ModelDesc}[]} chars @param {Record<string, WebGLUniformLocation>} u @param {boolean} lit
   * @param {{x:number, z:number}} eye
   */
  _drawChars(chars, u, lit, eye) {
    const gl = this.gl;
    for (const { s, m } of chars) {
      if (m.glb) continue;
      const far = !lit || Math.hypot(s.x - eye.x, s.z - eye.z) > CHAR_LOD_DIST;
      const v = m.variant ?? 0;
      const rig = getRig(m.rig, far, v);
      const gpu = this._skinned(`rig:${m.rig}#${v}${far ? '~' : ''}`, () => rig.mesh);
      const n = poseRig(rig, m, s.x, s.y, s.z, this.bones);
      gl.uniformMatrix4fv(u.uBones, false, this._skin(rig, n));
      if (lit) {
        gl.uniform1f(u.uSky, s.sky);
        gl.uniform3fv(u.uTint, s.tint);
        gl.uniform1f(u.uEmit, 1);
        gl.uniform1f(u.uBase, s.y);
      }
      this._drawIndexed(gpu);
    }
  }

  /**
   * Skinning matrices for a posed rig: each bone's pose times its inverse bind.
   * @param {import('./models.js').Rig} rig @param {number} n bones posed @returns {Float32Array}
   */
  _skin(rig, n) {
    for (let i = 0; i < n; i++) mul(this.bones.subarray(i * 16, i * 16 + 16), rig.invBind.subarray(i * 16, i * 16 + 16), this.skinMats.subarray(i * 16, i * 16 + 16));
    return this.skinMats.subarray(0, Math.max(n, 1) * 16);
  }

  /**
   * Uniforms shared by the lit mesh programs.
   * @param {Record<string, WebGLUniformLocation>} u @param {Float32Array} viewProj @param {RenderView} v @param {number} lights
   * @param {{fog:number[], zen:number[], amb:number[], sun:number[], wet:number, wind:number, shadowOn:number}} k
   */
  _common(u, viewProj, v, lights, k) {
    const gl = this.gl;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uLightPos, this.lightPos);
    gl.uniform3fv(u.uLightCol, this.lightCol);
    gl.uniform1i(u.uLightCount, lights);
    gl.uniform3f(u.uEye, v.eye.x, v.eye.y, v.eye.z);
    gl.uniform1f(u.uTime, v.time);
    gl.uniform1f(u.uWind, k.wind);
    gl.uniform3fv(u.uFog, k.fog);
    gl.uniform3fv(u.uZenith, k.zen);
    gl.uniform1f(u.uFogDensity, v.env.fogDensity);
    gl.uniform3fv(u.uAmbient, k.amb);
    gl.uniform3fv(u.uSunDir, v.env.sunDir);
    gl.uniform3fv(u.uSunCol, k.sun);
    gl.uniform1f(u.uStore, this.store);
    gl.uniform1f(u.uWet, k.wet);
    gl.uniformMatrix4fv(u.uShadowMat, false, this.shadowMat);
    gl.uniform1f(u.uShadowOn, k.shadowOn);
    [u.uAlbedo, u.uNormal, u.uMat, u.uDetail, u.uShadowMap, u.uGlbAlbedo, u.uGlbNormal, u.uGlbMR].forEach((loc, i) => loc && gl.uniform1i(loc, i));
  }

  /** Draw a fullscreen pass into a target (or the canvas). @param {Target|null} rt */
  _pass(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null);
    gl.viewport(0, 0, rt ? rt.w : this.canvas.width, rt ? rt.h : this.canvas.height);
    gl.bindVertexArray(this.postVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Fit the sun's orthographic shadow box around the view, snapped to whole texels so
   * shadow edges do not shimmer as the player moves.
   * @param {RenderView} v @param {number[]} fwd
   */
  _shadowViewProj(v, fwd) {
    const R = 30;
    const c = [v.eye.x + fwd[0] * R * 0.5, v.eye.y, v.eye.z + fwd[2] * R * 0.5];
    const sd = v.env.sunDir;
    const view = viewMatrix([0, 0, 0], [-sd[0], -sd[1], -sd[2]]);
    const cx = view[0] * c[0] + view[4] * c[1] + view[8] * c[2];
    const cy = view[1] * c[0] + view[5] * c[1] + view[9] * c[2];
    const cz = view[2] * c[0] + view[6] * c[1] + view[10] * c[2];
    const unit = (2 * R) / this.shadowSize;
    const sx = Math.round(cx / unit) * unit;
    const sy = Math.round(cy / unit) * unit;
    const vp = mul(ortho(sx - R, sx + R, sy - R, sy + R, -cz - 90, -cz + 90), view);
    const bias = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);
    mul(bias, vp, this.shadowMat);
    return vp;
  }

  /** Render one frame. @param {RenderView} v */
  render(v) {
    this.resize();
    const gl = this.gl;
    const scene = /** @type {Target} */ (this.sceneRT);
    const bloomA = /** @type {Target} */ (this.bloomA);
    const bloomB = /** @type {Target} */ (this.bloomB);
    const aoA = /** @type {Target} */ (this.aoA);
    const aoB = /** @type {Target} */ (this.aoB);
    const L = this.level;
    const cp = Math.cos(v.pitch);
    const fwd = [Math.cos(v.yaw) * cp, Math.sin(v.pitch), Math.sin(v.yaw) * cp];
    const proj = perspective((70 * Math.PI) / 180, scene.w / scene.h, NEAR, FAR);
    const view = viewMatrix([v.eye.x, v.eye.y, v.eye.z], fwd);
    const viewProj = mul(proj, view);
    const env = v.env;
    const rain = v.weather ? v.weather.rain : 0;
    const wind = v.weather ? v.weather.wind : 0;
    const camRight = [-Math.sin(v.yaw), Math.cos(v.yaw)];
    const outdoor = !!(L && L.outdoor);
    const eyeSky = outdoor && L && !L.covered(v.eye.x, v.eye.z) ? 1 : 0;
    // Environment in linear light; daylight is read from the sun colour.
    const day = Math.min(1, Math.max(0, env.sunCol[1]));
    const zenD = [env.fog[0] * 0.35 + (0.3 - env.fog[0] * 0.35) * day, env.fog[1] * 0.4 + (0.5 - env.fog[1] * 0.4) * day, env.fog[2] * 0.6 + (0.86 - env.fog[2] * 0.6) * day];
    const k = {
      fog: lin3(env.fog), zen: lin3(zenD), amb: lin3(env.ambient, outdoor ? 2.4 : 3.4), sun: lin3(env.sunCol, 2.7),
      wet: outdoor ? rain : 0, wind: 0.3 + wind, shadowOn: 0,
    };

    const n = this._packLights(v.lights, v.eye, v.time);
    const chars = this._gather(v, Math.cos(v.yaw), Math.sin(v.yaw));
    this._buildDoors(v.doors, v.time);

    // Sun/moon shadow map.
    if (outdoor && Math.max(...env.sunCol) > 0.02) {
      const svp = this._shadowViewProj(v, fwd);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(2, 4);
      const du = this.depth.u;
      gl.useProgram(this.depth.prog);
      gl.uniformMatrix4fv(du.uViewProj, false, svp);
      gl.uniform1f(du.uTime, v.time);
      gl.uniform1f(du.uWind, k.wind);
      gl.uniformMatrix4fv(du.uBones, false, this.identBones);
      for (const c of this.chunks.values()) {
        if (Math.hypot((c.cx + 0.5) * CHUNK - v.eye.x, (c.cz + 0.5) * CHUNK - v.eye.z) > 52) continue;
        this._drawIndexed(c.buf);
      }
      gl.bindVertexArray(this.doorBuf.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.doorMesh.count);
      this._drawChars(chars, du, false, v.eye);
      gl.useProgram(this.depthGlb.prog);
      gl.uniformMatrix4fv(this.depthGlb.u.uViewProj, false, svp);
      this._drawGlb(chars, this.depthGlb.u, false);
      const diu = this.depthInst.u;
      gl.useProgram(this.depthInst.prog);
      gl.uniformMatrix4fv(diu.uViewProj, false, svp);
      gl.uniform1f(diu.uTime, v.time);
      gl.uniform1f(diu.uWind, k.wind);
      this._drawModels(true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      k.shadowOn = 1;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.w, scene.h);
    gl.clearColor(k.fog[0] * this.store, k.fog[1] * this.store, k.fog[2] * this.store, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    if (outdoor) {
      const su = this.sky.u;
      gl.useProgram(this.sky.prog);
      gl.uniformMatrix4fv(su.uInvViewProj, false, invert(viewProj));
      gl.uniform3f(su.uEye, v.eye.x, v.eye.y, v.eye.z);
      gl.uniform3fv(su.uFog, k.fog);
      gl.uniform3fv(su.uZenith, k.zen);
      gl.uniform3fv(su.uSunDir, env.sunDir);
      gl.uniform3fv(su.uSunCol, k.sun);
      gl.uniform1f(su.uStore, this.store);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.bindVertexArray(this.postVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }

    /** @type {[number, WebGLTexture|null][]} */
    const textures = [[gl.TEXTURE_2D_ARRAY, this.albedoTex], [gl.TEXTURE_2D_ARRAY, this.normalTex], [gl.TEXTURE_2D_ARRAY, this.matTex], [gl.TEXTURE_2D, this.detailTex], [gl.TEXTURE_2D, this.shadowTex]];
    textures.forEach(([target, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(target, tex);
    });

    // World geometry, doors, characters and the viewmodel (skinned program).
    const u = this.mesh.u;
    gl.useProgram(this.mesh.prog);
    this._common(u, viewProj, v, n, k);
    gl.uniformMatrix4fv(u.uBones, false, this.identBones);
    gl.uniform1f(u.uSky, 1);
    gl.uniform3fv(u.uTint, WHITE);
    gl.uniform1f(u.uEmit, 1);
    gl.uniform1f(u.uBase, -1e4);
    const fx = Math.cos(v.yaw);
    const fz = Math.sin(v.yaw);
    for (const c of this.chunks.values()) {
      const dx = (c.cx + 0.5) * CHUNK - v.eye.x;
      const dz = (c.cz + 0.5) * CHUNK - v.eye.z;
      const d = Math.hypot(dx, dz);
      if (d > CHUNK * 1.5 && (dx * fx + dz * fz) / d < -0.35) continue;
      this._drawIndexed(c.buf);
    }
    gl.bindVertexArray(this.doorBuf.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.doorMesh.count);
    this._drawChars(chars, u, true, v.eye);
    if (v.view) this._drawViewmodel(v, view, u, eyeSky);
    if (chars.some((c) => c.m.glb)) {
      gl.useProgram(this.glb.prog);
      this._common(this.glb.u, viewProj, v, n, k);
      this._drawGlb(chars, this.glb.u, true);
    }

    // Instanced props, foliage, grass and items.
    gl.useProgram(this.meshInst.prog);
    this._common(this.meshInst.u, viewProj, v, n, k);
    this._drawModels(false);

    // Soft contact shadows under characters, then additive glow effects.
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    const xu = this.fx.u;
    gl.useProgram(this.fx.prog);
    gl.uniformMatrix4fv(xu.uViewProj, false, viewProj);
    gl.uniform3f(xu.uCamRight, camRight[0], 0, camRight[1]);
    gl.uniform3f(xu.uCamUp, -Math.sin(v.pitch) * fx, Math.cos(v.pitch), -Math.sin(v.pitch) * fz);
    gl.uniform1f(xu.uStore, this.store);
    gl.bindVertexArray(this.fxVAO);
    if (this.shadowList.n) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -4);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.shadowList.data.subarray(0, this.shadowList.n), gl.STREAM_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.shadowList.n / 8);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (this.fxList.n) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.fxList.data.subarray(0, this.fxList.n), gl.STREAM_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.fxList.n / 8);
    }
    if (this.xrayList.n) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.disable(gl.DEPTH_TEST);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxVBO);
      gl.bufferData(gl.ARRAY_BUFFER, this.xrayList.data.subarray(0, this.xrayList.n), gl.STREAM_DRAW);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.xrayList.n / 8);
      gl.enable(gl.DEPTH_TEST);
    }

    // GPU rain: every drop positioned in the vertex shader from its instance id.
    if (outdoor && L && rain > 0.01 && !L.covered(v.eye.x, v.eye.z)) {
      const ru = this.rain.u;
      gl.useProgram(this.rain.prog);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.uniformMatrix4fv(ru.uViewProj, false, viewProj);
      gl.uniform3f(ru.uEye, v.eye.x, v.eye.y, v.eye.z);
      gl.uniform1f(ru.uTime, v.time);
      gl.uniform2f(ru.uWind, wind * 2.5, wind * 1.2);
      gl.uniform2f(ru.uCamRight, camRight[0], camRight[1]);
      gl.uniform3fv(ru.uRainCol, lin3([env.ambient[0] * 1.8 + env.sunCol[0] * 0.3, env.ambient[1] * 1.8 + env.sunCol[1] * 0.3, env.ambient[2] * 2 + env.sunCol[2] * 0.3], 1.2));
      gl.uniform1f(ru.uStore, this.store);
      gl.bindVertexArray(this.rainVAO);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, Math.round(rain * 2400));
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // SSAO at half resolution, then a depth-aware blur in both directions.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.depth);
    gl.useProgram(this.ssao.prog);
    gl.uniform1i(this.ssao.u.uDepth, 0);
    gl.uniform2f(this.ssao.u.uProj, proj[0], proj[5]);
    gl.uniform2f(this.ssao.u.uNF, NEAR, FAR);
    gl.uniform2f(this.ssao.u.uTexel, 1 / aoA.w, 1 / aoA.h);
    this._pass(aoA);
    gl.useProgram(this.aoBlur.prog);
    gl.uniform1i(this.aoBlur.u.uDepth, 0);
    gl.uniform1i(this.aoBlur.u.uAO, 1);
    gl.uniform2f(this.aoBlur.u.uNF, NEAR, FAR);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, aoA.tex);
    gl.uniform2f(this.aoBlur.u.uDir, 1 / aoA.w, 0);
    this._pass(aoB);
    gl.bindTexture(gl.TEXTURE_2D, aoB.tex);
    gl.uniform2f(this.aoBlur.u.uDir, 0, 1 / aoA.h);
    this._pass(aoA);

    // Bloom: bright pass to quarter res, then a horizontal + vertical Gaussian.
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(this.bright.prog);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(this.bright.u.uScene, 0);
    gl.uniform2f(this.bright.u.uTexel, 1 / scene.w, 1 / scene.h);
    gl.uniform1f(this.bright.u.uThreshold, 1.0);
    gl.uniform1f(this.bright.u.uStore, this.store);
    this._pass(bloomA);
    gl.useProgram(this.blur.prog);
    gl.uniform1i(this.blur.u.uSrc, 0);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform2f(this.blur.u.uDir, 1 / bloomA.w, 0);
    this._pass(bloomB);
    gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
    gl.uniform2f(this.blur.u.uDir, 0, 1 / bloomA.h);
    this._pass(bloomA);

    const cu = this.composite.u;
    gl.useProgram(this.composite.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.tex);
    gl.uniform1i(cu.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(cu.uBloom, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, aoA.tex);
    gl.uniform1i(cu.uAO, 2);
    gl.uniform2f(cu.uRes, scene.w, scene.h);
    gl.uniform1f(cu.uDash, v.fx.dash);
    gl.uniform1f(cu.uParry, v.fx.parry);
    gl.uniform1f(cu.uHurt, v.fx.hurt);
    gl.uniform1f(cu.uFlash, v.fx.flash ?? 0);
    gl.uniform1f(cu.uTime, v.time);
    gl.uniform1f(cu.uStore, this.store);
    gl.uniform1f(cu.uExposure, 1.0);
    this._pass(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  /**
   * Head-and-shoulders portrait of a character rig for the dialogue panel, lit like a
   * lantern-lit study (warm key, cool fill, rim from behind) with the full PBR shader, rendered
   * offscreen at twice the size, then tone-mapped to a transparent PNG. Cached per rig and size.
   * @param {string} rigName @param {number} [size] CSS pixels @param {number} [variant] which look
   * @returns {string} data URL, or '' if it could not be drawn
   */
  portrait(rigName, size = 112, variant = 0) {
    const cacheKey = `${rigName}#${variant}@${size}`;
    const hit = this.portraits.get(cacheKey);
    if (hit !== undefined) return hit;
    const gl = this.gl;
    const px = size * 2;
    let url = '';
    /** @type {Target|null} */
    let rt = null;
    try {
      rt = this._target(null, px, px, true);
      const glbM = NPC_CHARS.get(rigName);
      const rig = getRig(rigName, false, variant);
      // t = 2.6 s falls between blinks (see poseRig).
      /** @type {import('./models.js').ModelDesc} */
      const desc = { rig: rigName, yaw: Math.PI / 2, t: 2.6, walk: 0, phase: 0, act: '', k: 0, stagger: 0, dead: 0, scale: 1 };
      let n;
      /** @type {number[]} */
      let fc;
      if (glbM) {
        // Rigged model: the idle's first frame (idles glance about later), framed a little above
        // its head joint (the skull base).
        const idle = glbM.states.idle;
        n = poseGlb(glbM, idle ? [{ clip: idle, time: 0, weight: 1 }] : [], trs(0, 0, 0, 0, 0, 0, 1, this.glbRoot), this.glbBones);
        fc = [glbM.headPos[0], glbM.headPos[1] + 0.1, glbM.headPos[2] + 0.02];
      } else {
        n = poseRig(rig, desc, 0, 0, 0, this.bones);
        // Frame on the face (head bone is index 2), aiming a little low to take in the shoulders.
        const H = this.bones.subarray(32, 48);
        const hp = [0, 0.13, 0.05];
        fc = [0, 1, 2].map((i) => H[i] * hp[0] + H[4 + i] * hp[1] + H[8 + i] * hp[2] + H[12 + i]);
      }
      const look = [fc[0], fc[1] - 0.08, fc[2]];
      const eye = [look[0] + Math.sin(0.42) * 0.72, look[1] + 0.05, look[2] + Math.cos(0.42) * 0.72];
      const d = [look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]];
      const dl = Math.hypot(d[0], d[1], d[2]);
      const vp = mul(perspective((30 * Math.PI) / 180, 1, 0.05, 10), viewMatrix(eye, d.map((c) => c / dl)));

      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, px, px);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      /** @type {[number, WebGLTexture|null][]} */
      const textures = [[gl.TEXTURE_2D_ARRAY, this.albedoTex], [gl.TEXTURE_2D_ARRAY, this.normalTex], [gl.TEXTURE_2D_ARRAY, this.matTex], [gl.TEXTURE_2D, this.detailTex], [gl.TEXTURE_2D, this.shadowTex]];
      textures.forEach(([target, tex], i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(target, tex);
      });
      const lp = new Float32Array(MAX_LIGHTS * 3);
      const lc = new Float32Array(MAX_LIGHTS * 3);
      const lights = [[-0.62, 0.36, 0.3, 2.2, 1.4, 0.72], [0.62, 0.0, 0.4, 0.2, 0.27, 0.42], [0.25, 0.3, -0.55, 1.3, 1.1, 0.85]];
      lights.forEach((l, i) => {
        lp.set([fc[0] + l[0], fc[1] + l[1], fc[2] + l[2]], i * 3);
        lc.set([l[3], l[4], l[5]], i * 3);
      });
      const prog = glbM ? this.glb : this.mesh;
      const u = prog.u;
      gl.useProgram(prog.prog);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniform3fv(u.uLightPos, lp);
      gl.uniform3fv(u.uLightCol, lc);
      gl.uniform1i(u.uLightCount, lights.length);
      gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
      gl.uniform1f(u.uTime, desc.t);
      gl.uniform1f(u.uWind, 0);
      gl.uniform3fv(u.uFog, [0, 0, 0]);
      gl.uniform3fv(u.uZenith, [0, 0, 0]);
      gl.uniform1f(u.uFogDensity, 0);
      gl.uniform3fv(u.uAmbient, [0.05, 0.05, 0.065]);
      gl.uniform3fv(u.uSunDir, [0, 1, 0]);
      gl.uniform3fv(u.uSunCol, [0, 0, 0]);
      gl.uniform1f(u.uStore, this.store);
      gl.uniform1f(u.uWet, 0);
      gl.uniformMatrix4fv(u.uShadowMat, false, ident());
      gl.uniform1f(u.uShadowOn, 0);
      [u.uAlbedo, u.uNormal, u.uMat, u.uDetail, u.uShadowMap, u.uGlbAlbedo, u.uGlbNormal, u.uGlbMR].forEach((loc, i) => loc && gl.uniform1i(loc, i));
      if (glbM) {
        this._drawGlbParts(this._glbGpu(glbM), u, true, n, glbM.skinned, 0, WHITE);
      } else {
        gl.uniformMatrix4fv(u.uBones, false, this._skin(rig, n));
        gl.uniform1f(u.uSky, 0);
        gl.uniform3fv(u.uTint, WHITE);
        gl.uniform1f(u.uEmit, 1);
        gl.uniform1f(u.uBase, 0);
        this._drawIndexed(this._skinned(`rig:${rigName}#${variant}`, () => rig.mesh));
      }
      gl.bindVertexArray(null);

      // Read back, average 2x2, ACES tone map and gamma, flip to top-down rows.
      const raw = this.hdr ? new Float32Array(px * px * 4) : new Uint8Array(px * px * 4);
      gl.readPixels(0, 0, px, px, gl.RGBA, this.hdr ? gl.FLOAT : gl.UNSIGNED_BYTE, raw);
      const scale = (this.hdr ? 1 : 1 / 255) / this.store;
      const aces = (/** @type {number} */ x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const c2 = cv.getContext('2d');
      if (!c2) throw new Error('2D canvas is not available');
      const img = c2.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const acc = [0, 0, 0, 0];
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const s = ((px - 1 - (y * 2 + oy)) * px + x * 2 + ox) * 4;
            for (let k = 0; k < 4; k++) acc[k] += raw[s + k] * (k < 3 ? scale : this.hdr ? 1 : 1 / 255);
          }
          const a = acc[3] / 4;
          const o = (y * size + x) * 4;
          for (let k = 0; k < 3; k++) img.data[o + k] = Math.pow(aces(acc[k] / 4 / Math.max(a, 1e-3)), 1 / 2.2) * 255;
          img.data[o + 3] = Math.min(1, a) * 255;
        }
      }
      c2.putImageData(img, 0, 0);
      url = cv.toDataURL('image/png');
    } catch (err) {
      console.warn('Portrait unavailable:', err);
      url = '';
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (rt) {
        gl.deleteFramebuffer(rt.fbo);
        gl.deleteTexture(rt.tex);
        if (rt.depth) gl.deleteTexture(rt.depth);
      }
    }
    this.portraits.set(cacheKey, url);
    return url;
  }

  /**
   * First-person weapon (right) and lantern (left), attached to the camera and drawn into the
   * front of the depth range. Lit like the world, so torches and shade fall across them.
   * @param {RenderView} v @param {Float32Array} view @param {Record<string, WebGLUniformLocation>} u @param {number} sky
   */
  _drawViewmodel(v, view, u, sky) {
    const vm = /** @type {ViewDesc} */ (v.view);
    const gl = this.gl;
    const cam = invert(view);
    // Inertia: the held items lag behind fast turns and settle back.
    const last = this.vmLast ?? { yaw: v.yaw, pitch: v.pitch };
    let dyaw = v.yaw - last.yaw;
    dyaw -= Math.round(dyaw / (Math.PI * 2)) * Math.PI * 2;
    const dpitch = v.pitch - last.pitch;
    this.vmLast = { yaw: v.yaw, pitch: v.pitch };
    const sway = this.vmSway;
    sway[0] += (Math.max(-0.05, Math.min(0.05, -dyaw * 1.6)) - sway[0]) * 0.18;
    sway[1] += (Math.max(-0.04, Math.min(0.04, -dpitch * 1.6)) - sway[1]) * 0.18;
    const bx = Math.sin(vm.bob) * 0.012 + sway[0];
    const by = -Math.abs(Math.cos(vm.bob)) * 0.012 + sway[1];
    /** @type {[string, Float32Array][]} */
    const parts = [];
    if (vm.item) {
      const sw = vm.item === 'fork' ? Math.sin(Math.min(1, vm.swing) * Math.PI) : 0;
      const rec = vm.recoil;
      const cast = vm.item === 'cast' ? vm.cast : 0;
      const blk = vm.block ? 1 : 0;
      const local = trs(
        0.24 + bx - 0.14 * sw - 0.1 * blk, -0.25 + by + 0.06 * sw + 0.08 * blk - (vm.item === 'cast' ? 0.03 : 0), -0.42 + 0.06 * rec - 0.12 * cast,
        0.35 + 0.9 * sw, 0.25 * rec - 0.4 * sw, 0.7 * blk + 0.5 * sw, 1,
      );
      parts.push([vm.item, mul(cam, local)]);
    }
    if (vm.lantern) parts.push(['lantern', mul(cam, trs(-0.34 - bx * 0.5, -0.24 + by, -0.62, -0.2, 0, 0, 0.75))]);
    if (!parts.length) return;
    gl.depthRange(0, VIEW_DEPTH);
    gl.uniform1f(u.uBase, -1e4);
    gl.uniform1f(u.uSky, sky);
    gl.uniform3fv(u.uTint, WHITE);
    gl.uniform1f(u.uEmit, vm.item === 'cast' ? 1 + vm.cast * 2 : 1);
    for (const [id, m] of parts) {
      const gpu = this._skinned(`view:${id}`, () => getViewmodel(id));
      this.bones.set(m, 0);
      gl.uniformMatrix4fv(u.uBones, false, this.bones.subarray(0, 16));
      this._drawIndexed(gpu);
    }
    gl.depthRange(0, 1);
    gl.uniformMatrix4fv(u.uBones, false, this.identBones);
  }
}
