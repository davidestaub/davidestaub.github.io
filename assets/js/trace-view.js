// Detector view: one NIRISS SOSS trace through a transit.
// The stripe dims when the planet crosses its star, more so at wavelengths
// where the atmosphere absorbs. The lower panel records how much light was
// blocked at each position: the transmission spectrum.
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
  const D_CONT = R_RATIO * R_RATIO;

  // blocked fraction shown in the lower panel and by the hover readout
  function blockedAt(wl) { return depthAt(wl); }
  const B_MAX = blockedAt(1.40) * 1.15;

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

  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let z = Math.imul(seed ^ seed >>> 15, 1 | seed);
      z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
      return ((z ^ z >>> 14) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry(20260827);
  const hotPixels = Array.from({ length: 40 }, () => ({ x: rand(), y: rand(), a: 0.03 + rand() * 0.05 }));

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

  // the measured spectrum: builds during the first transit, then stays
  const MEAS_N = 160;
  const measured = new Array(MEAS_N).fill(0);
  let spectrumDone = false;
  let hover = null;

  function fillMeasured() {
    for (let i = 0; i < MEAS_N; i++) {
      const wl = WL_MIN + (i + 0.5) / MEAS_N * (WL_MAX - WL_MIN);
      measured[i] = blockedAt(wl);
    }
    spectrumDone = true;
  }

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  canvas.addEventListener('pointerleave', () => { hover = null; });

  function draw(t) {
    const narrow = (canvas.clientWidth || 1060) < 640;
    const { ctx, w, h } = fit(canvas, narrow ? 0.95 : 1060 / 470);
    const S = h / 470;
    ctx.clearRect(0, 0, w, h);

    const padL = narrow ? 46 : 64, padR = narrow ? 12 : 18;
    const iw = w - padL - padR;
    const detY = 70 * S, detH = 150 * S;
    const plotY = 272 * S, plotH = 166 * S;
    const shape = shapeAt(t);

    const xOf = wl => padL + (wl - WL_MIN) / (WL_MAX - WL_MIN) * iw;
    const wlOf = x => WL_MIN + (x - padL) / iw * (WL_MAX - WL_MIN);
    // lower panel: amount of light blocked, zero at the bottom, bumps rise up
    const yOfBlocked = b => plotY + plotH - 14 * S - (b / B_MAX) * (plotH - 44 * S);

    const traceY = u => detY + detH / 2 + (16 + 70.9 * u - 120.9 * u * u) * S * 0.9;

    function stripeAlpha(wl) {
      const rel = (depthAt(wl) - D_CONT) / D_CONT;
      return Math.max(0.18, 1 - shape * (0.30 + 1.3 * rel));
    }
    // real dispersed spectra fade toward both ends of the trace
    function envelope(u) { return 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * u)), 0.7); }

    // record what the transit blocks; the record never un-draws
    if (shape > 0) {
      for (let i = 0; i < MEAS_N; i++) {
        const wl = WL_MIN + (i + 0.5) / MEAS_N * (WL_MAX - WL_MIN);
        const b = blockedAt(wl) * shape;
        if (b > measured[i]) measured[i] = b;
      }
      if (shape === 1) spectrumDone = true;
    }

    // ---- water-band shading, kept inside each panel ----
    ctx.font = 11 * S + 'px ' + MONO;
    for (const band of [[1.28, 1.54], [1.74, 2.08]]) {
      const x0 = xOf(band[0]), x1 = xOf(band[1]);
      ctx.fillStyle = 'rgba(53,214,255,0.05)';
      ctx.fillRect(x0, detY + 1, x1 - x0, detH - 2);
      ctx.fillRect(x0, plotY + 1, x1 - x0, plotH - 2);
      ctx.fillStyle = 'rgba(53,214,255,0.75)';
      ctx.textAlign = 'center';
      ctx.fillText('H₂O', (x0 + x1) / 2, detY - 8 * S);
      ctx.textAlign = 'left';
    }

    // ---- detector panel ----
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, detY, iw, detH);
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
    ctx.fillText('THE DETECTOR · ONE STAR, SPREAD INTO A STRIPE', padL + 10, detY + detH - 10 * S);

    // ---- the trace, clipped inside the detector ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL + 1, detY + 1, iw - 2, detH - 2);
    ctx.clip();
    ctx.lineCap = 'butt';
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < SEG_N; i++) {
        const u0 = i / SEG_N, u1 = (i + 1) / SEG_N;
        const a = stripeAlpha(segWl[i]) * envelope((u0 + u1) / 2);
        if (pass === 0) { ctx.strokeStyle = rgba(segRGB[i], 0.15 * a); ctx.lineWidth = 24 * S; }
        if (pass === 1) { ctx.strokeStyle = rgba(segRGB[i], 0.85 * a); ctx.lineWidth = 9 * S; }
        if (pass === 2) { ctx.strokeStyle = rgba(segLite[i], Math.min(1, 1.05 * a)); ctx.lineWidth = 3 * S; }
        ctx.beginPath();
        ctx.moveTo(padL + u0 * iw - 0.5, traceY(u0));
        ctx.lineTo(padL + u1 * iw + 0.5, traceY(u1));
        ctx.stroke();
      }
    }
    ctx.restore();

    // ---- wavelength ticks ----
    ctx.lineWidth = 1;
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

    // ---- lower panel: the recorded spectrum, bumps up where more light is blocked ----
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.strokeRect(padL, plotY, iw, plotH);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, yOfBlocked(0)); ctx.lineTo(padL + iw, yOfBlocked(0));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(107,122,153,0.9)';
    ctx.fillText('0%', padL + 6, yOfBlocked(0) - 5 * S);
    ctx.fillStyle = 'rgba(168,182,208,0.8)';
    ctx.fillText('LIGHT BLOCKED DURING THE TRANSIT, POSITION BY POSITION', padL + 10, plotY + 16 * S);

    if (!measured.some(m => m > 0)) {
      ctx.fillStyle = 'rgba(107,122,153,0.9)';
      ctx.fillText('waiting for the transit', padL + 10, plotY + plotH / 2);
    } else {
      ctx.lineWidth = 2.4 * S;
      ctx.lineJoin = 'round';
      for (let i = 0; i < MEAS_N - 1; i++) {
        const x0 = padL + (i + 0.5) / MEAS_N * iw;
        const x1 = padL + (i + 1.5) / MEAS_N * iw;
        ctx.strokeStyle = rgba(wlRGB(segWl[Math.min(SEG_N - 1, Math.round((i + 1) / MEAS_N * SEG_N))] || 1.7), 0.95);
        ctx.beginPath();
        ctx.moveTo(x0, yOfBlocked(measured[i]));
        ctx.lineTo(x1 + 0.5, yOfBlocked(measured[i + 1]));
        ctx.stroke();
      }
      if (spectrumDone) {
        ctx.fillStyle = 'rgba(245,179,36,0.9)';
        ctx.textAlign = 'right';
        ctx.fillText('THE TRANSMISSION SPECTRUM', padL + iw - 10, plotY + 34 * S);
        ctx.textAlign = 'left';
      }
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
    if (Math.abs(px - sx) < 1.6 * sr) {
      ctx.fillStyle = '#0B101F';
      ctx.strokeStyle = 'rgba(168,182,208,0.75)';
      ctx.beginPath(); ctx.arc(px, sy + 0.55 * sr, 3.2 * S, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    const phase = t < 0.18 ? 'BEFORE TRANSIT' : t < 0.30 ? 'ENTERING TRANSIT'
                : t < 0.70 ? 'IN TRANSIT' : t < 0.82 ? 'LEAVING TRANSIT' : 'AFTER TRANSIT';
    ctx.fillStyle = shape > 0 ? 'rgba(245,179,36,0.9)' : 'rgba(107,122,153,0.9)';
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
      const blocked = (blockedAt(wl) * 100).toFixed(1);
      const inBand = atmBoost(wl) > 0.5 * 0.055 * EXAG;
      const label = wl.toFixed(2) + ' µm · ' + blocked + '% blocked' + (inBand ? ' · water band' : '');
      ctx.font = 11.5 * S + 'px ' + MONO;
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(hover.x - tw / 2, padL + 4), padL + iw - tw - 4);
      ctx.fillStyle = 'rgba(4,6,15,0.85)';
      ctx.fillRect(lx - 6, 244 * S - 12 * S, tw + 12, 17 * S);
      ctx.fillStyle = '#F7FAFF';
      ctx.fillText(label, lx, 244 * S);
      ctx.font = 11 * S + 'px ' + MONO;
    }
  }

  // console hook for rendering a specific moment (used for testing)
  window.__traceDraw = function (t) { fillMeasured(); draw(t); };

  if (reduced) {
    fillMeasured();
    draw(0.5);
    window.addEventListener('resize', () => draw(0.5));
    canvas.addEventListener('pointermove', () => draw(0.5));
    canvas.addEventListener('pointerleave', () => draw(0.5));
    return;
  }

  let start = null;
  let inView = true;
  let running = false;
  function loop(now) {
    if (!inView) { running = false; return; }
    if (start === null) start = now;
    const t = ((now - start) % CYCLE_MS) / CYCLE_MS;
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
