import * as THREE from 'three';

export function buildWorld(scene) {
  // Sky colour
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0x87ceeb, 200, 1200);

  // Lighting
  const sun = new THREE.DirectionalLight(0xfff5e0, 2.2);
  sun.position.set(40, 60, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far  = 300;
  sun.shadow.camera.left  = -80;
  sun.shadow.camera.right =  80;
  sun.shadow.camera.top   =  80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  const ambient = new THREE.AmbientLight(0xb0c8e8, 0.8);
  scene.add(ambient);

  // Ground plane
  const groundGeo = new THREE.PlaneGeometry(4000, 4000, 80, 80);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x3a7d44,
    roughness: 0.95,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

// Scatter trees across the grass, skipping anything sitting on the track.
export function scatterTrees(scene, track) {
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8B5E3C, roughness: 1 });
  const leafMat  = new THREE.MeshStandardMaterial({ color: 0x2d6a2d, roughness: 0.9 });

  const rng = mulberry32(42);
  let placed = 0;
  let attempts = 0;
  while (placed < 500 && attempts < 4000) {
    attempts++;
    const side = rng() > 0.5 ? 1 : -1;
    const x = side * (8 + rng() * 1800);
    const z = (rng() - 0.5) * 3800;
    if (track && track.isNear(x, z, 12)) continue; // keep the racing surface clear

    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 6), trunkMat);
    trunk.position.set(x, 1, z);
    trunk.castShadow = true;
    scene.add(trunk);

    const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.5, 7), leafMat);
    leaves.position.set(x, 3.8, z);
    leaves.castShadow = true;
    scene.add(leaves);
    placed++;
  }
}

// Deterministic RNG so scene is consistent
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
