/* ===================================================================
   /explore/lib/cockpit.js : the procedural cockpit interior

   makeCockpit(THREE, opts?) -> { group, update(state), redraw(), dispose() }

   A camera-relative interior: the page keeps `group` at the rendering
   camera's position and orientation every frame (the same trick the
   warp streaks use), so the pilot sits behind it whatever the ship does.
   Built in camera space: x right, y up, the view along -z, sized for a
   45 degree vertical field of view with the dashboard 0.03 to 0.06
   scene units ahead (30 to 60 km at 1 unit = 1,000 km: a display size,
   like the ship itself).

   Parts: a dashboard face leaning back under a glare shield across the
   bottom third of the frame, two thin canopy struts in the upper
   corners, and three instrument screens on the face. The centre of the
   view is open. Brushed graphite, hairline gold edges, mono text in gold
   and cyan on near-black. The screens sit in a row on wide frames (the row
   shrinks as one on a 4:3 frame) and in two rows on portrait phones, from
   the aspect the page passes in. They are CanvasTextures redrawn at 4 Hz,
   and only when something on them changed, from the state passed to update():

     { now, aspect, targetName, targetSub, aligned, autopilot, boosting,
       speedKms, speedC, throttleLevel, hostName, distFromEarthLy,
       destination, destinationLy }

   Nothing here invents a number: every value on a screen comes from the
   page's HUD state, formatted the way the DOM HUD formats it.

   This module does NOT import three; the page passes THREE in.
   =================================================================== */

const GOLD = '#F5B324';
const CYAN = '#35D6FF';
const INK = '#D9DDE8';
const FAINT = 'rgba(217, 221, 232, 0.42)';
const SCREEN_BG = '#05070d';
const FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const REDRAW_S = 0.25;               // 4 Hz
const C_KMS = 299792.458;
const LY_KM = 9.4607e12;
const AU_KM = 149597870.7;

/* ---------------- formatting (mirrors hud.js) ---------------- */

function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  if (abs >= 100) return n.toLocaleString('en-GB', { maximumFractionDigits: Math.min(digits, 1) });
  return n.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function fmtSpeedKms(kms) {
  if (!Number.isFinite(kms)) return '0';
  const abs = Math.abs(kms);
  if (abs < 0.005) return '0';
  if (abs < 10) return kms.toLocaleString('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (abs < 1000) return kms.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return kms.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

function fmtSpeedC(c) {
  if (!Number.isFinite(c) || c < 0.001) return '';
  if (c >= 100) return fmt(c, 0) + ' c';
  if (c >= 1) return fmt(c, 2) + ' c';
  return c.toLocaleString('en-GB', { maximumFractionDigits: 3, minimumFractionDigits: 3 }) + ' c';
}

function fmtDistance(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1e6) return fmt(km, 0) + ' km';
  if (km < 1e9) return fmt(km / 1e6, km < 1e7 ? 2 : 1) + ' million km';
  const ly = km / LY_KM;
  if (ly >= 0.05) return fmt(ly, 2) + ' ly';
  const au = km / AU_KM;
  return fmt(au, au < 10 ? 2 : 1) + ' AU';
}

/* ---------------- textures ---------------- */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Brushed metal: fine horizontal streaks; one canvas serves as albedo variation and roughness. */
function makeBrushedMaps(THREE) {
  const W = 512, H = 256;
  const alb = makeCanvas(W, H), rgh = makeCanvas(W, H);
  const ca = alb.getContext('2d'), cr = rgh.getContext('2d');
  ca.fillStyle = '#2a2e37'; ca.fillRect(0, 0, W, H);
  cr.fillStyle = 'rgb(140,140,140)'; cr.fillRect(0, 0, W, H);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2600; i++) {
    const y = rnd() * H, x = rnd() * W, len = 40 + rnd() * 220;
    const a = 0.02 + rnd() * 0.045;
    ca.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,' + a.toFixed(3) + ')' : 'rgba(0,0,0,' + (a * 1.4).toFixed(3) + ')';
    ca.lineWidth = 1;
    ca.beginPath(); ca.moveTo(x, y + 0.5); ca.lineTo(x + len, y + 0.5); ca.stroke();
    const g = 120 + Math.round((rnd() - 0.5) * 60);
    cr.strokeStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
    cr.lineWidth = 1;
    cr.beginPath(); cr.moveTo(x, y + 0.5); cr.lineTo(x + len, y + 0.5); cr.stroke();
  }
  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(alb, true), roughnessMap: mk(rgh, false) };
}

/* ---------------- screens ---------------- */

const SCREEN_W = 512, SCREEN_H = 224;

function makeScreen(THREE, width, height) {
  const canvas = makeCanvas(SCREEN_W, SCREEN_H);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
  return { canvas, ctx, tex, mat, mesh };
}

/** Shrink the font until the text fits the width. Returns the font size used. */
function fitText(ctx, text, maxWidth, size, minSize) {
  let s = size;
  ctx.font = '500 ' + s + 'px ' + FONT;
  while (s > minSize && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = '500 ' + s + 'px ' + FONT;
  }
  return s;
}

function screenBase(ctx, title, tag, tagColor) {
  ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
  ctx.fillStyle = SCREEN_BG;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // a faint vignette so the panel reads as glass, not a flat rectangle
  const g = ctx.createRadialGradient(SCREEN_W * 0.5, SCREEN_H * 0.4, 40, SCREEN_W * 0.5, SCREEN_H * 0.5, SCREEN_W * 0.7);
  g.addColorStop(0, 'rgba(53, 214, 255, 0.035)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // the gold hairline along the top, a short bright run at the left
  ctx.fillStyle = 'rgba(245, 179, 36, 0.35)';
  ctx.fillRect(0, 0, SCREEN_W, 2);
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, 0, 44, 2);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
  ctx.font = '400 15px ' + FONT;
  ctx.fillStyle = 'rgba(245, 179, 36, 0.78)';
  ctx.fillText(title.toUpperCase(), 24, 38);
  if (tag) {
    ctx.textAlign = 'right';
    ctx.fillStyle = tagColor || CYAN;
    ctx.fillText(tag.toUpperCase(), SCREEN_W - 24, 38);
    ctx.textAlign = 'left';
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

function drawTarget(scr, s) {
  const ctx = scr.ctx;
  const name = s.targetName || '';
  screenBase(ctx, 'target', s.autopilot ? 'autopilot' : (s.aligned && name ? 'aligned' : ''), s.autopilot ? CYAN : GOLD);
  if (!name) {
    ctx.font = '500 30px ' + FONT;
    ctx.fillStyle = FAINT;
    ctx.fillText('none', 24, 104);
    ctx.font = '400 17px ' + FONT;
    ctx.fillText('T targets the next body', 24, 150);
    scr.tex.needsUpdate = true;
    return;
  }
  fitText(ctx, name, SCREEN_W - 48, 38, 20);
  ctx.fillStyle = s.autopilot ? CYAN : GOLD;
  ctx.fillText(name, 24, 104);
  // the bracket's line: 'distance · time at this speed' or 'autopilot · arriving in N s'
  const parts = String(s.targetSub || '').split(' · ');
  ctx.font = '500 22px ' + FONT;
  ctx.fillStyle = CYAN;
  const d = parts[0] || (Number.isFinite(s.targetDistKm) ? fmtDistance(s.targetDistKm) : '');
  ctx.fillText(d, 24, 150);
  if (parts[1]) {
    ctx.font = '400 17px ' + FONT;
    ctx.fillStyle = FAINT;
    fitText(ctx, parts[1], SCREEN_W - 48, 17, 12);
    ctx.fillText(parts[1], 24, 186);
  }
  scr.tex.needsUpdate = true;
}

function drawSpeed(scr, s) {
  const ctx = scr.ctx;
  const kms = Number(s.speedKms);
  const c = Number.isFinite(s.speedC) ? s.speedC : (Number.isFinite(kms) ? kms / C_KMS : NaN);
  const tag = s.boosting ? 'boost' : (s.autopilot ? 'autopilot' : '');
  screenBase(ctx, 'speed', tag, s.boosting ? GOLD : CYAN);
  const text = fmtSpeedKms(kms);
  const size = fitText(ctx, text, SCREEN_W - 140, 44, 24);
  ctx.fillStyle = INK;
  ctx.fillText(text, 24, 104);
  const w = ctx.measureText(text).width;
  ctx.font = '400 15px ' + FONT;
  ctx.fillStyle = FAINT;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.fillText('KM/S', 24 + w + 14, 104);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const cText = fmtSpeedC(c);
  if (cText) {
    ctx.font = '500 19px ' + FONT;
    ctx.fillStyle = c >= 1 ? GOLD : FAINT;
    ctx.fillText(cText + (c >= 1 ? '  (a game fiction)' : ''), 24, 138);
  }
  // throttle bar
  const lvl = Math.max(0, Math.min(1, Number(s.throttleLevel) || 0));
  const bx = 24, by = 162, bw = SCREEN_W - 48, bh = 6;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.fillRect(bx, by, bw, bh);
  const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  grad.addColorStop(0, 'rgba(245, 179, 36, 0.55)');
  grad.addColorStop(1, GOLD);
  ctx.fillStyle = grad;
  ctx.fillRect(bx, by, Math.round(bw * lvl), bh);
  // step ticks
  ctx.fillStyle = 'rgba(5, 7, 13, 0.9)';
  for (let k = 1; k < 14; k++) ctx.fillRect(bx + Math.round(bw * k / 14), by, 1, bh);
  ctx.font = '400 15px ' + FONT;
  ctx.fillStyle = FAINT;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.fillText('THROTTLE ' + Math.round(lvl * 100) + ' %', 24, 196);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  void size;
  scr.tex.needsUpdate = true;
}

function drawSystem(scr, s) {
  const ctx = scr.ctx;
  screenBase(ctx, 'system', '', '');
  const host = s.hostName || '';
  fitText(ctx, host, SCREEN_W - 48, 38, 20);
  ctx.fillStyle = GOLD;
  ctx.fillText(host, 24, 104);
  ctx.font = '400 17px ' + FONT;
  ctx.fillStyle = FAINT;
  const ly = Number(s.distFromEarthLy);
  ctx.fillText(Number.isFinite(ly) ? fmt(ly, ly < 100 ? 1 : 0) + ' ly from Earth' : 'distance not catalogued', 24, 138);
  // destination
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(24, 156, SCREEN_W - 48, 1);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.font = '400 14px ' + FONT;
  ctx.fillStyle = 'rgba(245, 179, 36, 0.6)';
  ctx.fillText('JUMP', 24, 190);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const dest = s.destination || '';
  if (dest) {
    const dl = Number(s.destinationLy);
    const line = dest + (Number.isFinite(dl) ? ' · ' + fmt(dl, dl < 10 ? 1 : 0) + ' ly' : '');
    fitText(ctx, line, SCREEN_W - 120, 21, 13);
    ctx.fillStyle = CYAN;
    ctx.fillText(line, 96, 190);
  } else {
    ctx.font = '400 17px ' + FONT;
    ctx.fillStyle = FAINT;
    ctx.fillText('no destination · J chooses', 96, 190);
  }
  scr.tex.needsUpdate = true;
}

/* ---------------- the interior ---------------- */

/**
 * @param THREE the three.js namespace
 * @param opts  { envMap } optional environment texture for the metal
 */
export function makeCockpit(THREE, opts) {
  const o = opts || {};
  const group = new THREE.Group();
  group.name = 'cockpit';
  group.frustumCulled = false;

  const brushed = makeBrushedMaps(THREE);
  // a faint emissive floor keeps the panel readable when the star is behind the ship
  const graphite = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: brushed.map, roughnessMap: brushed.roughnessMap, roughness: 1.0, metalness: 0.45,
    emissive: 0x07080b, envMap: o.envMap || null, envMapIntensity: 0.5,
  });
  const graphiteDark = new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.6, metalness: 0.4, emissive: 0x05060a, envMap: o.envMap || null, envMapIntensity: 0.4 });
  const gold = new THREE.MeshBasicMaterial({ color: 0xF5B324, toneMapped: false });
  const goldDim = new THREE.MeshBasicMaterial({ color: 0x6b4d12, toneMapped: false });

  /* dashboard face: leans back under the glare shield; the screens sit on it */
  const face = new THREE.Group();
  face.position.set(0, -0.0105, -0.040);
  face.rotation.x = -0.42;
  group.add(face);
  const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.012), graphite);
  faceMesh.geometry.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 === 0 ? 6 : 1); });
  faceMesh.geometry.attributes.uv.needsUpdate = true;
  face.add(faceMesh);
  // hairlines along the top and bottom of the face
  const topLine = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.00025, 0.00025), goldDim);
  topLine.position.set(0, 0.006, 0.0001);
  face.add(topLine);

  /* glare shield: a flat deck from the face's top edge forward, a gold hairline on its far edge */
  const shieldDepth = 0.010;
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.0012, shieldDepth), graphiteDark);
  // the face's top edge in group space
  const topY = -0.0105 + 0.006 * Math.cos(0.42), topZ = -0.040 - 0.006 * Math.sin(0.42);
  shield.position.set(0, topY - 0.0002, topZ - shieldDepth / 2);
  shield.rotation.x = -0.04;
  group.add(shield);
  const shieldLine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.0003, 0.0003), gold);
  shieldLine.position.set(0, topY + 0.0004 + shieldDepth * 0.04, topZ - shieldDepth);
  group.add(shieldLine);
  // the deck's brushed top: a thin plane over the dark box so the streaks read
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(0.18, shieldDepth), graphite);
  deck.rotation.x = -Math.PI / 2 - 0.04;
  deck.position.set(0, topY + 0.00045, topZ - shieldDepth / 2);
  deck.geometry.attributes.uv.array.forEach((v, i, a) => { a[i] = v * (i % 2 === 0 ? 6 : 0.5); });
  deck.geometry.attributes.uv.needsUpdate = true;
  group.add(deck);

  /* canopy struts: thin, from outside the lower corners up toward the top centre */
  const strutGeom = new THREE.CylinderGeometry(0.00035, 0.00045, 1, 10, 1);
  for (const s of [1, -1]) {
    const a = new THREE.Vector3(s * 0.050, -0.0045, -0.046);
    const b = new THREE.Vector3(s * 0.024, 0.030, -0.062);
    const strut = new THREE.Mesh(strutGeom, graphiteDark);
    const len = a.distanceTo(b);
    strut.scale.set(1, len, 1);
    strut.position.copy(a).add(b).multiplyScalar(0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(strut);
    // a hairline of gold along the inner face of each strut
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.00012, len, 0.00012), goldDim);
    line.position.copy(strut.position).add(new THREE.Vector3(-s * 0.00038, 0, 0.0002));
    line.quaternion.copy(strut.quaternion);
    group.add(line);
  }

  /* screens on the face, in the face's frame; the side ones move in on narrow frames */
  const SCREEN_MESH_W = 0.0115, SCREEN_MESH_H = 0.0050;
  const screens = {
    target: makeScreen(THREE, SCREEN_MESH_W, SCREEN_MESH_H),
    speed: makeScreen(THREE, SCREEN_MESH_W, SCREEN_MESH_H),
    system: makeScreen(THREE, SCREEN_MESH_W, SCREEN_MESH_H),
  };
  const bezelGeom = new THREE.BoxGeometry(SCREEN_MESH_W + 0.0006, SCREEN_MESH_H + 0.0006, 0.0004);
  const bezelLineGeomH = new THREE.BoxGeometry(SCREEN_MESH_W + 0.0006, 0.00012, 0.00012);
  const SIDE_X = 0.0132;
  const SCREEN_Y = 0.0012;
  for (const key of ['target', 'speed', 'system']) {
    const scr = screens[key];
    const holder = new THREE.Group();
    const bezel = new THREE.Mesh(bezelGeom, graphiteDark);
    bezel.position.z = -0.0002;
    holder.add(bezel);
    scr.mesh.position.z = 0.00005;
    holder.add(scr.mesh);
    const lineTop = new THREE.Mesh(bezelLineGeomH, goldDim);
    lineTop.position.set(0, (SCREEN_MESH_H + 0.0006) / 2, 0.0001);
    holder.add(lineTop);
    holder.position.set(0, SCREEN_Y, 0.0002);
    face.add(holder);
    scr.holder = holder;
  }
  screens.target.holder.position.x = -SIDE_X;
  screens.system.holder.position.x = SIDE_X;

  /* the panel's own light: the screens spill a little gold and cyan onto the face and deck.
     three clamps a point light's falloff at 1 / max(d^2, 0.01), so at these distances (a few
     thousandths of a unit) a light is a constant illuminant with irradiance = 100 x intensity */
  const panelLight = new THREE.PointLight(0xd8c39a, 0.011, 0, 2);
  panelLight.position.set(0, -0.0060, -0.036);
  group.add(panelLight);
  const panelLight2 = new THREE.PointLight(0x35D6FF, 0.004, 0, 2);
  panelLight2.position.set(0, -0.0090, -0.034);
  group.add(panelLight2);

  /* ---- layout: the screens for the frame's aspect ---- */
  // the visible half-width at the face's distance, per unit of aspect (45 degree vertical fov)
  const HALF_H_AT_FACE = Math.tan(Math.PI / 8) * 0.040;
  const EDGE_MARGIN = 0.0008;
  const ROW_GAP = 0.0004;

  /**
   * Wide frames: three screens in a row, the row shrunk as one when the frame cannot take it
   * at full size (a 4:3 tablet). Portrait phones: the speed screen on top, the target and
   * system screens smaller in a row under it. Every screen stays inside the frame.
   */
  function layout(aspect) {
    const avail = HALF_H_AT_FACE * aspect - EDGE_MARGIN;
    const T = screens.target.holder, S = screens.speed.holder, Y = screens.system.holder;
    const need3 = SIDE_X + SCREEN_MESH_W / 2;
    const s3 = Math.min(1, avail / need3);
    if (s3 >= 0.72) {
      for (const h of [T, S, Y]) { h.scale.setScalar(s3); h.position.set(0, SCREEN_Y, 0.0002); }
      T.position.x = -SIDE_X * s3;
      Y.position.x = SIDE_X * s3;
      return;
    }
    const s1 = Math.max(0.4, Math.min(1, avail / (SCREEN_MESH_W / 2)));
    const s2 = Math.max(0.4, Math.min(1, (2 * avail - ROW_GAP) / (2 * SCREEN_MESH_W)));
    S.scale.setScalar(s1);
    S.position.set(0, 0.0030, 0.0002);
    T.scale.setScalar(s2);
    T.position.set(-(SCREEN_MESH_W * s2 / 2 + ROW_GAP / 2), -0.0030, 0.0002);
    Y.scale.setScalar(s2);
    Y.position.set(SCREEN_MESH_W * s2 / 2 + ROW_GAP / 2, -0.0030, 0.0002);
  }

  /* ---- update ---- */
  let lastDraw = -1;
  let lastAspect = 0;
  let lastKey = '';
  let fontsReady = false;
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { fontsReady = true; lastDraw = -1; lastKey = ''; }).catch(() => {});
  }

  function draw(s) {
    drawTarget(screens.target, s);
    drawSpeed(screens.speed, s);
    drawSystem(screens.system, s);
  }

  /** Everything the three screens show, as one string: an unchanged key skips the redraw and the texture uploads. */
  function drawKey(s) {
    const lvl = Math.round((Number(s.throttleLevel) || 0) * 100);
    return [s.targetName, s.targetSub, Number.isFinite(s.targetDistKm) ? Math.round(s.targetDistKm) : '',
      s.aligned ? 1 : 0, s.autopilot ? 1 : 0, s.boosting ? 1 : 0, fmtSpeedKms(Number(s.speedKms)), lvl,
      s.hostName, s.distFromEarthLy, s.destination, s.destinationLy].join('|');
  }

  function update(s) {
    if (!s) return;
    const aspect = Number.isFinite(s.aspect) && s.aspect > 0 ? s.aspect : 1.78;
    if (aspect !== lastAspect) {
      lastAspect = aspect;
      layout(aspect);
    }
    const now = Number.isFinite(s.now) ? s.now : 0;
    if (lastDraw >= 0 && now - lastDraw < REDRAW_S && now >= lastDraw) return;
    lastDraw = now;
    const key = drawKey(s);
    if (key === lastKey) return;
    lastKey = key;
    draw(s);
  }
  layout(1.78);

  /** Force the next update() to redraw every screen. */
  function redraw() { lastDraw = -1; lastKey = ''; }
  // a hidden tab may hibernate a 2D canvas (Chrome) and hand the GPU a stale copy of it; the
  // unchanged-key shortcut would then keep that copy, so the first frame after the page is
  // shown again redraws everything
  const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) redraw(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  function dispose() {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    for (const key of Object.keys(screens)) {
      screens[key].tex.dispose();
      screens[key].mat.dispose();
      screens[key].mesh.geometry.dispose();
    }
    brushed.map.dispose();
    brushed.roughnessMap.dispose();
    graphite.dispose(); graphiteDark.dispose(); gold.dispose(); goldDim.dispose();
    strutGeom.dispose(); bezelGeom.dispose(); bezelLineGeomH.dispose();
    if (group.parent) group.parent.remove(group);
  }

  group.userData.screens = screens;
  group.userData.fontsReady = () => fontsReady;
  return { group, update, redraw, dispose, screens };
}
