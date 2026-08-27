// Subtle twinkling starfield behind every page.
(function () {
  const canvas = document.getElementById('starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let stars = [];

  function build() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    const n = Math.min(110, Math.floor(window.innerWidth * window.innerHeight / 22000));
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() * 0.9 + 0.3) * devicePixelRatio,
      a: Math.random() * 0.3 + 0.08,
      tw: Math.random() * 0.002 + 0.0006,
      ph: Math.random() * Math.PI * 2,
      hue: Math.random() < 0.06 ? '111,168,255' : '247,250,255'
    }));
  }

  let t = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    t += 1;
    for (const s of stars) {
      const a = reduced ? s.a : s.a * (0.82 + 0.18 * Math.sin(t * s.tw * 60 + s.ph));
      ctx.fillStyle = 'rgba(' + s.hue + ',' + a.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(draw);
  }

  build();
  draw();
  window.addEventListener('resize', () => { build(); if (reduced) draw(); });
})();

// Reveal .bubble elements (and anything with .reveal) as they scroll into view.
(function () {
  const els = document.querySelectorAll('.bubble, .reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach(e => e.classList.add('visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        en.target.classList.add('visible');
        io.unobserve(en.target);
      }
    });
  }, { threshold: 0.25 });
  els.forEach(e => io.observe(e));
})();
