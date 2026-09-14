// Homepage globe. The archive keeps its own renderer.
(function () {
  const container = document.getElementById('planet-container');
  if (!container || !window.THREE) return;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); }
  catch { return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Slowly rotating blue exoplanet with pale cloud bands');
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, .1, 30);
  camera.position.set(0, 0, 3.8);
  const group = new THREE.Group();
  group.rotation.z = -.23;
  scene.add(group);
  const vertex = `varying vec2 vUv; varying vec3 vN; varying vec3 vP;
    void main(){vUv=uv; vN=normalize(mat3(modelMatrix)*normal);
    vP=(modelMatrix*vec4(position,1.)).xyz;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader: vertex,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main(){
        vec3 n=normalize(vN), eye=normalize(cameraPosition-vP);
        float facing=max(dot(n,eye),0.);
        float light=max(dot(n,normalize(vec3(-2.5,2.8,4.5))),0.);
        vec3 color=pow(texture2D(map,vUv).rgb,vec3(2.2));
        color*=.64+.48*light;
        float rim=pow(1.-facing,3.5);
        color=mix(color,vec3(.13,.42,.68),rim*.40);
        color+=vec3(.12,.28,.38)*pow(1.-facing,7.)*.24;
        gl_FragColor=vec4(pow(max(color,vec3(0.)),vec3(1./2.2)),1.);
      }`
  });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1.06, 128, 80), material);
  globe.rotation.y = .7;
  group.add(globe);
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.085, 96, 64),new THREE.ShaderMaterial({
    vertexShader:vertex,
    fragmentShader:`varying vec3 vN;varying vec3 vP;
      void main(){float edge=pow(1.-abs(dot(normalize(vN),normalize(cameraPosition-vP))),4.);
      gl_FragColor=vec4(.25,.63,.95,edge*.13);}`,
    transparent:true,depthWrite:false,side:THREE.BackSide,blending:THREE.AdditiveBlending
  }));
  group.add(atmosphere);
  let ready=false, visible=true, frame=0, previous=0;
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
  function draw(){if(ready)renderer.render(scene,camera);}
  function tick(now){frame=0;if(document.hidden||!visible||reduced.matches||!ready)return;
    if(previous)globe.rotation.y+=Math.min((now-previous)/1000,.05)*.065;
    previous=now;draw();frame=requestAnimationFrame(tick);
  }
  function update(){cancelAnimationFrame(frame);frame=0;previous=0;draw();
    if(ready&&visible&&!document.hidden&&!reduced.matches)frame=requestAnimationFrame(tick);
  }
  function resize(){const size=container.clientWidth||300;renderer.setSize(size,size,false);draw();}
  new ResizeObserver(resize).observe(container);resize();
  new THREE.TextureLoader().load('assets/img/atlas/collection-40/hd-189733-b-globe.webp',texture=>{
    texture.wrapS=THREE.RepeatWrapping;
    texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    material.uniforms.map.value=texture;ready=true;container.classList.add('planet-ready');update();
  });
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;update();},{threshold:.01}).observe(container);
  document.addEventListener('visibilitychange',update);
  reduced.addEventListener('change',update);
})();
