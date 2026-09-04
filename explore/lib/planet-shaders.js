/* ===================================================================
   /explore/lib/planet-shaders.js
   Procedural planet surfaces for the star system renderer.

   Nothing here is observed. Every surface is a guess driven by the
   handful of catalogued numbers a planet has (class, equilibrium
   temperature, radius, tidal locking). Each material carries
   material.userData.imagined so the page can say so.

   This module does NOT import three. The page passes THREE in so
   that only one copy of the library exists.

   Exports:
     makePlanetMaterial(THREE, { cls, teq, radius_km, seed, tidally_locked })
     makeAtmosphere(THREE, { radius_units, color, strength, ratio })

   Shader notes:
     - Written for GLSL ES 1.00 so it compiles on WebGL1 and WebGL2
       (three prepends the right version header and #defines).
     - Lighting is done in object space. The vertex shader moves the
       light direction and the camera into object space, so world
       coordinates of order 1e5 units never reach the fragment stage.
     - Log-depth chunks are included so the materials depth-test
       correctly against everything else when the renderer uses
       logarithmicDepthBuffer: true.
     - Uniforms the page must drive each frame:
         uLightDir   world-space unit vector, planet centre -> star
         uLightColor linear RGB of the star light (use light.color
                     from makeStar, which is already linear)
         uTime       seconds
   =================================================================== */

const EARTH_RADIUS_KM = 6371;

/* ------------------------------------------------------------------
   GLSL: hash, gradient noise, fbm, ridged, worley. Shared by all
   fragment shaders in this module and by star.js (duplicated there
   so each module stays standalone).
   ------------------------------------------------------------------ */
export const NOISE_GLSL = /* glsl */`
float hash1(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash3(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float gnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(hash3(i + vec3(0.0, 0.0, 0.0)) * 2.0 - 1.0, f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(hash3(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(hash3(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(hash3(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(hash3(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0, f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(hash3(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0, f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(hash3(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0, f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(hash3(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0, f - vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return clamp(mix(nxy0, nxy1, u.z) * 1.6, -1.0, 1.0);
}
float fbm(vec3 p) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * gnoise3(p);
    norm += amp;
    p = p * 2.03 + vec3(17.3, 9.1, 31.7);
    amp *= 0.5;
  }
  return sum / norm;
}
float ridged(vec3 p) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(gnoise3(p));
    sum += amp * n * n;
    norm += amp;
    p = p * 2.11 + vec3(5.2, 13.7, 3.3);
    amp *= 0.5;
  }
  return sum / norm;
}
vec2 worley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float best = 8.0;
  float id = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 h = hash3(i + g);
        vec3 r = g + h - f;
        float d = dot(r, r);
        if (d < best) {
          best = d;
          id = hash1(i + g + 7.0);
        }
      }
    }
  }
  return vec2(sqrt(best), id);
}
`;

/* ------------------------------------------------------------------
   Vertex shader shared by planet surfaces and atmosphere shells.
   Moves the star direction and the camera into object space.
   Assumes the mesh has uniform scale (a sphere).
   ------------------------------------------------------------------ */
const PLANET_VERT = /* glsl */`
uniform vec3 uLightDir;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vLightObj;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vObjPos = position;
  vec3 dCam = cameraPosition - modelMatrix[3].xyz;
  float s2 = dot(modelMatrix[0].xyz, modelMatrix[0].xyz);
  vec3 camObj = (dCam * mat3(modelMatrix)) / s2;
  vViewObj = camObj - position;
  vLightObj = normalize(uLightDir * mat3(modelMatrix));
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

/* ------------------------------------------------------------------
   Solid worlds: terrestrial and super-earth, all temperatures.
   Ice, rock, ochre rock and lava are the same program driven by
   uniforms, so a planet near a temperature boundary blends instead
   of flipping.
   ------------------------------------------------------------------ */
const SOLID_FRAG = /* glsl */`
uniform vec3 uLightColor;
uniform float uTime;
uniform vec3 uOffset;
uniform vec3 uColLow;
uniform vec3 uColHigh;
uniform vec3 uColDark;
uniform vec3 uShadowTint;
uniform vec3 uGlow;
uniform float uFreq;
uniform float uCraterDensity;
uniform float uCraterFreq;
uniform float uCraterAmp;
uniform float uBump;
uniform float uRim;
uniform float uWrap;
uniform float uSpec;
uniform float uShiny;
uniform float uGlowAmt;
uniform float uMeltAmt;
uniform float uFracAmt;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vLightObj;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
float terrainH(vec3 p) {
  vec3 q = p * uFreq + uOffset;
  float base = fbm(q * 1.3);
  float rg = ridged(q * 2.6 + 4.0);
  float h = base * 0.6 + (rg - 0.5) * 0.4;
  vec2 w = worley(q * uCraterFreq + 9.0);
  float on = step(w.y, uCraterDensity);
  float sz = clamp(w.y / max(uCraterDensity, 0.001), 0.0, 1.0);
  float R = 0.14 + 0.30 * sz;
  float x = w.x / R;
  float bowl = 1.0 - smoothstep(0.0, 1.0, x);
  float t = (x - 1.0) * 4.0;
  float rim = exp(-t * t);
  float crater = (rim * 0.35 - bowl * bowl * 0.9) * (0.35 + 0.65 * sz) * on;
  return h + crater * uCraterAmp;
}
vec3 bumpNormal(vec3 p, float eps, float scale, out float h0) {
  vec3 t;
  if (abs(p.y) < 0.98) {
    t = normalize(cross(vec3(0.0, 1.0, 0.0), p));
  } else {
    t = vec3(1.0, 0.0, 0.0);
  }
  vec3 b = normalize(cross(p, t));
  h0 = terrainH(p);
  float hx = terrainH(normalize(p + t * eps));
  float hy = terrainH(normalize(p + b * eps));
  vec3 n = p - (t * (hx - h0) + b * (hy - h0)) * (scale / eps);
  return normalize(n);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vLightObj);
  float h0 = 0.0;
  vec3 N = bumpNormal(p, 0.004, uBump, h0);
  vec3 q = p * uFreq + uOffset;

  float macro = dot(p, L);
  float micro = dot(N, L);
  float diff = clamp((micro + uWrap) / (1.0 + uWrap), 0.0, 1.0) * smoothstep(-0.3, 0.1, macro);

  float hn = clamp(h0 * 0.9 + 0.5, 0.0, 1.0);
  vec3 alb = mix(uColLow, uColHigh, hn);
  float patches = fbm(q * 0.6 + 21.0);
  alb = mix(alb, uColDark, smoothstep(0.12, 0.45, patches) * 0.8);
  float grain = fbm(q * 8.0 + 3.0);
  alb *= 1.0 + grain * 0.15;

  float fr = clamp(1.0 - abs(gnoise3(q * 2.4 + 17.0)), 0.0, 1.0);
  fr = pow(fr, 12.0) * clamp(0.6 + fbm(q * 3.0 + 8.0), 0.0, 1.0);
  alb = mix(alb, uColDark, fr * uFracAmt);

  vec3 col = alb * diff * uLightColor;
  col += uShadowTint * alb * (1.0 - diff) * smoothstep(-0.4, 0.35, macro) * 0.35;

  vec3 H = normalize(L + V);
  float sp = pow(clamp(dot(N, H), 0.0, 1.0), uShiny) * uSpec * diff;
  col += uLightColor * sp;

  float ndv = clamp(dot(p, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.5);
  col += uLightColor * fres * uRim * clamp(macro * 0.8 + 0.4, 0.0, 1.0);

  float cr = clamp(1.0 - abs(gnoise3(q * 2.2 + 11.0) * 0.75 + gnoise3(q * 6.5 + 5.0) * 0.25), 0.0, 1.0);
  float crackMask = smoothstep(-0.1, 0.45, fbm(q * 0.7 + 31.0));
  float cracks = smoothstep(0.955, 0.995, cr) * crackMask;
  float melt = smoothstep(0.2, 0.8, macro) * uMeltAmt;
  float pool = smoothstep(0.30, 0.60, fbm(q * 0.9 + 2.0) + 0.2) * melt;
  float glow = clamp(max(cracks, pool) * uGlowAmt, 0.0, 1.0);
  float flick = 0.92 + 0.08 * sin(uTime * 0.9 + h0 * 25.0 + p.x * 3.0);
  vec3 glowCol = uGlow * flick;
  col = mix(col, glowCol * 1.4, glow);
  col += glowCol * pool * uGlowAmt * 0.5;

  col += alb * uLightColor * 0.004;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------
   Gas giants and neptune-like worlds. Bands by latitude, displaced
   by turbulence, streaky detail, optional storm ovals, limb
   darkening, haze and rim, and thermal glow for the hottest ones.
   ------------------------------------------------------------------ */
const GAS_FRAG = /* glsl */`
uniform vec3 uLightColor;
uniform float uTime;
uniform vec3 uOffset;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uStormCol;
uniform vec3 uStorm0;
uniform vec3 uStorm1;
uniform vec2 uStormSize0;
uniform vec2 uStormSize1;
uniform vec3 uEmitCol;
uniform float uStormAmt;
uniform float uBandFreq;
uniform float uContrast;
uniform float uTurb;
uniform float uHaze;
uniform float uRim;
uniform float uWrap;
uniform float uDrift;
uniform float uEmit;
uniform float uFreq;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vLightObj;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
vec3 rotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 stormMix(vec3 alb, vec3 r, vec3 c, vec2 size, vec3 stormCol, float amp) {
  vec3 e = normalize(cross(vec3(0.0, 1.0, 0.0), c));
  vec3 n = normalize(cross(c, e));
  vec3 d = r - c;
  float dx = dot(d, e) / size.x;
  float dy = dot(d, n) / size.y;
  float rr = dx * dx + dy * dy;
  float ang = atan(dy, dx);
  float swirl = 0.5 + 0.5 * sin(rr * 9.0 - ang * 2.0 + fbm(r * 6.0) * 2.0);
  float mask = 1.0 - smoothstep(0.55, 1.0, rr);
  vec3 inner = mix(stormCol, alb, swirl * 0.5);
  return mix(alb, inner, mask * amp);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vLightObj);
  float lat = p.y;
  float drift = uTime * uDrift * (0.6 + 0.8 * cos(lat * 4.7));
  vec3 r = rotY(p, drift);
  vec3 q = vec3(r.x, r.y * 3.0, r.z) * uFreq + uOffset;
  float warp = fbm(vec3(r.x, r.y * 1.5, r.z) * (uFreq * 1.7) + uOffset.zxy);
  float latW = lat + warp * uTurb * (1.0 - 0.6 * lat * lat);
  float b1 = sin(latW * uBandFreq + uOffset.x);
  float b2 = sin(latW * uBandFreq * 2.3 + 1.7 + uOffset.y);
  float b3 = sin(latW * uBandFreq * 0.45 + 0.4 + uOffset.z);
  float bands = 0.5 + 0.5 * (b1 * 0.55 + b2 * 0.25 + b3 * 0.2);
  bands = smoothstep(0.15, 0.85, bands);
  float detail = fbm(q * 2.0);
  float fine = fbm(q * 5.0 + 13.0);
  float mixv = clamp(bands + (detail * 0.7 + fine * 0.3) * uContrast, 0.0, 1.0);
  vec3 alb = mix(uColA, uColB, mixv);
  float streak = smoothstep(0.35, 0.8, abs(detail * 0.6 + fine * 0.6));
  alb = mix(alb, uColC, clamp(streak * uContrast, 0.0, 1.0));
  alb = mix(alb, uColC, smoothstep(0.72, 0.95, abs(lat)) * 0.45);
  alb = stormMix(alb, r, uStorm0, uStormSize0, uStormCol, uStormAmt);
  alb = stormMix(alb, r, uStorm1, uStormSize1, uStormCol, uStormAmt * 0.7);

  float ndl = dot(p, L);
  float diff = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  float ndv = clamp(dot(p, V), 0.0, 1.0);
  float limb = mix(0.55, 1.0, sqrt(ndv));
  vec3 col = alb * diff * uLightColor * limb;

  float fres = pow(1.0 - ndv, 3.0);
  float litRim = clamp(ndl * 0.8 + 0.45, 0.0, 1.0);
  col += uLightColor * fres * uRim * litRim;
  vec3 hazeCol = uLightColor * (alb * 0.6 + 0.4) * diff;
  col = mix(col, hazeCol, fres * uHaze);

  col += uEmitCol * uEmit * (0.55 + 0.45 * mixv);
  col += alb * uLightColor * 0.004;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------
   Atmosphere shell: BackSide sphere slightly larger than the planet,
   additive Fresnel rim, lit side only.
   uK = sqrt(1 - (Rp/Rs)^2): the value of -(n.v) at the planet limb,
   so the glow is brightest where it meets the disk and fades to
   nothing at the shell edge.
   ------------------------------------------------------------------ */
const ATMO_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uStrength;
uniform float uK;
varying vec3 vObjPos;
varying vec3 vViewObj;
varying vec3 vLightObj;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  vec3 L = normalize(vLightObj);
  float ndv = dot(n, V);
  float x = clamp(-ndv / uK, 0.0, 1.0);
  float rim = pow(x, 1.6) * 0.85 + pow(x, 6.0) * 0.35;
  float lit = smoothstep(-0.55, 0.45, dot(n, L));
  vec3 col = uColor * rim * lit * uStrength * 1.3;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------
   Palette helpers (JS side). Colours are sRGB hex; THREE.Color
   converts them to linear on construction (ColorManagement on).
   ------------------------------------------------------------------ */
function stopColor(THREE, stops, t) {
  if (t <= stops[0][0]) return new THREE.Color(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const f = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return new THREE.Color(stops[i - 1][1]).lerp(new THREE.Color(stops[i][1]), f);
    }
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}

function ramp(t, a, b) {
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

function hashSeed(seed, k) {
  const x = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function fmtK(teq) {
  return Math.round(teq / 10) * 10;
}

function fmtTemp(teq) {
  return fmtK(teq).toLocaleString('en-US') + ' K';
}

/* Gas giant palette stops: [temperature, base, light, dark] */
const GAS_STOPS = {
  A: [[250, 0x5f8fd0], [350, 0xc4a97e], [850, 0xc4a97e], [1000, 0x7a4a26], [1400, 0x7a4a26], [1650, 0x2a1210]],
  B: [[250, 0xd6e6f4], [350, 0xecdfc3], [850, 0xecdfc3], [1000, 0xc8864a], [1400, 0xc8864a], [1650, 0x6a2a18]],
  C: [[250, 0x3f6bb0], [350, 0x8f6a45], [850, 0x8f6a45], [1000, 0x45281a], [1400, 0x45281a], [1650, 0x140808]],
};
/* Neptune-like palette stops */
const NEP_STOPS = {
  A: [[250, 0x2e64c8], [450, 0x5f7fa6], [900, 0x8a8478]],
  B: [[250, 0x6fc4dc], [450, 0x93b0c4], [900, 0xb5ada0]],
  C: [[250, 0x204a98], [450, 0x40587a], [900, 0x5e5850]],
};
/* Solid palette stops: lowland, highland, dark patches */
const SOLID_STOPS = {
  low:  [[180, 0xdfe9f2], [220, 0xdfe9f2], [260, 0x5e5650], [400, 0x6a5d4a], [480, 0x8a6a3e], [1000, 0x6a5a48], [1100, 0x1a1412]],
  high: [[180, 0xf4f8fb], [220, 0xf4f8fb], [260, 0x8c8072], [400, 0x9a8b70], [480, 0xb08a58], [1000, 0x8f7e6a], [1100, 0x2e2622]],
  dark: [[180, 0x9fb6d0], [220, 0x9fb6d0], [260, 0x3e3833], [400, 0x4a3f36], [480, 0x5a4a3e], [1000, 0x3a302a], [1100, 0x0c0a0a]],
};
const GLOW_STOPS = [[1000, 0x8a1600], [1500, 0xff4a10], [2200, 0xffb040]];

function gasColourWords(teq) {
  if (teq < 300) return 'pale blue and white bands';
  if (teq < 900) return 'cream and tan bands';
  if (teq < 1500) return 'brown and orange bands';
  return 'dark bands with an orange-red thermal glow';
}
function nepColourWords(teq) {
  if (teq < 350) return 'blue-teal haze';
  if (teq < 700) return 'grey-blue haze';
  return 'warm grey haze';
}
function solidColourWords(teq) {
  if (teq < 200) return 'white-blue ice';
  if (teq < 400) return 'grey-brown rock';
  if (teq < 1000) return 'ochre and grey rock';
  return 'black rock with glowing lava';
}

/* ------------------------------------------------------------------
   makePlanetMaterial
   ------------------------------------------------------------------ */
export function makePlanetMaterial(THREE, opts) {
  const o = opts || {};
  const cls = o.cls || 'unknown';
  const teqGiven = Number.isFinite(o.teq) && o.teq > 0;
  const teq = teqGiven ? o.teq : 300;
  const seed = Number.isFinite(o.seed) ? o.seed : 0.5;
  const radiusKm = Number.isFinite(o.radius_km) && o.radius_km > 0 ? o.radius_km : EARTH_RADIUS_KM;
  const locked = !!o.tidally_locked;
  const isGas = cls === 'gas-giant';
  const isNep = cls === 'neptune-like';
  const gasLike = isGas || isNep;

  const tempNote = teqGiven
    ? 'chosen from the ' + fmtTemp(teq) + ' equilibrium temperature'
    : 'no temperature available, 300 K assumed';

  const offset = new THREE.Vector3(seed * 97.3, seed * 41.7 + 3.1, seed * 63.9 + 7.7);
  const freqScale = Math.min(1.6, Math.max(0.8, Math.pow(radiusKm / EARTH_RADIUS_KM, 0.25)));

  const common = {
    uLightDir: { value: new THREE.Vector3(1, 0, 0) },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uTime: { value: 0 },
    uOffset: { value: offset },
  };

  let material;
  let imagined;

  if (gasLike) {
    const S = isGas ? GAS_STOPS : NEP_STOPS;
    const colA = stopColor(THREE, S.A, teq);
    const colB = stopColor(THREE, S.B, teq);
    const colC = stopColor(THREE, S.C, teq);
    const emit = ramp(teq, 1400, 2600) * 0.9;
    const emitCol = new THREE.Color(0xff5a1a);

    const stormCol = colB.clone().lerp(colC, 0.35).multiply(new THREE.Color(1.1, 0.95, 0.9));
    const stormRoll = hashSeed(seed, 1);
    const hasStorms = isGas ? stormRoll > 0.3 : stormRoll > 0.5;
    const stormAmt = hasStorms ? (isGas ? 0.75 : 0.45) : 0.0;
    const storms = [];
    for (let i = 0; i < 2; i++) {
      const latDeg = (15 + 30 * hashSeed(seed, 2 + i)) * (hashSeed(seed, 4 + i) > 0.5 ? 1 : -1);
      const lon = hashSeed(seed, 6 + i) * Math.PI * 2;
      const la = latDeg * Math.PI / 180;
      storms.push(new THREE.Vector3(Math.cos(la) * Math.cos(lon), Math.sin(la), Math.cos(la) * Math.sin(lon)));
    }

    const uniforms = Object.assign(common, {
      uColA: { value: colA },
      uColB: { value: colB },
      uColC: { value: colC },
      uStormCol: { value: stormCol },
      uStorm0: { value: storms[0] },
      uStorm1: { value: storms[1] },
      uStormSize0: { value: new THREE.Vector2(0.20, 0.10) },
      uStormSize1: { value: new THREE.Vector2(0.11, 0.065) },
      uStormAmt: { value: stormAmt },
      uEmitCol: { value: emitCol },
      uEmit: { value: emit },
      uBandFreq: { value: isGas ? 13 + 7 * hashSeed(seed, 9) : 6 + 2 * hashSeed(seed, 9) },
      uContrast: { value: isGas ? (teq > 1500 ? 0.3 : 0.4) : 0.18 },
      uTurb: { value: isGas ? 0.10 : 0.06 },
      uHaze: { value: isGas ? 0.12 : 0.55 },
      uRim: { value: isGas ? 0.30 : 0.35 },
      uWrap: { value: isGas ? 0.20 : 0.25 },
      uDrift: { value: isGas ? 0.0035 : 0.002 },
      uFreq: { value: 1.5 * freqScale },
    });

    material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PLANET_VERT,
      fragmentShader: GAS_FRAG,
    });

    const stormText = hasStorms
      ? (isGas ? ' with two storm ovals' : ' with one dark storm oval')
      : '';
    imagined = {
      surface: isGas
        ? 'banded gas giant' + stormText + '; the bands are noise, not observations'
        : 'smooth neptune-like cloud deck' + stormText + '; faint bands from noise',
      colours: (isGas ? gasColourWords(teq) : nepColourWords(teq)) + ', ' + tempNote,
      atmosphere: isGas
        ? 'limb darkening and a rim glow shown; composition unknown'
        : 'thick haze shown at the limb; composition unknown',
      clouds: isGas
        ? 'cloud belts drift slowly with an invented differential rotation'
        : 'faint cloud bands drift slowly; invented',
    };
    if (emit > 0) {
      imagined.atmosphere += '; a dull thermal glow is shown on the night side because the equilibrium temperature is above 1,400 K';
    }
    material.userData.suggestAtmosphere = {
      color: isGas ? colB.clone().lerp(new THREE.Color(1, 1, 1), 0.3) : colB.clone(),
      strength: isGas ? 0.7 : 1.0,
    };
  } else {
    const colLow = stopColor(THREE, SOLID_STOPS.low, teq);
    const colHigh = stopColor(THREE, SOLID_STOPS.high, teq);
    const colDark = stopColor(THREE, SOLID_STOPS.dark, teq);
    const iceAmt = 1 - ramp(teq, 190, 230);
    const glowAmt = ramp(teq, 1000, 1600);
    const glowCol = stopColor(THREE, GLOW_STOPS, teq).multiplyScalar(1.6);
    const meltAmt = locked ? ramp(teq, 1300, 1900) : 0;
    const shadowTint = new THREE.Color(0x4a74b8).multiplyScalar(iceAmt);

    const craterDensity = iceAmt > 0.5 ? 0.08 : (glowAmt > 0.5 ? 0.10 : 0.32);
    const rim = 0.10 + 0.08 * iceAmt + 0.02 * glowAmt;
    const spec = 0.35 * iceAmt + 0.25 * glowAmt;
    const shiny = iceAmt > 0.5 ? 18 : 40;
    const bump = 0.35 - 0.23 * iceAmt - 0.10 * glowAmt;

    const uniforms = Object.assign(common, {
      uColLow: { value: colLow },
      uColHigh: { value: colHigh },
      uColDark: { value: colDark },
      uShadowTint: { value: shadowTint },
      uGlow: { value: glowCol },
      uFreq: { value: 3.0 * freqScale },
      uCraterDensity: { value: craterDensity },
      uCraterFreq: { value: 2.2 },
      uCraterAmp: { value: 1.0 },
      uBump: { value: bump },
      uRim: { value: rim },
      uWrap: { value: 0.08 + 0.04 * iceAmt },
      uSpec: { value: spec },
      uShiny: { value: shiny },
      uGlowAmt: { value: glowAmt },
      uMeltAmt: { value: meltAmt },
      uFracAmt: { value: iceAmt * 0.8 },
    });

    material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: PLANET_VERT,
      fragmentShader: SOLID_FRAG,
    });

    let surface;
    if (iceAmt > 0.5) {
      surface = 'ice with fracture lines and a few craters; no ocean or vegetation shown';
    } else if (glowAmt > 0.5) {
      surface = 'dark rock with glowing lava cracks';
      if (meltAmt > 0) surface += ' and a molten region on the star-facing side (planet assumed tidally locked)';
    } else if (teq < 400) {
      surface = 'cratered grey-brown rock; no ocean or vegetation shown';
    } else {
      surface = 'cratered ochre and grey rock; no ocean or vegetation shown';
    }
    imagined = {
      surface,
      colours: solidColourWords(teq) + ', ' + tempNote,
      atmosphere: 'none shown on the surface; a thin limb sheen only',
      clouds: 'none',
    };
    if (glowAmt > 0) {
      imagined.surface += '; the lava glow is visible on the night side';
    }
    material.userData.suggestAtmosphere = null;
  }

  material.userData.imagined = imagined;
  material.userData.cls = cls;
  material.userData.teq = teq;
  return material;
}

/* ------------------------------------------------------------------
   makeAtmosphere
   radius_units: planet radius in scene units
   color: [r,g,b] 0..1 sRGB (a THREE.Color is accepted too)
   strength: 0..1 multiplier
   ratio: shell radius / planet radius (default 1.045)
   ------------------------------------------------------------------ */
export function makeAtmosphere(THREE, opts) {
  const o = opts || {};
  const radius = Number.isFinite(o.radius_units) && o.radius_units > 0 ? o.radius_units : 1;
  const ratio = Number.isFinite(o.ratio) && o.ratio > 1.001 ? o.ratio : 1.045;
  const strength = Number.isFinite(o.strength) ? o.strength : 0.8;
  const k = Math.sqrt(1 - 1 / (ratio * ratio));

  let color;
  if (o.color && typeof o.color.isColor === 'boolean' && o.color.isColor) {
    color = o.color.clone();
  } else if (Array.isArray(o.color)) {
    color = new THREE.Color().setRGB(o.color[0], o.color[1], o.color[2], THREE.SRGBColorSpace);
  } else {
    color = new THREE.Color(0x8fc6ff);
  }

  const geometry = new THREE.SphereGeometry(radius * ratio, 64, 48);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: new THREE.Vector3(1, 0, 0) },
      uColor: { value: color },
      uStrength: { value: strength },
      uK: { value: k },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: ATMO_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  mesh.userData.imagined = 'atmosphere rim glow is an assumption; no atmosphere has been detected for this planet unless the dossier says so';
  return mesh;
}
