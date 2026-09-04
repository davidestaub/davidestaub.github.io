#!/usr/bin/env python3
"""Independent python re-implementation of explore/lib/catalog.js derivation rules.

Reads explore/data/planets.json, derives the star and planets for a few
hosts, and prints JSON in the same shape as explore/lib/catalog.test.html
so the two outputs can be compared line by line. Also runs the same
whole-catalogue sanity checks the test page runs.

Standard library only:

    python3 tools/check_catalog_lib.py            # default hosts
    python3 tools/check_catalog_lib.py "Kepler-11" # any host names

Rules (mirror of catalog.js; keep the two in step):
  star   missing st_rad -> 1.0 Rsun, st_teff -> 5500 K, st_mass -> 1.0 Msun
  radius measured pl_rade; else from mass (Earth units):
           M <= 1: M^0.28; 1 < M <= 130: min(15, M^0.59);
           M > 130: clamp(11 * (M/318)^-0.04, 8, 16); else 1.5 Re
  orbit  a and P measured; a from P: a_AU = (M P_yr^2)^(1/3);
         P from a: P_yr = sqrt(a_AU^3 / M); both missing: a_AU = 0.5 (i+1)
  e      measured in [0, 1) else 0 'assumed circular'
  teq    measured pl_eqt; else Teff sqrt(Rs / 2a), albedo 0; flagged
         'assumed' when Teff, Rs or a was itself assumed
  spin   locked when P < 20 d, rotation = P; else 24 h
"""

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DATA = os.path.join(REPO, "explore", "data", "planets.json")

SUN_RADIUS_KM = 695700.0
AU_KM = 149597870.7
EARTH_RADIUS_KM = 6371.0
DAYS_PER_YEAR = 365.25

DEFAULT_HOSTS = ["TRAPPIST-1", "WASP-96", "HD 209458", "51 Peg", "Kepler-90"]

TEFF_TABLE = [
    (2500, 1.00, 0.42, 0.16),
    (3000, 1.00, 0.55, 0.25),
    (4000, 1.00, 0.72, 0.45),
    (5000, 1.00, 0.88, 0.72),
    (5800, 1.00, 0.96, 0.88),
    (7000, 0.93, 0.95, 1.00),
    (10000, 0.72, 0.82, 1.00),
    (20000, 0.62, 0.72, 1.00),
]


def pos(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


def teff_rgb(teff):
    if not pos(teff):
        return [0.86, 0.87, 0.92]
    last = len(TEFF_TABLE) - 1
    t = max(TEFF_TABLE[0][0], min(TEFF_TABLE[last][0], teff))
    i = 0
    while i < last - 1 and TEFF_TABLE[i + 1][0] < t:
        i += 1
    a, b = TEFF_TABLE[i], TEFF_TABLE[i + 1]
    f = (t - a[0]) / (b[0] - a[0])
    return [a[k] + (b[k] - a[k]) * f for k in (1, 2, 3)]


def radius_from_mass(m):
    if m <= 1:
        return m ** 0.28
    if m <= 130:
        return min(15.0, m ** 0.59)
    return max(8.0, min(16.0, 11.0 * (m / 318.0) ** -0.04))


def derive_star(rows):
    first = rows[0]
    # fill gaps from later rows, as catalog.js does
    st_rad = next((r["st_rad"] for r in rows if pos(r["st_rad"])), None)
    st_teff = next((r["st_teff"] for r in rows if pos(r["st_teff"])), None)
    st_mass = next((r["st_mass"] for r in rows if pos(r["st_mass"])), None)
    rad = st_rad if st_rad is not None else 1.0
    teff = st_teff if st_teff is not None else 5500.0
    mass = st_mass if st_mass is not None else 1.0
    return {
        "name": first["host"],
        "radius_km": rad * SUN_RADIUS_KM,
        "radius_src": "measured" if st_rad is not None else "assumed",
        "teff": teff,
        "teff_src": "measured" if st_teff is not None else "assumed",
        "mass_msun": mass,
        "mass_src": "measured" if st_mass is not None else "assumed",
        "color": [round(c, 3) for c in teff_rgb(teff)],
    }


def derive_planet(raw, index, star):
    mass_me = raw["pl_bmasse"] if pos(raw["pl_bmasse"]) else None

    if pos(raw["pl_rade"]):
        radius_re, radius_src = raw["pl_rade"], "measured"
    elif mass_me is not None:
        radius_re, radius_src = radius_from_mass(mass_me), "from mass"
    else:
        radius_re, radius_src = 1.5, "assumed"

    M = star["mass_msun"]
    has_a, has_p = pos(raw["pl_orbsmax"]), pos(raw["pl_orbper"])
    if has_a and has_p:
        a_au, a_src = raw["pl_orbsmax"], "measured"
        period, period_src = raw["pl_orbper"], "measured"
    elif has_p:
        period, period_src = raw["pl_orbper"], "measured"
        a_au, a_src = (M * (period / DAYS_PER_YEAR) ** 2) ** (1.0 / 3.0), "from period"
    elif has_a:
        a_au, a_src = raw["pl_orbsmax"], "measured"
        period, period_src = math.sqrt(a_au ** 3 / M) * DAYS_PER_YEAR, "from semi-major axis"
    else:
        a_au, a_src = 0.5 * (index + 1), "assumed"
        period, period_src = math.sqrt(a_au ** 3 / M) * DAYS_PER_YEAR, "assumed"
    a_km = a_au * AU_KM

    ecc = raw["pl_orbeccen"]
    if isinstance(ecc, (int, float)) and math.isfinite(ecc) and 0 <= ecc < 1:
        e, e_src = ecc, "measured"
    else:
        e, e_src = 0, "assumed circular"

    if pos(raw["pl_eqt"]):
        teq, teq_src = raw["pl_eqt"], "measured"
    else:
        teq = star["teff"] * math.sqrt(star["radius_km"] / (2 * a_km))
        assumed = star["teff_src"] == "assumed" or star["radius_src"] == "assumed" or a_src == "assumed"
        teq_src = "assumed" if assumed else "computed"

    locked = period < 20
    rotation = period * 24 if locked else 24

    cls = raw["cls"] if raw["cls"] in ("terrestrial", "super-earth", "neptune-like", "gas-giant") else "unknown"
    return {
        "name": raw["name"], "cls": cls,
        "radius_km": radius_re * EARTH_RADIUS_KM, "radius_src": radius_src,
        "mass_me": mass_me,
        "a_km": a_km, "a_src": a_src,
        "period_days": period, "period_src": period_src,
        "e": e, "e_src": e_src,
        "teq": teq, "teq_src": teq_src,
        "tidally_locked": locked, "rotation_hours": rotation,
    }


def derive_system(rows):
    star = derive_star(rows)
    planets = [derive_planet(r, i, star) for i, r in enumerate(rows)]
    planets.sort(key=lambda p: p["a_km"])
    return {"star": star, "planets": planets}


def main(argv):
    with open(DATA) as fh:
        cat = json.load(fh)
    fields = cat["fields"]
    hosts = {}
    order = []
    for arr in cat["rows"]:
        raw = dict(zip(fields, arr))
        if raw["host"] not in hosts:
            hosts[raw["host"]] = []
            order.append(raw["host"])
        hosts[raw["host"]].append(raw)

    names = argv[1:] or DEFAULT_HOSTS
    print("catalogue: %d rows, %d hosts, retrieved %s" % (cat["meta"]["count"], len(hosts), cat["meta"]["retrieved"]))
    print("teffToRGB(5800) %s" % json.dumps([round(c, 3) for c in teff_rgb(5800)]))

    def find_host(query):
        """Same order as catalog.js findHost: exact, case-insensitive, planet-name prefix."""
        if query in hosts:
            return query
        low = query.lower()
        for h in order:
            if h.lower() == low:
                return h
        for h in order:
            if any(r["name"].lower().startswith(low + " ") for r in hosts[h]):
                return h
        return None

    result = {}
    for name in names:
        h = find_host(name)
        if h is None:
            print("host missing from catalogue: %s" % name, file=sys.stderr)
            return 1
        if h != name:
            print("%s resolved to host %s" % (name, h))
        result[name] = derive_system(hosts[h])
    print(json.dumps(result, indent=1))

    # same assertions as catalog.test.html
    t1 = result.get("TRAPPIST-1")
    if t1 is not None:
        assert len(t1["planets"]) == 7, "TRAPPIST-1 should have 7 planets"
        for p in t1["planets"]:
            assert p["a_src"] == "measured" and p["radius_src"] == "measured", p["name"]
    peg = result.get("51 Peg")
    if peg is not None:
        p = next(p for p in peg["planets"] if p["name"] == "51 Peg b")
        print("51 Peg b radius_src in catalogue: %s" % p["radius_src"])
        rows = [dict(r, pl_rade=None) for r in hosts["51 Peg"]]
        q = derive_system(rows)["planets"][0]
        assert q["radius_src"] == "from mass"
        print("51 Peg b without catalogued radius: %.0f km from mass" % q["radius_km"])
        rows = [dict(r, pl_rade=None, pl_bmasse=None) for r in hosts["51 Peg"]]
        assert derive_system(rows)["planets"][0]["radius_src"] == "assumed"

    n = 0
    src_counts = {}
    for name in order:
        sys_ = derive_system(hosts[name])
        prev = -1.0
        for p in sys_["planets"]:
            n += 1
            for k in ("a_km", "radius_km", "period_days", "teq"):
                assert pos(p[k]), "%s %s = %r" % (p["name"], k, p[k])
            assert 0 <= p["e"] < 1, p["name"]
            assert p["a_km"] >= prev, name
            prev = p["a_km"]
            for k in ("radius_src", "a_src", "period_src", "e_src", "teq_src"):
                key = k + ":" + p[k]
                src_counts[key] = src_counts.get(key, 0) + 1
    print("checked %d planets across %d hosts" % (n, len(order)))
    for k in sorted(src_counts):
        print("  %-32s %d" % (k, src_counts[k]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
