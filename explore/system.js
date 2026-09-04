/* ===================================================================
   /explore/system.js : star system renderer (stage 2)

   One host star and its confirmed planets at true scale
   (1 scene unit = 1,000 km), lit by the star, under the real sky as
   seen from the host's position. Every rendering choice that is not
   backed by a catalogued number is reported in the dossier as imagined.
   =================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  KM_PER_UNIT, SUN_RADIUS_KM, AU_KM, EARTH_RADIUS_KM, JUP_RADIUS_KM,
  loadCatalog, deriveSystem, describeMeasured, describeAssumed, findHost,
} from './lib/catalog.js';
import { makePlanetMaterial, makeAtmosphere } from './lib/planet-shaders.js';
import { makeStar } from './lib/star.js';
import { loadSky, makeSky } from './lib/sky.js';

/* ---------------- constants ---------------- */

const BASE_URL = new URL('./', import.meta.url).href;
const DEFAULT_HOST = 'TRAPPIST-1';
const PC_TO_LY = 3.26156;
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

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('system-stage'),
  canvas: $('system-canvas'),
  status: $('sys-status'),
  clock: $('sys-clock'),
  pause: $('btn-pause'),
  timeButtons: Array.from(document.querySelectorAll('.t-btn[data-scale]')),
  btnStar: $('btn-star'),
  btnSystem: $('btn-system'),
  planetList: $('planet-list'),
  hint: $('sys-hint'),
  hostTitle: $('host-title'),
  dHost: $('d-host'),
  dStar: $('d-star'),
  dFocus: $('d-focus'),
  dMeasured: $('d-measured'),
  dImagined: $('d-imagined'),
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
    // planet-shaders.js: gas/neptune programs expose uColA (base band colour),
    // solid programs expose uColLow/uColHigh (lowland/highland); all linear THREE.Color
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
  // paletteFor returns sRGB-ish values; linearise roughly so rgbCss can encode them
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

/* ---------------- state ---------------- */

const state = {
  host: null, system: null,
  renderer: null, scene: null, camera: null, controls: null,
  sky: null, star: null, bodies: [], outerRadius: 1,
  simSeconds: 0, timeScale: 3600, paused: false,
  realSeconds: 0, lastFrame: 0, running: false, rafId: 0,
  visible: true,
  focus: { mode: 'system', index: -1 },
  tween: { active: false, t: 0, fromTarget: new THREE.Vector3(), fromDir: new THREE.Vector3(), toDir: new THREE.Vector3(), fromDist: 0, toDist: 0 },
  pixelRatio: 1,
};

// reusable temporaries: no per-frame allocation
const tmpV = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpDelta = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();

/* ---------------- boot ---------------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  const hostParam = (params.get('host') || DEFAULT_HOST).trim();

  let catalog, skyData;
  try {
    [catalog, skyData] = await Promise.all([loadCatalog(BASE_URL), loadSky(BASE_URL)]);
  } catch (err) {
    console.error(err);
    setStatus('could not load the catalogue: ' + (err && err.message ? err.message : err), true);
    return;
  }

  // exact host name, then case-insensitive, then a planet-name prefix
  // (the archive files Kepler-90 b..h under host KOI-351)
  const host = findHost(catalog, hostParam);
  if (!host) {
    setStatus('host "' + hostParam + '" is not in the catalogue', true);
    if (el.hostTitle) el.hostTitle.textContent = 'Unknown host';
    return;
  }

  state.host = host;
  state.system = deriveSystem(host);
  document.title = host.name + ' · System · Davide Staub';
  if (el.hostTitle) el.hostTitle.textContent = host.name;

  setStatus('building scene');
  try {
    buildScene(skyData);
  } catch (err) {
    console.error(err);
    setStatus('could not build the scene: ' + (err && err.message ? err.message : err), true);
    return;
  }

  buildHud();
  renderStarLine();
  setFocus('system', -1, true);
  hideStatus();
  installLoop();
  installTestHook();
}

/* ---------------- scene ---------------- */

function buildScene(skyData) {
  const { star, planets } = state.system;
  const host = state.host;

  const renderer = new THREE.WebGLRenderer({
    canvas: el.canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true,
  });
  state.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(state.pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 1);
  state.renderer = renderer;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  state.scene = scene;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
  camera.up.set(0, 0, 1);
  state.camera = camera;

  // sky at the host's heliocentric position (null -> the Sun's sky)
  const origin = (Number.isFinite(host.x) && Number.isFinite(host.y) && Number.isFinite(host.z))
    ? { x: host.x, y: host.y, z: host.z } : null;
  const sky = makeSky(THREE, skyData, origin);
  scene.add(sky);
  state.sky = sky;

  // the star at the origin
  const starRadiusUnits = star.radius_km / KM_PER_UNIT;
  const starObj = makeStar(THREE, { radius_units: starRadiusUnits, teff: star.teff, color: star.color });
  scene.add(starObj.group);
  if (starObj.light && !starObj.light.parent) scene.add(starObj.light);
  state.star = starObj;
  state.starRadiusUnits = starRadiusUnits;
  // light colour: the star's colour (linear), softened toward white so that a cool red
  // star does not paint every rock world as lava. Reported in the IMAGINED column.
  state.lightColor = new THREE.Color(star.color[0], star.color[1], star.color[2]);
  if (starObj.light && starObj.light.color) state.lightColor.copy(starObj.light.color);
  state.lightColor.lerp(new THREE.Color(1, 1, 1), LIGHT_SOFTEN);

  // screen-space marker for the star itself: a Sun-sized star is sub-pixel from a 1 AU system view
  const dotTex = makeDotTexture();
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

  // planets, orbits and markers
  const orbitMat = new THREE.LineBasicMaterial({ color: 0xF5B324, transparent: true, opacity: 0.32 });
  const markerMat = new THREE.PointsMaterial({
    color: 0xF5B324, size: 6 * state.pixelRatio, sizeAttenuation: false,
    map: dotTex, alphaTest: 0.05,
    transparent: true, opacity: 0.8, depthTest: false, depthWrite: false,
  });
  markerMat.toneMapped = false;

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

    // atmosphere rule: radius above 1.6 Earth radii, or equilibrium temperature below 1,500 K
    const showAtm = (p.radius_km > 1.6 * EARTH_RADIUS_KM) || (Number.isFinite(p.teq) && p.teq < 1500);
    let atmosphere = null;
    if (showAtm) {
      const atmColor = atmosphereColour(p);
      // makeAtmosphere scales the shell itself (ratio 1.045 by default): pass the planet radius
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

    // screen-space marker so a true-scale planet can be found from far away
    const markerGeom = new THREE.BufferGeometry();
    markerGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const marker = new THREE.Points(markerGeom, markerMat);
    marker.frustumCulled = false;
    marker.renderOrder = 5;
    scene.add(marker);

    const periodSeconds = Math.max(1, p.period_days) * DAY_S;
    const body = {
      planet: p, mesh, material, atmosphere, orbit, marker,
      radiusUnits: rUnits, aUnits, e, seed,
      periodSeconds,
      meanAnomaly0: seed * TAU,            // starting phase: not in the catalogue, assumed
      rotationSeconds: Math.max(1, p.rotation_hours) * 3600,
      swatch: dominantColour(material, p),
      atmosphereShown: showAtm,
      atmosphereColour: showAtm ? atmosphereColour(p) : null,
    };
    bodies.push(body);
    outer = Math.max(outer, aUnits * (1 + e) + rUnits);
  }
  state.bodies = bodies;
  state.outerRadius = outer;

  // controls
  const controls = new OrbitControls(camera, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  controls.screenSpacePanning = true;
  controls.maxDistance = 5e8;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  state.controls = controls;

  // size the renderer first so the system fit uses the real aspect ratio
  resize();

  // initial camera: above the plane, looking at the whole system
  const d0 = systemDistance();
  camera.position.set(0, -0.72 * d0, 0.69 * d0);
  controls.target.set(0, 0, 0);
  controls.update();

  positionBodies(0);
}

function systemDistance() {
  const aspect = state.camera ? state.camera.aspect : 1.6;
  const half = THREE.MathUtils.degToRad(state.camera ? state.camera.fov / 2 : 22.5);
  const fit = state.outerRadius / Math.tan(half);
  return fit * (aspect < 1 ? 1.15 / aspect : 1.15);
}

/* ---------------- HUD ---------------- */

function buildHud() {
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

  el.btnStar.addEventListener('click', () => setFocus('star', -1));
  el.btnSystem.addEventListener('click', () => setFocus('system', -1));

  el.timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => setTimeScale(Number(btn.dataset.scale)));
  });
  el.pause.addEventListener('click', () => setPaused(!state.paused));
  updateClock();
}

function setTimeScale(scale) {
  state.timeScale = scale;
  el.timeButtons.forEach((btn) => {
    const on = Number(btn.dataset.scale) === scale;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setPaused(paused) {
  state.paused = paused;
  el.pause.classList.toggle('active', paused);
  el.pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
  el.pause.textContent = paused ? 'resume' : 'pause';
}

let lastClockText = '';
let lastClockAt = -1;
function updateClock(force) {
  // the clock text is rebuilt at most four times a second
  if (!force && state.realSeconds - lastClockAt < 0.25) return;
  lastClockAt = state.realSeconds;
  const text = 'elapsed: ' + fmtElapsed(state.simSeconds);
  if (text !== lastClockText) { el.clock.textContent = text; lastClockText = text; }
}

/* ---------------- focus ---------------- */

function focusButtons() {
  return [el.btnStar, el.btnSystem, ...el.planetList.querySelectorAll('.f-planet')];
}

function setFocus(mode, index, immediate) {
  const f = state.focus;
  f.mode = mode;
  f.index = mode === 'planet' ? index : -1;

  let dist, minDist;
  if (mode === 'planet') {
    const b = state.bodies[index];
    dist = Math.max(b.radiusUnits * 6, 0.05);
    minDist = b.radiusUnits * 1.4;
  } else if (mode === 'star') {
    dist = state.starRadiusUnits * 8;
    minDist = state.starRadiusUnits * 1.3;
  } else {
    dist = systemDistance();
    minDist = state.starRadiusUnits * 1.3;
  }
  state.controls.minDistance = minDist;

  focusTargetPosition(tmpTarget);
  const tw = state.tween;
  // current viewing direction (target -> camera)
  tmpDir.subVectors(state.camera.position, state.controls.target);
  if (tmpDir.lengthSq() < 1e-12) tmpDir.set(0, -0.72, 0.69);
  tmpDir.normalize();
  tw.fromDir.copy(tmpDir);
  // where to look from: for a planet, round from the star direction so the
  // terminator is in view; for the star and the whole system, keep the current direction
  if (mode === 'planet') focusDirection(state.bodies[index], tw.toDir);
  else tw.toDir.copy(tmpDir);
  if (immediate) {
    tw.active = false;
    state.controls.target.copy(tmpTarget);
    state.camera.position.copy(tmpTarget).addScaledVector(tw.toDir, dist);
  } else {
    tw.active = true;
    tw.t = 0;
    tw.fromTarget.copy(state.controls.target);
    tw.fromDist = state.camera.position.distanceTo(state.controls.target);
    tw.toDist = dist;
  }

  focusButtons().forEach((btn) => {
    const on = (btn.dataset.focus === mode) || (mode === 'planet' && Number(btn.dataset.index) === index);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  renderDossier();
}

/** Unit vector from a planet toward a good viewpoint: rotated FOCUS_AZIMUTH round from the
    star direction in the orbital plane, lifted above the plane. */
function focusDirection(body, out) {
  const px = body.mesh.position.x, py = body.mesh.position.y;
  let ang = Math.atan2(-py, -px);                 // direction planet -> star (star at the origin)
  if (!Number.isFinite(ang)) ang = 0;
  ang += FOCUS_AZIMUTH;
  out.set(Math.cos(ang), Math.sin(ang), FOCUS_ELEVATION).normalize();
  return out;
}

function focusTargetPosition(out) {
  const f = state.focus;
  if (f.mode === 'planet') out.copy(state.bodies[f.index].mesh.position);
  else out.set(0, 0, 0);
  return out;
}

function updateFocus(dt) {
  const cam = state.camera, controls = state.controls, tw = state.tween;
  focusTargetPosition(tmpTarget);
  if (tw.active) {
    tw.t = Math.min(1, tw.t + dt / TWEEN_SECONDS);
    const s = 1 - Math.pow(1 - tw.t, 3);           // ease out cubic
    tmpDir.lerpVectors(tw.fromDir, tw.toDir, s);
    if (tmpDir.lengthSq() < 1e-12) tmpDir.copy(tw.toDir);
    tmpDir.normalize();
    tmpV.lerpVectors(tw.fromTarget, tmpTarget, s);
    const d = tw.fromDist + (tw.toDist - tw.fromDist) * s;
    controls.target.copy(tmpV);
    cam.position.copy(tmpV).addScaledVector(tmpDir, d);
    if (tw.t >= 1) tw.active = false;
  } else {
    // the focused body moves: carry the camera along with it, keeping the user's offset
    tmpDelta.subVectors(tmpTarget, controls.target);
    if (tmpDelta.lengthSq() > 0) {
      controls.target.copy(tmpTarget);
      cam.position.add(tmpDelta);
    }
  }
}

/* ---------------- simulation ---------------- */

function positionBodies(simSeconds) {
  const bodies = state.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const M = b.meanAnomaly0 + TAU * (simSeconds / b.periodSeconds);
    const E = solveKepler(M, b.e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const x = b.aUnits * (cosE - b.e);
    const y = b.aUnits * Math.sqrt(1 - b.e * b.e) * sinE;
    b.mesh.position.set(x, y, 0);

    // spin is about the local y axis (the sphere's poles), which the 90 degree
    // x tilt set at build time maps to world +z; the local +x meridian then
    // points at world azimuth = rotation.y
    if (b.planet.tidally_locked) {
      // same face toward the star: spin follows the true anomaly
      b.mesh.rotation.y = Math.atan2(y, x) + Math.PI;
    } else {
      b.mesh.rotation.y = TAU * (simSeconds / b.rotationSeconds);
    }
  }
}

function updateLighting(realSeconds) {
  const bodies = state.bodies;
  const lc = state.lightColor;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    tmpDir.copy(b.mesh.position).negate();
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
    const dist = cam.position.distanceTo(b.mesh.position);
    const apparentPx = (b.radiusUnits / Math.max(dist, 1e-6)) * pxPerUnitAtOne * 2;
    b.marker.visible = apparentPx < MARKER_HIDE_PX;
    if (b.marker.visible) b.marker.position.copy(b.mesh.position);
  }
  const starDist = cam.position.length();
  const starPx = (state.starRadiusUnits / Math.max(starDist, 1e-6)) * pxPerUnitAtOne * 2;
  state.starMarker.visible = starPx < MARKER_HIDE_PX;
}

function step(dt) {
  if (!state.paused) state.simSeconds += dt * state.timeScale;
  positionBodies(state.simSeconds);
  updateLighting(state.realSeconds);
  if (state.star && typeof state.star.update === 'function') state.star.update(state.realSeconds);
  updateFocus(dt);
  state.controls.update();
  state.sky.update(state.camera.position);
  updateMarkers();
  updateClock();
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
    // not laid out yet (hidden tab, display none): fall back to the stage or the viewport
    w = el.stage.clientWidth || window.innerWidth || 1280;
    h = el.stage.clientHeight || Math.round(window.innerHeight * 0.78) || 720;
  }
  const pr = Math.min(2, window.devicePixelRatio || 1);
  if (pr !== state.pixelRatio) {
    state.pixelRatio = pr;
    state.renderer.setPixelRatio(pr);
    if (state.sky && state.sky.setPixelRatio) state.sky.setPixelRatio(pr);
    state.bodies.forEach((b) => { b.marker.material.size = 6 * pr; });
    if (state.starMarker) state.starMarker.material.size = 9 * pr;
  }
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  if (!state.running) renderFrame();
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

function starMeasuredRows() {
  const host = state.host, star = state.system.star;
  const rows = [];
  if (host.spec) rows.push({ label: 'spectral type', value: host.spec, note: 'catalogued' });
  rows.push({ label: 'temperature', value: fmt(star.teff, 0) + ' K', note: srcNote(star.teff_src) });
  rows.push({ label: 'radius', value: fmt(star.radius_km / SUN_RADIUS_KM, 3) + ' solar radii', note: srcNote(star.radius_src) });
  rows.push({ label: 'mass', value: fmt(star.mass_msun, 3) + ' solar masses', note: srcNote(star.mass_src) });
  if (Number.isFinite(host.dist_pc)) {
    rows.push({ label: 'distance from Earth', value: fmt(host.dist_pc * PC_TO_LY, 1) + ' light-years', note: fmt(host.dist_pc, 1) + ' pc, catalogued' });
  } else {
    rows.push({ label: 'distance from Earth', value: 'not catalogued', note: 'sky drawn from the Sun' });
  }
  rows.push({ label: 'confirmed planets', value: String(state.bodies.length), note: 'catalogued' });
  return rows;
}

function starImaginedRows() {
  return [
    { label: 'surface', value: 'limb darkening and a slow granulation pattern, imagined' },
    { label: 'colour', value: 'blackbody approximation from ' + fmt(state.system.star.teff, 0) + ' K' },
    { label: 'glow', value: 'soft corona drawn at about 1.6 radii, imagined' },
    { label: 'activity', value: 'no spots, flares or rotation drawn' },
    { label: 'size', value: 'true scale' },
  ];
}

function renderStarLine() {
  const host = state.host, star = state.system.star;
  el.dHost.textContent = host.name;
  const parts = [];
  if (host.spec) parts.push(host.spec);
  parts.push(fmt(star.teff, 0) + ' K (' + srcNote(star.teff_src) + ')');
  parts.push(fmt(star.radius_km / SUN_RADIUS_KM, 3) + ' solar radii (' + srcNote(star.radius_src) + ')');
  parts.push(fmt(star.mass_msun, 3) + ' solar masses (' + srcNote(star.mass_src) + ')');
  if (Number.isFinite(host.dist_pc)) parts.push(fmt(host.dist_pc * PC_TO_LY, 1) + ' light-years from Earth');
  el.dStar.textContent = parts.join(' · ');
}

function renderDossier() {
  const f = state.focus;
  el.dMeasured.replaceChildren();
  el.dImagined.replaceChildren();

  if (f.mode !== 'planet') {
    el.dFocus.textContent = f.mode === 'star'
      ? 'focus: ' + state.host.name + ' (star)'
      : 'focus: whole system, ' + state.bodies.length + (state.bodies.length === 1 ? ' planet' : ' planets');
    starMeasuredRows().forEach((r) => addRow(el.dMeasured, r.label, r.value, r.note));
    const im = starImaginedRows();
    if (f.mode === 'system') {
      im.push({ label: 'orbits', value: 'all drawn in one plane; true inclinations and orientations are not shown' });
      im.push({ label: 'orbital phases', value: 'starting positions along each orbit are assumed, not catalogued' });
      im.push({ label: 'markers', value: 'gold dots mark planets too small to see at true scale' });
    }
    im.forEach((r) => addRow(el.dImagined, r.label, r.value, r.note));
    return;
  }

  const b = state.bodies[f.index];
  const p = b.planet;
  el.dFocus.textContent = 'focus: ' + p.name + ' · ' + p.cls + (p.method ? ' · ' + p.method + (p.year ? ' ' + p.year : '') : '');

  let measured = [];
  try { measured = describeMeasured(p, state.system.star) || []; } catch (err) { console.error(err); }
  if (!measured.length) measured = [{ label: 'catalogue', value: 'no rows returned' }];
  measured.forEach((r) => addRow(el.dMeasured, r.label, r.value, r.note));

  const im = (b.material && b.material.userData && b.material.userData.imagined) || {};
  const rows = [];
  // assumptions made by the catalogue module (assumed star values, assumed radius,
  // orbit or period, teq from assumed inputs); rotation and orbit shape are
  // reported by the page below with the rendering rule attached
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
  rows.forEach((r) => addRow(el.dImagined, r.label, r.value, r.note));
}

/* ---------------- test hook ---------------- */

function installTestHook() {
  window.__system = {
    render() {
      step(0);
      renderFrame();
    },
    focus(name) {
      const key = String(name || '').trim().toLowerCase();
      if (key === 'star') return setFocus('star', -1, true);
      if (key === 'system' || key === '') return setFocus('system', -1, true);
      let idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase() === key);
      if (idx < 0) idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase().endsWith(' ' + key));
      if (idx < 0) idx = state.bodies.findIndex((b) => b.planet.name.toLowerCase().includes(key));
      if (idx < 0) throw new Error('no such body: ' + name);
      setFocus('planet', idx, true);
    },
    setTime(seconds) {
      state.simSeconds = Number(seconds) || 0;
      positionBodies(state.simSeconds);
      updateClock(true);
    },
    snapshot() {
      step(0);
      renderFrame();
      return el.canvas.toDataURL('image/jpeg', 0.9);
    },
    resize,
    state,
    constants: { KM_PER_UNIT, SUN_RADIUS_KM, AU_KM, EARTH_RADIUS_KM, JUP_RADIUS_KM },
  };
}

boot();
