// Detector view: one NIRISS SOSS trace through a transit.
// The stripe dims everywhere when the planet crosses its star, and dims
// more at the wavelengths where the planet's atmosphere absorbs.
(function () {
  const canvas = document.getElementById('trace-canvas');
  if (!canvas) return;

  const MONO = '"IBM Plex Mono", monospace';
  const WL_MIN = 0.6, WL_MAX = 2.8;
  const R_RATIO = 0.10045 * 1.2;          // planet: 1.2 Jupiter radii
  const EXAG = 3;                          // atmosphere imprint, exaggerated for the eye
  const CYCLE_MS = 11000;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function gauss(x, mu, sig) { return Math.exp(-0.5 * Math.pow((x - mu) / sig, 2)); }

  function atmBoost(wl) {
    const bands =
      1.00 * gauss(wl, 1.40, 0.09) +
      0.85 * gauss(wl, 1.90, 0.13) +
      0.75 * gauss(wl, 2.70, 0.16) +
      0.20 * gauss(wl, 2.32, 0.07);
    const rayleigh = 0.30 * Math.exp(-(wl - WL_MIN) / 0.45);
    return 0.055 * EXAG * (bands + rayleigh);
  }

  function depthAt(wl) {
    const r = R_RATIO * (1 + atmBoost(wl));
    return r * r;
  }
  const D_CONT = R_RATIO * R_RATIO;        // airless reference depth

  // transit shape over one loop of normalised time
  function shapeAt(t) {
    if (t < 0.18 || t > 0.82) return 0;
    if (t < 0.30) return (t - 0.18) / 0.12;
    if (t > 0.70) return (0.82 - t) / 0.12;
    return 1;
  }

  function wlRGB(wl) {
    const t = (wl - WL_MIN) / (WL_MAX - WL_MIN);
    let r, g, b;
    if (t < 0.33)      { const u = t / 0.33;          r = 245; g = 205 - 90 * u;  b = 60 + 20 * u; }
    else if (t < 0.66) { const u = (t - 0.33) / 0.33; r = 245 - 60 * u; g = 115 - 45 * u; b = 80 + 100 * u; }
    else               { const u = (t - 0.66) / 0.34; r = 185 - 16 * u; g = 70 + 42 * u;  b = 180 + 75 * u; }
    return [r | 0, g | 0, b | 0];
  }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function lighten(c, f) { return [c[0] + (255 - c[0]) * f | 0, c[1] + (255 - c[1]) * f | 0, c[2] + (255 - c[2]) * f | 0]; }

  // deterministic pseudo-random (stable speckles and absorption lines)
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let z = Math.imul(seed ^ seed >>> 15, 1 | seed);
      z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
      return ((z ^ z >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry(20260827);

  const speckles = Array.from({ length: 130 }, () => ({
    u: rand(), dy: (rand() - 0.5) * 11, ph: rand() * Math.PI * 2, s: 0.8 + rand() * 0.9
  }));
  const hotPixels = Array.from({ length: 40 }, () => ({ x: rand(), y: rand(), a: 0.03 + rand() * 0.05 }));
  const absLines = Array.from({ length: 15 }, () => ({
    u: 0.04 + rand() * 0.92, w: 1 + rand() * 1.6, d: 0.35 + rand() * 0.5
  }));

  function fit(c, aspect) {
    const w = c.clientWidth || parseInt(c.getAttribute('width'), 10);
    const h = Math.round(w / aspect);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw; c.height = bh; c.style.height = h + 'px';
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // precomputed per-segment colours (wavelength is linear in segment index)
  const SEG_N = 200;
  const segWl = [], segRGB = [], segLite = [];
  for (let i = 0; i < SEG_N; i++) {
    const wl = WL_MIN + (i + 0.5) / SEG_N * (WL_MAX - WL_MIN);
    segWl.push(wl);
    const c = wlRGB(wl);
    segRGB.push(c);
    segLite.push(lighten(c, 0.45));
  }

  // envelope of minimum brightness seen at each position (becomes the spectrum)
  const ENV_N = 160;
  let env = new Array(ENV_N).fill(2);
  let sawFullTransit = false;
  let hover = null;   // {x, y} in CSS px

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });

  function draw(t) {
    const narrow = (canvas.clientWidth || 1060) < 640;
    const { ctx, w, h } = fit(canvas, narrow ? 0.95 : 1060 / 470);
    const S = h / 470;                      // vertical scale for fixed layout
    ctx.clearRect(0, 0, w, h);

    const padL = narrow ? 46 : 64, padR = narrow ? 12 : 18;
    const iw = w - padL - padR;
    const detY = 70 * S, detH = 150 * S;
    const plotY = 272 * S, plotH = 166 * S;
    const shape = shapeAt(t);

    const xOf = wl => padL + (wl - WL_MIN) / (WL_MAX - WL_MIN) * iw;
    const wlOf = x => WL_MIN + (x - padL) / iw * (WL_MAX - WL_MIN);
    const yOfFlux = f => plotY + (1.006 - f) / (1.006 - 0.934) * plotH;

    // trace centreline inside the detector (after a real SOSS order-1 curve)
    const traceY = u => detY + detH / 2 + (16 + 70.9 * u - 120.9 * u * u) * S * 0.9;

    // visual dimming of the stripe: continuum dims a little, bands dim a lot
    function stripeAlpha(wl) {
      const rel = (depthAt(wl) - D_CONT) / D_CONT;   // 0 .. ~0.5
      return Math.max(0.18, 1 - shape * (0.30 + 1.3 * rel));
    }
    // plotted brightness (dip exaggerated so it is visible by eye)
    function fluxVis(wl) { return 1 - 3 * depthAt(wl) * shape; }

    // ---- water-band columns connecting detector and plot ----
    for (const band of [[1.28, 1.54], [1.74, 2.08]]) {
      const x0 = xOf(band[0]), x1 = xOf(band[1]);
      ctx.fillStyle = 'rgba(53,214,255,0.045)';
      ctx.fillRect(x0, detY, x1 - x0, plotY + plotH - detY);
      ctx.fillStyle = 'rgba(53,214,255,0.75)';
      ctx.font = 11 * S + 'px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillText('H₂O', (x0 + x1) / 2, detY + 16 * S);
      ctx.textAlign = 'left';
    }

    // ---- detector panel ----
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, detY, iw, detH);
    // faint pixel grid
    ctx.strokeStyle = 'rgba(255,255,255,0.028)';
    ctx.beginPath();
    for (let gx = padL; gx <= padL + iw; gx += 26) { ctx.moveTo(gx, detY); ctx.lineTo(gx, detY + detH); }
    for (let gy = detY; gy <= detY + detH; gy += 26) { ctx.moveTo(padL, gy); ctx.lineTo(padL + iw, gy); }
    ctx.stroke();
    for (const p of hotPixels) {
      ctx.fillStyle = 'rgba(247,250,255,' + p.a + ')';
      ctx.fillRect(padL + p.x * iw, detY + p.y * detH, 1.5, 1.5);
    }
    ctx.fillStyle = 'rgba(168,182,208,0.8)';
    ctx.font = 11 * S + 'px ' + MONO;
    ctx.fillText('THE DETECTOR · ONE STAR, SPREAD INTO A STRIPE', padL + 10, detY + detH - 10 * S);

    // ---- the trace ----
    const N = SEG_N;
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < N; i++) {
        const u0 = i / N, u1 = (i + 1) / N;
        const a = stripeAlpha(segWl[i]);
        if (pass === 0) { ctx.strokeStyle = rgba(segRGB[i], 0.16 * a); ctx.lineWidth = 24 * S; }
        if (pass === 1) { ctx.strokeStyle = rgba(segRGB[i], 0.85 * a); ctx.lineWidth = 10 * S; }
        if (pass === 2) { ctx.strokeStyle = rgba(segLite[i], Math.min(1, 1.05 * a)); ctx.lineWidth = 3.5 * S; }
        ctx.beginPath();
        ctx.moveTo(padL + u0 * iw, traceY(u0));
        ctx.lineTo(padL + u1 * iw + 0.5, traceY(u1));
        ctx.stroke();
      }
    }
    // stellar absorption lines: thin dark cuts across the stripe
    for (const l of absLines) {
      const x = padL + l.u * iw;
      const y = traceY(l.u);
      const slope = (traceY(l.u + 0.01) - traceY(l.u - 0.01)) / (0.02 * iw);
      const ang = Math.atan(slope) + Math.PI / 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.strokeStyle = 'rgba(1,2,10,' + l.d + ')';
      ctx.lineWidth = l.w * S;
      ctx.beginPath();
      ctx.moveTo(-7 * S, 0); ctx.lineTo(7 * S, 0);
      ctx.stroke();
      ctx.restore();
    }
    // photon shimmer
    for (const sp of speckles) {
      const wl = wlOf(padL + sp.u * iw);
      const a = stripeAlpha(wl) * (0.25 + 0.3 * Math.sin(t * Math.PI * 14 + sp.ph));
      if (a <= 0) continue;
      ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      ctx.fillRect(padL + sp.u * iw, traceY(sp.u) + sp.dy * S, sp.s, sp.s);
    }

    // ---- wavelength ticks ----
    ctx.lineWidth = 1;
    ctx.font = 11 * S + 'px ' + MONO;
    ctx.textAlign = 'center';
    for (const wl of [0.6, 1.0, 1.4, 1.9, 2.4, 2.8]) {
      const x = xOf(wl);
      const isBand = (wl === 1.4 || wl === 1.9);
      ctx.strokeStyle = isBand ? 'rgba(53,214,255,0.6)' : 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(x, detY + detH + 4 * S); ctx.lineTo(x, detY + detH + 10 * S);
      ctx.stroke();
      ctx.fillStyle = isBand ? 'rgba(53,214,255,0.85)' : 'rgba(107,122,153,0.9)';
      ctx.fillText(wl.toFixed(1), x, detY + detH + 24 * S);
    }
    ctx.fillStyle = 'rgba(168,182,208,0.8)';
    ctx.fillText('wavelength along the stripe (microns)', padL + iw / 2, detY + detH + 40 * S);
    ctx.textAlign = 'left';

    // ---- brightness plot ----
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.strokeRect(padL, plotY, iw, plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, yOfFlux(1)); ctx.lineTo(padL + iw, yOfFlux(1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(107,122,153,0.9)';
    ctx.font = 11 * S + 'px ' + MONO;
    ctx.fillText('100%', padL + iw - 40 * S, yOfFlux(1) - 5 * S);
    ctx.fillStyle = 'rgba(168,182,208,0.8)';
    ctx.fillText('BRIGHTNESS OF THE STRIPE, POSITION BY POSITION', padL + 10, plotY + 32 * S);

    // envelope update + spectrum reveal
    for (let i = 0; i < ENV_N; i++) {
      const wl = wlOf(padL + (i + 0.5) / ENV_N * iw);
      const f = fluxVis(wl);
      if (f < env[i]) env[i] = f;
    }
    if (sawFullTransit) {
      ctx.strokeStyle = 'rgba(245,179,36,0.55)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.6 * S;
      ctx.beginPath();
      for (let i = 0; i < ENV_N; i++) {
        const x = padL + (i + 0.5) / ENV_N * iw;
        const y = yOfFlux(env[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(245,179,36,0.85)';
      ctx.textAlign = 'right';
      ctx.fillText('THE TRANSMISSION SPECTRUM', padL + iw - 10, yOfFlux(env[ENV_N - 12]) - 28 * S);
      ctx.textAlign = 'left';
    }

    // live brightness curve, coloured by wavelength
    ctx.lineWidth = 2.4 * S;
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      const wl0 = wlOf(padL + u0 * iw), wl1 = wlOf(padL + u1 * iw);
      ctx.strokeStyle = rgba(segRGB[i], 0.95);
      ctx.beginPath();
      ctx.moveTo(padL + u0 * iw, yOfFlux(fluxVis(wl0)));
      ctx.lineTo(padL + u1 * iw + 0.5, yOfFlux(fluxVis(wl1)));
      ctx.stroke();
    }

    // ---- top strip: transit inset + phase ----
    const sx = padL + 26, sy = 34 * S, sr = 15 * S;
    const g = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 1.55);
    g.addColorStop(0, 'rgba(255,247,220,1)');
    g.addColorStop(0.55, 'rgba(245,179,36,0.95)');
    g.addColorStop(1, 'rgba(238,100,42,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, sr * 1.55, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1;
    const px = sx - 2.6 * sr + 5.2 * sr * Math.min(1, Math.max(0, (t - 0.18) / 0.64));
    const py = sy + 0.55 * sr;
    ctx.fillStyle = '#0B101F';
    ctx.strokeStyle = 'rgba(168,182,208,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(px, py, 3.2 * S, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    const phase = t < 0.18 ? 'BEFORE TRANSIT' : t < 0.30 ? 'ENTERING TRANSIT'
                : t < 0.70 ? 'IN TRANSIT' : t < 0.82 ? 'LEAVING TRANSIT' : 'AFTER TRANSIT';
    ctx.fillStyle = shape > 0 ? 'rgba(245,179,36,0.9)' : 'rgba(107,122,153,0.9)';
    ctx.font = 11 * S + 'px ' + MONO;
    ctx.textAlign = 'right';
    ctx.fillText(phase, padL + iw, 26 * S);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(padL + iw - 170, 38 * S); ctx.lineTo(padL + iw, 38 * S); ctx.stroke();
    ctx.fillStyle = '#F5B324';
    ctx.beginPath(); ctx.arc(padL + iw - 170 + 170 * t, 38 * S, 3 * S, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left';

    // ---- hover marker ----
    if (hover && hover.x > padL && hover.x < padL + iw) {
      const wl = wlOf(hover.x);
      ctx.strokeStyle = 'rgba(247,250,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hover.x, detY); ctx.lineTo(hover.x, plotY + plotH);
      ctx.stroke();
      const blocked = (depthAt(wl) * 100).toFixed(2);
      const inBand = atmBoost(wl) > 0.5 * 0.055 * EXAG;
      const label = wl.toFixed(2) + ' µm · ' + blocked + '% blocked' + (inBand ? ' · water band' : '');
      ctx.font = 11.5 * S + 'px ' + MONO;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(hover.x - tw / 2, padL + 4), padL + iw - tw - 4);
      ctx.fillStyle = 'rgba(4,6,15,0.85)';
      ctx.fillRect(lx - 6, 244 * S - 12 * S, tw + 12, 17 * S);
      ctx.fillStyle = '#F7FAFF';
      ctx.fillText(label, lx, 244 * S);
    }
  }

  if (reduced) {
    // static frame: mid-transit, with the full spectrum already drawn
    for (let i = 0; i < ENV_N; i++) env[i] = 2;
    sawFullTransit = true;
    const { w } = fit(canvas, 1060 / 470);
    const padL = 64, padR = 18, iw = w - padL - padR;
    for (let i = 0; i < ENV_N; i++) {
      const wl = WL_MIN + (i + 0.5) / ENV_N * (WL_MAX - WL_MIN);
      env[i] = 1 - 3 * depthAt(wl);
    }
    draw(0.5);
    window.addEventListener('resize', () => draw(0.5));
    canvas.addEventListener('pointermove', () => draw(0.5));
    canvas.addEventListener('pointerleave', () => draw(0.5));
    return;
  }

  // console hook for rendering a specific moment (used for testing)
  window.__traceDraw = function (t) { sawFullTransit = true; draw(t); };

  let start = null;
  let inView = true;
  let running = false;
  function loop(now) {
    if (!inView) { running = false; return; }
    if (start === null) start = now;
    const t = ((now - start) % CYCLE_MS) / CYCLE_MS;
    if ((now - start) > CYCLE_MS * 0.85) sawFullTransit = true;
    draw(t);
    requestAnimationFrame(loop);
  }
  function ensureRunning() {
    if (!running && inView) { running = true; requestAnimationFrame(loop); }
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => {
      inView = es[0].isIntersecting;
      ensureRunning();
    }).observe(canvas);
  }
  draw(0);
  ensureRunning();
})();
