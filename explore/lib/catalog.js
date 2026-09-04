/* ===================================================================
   /explore/lib/catalog.js
   Catalogue loader and derivation rules for the star system renderer.

   Pure ES module. No three.js, no DOM. Everything here is either a
   catalogued number copied from data/planets.json (NASA Exoplanet
   Archive, PSCompPars) or a derived number whose rule is written down
   next to the code and flagged in a *_src field so the page can report
   it honestly.

   Units
     Catalogue: parsecs, solar radii, solar masses, Earth radii, Earth
       masses, days, AU, kelvin.
     Planet objects: kilometres for lengths (radius_km, a_km), days for
       periods, kelvin for temperatures, hours for rotation.
     Scene: 1 unit = KM_PER_UNIT km. The renderer divides km by
       KM_PER_UNIT; this module never touches scene units apart from
       exporting the constant.

   Source flags (every derived field carries one)
     radius_src  'measured' | 'from mass' | 'assumed'
     a_src       'measured' | 'from period' | 'assumed'
     period_src  'measured' | 'from semi-major axis' | 'assumed'
     e_src       'measured' | 'assumed circular'
     teq_src     'measured' | 'computed' | 'assumed'
     star.radius_src, star.mass_src
                 'measured' | 'assumed'
     star.teff_src
                 'measured' | 'from spectral type' | 'assumed'

   The python script tools/check_catalog_lib.py re-implements the same
   rules independently; keep the two in step.
   =================================================================== */

export const KM_PER_UNIT = 1000;
export const SUN_RADIUS_KM = 695700;
export const AU_KM = 149597870.7;
export const EARTH_RADIUS_KM = 6371;
export const JUP_RADIUS_KM = 69911;
export const JUP_MASS_ME = 317.8;      // Jupiter mass in Earth masses
export const LY_PER_PC = 3.26156;
export const DAYS_PER_YEAR = 365.25;

/* Defaults used when the catalogue has no value. Each use is flagged. */
export const ASSUMED = Object.freeze({
  st_rad: 1.0,        // solar radii
  st_teff: 5500,      // kelvin
  st_mass: 1.0,       // solar masses
  radius_re: 1.5,     // Earth radii, when neither radius nor mass is known
  a_step_au: 0.5,     // a_AU = 0.5 * (index + 1) when neither a nor period is known
  e: 0,               // circular
  locked_below_days: 20,
  rotation_hours_free: 24,
});

/* Rough effective temperature per spectral class letter, used only when
   the catalogue has a spectral type but no temperature. A single value
   per class (about the middle of the class), flagged 'from spectral type'. */
export const SPECTRAL_TEFF = Object.freeze({
  O: 30000, B: 20000, A: 8500, F: 6500, G: 5500, K: 4500, M: 3200, L: 2000, T: 1200, Y: 500,
});

/** Class letter of a spectral type string ('M5.5/M6' -> 'M', 'K2.5 V' -> 'K'), or null.
    Strings that start with anything else (white dwarfs 'WD', 'DA', 'DC', subdwarf prefixes) give null. */
export function spectralClass(spec) {
  if (spec == null) return null;
  const m = /^([OBAFGKMLTY])(?![A-Z])/.exec(String(spec).trim());
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------
   Loading
   ------------------------------------------------------------------ */

/**
 * Fetch baseUrl + 'data/planets.json' and group rows by host.
 * @param {string|URL} baseUrl  directory that contains data/, with or
 *   without a trailing slash. Resolved relative to the document.
 * @returns {Promise<{meta: object, hosts: Map<string, Host>, hostList: Host[]}>}
 */
export async function loadCatalog(baseUrl) {
  let base = String(baseUrl == null ? '' : baseUrl);
  if (base && !base.endsWith('/')) base += '/';
  const res = await fetch(base + 'data/planets.json');
  if (!res.ok) throw new Error('catalog: ' + res.status + ' ' + res.statusText + ' for ' + base + 'data/planets.json');
  const json = await res.json();
  return buildCatalog(json);
}

/**
 * Build the host map from an already-parsed planets.json object.
 * Exported so tests can feed a fixture without fetch.
 */
export function buildCatalog(json) {
  const fields = json.fields;
  const rows = json.rows;
  const idx = {};
  fields.forEach((f, i) => { idx[f] = i; });
  const need = ['name', 'host', 'dist_pc', 'x', 'y', 'z', 'st_teff', 'st_rad', 'st_mass',
    'st_spec', 'pl_rade', 'pl_bmasse', 'pl_orbper', 'pl_orbsmax', 'pl_eqt',
    'pl_orbeccen', 'method', 'year', 'cls'];
  for (const f of need) {
    if (!(f in idx)) throw new Error('catalog: planets.json is missing field ' + f);
  }

  const hosts = new Map();
  const hostList = [];
  for (const arr of rows) {
    const raw = {};
    for (let i = 0; i < fields.length; i++) raw[fields[i]] = arr[i];
    let host = hosts.get(raw.host);
    if (!host) {
      host = {
        name: raw.host,
        dist_pc: numOrNull(raw.dist_pc),
        x: numOrNull(raw.x),
        y: numOrNull(raw.y),
        z: numOrNull(raw.z),
        teff: numOrNull(raw.st_teff),
        st_rad: numOrNull(raw.st_rad),
        st_mass: numOrNull(raw.st_mass),
        spec: raw.st_spec == null ? null : String(raw.st_spec),
        planets: [],
        _raw: [],
      };
      hosts.set(raw.host, host);
      hostList.push(host);
    } else {
      // Rows of one host repeat the stellar values; fill gaps if a later
      // row happens to carry a value an earlier one lacked.
      if (host.dist_pc == null && raw.dist_pc != null) { host.dist_pc = raw.dist_pc; host.x = raw.x; host.y = raw.y; host.z = raw.z; }
      if (host.teff == null && raw.st_teff != null) host.teff = raw.st_teff;
      if (host.st_rad == null && raw.st_rad != null) host.st_rad = raw.st_rad;
      if (host.st_mass == null && raw.st_mass != null) host.st_mass = raw.st_mass;
      if (host.spec == null && raw.st_spec != null) host.spec = String(raw.st_spec);
    }
    host._raw.push(raw);
  }

  // Derive planets once per host so host.planets is ready to use.
  for (const host of hostList) {
    const star = deriveStar(host);
    host.planets = derivePlanets(host, star);
  }

  return { meta: json.meta || {}, hosts, hostList };
}

/**
 * Look a host up by name. Order: exact host name, case-insensitive host
 * name, then a host owning a planet whose name starts with the query
 * (the archive files Kepler-90 b..h under host "KOI-351", for example,
 * so "Kepler-90" resolves through the planet "Kepler-90 i").
 * @returns {Host|null}
 */
export function findHost(catalog, query) {
  if (query == null) return null;
  const q = String(query).trim();
  if (!q) return null;
  const exact = catalog.hosts.get(q);
  if (exact) return exact;
  const lower = q.toLowerCase();
  for (const host of catalog.hostList) {
    if (host.name.toLowerCase() === lower) return host;
  }
  const prefix = lower + ' ';
  for (const host of catalog.hostList) {
    for (const p of host.planets) {
      if (String(p.name).toLowerCase().startsWith(prefix)) return host;
    }
  }
  return null;
}

/* ------------------------------------------------------------------
   Star
   ------------------------------------------------------------------ */

/**
 * Stellar parameters with defaults.
 *   missing st_rad  -> 1.0 solar radii, radius_src 'assumed'
 *   missing st_teff -> SPECTRAL_TEFF[class letter] when st_spec has one,
 *                      teff_src 'from spectral type'; else 5500 K, 'assumed'
 *   missing st_mass -> 1.0 solar masses, mass_src  'assumed'
 */
export function deriveStar(host) {
  const hasRad = isPos(host.st_rad);
  const hasTeff = isPos(host.teff);
  const hasMass = isPos(host.st_mass);
  const rad_rsun = hasRad ? host.st_rad : ASSUMED.st_rad;
  const specClass = hasTeff ? null : spectralClass(host.spec);
  let teff, teff_src;
  if (hasTeff) { teff = host.teff; teff_src = 'measured'; }
  else if (specClass) { teff = SPECTRAL_TEFF[specClass]; teff_src = 'from spectral type'; }
  else { teff = ASSUMED.st_teff; teff_src = 'assumed'; }
  const mass_msun = hasMass ? host.st_mass : ASSUMED.st_mass;
  return {
    name: host.name,
    radius_km: rad_rsun * SUN_RADIUS_KM,
    radius_rsun: rad_rsun,
    radius_src: hasRad ? 'measured' : 'assumed',
    teff,
    teff_src,
    mass_msun,
    mass_src: hasMass ? 'measured' : 'assumed',
    spec: host.spec,
    dist_pc: host.dist_pc,
    color: teffToRGB(teff),
  };
}

/**
 * Star plus planets sorted by semi-major axis.
 * Deterministic: calling it again on the same host gives the same numbers.
 */
export function deriveSystem(host) {
  const star = deriveStar(host);
  const planets = derivePlanets(host, star);
  return { star, planets };
}

function derivePlanets(host, star) {
  const raws = host._raw || host.planets.map((p) => p.raw);
  const planets = raws.map((raw, i) => derivePlanet(raw, i, star));
  planets.sort((p, q) => p.a_km - q.a_km);
  return planets;
}

/* ------------------------------------------------------------------
   Planet
   ------------------------------------------------------------------ */

/**
 * One planet from one catalogue row.
 * @param raw   row object keyed by field name
 * @param index position of the row within its host (catalogue order);
 *              only used for the "both a and period missing" fallback
 * @param star  from deriveStar
 */
export function derivePlanet(raw, index, star) {
  const mass_me = isPos(raw.pl_bmasse) ? raw.pl_bmasse : null;

  // ---- radius -----------------------------------------------------
  // measured  : pl_rade (Earth radii)
  // from mass : mass-radius power laws, Earth units
  //               M <= 1      R = M^0.28
  //               1 < M <= 130  R = M^0.59, capped at 15 Re
  //               M > 130     R = 11 * (M / 318)^-0.04, clamped to [8, 16]
  //             (rocky planets grow slowly with mass; volatile-rich
  //              planets grow faster; gas giants sit near one Jupiter
  //              radius and shrink slightly with mass.)
  // assumed   : 1.5 Re when neither radius nor mass is known
  let radius_re, radius_src;
  if (isPos(raw.pl_rade)) {
    radius_re = raw.pl_rade; radius_src = 'measured';
  } else if (mass_me != null) {
    radius_re = radiusFromMass(mass_me); radius_src = 'from mass';
  } else {
    radius_re = ASSUMED.radius_re; radius_src = 'assumed';
  }

  // ---- orbit size and period ----------------------------------------
  // measured           : pl_orbsmax (AU), pl_orbper (days)
  // a from period      : Kepler's third law, a_AU = (M * P_yr^2)^(1/3)
  //                      with M the stellar mass in solar masses
  //                      (planet mass neglected)
  // period from a      : P_yr = sqrt(a_AU^3 / M)
  // both missing       : a_AU = 0.5 * (index + 1), then period from a;
  //                      both flagged 'assumed'
  const M = star.mass_msun;
  let a_au, a_src, period_days, period_src;
  const hasA = isPos(raw.pl_orbsmax);
  const hasP = isPos(raw.pl_orbper);
  if (hasA && hasP) {
    a_au = raw.pl_orbsmax; a_src = 'measured';
    period_days = raw.pl_orbper; period_src = 'measured';
  } else if (hasP) {
    period_days = raw.pl_orbper; period_src = 'measured';
    a_au = Math.cbrt(M * Math.pow(period_days / DAYS_PER_YEAR, 2)); a_src = 'from period';
  } else if (hasA) {
    a_au = raw.pl_orbsmax; a_src = 'measured';
    period_days = Math.sqrt(Math.pow(a_au, 3) / M) * DAYS_PER_YEAR; period_src = 'from semi-major axis';
  } else {
    a_au = ASSUMED.a_step_au * (index + 1); a_src = 'assumed';
    period_days = Math.sqrt(Math.pow(a_au, 3) / M) * DAYS_PER_YEAR; period_src = 'assumed';
  }
  const a_km = a_au * AU_KM;

  // ---- eccentricity ---------------------------------------------------
  // measured when catalogued (0 is a valid catalogued value), else 0.
  let e, e_src;
  if (isFiniteNum(raw.pl_orbeccen) && raw.pl_orbeccen >= 0 && raw.pl_orbeccen < 1) {
    e = raw.pl_orbeccen; e_src = 'measured';
  } else {
    e = ASSUMED.e; e_src = 'assumed circular';
  }

  // ---- equilibrium temperature ------------------------------------------
  // measured : pl_eqt as catalogued (itself a modelled quantity, but it is
  //            the archive's number, not ours)
  // computed : Teq = Teff * sqrt(Rs / (2 a)), Rs and a in km, Bond albedo 0,
  //            full redistribution. Flagged 'assumed' instead of 'computed'
  //            when any input (Teff, Rs, a) was itself assumed or, for
  //            Teff, only read off the spectral type.
  let teq, teq_src;
  if (isPos(raw.pl_eqt)) {
    teq = raw.pl_eqt; teq_src = 'measured';
  } else {
    teq = star.teff * Math.sqrt(star.radius_km / (2 * a_km));
    const inputsAssumed = star.teff_src !== 'measured' || star.radius_src === 'assumed' || a_src === 'assumed';
    teq_src = inputsAssumed ? 'assumed' : 'computed';
  }

  // ---- rotation (always assumed; nothing in the catalogue measures it) ----
  // period < 20 days -> tidally locked, rotation = orbital period
  // otherwise         -> 24 h
  const tidally_locked = period_days < ASSUMED.locked_below_days;
  const rotation_hours = tidally_locked ? period_days * 24 : ASSUMED.rotation_hours_free;

  return {
    name: raw.name,
    host: raw.host,
    method: raw.method == null ? null : String(raw.method),
    year: isFiniteNum(raw.year) ? raw.year : null,
    cls: CLASSES.has(raw.cls) ? raw.cls : 'unknown',
    radius_km: radius_re * EARTH_RADIUS_KM,
    radius_re,
    radius_src,
    mass_me,
    a_km,
    a_au,
    a_src,
    period_days,
    period_src,
    e,
    e_src,
    teq,
    teq_src,
    tidally_locked,
    rotation_hours,
    raw,
  };
}

const CLASSES = new Set(['terrestrial', 'super-earth', 'neptune-like', 'gas-giant', 'unknown']);

/* Discovery methods that observe the planet's size directly. */
const RADIUS_METHODS = new Set(['Transit', 'Transit Timing Variations', 'Orbital Brightness Modulation']);

/** Mass-radius rule, Earth units. See derivePlanet for the rationale. */
export function radiusFromMass(mass_me) {
  if (mass_me <= 1) return Math.pow(mass_me, 0.28);
  if (mass_me <= 130) return Math.min(15, Math.pow(mass_me, 0.59));
  const r = 11 * Math.pow(mass_me / 318, -0.04);
  return Math.max(8, Math.min(16, r));
}

/* ------------------------------------------------------------------
   Colour from effective temperature
   ------------------------------------------------------------------ */

/* Piecewise-linear approximation of a blackbody's apparent colour on a
   dark display. Same table as explore/explore.js so the galaxy map and
   the system view agree. 3000 K orange, 5800 K warm white, 10000 K
   blue-white. Clamped outside [2500, 20000] K. */
const TEFF_TABLE = [
  [2500, 1.00, 0.42, 0.16],
  [3000, 1.00, 0.55, 0.25],
  [4000, 1.00, 0.72, 0.45],
  [5000, 1.00, 0.88, 0.72],
  [5800, 1.00, 0.96, 0.88],
  [7000, 0.93, 0.95, 1.00],
  [10000, 0.72, 0.82, 1.00],
  [20000, 0.62, 0.72, 1.00],
];

/** @returns {[number, number, number]} r, g, b in 0..1 */
export function teffToRGB(teff) {
  if (!isPos(teff)) return [0.86, 0.87, 0.92];
  const last = TEFF_TABLE.length - 1;
  const t = Math.max(TEFF_TABLE[0][0], Math.min(TEFF_TABLE[last][0], teff));
  let i = 0;
  while (i < last - 1 && TEFF_TABLE[i + 1][0] < t) i++;
  const a = TEFF_TABLE[i], b = TEFF_TABLE[i + 1];
  const f = (t - a[0]) / (b[0] - a[0]);
  return [
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ];
}

/* ------------------------------------------------------------------
   Dossier rows
   ------------------------------------------------------------------ */

/**
 * Rows for the MEASURED column: catalogued numbers and clearly marked
 * derived numbers only. Anything that rests on an assumed value is left
 * out here and reported by describeAssumed instead.
 * @returns {Array<{label: string, value: string, note?: string}>}
 */
export function describeMeasured(planet, star) {
  const rows = [];
  const raw = planet.raw || {};

  if (planet.method) {
    rows.push({ label: 'discovery', value: planet.method + (planet.year ? ', ' + planet.year : '') });
  }

  const dist_pc = isPos(raw.dist_pc) ? raw.dist_pc : (star && isPos(star.dist_pc) ? star.dist_pc : null);
  if (dist_pc != null) {
    rows.push({ label: 'distance from Earth', value: fmt(dist_pc * LY_PER_PC, 3) + ' light-years', note: fmt(dist_pc, 3) + ' pc, catalogued' });
  }

  if (star) {
    if (star.teff_src === 'measured') rows.push({ label: 'star temperature', value: fmt(star.teff, 4) + ' K', note: 'measured' });
    else if (star.teff_src === 'from spectral type') rows.push({ label: 'star temperature', value: fmt(star.teff, 4) + ' K', note: 'rough value from the catalogued spectral type ' + (star.spec || '') });
    if (star.radius_src === 'measured') rows.push({ label: 'star radius', value: fmt(star.radius_rsun, 3) + ' solar radii', note: 'measured' });
    if (star.mass_src === 'measured') rows.push({ label: 'star mass', value: fmt(star.mass_msun, 3) + ' solar masses', note: 'measured' });
    if (star.spec) rows.push({ label: 'spectral type', value: star.spec, note: 'catalogued' });
  }

  // radius. PSCompPars lists a radius for every planet; for planets that
  // do not transit it is a value the archive calculated from mass, and
  // planets.json does not carry that flag. So the note says 'measured'
  // only when the discovery method observes the planet's size, else
  // 'catalogued' (true in both cases; the number is the archive's).
  if (planet.radius_src !== 'assumed') {
    let note = planet.radius_src;
    if (note === 'measured' && !RADIUS_METHODS.has(planet.method)) note = 'catalogued';
    rows.push({ label: 'radius', value: fmtRadius(planet.radius_re), note });
  }

  // mass
  if (planet.mass_me != null) {
    rows.push({ label: 'mass', value: fmtMass(planet.mass_me), note: 'measured, mass or minimum mass' });
  }

  // period
  if (planet.period_src !== 'assumed') {
    let note = planet.period_src;
    if (planet.period_src === 'from semi-major axis') note += massNote(star);
    rows.push({ label: 'orbital period', value: fmtPeriod(planet.period_days), note });
  }

  // semi-major axis
  if (planet.a_src !== 'assumed') {
    let note = planet.a_src;
    if (planet.a_src === 'from period') note += massNote(star);
    const inRs = star
      ? ', ' + fmt(planet.a_km / star.radius_km, 3) + ' star radii' + (star.radius_src === 'assumed' ? ', using an assumed star radius' : '')
      : '';
    rows.push({ label: 'semi-major axis', value: fmt(planet.a_au, 3) + ' AU', note: note + inRs });
  }

  // eccentricity
  if (planet.e_src === 'measured') {
    rows.push({ label: 'eccentricity', value: fmt(planet.e, 3), note: 'measured' });
  }

  // equilibrium temperature
  if (planet.teq_src === 'measured') {
    rows.push({ label: 'equilibrium temperature', value: fmt(planet.teq, 4) + ' K', note: 'catalogue value' });
  } else if (planet.teq_src === 'computed') {
    rows.push({ label: 'equilibrium temperature', value: fmt(planet.teq, 4) + ' K', note: 'computed from star temperature, star radius and semi-major axis, albedo 0' });
  }

  return rows;
}

/**
 * Rows for the IMAGINED column that come from this module (the renderer
 * adds its own rows for surface, colours, atmosphere). Every row here is
 * an assumption made because the catalogue has no value.
 * @returns {Array<{label: string, value: string, note?: string}>}
 */
export function describeAssumed(planet, star) {
  const rows = [];
  if (star) {
    if (star.teff_src === 'assumed') rows.push({ label: 'star temperature', value: fmt(star.teff, 4) + ' K', note: 'assumed, not in catalogue' });
    if (star.radius_src === 'assumed') rows.push({ label: 'star radius', value: fmt(star.radius_rsun, 3) + ' solar radii', note: 'assumed, not in catalogue' });
    if (star.mass_src === 'assumed') rows.push({ label: 'star mass', value: fmt(star.mass_msun, 3) + ' solar masses', note: 'assumed, not in catalogue' });
  }
  if (planet.radius_src === 'assumed') rows.push({ label: 'radius', value: fmtRadius(planet.radius_re), note: 'assumed, neither radius nor mass in catalogue' });
  if (planet.a_src === 'assumed') rows.push({ label: 'semi-major axis', value: fmt(planet.a_au, 3) + ' AU', note: 'assumed, neither semi-major axis nor period in catalogue' });
  if (planet.period_src === 'assumed') rows.push({ label: 'orbital period', value: fmtPeriod(planet.period_days), note: 'from the assumed semi-major axis' });
  if (planet.e_src !== 'measured') rows.push({ label: 'orbit shape', value: 'circular', note: 'eccentricity not in catalogue' });
  if (planet.teq_src === 'assumed') rows.push({ label: 'equilibrium temperature', value: fmt(planet.teq, 4) + ' K', note: 'computed from assumed inputs, albedo 0' });
  rows.push({
    label: 'rotation',
    value: planet.tidally_locked ? 'tidally locked, one face to the star' : fmt(planet.rotation_hours, 3) + ' hours',
    note: planet.tidally_locked ? 'assumed for orbital periods under 20 days' : 'assumed, rotation is not measured',
  });
  return rows;
}

/* ------------------------------------------------------------------
   Formatting helpers
   ------------------------------------------------------------------ */

/** Number to `digits` significant figures, no exponent, thousands separators. */
export function fmt(n, digits) {
  if (!isFiniteNum(n)) return 'n/a';
  const d = digits == null ? 3 : digits;
  const v = Number(n.toPrecision(d));
  return v.toLocaleString('en-GB', { maximumFractionDigits: 12 });
}

export function fmtRadius(radius_re) {
  if (radius_re >= 6) return fmt(radius_re / (JUP_RADIUS_KM / EARTH_RADIUS_KM), 3) + ' Jupiter radii (' + fmt(radius_re, 3) + ' Earth radii)';
  return fmt(radius_re, 3) + ' Earth radii';
}

export function fmtMass(mass_me) {
  if (mass_me >= 50) return fmt(mass_me / JUP_MASS_ME, 3) + ' Jupiter masses (' + fmt(mass_me, 3) + ' Earth masses)';
  return fmt(mass_me, 3) + ' Earth masses';
}

export function fmtPeriod(days) {
  if (days >= 2 * DAYS_PER_YEAR) return fmt(days / DAYS_PER_YEAR, 3) + ' years';
  if (days < 1) return fmt(days * 24, 3) + ' hours';
  return fmt(days, 3) + ' days';
}

export function fmtLy(pc) {
  return fmt(pc * LY_PER_PC, 3) + ' ly';
}

function massNote(star) {
  return star && star.mass_src === 'assumed' ? ', using an assumed star mass' : '';
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPos(v) {
  return isFiniteNum(v) && v > 0;
}

function numOrNull(v) {
  return isFiniteNum(v) ? v : null;
}
