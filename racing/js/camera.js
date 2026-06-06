import * as THREE from 'three';

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

  update(car) {
    const heading = car.mesh.rotation.y;

    // Ideal camera position: behind and above the car
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
