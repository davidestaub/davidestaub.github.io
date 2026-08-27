// Point JWST at real stars and observe their planets.
(function () {
  const skyC = document.getElementById('sky-canvas');
  const lcC  = document.getElementById('obs-canvas');
  const card = document.getElementById('target-card');
  const countEl = document.getElementById('observed-count');
  const statusEl = document.getElementById('obs-status');
  if (!skyC || !lcC) return;

  const MONO = '"IBM Plex Mono", monospace';
  const OBS_MS = 4200;

  // Real targets. Depths are approximate true transit depths.
  const TARGETS = [
    {
      name: 'TRAPPIST-1', x: 0.16, y: 0.30, starR: 5, color: '#FF7A5C', type: 'M8 red dwarf', dist: '40 light-years',
      planet: 'TRAPPIST-1 e', depth: 0.006, dur: 'orbit: 6.1 days', year: 'discovered 2017',
      cls: 'terrestrial', img: 'planet-terrestrial.webp',
      fact: 'An Earth-sized world, one of seven rocky planets packed around a star barely bigger than Jupiter. It sits in the habitable zone, and JWST is currently testing whether it holds an atmosphere at all.'
    },
    {
      name: 'WASP-96', x: 0.34, y: 0.62, starR: 7, color: '#F5D98A', type: 'G8 sun-like star', dist: '1,150 light-years',
      planet: 'WASP-96 b', depth: 0.014, dur: 'orbit: 3.4 days', year: 'discovered 2014',
      cls: 'gas', img: 'planet-gas-giant.webp',
      fact: 'A hot, puffy Saturn. Its spectrum was in JWST’s very first science release in July 2022, showing a clear signature of water vapour and unexpectedly few clouds.'
    },
    {
      name: 'WASP-17', x: 0.50, y: 0.22, starR: 8, color: '#F7FAFF', type: 'F6 star, hotter than the Sun', dist: '1,300 light-years',
      planet: 'WASP-17 b', depth: 0.016, dur: 'orbit: 3.7 days', year: 'discovered 2009',
      cls: 'gas', img: 'planet-gas-giant.webp',
      fact: 'One of the puffiest planets known, nearly twice Jupiter’s size, orbiting backwards relative to its star’s spin. In 2023 JWST found evidence of quartz crystals in its clouds.'
    },
    {
      name: 'HD 209458', x: 0.68, y: 0.55, starR: 7, color: '#FFE9B8', type: 'G0 sun-like star', dist: '159 light-years',
      planet: 'HD 209458 b', depth: 0.015, dur: 'orbit: 3.5 days', year: 'discovered 1999',
      cls: 'gas', img: 'planet-gas-giant.webp',
      fact: 'The first planet ever seen in transit, and the first with a detected atmosphere (sodium, in 2001). Its outer layers are slowly boiling off into space.'
    },
    {
      name: '51 Pegasi', x: 0.84, y: 0.28, starR: 7, color: '#FFE9B8', type: 'G2 sun-like star', dist: '50 light-years',
      planet: '51 Pegasi b', depth: 0, dur: 'orbit: 4.2 days', year: 'discovered 1995',
      cls: 'gas', img: 'planet-gas-giant.webp', wobble: true,
      fact: 'The first planet found around a Sun-like star, a discovery that earned the 2019 Nobel Prize in Physics. From our vantage point it never crosses its star, so it was found by the wobble it induces in the star’s motion instead.'
    },
    {
      name: 'K2-18', x: 0.28, y: 0.82, starR: 5, color: '#FF9E6B', type: 'M2.5 red dwarf', dist: '124 light-years',
      planet: 'K2-18 b', depth: 0.0029, dur: 'orbit: 33 days', year: 'discovered 2015',
      cls: 'neptune', img: 'planet-neptune.webp',
      fact: 'A sub-Neptune in its star’s habitable zone. In 2023 JWST detected methane and carbon dioxide in its atmosphere, making it one of the most closely watched small planets in the sky.'
    },
    {
      name: 'WASP-76', x: 0.62, y: 0.85, starR: 8, color: '#F7FAFF', type: 'F7 star, hotter than the Sun', dist: '640 light-years',
      planet: 'WASP-76 b', depth: 0.011, dur: 'orbit: 1.8 days', year: 'discovered 2013',
      cls: 'gas', img: 'planet-gas-giant.webp',
      fact: 'An ultra-hot Jupiter, tidally locked to its star. The day side is hot enough to vaporise iron, which condenses on the cooler night side. On this planet, it likely rains liquid iron.'
    }
  ];

  const state = {
    ret: { x: 0.5, y: 0.5 },       // reticle position (fractions)
    target: null,                  // target being slewed to / observed
    obsT: 0,                       // ms of integration so far
    lcPts: [],                     // accumulated light-curve points
    observedCount: 0,
    done: false
  };

  const bgStars = Array.from({ length: 90 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 0.9 + 0.2, a: Math.random() * 0.35 + 0.05
  }));

  function fit(c, aspect) {
    const w = c.clientWidth || parseInt(c.getAttribute('width'), 10);
    const h = Math.round(w / aspect);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr; c.height = h * dpr; c.style.height = h + 'px';
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function setStatus(text) { if (statusEl) statusEl.innerHTML = text; }

  // ----------------------------------------------------------------
  // Sky panel
  // ----------------------------------------------------------------
  function drawSky() {
    const { ctx, w, h } = fit(skyC, 2.05);
    ctx.clearRect(0, 0, w, h);

    for (const s of bgStars) {
      ctx.fillStyle = 'rgba(247,250,255,' + s.a + ')';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const t of TARGETS) {
      const x = t.x * w, y = t.y * h;
      const g = ctx.createRadialGradient(x, y, 0, x, y, t.starR * 3.2);
      g.addColorStop(0, t.color);
      g.addColorStop(0.35, t.color + 'AA');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, t.starR * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(x, y, t.starR, 0, Math.PI * 2);
      ctx.fill();

      if (t.observed) {
        ctx.strokeStyle = 'rgba(245,179,36,0.9)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x, y, t.starR + 7, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = t.observed ? 'rgba(245,179,36,0.95)' : 'rgba(168,182,208,0.8)';
      ctx.font = '10px ' + MONO;
      ctx.textAlign = 'center';
      ctx.fillText(t.name.toUpperCase() + (t.observed ? ' ✓' : ''), x, y + t.starR + 22);
      ctx.textAlign = 'left';
    }

    // JWST reticle
    const rx = state.ret.x * w, ry = state.ret.y * h;
    ctx.strokeStyle = 'rgba(245,179,36,0.95)';
    ctx.lineWidth = 1.4;
    const R = 17;
    // hexagon (a nod to the mirror segments)
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const px = rx + R * Math.cos(a), py = ry + R * Math.sin(a);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    // crosshair ticks
    ctx.beginPath();
    ctx.moveTo(rx - R - 7, ry); ctx.lineTo(rx - R + 2, ry);
    ctx.moveTo(rx + R - 2, ry); ctx.lineTo(rx + R + 7, ry);
    ctx.moveTo(rx, ry - R - 7); ctx.lineTo(rx, ry - R + 2);
    ctx.moveTo(rx, ry + R - 2); ctx.lineTo(rx, ry + R + 7);
    ctx.stroke();

    ctx.fillStyle = 'rgba(168,182,208,0.85)';
    ctx.font = '11px ' + MONO;
    ctx.fillText('JWST TARGET FIELD · CLICK A STAR TO SLEW', 12, 20);
  }

  // ----------------------------------------------------------------
  // Instrument panel (light curve)
  // ----------------------------------------------------------------
  function drawObs() {
    const { ctx, w, h } = fit(lcC, 2.6);
    ctx.clearRect(0, 0, w, h);

    const padL = 52, padR = 14, padT = 28, padB = 30;
    const iw = w - padL - padR, ih = h - padT - padB;

    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.strokeRect(padL, padT, iw, ih);

    ctx.fillStyle = 'rgba(168,182,208,0.85)';
    ctx.font = '11px ' + MONO;
    ctx.fillText('LIGHT METER', padL, 18);
    ctx.fillText('time →', padL + iw - 44, h - 10);

    const t = state.target;
    if (!t || (!state.lcPts.length)) {
      ctx.fillStyle = 'rgba(107,122,153,0.9)';
      ctx.fillText('waiting for a target', padL + 12, padT + ih / 2);
      return;
    }

    // y-scale zoomed to this target's dip (with a floor for near-flat curves)
    const span = Math.max(t.depth * 1.7, 0.004);
    const yOf = f => padT + (1 + span * 0.25 - f) / (span * 1.25) * ih;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, yOf(1));
    ctx.lineTo(padL + iw, yOf(1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(107,122,153,0.9)';
    ctx.fillText('100%', padL + 4, yOf(1) - 5);

    for (const p of state.lcPts) {
      ctx.fillStyle = 'rgba(53,214,255,0.85)';
      ctx.beginPath();
      ctx.arc(padL + p.u * iw, yOf(p.f), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    if (t.observed && !t.wobble) {
      ctx.fillStyle = '#F5B324';
      ctx.fillText('dip: ' + (t.depth * 100).toFixed(2) + '%', padL + 6, padT + 16);
    }
    if (t.observed && t.wobble) {
      ctx.fillStyle = '#F5B324';
      ctx.fillText('no transit detected', padL + 6, padT + 16);
    }
  }

  // model flux during the observation window
  function modelFlux(u, t) {
    if (t.wobble) return 1;
    const i0 = 0.32, i1 = 0.40, e0 = 0.60, e1 = 0.68;   // ingress / egress
    if (u < i0 || u > e1) return 1;
    if (u < i1) return 1 - t.depth * (u - i0) / (i1 - i0);
    if (u < e0) return 1 - t.depth;
    return 1 - t.depth * (e1 - u) / (e1 - e0);
  }

  // ----------------------------------------------------------------
  // Target card
  // ----------------------------------------------------------------
  function showCard(t) {
    if (!card) return;
    card.innerHTML =
      '<div class="tc-head">' +
        '<img src="assets/img/' + t.img + '" alt="Artist’s render of ' + t.planet + '">' +
        '<div>' +
          '<p class="eyebrow" style="margin:0 0 0.2rem">' + t.year + '</p>' +
          '<h3 style="margin:0">' + t.planet + '</h3>' +
          '<p class="tc-meta">' + t.type + ' · ' + t.dist + ' · ' + t.dur + '</p>' +
        '</div>' +
      '</div>' +
      '<p class="tc-fact">' + t.fact + '</p>';
    card.classList.add('show');
  }

  // ----------------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------------
  function pick(clientX, clientY) {
    const r = skyC.getBoundingClientRect();
    const fx = (clientX - r.left) / r.width;
    const fy = (clientY - r.top) / r.height;
    let best = null, bestD = 1e9;
    for (const t of TARGETS) {
      const d = Math.hypot(fx - t.x, fy - t.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return bestD < 0.09 ? best : null;
  }

  skyC.addEventListener('click', (e) => {
    const t = pick(e.clientX, e.clientY);
    if (!t) { setStatus('No target there. Click one of the labelled stars.'); return; }
    if (state.target === t && (state.obsT > 0 || t.observed)) return;
    state.target = t;
    state.obsT = 0;
    state.lcPts = [];
    setStatus('Slewing to <strong>' + t.name + '</strong>…');
  });

  // ----------------------------------------------------------------
  // Main loop
  // ----------------------------------------------------------------
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(60, now - last);
    last = now;

    const t = state.target;
    if (t) {
      // slew reticle toward target
      const dx = t.x - state.ret.x, dy = t.y - state.ret.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.004) {
        const step = Math.min(dist, 0.0012 * dt);
        state.ret.x += dx / dist * step;
        state.ret.y += dy / dist * step;
      } else if (!t.observed && state.obsT < OBS_MS) {
        // integrate
        if (state.obsT === 0) setStatus('Locked on <strong>' + t.name + '</strong>. Observing…');
        state.obsT += dt;
        const u = Math.min(1, state.obsT / OBS_MS);
        const noise = (Math.random() - 0.5) * (t.wobble ? 0.0012 : Math.max(t.depth * 0.10, 0.0008));
        state.lcPts.push({ u: u, f: modelFlux(u, t) + noise });
        if (u >= 1) {
          t.observed = true;
          state.observedCount = TARGETS.filter(x => x.observed).length;
          if (countEl) countEl.textContent = state.observedCount;
          showCard(t);
          if (t.wobble) {
            setStatus('Flat! <strong>' + t.planet + '</strong> never crosses its star from our point of view. It was discovered through the wobble of its star instead.');
          } else {
            setStatus('Transit captured: <strong>' + t.planet + '</strong> blocks ' +
                      (t.depth * 100).toFixed(2) + '% of its star’s light.');
          }
          if (state.observedCount === TARGETS.length && !state.done) {
            state.done = true;
            setStatus('All ' + TARGETS.length + ' targets observed. These are real planets, and everything on their cards comes from real measurements. Well done.');
          }
        }
      }
    }

    drawSky();
    drawObs();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
