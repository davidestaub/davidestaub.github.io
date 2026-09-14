/* Catalogue UI. Parameter provenance is available in the evidence dialog. */
(async function(){
'use strict';
const filters=[
 {id:'temperature',label:'Temperature',ends:['Cold','Hot'],options:['Any','Cold · <250 K','250–500 K','500–1,000 K','1,000–1,500 K','Hot · ≥1,500 K'],match:5},
 {id:'star',label:'Host star',ticks:'M K G F A',options:['Any','M-type','K-type','G-type','F-type','A-type','B-type','O-type','White dwarf','Neutron star','Brown dwarf'],match:3},
 {id:'type',label:'Planet type',ticks:'ROCK / GAS',options:['Any','Rocky','Neptune-like','Gas giant'],match:1},
 {id:'size',label:'Size',ends:['Small','Large'],options:['Any','<10,000 km','10,000–25,000 km','25,000–75,000 km','≥75,000 km'],match:2},
 {id:'orbit',label:'Orbit distance',ends:['Close','Far'],options:['Any','<0.05 AU','0.05–0.5 AU','0.5–2 AU','≥2 AU'],match:1}
];
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
let globe, galaxy, current=null, catalogue, systems;
try { const response=await fetch('../assets/data/atlas-catalogue.json?v=reader6'); if(!response.ok)throw new Error('Catalogue download failed'); const data=await response.json();catalogue=data.planets;systems=data.systems; }
catch(error){$('#results').textContent='The catalogue could not load. Please refresh the page.';$('#count').textContent='Load error';return;}
const byId=new Map(catalogue.map(p=>[p.id,p]));
let artwork={};
try{const r=await fetch('../assets/data/atlas-art.json?v=collection40');if(r.ok)artwork=(await r.json()).planets||{};}catch(error){console.warn('New artwork manifest unavailable',error);}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
globe=window.AtlasGlobes?.(artwork);
try{const r=await fetch('../assets/data/atlas-galaxy.json?v=reader6');if(r.ok)galaxy=AtlasGalaxy(await r.json(),catalogue);}catch(e){$('#galaxy-readout').textContent='The map data could not load. Please refresh.';}
const originalPoster='../assets/img/atlas/55-cancri-e-poster';

for(const f of filters){
 const el=document.createElement('div');el.className='filter';
 const angle=i=>-135+i/(f.options.length-1)*270;
 el.innerHTML=`<span class="filter-title" id="label-${f.id}">${f.label}</span><div class="dial-wrap"><div class="tick-ring" aria-hidden="true"></div><div class="dial" role="slider" tabindex="0" aria-labelledby="label-${f.id}" aria-valuemin="0" aria-valuemax="${f.options.length-1}" aria-valuenow="0" aria-valuetext="Any"></div>${f.options.map((v,i)=>`<button class="dial-tick" style="--tick:${angle(i)}deg" title="${v}" aria-label="${f.label}: ${v}" data-step="${i}"><span></span></button>`).join('')}${f.ends?`<span class="dial-end start">${f.ends[0]}</span><span class="dial-end end">${f.ends[1]}</span>`:''}</div><output id="read-${f.id}">Any</output>`;
 $('#filters').append(el);f.el=el;f.dial=el.querySelector('.dial');f.output=el.querySelector('output');f.value=0;
 function set(v){f.value=Math.max(0,Math.min(f.options.length-1,v));f.output.textContent=f.options[f.value];f.dial.setAttribute('aria-valuenow',f.value);f.dial.setAttribute('aria-valuetext',f.options[f.value]);f.dial.style.setProperty('--angle',angle(f.value)+'deg');el.querySelectorAll('.dial-tick').forEach((t,i)=>t.setAttribute('aria-pressed',String(i===f.value)));filterResults();}
 f.set=set;f.dial.style.setProperty('--angle',angle(0)+'deg');
 el.querySelectorAll('.dial-tick').forEach(t=>t.addEventListener('click',()=>{set(+t.dataset.step);showArchiveAfterFilter();}));
 f.dial.addEventListener('keydown',e=>{const delta={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1};if(e.key in delta||e.key==='Home'||e.key==='End'){e.preventDefault();set(e.key==='Home'?0:e.key==='End'?f.options.length-1:f.value+delta[e.key]);showArchiveAfterFilter();}});
 let origin=null;
 f.dial.addEventListener('pointerdown',e=>{if(e.button!==0)return;f.dial.focus();const r=f.dial.getBoundingClientRect();origin={cx:r.x+r.width/2,cy:r.y+r.height/2};f.dial.setPointerCapture(e.pointerId);f.dial.classList.add('turning');});
 f.dial.addEventListener('pointermove',e=>{if(!origin)return;let a=Math.atan2(e.clientX-origin.cx,-(e.clientY-origin.cy))*180/Math.PI;a=Math.max(-135,Math.min(135,a));const next=Math.round((a+135)/270*(f.options.length-1));if(next!==f.value){set(next);showArchiveAfterFilter();}});
 ['pointerup','pointercancel','lostpointercapture'].forEach(type=>f.dial.addEventListener(type,()=>{origin=null;f.dial.classList.remove('turning');}));
}
const normal=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const fmt=n=>Number(n).toLocaleString('en-GB',{maximumSignificantDigits:3});
const year=p=>p.year?(p.year<2?fmt(p.year*24)+' h':p.year<365.25?fmt(p.year)+' d':fmt(p.year/365.25)+' yr'):'Not constrained';
const tint={blue:'#659be7',violet:'#b8a0d3',teal:'#82bcb2',sand:'#e4ca9c',copper:'#dfa987',ice:'#b8dada',lava:'#fca25a'};
function texture(p){return artwork[p.id]?.texture||'../assets/img/'+(p.visual==='lava'?'lava-terrain.webp':p.visual==='rock'||p.visual==='ice'?'rock-terrain.webp':'giant-atmosphere.webp');}
function art(p,kind){return artwork[p.id]?.[kind]||(p.id==='55-cancri-e'?`../assets/img/atlas/55-cancri-e-${kind}.webp`:`../assets/img/atlas/worlds/${p.id}-${kind}.svg`);}
function category(p,f){
 const v=f.id==='temperature'?p.filterTemperature:f.id==='size'?p.diameter:f.id==='orbit'?p.a:null;
 if(f.id==='star')return ['M','K','G','F','A','B','O','White dwarf','Neutron star','Brown dwarf'].indexOf(p.starClass)+1;
 if(f.id==='type')return ['Rocky','Neptune-like','Gas giant'].indexOf(p.kind)+1;
 if(v===null)return -1;
 const edges=f.id==='temperature'?[250,500,1000,1500]:f.id==='size'?[10000,25000,75000]:[.05,.5,2];
 const i=edges.findIndex(edge=>v<edge);return i<0?edges.length+1:i+1;
}
function matches(p){const q=normal($('#search').value);return (!q||normal(p.name+' '+p.archiveName+' '+p.host+(p.id==='55-cancri-e'?' Janssen':'' )).includes(q))&&filters.every(f=>!f.value||f.value===category(p,f));}
function filterResults(){
 const found=catalogue.filter(matches);$('#count').textContent=found.length+' '+(found.length===1?'match':'matches');$('#results').hidden=!found.length;$('#empty').hidden=!!found.length;
 $('#results').innerHTML=found.map(p=>`<button class="planet-card" data-planet-id="${p.id}" aria-label="Open ${esc(p.name)}"><span class="card-arrow" aria-hidden="true">↗</span><span class="mini atlas-mini" data-globe-id="${p.id}" aria-hidden="true"></span><strong>${esc(p.name)}</strong><small>${esc(p.kind)}${p.starClass?' · '+esc(p.starClass)+' star':''}</small><span class="card-year">Year · ${year(p)}</span></button>`).join('');
 $('.archive-note').textContent=catalogue.length+' planets in the archive';globe?.refresh();
}
function reset(){for(const f of filters)f.set(0);$('#search').value='';filterResults();showArchiveAfterFilter();}
function showArchiveAfterFilter(){if(!$('#dossier').hidden){history.replaceState(null,'',location.pathname+location.search);renderRoute(false);}}
$('#search').addEventListener('input',filterResults);$('#clear').addEventListener('click',reset);$('#clear-empty').addEventListener('click',reset);
$('#results').addEventListener('click',e=>{const card=e.target.closest('[data-planet-id]');if(card)location.hash=card.dataset.planetId;});
$('#back').addEventListener('click',()=>{history.pushState(null,'',location.pathname+location.search);renderRoute(true);});
window.addEventListener('hashchange',()=>renderRoute(true));window.addEventListener('popstate',()=>renderRoute(true));
const tabs=$$('[data-view]');
function tabSelect(tab,focus=false){for(const t of tabs){const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;$('#panel-'+t.dataset.view).hidden=!active;}const p=current;$('#panel-caption').textContent=tab.dataset.view==='system'?p.host+(p.starType?' · '+p.starType:''):tab.dataset.view==='atmosphere'?'Interior · '+p.name:tab.dataset.view==='galaxy'?'Milky Way · '+p.host:'Landscape · '+p.name;if(tab.dataset.view==='galaxy')requestAnimationFrame(()=>galaxy?.draw());if(focus)tab.focus();}
for(const tab of tabs){tab.addEventListener('click',()=>tabSelect(tab));tab.addEventListener('keydown',e=>{let i=tabs.indexOf(tab);if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabSelect(tabs[i],true);}});}
for(const b of $$('[data-dialog]'))b.addEventListener('click',()=>$('#'+b.dataset.dialog).showModal());
for(const d of $$('dialog')){d.querySelector('.close').addEventListener('click',()=>d.close());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});}
function sourceLinks(p){return p.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('');}
function renderEvidence(p){
 const dialog=$('#evidence');$('#evidence-title').textContent='More info';dialog.querySelectorAll('section').forEach(s=>s.remove());
 const params=[['pl_rade','Radius','Earth radii'],['pl_bmasse','Mass','Earth masses'],['pl_orbper','Year','days'],['pl_orbsmax','Orbital distance','AU']];
 const rows=params.map(([key,label,unit])=>{const v=p.parameters[key];let text=v.value===null?'Not measured':(v.limit===1?'< ':v.limit===-1?'> ':'')+fmt(v.value);if(v.value!==null&&v.plus!=null&&v.minus!=null)text+=' (+'+fmt(Math.abs(v.plus))+' / −'+fmt(Math.abs(v.minus))+')';if(key==='pl_bmasse'&&p.massProvenance&&p.massProvenance!=='Mass')label+=' · '+p.massProvenance;return `<tr><th>${esc(label)}</th><td>${esc(text)}${v.value!==null?' '+unit:''}</td><td>${v.source?`<a href="${esc(v.source.url)}" target="_blank" rel="noopener">${esc(v.source.title)}</a>`:''}</td></tr>`;}).join('');
 const story=(p.story||[]).map(s=>`<section><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p><p><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.citation)}</a>${(s.also||[]).map(a=>` · <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join('')}</p></section>`).join('');
 const sections=`<section><h3>${esc(p.name)}</h3><div class="parameter-scroll"><table class="parameter-table">${rows}</table></div></section>${story}<section><h3>Possible interior</h3>${p.layers.map(l=>`<h4>${esc(l.name)}</h4><p>${esc(l.text)}</p><p><a href="${esc(l.source.url)}" target="_blank" rel="noopener">${esc(l.source.title)}</a>${(l.also||[]).map(a=>` · <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>`).join('')}</p>`).join('')}</section>${p.filterTemperature?`<section><h3>Temperature</h3><p>Starlight gives an estimated average temperature of ${fmt(p.filterTemperature)} K (${fmt(Math.round(p.filterTemperature-273.15))} °C), assuming all incoming light is absorbed and heat is spread evenly around the planet. Clouds, atmospheric warming and internal heat can change the actual temperature.</p></section>`:''}<section><h3>Read the research</h3><ol>${sourceLinks(p)}</ol><p><a href="../research-notes/atlas-library/literature-40/index.html#${p.id}">Search the bibliography ↗</a></p><p><a href="${esc(p.archiveURL)}" target="_blank" rel="noopener">NASA Exoplanet Archive record ↗</a> · <a href="../research-notes/atlas-library/catalogue-200/index.html#${p.id}">Research record ↗</a></p></section>`;
 dialog.insertAdjacentHTML('beforeend',sections);
}
function renderInterior(p){
 const layers=p.layers,n=layers.length,radii=p.layerRadii||(n===4?[128,113,80,39,0]:[128,108,52,0]),x=164,y=151;
 function ring(outer,inner){return `M${x} ${y-outer} A${outer} ${outer} 0 0 1 ${x} ${y+outer} L${x} ${y+inner}`+(inner?` A${inner} ${inner} 0 0 0 ${x} ${y-inner}`:'')+' Z';}
 const gradients=layers.map((l,i)=>`<radialGradient id="layer-gradient-${i}" gradientUnits="userSpaceOnUse" cx="${x}" cy="${y}" r="128"><stop offset="${radii[i+1]/128}" stop-color="${l.colour}"/><stop offset="${radii[i]/128}" stop-color="${p.layerStyle==='fluid'&&i>0?layers[i-1].colour:l.colour}"/></radialGradient>`).join('');
 const graphic=`<svg class="cutaway" viewBox="0 0 360 308" aria-label="Possible layers inside ${esc(p.name)}"><defs>${gradients}<clipPath id="cut-globe"><circle cx="${x}" cy="${y}" r="128"/></clipPath><radialGradient id="cut-shade"><stop stop-color="#0000"/><stop offset="1" stop-color="#000b"/></radialGradient></defs><g clip-path="url(#cut-globe)"><image href="${texture(p)}" x="36" y="23" width="256" height="256" preserveAspectRatio="xMidYMid slice"/><circle cx="${x}" cy="${y}" r="128" fill="url(#cut-shade)"/>${layers.map((l,i)=>`<path class="cut-layer${i===0?' selected':''}" data-ring="${i}" d="${ring(radii[i],radii[i+1])}" fill="url(#layer-gradient-${i})" tabindex="0" role="button" aria-label="Explore ${esc(l.name)}" aria-pressed="${i===0}"/>`).join('')}<path d="M164 23V279" fill="none" stroke="#e5cba070"/></g>${layers.map((l,i)=>{const rad=(radii[i]+radii[i+1])/2,yy=48+i*65,xx=x+rad*.85,sy=y-rad*.527;return `<path d="M${xx} ${sy} L312 ${yy}" stroke="#e5cba060" fill="none"/><circle cx="324" cy="${yy}" r="10" fill="#111510" stroke="${l.colour}"/><text x="324" y="${yy+4}" fill="#ebd5ac" text-anchor="middle" font-family="monospace" font-size="11">${i+1}</text>`;}).join('')}</svg>`;
 $('#panel-atmosphere').innerHTML=graphic+`<div class="layer-controls" aria-label="Interior layers">${layers.map((l,i)=>`<button data-layer-index="${i}" aria-pressed="${i===0}">${i+1} · ${esc(l.name)}</button>`).join('')}</div><div class="layer-copy" aria-live="polite"><h3 id="layer-title"></h3><p id="layer-text"></p><a id="layer-source" target="_blank" rel="noopener"></a></div><div id="planet-story"></div>`;
 function select(i){const l=layers[i];$('#layer-title').textContent=l.name;$('#layer-text').textContent=l.text;$('#layer-source').href=l.source.url;$('#layer-source').textContent=l.source.title+' ↗';$('#layer-extra')?.remove();if(l.also?.length)$('#layer-source').insertAdjacentHTML('afterend',`<span id="layer-extra">${l.also.map(a=>`<br><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)} ↗</a>`).join('')}</span>`);$$('[data-layer-index]').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.layerIndex===i)));$$('[data-ring]').forEach(b=>{b.classList.toggle('selected',+b.dataset.ring===i);b.setAttribute('aria-pressed',String(+b.dataset.ring===i));});}
 $$('[data-layer-index]').forEach(b=>b.onclick=()=>select(+b.dataset.layerIndex));$$('[data-ring]').forEach(b=>{b.onclick=()=>select(+b.dataset.ring);b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(+b.dataset.ring);}};});select(0);
 if(p.question)$('#planet-story').innerHTML=`<details class="diamond-note"><summary>${esc(p.question)}</summary><p>${esc(p.answer)}</p>${p.questionSources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`).join('<br>')}</details>`;
}
function renderSystem(p){
 const sys=systems[p.host];
 $('#panel-system').innerHTML=`<div class="system-copy"><h3>${esc(p.host)}</h3><p>${esc(sys.description)}</p><div class="system-members">${sys.orbits.map(o=>`<p><strong>${esc(o.name.replace('bet Pic','Beta Pictoris').replace('Proxima Cen ','Proxima Centauri '))}</strong> · ${o.period<365.25?fmt(o.period)+' days':fmt(o.period/365.25)+' years'} per orbit${o.id&&o.id!==p.id?` · <a href="#${o.id}">Visit planet ↗</a>`:''}</p>`).join('')}</div><details><summary>Read the research</summary>${sys.descriptionSources.map(v=>`<p><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title)} ↗</a></p>`).join('')}</details></div>`;
}
function renderRoute(focus){
 const previous=current;current=byId.get(decodeURIComponent(location.hash.slice(1)))||null;
 $('#archive').hidden=!!current;$('#dossier').hidden=!current;
 if(!current){document.title='Exoplanet Archive · Davide Staub';if(focus){const card=previous&&$(`[data-planet-id="${previous.id}"]`);(card||$('#search')).focus({preventScroll:true});}return;}
 const p=current;document.title=p.name+' · Exoplanet Archive';$('#planet-name').textContent=p.name;$('.subtitle').textContent=p.hook;$('.prose').textContent=p.intro;$('.screen-status').textContent='RECORD '+String(p.order).padStart(3,'0')+' / '+catalogue.length;
 $('.facts').innerHTML=`<div><dt>One year</dt><dd>${year(p)}</dd></div><div><dt>Diameter</dt><dd>${esc(p.diameterText)}</dd></div><div><dt>Orbit radius</dt><dd>${p.a?fmt(p.a)+' AU':'Not constrained'}</dd></div>`;
 $('#cancri-globe').dataset.globeId=p.id;globe?.refresh();galaxy?.select(p);
 $('#cancri-globe').setAttribute('aria-label','Slowly rotating illustration of '+p.name);
 $('#landscape-explanation').innerHTML=`<p>${esc(p.landscapeExplanation.text)}</p><p>${p.landscapeExplanation.sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a>`).join('<br>')}</p>`;
 $('.landscape').src=art(p,'landscape');$('.landscape').alt='Illustrated landscape of '+p.name;
 $('.poster-thumb img').src=art(p,'poster');$('.poster-thumb img').alt=p.name+' travel poster';$('.poster-thumb').setAttribute('aria-label','View '+p.name+' travel poster');
 $('#poster-title').textContent=p.name+' · Travel poster';$('#poster > img').src=art(p,'poster');$('#poster > img').alt=p.name+' retro travel poster';
 const dl=artwork[p.id]?.posterDownload||artwork[p.id]?.poster||(p.id==='55-cancri-e'?originalPoster+'.png':art(p,'poster'));
 const raster=!!artwork[p.id]?.poster;pngButton.hidden=raster;
 for(const a of $$('.poster-strip a, #poster footer a')){a.href=dl;a.download=p.id+'-travel-poster.'+(raster||p.id==='55-cancri-e'?'png':'svg');a.textContent=raster||p.id==='55-cancri-e'?'Download original PNG ↓':'Download print SVG ↓';}
 $('#poster footer span').textContent=raster?(artwork[p.id].posterSize||'Original PNG'):p.id==='55-cancri-e'?'Original PNG · 1024 × 1536 px':'Vector master · 3000 × 4500 canvas';
 $('#download-png').hidden=raster||p.id==='55-cancri-e';
 renderInterior(p);renderSystem(p);renderEvidence(p);tabSelect(tabs[0]);if(focus)$('#planet-name').focus({preventScroll:true});
}
const pngButton=document.createElement('button');pngButton.className='button';pngButton.id='download-png';pngButton.textContent='Download PNG · 3000 × 4500 ↓';$('#poster footer').append(pngButton);
pngButton.addEventListener('click',async()=>{const p=current;pngButton.disabled=true;pngButton.textContent='Preparing PNG…';try{const response=await fetch(art(p,'poster'));if(!response.ok)throw Error('Poster unavailable');const svg=await response.text();const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));const img=new Image();try{await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url;});const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=4500;canvas.getContext('2d').drawImage(img,0,0,3000,4500);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('PNG creation failed');const out=URL.createObjectURL(blob);const a=document.createElement('a');a.href=out;a.download=p.id+'-travel-poster-3000x4500.png';a.click();setTimeout(()=>URL.revokeObjectURL(out),1000);}finally{URL.revokeObjectURL(url);}}catch(error){pngButton.textContent='PNG unavailable · use print SVG';return;}finally{pngButton.disabled=false;}pngButton.textContent='Download PNG · 3000 × 4500 ↓';});
filterResults();renderRoute(false);
})();
