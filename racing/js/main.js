import * as THREE from 'three';
import { input }              from './input.js';
import { Car }                from './car.js';
import { ChaseCamera }        from './camera.js';
import { buildWorld, scatterTrees } from './world.js';
import { buildTrack }         from './track.js';
import { engineAudio }        from './audio.js';

// Renderer
const canvas   = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.outputColorSpace   = THREE.SRGBColorSpace;
renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

// Scene & camera
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 500);

// World: sky, lights, ground -> track -> trees (avoiding the track)
buildWorld(scene);
const track = buildTrack(scene);
scatterTrees(scene, track);

// Car + chase camera
const car         = new Car(scene);
car.placeAt(track.start.x, track.start.z, track.startHeading);
const chaseCamera = new ChaseCamera(camera);

// HUD elements
const speedEl    = document.getElementById('speed-value');
const gearEl     = document.getElementById('gear-value');
const rpmEl      = document.getElementById('rpm-value');
const tachFillEl = document.getElementById('tach-fill');
const statusEl   = document.getElementById('engine-status');

// Audio: starts on the first user gesture (autoplay policy)
engineAudio.attachAutoResume();

// Clock
const clock = new THREE.Clock();

// Track transitions so we can fire one-shot sounds
let prevGear  = car.gear;
let prevState = car.engineState;

// Game loop
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05); // cap dt to avoid tunnelling

  car.update(input, dt);
  chaseCamera.update(car);

  // Sound events on state changes
  if (car.engineState !== prevState) {
    if (car.engineState === 'cranking') engineAudio.crank();
    prevState = car.engineState;
  }
  if (car.startRejected) {        // tried to start with ignition off
    engineAudio.fail();
    car.startRejected = false;
  }
  if (car.gear !== prevGear) {
    engineAudio.shift();
    prevGear = car.gear;
  }
  engineAudio.update(car.rpm, input.forward, car.isRunning, car.speed);

  // Update HUD
  speedEl.textContent = Math.round(car.kmh);
  gearEl.textContent  = car.gearLabel;
  rpmEl.textContent   = Math.round(car.rpm);
  const rpmPct = Math.min(car.rpm / car.maxRpm, 1) * 100;
  tachFillEl.style.width = rpmPct + '%';
  tachFillEl.classList.toggle('redline', car.rpm > car.redline);
  statusEl.textContent = car.statusLabel;
  statusEl.className   = 'status-' + car.engineState;

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

tick();
