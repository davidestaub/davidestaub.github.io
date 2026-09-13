import json
from pathlib import Path
r=Path(__file__).resolve().parents[1]
c=json.loads((r/'assets/data/atlas-catalogue.json').read_text())
from html import escape as e
s='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Exoplanet Archive · Research</title><style>body{background:#080c0d;color:#d4c9b5;font:16px/1.8 system-ui;max-width:950px;margin:auto;padding:32px}a{color:#e7bd79}h1,h2,h3{font-weight:500;color:#f2d59f}article{border-top:1px solid #4b4130;padding:28px 0}nav{display:flex;flex-wrap:wrap;gap:8px 20px}table{width:100%;font-size:14px}td,th{text-align:left;padding:8px}details{margin:16px 0}li{margin:8px 0}</style><p><a href="../../../blog/exoplanet-archive.html">← Exoplanet Archive</a></p><h1>Research behind the 40 planets</h1><p>The observations, possible interiors and source papers used in the archive. Updated 13 September 2026.</p><nav>'''
s+=''.join('<a href="#'+p['id']+'">'+e(p['name'])+'</a>' for p in c['planets'])+'</nav>'
for p in c['planets']:
 s+='<article id="'+p['id']+'"><h2>'+e(p['name'])+'</h2><p>'+e(p['intro'])+'</p>'
 for v in p['story']:
  s+='<h3>'+e(v['title'])+'</h3><p>'+e(v['text'])+'</p><p><a href="'+e(v['url'],quote=True)+'">'+e(v['citation'])+'</a></p>'
  for a in v.get('also',[]):s+='<p><a href="'+e(a['url'],quote=True)+'">'+e(a['title'])+'</a></p>'
 s+='<details><summary>Possible interior layers</summary><p>'+e(p['interior'])+'</p>'
 for l in p['layers']:s+='<h3>'+e(l['name'])+'</h3><p>'+e(l['text'])+'</p><a href="'+e(l['source']['url'],quote=True)+'">'+e(l['source']['title'])+'</a>'
 s+='</details><details><summary>Read the research</summary><ol>'
 for v in p['sources']:s+='<li><a href="'+e(v['url'],quote=True)+'">'+e(v['title'])+'</a></li>'
 s+='</ol></details></article>'
s+='</html>'
(r/'research-notes/atlas-library/catalogue-200/index.html').write_text(s)
