/* ===================================================================
   explore/lib/warp.js : the warp between systems

   A field of star streaks in a cylinder around the camera's view axis,
   drawn additively at the scene origin (the camera sits at the origin
   under the floating origin scheme) and oriented each frame from the
   camera's quaternion, plus a subtle overlay flash and a factual line
   of text. Timeline:
     spool   0.6 s   streaks fade in and start to stretch, text 'charging'
     streaks 1.4 s   full stretch, brightness rises to the peak
     peak            await onMidpoint() (the caller swaps the system);
                     the field and the flash hold at their peak meanwhile
     decel   1.0 s   streaks shorten and fade, flash fades
   prefers-reduced-motion: no streaks; a short dark crossfade instead.

   The overlay reads 'warp: A to B · N ly · light would take N years'.
   Nothing about the crossing is invented: the years are the light
   travel time, and no ship speed is implied by the animation.

   This module does NOT import three; the page passes THREE in.
   =================================================================== */

const N_STREAKS = 600;
const SPOOL_S = 0.6;
const STREAK_S = 1.4;
const DECEL_S = 1.0;
const REDUCED_FADE_S = 0.35;
const REDUCED_HOLD_S = 0.9;

// cylinder around the view axis, scene units (1 unit = 1,000 km); the
// camera near plane is 0.01 so anything past a few units is safe
const R_MIN = 0.35, R_MAX = 9.0;
const Z_NEAR = 2.0, Z_FAR = 60.0;

const STYLE_ID = 'warp-overlay-style';
const CSS = `
.warp-flash { position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(ellipse at center, rgba(228, 240, 255, 0.95) 0%, rgba(160, 205, 255, 0.55) 22%, rgba(53, 214, 255, 0.10) 48%, rgba(4, 6, 15, 0) 72%); }
.warp-dark { position: absolute; inset: 0; pointer-events: none; opacity: 0; background: #04060F; }
.warp-text { position: absolute; left: 50%; top: 72%; transform: translate(-50%, -50%); pointer-events: none;
  font: 12px/1.6 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em;
  color: #F5B324; text-align: center; opacity: 0; text-shadow: 0 0 8px rgba(4, 6, 15, 0.9), 0 0 2px rgba(4, 6, 15, 1); white-space: nowrap; }
.warp-text .warp-phase { display: block; color: rgba(217, 221, 232, 0.75); font-size: 11px; }
@media (max-width: 600px) { .warp-text { font-size: 11px; white-space: normal; max-width: 90vw; } }
`;

const VERT = /* glsl */`
  attribute float aEnd;      // 0 = head (nearest the camera), 1 = tail
  attribute float aSeed;     // 0..1 per streak
  attribute float aRadius;   // 0..1 normalised radius in the cylinder
  uniform float uTime;
  uniform float uStretch;    // tail length, units
  uniform float uSpeed;      // units per second along +z (toward the camera)
  uniform float uZNear;
  uniform float uZRange;
  varying float vAlong;
  varying float vRadius;
  varying float vSeed;
  void main() {
    // each streak slides toward the camera and wraps inside [-(zNear+range), -zNear]
    float travel = mod(aSeed * uZRange + uTime * uSpeed * (0.6 + 0.8 * aSeed), uZRange);
    float zHead = -uZNear - (uZRange - travel);
    float len = uStretch * (0.5 + aSeed);
    vec3 p = position;
    p.z = zHead - aEnd * len;
    vAlong = aEnd;
    vRadius = aRadius;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  uniform float uAlpha;
  varying float vAlong;
  varying float vRadius;
  varying float vSeed;
  void main() {
    // white-blue streaks, a faint gold core for the innermost ones
    vec3 blue = vec3(0.80, 0.90, 1.00);
    vec3 gold = vec3(1.00, 0.78, 0.32);
    float core = 1.0 - smoothstep(0.0, 0.22, vRadius);
    vec3 c = mix(blue, gold, core * 0.55);
    // bright head, transparent tail
    float a = (1.0 - vAlong) * (1.0 - vAlong);
    a *= 0.35 + 0.65 * vSeed;
    gl_FragColor = vec4(c * a * uAlpha, a * uAlpha);
  }
`;

function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }
function fmtNum(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 10) return n.toFixed(1).replace(/\.0$/, '');
  if (n < 100) return n.toFixed(1).replace(/\.0$/, '');
  return Math.round(n).toLocaleString('en-GB');
}
function nextFrame() { return new Promise((r) => requestAnimationFrame(r)); }

/**
 * @param THREE the three.js namespace
 * @param {{ scene: THREE.Scene, camera: THREE.Camera, overlayEl: HTMLElement }} opts
 *   overlayEl: a positioned element over the 3D stage; the warp adds its
 *   flash and text children to it and leaves them hidden between warps.
 *   reducedMotion (optional boolean): force the crossfade path on or off;
 *   when omitted the prefers-reduced-motion media query decides.
 */
export function createWarp(THREE, { scene, camera, overlayEl, reducedMotion }) {
  /* ---- streak field, built once ---- */
  const pos = new Float32Array(N_STREAKS * 2 * 3);
  const end = new Float32Array(N_STREAKS * 2);
  const seed = new Float32Array(N_STREAKS * 2);
  const rad = new Float32Array(N_STREAKS * 2);
  for (let i = 0; i < N_STREAKS; i++) {
    // area-uniform in the annulus, a few more near the axis for the core
    const u = Math.random();
    const r = R_MIN + (R_MAX - R_MIN) * Math.pow(u, 0.8);
    const a = Math.random() * Math.PI * 2;
    const x = r * Math.cos(a), y = r * Math.sin(a);
    const s = Math.random();
    const rn = (r - R_MIN) / (R_MAX - R_MIN);
    for (let k = 0; k < 2; k++) {
      const v = i * 2 + k;
      pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = -Z_NEAR;
      end[v] = k;
      seed[v] = s;
      rad[v] = rn;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geom.setAttribute('aRadius', new THREE.BufferAttribute(rad, 1));
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -Z_FAR * 0.5), Z_FAR);

  const uniforms = {
    uTime: { value: 0 },
    uStretch: { value: 0 },
    uSpeed: { value: 0 },
    uAlpha: { value: 0 },
    uZNear: { value: Z_NEAR },
    uZRange: { value: Z_FAR - Z_NEAR },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const streaks = new THREE.LineSegments(geom, mat);
  streaks.frustumCulled = false;
  streaks.renderOrder = 1000;
  streaks.visible = false;
  streaks.name = 'warp-streaks';
  scene.add(streaks);

  /* ---- overlay ---- */
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const flash = document.createElement('div');
  flash.className = 'warp-flash';
  const dark = document.createElement('div');
  dark.className = 'warp-dark';
  const text = document.createElement('div');
  text.className = 'warp-text';
  text.setAttribute('role', 'status');
  const line = document.createElement('span');
  const phase = document.createElement('span');
  phase.className = 'warp-phase';
  text.appendChild(line);
  text.appendChild(phase);
  if (overlayEl) {
    overlayEl.appendChild(dark);
    overlayEl.appendChild(flash);
    overlayEl.appendChild(text);
  }

  // reducedMotion: true/false forces the path; undefined follows the media query
  const reduced = typeof reducedMotion === 'boolean'
    ? { matches: reducedMotion }
    : (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false });

  let active = false;
  let seq = 0;

  function setOverlay(flashA, darkA, textA, phaseText) {
    flash.style.opacity = flashA.toFixed(3);
    dark.style.opacity = darkA.toFixed(3);
    text.style.opacity = textA.toFixed(3);
    if (phaseText != null) phase.textContent = phaseText;
  }

  function describe(fromName, toName, distanceLy) {
    const ly = Number(distanceLy);
    const parts = ['warp: ' + (fromName || '?') + ' to ' + (toName || '?')];
    if (Number.isFinite(ly)) {
      parts.push(fmtNum(ly) + ' ly');
      parts.push('light would take ' + fmtNum(ly) + (ly === 1 ? ' year' : ' years'));
    } else {
      parts.push('distance not catalogued');
    }
    return parts.join(' · ');
  }

  // per-frame: keep the field on the camera and oriented with it
  function follow() {
    streaks.position.copy(camera.position);
    streaks.quaternion.copy(camera.quaternion);
  }

  async function runFull(opts, mySeq) {
    const start = performance.now();
    streaks.visible = true;
    uniforms.uTime.value = 0;
    let midpointDone = false;
    let midpointPromise = null;
    let holdStart = 0; // when the peak began
    let holdOffset = 0; // total time spent holding at the peak

    while (mySeq === seq) {
      const now = performance.now();
      const t = (now - start) / 1000;
      follow();

      if (t < SPOOL_S) {
        // spool: streaks emerge, short and slow
        const u = t / SPOOL_S;
        const e = easeInOut(u);
        uniforms.uAlpha.value = 0.55 * e;
        uniforms.uStretch.value = 0.4 + 1.6 * e;
        uniforms.uSpeed.value = 4 + 26 * e;
        setOverlay(0.05 * e, 0, e, 'charging');
      } else if (t < SPOOL_S + STREAK_S) {
        // streaks: stretch and brighten to the peak
        const u = (t - SPOOL_S) / STREAK_S;
        const e = easeInOut(u);
        uniforms.uAlpha.value = 0.55 + 0.45 * e;
        uniforms.uStretch.value = 2.0 + 26.0 * e;
        uniforms.uSpeed.value = 30 + 90 * e;
        setOverlay(0.05 + 0.75 * e * e, 0, 1, 'in transit');
      } else if (!midpointDone) {
        // peak: hold while the caller swaps the system
        if (!midpointPromise) {
          holdStart = now;
          setOverlay(0.92, 0, 1, 'arriving');
          midpointPromise = Promise.resolve()
            .then(() => (opts.onMidpoint ? opts.onMidpoint() : undefined))
            .catch((err) => { console.error('[warp] onMidpoint failed', err); })
            .then(() => { midpointDone = true; holdOffset = (performance.now() - holdStart) / 1000; });
        }
        uniforms.uAlpha.value = 1.0;
        uniforms.uStretch.value = 28.0;
        uniforms.uSpeed.value = 120;
      } else {
        // decel: shorten, slow down, fade
        const u = (t - SPOOL_S - STREAK_S - holdOffset) / DECEL_S;
        if (u >= 1) break;
        const e = easeOut(clamp01(u));
        uniforms.uAlpha.value = 1.0 - e;
        uniforms.uStretch.value = 28.0 * (1 - e) + 0.3 * e;
        uniforms.uSpeed.value = 120 * (1 - e) + 3 * e;
        setOverlay(0.92 * (1 - e) * (1 - e), 0, 1 - clamp01((u - 0.55) / 0.45), 'arrived');
      }
      uniforms.uTime.value += 1 / 60; // shader time; framerate independent enough for streaks
      await nextFrame();
    }
    streaks.visible = false;
    uniforms.uAlpha.value = 0;
    setOverlay(0, 0, 0, '');
  }

  async function runReduced(opts, mySeq) {
    const start = performance.now();
    let stage = 0; // 0 fade to dark, 1 hold + midpoint, 2 fade in
    let midpointDone = false;
    let holdT0 = 0;
    while (mySeq === seq) {
      const t = (performance.now() - start) / 1000;
      if (stage === 0) {
        const u = clamp01(t / REDUCED_FADE_S);
        setOverlay(0, u, u, 'charging');
        if (u >= 1) {
          stage = 1;
          holdT0 = t;
          Promise.resolve()
            .then(() => (opts.onMidpoint ? opts.onMidpoint() : undefined))
            .catch((err) => { console.error('[warp] onMidpoint failed', err); })
            .then(() => { midpointDone = true; });
        }
      } else if (stage === 1) {
        setOverlay(0, 1, 1, 'in transit');
        if (midpointDone && t - holdT0 >= REDUCED_HOLD_S) { stage = 2; holdT0 = t; }
      } else {
        const u = clamp01((t - holdT0) / (REDUCED_FADE_S * 1.3));
        setOverlay(0, 1 - u, 1 - u, 'arrived');
        if (u >= 1) break;
      }
      await nextFrame();
    }
    setOverlay(0, 0, 0, '');
  }

  const api = {
    /**
     * Play a warp. Resolves when the animation has finished.
     * @param {{ fromName:string, toName:string, distanceLy:number, onMidpoint?:()=>any }} opts
     *   onMidpoint may return a promise; the peak holds until it settles.
     */
    async run(opts) {
      const o = opts || {};
      const mySeq = ++seq;
      active = true;
      line.textContent = describe(o.fromName, o.toName, o.distanceLy);
      try {
        if (reduced.matches) await runReduced(o, mySeq);
        else await runFull(o, mySeq);
      } finally {
        if (mySeq === seq) active = false;
      }
    },
    /** true while a warp is playing */
    get active() { return active; },
    /** stop a running warp immediately (its promise still resolves) */
    cancel() { seq++; active = false; streaks.visible = false; uniforms.uAlpha.value = 0; setOverlay(0, 0, 0, ''); },
    /** the THREE.LineSegments streak field, for tests */
    streaks,
    /** the overlay's text line (string) */
    describe,
    dispose() {
      api.cancel();
      scene.remove(streaks);
      geom.dispose();
      mat.dispose();
      for (const n of [flash, dark, text]) if (n.parentNode) n.parentNode.removeChild(n);
    },
  };
  return api;
}
