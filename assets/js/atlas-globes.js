/* One renderer and one visual recipe for cards and opened records. */
window.AtlasGlobes=function(art){
 if(!window.THREE)return;
 let renderer;try{renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});}catch{return;}
 const canvas=renderer.domElement;canvas.id='atlas-shared-globes';canvas.setAttribute('aria-hidden','true');document.body.append(canvas);renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.setClearColor(0,0);
 const camera=new THREE.PerspectiveCamera(39,1,.1,30);camera.position.set(0,.18,4.15);camera.lookAt(0,0,0);
 const geometry=new THREE.SphereGeometry(1.12,80,48),entries=new Map();let elements=[],clock=0,previous=performance.now(),w=0,h=0;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 const vertex='varying vec2 vUv;varying vec3 vNormal;varying vec3 vPosition;void main(){vUv=uv;vNormal=normalize(mat3(modelMatrix)*normal);vPosition=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}';
 const fragment='uniform sampler2D map;uniform float haze;uniform float emission;varying vec2 vUv;varying vec3 vNormal;varying vec3 vPosition;void main(){vec3 tex=pow(texture2D(map,vUv).rgb,vec3(2.2));vec3 n=normalize(vNormal);vec3 light=normalize(vec3(-3.8,1.7,3.));float lit=max(dot(n,light),0.);float rim=pow(1.-max(dot(n,normalize(cameraPosition-vPosition)),0.),3.);float facing=max(dot(n,normalize(cameraPosition-vPosition)),0.);vec3 col=tex*(.72+.28*sqrt(facing));float lava=max(tex.r-tex.b*1.35-.13,0.);col+=vec3(1.,.19,.015)*lava*emission;col+=vec3(.30,.42,.55)*rim*haze*max(dot(n,light)+.25,0.);gl_FragColor=vec4(pow(max(col,vec3(0.)),vec3(1./2.2)),1.);}';
 function make(id){const a=art[id],material=new THREE.ShaderMaterial({uniforms:{map:{value:null},haze:{value:['rock','lava'].includes(a.visual)?0:.018},emission:{value:a.visual==='lava'?.025:0}},vertexShader:vertex,fragmentShader:fragment});const mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.add(mesh);mesh.rotation.z=.1;const e={mesh,scene,material,ready:false,last:clock};entries.set(id,e);new THREE.TextureLoader().load(a.texture,t=>{if(!entries.has(id)||entries.get(id)!==e){t.dispose();return;}t.wrapS=THREE.RepeatWrapping;t.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());e.texture=t;material.uniforms.map.value=t;e.ready=true;});return e;}
 function refresh(){elements=[...document.querySelectorAll('[data-globe-id]')];}
 function draw(time){requestAnimationFrame(draw);const dt=Math.min((time-previous)/1000,.1);previous=time;if(document.hidden)return;if(!reduced.matches)clock+=dt;
 if(w!==innerWidth||h!==innerHeight){w=innerWidth;h=innerHeight;renderer.setSize(w,h);}
 renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);const used=new Set();
 for(const el of elements){if(!el.getClientRects().length)continue;const r=el.getBoundingClientRect(),id=el.dataset.globeId;if(!art[id]||r.bottom<=0||r.top>=h||r.width<=0)continue;used.add(id);const e=entries.get(id)||make(id);e.last=time;if(!e.ready)continue;el.classList.add('globe-ready');e.mesh.rotation.y=clock*.1;camera.aspect=1;camera.updateProjectionMatrix();const size=Math.min(r.width,r.height);renderer.setViewport(r.left+(r.width-size)/2,h-r.bottom+(r.height-size)/2,size,size);const x=Math.max(r.left,0),y=Math.max(r.top,0),right=Math.min(r.right,w),bottom=Math.min(r.bottom,h);renderer.setScissor(x,h-bottom,right-x,bottom-y);renderer.render(e.scene,camera);}
 // Keep recently viewed maps briefly, including the selected card during navigation.
 for(const [id,e]of entries)if(!used.has(id)&&time-e.last>10000){e.texture?.dispose();e.material.dispose();entries.delete(id);}
 }
 refresh();requestAnimationFrame(draw);return{refresh};
};
