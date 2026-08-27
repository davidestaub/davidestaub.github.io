// Interactive transit + transmission-spectrum demo for the blog explainer.
(function () {
  const orbitC = document.getElementById('orbit-canvas');
  const lcC    = document.getElementById('lc-canvas');
  const specC  = document.getElementById('spec-canvas');
  if (!orbitC || !lcC || !specC) return;

  // ------------------------------------------------------------------
  // Animated counter in the hero
  // ------------------------------------------------------------------
  const counter = document.getElementById('count-worlds');
  if (counter) {
    const target = 6000;
    const t0 = performance.now();
    (function tick(now) {
      const p = Math.min(1, (now - t0) / 2200);
      const eased = 1 - Math.pow(1 - p, 3);
      counter.textContent = Math.round(target * eased).toLocaleString('en-US') + (p === 1 ? '+' : '');
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }

  // ------------------------------------------------------------------
  // Model
  // ------------------------------------------------------------------
  const state = {
    rpJup: 1.0,          // planet radius in Jupiter radii
    wl: 1.0,             // wavelength in microns
    atm: true,           // atmosphere on/off
    phase: 0,            // orbital phase 0..1
    scan: null,          // {t0} while scanning
    specPoints: []       // measured {wl, depth}
  };

  const R_RATIO = 0.10045;      // R_jup / R_sun
  const B_IMPACT = 0.25;        // impact parameter (fraction of Rs)
  const WL_MIN = 0.6, WL_MAX = 2.8;

  function gauss(x, mu, sig) { return Math.exp(-0.5 * Math.pow((x - mu) / sig, 2)); }

  // Fractional radius boost from the atmosphere at wavelength wl (0 → none).
  function atmBoost(wl) {
    if (!state.atm) return 0;
    const bands =
      1.00 * gauss(wl, 1.40, 0.09) +
      0.85 * gauss(wl, 1.90, 0.13) +
      0.75 * gauss(wl, 2.70, 0.16) +
      0.20 * gauss(wl, 2.32, 0.07);
    const rayleigh = 0.30 * Math.exp(-(wl - WL_MIN) / 0.45);
    return 0.055 * (bands + rayleigh);
  }

  function rRatioEff(wl) { return R_RATIO * state.rpJup * (1 + atmBoost(wl)); }
  function depthAt(wl)   { const r = rRatioEff(wl); return r * r; }   // fraction of light blocked

  // Overlap area of planet disk (radius r) with star disk (radius 1), centres d apart.
  function overlap(r, d) {
    if (d >= 1 + r) return 0;
    if (d <= 1 - r) return Math.PI * r * r;
    const a = r * r * Math.acos((d * d + r * r - 1) / (2 * d * r)) +
              Math.acos((d * d + 1 - r * r) / (2 * d)) -
              0.5 * Math.sqrt((-d + r + 1) * (d + r - 1) * (d - r + 1) * (d + r + 1));
    return a;
  }

  // Relative flux at orbital phase p (planet crosses -1.7..1.7 Rs during p 0.15..0.85).
  function fluxAt(p, wl) {
    const x = -1.7 + 3.4 * ((p - 0.15) / 0.7);
    if (p < 0.15 || p > 0.85) return 1;
    const r = rRatioEff(wl);
    const d = Math.sqrt(x * x + B_IMPACT * B_IMPACT);
    return 1 - overlap(r, d) / Math.PI;
  }

  // Map wavelength → display colour (stylised: visible→gold, deeper IR→red→purple).
  function wlColor(wl, alpha) {
    const t = (wl - WL_MIN) / (WL_MAX - WL_MIN);
    let r, g, b;
    if (t < 0.33)      { const u = t / 0.33;        r = 245; g = 205 - 90 * u;  b = 60 + 20 * u; }
    else if (t < 0.66) { const u = (t - 0.33) / 0.33; r = 245 - 60 * u; g = 115 - 45 * u; b = 80 + 100 * u; }
    else               { const u = (t - 0.66) / 0.34; r = 185 - 16 * u; g = 70 + 42 * u;  b = 180 + 75 * u; }
    return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + alpha + ')';
  }

  // ------------------------------------------------------------------
  // Canvas helpers (retina-aware, responsive)
  // ------------------------------------------------------------------
  function fit(c, aspect) {
    const w = c.clientWidth || parseInt(c.getAttribute('width'), 10);
    const h = Math.round(w / aspect);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
      c.style.height = h + 'px';
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  const MONO = '"IBM Plex Mono", monospace';

  // Static background stars for the orbit view
  const bgStars = Array.from({ length: 70 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 1.1 + 0.3, a: Math.random() * 0.5 + 0.15
  }));

  // ------------------------------------------------------------------
  // Panels
  // ------------------------------------------------------------------
  function drawOrbit() {
    const { ctx, w, h } = fit(orbitC, 520 / 330);
    ctx.clearRect(0, 0, w, h);

    for (const s of bgStars) {
      ctx.fillStyle = 'rgba(247,250,255,' + s.a + ')';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const cx = w / 2, cy = h / 2;
    const Rs = Math.min(w, h) * 0.30;

    // star with soft limb-darkened glow
    let g = ctx.createRadialGradient(cx, cy, Rs * 0.1, cx, cy, Rs * 1.7);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.45, 'rgba(245,179,36,0.95)');
    g.addColorStop(0.62, 'rgba(242,140,60,0.55)');
    g.addColorStop(1, 'rgba(238,100,42,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, Rs * 1.7, 0, Math.PI * 2);
    ctx.fill();

    // planet
    const p = state.phase;
    const x = cx + (-1.7 + 3.4 * ((Math.max(0.15, Math.min(0.85, p)) - 0.15) / 0.7)) * Rs;
    const wrapX = p < 0.15 ? cx - 1.7 * Rs - (0.15 - p) / 0.15 * w * 0.25
                : p > 0.85 ? cx + 1.7 * Rs + (p - 0.85) / 0.15 * w * 0.25
                : x;
    const y = cy + B_IMPACT * Rs;
    const rp = R_RATIO * state.rpJup * Rs;

    if (state.atm) {
      const ra = rp * (1 + 8 * atmBoost(state.wl));   // exaggerate ring for visibility
      const ag = ctx.createRadialGradient(wrapX, y, rp * 0.85, wrapX, y, ra + rp * 0.6);
      ag.addColorStop(0, wlColor(state.wl, 0.55));
      ag.addColorStop(1, wlColor(state.wl, 0));
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(wrapX, y, ra + rp * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#05070F';
    ctx.strokeStyle = 'rgba(168,182,208,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(wrapX, y, rp, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(168,182,208,0.85)';
    ctx.font = '11px ' + MONO;
    ctx.fillText('THE VIEW FROM THE TELESCOPE', 12, 20);
  }

  function drawLightCurve() {
    const { ctx, w, h } = fit(lcC, 520 / 330);
    ctx.clearRect(0, 0, w, h);

    const padL = 46, padR = 14, padT = 30, padB = 34;
    const iw = w - padL - padR, ih = h - padT - padB;

    const maxDepth = 0.037;                    // fixed y-scale: 0.5 Rjup..1.8 Rjup fits
    const yOf = f => padT + (1.004 - f) / (1.004 - (1 - maxDepth)) * ih;
    const xOf = p => padL + p * iw;

    // frame
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, iw, ih);

    // reference 100% line
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, yOf(1));
    ctx.lineTo(padL + iw, yOf(1));
    ctx.stroke();
    ctx.setLineDash([]);

    // full model curve
    ctx.strokeStyle = wlColor(state.wl, 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 220; i++) {
      const p = i / 220;
      const f = fluxAt(p, state.wl);
      i === 0 ? ctx.moveTo(xOf(p), yOf(f)) : ctx.lineTo(xOf(p), yOf(f));
    }
    ctx.stroke();

    // moving marker
    const f = fluxAt(state.phase, state.wl);
    ctx.fillStyle = '#F7FAFF';
    ctx.beginPath();
    ctx.arc(xOf(state.phase), yOf(f), 4, 0, Math.PI * 2);
    ctx.fill();

    // labels
    ctx.fillStyle = 'rgba(168,182,208,0.85)';
    ctx.font = '11px ' + MONO;
    ctx.fillText('BRIGHTNESS OF THE STAR', padL, 20);
    ctx.fillText('time →', padL + iw - 46, h - 12);
    ctx.save();
    ctx.translate(14, padT + ih / 2 + 30);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('flux', 0, 0);
    ctx.restore();
    ctx.fillText('100%', padL + 4, yOf(1) - 5);

    const d = depthAt(state.wl);
    ctx.fillStyle = '#F5B324';
    ctx.fillText('dip: ' + (d * 100).toFixed(2) + '%', padL + 4, padT + 14);
  }

  function drawSpectrum() {
    const { ctx, w, h } = fit(specC, 1060 / 300);
    ctx.clearRect(0, 0, w, h);

    const padL = 56, padR = 16, padT = 26, padB = 36;
    const iw = w - padL - padR, ih = h - padT - padB;

    // y-range centred on the airless depth for the current planet size
    const base = R_RATIO * state.rpJup;
    const d0 = base * base;
    const dMin = d0 * 0.96, dMax = d0 * 1.16;
    const xOf = wl => padL + (wl - WL_MIN) / (WL_MAX - WL_MIN) * iw;
    const yOf = d => padT + (dMax - d) / (dMax - dMin) * ih;

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(padL, padT, iw, ih);

    // rainbow strip along the x-axis
    for (let i = 0; i < iw; i++) {
      const wl = WL_MIN + (i / iw) * (WL_MAX - WL_MIN);
      ctx.fillStyle = wlColor(wl, 0.55);
      ctx.fillRect(padL + i, padT + ih + 6, 1, 5);
    }

    // x labels
    ctx.fillStyle = 'rgba(168,182,208,0.85)';
    ctx.font = '11px ' + MONO;
    for (const wl of [0.6, 1.0, 1.4, 1.8, 2.2, 2.6]) {
      ctx.fillText(wl.toFixed(1), xOf(wl) - 8, h - 8);
    }
    ctx.fillText('wavelength (µm)', padL + iw / 2 - 50, h - 22);
    ctx.save();
    ctx.translate(16, padT + ih / 2 + 44);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('transit depth', 0, 0);
    ctx.restore();
    ctx.fillText('THE TRANSMISSION SPECTRUM', padL, 16);

    // faint true curve as a hint once scanning has begun
    if (state.specPoints.length > 3) {
      ctx.strokeStyle = 'rgba(247,250,255,0.18)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 200; i++) {
        const wl = WL_MIN + (i / 200) * (WL_MAX - WL_MIN);
        const y = yOf(depthAt(wl));
        i === 0 ? ctx.moveTo(xOf(wl), y) : ctx.lineTo(xOf(wl), y);
      }
      ctx.stroke();
    }

    // measured points
    for (const pt of state.specPoints) {
      ctx.fillStyle = wlColor(pt.wl, 0.95);
      ctx.beginPath();
      ctx.arc(xOf(pt.wl), yOf(pt.depth), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // current-wavelength marker
    ctx.strokeStyle = wlColor(state.wl, 0.8);
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(xOf(state.wl), padT);
    ctx.lineTo(xOf(state.wl), padT + ih);
    ctx.stroke();
    ctx.setLineDash([]);

    const dNow = depthAt(state.wl);
    ctx.fillStyle = '#F7FAFF';
    ctx.beginPath();
    ctx.arc(xOf(state.wl), yOf(dNow), 4.5, 0, Math.PI * 2);
    ctx.fill();

    // annotate water bands once revealed
    if (state.specPoints.length > 30 && state.atm) {
      ctx.fillStyle = 'rgba(53,214,255,0.9)';
      ctx.font = '12px ' + MONO;
      ctx.fillText('H₂O', xOf(1.4) - 12, yOf(depthAt(1.4)) - 12);
      ctx.fillText('H₂O', xOf(1.9) - 12, yOf(depthAt(1.9)) - 12);
    }
  }

  // ------------------------------------------------------------------
  // Captions
  // ------------------------------------------------------------------
  const caption = document.getElementById('demo-caption');
  function say(html) { if (caption) caption.innerHTML = html; }

  function describeCurrent() {
    const d = (depthAt(state.wl) * 100).toFixed(2);
    if (!state.atm) {
      return 'Atmosphere off: a bare rock blocks the same light at every colour — ' +
             'the dip is <strong>' + d + '%</strong> everywhere, and the spectrum is flat.';
    }
    const boost = atmBoost(state.wl);
    if (boost > 0.028) {
      return 'At <strong>' + state.wl.toFixed(2) + ' µm</strong> the atmosphere absorbs strongly ' +
             '(hello, water vapour!) — the planet looks bigger, and the dip deepens to <strong>' + d + '%</strong>.';
    }
    return 'At <strong>' + state.wl.toFixed(2) + ' µm</strong> the air is fairly transparent — ' +
           'the dip is <strong>' + d + '%</strong>. Try sliding towards 1.4 µm…';
  }

  // ------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------
  const rpSlider = document.getElementById('rp-slider');
  const wlSlider = document.getElementById('wl-slider');
  const atmToggle = document.getElementById('atm-toggle');
  const rpVal = document.getElementById('rp-val');
  const wlVal = document.getElementById('wl-val');
  const scanBtn = document.getElementById('scan-btn');
  const resetBtn = document.getElementById('reset-btn');

  rpSlider.addEventListener('input', () => {
    state.rpJup = parseFloat(rpSlider.value);
    rpVal.innerHTML = state.rpJup.toFixed(2) + ' R<sub>Jup</sub>';
    state.specPoints = [];   // new planet, new spectrum
    say('Planet size: <strong>' + state.rpJup.toFixed(2) + ' R<sub>Jup</sub></strong> — the dip is now <strong>' +
        (depthAt(state.wl) * 100).toFixed(2) + '%</strong>. Depth scales with the planet’s area: double the radius, four times the dip.');
  });

  wlSlider.addEventListener('input', () => {
    state.wl = parseFloat(wlSlider.value);
    wlVal.textContent = state.wl.toFixed(2) + ' µm';
    if (!state.scan) {
      state.specPoints.push({ wl: state.wl, depth: depthAt(state.wl) });
      if (state.specPoints.length > 400) state.specPoints.shift();
    }
    say(describeCurrent());
  });

  atmToggle.addEventListener('change', () => {
    state.atm = atmToggle.checked;
    state.specPoints = [];
    say(state.atm
      ? 'Atmosphere on: a thin envelope of gas now wraps the planet. Its opacity depends on the colour of light — scan the wavelength slider to see it.'
      : 'Atmosphere off: a bare, airless world. Watch the spectrum go completely flat.');
  });

  scanBtn.addEventListener('click', () => {
    if (state.scan) return;
    state.specPoints = [];
    state.scan = { t0: performance.now() };
    scanBtn.disabled = true;
    scanBtn.style.opacity = 0.5;
    say('Scanning the rainbow: measuring the transit depth at every wavelength, one colour at a time…');
  });

  resetBtn.addEventListener('click', () => {
    state.specPoints = [];
    state.scan = null;
    scanBtn.disabled = false;
    scanBtn.style.opacity = 1;
    rpSlider.value = 1.0; rpSlider.dispatchEvent(new Event('input'));
    wlSlider.value = 1.0; wlSlider.dispatchEvent(new Event('input'));
    if (!atmToggle.checked) { atmToggle.checked = true; atmToggle.dispatchEvent(new Event('change')); }
    state.specPoints = [];
    say('Reset. The planet blocks <strong>' + (depthAt(state.wl) * 100).toFixed(2) +
        '%</strong> of the starlight. Play with the sliders, then scan the rainbow.');
  });

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  const SCAN_MS = 5000;
  let last = performance.now();

  function loop(now) {
    const dt = Math.min(50, now - last);
    last = now;
    state.phase = (state.phase + dt / 6000) % 1;

    if (state.scan) {
      const u = Math.min(1, (now - state.scan.t0) / SCAN_MS);
      const wl = WL_MIN + u * (WL_MAX - WL_MIN);
      state.wl = wl;
      wlSlider.value = wl;
      wlVal.textContent = wl.toFixed(2) + ' µm';
      state.specPoints.push({ wl: wl, depth: depthAt(wl) });
      if (u >= 1) {
        state.scan = null;
        scanBtn.disabled = false;
        scanBtn.style.opacity = 1;
        say(state.atm
          ? 'Done — that curve is a <strong>transmission spectrum</strong>. The two big bumps are water vapour ' +
            'absorbing at 1.4 and 1.9 µm. From dips in starlight to chemistry: that’s the whole trick.'
          : 'Done — perfectly flat. No atmosphere means no fingerprint: every colour sees the same opaque rock. ' +
            'Switch the atmosphere on and scan again!');
      }
    }

    drawOrbit();
    drawLightCurve();
    drawSpectrum();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
