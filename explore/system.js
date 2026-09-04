/* ===================================================================
   /explore/system.js : star system renderer and ship (stage 3)

   One host star and its confirmed planets at true scale
   (1 scene unit = 1,000 km), lit by the star, under the real sky as
   seen from the host's position. Every rendering choice that is not
   backed by a catalogued number is reported in the dossier as imagined.

   Floating origin: the camera never leaves the scene origin. The ship
   keeps its true position in doubles (ship.pos) and every frame each
   body, orbit line and the star group is placed at (body - ship), so
   there is no Float32 jitter a million units from the star.

   Modes
     attract  the camera orbits the focused body (OrbitControls driven
              on a hidden camera in a frame centred on the focus; the
              ship's position and orientation are derived from it)
     flight   the ship module drives position and orientation
     warp     frozen while the warp effect plays and the system swaps
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
import { createShip, THROTTLE_STEPS } from './lib/ship.js';

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
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  pickedHost: null,
  pixelRatio: 1,
  noLock: false,        // ?flight=1: fly without pointer lock
};

/** Per-frame HUD state object, mutated in place. */
const hudState = {
  speedKms: 0, speedC: 0, throttleLevel: 0,
  targetName: null, distToTargetKm: null,
  hostName: '', distFromEarthLy: null,
  systemsVisited: 0, totalSystems: 0,
  autopilot: false, timeScaleLabel: '', mode: 'attract',
  hudAt: -1,           // real seconds of the last HUD push (not part of the HUD contract)
};

// reusable temporaries: no per-frame allocation
const tmpDir = new THREE.Vector3();
const tmpD = { x: 0, y: 0, z: 0 };     // double-precision scratch point

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
  const [hudMod, minimapMod, warpMod, galaxy] = await Promise.all([
    optionalImport('./lib/hud.js'),
    optionalImport('./lib/minimap.js'),
    optionalImport('./lib/warp.js'),
    optionalJson(BASE_URL + 'data/galaxy.json'),
  ]);
  state.galaxy = galaxy;

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
    buildChrome(hudMod, minimapMod, warpMod);
    await setHost(host.name, { immediate: true, arrival: false });
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

  // the rendering camera: always at the origin, orientation from the ship
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 0);
  state.camera = camera;

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

/** Controls that live for the whole page: time presets, star/system buttons, the cockpit modules. */
function buildChrome(hudMod, minimapMod, warpMod) {
  // cockpit HUD (owns the buttons inside #cockpit and fires callbacks)
  const root = el.cockpit || el.stage;
  if (hudMod && typeof hudMod.createHud === 'function' && root) {
    try {
      state.hud = hudMod.createHud(root, {
        onTakeControls: () => setMode('flight'),
        onRelease: () => setMode('attract'),
        onFocus: (name) => focusByName(name, false),
        onAutopilot: (name) => autopilotByName(name),
        onWarp: (name) => warpTo(name || state.pickedHost),
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
        state.pickedHost = name;
        if (state.hud && typeof state.hud.setPickedHost === 'function') state.hud.setPickedHost(name);
        else toast('selected: ' + name);
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

  // keyboard: Enter warps to the picked host (H and M are handled by the HUD)
  window.addEventListener('keydown', onPageKey);

  if (state.hud) {
    state.hud.setVisited(state.visited.size, totalSystems());
    state.hud.setMode('attract');
  }
  updateClock(true);
}

function onPageKey(e) {
  if (state.mode !== 'flight') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (state.pickedHost) warpTo(state.pickedHost);
  }
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
    if (el.hint) el.hint.textContent = 'mouse looks · W/S throttle · Q/E roll · shift boost · space brake · Esc releases the controls';
    toast('you have the controls · Esc releases them · H for help');
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
}

/* ---------------- autopilot, discovery, warp ---------------- */

function autopilotByName(name) {
  if (state.mode === 'warp' || state.building) { toast('wait for the warp to finish'); return false; }
  const f = resolveFocus(name);
  if (!f || f.mode === 'system') { toast('pick a body first'); return false; }
  const body = f.mode === 'star' ? state.shipBodies[0] : state.shipBodies[f.index + 1];
  if (!body) return false;
  if (state.mode !== 'flight') setMode('flight');
  setFocus(f.mode, f.index, true);
  state.ship.autopilotTo(body, { stopRadii: 4 });
  toast('autopilot: ' + body.name);
  return true;
}

function onShipArrive(body) {
  toast('arrived: ' + body.name);
  if (body.kind === 'planet') markVisited(state.host.name);
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
  const keepFlying = prevMode === 'flight' && state.ship.enabled;
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
      // the destination is no longer a pick target
      if (state.pickedHost === host.name) {
        state.pickedHost = null;
        if (state.hud && typeof state.hud.setPickedHost === 'function') state.hud.setPickedHost(null);
        if (state.minimap && typeof state.minimap.setPicked === 'function') state.minimap.setPicked(null);
      }
    }
  } finally {
    // whatever happened, never leave the page in warp mode: every recovering control is hidden there
    if (typeof state.ship.resetInputs === 'function') state.ship.resetInputs();
    state.mode = 'none';   // force the transition
    setMode(keepFlying ? 'flight' : 'attract');
  }
  if (!arrived) return false;
  const yrs = fmt(distanceLy, 1);
  const light = distanceLy == null ? '' : ' · light takes ' + yrs + (yrs === '1' ? ' year' : ' years');
  toast('arrived at ' + host.name + light, 4000);
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
  const ship = state.ship, f = state.focus, host = state.host;
  hudState.speedKms = ship.speedKms();
  hudState.speedC = hudState.speedKms / 299792.458;
  hudState.throttleLevel = ship.throttleLevel();
  hudState.mode = state.mode;
  if (f.mode === 'planet') {
    const b = state.bodies[f.index];
    hudState.targetName = b.planet.name;
    const d = Math.hypot(ship.pos.x - b.world.x, ship.pos.y - b.world.y, ship.pos.z - b.world.z);
    hudState.distToTargetKm = Math.max(0, d - b.radiusUnits) * KM_PER_UNIT;
  } else if (f.mode === 'star') {
    hudState.targetName = host.name;
    const d = Math.hypot(ship.pos.x, ship.pos.y, ship.pos.z);
    hudState.distToTargetKm = Math.max(0, d - state.starRadiusUnits) * KM_PER_UNIT;
  } else {
    hudState.targetName = null;
    hudState.distToTargetKm = Math.hypot(ship.pos.x, ship.pos.y, ship.pos.z) * KM_PER_UNIT;
  }
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
  state.camera.position.set(0, 0, 0);
  state.camera.quaternion.copy(state.ship.quat);
  placeRelative();
  updateLighting(state.realSeconds);
  if (state.star && typeof state.star.update === 'function') state.star.update(state.realSeconds);
  if (state.sky) state.sky.update(state.camera.position);
  updateMarkers();
  updateClock();
  updateHud(dt === 0);
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
  return { title, measured, imagined: rows };
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
    setHost: (name) => setHost(name, { arrival: true, immediate: false }),
    warpTo,
    autopilot: autopilotByName,
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
