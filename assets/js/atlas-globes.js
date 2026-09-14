/* One renderer and one visual recipe for cards and opened records. */
window.AtlasGlobes=function(art){
 if(!window.THREE)return;
 let renderer;try{renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});}catch{return;}
 const canvas=renderer.domElement,pixelRatio=Math.min(devicePixelRatio,1.6);renderer.setPixelRatio(pixelRatio);renderer.setClearColor(0,0);const views=new WeakMap();
 const camera=new THREE.PerspectiveCamera(39,1,.1,30);camera.position.set(0,.18,4.15);camera.lookAt(0,0,0);
 const geometry=new THREE.SphereGeometry(1.12,80,48),entries=new Map();let elements=[],clock=0,previous=performance.now(),renderSize=0;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const vertex='varying vec2 vUv;varying vec3 vNormal;varying vec3 vPosition;void main(){vUv=uv;vNormal=normalize(mat3(modelMatrix)*normal);vPosition=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
 const fragment='uniform sampler2D map;uniform float haze;uniform float emission;varying vec2 vUv;varying vec3 vNormal;varying vec3 vPosition;void main(){vec3 tex=pow(texture2D(map,vUv).rgb,vec3(2.2));vec3 n=normalize(vNormal);vec3 light=normalize(vec3(-3.8,1.7,3.));float lit=max(dot(n,light),0.);float rim=pow(1.-max(dot(n,normalize(cameraPosition-vPosition)),0.),3.);float facing=max(dot(n,normalize(cameraPosition-vPosition)),0.);vec3 col=tex*(.72+.28*sqrt(facing));float lava=max(tex.r-tex.b*1.35-.13,0.);col+=vec3(1.,.19,.015)*lava*emission;col+=vec3(.30,.42,.55)*rim*haze*max(dot(n,light)+.25,0.);gl_FragColor=vec4(pow(max(col,vec3(0.)),vec3(1./2.2)),1.);}';
 function make(id){const a=art[id],material=new THREE.ShaderMaterial({uniforms:{map:{value:null},haze:{value:['rock','lava'].includes(a.visual)?0:.018},emission:{value:a.visual==='lava'?.025:0}},vertexShader:vertex,fragmentShader:fragment});const mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.add(mesh);mesh.rotation.z=.1;const e={mesh,scene,material,ready:false,last:clock};entries.set(id,e);new THREE.TextureLoader().load(a.texture,t=>{if(!entries.has(id)||entries.get(id)!==e){t.dispose();return;}t.wrapS=THREE.RepeatWrapping;t.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());e.texture=t;material.uniforms.map.value=t;e.ready=true;});return e;}
 function refresh(){elements=[...document.querySelectorAll('[data-globe-id]')];
  for(const el of elements)if(!views.has(el)){
   const target=document.createElement('canvas');target.className='atlas-globe-canvas';target.setAttribute('aria-hidden','true');el.append(target);
   views.set(el,{canvas:target,context:target.getContext('2d'),size:0});
  }
 }
 function draw(time){requestAnimationFrame(draw);const dt=Math.min((time-previous)/1000,.1);previous=time;if(document.hidden)return;if(!reduced.matches)clock+=dt;
 const used=new Set();
 for(const el of elements){
  if(!el.getClientRects().length)continue;
  const r=el.getBoundingClientRect(),id=el.dataset.globeId;
  if(!art[id]||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth||r.width<=0)continue;
  used.add(id);const e=entries.get(id)||make(id);e.last=time;if(!e.ready)continue;
  const view=views.get(el);if(!view?.context)continue;
  const size=Math.max(1,Math.round(Math.min(r.width,r.height)));
  if(renderSize!==size){renderSize=size;renderer.setSize(size,size,false);}
  if(view.size!==size){view.size=size;view.canvas.width=canvas.width;view.canvas.height=canvas.height;view.canvas.style.width=size+'px';view.canvas.style.height=size+'px';}
  e.mesh.rotation.y=clock*.1;
  renderer.setViewport(0,0,size,size);renderer.clear();renderer.render(e.scene,camera);
  // Copy immediately into a canvas in normal document flow. The browser then
  // scrolls the globe and its card together, without viewport-position tracking.
  view.context.clearRect(0,0,view.canvas.width,view.canvas.height);
  view.context.drawImage(canvas,0,0,view.canvas.width,view.canvas.height);
  el.classList.add('globe-ready');
 }
 // Keep recently viewed maps briefly, including the selected card during navigation.
 for(const [id,e]of entries)if(!used.has(id)&&time-e.last>10000){e.texture?.dispose();e.material.dispose();entries.delete(id);}
 }
 refresh();requestAnimationFrame(draw);return{refresh};
};
