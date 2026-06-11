import * as THREE from 'three';

// Spa-Francorchamps-inspired circuit: a long, flowing closed loop with real
// elevation change (Eau Rouge/Raidillon), red/white kerbs, grass + gravel
// run-off, and a pit lane parallel to the start/finish straight.
//
// Returns { start, startHeading, halfWidth, lapLength, sampleSurface, isNear, pit }.

const SCALE      = 1.4;
const HALF_WIDTH = 9;       // asphalt half-width (18 wide)
const KERB_W     = 1.8;     // red/white kerb band, just outside the asphalt at corners
const VERGE_OUT  = 27;      // flat run-off (grass / gravel) extends to here from centre
const APRON_OUT  = 82;      // grassy bank slopes from VERGE_OUT (track height) down to ground (y=0)
const SEG        = 720;     // ribbon / sampling resolution
const UP         = new THREE.Vector3(0, 1, 0);

// Centre-line control points: [x, z, elevation]. Hand-placed to trace the
// recognisable Spa layout and corner sequence.
const CTRL = [
  [-300, -60, 14],  // 0  start/finish line (straight runs +Z toward La Source)
  [-300,  40, 13],  // 1  end of straight / braking for La Source
  [-298,  95, 13],  // 2  La Source entry
  [-280, 120, 13],  // 3  La Source apex (tight right hairpin)
  [-256, 110, 12],  // 4  La Source exit
  [-240,  60,  7],  // 5  plunge down...
  [-232,  18,  0],  // 6  Eau Rouge (low point, left kink)
  [-214, -18,  4],  // 7  Raidillon (right, climbing steeply)
  [-188, -34,  9],  // 8  crest (left)
  [ -90,  20, 15],  // 9  Kemmel straight (long, climbing)
  [ -20,  78, 18],  // 10 Les Combes entry (top of the hill)
  [  10,  92, 18],  // 11 Les Combes chicane
  [  40,  78, 17],  // 12 Les Combes exit
  [  80,  44, 16],  // 13 Malmedy (right)
  [ 104,   4, 14],  // 14 Rivage (downhill right hairpin)
  [  86, -40, 12],  // 15 Rivage exit
  [  40, -96,  9],  // 16 Pouhon (long fast left, downhill)
  [ -10,-140,  7],  // 17 Fagnes
  [ -58,-166,  5],  // 18 Campus
  [-120,-186,  4],  // 19 Stavelot (right)
  [-200,-170,  6],  // 20 Blanchimont approach
  [-262,-132,  9],  // 21 Blanchimont (fast left)
  [-300,-104, 12],  // 22 back straight toward the Bus Stop
  [-318, -90, 13],  // 23 Bus Stop chicane (right-left)
  [-300, -78, 14],  // 24 Bus Stop exit -> short straight to the line
];

// Corner names by nearest control-point index, for reference / signage.
export function buildTrack(scene) {
  const ctrl = CTRL.map(p => new THREE.Vector3(p[0] * SCALE, p[2], p[1] * SCALE));
  const curve = new THREE.CatmullRomCurve3(ctrl, true, 'catmullrom', 0.5);

  // --- Sample the curve and build per-sample frames (with elevation) ---
  const raw = curve.getSpacedPoints(SEG);          // SEG+1, last === first
  const center = [], tangent = [], normal = [], corner = [];
  for (let i = 0; i < SEG; i++) {
    const p  = raw[i];
    const pn = raw[(i + 1) % SEG];
    const pp = raw[(i - 1 + SEG) % SEG];
    const t  = new THREE.Vector3().subVectors(pn, pp); t.y = 0; t.normalize();
    const n  = new THREE.Vector3().crossVectors(t, UP).normalize();
    center.push(p.clone()); tangent.push(t); normal.push(n);
  }
  // Curvature -> corner flag (turn rate per sample), then dilate a little
  const turn = [];
  for (let i = 0; i < SEG; i++) {
    const a = tangent[i], b = tangent[(i + 1) % SEG];
    turn.push(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)));
  }
  const CORNER_TH = 0.018;
  for (let i = 0; i < SEG; i++) corner.push(turn[i] > CORNER_TH);
  // dilate corner flag by +/- 6 samples so kerbs reach into entry/exit
  const cornerD = corner.slice();
  for (let i = 0; i < SEG; i++) {
    if (!corner[i]) continue;
    for (let k = -6; k <= 6; k++) cornerD[(i + k + SEG) % SEG] = true;
  }

  // Close the loop (append first frame)
  const push0 = (arr) => arr.push(arr[0]);
  center.push(center[0].clone()); tangent.push(tangent[0]); normal.push(normal[0]); cornerD.push(cornerD[0]);

  // --- Materials ---
  const roadMat   = new THREE.MeshStandardMaterial({ color: 0x26262b, roughness: 0.97 });
  const grassMat  = new THREE.MeshStandardMaterial({ color: 0x3f7d34, roughness: 1.0 });
  const gravelMat = new THREE.MeshStandardMaterial({ color: 0xb9a878, roughness: 1.0 });
  const lineMat   = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.7 });
  const kerbRed   = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.7 });
  const kerbWhite = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 });

  const off = (i, d) => new THREE.Vector3().copy(center[i]).addScaledVector(normal[i], d);

  // --- Road ribbon ---
  const rL = [], rR = [];
  for (let i = 0; i < center.length; i++) { rL.push(off(i,  HALF_WIDTH)); rR.push(off(i, -HALF_WIDTH)); }
  const road = ribbon(rL, rR, roadMat, 0.02); road.receiveShadow = true; scene.add(road);

  // --- White edge lines ---
  const eLo=[],eLi=[],eRi=[],eRo=[];
  for (let i = 0; i < center.length; i++) {
    eLo.push(off(i, HALF_WIDTH)); eLi.push(off(i, HALF_WIDTH - 0.45));
    eRi.push(off(i, -(HALF_WIDTH - 0.45))); eRo.push(off(i, -HALF_WIDTH));
  }
  scene.add(ribbon(eLo, eLi, lineMat, 0.05)); scene.add(ribbon(eRi, eRo, lineMat, 0.05));

  // --- Verge run-off (flat, at track height): grass normally, gravel at corners ---
  const grassQ = new QuadBuf(), gravelQ = new QuadBuf();
  for (let i = 0; i < center.length - 1; i++) {
    for (const side of [1, -1]) {
      const inA = cornerD[i] ? HALF_WIDTH + KERB_W : HALF_WIDTH;
      const a = off(i,   side * inA),        b = off(i + 1, side * inA);
      const c = off(i,   side * VERGE_OUT),  d = off(i + 1, side * VERGE_OUT);
      (cornerD[i] ? gravelQ : grassQ).add(side > 0 ? [a, c, b, d] : [a, b, c, d]);
    }
  }
  scene.add(grassQ.mesh(grassMat, 0.012));
  scene.add(gravelQ.mesh(gravelMat, 0.016));

  // --- Red/white kerbs at corners ---
  const kerbR = new QuadBuf(), kerbW = new QuadBuf();
  for (let i = 0; i < center.length - 1; i++) {
    if (!cornerD[i]) continue;
    for (const side of [1, -1]) {
      const a = off(i,   side * HALF_WIDTH),            b = off(i + 1, side * HALF_WIDTH);
      const c = off(i,   side * (HALF_WIDTH + KERB_W)), d = off(i + 1, side * (HALF_WIDTH + KERB_W));
      const q = side > 0 ? [a, c, b, d] : [a, b, c, d];
      ((i >> 1) % 2 === 0 ? kerbR : kerbW).add(q);
    }
  }
  scene.add(kerbR.mesh(kerbRed, 0.05));
  scene.add(kerbW.mesh(kerbWhite, 0.052));

  // --- Grass apron: slopes from VERGE_OUT (track height) down to ground (y=0) ---
  const apron = new QuadBuf();
  for (let i = 0; i < center.length - 1; i++) {
    for (const side of [1, -1]) {
      const a = off(i,   side * VERGE_OUT),  b = off(i + 1, side * VERGE_OUT);
      const c = off(i,   side * APRON_OUT).setY(0), d = off(i + 1, side * APRON_OUT).setY(0);
      apron.add(side > 0 ? [a, c, b, d] : [a, b, c, d]);
    }
  }
  scene.add(apron.mesh(grassMat, 0));

  // --- Dashed centre line + start/finish ---
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xffd84a, roughness: 0.7 });
  const dashGeo = new THREE.PlaneGeometry(0.35, 5); dashGeo.rotateX(-Math.PI / 2);
  for (let i = 0; i < SEG; i += 14) {
    const d = new THREE.Mesh(dashGeo, dashMat);
    d.position.copy(center[i]).setY(center[i].y + 0.04);
    d.rotation.y = Math.atan2(tangent[i].x, tangent[i].z);
    scene.add(d);
  }
  buildStartLine(scene, center[0], tangent[0], normal[0]);

  // --- Pit lane (parallel to the start/finish straight) ---
  const pit = buildPitLane(scene, roadMat, lineMat);

  // --- Flatten arrays for fast surface queries ---
  const cx = new Float32Array(SEG), cy = new Float32Array(SEG), cz = new Float32Array(SEG);
  const nx = new Float32Array(SEG), nz = new Float32Array(SEG); const cFlag = new Uint8Array(SEG);
  for (let i = 0; i < SEG; i++) { cx[i]=center[i].x; cy[i]=center[i].y; cz[i]=center[i].z; nx[i]=normal[i].x; nz[i]=normal[i].z; cFlag[i]=cornerD[i]?1:0; }

  function nearestIndex(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < SEG; i += 2) { const dx=cx[i]-x, dz=cz[i]-z; const d=dx*dx+dz*dz; if (d<bd){bd=d;best=i;} }
    for (let k = -2; k <= 2; k++) { const i=(best+k+SEG)%SEG; const dx=cx[i]-x, dz=cz[i]-z; const d=dx*dx+dz*dz; if (d<bd){bd=d;best=i;} }
    return best;
  }

  // Surface query: classify the point and return drive characteristics + height.
  function sampleSurface(x, z) {
    const p = pit.query(x, z);   // pit lane overrides (it sits beside the track)
    const i = nearestIndex(x, z);
    const offset = (x - cx[i]) * nx[i] + (z - cz[i]) * nz[i];
    const a = Math.abs(offset);
    const isCorner = cFlag[i] === 1;
    let surface = 'asphalt', grip = 1.0, drag = 0;
    if (a <= HALF_WIDTH) {
      surface = 'asphalt';
    } else if (isCorner && a <= HALF_WIDTH + KERB_W) {
      surface = 'kerb'; grip = 0.9; drag = 1.5;
    } else if (isCorner && a <= VERGE_OUT) {
      surface = 'gravel'; grip = 0.45; drag = 16;
    } else {
      surface = 'grass'; grip = 0.6; drag = 7;
    }
    let height = cy[i];
    if (p.inPit) {
      surface = 'pit'; grip = 1.0; drag = 0; height = p.height;
    }
    return { surface, grip, drag, height, offset, onTrack: a <= HALF_WIDTH,
             inPitLane: p.inPit, inPitBox: p.inBox, pitLimit: p.inPit };
  }

  function heightAt(x, z) { const i = nearestIndex(x, z); return cy[i]; }

  // Coarse points for cheap "near the track" tests (tree scatter avoidance)
  const coarse = [];
  for (let i = 0; i < SEG; i += 4) coarse.push(center[i]);

  return {
    start: center[0].clone(),
    startHeading: Math.atan2(tangent[0].x, tangent[0].z),
    halfWidth: HALF_WIDTH,
    lapLength: curve.getLength(),
    sampleSurface,
    heightAt,
    pit,
    isNear(x, z, margin = APRON_OUT) {
      const limit = (HALF_WIDTH + margin) ** 2;
      for (let i = 0; i < coarse.length; i++) {
        const dx = coarse[i].x - x, dz = coarse[i].z - z;
        if (dx * dx + dz * dz < limit) return true;
      }
      return pit.isNear(x, z);
    },
  };
}

// ---- Pit lane: parallel to the S/F straight, with entry/exit, boxes, limit ----
const PIT_HALF = 6.5;
function buildPitLane(scene, roadMat, lineMat) {
  // Pit centre-line (scaled world coords). Branches off after the Bus Stop and
  // rejoins before La Source. Boxes sit on the flat middle stretch.
  const P = [
    [-300, -100, 14], [-322, -72, 14], [-330, -24, 14],
    [-330, 22, 14], [-322, 58, 13], [-300, 84, 13],
  ].map(p => new THREE.Vector3(p[0] * SCALE, p[2], p[1] * SCALE));
  const curve = new THREE.CatmullRomCurve3(P, false, 'catmullrom', 0.5);
  const N = 90;
  const pts = curve.getSpacedPoints(N);
  const cen = [], nrm = [];
  for (let i = 0; i <= N; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a); t.y = 0; t.normalize();
    cen.push(pts[i]); nrm.push(new THREE.Vector3().crossVectors(t, UP).normalize());
  }
  const off = (i, d) => new THREE.Vector3().copy(cen[i]).addScaledVector(nrm[i], d);
  const L = [], R = [];
  for (let i = 0; i <= N; i++) { L.push(off(i, PIT_HALF)); R.push(off(i, -PIT_HALF)); }
  const lane = ribbon(L, R, roadMat, 0.03); lane.receiveShadow = true; scene.add(lane);

  // pit wall side line + a yellow pit-limit line near the entry
  const wl = [], wlo = [];
  for (let i = 0; i <= N; i++) { wl.push(off(i, -PIT_HALF)); wlo.push(off(i, -PIT_HALF + 0.4)); }
  scene.add(ribbon(wl, wlo, lineMat, 0.05));

  // three pit boxes on the inner side of the middle stretch
  const boxIdx = [Math.round(N * 0.42), Math.round(N * 0.5), Math.round(N * 0.58)];
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.7 });
  const boxGeo = new THREE.PlaneGeometry(5.5, 6.5); boxGeo.rotateX(-Math.PI / 2);
  const boxCenters = [];
  boxIdx.forEach((bi, k) => {
    const c = off(bi, PIT_HALF - 3.2);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 6.5).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: k === 1 ? 0x2f7d4f : 0x2a2a30, roughness: 0.8 }));
    m.position.copy(c).setY(c.y + 0.035);
    m.rotation.y = Math.atan2(nrm[bi].z, nrm[bi].x);
    scene.add(m);
    boxCenters.push(c);
  });
  const pitBox = boxCenters[1]; // middle box is the active stop

  // Flatten for queries
  const px = new Float32Array(N + 1), py = new Float32Array(N + 1), pz = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { px[i]=cen[i].x; py[i]=cen[i].y; pz[i]=cen[i].z; }

  function query(x, z) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i <= N; i++) { const dx=px[i]-x, dz=pz[i]-z; const d=dx*dx+dz*dz; if (d<bd){bd=d;bi=i;} }
    const dist = Math.sqrt(bd);
    const inPit = dist < PIT_HALF + 1 && bi > 2 && bi < N - 2; // not at the very entry/exit tips
    const bx = pitBox.x - x, bz = pitBox.z - z;
    const inBox = Math.hypot(bx, bz) < 6;
    return { inPit, inBox, height: py[bi] };
  }
  function isNear(x, z) {
    for (let i = 0; i <= N; i += 3) { const dx=px[i]-x, dz=pz[i]-z; if (dx*dx+dz*dz < (PIT_HALF + 30) ** 2) return true; }
    return false;
  }

  return { query, isNear, box: pitBox.clone(), entry: cen[0].clone(), exit: cen[N].clone() };
}

// ---- helpers ----
function ribbon(leftArr, rightArr, material, yLift) {
  const positions = [], indices = [];
  const n = leftArr.length;
  for (let i = 0; i < n; i++) {
    positions.push(leftArr[i].x, leftArr[i].y + yLift, leftArr[i].z);
    positions.push(rightArr[i].x, rightArr[i].y + yLift, rightArr[i].z);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

// Accumulates quads [p1,p2,p3,p4] (two triangles p1-p2-p3, p2-p4-p3) into one mesh.
class QuadBuf {
  constructor() { this.pos = []; this.idx = []; this.n = 0; }
  add(q) {
    const b = this.n;
    for (const p of q) this.pos.push(p.x, p.y, p.z);
    this.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    this.n += 4;
  }
  mesh(material, yLift) {
    const geo = new THREE.BufferGeometry();
    const pos = this.pos.slice();
    if (yLift) for (let i = 1; i < pos.length; i += 3) pos[i] += yLift;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(this.idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, material); m.receiveShadow = true; return m;
  }
}

function buildStartLine(scene, c, t, n) {
  const cols = 14, rows = 2;
  const cellW = (HALF_WIDTH * 2) / cols, cellD = 1.5;
  const heading = Math.atan2(t.x, t.z);
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 });
  const geo = new THREE.PlaneGeometry(cellW, cellD); geo.rotateX(-Math.PI / 2);
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    const cell = new THREE.Mesh(geo, (r + col) % 2 === 0 ? white : black);
    cell.position.copy(c)
      .addScaledVector(n, -HALF_WIDTH + cellW * (col + 0.5))
      .addScaledVector(t, (r - 0.5) * cellD)
      .setY(c.y + 0.05);
    cell.rotation.y = heading;
    scene.add(cell);
  }
}
