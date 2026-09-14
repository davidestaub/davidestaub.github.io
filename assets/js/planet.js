// Animated homepage planets. Artwork and rendering are independent of the archive.
(function(){
 const host=document.getElementById('planet-container'); if(!host||!window.THREE)return;
 const variants={
  blue:{map:'assets/img/atlas/collection-40/hd-189733-b-globe.webp',label:'Blue gas giant',rim:[.2,.48,.8],cloud:[.75,.84,.92],speed:.039},
  sapphire:{map:'assets/img/hero-sapphire-map.png',label:'Sapphire gas giant',rim:[.15,.4,.9],cloud:[.78,.85,.97],speed:.034},
  pearl:{map:'assets/img/hero-pearl-map.png',label:'Pearl gas giant',rim:[.72,.52,.34],cloud:[.96,.89,.79],speed:.031},
  ringed:{map:'assets/img/hero-ringed-map.png',label:'Ringed teal planet',rim:[.28,.56,.61],cloud:[.79,.9,.89],speed:.037},
  volcanic:{map:'assets/img/hero-volcanic-map.png',label:'Volcanic planet',rim:[.9,.34,.09],cloud:[.8,.77,.71],speed:.027}
 };
 const requested=host.dataset.planet||new URLSearchParams(location.search).get('planet');
 let last='';try{last=sessionStorage.getItem('hero-last-planet')||'';}catch{}
 const pool=Object.keys(variants).filter(id=>id!==last);
 const id=Object.hasOwn(variants,requested)?requested:pool[Math.floor(Math.random()*pool.length)];
 if(!requested)try{sessionStorage.setItem('hero-last-planet',id);}catch{}
 const config=variants[id],volcanic=id==='volcanic',ringed=id==='ringed';
 host.dataset.planet=id;
 host.style.setProperty('--planet-halo',config.rim.map(n=>Math.round(n*255)).join(','));
 const T=THREE;let renderer;try{renderer=new T.WebGLRenderer({alpha:true,antialias:true});}catch{return;}
 renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setClearColor(0,0);
 renderer.domElement.setAttribute('role','img');renderer.domElement.setAttribute('aria-label',config.label+' rotating with moving clouds'+(volcanic?' and glowing eruptions':''));host.append(renderer.domElement);
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(36,1,.1,30);camera.position.z=ringed?7.8:3.8;
 const axial=new T.Group();axial.rotation.z=ringed?.36:-.18;axial.rotation.x=ringed?.47:0;scene.add(axial);
 const world=new T.Group();world.rotation.y=-1.45;axial.add(world);
 const vertex=`varying vec2 vUv;varying vec3 vN;varying vec3 vP;varying vec3 vLocal;
 void main(){vUv=uv;vLocal=normalize(position);vN=normalize(mat3(modelMatrix)*normal);vP=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
 const noise=`float hash(vec3 p){p=fract(p*.3183099+vec3(.13,.37,.71));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
 float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
 float fbm(vec3 p){float n=0.,a=.52;for(int i=0;i<5;i++){n+=a*noise(p);p=p*2.03+vec3(7.1,3.7,1.3);a*=.48;}return n;}`;
 const vents=Array.from({length:12},()=>new T.Vector3(0,1,0));
 const heat=Array(12).fill(0);
 const ground=new T.ShaderMaterial({uniforms:{map:{value:null},time:{value:0},vents:{value:vents},heat:{value:heat},volcanic:{value:volcanic?1:0},rimColor:{value:new T.Vector3(...config.rim)}},vertexShader:vertex,fragmentShader:`uniform sampler2D map;uniform float time;uniform float volcanic;uniform vec3 rimColor;uniform vec3 vents[12];uniform float heat[12];varying vec2 vUv;varying vec3 vN;varying vec3 vP;varying vec3 vLocal;
 void main(){vec2 uv=vUv;
 if(volcanic<.5){float latitude=(uv.y-.5)*3.14159265;uv.x+=time*.0019*sin(latitude*8.)*cos(latitude);uv.y+=.0015*sin(uv.x*25.+time*.18)*cos(latitude);}
 vec3 tex=texture2D(map,uv).rgb;float hot=smoothstep(.10,.28,tex.r-tex.b)*smoothstep(.25,.65,tex.r);vec3 n=normalize(vN);float lighting=.58+.48*max(dot(n,normalize(vec3(-2.5,2.8,4.5))),0.);vec3 c=tex*lighting;
 c+=volcanic*hot*vec3(.16,.055,.006)*(.7+.3*sin(time*.8+vUv.x*23.+vUv.y*9.));
 for(int i=0;i<12;i++){float d=max(0.,1.-dot(normalize(vLocal),vents[i]));float core=exp(-d*5200.);float halo=exp(-d*420.);c+=volcanic*heat[i]*(vec3(1.,.58,.16)*core+vec3(.36,.09,.008)*halo);}
 float edge=pow(1.-max(dot(n,normalize(cameraPosition-vP)),0.),5.);c+=rimColor*.17*edge;
 gl_FragColor=vec4(c,1.);}`});
 const globe=new T.Mesh(new T.SphereGeometry(1.06,128,80),ground);world.add(globe);
 const cloudMat=new T.ShaderMaterial({uniforms:{time:{value:0},cloudColor:{value:new T.Vector3(...config.cloud)},coverage:{value:volcanic?.94:.26}},vertexShader:vertex,fragmentShader:`uniform float time;uniform vec3 cloudColor;uniform float coverage;varying vec3 vLocal;varying vec3 vN;varying vec3 vP;${noise}
 void main(){vec3 p=vLocal*vec3(3.2,6.,3.2);p+=vec3(time*.019,0.,time*.014);float broad=fbm(p+vec3(fbm(p*1.8)));float fine=fbm(p*4.5+vec3(time*.039,0.,0.));float density=smoothstep(.34,.63,broad)*smoothstep(.20,.60,fine);float facing=max(dot(normalize(vN),normalize(cameraPosition-vP)),0.);float light=.45+.55*max(dot(normalize(vN),normalize(vec3(-2.,3.,4.))),0.);gl_FragColor=vec4(cloudColor*light,density*coverage*smoothstep(0.,.18,facing));}`,
 transparent:true,depthWrite:false});
 const clouds=new T.Mesh(new T.SphereGeometry(1.075,96,64),cloudMat);world.add(clouds);
 const halo=new T.Mesh(new T.SphereGeometry(1.081,96,64),new T.ShaderMaterial({vertexShader:vertex,uniforms:{rimColor:{value:new T.Vector3(...config.rim)}},fragmentShader:`uniform vec3 rimColor;varying vec3 vN;varying vec3 vP;void main(){float e=pow(1.-abs(dot(normalize(vN),normalize(cameraPosition-vP))),5.);gl_FragColor=vec4(rimColor,e*.16);}`,side:T.BackSide,transparent:true,depthWrite:false,blending:T.AdditiveBlending}));world.add(halo);
 if(ringed){
  const ring=new T.Mesh(new T.RingGeometry(1.36,2.23,192,8),new T.ShaderMaterial({
   vertexShader:`varying vec3 local;varying vec3 wp;void main(){local=position;wp=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
   fragmentShader:`varying vec3 local;varying vec3 wp;
    void main(){float r=length(local.xy);float width=fwidth(r);float fine=(1.-smoothstep(.4,1.5,width*143.))*sin(r*143.);float stripes=.55+.14*sin(r*55.)+.07*fine;
    float gap=1.-smoothstep(max(0.,.009-width),.015+width,abs(r-1.86));float alpha=(.54+.24*stripes)*(1.-gap*.96);
    alpha*=smoothstep(1.36,1.39,r)*(1.-smoothstep(2.19,2.23,r));
    vec3 sun=normalize(vec3(-2.5,2.8,4.5));float along=dot(-wp,sun);float separation=length(wp+sun*max(0.,along));
    float shade=along>0.?mix(.20,1.,smoothstep(1.01,1.10,separation)):1.;
    vec3 c=mix(vec3(.35,.36,.36),vec3(.80,.77,.70),stripes)*shade;gl_FragColor=vec4(c,alpha);}`,
   side:T.DoubleSide,transparent:true,depthWrite:false}));
  ring.rotation.x=Math.PI/2;axial.add(ring);
 }
 const smokeVertex=`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
 const smoke=[];
 for(let i=0;i<(volcanic?12:0);i++)for(let j=0;j<4;j++){
 const m=new T.ShaderMaterial({uniforms:{age:{value:0},opacity:{value:0}},vertexShader:smokeVertex,fragmentShader:`uniform float age;uniform float opacity;varying vec2 vUv;${noise}void main(){vec2 p=(vUv-.5)*2.;float edge=1.-smoothstep(.2,1.,length(p));float n=fbm(vec3(p*3.,age*.3));float a=edge*n*opacity;vec3 c=mix(vec3(.95,.43,.12),vec3(.43,.42,.40),smoothstep(0.,.6,age));gl_FragColor=vec4(c,a);}`,transparent:true,depthWrite:false});
 const s=new T.Mesh(new T.PlaneGeometry(1,1),m);scene.add(s);smoke.push({s,i,j});}
 let ready=false,time=0,previous=0,frame=0,visible=true;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)'),pos=new T.Vector3(),normal=new T.Vector3(),eye=new T.Vector3();
 function eruption(i){const phase=(time+i*2.7)%(10+(i%5)*1.3);return {age:phase,power:Math.sin(Math.PI*Math.min(phase/5,1))**2};}
 function render(){if(!ready)return;ground.uniforms.time.value=time;cloudMat.uniforms.time.value=time;
 world.rotation.y=-1.45+time*config.speed;clouds.rotation.y=time*(volcanic?.070:.042);
 for(let i=0;i<12;i++)heat[i]=eruption(i).power;
 world.updateWorldMatrix(true,false);
 for(const {s,i,j} of smoke){const e=eruption(i),age=e.age-j*.42;const life=age/5;
 s.visible=age>0&&age<5;if(!s.visible)continue;
 pos.copy(vents[i]).multiplyScalar(1.075+life*.05);pos.x+=life*.034;world.localToWorld(pos);
 normal.copy(pos).normalize();eye.copy(camera.position).sub(pos).normalize();s.visible=normal.dot(eye)>.12;if(!s.visible)continue;
 s.position.copy(pos);s.quaternion.copy(camera.quaternion);s.scale.setScalar(.023+life*.09);
 s.material.uniforms.age.value=life;s.material.uniforms.opacity.value=Math.sin(life*Math.PI)*.7;}
 renderer.render(scene,camera);}
 function tick(now){frame=0;if(!ready||!visible||document.hidden||reduced.matches)return;if(previous)time+=Math.min(.08,(now-previous)/1000);previous=now;render();frame=requestAnimationFrame(tick);}
 function update(){cancelAnimationFrame(frame);previous=0;render();if(ready&&visible&&!document.hidden&&!reduced.matches)frame=requestAnimationFrame(tick);}
 new ResizeObserver(()=>{const s=host.clientWidth||300;renderer.setSize(s,s,false);render();}).observe(host);
 new T.TextureLoader().load(config.map,texture=>{
 texture.wrapS=T.RepeatWrapping;texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());ground.uniforms.map.value=texture;
 // Choose eruption sites from actual molten areas in the artwork.
 if(volcanic){const c=document.createElement('canvas');c.width=256;c.height=128;const ctx=c.getContext('2d');ctx.drawImage(texture.image,0,0,256,128);const data=ctx.getImageData(0,0,256,128).data;
 const candidates=[];for(let y=24;y<105;y+=3)for(let x=0;x<256;x+=3){let k=(y*256+x)*4;if(data[k]>135&&data[k]-data[k+2]>80)candidates.push({x,y,score:data[k]-data[k+2]});}
 candidates.sort((a,b)=>b.score-a.score);const chosen=[];
 for(const q of candidates){if(chosen.every(p=>Math.hypot(Math.min(Math.abs(p.x-q.x),256-Math.abs(p.x-q.x)),p.y-q.y)>15)){chosen.push(q);if(chosen.length===12)break;}}
 chosen.forEach((q,i)=>{const u=q.x/256,v=1-q.y/128,phi=u*Math.PI*2,theta=(1-v)*Math.PI;vents[i].set(-Math.cos(phi)*Math.sin(theta),Math.cos(theta),Math.sin(phi)*Math.sin(theta));});
 } ready=true;host.classList.add('planet-ready');time=2;update();},undefined,()=>{host.setAttribute('aria-label','Planet preview could not load');});
 new IntersectionObserver(e=>{visible=e[0].isIntersecting;update();}).observe(host);document.addEventListener('visibilitychange',update);reduced.addEventListener('change',update);
})();
