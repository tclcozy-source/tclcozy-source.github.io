import * as THREE from 'three';

// ---- Steering ----
const MAX_YAW_RATE    = 2.2;    // rad/s at full lock, low speed
const STEER_SPEED_REF = 0.04;   // higher -> steering tightens less at speed
const STEER_RESPONSE  = 6.0;    // how fast steering eases toward target (per s)
const STEER_RETURN    = 9.0;    // quicker self-centering when no input
const BODY_ROLL_MAX   = 0.03;   // subtle visual lean

// ---- Engine ----
const ENGINE_IDLE_RPM   = 900;
const ENGINE_REDLINE    = 7200;
const ENGINE_MAX_RPM    = 8000;  // tachometer ceiling
const PEAK_TORQUE_RPM   = 4600;
const LIMITER_START_RPM = 6500;  // power begins falling off above this
const CRANK_TIME        = 1.1;   // seconds of cranking before idle

// ---- Drivetrain ----
// gear index: -1 = reverse, 0 = neutral, 1..6 = forward gears
const FINAL_DRIVE = 3.0;
const GEAR_RATIOS = { '-1': 3.6, 1: 3.85, 2: 2.6, 3: 1.9, 4: 1.45, 5: 1.15, 6: 0.95 };
const RPM_PER_MS  = 39;    // engineRPM = |speed| * effRatio * RPM_PER_MS
const TORQUE_K    = 0.85;  // engine force scaling (accel feel)

// ---- Resistance ----
const BRAKE_DECEL       = 26;
const ROLLING_DRAG      = 0.8;
const AERO_DRAG         = 0.0004;
const ENGINE_BRAKE_BASE = 2.2;
const MAX_REVERSE_SPEED = 12;

const EFF_RATIO_1 = GEAR_RATIOS[1] * FINAL_DRIVE; // reference for engine braking

export class Car {
  constructor(scene) {
    this.speed       = 0;       // signed m/s: + forward, - reverse
    this.heading     = 0;       // world-space yaw (radians)
    this.steerValue  = 0;       // smoothed steering, -1 (right) .. +1 (left)
    this.bodyRoll    = 0;       // visual only
    this.gear        = 1;       // start ready to launch in 1st
    this.rpm         = 0;       // engine off at spawn
    this.engineState = 'off';   // 'off' | 'ignition' | 'cranking' | 'running'
    this.crankTimer  = 0;
    this.startRejected = false; // one-shot: start attempted without ignition

    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  _buildMesh() {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.4, metalness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.6 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
    const rimMat   = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.8 });

    // Lower body
    const lower = new THREE.Mesh(new THREE.BoxGeometry(2, 0.4, 4.2), bodyMat);
    lower.position.y = 0.3;
    lower.castShadow = true;
    group.add(lower);

    // Upper cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), bodyMat);
    cabin.position.set(0, 0.75, -0.1);
    cabin.castShadow = true;
    group.add(cabin);

    // Windscreen
    const windscreen = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 0.08), glassMat);
    windscreen.position.set(0, 0.72, 1.0);
    group.add(windscreen);

    // Rear window
    const rearWin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 0.08), glassMat);
    rearWin.position.set(0, 0.72, -1.2);
    group.add(rearWin);

    // Wheels
    const wheelPositions = [
      [ 1.1, 0.28,  1.5],  // front-right
      [-1.1, 0.28,  1.5],  // front-left
      [ 1.1, 0.28, -1.5],  // rear-right
      [-1.1, 0.28, -1.5],  // rear-left
    ];
    this.wheelMeshes = [];
    wheelPositions.forEach(([x, y, z]) => {
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.22, 20), wheelMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;

      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.23, 8), rimMat);
      rim.rotation.z = Math.PI / 2;

      const wheel = new THREE.Group();
      wheel.add(tire);
      wheel.add(rim);
      wheel.position.set(x, y, z);
      group.add(wheel);
      this.wheelMeshes.push(wheel);
    });

    return group;
  }

  // Place the car at a track position facing a heading (radians).
  placeAt(x, z, heading) {
    this.mesh.position.set(x, 0, z);
    this.heading = heading;
    this.speed = 0;
    this.gear = 1;
    this.mesh.rotation.y = heading;
  }

  // --- Ignition / starter ---
  toggleIgnition() {
    this.engineState = (this.engineState === 'off') ? 'ignition' : 'off';
  }

  startEngine() {
    // The starter only works with ignition already ON (press I first)
    if (this.engineState === 'ignition') {
      this.engineState = 'cranking';
      this.crankTimer = CRANK_TIME;
    } else if (this.engineState === 'off') {
      this.startRejected = true; // dead click — needs ignition first
    }
    // already cranking / running: ignore
  }

  get isRunning() { return this.engineState === 'running'; }

  update(input, dt) {
    this._handleIgnition(input);
    this._handleShift(input);
    this._updateEngine(input, dt);
    this._updateSteering(input, dt);
    this._integrate(dt);
    this._updateVisuals(dt);
  }

  _handleIgnition(input) {
    if (input.ignitionToggle) { this.toggleIgnition(); input.ignitionToggle = false; }
    if (input.startEngine)    { this.startEngine();    input.startEngine = false; }
  }

  _handleShift(input) {
    if (input.shiftUp)   { this.gear = Math.min(this.gear + 1, 6);  input.shiftUp = false; }
    if (input.shiftDown) { this.gear = Math.max(this.gear - 1, -1); input.shiftDown = false; }
  }

  _updateEngine(input, dt) {
    // Advance the cranking phase
    if (this.engineState === 'cranking') {
      this.crankTimer -= dt;
      if (this.crankTimer <= 0) this.engineState = 'running';
    }

    // Engine not running -> no drive. Car can still brake/coast to a stop.
    if (this.engineState !== 'running') {
      if (this.engineState === 'cranking') {
        const prog = 1 - Math.max(this.crankTimer, 0) / CRANK_TIME;
        this.rpm = 200 + prog * 200;             // labouring starter
      } else {
        this.rpm = 0;                            // off / electronics only
      }
      this._applyBrakeAndDrag(input, dt);
      return;
    }

    const throttle = input.forward;
    const braking  = input.backward;
    let engineAccel = 0;

    if (this.gear === 0) {
      // Neutral — engine free-revs, no drive to the wheels
      const target = throttle ? ENGINE_REDLINE * 0.88 : ENGINE_IDLE_RPM;
      this.rpm += (target - this.rpm) * (throttle ? 0.07 : 0.05);
    } else {
      const effRatio = GEAR_RATIOS[this.gear] * FINAL_DRIVE;
      const dir = this.gear < 0 ? -1 : 1;
      const rawRpm = Math.abs(this.speed) * effRatio * RPM_PER_MS;
      this.rpm = Math.max(ENGINE_IDLE_RPM, rawRpm);

      const gearTopSpeed = (ENGINE_REDLINE / (effRatio * RPM_PER_MS)) * dir;
      if (throttle) {
        const atLimit = dir > 0 ? this.speed >= gearTopSpeed : this.speed <= gearTopSpeed;
        if (!atLimit) engineAccel = torqueFactor(this.rpm) * effRatio * TORQUE_K * dir;
      } else if (Math.abs(this.speed) > 0.1) {
        const eb = ENGINE_BRAKE_BASE * (effRatio / EFF_RATIO_1);
        engineAccel = -Math.sign(this.speed) * eb;
      }
    }

    this.speed += engineAccel * dt;
    this._applyBrakeAndDrag(input, dt);
  }

  _applyBrakeAndDrag(input, dt) {
    if (input.backward) {
      if (this.speed > 0)      this.speed = Math.max(0, this.speed - BRAKE_DECEL * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + BRAKE_DECEL * dt);
    }
    const drag = ROLLING_DRAG + AERO_DRAG * this.speed * this.speed;
    if (this.speed > 0)      this.speed = Math.max(0, this.speed - drag * dt);
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + drag * dt);

    this.speed = THREE.MathUtils.clamp(this.speed, -MAX_REVERSE_SPEED, 75);
  }

  _updateSteering(input, dt) {
    // Ease the steering value toward the target instead of snapping to it
    const target = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    const resp = (target === 0) ? STEER_RETURN : STEER_RESPONSE;
    this.steerValue += (target - this.steerValue) * Math.min(1, resp * dt);

    // Turn rate eases off as speed climbs, for stability
    if (Math.abs(this.speed) > 0.5) {
      const speedFactor = 1 / (1 + Math.abs(this.speed) * STEER_SPEED_REF);
      const yawRate = this.steerValue * MAX_YAW_RATE * speedFactor;
      this.heading += yawRate * Math.sign(this.speed) * dt;
    }
  }

  _integrate(dt) {
    this.mesh.position.x += Math.sin(this.heading) * this.speed * dt;
    this.mesh.position.z += Math.cos(this.heading) * this.speed * dt;
    this.mesh.position.y = 0;
    this.mesh.rotation.y = this.heading;
  }

  _updateVisuals(dt) {
    // Subtle body roll, following the smoothed steering
    const speedFrac = this.speed / 60;
    const targetRoll = BODY_ROLL_MAX * this.steerValue * speedFrac;
    this.bodyRoll += (targetRoll - this.bodyRoll) * 0.12;
    this.mesh.rotation.z = this.bodyRoll;

    // Spin wheels with road speed
    const spin = this.speed * dt * 3;
    this.wheelMeshes.forEach(w => { w.rotation.x += spin; });
  }

  get position()  { return this.mesh.position; }
  get kmh()       { return Math.abs(this.speed) * 3.6; }
  get maxRpm()    { return ENGINE_MAX_RPM; }
  get redline()   { return LIMITER_START_RPM; }
  get gearLabel() {
    if (this.gear === -1) return 'R';
    if (this.gear === 0)  return 'N';
    return String(this.gear);
  }
  get statusLabel() {
    switch (this.engineState) {
      case 'ignition': return 'Ignition On';
      case 'cranking': return 'Starting…';
      case 'running':  return 'Running';
      default:         return 'Engine Off';
    }
  }
}

// Normalised engine torque (0..1) across the rev range.
function torqueFactor(rpm) {
  if (rpm > ENGINE_REDLINE) return 0.10; // bouncing off the limiter
  let t = 1 - 0.5 * ((rpm - PEAK_TORQUE_RPM) / PEAK_TORQUE_RPM) ** 2;
  t = Math.max(0.3, Math.min(1, t));
  if (rpm > LIMITER_START_RPM) {
    const f = (rpm - LIMITER_START_RPM) / (ENGINE_REDLINE - LIMITER_START_RPM);
    t *= (1 - 0.75 * f);
  }
  return t;
}
