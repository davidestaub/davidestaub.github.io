/* ===================================================================
   /explore/lib/hud.js : cockpit HUD (stage 3)

   Owns the cockpit overlay markup in index.html (formerly system.html) (#cockpit and its
   children) and nothing in the 3D scene. Pure DOM: no THREE dependency.

   createHud(rootEl, callbacks) -> {
     update(state), setDossier(d), setBodies(list), setVisited(n, total),
     toast(text, ms), setMode(mode), minimapCanvas, showControlsHelp(bool),
     // extensions beyond the contract, all optional for the caller:
     setPickedHost(name|null, ly), pickedHost(), setMapMode(mode),
     setDossierOpen(bool), setSelectedBody(name), setTargetBody(name|null),
     showHint(text, ms), setNavHeight(), destroy()
   }

   callbacks (all optional): onTakeControls, onRelease, onFocus(bodyName),
   onAutopilot(bodyName), onWarp(hostName), onToggleMap, onTimeScale(scale),
   and the extensions onThrottle(delta: +1|-1), onBrake(), onPause(),
   onOpenJump(tab) (the JUMP button without a destination, 'change', and
   the phone bar's map button).

   The per-frame state may carry `aligned` (bool): the reticle turns gold
   and reads 'aligned' while the nose is on the target.

   Honesty rules: speed is shown in km/s, and as a multiple of c only when
   above c, with a note that this is not physical. Nothing here invents a
   planet property; the dossier rows come from the caller.
   =================================================================== */

const TOTAL_SYSTEMS_DEFAULT = 4741;
const AU_KM = 149597870.7;
const LY_KM = 9.4607e12;
const TOAST_MS = 2400;

/* ---------------- formatting ---------------- */

function fmt(n, digits = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  if (abs >= 100) return n.toLocaleString('en-GB', { maximumFractionDigits: Math.min(digits, 1) });
  return n.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Speed in km/s, plain and honest at every scale. */
function fmtSpeedKms(kms) {
  if (!Number.isFinite(kms)) return '·';
  const abs = Math.abs(kms);
  if (abs < 0.005) return '0';
  if (abs < 10) return kms.toLocaleString('en-GB', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (abs < 1000) return kms.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return kms.toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

/** Multiple of c: shown when at or above c, and as a fraction from 0.001 c up. */
function fmtSpeedC(c) {
  if (!Number.isFinite(c) || c < 0.001) return '';
  if (c >= 100) return fmt(c, 0) + ' c';
  if (c >= 1) return fmt(c, 2) + ' c';
  return c.toLocaleString('en-GB', { maximumFractionDigits: 3, minimumFractionDigits: 3 }) + ' c';
}

/** Distance in km, AU or light-years depending on size. */
function fmtDistance(km) {
  if (!Number.isFinite(km)) return '·';
  const abs = Math.abs(km);
  if (abs < 1e6) return fmt(km, 0) + ' km';
  const au = km / AU_KM;
  if (au < 0.01) return fmt(km, 0) + ' km';
  const ly = km / LY_KM;
  if (ly >= 0.05) return fmt(ly, 2) + ' ly';
  return fmt(au, au < 10 ? 3 : 1) + ' AU';
}

function fmtLy(ly) {
  if (!Number.isFinite(ly)) return 'distance not catalogued';
  return fmt(ly, ly < 100 ? 1 : 0) + ' ly from Earth';
}

/* ---------------- create ---------------- */

export function createHud(rootEl, callbacks = {}) {
  const root = rootEl || document.getElementById('cockpit') || document.body;
  const cb = callbacks || {};
  const q = (id) => root.querySelector('#' + id) || document.getElementById(id);

  const el = {
    system: q('hud-system'),
    systemDist: q('hud-system-dist'),
    speed: q('hud-speed'),
    speedC: q('hud-speed-c'),
    speedNote: q('hud-speed-note'),
    throttle: q('hud-throttle'),
    throttleFill: q('hud-throttle-fill'),
    throttleLabel: q('hud-throttle-label'),
    autopilot: q('hud-autopilot'),
    target: q('hud-target'),
    reticle: q('hud-reticle'),
    visited: q('hud-visited'),
    timescale: q('hud-timescale'),
    toast: q('hud-toast'),
    help: q('hud-help'),
    helpClose: q('btn-help-close'),
    btnHelp: q('btn-help'),
    take: q('btn-take-controls'),
    release: q('btn-release'),
    escHint: q('hud-esc-hint'),
    minimap: q('minimap-canvas'),
    minimapPanel: q('hud-minimap'),
    btnMapMode: q('btn-minimap-mode'),
    btnWarp: q('btn-warp'),
    pick: q('hud-pick'),
    dossierPanel: q('hud-dossier'),
    btnDossier: q('btn-dossier'),
    dHost: q('d-host'),
    dStar: q('d-star'),
    dFocus: q('d-focus'),
    dMeasured: q('d-measured'),
    dImagined: q('d-imagined'),
    planetList: q('planet-list'),
    btnStar: q('btn-star'),
    btnSystem: q('btn-system'),
    timeButtons: Array.from(root.querySelectorAll('.t-btn[data-scale]')),
    pause: q('btn-pause'),
    mobileBar: q('hud-mobile-bar'),
    btnThrUp: q('btn-throttle-up'),
    btnThrDown: q('btn-throttle-down'),
    btnBrake: q('btn-brake'),
    btnAutopilot: q('btn-autopilot'),
    btnMap: q('btn-map'),
    btnJump: q('btn-jump'),
    btnJumpPick: q('btn-jump-pick'),
    hintStrip: q('hud-hint-strip'),
  };

  const hud = {
    mode: 'attract',
    picked: null,
    mapMode: 'local',
    selectedBody: null,
    lastState: {},
    helpOpen: false,
  };

  const last = {};        // last rendered text per key: the DOM is only touched on change
  let toastTimer = 0;
  const disposers = [];

  function setText(node, key, text) {
    if (!node) return;
    if (last[key] === text) return;
    last[key] = text;
    node.textContent = text;
  }

  function on(node, type, fn, opts) {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    disposers.push(() => node.removeEventListener(type, fn, opts));
  }

  function fire(name, ...args) {
    const fn = cb[name];
    if (typeof fn === 'function') {
      try { return fn(...args); } catch (err) { console.error('hud callback ' + name, err); }
    }
    return undefined;
  }

  /* ---------------- nav height -> stage height ---------------- */

  function setNavHeight() {
    const nav = document.querySelector('.nav');
    const h = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--nav-h', (h || 58) + 'px');
  }
  setNavHeight();
  if ('ResizeObserver' in window) {
    const nav = document.querySelector('.nav');
    if (nav) {
      const ro = new ResizeObserver(setNavHeight);
      ro.observe(nav);
      disposers.push(() => ro.disconnect());
    }
  }
  on(window, 'resize', setNavHeight);

  /* ---------------- per-frame state ---------------- */

  function update(state) {
    if (!state) return;
    hud.lastState = state;

    // system
    if (state.hostName !== undefined) setText(el.system, 'system', state.hostName || '·');
    if (state.distFromEarthLy !== undefined) setText(el.systemDist, 'systemDist', fmtLy(state.distFromEarthLy));

    // speed
    const kms = Number(state.speedKms);
    const c = Number.isFinite(state.speedC) ? state.speedC : (Number.isFinite(kms) ? kms / 299792.458 : NaN);
    setText(el.speed, 'speed', fmtSpeedKms(kms));
    const cText = fmtSpeedC(c);
    setText(el.speedC, 'speedC', cText);
    if (el.speedC) {
      const over = Number.isFinite(c) && c >= 1;
      if (last.speedOver !== over) {
        last.speedOver = over;
        el.speedC.classList.toggle('over', over);
        if (el.speedNote) el.speedNote.hidden = !over;
      }
    }

    // throttle
    const lvl = Math.max(0, Math.min(1, Number(state.throttleLevel) || 0));
    const lvlKey = Math.round(lvl * 200);
    if (el.throttleFill && last.throttle !== lvlKey) {
      last.throttle = lvlKey;
      el.throttleFill.style.transform = 'scaleX(' + (lvlKey / 200).toFixed(3) + ')';
      if (el.throttle) el.throttle.setAttribute('aria-valuenow', String(Math.round(lvl * 100)));
    }
    setText(el.throttleLabel, 'throttleLabel', 'throttle ' + Math.round(lvl * 100) + ' %');

    // autopilot flag
    const ap = !!state.autopilot;
    if (last.autopilot !== ap) {
      last.autopilot = ap;
      if (el.autopilot) el.autopilot.hidden = !ap;
      root.classList.toggle('is-autopilot', ap);
    }

    // target: the bracket (system.js) carries the name and distance; under the reticle only
    // the alignment word is shown, and the reticle turns gold while the nose is on the target
    const aligned = !!state.aligned && !!state.targetName;
    if (last.aligned !== aligned) {
      last.aligned = aligned;
      root.classList.toggle('is-aligned', aligned);
    }
    setText(el.target, 'target', aligned ? 'aligned' : '');

    // discovery
    if (state.systemsVisited !== undefined) {
      setVisited(state.systemsVisited, state.totalSystems);
    }

    // time scale label (the time preset buttons are owned by system.js)
    if (state.timeScaleLabel !== undefined) setText(el.timescale, 'timescale', state.timeScaleLabel || '');
  }

  /* ---------------- dossier ---------------- */

  function addRow(dl, r) {
    if (!r) return;
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = r.label == null ? '' : String(r.label);
    const dd = document.createElement('dd');
    dd.textContent = r.value == null ? '' : String(r.value);
    if (r.note) {
      const n = document.createElement('span');
      n.className = 'd-note';
      n.textContent = String(r.note);
      dd.appendChild(n);
    }
    row.append(dt, dd);
    dl.appendChild(row);
  }

  function fillList(dl, rows) {
    if (!dl) return;
    const frag = document.createDocumentFragment();
    const tmp = document.createElement('dl');
    (rows || []).forEach((r) => addRow(tmp, r));
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    dl.replaceChildren(frag);
  }

  function setDossier(d) {
    if (!d) return;
    if (d.hostLine !== undefined && el.dHost) el.dHost.textContent = d.hostLine || '·';
    if (d.starLine !== undefined && el.dStar) el.dStar.textContent = d.starLine || '·';
    if (d.title !== undefined && el.dFocus) el.dFocus.textContent = d.title || '·';
    if (d.measured !== undefined) fillList(el.dMeasured, d.measured);
    if (d.imagined !== undefined) fillList(el.dImagined, d.imagined);
  }

  function setDossierOpen(open) {
    if (!el.dossierPanel) return;
    el.dossierPanel.classList.toggle('collapsed', !open);
    if (el.btnDossier) {
      el.btnDossier.setAttribute('aria-expanded', open ? 'true' : 'false');
      el.btnDossier.textContent = open ? 'hide' : 'dossier';
    }
  }

  /* ---------------- bodies ---------------- */

  /**
   * @param list [{ name, host?, cls, radius_re, swatchCss }]. When the planet's name starts with
   *   the host name the chip shows only the suffix ('b', 'c'); the full name is the accessible name.
   */
  function setBodies(list) {
    if (!el.planetList) return;
    hud.selectedBody = null;            // a new system: the old selection names a body that no longer exists
    const frag = document.createDocumentFragment();
    (list || []).forEach((b, i) => {
      const item = document.createElement('div');
      item.className = 'p-item';

      // the focus chip keeps the classes and data-index that system.js's focus code expects
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'f-btn f-planet';
      btn.dataset.index = String(i);
      btn.dataset.name = b.name;
      btn.setAttribute('aria-pressed', 'false');
      const sw = document.createElement('span');
      sw.className = 'p-sw';
      if (b.swatchCss) { sw.style.background = b.swatchCss; sw.style.boxShadow = '0 0 6px ' + b.swatchCss; }
      const name = document.createElement('span');
      name.className = 'p-name';
      const host = typeof b.host === 'string' ? b.host : '';
      const full = String(b.name == null ? '' : b.name);
      name.textContent = host && full.startsWith(host + ' ') ? full.slice(host.length + 1) : full;
      const meta = document.createElement('span');
      meta.className = 'p-meta';
      meta.setAttribute('aria-hidden', 'true');
      const re = Number(b.radius_re);
      meta.textContent = (b.cls || '') + (Number.isFinite(re) ? ' · ' + fmt(re, 2) + ' Re' : '');
      btn.setAttribute('aria-label', full + (meta.textContent ? ', ' + meta.textContent : ''));
      btn.title = full;
      btn.append(sw, name, meta);
      btn.addEventListener('click', () => {
        hud.selectedBody = b.name;
        fire('onFocus', b.name);
      });

      // autopilot: fly to this body and settle in front of it
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'f-go';
      go.dataset.name = b.name;
      go.textContent = 'fly';
      go.title = 'autopilot to ' + b.name;
      go.setAttribute('aria-label', 'autopilot to ' + b.name);
      go.addEventListener('click', (ev) => {
        ev.stopPropagation();
        hud.selectedBody = b.name;
        fire('onAutopilot', b.name);
      });

      item.append(btn, go);
      frag.appendChild(item);
    });
    el.planetList.replaceChildren(frag);
  }

  function setSelectedBody(name) { hud.selectedBody = name || null; }

  /** Mark the targeted body's chip (gold bracket corners), or none. */
  function setTargetBody(name) {
    if (!el.planetList) return;
    const chips = el.planetList.querySelectorAll('.f-planet');
    for (let i = 0; i < chips.length; i++) {
      const on = !!name && chips[i].dataset.name === name;
      if (chips[i].classList.contains('targeted') !== on) chips[i].classList.toggle('targeted', on);
    }
  }

  /* ---------------- hint strip under the reticle ---------------- */

  let hintTimer = 0;
  function showHint(text, ms) {
    if (!el.hintStrip) return;
    clearTimeout(hintTimer);
    el.hintStrip.textContent = text == null ? '' : String(text);
    el.hintStrip.hidden = !text;
    if (text && Number.isFinite(ms) && ms > 0) hintTimer = setTimeout(() => { el.hintStrip.hidden = true; }, ms);
  }

  /* ---------------- discovery ---------------- */

  const narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 820px)') : null;

  function setVisited(count, total) {
    const n = Number.isFinite(count) ? count : 0;
    const t = Number.isFinite(total) && total > 0 ? total : TOTAL_SYSTEMS_DEFAULT;
    // phones: the short form fits the top-left panel on one line, under the time controls
    const text = narrowQuery && narrowQuery.matches
      ? 'visited ' + fmt(n, 0) + ' / ' + fmt(t, 0)
      : 'systems visited: ' + fmt(n, 0) + ' of ' + fmt(t, 0);
    setText(el.visited, 'visited', text);
  }

  /* ---------------- toast ---------------- */

  function toast(text, ms) {
    if (!el.toast) return;
    clearTimeout(toastTimer);
    el.toast.textContent = text == null ? '' : String(text);
    el.toast.hidden = false;
    // force a restart of the fade transition
    el.toast.classList.remove('show');
    void el.toast.offsetWidth;
    el.toast.classList.add('show');
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      toastTimer = setTimeout(() => { el.toast.hidden = true; }, 320);
    }, Number.isFinite(ms) && ms > 0 ? ms : TOAST_MS);
  }

  /* ---------------- modes ---------------- */

  function setMode(mode) {
    const m = (mode === 'flight' || mode === 'warp') ? mode : 'attract';
    hud.mode = m;
    root.dataset.mode = m;
    if (el.take) el.take.hidden = m !== 'attract';
    if (el.escHint) el.escHint.hidden = m !== 'flight';
    if (el.reticle) el.reticle.hidden = m === 'attract';
    if (m === 'warp') showControlsHelp(false);
  }

  /* ---------------- help ---------------- */

  function showControlsHelp(show) {
    const wasOpen = hud.helpOpen;
    // if focus is inside the dialog when it closes, hand it back to the button that opened it
    const focusInside = !!(el.help && document.activeElement && el.help.contains(document.activeElement));
    hud.helpOpen = !!show;
    if (el.help) el.help.hidden = !show;
    if (el.btnHelp) el.btnHelp.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show && el.helpClose && typeof el.helpClose.focus === 'function') el.helpClose.focus();
    else if (!show && wasOpen && focusInside && el.btnHelp && typeof el.btnHelp.focus === 'function') el.btnHelp.focus();
  }

  /* ---------------- minimap panel ---------------- */

  /**
   * The jump destination (one state for the minimap pick, the chooser and the JUMP button).
   * @param name  host name or null
   * @param ly    distance from the current system in light-years, optional
   */
  function setPickedHost(name, ly) {
    hud.picked = name || null;
    if (el.pick) el.pick.textContent = name ? 'destination: ' + name : 'click a host to set the destination';
    if (el.btnWarp) {
      el.btnWarp.disabled = !name;
      el.btnWarp.textContent = name ? 'jump to ' + name : 'jump to destination';
    }
    if (el.minimapPanel) el.minimapPanel.dataset.picked = name ? '1' : '0';
    if (el.btnJump) {
      const lyText = Number.isFinite(ly) ? ' · ' + fmt(ly, ly < 10 ? 1 : 0) + ' ly' : '';
      el.btnJump.textContent = name ? 'jump: ' + name + lyText : 'jump: choose a system';
      el.btnJump.title = name ? 'engage the jump to ' + name + ' (J)' : 'choose a system to jump to (J)';
      el.btnJump.setAttribute('aria-label', name ? 'jump to ' + name + lyText : 'jump: no destination, choose a system');
      // without a destination the button opens the chooser dialog; with one it engages
      if (name) el.btnJump.removeAttribute('aria-haspopup'); else el.btnJump.setAttribute('aria-haspopup', 'dialog');
      el.btnJump.classList.toggle('armed', !!name);
    }
    if (el.btnJumpPick) el.btnJumpPick.hidden = !name;
  }

  function setMapMode(mode) {
    hud.mapMode = mode === 'galaxy' ? 'galaxy' : 'local';
    if (el.btnMapMode) {
      el.btnMapMode.textContent = 'map: ' + hud.mapMode;
      el.btnMapMode.setAttribute('aria-label', 'minimap mode, currently ' + hud.mapMode + ', click to switch');
    }
  }

  function setMapVisible(show) {
    root.classList.toggle('show-map', !!show);
    if (el.btnMap) el.btnMap.setAttribute('aria-pressed', show ? 'true' : 'false');
  }

  /* ---------------- wiring ---------------- */

  on(el.take, 'click', () => fire('onTakeControls'));
  on(el.release, 'click', () => fire('onRelease'));
  on(el.btnHelp, 'click', () => showControlsHelp(!hud.helpOpen));
  on(el.helpClose, 'click', () => showControlsHelp(false));
  on(el.btnDossier, 'click', () => setDossierOpen(el.dossierPanel && el.dossierPanel.classList.contains('collapsed')));
  on(el.btnMapMode, 'click', () => {
    setMapMode(hud.mapMode === 'local' ? 'galaxy' : 'local');   // optimistic; setMapMode() from the caller wins
    fire('onToggleMap');
  });
  on(el.btnWarp, 'click', () => { if (hud.picked) fire('onWarp', hud.picked); });
  // JUMP: with a destination it engages, without one it opens the chooser; 'change' always opens it
  on(el.btnJump, 'click', () => { if (hud.picked) fire('onWarp', hud.picked); else fire('onOpenJump'); });
  on(el.btnJumpPick, 'click', () => fire('onOpenJump'));
  // phones: the bar's map button opens the chooser (the minimap is its 'map' tab); without
  // that callback it falls back to the minimap sheet
  on(el.btnMap, 'click', () => {
    if (typeof cb.onOpenJump === 'function') fire('onOpenJump', 'map');
    else setMapVisible(!root.classList.contains('show-map'));
  });
  on(el.btnThrUp, 'click', () => fire('onThrottle', +1));
  on(el.btnThrDown, 'click', () => fire('onThrottle', -1));
  on(el.btnBrake, 'click', () => fire('onBrake'));
  on(el.btnAutopilot, 'click', () => {
    const name = hud.selectedBody || (hud.lastState && hud.lastState.targetName) || null;
    if (name) fire('onAutopilot', name);
    else toast('pick a planet first', 1800);
  });
  on(el.btnStar, 'click', () => { hud.selectedBody = null; fire('onFocus', 'star'); });
  on(el.btnSystem, 'click', () => { hud.selectedBody = null; fire('onFocus', 'system'); });
  el.timeButtons.forEach((btn) => on(btn, 'click', () => fire('onTimeScale', Number(btn.dataset.scale))));
  on(el.pause, 'click', () => fire('onPause'));

  // keyboard: H toggles the help, M toggles the map mode, Esc closes the help.
  // W/S/Q/E/space/shift belong to the ship and are only listed here.
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  on(window, 'keydown', (ev) => {
    if (isTyping(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key;
    if (k === 'h' || k === 'H') { showControlsHelp(!hud.helpOpen); ev.preventDefault(); }
    else if (k === 'm' || k === 'M') { setMapMode(hud.mapMode === 'local' ? 'galaxy' : 'local'); fire('onToggleMap'); }
    else if (k === 'Escape' && hud.helpOpen) showControlsHelp(false);
  });

  // initial state
  setMode('attract');
  setPickedHost(null);
  setMapMode('local');
  setVisited(0, TOTAL_SYSTEMS_DEFAULT);
  const narrow = window.matchMedia && window.matchMedia('(max-width: 820px)').matches;
  setDossierOpen(!narrow);
  if (el.toast) el.toast.hidden = true;
  if (el.help) el.help.hidden = true;
  if (el.autopilot) el.autopilot.hidden = true;
  if (el.speedNote) el.speedNote.hidden = true;

  if (el.hintStrip) el.hintStrip.hidden = true;
  if (el.btnJumpPick) el.btnJumpPick.hidden = true;

  function destroy() {
    clearTimeout(toastTimer);
    clearTimeout(hintTimer);
    disposers.splice(0).forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
  }

  return {
    update,
    setDossier,
    setBodies,
    setVisited,
    toast,
    setMode,
    minimapCanvas: el.minimap,
    showControlsHelp,
    // extensions
    setPickedHost,
    pickedHost: () => hud.picked,
    setMapMode,
    setMapVisible,
    setDossierOpen,
    setSelectedBody,
    setTargetBody,
    showHint,
    setNavHeight,
    mode: () => hud.mode,
    destroy,
    el,
  };
}
