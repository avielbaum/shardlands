/**
 * @file Raw WebGL 2.0 renderer (GLSL ES 3.00). World geometry samples 256px texture-array
 * layers (albedo, tangent-space normal, roughness/specular/cavity/metal) with mipmaps and
 * anisotropic filtering, a pixel-art-preserving sampler, derivative-based normal mapping,
 * Blinn-Phong sun + 16 point lights, world-space detail grunge, per-vertex corner AO, blob
 * contact shadows, soft-edged sorted sprites and exp2 height/distance fog. The scene renders
 * into an HDR framebuffer; post passes add bloom, FXAA, ACES tone mapping and warm/cool grading.
 */
import { buildWorldAtlas, buildSpriteAtlas, buildWorldMaterials, buildDetailTexture, uploadTexture, uploadArray, uploadRepeating, spriteUV, MAT_SIZE } from './textures.js';
import { TILE, CHUNK, Level } from './world.js';

/** @typedef {import('./world.js').Door} Door */
/** @typedef {import('./world.js').Light} Light */
/**
 * @typedef {Object} SpriteDesc
 * @property {number} x
 * @property {number} y bottom edge height
 * @property {number} z
 * @property {number} w
 * @property {number} h
 * @property {number} frame
 * @property {number} emit 0 none, 1 cyan-masked glow, 2 fully emissive
 * @property {number[]} tint
 * @property {number} sky 1 under open sky, 0 under a roof
 */
/**
 * @typedef {Object} Env
 * @property {number[]} fog
 * @property {number} fogDensity
 * @property {number[]} ambient
 * @property {number[]} sunDir unit vector toward the sun
 * @property {number[]} sunCol
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
 * @property {{dash:number, parry:number, hurt:number}} fx
 * @property {Env} env
 */

const FLOATS = 14; // pos3 uv2 normal3 emit1 tint3 sky1 layer1
const MAX_LIGHTS = 16;
const WHITE = [1, 1, 1];
const FULL_UV = [0, 0, 1, 1];
/** Draw modes shared by every scene draw call. */
const MODE = { WORLD: 0, SPRITE: 1, SHADOW: 2 };

const SCENE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec3 aNormal;
layout(location=3) in float aEmit;
layout(location=4) in vec3 aTint;
layout(location=5) in float aSky;
layout(location=6) in float aLayer;
uniform mat4 uViewProj;
out vec3 vPos; out vec2 vUV; out vec3 vNormal; out float vEmit; out vec3 vTint; out float vSky; out float vLayer;
void main() {
  vPos = aPos; vUV = aUV; vNormal = aNormal; vEmit = aEmit; vTint = aTint; vSky = aSky; vLayer = aLayer;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const SCENE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
#define MAX_LIGHTS ${MAX_LIGHTS}
in vec3 vPos; in vec2 vUV; in vec3 vNormal; in float vEmit; in vec3 vTint; in float vSky; in float vLayer;
uniform sampler2DArray uAlbedo;
uniform sampler2DArray uNormal;
uniform sampler2DArray uMat;
uniform sampler2D uDetail;
uniform sampler2D uSpriteTex;
uniform int uMode;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightCol[MAX_LIGHTS];
uniform int uLightCount;
uniform vec3 uEye;
uniform float uTime;
uniform vec3 uFog;
uniform float uFogDensity;
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uStore;
out vec4 outColor;

// Crisp texel edges up close (anti-aliased "sharp bilinear"), plain filtering when minified.
vec2 pixelUV(vec2 uv, vec2 size) {
  vec2 px = uv * size;
  vec2 w = max(fwidth(px), vec2(1e-4));
  vec2 crisp = (floor(px) + 0.5 + clamp((fract(px) - 0.5) / w, -0.5, 0.5)) / size;
  return mix(crisp, uv, clamp(max(w.x, w.y) - 0.5, 0.0, 1.0));
}

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

// exp2 distance fog plus a ground-hugging mist layer.
float fogAmount(float d, float y) {
  float f = 1.0 - exp(-pow(d * uFogDensity, 2.0));
  float mist = (1.0 - exp(-d * uFogDensity * 0.9)) * exp(-max(y - uEye.y + 1.2, 0.0) * 0.35);
  // Fully fogged by the streaming radius, so distant chunks and the world-edge cliffs never pop.
  return max(clamp(f + mist * 0.28 * (1.0 - f), 0.0, 1.0), smoothstep(44.0, 62.0, d));
}

// Haze brightens toward the sun (zero indoors, where uSunCol is black).
vec3 fogColor(vec3 dir) {
  return uFog + uSunCol * pow(max(dot(dir, uSunDir), 0.0), 8.0) * 0.18;
}

void main() {
  vec3 toEye = uEye - vPos;
  float dist = length(toEye);
  vec3 V = toEye / max(dist, 1e-4);
  if (uMode == 2) {
    float r = length(vUV * 2.0 - 1.0);
    float a = (1.0 - smoothstep(0.3, 1.0, r)) * 0.45 * (1.0 - fogAmount(dist, vPos.y));
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 N = normalize(vNormal);
  vec3 albedo;
  float alpha = 1.0;
  float rough = 0.85;
  float specI = 0.04;
  float cav = 1.0;
  float metal = 0.0;
  if (uMode == 1) {
    vec2 size = vec2(textureSize(uSpriteTex, 0));
    vec4 t = textureGrad(uSpriteTex, pixelUV(vUV, size), dFdx(vUV), dFdy(vUV));
    if (t.a < 0.08) discard;
    albedo = t.rgb;
    alpha = t.a;
  } else {
    vec2 uv = vUV;
    if (vEmit > 2.5) uv += vec2(uTime * 0.035, uTime * 0.021);
    vec2 g1 = dFdx(uv);
    vec2 g2 = dFdy(uv);
    vec3 suv = vec3(pixelUV(uv, vec2(${MAT_SIZE}.0)), vLayer);
    albedo = textureGrad(uAlbedo, suv, g1, g2).rgb;
    vec4 nm = textureGrad(uNormal, suv, g1, g2);
    vec4 mm = textureGrad(uMat, suv, g1, g2);
    rough = mm.r;
    specI = mm.g;
    cav = mm.b;
    metal = mm.a;
    N = perturb(N, vPos, uv, nm.xyz * 2.0 - 1.0);
    // World-space detail grunge, projected on the dominant axis, hides 1-unit tiling.
    vec3 an = abs(vNormal);
    vec2 duv = an.y > 0.7 ? vPos.xz : (an.x > an.z ? vPos.zy : vPos.xy);
    vec3 d1 = texture(uDetail, duv * 0.23).rgb;
    vec3 d2 = texture(uDetail, duv * 0.047).rgb;
    albedo *= (1.0 + (d1.r - 0.5) * 0.24) * (1.0 + (d2.g - 0.5) * 0.32);
    rough = clamp(rough + (d1.b - 0.5) * 0.2, 0.04, 1.0);
  }
  albedo *= vTint;

  float shin = mix(90.0, 6.0, rough);
  float sNorm = (shin + 8.0) / 25.0 * specI * (1.0 - rough * 0.7);
  float hemi = mix(0.55, 1.0, N.y * 0.5 + 0.5);
  vec3 diff = uAmbient * hemi * mix(0.55, 1.0, vSky) * cav;
  vec3 spec = vec3(0.0);
  if (vSky > 0.0) {
    float ndl = uMode == 1 ? 0.7 : max(dot(N, uSunDir), 0.0);
    diff += uSunCol * ndl * vSky;
    if (uMode == 0 && ndl > 0.0) spec += uSunCol * pow(max(dot(N, normalize(uSunDir + V)), 0.0), shin) * sNorm * vSky;
  }
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 L = uLightPos[i] - vPos;
    float d2 = dot(L, L);
    if (d2 > 256.0) continue;
    float d = sqrt(d2);
    vec3 Ld = L / max(d, 1e-4);
    float att = clamp(1.0 - d / 16.0, 0.0, 1.0) / (1.0 + 0.25 * d * d);
    float ndl = uMode == 1 ? 1.0 : max(dot(N, Ld), 0.0) * 0.85 + 0.15;
    diff += uLightCol[i] * att * ndl;
    if (uMode == 0) spec += uLightCol[i] * att * pow(max(dot(N, normalize(Ld + V)), 0.0), shin) * sNorm;
  }
  vec3 specCol = mix(vec3(1.0), albedo * 1.8, metal);
  vec3 col = albedo * diff + spec * specCol;
  if (vEmit > 2.5) {
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
    col = mix(col, fogColor(-V) * 1.05, fres * 0.65);
  } else if (vEmit > 0.0) {
    // Cyan-dominant or near-white texels glow; neutral steel and brass highlights do not.
    float mask = vEmit > 1.5 ? 1.0 : clamp(smoothstep(0.2, 0.45, max(albedo.g, albedo.b) - albedo.r) + smoothstep(0.9, 0.98, min(albedo.r, min(albedo.g, albedo.b))), 0.0, 1.0);
    float pulse = 0.7 + 0.3 * sin(uTime * 2.5 + vPos.x * 0.7 + vPos.z * 0.5 - vPos.y * 3.0);
    col += albedo * mask * pulse * 1.6;
  }
  col = mix(col, fogColor(-V), fogAmount(dist, vPos.y));
  outColor = vec4(col * uStore, alpha);
}`;

const POST_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Outdoor sky: horizon haze up to a time-of-day zenith, with a sun disc and glow that bloom.
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
  col += uSunCol * (pow(s, 900.0) * 6.0 + pow(s, 28.0) * 0.32);
  outColor = vec4(col * uStore, 1.0);
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

// FXAA edge softening, bloom, gameplay pulses, vignette, ACES tone map, split-tone grade.
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uDash, uParry, uHurt, uTime, uStore, uExposure;
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
    col = mix(col, acc * 0.25, 0.5 * uDash) + vec3(0.0, 0.3, 0.4) * uDash * r;
  }
  col += texture(uBloom, vUV).rgb / uStore * 0.65;
  col += vec3(0.9, 0.7, 0.25) * uParry * 0.2 * (1.0 - r);
  col *= mix(0.62, 1.0, smoothstep(0.85, 0.3, r));
  col = mix(col, col * vec3(1.4, 0.3, 0.25) + vec3(0.25, 0.0, 0.0), uHurt * smoothstep(0.2, 0.75, r));
  col = aces(col * uExposure);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += vec3(0.045, 0.02, -0.035) * smoothstep(0.45, 1.0, l) + vec3(-0.02, 0.0, 0.03) * (1.0 - smoothstep(0.0, 0.4, l));
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Every uniform each program declares; checked against the shader sources at startup. */
const UNIFORMS = {
  scene: ['uViewProj', 'uAlbedo', 'uNormal', 'uMat', 'uDetail', 'uSpriteTex', 'uMode', 'uLightPos', 'uLightCol', 'uLightCount', 'uEye', 'uTime', 'uFog', 'uFogDensity', 'uAmbient', 'uSunDir', 'uSunCol', 'uStore'],
  sky: ['uInvViewProj', 'uEye', 'uFog', 'uZenith', 'uSunDir', 'uSunCol', 'uStore'],
  bright: ['uScene', 'uTexel', 'uThreshold', 'uStore'],
  blur: ['uSrc', 'uDir'],
  composite: ['uScene', 'uBloom', 'uRes', 'uDash', 'uParry', 'uHurt', 'uTime', 'uStore', 'uExposure'],
};

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

/** Column-major a * b. @param {Float32Array} a @param {Float32Array} b */
function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

/** Growable vertex batch of textured quads and triangles. */
class Batch {
  /** @param {number} quads initial capacity */
  constructor(quads) {
    this.data = new Float32Array(quads * 6 * FLOATS);
    this.n = 0;
  }

  reset() {
    this.n = 0;
  }

  get vertexCount() {
    return this.n / FLOATS;
  }

  /** @param {number} floats */
  _reserve(floats) {
    if (this.n + floats <= this.data.length) return;
    const next = new Float32Array(Math.max(this.data.length * 2, this.n + floats));
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }

  /**
   * @param {number} x @param {number} y @param {number} z @param {number} u @param {number} v
   * @param {number[]} nrm @param {number} emit @param {number[]} tint @param {number} shade per-vertex AO
   * @param {number} sky @param {number} layer
   */
  _v(x, y, z, u, v, nrm, emit, tint, shade, sky, layer) {
    const d = this.data;
    let i = this.n;
    d[i++] = x; d[i++] = y; d[i++] = z; d[i++] = u; d[i++] = v;
    d[i++] = nrm[0]; d[i++] = nrm[1]; d[i++] = nrm[2];
    d[i++] = emit; d[i++] = tint[0] * shade; d[i++] = tint[1] * shade; d[i++] = tint[2] * shade;
    d[i++] = sky; d[i++] = layer;
    this.n = i;
  }

  /**
   * Quad from corners top-left, top-right, bottom-right, bottom-left.
   * @param {number[]} p 12 floats @param {number[]} uv [u0, v0, u1, v1] @param {number[]} nrm @param {number} emit
   * @param {number[]} tint @param {number} sky @param {number} layer texture-array layer (-1 for sprites)
   * @param {number[]} [ao] per-corner occlusion in the same corner order
   */
  quad(p, uv, nrm, emit, tint, sky, layer, ao) {
    this._reserve(6 * FLOATS);
    const us = [uv[0], uv[2], uv[2], uv[0]];
    const vs = [uv[1], uv[1], uv[3], uv[3]];
    for (const c of [0, 1, 2, 0, 2, 3]) this._v(p[c * 3], p[c * 3 + 1], p[c * 3 + 2], us[c], vs[c], nrm, emit, tint, ao ? ao[c] : 1, sky, layer);
  }

  /**
   * One triangle with per-vertex UVs and occlusion, and a flat upward-facing normal.
   * @param {number[][]} pts three [x, y, z] @param {number[][]} uvs three [u, v] @param {number[]} ao
   * @param {number} emit @param {number} sky @param {number} layer
   */
  tri(pts, uvs, ao, emit, sky, layer) {
    this._reserve(3 * FLOATS);
    const [a, b, c] = pts;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    const n = [nx / l, ny / l, nz / l];
    for (let k = 0; k < 3; k++) this._v(pts[k][0], pts[k][1], pts[k][2], uvs[k][0], uvs[k][1], n, emit, WHITE, ao[k], sky, layer);
  }
}

/**
 * Vertical face between two floor-plan points, split into ~1 unit bands so wall textures
 * keep their proportions; darkened toward the floor seam (and the ceiling seam indoors).
 * @param {Batch} b @param {number} x0 @param {number} z0 @param {number} x1 @param {number} z1
 * @param {number} y0 @param {number} y1 @param {number} tile @param {number[]} nrm @param {number} emit @param {number} sky
 * @param {number} ceilY height of a ceiling seam to shade, or Infinity
 */
function vface(b, x0, z0, x1, z1, y0, y1, tile, nrm, emit, sky, ceilY) {
  if (y1 - y0 < 0.01) return;
  const bands = Math.max(1, Math.round(y1 - y0));
  const step = (y1 - y0) / bands;
  /** @param {number} y */
  const ao = (y) => Math.min(0.55 + 0.45 * Math.min(1, (y - y0) / 0.9), 0.72 + 0.28 * Math.min(1, Math.max(0, ceilY - y) / 0.6));
  for (let s = 0; s < bands; s++) {
    const lo = y0 + s * step;
    const hi = lo + step;
    const a = [ao(hi), ao(hi), ao(lo), ao(lo)];
    b.quad([x0, hi, z0, x1, hi, z1, x1, lo, z1, x0, lo, z0], FULL_UV, nrm, emit, WHITE, sky, tile, a);
  }
}

/** Horizontal quad over a cell. @param {Batch} b @param {number} i @param {number} j @param {number} y @param {number} tile @param {number} ny @param {number} emit @param {number} sky @param {number[]} [ao] */
function hface(b, i, j, y, tile, ny, emit, sky, ao) {
  b.quad([i, y, j, i + 1, y, j, i + 1, y, j + 1, i, y, j + 1], FULL_UV, [0, ny, 0], emit, WHITE, sky, tile, ao);
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

/**
 * Build the static mesh for one chunk of a level.
 * @param {Level} L @param {number} cx @param {number} cz @param {Batch} b
 */
function buildChunk(L, cx, cz, b) {
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
        if (L.outdoor) hface(b, i, j, top, tex === TILE.TIMBER ? TILE.ROOF : tex, 1, 0, 1);
        continue;
      }
      const ftex = L.floorTex[k];
      const femit = tileEmit(ftex);
      const ao = [cornerAO(L, i, j, 0.16), cornerAO(L, i + 1, j, 0.16), cornerAO(L, i + 1, j + 1, 0.16), cornerAO(L, i, j + 1, 0.16)];
      let low = L.floorH[k];
      if (L.smooth) {
        const h00 = L.vh[j * W + i];
        const h10 = L.vh[j * W + i + 1];
        const h01 = L.vh[(j + 1) * W + i];
        const h11 = L.vh[(j + 1) * W + i + 1];
        low = Math.min(h00, h10, h01, h11);
        const A = [i, h00, j];
        const B = [i + 1, h10, j];
        const C = [i + 1, h11, j + 1];
        const D = [i, h01, j + 1];
        b.tri([A, B, C], [[0, 0], [1, 0], [1, 1]], [ao[0], ao[1], ao[2]], femit, sky, ftex);
        b.tri([A, C, D], [[0, 0], [1, 1], [0, 1]], [ao[0], ao[2], ao[3]], femit, sky, ftex);
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
        if (L.outdoor) hface(b, i, j, ceil + 0.3, TILE.ROOF, 1, 0, 1);
      }
      if (low < L.waterLevel) hface(b, i, j, L.waterLevel, TILE.WATER, 1, 3, sky);
    }
  }
}

/**
 * @typedef {Object} Target
 * @property {WebGLFramebuffer} fbo
 * @property {WebGLTexture} tex
 * @property {WebGLRenderbuffer|null} depth
 * @property {number} w
 * @property {number} h
 */

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
    const aniso = anisoExt ? Math.min(8, gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1;
    this.scene = createProgram(gl, SCENE_VS, SCENE_FS, UNIFORMS.scene);
    this.sky = createProgram(gl, POST_VS, SKY_FS, UNIFORMS.sky);
    this.bright = createProgram(gl, POST_VS, BRIGHT_FS, UNIFORMS.bright);
    this.blur = createProgram(gl, POST_VS, BLUR_FS, UNIFORMS.blur);
    this.composite = createProgram(gl, POST_VS, COMPOSITE_FS, UNIFORMS.composite);
    const mats = buildWorldMaterials(buildWorldAtlas());
    this.albedoTex = uploadArray(gl, mats.albedo, mats.size, mats.layers, aniso);
    this.normalTex = uploadArray(gl, mats.normal, mats.size, mats.layers, aniso);
    this.matTex = uploadArray(gl, mats.mat, mats.size, mats.layers, aniso);
    this.detailTex = uploadRepeating(gl, buildDetailTexture(), MAT_SIZE, aniso);
    this.spriteAtlas = buildSpriteAtlas();
    this.spriteTex = uploadTexture(gl, this.spriteAtlas, 4, aniso);
    /** @type {Map<number, {buf:{vao:WebGLVertexArrayObject, vbo:WebGLBuffer}, count:number, cx:number, cz:number}>} */
    this.chunks = new Map();
    /** @type {Level|null} */
    this.level = null;
    this.chunkBatch = new Batch(4096);
    this.doorBatch = new Batch(256);
    this.doorBuf = this._makeBuffer();
    this.spriteBatch = new Batch(4096);
    this.spriteBuf = this._makeBuffer();
    this.shadowBatch = new Batch(1024);
    this.shadowBuf = this._makeBuffer();
    this.postVAO = gl.createVertexArray();
    /** @type {Target|null} */
    this.sceneRT = null;
    /** @type {Target|null} */
    this.bloomA = null;
    /** @type {Target|null} */
    this.bloomB = null;
    this.lightPos = new Float32Array(MAX_LIGHTS * 3);
    this.lightCol = new Float32Array(MAX_LIGHTS * 3);
  }

  /** @returns {{vao: WebGLVertexArrayObject, vbo: WebGLBuffer}} */
  _makeBuffer() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('Could not allocate GPU buffers');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = FLOATS * 4;
    for (const [l, size, off] of [[0, 3, 0], [1, 2, 12], [2, 3, 20], [3, 1, 32], [4, 3, 36], [5, 1, 48], [6, 1, 52]]) {
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
    }
    gl.bindVertexArray(null);
    return { vao, vbo };
  }

  /** Drop every chunk mesh and switch to another level. @param {Level} level */
  setLevel(level) {
    for (const key of [...this.chunks.keys()]) this.unloadChunk(key);
    this.level = level;
  }

  /** Build and upload one chunk's mesh. @param {number} key */
  loadChunk(key) {
    if (!this.level || this.chunks.has(key)) return;
    const cx = key % 1024;
    const cz = Math.floor(key / 1024);
    buildChunk(this.level, cx, cz, this.chunkBatch);
    const gl = this.gl;
    const buf = this._makeBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.chunkBatch.data.subarray(0, this.chunkBatch.n), gl.STATIC_DRAW);
    this.chunks.set(key, { buf, count: this.chunkBatch.vertexCount, cx, cz });
  }

  /** @param {number} key */
  unloadChunk(key) {
    const c = this.chunks.get(key);
    if (!c) return;
    this.gl.deleteBuffer(c.buf.vbo);
    this.gl.deleteVertexArray(c.buf.vao);
    this.chunks.delete(key);
  }

  /**
   * (Re)create a render target.
   * @param {Target|null} old @param {number} w @param {number} h @param {boolean} depth @returns {Target}
   */
  _target(old, w, h, depth) {
    const gl = this.gl;
    if (old) {
      gl.deleteFramebuffer(old.fbo);
      gl.deleteTexture(old.tex);
      if (old.depth) gl.deleteRenderbuffer(old.depth);
    }
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error('Could not allocate render target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    /** @type {WebGLRenderbuffer|null} */
    let rb = null;
    if (depth) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, depth: rb, w, h };
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
  }

  /** Sliding door panels plus lintels. @param {Door[]} doors @param {number} time */
  _buildDoors(doors, time) {
    const b = this.doorBatch;
    b.reset();
    for (const d of doors) {
      const pulse = Math.sin(time * 4);
      const tint = d.locked && (d.magic || d.puzzle) ? [0.7, 1.0 + 0.3 * pulse, 1.4 + 0.4 * pulse] : WHITE;
      const y0 = d.base;
      const y1 = d.base + d.height;
      const slide = d.open * 0.95;
      const emit = tileEmit(d.tex) || (d.magic ? 1 : 0);
      const sky = this.level && this.level.outdoor && this.level.ceil[this.level.idx(d.i, d.j)] === 0 ? 1 : 0;
      const ao = [1, 1, 0.6, 0.6];
      if (d.axis === 'x') {
        const x0 = d.i + slide;
        const x1 = x0 + 1;
        const za = d.j + 0.42;
        const zb = d.j + 0.58;
        b.quad([x0, y1, za, x1, y1, za, x1, y0, za, x0, y0, za], FULL_UV, [0, 0, -1], emit, tint, sky, d.tex, ao);
        b.quad([x1, y1, zb, x0, y1, zb, x0, y0, zb, x1, y0, zb], FULL_UV, [0, 0, 1], emit, tint, sky, d.tex, ao);
        b.quad([x0, y1, zb, x0, y1, za, x0, y0, za, x0, y0, zb], [0, 0, 0.16, 1], [-1, 0, 0], emit, tint, sky, d.tex, ao);
        vface(b, d.i, d.j, d.i + 1, d.j, y1, d.top, d.tex, [0, 0, -1], emit, sky, Infinity);
        vface(b, d.i, d.j + 1, d.i + 1, d.j + 1, y1, d.top, d.tex, [0, 0, 1], emit, sky, Infinity);
      } else {
        const z0 = d.j + slide;
        const z1 = z0 + 1;
        const xa = d.i + 0.42;
        const xb = d.i + 0.58;
        b.quad([xa, y1, z1, xa, y1, z0, xa, y0, z0, xa, y0, z1], FULL_UV, [-1, 0, 0], emit, tint, sky, d.tex, ao);
        b.quad([xb, y1, z0, xb, y1, z1, xb, y0, z1, xb, y0, z0], FULL_UV, [1, 0, 0], emit, tint, sky, d.tex, ao);
        b.quad([xa, y1, z0, xb, y1, z0, xb, y0, z0, xa, y0, z0], [0, 0, 0.16, 1], [0, 0, -1], emit, tint, sky, d.tex, ao);
        vface(b, d.i, d.j + 1, d.i, d.j, y1, d.top, d.tex, [-1, 0, 0], emit, sky, Infinity);
        vface(b, d.i + 1, d.j, d.i + 1, d.j + 1, y1, d.top, d.tex, [1, 0, 0], emit, sky, Infinity);
      }
      b.quad([d.i, y1, d.j, d.i + 1, y1, d.j, d.i + 1, y1, d.j + 1, d.i, y1, d.j + 1], FULL_UV, [0, -1, 0], emit, WHITE, 0, d.tex);
    }
  }

  /**
   * Sprites sorted back to front (soft edges blend), darkened toward their feet, plus a
   * ground contact shadow under every standing sprite.
   * @param {SpriteDesc[]} sprites @param {number} yaw @param {{x:number, z:number}} eye
   */
  _buildSprites(sprites, yaw, eye) {
    const b = this.spriteBatch;
    const sh = this.shadowBatch;
    b.reset();
    sh.reset();
    const rx = -Math.sin(yaw);
    const rz = Math.cos(yaw);
    const nrm = [-Math.cos(yaw), 0, -Math.sin(yaw)];
    const order = sprites.map((s) => ({ s, d: (s.x - eye.x) ** 2 + (s.z - eye.z) ** 2 })).sort((a, c) => c.d - a.d);
    const L = this.level;
    for (const { s } of order) {
      const hx = rx * s.w * 0.5;
      const hz = rz * s.w * 0.5;
      const top = s.y + s.h;
      const standing = s.h >= 0.9 && s.emit < 2;
      const ao = standing ? [1, 1, 0.62, 0.62] : undefined;
      b.quad([s.x - hx, top, s.z - hz, s.x + hx, top, s.z + hz, s.x + hx, s.y, s.z + hz, s.x - hx, s.y, s.z - hz], spriteUV(s.frame), nrm, s.emit, s.tint, s.sky, -1, ao);
      if (standing && L) {
        const r = s.w * 0.3;
        const g = L.heightAt(s.x, s.z) + 0.03;
        sh.quad([s.x - r, g, s.z - r, s.x + r, g, s.z - r, s.x + r, g, s.z + r, s.x - r, g, s.z + r], FULL_UV, [0, 1, 0], 0, WHITE, 1, -1);
      }
    }
  }

  /** Pick the lights nearest the eye, apply flicker, pack into uniform arrays. @param {Light[]} lights @param {{x:number,y:number,z:number}} eye @param {number} time */
  _packLights(lights, eye, time) {
    const sorted = lights.map((l) => ({ l, d: (l.x - eye.x) ** 2 + (l.z - eye.z) ** 2 })).sort((a, b) => a.d - b.d);
    const n = Math.min(this.maxLights, MAX_LIGHTS, sorted.length);
    for (let i = 0; i < n; i++) {
      const { l } = sorted[i];
      const f = l.flicker ? 1 - l.flicker * (0.5 + 0.5 * Math.sin(time * 13 + l.x) * Math.sin(time * 7.3 + l.z)) : 1;
      this.lightPos.set([l.x, l.y, l.z], i * 3);
      this.lightCol.set([l.r * f, l.g * f, l.b * f], i * 3);
    }
    return n;
  }

  /** @param {{vao: WebGLVertexArrayObject, vbo: WebGLBuffer}} buf @param {Batch} batch */
  _drawBatch(buf, batch) {
    if (!batch.n) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.n), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(buf.vao);
    gl.drawArrays(gl.TRIANGLES, 0, batch.vertexCount);
  }

  /** Draw a fullscreen pass into a target (or the canvas). @param {Target|null} rt */
  _pass(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null);
    gl.viewport(0, 0, rt ? rt.w : this.canvas.width, rt ? rt.h : this.canvas.height);
    gl.bindVertexArray(this.postVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Render one frame. @param {RenderView} v */
  render(v) {
    this.resize();
    const gl = this.gl;
    const scene = /** @type {Target} */ (this.sceneRT);
    const bloomA = /** @type {Target} */ (this.bloomA);
    const bloomB = /** @type {Target} */ (this.bloomB);
    const { u } = this.scene;
    const cp = Math.cos(v.pitch);
    const fwd = [Math.cos(v.yaw) * cp, Math.sin(v.pitch), Math.sin(v.yaw) * cp];
    const viewProj = multiply(perspective((70 * Math.PI) / 180, scene.w / scene.h, 0.05, 140), viewMatrix([v.eye.x, v.eye.y, v.eye.z], fwd));
    const env = v.env;

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fbo);
    gl.viewport(0, 0, scene.w, scene.h);
    gl.clearColor(env.fog[0] * this.store, env.fog[1] * this.store, env.fog[2] * this.store, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    if (this.level && this.level.outdoor) {
      // Sky first, without touching depth; daylight is read from the sun colour.
      const day = Math.min(1, Math.max(0, env.sunCol[1]));
      const zen = [env.fog[0] * 0.35 + (0.3 - env.fog[0] * 0.35) * day, env.fog[1] * 0.4 + (0.5 - env.fog[1] * 0.4) * day, env.fog[2] * 0.6 + (0.86 - env.fog[2] * 0.6) * day];
      const su = this.sky.u;
      gl.useProgram(this.sky.prog);
      gl.uniformMatrix4fv(su.uInvViewProj, false, invert(viewProj));
      gl.uniform3f(su.uEye, v.eye.x, v.eye.y, v.eye.z);
      gl.uniform3fv(su.uFog, env.fog);
      gl.uniform3fv(su.uZenith, zen);
      gl.uniform3fv(su.uSunDir, env.sunDir);
      gl.uniform3fv(su.uSunCol, env.sunCol);
      gl.uniform1f(su.uStore, this.store);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.bindVertexArray(this.postVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }
    gl.useProgram(this.scene.prog);
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    const n = this._packLights(v.lights, v.eye, v.time);
    gl.uniform3fv(u.uLightPos, this.lightPos);
    gl.uniform3fv(u.uLightCol, this.lightCol);
    gl.uniform1i(u.uLightCount, n);
    gl.uniform3f(u.uEye, v.eye.x, v.eye.y, v.eye.z);
    gl.uniform1f(u.uTime, v.time);
    gl.uniform3fv(u.uFog, env.fog);
    gl.uniform1f(u.uFogDensity, env.fogDensity);
    gl.uniform3fv(u.uAmbient, env.ambient);
    gl.uniform3fv(u.uSunDir, env.sunDir);
    gl.uniform3fv(u.uSunCol, env.sunCol);
    gl.uniform1f(u.uStore, this.store);
    const units = [[u.uAlbedo, gl.TEXTURE_2D_ARRAY, this.albedoTex], [u.uNormal, gl.TEXTURE_2D_ARRAY, this.normalTex], [u.uMat, gl.TEXTURE_2D_ARRAY, this.matTex],
      [u.uDetail, gl.TEXTURE_2D, this.detailTex], [u.uSpriteTex, gl.TEXTURE_2D, this.spriteTex]];
    units.forEach(([loc, target, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(/** @type {number} */ (target), /** @type {WebGLTexture} */ (tex));
      gl.uniform1i(/** @type {WebGLUniformLocation} */ (loc), i);
    });

    gl.uniform1i(u.uMode, MODE.WORLD);
    const fx = Math.cos(v.yaw);
    const fz = Math.sin(v.yaw);
    for (const c of this.chunks.values()) {
      const dx = (c.cx + 0.5) * CHUNK - v.eye.x;
      const dz = (c.cz + 0.5) * CHUNK - v.eye.z;
      const d = Math.hypot(dx, dz);
      if (d > CHUNK * 1.5 && (dx * fx + dz * fz) / d < -0.35) continue;
      gl.bindVertexArray(c.buf.vao);
      gl.drawArrays(gl.TRIANGLES, 0, c.count);
    }
    this._buildDoors(v.doors, v.time);
    this._drawBatch(this.doorBuf, this.doorBatch);

    this._buildSprites(v.sprites, v.yaw, v.eye);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -4);
    gl.uniform1i(u.uMode, MODE.SHADOW);
    this._drawBatch(this.shadowBuf, this.shadowBatch);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.uniform1i(u.uMode, MODE.SPRITE);
    this._drawBatch(this.spriteBuf, this.spriteBatch);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

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
    gl.uniform2f(cu.uRes, scene.w, scene.h);
    gl.uniform1f(cu.uDash, v.fx.dash);
    gl.uniform1f(cu.uParry, v.fx.parry);
    gl.uniform1f(cu.uHurt, v.fx.hurt);
    gl.uniform1f(cu.uTime, v.time);
    gl.uniform1f(cu.uStore, this.store);
    gl.uniform1f(cu.uExposure, 1.2);
    this._pass(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }
}
