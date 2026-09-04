#!/usr/bin/env python3
"""Build explore/data/stars.json from the HYG star database.

Standard library only. Downloads the current HYG CSV from GitHub
(astronexus/HYG-Database), keeps stars with visual magnitude <= 7.0 and a
finite distance, drops the Sun, and writes galactic cartesian coordinates in
the same frame as explore/data/planets.json.

Frame: heliocentric galactic cartesian, parsecs. x toward the Galactic Centre
(l=0, b=0), y toward l=90, z toward the north galactic pole. The ICRS unit
vector (from ra in hours and dec in degrees) is rotated with the matrix below
and scaled by the distance. HYG's own x,y,z are equatorial and are ignored.

Usage:
    python3 tools/build_stars.py            # download and build
    python3 tools/build_stars.py --csv PATH # use a local copy of the CSV
"""

import argparse
import csv
import gzip
import io
import json
import math
import os
import subprocess
import sys
import urllib.request

# Candidate raw URLs, tried in order. The first is the current release.
HYG_URLS = [
    "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv",
    "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz",
    "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v38.csv.gz",
]

MAG_LIMIT = 7.0

# HYG stores 100000 pc for stars without a usable parallax.
DIST_SENTINEL = 100000.0

# ICRS -> galactic rotation matrix (data contract).
ROT = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762],
]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.normpath(os.path.join(HERE, "..", "explore", "data", "stars.json"))


def sig4(v):
    """Round to 4 significant figures, returning int when exact."""
    if v == 0:
        return 0
    r = round(v, 3 - int(math.floor(math.log10(abs(v)))))
    if r == int(r) and abs(r) < 1e15:
        return int(r)
    return r


def fetch_csv(csv_path=None):
    if csv_path:
        with open(csv_path, "rb") as f:
            raw = f.read()
        src = csv_path
    else:
        raw = None
        src = None
        for url in HYG_URLS:
            sys.stderr.write("fetching %s\n" % url)
            try:
                with urllib.request.urlopen(url, timeout=120) as r:
                    raw = r.read()
                src = url
                break
            except Exception as e:  # noqa: BLE001
                sys.stderr.write("  urllib failed: %s\n" % e)
            # Some python.org builds on macOS ship without a CA bundle; fall
            # back to the system curl, which uses the OS trust store.
            try:
                res = subprocess.run(["curl", "-sSL", "--fail", url],
                                     capture_output=True, timeout=300, check=True)
                raw = res.stdout
                src = url
                break
            except Exception as e:  # noqa: BLE001
                sys.stderr.write("  curl failed: %s\n" % e)
        if raw is None:
            sys.exit("could not download the HYG CSV from any known URL")
    if raw[:2] == b"\x1f\x8b" or (src or "").endswith(".gz"):
        raw = gzip.decompress(raw)
    return raw.decode("utf-8"), src


def to_float(s):
    if s is None or s == "":
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if not math.isfinite(v):
        return None
    return v


def galactic_xyz(ra_hours, dec_deg, dist_pc):
    ra = math.radians(ra_hours * 15.0)
    dec = math.radians(dec_deg)
    ux = math.cos(dec) * math.cos(ra)
    uy = math.cos(dec) * math.sin(ra)
    uz = math.sin(dec)
    u = (ux, uy, uz)
    return tuple(dist_pc * sum(ROT[i][j] * u[j] for j in range(3)) for i in range(3))


def build(text):
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for rec in reader:
        mag = to_float(rec.get("mag"))
        dist = to_float(rec.get("dist"))
        ra = to_float(rec.get("ra"))
        dec = to_float(rec.get("dec"))
        if mag is None or dist is None or ra is None or dec is None:
            continue
        if mag > MAG_LIMIT:
            continue
        if dist <= 0 or dist >= DIST_SENTINEL:
            continue  # the Sun (dist 0) and stars without a parallax
        name = (rec.get("proper") or "").strip() or None
        if name == "Sol":
            continue
        ci = to_float(rec.get("ci"))
        x, y, z = galactic_xyz(ra, dec, dist)
        rows.append([sig4(x), sig4(y), sig4(z), sig4(mag),
                     sig4(ci) if ci is not None else None, name])
    rows.sort(key=lambda r: r[3])  # brightest first
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="local HYG CSV (plain or .gz) instead of downloading")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    text, src = fetch_csv(args.csv)
    rows = build(text)

    data = {
        "meta": {
            "source": "HYG database v3/v4 (astronexus), stars with visual magnitude <= 7.0",
            "count": len(rows),
            "frame": "same galactic cartesian frame, parsecs",
        },
        "fields": ["x", "y", "z", "mag", "ci", "name"],
        "rows": rows,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(args.out)
    sys.stderr.write("source: %s\nstars: %d\nwrote %s (%d bytes)\n" % (src, len(rows), args.out, size))


if __name__ == "__main__":
    main()
