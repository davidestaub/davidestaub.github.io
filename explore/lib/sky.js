/* ===================================================================
   explore/lib/sky.js : the real sky seen from inside a planetary system

   Bright stars (HYG, V <= 7) are placed on a sphere of radius SKY_RADIUS
   around the observer, in the direction from the host star to each
   catalogued star. Apparent magnitude is recomputed for the new distance,
     m' = m + 5 log10(d' / d),
   so a nearby host sees a different sky from the Sun's, while a host a
   few kiloparsecs away sees most of the familiar bright stars fade.

   This module does NOT import three; the page passes THREE in.
   =================================================================== */

export const SKY_RADIUS = 2e7;         // scene units (1 unit = 1,000 km)
const FAINT_LIMIT = 8.0;               // stars fainter than this are dropped
const MIN_DIST_PC = 5e-4;              // a star this close to the origin is the host itself

/** Fetch baseUrl + 'data/stars.json' -> { meta, fields, rows }. */
export async function loadSky(baseUrl) {
  const url = (baseUrl || '') + 'data/stars.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error('sky: could not load ' + url + ' (' + res.status + ')');
  const json = await res.json();
  return { meta: json.meta || {}, fields: json.fields, rows: json.rows };
}

/* --- colour from B-V ------------------------------------------------- */

/** B-V colour index -> effective temperature (Ballesteros 2012). */
function bvToTeff(bv) {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** Blackbody-ish RGB (0..1) from temperature, normalised so the brightest channel is 1. */
function teffToRGB(t) {
  const T = Math.max(1000, Math.min(40000, t)) / 100;
  let r, g, b;
  if (T <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(T) - 161.1195681661;
    b = T <= 19 ? 0 : 138.5177312231 * Math.log(T - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(T - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(T - 60, -0.0755148492);
    b = 255;
  }
  r = Math.max(0, Math.min(255, r)) / 255;
  g = Math.max(0, Math.min(255, g)) / 255;
  b = Math.max(0, Math.min(255, b)) / 255;
  const m = Math.max(r, g, b) || 1;
  // soften saturation a little: real stars look pale to the eye
  const k = 0.75;
  return [
    (r / m) * k + (1 - k),
    (g / m) * k + (1 - k),
    (b / m) * k + (1 - k),
  ];
}

/* --- the point cloud -------------------------------------------------- */

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aBright;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vColor = aColor;
    vBright = aBright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio;
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float d = length(p) * 2.0;
    float disc = 1.0 - smoothstep(0.35, 1.0, d);
    vec3 c = vColor * vBright * disc;
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

/**
 * Build the sky as a THREE.Points object.
 * @param THREE the three.js namespace
 * @param sky   { fields, rows } from loadSky
 * @param originHelioPc { x, y, z } heliocentric galactic parsecs of the host, or null for the Sun
 */
export function makeSky(THREE, sky, originHelioPc) {
  const fields = sky.fields || ['x', 'y', 'z', 'mag', 'ci', 'name'];
  const ix = fields.indexOf('x'), iy = fields.indexOf('y'), iz = fields.indexOf('z');
  const im = fields.indexOf('mag'), ic = fields.indexOf('ci');
  const ox = originHelioPc && Number.isFinite(originHelioPc.x) ? originHelioPc.x : 0;
  const oy = originHelioPc && Number.isFinite(originHelioPc.y) ? originHelioPc.y : 0;
  const oz = originHelioPc && Number.isFinite(originHelioPc.z) ? originHelioPc.z : 0;

  const rows = sky.rows || [];
  const pos = [], size = [], bright = [], col = [];
  let kept = 0, brightest = Infinity;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const x = r[ix], y = r[iy], z = r[iz], mag = r[im];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(mag)) continue;

    const d0 = Math.sqrt(x * x + y * y + z * z);          // distance from the Sun
    const dx = x - ox, dy = y - oy, dz = z - oz;
    const d1 = Math.sqrt(dx * dx + dy * dy + dz * dz);    // distance from the host
    if (d1 < MIN_DIST_PC || d0 < MIN_DIST_PC) continue;   // the host itself, or a degenerate row

    const m1 = mag + 5 * Math.log10(d1 / d0);
    if (m1 > FAINT_LIMIT) continue;

    const inv = SKY_RADIUS / d1;
    pos.push(dx * inv, dy * inv, dz * inv);

    // size 1..4 px: m' = -1.5 -> 4 px, m' = 6 -> 1 px
    const s = Math.max(1, Math.min(4, 4 - (m1 + 1.5) * 0.4));
    size.push(s);
    // brightness: unity at m' = 2, falling by 2.512 per magnitude, floored so faint stars still register
    const b = Math.max(0.05, Math.min(1.35, Math.pow(10, -0.4 * (m1 - 2.0))));
    bright.push(b);

    const ci = r[ic];
    const rgb = (ci === null || ci === undefined || !Number.isFinite(ci)) ? [1, 1, 1] : teffToRGB(bvToTeff(ci));
    col.push(rgb[0], rgb[1], rgb[2]);
    kept++;
    if (m1 < brightest) brightest = m1;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  geom.setAttribute('aBright', new THREE.Float32BufferAttribute(bright, 1));
  geom.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  // stars are always drawn: a bounding sphere of the sky radius stops culling surprises
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SKY_RADIUS * 1.01);

  const pr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pr } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    // not flagged transparent: that keeps it in the opaque pass, where renderOrder -10
    // draws it before every planet, so bodies cover the stars behind them
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });

  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  points.name = 'sky';
  points.userData.count = kept;
  points.userData.brightestMag = brightest;
  points.userData.origin = { x: ox, y: oy, z: oz };

  /** Stars are at infinity: keep the sky centred on the camera so there is no parallax. */
  points.update = function (cameraPosition) {
    points.position.copy(cameraPosition);
  };
  points.setPixelRatio = function (v) {
    mat.uniforms.uPixelRatio.value = v;
  };
  return points;
}
