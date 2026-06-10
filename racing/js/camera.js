import * as THREE from 'three';

// ---- Third-person chase camera ----
const CHASE_DISTANCE = 9;
const CHASE_HEIGHT   = 3.5;
const LERP_POS       = 0.08;  // position smoothing
const LERP_LOOK      = 0.12;  // look-at smoothing

export class ChaseCamera {
  constructor(camera) {
    this.camera   = camera;
    this._lookAt  = new THREE.Vector3();
    this._pos     = new THREE.Vector3();
    this._init    = false;
  }

  reset() { this._init = false; }

  update(car) {
    const heading = car.mesh.rotation.y;

    const idealX = car.position.x - Math.sin(heading) * CHASE_DISTANCE;
    const idealY = car.position.y + CHASE_HEIGHT;
    const idealZ = car.position.z - Math.cos(heading) * CHASE_DISTANCE;

    if (!this._init) {
      this._pos.set(idealX, idealY, idealZ);
      this._lookAt.copy(car.position);
      this._init = true;
    }

    this._pos.lerp(new THREE.Vector3(idealX, idealY, idealZ), LERP_POS);
    this._lookAt.lerp(car.position, LERP_LOOK);

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._lookAt);
  }
}

// ---- First-person cockpit camera ----
// Driver's seat: slightly left of centre (LHD), at eye height, looking forward
// over the dash. Local frame: +Z forward, +X is the car's left.
// The seat offset comes from car.driverHead, kept in sync with the 3D cockpit.
const STEER_LOOK = 0.10;  // subtle view yaw with steering (rad at full lock)
const LOOK_DIST  = 12;
const LOOK_DOWN  = 0.08;  // look slightly down over the dash
const FALLBACK_SEAT = { x: -0.40, y: 0.96, z: -0.05 };

export class CockpitCamera {
  constructor(camera) {
    this.camera = camera;
    this._look  = new THREE.Vector3();
    this._yaw   = 0;
    this._init  = false;
  }

  reset() { this._init = false; }

  update(car) {
    const h = car.heading;

    // Driver-seat world position (rotate the local seat offset by the heading)
    const s = car.driverHead || FALLBACK_SEAT;
    const px = car.position.x + Math.cos(h) * s.x + Math.sin(h) * s.z;
    const py = car.position.y + s.y;
    const pz = car.position.z - Math.sin(h) * s.x + Math.cos(h) * s.z;
    this.camera.position.set(px, py, pz);

    // Smoothly yaw the view a little with steering for a natural feel
    const targetYaw = car.steerValue * STEER_LOOK;
    if (!this._init) { this._yaw = targetYaw; this._init = true; }
    this._yaw += (targetYaw - this._yaw) * 0.2;

    const lookH = h + this._yaw;
    this._look.set(
      px + Math.sin(lookH) * LOOK_DIST,
      py - LOOK_DOWN * LOOK_DIST,
      pz + Math.cos(lookH) * LOOK_DIST,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
  }
}
