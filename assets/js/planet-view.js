/* Shared, locally hosted WebGL globe. Lighting/viewpoint are illustrative. */
(function(){
'use strict';
window.PlanetView=function(el,opts={}){
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let renderer,scene,camera,mesh,material,raf=0,visible=true,paused=reduced.matches,angle=0,distance=3.65,last=0,drag=false,px=0;
 const fallback=document.createElement('div');fallback.className='fallback-globe';fallback.style.backgroundImage=`url('${opts.texture}')`;el.append(fallback);
 const fallbackView={pause(v){paused=v;},configure(o){if(o.texture)fallback.style.backgroundImage=`url('${o.texture}')`;},view(){},get paused(){return paused;}};
 if(!window.THREE){el.dataset.fallback='true';return fallbackView;}
 try{renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});}catch(e){el.dataset.fallback='true';return fallbackView;}
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.setClearColor(0,0);el.append(renderer.domElement);
 renderer.domElement.setAttribute('aria-hidden','true');scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(39,1,.1,100);
 material=new THREE.ShaderMaterial({uniforms:{realistic:{value:0},map:{value:null},tint:{value:new THREE.Color('#e5c5a2')},tintAmount:{value:0},lightDirection:{value:new THREE.Vector3(2.7,1.1,4).normalize()},emission:{value:0},haze:{value:.15}},vertexShader:`varying vec2 vUv; varying vec3 vNormal; varying vec3 vPosition; void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);vPosition=world.xyz;vNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*viewMatrix*world;}`,fragmentShader:`uniform float realistic;uniform sampler2D map; uniform vec3 tint;uniform float tintAmount;uniform vec3 lightDirection;uniform float emission;uniform float haze;varying vec2 vUv;varying vec3 vNormal;varying vec3 vPosition;void main(){vec3 tex=texture2D(map,vUv).rgb;if(realistic>.5)tex=pow(tex,vec3(2.2));float gray=dot(tex,vec3(.299,.587,.114));vec3 albedo=mix(tex,gray*tint*1.6,tintAmount);vec3 n=normalize(vNormal);float lit=max(dot(n,lightDirection),0.);float rim=pow(1.-max(dot(n,normalize(cameraPosition-vPosition)),0.),3.);vec3 col=albedo*(mix(.035,.0015,realistic)+1.24*lit);float lava=max(tex.r-tex.b*1.35-.13,0.);col+=vec3(1.,.19,.015)*lava*emission;col+=vec3(.30,.42,.55)*rim*haze*max(dot(n,lightDirection)+.25,0.);if(realistic>.5)col=pow(max(col,vec3(0.)),vec3(1./2.2));gl_FragColor=vec4(col,1.);}`});
 mesh=new THREE.Mesh(new THREE.SphereGeometry(1.12,80,48),material);mesh.rotation.z=.10;scene.add(mesh);
 const textureCache=new Map();let currentTexture='';
 function configure(o){material.uniforms.realistic.value=o.realistic?1:0;material.uniforms.lightDirection.value.set(o.realistic?-3.8:2.7,o.realistic?1.7:1.1,o.realistic?3:4).normalize();if(o.tint)material.uniforms.tint.value.set(o.tint);material.uniforms.tintAmount.value=o.tintAmount||0;material.uniforms.emission.value=o.emission||0;material.uniforms.haze.value=o.haze===undefined?.15:o.haze;
 if(o.texture){currentTexture=o.texture;fallback.style.backgroundImage=`url('${o.texture}')`;if(textureCache.has(o.texture)){material.uniforms.map.value=textureCache.get(o.texture);fallback.hidden=true;renderer.domElement.hidden=false;delete el.dataset.fallback;render();}else{new THREE.TextureLoader().load(o.texture,t=>{t.wrapS=THREE.RepeatWrapping;t.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),4);textureCache.set(o.texture,t);while(textureCache.size>4){const key=textureCache.keys().next().value;if(key===currentTexture)break;textureCache.get(key).dispose();textureCache.delete(key);}if(currentTexture===o.texture){material.uniforms.map.value=t;fallback.hidden=true;renderer.domElement.hidden=false;delete el.dataset.fallback;render();}},undefined,()=>{el.dataset.fallback='true';fallback.hidden=false;renderer.domElement.hidden=true;});}}
 render();}
 function render(){camera.position.set(Math.sin(angle)*distance,.24,Math.cos(angle)*distance);camera.lookAt(0,0,0);if(material.uniforms.map.value)renderer.render(scene,camera);}
 function tick(time){raf=0;if(!visible||document.hidden||paused)return;const dt=Math.min((time-last)/1000,.05);last=time;if(!drag)mesh.rotation.y+=dt*.10;render();raf=requestAnimationFrame(tick);}
 function schedule(){if(!raf&&visible&&!document.hidden&&!paused){last=performance.now();raf=requestAnimationFrame(tick);}}
 function pause(value){paused=value;if(paused){cancelAnimationFrame(raf);raf=0;}else schedule();}
 function size(){const w=el.clientWidth,h=el.clientHeight||w;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();render();}
 new ResizeObserver(size).observe(el);new IntersectionObserver(es=>{visible=es[0].isIntersecting;if(visible)schedule();else{cancelAnimationFrame(raf);raf=0;}}).observe(el);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else schedule();});
 reduced.addEventListener('change',e=>{pause(e.matches);el.dispatchEvent(new CustomEvent('motionchange',{detail:{paused}}));});
 if(opts.interactive!==false){el.addEventListener('pointerdown',e=>{if(e.target.tagName==='BUTTON')return;drag=true;px=e.clientX;el.setPointerCapture(e.pointerId);});el.addEventListener('pointermove',e=>{if(drag){mesh.rotation.y+=(e.clientX-px)*.008;px=e.clientX;render();}});['pointerup','pointercancel','lostpointercapture'].forEach(ev=>el.addEventListener(ev,()=>drag=false));
 el.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();mesh.rotation.y+=(e.key==='ArrowLeft'?-.15:.15);render();}});
 }
 configure(opts);size();schedule();return {configure,pause,view(a,d){angle=a;distance=d;render();},get paused(){return paused;}};
};})();
