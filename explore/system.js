/* ===================================================================
   /explore/system.js : star system renderer and ship (stage 3)

   One host star and its confirmed planets at true scale
   (1 scene unit = 1,000 km), lit by the star, under the real sky as
   seen from the host's position. Every rendering choice that is not
   backed by a catalogued number is reported in the dossier as imagined.

   Floating origin: the ship is the scene origin. The ship keeps its
   true position in doubles (ship.pos) and every frame each body, orbit
   line and the star group is placed at (body - ship), so there is no
   Float32 jitter a million units from the star. The rendering camera
   sits at a small offset from that origin: at it in the cockpit view,
   a fraction of a unit behind and above it in the chase view.

   Modes
     attract  the camera orbits the focused body (OrbitControls driven
              on a hidden camera in a frame centred on the focus; the
              ship's position and orientation are derived from it); the
              ship model flies in front of the camera, along the orbit
     flight   the ship module drives position and orientation
     warp     frozen while the warp effect plays and the system swaps

   Views (V, persisted in localStorage 'explore.view')
     chase    the ship model at the origin, a lagging camera behind it
     cockpit  the camera at the origin inside lib/cockpit.js's interior
   Attract mode always shows the chase view.
   =================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  KM_PER_UNIT, SUN_RADIUS_KM, AU_KM, EARTH_RADIUS_KM, JUP_RADIUS_KM, LY_PER_PC,
  loadCatalog, deriveSystem, describeMeasured, describeAssumed, findHost,
} from './lib/catalog.js';
import { makePlanetMaterial, makeAtmosphere } from './lib/planet-shaders.js';
import { makeStar } from './lib/star.js';
import { loadSky, makeSky } from './lib/sky.js';
import { createShip, THROTTLE_STEPS, AUTOPILOT } from './lib/ship.js';

/* ---------------- constants ---------------- */

const BASE_URL = new URL('./', import.meta.url).href;
const DEFAULT_HOST = 'TRAPPIST-1';
const PC_TO_LY = LY_PER_PC;
const TAU = Math.PI * 2;
const DAY_S = 86400;
const YEAR_S = 365.25 * DAY_S;
const ORBIT_SEGMENTS = 360;
const PLANET_SEGMENTS = 96;
const TWEEN_SECONDS = 0.9;
const MARKER_HIDE_PX = 7;            // hide the planet marker once the disc is wider than this
const LIGHT_SOFTEN = 0.45;           // fraction of the way from the star colour toward white for lighting
const FOCUS_AZIMUTH = THREE.MathUtils.degToRad(65);   // planet focus: camera this far round from the star direction
const FOCUS_ELEVATION = 0.32;        // and this much above the orbital plane (fraction of the offset)
const ATTRACT_ROTATE_SPEED = 0.25;   // OrbitControls autoRotateSpeed: 2.0 is one turn per 30 s
const ARRIVAL_STAR_RADII = 12;       // after a warp the ship sits this far from the star
const DISCOVER_RADII = 6;            // within this many radii of a planet counts as a visit
const RELEASE_FOCUS_RADII = 30;      // on Esc, focus the planet the ship is parked next to
const HUD_HZ = 30;
const VISITED_KEY = 'explore.visited';
const INTRO_KEY = 'explore.intro';     // sessionStorage: the intro overlay has been shown this session
// first visit without ?host=: 70 percent one of these, else a random qualifying host
const CURATED_HOSTS = ['TRAPPIST-1', 'WASP-96', 'HD 209458', 'WASP-39', 'WASP-17', 'K2-18',
  '55 Cnc', 'HD 189733', 'GJ 1214', 'Kepler-16', 'LHS 1140', 'TOI-700'];
const CURATED_PROB = 0.7;
const TIME_LABELS = { 1: 'real time', 3600: '1 h/s', 86400: '1 day/s', 864000: '10 days/s' };
const ORBIT_LINE_HIDE_RADII = 20;    // hide a planet's orbit line when the ship is within this many radii of it
const ATTRACT_HINT = 'drag to rotate · click, then scroll to zoom · right-drag to pan';
// targeting and jumps
const LY_KM = 9.4607e12;
const TARGET_CLICK_PX = 24;          // a click within this many px of a body's centre targets it
const CLICK_DRAG_PX = 4;             // a pointer that moved more than this before release is a drag, not a click
const CLICK_MAX_MS = 600;
const ALIGN_COS = Math.cos(THREE.MathUtils.degToRad(2));   // the reticle reads 'aligned' within 2 degrees
const AUTOPILOT_STOP_RADII = 4;
const BRACKET_MIN_PX = 28;
const EDGE_MARGIN_X = 96;            // the off-screen arrow keeps inside this inset of the stage
const EDGE_MARGIN_TOP = 150;
const EDGE_MARGIN_BOTTOM = 96;
const HINT_STRIP_MS = 12000;
const NEAREST_COUNT = 12;
const JUMP_FAMOUS = CURATED_HOSTS.concat(['51 Peg', 'Proxima Cen']);
const HINT_STRIP_TEXT = 'T next target · F fly there · J jump systems · V view';
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// views
const VIEW_KEY = 'explore.view';
const CAMERA_NEAR = 0.001;           // the cockpit interior sits 0.03 units ahead of the camera
const CHASE_BACK = 0.16;             // chase camera: behind the ship, in ship space (units)
const CHASE_UP = 0.05;               // and above it
const CHASE_AHEAD = 0.4;             // the chase camera looks at a point this far ahead of the ship
const CHASE_TAU = 0.25;              // s, the camera position's lag toward its target
const CHASE_MAX_LAG = 0.045;         // units: the lag is capped so a fast turn never swings the ship out of frame
const BANK_MAX = THREE.MathUtils.degToRad(18);   // the model rolls into a yaw, visual only
const BANK_GAIN = 0.4;               // rad of bank per rad/s of yaw
const BANK_TAU = 0.35;               // s
const PITCH_MAX = THREE.MathUtils.degToRad(4);   // and pitches into throttle changes
const PITCH_GAIN = 0.8;              // rad per unit of throttle step not yet absorbed
const PITCH_TAU = 0.6;               // s, how long a throttle change takes to be absorbed
const GLOW_RISE_TAU = 0.12;          // s, engine glow response
const GLOW_FALL_TAU = 0.45;
const BOOST_FLARE = 0.35;            // engine glow added while boosting
const ATTRACT_GLOW = 0.3;            // cruising glow in attract mode
const ATTRACT_MODEL_OFFSET = new THREE.Vector3(0, -0.045, -0.20);   // attract: the model in front of and below the camera
const ATTRACT_BANK = THREE.MathUtils.degToRad(16);   // banked into the orbit round the focus
const ATTRACT_POSE_TAU = 0.35;       // s, smoothing of the tangential pose
const VIEW_BLEND_S = 0.8;            // s, the model's pose blends across a mode change

/** Device pixel ratio to render at: capped at 2, and at 1.5 on touch devices (the planet shaders are per-pixel heavy). */
function pixelRatioCap() {
  return Math.min(COARSE_POINTER ? 1.5 : 2, window.devicePixelRatio || 1);
}

/* ---------------- DOM (every element optional: the cockpit markup is built elsewhere) ---------------- */

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('system-stage') || $('cockpit') || document.body,
  canvas: $('system-canvas'),
  cockpit: $('cockpit'),
  status: $('sys-status'),
  clock: $('sys-clock'),
  pause: $('btn-pause'),
  timeButtons: Array.from(document.querySelectorAll('.t-btn[data-scale]')),
  btnStar: $('btn-star'),
  btnSystem: $('btn-system'),
  btnTake: $('btn-take-controls'),
  planetList: $('planet-list'),
  hint: $('sys-hint'),
  hostTitle: $('host-title'),
  dHost: $('d-host'),
  dStar: $('d-star'),
  dFocus: $('d-focus'),
  dMeasured: $('d-measured'),
  dImagined: $('d-imagined'),
  toast: $('hud-toast'),
  warpOverlay: $('warp-overlay'),
  intro: $('hud-intro'),
  introTake: $('btn-intro-take'),
  introSkip: $('btn-intro-skip'),
  fullMap: $('link-full-map'),
  fullMapFoot: $('link-full-map-foot'),
  bracket: $('hud-bracket'),
  bracketName: $('hud-bracket-name'),
  bracketSub: $('hud-bracket-sub'),
  edge: $('hud-edge'),
  edgeArrow: $('hud-edge-arrow'),
  edgeLabel: $('hud-edge-label'),
};

/* ---------------- small helpers ---------------- */

function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  if (abs >= 100) return n.toLocaleString('en-GB', { maximumFractionDigits: Math.min(digits, 1) });
  return n.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fmtElapsed(s) {
  if (s < 90) return fmt(s, 0) + ' s';
  if (s < 90 * 60) return fmt(s / 60, 1) + ' min';
  if (s < 2 * DAY_S) return fmt(s / 3600, 1) + ' h';
  if (s < 2 * YEAR_S) return fmt(s / DAY_S, 1) + ' days';
  return fmt(s / YEAR_S, 2) + ' years';
}

/** Distance for the target bracket: km, million km, AU, then light-years. */
function fmtDistanceLong(km) {
  if (!Number.isFinite(km)) return '·';
  if (km < 1e6) return fmt(km, 0) + ' km';
  if (km < 1e9) return fmt(km / 1e6, km < 1e7 ? 2 : 1) + ' million km';
  const ly = km / LY_KM;
  if (ly >= 0.05) return fmt(ly, 2) + ' ly';
  const au = km / AU_KM;
  return fmt(au, au < 10 ? 2 : 1) + ' AU';
}

/** A duration in s / min / h / d, two units at most: '4 min 10 s', '2 h 5 min', '3 d 4 h'. */
function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '·';
  if (s < 60) return Math.round(s) + ' s';
  if (s < 3600) { const r = Math.round(s), m = Math.floor(r / 60); return m + ' min ' + (r - m * 60) + ' s'; }
  if (s < DAY_S) { const r = Math.round(s / 60), h = Math.floor(r / 60); return h + ' h ' + (r - h * 60) + ' min'; }
  if (s < 100 * YEAR_S) { const r = Math.round(s / 3600), d = Math.floor(r / 24); return fmt(d, 0) + ' d ' + (r - d * 24) + ' h'; }
  return 'over 100 years';
}

/** FNV-1a hash of a string -> 0..1, a stable per-planet seed. */
function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 100000) / 100000;
}

function setStatus(text, isError) {
  if (!el.status) return;
  el.status.hidden = false;
  el.status.textContent = text;
  el.status.classList.toggle('error', !!isError);
}
function hideStatus() { if (el.status) el.status.hidden = true; }

function srcNote(src) { return src ? src : 'measured'; }

let toastTimer = 0;
function toast(text, ms) {
  if (state.hud && typeof state.hud.toast === 'function') { state.hud.toast(text, ms || 2600); return; }
  if (!el.toast) return;
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms || 2600);
}

/** Palette guess used for the HUD swatch and atmosphere tint when the material exposes nothing better.
    Mirrors the palette rules of planet-shaders.js (class + equilibrium temperature). */
function paletteFor(p) {
  const teq = Number.isFinite(p.teq) ? p.teq : 300;
  const re = p.radius_km / EARTH_RADIUS_KM;
  let cls = p.cls;
  if (cls === 'unknown') cls = re > 6 ? 'gas-giant' : re > 2 ? 'neptune-like' : 'super-earth';
  if (cls === 'gas-giant') {
    if (teq > 1500) return [0.55, 0.22, 0.10];
    if (teq > 900) return [0.62, 0.42, 0.24];
    if (teq > 300) return [0.86, 0.76, 0.56];
    return [0.66, 0.80, 0.94];
  }
  if (cls === 'neptune-like') {
    if (teq > 700) return [0.56, 0.62, 0.68];
    return [0.34, 0.56, 0.82];
  }
  if (teq > 1000) return [0.45, 0.16, 0.08];
  if (teq > 400) return [0.60, 0.50, 0.38];
  if (teq > 200) return [0.46, 0.41, 0.36];
  return [0.86, 0.90, 0.95];
}

/** Try to read the material's dominant colour; fall back to the palette rule. */
function dominantColour(material, p) {
  const ud = material && material.userData;
  const cand = ud && (ud.dominantColor || ud.dominantColour || ud.dominant || ud.swatch);
  if (cand) {
    if (Array.isArray(cand) && cand.length >= 3) return [cand[0], cand[1], cand[2]];
    if (cand.isColor) return [cand.r, cand.g, cand.b];
  }
  const u = material && material.uniforms;
  if (u) {
    if (u.uColLow && u.uColHigh && u.uColLow.value && u.uColLow.value.isColor && u.uColHigh.value.isColor) {
      const a = u.uColLow.value, b = u.uColHigh.value;
      return [(a.r + b.r) / 2, (a.g + b.g) / 2, (a.b + b.b) / 2];
    }
    for (const key of ['uColA', 'uBaseColor', 'uColorA', 'uColor', 'uColor1', 'uPalette0']) {
      const v = u[key] && u[key].value;
      if (v && v.isColor) return [v.r, v.g, v.b];
      if (v && v.isVector3) return [v.x, v.y, v.z];
    }
  }
  return paletteFor(p).map((v) => Math.pow(v, 2.2));
}

function atmosphereColour(p) {
  const teq = Number.isFinite(p.teq) ? p.teq : 300;
  const re = p.radius_km / EARTH_RADIUS_KM;
  if (teq > 1500) return [1.0, 0.55, 0.30];
  if (p.cls === 'gas-giant' || p.cls === 'neptune-like' || re > 2) return [0.60, 0.75, 1.0];
  if (teq > 400) return [0.90, 0.80, 0.65];
  return [0.70, 0.85, 1.0];
}

/** Linear [r,g,b] -> CSS colour (gamma encoded). */
function rgbCss(c) {
  const g = (v) => Math.round(Math.max(0, Math.min(1, Math.pow(v, 1 / 2.2))) * 255);
  return `rgb(${g(c[0])}, ${g(c[1])}, ${g(c[2])})`;
}

/** sRGB [r,g,b] (as passed to makeAtmosphere) -> CSS colour, no re-encoding. */
function srgbCss(c) {
  const g = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${g(c[0])}, ${g(c[1])}, ${g(c[2])})`;
}

/** Small round sprite for the screen-space markers (PointsMaterial draws squares by default). */
function makeDotTexture() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,1)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Solve Kepler's equation M = E - e sin E for E (radians). */
function solveKepler(M, e) {
  M = M % TAU; if (M < 0) M += TAU;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-9) break;
  }
  return E;
}

function disposeObject(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const mat of list) {
      if (mat.map && typeof mat.map.dispose === 'function' && mat.map !== state.dotTex) mat.map.dispose();
      if (typeof mat.dispose === 'function') mat.dispose();
    }
  });
}

async function optionalImport(path) {
  try {
    return await import(path);
  } catch (err) {
    console.warn('system: optional module not loaded: ' + path, err && err.message ? err.message : err);
    return null;
  }
}

async function optionalJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/* ---------------- state ---------------- */

const state = {
  catalog: null, skyData: null, galaxy: null,
  host: null, system: null,
  renderer: null, scene: null, camera: null, orbitCam: null, controls: null,
  ship: null, shipBodies: [], starBody: null,
  hud: null, minimap: null, warp: null,
  sky: null, star: null, starMarker: null, bodies: [], outerRadius: 1,
  starRadiusUnits: 1, lightColor: null, dotTex: null, orbitMat: null, markerMat: null,
  simSeconds: 0, timeScale: 3600, paused: false,
  realSeconds: 0, lastFrame: 0, running: false, rafId: 0,
  visible: true,
  mode: 'attract', building: false,
  focus: { mode: 'system', index: -1 },
  focusWorld: { x: 0, y: 0, z: 0 },
  tween: {
    active: false, t: 0,
    fromTarget: { x: 0, y: 0, z: 0 },
    fromDir: new THREE.Vector3(), toDir: new THREE.Vector3(),
    fromDist: 0, toDist: 0,
    fromQuat: new THREE.Quaternion(), slerp: false,
  },
  visited: new Set(),
  placedHosts: 0,       // hosts with a catalogued position: the denominator of 'systems visited'
  pickedHost: null,     // the jump destination (minimap pick, chooser row and JUMP button share it)
  target: null,         // a state.shipBodies entry (planet or star), or null
  jump: null,           // the system chooser (lib/jump.js)
  jumpPool: null,       // qualifying placed hosts for 'somewhere new', built on first use
  jumpResume: false,    // the chooser took the controls away from a flight; give them back on close
  hintShown: false,     // the T / F / J strip has been shown this page load
  mbarPx: 0,            // the phone bar's height in px (0 on desktop), read in resize()
  pixelRatio: 1,
  noLock: false,        // ?flight=1: fly without pointer lock
  view: 'chase',        // 'chase' | 'cockpit', the player's preference (attract mode shows chase regardless)
  shipModel: null,      // the ship's mesh group (lib/ship-mesh.js), at the origin in the chase view
  shipApi: null,        // { setThrottle, update, source, ... } from loadShip
  cockpit: null,        // { group, update } from lib/cockpit.js
  hemi: null,           // faint hemisphere fill so the ship's shadow side is not pure black
  pickedLy: null,       // distance to the jump destination in light-years (for the cockpit screen)
};

/** Camera and model pose state for the views (scene units, all relative to the ship origin). */
const cam = {
  pos: new THREE.Vector3(),          // the rendering camera's current offset
  init: false,                       // false: snap to the target on the next update (teleports)
  qSmooth: new THREE.Quaternion(),   // the model's smoothed pose
  pSmooth: new THREE.Vector3(),
  poseInit: false,
  fromQ: new THREE.Quaternion(),     // the pose at the last mode change, blended out over VIEW_BLEND_S
  fromP: new THREE.Vector3(),
  blendT: VIEW_BLEND_S,
  bank: 0, pitch: 0, throttleEased: 0, glow: 0,
  prevFwd: new THREE.Vector3(0, 0, -1), prevFwdValid: false,
  prevOrbit: new THREE.Vector3(), prevOrbitValid: false,
  tangent: new THREE.Vector3(1, 0, 0), tangentValid: false,
};

/** Per-frame HUD state object, mutated in place. */
const hudState = {
  speedKms: 0, speedC: 0, throttleLevel: 0,
  targetName: null, distToTargetKm: null, aligned: false,
  hostName: '', distFromEarthLy: null,
  systemsVisited: 0, totalSystems: 0,
  autopilot: false, timeScaleLabel: '', mode: 'attract',
  hudAt: -1,           // real seconds of the last HUD push (not part of the HUD contract)
};

// reusable temporaries: no per-frame allocation
const tmpDir = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpD = { x: 0, y: 0, z: 0 };     // double-precision scratch point
const vFwd = new THREE.Vector3(), vUp = new THREE.Vector3(), vRight = new THREE.Vector3();
const vA = new THREE.Vector3(), vB = new THREE.Vector3();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
const mA = new THREE.Matrix4();
const V_ZERO = new THREE.Vector3(0, 0, 0);
const AX_X = new THREE.Vector3(1, 0, 0), AX_Z = new THREE.Vector3(0, 0, 1);

/** Screen projection of a body, filled by projectBody (one shared object, no allocation).
    dist is from the ship, nose the cosine between the ship's forward axis and the body direction;
    sx, sy, front, discPx and cx, cy, cz are in the rendering camera's frame. */
const proj = { sx: 0, sy: 0, front: false, discPx: 0, dist: 0, nose: 0, cx: 0, cy: 0, cz: 0 };

/** State handed to the cockpit interior's screens (mutated in place). */
const cockpitState = {
  now: 0, aspect: 1.78, targetName: null, targetSub: '', targetDistKm: NaN, aligned: false, autopilot: false, boosting: false,
  speedKms: 0, speedC: 0, throttleLevel: 0, hostName: '', distFromEarthLy: null, destination: null, destinationLy: null,
};

/** Last values written to the target bracket and edge arrow: the DOM is touched only on change. */
const ov = {
  shown: false, x: -1e9, y: -1e9, size: 0, name: '', sub: '', subAt: -1, aligned: false,
  edgeShown: false, ex: -1e9, ey: -1e9, ang: 1e9, label: '', side: '',
};

/* ---------------- first visit: which host ---------------- */

/** A host qualifies when it has a catalogued distance and at least one planet with a catalogued radius and equilibrium temperature. */
function hostQualifies(host) {
  if (!host || !Number.isFinite(host.dist_pc)) return false;
  for (const p of host.planets) {
    if (p.radius_src === 'measured' && p.teq_src === 'measured') return true;
  }
  return false;
}

/**
 * Pick the host for a visit without ?host=: with CURATED_PROB one of the
 * curated names that is in the catalogue and qualifies, otherwise a random
 * qualifying host. @param rnd  a () => [0, 1) source, Math.random by default.
 */
function chooseInitialHost(catalog, rnd) {
  const r = typeof rnd === 'function' ? rnd : Math.random;
  const curated = [];
  for (const name of CURATED_HOSTS) {
    const h = findHost(catalog, name);
    if (h && hostQualifies(h)) curated.push(h);
  }
  if (curated.length && r() < CURATED_PROB) return curated[Math.floor(r() * curated.length)];
  const pool = catalog.hostList.filter(hostQualifies);
  if (pool.length) return pool[Math.floor(r() * pool.length)];
  if (curated.length) return curated[0];
  return findHost(catalog, DEFAULT_HOST) || catalog.hostList[0] || null;
}

/** Set ?host= and keep every other query parameter and the hash (?flight=1, ?intro=0, #main). */
function writeHostToUrl(name) {
  try {
    const p = new URLSearchParams(location.search);
    p.set('host', name);
    history.replaceState(null, '', '?' + p.toString() + location.hash);
  } catch (err) { /* file: origin */ }
}

/** Hosts that can be reached from the minimap: those with a catalogued position. */
function totalSystems() {
  if (state.placedHosts) return state.placedHosts;
  return state.catalog ? state.catalog.hostList.length : 0;
}

/* ---------------- intro overlay (once per session) ---------------- */

function introSeen() {
  try { return sessionStorage.getItem(INTRO_KEY) === '1'; } catch (err) { return false; }
}

function showIntro() {
  if (!el.intro) return;
  el.intro.hidden = false;
  if (el.cockpit) el.cockpit.classList.add('intro-open');
  try { sessionStorage.setItem(INTRO_KEY, '1'); } catch (err) { /* private mode */ }
  // a dialog: move focus into it
  if (el.introTake && typeof el.introTake.focus === 'function') el.introTake.focus();
}

function hideIntro() {
  if (!el.intro || el.intro.hidden) return;
  el.intro.hidden = true;
  if (el.cockpit) el.cockpit.classList.remove('intro-open');
}

function installIntro(params) {
  if (!el.intro) return;
  if (el.introTake) el.introTake.addEventListener('click', () => { hideIntro(); setMode('flight'); });
  if (el.introSkip) el.introSkip.addEventListener('click', () => hideIntro());
  // Escape closes it, like the help
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.intro && !el.intro.hidden) { hideIntro(); e.preventDefault(); }
  });
  // ?flight=1 (tests) and ?intro=0 skip it; ?intro=1 forces it
  const force = params.get('intro') === '1';
  const skip = params.get('intro') === '0' || params.get('flight') === '1';
  if (force || (!skip && !introSeen())) showIntro();
}

/* ---------------- boot ---------------- */

async function boot() {
  // index.html arms a timer that reports a three.js load failure; this module evaluating means it loaded
  if (window.__sysBootTimer) { clearTimeout(window.__sysBootTimer); window.__sysBootTimer = 0; }
  const params = new URLSearchParams(location.search);
  const hostParam = (params.get('host') || '').trim();

  if (!el.canvas) {
    setStatus('no #system-canvas on the page', true);
    return;
  }

  let catalog, skyData;
  try {
    [catalog, skyData] = await Promise.all([loadCatalog(BASE_URL), loadSky(BASE_URL)]);
  } catch (err) {
    console.error(err);
    setStatus('could not load the catalogue: ' + (err && err.message ? err.message : err), true);
    return;
  }
  state.catalog = catalog;
  state.skyData = skyData;
  state.placedHosts = catalog.hostList.filter((h) => Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z)).length;
  state.visited = loadVisited();

  // the cockpit modules are optional: the page renders without them
  const [hudMod, minimapMod, warpMod, jumpMod, shipMeshMod, cockpitMod, galaxy] = await Promise.all([
    optionalImport('./lib/hud.js'),
    optionalImport('./lib/minimap.js'),
    optionalImport('./lib/warp.js'),
    optionalImport('./lib/jump.js'),
    optionalImport('./lib/ship-mesh.js'),
    optionalImport('./lib/cockpit.js'),
    optionalJson(BASE_URL + 'data/galaxy.json'),
  ]);
  state.galaxy = galaxy;
  state.view = loadView();

  let host;
  if (hostParam) {
    host = findHost(catalog, hostParam);
    if (!host) {
      setStatus('host "' + hostParam + '" is not in the catalogue', true);
      if (el.hostTitle) el.hostTitle.textContent = 'Unknown host';
      return;
    }
  } else {
    host = chooseInitialHost(catalog);
    if (!host) {
      setStatus('the catalogue has no host to show', true);
      return;
    }
    writeHostToUrl(host.name);
  }

  setStatus('building scene');
  try {
    buildRenderer();
    buildChrome(hudMod, minimapMod, warpMod, jumpMod);
    await buildViews(shipMeshMod, cockpitMod);
    await setHost(host.name, { immediate: true, arrival: false });
    warmUpViews();
  } catch (err) {
    console.error(err);
    setStatus('could not build the scene: ' + (err && err.message ? err.message : err), true);
    return;
  }

  hideStatus();
  installLoop();
  installTestHook();
  installIntro(params);

  // ?flight=1: start with the controls, without pointer lock (mouse motion looks); for testing
  if (params.get('flight') === '1') {
    state.noLock = true;
    setMode('flight');
  }
}

/* ---------------- renderer, cameras, ship (built once) ---------------- */

function buildRenderer() {
  // no preserveDrawingBuffer: snapshot() renders synchronously right before toDataURL
  const renderer = new THREE.WebGLRenderer({
    canvas: el.canvas, antialias: true, logarithmicDepthBuffer: true,
  });
  state.pixelRatio = pixelRatioCap();
  renderer.setPixelRatio(state.pixelRatio);
  // context loss (memory pressure on phones): stop the loop and say so instead of running blind on a black canvas
  el.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    setRunning(false);
    setStatus('graphics context lost, reload the page', true);
  });
  el.canvas.addEventListener('webglcontextrestored', () => location.reload());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 1);
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  state.scene = scene;

  // the rendering camera: at the ship origin (cockpit) or a small offset behind it (chase),
  // orientation from the ship; the near plane admits the cockpit interior at 0.03 units
  const camera = new THREE.PerspectiveCamera(45, 1, CAMERA_NEAR, 1e9);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 0);
  state.camera = camera;

  // a very faint sky and ground fill: the star is the only real light, but a hull with a
  // pure black shadow side reads as a hole in the sky (planet shaders ignore scene lights)
  const hemi = new THREE.HemisphereLight(0x223a66, 0x05070f, 0.12);
  hemi.name = 'fill';
  scene.add(hemi);
  state.hemi = hemi;

  // the attract-mode camera: OrbitControls drives this one in a frame centred on the focus
  const orbitCam = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
  orbitCam.up.set(0, 0, 1);
  state.orbitCam = orbitCam;

  const controls = new OrbitControls(orbitCam, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  controls.screenSpacePanning = true;
  controls.maxDistance = 5e8;                  // raised per system in buildSystem for wide orbits
  controls.autoRotate = !REDUCED_MOTION;
  controls.autoRotateSpeed = ATTRACT_ROTATE_SPEED;
  // phones: one finger scrolls the page (the canvas is touch-action: pan-y in attract mode),
  // two fingers rotate and zoom; in flight the ship's own touch handlers take over
  controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
  // desktop: the wheel scrolls the page until the reader clicks into the stage, as on the map page
  controls.enableZoom = false;
  el.canvas.addEventListener('pointerdown', () => { controls.enableZoom = true; });
  el.canvas.addEventListener('pointerleave', () => { controls.enableZoom = false; });
  // OrbitControls writes an inline touch-action: none on its element, which beats the stylesheet;
  // setMode() switches this between pan-y (attract, warp) and none (flight)
  el.canvas.style.touchAction = 'pan-y';
  state.controls = controls;

  const ship = createShip(THREE, { camera, element: el.canvas });
  ship.onRelease = () => { if (state.mode === 'flight') setMode('attract'); };
  ship.onArrive = onShipArrive;
  ship.onInput = () => { toast('autopilot off'); };
  state.ship = ship;

  state.dotTex = makeDotTexture();
  state.starBody = { name: '', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, radius_units: 1, kind: 'star', index: -1 };
}

/** The ship model (chase view) and the cockpit interior (cockpit view); both optional. */
async function buildViews(shipMeshMod, cockpitMod) {
  const scene = state.scene;
  if (shipMeshMod && typeof shipMeshMod.loadShip === 'function') {
    try {
      const api = await shipMeshMod.loadShip(THREE, BASE_URL);
      state.shipApi = api;
      state.shipModel = api.group;
      api.group.name = 'ship-model';
      api.group.visible = false;
      scene.add(api.group);
      if (typeof api.setThrottle === 'function') api.setThrottle(0);
    } catch (err) {
      console.error('system: ship model failed', err);
      state.shipModel = null;
      state.shipApi = null;
    }
  }
  if (cockpitMod && typeof cockpitMod.makeCockpit === 'function') {
    try {
      const c = cockpitMod.makeCockpit(THREE);
      c.group.visible = false;
      scene.add(c.group);
      state.cockpit = c;
    } catch (err) {
      console.error('system: cockpit failed', err);
      state.cockpit = null;
    }
  }
  applyViewDom();
}

/**
 * Compile both views' shaders against the real light set (the star's point light exists only
 * once a system is built; three keys its programs on the light counts, and the cockpit adds
 * two point lights of its own), so neither the first chase frame nor the first V press stalls.
 * The hull's environment cube is converted here too. Called once, after the first setHost.
 */
function warmUpViews() {
  const model = state.shipModel, c = state.cockpit;
  if (!model && !c) return;
  const mv = model ? model.visible : false, cv = c ? c.group.visible : false;
  try {
    if (c) { c.group.position.copy(state.camera.position); c.group.quaternion.copy(state.camera.quaternion); }
    for (const view of ['chase', 'cockpit']) {
      if (model) model.visible = view === 'chase';
      if (c) c.group.visible = view === 'cockpit';
      state.renderer.compile(state.scene, state.camera);
      state.renderer.render(state.scene, state.camera);      // uploads the textures as well
    }
  } catch (err) {
    console.warn('system: view warm-up failed', err);
  } finally {
    if (model) model.visible = mv;
    if (c) c.group.visible = cv;
    renderFrame();
  }
}

/* ---------------- views: chase and cockpit ---------------- */

function loadView() {
  try { return localStorage.getItem(VIEW_KEY) === 'cockpit' ? 'cockpit' : 'chase'; } catch (err) { return 'chase'; }
}

/** The view actually rendered: attract mode always shows the ship from outside. */
function activeView() {
  return state.mode === 'attract' ? 'chase' : state.view;
}

/** Tell the HUD (button labels, data-view for the CSS) which view is preferred and which is shown. */
function applyViewDom() {
  const shown = activeView();
  if (state.hud && typeof state.hud.setView === 'function') state.hud.setView(state.view, shown);
  else if (el.cockpit) el.cockpit.dataset.view = shown;
}

/**
 * Set the view preference. In attract mode it takes effect when the controls are taken.
 * @param name  'chase' | 'cockpit'
 * @param o     { quiet: no toast }
 */
function setView(name, o) {
  const v = name === 'cockpit' ? 'cockpit' : (name === 'chase' ? 'chase' : null);
  if (!v) throw new Error('unknown view: ' + name);
  const changed = v !== state.view;
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch (err) { /* private mode */ }
  applyViewDom();
  if (changed) {
    hudState.hudAt = -1;
    ov.x = -1e9; ov.ex = -1e9;         // the overlays re-place for the new camera
    // a cut, not an ease: the camera would otherwise pass through the hull on its way to or
    // from the seat (the model's pose is the same in both views, so nothing else blends)
    cam.init = false;
  }
  if (!(o && o.quiet)) {
    toast('view: ' + v + (state.mode === 'attract' ? ' · shown once you take the controls' : ''), 2400);
  }
  return v;
}

function toggleView() {
  return setView(state.view === 'chase' ? 'cockpit' : 'chase');
}

/** Start blending the model's pose from where it is now to where the mode wants it. */
function beginPoseBlend() {
  const g = state.shipModel;
  // a hidden model (cockpit view) has no current pose to blend from: it snaps when next shown
  if (!g || !cam.poseInit || !g.visible) return;
  cam.fromQ.copy(g.quaternion);
  cam.fromP.copy(g.position);
  cam.blendT = 0;
}

/** A teleport: the camera and the model snap to their targets on the next update. */
function snapViews() {
  cam.init = false;
  cam.poseInit = false;
  cam.blendT = VIEW_BLEND_S;
  cam.prevFwdValid = false;
  cam.prevOrbitValid = false;
  cam.tangentValid = false;
  cam.bank = 0; cam.pitch = 0;
}

/**
 * Place the rendering camera for the active view. Every projection elsewhere uses ship.pos as
 * the origin and the camera's own small offset and quaternion, so nothing jitters.
 */
function updateCamera(dt) {
  const ship = state.ship, camera = state.camera;
  const view = activeView();
  vFwd.set(0, 0, -1).applyQuaternion(ship.quat);
  vUp.set(0, 1, 0).applyQuaternion(ship.quat);
  vRight.set(1, 0, 0).applyQuaternion(ship.quat);
  const chase = view === 'chase' && state.mode !== 'attract';
  if (chase) vA.copy(vUp).multiplyScalar(CHASE_UP).addScaledVector(vFwd, -CHASE_BACK);
  else vA.set(0, 0, 0);
  if (!cam.init || dt <= 0 && !cam.init) {
    cam.pos.copy(vA);
    cam.init = true;
  } else {
    cam.pos.lerp(vA, 1 - Math.exp(-dt / CHASE_TAU));
    vB.subVectors(cam.pos, vA);
    const lag = vB.length();
    // the cap is for fast turns; across a mode change the camera has the whole offset to
    // travel while the model blends poses, and capping that would make it pop
    if (lag > CHASE_MAX_LAG && cam.blendT >= VIEW_BLEND_S) cam.pos.copy(vA).addScaledVector(vB, CHASE_MAX_LAG / lag);
  }
  camera.position.copy(cam.pos);
  if (chase) {
    // look at a point ahead of the ship, with the ship's up: the reticle at the screen centre
    // is close to the nose direction and the view swings with the lagging position
    vB.copy(vFwd).multiplyScalar(CHASE_AHEAD);
    mA.lookAt(cam.pos, vB, vUp);
    camera.quaternion.setFromRotationMatrix(mA);
  } else {
    camera.quaternion.copy(ship.quat);
  }
}

/** The ship model's pose (bank, pitch, the attract-mode tangent) and engine glow. */
function updateShipModel(dt) {
  const g = state.shipModel;
  if (!g) return;
  const ship = state.ship;
  const view = activeView();
  g.visible = view === 'chase';
  if (!g.visible) {
    // while hidden the pose is not tracked: a blend begun before (a mode change) would otherwise
    // resume from a stale pose when the model is next shown, so it snaps instead
    cam.prevFwdValid = false;
    cam.poseInit = false;
    cam.blendT = VIEW_BLEND_S;
    return;
  }
  const attract = state.mode === 'attract';

  if (attract) {
    // the ship flies along the orbit: nose along the orbit camera's motion, banked toward the focus
    const oc = state.orbitCam.position;
    if (cam.prevOrbitValid && dt > 0) {
      vA.subVectors(oc, cam.prevOrbit);
      if (vA.lengthSq() > 1e-14) { cam.tangent.copy(vA).normalize(); cam.tangentValid = true; }
    }
    cam.prevOrbit.copy(oc);
    cam.prevOrbitValid = true;
    if (!cam.tangentValid) cam.tangent.copy(vRight).negate();
    // up: the camera's up leaned toward the focus (the view direction) by the bank angle
    vB.copy(vUp).multiplyScalar(Math.cos(ATTRACT_BANK)).addScaledVector(vFwd, Math.sin(ATTRACT_BANK));
    vA.crossVectors(cam.tangent, vB);
    if (vA.lengthSq() < 1e-6) vB.copy(vUp);
    mA.lookAt(V_ZERO, cam.tangent, vB);
    qA.setFromRotationMatrix(mA);
    vA.copy(ATTRACT_MODEL_OFFSET).applyQuaternion(ship.quat);
    cam.bank = 0; cam.pitch = 0;
    cam.prevFwdValid = false;
    const k = dt > 0 ? 1 - Math.exp(-dt / ATTRACT_POSE_TAU) : 1;
    if (!cam.poseInit) { cam.qSmooth.copy(qA); cam.pSmooth.copy(vA); }
    else { cam.qSmooth.slerp(qA, k); cam.pSmooth.lerp(vA, k); }
  } else {
    // bank into the yaw rate (measured from the forward axis's motion), pitch into throttle changes
    let bankTarget = 0;
    if (cam.prevFwdValid && dt > 0) {
      vA.subVectors(vFwd, cam.prevFwd);
      const yawRate = vA.dot(vRight) / dt;
      bankTarget = Math.max(-BANK_MAX, Math.min(BANK_MAX, -yawRate * BANK_GAIN));
    }
    cam.prevFwd.copy(vFwd);
    cam.prevFwdValid = true;
    const lvl = ship.throttleLevel();
    if (dt > 0) {
      cam.bank += (bankTarget - cam.bank) * (1 - Math.exp(-dt / BANK_TAU));
      cam.throttleEased += (lvl - cam.throttleEased) * (1 - Math.exp(-dt / PITCH_TAU));
    } else {
      cam.throttleEased = lvl;
    }
    let pitchTarget = (lvl - cam.throttleEased) * PITCH_GAIN + (ship.boosting ? PITCH_MAX * 0.4 : 0);
    pitchTarget = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitchTarget));
    cam.pitch += (pitchTarget - cam.pitch) * (dt > 0 ? 1 - Math.exp(-dt / BANK_TAU) : 1);
    qA.copy(ship.quat);
    if (cam.bank !== 0) { qB.setFromAxisAngle(AX_Z, cam.bank); qA.multiply(qB); }
    if (cam.pitch !== 0) { qB.setFromAxisAngle(AX_X, cam.pitch); qA.multiply(qB); }
    cam.qSmooth.copy(qA);
    cam.pSmooth.set(0, 0, 0);
  }
  cam.poseInit = true;

  // a mode change blends the old pose out over VIEW_BLEND_S
  if (cam.blendT < VIEW_BLEND_S) {
    cam.blendT += dt;
    const u = Math.max(0, Math.min(1, cam.blendT / VIEW_BLEND_S));
    const s = u * u * (3 - 2 * u);
    g.quaternion.slerpQuaternions(cam.fromQ, cam.qSmooth, s);
    g.position.lerpVectors(cam.fromP, cam.pSmooth, s);
  } else {
    g.quaternion.copy(cam.qSmooth);
    g.position.copy(cam.pSmooth);
  }

  // engine glow: the throttle level, a flare while boosting, a cruising glow in attract mode
  let glowTarget;
  if (attract) glowTarget = ATTRACT_GLOW;
  else if (ship.braking) glowTarget = 0;
  else glowTarget = Math.min(1, ship.throttleLevel() + (ship.boosting ? BOOST_FLARE : 0));
  if (dt > 0) {
    const tau = glowTarget > cam.glow ? GLOW_RISE_TAU : GLOW_FALL_TAU;
    cam.glow += (glowTarget - cam.glow) * (1 - Math.exp(-dt / tau));
  } else {
    cam.glow = glowTarget;
  }
  const api = state.shipApi;
  if (api) {
    if (typeof api.setThrottle === 'function') api.setThrottle(cam.glow);
    // the plume flicker is a continuous animation: off under prefers-reduced-motion
    if (typeof api.update === 'function' && !REDUCED_MOTION) api.update(dt, state.realSeconds);
  }
}

/** The cockpit interior follows the camera; its screens read the HUD state at 4 Hz. */
function updateCockpit() {
  const c = state.cockpit;
  if (!c) return;
  const on = activeView() === 'cockpit';
  c.group.visible = on;
  if (!on) return;
  c.group.position.copy(state.camera.position);
  c.group.quaternion.copy(state.camera.quaternion);
  const cs = cockpitState;
  cs.now = state.realSeconds;
  cs.aspect = state.camera.aspect;
  cs.targetName = hudState.targetName;
  cs.targetSub = state.target ? ov.sub : '';
  cs.targetDistKm = hudState.distToTargetKm;
  cs.aligned = ov.aligned;
  cs.autopilot = hudState.autopilot;
  cs.boosting = !!state.ship.boosting;
  cs.speedKms = hudState.speedKms;
  cs.speedC = hudState.speedC;
  cs.throttleLevel = hudState.throttleLevel;
  cs.hostName = hudState.hostName;
  cs.distFromEarthLy = hudState.distFromEarthLy;
  cs.destination = state.pickedHost;
  cs.destinationLy = state.pickedLy;
  c.update(cs);
}

/** Controls that live for the whole page: time presets, star/system buttons, the cockpit modules. */
function buildChrome(hudMod, minimapMod, warpMod, jumpMod) {
  // cockpit HUD (owns the buttons inside #cockpit and fires callbacks)
  const root = el.cockpit || el.stage;
  if (hudMod && typeof hudMod.createHud === 'function' && root) {
    try {
      state.hud = hudMod.createHud(root, {
        onTakeControls: () => setMode('flight'),
        onRelease: () => setMode('attract'),
        // a planet chip: in attract mode the camera goes there; in flight it becomes the target
        onFocus: (name) => {
          const b = state.mode === 'flight' ? bodyByName(name) : null;
          if (b) setTarget(b); else focusByName(name, false);
        },
        onAutopilot: (name) => autopilotByName(name),
        onWarp: (name) => warpTo(name || state.pickedHost),
        onOpenJump: (tab) => openJump(typeof tab === 'string' ? tab : undefined),
        onToggleMap: () => {
          if (!state.minimap) return;
          const m = state.minimap.toggleMode();
          state.minimap.draw();
          if (typeof state.hud.setMapMode === 'function') state.hud.setMapMode(typeof m === 'string' ? m : state.minimap.getMode());
        },
        onTimeScale: (scale) => setTimeScale(scale),
        onPause: () => setPaused(!state.paused),
        onThrottle: (delta) => { if (state.ship) state.ship.throttleStep(delta); },
        onBrake: () => { if (state.ship) state.ship.brake(); },
        onToggleView: () => toggleView(),
        onTouchLook: state.ship ? state.ship.touchLook : null,
      });
    } catch (err) {
      console.error('system: hud failed', err);
      state.hud = null;
    }
  }
  // without the HUD module the stage-2 controls are wired directly
  if (!state.hud) {
    if (el.btnTake) el.btnTake.addEventListener('click', () => setMode('flight'));
    if (el.btnStar) el.btnStar.addEventListener('click', () => setFocus('star', -1));
    if (el.btnSystem) el.btnSystem.addEventListener('click', () => setFocus('system', -1));
    el.timeButtons.forEach((btn) => {
      btn.addEventListener('click', () => setTimeScale(Number(btn.dataset.scale)));
    });
    if (el.pause) el.pause.addEventListener('click', () => setPaused(!state.paused));
  }

  // galaxy minimap on the HUD's canvas
  const mapCanvas = state.hud && state.hud.minimapCanvas ? state.hud.minimapCanvas : $('minimap');
  if (minimapMod && typeof minimapMod.createMinimap === 'function' && mapCanvas && state.galaxy) {
    try {
      const hosts = [];
      for (const h of state.catalog.hostList) {
        if (Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z)) {
          hosts.push({ name: h.name, x: h.x, y: h.y, z: h.z, planets: h.planets.length });
        }
      }
      const minimap = minimapMod.createMinimap(mapCanvas, { hosts, galaxy: state.galaxy, baseUrl: BASE_URL });
      minimap.onPick((name) => {
        setDestination(name);
        if (!state.hud) toast('destination: ' + name);
      });
      minimap.setVisited(state.visited);
      // the HUD's mode button starts on 'local'; the map itself defaults to galaxy, so agree on one
      minimap.setMode('local');
      if (state.hud && typeof state.hud.setMapMode === 'function') state.hud.setMapMode('local');
      state.minimap = minimap;
    } catch (err) {
      console.error('system: minimap failed', err);
      state.minimap = null;
    }
  }

  // warp effect
  if (warpMod && typeof warpMod.createWarp === 'function') {
    let overlay = el.warpOverlay;
    if (!overlay && root) {
      overlay = document.createElement('div');
      overlay.id = 'warp-overlay';
      overlay.className = 'warp-overlay';
      overlay.hidden = true;
      root.appendChild(overlay);
    }
    try {
      state.warp = warpMod.createWarp(THREE, { scene: state.scene, camera: state.camera, overlayEl: overlay });
    } catch (err) {
      console.error('system: warp failed', err);
      state.warp = null;
    }
  }

  // the system chooser (J): rows come from the catalogue, the minimap canvas is its 'map' tab
  if (jumpMod && typeof jumpMod.createJumpChooser === 'function' && root) {
    try {
      state.jump = jumpMod.createJumpChooser(root, {
        nearest: () => nearestHostRows(NEAREST_COUNT),
        famous: () => famousHostRows(),
        search: (q) => searchHostRows(q),
        random: () => randomHostName(),
        onSelect: (name) => {
          setDestination(name);
          const host = findHost(state.catalog, name);
          const ly = host ? hostDistanceLy(state.host, host) : null;
          // phones have no J key: the JUMP button at the top engages
          toast('destination: ' + (host ? host.name : name) + (ly == null ? '' : ' · ' + fmt(ly, ly < 10 ? 1 : 0) + ' ly') + (COARSE_POINTER ? ' · tap jump to go' : ' · J to jump'), 3600);
        },
        // the card's own jump button: the destination is already set, engage
        onEngage: (name) => { setDestination(name); warpTo(name); },
        onOpen: () => {
          hideIntro();
          if (state.hud) state.hud.showControlsHelp(false);
          // the mouse has to reach the panel: leave pointer lock, but stay in flight mode
          state.jumpResume = state.mode === 'flight';
          if (state.mode === 'flight' && state.ship.enabled) state.ship.detach();
        },
        onClose: () => {
          // the click or key that closed the panel is the user gesture the lock request needs
          if (state.jumpResume && state.mode === 'flight' && !state.ship.enabled) state.ship.attach(state.noLock ? { lock: false } : undefined);
          state.jumpResume = false;
        },
        mapCanvas,
      });
    } catch (err) {
      console.error('system: jump chooser failed', err);
      state.jump = null;
    }
  }

  // keyboard: T / F / G / X / J and Enter (H and M are handled by the HUD, W S Q E A D by the ship)
  window.addEventListener('keydown', onPageKey);
  // a click (not a drag) on a body in the view targets it
  installClickTarget();

  if (state.hud) {
    state.hud.setVisited(state.visited.size, totalSystems());
    state.hud.setMode('attract');
  }
  applyViewDom();
  updateClock(true);
}

function onPageKey(e) {
  if (state.mode === 'warp' || state.building) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.code) {
    case 'KeyT': cycleTarget(e.shiftKey ? -1 : 1); break;
    case 'KeyF': flyToTarget(); break;
    case 'KeyG': targetNearest(); break;
    case 'KeyX': if (state.target) setTarget(null); else return; break;
    case 'KeyV': toggleView(); break;
    case 'KeyJ':
      if (e.shiftKey || !state.pickedHost) openJump();
      else warpTo(state.pickedHost);
      break;
    case 'Enter': case 'NumpadEnter':
      // engage only when Enter is not also activating a focused button or link (that click has its own meaning)
      if (state.mode === 'flight' && state.pickedHost && !focusOnControl()) warpTo(state.pickedHost); else return;
      break;
    default: return;
  }
  e.preventDefault();
}

/** True when keyboard focus sits on a button, link or field, where Enter and Space already mean something. */
function focusOnControl() {
  const a = document.activeElement;
  if (!a || a === document.body || a === el.canvas) return false;
  const tag = a.tagName;
  return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable === true;
}

/** Clicking a body in the 3D view targets it: the nearest projected body within TARGET_CLICK_PX. */
function installClickTarget() {
  let downX = 0, downY = 0, downAt = 0, armed = false;
  el.canvas.addEventListener('pointerdown', (e) => {
    armed = e.button === 0 && e.isPrimary !== false;
    downX = e.clientX; downY = e.clientY; downAt = performance.now();
  });
  el.canvas.addEventListener('pointerup', (e) => {
    if (!armed || e.button !== 0) return;
    armed = false;
    if (state.mode === 'warp' || state.building) return;
    if (state.jump && state.jump.isOpen()) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_DRAG_PX) return;   // a drag
    if (performance.now() - downAt > CLICK_MAX_MS) return;
    const rect = el.canvas.getBoundingClientRect();
    let px, py;
    if (state.ship.pointerLocked) { px = rect.width / 2; py = rect.height / 2; }   // under lock the reticle is the pointer
    else { px = e.clientX - rect.left; py = e.clientY - rect.top; }
    const b = bodyAtScreen(px, py);
    if (b && b !== state.target) setTarget(b);
  });
}

/* ---------------- system build and teardown ---------------- */

function teardownSystem() {
  const scene = state.scene;
  if (!scene) return;
  for (const b of state.bodies) {
    scene.remove(b.mesh, b.orbit, b.marker);
    disposeObject(b.mesh);
    if (b.orbit.geometry) b.orbit.geometry.dispose();
    if (b.marker.geometry) b.marker.geometry.dispose();
  }
  if (state.orbitMat) state.orbitMat.dispose();
  if (state.markerMat) state.markerMat.dispose();
  state.bodies = [];
  state.shipBodies = [];
  if (state.star) {
    scene.remove(state.star.group);
    if (state.star.light && state.star.light.parent === scene) scene.remove(state.star.light);
    disposeObject(state.star.group);
    state.star = null;
  }
  if (state.starMarker) {
    scene.remove(state.starMarker);
    state.starMarker.geometry.dispose();
    state.starMarker.material.dispose();
    state.starMarker = null;
  }
  if (state.sky) {
    scene.remove(state.sky);
    disposeObject(state.sky);
    state.sky = null;
  }
}

function buildSystem() {
  const { star, planets } = state.system;
  const host = state.host;
  const scene = state.scene;
  const dotTex = state.dotTex;

  // sky at the host's heliocentric position (null -> the Sun's sky)
  const origin = (Number.isFinite(host.x) && Number.isFinite(host.y) && Number.isFinite(host.z))
    ? { x: host.x, y: host.y, z: host.z } : null;
  const sky = makeSky(THREE, state.skyData, origin);
  if (sky.setPixelRatio) sky.setPixelRatio(state.pixelRatio);
  scene.add(sky);
  state.sky = sky;

  // the star at the world origin (drawn at -ship)
  const starRadiusUnits = star.radius_km / KM_PER_UNIT;
  const starObj = makeStar(THREE, { radius_units: starRadiusUnits, teff: star.teff, color: star.color });
  scene.add(starObj.group);
  if (starObj.light && !starObj.light.parent) scene.add(starObj.light);
  state.star = starObj;
  state.starRadiusUnits = starRadiusUnits;
  state.lightColor = new THREE.Color(star.color[0], star.color[1], star.color[2]);
  if (starObj.light && starObj.light.color) state.lightColor.copy(starObj.light.color);
  state.lightColor.lerp(new THREE.Color(1, 1, 1), LIGHT_SOFTEN);

  const starMarkerGeom = new THREE.BufferGeometry();
  starMarkerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const starMarkerMat = new THREE.PointsMaterial({
    color: new THREE.Color(star.color[0], star.color[1], star.color[2]), size: 9 * state.pixelRatio,
    map: dotTex, alphaTest: 0.05,
    sizeAttenuation: false, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  });
  starMarkerMat.toneMapped = false;
  const starMarker = new THREE.Points(starMarkerGeom, starMarkerMat);
  starMarker.frustumCulled = false;
  starMarker.renderOrder = 5;
  scene.add(starMarker);
  state.starMarker = starMarker;

  const orbitMat = new THREE.LineBasicMaterial({ color: 0xF5B324, transparent: true, opacity: 0.32 });
  const markerMat = new THREE.PointsMaterial({
    color: 0xF5B324, size: 6 * state.pixelRatio, sizeAttenuation: false,
    map: dotTex, alphaTest: 0.05,
    transparent: true, opacity: 0.8, depthTest: false, depthWrite: false,
  });
  markerMat.toneMapped = false;
  state.orbitMat = orbitMat;
  state.markerMat = markerMat;

  let outer = starRadiusUnits * 12;
  const bodies = [];
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i];
    const rUnits = p.radius_km / KM_PER_UNIT;
    const aUnits = p.a_km / KM_PER_UNIT;
    const e = Math.max(0, Math.min(0.95, Number.isFinite(p.e) ? p.e : 0));
    const seed = seedFrom(p.name);

    const material = makePlanetMaterial(THREE, {
      cls: p.cls, teq: p.teq, radius_km: p.radius_km, seed, tidally_locked: p.tidally_locked,
    });
    const geom = new THREE.SphereGeometry(rUnits, PLANET_SEGMENTS, PLANET_SEGMENTS);
    const mesh = new THREE.Mesh(geom, material);
    mesh.name = p.name;
    // SphereGeometry puts the poles on local y; orbits lie in z = 0 with +z up, so tilt the
    // sphere by 90 degrees about x (order XYZ: spin about local y is applied first, then the tilt)
    mesh.rotation.order = 'XYZ';
    mesh.rotation.set(Math.PI / 2, 0, 0);
    scene.add(mesh);

    const showAtm = (p.radius_km > 1.6 * EARTH_RADIUS_KM) || (Number.isFinite(p.teq) && p.teq < 1500);
    let atmosphere = null;
    if (showAtm) {
      const atmColor = atmosphereColour(p);
      atmosphere = makeAtmosphere(THREE, { radius_units: rUnits, color: atmColor, strength: p.cls === 'gas-giant' ? 0.7 : 0.55 });
      mesh.add(atmosphere);
    }

    // orbit: ellipse with the star at one focus, periastron on +x, in the z = 0 plane
    const pts = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
    const semiLatus = aUnits * (1 - e * e);
    for (let k = 0; k <= ORBIT_SEGMENTS; k++) {
      const nu = (k / ORBIT_SEGMENTS) * TAU;
      const r = semiLatus / (1 + e * Math.cos(nu));
      pts[k * 3] = r * Math.cos(nu);
      pts[k * 3 + 1] = r * Math.sin(nu);
      pts[k * 3 + 2] = 0;
    }
    const orbitGeom = new THREE.BufferGeometry();
    orbitGeom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const orbit = new THREE.Line(orbitGeom, orbitMat);
    orbit.frustumCulled = false;
    scene.add(orbit);

    const markerGeom = new THREE.BufferGeometry();
    markerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const marker = new THREE.Points(markerGeom, markerMat);
    marker.frustumCulled = false;
    marker.renderOrder = 5;
    scene.add(marker);

    // the true period, sub-day ones included (55 Cnc e orbits in 17.7 h); only a missing value falls back
    const periodSeconds = (p.period_days > 0 ? p.period_days : 1) * DAY_S;
    const body = {
      planet: p, mesh, material, atmosphere, orbit, marker,
      radiusUnits: rUnits, aUnits, e, seed,
      periodSeconds,
      meanAnomaly0: seed * TAU,            // starting phase: not in the catalogue, assumed
      rotationSeconds: (p.rotation_hours > 0 ? p.rotation_hours : 24) * 3600,
      swatch: dominantColour(material, p),
      atmosphereShown: showAtm,
      atmosphereColour: showAtm ? atmosphereColour(p) : null,
      world: { x: 0, y: 0, z: 0 },          // true position, doubles
      vel: { x: 0, y: 0, z: 0 },            // finite-difference velocity, units per real second
      velKnown: false,
    };
    bodies.push(body);
    outer = Math.max(outer, aUnits * (1 + e) + rUnits);
  }
  state.bodies = bodies;
  state.outerRadius = outer;

  // camera limits per system: a planet at 19,000 AU needs a far plane and an orbit radius the
  // defaults do not reach (the logarithmic depth buffer keeps precision; the sky sits at 2e7 units)
  const need = systemDistance() * 1.5;
  state.controls.maxDistance = Math.max(5e8, need);
  state.camera.far = state.orbitCam.far = Math.max(1e9, outer * 8);
  state.camera.updateProjectionMatrix();
  state.orbitCam.updateProjectionMatrix();

  // the ship's view of the system: star first, then the planets (positions shared by reference)
  const sb = state.starBody;
  sb.name = host.name;
  sb.radius_units = starRadiusUnits;
  const shipBodies = [sb];
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    shipBodies.push({ name: b.planet.name, pos: b.world, vel: b.vel, radius_units: b.radiusUnits, kind: 'planet', index: i });
  }
  state.shipBodies = shipBodies;

  resize();
  positionBodies(state.simSeconds, 0);
}

/**
 * Swap the whole system for another host (no page reload).
 * @param name  host name (resolved with findHost)
 * @param opts  { immediate: bool (no tween), arrival: bool (place the ship at the arrival point) }
 */
async function setHost(name, opts) {
  const o = opts || {};
  const host = findHost(state.catalog, name);
  if (!host) throw new Error('host "' + name + '" is not in the catalogue');
  state.building = true;
  try {
    teardownSystem();
    state.host = host;
    state.system = deriveSystem(host);
    state.simSeconds = 0;
    state.focus.mode = 'system';
    state.focus.index = -1;
    state.tween.active = false;
    state.target = null;                 // the bodies are about to be replaced
    if (state.hud && typeof state.hud.setTargetBody === 'function') state.hud.setTargetBody(null);
    document.title = host.name + ' · Explore · Davide Staub';
    if (el.hostTitle) el.hostTitle.textContent = host.name;
    const mapHref = 'map.html?host=' + encodeURIComponent(host.name);
    if (el.fullMap) el.fullMap.href = mapHref;
    if (el.fullMapFoot) el.fullMapFoot.href = mapHref;

    buildSystem();
    buildPlanetButtons();
    renderStarLine();

    const ship = state.ship;
    ship.cancelAutopilot();
    ship.unanchor();
    ship.setVelocity(null);
    ship.setThrottleIndex(0);
    if (o.arrival !== false) placeShipAtArrival();
    snapViews();                         // a teleport: no camera lag or pose blend across it

    if (state.mode === 'attract') {
      // the attract frame starts from wherever the ship is; the focus tween takes it to the system view
      syncOrbitFrameToShip();
      setFocus('system', -1, !!o.immediate);
    } else {
      setFocus('system', -1, true);
    }
    if (state.minimap) { state.minimap.setCurrent(host.name); state.minimap.draw(); }
    hudState.hudAt = -1;
    updateClock(true);
    // one placed frame even when the loop is paused (hidden tab, offscreen stage)
    step(0);
    renderFrame();
  } finally {
    state.building = false;
  }
}

/** Arrival point: ARRIVAL_STAR_RADII from the star on the side of the outermost planet, facing the star. */
function placeShipAtArrival() {
  const ship = state.ship;
  const bodies = state.bodies;
  let dx = 1, dy = 0;
  if (bodies.length) {
    const outerBody = bodies[bodies.length - 1];
    const w = outerBody.world;
    const len = Math.hypot(w.x, w.y);
    if (len > 1e-9) { dx = w.x / len; dy = w.y / len; }
  }
  const d = state.starRadiusUnits * ARRIVAL_STAR_RADII;
  ship.setPosition({ x: dx * d, y: dy * d, z: state.starRadiusUnits * 2 });
  ship.setVelocity(null);
  ship.lookAt({ x: 0, y: 0, z: 0 });
}

function systemDistance() {
  const aspect = state.camera ? state.camera.aspect : 1.6;
  const half = THREE.MathUtils.degToRad(state.camera ? state.camera.fov / 2 : 22.5);
  const fit = state.outerRadius / Math.tan(half);
  return fit * (aspect < 1 ? 1.15 / aspect : 1.15);
}

/* ---------------- legacy side panel and HUD lists ---------------- */

function buildPlanetButtons() {
  if (el.planetList && !state.hud) {
    const frag = document.createDocumentFragment();
    state.bodies.forEach((b, i) => {
      const p = b.planet;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'f-btn f-planet';
      btn.dataset.index = String(i);
      btn.setAttribute('aria-pressed', 'false');
      const sw = document.createElement('span');
      sw.className = 'p-sw';
      sw.style.background = rgbCss(b.swatch);
      sw.style.boxShadow = '0 0 6px ' + rgbCss(b.swatch);
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = p.name;
      const meta = document.createElement('span');
      meta.className = 'p-meta';
      meta.textContent = p.cls + ' · ' + fmt(p.radius_km / EARTH_RADIUS_KM, 2) + ' Re';
      meta.title = 'class, radius in Earth radii (' + srcNote(p.radius_src) + ')';
      btn.append(sw, name, meta);
      btn.addEventListener('click', () => setFocus('planet', i));
      frag.appendChild(btn);
    });
    el.planetList.replaceChildren(frag);
  }
  if (state.hud && typeof state.hud.setBodies === 'function') {
    state.hud.setBodies(state.bodies.map((b) => ({
      name: b.planet.name, host: state.host.name, cls: b.planet.cls,
      radius_re: b.planet.radius_km / EARTH_RADIUS_KM, swatchCss: rgbCss(b.swatch),
    })));
  }
}

function setTimeScale(scale) {
  const s = Number(scale);
  if (!(s > 0)) { setPaused(true); return; }
  state.timeScale = s;
  if (state.paused) setPaused(false);
  el.timeButtons.forEach((btn) => {
    const on = Number(btn.dataset.scale) === s;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setPaused(paused) {
  state.paused = paused;
  if (el.pause) {
    el.pause.classList.toggle('active', paused);
    el.pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    el.pause.textContent = paused ? 'resume' : 'pause';
  }
}

function timeScaleLabel() {
  if (state.paused) return 'paused';
  return TIME_LABELS[state.timeScale] || (fmt(state.timeScale, 0) + ' s/s');
}

let lastClockText = '';
let lastClockAt = -1;
function updateClock(force) {
  if (!el.clock) return;
  if (!force && state.realSeconds - lastClockAt < 0.25) return;
  lastClockAt = state.realSeconds;
  const text = 'elapsed: ' + fmtElapsed(state.simSeconds);
  if (text !== lastClockText) { el.clock.textContent = text; lastClockText = text; }
}

/* ---------------- focus ---------------- */

function focusButtons() {
  const list = [];
  if (el.btnStar) list.push(el.btnStar);
  if (el.btnSystem) list.push(el.btnSystem);
  if (el.planetList) list.push(...el.planetList.querySelectorAll('.f-planet'));
  return list;
}

/** Resolve 'star', 'system' or a planet name (full, suffix letter, or substring) to a focus. */
function resolveFocus(name) {
  const key = String(name || '').trim().toLowerCase();
  if (key === 'star' || key === state.host.name.toLowerCase()) return { mode: 'star', index: -1 };
  if (key === 'system' || key === '') return { mode: 'system', index: -1 };
  let idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase() === key);
  if (idx < 0) idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase().endsWith(' ' + key));
  if (idx < 0) idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase().includes(key));
  if (idx < 0) return null;
  return { mode: 'planet', index: idx };
}

function focusByName(name, immediate) {
  const f = resolveFocus(name);
  if (!f) { toast('no such body: ' + name); return false; }
  setFocus(f.mode, f.index, immediate);
  return true;
}

function focusMinDistance(mode, index) {
  if (mode === 'planet') return state.bodies[index].radiusUnits * 1.4;
  return state.starRadiusUnits * 1.3;
}

function focusDistance(mode, index) {
  if (mode === 'planet') return Math.max(state.bodies[index].radiusUnits * 6, 0.05);
  if (mode === 'star') return state.starRadiusUnits * 8;
  return systemDistance();
}

/** World position (doubles) of a focus. */
function focusWorldOf(mode, index, out) {
  if (mode === 'planet') {
    const w = state.bodies[index].world;
    out.x = w.x; out.y = w.y; out.z = w.z;
  } else {
    out.x = 0; out.y = 0; out.z = 0;
  }
  return out;
}

/** Unit vector from a planet toward a good viewpoint: rotated FOCUS_AZIMUTH round from the
    star direction in the orbital plane, lifted above the plane. */
function focusDirection(body, out) {
  const px = body.world.x, py = body.world.y;
  let ang = Math.atan2(-py, -px);                 // direction planet -> star (star at the origin)
  if (!Number.isFinite(ang)) ang = 0;
  ang += FOCUS_AZIMUTH;
  out.set(Math.cos(ang), Math.sin(ang), FOCUS_ELEVATION).normalize();
  return out;
}

/**
 * Focus a body. In attract mode the camera tweens to it; in flight it only becomes the
 * target for the dossier and the HUD readouts (the autopilot flies there on request).
 */
function setFocus(mode, index, immediate) {
  const f = state.focus;
  const prevMode = f.mode, prevIndex = f.index;
  f.mode = mode;
  f.index = mode === 'planet' ? index : -1;

  if (state.mode === 'attract') {
    const cam = state.orbitCam, controls = state.controls, tw = state.tween;
    const dist = focusDistance(mode, index);
    controls.minDistance = focusMinDistance(mode, index);

    // where the camera is now, in world doubles: old frame origin + local offset
    focusWorldOf(prevMode, prevIndex, tmpD);
    tmpDir.subVectors(cam.position, controls.target);
    if (tmpDir.lengthSq() < 1e-12) tmpDir.set(0, -0.72, 0.69);
    const fromDist = tmpDir.length();
    tmpDir.normalize();
    tw.fromDir.copy(tmpDir);
    if (mode === 'planet') focusDirection(state.bodies[index], tw.toDir);
    else tw.toDir.copy(tmpDir);

    if (immediate) {
      tw.active = false;
      focusWorldOf(mode, index, state.focusWorld);
      controls.target.set(0, 0, 0);
      cam.position.copy(tw.toDir).multiplyScalar(dist);
      cam.lookAt(controls.target);
      applyOrbitFrameToShip();
    } else {
      tw.active = true;
      tw.t = 0;
      tw.slerp = false;
      tw.fromTarget.x = tmpD.x + controls.target.x;
      tw.fromTarget.y = tmpD.y + controls.target.y;
      tw.fromTarget.z = tmpD.z + controls.target.z;
      tw.fromDist = fromDist;
      tw.toDist = dist;
    }
  }

  // a visit is earned in flight (checkDiscovery) or by an autopilot arrival (onShipArrive), not by focusing a chip

  focusButtons().forEach((btn) => {
    const on = (btn.dataset.focus === mode) || (mode === 'planet' && Number(btn.dataset.index) === index);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderDossier();
}

/** Attract frame: local origin = focus world position; the ship sits at origin + orbitCam.position. */
function applyOrbitFrameToShip() {
  const cam = state.orbitCam, ship = state.ship, fw = state.focusWorld;
  ship.pos.x = fw.x + cam.position.x;
  ship.pos.y = fw.y + cam.position.y;
  ship.pos.z = fw.z + cam.position.z;
  ship.quat.copy(cam.quaternion);
}

/** The inverse: put the orbit camera where the ship is, relative to the current focus. */
function syncOrbitFrameToShip() {
  const cam = state.orbitCam, controls = state.controls, ship = state.ship, f = state.focus;
  focusWorldOf(f.mode, f.index, state.focusWorld);
  const fw = state.focusWorld;
  controls.target.set(0, 0, 0);
  cam.position.set(ship.pos.x - fw.x, ship.pos.y - fw.y, ship.pos.z - fw.z);
  cam.quaternion.copy(ship.quat);
}

/** Leaving flight: keep the view where the ship is, turn toward the focus, then let OrbitControls take over. */
function enterAttractFromShip() {
  const ship = state.ship, tw = state.tween, controls = state.controls, cam = state.orbitCam;
  // if the ship is parked near a planet, that planet becomes the focus
  let nearest = -1, nearestRadii = RELEASE_FOCUS_RADII;
  for (let i = 0; i < state.bodies.length; i++) {
    const b = state.bodies[i];
    const d = Math.hypot(ship.pos.x - b.world.x, ship.pos.y - b.world.y, ship.pos.z - b.world.z) / b.radiusUnits;
    if (d < nearestRadii) { nearestRadii = d; nearest = i; }
  }
  const f = state.focus;
  if (nearest >= 0 && !(f.mode === 'planet' && f.index === nearest)) {
    f.mode = 'planet'; f.index = nearest;
    focusButtons().forEach((btn) => {
      const on = Number(btn.dataset.index) === nearest;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderDossier();
  }
  syncOrbitFrameToShip();
  controls.minDistance = focusMinDistance(f.mode, f.index);
  tmpDir.copy(cam.position);
  let dist = tmpDir.length();
  if (dist < 1e-9) { tmpDir.set(0, -0.72, 0.69); dist = focusDistance(f.mode, f.index); }
  tmpDir.normalize();
  tw.active = true;
  tw.t = 0;
  tw.slerp = true;
  tw.fromQuat.copy(ship.quat);
  tw.fromTarget.x = state.focusWorld.x;
  tw.fromTarget.y = state.focusWorld.y;
  tw.fromTarget.z = state.focusWorld.z;
  tw.fromDir.copy(tmpDir);
  tw.toDir.copy(tmpDir);
  tw.fromDist = dist;
  tw.toDist = Math.max(dist, controls.minDistance * 1.5);
}

function updateAttract(dt) {
  const cam = state.orbitCam, controls = state.controls, tw = state.tween, f = state.focus;
  const fw = focusWorldOf(f.mode, f.index, state.focusWorld);
  if (tw.active) {
    tw.t = Math.min(1, tw.t + dt / TWEEN_SECONDS);
    const s = 1 - Math.pow(1 - tw.t, 3);           // ease out cubic
    tmpDir.lerpVectors(tw.fromDir, tw.toDir, s);
    if (tmpDir.lengthSq() < 1e-12) tmpDir.copy(tw.toDir);
    tmpDir.normalize();
    // the look target slides from the old focus to the new one, expressed in the new frame
    const tx = tw.fromTarget.x + (fw.x - tw.fromTarget.x) * s - fw.x;
    const ty = tw.fromTarget.y + (fw.y - tw.fromTarget.y) * s - fw.y;
    const tz = tw.fromTarget.z + (fw.z - tw.fromTarget.z) * s - fw.z;
    const d = tw.fromDist + (tw.toDist - tw.fromDist) * s;
    controls.target.set(tx, ty, tz);
    cam.position.copy(controls.target).addScaledVector(tmpDir, d);
    cam.lookAt(controls.target);
    applyOrbitFrameToShip();
    if (tw.slerp) state.ship.quat.slerpQuaternions(tw.fromQuat, cam.quaternion, s);
    if (tw.t >= 1) { tw.active = false; tw.slerp = false; }
  } else {
    controls.update();                              // damping, slow auto-orbit, user drag and zoom
    applyOrbitFrameToShip();
  }
}

/* ---------------- modes ---------------- */

function setMode(name) {
  const ship = state.ship;
  const attachOpts = state.noLock ? { lock: false } : undefined;
  if (name === state.mode) {
    if (name === 'flight' && !ship.enabled) ship.attach(attachOpts);
    return;
  }
  if (name === 'flight') {
    hideIntro();
    state.mode = 'flight';
    state.tween.active = false;
    state.controls.enabled = false;
    ship.unanchor();
    ship.setVelocity(null);
    ship.setThrottleIndex(0);
    ship.attach(attachOpts);
    el.canvas.style.touchAction = 'none';        // one finger looks
    if (state.hud) state.hud.setMode('flight');
    if (el.hint) el.hint.textContent = 'mouse looks · W/S throttle · Q/E roll · shift boost · space brake · V view · Esc releases the controls';
    // something to aim at from the first second: the nearest planet, unless a target was already chosen
    if (!state.target) {
      const nb = nearestPlanetBody();
      if (nb) setTarget(nb, { quiet: true });
    }
    toast('you have the controls' + (state.target ? ' · F flies to ' + state.target.name : '') + ' · H for help', 3600);
    if (!state.hintShown && state.hud && typeof state.hud.showHint === 'function') {
      state.hintShown = true;
      state.hud.showHint(HINT_STRIP_TEXT, HINT_STRIP_MS);
    }
  } else if (name === 'attract') {
    state.mode = 'attract';
    ship.cancelAutopilot();
    if (ship.enabled) ship.detach();
    enterAttractFromShip();
    state.controls.enabled = true;
    el.canvas.style.touchAction = 'pan-y';       // one finger scrolls the page, two fingers rotate and zoom
    if (state.hud) state.hud.setMode('attract');
    if (el.hint) el.hint.textContent = ATTRACT_HINT;
  } else if (name === 'warp') {
    state.mode = 'warp';
    state.tween.active = false;
    state.controls.enabled = false;
    ship.cancelAutopilot();
    ship.setVelocity(null);
    if (typeof ship.resetInputs === 'function') ship.resetInputs();   // no stored look input is applied on arrival
    el.canvas.style.touchAction = 'pan-y';
    if (state.hud) state.hud.setMode('warp');
  } else {
    throw new Error('unknown mode: ' + name);
  }
  hudState.hudAt = -1;
  applyViewDom();                      // attract shows the chase view whatever the preference
  beginPoseBlend();                    // the model eases between its attract and flight poses
  updateTargetOverlay();               // hidden in warp mode, back on the target after it
}

/* ---------------- autopilot, discovery, warp ---------------- */

function autopilotByName(name) {
  if (state.mode === 'warp' || state.building) { toast('wait for the jump to finish'); return false; }
  const body = bodyByName(name);
  if (!body) { toast('pick a body first'); return false; }
  setTarget(body, { quiet: true });
  return flyToTarget();
}

/** F: the autopilot flies to the target (the nearest planet when nothing is targeted). */
function flyToTarget() {
  if (state.mode === 'warp' || state.building) { toast('wait for the jump to finish'); return false; }
  let t = state.target;
  if (!t) {
    t = nearestPlanetBody();
    if (!t) { toast('nothing to fly to in this system'); return false; }
    setTarget(t, { quiet: true });
  }
  if (state.mode !== 'flight') setMode('flight');
  const ship = state.ship;
  if (ship.autopilot && ship.autopilotBody === t) { toast('autopilot: already flying to ' + t.name); return true; }
  ship.autopilotTo(t, { stopRadii: AUTOPILOT_STOP_RADII });
  hudState.hudAt = -1;
  ov.subAt = -1;
  toast('autopilot: flying to ' + t.name + ' · any input cancels');
  return true;
}

function onShipArrive(body) {
  toast('arrived at ' + body.name, 3200);
  ov.subAt = -1;
  if (body.kind === 'planet') markVisited(state.host.name);
}

/* ---------------- target ---------------- */

/** Resolve 'star' or a planet name (full, suffix letter, or substring) to a ship body, or null. */
function bodyByName(name) {
  const f = resolveFocus(name);
  if (!f || f.mode === 'system') return null;
  return f.mode === 'star' ? state.shipBodies[0] : (state.shipBodies[f.index + 1] || null);
}

/** The planet whose surface is nearest the ship, or null when the system has none. */
function nearestPlanetBody() {
  const ship = state.ship, sb = state.shipBodies;
  let best = null, bestD = Infinity;
  for (let i = 1; i < sb.length; i++) {
    const b = sb[i];
    const d = Math.hypot(b.pos.x - ship.pos.x, b.pos.y - ship.pos.y, b.pos.z - ship.pos.z) - b.radius_units;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/**
 * Set the target (a state.shipBodies entry) or clear it. In flight the dossier follows the
 * target; in attract mode the camera stays where it is (the chip's focus does that).
 */
function setTarget(body, o) {
  const quiet = !!(o && o.quiet);
  const b = body || null;
  state.target = b;
  if (state.hud) {
    if (typeof state.hud.setTargetBody === 'function') state.hud.setTargetBody(b && b.kind === 'planet' ? b.name : null);
    // the phone bar's 'fly' button flies to the HUD's selected body: keep it on the target
    if (typeof state.hud.setSelectedBody === 'function') state.hud.setSelectedBody(b ? b.name : null);
  }
  if (b && state.mode === 'flight') {
    const f = state.focus;
    const mode = b.kind === 'star' ? 'star' : 'planet';
    const index = b.kind === 'star' ? -1 : b.index;
    if (f.mode !== mode || f.index !== index) setFocus(mode, index, true);
  }
  hudState.hudAt = -1;
  ov.subAt = -1;
  if (!quiet) toast(b ? 'target: ' + b.name + ' · F flies there' : 'target cleared', 2600);
  updateTargetOverlay();
  return b;
}

/** T / Shift+T: planets in orbit order, then the star, round again. */
function cycleTarget(dir) {
  const sb = state.shipBodies, n = sb.length;
  if (!n) return null;
  // cycle index k: 0..n-2 are the planets (sb[1..]), n-1 is the star (sb[0])
  let k = -1;
  if (state.target) k = state.target.kind === 'star' ? n - 1 : state.target.index;
  k = (((k + (dir < 0 ? -1 : 1)) % n) + n) % n;
  return setTarget(sb[k < n - 1 ? k + 1 : 0]);
}

/** G: target the nearest planet. */
function targetNearest() {
  const nb = nearestPlanetBody();
  if (!nb) { toast('no planet in this system'); return null; }
  if (nb === state.target) { toast('target: ' + nb.name + ' is already the nearest · F flies there'); return nb; }
  return setTarget(nb);
}

/**
 * Project a body to the canvas. The relative position is taken from ship.pos in doubles, then
 * the camera's small offset from the ship origin is subtracted and the result rotated into
 * the camera's frame (at the origin with the ship's orientation in the cockpit view, behind
 * and above it in the chase view). The nose alignment is measured in the ship's own frame.
 */
function projectBody(b) {
  const ship = state.ship, camera = state.camera;
  const w = el.canvas.clientWidth || 1, h = el.canvas.clientHeight || 1;
  tmpDir.set(b.pos.x - ship.pos.x, b.pos.y - ship.pos.y, b.pos.z - ship.pos.z);
  proj.dist = tmpDir.length();
  vA.set(0, 0, -1).applyQuaternion(ship.quat);
  proj.nose = proj.dist > 1e-9 ? tmpDir.dot(vA) / proj.dist : 0;
  tmpDir.sub(camera.position);
  const camDist = tmpDir.length();
  tmpQ.copy(camera.quaternion).invert();
  tmpDir.applyQuaternion(tmpQ);
  proj.cx = tmpDir.x; proj.cy = tmpDir.y; proj.cz = tmpDir.z;
  const pm = camera.projectionMatrix.elements;      // [0] = f / aspect, [5] = f = 1 / tan(fov / 2)
  proj.front = tmpDir.z < 0;
  const iz = proj.front ? 1 / -tmpDir.z : 0;
  proj.sx = (tmpDir.x * iz * pm[0] + 1) * 0.5 * w;
  proj.sy = (1 - tmpDir.y * iz * pm[5]) * 0.5 * h;
  proj.discPx = (b.radius_units / Math.max(camDist, 1e-9)) * (h * 0.5 * pm[5]);   // apparent radius in px
  return proj;
}

/** The body whose projected centre (or disc) is nearest a canvas point, within TARGET_CLICK_PX. */
function bodyAtScreen(px, py) {
  const sb = state.shipBodies;
  let best = null, bestD = Infinity;
  for (let i = 0; i < sb.length; i++) {
    const p = projectBody(sb[i]);
    if (!p.front) continue;
    const d = Math.hypot(p.sx - px, p.sy - py);
    const lim = Math.max(TARGET_CLICK_PX, p.discPx);
    if (d <= lim && d < bestD) { bestD = d; best = sb[i]; }
  }
  return best;
}

/**
 * Seconds the autopilot needs from a distance: the capped run at full speed, then the
 * ease-out, whose speed law is remaining / EASE_S + CREEP * r down to ARRIVE_FRACTION radii
 * (integrated: EASE_S * ln((R + c) / (arrive + c)) with c = CREEP * r * EASE_S).
 * An estimate, refreshed every frame; the turn at the start is not counted.
 */
function autopilotEta(dist, body) {
  const r = Math.max(1e-6, Number(body.radius_units) || 1e-6);
  const stop = r * (1 + state.ship.autopilotStopRadii);
  let remaining = Math.max(0, dist - stop);
  const T = AUTOPILOT.EASE_S;
  const capDist = AUTOPILOT.MAX_UNITS_PER_S * T;
  let t = 0;
  if (remaining > capDist) { t += (remaining - capDist) / AUTOPILOT.MAX_UNITS_PER_S; remaining = capDist; }
  const c = AUTOPILOT.CREEP * r * T;
  t += T * Math.log(Math.max(1, (remaining + c) / (AUTOPILOT.ARRIVE_FRACTION * r + c)));
  return t;
}

function setBracketShown(on) {
  if (ov.shown === on) return;
  ov.shown = on;
  el.bracket.hidden = !on;
}
function setEdgeShown(on) {
  if (ov.edgeShown === on) return;
  ov.edgeShown = on;
  el.edge.hidden = !on;
}

/** Place the bracket over the target, or the edge arrow toward it; every DOM write is on change only. */
function updateTargetOverlay() {
  const t = state.target;
  if (!el.bracket || !el.edge) { ov.aligned = false; return; }
  if (!t || state.mode === 'warp' || state.building) {
    setBracketShown(false);
    setEdgeShown(false);
    ov.aligned = false;
    return;
  }
  const p = projectBody(t);
  const w = el.canvas.clientWidth || 1, h = el.canvas.clientHeight || 1;
  const ship = state.ship;
  const surface = Math.max(0, p.dist - t.radius_units);
  // the nose is on the target when the body direction is close to the ship's forward axis
  ov.aligned = p.dist > 1e-9 && p.nose > ALIGN_COS;

  if (t.name !== ov.name) { ov.name = t.name; el.bracketName.textContent = t.name; }
  if (ov.subAt < 0 || state.realSeconds - ov.subAt >= 1 / HUD_HZ) {
    ov.subAt = state.realSeconds;
    const km = surface * KM_PER_UNIT;
    const distText = fmtDistanceLong(km);
    let sub;
    if (ship.autopilot && ship.autopilotBody === t) {
      sub = 'autopilot · arriving in ' + Math.ceil(autopilotEta(p.dist, t)) + ' s';
    } else {
      // stopped (or parked at the target): the distance alone, no time
      const v = ship.speedUnits();
      const eta = v * KM_PER_UNIT >= 0.5 ? surface / v : NaN;
      sub = Number.isFinite(eta) ? distText + ' · ' + fmtDuration(eta) + ' at this speed' : distText;
    }
    if (sub !== ov.sub) { ov.sub = sub; el.bracketSub.textContent = sub; }
    const label = t.name + ' · ' + distText;
    if (label !== ov.label) { ov.label = label; el.edgeLabel.textContent = label; }
  }

  const onScreen = p.front && p.sx >= 0 && p.sx <= w && p.sy >= 0 && p.sy <= h;
  if (onScreen) {
    setEdgeShown(false);
    let size = Math.max(BRACKET_MIN_PX, Math.round(p.discPx * 2 + 14));
    size = Math.min(size, Math.round(Math.min(w, h) * 0.8));
    const x = Math.round(p.sx - size / 2), y = Math.round(p.sy - size / 2);
    if (size !== ov.size) {
      ov.size = size;
      el.bracket.style.width = size + 'px';
      el.bracket.style.height = size + 'px';
    }
    if (x !== ov.x || y !== ov.y) {
      ov.x = x; ov.y = y;
      el.bracket.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }
    setBracketShown(true);
    return;
  }

  setBracketShown(false);
  // direction from the screen centre: the projection when in front, the camera-space offset when behind
  let dx, dy;
  if (p.front) { dx = p.sx - w / 2; dy = p.sy - h / 2; } else { dx = p.cx; dy = -p.cy; }
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) { dx = 0; dy = 1; len = 1; }
  dx /= len; dy /= len;
  const cx = w / 2, cy = h / 2;
  const bot = EDGE_MARGIN_BOTTOM + state.mbarPx;
  let tx = Infinity, ty = Infinity;
  if (dx > 1e-9) tx = (w - EDGE_MARGIN_X - cx) / dx; else if (dx < -1e-9) tx = (EDGE_MARGIN_X - cx) / dx;
  if (dy > 1e-9) ty = (h - bot - cy) / dy; else if (dy < -1e-9) ty = (EDGE_MARGIN_TOP - cy) / dy;
  const tt = Math.max(0, Math.min(tx, ty));
  const ex = Math.round(cx + dx * tt), ey = Math.round(cy + dy * tt);
  const ang = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
  if (ex !== ov.ex || ey !== ov.ey) {
    ov.ex = ex; ov.ey = ey;
    el.edge.style.transform = 'translate(' + ex + 'px,' + ey + 'px)';
  }
  if (ang !== ov.ang) { ov.ang = ang; el.edgeArrow.style.transform = 'rotate(' + ang + 'deg)'; }
  // the label sits on the inward side of the edge the arrow rests on, so it is never clipped
  const side = tx < ty ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  if (side !== ov.side) { ov.side = side; el.edge.dataset.side = side; }
  setEdgeShown(true);
}

/* ---------------- jump: destination and chooser ---------------- */

function placedHost(h) { return !!h && Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z); }

function hostRow(h) {
  return { name: h.name, planets: h.planets.length, ly: hostDistanceLy(state.host, h), current: h === state.host };
}

/** The n nearest hosts with a catalogued position, nearest first. */
function nearestHostRows(n) {
  const cur = state.host;
  if (!placedHost(cur)) return [];
  const best = [], d2s = [];
  for (const h of state.catalog.hostList) {
    if (h === cur || !placedHost(h)) continue;
    const dx = h.x - cur.x, dy = h.y - cur.y, dz = h.z - cur.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (best.length >= n && d2 >= d2s[best.length - 1]) continue;
    let i = best.length;
    while (i > 0 && d2s[i - 1] > d2) i--;
    best.splice(i, 0, h);
    d2s.splice(i, 0, d2);
    if (best.length > n) { best.pop(); d2s.pop(); }
  }
  return best.map(hostRow);
}

function famousHostRows() {
  const rows = [];
  for (const name of JUMP_FAMOUS) {
    const h = findHost(state.catalog, name);
    if (h && h !== state.host && placedHost(h)) rows.push(hostRow(h));
  }
  return rows;
}

/** Search: findHost's own resolution, then host and planet name prefixes, then substrings, 8 at most. */
function searchHostRows(query) {
  const key = String(query == null ? '' : query).trim().toLowerCase();
  if (!key) return [];
  const list = state.catalog.hostList;
  const seen = new Set();
  const rows = [];
  const add = (h) => {
    if (!h || seen.has(h) || rows.length >= 8) return;
    seen.add(h);
    rows.push(hostRow(h));
  };
  add(findHost(state.catalog, query));
  for (let i = 0; i < list.length && rows.length < 8; i++) if (list[i].name.toLowerCase().startsWith(key)) add(list[i]);
  for (let i = 0; i < list.length && rows.length < 8; i++) {
    const ps = list[i].planets;
    for (let k = 0; k < ps.length; k++) if (String(ps[k].name).toLowerCase().startsWith(key)) { add(list[i]); break; }
  }
  for (let i = 0; i < list.length && rows.length < 8; i++) if (list[i].name.toLowerCase().includes(key)) add(list[i]);
  return rows;
}

/** 'somewhere new': a random host that qualifies (catalogued distance, a measured planet) and is placed. */
function randomHostName() {
  if (!state.jumpPool) state.jumpPool = state.catalog.hostList.filter((h) => hostQualifies(h) && placedHost(h));
  const pool = state.jumpPool;
  if (!pool.length) return null;
  for (let k = 0; k < 12; k++) {
    const h = pool[Math.floor(Math.random() * pool.length)];
    if (h !== state.host) return h.name;
  }
  return null;
}

/** One destination for the minimap pick, the chooser and the JUMP button. */
function setDestination(name) {
  const host = name ? findHost(state.catalog, name) : null;
  state.pickedHost = host ? host.name : null;
  const ly = host ? hostDistanceLy(state.host, host) : null;
  state.pickedLy = ly;
  if (state.hud && typeof state.hud.setPickedHost === 'function') state.hud.setPickedHost(state.pickedHost, ly == null ? NaN : ly);
  if (state.minimap && typeof state.minimap.setPicked === 'function') state.minimap.setPicked(state.pickedHost);
  if (state.jump) state.jump.setDestination(state.pickedHost);
  return state.pickedHost;
}

function openJump(tab) {
  if (!state.jump) { toast('the system chooser did not load; pick a host on the map'); return false; }
  if (state.mode === 'warp' || state.building) { toast('wait for the jump to finish'); return false; }
  state.jump.open(tab);
  return true;
}

function loadVisited() {
  try {
    const a = JSON.parse(localStorage.getItem(VISITED_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.filter((s) => typeof s === 'string') : []);
  } catch (err) {
    return new Set();
  }
}

function markVisited(hostName) {
  if (!hostName || state.visited.has(hostName)) return;
  state.visited.add(hostName);
  try { localStorage.setItem(VISITED_KEY, JSON.stringify(Array.from(state.visited))); } catch (err) { /* private mode */ }
  const total = totalSystems();
  if (state.hud) state.hud.setVisited(state.visited.size, total);
  if (state.minimap) { state.minimap.setVisited(state.visited); state.minimap.draw(); }
  toast('system visited: ' + hostName + ' · ' + state.visited.size + ' of ' + total.toLocaleString('en-GB'));
}

/** In flight, coming within DISCOVER_RADII of any planet counts as a visit. */
function checkDiscovery() {
  if (state.visited.has(state.host.name)) return;
  const ship = state.ship;
  for (let i = 0; i < state.bodies.length; i++) {
    const b = state.bodies[i];
    const lim = b.radiusUnits * (1 + DISCOVER_RADII);
    const dx = ship.pos.x - b.world.x, dy = ship.pos.y - b.world.y, dz = ship.pos.z - b.world.z;
    if (dx * dx + dy * dy + dz * dz < lim * lim) { markVisited(state.host.name); return; }
  }
}

function hostDistanceLy(a, b) {
  if (!a || !b) return null;
  const ok = (h) => Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.z);
  if (!ok(a) || !ok(b)) return null;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * PC_TO_LY;
}

async function warpTo(name) {
  if (state.mode === 'warp' || state.building) return false;
  const host = findHost(state.catalog, name);
  if (!host) { toast('unknown host: ' + name); return false; }
  if (host === state.host) { toast('already at ' + host.name); return false; }
  const from = state.host;
  const prevMode = state.mode;
  const distanceLy = hostDistanceLy(from, host);
  // a flight resumes after the jump (the chooser may have detached the ship for the mouse)
  const keepFlying = prevMode === 'flight';
  if (state.jump && state.jump.isOpen()) { state.jumpResume = false; state.jump.close(); }
  setMode('warp');
  const swap = async () => { await setHost(host.name, { arrival: true, immediate: false }); };
  let arrived = false;
  try {
    try {
      if (state.warp) await state.warp.run({ fromName: from.name, toName: host.name, distanceLy: distanceLy == null ? NaN : distanceLy, onMidpoint: swap });
      else await swap();
    } catch (err) {
      console.error('system: warp failed', err);
    }
    // warp.js swallows a failing onMidpoint: retry the swap once, and report rather than throw
    if (state.host === from) {
      try { await swap(); } catch (err) {
        console.error('system: system swap failed', err);
        setStatus('could not build ' + host.name + ': ' + (err && err.message ? err.message : err), true);
      }
    }
    arrived = state.host !== from;
    if (arrived) {
      writeHostToUrl(host.name);
      // the destination has been reached; the distances of any other pick changed with the system
      setDestination(null);
    }
  } finally {
    // whatever happened, never leave the page in warp mode: every recovering control is hidden there
    if (typeof state.ship.resetInputs === 'function') state.ship.resetInputs();
    state.mode = 'none';   // force the transition
    setMode(keepFlying ? 'flight' : 'attract');
  }
  if (!arrived) return false;
  // the new system's nearest planet is the target from the first frame
  const nb = state.target || nearestPlanetBody();
  if (nb && nb !== state.target) setTarget(nb, { quiet: true });
  const yrs = fmt(distanceLy, 1);
  const light = distanceLy == null ? '' : ' · light takes ' + yrs + (yrs === '1' ? ' year' : ' years');
  toast('arrived at ' + host.name + light + (nb ? ' · target: ' + nb.name + ' · F flies there' : ''), 5000);
  return true;
}

/* ---------------- simulation ---------------- */

/** True positions (doubles) and spins for a simulation time; velocities by finite difference over real dt. */
function positionBodies(simSeconds, dt) {
  const bodies = state.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const M = b.meanAnomaly0 + TAU * (simSeconds / b.periodSeconds);
    const E = solveKepler(M, b.e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const x = b.aUnits * (cosE - b.e);
    const y = b.aUnits * Math.sqrt(1 - b.e * b.e) * sinE;
    const w = b.world;
    if (dt > 0 && b.velKnown) {
      b.vel.x = (x - w.x) / dt; b.vel.y = (y - w.y) / dt; b.vel.z = 0;
    } else if (dt > 0) {
      b.velKnown = true;
    }
    w.x = x; w.y = y; w.z = 0;

    // spin is about the local y axis (the sphere's poles), which the 90 degree
    // x tilt set at build time maps to world +z; the local +x meridian then
    // points at world azimuth = rotation.y
    if (b.planet.tidally_locked) {
      b.mesh.rotation.y = Math.atan2(y, x) + Math.PI;
    } else {
      b.mesh.rotation.y = TAU * (simSeconds / b.rotationSeconds);
    }
  }
}

/** Floating origin: everything is drawn relative to the ship. */
function placeRelative() {
  const s = state.ship.pos;
  const sx = s.x, sy = s.y, sz = s.z;
  if (state.star) state.star.group.position.set(-sx, -sy, -sz);
  if (state.star && state.star.light && state.star.light.parent === state.scene) state.star.light.position.set(-sx, -sy, -sz);
  if (state.starMarker) state.starMarker.position.set(-sx, -sy, -sz);
  const bodies = state.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    b.mesh.position.set(b.world.x - sx, b.world.y - sy, b.world.z - sz);
    b.orbit.position.set(-sx, -sy, -sz);
    b.marker.position.copy(b.mesh.position);
  }
}

function updateLighting(realSeconds) {
  const bodies = state.bodies;
  const lc = state.lightColor;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    tmpDir.set(-b.world.x, -b.world.y, -b.world.z);
    if (tmpDir.lengthSq() < 1e-12) tmpDir.set(1, 0, 0);
    tmpDir.normalize();
    applyLight(b.material, tmpDir, lc, realSeconds);
    if (b.atmosphere) applyLight(b.atmosphere.material, tmpDir, lc, realSeconds);
  }
}

function applyLight(material, dir, color, t) {
  const u = material && material.uniforms;
  if (!u) return;
  if (u.uLightDir && u.uLightDir.value && u.uLightDir.value.isVector3) u.uLightDir.value.copy(dir);
  if (u.uLightColor && u.uLightColor.value) {
    const v = u.uLightColor.value;
    if (v.isColor) v.copy(color);
    else if (v.isVector3) v.set(color.r, color.g, color.b);
  }
  if (u.uTime) u.uTime.value = t;
}

function updateMarkers() {
  const cam = state.camera;
  const h = el.canvas.clientHeight || 1;
  const pxPerUnitAtOne = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
  const bodies = state.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const dist = b.mesh.position.length();
    const apparentPx = (b.radiusUnits / Math.max(dist, 1e-6)) * pxPerUnitAtOne * 2;
    b.marker.visible = apparentPx < MARKER_HIDE_PX;
    // shader level of detail: the disc's height as a fraction of the canvas (the shader picks a threshold)
    const u = b.material && b.material.uniforms && b.material.uniforms.uDetail;
    if (u) u.value = Math.min(1, apparentPx / h);
    // the orbit line is Float32 world vertices plus a translation: near a wide-orbit planet it jitters, so hide it there
    b.orbit.visible = dist > b.radiusUnits * ORBIT_LINE_HIDE_RADII;
  }
  const starDist = state.starMarker ? state.starMarker.position.length() : 1;
  const starPx = (state.starRadiusUnits / Math.max(starDist, 1e-6)) * pxPerUnitAtOne * 2;
  if (state.starMarker) state.starMarker.visible = starPx < MARKER_HIDE_PX;
}

function updateHud(force) {
  const hud = state.hud;
  if (!hud) return;
  if (!force && state.realSeconds - hudState.hudAt < 1 / HUD_HZ) return;
  hudState.hudAt = state.realSeconds;
  const ship = state.ship, host = state.host, t = state.target;
  hudState.speedKms = ship.speedKms();
  hudState.speedC = hudState.speedKms / 299792.458;
  hudState.throttleLevel = ship.throttleLevel();
  hudState.mode = state.mode;
  if (t) {
    hudState.targetName = t.name;
    const d = Math.hypot(ship.pos.x - t.pos.x, ship.pos.y - t.pos.y, ship.pos.z - t.pos.z);
    hudState.distToTargetKm = Math.max(0, d - t.radius_units) * KM_PER_UNIT;
  } else {
    hudState.targetName = null;
    hudState.distToTargetKm = Math.hypot(ship.pos.x, ship.pos.y, ship.pos.z) * KM_PER_UNIT;
  }
  hudState.aligned = ov.aligned;
  hudState.hostName = host.name;
  hudState.distFromEarthLy = Number.isFinite(host.dist_pc) ? host.dist_pc * PC_TO_LY : null;
  hudState.systemsVisited = state.visited.size;
  hudState.totalSystems = totalSystems();
  hudState.autopilot = !!ship.autopilot;
  hudState.timeScaleLabel = timeScaleLabel();
  hud.update(hudState);
  // flying without pointer lock (refused, or ?flight=1): keep a visible crosshair
  if (el.cockpit) {
    const lock = state.mode === 'flight' && !ship.pointerLocked ? '0' : '1';
    if (el.cockpit.dataset.lock !== lock) el.cockpit.dataset.lock = lock;
  }
}

function step(dt) {
  if (!state.paused) state.simSeconds += dt * state.timeScale;
  positionBodies(state.simSeconds, dt);
  if (state.mode === 'attract') {
    updateAttract(dt);
  } else if (state.mode === 'flight') {
    state.ship.update(dt, state.shipBodies);
    checkDiscovery();
  }
  updateCamera(dt);
  placeRelative();
  updateLighting(state.realSeconds);
  if (state.star && typeof state.star.update === 'function') state.star.update(state.realSeconds);
  if (state.sky) state.sky.update(state.camera.position);
  updateMarkers();
  updateTargetOverlay();
  updateClock();
  updateHud(dt === 0);
  updateShipModel(dt);
  updateCockpit();
}

function renderFrame() {
  state.renderer.render(state.scene, state.camera);
}

/* ---------------- loop, visibility, resize ---------------- */

function loop(now) {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(loop);
  const dt = Math.min(0.1, Math.max(0, (now - state.lastFrame) / 1000));
  state.lastFrame = now;
  state.realSeconds += dt;
  step(dt);
  renderFrame();
}

function setRunning(on) {
  if (on && !state.running) {
    state.running = true;
    state.lastFrame = performance.now();
    state.rafId = requestAnimationFrame(loop);
  } else if (!on && state.running) {
    state.running = false;
    cancelAnimationFrame(state.rafId);
  }
}

function reconsiderRunning() {
  setRunning(state.visible && !document.hidden);
}

function installLoop() {
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      state.visible = entries.some((e) => e.isIntersecting);
      reconsiderRunning();
    }, { threshold: 0.02 });
    io.observe(el.stage);
  }
  document.addEventListener('visibilitychange', reconsiderRunning);
  if ('ResizeObserver' in window) {
    new ResizeObserver(resize).observe(el.canvas);
  }
  window.addEventListener('resize', resize);
  reconsiderRunning();
}

function resize() {
  if (!state.renderer) return;
  let w = el.canvas.clientWidth;
  let h = el.canvas.clientHeight;
  if (!(w >= 2 && h >= 2)) {
    w = el.stage.clientWidth || window.innerWidth || 1280;
    h = el.stage.clientHeight || Math.round(window.innerHeight * 0.78) || 720;
  }
  const pr = pixelRatioCap();
  if (pr !== state.pixelRatio) {
    state.pixelRatio = pr;
    state.renderer.setPixelRatio(pr);
    if (state.sky && state.sky.setPixelRatio) state.sky.setPixelRatio(pr);
    if (state.markerMat) state.markerMat.size = 6 * pr;
    if (state.starMarker) state.starMarker.material.size = 9 * pr;
  }
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  if (state.orbitCam) {
    state.orbitCam.aspect = w / h;
    state.orbitCam.updateProjectionMatrix();
  }
  if (state.minimap && typeof state.minimap.resize === 'function') state.minimap.resize();
  // the phone bar's height keeps the edge arrow above it
  try { state.mbarPx = parseFloat(getComputedStyle(document.body).getPropertyValue('--mbar-h')) || 0; } catch (err) { state.mbarPx = 0; }
  ov.x = -1e9; ov.ex = -1e9;             // re-place the overlays for the new size
  if (!state.running && state.ship) renderFrame();
}

/* ---------------- dossier ---------------- */

function addRow(dl, label, value, note) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (note) {
    const n = document.createElement('span');
    n.className = 'd-note';
    n.textContent = note;
    dd.appendChild(n);
  }
  row.append(dt, dd);
  dl.appendChild(row);
}

/** MEASURED column for the star and system focus: catalogued values only; assumed ones go to starImaginedRows. */
function starMeasuredRows() {
  const host = state.host, star = state.system.star;
  const rows = [];
  if (host.spec) rows.push({ label: 'spectral type', value: host.spec, note: 'catalogued' });
  if (star.teff_src === 'measured') rows.push({ label: 'temperature', value: fmt(star.teff, 0) + ' K', note: 'measured' });
  else if (star.teff_src === 'from spectral type') rows.push({ label: 'temperature', value: fmt(star.teff, 0) + ' K', note: 'rough value from the spectral type; not in catalogue' });
  if (star.radius_src === 'measured') rows.push({ label: 'radius', value: fmt(star.radius_km / SUN_RADIUS_KM, 3) + ' solar radii', note: 'measured' });
  if (star.mass_src === 'measured') rows.push({ label: 'mass', value: fmt(star.mass_msun, 3) + ' solar masses', note: 'measured' });
  if (Number.isFinite(host.dist_pc)) {
    rows.push({ label: 'distance from Earth', value: fmt(host.dist_pc * PC_TO_LY, 1) + ' light-years', note: fmt(host.dist_pc, 1) + ' pc, catalogued' });
  } else {
    rows.push({ label: 'distance from Earth', value: 'not catalogued', note: 'sky drawn from the Sun' });
  }
  rows.push({ label: 'confirmed planets', value: String(state.bodies.length), note: 'catalogued' });
  return rows;
}

/** IMAGINED column for the star and system focus: assumed stellar values first, then the rendering choices. */
function starImaginedRows() {
  const star = state.system.star;
  const rows = [];
  if (star.teff_src === 'assumed') rows.push({ label: 'temperature', value: fmt(star.teff, 0) + ' K', note: 'assumed, not in catalogue' });
  if (star.radius_src === 'assumed') rows.push({ label: 'radius', value: fmt(star.radius_km / SUN_RADIUS_KM, 3) + ' solar radii', note: 'assumed, not in catalogue' });
  if (star.mass_src === 'assumed') rows.push({ label: 'mass', value: fmt(star.mass_msun, 3) + ' solar masses', note: 'assumed, not in catalogue' });
  const teffWord = star.teff_src === 'measured' ? '' : (star.teff_src === 'from spectral type' ? ' (from the spectral type)' : ' (assumed)');
  rows.push(
    { label: 'surface', value: 'limb darkening and a slow granulation pattern, imagined' },
    { label: 'colour', value: 'blackbody approximation from ' + fmt(star.teff, 0) + ' K' + teffWord },
    { label: 'glow', value: 'soft corona drawn at about 1.6 radii, imagined' },
    { label: 'activity', value: 'a few dark spots drawn on stars cooler than 6,000 K as a look; no flares or rotation drawn' },
    {
      label: 'size',
      value: star.radius_src === 'measured' ? 'true scale' : 'radius assumed (1 solar radius), size not to scale',
    },
  );
  return rows;
}

function starLineText() {
  const host = state.host, star = state.system.star;
  const parts = [];
  if (host.spec) parts.push(host.spec);
  parts.push(fmt(star.teff, 0) + ' K (' + srcNote(star.teff_src) + ')');
  parts.push(fmt(star.radius_km / SUN_RADIUS_KM, 3) + ' solar radii (' + srcNote(star.radius_src) + ')');
  parts.push(fmt(star.mass_msun, 3) + ' solar masses (' + srcNote(star.mass_src) + ')');
  if (Number.isFinite(host.dist_pc)) parts.push(fmt(host.dist_pc * PC_TO_LY, 1) + ' light-years from Earth');
  return parts.join(' · ');
}

function renderStarLine() {
  if (state.hud) return;             // the HUD writes the dossier head from setDossier
  if (el.dHost) el.dHost.textContent = state.host.name;
  if (el.dStar) el.dStar.textContent = starLineText();
}

/** Rows for the current focus: { title, measured, imagined }. */
function dossierRows() {
  const f = state.focus;
  if (f.mode !== 'planet') {
    const title = f.mode === 'star'
      ? 'focus: ' + state.host.name + ' (star)'
      : 'focus: whole system, ' + state.bodies.length + (state.bodies.length === 1 ? ' planet' : ' planets');
    const im = starImaginedRows();
    if (f.mode === 'system') {
      im.push({ label: 'orbits', value: 'all drawn in one plane; true inclinations and orientations are not shown' });
      im.push({ label: 'orbital phases', value: 'starting positions along each orbit are assumed, not catalogued' });
      im.push({ label: 'markers', value: 'gold dots mark planets too small to see at true scale' });
    }
    im.push(shipRow());
    return { title, measured: starMeasuredRows(), imagined: im };
  }

  const b = state.bodies[f.index];
  const p = b.planet;
  const title = 'focus: ' + p.name + ' · ' + p.cls + (p.method ? ' · ' + p.method + (p.year ? ' ' + p.year : '') : '');

  let measured = [];
  try { measured = describeMeasured(p, state.system.star) || []; } catch (err) { console.error(err); }
  if (!measured.length) measured = [{ label: 'catalogue', value: 'no rows returned' }];

  const im = (b.material && b.material.userData && b.material.userData.imagined) || {};
  const rows = [];
  let assumed = [];
  try { assumed = describeAssumed(p, state.system.star) || []; } catch (err) { console.error(err); }
  assumed.filter((r) => r.label !== 'rotation' && r.label !== 'orbit shape').forEach((r) => rows.push(r));
  if (im.surface) rows.push({ label: 'surface', value: im.surface });
  if (im.colours) rows.push({ label: 'colours', value: im.colours });
  if (im.atmosphere) rows.push({ label: 'atmosphere', value: im.atmosphere });
  if (im.clouds) rows.push({ label: 'clouds', value: im.clouds });
  Object.keys(im).forEach((k) => {
    if (!['surface', 'colours', 'atmosphere', 'clouds'].includes(k) && typeof im[k] === 'string') rows.push({ label: k, value: im[k] });
  });
  rows.push({
    label: 'atmosphere shown',
    value: b.atmosphereShown ? 'yes, rim glow' : 'no',
    note: 'rule: radius above 1.6 Earth radii or equilibrium temperature below 1,500 K',
  });
  if (b.atmosphereShown) rows.push({ label: 'rim colour', value: 'chosen from class and temperature (' + srgbCss(b.atmosphereColour) + ')' });
  rows.push({
    label: 'rotation',
    value: p.tidally_locked ? 'assumed tidally locked, one face toward the star' : 'assumed 24 h',
    note: p.tidally_locked ? 'rule: orbital period below 20 days' : 'spin period unknown',
  });
  const eSrc = p.e_src || 'assumed circular';
  rows.push({
    label: 'orbit',
    value: (eSrc === 'measured'
      ? 'eccentricity ' + fmt(p.e, 3) + ' measured'
      : 'circular assumed') + '; orientation unknown, drawn coplanar with periastron on +x',
  });
  rows.push({ label: 'orbital phase', value: 'starting position along the orbit assumed' });
  rows.push({
    label: 'lighting',
    value: 'star colour from ' + fmt(state.system.star.teff, 0) + ' K, softened toward white for display',
    note: 'the true tint of a ' + fmt(state.system.star.teff, 0) + ' K star is stronger',
  });
  rows.push({ label: 'size', value: 'true scale' + (p.radius_src && p.radius_src !== 'measured' ? ' (radius ' + p.radius_src + ')' : '') });
  rows.push({ label: 'rings, moons', value: 'none drawn, none known' });
  rows.push(shipRow());
  return { title, measured, imagined: rows };
}

/** The one thing in the scene that is not to scale: the ship, drawn at a display size. */
function shipRow() {
  const km = state.shipApi && Number.isFinite(state.shipApi.length_units) ? state.shipApi.length_units * KM_PER_UNIT : 60;
  return { label: 'the ship', value: 'not to scale: drawn about ' + fmt(km, 0) + ' km long so it can be seen next to a planet; the cockpit is a display too' };
}

function renderDossier() {
  const d = dossierRows();
  if (state.hud && typeof state.hud.setDossier === 'function') {
    state.hud.setDossier({
      hostLine: state.host.name,
      starLine: starLineText(),
      measured: d.measured,
      imagined: d.imagined,
      title: d.title,
    });
    return;
  }
  if (el.dFocus) el.dFocus.textContent = d.title;
  if (el.dMeasured) {
    el.dMeasured.replaceChildren();
    d.measured.forEach((r) => addRow(el.dMeasured, r.label, r.value, r.note));
  }
  if (el.dImagined) {
    el.dImagined.replaceChildren();
    d.imagined.forEach((r) => addRow(el.dImagined, r.label, r.value, r.note));
  }
}

/* ---------------- test hook ---------------- */

function installTestHook() {
  window.__system = {
    render() {
      step(0);
      renderFrame();
    },
    /** Advance the simulation by dt real seconds without rendering (tests, hidden tabs). */
    step(dt) {
      const d = Math.max(0, Math.min(0.1, Number(dt) || 0));
      state.realSeconds += d;
      step(d);
    },
    focus(name) {
      const f = resolveFocus(name);
      if (!f) throw new Error('no such body: ' + name);
      setFocus(f.mode, f.index, true);
    },
    setTime(seconds) {
      state.simSeconds = Number(seconds) || 0;
      positionBodies(state.simSeconds, 0);
      updateClock(true);
    },
    snapshot() {
      step(0);
      // twice: in a hidden tab the first readback after a scene change can be a frame stale
      renderFrame();
      renderFrame();
      return el.canvas.toDataURL('image/jpeg', 0.9);
    },
    mode() { return state.mode; },
    setMode,
    /** The view preference ('chase' | 'cockpit'); attract mode shows chase regardless (activeView). */
    view() { return state.view; },
    setView: (name) => setView(name, { quiet: true }),
    activeView,
    get shipModel() { return state.shipModel; },
    get cockpit() { return state.cockpit; },
    camera: state.camera,
    cameraState: cam,
    setHost: (name) => setHost(name, { arrival: true, immediate: false }),
    warpTo,
    autopilot: autopilotByName,
    /** Target a body by name ('star', 'b', 'WASP-96 b'), or null to clear; returns the target's name. */
    target(name) {
      if (name == null) { setTarget(null); return null; }
      const b = bodyByName(name);
      if (!b) throw new Error('no such body: ' + name);
      return setTarget(b).name;
    },
    targetName: () => (state.target ? state.target.name : null),
    cycleTarget,
    targetNearest,
    flyToTarget,
    openJump,
    closeJump: () => { if (state.jump) state.jump.close(); },
    jumpOpen: () => !!(state.jump && state.jump.isOpen()),
    /** Set the destination and engage the jump; resolves like warpTo. */
    jump: (name) => { setDestination(name); return warpTo(name); },
    setDestination,
    destination: () => state.pickedHost,
    overlay: ov,
    ship: state.ship,
    visited: () => Array.from(state.visited),
    resize,
    state,
    chooseInitialHost: (rnd) => chooseInitialHost(state.catalog, rnd),
    hostQualifies,
    curatedHosts: CURATED_HOSTS.slice(),
    introOpen: () => !!(el.intro && !el.intro.hidden),
    showIntro,
    hideIntro,
    constants: { KM_PER_UNIT, SUN_RADIUS_KM, AU_KM, EARTH_RADIUS_KM, JUP_RADIUS_KM, THROTTLE_STEPS },
  };
}

boot();
