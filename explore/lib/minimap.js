/* ===================================================================
   explore/lib/minimap.js : the cockpit minimap (2D canvas)

   Two modes.
     galaxy  the calibrated artwork (data/galaxy.json) with every host
             as a one pixel dot, the current system ringed in gold,
             visited systems as gold dots.
     local   a 4,000 ly wide top-down view centred on the current
             system, 100 and 1,000 ly rings, the Sun labelled.

   Frame: galactocentric parsecs, exactly as explore/explore.js
     origin = Galactic Centre, Sun at (-r0, 0, 0), +y toward l = 90,
     +z toward the north galactic pole.
   Host position = Sun + heliocentric (x, y, z) from planets.json.

   Artwork registration (same maths as explore.js, inverted):
     pixel offset d = (px - cx, py - cy)
     world.x = P * (d . x_gal_dir_px),  world.y = P * (d . y_gal_dir_px)
   so with A = [[xd0, xd1], [yd0, yd1]]:  d = A^-1 * world / P.
   P is re-derived so that sun_px lands exactly r0 from centre_px, and
   falls back to the file's pc_per_px if that disagrees by > 0.2 percent.
   Local mode uses the same direction vectors, so both modes share one
   orientation (x_gal up, y_gal left on the shipped artwork).

   Cost: nothing is drawn per frame. A cached offscreen canvas holds the
   artwork plus the host dots (or, in local mode, rings plus dots sized
   by proximity); a state change redraws that cache only when the mode,
   the size or, in local mode, the current system changed. Overlay marks
   (current ring, visited, picked, hover) are cheap and drawn on top.
   =================================================================== */

const LY_PER_PC = 3.26156;
const DEFAULT_R0_PC = 8178;
const LOCAL_WIDTH_LY = 4000;
const LOCAL_RINGS_LY = [100, 1000];
const PICK_RADIUS_PX = 8;

const COL = {
  bg: '#000000',
  gold: '#F5B324',
  cyan: '#35D6FF',
  host: 'rgba(200, 222, 255, 0.55)',
  hostLocal: 'rgba(200, 222, 255, 0.85)',
  ring: 'rgba(245, 179, 36, 0.35)',
  text: 'rgba(217, 221, 232, 0.85)',
  dim: 'rgba(217, 221, 232, 0.5)',
};
const FONT = '10px "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function fmtInt(n) { return Math.round(n).toLocaleString('en-GB'); }
function fmtLy(pc) {
  const ly = pc * LY_PER_PC;
  if (ly < 100) return ly.toFixed(1) + ' ly';
  return fmtInt(ly) + ' ly';
}

/**
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} opts
 * @param {Array<{name:string, x:number, y:number, z:number, planets?:number|Array}>} opts.hosts
 *   heliocentric galactic parsecs; hosts without finite positions are skipped
 * @param {object} opts.galaxy   parsed data/galaxy.json
 * @param {string} [opts.baseUrl]  directory that contains img/ (with or without a trailing slash)
 * @param {number} [opts.r0_pc]    Sun to Galactic Centre distance, default 8178
 */
export function createMinimap(canvasEl, opts) {
  const galaxy = opts.galaxy;
  const R0 = Number.isFinite(opts.r0_pc) ? opts.r0_pc : DEFAULT_R0_PC;
  let base = String(opts.baseUrl == null ? '' : opts.baseUrl);
  if (base && !base.endsWith('/')) base += '/';

  /* ---- hosts: galactocentric arrays ---- */
  const src = Array.isArray(opts.hosts) ? opts.hosts : [];
  const names = [];
  const gx = [], gy = [], gz = [];
  const nPlanets = [];
  const indexByName = new Map();
  for (const h of src) {
    if (!h || typeof h.name !== 'string') continue;
    if (!Number.isFinite(h.x) || !Number.isFinite(h.y) || !Number.isFinite(h.z)) continue;
    indexByName.set(h.name, names.length);
    names.push(h.name);
    gx.push(-R0 + h.x); gy.push(h.y); gz.push(h.z);
    const p = h.planets;
    nPlanets.push(Array.isArray(p) ? p.length : (Number.isFinite(p) ? p : 1));
  }
  const N = names.length;
  const SUN = { x: -R0, y: 0, z: 0 };

  /* ---- artwork registration ---- */
  const W = galaxy.px_w, H = galaxy.px_h;
  const cx = galaxy.centre_px[0], cy = galaxy.centre_px[1];
  const sunDx = galaxy.sun_px[0] - cx, sunDy = galaxy.sun_px[1] - cy;
  const sunPx = Math.hypot(sunDx, sunDy);
  let P = R0 / sunPx;
  if (!Number.isFinite(P) || Math.abs(P - galaxy.pc_per_px) / galaxy.pc_per_px > 0.002) P = galaxy.pc_per_px;
  const xd = galaxy.x_gal_dir_px, yd = galaxy.y_gal_dir_px;
  const det = xd[0] * yd[1] - xd[1] * yd[0];
  // world (pc, galactocentric) -> artwork pixel offset from centre_px
  function worldToPixelOffset(X, Y, out) {
    out.x = (yd[1] * X - xd[1] * Y) / det / P;
    out.y = (-yd[0] * X + xd[0] * Y) / det / P;
    return out;
  }
  // world (pc) -> unit pixel direction, used for local mode orientation (no P)
  function worldToDir(X, Y, out) {
    out.x = (yd[1] * X - xd[1] * Y) / det;
    out.y = (-yd[0] * X + xd[0] * Y) / det;
    return out;
  }

  /* ---- state ---- */
  const ctx = canvasEl.getContext('2d');
  let mode = 'galaxy';
  let current = -1;
  let picked = -1;
  let hovered = -1;
  const visited = new Set(); // indices
  let pickHandler = null;
  let cssW = 220, cssH = 220, dpr = 1;
  let img = null;
  let imgFailed = false;

  // cache: offscreen canvas at device resolution, plus the projection it was built with
  const cache = document.createElement('canvas');
  const cctx = cache.getContext('2d');
  let cacheKey = '';
  // screen positions (css px) of every host for the cached projection
  const sx = new Float32Array(N), sy = new Float32Array(N);
  let sunX = 0, sunY = 0;
  // artwork placement in galaxy mode (css px)
  const art = { x: 0, y: 0, w: 0, h: 0, scale: 0 };
  let scheduled = false;

  const tmp = { x: 0, y: 0 };

  /* ---- artwork ---- */
  if (galaxy.image) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => { cacheKey = ''; schedule(); };
    img.onerror = () => { imgFailed = true; img = null; console.warn('[minimap] artwork failed to load: ' + base + galaxy.image); };
    img.src = base + galaxy.image;
  }

  /* ---- projections ---- */
  function projectGalaxy() {
    // artwork fitted (contain) inside the canvas, centred
    const s = Math.min(cssW / W, cssH / H);
    art.scale = s;
    art.w = W * s; art.h = H * s;
    art.x = (cssW - art.w) * 0.5; art.y = (cssH - art.h) * 0.5;
    const ox = art.x + cx * s, oy = art.y + cy * s;
    for (let i = 0; i < N; i++) {
      worldToPixelOffset(gx[i], gy[i], tmp);
      sx[i] = ox + tmp.x * s;
      sy[i] = oy + tmp.y * s;
    }
    worldToPixelOffset(SUN.x, SUN.y, tmp);
    sunX = ox + tmp.x * s; sunY = oy + tmp.y * s;
  }

  function projectLocal() {
    const pxPerPc = cssW / (LOCAL_WIDTH_LY / LY_PER_PC);
    const c0x = current >= 0 ? gx[current] : SUN.x;
    const c0y = current >= 0 ? gy[current] : SUN.y;
    const ox = cssW * 0.5, oy = cssH * 0.5;
    for (let i = 0; i < N; i++) {
      worldToDir(gx[i] - c0x, gy[i] - c0y, tmp);
      sx[i] = ox + tmp.x * pxPerPc;
      sy[i] = oy + tmp.y * pxPerPc;
    }
    worldToDir(SUN.x - c0x, SUN.y - c0y, tmp);
    sunX = ox + tmp.x * pxPerPc; sunY = oy + tmp.y * pxPerPc;
    return pxPerPc;
  }

  /* ---- cache ---- */
  function rebuildCache() {
    const key = mode + '|' + cssW + 'x' + cssH + '@' + dpr + '|' + (img && img.complete && img.naturalWidth ? 'img' : 'noimg') + (mode === 'local' ? '|' + current : '');
    if (key === cacheKey) return;
    cacheKey = key;
    cache.width = Math.max(1, Math.round(cssW * dpr));
    cache.height = Math.max(1, Math.round(cssH * dpr));
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.fillStyle = COL.bg;
    cctx.fillRect(0, 0, cache.width, cache.height);

    if (mode === 'galaxy') {
      projectGalaxy();
      if (img && img.complete && img.naturalWidth) {
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = 'high';
        cctx.globalAlpha = 0.85;
        cctx.drawImage(img, art.x * dpr, art.y * dpr, art.w * dpr, art.h * dpr);
        cctx.globalAlpha = 1;
      }
      // hosts: one device pixel each, additive-ish through alpha
      cctx.fillStyle = COL.host;
      for (let i = 0; i < N; i++) {
        cctx.fillRect(Math.round(sx[i] * dpr), Math.round(sy[i] * dpr), 1, 1);
      }
    } else {
      const pxPerPc = projectLocal();
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // rings around the current system
      cctx.lineWidth = 1;
      cctx.strokeStyle = COL.ring;
      cctx.fillStyle = COL.dim;
      cctx.font = FONT;
      cctx.textAlign = 'left';
      cctx.textBaseline = 'bottom';
      for (const ly of LOCAL_RINGS_LY) {
        const r = (ly / LY_PER_PC) * pxPerPc;
        cctx.beginPath();
        cctx.arc(cssW * 0.5, cssH * 0.5, r, 0, Math.PI * 2);
        cctx.stroke();
        cctx.fillText(fmtInt(ly) + ' ly', cssW * 0.5 + r * 0.7071 + 3, cssH * 0.5 - r * 0.7071 - 2);
      }
      // hosts sized by proximity to the current system
      const c0x = current >= 0 ? gx[current] : SUN.x;
      const c0y = current >= 0 ? gy[current] : SUN.y;
      const c0z = current >= 0 ? gz[current] : SUN.z;
      cctx.fillStyle = COL.hostLocal;
      const margin = 4;
      for (let i = 0; i < N; i++) {
        if (i === current) continue;
        const x = sx[i], y = sy[i];
        if (x < -margin || x > cssW + margin || y < -margin || y > cssH + margin) continue;
        const d = Math.hypot(gx[i] - c0x, gy[i] - c0y, gz[i] - c0z); // pc
        const r = 0.5 + 1.6 / (1 + d / 60);
        cctx.beginPath();
        cctx.arc(x, y, r, 0, Math.PI * 2);
        cctx.fill();
      }
    }
  }

  /* ---- drawing ---- */
  function drawDot(x, y, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  function drawRing(x, y, r, stroke, lw) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  function label(text, x, y, color, align) {
    ctx.font = FONT;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    // dark halo so the text reads over the artwork
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function inside(x, y, m) {
    return x >= -m && x <= cssW + m && y >= -m && y <= cssH + m;
  }
  // a marker at the canvas edge pointing toward an off-screen point
  function edgeMarker(x, y, text, color) {
    const ox = cssW * 0.5, oy = cssH * 0.5;
    const dx = x - ox, dy = y - oy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const pad = 10;
    const tx = ux !== 0 ? (cssW * 0.5 - pad) / Math.abs(ux) : Infinity;
    const ty = uy !== 0 ? (cssH * 0.5 - pad) / Math.abs(uy) : Infinity;
    const t = Math.min(tx, ty);
    const ex = ox + ux * t, ey = oy + uy * t;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ex - ux * 6, ey - uy * 6);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    drawDot(ex, ey, 1.5, color);
    const lx = ex - ux * 10, ly = ey - uy * 10;
    label(text, lx, ly, color, ux > 0.3 ? 'right' : (ux < -0.3 ? 'left' : 'center'));
  }

  function draw() {
    scheduled = false;
    if (!ctx) return;
    rebuildCache();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // the Sun
    if (inside(sunX, sunY, 0)) {
      drawDot(sunX, sunY, mode === 'galaxy' ? 1.5 : 2, COL.gold);
      const away = current >= 0 && Math.hypot(sx[current] - sunX, sy[current] - sunY) < 14;
      // in galaxy mode the current system sits on top of the Sun: label the Sun to the lower left
      label('sun', sunX - (away || mode === 'galaxy' ? 5 : -6), sunY + (away || mode === 'galaxy' ? 9 : 0), COL.gold, (away || mode === 'galaxy') ? 'right' : 'left');
    } else if (mode === 'local') {
      const d = current >= 0 ? Math.hypot(gx[current] - SUN.x, gy[current] - SUN.y, gz[current] - SUN.z) : 0;
      edgeMarker(sunX, sunY, 'sun ' + fmtLy(d), COL.gold);
    }

    // visited: gold dots
    for (const i of visited) {
      if (i === current) continue;
      if (!inside(sx[i], sy[i], 2)) continue;
      drawDot(sx[i], sy[i], mode === 'galaxy' ? 1.2 : 2, COL.gold);
    }

    // picked: cyan ring
    if (picked >= 0 && picked !== current && inside(sx[picked], sy[picked], 6)) {
      drawRing(sx[picked], sy[picked], 4.5, COL.cyan, 1);
      drawDot(sx[picked], sy[picked], 1.2, COL.cyan);
    }

    // current: gold ring with a label
    if (current >= 0) {
      const x = sx[current], y = sy[current];
      if (inside(x, y, 6)) {
        drawDot(x, y, 1.5, COL.gold);
        drawRing(x, y, 5, COL.gold, 1.2);
        const right = x < cssW * 0.6;
        label(names[current], x + (right ? 9 : -9), y - (mode === 'galaxy' ? 6 : 0), COL.gold, right ? 'left' : 'right');
      }
    }

    // mode caption, top-left
    label(mode === 'galaxy' ? 'galaxy · ' + fmtInt(W * P * LY_PER_PC) + ' ly across' : 'local · ' + fmtInt(LOCAL_WIDTH_LY) + ' ly across', 6, 9, COL.dim, 'left');

    // hover, bottom-left corner
    const hi = hovered >= 0 ? hovered : -1;
    if (hi >= 0) {
      let text = names[hi];
      if (current >= 0 && hi !== current) {
        const d = Math.hypot(gx[hi] - gx[current], gy[hi] - gy[current], gz[hi] - gz[current]);
        text += ' · ' + fmtLy(d);
      }
      text += ' · ' + nPlanets[hi] + (nPlanets[hi] === 1 ? ' planet' : ' planets');
      label(text, 6, cssH - 9, COL.text, 'left');
      if (inside(sx[hi], sy[hi], 4) && hi !== current) drawRing(sx[hi], sy[hi], 3.5, COL.text, 1);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(draw);
  }

  /* ---- sizing ---- */
  function resize() {
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.round(rect.width) || canvasEl.clientWidth || 220;
    const h = Math.round(rect.height) || canvasEl.clientHeight || 220;
    const d = Math.min(3, window.devicePixelRatio || 1);
    if (w === cssW && h === cssH && d === dpr && canvasEl.width === Math.round(w * d)) return;
    cssW = w; cssH = h; dpr = d;
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    cacheKey = '';
    draw();
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(canvasEl);
  }

  /* ---- picking ---- */
  function hostAt(px, py) {
    let best = -1, bestD = PICK_RADIUS_PX * PICK_RADIUS_PX;
    for (let i = 0; i < N; i++) {
      const dx = sx[i] - px, dy = sy[i] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { best = i; bestD = d2; }
    }
    // prefer the current system when several sit on one pixel is not useful: prefer the nearest, ties keep the first
    return best;
  }
  function localXY(ev) {
    const rect = canvasEl.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  let downX = 0, downY = 0, downId = -1;
  function onPointerDown(ev) {
    downX = ev.clientX; downY = ev.clientY; downId = ev.pointerId;
  }
  function onPointerUp(ev) {
    if (ev.pointerId !== downId) return;
    downId = -1;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 6) return;
    const p = localXY(ev);
    const i = hostAt(p.x, p.y);
    if (i < 0) return;
    picked = i;
    schedule();
    if (pickHandler) pickHandler(names[i]);
  }
  function onPointerMove(ev) {
    if (ev.pointerType !== 'mouse') return;
    const p = localXY(ev);
    const i = hostAt(p.x, p.y);
    if (i !== hovered) {
      hovered = i;
      canvasEl.style.cursor = i >= 0 ? 'pointer' : '';
      schedule();
    }
  }
  function onPointerLeave() {
    if (hovered >= 0) { hovered = -1; canvasEl.style.cursor = ''; schedule(); }
  }
  canvasEl.addEventListener('pointerdown', onPointerDown);
  canvasEl.addEventListener('pointerup', onPointerUp);
  canvasEl.addEventListener('pointermove', onPointerMove);
  canvasEl.addEventListener('pointerleave', onPointerLeave);
  canvasEl.style.touchAction = 'manipulation';

  /* ---- public ---- */
  const api = {
    setCurrent(hostName) {
      const i = hostName == null ? -1 : (indexByName.has(hostName) ? indexByName.get(hostName) : -1);
      if (hostName != null && i < 0) console.warn('[minimap] unknown or unplaced host: ' + hostName);
      if (i === current) return;
      current = i;
      if (picked === current) picked = -1;
      if (mode === 'local') cacheKey = '';
      schedule();
    },
    setVisited(setOfNames) {
      visited.clear();
      if (setOfNames) {
        for (const n of setOfNames) {
          const i = indexByName.get(n);
          if (i !== undefined) visited.add(i);
        }
      }
      schedule();
    },
    setMode(m) {
      const next = m === 'local' ? 'local' : 'galaxy';
      if (next === mode) return;
      mode = next;
      cacheKey = '';
      schedule();
    },
    toggleMode() { api.setMode(mode === 'galaxy' ? 'local' : 'galaxy'); return mode; },
    getMode() { return mode; },
    onPick(fn) { pickHandler = typeof fn === 'function' ? fn : null; },
    /** extra: mark a host as the pick target (cyan ring), or null to clear */
    setPicked(hostName) {
      const i = hostName == null ? -1 : (indexByName.has(hostName) ? indexByName.get(hostName) : -1);
      if (i === picked) return;
      picked = i;
      schedule();
    },
    getPicked() { return picked >= 0 ? names[picked] : null; },
    /** extra: nearest placed host to a css pixel on the canvas, or null */
    hostAt(px, py) { const i = hostAt(px, py); return i >= 0 ? names[i] : null; },
    draw,
    resize,
    destroy() {
      if (ro) ro.disconnect();
      canvasEl.removeEventListener('pointerdown', onPointerDown);
      canvasEl.removeEventListener('pointerup', onPointerUp);
      canvasEl.removeEventListener('pointermove', onPointerMove);
      canvasEl.removeEventListener('pointerleave', onPointerLeave);
    },
    /** extra: how many hosts had positions and are drawn */
    count: N,
    calibration: { pc_per_px: P, det, r0_pc: R0 },
  };

  resize();
  draw();
  return api;
}
