// Rotating gas giant for the home hero.
// Requires three.min.js to be loaded first.
(function () {
  const container = document.getElementById('planet-container');
  if (!container || !window.THREE) return;

  const size = container.clientWidth || 280;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(size, size);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 3.2);

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const keyLight = new THREE.DirectionalLight(0xfff3d6, 1.25);
  keyLight.position.set(3, 2, 4);
  scene.add(keyLight);
  const rim = new THREE.DirectionalLight(0x6fa8ff, 0.5);
  rim.position.set(-4, -1, -2);
  scene.add(rim);

  const textures = [
    'assets/img/exoplanet_var1.jpg',
    'assets/img/exoplanet_var2.jpg',
    'assets/img/exoplanet_var3.jpg',
    'assets/img/exoplanet_var4.jpg',
    'assets/img/exoplanet_var5.jpg'
  ];
  const map = new THREE.TextureLoader().load(textures[Math.floor(Math.random() * textures.length)]);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.offset.x = Math.random();

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(1.28, 64, 64),
    new THREE.MeshStandardMaterial({ map: map, roughness: 1, metalness: 0 })
  );
  scene.add(planet);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame() {
    planet.rotation.y += 0.0028;
    renderer.render(scene, camera);
  }
  function animate() {
    requestAnimationFrame(animate);
    frame();
  }
  if (reduced) {
    map.onUpdate = null;
    setTimeout(frame, 200);   // one still frame once the texture is in
  } else {
    animate();
  }

  window.addEventListener('resize', () => {
    const s = container.clientWidth || 280;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(s, s);
    if (reduced) frame();
  });
})();
