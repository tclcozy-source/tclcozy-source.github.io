import * as THREE from 'three';

// Closed-circuit race track built from a smooth spline.
// Returns { curve, start, startHeading, halfWidth, isNear }.

const HALF_WIDTH = 9;      // road is 18 units wide — comfortable for racing
const EDGE_LINE  = 0.5;    // white edge line thickness
const SEG        = 600;    // ribbon resolution around the loop
const UP         = new THREE.Vector3(0, 1, 0);

export function buildTrack(scene) {
  // --- Control points: a star-convex closed loop (no self-intersections),
  //     with varying radius to create straights, sweepers and tight corners.
  const a = 235, b = 155; // base ellipse half-extents (x, z)
  const factors = [1.00, 0.96, 1.15, 1.04, 0.80, 1.02, 1.00, 0.86, 1.16, 1.05, 0.78, 0.97];
  const N = factors.length;
  const ctrl = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * Math.PI * 2;
    const r = factors[i];
    ctrl.push(new THREE.Vector3(Math.cos(theta) * a * r, 0, Math.sin(theta) * b * r));
  }
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'catmullrom', 0.5);

  // --- Sample the curve evenly and build per-sample frames.
  const raw = curve.getSpacedPoints(SEG); // length SEG+1, last === first
  const center = [], tangent = [], normal = [];
  for (let i = 0; i < SEG; i++) {
    const p  = raw[i];
    const pn = raw[(i + 1) % SEG];
    const pp = raw[(i - 1 + SEG) % SEG];
    const t  = new THREE.Vector3().subVectors(pn, pp).normalize();
    const n  = new THREE.Vector3().crossVectors(t, UP).normalize(); // horizontal perpendicular
    center.push(p); tangent.push(t); normal.push(n);
  }
  // Close the loop so the last ring equals the first
  center.push(center[0]); tangent.push(tangent[0]); normal.push(normal[0]);

  // --- Road surface ribbon
  const roadL = [], roadR = [];
  for (let i = 0; i < center.length; i++) {
    roadL.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i],  HALF_WIDTH));
    roadR.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i], -HALF_WIDTH));
  }
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x26262b, roughness: 0.96, metalness: 0.0 });
  const road = ribbonMesh(roadL, roadR, 0.02, roadMat);
  road.receiveShadow = true;
  scene.add(road);

  // --- White edge lines along both sides
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.7 });
  const leftOuter = [], leftInner = [], rightOuter = [], rightInner = [];
  for (let i = 0; i < center.length; i++) {
    leftOuter.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i],  HALF_WIDTH));
    leftInner.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i],  HALF_WIDTH - EDGE_LINE));
    rightInner.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i], -(HALF_WIDTH - EDGE_LINE)));
    rightOuter.push(new THREE.Vector3().copy(center[i]).addScaledVector(normal[i], -HALF_WIDTH));
  }
  scene.add(ribbonMesh(leftOuter, leftInner, 0.03, lineMat));
  scene.add(ribbonMesh(rightInner, rightOuter, 0.03, lineMat));

  // --- Dashed centre line
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xffd84a, roughness: 0.7 });
  const dashGeo = new THREE.PlaneGeometry(0.35, 4);
  dashGeo.rotateX(-Math.PI / 2);
  for (let i = 0; i < SEG; i += 12) {
    const dash = new THREE.Mesh(dashGeo, dashMat);
    dash.position.copy(center[i]).setY(0.035);
    dash.rotation.y = Math.atan2(tangent[i].x, tangent[i].z);
    scene.add(dash);
  }

  // --- Checkered start/finish line at sample 0
  buildStartLine(scene, center[0], tangent[0], normal[0]);

  // --- Coarse samples for cheap "is this point on the track" tests
  const coarse = [];
  for (let i = 0; i < SEG; i += 4) coarse.push(center[i]);

  const startHeading = Math.atan2(tangent[0].x, tangent[0].z);

  return {
    curve,
    halfWidth: HALF_WIDTH,
    start: center[0].clone(),
    startHeading,
    isNear(x, z, margin = 10) {
      const limit = (HALF_WIDTH + margin) ** 2;
      for (let i = 0; i < coarse.length; i++) {
        const dx = coarse[i].x - x, dz = coarse[i].z - z;
        if (dx * dx + dz * dz < limit) return true;
      }
      return false;
    },
  };
}

// Build a flat ribbon mesh from matched left/right edge point arrays.
function ribbonMesh(leftArr, rightArr, y, material) {
  const positions = [], indices = [];
  const n = leftArr.length;
  for (let i = 0; i < n; i++) {
    positions.push(leftArr[i].x, y, leftArr[i].z);
    positions.push(rightArr[i].x, y, rightArr[i].z);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

// A two-row checkered band across the full track width.
function buildStartLine(scene, c, t, n) {
  const cols = 14, rows = 2;
  const cellW = (HALF_WIDTH * 2) / cols;
  const cellD = 1.4;
  const heading = Math.atan2(t.x, t.z);
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 });
  const geo = new THREE.PlaneGeometry(cellW, cellD);
  geo.rotateX(-Math.PI / 2);

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const cell = new THREE.Mesh(geo, (r + col) % 2 === 0 ? white : black);
      const offN = -HALF_WIDTH + cellW * (col + 0.5);
      const offT = (r - (rows - 1) / 2) * cellD;
      cell.position.copy(c)
        .addScaledVector(n, offN)
        .addScaledVector(t, offT)
        .setY(0.04);
      cell.rotation.y = heading;
      scene.add(cell);
    }
  }
}
