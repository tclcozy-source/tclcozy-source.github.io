import * as THREE from 'three';

// Rear-wheel contact points in the car's local frame (matches car.js wheels).
const REAR = [{ x: 0.94, z: -1.5 }, { x: -0.94, z: -1.5 }];

const SMOKE_MAX = 180;   // tyre-smoke particle pool
const SKID_MAX  = 800;   // skid-mark instance pool
const SKID_W    = 0.26;  // skid quad width / length (m)
const SKID_L    = 0.44;
const SKID_STEP = 0.16;  // lay a new mark every this many metres of travel

// Tyre smoke + skid marks for drift mode. Pure CPU-driven pools so there is no
// per-frame allocation; both render in a single draw call.
export class DriftEffects {
  constructor(scene) {
    this._buildSmoke(scene);
    this._buildSkids(scene);
    this._skidIdx  = 0;
    this._skidDist = [0, 0];
    this._lastPos  = [null, null];
    this._cursor   = 0;
  }

  // ---- Tyre smoke (GPU points with a soft radial falloff) ----
  _buildSmoke(scene) {
    const N = SMOKE_MAX;
    this.sN     = N;
    this.sPos   = new Float32Array(N * 3);
    this.sVel   = new Float32Array(N * 3);
    this.sSize  = new Float32Array(N);
    this.sAlpha = new Float32Array(N);
    this.sLife  = new Float32Array(N);
    this.sMax   = new Float32Array(N);
    for (let i = 0; i < N; i++) this.sPos[i * 3 + 1] = -999; // parked offscreen

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3));
    geo.setAttribute('aSize',  new THREE.BufferAttribute(this.sSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.sAlpha, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (320.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          float a = smoothstep(0.5, 0.12, d) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.82, 0.83, 0.86, a);
        }`,
    });

    this.smoke = new THREE.Points(geo, mat);
    this.smoke.frustumCulled = false;
    this.smokeGeo = geo;
    scene.add(this.smoke);
  }

  // ---- Skid marks (instanced flat quads laid on the track) ----
  _buildSkids(scene) {
    const geo = new THREE.PlaneGeometry(SKID_W, SKID_L);
    geo.rotateX(-Math.PI / 2);            // lie flat on the ground (length along Z)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x080808, transparent: true, opacity: 0.6, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.skids = new THREE.InstancedMesh(geo, mat, SKID_MAX);
    this.skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SKID_MAX; i++) this.skids.setMatrixAt(i, hidden);
    this.skids.instanceMatrix.needsUpdate = true;
    this.skids.frustumCulled = false;
    scene.add(this.skids);

    this._m  = new THREE.Matrix4();
    this._q  = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._p  = new THREE.Vector3();
    this._sc = new THREE.Vector3(1, 1, 1);
  }

  _spawnSmoke(x, y, z, intensity) {
    const count = 1;
    for (let c = 0; c < count; c++) {
      let i = -1;
      for (let k = 0; k < this.sN; k++) {
        this._cursor = (this._cursor + 1) % this.sN;
        if (this.sLife[this._cursor] <= 0) { i = this._cursor; break; }
      }
      if (i < 0) return;
      this.sPos[i * 3]     = x + (Math.random() - 0.5) * 0.25;
      this.sPos[i * 3 + 1] = y + Math.random() * 0.1;
      this.sPos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.25;
      this.sVel[i * 3]     = (Math.random() - 0.5) * 1.0;
      this.sVel[i * 3 + 1] = 0.75 + Math.random() * 0.9; // rise so the plume reads
      this.sVel[i * 3 + 2] = (Math.random() - 0.5) * 1.0;
      this.sMax[i]   = 0.5 + Math.random() * 0.4;
      this.sLife[i]  = this.sMax[i];
      this.sSize[i]  = 10 + Math.random() * 7;
      this.sAlpha[i] = 0;
    }
  }

  _spawnSkid(x, z, dirAngle) {
    const i = this._skidIdx;
    this._skidIdx = (this._skidIdx + 1) % SKID_MAX;
    this._q.setFromAxisAngle(this._up, dirAngle);
    this._p.set(x, 0.015, z);
    this._m.compose(this._p, this._q, this._sc);
    this.skids.setMatrixAt(i, this._m);
    this.skids.instanceMatrix.needsUpdate = true;
  }

  update(car, dt) {
    if (car.isSliding) {
      const h = car.heading, sin = Math.sin(h), cos = Math.cos(h);
      const intensity = Math.min(1, (Math.abs(car.slip) - SLIDE_THRESH_REF) / 0.5);
      for (let w = 0; w < 2; w++) {
        const lx = REAR[w].x, lz = REAR[w].z;
        const wx = car.position.x + cos * lx + sin * lz;
        const wz = car.position.z - sin * lx + cos * lz;
        this._spawnSmoke(wx, 0.22, wz, intensity);

        const last = this._lastPos[w];
        if (last) {
          this._skidDist[w] += Math.hypot(wx - last.x, wz - last.z);
          if (this._skidDist[w] > SKID_STEP) {
            this._spawnSkid(wx, wz, car.travelDir);
            this._skidDist[w] = 0;
          }
        } else {
          this._spawnSkid(wx, wz, car.travelDir);
        }
        this._lastPos[w] = { x: wx, z: wz };
      }
    } else {
      this._lastPos[0] = this._lastPos[1] = null;
    }
    this._updateSmoke(dt);
  }

  _updateSmoke(dt) {
    for (let i = 0; i < this.sN; i++) {
      if (this.sLife[i] <= 0) continue;
      this.sLife[i] -= dt;
      if (this.sLife[i] <= 0) { this.sAlpha[i] = 0; this.sPos[i * 3 + 1] = -999; continue; }
      const t = this.sLife[i] / this.sMax[i];      // 1 -> 0
      this.sPos[i * 3]     += this.sVel[i * 3]     * dt;
      this.sPos[i * 3 + 1] += this.sVel[i * 3 + 1] * dt;
      this.sPos[i * 3 + 2] += this.sVel[i * 3 + 2] * dt;
      this.sVel[i * 3]     *= (1 - 1.6 * dt);
      this.sVel[i * 3 + 1] *= (1 - 0.6 * dt);
      this.sVel[i * 3 + 2] *= (1 - 1.6 * dt);
      this.sSize[i] += 13 * dt;                     // billow out
      const age = 1 - t;                            // 0 -> 1
      this.sAlpha[i] = Math.sin(Math.min(1, age) * Math.PI) * 0.22; // fade in then out
    }
    this.smokeGeo.attributes.position.needsUpdate = true;
    this.smokeGeo.attributes.aSize.needsUpdate = true;
    this.smokeGeo.attributes.aAlpha.needsUpdate = true;
  }
}

const SLIDE_THRESH_REF = 0.12;
