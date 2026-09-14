// Volcanic homepage concept: a real sphere, separate moving atmosphere and local eruptions.
(function(){
 const host=document.getElementById('planet-container'); if(!host||!window.THREE)return;
 const T=THREE, renderer=new T.WebGLRenderer({alpha:true,antialias:true});
 renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setClearColor(0,0);
 renderer.domElement.setAttribute('role','img');renderer.domElement.setAttribute('aria-label','Rotating volcanic planet with drifting clouds and occasional glowing eruptions');host.append(renderer.domElement);
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(36,1,.1,30);camera.position.z=3.8;
 const axial=new T.Group();axial.rotation.z=-.18;scene.add(axial);
 const world=new T.Group();world.rotation.y=-1.45;axial.add(world);
 const vertex=`varying vec2 vUv;varying vec3 vN;varying vec3 vP;varying vec3 vLocal;
 void main(){vUv=uv;vLocal=normalize(position);vN=normalize(mat3(modelMatrix)*normal);vP=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
 const noise=`float hash(vec3 p){p=fract(p*.3183099+vec3(.13,.37,.71));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
 float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
 float fbm(vec3 p){float n=0.,a=.52;for(int i=0;i<5;i++){n+=a*noise(p);p=p*2.03+vec3(7.1,3.7,1.3);a*=.48;}return n;}`;
 const vents=Array.from({length:6},()=>new T.Vector3(0,1,0));
 const heat=Array(6).fill(0);
 const ground=new T.ShaderMaterial({uniforms:{map:{value:null},time:{value:0},vents:{value:vents},heat:{value:heat}},vertexShader:vertex,fragmentShader:`uniform sampler2D map;uniform float time;uniform vec3 vents[6];uniform float heat[6];varying vec2 vUv;varying vec3 vN;varying vec3 vP;varying vec3 vLocal;
 void main(){vec3 tex=texture2D(map,vUv).rgb;float hot=smoothstep(.10,.28,tex.r-tex.b)*smoothstep(.25,.65,tex.r);vec3 n=normalize(vN);float lighting=.58+.48*max(dot(n,normalize(vec3(-2.5,2.8,4.5))),0.);vec3 c=tex*lighting;
 c+=hot*vec3(.16,.055,.006)*(.7+.3*sin(time*.8+vUv.x*23.+vUv.y*9.));
 for(int i=0;i<6;i++){float d=max(0.,1.-dot(normalize(vLocal),vents[i]));float core=exp(-d*5200.);float halo=exp(-d*420.);c+=heat[i]*(vec3(1.,.58,.16)*core+vec3(.36,.09,.008)*halo);}
 float edge=pow(1.-max(dot(n,normalize(cameraPosition-vP)),0.),5.);c+=vec3(.15,.055,.017)*edge;
 gl_FragColor=vec4(c,1.);}`});
 const globe=new T.Mesh(new T.SphereGeometry(1.06,128,80),ground);world.add(globe);
 const cloudMat=new T.ShaderMaterial({uniforms:{time:{value:0}},vertexShader:vertex,fragmentShader:`uniform float time;varying vec3 vLocal;varying vec3 vN;varying vec3 vP;${noise}
 void main(){vec3 p=vLocal*vec3(3.2,6.,3.2);p+=vec3(time*.004,0.,time*.003);float broad=fbm(p+vec3(fbm(p*1.8)));float fine=fbm(p*4.5+vec3(time*.012,0.,0.));float density=smoothstep(.47,.70,broad)*smoothstep(.23,.65,fine);float facing=max(dot(normalize(vN),normalize(cameraPosition-vP)),0.);float light=.45+.55*max(dot(normalize(vN),normalize(vec3(-2.,3.,4.))),0.);gl_FragColor=vec4(vec3(.74,.71,.65)*light,density*.58*smoothstep(0.,.18,facing));}`,
 transparent:true,depthWrite:false});
 const clouds=new T.Mesh(new T.SphereGeometry(1.075,96,64),cloudMat);world.add(clouds);
 const halo=new T.Mesh(new T.SphereGeometry(1.081,96,64),new T.ShaderMaterial({vertexShader:vertex,fragmentShader:`varying vec3 vN;varying vec3 vP;void main(){float e=pow(1.-abs(dot(normalize(vN),normalize(cameraPosition-vP))),5.);gl_FragColor=vec4(.9,.34,.09,e*.16);}`,side:T.BackSide,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));world.add(halo);
 const smokeVertex=`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
 const smoke=[];
 for(let i=0;i<6;i++)for(let j=0;j<4;j++){
 const m=new T.ShaderMaterial({uniforms:{age:{value:0},opacity:{value:0}},vertexShader:smokeVertex,fragmentShader:`uniform float age;uniform float opacity;varying vec2 vUv;${noise}void main(){vec2 p=(vUv-.5)*2.;float edge=1.-smoothstep(.2,1.,length(p));float n=fbm(vec3(p*3.,age*.3));float a=edge*n*opacity;vec3 c=mix(vec3(.95,.43,.12),vec3(.43,.42,.40),smoothstep(0.,.6,age));gl_FragColor=vec4(c,a);}`,transparent:true,depthWrite:false});
 const s=new T.Mesh(new T.PlaneGeometry(1,1),m);scene.add(s);smoke.push({s,i,j});}
 let ready=false,time=0,previous=0,frame=0,visible=true;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),pos=new T.Vector3(),normal=new T.Vector3(),eye=new T.Vector3();
 function eruption(i){const phase=(time+i*7.1)%(27+i*2);return {age:phase,power:Math.sin(Math.PI*Math.min(phase/5,1))**2};}
 function render(){if(!ready)return;ground.uniforms.time.value=time;cloudMat.uniforms.time.value=time;
 world.rotation.y=-1.45+time*.027;clouds.rotation.y=time*.013;
 for(let i=0;i<6;i++)heat[i]=eruption(i).power;
 world.updateWorldMatrix(true,false);
 for(const {s,i,j} of smoke){const e=eruption(i),age=e.age-j*.42;const life=age/5;
 s.visible=age>0&&age<5;if(!s.visible)continue;
 pos.copy(vents[i]).multiplyScalar(1.075+life*.027);pos.x+=life*.018;world.localToWorld(pos);
 normal.copy(pos).normalize();eye.copy(camera.position).sub(pos).normalize();s.visible=normal.dot(eye)>.12;if(!s.visible)continue;
 s.position.copy(pos);s.quaternion.copy(camera.quaternion);s.scale.setScalar(.016+life*.064);
 s.material.uniforms.age.value=life;s.material.uniforms.opacity.value=Math.sin(life*Math.PI)*.5;}
 renderer.render(scene,camera);}
 function tick(now){frame=0;if(!ready||!visible||document.hidden||reduced.matches)return;if(previous)time+=Math.min(.08,(now-previous)/1000);previous=now;render();frame=requestAnimationFrame(tick);}
 function update(){cancelAnimationFrame(frame);previous=0;render();if(ready&&visible&&!document.hidden&&!reduced.matches)frame=requestAnimationFrame(tick);}
 new ResizeObserver(()=>{const s=host.clientWidth||300;renderer.setSize(s,s,false);render();}).observe(host);
 new T.TextureLoader().load('assets/img/hero-volcanic-map.png',texture=>{
 texture.wrapS=T.RepeatWrapping;texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());ground.uniforms.map.value=texture;
 // Choose eruption sites from actual molten areas in the artwork.
 const c=document.createElement('canvas');c.width=256;c.height=128;const ctx=c.getContext('2d');ctx.drawImage(texture.image,0,0,256,128);const data=ctx.getImageData(0,0,256,128).data;
 const candidates=[];for(let y=24;y<105;y+=3)for(let x=0;x<256;x+=3){let k=(y*256+x)*4;if(data[k]>135&&data[k]-data[k+2]>80)candidates.push({x,y,score:data[k]-data[k+2]});}
 candidates.sort((a,b)=>b.score-a.score);const chosen=[];
 for(const q of candidates){if(chosen.every(p=>Math.hypot(Math.min(Math.abs(p.x-q.x),256-Math.abs(p.x-q.x)),p.y-q.y)>23)){chosen.push(q);if(chosen.length===6)break;}}
 chosen.forEach((q,i)=>{const u=q.x/256,v=1-q.y/128,phi=u*Math.PI*2,theta=(1-v)*Math.PI;vents[i].set(-Math.cos(phi)*Math.sin(theta),Math.cos(theta),Math.sin(phi)*Math.sin(theta));});
 ready=true;host.classList.add('planet-ready');time=2;update();},undefined,()=>{host.setAttribute('aria-label','Planet preview could not load');});
 new IntersectionObserver(e=>{visible=e[0].isIntersecting;update();}).observe(host);document.addEventListener('visibilitychange',update);reduced.addEventListener('change',update);
})();
