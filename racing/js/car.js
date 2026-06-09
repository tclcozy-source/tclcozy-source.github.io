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

// The physics runs on a compact internal rev range; the tachometer shows a
// high-revving scale with the redline starting at ~80,000 rpm.
// (LIMITER_START_RPM 6500 internal -> ~80,000 displayed.)
const DISPLAY_RPM_SCALE = 12.31;

// ---- Rev dynamics (display/audio smoothing — does not affect physics) ----
const RPM_RISE_RATE  = 11;    // per second — quick rev pickup on throttle
const RPM_FALL_RATE  = 1.7;   // per second — exponential ease for the final approach
const RPM_FALL_MAX   = 1500;  // hard cap on rev-down speed (rpm/sec) so braking never plummets
const DOWNSHIFT_BLIP = 1200;  // rpm bump injected on downshift (rev-match)
const BLIP_DECAY     = 0.90;  // per-frame blip decay (~0.35s at 60fps)

// ---- Drivetrain ----
// gear index: -1 = reverse, 0 = neutral, 1..6 = forward gears
const FINAL_DRIVE = 3.0;
const GEAR_RATIOS = { '-1': 3.6, 1: 3.85, 2: 2.6, 3: 1.9, 4: 1.45, 5: 1.15, 6: 0.95 };
const RPM_PER_MS  = 39;    // engineRPM = |speed| * effRatio * RPM_PER_MS
const TORQUE_K    = 0.85;  // engine force scaling (accel feel)

// ---- Resistance ----
const BRAKE_DECEL       = 9.5;  // gentle, controllable braking (was an abrupt 26)
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
    this._reverseReady = false; // auto: reverse only after a deliberate re-press at a stop
    this.atLimiter = false;     // true while revs are pinned at the limiter

    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  _buildMesh() {
    // Detailed GT3 race car (Huracan-GT3 inspired). Forward = +Z (nose), rear = -Z.
    const group = new THREE.Group();

    const paintMat  = new THREE.MeshPhysicalMaterial({ color: 0x2fae54, metalness: 0.5, roughness: 0.28, clearcoat: 1.0, clearcoatRoughness: 0.08 });
    const carbonMat = new THREE.MeshPhysicalMaterial({ color: 0x14161a, metalness: 0.45, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.35 });
    const whiteMat  = new THREE.MeshPhysicalMaterial({ color: 0xf3f3f3, metalness: 0.2, roughness: 0.35, clearcoat: 0.7 });
    const glassMat  = new THREE.MeshPhysicalMaterial({ color: 0x0a0e14, metalness: 0.0, roughness: 0.05, transparent: true, opacity: 0.55, clearcoat: 1.0 });
    const tireMat   = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.85 });
    const rimMat    = new THREE.MeshStandardMaterial({ color: 0x35383d, metalness: 0.9, roughness: 0.25 });
    const discMat   = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.35 });
    const calMat    = new THREE.MeshStandardMaterial({ color: 0xd11414, roughness: 0.5 });
    const headMat   = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1cc, emissiveIntensity: 1.1, roughness: 0.3 });
    const tailMat   = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1500, emissiveIntensity: 1.0, roughness: 0.4 });
    const darkMat   = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.8 });

    const add = (geo, mat, x, y, z, rx = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      m.castShadow = cast;
      group.add(m);
      return m;
    };
    const mirror = (geo, mat, x, y, z, rx = 0) => { add(geo, mat, x, y, z, rx); add(geo, mat, -x, y, z, rx); };

    // Floor / undertray
    add(new THREE.BoxGeometry(1.9, 0.1, 4.3), carbonMat, 0, 0.16, 0, 0, false).receiveShadow = true;

    // Main body mass + sculpted clips
    add(new THREE.BoxGeometry(1.92, 0.46, 3.9), paintMat, 0, 0.47, 0);
    add(new THREE.BoxGeometry(1.74, 0.18, 1.5), paintMat, 0, 0.66, 1.4, -0.07);  // hood (raked)
    add(new THREE.BoxGeometry(1.82, 0.4,  0.4), paintMat, 0, 0.5, 2.02);          // nose fascia
    add(new THREE.BoxGeometry(1.86, 0.2,  1.5), paintMat, 0, 0.78, -1.35);        // rear deck
    add(new THREE.BoxGeometry(1.86, 0.5,  0.35),paintMat, 0, 0.52, -2.02);        // rear fascia

    // Cabin greenhouse
    add(new THREE.BoxGeometry(1.36, 0.1, 1.25), paintMat, 0, 1.12, -0.15);        // roof
    add(new THREE.BoxGeometry(1.4, 0.6, 0.06),  glassMat, 0, 0.92, 0.62, -0.55);  // windscreen
    add(new THREE.BoxGeometry(1.4, 0.5, 0.06),  glassMat, 0, 0.95, -0.78, 0.6);   // rear glass
    mirror(new THREE.BoxGeometry(0.06, 0.34, 1.25), glassMat, 0.69, 0.96, -0.12); // side windows
    mirror(new THREE.BoxGeometry(0.08, 0.52, 0.12), paintMat, 0.64, 0.9, 0.5, -0.5); // A-pillars

    // Aero: front splitter, dive planes, side skirts, diffuser
    add(new THREE.BoxGeometry(2.06, 0.05, 0.8), carbonMat, 0, 0.13, 2.32, 0, false);
    mirror(new THREE.BoxGeometry(0.32, 0.03, 0.26), carbonMat, 0.86, 0.34, 2.05, 0.12);
    mirror(new THREE.BoxGeometry(0.1, 0.14, 2.4), carbonMat, 0.96, 0.2, -0.1);
    add(new THREE.BoxGeometry(1.72, 0.24, 0.5), carbonMat, 0, 0.2, -2.05, 0.25, false);
    mirror(new THREE.BoxGeometry(0.04, 0.22, 0.5), carbonMat, 0.4, 0.22, -2.05, 0.25); // diffuser fins

    // Big GT3 rear wing (swan-neck mounts + plane + gurney + endplates)
    mirror(new THREE.BoxGeometry(0.07, 0.46, 0.12), carbonMat, 0.5, 1.2, -2.0);
    add(new THREE.BoxGeometry(1.84, 0.07, 0.48), carbonMat, 0, 1.46, -2.06);
    add(new THREE.BoxGeometry(1.84, 0.05, 0.04), carbonMat, 0, 1.5, -2.28, 0, false); // gurney flap
    mirror(new THREE.BoxGeometry(0.04, 0.36, 0.62), paintMat, 0.9, 1.4, -2.06);

    // Mirrors, lights, vents
    mirror(new THREE.BoxGeometry(0.16, 0.1, 0.07), carbonMat, 0.86, 0.99, 0.5);
    mirror(new THREE.BoxGeometry(0.36, 0.12, 0.06), headMat, 0.58, 0.6, 2.2);       // headlights
    mirror(new THREE.BoxGeometry(0.5, 0.1, 0.05), tailMat, 0.5, 0.64, -2.19);       // taillights
    add(new THREE.BoxGeometry(0.12, 0.1, 0.05), tailMat, 0, 0.5, -2.19, 0, false);  // rain light
    mirror(new THREE.BoxGeometry(0.5, 0.02, 0.32), darkMat, 0.42, 0.73, 1.45);      // hood vents

    // Wheel arches (haunches over each wheel)
    [[0.9, 1.45], [-0.9, 1.45], [0.94, -1.5], [-0.94, -1.5]].forEach(([x, z]) =>
      add(new THREE.BoxGeometry(0.34, 0.16, 0.95), paintMat, x, 0.66, z));

    // Livery: race number roundels on the doors
    const liveryTex = this._makeLiveryTexture('63');
    const decalMat = new THREE.MeshStandardMaterial({ map: liveryTex, transparent: true, roughness: 0.4 });
    [1, -1].forEach((s) => {
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), decalMat);
      decal.position.set(s * 0.985, 0.55, 0.12);
      decal.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
      group.add(decal);
    });

    // Detailed wheels (tire + multi-spoke rim + brake disc + caliper)
    const makeWheel = (r, w) => {
      const wheel = new THREE.Group();      // steers (front)
      const spinner = new THREE.Group();    // spins (roll)
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 30), tireMat);
      tire.rotation.z = Math.PI / 2; tire.castShadow = true; spinner.add(tire);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w * 0.9, 28), rimMat);
      rim.rotation.z = Math.PI / 2; spinner.add(rim);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.56, r * 0.56, w * 0.32, 24), discMat);
      disc.rotation.z = Math.PI / 2; spinner.add(disc);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, w + 0.02, 12), rimMat);
      hub.rotation.z = Math.PI / 2; spinner.add(hub);
      for (let i = 0; i < 5; i++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, r * 1.15, 0.06), rimMat);
        spoke.position.x = w * 0.36;
        spoke.rotation.x = (i / 5) * Math.PI * 2;
        spinner.add(spoke);
      }
      wheel.add(spinner);
      const caliper = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.15, 0.09), calMat);
      caliper.position.set(0, r * 0.55, 0);
      wheel.add(caliper);
      return { wheel, spinner };
    };

    this.wheelMeshes = [];   // spinners (roll)
    this.frontWheels = [];   // outer groups (steer)
    [
      { x: 0.9,  z: 1.45, r: 0.35, w: 0.32, front: true  },
      { x: -0.9, z: 1.45, r: 0.35, w: 0.32, front: true  },
      { x: 0.94, z: -1.5, r: 0.37, w: 0.42, front: false },
      { x: -0.94,z: -1.5, r: 0.37, w: 0.42, front: false },
    ].forEach(({ x, z, r, w, front }) => {
      const { wheel, spinner } = makeWheel(r, w);
      wheel.position.set(x, r, z);
      group.add(wheel);
      this.wheelMeshes.push(spinner);
      if (front) this.frontWheels.push(wheel);
    });

    return group;
  }

  // Canvas texture: a white roundel with a race number for the door livery.
  _makeLiveryTexture(number) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 256);
    ctx.beginPath();
    ctx.arc(128, 128, 92, 0, Math.PI * 2);
    ctx.fillStyle = '#f5f5f5';
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#14161a';
    ctx.stroke();
    ctx.fillStyle = '#14161a';
    ctx.font = 'bold 130px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), 128, 138);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
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
    this.atLimiter = false;

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
        else if (dir > 0) this.atLimiter = true; // revs pinned at the limiter
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

  // Automatic gearbox. Braking only downshifts through the forward gears and
  // comes to a stop — it NEVER rolls into reverse on its own. Reverse engages
  // only as a deliberate action: stop, release back, then press back again.
  _autoTransmission(input, dt) {
    if (this._autoCooldown > 0) this._autoCooldown -= dt;
    const v = this.speed;
    const stopped = Math.abs(v) < 0.5;

    // "Arm" reverse only once the car is stopped AND the back/brake input has
    // been released. This makes engaging reverse a fresh, deliberate press
    // rather than a continuation of braking to a halt.
    if (!stopped) this._reverseReady = false;
    else if (!input.backward) this._reverseReady = true;

    if (this.gear === -1) {
      // In reverse: pressing forward brakes and then returns to drive
      if (input.forward && v > -0.5) this.gear = 1;
      return;
    }

    // Forward gears
    if (!stopped && v >= 0.5 && this.gear < 1) {
      this.gear = 1;                       // rolling forward must be in a drive gear
    } else if (stopped) {
      if (input.backward && this._reverseReady) {
        this.gear = -1;                    // deliberate reverse from a standstill
        this._reverseReady = false;
        return;
      }
      this.gear = 1;                       // otherwise sit in 1st, ready to pull away
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
        this.revBlip = Math.max(this.revBlip, DOWNSHIFT_BLIP); // rev-match blip on downshift
        this._autoCooldown = AUTO_SHIFT_COOLDOWN;
      }
    }
  }

  _updateSteering(input, dt) {
    // Ease the steering value toward the target instead of snapping to it.
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

    // Steer the front wheels visually with the smoothed steering
    const steerAngle = this.steerValue * 0.5;
    this.frontWheels.forEach(w => { w.rotation.y = steerAngle; });
  }

  get position()  { return this.mesh.position; }
  get kmh()       { return Math.abs(this.speed) * 3.6; }
  get rpmRaw()    { return this.rpm; }                            // internal sim rpm (audio)
  get displayRpm(){ return Math.round(this.rpm * DISPLAY_RPM_SCALE); } // F1-scale rpm (HUD)
  get maxRpm()    { return ENGINE_MAX_RPM * DISPLAY_RPM_SCALE; }   // tach ceiling (~20,000)
  get redline()   { return LIMITER_START_RPM * DISPLAY_RPM_SCALE; }// limiter line (~16,250)
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
