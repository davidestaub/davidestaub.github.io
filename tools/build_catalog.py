#!/usr/bin/env python3
"""Build explore/data/planets.json from the NASA Exoplanet Archive (PSCompPars).

Standard library only. Run from anywhere:

    python3 tools/build_catalog.py

Output contract (see explore/data/planets.json "meta" and "fields"):
  - one row per planet, values in the order listed in "fields"
  - numbers rounded to 4 significant figures, missing values as null
  - x, y, z are heliocentric galactic cartesian coordinates in parsecs
    (x toward the Galactic Centre, y toward l=90, z toward the north
    galactic pole), null when the distance is unknown
  - cls is a coarse size class derived from radius, else mass
"""

import csv
import datetime
import io
import json
import math
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT_PATH = os.path.join(REPO, "explore", "data", "planets.json")

USER_AGENT = "davidestaub.github.io explore catalogue builder (python3 urllib)"

# Columns requested from pscomppars, in the order we want them back.
ARCHIVE_COLUMNS = [
    "pl_name", "hostname", "ra", "dec", "sy_dist",
    "st_teff", "st_rad", "st_mass", "st_spectype",
    "pl_rade", "pl_bmasse", "pl_orbper", "pl_orbsmax", "pl_eqt", "pl_orbeccen",
    "discoverymethod", "disc_year", "sy_pnum",
]

TAP_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
LEGACY_URL = "https://exoplanetarchive.ipac.caltech.edu/cgi-bin/nstedAPI/nph-nstedAPI"

OUTPUT_FIELDS = [
    "name", "host", "ra", "dec", "dist_pc", "x", "y", "z",
    "st_teff", "st_rad", "st_mass", "st_spec",
    "pl_rade", "pl_bmasse", "pl_orbper", "pl_orbsmax", "pl_eqt", "pl_orbeccen",
    "method", "year", "sy_pnum", "cls",
]

# ICRS -> galactic rotation matrix (applied to the ICRS unit vector).
ICRS_TO_GAL = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762],
]

R0_PC = 8178


# ----------------------------------------------------------------------------
# Download
# ----------------------------------------------------------------------------

def ssl_context():
    """Verified TLS context.

    A python.org build on macOS ships without a CA bundle unless
    "Install Certificates.command" was run, so if the default store is empty
    fall back to the operating system bundle. Verification is never disabled.
    """
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509", 0) == 0:
        for cafile in (os.environ.get("SSL_CERT_FILE"), "/etc/ssl/cert.pem",
                       "/etc/ssl/certs/ca-certificates.crt"):
            if cafile and os.path.isfile(cafile):
                ctx.load_verify_locations(cafile=cafile)
                print("  using CA bundle %s" % cafile, file=sys.stderr)
                break
    return ctx


def http_get(url, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_with_retry(url, label, attempts=2):
    last_err = None
    for i in range(attempts):
        try:
            print("fetching %s (attempt %d) ..." % (label, i + 1), file=sys.stderr)
            t0 = time.time()
            text = http_get(url)
            print("  %d bytes in %.1fs" % (len(text), time.time() - t0), file=sys.stderr)
            return text
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last_err = e
            print("  failed: %s" % e, file=sys.stderr)
            if i + 1 < attempts:
                time.sleep(3)
    raise RuntimeError("%s failed after %d attempts: %s" % (label, attempts, last_err))


def download_csv():
    cols = ",".join(ARCHIVE_COLUMNS)
    adql = "select %s from pscomppars" % cols
    tap_url = TAP_URL + "?" + urllib.parse.urlencode({"query": adql, "format": "csv"})
    try:
        text = fetch_with_retry(tap_url, "TAP")
        source_url = tap_url
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        legacy_url = LEGACY_URL + "?" + urllib.parse.urlencode(
            {"table": "pscomppars", "select": cols, "format": "csv"})
        text = fetch_with_retry(legacy_url, "legacy API")
        source_url = legacy_url

    # Guard against an HTML or error body being returned with status 200.
    head = text.lstrip()[:200].lower()
    if head.startswith("<") or "error" in head.split("\n")[0]:
        raise RuntimeError("service returned an error body:\n" + text[:500])
    return text, source_url


def parse_csv(text):
    # The legacy API prefixes comment lines with '#'; TAP does not.
    lines = [ln for ln in text.splitlines() if not ln.startswith("#")]
    reader = csv.DictReader(io.StringIO("\n".join(lines)))
    rows = list(reader)
    missing = [c for c in ARCHIVE_COLUMNS if c not in reader.fieldnames]
    if missing:
        raise RuntimeError("missing columns in response: %s" % missing)
    return rows


# ----------------------------------------------------------------------------
# Transform
# ----------------------------------------------------------------------------

def to_float(s):
    if s is None:
        return None
    s = s.strip()
    if s == "" or s.lower() in ("null", "nan"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def to_int(s):
    v = to_float(s)
    return None if v is None else int(round(v))


def to_str(s):
    if s is None:
        return None
    s = s.strip()
    return s if s else None


def sig4(v):
    """Round to 4 significant figures; return int when the value is integral."""
    if v is None:
        return None
    if v == 0:
        return 0
    digits = 4 - int(math.floor(math.log10(abs(v)))) - 1
    r = round(v, digits)
    if digits <= 0 or float(r).is_integer():
        return int(r)
    return r


def galactic_xyz(ra_deg, dec_deg, dist_pc):
    if ra_deg is None or dec_deg is None or dist_pc is None:
        return None, None, None
    ra = math.radians(ra_deg)
    dec = math.radians(dec_deg)
    u = (math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec))
    out = []
    for row in ICRS_TO_GAL:
        out.append(dist_pc * (row[0] * u[0] + row[1] * u[1] + row[2] * u[2]))
    return out[0], out[1], out[2]


def classify(rade, bmasse):
    if rade is not None:
        if rade < 1.25:
            return "terrestrial"
        if rade < 2.0:
            return "super-earth"
        if rade < 6.0:
            return "neptune-like"
        return "gas-giant"
    if bmasse is not None:
        if bmasse < 2:
            return "terrestrial"
        if bmasse < 10:
            return "super-earth"
        if bmasse < 50:
            return "neptune-like"
        return "gas-giant"
    return "unknown"


def build_row(r):
    ra = to_float(r["ra"])
    dec = to_float(r["dec"])
    dist = to_float(r["sy_dist"])
    x, y, z = galactic_xyz(ra, dec, dist)
    rade = to_float(r["pl_rade"])
    bmasse = to_float(r["pl_bmasse"])
    return [
        to_str(r["pl_name"]),
        to_str(r["hostname"]),
        sig4(ra),
        sig4(dec),
        sig4(dist),
        sig4(x),
        sig4(y),
        sig4(z),
        sig4(to_float(r["st_teff"])),
        sig4(to_float(r["st_rad"])),
        sig4(to_float(r["st_mass"])),
        to_str(r["st_spectype"]),
        sig4(rade),
        sig4(bmasse),
        sig4(to_float(r["pl_orbper"])),
        sig4(to_float(r["pl_orbsmax"])),
        sig4(to_float(r["pl_eqt"])),
        sig4(to_float(r["pl_orbeccen"])),
        to_str(r["discoverymethod"]),
        to_int(r["disc_year"]),
        to_int(r["sy_pnum"]),
        classify(rade, bmasse),
    ]


# ----------------------------------------------------------------------------
# Report
# ----------------------------------------------------------------------------

PC_TO_LY = 3.2615638


def report(rows, raw_rows, out_path):
    n = len(rows)
    idx = {f: i for i, f in enumerate(OUTPUT_FIELDS)}
    with_dist = [r for r in rows if r[idx["dist_pc"]] is not None]
    print("rows: %d" % n)
    print("rows with distance: %d" % len(with_dist))

    counts = {}
    for r in rows:
        counts[r[idx["cls"]]] = counts.get(r[idx["cls"]], 0) + 1
    print("class counts:")
    for k in ["terrestrial", "super-earth", "neptune-like", "gas-giant", "unknown"]:
        print("  %-13s %d" % (k, counts.get(k, 0)))

    # nearest systems (one entry per host)
    by_host = {}
    for r in with_dist:
        h = r[idx["host"]]
        d = r[idx["dist_pc"]]
        if h not in by_host or d < by_host[h][0]:
            by_host[h] = (d, r[idx["sy_pnum"]])
    nearest = sorted(by_host.items(), key=lambda kv: kv[1][0])[:5]
    print("5 nearest systems:")
    for h, (d, npl) in nearest:
        print("  %-20s %8.3f pc  %8.3f ly  (%s planets)" % (h, d, d * PC_TO_LY, npl))

    dists = sorted(r[idx["dist_pc"]] for r in with_dist)
    if dists:
        k = (len(dists) - 1) * 0.99
        lo, hi = int(math.floor(k)), int(math.ceil(k))
        p99 = dists[lo] + (dists[hi] - dists[lo]) * (k - lo)
        print("99th percentile distance: %.1f pc = %.1f ly" % (p99, p99 * PC_TO_LY))
        print("max distance: %.1f pc = %.1f ly (%s)" % (
            dists[-1], dists[-1] * PC_TO_LY,
            [r[idx["name"]] for r in with_dist if r[idx["dist_pc"]] == dists[-1]][0]))

    print("file size: %d bytes (%.1f KB)" % (os.path.getsize(out_path), os.path.getsize(out_path) / 1024.0))

    # quirks
    names = [r[idx["name"]] for r in rows]
    dup = sorted(set(x for x in names if names.count(x) > 1)) if n < 20000 else []
    print("duplicate planet names: %d %s" % (len(dup), dup[:10]))
    print("null fraction per field:")
    for f in OUTPUT_FIELDS:
        nn = sum(1 for r in rows if r[idx[f]] is None)
        if nn:
            print("  %-12s %5d  (%.1f%%)" % (f, nn, 100.0 * nn / n))
    bad_coord = sum(1 for r in rows if r[idx["ra"]] is None or r[idx["dec"]] is None)
    print("rows without ra/dec: %d" % bad_coord)
    ecc_bad = sum(1 for r in rows if r[idx["pl_orbeccen"]] is not None and not (0 <= r[idx["pl_orbeccen"]] < 1))
    print("rows with eccentricity outside [0,1): %d" % ecc_bad)
    no_class_input = sum(1 for r in rows if r[idx["pl_rade"]] is None and r[idx["pl_bmasse"]] is None)
    print("rows with neither radius nor mass: %d" % no_class_input)


# ----------------------------------------------------------------------------

def main():
    text, source_url = download_csv()
    raw_rows = parse_csv(text)
    rows = [build_row(r) for r in raw_rows]
    rows.sort(key=lambda r: ((r[1] or ""), (r[0] or "")))

    with_distance = sum(1 for r in rows if r[4] is not None)
    doc = {
        "meta": {
            "source": "NASA Exoplanet Archive, PSCompPars",
            "retrieved": datetime.date.today().isoformat(),
            "count": len(rows),
            "with_distance": with_distance,
            "frame": ("heliocentric galactic cartesian, parsecs; x toward Galactic Centre (l=0,b=0), "
                      "y toward l=90, z toward north galactic pole"),
            "r0_pc": R0_PC,
        },
        "fields": OUTPUT_FIELDS,
        "rows": rows,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        f.write("\n")

    print("wrote %s" % OUT_PATH, file=sys.stderr)
    print("source: %s" % source_url, file=sys.stderr)
    report(rows, raw_rows, OUT_PATH)


if __name__ == "__main__":
    main()
