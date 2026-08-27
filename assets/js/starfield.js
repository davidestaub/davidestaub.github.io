// Subtle twinkling starfield behind every page.
(function () {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // star positions are stored as 0..1 fractions so a resize (for example the
  // mobile URL bar collapsing) rescales the pattern instead of re-rolling it
  const n = Math.min(110, Math.floor(window.innerWidth * window.innerHeight / 22000));
  const stars = Array.from({ length: n }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 0.9 + 0.3,
    a: Math.random() * 0.3 + 0.08,
    tw: Math.random() * 0.12 + 0.036,
    ph: Math.random() * Math.PI * 2
  }));
  const blue = new Set();
  stars.forEach((s, i) => { if (Math.random() < 0.06) blue.add(i); });

  function size() {
    canvas.width = Math.round(window.innerWidth * devicePixelRatio);
    canvas.height = Math.round(window.innerHeight * devicePixelRatio);
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // At the foot of the page, the Great Square of Pegasus quietly joins up
  // and a small gold ring marks 51 Peg, the planet that started the field.
  const SQ = [[0.885, 0.665], [0.755, 0.695], [0.775, 0.865], [0.900, 0.845]];
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const PEG51 = [0.715, 0.795];
  let cTarget = 0, cA = 0;
  const footer = document.querySelector('footer');
  if (footer && 'IntersectionObserver' in window) {
    new IntersectionObserver(es => {
      cTarget = es[0].isIntersecting ? 1 : 0;
      if (reduced) { cA = cTarget; draw(0); }
    }, { threshold: 0.35 }).observe(footer);
  }

  function drawConstellation() {
    if (window.innerWidth < 760) return;
    cA += (cTarget - cA) * (reduced ? 1 : 0.045);
    if (cA < 0.01) return;
    const d = devicePixelRatio, W = canvas.width, H = canvas.height;
    ctx.lineWidth = d;
    ctx.strokeStyle = 'rgba(111,168,255,' + (0.22 * cA).toFixed(3) + ')';
    EDGES.forEach(([i, j]) => {
      ctx.beginPath();
      ctx.moveTo(SQ[i][0] * W, SQ[i][1] * H);
      ctx.lineTo(SQ[j][0] * W, SQ[j][1] * H);
      ctx.stroke();
    });
    ctx.fillStyle = 'rgba(247,250,255,' + (0.85 * cA).toFixed(3) + ')';
    SQ.forEach(p => { ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, 1.6 * d, 0, 7); ctx.fill(); });
    ctx.beginPath(); ctx.arc(PEG51[0] * W, PEG51[1] * H, 1.1 * d, 0, 7);
    ctx.fillStyle = 'rgba(245,217,138,' + (0.9 * cA).toFixed(3) + ')'; ctx.fill();
    ctx.beginPath(); ctx.arc(PEG51[0] * W, PEG51[1] * H, 5 * d, 0, 7);
    ctx.strokeStyle = 'rgba(245,179,36,' + (0.6 * cA).toFixed(3) + ')'; ctx.stroke();
    ctx.font = (10 * d) + 'px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(107,122,153,' + (0.9 * cA).toFixed(3) + ')';
    ctx.fillText('51 Peg', PEG51[0] * W + 9 * d, PEG51[1] * H + 3 * d);
  }

  function draw(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const t = (now || 0) / 1000;
    stars.forEach((s, i) => {
      const a = reduced ? s.a : s.a * (0.82 + 0.18 * Math.sin(t * s.tw + s.ph));
      ctx.fillStyle = 'rgba(' + (blue.has(i) ? '111,168,255' : '247,250,255') + ',' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s.x * canvas.width, s.y * canvas.height, s.r * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    });
    drawConstellation();
    if (!reduced) requestAnimationFrame(draw);
  }

  size();
  requestAnimationFrame(draw);
  if (reduced) draw(0);
  window.addEventListener('resize', () => { size(); if (reduced) draw(0); });
})();

// Reveal .bubble and .reveal elements as they scroll into view.
(function () {
  let els = Array.from(document.querySelectorAll('.bubble, .reveal, .reveal-group, .tl-item'));
  function check() {
    const vh = window.innerHeight;
    els = els.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.92 && r.bottom > 0) {
        el.classList.add('visible');
        return false;
      }
      return true;
    });
    if (!els.length) {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    }
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  window.addEventListener('load', check);
  check();
})();


// Reading progress in the nav, drawn as a transit light curve.
(function () {
  const c = document.querySelector('.nav-transit');
  if (!c) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), W = 120, H = 26;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  function shape(u) {
    if (u < 0.20 || u > 0.80) return 0;
    if (u < 0.32) return (u - 0.20) / 0.12;
    if (u > 0.68) return (0.80 - u) / 0.12;
    return 1;
  }
  const y = u => 7.5 + shape(u) * 10;
  function draw() {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    ctx.clearRect(0, 0, W, H);
    [[0, p, 'rgba(245,179,36,0.9)'], [p, 1, 'rgba(247,250,255,0.16)']].forEach(([a, b, col]) => {
      ctx.beginPath();
      for (let u = a; u <= b + 1e-4; u += 0.01) ctx.lineTo(4 + u * (W - 8), y(u));
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.arc(4 + p * (W - 8), y(p), 3, 0, Math.PI * 2);
    ctx.fillStyle = '#04060F';
    ctx.fill();
    ctx.strokeStyle = 'rgba(168,182,208,0.9)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  addEventListener('scroll', draw, { passive: true });
  addEventListener('resize', draw);
  draw();
})();
