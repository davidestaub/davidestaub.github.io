/* ===================================================================
   /explore/lib/ship-mesh.js : the player's ship as a mesh

   Two exports.

   makeShipMesh(THREE, opts?) -> THREE.Group
     A procedural fighter: a dart fuselage from a lathe profile (flattened
     into a lifting body), swept main wings and canards, canted twin fins,
     a dark glossy canopy, two underwing nacelles and a central drive, each
     with an emissive nozzle, an additive plume and a glow sprite. Panel
     lines, plate variation, rivets and gold cheat lines come from a
     procedural canvas (albedo, normal and roughness maps). Graphite hull
     with gold accents and cyan drives, the site's palette. Built in local
     units where the hull is 10 long: the caller (loadShip) scales it.

   loadShip(THREE, baseUrl, opts?) -> Promise<{
       group, engines, length_units, bounds, setThrottle, update, source }>
     The ship the game draws. With USE_GLB false (the shipped state) it is
     the procedural mesh; with USE_GLB true it loads baseUrl + 'models/ship.glb'
     with GLTFLoader and falls back to the procedural mesh when that fails.
     Either way the result is normalised: nose along -Z, up +Y, the hull
     LENGTH_UNITS long (0.06 scene units = 60 km at the scene's 1 unit =
     1,000 km). That is absurd for a fighter: the ship is drawn at a
     display scale, not a true one, and the dossier must say so.
       group.userData.setThrottle(level 0..1)   drive glow and plume length
       group.userData.update(dt, t)             plume flicker (optional)

   Lighting assumption: a single PointLight (the star) plus a faint
   hemisphere fill. The materials carry a small procedural environment
   cube (dark navy with one warm patch) so metallic surfaces keep a sheen
   on the shadow side; opts.envMap replaces it, opts.envMap === null drops it.

   This module does NOT import three; the page passes THREE in.
   =================================================================== */

export const LENGTH_UNITS = 0.06;
export const USE_GLB = false;        // no GLB shipped: the procedural mesh is the ship

const GRAPHITE = '#454a55';
const GRAPHITE_DARK = '#23262d';
const GOLD = '#F5B324';
const CYAN = 0x35d6ff;

/* ---------------- procedural textures ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** A 2D context; readback = true for a canvas whose pixels are read back (getImageData). */
function ctx2d(canvas, readback) {
  return canvas.getContext('2d', readback ? { willReadFrequently: true } : undefined);
}

/**
 * Hull maps: albedo (graphite plates, gold cheat lines), a height field turned into a
 * normal map (panel grooves, rivets, raised plates) and a roughness map (worn plates
 * shinier, grooves and decals duller). One set is shared by every hull part; the
 * parts scale their UVs so the panel size reads the same everywhere.
 */
function makeHullMaps(THREE, seed) {
  const W = 1024, H = 512;
  const rnd = mulberry32(seed || 7);

  const alb = makeCanvas(W, H), hgt = makeCanvas(W, H), rgh = makeCanvas(W, H);
  const ca = ctx2d(alb, true), ch = ctx2d(hgt, true), cr = ctx2d(rgh, false);

  ca.fillStyle = GRAPHITE; ca.fillRect(0, 0, W, H);
  ch.fillStyle = '#808080'; ch.fillRect(0, 0, W, H);
  cr.fillStyle = 'rgb(115,115,115)'; cr.fillRect(0, 0, W, H);   // 0.45 roughness

  // plates: an irregular grid, each plate a slightly different grey and height
  const cols = 14, rows = 8;
  const xs = [0], ys = [0];
  for (let i = 1; i < cols; i++) xs.push(Math.round((i + (rnd() - 0.5) * 0.5) * W / cols));
  xs.push(W);
  for (let j = 1; j < rows; j++) ys.push(Math.round((j + (rnd() - 0.5) * 0.5) * H / rows));
  ys.push(H);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
      const tone = 1 + (rnd() - 0.5) * 0.14;
      const base = [0x45, 0x4a, 0x55].map((v) => Math.max(0, Math.min(255, Math.round(v * tone))));
      ca.fillStyle = 'rgb(' + base.join(',') + ')';
      ca.fillRect(x0, y0, x1 - x0, y1 - y0);
      const h = 128 + Math.round((rnd() - 0.5) * 18);
      ch.fillStyle = 'rgb(' + h + ',' + h + ',' + h + ')';
      ch.fillRect(x0, y0, x1 - x0, y1 - y0);
      const r = 115 + Math.round((rnd() - 0.5) * 40);
      cr.fillStyle = 'rgb(' + r + ',' + r + ',' + r + ')';
      cr.fillRect(x0, y0, x1 - x0, y1 - y0);
      // some plates get a sub-panel or a hatch
      if (rnd() < 0.35) {
        const px = x0 + (x1 - x0) * (0.15 + rnd() * 0.3), py = y0 + (y1 - y0) * (0.15 + rnd() * 0.3);
        const pw = (x1 - x0) * (0.25 + rnd() * 0.35), ph = (y1 - y0) * (0.25 + rnd() * 0.35);
        ca.fillStyle = 'rgba(0,0,0,' + (0.10 + rnd() * 0.12).toFixed(2) + ')';
        ca.fillRect(px, py, pw, ph);
        ch.fillStyle = 'rgb(122,122,122)'; ch.fillRect(px, py, pw, ph);
        cr.fillStyle = 'rgb(150,150,150)'; cr.fillRect(px, py, pw, ph);
      }
    }
  }
  // grooves along the plate edges
  ca.strokeStyle = 'rgba(0,0,0,0.55)'; ca.lineWidth = 2;
  ch.strokeStyle = 'rgb(70,70,70)'; ch.lineWidth = 3;
  cr.strokeStyle = 'rgb(190,190,190)'; cr.lineWidth = 3;
  for (const ctx of [ca, ch, cr]) {
    ctx.beginPath();
    for (let i = 1; i < cols; i++) { ctx.moveTo(xs[i] + 0.5, 0); ctx.lineTo(xs[i] + 0.5, H); }
    for (let j = 1; j < rows; j++) { ctx.moveTo(0, ys[j] + 0.5); ctx.lineTo(W, ys[j] + 0.5); }
    ctx.stroke();
  }
  // rivets along the grooves
  for (let i = 1; i < cols; i++) {
    for (let y = 8; y < H; y += 14 + Math.round(rnd() * 3)) {
      ch.fillStyle = 'rgb(160,160,160)';
      ch.beginPath(); ch.arc(xs[i] + 5, y, 1.6, 0, Math.PI * 2); ch.fill();
      ca.fillStyle = 'rgba(255,255,255,0.10)';
      ca.beginPath(); ca.arc(xs[i] + 5, y, 1.4, 0, Math.PI * 2); ca.fill();
    }
  }
  // gold cheat lines: a long stripe and a short one, plus a few accent blocks
  ca.fillStyle = GOLD;
  ca.fillRect(0, Math.round(H * 0.30), W, 5);
  ca.fillRect(0, Math.round(H * 0.325), W, 2);
  ca.fillRect(Math.round(W * 0.55), Math.round(H * 0.72), Math.round(W * 0.30), 4);
  for (let k = 0; k < 6; k++) {
    const x = rnd() * W, y = rnd() * H;
    ca.fillRect(x, y, 10 + rnd() * 24, 4);
  }
  cr.fillStyle = 'rgb(95,95,95)';
  cr.fillRect(0, Math.round(H * 0.30), W, 5);
  // dark decals: a few matte rectangles (vents, markings)
  for (let k = 0; k < 10; k++) {
    const x = rnd() * W, y = rnd() * H, w = 12 + rnd() * 40, h = 4 + rnd() * 10;
    ca.fillStyle = GRAPHITE_DARK; ca.fillRect(x, y, w, h);
    cr.fillStyle = 'rgb(200,200,200)'; cr.fillRect(x, y, w, h);
    ch.fillStyle = 'rgb(100,100,100)'; ch.fillRect(x, y, w, h);
  }
  // fine grain so the plates are not perfectly flat
  const img = ca.getImageData(0, 0, W, H), d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    const n = (rnd() - 0.5) * 10;
    d[p] += n; d[p + 1] += n; d[p + 2] += n;
  }
  ca.putImageData(img, 0, 0);

  // normal map from the height field (central differences, wrapping)
  const hd = ch.getImageData(0, 0, W, H).data;
  const nrm = makeCanvas(W, H), cn = nrm.getContext('2d');
  const out = cn.createImageData(W, H), od = out.data;
  const STRENGTH = 2.2;
  const at = (x, y) => hd[(((y + H) % H) * W + ((x + W) % W)) * 4] / 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
      const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * W + x) * 4;
      od[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      od[i + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);   // canvas y grows downward, three's uv v grows upward
      od[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      od[i + 3] = 255;
    }
  }
  cn.putImageData(out, 0, 0);

  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(alb, true), normalMap: mk(nrm, false), roughnessMap: mk(rgh, false) };
}

/** Radial glow for the drive sprites. */
function makeGlowTexture(THREE) {
  const c = makeCanvas(128, 128), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(180,240,255,0.9)');
  g.addColorStop(0.45, 'rgba(53,214,255,0.35)');
  g.addColorStop(1, 'rgba(53,214,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A tiny environment cube: dark navy sky, near-black ground, one warm patch. Enough for
 * the metallic hull to keep a sheen where the star does not reach. Cube textures with
 * CubeReflectionMapping are converted by the renderer for PBR materials.
 */
function makeSpaceEnv(THREE) {
  const S = 32;
  const faces = [];
  const mkFace = (fn) => {
    const c = makeCanvas(S, S), ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S), d = img.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const [r, g, b] = fn(x / (S - 1), y / (S - 1));
      const i = (y * S + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const sky = (u, v) => [8 + 18 * (1 - v), 12 + 26 * (1 - v), 30 + 50 * (1 - v)];
  const up = () => [30, 44, 88];
  const down = () => [3, 4, 8];
  const warm = (u, v) => {
    const dx = u - 0.65, dy = v - 0.35, f = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.6);
    return [8 + 18 * (1 - v) + 120 * f, 12 + 26 * (1 - v) + 90 * f, 30 + 50 * (1 - v) + 40 * f];
  };
  // +x, -x, +y, -y, +z, -z
  faces.push(mkFace(warm), mkFace(sky), mkFace(up), mkFace(down), mkFace(sky), mkFace(sky));
  const t = new THREE.CubeTexture(faces);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/* ---------------- geometry helpers ---------------- */

/** A lathe about the local Z axis, nose at -z. profile: [[radius, z], ...] from nose to tail. */
function lathe(THREE, profile, segments) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(r, z));
  const g = new THREE.LatheGeometry(pts, segments || 48);
  g.rotateX(Math.PI / 2);         // lathe axis Y -> local Z (a point at y = -5 lands at z = -5)
  return g;
}

/** Scale a geometry's uv attribute in place. */
function scaleUv(g, su, sv) {
  const uv = g.attributes.uv;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

/**
 * A thin bevelled slab from a planform. pts are [x, z] pairs (z aft positive); the
 * slab lies in the XZ plane, thickness along Y, centred on y = 0.
 */
function slab(THREE, pts, thickness, bevel) {
  const shape = new THREE.Shape();
  pts.forEach(([x, z], i) => { if (i === 0) shape.moveTo(x, z); else shape.lineTo(x, z); });
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 1.6, bevelSegments: 2, curveSegments: 4,
  });
  g.rotateX(Math.PI / 2);                 // shape y -> world z, extrusion -> down
  g.translate(0, (thickness + bevel * 2) / 2, 0);
  scaleUv(g, 0.12, 0.12);
  g.computeVertexNormals();
  return g;
}

/* ---------------- the ship ---------------- */

/**
 * @param THREE  the three.js namespace
 * @param opts   { seed, envMap (Texture | null), envMapIntensity }
 */
export function makeShipMesh(THREE, opts) {
  const o = opts || {};
  const group = new THREE.Group();
  group.name = 'ship';

  const maps = makeHullMaps(THREE, o.seed || 7);
  const env = o.envMap === null ? null : (o.envMap || makeSpaceEnv(THREE));
  const envI = Number.isFinite(o.envMapIntensity) ? o.envMapIntensity : 0.7;

  const hull = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: maps.map, normalMap: maps.normalMap, normalScale: new THREE.Vector2(0.7, 0.7),
    roughnessMap: maps.roughnessMap, roughness: 1.0, metalness: 0.6, envMap: env, envMapIntensity: envI,
  });
  const hullDark = new THREE.MeshStandardMaterial({
    color: 0x1a1c22, roughness: 0.5, metalness: 0.7, envMap: env, envMapIntensity: envI,
  });
  const goldMat = new THREE.MeshStandardMaterial({
    color: 0xF5B324, roughness: 0.32, metalness: 0.85, envMap: env, envMapIntensity: envI * 1.4,
  });
  const canopyMat = new THREE.MeshPhysicalMaterial({
    color: 0x05080f, roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.05,
    envMap: env, envMapIntensity: envI * 2.2, reflectivity: 1.0, specularIntensity: 1.0,
  });
  const nozzleMat = new THREE.MeshStandardMaterial({
    color: 0x0c1016, roughness: 0.35, metalness: 0.9, emissive: CYAN, emissiveIntensity: 0.3, envMap: env, envMapIntensity: envI,
  });
  const plumeMat = new THREE.MeshBasicMaterial({
    color: CYAN, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const glowTex = makeGlowTexture(THREE);
  const spriteMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffffff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const navMat = new THREE.MeshBasicMaterial({ color: CYAN });
  const navGold = new THREE.MeshBasicMaterial({ color: 0xF5B324 });

  /* fuselage: a dart, flattened into a lifting body; a stepped tail ring for the drive */
  const fuselage = new THREE.Mesh(lathe(THREE, [
    [0.0, -5.0], [0.05, -4.92], [0.14, -4.5], [0.28, -3.7], [0.44, -2.7], [0.58, -1.5], [0.66, -0.2],
    [0.66, 1.2], [0.60, 2.6], [0.52, 3.7], [0.46, 4.4], [0.44, 4.75], [0.36, 4.8], [0.34, 4.86], [0.0, 4.86],
  ], 56), hull);
  fuselage.geometry.scale(1.12, 0.62, 1);
  scaleUv(fuselage.geometry, 3, 2);
  fuselage.geometry.computeVertexNormals();
  group.add(fuselage);

  // dorsal spine behind the canopy
  const spine = new THREE.Mesh(lathe(THREE, [
    [0.0, -1.0], [0.16, -0.7], [0.24, 0.2], [0.22, 2.4], [0.14, 3.6], [0.0, 4.0],
  ], 24), hull);
  spine.geometry.scale(1.4, 0.75, 1);
  spine.position.y = 0.30;
  scaleUv(spine.geometry, 1.5, 1);
  group.add(spine);

  // chines: a flat strake along each side, nose to wing root
  const chineL = new THREE.Mesh(slab(THREE, [[-0.05, -3.4], [0.70, -0.6], [0.82, 1.0], [0.60, 1.4], [-0.05, 1.0]], 0.05, 0.03), hull);
  chineL.position.set(0.20, -0.02, 0);
  const chineR = chineL.clone(); chineR.scale.x = -1; chineR.position.x = -0.20;
  group.add(chineL, chineR);

  /* canopy: dark glass with a thin frame */
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), canopyMat);
  canopy.scale.set(0.34, 0.27, 1.25);
  canopy.position.set(0, 0.30, -2.05);
  group.add(canopy);
  const frame = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24, 0, Math.PI * 2, 0, Math.PI * 0.58), hullDark);
  frame.scale.set(0.36, 0.20, 1.30);
  frame.position.set(0, 0.22, -2.05);
  frame.rotation.x = Math.PI;      // an open bowl under the glass, the sill
  group.add(frame);

  /* wings: swept, with a kinked trailing edge, slight anhedral */
  const wingPts = (s) => [[s * 0.40, -1.3], [s * 2.2, 1.0], [s * 3.9, 2.55], [s * 4.0, 3.1], [s * 2.6, 3.2], [s * 1.2, 3.6], [s * 0.40, 3.3]];
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(slab(THREE, wingPts(s), 0.10, 0.04), hull);
    w.position.y = -0.06;
    w.rotation.z = -s * 0.06;
    group.add(w);
    // wingtip: a gold-edged blade and a cyan navigation light
    const blade = new THREE.Mesh(slab(THREE, [[s * 3.85, 2.45], [s * 4.05, 2.45], [s * 4.1, 3.25], [s * 3.9, 3.25]], 0.04, 0.02), goldMat);
    blade.position.y = -0.06; blade.rotation.z = -s * 0.06;
    group.add(blade);
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), navMat);
    nav.position.set(s * 4.05, -0.30, 2.85);       // the tip after the anhedral drop
    group.add(nav);
  }

  /* canards near the nose */
  const canardPts = (s) => [[s * 0.30, -3.3], [s * 1.30, -2.45], [s * 1.35, -2.15], [s * 0.30, -2.25]];
  for (const s of [1, -1]) {
    const c = new THREE.Mesh(slab(THREE, canardPts(s), 0.06, 0.03), hull);
    c.position.y = 0.02;
    group.add(c);
  }

  /* twin fins, canted outward */
  for (const s of [1, -1]) {
    const fin = new THREE.Mesh(slab(THREE, [[-0.0, 2.9], [-0.0, 4.55], [0.0, 4.75], [1.15, 4.7], [1.25, 4.35], [0.55, 3.2]], 0.06, 0.03), hull);
    // the slab lies in XZ with its "span" along x: a quarter turn about z stands it up
    // (span -> y), and the extra angle cants the top outward
    fin.rotation.z = Math.PI / 2 - s * 0.32;
    fin.position.set(s * 0.42, 0.28, 0);
    group.add(fin);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), navGold);
    tip.position.set(s * (0.42 + Math.sin(0.32) * 1.2), 0.28 + Math.cos(0.32) * 1.2, 4.55);
    group.add(tip);
  }

  /* drives: two nacelles under the wings and one in the tail */
  const engines = [];
  const plumes = [];
  const sprites = [];
  const nozzles = [];

  function addDrive(x, y, z, radius, plumeLen) {
    // bell: a short flared cone, dark; throat: the emissive disc
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius, radius * 0.9, 32, 1, true), hullDark);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(x, y, z + radius * 0.45);
    group.add(bell);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.98, radius * 0.07, 10, 40), goldMat);
    ring.position.set(x, y, z + radius * 0.9);
    group.add(ring);
    const throat = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.74, 32), nozzleMat.clone());
    throat.position.set(x, y, z + 0.02);
    throat.rotation.y = 0;               // faces +z (aft)
    group.add(throat);
    nozzles.push(throat);
    engines.push(throat);
    // plume: a long thin cone, additive, scaled by the throttle
    const plume = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.66, 1, 24, 1, true), plumeMat.clone());
    plume.geometry.translate(0, 0.5, 0);            // base at the origin, apex at +y
    plume.geometry.rotateX(Math.PI / 2);            // apex along +z (aft)
    plume.position.set(x, y, z + radius * 0.85);
    plume.userData.len = plumeLen;
    plume.userData.fx = true;                        // not part of the hull's bounds
    group.add(plume);
    plumes.push(plume);
    const spr = new THREE.Sprite(spriteMat.clone());
    spr.position.set(x, y, z + radius * 0.9);
    spr.userData.base = radius * 2.6;
    spr.userData.fx = true;
    group.add(spr);
    sprites.push(spr);
    engines.push(spr);
  }

  for (const s of [1, -1]) {
    const nac = new THREE.Mesh(lathe(THREE, [
      [0.0, -1.4], [0.16, -1.3], [0.28, -0.9], [0.33, 0.4], [0.33, 2.4], [0.28, 3.4], [0.26, 3.6], [0.0, 3.6],
    ], 36), hull);
    nac.position.set(s * 1.25, -0.16, 0.2);
    scaleUv(nac.geometry, 1.5, 1.2);
    group.add(nac);
    // pylon between wing and nacelle
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.26, 2.2), hullDark);
    pylon.position.set(s * 1.25, 0.02, 1.4);
    group.add(pylon);
    // intake lip in gold
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.03, 8, 36), goldMat);
    lip.position.set(s * 1.25, -0.16, 0.2 - 1.05);
    group.add(lip);
    addDrive(s * 1.25, -0.16, 0.2 + 3.6, 0.27, 3.6);
  }
  addDrive(0, 0, 4.86, 0.34, 4.6);

  /* throttle: glow, plume length and throat emission */
  let throttle = 0;
  let time = 0;
  function apply(flicker) {
    const t = Math.max(0, Math.min(1, throttle));
    const f = 1 + (flicker || 0);
    for (const n of nozzles) n.material.emissiveIntensity = 0.25 + 3.2 * t * f;
    for (const p of plumes) {
      p.material.opacity = t <= 0 ? 0 : (0.10 + 0.55 * t) * f;
      const len = p.userData.len * (0.08 + 0.92 * t * t) * (0.9 + 0.1 * f);
      p.scale.set(0.35 + 0.65 * t, 0.35 + 0.65 * t, Math.max(0.02, len));
      p.visible = t > 0.001;
    }
    for (const s of sprites) {
      const sc = s.userData.base * (0.45 + 1.4 * t) * (0.94 + 0.06 * f);
      s.scale.set(sc, sc, 1);
      s.material.opacity = 0.22 + 0.7 * t;
    }
  }
  function setThrottle(level) {
    throttle = Number.isFinite(level) ? level : 0;
    apply(0);
  }
  function update(dt, t) {
    time = Number.isFinite(t) ? t : time + (Number.isFinite(dt) ? dt : 0);
    const flick = throttle > 0 ? (Math.sin(time * 37) * 0.5 + Math.sin(time * 61 + 1.3) * 0.5) * 0.06 * throttle : 0;
    apply(flick);
  }
  group.userData.setThrottle = setThrottle;
  group.userData.update = update;
  group.userData.engines = engines;
  group.userData.materials = { hull, hullDark, goldMat, canopyMat, nozzleMat };
  setThrottle(0);

  return group;
}

/* ---------------- normalise and load ---------------- */

/** Bounds of the hull only: plumes and glow sprites (userData.fx) are left out. */
function hullBox(THREE, root) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((m) => {
    if (!m.isMesh || m.userData.fx || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    box.union(tmp);
  });
  return box;
}

/** Scale so the hull's z extent is LENGTH_UNITS and centre it on the origin (nose at -z). */
function normalise(THREE, group) {
  const box = hullBox(THREE, group);
  const size = new THREE.Vector3(); box.getSize(size);
  const centre = new THREE.Vector3(); box.getCenter(centre);
  const s = LENGTH_UNITS / Math.max(size.z, 1e-9);
  const holder = new THREE.Group();
  holder.name = 'ship-holder';
  holder.add(group);
  group.position.sub(centre);
  holder.scale.setScalar(s);
  const bounds = hullBox(THREE, holder);
  return { holder, bounds, scale: s };
}

/**
 * @param THREE    the three.js namespace
 * @param baseUrl  URL prefix of /explore/ (e.g. './' from index.html, '../' from lib/)
 * @param opts     { envMap, envMapIntensity, seed, glb (override USE_GLB) }
 */
export async function loadShip(THREE, baseUrl, opts) {
  const o = opts || {};
  const useGlb = typeof o.glb === 'boolean' ? o.glb : USE_GLB;
  let inner = null;
  let source = 'procedural';

  if (useGlb) {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const url = (baseUrl || './').replace(/\/?$/, '/') + 'models/ship.glb';
      const gltf = await new GLTFLoader().loadAsync(url);
      inner = gltf.scene;
      source = 'glb';
      // GLB engines: any mesh whose name or material name mentions "engine", "nozzle" or "thrust"
      const engines = [];
      inner.traverse((m) => {
        if (!m.isMesh) return;
        const n = ((m.name || '') + ' ' + (m.material && m.material.name || '')).toLowerCase();
        if (/engine|nozzle|thrust|exhaust/.test(n)) engines.push(m);
      });
      inner.userData.engines = engines;
      inner.userData.setThrottle = (level) => {
        const t = Math.max(0, Math.min(1, Number(level) || 0));
        for (const m of engines) if (m.material && 'emissiveIntensity' in m.material) m.material.emissiveIntensity = 0.2 + 3 * t;
      };
      inner.userData.update = () => {};
    } catch (err) {
      console.warn('ship.glb not loaded, building the procedural ship', err);
      inner = null;
    }
  }
  if (!inner) inner = makeShipMesh(THREE, o);

  const { holder, bounds } = normalise(THREE, inner);
  holder.userData.setThrottle = inner.userData.setThrottle;
  holder.userData.update = inner.userData.update;
  holder.userData.engines = inner.userData.engines;
  holder.userData.source = source;
  holder.userData.notToScale = true;    // 60 km long on the scene's scale: a display size, not a real one

  return {
    group: holder,
    engines: inner.userData.engines || [],
    length_units: LENGTH_UNITS,
    bounds,
    setThrottle: inner.userData.setThrottle,
    update: inner.userData.update,
    source,
  };
}
