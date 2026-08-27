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
