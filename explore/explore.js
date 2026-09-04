/* ===================================================================
   /explore/ stage 1: the galaxy map.
   Scene units are parsecs in a galactocentric frame:
     origin = Galactic Centre, +x toward the Sun-to-centre direction
     reversed (i.e. the Sun sits at x = -r0), +y toward l = 90,
     +z toward the north galactic pole.
   Host star position = Sun position + heliocentric (x, y, z) from
   data/planets.json.
   =================================================================== */

const LY_PER_PC = 3.26156;
const RING_LY = [100, 1000, 10000];

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('map-stage'),
  canvas: $('map-canvas'),
  status: $('map-status'),
  labels: $('map-labels'),
  labelSun: $('label-sun'),
  labelRings: [$('label-ring-0'), $('label-ring-1'), $('label-ring-2')],
  marker: $('map-marker'),
  tooltip: $('map-tooltip'),
  ttHost: $('tt-host'),
  ttDist: $('tt-dist'),
  ttStar: $('tt-star'),
  ttCount: $('tt-count'),
  ttPlanets: $('tt-planets'),
  btnLocal: $('view-local'),
  btnGalaxy: $('view-galaxy'),
  roCount: $('ro-count'),
  roShown: $('ro-shown'),
  roHosts: $('ro-hosts'),
  roMedian: $('ro-median'),
  roP99: $('ro-p99'),
  roDate: $('ro-date'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function setStatus(text, isError) {
  el.status.textContent = text;
  el.status.hidden = !text;
  el.status.classList.toggle('error', !!isError);
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-GB');
}

function fmtLy(pc) {
  const ly = pc * LY_PER_PC;
  if (ly < 100) return ly.toFixed(1) + ' ly';
  return fmtInt(ly) + ' ly';
}

/* ---------------- colour from effective temperature ----------------
   Piecewise-linear approximation of a blackbody's apparent colour,
   tuned for a dark additive display. Missing temperature -> neutral. */
const TEFF_TABLE = [
  [2500, 1.00, 0.42, 0.16],
  [3000, 1.00, 0.55, 0.25],
  [4000, 1.00, 0.72, 0.45],
  [5000, 1.00, 0.88, 0.72],
  [5800, 1.00, 0.96, 0.88],
  [7000, 0.93, 0.95, 1.00],
  [10000, 0.72, 0.82, 1.00],
  [20000, 0.62, 0.72, 1.00],
];
function teffColor(teff, out, o) {
  if (!teff || !isFinite(teff)) { out[o] = 0.86; out[o + 1] = 0.87; out[o + 2] = 0.92; return; }
  const t = Math.max(TEFF_TABLE[0][0], Math.min(TEFF_TABLE[TEFF_TABLE.length - 1][0], teff));
  let i = 0;
  while (i < TEFF_TABLE.length - 2 && TEFF_TABLE[i + 1][0] < t) i++;
  const a = TEFF_TABLE[i], b = TEFF_TABLE[i + 1];
  const f = (t - a[0]) / (b[0] - a[0]);
  out[o] = a[1] + (b[1] - a[1]) * f;
  out[o + 1] = a[2] + (b[2] - a[2]) * f;
  out[o + 2] = a[3] + (b[3] - a[3]) * f;
}

/* ---------------- shaders ---------------- */
const POINT_VERT = `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aBright;
  uniform float uScale;
  uniform float uMinPx;
  uniform float uMaxPx;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = aSize * uScale / max(-mv.z, 1.0);
    gl_PointSize = clamp(px, uMinPx, uMaxPx);
    vColor = aColor;
    vBright = aBright;
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = `
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float core = 0.9 * exp(-d * d * 6.0);
    float halo = (1.0 - d) * 0.25;
    float a = (core + halo) * vBright;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

/* ---------------- main ---------------- */
async function main() {
  let THREE, OrbitControls;
  try {
    THREE = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  } catch (e) {
    setStatus('could not load the 3D library (three.js from unpkg). check the connection and reload.', true);
    return;
  }

  let planets, galaxy;
  try {
    const [pr, gr] = await Promise.all([fetch('data/planets.json'), fetch('data/galaxy.json')]);
    if (!pr.ok || !gr.ok) throw new Error('fetch failed');
    planets = await pr.json();
    galaxy = await gr.json();
  } catch (e) {
    setStatus('could not load the catalogue (data/planets.json).', true);
    return;
  }

  // render-loop flags (declared early: resize() and view setup touch them)
  let dirty = true;
  let pickNeeded = false;

  /* ---- catalogue -> hosts ---- */
  const F = {};
  planets.fields.forEach((k, i) => { F[k] = i; });
  const R0 = planets.meta.r0_pc;
  const SUN = { x: -R0, y: 0, z: 0 };

  const hostIndex = new Map();
  const hosts = [];
  const dists = [];
  let shown = 0;
  for (const row of planets.rows) {
    const d = row[F.dist_pc];
    if (d === null || d === undefined || !isFinite(d)) continue;
    shown++;
    dists.push(d);
    const name = row[F.host];
    let h = hostIndex.get(name);
    if (!h) {
      h = {
        name,
        dist: d,
        x: SUN.x + row[F.x], y: SUN.y + row[F.y], z: SUN.z + row[F.z],
        teff: row[F.st_teff], spec: row[F.st_spec],
        planets: [],
      };
      hostIndex.set(name, h);
      hosts.push(h);
    }
    h.planets.push(row[F.name]);
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];
  const p99 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.99))];

  el.roCount.textContent = fmtInt(planets.meta.count);
  el.roShown.textContent = fmtInt(shown);
  el.roHosts.textContent = fmtInt(hosts.length);
  el.roMedian.textContent = fmtLy(median) + ' (' + fmtInt(median) + ' pc)';
  el.roP99.textContent = fmtLy(p99);
  el.roDate.textContent = planets.meta.retrieved;

  /* ---- renderer ---- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    setStatus('WebGL is not available in this browser.', true);
    return;
  }
  let DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setClearColor(0x000000, 1); // the artwork's borders are pure black: no visible plane edge

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 400000);
  camera.up.set(0, 0, 1);

  const controls = new OrbitControls(camera, el.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 4;
  controls.maxDistance = 200000;
  controls.maxPolarAngle = Math.PI * 0.5 - 0.04;
  controls.screenSpacePanning = false;
  // phones: one finger scrolls the page, two fingers rotate and zoom the map
  el.canvas.style.touchAction = 'pan-y';
  controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
  // desktop: the wheel scrolls the page until the reader clicks into the map
  controls.enableZoom = false;
  el.canvas.addEventListener('pointerdown', () => { controls.enableZoom = true; });
  // a user gesture during a view tween takes over
  controls.addEventListener('start', () => { tween.active = false; });

  /* ---- backdrop: calibrated artwork in the z = 0 plane ----
     Pixel (px, py) -> world (pc):
       d = (px - cx, py - cy)
       world.x = P * (d . x_gal_dir_px),  world.y = P * (d . y_gal_dir_px)
     The PlaneGeometry maps pixel (px, py) to local
       ((px - W/2) * P, -(py - H/2) * P)   (texture flipY, image up = +local y)
     so the plane's rigid transform is
       linear      = A * diag(1, -1),   A = [[xdir_x, xdir_y], [ydir_x, ydir_y]]
       translation = -P * A * (c - c0),  c0 = (W/2, H/2)
     P is re-derived so that sun_px lands exactly r0 from centre_px. */
  const W = galaxy.px_w, H = galaxy.px_h;
  const cx = galaxy.centre_px[0], cy = galaxy.centre_px[1];
  const sunDx = galaxy.sun_px[0] - cx, sunDy = galaxy.sun_px[1] - cy;
  const sunPx = Math.hypot(sunDx, sunDy);
  let P = R0 / sunPx;
  if (Math.abs(P - galaxy.pc_per_px) / galaxy.pc_per_px > 0.002) P = galaxy.pc_per_px;
  const xd = galaxy.x_gal_dir_px, yd = galaxy.y_gal_dir_px;
  // linear part: A * diag(1,-1)
  const la = xd[0], lb = -xd[1];
  const lc = yd[0], ld = -yd[1];
  const det = la * ld - lb * lc;
  const ex = cx - W / 2, ey = cy - H / 2;
  const tx = -P * (xd[0] * ex + xd[1] * ey);
  const ty = -P * (yd[0] * ex + yd[1] * ey);
  // check: where does sun_px land?
  const sunWorldX = P * (sunDx * xd[0] + sunDy * xd[1]);
  const sunWorldY = P * (sunDx * yd[0] + sunDy * yd[1]);
  console.info('[explore] backdrop calibration: pc/px = ' + P.toFixed(4) + ' (file ' + galaxy.pc_per_px + '), det = ' + det +
    ', sun_px -> (' + sunWorldX.toFixed(2) + ', ' + sunWorldY.toFixed(2) + ') pc, Sun placed at (' + SUN.x + ', 0, 0)');

  const texLoader = new THREE.TextureLoader();
  const backdropMat = new THREE.MeshBasicMaterial({ color: 0xd8d8d8, side: THREE.DoubleSide, depthWrite: false });
  backdropMat.toneMapped = false;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(W * P, H * P), backdropMat);
  backdrop.matrixAutoUpdate = false;
  backdrop.matrix.set(
    la, lb, 0, tx,
    lc, ld, 0, ty,
    0, 0, 1, 0,
    0, 0, 0, 1
  );
  backdrop.renderOrder = 0;
  backdrop.visible = false;
  scene.add(backdrop);
  texLoader.load(galaxy.image, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    backdropMat.map = tex;
    backdropMat.needsUpdate = true;
    backdrop.visible = true;
    dirty = true;
  }, undefined, () => {
    // artwork missing: keep the points, note it quietly
    console.warn('[explore] backdrop image failed to load');
  });

  /* ---- host star cloud: one draw call ---- */
  const n = hosts.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const bright = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = hosts[i];
    pos[i * 3] = h.x; pos[i * 3 + 1] = h.y; pos[i * 3 + 2] = h.z;
    teffColor(h.teff, col, i * 3);
    // size in parsecs; nearby hosts drawn larger so the local bubble reads as dense
    size[i] = 3.0 * (1.0 + 2.2 / (1.0 + h.dist / 150.0));
    const multi = h.planets.length > 1;
    bright[i] = multi ? 1.0 : 0.72;
    if (multi) size[i] *= 1.15;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  cloudGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  cloudGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  cloudGeo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  cloudGeo.computeBoundingSphere();

  const pointUniforms = { uScale: { value: 1 }, uMinPx: { value: 1.6 * DPR }, uMaxPx: { value: 20 * DPR } };
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: pointUniforms,
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });
  const cloud = new THREE.Points(cloudGeo, cloudMat);
  cloud.frustumCulled = false;
  cloud.renderOrder = 2;
  scene.add(cloud);

  /* ---- the Sun ---- */
  const sunGeo = new THREE.BufferGeometry();
  sunGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([SUN.x, SUN.y, SUN.z]), 3));
  sunGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([245 / 255, 179 / 255, 36 / 255]), 3));
  sunGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array([16]), 1));
  sunGeo.setAttribute('aBright', new THREE.BufferAttribute(new Float32Array([1.6]), 1));
  const sunUniforms = { uScale: pointUniforms.uScale, uMinPx: { value: 5 * DPR }, uMaxPx: { value: 26 * DPR } };
  const sunMat = new THREE.ShaderMaterial({
    uniforms: sunUniforms,
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
  });
  const sun = new THREE.Points(sunGeo, sunMat);
  sun.frustumCulled = false;
  sun.renderOrder = 3;
  scene.add(sun);

  /* ---- scale rings, one LineSegments draw call ---- */
  const SEG = 256;
  const ringPos = new Float32Array(RING_LY.length * SEG * 2 * 3);
  const ringRadiiPc = RING_LY.map((ly) => ly / LY_PER_PC);
  {
    let k = 0;
    for (const r of ringRadiiPc) {
      for (let s = 0; s < SEG; s++) {
        const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
        ringPos[k++] = SUN.x + r * Math.cos(a0); ringPos[k++] = SUN.y + r * Math.sin(a0); ringPos[k++] = 0;
        ringPos[k++] = SUN.x + r * Math.cos(a1); ringPos[k++] = SUN.y + r * Math.sin(a1); ringPos[k++] = 0;
      }
    }
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
  const rings = new THREE.LineSegments(ringGeo, new THREE.LineBasicMaterial({
    color: 0xf5b324, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false,
  }));
  rings.frustumCulled = false;
  rings.renderOrder = 1;
  scene.add(rings);

  /* ---- view presets ---- */
  const VIEW_DIR = new THREE.Vector3(-0.34, 0, 1).normalize(); // slight tilt, screen-up toward the centre
  const fovTan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  function fitDistance(halfExtentPc) {
    const aspect = Math.max(0.4, camera.aspect || 1);
    return halfExtentPc * 1.08 / (fovTan * Math.min(1, aspect));
  }
  let currentView = 'local';
  let viewFitted = false; // becomes true once a preset has been applied at a real canvas size
  const VIEWS = {
    local: () => ({
      target: new THREE.Vector3(SUN.x, SUN.y, SUN.z),
      dist: fitDistance(4000 / LY_PER_PC / 2),
    }),
    galaxy: () => ({
      target: new THREE.Vector3(0, 0, 0),
      dist: fitDistance(Math.min(W, H) * P * 0.45), // the disc reaches about 90 percent of the half-width
    }),
  };

  const tween = { active: false, t0: 0, dur: 1600, a: null, b: null };
  const tmpDirA = new THREE.Vector3(), tmpDirB = new THREE.Vector3(), tmpDir = new THREE.Vector3(), tmpV = new THREE.Vector3();
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function applyView(v) {
    controls.target.copy(v.target);
    camera.position.copy(v.target).addScaledVector(VIEW_DIR, v.dist);
    camera.lookAt(v.target);
    controls.update();
    dirty = true;
  }

  function goToView(name, animate) {
    const v = VIEWS[name]();
    currentView = name;
    viewFitted = cssW > 2 && cssH > 2;
    el.btnLocal.classList.toggle('active', name === 'local');
    el.btnGalaxy.classList.toggle('active', name === 'galaxy');
    el.btnLocal.setAttribute('aria-pressed', String(name === 'local'));
    el.btnGalaxy.setAttribute('aria-pressed', String(name === 'galaxy'));
    if (!animate || reducedMotion.matches) { tween.active = false; applyView(v); return; }
    tween.a = {
      target: controls.target.clone(),
      dir: tmpV.copy(camera.position).sub(controls.target).normalize().clone(),
      dist: camera.position.distanceTo(controls.target),
    };
    tween.b = { target: v.target, dir: VIEW_DIR, dist: v.dist };
    tween.t0 = performance.now();
    tween.active = true;
  }

  function stepTween(now) {
    const u = Math.min(1, (now - tween.t0) / tween.dur);
    const s = easeInOut(u);
    tmpV.copy(tween.a.target).lerp(tween.b.target, s);
    controls.target.copy(tmpV);
    tmpDir.copy(tween.a.dir).lerp(tween.b.dir, s).normalize();
    const dist = Math.exp(Math.log(tween.a.dist) * (1 - s) + Math.log(tween.b.dist) * s);
    camera.position.copy(tmpV).addScaledVector(tmpDir, dist);
    camera.lookAt(tmpV);
    dirty = true;
    if (pointer.inside) pickNeeded = true;
    if (u >= 1) { tween.active = false; controls.update(); }
  }

  el.btnLocal.addEventListener('click', () => goToView('local', true));
  el.btnGalaxy.addEventListener('click', () => goToView('galaxy', true));

  /* ---- sizing ---- */
  let cssW = 1, cssH = 1;
  function resize() {
    const rect = el.canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.round(rect.width));
    cssH = Math.max(1, Math.round(rect.height));
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(DPR);
    pointUniforms.uMinPx.value = 1.6 * DPR;
    pointUniforms.uMaxPx.value = 20 * DPR;
    sunUniforms.uMinPx.value = 5 * DPR;
    sunUniforms.uMaxPx.value = 26 * DPR;
    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    pointUniforms.uScale.value = (cssH * DPR) / (2 * fovTan);
    dirty = true;
    pickNeeded = true;
    // first real size after a degenerate one (hidden tab, display:none): refit the preset
    if (!viewFitted && cssW > 2 && cssH > 2 && !tween.active) goToView(currentView, false);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(el.canvas);
  // re-run resize when the window moves to a display with another pixel ratio
  function watchDpr() {
    const mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
    mq.addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  }
  watchDpr();
  resize();
  goToView('local', false);

  /* ---- picking in screen space ---- */
  const pointer = { x: -1, y: -1, inside: false };
  let hovered = -1;
  let selected = -1;
  const viewProj = new THREE.Matrix4();

  function pick() {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = viewProj.elements;
    const rad = 11, rad2 = rad * rad;
    let best = -1, bestD = rad2, bestW = Infinity;
    const halfW = cssW * 0.5, halfH = cssH * 0.5;
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const sx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * halfW + halfW;
      const sy = -(e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * halfH + halfH;
      const dx = sx - pointer.x, dy = sy - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD || (d2 === bestD && cw < bestW)) { best = i; bestD = d2; bestW = cw; }
    }
    return best;
  }

  function showTooltip(i, px, py) {
    const h = hosts[i];
    el.ttHost.textContent = h.name;
    el.ttDist.textContent = fmtLy(h.dist) + ' · ' + (h.dist < 100 ? h.dist.toFixed(1) : fmtInt(h.dist)) + ' pc';
    const starBits = [];
    if (h.spec) starBits.push(h.spec);
    if (h.teff) starBits.push(fmtInt(h.teff) + ' K');
    el.ttStar.textContent = starBits.join(' · ');
    el.ttStar.hidden = starBits.length === 0;
    el.ttCount.textContent = h.planets.length + (h.planets.length === 1 ? ' planet' : ' planets');
    el.ttPlanets.textContent = '';
    const max = 6;
    h.planets.slice(0, max).forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p;
      el.ttPlanets.appendChild(li);
    });
    if (h.planets.length > max) {
      const li = document.createElement('li');
      li.className = 'more';
      li.textContent = '+' + (h.planets.length - max) + ' more';
      el.ttPlanets.appendChild(li);
    }
    el.tooltip.hidden = false;
    const tw = el.tooltip.offsetWidth, th = el.tooltip.offsetHeight;
    let lx = px + 16, ly = py + 12;
    if (lx + tw > cssW - 8) lx = px - tw - 12;
    lx = Math.max(8, lx);
    if (ly + th > cssH - 8) ly = Math.max(8, py - th - 8);
    el.tooltip.style.transform = 'translate(' + Math.round(lx) + 'px,' + Math.round(ly) + 'px)';
  }
  function hideTooltip() { el.tooltip.hidden = true; }

  const projV = new THREE.Vector3();
  // returns false when the point is behind the camera; writes screen px into out
  function projectToScreen(x, y, z, out) {
    projV.set(x, y, z).project(camera);
    if (projV.z > 1 || projV.z < -1) return false;
    out.x = (projV.x * 0.5 + 0.5) * cssW;
    out.y = (-projV.y * 0.5 + 0.5) * cssH;
    return true;
  }
  const scr = { x: 0, y: 0 };

  function placeLabel(node, x, y, z, dx, dy) {
    if (projectToScreen(x, y, z, scr) && scr.x > -40 && scr.x < cssW + 40 && scr.y > -20 && scr.y < cssH + 20) {
      node.style.transform = 'translate(' + Math.round(scr.x + dx) + 'px,' + Math.round(scr.y + dy) + 'px) translate(-50%,-50%)';
      node.style.visibility = 'visible';
    } else {
      node.style.visibility = 'hidden';
    }
  }

  function updateLabels() {
    placeLabel(el.labelSun, SUN.x, SUN.y, SUN.z, 0, -16);
    for (let r = 0; r < RING_LY.length; r++) {
      const rad = ringRadiiPc[r];
      // label at the ring's upper-left (toward the centre and l = 90)
      const lx = SUN.x + rad * 0.7071, ly = SUN.y + rad * 0.7071;
      // hide when the ring is too small on screen to be meaningful
      const okC = projectToScreen(SUN.x, SUN.y, 0, scr);
      const cx0 = scr.x, cy0 = scr.y;
      const okR = projectToScreen(SUN.x + rad, SUN.y, 0, scr);
      const pxRad = okC && okR ? Math.hypot(scr.x - cx0, scr.y - cy0) : 0;
      if (pxRad < 14) { el.labelRings[r].style.visibility = 'hidden'; continue; }
      placeLabel(el.labelRings[r], lx, ly, 0, -6, -8);
    }
    const mi = selected >= 0 ? selected : hovered;
    if (mi >= 0) {
      placeLabel(el.marker, pos[mi * 3], pos[mi * 3 + 1], pos[mi * 3 + 2], 0, 0);
    } else {
      el.marker.style.visibility = 'hidden';
    }
  }

  function setHover(i) {
    if (i === hovered) return;
    hovered = i;
    el.canvas.classList.toggle('hovering', i >= 0);
    dirty = true;
  }

  el.canvas.addEventListener('pointermove', (ev) => {
    const rect = el.canvas.getBoundingClientRect();
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
    pointer.inside = true;
    pickNeeded = true;
  });
  el.canvas.addEventListener('pointerleave', () => {
    pointer.inside = false;
    controls.enableZoom = false;
    setHover(-1);
    if (selected < 0) hideTooltip();
  });
  let downX = 0, downY = 0;
  el.canvas.addEventListener('pointerdown', (ev) => { downX = ev.clientX; downY = ev.clientY; });
  el.canvas.addEventListener('pointerup', (ev) => {
    if (ev.button !== 0) return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return; // a drag, not a click
    const rect = el.canvas.getBoundingClientRect();
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
    pointer.inside = true;
    const i = pick();
    selected = i;
    if (i >= 0) showTooltip(i, pointer.x, pointer.y); else hideTooltip();
    dirty = true;
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && selected >= 0) { selected = -1; hideTooltip(); dirty = true; }
  });
  controls.addEventListener('change', () => { dirty = true; if (pointer.inside) pickNeeded = true; });

  /* ---- render loop: only when visible, only when something changed ---- */
  let running = false;
  let rafId = 0;

  function frame(now) {
    rafId = 0;
    if (!running) return;
    if (tween.active) stepTween(now);
    else controls.update();
    if (pickNeeded) {
      pickNeeded = false;
      if (pointer.inside) {
        const i = pick();
        setHover(i);
        if (selected >= 0) {
          if (projectToScreen(pos[selected * 3], pos[selected * 3 + 1], pos[selected * 3 + 2], scr)) showTooltip(selected, scr.x, scr.y);
        } else if (i >= 0) {
          showTooltip(i, pointer.x, pointer.y);
        } else {
          hideTooltip();
        }
      }
    }
    if (dirty) {
      dirty = false;
      // the artwork is 20 pc/px: dim it when magnified so the points stay legible
      const camDist = camera.position.distanceTo(controls.target);
      const f = Math.min(1, Math.max(0, (Math.log(camDist) - Math.log(1500)) / (Math.log(40000) - Math.log(1500))));
      const lum = 0.3 + 0.6 * f;
      backdropMat.color.setRGB(lum, lum, lum, THREE.SRGBColorSpace);
      renderer.render(scene, camera);
      updateLabels();
      if (selected >= 0 && !pointer.inside) {
        if (projectToScreen(pos[selected * 3], pos[selected * 3 + 1], pos[selected * 3 + 2], scr)) showTooltip(selected, scr.x, scr.y);
        else hideTooltip();
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  function start() { if (!running) { running = true; dirty = true; if (!rafId) rafId = requestAnimationFrame(frame); } }
  function stop() { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  let onScreen = false;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) { onScreen = en.isIntersecting; }
    if (onScreen && !document.hidden) start(); else stop();
  }, { threshold: 0.02 });
  io.observe(el.stage);
  document.addEventListener('visibilitychange', () => { if (onScreen && !document.hidden) start(); else stop(); });

  setStatus('');
  start();

  // test hook: render a frame on demand and jump between views (used for capture checks)
  window.__explore = {
    render: () => { controls.update(); renderer.render(scene, camera); updateLabels(); },
    goToView: (name) => goToView(name, false),
    resize,
  };
}

main().catch((e) => {
  console.error(e);
  setStatus('the map failed to start: ' + (e && e.message ? e.message : 'unknown error'), true);
});
