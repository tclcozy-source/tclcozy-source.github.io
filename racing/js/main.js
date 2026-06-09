import * as THREE from 'three';
import { RoomEnvironment }    from 'three/addons/environments/RoomEnvironment.js';
import { input }              from './input.js';
import { Car }                from './car.js';
import { ChaseCamera }        from './camera.js';
import { buildWorld, scatterTrees } from './world.js';
import { buildTrack }         from './track.js';
import { engineAudio }        from './audio.js';

// ---- Desktop-only gate ----------------------------------------------------
// This game is laptop/desktop only. On phones/tablets show a message and stop.
const isMobile =
  /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer: fine)').matches);

if (isMobile) {
  const gate = document.getElementById('mobile-gate');
  if (gate) gate.style.display = 'flex';
  const canvas = document.getElementById('game-canvas');
  if (canvas) canvas.style.display = 'none';
} else {
  startGame();
}

function startGame() {
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

  // Environment map for realistic reflections on the car paint / glass / rims
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // World: sky, lights, ground -> track -> trees (avoiding the track)
  buildWorld(scene);
  const track = buildTrack(scene);
  scatterTrees(scene, track);

  // Car + chase camera
  const car         = new Car(scene);
  car.placeAt(track.start.x, track.start.z, track.startHeading);
  car.autoTransmission = false; // desktop defaults to manual (Q/E)
  const chaseCamera = new ChaseCamera(camera);

  // HUD elements
  const speedEl    = document.getElementById('speed-value');
  const gearEl     = document.getElementById('gear-value');
  const rpmEl      = document.getElementById('rpm-value');
  const tachFillEl = document.getElementById('tach-fill');
  const statusEl   = document.getElementById('engine-status');
  const transLabel = document.getElementById('transmission-label');
  const transBtn   = document.getElementById('btn-transmission');

  function refreshTransmissionUI() {
    if (transLabel) transLabel.textContent = car.autoTransmission ? 'AUTO' : 'MANUAL';
    if (transBtn)   transBtn.classList.toggle('auto', car.autoTransmission);
  }
  refreshTransmissionUI();

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

    // Auto/Manual transmission toggle (T key or button)
    if (input.toggleTransmission) {
      input.toggleTransmission = false;
      car.autoTransmission = !car.autoTransmission;
      refreshTransmissionUI();
    }

    car.update(input, dt);
    chaseCamera.update(car);

    // Sound events on state changes
    if (car.engineState !== prevState) {
      if (car.engineState === 'cranking') engineAudio.crank();
      prevState = car.engineState;
    }
    if (car.startRejected) {
      engineAudio.fail();
      car.startRejected = false;
    }
    if (car.gear !== prevGear) {
      engineAudio.shift();
      prevGear = car.gear;
    }

    // Synthesized V8 engine — pitch tied directly to RPM
    engineAudio.update(car.rpm, input.forward, car.isRunning, car.speed);

    // Update HUD (tachometer shows the F1-scale display RPM)
    speedEl.textContent = Math.round(car.kmh);
    gearEl.textContent  = car.gearLabel;
    rpmEl.textContent   = car.displayRpm;
    const rpmPct = Math.min(car.displayRpm / car.maxRpm, 1) * 100;
    tachFillEl.style.width = rpmPct + '%';
    tachFillEl.classList.toggle('redline', car.displayRpm > car.redline);
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
}
