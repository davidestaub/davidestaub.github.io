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
let globe, current=null, catalogue, systems;
try { const response=await fetch('../assets/data/atlas-catalogue.json?v=only40'); if(!response.ok)throw new Error('Catalogue download failed'); const data=await response.json();catalogue=data.planets;systems=data.systems; }
catch(error){$('#results').textContent='The catalogue could not load. Please refresh the page.';$('#count').textContent='Load error';return;}
const byId=new Map(catalogue.map(p=>[p.id,p]));
let artwork={};
try{const r=await fetch('../assets/data/atlas-art.json?v=collection40');if(r.ok)artwork=(await r.json()).planets||{};}catch(error){console.warn('New artwork manifest unavailable',error);}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const originalInterior=$('#panel-atmosphere').innerHTML;
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
 $('#results').innerHTML=found.map(p=>`<button class="planet-card" data-planet-id="${p.id}" aria-label="Open ${esc(p.name)}"><span class="card-arrow" aria-hidden="true">↗</span><span class="mini ${p.visual}" style="--planet-tint:${tint[p.palette]};background-image:url('${texture(p)}');background-position:${p.seed%100}% 50%" aria-hidden="true"></span><strong>${esc(p.name)}</strong><small>${esc(p.kind)}${p.starClass?' · '+esc(p.starClass)+' star':''}</small><span class="card-year">Year · ${year(p)}</span></button>`).join('');
 $('.archive-note').textContent=catalogue.length+' planets in the archive';
}
function reset(){for(const f of filters)f.set(0);$('#search').value='';filterResults();showArchiveAfterFilter();}
function showArchiveAfterFilter(){if(!$('#dossier').hidden){history.replaceState(null,'',location.pathname+location.search);renderRoute(false);}}
$('#search').addEventListener('input',filterResults);$('#clear').addEventListener('click',reset);$('#clear-empty').addEventListener('click',reset);
$('#results').addEventListener('click',e=>{const card=e.target.closest('[data-planet-id]');if(card)location.hash=card.dataset.planetId;});
$('#back').addEventListener('click',()=>{history.pushState(null,'',location.pathname+location.search);renderRoute(true);});
window.addEventListener('hashchange',()=>renderRoute(true));window.addEventListener('popstate',()=>renderRoute(true));
const tabs=$$('[data-view]');
function tabSelect(tab,focus=false){for(const t of tabs){const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;$('#panel-'+t.dataset.view).hidden=!active;}const p=current;$('#panel-caption').textContent=tab.dataset.view==='system'?p.host+(p.starType?' · '+p.starType:''):tab.dataset.view==='atmosphere'?'Interior · '+p.name:'Landscape · '+p.name;if(focus)tab.focus();}
for(const tab of tabs){tab.addEventListener('click',()=>tabSelect(tab));tab.addEventListener('keydown',e=>{let i=tabs.indexOf(tab);if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabSelect(tabs[i],true);}});}
for(const b of $$('[data-dialog]'))b.addEventListener('click',()=>$('#'+b.dataset.dialog).showModal());
for(const d of $$('dialog')){d.querySelector('.close').addEventListener('click',()=>d.close());d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});}
function sourceLinks(p){return p.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('');}
function renderEvidence(p){
 const dialog=$('#evidence');dialog.querySelectorAll('section').forEach(s=>s.remove());
 const params=[['pl_rade','Radius','Earth radii'],['pl_bmasse','Mass','Earth masses'],['pl_orbper','Year','days'],['pl_orbsmax','Orbital distance','AU']];
 const rows=params.map(([key,label,unit])=>{const v=p.parameters[key];let text=v.value===null?'Not measured':(v.limit===1?'< ':v.limit===-1?'> ':'')+fmt(v.value);if(v.value!==null&&v.plus!=null&&v.minus!=null)text+=' (+'+fmt(Math.abs(v.plus))+' / −'+fmt(Math.abs(v.minus))+')';if(key==='pl_bmasse'&&p.massProvenance)label+=' · '+p.massProvenance;return `<tr><th>${esc(label)}</th><td>${esc(text)}${v.value!==null?' '+unit:''}</td><td>${v.source?`<a href="${esc(v.source.url)}" target="_blank" rel="noopener">${esc(v.source.title)}</a>`:''}</td></tr>`;}).join('');
 const sections=`<section><h3>${esc(p.name)}</h3><p>${esc(p.evidence)}</p><div class="parameter-scroll"><table class="parameter-table">${rows}</table></div></section><section><h3>The interior</h3><p>${esc(p.interior)}</p><p>${esc(p.limits)}</p></section><section><h3>Temperature and the filters</h3><p>${p.filterTemperature?'The temperature knob uses '+fmt(p.filterTemperature)+' K for this planet. It is a consistent estimate of heating by the star: zero reflected light and heat spread over the whole globe.':'No comparable single-star heating temperature is adopted for this entry.'} This is not a measured surface temperature. Day-side conditions, clouds and internal heat can differ. Size uses physical diameter where a published radius is available. The size-family labels do not establish a solid surface.</p><p>${p.starType?'Published host class: '+esc(p.starType)+(p.starSource?` · <a href="${esc(p.starSource.url)}" target="_blank" rel="noopener">${esc(p.starSource.title)}</a>`:''): 'No published spectral class is adopted here. This planet remains visible with the host knob set to Any.'}</p></section><section><h3>The system view</h3><p>${esc(systems[p.host].model)}</p><p>${esc(p.rotation)}</p></section><section><h3>Read the research</h3><ol>${sourceLinks(p)}</ol><p><a href="${esc(p.archiveURL)}" target="_blank" rel="noopener">NASA Exoplanet Archive record ↗</a> · <a href="../research-notes/atlas-library/catalogue-200/index.html#${p.id}">Research record and literature inventory ↗</a></p></section>`;
 dialog.insertAdjacentHTML('beforeend',sections);
}
const rockyLayers=[['Outer rock','Rock exposed to space or covered by an atmosphere forms the outer boundary in this possible model. Heat and gas determine what the surface would be like.'],['Mantle','Below the exterior lies a much deeper region of rock. High pressure changes its minerals. The layer thickness shown here is illustrative.'],['Metal-rich centre','Dense metal can collect near the centre. Different proportions of metal and rock can fit similar measurements. A core boundary has not been mapped.']];
const fluidLayers=[['Atmosphere','The outer gas is the part most accessible to telescopes. Clouds or haze may conceal deeper layers.'],['Deep fluid','Pressure rises steadily below the visible atmosphere. Gas becomes a dense fluid, with no everyday ground surface at the transition.'],['Dense interior','Heavier material may be concentrated near the centre or mixed through the envelope. Its arrangement depends on formation and subsequent mixing.']];
function renderInterior(p){
 const rocky=p.kind==='Rocky',water=p.visual==='ice'||['Kepler-138 c','Kepler-138 d'].includes(p.archiveName);
 let layers=rocky?rockyLayers:fluidLayers;
 if(water)layers=[['Water or ice','A water-rich model can have vapour, liquid or ice in its outer layers, depending on temperature and pressure.'],['High-pressure water','Far below, pressure can produce dense fluid or high-pressure ice. The water layer may be much deeper than Earth’s oceans.'],['Rock and metal','The water-rich model still contains a deep rocky interior, potentially with metal concentrated toward its centre.']];
 if(p.id==='55-cancri-e')layers=[['Atmosphere','The atmospheric evidence supports gases such as carbon monoxide or carbon dioxide. Molten rock could release gas into the atmosphere.'],['Molten rock','The star-facing side is hot enough for an ocean of molten rock. Its depth is uncertain.'],['Carbon-rich mantle','One possibility is a mantle rich in carbon. Under high pressure some carbon could form diamond. Later stellar-abundance work makes this less certain.'],['Core','Some interior models include an iron-rich centre. The planet’s mass and size do not uniquely determine its core.']];
 const fluid=!rocky&&!water;const col=tint[p.palette]||'#b79468';
 const graphic=`<svg class="cutaway" viewBox="0 0 520 330" role="img" aria-label="Possible ${esc(p.name)} interior"><defs><radialGradient id="deep-fluid"><stop stop-color="#ede0b8"/><stop offset=".35" stop-color="#a57c64"/><stop offset=".65" stop-color="${col}"/><stop offset="1" stop-color="#24303d"/></radialGradient><clipPath id="outer-sphere"><circle cx="225" cy="163" r="120"/></clipPath><radialGradient id="sphere-shade"><stop stop-color="#0000"/><stop offset="1" stop-color="#000b"/></radialGradient></defs><g clip-path="url(#outer-sphere)"><image href="${texture(p)}" x="105" y="43" width="240" height="240" preserveAspectRatio="xMidYMid slice"/><circle cx="225" cy="163" r="120" fill="url(#sphere-shade)"/><path d="M225 43 A120 120 0 0 1 345 163 H225Z" fill="${fluid?'url(#deep-fluid)':water?'#a3cbd2':'#c38657'}"/>${fluid?'':`<path d="M225 57 A106 106 0 0 1 331 163 H225Z" fill="${water?'#527e94':'#794c34'}"/><path d="M225 106 A57 57 0 0 1 282 163 H225Z" fill="#d6bd81"/>`}<path d="M225 43V163H345" stroke="#e6cd9a" stroke-opacity=".5" fill="none"/></g><g stroke="#957949" fill="none"><path d="M306 70L365 46H480"/><path d="M297 113L365 112H480"/><path d="M259 143L365 180H480"/></g><g fill="#dcc193" font-family="monospace" font-size="12"><text x="373" y="39">${water?'WATER / ICE':rocky?'OUTER ROCK':'ATMOSPHERE'}</text><text x="373" y="105">${water?'DEEP WATER':rocky?'MANTLE':'DEEP FLUID'}</text><text x="373" y="198">${rocky?'CORE':'INTERIOR'}</text></g></svg>`;
 $('#panel-atmosphere').innerHTML=graphic+`<p class="interior-overview">${esc(p.interior)}</p><div class="layer-controls" aria-label="Explore interior layers">${layers.map((l,i)=>`<button data-layer-index="${i}" aria-pressed="${i===0}">${esc(l[0])}</button>`).join('')}</div><div class="layer-copy" aria-live="polite"><h3 id="layer-title">${esc(layers[0][0])}</h3><p id="layer-text">${esc(layers[0][1])}</p><a href="${esc(p.sources[0].url)}" target="_blank" rel="noopener">Read the research ↗</a></div><div id="planet-story"></div>`;
 // Keep the approved detailed cutaway for the original entry.
 if(p.id==='55-cancri-e')$('#panel-atmosphere .cutaway').outerHTML=new DOMParser().parseFromString(originalInterior,'text/html').querySelector('.cutaway').outerHTML;
 $$('[data-layer-index]').forEach(b=>b.addEventListener('click',()=>{const l=layers[+b.dataset.layerIndex];$('#layer-title').textContent=l[0];$('#layer-text').textContent=l[1];$$('[data-layer-index]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}));
 if(p.question)$('#planet-story').innerHTML=`<details class="diamond-note"><summary>${esc(p.question)}</summary><p>${esc(p.answer)}</p><a href="${esc(p.sources[0].url)}" target="_blank" rel="noopener">Read the research ↗</a></details>`;
}
let simDays=0,orbitLast=0,orbitZoom=1,orbitRunning=!matchMedia('(prefers-reduced-motion: reduce)').matches;
function renderSystem(p){
 const sys=systems[p.host];$('#orbit-map').innerHTML=sys.orbits.map((d,i)=>`<ellipse id="path-${i}" cy="165" fill="none" stroke="${d.name===p.archiveName?'#ffd580':'#796341'}" stroke-width="1"/><g id="body-${i}"><circle r="${d.name===p.archiveName?4:3}" fill="${d.name===p.archiveName?'#ffdb91':'#c6a374'}"/><text x="7" y="-7">${esc(d.label)}</text></g>`).join('');
 let note=$('.companion-note');note.hidden=!(sys.stars>1||sys.omitted.length);note.innerHTML=`<summary>${sys.binary?'Two stars inside these planetary orbits':sys.stars>1?'Other stars in this system':'More system data'}</summary><p>${sys.binary?'The planet orbits both stars. The centre of this diagram represents their shared centre of mass. Their individual stellar orbits are not shown.':sys.stars>1?'This system includes a stellar companion. Its separation is outside the planetary diagram shown here.':''}${sys.omitted.length?' Some confirmed companions have no complete period-and-distance pair in the adopted records: '+esc(sys.omitted.join(', '))+'.':''}</p>`;
 const old=$('#system-planets');if(old)old.remove();
 $('#panel-system').insertAdjacentHTML('beforeend',`<details id="system-planets" class="companion-note"><summary>Orbital periods and distances</summary><table class="system-table">${sys.orbits.map(d=>`<tr><td>${esc(d.name)}</td><td>${fmt(d.a)} AU</td><td>${fmt(d.period)} d</td></tr>`).join('')}</table></details>`);
 orbitZoom=1;$('#system-zoom').value=0;drawOrbits();
}
function position(d,t){const M=(t/d.period*Math.PI*2)% (Math.PI*2);let E=M;for(let j=0;j<10;j++)E-=(E-d.eccentricity*Math.sin(E)-M)/(1-d.eccentricity*Math.cos(E));return [d.a*(Math.cos(E)-d.eccentricity),d.a*Math.sqrt(1-d.eccentricity*d.eccentricity)*Math.sin(E)];}
function drawOrbits(){if(!current)return;const sys=systems[current.host];const max=Math.max(...sys.orbits.map(d=>d.a*(1+d.eccentricity)),.01);const scale=145/max*orbitZoom;sys.orbits.forEach((d,i)=>{const r=d.a*scale;const path=$('#path-'+i);path.setAttribute('cx',245-r*d.eccentricity);path.setAttribute('rx',r);path.setAttribute('ry',r*Math.sqrt(1-d.eccentricity*d.eccentricity));const [x,y]=position(d,simDays+d.period*i*.173);$('#body-'+i).setAttribute('transform',`translate(${245+x*scale} ${165+y*scale})`);});$('#distance-scale').textContent=fmt(100/scale)+' AU';$('#system-clock').textContent=simDays.toFixed(1)+' days';}
$('#system-zoom').addEventListener('input',e=>{orbitZoom=Math.pow(10,+e.target.value);drawOrbits();});
$('#system-speed').addEventListener('input',()=>{const days=Math.pow(10,+$('#system-speed').value);$('#speed-readout').textContent=(days===1?'1 day':days.toFixed(2)+' days')+' / second';});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{orbitRunning=!e.matches;});
function orbitFrame(t){const dt=Math.min((t-orbitLast)/1000,.1);orbitLast=t;if(current&&orbitRunning&&!document.hidden&&!$('#dossier').hidden&&!$('#panel-system').hidden){simDays+=dt*Math.pow(10,+$('#system-speed').value);drawOrbits();}requestAnimationFrame(orbitFrame);}
requestAnimationFrame(orbitFrame);
function renderRoute(focus){
 const previous=current;current=byId.get(decodeURIComponent(location.hash.slice(1)))||null;
 $('#archive').hidden=!!current;$('#dossier').hidden=!current;
 if(!current){document.title='Exoplanet Archive · Davide Staub';if(focus){const card=previous&&$(`[data-planet-id="${previous.id}"]`);(card||$('#search')).focus({preventScroll:true});}return;}
 const p=current;document.title=p.name+' · Exoplanet Archive';$('#planet-name').textContent=p.name;$('.subtitle').textContent=p.hook;$('.prose').textContent=p.intro;$('.screen-status').textContent='RECORD '+String(p.order).padStart(3,'0')+' / '+catalogue.length;
 $('.facts').innerHTML=`<div><dt>One year</dt><dd>${year(p)}</dd></div><div><dt>Diameter</dt><dd>${esc(p.diameterText)}</dd></div><div><dt>Orbit radius</dt><dd>${p.a?fmt(p.a)+' AU':'Not constrained'}</dd></div>`;
 const opts={texture:texture(p),tint:tint[p.palette],tintAmount:artwork[p.id]?.texture?0:p.visual==='lava'?0:.55,realistic:!!artwork[p.id]?.realistic,emission:artwork[p.id]?.realistic?(artwork[p.id].visual==='lava'?.025:0):p.visual==='lava'?.5:0,haze:artwork[p.id]?.realistic?(['rock','lava'].includes(artwork[p.id].visual)?0:.018):p.kind==='Rocky'?.02:.17,interactive:false};
 if(!globe&&window.PlanetView)globe=PlanetView($('#cancri-globe'),opts);else if(globe)globe.configure(opts);if(globe)globe.view(0,4.15);
 $('#cancri-globe').setAttribute('aria-label','Slowly rotating illustration of '+p.name);
 $('.landscape').src=art(p,'landscape');$('.landscape').alt=p.name+' · '+p.landscapeBrief;
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
