/* ===================================================================
   /explore/lib/jump.js : the system chooser (stage 6)

   A modal panel over the stage that picks a destination system: a
   search box, then the tabs 'nearest', 'famous', 'random' and 'map'
   (the galaxy minimap, borrowed from its panel while the tab is open).
   Choosing a row sets the destination and closes the panel; the page
   engages the jump from its JUMP button or the J key.

   Pure DOM, no THREE. Rows come from the caller's callbacks so nothing
   here knows about the catalogue.

   createJumpChooser(rootEl, callbacks) -> {
     open(tab?), close(), toggle(), isOpen(), setDestination(name),
     setQuery(text), refresh(), destroy(), el
   }
   callbacks: nearest() -> rows, famous() -> rows, search(query) -> rows,
     random() -> name|null, onSelect(name), onEngage(name) (the card's
     own jump button), onOpen(), onClose(), mapCanvas (element, optional)
   a row: { name, planets, ly, current }
   =================================================================== */

const SEARCH_MAX = 8;
const TABS = ['nearest', 'famous', 'random', 'map'];
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function fmtLy(ly) {
  if (!Number.isFinite(ly)) return 'distance not catalogued';
  if (ly < 10) return ly.toFixed(1) + ' ly';
  return Math.round(ly).toLocaleString('en-GB') + ' ly';
}

function isTyping(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

export function createJumpChooser(rootEl, callbacks = {}) {
  const root = rootEl || document.getElementById('cockpit') || document.body;
  const cb = callbacks || {};
  const q = (id) => root.querySelector('#' + id) || document.getElementById(id);
  const el = {
    panel: q('hud-jump'),
    close: q('btn-jump-close'),
    search: q('jump-search'),
    tabs: Array.from((q('hud-jump') || root).querySelectorAll('.jump-tab[data-tab]')),
    list: q('jump-list'),
    map: q('jump-map'),
    mapNote: q('jump-map-note'),
    go: q('btn-jump-go'),
    foot: q('jump-foot'),
    status: q('jump-status'),
  };

  const st = {
    open: false,
    tab: 'nearest',
    rows: [],           // rows currently listed
    sel: -1,            // highlighted row
    destination: null,
    query: '',
  };

  // the minimap canvas lives in its own panel; the map tab borrows it and puts it back
  const mapCanvas = cb.mapCanvas || null;
  const mapHome = mapCanvas ? mapCanvas.parentNode : null;
  const mapNext = mapCanvas ? mapCanvas.nextSibling : null;

  const disposers = [];
  function on(node, type, fn, opts) {
    if (!node) return;
    node.addEventListener(type, fn, opts);
    disposers.push(() => node.removeEventListener(type, fn, opts));
  }
  function fire(name, ...args) {
    const fn = cb[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (err) { console.error('jump callback ' + name, err); return undefined; }
  }

  /* ---------------- rows ---------------- */

  function rowsFor(tab) {
    let rows;
    if (st.query) rows = fire('search', st.query);
    else if (tab === 'nearest') rows = fire('nearest');
    else if (tab === 'famous') rows = fire('famous');
    else if (tab === 'random') rows = [{ name: null, random: true }];
    else rows = [];
    if (!Array.isArray(rows)) rows = [];
    if (st.query && rows.length > SEARCH_MAX) rows = rows.slice(0, SEARCH_MAX);
    return rows;
  }

  function renderList() {
    if (!el.list) return;
    st.rows = rowsFor(st.tab);
    const frag = document.createDocumentFragment();
    st.rows.forEach((r, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'jump-item';
      btn.setAttribute('role', 'option');
      btn.dataset.index = String(i);
      if (r.random) {
        btn.classList.add('jump-random');
        const name = document.createElement('span');
        name.className = 'jr-name';
        name.textContent = 'somewhere new';
        const meta = document.createElement('span');
        meta.className = 'jr-meta';
        meta.textContent = 'a random system with a catalogued distance and a measured planet';
        btn.append(name, meta);
      } else {
        btn.dataset.name = r.name;
        const name = document.createElement('span');
        name.className = 'jr-name';
        name.textContent = r.name;
        const meta = document.createElement('span');
        meta.className = 'jr-meta';
        const n = Number(r.planets);
        const parts = [];
        if (Number.isFinite(n)) parts.push(n + (n === 1 ? ' planet' : ' planets'));
        parts.push(r.current ? 'here' : fmtLy(r.ly));
        meta.textContent = parts.join(' · ');
        if (r.current) btn.classList.add('is-here');
        if (r.name === st.destination) btn.classList.add('is-destination');
        btn.append(name, meta);
      }
      btn.addEventListener('click', () => choose(i));
      btn.addEventListener('pointerenter', () => setSel(i, false));
      frag.appendChild(btn);
    });
    el.list.replaceChildren(frag);
    if (el.status) {
      let text = '';
      if (st.query && !st.rows.length) text = 'nothing matches "' + st.query + '"';
      else if (st.query) text = st.rows.length + (st.rows.length === 1 ? ' match' : ' matches');
      else if (st.tab === 'nearest') text = 'the nearest systems with a catalogued position';
      else if (st.tab === 'famous') text = 'well studied systems';
      else text = '';
      el.status.textContent = text;
      el.status.hidden = !text;
    }
    // the destination row when listed, else the first row
    let sel = st.rows.findIndex((r) => r.name && r.name === st.destination);
    if (sel < 0) sel = st.rows.length ? 0 : -1;
    setSel(sel, false);
  }

  function setSel(i, scroll) {
    const n = st.rows.length;
    st.sel = n ? Math.max(0, Math.min(n - 1, i)) : -1;
    if (!el.list) return;
    const kids = el.list.children;
    for (let k = 0; k < kids.length; k++) {
      const on = k === st.sel;
      kids[k].classList.toggle('sel', on);
      kids[k].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (scroll && st.sel >= 0 && kids[st.sel] && typeof kids[st.sel].scrollIntoView === 'function') {
      kids[st.sel].scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(i) {
    const r = st.rows[i];
    if (!r) return;
    let name = r.name;
    if (r.random) name = fire('random');
    if (!name) return;
    if (r.current) return;
    st.destination = name;
    close();
    fire('onSelect', name);
  }

  /* ---------------- tabs ---------------- */

  function setTab(tab) {
    const t = TABS.includes(tab) ? tab : 'nearest';
    st.tab = t;
    el.tabs.forEach((b) => {
      const on = b.dataset.tab === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const mapOn = t === 'map' && !st.query;
    if (el.map) el.map.hidden = !mapOn;
    if (el.list) el.list.hidden = mapOn;
    if (mapOn) borrowMap(); else returnMap();
    if (el.foot) {
      if (COARSE) el.foot.textContent = mapOn ? 'tap a host, then the jump button' : 'tap a system, then the jump button';
      else el.foot.textContent = mapOn ? 'click a host to set the destination · Enter confirms · Esc closes' : 'arrows move · Enter selects · Esc closes';
    }
    renderDestination();
    renderList();
  }

  /** The map note and the engage button follow the destination (a map pick leaves the card open). */
  function renderDestination() {
    const d = st.destination;
    if (el.mapNote) {
      el.mapNote.textContent = d
        ? 'destination: ' + d
        : 'the galaxy map: ' + (COARSE ? 'tap' : 'click') + ' a host to set the destination, M switches local and galaxy';
    }
    if (el.go) {
      el.go.hidden = !d;
      el.go.textContent = d ? 'jump to ' + d : 'jump';
    }
  }

  function borrowMap() {
    if (!mapCanvas || !el.map || mapCanvas.parentNode === el.map) return;
    el.map.insertBefore(mapCanvas, el.mapNote || null);
  }
  function returnMap() {
    if (!mapCanvas || !mapHome || mapCanvas.parentNode === mapHome) return;
    mapHome.insertBefore(mapCanvas, mapNext && mapNext.parentNode === mapHome ? mapNext : null);
  }

  /* ---------------- open and close ---------------- */

  function open(tab) {
    if (!el.panel) return;
    if (!st.open) {
      st.open = true;
      el.panel.hidden = false;
      root.classList.add('jump-open');
      fire('onOpen');
    }
    st.query = '';
    if (el.search) el.search.value = '';
    setTab(tab || st.tab || 'nearest');
    // a keyboard goes straight to the search box; on a phone the on-screen keyboard would cover
    // the list, so there the box waits for a tap
    if (el.search && !COARSE && typeof el.search.focus === 'function') el.search.focus({ preventScroll: true });
  }

  function close() {
    if (!st.open) return;
    st.open = false;
    returnMap();
    if (el.panel) el.panel.hidden = true;
    root.classList.remove('jump-open');
    if (el.search && document.activeElement === el.search) el.search.blur();
    fire('onClose');
  }

  function toggle(tab) { if (st.open) close(); else open(tab); }

  function setDestination(name) {
    st.destination = name || null;
    if (st.open) { renderDestination(); renderList(); }
  }

  function setQuery(text) {
    st.query = String(text == null ? '' : text).trim();
    if (el.search && el.search.value !== st.query) el.search.value = st.query;
    setTab(st.tab);
  }

  /* ---------------- wiring ---------------- */

  on(el.close, 'click', () => close());
  // engage the set destination from inside the card
  on(el.go, 'click', () => { const d = st.destination; if (!d) return; close(); fire('onEngage', d); });
  el.tabs.forEach((b) => on(b, 'click', () => { st.query = ''; if (el.search) el.search.value = ''; setTab(b.dataset.tab); }));
  on(el.search, 'input', () => { st.query = el.search.value.trim(); setTab(st.tab); });
  // a click on the panel's backdrop (outside the card) closes it
  on(el.panel, 'click', (ev) => { if (ev.target === el.panel) close(); });

  // keys while open: capture phase on the window so the ship, the HUD and the page never
  // see them (stopImmediatePropagation: the page's own window listeners are skipped even when
  // the event targets the window itself; the search input still receives typed characters,
  // which are a default action)
  function onKey(ev) {
    if (!st.open) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key;
    const typing = isTyping(ev.target) && ev.target !== el.search;
    if (typing) return;
    if (k === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); close(); return; }
    if (k === 'ArrowDown') { ev.preventDefault(); ev.stopImmediatePropagation(); setSel(st.sel + 1, true); return; }
    if (k === 'ArrowUp') { ev.preventDefault(); ev.stopImmediatePropagation(); setSel(st.sel - 1, true); return; }
    if (k === 'Enter') {
      ev.preventDefault(); ev.stopImmediatePropagation();
      if (st.tab === 'map' && !st.query) { if (st.destination) { close(); fire('onSelect', st.destination); } return; }
      choose(st.sel);
      return;
    }
    if (k === 'Tab') return;                       // focus moves normally
    // every other key stays inside the chooser
    ev.stopImmediatePropagation();
    if (ev.target !== el.search && el.search && k.length === 1) {
      // typing while a row has focus goes into the search box
      el.search.focus({ preventScroll: true });
    }
  }
  window.addEventListener('keydown', onKey, true);
  disposers.push(() => window.removeEventListener('keydown', onKey, true));

  if (el.panel) el.panel.hidden = true;
  if (el.map) el.map.hidden = true;

  function destroy() {
    close();
    disposers.splice(0).forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
  }

  return {
    open, close, toggle,
    isOpen: () => st.open,
    setDestination,
    setQuery,
    refresh: () => { if (st.open) renderList(); },
    tab: () => st.tab,
    selected: () => (st.sel >= 0 && st.rows[st.sel] ? st.rows[st.sel].name : null),
    destroy,
    el,
  };
}
