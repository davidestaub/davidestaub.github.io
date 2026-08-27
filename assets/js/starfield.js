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
  let els = Array.from(document.querySelectorAll('.bubble, .reveal'));
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
