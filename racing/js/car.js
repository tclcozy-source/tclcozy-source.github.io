import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---- Steering ----
const MAX_YAW_RATE    = 2.2;    // rad/s at full lock, low speed
const STEER_SPEED_REF = 0.04;   // higher -> steering tightens less at speed
const STEER_RESPONSE  = 6.0;    // how fast steering eases toward target (per s)
const STEER_RETURN    = 9.0;    // quicker self-centering when no input
const BODY_ROLL_MAX   = 0.03;   // subtle visual lean

// ---- First-person cockpit ----
const DRIVER_X     = -0.45;  // left-hand drive seat (negative X = driver's left)
const DRIVER_EYE_Y = 1.06;   // eye height — raised to see over the wheel & dash
const DRIVER_EYE_Z = -0.30;  // pulled back so the road is clearly visible
const WHEEL_TURN   = 1.9;    // max steering-wheel rotation (rad) at full lock

// ---- Drift mode (toggled with B) ----
const DRIFT_YAW_GAIN  = 2.4;  // huge steering authority — the rear kicks out on the lightest input
const REAR_GRIP_DRIFT = 0.5;  // very low: the rear stays loose and the slide holds
const SELF_ALIGN      = 0.6;  // restoring yaw within the grip window (counter-steer / recovery)
const GRIP_SLIP_PEAK  = 0.9;  // rad (~50 deg): rear grip is full up to here, then breaks away
const GRIP_FADE       = 0.7;  // how fast grip falls off past the peak (no cap -> can spin out)
const GRIP_MIN        = 0.08; // residual rear grip once fully broken loose
const DRIFT_REF_SPEED = 16;   // speed at which self-align reaches full strength
const SLIDE_SCRUB     = 0.03; // gentle — a drift keeps most of its speed
const SLIDE_THRESH    = 0.10; // slip angle (rad) above which tyres smoke / mark
const SLIDE_MIN_SPEED = 6;    // m/s below which we never count it as a slide

// ---- Engine ----
const ENGINE_IDLE_RPM   = 900;
const ENGINE_REDLINE    = 7200;
const ENGINE_MAX_RPM    = 8000;  // tachometer ceiling
const PEAK_TORQUE_RPM   = 4600;
const LIMITER_START_RPM = 6500;  // power begins falling off above this
const CRANK_TIME        = 1.1;   // seconds of cranking before idle

// The physics runs on a compact internal rev range; the tachometer maps it to a
// realistic V12 scale: 600 rpm idle -> 6500 rpm redline.
const DISPLAY_IDLE_RPM    = 600;
const DISPLAY_REDLINE_RPM = 6500;

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
const AUTO_UPSHIFT_RPM   = 6400; // rev out near the limiter, but reachable in every gear
                                 // (5th tops out ~6780 rpm under drag, so it can still hit 6th)
const AUTO_DOWNSHIFT_RPM = 1850; // only drop a gear once revs fall well off — no eager downshifts
const AUTO_SHIFT_COOLDOWN = 0.7; // seconds between auto shifts (relaxed, anti-hunting)

// ---- Track surface / pit lane ----
const PIT_LIMIT     = 16;    // m/s (~58 km/h) pit-lane speed limit
const PIT_BRAKE     = 30;    // firm auto-brake that enforces the pit limit
const PIT_STOP_TIME = 3.5;   // seconds of service once stopped in the box

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

    // Drift state
    this.driftMode = false;     // toggled with B
    this.travelDir = 0;         // direction the car is actually moving (vs heading)
    this.slip      = 0;         // slip angle = heading - travelDir (rad)
    this.isSliding = false;     // true while the rear is breaking traction

    // Track surface + pit state
    this.track       = null;    // set by main; provides sampleSurface / heightAt
    this.surface     = 'asphalt';
    this.surfaceGrip = 1;       // 0..1 grip multiplier (grass / gravel reduce it)
    this.surfaceDrag = 0;       // extra deceleration off-track
    this.inPitLane   = false;
    this.inPitBox    = false;
    this.pitState    = 'none';  // 'none' | 'servicing' | 'done'
    this.pitTimer    = 0;
    this._groundY    = 0;

    // Driver-head offset in the car's local frame (read by the cockpit camera)
    this.driverHead = new THREE.Vector3(DRIVER_X, DRIVER_EYE_Y, DRIVER_EYE_Z);

    this.mesh = this._buildMesh();
    scene.add(this.mesh);
  }

  _buildMesh() {
    // Detailed GT3 race car (Huracan-GT3 inspired). Forward = +Z (nose), rear = -Z.
    const ext = new THREE.Group();   // exterior (shown in third person)

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
      ext.add(m);
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
      ext.add(decal);
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
      ext.add(wheel);
      this.wheelMeshes.push(spinner);
      if (front) this.frontWheels.push(wheel);
    });

    // Assemble root: exterior + (hidden) first-person cockpit interior
    this.exterior = ext;
    this.cockpit  = this._buildCockpit();
    this.cockpit.visible = false;          // shown only in first-person view

    const root = new THREE.Group();
    root.add(ext);
    root.add(this.cockpit);
    return root;
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

  // ---- First-person cockpit interior (real 3D geometry) ----
  _buildCockpit() {
    const g = new THREE.Group();
    const X = DRIVER_X;

    const dashMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.86, metalness: 0.1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x0d0e12, roughness: 0.7,  metalness: 0.2 });
    const accMat  = new THREE.MeshStandardMaterial({ color: 0x222530, roughness: 0.5,  metalness: 0.5 });
    const rimMat  = new THREE.MeshPhysicalMaterial({ color: 0x101114, roughness: 0.5, metalness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.4 });
    const ventMat = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.95 });
    const markMat = new THREE.MeshStandardMaterial({ color: 0xc9a832, roughness: 0.5 });

    // Dashboard: rolled top edge, sloped face, centre console, binnacle hood
    const dashTop = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.92, 20), dashMat);
    dashTop.rotation.z = Math.PI / 2;
    dashTop.position.set(0, 0.74, 0.52);
    dashTop.receiveShadow = true;
    g.add(dashTop);

    const dashFace = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.4, 0.12), dashMat);
    dashFace.position.set(0, 0.52, 0.5);
    dashFace.rotation.x = 0.3;
    dashFace.receiveShadow = true;
    g.add(dashFace);

    const centreConsole = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.46, 0.85), dashMat);
    centreConsole.position.set(0.16, 0.4, 0.05);
    g.add(centreConsole);

    // Digital display on the dash (3D textured surface, faces the driver)
    this.dashTexture = this._makeDashTexture();
    const screenGroup = new THREE.Group();
    screenGroup.position.set(X, 0.93, 0.48);
    screenGroup.rotation.x = 0.34;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.15, 0.02), trimMat);
    bezel.position.z = 0.02;         // behind the screen (away from the driver)
    screenGroup.add(bezel);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.29, 0.115),
      new THREE.MeshBasicMaterial({ map: this.dashTexture, side: THREE.DoubleSide }),
    );
    screen.rotation.y = Math.PI;     // face the driver, text reads correctly
    screen.position.z = 0.0;
    screenGroup.add(screen);
    g.add(screenGroup);

    // Centre air vents (recessed, with louvers)
    for (let i = 0; i < 2; i++) {
      const vx = 0.05 + i * 0.27;
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.05), ventMat);
      vent.position.set(vx, 0.7, 0.5);
      g.add(vent);
      for (let j = 0; j < 3; j++) {
        const lou = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.006, 0.06), accMat);
        lou.position.set(vx, 0.68 + j * 0.024, 0.51);
        g.add(lou);
      }
    }

    // Steering column + wheel (rotates with steering, parallaxes with the camera)
    const pivot = new THREE.Group();
    pivot.position.set(X, 0.7, 0.32);
    pivot.rotation.x = 0.5;          // column rake: reclines the wheel ~28°, top away from driver
    g.add(pivot);

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.24, 12), trimMat);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -0.14;
    pivot.add(shaft);

    const wheel = new THREE.Group();
    pivot.add(wheel);
    this.steeringWheel = wheel;

    // Downloaded racing-wheel model (Poly Pizza, CC-BY 3.0). Loaded async and
    // dropped in over a simple fallback rim. The model is round and lies flat
    // in its own XZ plane, so we stand it upright (axis Y -> the wheel group's
    // local Z) and scale it to ~0.34 m, so it spins about the column when
    // wheel.rotation.z changes with steering.
    const R = 0.16;
    const fallback = new THREE.Mesh(new THREE.TorusGeometry(R, 0.019, 12, 32), rimMat);
    fallback.castShadow = true;
    wheel.add(fallback);

    new GLTFLoader().load(
      'models/steering_wheel.glb',
      (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(0.00099);   // ~344 model units -> ~0.34 m diameter
        model.rotation.x = -Math.PI / 2;  // lay-flat wheel -> upright; pivot rake reclines it toward the driver
        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.material = (o.material && o.material.name === 'default') ? accMat : rimMat;
          }
        });
        wheel.remove(fallback);
        wheel.add(model);
        this._wheelModel = model;
      },
      undefined,
      (err) => console.warn('[cockpit] steering-wheel model failed to load:', err),
    );

    // Small upright marker on the rim so the wheel's rotation reads clearly
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.012), markMat);
    mark.position.set(0, R - 0.005, 0.025);
    wheel.add(mark);

    // Interior frame: windscreen header, headliner, A-pillars, door sills
    const header = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.14), trimMat);
    header.position.set(0, 1.16, 0.58);
    g.add(header);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 1.4), trimMat);
    roof.position.set(0, 1.24, -0.12);
    g.add(roof);

    [-1, 1].forEach((s) => {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.72, 0.1), trimMat);
      pillar.position.set(s * 0.66, 0.96, 0.54);
      pillar.rotation.x = -0.5;
      pillar.rotation.z = s * 0.12;
      g.add(pillar);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 1.2), trimMat);
      sill.position.set(s * 0.68, 0.74, -0.1);
      g.add(sill);
    });

    return g;
  }

  // Canvas-backed texture for the 3D dash display.
  _makeDashTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    this._dashCanvas = c;
    this._dashCtx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    this._drawDash(0, 'N', 0, 0, false);
    tex.needsUpdate = true;
    return tex;
  }

  _drawDash(speed, gear, rpm, frac, redline) {
    const ctx = this._dashCtx, W = 256, H = 96;
    ctx.fillStyle = '#05090b'; ctx.fillRect(0, 0, W, H);
    // shift-light bar across the top
    const n = 14, cw = (W - 16) / n;
    const lit = frac <= 0.5 ? 0 : Math.ceil(((frac - 0.5) / 0.5) * n);
    for (let i = 0; i < n; i++) {
      let col = '#0b1a14';
      if (i < lit) {
        if (redline) col = '#39c6ff';
        else if (i < n * 0.5) col = '#27c060';
        else if (i < n * 0.8) col = '#d8ad1e';
        else col = '#e02828';
      }
      ctx.fillStyle = col;
      ctx.fillRect(8 + i * cw, 6, cw - 2, 9);
    }
    // gear (big, centre)
    ctx.fillStyle = redline ? '#ff6b6b' : '#e6fbef';
    ctx.font = 'bold 50px Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(gear), W / 2, H / 2 + 14);
    // speed (left)
    ctx.fillStyle = '#79c79a';
    ctx.textAlign = 'left';
    ctx.font = 'bold 26px Consolas, monospace';
    ctx.fillText(String(speed), 10, H / 2 + 12);
    ctx.fillStyle = 'rgba(120,200,160,0.55)';
    ctx.font = '11px Consolas, monospace';
    ctx.fillText('KM/H', 10, H - 8);
    // rpm (right)
    ctx.fillStyle = '#79c79a';
    ctx.textAlign = 'right';
    ctx.font = 'bold 22px Consolas, monospace';
    ctx.fillText(String(rpm), W - 10, H / 2 + 10);
    ctx.fillStyle = 'rgba(120,200,160,0.55)';
    ctx.font = '11px Consolas, monospace';
    ctx.fillText('RPM', W - 10, H - 8);
  }

  // Refresh the dash display (called each frame while in cockpit view).
  updateDashDisplay() {
    if (!this.dashTexture) return;
    const frac = Math.min(this.displayRpm / this.maxRpm, 1);
    const redline = this.displayRpm >= this.redline;
    this._drawDash(Math.round(this.kmh), this.gearLabel, this.displayRpm, frac, redline);
    this.dashTexture.needsUpdate = true;
  }

  // Toggle between the third-person exterior and the first-person cockpit.
  setCockpitView(on) {
    if (this.cockpit)  this.cockpit.visible = on;
    if (this.exterior) this.exterior.visible = !on;
  }

  // Place the car at a track position facing a heading (radians).
  placeAt(x, z, heading) {
    const y = this.track ? this.track.heightAt(x, z) : 0;
    this.mesh.position.set(x, y, z);
    this.heading = heading;
    this.travelDir = heading;
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
    this._sampleSurface();
    this._handleIgnition(input);
    this._handleShift(input);
    this._updateEngine(input, dt);
    this._updateSteering(input, dt);
    this._integrate(dt);
    this._updateVisuals(dt);
    this._updatePit(input, dt);
  }

  // Query the track surface under the car: grip, drag, elevation, pit flags.
  _sampleSurface() {
    if (!this.track) return;
    const s = this.track.sampleSurface(this.mesh.position.x, this.mesh.position.z);
    this.surface     = s.surface;
    this.surfaceGrip = s.grip;
    this.surfaceDrag = s.drag;
    this.inPitLane   = s.inPitLane;
    this.inPitBox    = s.inPitBox;
    this._groundY    = s.height;
  }

  // Pit-stop state machine: stop in the box -> a few seconds of service -> GO.
  _updatePit(input, dt) {
    if (this.pitState === 'none') {
      if (this.inPitBox && Math.abs(this.speed) < 0.6 && this.isRunning) {
        this.pitState = 'servicing';
        this.pitTimer = PIT_STOP_TIME;
      }
    } else if (this.pitState === 'servicing') {
      this.speed = 0;                       // held while serviced
      this.pitTimer -= dt;
      if (this.pitTimer <= 0) this.pitState = 'done';
    } else if (this.pitState === 'done') {
      if (!this.inPitBox) this.pitState = 'none';   // pulled away -> ready to pit again
    }
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

    this.speed += engineAccel * this.surfaceGrip * dt;   // less drive off-track
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
    const drag = ROLLING_DRAG + AERO_DRAG * this.speed * this.speed + this.surfaceDrag;
    if (this.speed > 0)      this.speed = Math.max(0, this.speed - drag * dt);
    else if (this.speed < 0) this.speed = Math.min(0, this.speed + drag * dt);

    // Pit-lane speed limiter (auto-brake), released while being serviced
    if (this.inPitLane && this.pitState !== 'servicing') {
      if (this.speed >  PIT_LIMIT) this.speed = Math.max( PIT_LIMIT, this.speed - PIT_BRAKE * dt);
      if (this.speed < -PIT_LIMIT) this.speed = Math.min(-PIT_LIMIT, this.speed + PIT_BRAKE * dt);
    }

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
  }

  _integrate(dt) {
    const absV = Math.abs(this.speed);

    if (absV > 0.4) {
      const speedFactor = 1 / (1 + absV * STEER_SPEED_REF); // calmer steering at speed
      const dir = Math.sign(this.speed);
      const yawRate = this.steerValue * MAX_YAW_RATE * speedFactor * dir * this.surfaceGrip;

      if (this.driftMode) {
        // Loose rear: steering kicks the back out and the slide HOLDS. Rear grip
        // is full up to a peak slip angle then FADES away, so past the limit
        // nothing arrests the rotation — the rear keeps sliding and the car can
        // spin right out if you push too far. No hard cap on the slip angle.
        this.heading += yawRate * DRIFT_YAW_GAIN * dt;
        const slip = wrapPi(this.heading - this.travelDir);
        const grip = Math.max(GRIP_MIN, 1 - Math.max(0, Math.abs(slip) - GRIP_SLIP_PEAK) * GRIP_FADE);
        // Both rear-tyre restoring terms scale with grip, so once the tyres let
        // go they can no longer pull the car straight.
        this.travelDir += slip * REAR_GRIP_DRIFT * grip * dt;
        this.heading   -= slip * SELF_ALIGN * grip * Math.min(1, absV / DRIFT_REF_SPEED) * dt;
        this.slip = wrapPi(this.heading - this.travelDir);
        this.speed -= Math.abs(this.slip) * SLIDE_SCRUB * absV * dt;  // gentle scrub
        this.isSliding = Math.abs(this.slip) > SLIDE_THRESH && absV > SLIDE_MIN_SPEED;
      } else {
        // Full grip: the car goes exactly where it points.
        this.heading += yawRate * dt;
        this.travelDir = this.heading;
        this.slip = 0;
        this.isSliding = false;
      }
    } else {
      this.travelDir = this.heading;
      this.slip = 0;
      this.isSliding = false;
    }

    // Move along the direction of travel (which differs from heading in a slide)
    this.mesh.position.x += Math.sin(this.travelDir) * this.speed * dt;
    this.mesh.position.z += Math.cos(this.travelDir) * this.speed * dt;
    // Follow the track-surface elevation
    if (this.track) {
      const gy = this.track.heightAt(this.mesh.position.x, this.mesh.position.z);
      this.mesh.position.y += (gy - this.mesh.position.y) * 0.5;
    } else {
      this.mesh.position.y = 0;
    }
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

    // Turn the 3D cockpit steering wheel (left input -> anticlockwise)
    if (this.steeringWheel) this.steeringWheel.rotation.z = -this.steerValue * WHEEL_TURN;
  }

  get position()  { return this.mesh.position; }
  get kmh()       { return Math.abs(this.speed) * 3.6; }
  get rpmRaw()    { return this.rpm; }   // internal sim rpm (drives audio)
  get displayRpm(){                      // realistic 600 idle -> 6500 redline (HUD)
    const rev = Math.max(0, (this.rpm - ENGINE_IDLE_RPM) / (ENGINE_REDLINE - ENGINE_IDLE_RPM));
    return Math.min(7000, Math.round(DISPLAY_IDLE_RPM + rev * (DISPLAY_REDLINE_RPM - DISPLAY_IDLE_RPM)));
  }
  get maxRpm()    { return 7000; }       // tach ceiling
  get redline()   { return 6000; }       // redzone start (near the 6500 limit)
  get gearLabel() {
    if (this.gear === -1) return 'R';
    if (this.gear === 0)  return 'N';
    return String(this.gear);
  }
  get transmissionLabel() { return this.autoTransmission ? 'AUTO' : 'MANUAL'; }
  get pitStatus() {
    if (this.pitState === 'servicing') return { active: true, text: 'PIT STOP — ' + Math.ceil(this.pitTimer) + 's', kind: 'busy' };
    if (this.pitState === 'done')      return { active: true, text: 'GO!', kind: 'go' };
    if (this.inPitLane)                return { active: true, text: 'PIT LANE — LIMITER', kind: 'limit' };
    return { active: false, text: '', kind: '' };
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

// Wrap an angle to [-PI, PI].
function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

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
