/* ===================================================================
   /explore/lib/star.js
   The host star: a limb-darkened, slowly granulating surface, a
   Fresnel corona shell at 1.6 radii, a soft glare sprite, and a
   PointLight (decay 0) for any lit standard materials in the scene.

   This module does NOT import three. The page passes THREE in.

   makeStar(THREE, { radius_units, teff, color })
     radius_units  star radius in scene units (1 unit = 1,000 km)
     teff          effective temperature in K (drives limb darkening,
                   spots and granulation contrast)
     color         [r,g,b] 0..1 sRGB from catalog.teffToRGB; a
                   THREE.Color is accepted too. If missing, a rough
                   blackbody colour is derived from teff.
   returns { group, light, surface, corona, glare, update(seconds) }
     group    add to the scene and position it at the star
     light    THREE.PointLight, colour is linear; pass light.color as
              uLightColor to planet materials
     update   call every frame with elapsed seconds

   The surface pattern is a look, not a model of the star. Real
   granules are far too small to see at whole-disk scale.
   =================================================================== */

import { NOISE_GLSL } from './planet-shaders.js';

const STAR_VERT = /* glsl */`
varying vec3 vObjPos;
varying vec3 vViewObj;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vObjPos = position;
  vec3 dCam = cameraPosition - modelMatrix[3].xyz;
  float s2 = dot(modelMatrix[0].xyz, modelMatrix[0].xyz);
  vec3 camObj = (dCam * mat3(modelMatrix)) / s2;
  vViewObj = camObj - position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uLimb;
uniform float uGran;
uniform float uSpots;
uniform float uBright;
varying vec3 vObjPos;
varying vec3 vViewObj;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 p = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  float mu = clamp(dot(p, V), 0.0, 1.0);
  float limb = 1.0 - uLimb * (1.0 - mu);

  vec3 q = p * 26.0 + vec3(uTime * 0.020, uTime * 0.013, -uTime * 0.017);
  vec2 w = worley(q);
  float lanes = smoothstep(0.0, 0.85, w.x);
  float gran = 1.0 - lanes * lanes * uGran;

  float mott = fbm(p * 4.0 + vec3(uTime * 0.004, 0.0, -uTime * 0.003));
  gran *= 1.0 + mott * 0.12;

  float sp = fbm(p * 2.5 + vec3(7.0, 3.0, 11.0));
  float spot = smoothstep(0.42, 0.60, sp) * uSpots;
  gran *= 1.0 - spot * 0.75;

  vec3 hot = mix(uColor, vec3(1.0), 0.3);
  vec3 col = mix(uColor, hot, 1.0 - lanes) * gran * limb * uBright;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CORONA_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uK;
uniform float uStrength;
varying vec3 vObjPos;
varying vec3 vViewObj;
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vObjPos);
  vec3 V = normalize(vViewObj);
  float ndv = dot(n, V);
  float x = clamp(-ndv / uK, 0.0, 1.0);
  float glow = pow(x, 4.0) * 0.45 + pow(x, 16.0) * 0.55;
  float streaks = 0.85 + 0.15 * fbm(n * 6.0 + vec3(0.0, uTime * 0.03, 0.0));
  vec3 col = uColor * glow * streaks * uStrength;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* Rough blackbody look, used only when no colour is supplied. */
function fallbackRGB(teff) {
  const t = Math.min(12000, Math.max(2500, teff || 5500));
  const f = (t - 2500) / 9500;
  const stops = [
    [0.00, [1.00, 0.55, 0.25]],
    [0.20, [1.00, 0.72, 0.45]],
    [0.35, [1.00, 0.90, 0.75]],
    [0.50, [1.00, 0.98, 0.94]],
    [0.65, [0.92, 0.95, 1.00]],
    [1.00, [0.70, 0.82, 1.00]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (f <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const u = (f - a[0]) / (b[0] - a[0]);
      return [0, 1, 2].map((k) => a[1][k] + (b[1][k] - a[1][k]) * u);
    }
  }
  return stops[stops.length - 1][1];
}

function makeGlareTexture(THREE) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c;
      const dy = (y + 0.5 - c) / c;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - r, 4.5);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function makeStar(THREE, opts) {
  const o = opts || {};
  const radius = Number.isFinite(o.radius_units) && o.radius_units > 0 ? o.radius_units : 695.7;
  const teff = Number.isFinite(o.teff) && o.teff > 0 ? o.teff : 5500;

  let color;
  if (o.color && o.color.isColor) {
    color = o.color.clone();
  } else {
    const rgb = Array.isArray(o.color) ? o.color : fallbackRGB(teff);
    color = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  }

  /* Cooler stars: stronger limb darkening, spots, contrastier granulation. */
  const limb = Math.min(0.80, Math.max(0.35, 0.9 - teff / 20000));
  const spots = teff < 4500 ? 0.8 : (teff < 6000 ? 0.3 : 0.0);
  const gran = teff < 4500 ? 0.35 : 0.22;

  const group = new THREE.Group();
  group.name = 'star';

  const surfaceMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uTime: { value: 0 },
      uLimb: { value: limb },
      uGran: { value: gran },
      uSpots: { value: spots },
      // 1.0: bright under ACES but below the point where limb darkening and colour clip to white
      uBright: { value: 1.0 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
  });
  const surface = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), surfaceMat);
  surface.name = 'star-surface';
  group.add(surface);

  const ratio = 1.6;
  const k = Math.sqrt(1 - 1 / (ratio * ratio));
  const coronaMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone().lerp(new THREE.Color(1, 1, 1), 0.15) },
      uTime: { value: 0 },
      uK: { value: k },
      uStrength: { value: 0.9 },
    },
    vertexShader: STAR_VERT,
    fragmentShader: CORONA_FRAG,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const corona = new THREE.Mesh(new THREE.SphereGeometry(radius * ratio, 64, 48), coronaMat);
  corona.name = 'star-corona';
  corona.renderOrder = 1;
  group.add(corona);

  const glareMat = new THREE.SpriteMaterial({
    map: makeGlareTexture(THREE),
    color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.2),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    opacity: 0.16,
  });
  const glare = new THREE.Sprite(glareMat);
  glare.name = 'star-glare';
  glare.scale.set(radius * 3.4, radius * 3.4, 1);
  glare.renderOrder = 2;
  group.add(glare);

  const light = new THREE.PointLight(color.clone(), 3.0, 0, 0);
  light.name = 'star-light';
  group.add(light);

  function update(seconds) {
    const t = Number.isFinite(seconds) ? seconds : 0;
    surfaceMat.uniforms.uTime.value = t;
    coronaMat.uniforms.uTime.value = t;
  }

  group.userData.imagined = {
    surface: 'granulation pattern and limb darkening are a look, not a model; real granules are not visible at this scale',
    colours: 'from the ' + Math.round(teff).toLocaleString('en-US') + ' K effective temperature',
    corona: 'soft glow at 1.6 radii is decorative',
  };

  return { group, light, surface, corona, glare, update };
}
