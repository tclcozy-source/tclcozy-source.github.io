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

// ---- Rev dynamics (display/audio smoothing — does not affect physics) ----
const RPM_RISE_RATE  = 11;    // per second — quick rev pickup on throttle
const RPM_FALL_RATE  = 2.0;   // per second — exponential ease for the final approach
const RPM_FALL_MAX   = 2600;  // hard cap on rev-down speed (rpm/sec) so braking never plummets
const DOWNSHIFT_BLIP = 1200;  // rpm bump injected on downshift (rev-match)
const BLIP_DECAY     = 0.90;  // per-frame blip decay (~0.35s at 60fps)

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

// ---- Automatic transmission ----
const AUTO_UPSHIFT_RPM   = 6900; // hold each gear and rev out before upshifting
const AUTO_DOWNSHIFT_RPM = 1850; // only drop a gear once revs fall well off — no eager downshifts
const AUTO_SHIFT_COOLDOWN = 0.7; // seconds between auto shifts (relaxed, anti-hunting)

export class Car {
  constructor(scene) {
    this.speed       = 0;       // signed m/s: + forward, - reverse
    this.heading     = 0;       // world-space yaw (radians)
    this.steerValue  = 0;       // smoothed steering, -1 (right) .. +1 (left)
    this.bodyRoll    = 0;       // visual only
    this.gear        = 1;       // start ready to launch in 1st
    this.rpm         = 0;       // displayed/audible rpm (smoothed + blip)
    this._baseRpm    = 0;       // smoothed mechanical rpm
    this.revBlip     = 0;       // transient downshift rev-match blip
    this.engineState = 'off';   // 'off' | 'ignition' | 'cranking' | 'running'
    this.crankTimer  = 0;
    this.startRejected = false; // one-shot: start attempted without ignition
    this.autoTransmission = false; // set by main (mobile = true; desktop togglable)
    this._autoCooldown = 0;     // anti-hunting timer for auto shifts

    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  _buildMesh() {
    // Ferrari-style Formula 1 single-seater. Forward = +Z (nose), rear = -Z.
    const group = new THREE.Group();

    const RED      = 0xd00000; // Ferrari red
    const bodyMat   = new THREE.MeshStandardMaterial({ color: RED,      roughness: 0.35, metalness: 0.45 });
    const carbonMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5,  metalness: 0.4 });
    const tireMat   = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
    const rimMat    = new THREE.MeshStandardMaterial({ color: 0xcacaca, roughness: 0.3,  metalness: 0.9 });
    const darkMat   = new THREE.MeshStandardMaterial({ color: 0x202225, roughness: 0.7 });
    const helmetMat = new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.3,  metalness: 0.2 });

    const add = (geo, mat, x, y, z, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      group.add(m);
      return m;
    };

    // Floor plank
    add(new THREE.BoxGeometry(0.9, 0.08, 3.6), carbonMat, 0, 0.12, -0.2).receiveShadow = true;

    // Central monocoque tub
    add(new THREE.BoxGeometry(0.62, 0.34, 2.4), bodyMat, 0, 0.34, -0.2);

    // Sidepods (radiator bulges either side of the cockpit)
    [-1, 1].forEach((s) => add(new THREE.BoxGeometry(0.42, 0.34, 1.5), bodyMat, s * 0.52, 0.32, -0.55));

    // Nose: main section + tapered cone tip pointing forward
    add(new THREE.BoxGeometry(0.5, 0.28, 1.4), bodyMat, 0, 0.4, 1.25);
    const noseTip = add(new THREE.ConeGeometry(0.22, 0.9, 14), bodyMat, 0, 0.36, 2.15);
    noseTip.rotation.x = Math.PI / 2;

    // Front wing (main plane + flap + endplates + pylons)
    add(new THREE.BoxGeometry(1.75, 0.05, 0.55), bodyMat, 0, 0.16, 2.5);
    add(new THREE.BoxGeometry(1.75, 0.04, 0.2),  bodyMat, 0, 0.24, 2.62, false);
    [-1, 1].forEach((s) => add(new THREE.BoxGeometry(0.04, 0.22, 0.6), carbonMat, s * 0.86, 0.22, 2.5));
    [-1, 1].forEach((s) => add(new THREE.BoxGeometry(0.05, 0.2, 0.1),  carbonMat, s * 0.18, 0.26, 2.55, false));

    // Cockpit: raised rim, dark opening, driver helmet + visor
    add(new THREE.BoxGeometry(0.56, 0.16, 0.95), bodyMat, 0, 0.52, 0.25);
    add(new THREE.BoxGeometry(0.42, 0.16, 0.7),  darkMat, 0, 0.6, 0.28, false);
    add(new THREE.SphereGeometry(0.17, 18, 14),  helmetMat, 0, 0.7, 0.18);
    add(new THREE.BoxGeometry(0.2, 0.06, 0.04),  darkMat, 0, 0.71, 0.33, false);

    // Airbox / roll hoop behind the driver, sloping engine cover to the rear
    add(new THREE.BoxGeometry(0.34, 0.4, 0.5),  bodyMat, 0, 0.72, -0.45);
    add(new THREE.BoxGeometry(0.4, 0.36, 1.3),  bodyMat, 0, 0.46, -1.1);

    // Rear wing: support pylon, main plane, upper flap, endplates
    add(new THREE.BoxGeometry(0.12, 0.55, 0.25), carbonMat, 0, 0.75, -1.95, false);
    add(new THREE.BoxGeometry(1.15, 0.06, 0.42), bodyMat, 0, 1.0, -2.0);
    add(new THREE.BoxGeometry(1.15, 0.06, 0.3),  bodyMat, 0, 1.14, -2.06);
    [-1, 1].forEach((s) => add(new THREE.BoxGeometry(0.05, 0.42, 0.55), carbonMat, s * 0.6, 1.05, -2.02));

    // Open wheels (fat rears), with steerable fronts and suspension arms
    const wheelDefs = [
      { x:  0.95, z:  1.55, r: 0.33, w: 0.30, front: true  },
      { x: -0.95, z:  1.55, r: 0.33, w: 0.30, front: true  },
      { x:  1.0,  z: -1.5,  r: 0.36, w: 0.46, front: false },
      { x: -1.0,  z: -1.5,  r: 0.36, w: 0.46, front: false },
    ];
    this.wheelMeshes = [];   // inner spinners (roll)
    this.frontWheels = [];   // outer groups (steer)
    wheelDefs.forEach(({ x, z, r, w, front }) => {
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 12), rimMat);
      rim.rotation.z = Math.PI / 2;

      const spinner = new THREE.Group();   // rotates about X to roll
      spinner.add(tire);
      spinner.add(rim);

      const wheel = new THREE.Group();     // rotates about Y to steer
      wheel.add(spinner);
      wheel.position.set(x, r, z);
      group.add(wheel);

      this.wheelMeshes.push(spinner);
      if (front) this.frontWheels.push(wheel);

      // Suspension arm to the body
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, Math.abs(x) - 0.32, 6), carbonMat);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(x * 0.55, r, z);
      group.add(arm);
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
    // In automatic mode the gearbox manages itself — ignore manual shifts
    if (this.autoTransmission) { input.shiftUp = false; input.shiftDown = false; return; }
    if (input.shiftUp) {
      this.gear = Math.min(this.gear + 1, 6);
      input.shiftUp = false;
    }
    if (input.shiftDown) {
      const before = this.gear;
      this.gear = Math.max(this.gear - 1, -1);
      // Rev-match blip: revs briefly rise when dropping a gear under power/braking
      if (this.gear < before && this.engineState === 'running') {
        this.revBlip = Math.max(this.revBlip, DOWNSHIFT_BLIP);
      }
      input.shiftDown = false;
    }
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
      this._baseRpm = this.rpm;                  // keep base synced for a clean start
      this.revBlip = 0;
      this._applyBrakeAndDrag(input.backward, dt);
      return;
    }

    // Automatic mode picks the gear (and reverse) for you.
    if (this.autoTransmission) this._autoTransmission(input, dt);

    // Effective throttle/brake. While in reverse the controls flip so that
    // "down/back" drives backwards and "up/forward" brakes — like an automatic.
    let throttle, braking;
    if (this.gear < 0) { throttle = input.backward; braking = input.forward; }
    else               { throttle = input.forward;  braking = input.backward; }

    let engineAccel = 0;
    let targetRpm;

    if (this.gear === 0) {
      // Neutral — engine free-revs, no drive to the wheels
      targetRpm = throttle ? ENGINE_REDLINE * 0.85 : ENGINE_IDLE_RPM;
    } else {
      const effRatio = GEAR_RATIOS[this.gear] * FINAL_DRIVE;
      const dir = this.gear < 0 ? -1 : 1;
      // Mechanical rpm drives the *physics* (unchanged gearbox behaviour)
      const mechRpm = Math.max(ENGINE_IDLE_RPM, Math.abs(this.speed) * effRatio * RPM_PER_MS);
      targetRpm = mechRpm;

      const gearTopSpeed = (ENGINE_REDLINE / (effRatio * RPM_PER_MS)) * dir;
      if (throttle) {
        const atLimit = dir > 0 ? this.speed >= gearTopSpeed : this.speed <= gearTopSpeed;
        if (!atLimit) engineAccel = torqueFactor(mechRpm) * effRatio * TORQUE_K * dir;
      } else if (Math.abs(this.speed) > 0.1) {
        const eb = ENGINE_BRAKE_BASE * (effRatio / EFF_RATIO_1);
        engineAccel = -Math.sign(this.speed) * eb;
      }
    }

    this.speed += engineAccel * dt;
    this._applyBrakeAndDrag(braking, dt);

    // Displayed/audible rpm: quick to rise, gradual to fall, plus the
    // decaying downshift blip — keeps the satisfying engine-braking note
    // and stops the revs from collapsing when you brake.
    if (targetRpm >= this._baseRpm) {
      // Rise responsively toward the target
      this._baseRpm += (targetRpm - this._baseRpm) * Math.min(1, RPM_RISE_RATE * dt);
    } else {
      // Fall: exponential ease near the target, but never faster than the cap,
      // so hard braking from high revs still bleeds down gradually.
      const eased  = this._baseRpm + (targetRpm - this._baseRpm) * Math.min(1, RPM_FALL_RATE * dt);
      const capped = this._baseRpm - RPM_FALL_MAX * dt;
      this._baseRpm = Math.max(targetRpm, eased, capped);
    }
    this.revBlip *= Math.pow(BLIP_DECAY, dt * 60);
    if (this.revBlip < 1) this.revBlip = 0;
    this.rpm = Math.min(ENGINE_MAX_RPM, this._baseRpm + this.revBlip);
  }

  _applyBrakeAndDrag(braking, dt) {
    if (braking) {
      if (this.speed > 0)      this.speed = Math.max(0, this.speed - BRAKE_DECEL * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + BRAKE_DECEL * dt);
    }
    const drag = ROLLING_DRAG + AERO_DRAG * this.speed * this.speed;
    if (this.speed > 0)      this.speed = Math.max(0, this.speed - drag * dt);
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + drag * dt);

    this.speed = THREE.MathUtils.clamp(this.speed, -MAX_REVERSE_SPEED, 75);
  }

  // Automatic gearbox: choose direction near standstill and shift forward
  // gears by engine speed (with a cooldown to avoid hunting).
  _autoTransmission(input, dt) {
    if (this._autoCooldown > 0) this._autoCooldown -= dt;
    const v = this.speed;

    // Direction / engagement
    if (Math.abs(v) < 0.6) {
      if (input.forward) { if (this.gear < 1) this.gear = 1; }
      else if (input.backward) { if (this.gear >= 0) this.gear = -1; }
      else if (this.gear === 0) { this.gear = 1; }
    } else if (v >= 0.6 && this.gear < 1) {
      this.gear = 1;            // rolling forward must be in a drive gear
    } else if (v <= -0.6 && this.gear !== -1) {
      this.gear = -1;           // rolling backward -> reverse
    }

    // Up/down shifting among the forward gears
    if (this.gear >= 1 && this._autoCooldown <= 0) {
      const effRatio = GEAR_RATIOS[this.gear] * FINAL_DRIVE;
      const mechRpm = Math.abs(v) * effRatio * RPM_PER_MS;
      if (mechRpm > AUTO_UPSHIFT_RPM && this.gear < 6) {
        this.gear++;
        this._autoCooldown = AUTO_SHIFT_COOLDOWN;
      } else if (mechRpm < AUTO_DOWNSHIFT_RPM && this.gear > 1) {
        this.gear--;
        this.revBlip = Math.max(this.revBlip, DOWNSHIFT_BLIP); // blip on auto downshift
        this._autoCooldown = AUTO_SHIFT_COOLDOWN;
      }
    }
  }

  _updateSteering(input, dt) {
    // Ease the steering value toward the target instead of snapping to it.
    // Analog joystick (steerAxis) and keyboard (left/right) both feed the target.
    const target = THREE.MathUtils.clamp(
      (input.steerAxis || 0) + (input.left ? 1 : 0) - (input.right ? 1 : 0), -1, 1);
    const resp = (Math.abs(target) < 0.001) ? STEER_RETURN : STEER_RESPONSE;
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

    // Steer the front wheels visually with the smoothed steering
    const steerAngle = this.steerValue * 0.5;
    this.frontWheels.forEach(w => { w.rotation.y = steerAngle; });
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
  get transmissionLabel() { return this.autoTransmission ? 'AUTO' : 'MANUAL'; }
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
