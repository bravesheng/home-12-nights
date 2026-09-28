// ===== 在家生存 99 夜 — 3D 畫面（Three.js） =====
// 光照做法：遊戲邏輯本來就用「每個房間各自計算」的光（lightAt），
// 這裡把同樣的光算成一張「光照貼圖」（每格 4×4 像素），所有牆、地板、家具都用它上色。
// 所以畫面上亮的地方＝遊戲判定安全的地方，而且不會有光穿牆的問題。
import * as THREE from '../lib/three.module.js';

const WALL_H = 2.7, EYE = 1.55, LMS = 4;
const LMW = MAP_W * LMS, LMH = MAP_H * LMS;
const SRGB = THREE.SRGBColorSpace;

let renderer, scene, camera, spot, viewFlash, lensMat, placeGhost;
const uni = { uLM: { value: null }, uLMSize: { value: new THREE.Vector2(MAP_W, MAP_H) }, uAmb: { value: 0.012 } };
const lmBytes = new Uint8Array(LMW * LMH * 4);
const lmAcc = new Float32Array(LMW * LMH * 3);
const texRoom = new Array(LMW * LMH).fill(null);
const texDoor = new Array(LMW * LMH).fill(null);
let lmTex;

// ====================================================================
// 材質與幾何
// ====================================================================
function patchLM(m) {
  m.onBeforeCompile = sh => {
    sh.uniforms.uLM = uni.uLM; sh.uniforms.uLMSize = uni.uLMSize; sh.uniforms.uAmb = uni.uAmb;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLMPos;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 lmWP = vec4(transformed, 1.0);
        vec3 lmN = objectNormal;
        #ifdef USE_INSTANCING
          lmWP = instanceMatrix * lmWP;
          lmN = mat3(instanceMatrix) * lmN;
        #endif
        lmWP = modelMatrix * lmWP;
        lmN = normalize(mat3(modelMatrix) * lmN);
        vLMPos = lmWP.xyz + lmN * 0.3;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLMPos;\nuniform sampler2D uLM;\nuniform vec2 uLMSize;\nuniform float uAmb;')
      .replace('#include <aomap_fragment>', `vec3 lmc = texture2D(uLM, vLMPos.xz / uLMSize).rgb * 2.0;
        reflectedLight.indirectDiffuse += diffuseColor.rgb * (lmc + uAmb);
        #include <aomap_fragment>`);
  };
  m.customProgramCacheKey = () => 'lightmap';
  return m;
}
const matCache = new Map();
function lm(color, opts) {
  const key = color + (opts ? JSON.stringify(opts) : '');
  let m = matCache.get(key);
  if (!m) { m = patchLM(new THREE.MeshLambertMaterial({ color, ...opts })); matCache.set(key, m); }
  return m;
}
const ownLM = (color, opts) => { const m = patchLM(new THREE.MeshLambertMaterial({ color, ...opts })); m.userData.own = true; return m; };
const ownBasic = opts => { const m = new THREE.MeshBasicMaterial(opts); m.userData.own = true; return m; };
const ownSprite = (map, color, extra = {}) => {
  const m = new THREE.SpriteMaterial({ map, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, ...extra });
  m.userData.own = true;
  return new THREE.Sprite(m);
};

const geoCache = new Map();
const geo = (key, make) => { let g = geoCache.get(key); if (!g) { g = make(); geoCache.set(key, g); } return g; };
const BOX = new THREE.BoxGeometry(1, 1, 1);

function box(g, x0, x1, y0, y1, z0, z1, mat, shadow = true) {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(Math.max(0.001, x1 - x0), Math.max(0.001, y1 - y0), Math.max(0.001, z1 - z0));
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.castShadow = shadow; m.receiveShadow = true;
  g.add(m);
  return m;
}
function cyl(g, rTop, rBot, h, x, y0, z, mat, seg = 14, open = false) {
  const gm = geo(`c${rTop},${rBot},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open));
  const m = new THREE.Mesh(gm, mat);
  m.position.set(x, y0 + h / 2, z);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}
function sph(g, r, x, y, z, mat, sx = 1, sy = 1, sz = 1, seg = 12) {
  const m = new THREE.Mesh(geo(`s${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.75 | 0))), mat);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}
function octa(g, r, x, y, z, mat) {
  const m = new THREE.Mesh(geo(`o${r}`, () => new THREE.OctahedronGeometry(r)), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}
function disposeGroup(g) {
  g.parent && g.parent.remove(g);
  g.traverse(o => {
    if (o.material && o.material.userData.own) o.material.dispose();
    if (o.userData.ownGeo) o.geometry.dispose();
  });
}

// ====================================================================
// 貼圖（全部用程式畫）
// ====================================================================
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = SRGB;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
let seed = 98765;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function shade(hex, v) {
  const n = parseInt(hex.slice(1), 16);
  const c = x => Math.max(0, Math.min(255, x + v)) | 0;
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const floorTexCache = {};
function floorTex(type) {
  if (floorTexCache[type]) return floorTexCache[type];
  const t = canvasTex(64, 64, (c, w, h) => {
    const planks = (base, seam, ph) => {
      for (let y = 0; y < h; y += ph) {
        c.fillStyle = shade(base, (rnd() - 0.5) * 18); c.fillRect(0, y, w, ph);
        c.fillStyle = seam; c.fillRect(0, y + ph - 1, w, 1);
        c.fillRect(Math.floor(rnd() * w), y, 1, ph);
        c.fillStyle = 'rgba(0,0,0,.05)';
        for (let i = 0; i < 4; i++) c.fillRect(0, y + rnd() * ph, w, 1);
      }
    };
    const checker = (a, b) => {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { c.fillStyle = (i + j) % 2 ? a : b; c.fillRect(i * 32, j * 32, 32, 32); }
      c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 2;
      for (let i = 0; i <= 64; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 64); c.moveTo(0, i); c.lineTo(64, i); c.stroke(); }
    };
    const speckle = (base, n, col) => {
      c.fillStyle = base; c.fillRect(0, 0, w, h);
      c.fillStyle = col;
      for (let i = 0; i < n; i++) c.fillRect(rnd() * w, rnd() * h, 2, 2);
    };
    switch (type) {
      case 'wood': planks('#8b6a4a', '#5e4630', 16); break;
      case 'wood2': planks('#6d4c34', '#452f20', 16); break;
      case 'attic': planks('#76583a', '#3a2a1a', 21); break;
      case 'carpet': speckle('#5b4d78', 140, 'rgba(255,255,255,.07)'); break;
      case 'tile': checker('#c9d3d8', '#aebac0'); break;
      case 'tile2': checker('#e6d9c3', '#cbbb9f'); break;
      case 'concrete': speckle('#62656a', 160, 'rgba(0,0,0,.18)'); break;
      case 'concrete2': speckle('#575a60', 160, 'rgba(0,0,0,.18)'); break;
    }
  });
  floorTexCache[type] = t;
  return t;
}
let glowTex, raysTex, wallTex, breakerTex, faceTex, hairTex, scribbleTex, ringEyeTex, blobGeo;
function makeTextures() {
  glowTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  });
  raysTex = canvasTex(128, 128, (c) => {
    c.translate(64, 64);
    for (let i = 0; i < 8; i++) {
      c.rotate(Math.PI / 4);
      const g = c.createLinearGradient(0, 0, 64, 0);
      g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath(); c.moveTo(0, -3); c.lineTo(64, 0); c.lineTo(0, 3); c.fill();
    }
  });
  wallTex = canvasTex(64, 128, (c, w, h) => {
    c.fillStyle = '#7b6e86'; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) { c.fillStyle = 'rgba(255,255,255,.035)'; c.fillRect(x, 0, 8, h); }
    c.fillStyle = 'rgba(0,0,0,.06)';
    for (let i = 0; i < 30; i++) c.fillRect(rnd() * w, rnd() * h, 1, 3);
    c.fillStyle = '#3f3446'; c.fillRect(0, h - 9, w, 9);
    c.fillStyle = '#9a8ea3'; c.fillRect(0, 0, w, 4);
  });
  // 血淚女：臉（和驚嚇畫面同一張圖）、垂到背後的長髮
  faceTex = canvasTex(512, 512, (c) => drawWomanFace(c, 512));
  hairTex = canvasTex(256, 512, (c) => {
    // 圓圓的頭頂、往下散開、髮尾參差不齊
    c.fillStyle = '#121014';
    c.beginPath(); c.moveTo(128, 18);
    c.bezierCurveTo(44, 18, 30, 120, 34, 210);
    c.bezierCurveTo(38, 320, 46, 390, 62, 430);
    c.lineTo(194, 430);
    c.bezierCurveTo(210, 390, 218, 320, 222, 210);
    c.bezierCurveTo(226, 120, 212, 18, 128, 18);
    c.fill();
    c.lineCap = 'round';
    for (let i = 0; i < 160; i++) {
      const x0 = 128 + (rnd() - 0.5) * 176, y0 = 26 + Math.abs(x0 - 128) * 0.7;
      const y1 = 380 + rnd() * 128, x1 = x0 + (x0 - 128) * 0.18 + (rnd() - 0.5) * 20, g = 20 + rnd() * 45 | 0;
      c.strokeStyle = `rgba(${g},${g - 2},${g + 5},${0.6 + rnd() * 0.4})`;
      c.lineWidth = 2 + rnd() * 3;
      c.beginPath(); c.moveTo(x0, y0);
      c.bezierCurveTo(x0 + (rnd() - 0.5) * 30, y1 * 0.4, x1 + (rnd() - 0.5) * 30, y1 * 0.75, x1, y1);
      c.stroke();
    }
  });
  // 3D 裡的臉：下緣淡出，才不會看到貼圖被切一刀
  {
    const c = faceTex.image.getContext('2d');
    c.globalCompositeOperation = 'destination-out';
    const g = c.createLinearGradient(0, 470, 0, 512);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
    c.fillStyle = g; c.fillRect(0, 470, 512, 42);
    c.globalCompositeOperation = 'source-over';
    faceTex.needsUpdate = true;
  }
  for (const t of [faceTex, hairTex]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // 黑球：像鉛筆來回塗黑的線條、紅色圈圈眼睛
  scribbleTex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#0b0a0d'; c.fillRect(0, 0, 256, 256);
    c.lineJoin = 'round';
    for (let row = -40; row < 300; row += 22) {
      c.strokeStyle = `rgba(${60 + rnd() * 30 | 0},${58 + rnd() * 25 | 0},${66 + rnd() * 30 | 0},.7)`;
      c.lineWidth = 1.5 + rnd() * 1.5;
      c.beginPath(); c.moveTo(-10, row);
      for (let x = -10; x < 270; x += 12) c.lineTo(x + 6, row - 28 + rnd() * 6), c.lineTo(x + 12, row + rnd() * 6);
      c.stroke();
    }
  });
  ringEyeTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,60,40,.55)'); g.addColorStop(1, 'rgba(255,60,40,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    c.strokeStyle = '#ff5a46'; c.lineWidth = 4; c.beginPath(); c.arc(32, 32, 17, 0, 7); c.stroke();
    c.fillStyle = '#ff4030'; c.beginPath(); c.arc(32, 32, 8, 0, 7); c.fill();
  });
  // 草稿裡的黑球不是正圓，是有點歪歪扭扭的一團
  blobGeo = new THREE.SphereGeometry(1, 36, 26);
  const bp = blobGeo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < bp.count; i++) {
    v.fromBufferAttribute(bp, i).normalize();
    const k = 1 + 0.1 * Math.sin(3 * v.x + 1.3) * Math.cos(2.4 * v.y) + 0.07 * Math.sin(5 * v.z + 2 * v.x) + 0.04 * Math.sin(9 * v.y + 4 * v.z);
    bp.setXYZ(i, v.x * k, v.y * k * 0.88, v.z * k);
  }
  blobGeo.computeVertexNormals();
  breakerTex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#8d9399'; c.fillRect(0, 0, 64, 64);
    c.strokeStyle = '#555b61'; c.lineWidth = 3; c.strokeRect(2, 2, 60, 60);
    c.fillStyle = '#ffd400';
    c.beginPath(); c.moveTo(36, 8); c.lineTo(20, 34); c.lineTo(31, 34); c.lineTo(25, 56); c.lineTo(45, 26); c.lineTo(34, 26); c.closePath(); c.fill();
  });
}

// ====================================================================
// 光照貼圖
// ====================================================================
function precomputeTexels() {
  for (let ty = 0; ty < LMH; ty++) for (let tx = 0; tx < LMW; tx++) {
    const x = Math.floor(tx / LMS), y = Math.floor(ty / LMS), i = ty * LMW + tx;
    texRoom[i] = roomGrid[y][x];
    texDoor[i] = doorGrid[y][x] ? doorGrid[y][x].rooms : null;
  }
}
const toLin = c => Math.pow(c / 255, 2.2);
function addLight(x, y, r, room, col, k) {
  const x0 = Math.max(0, Math.floor(Math.max(room.x - 1, x - r) * LMS)), x1 = Math.min(LMW - 1, Math.ceil(Math.min(room.x + room.w + 1, x + r) * LMS));
  const y0 = Math.max(0, Math.floor(Math.max(room.y - 1, y - r) * LMS)), y1 = Math.min(LMH - 1, Math.ceil(Math.min(room.y + room.h + 1, y + r) * LMS));
  const r2 = r * r;
  for (let ty = y0; ty <= y1; ty++) {
    const wy = (ty + 0.5) / LMS - y;
    for (let tx = x0; tx <= x1; tx++) {
      const i = ty * LMW + tx;
      let s;
      if (texRoom[i] === room) s = 1;
      else if (texDoor[i] && texDoor[i].includes(room)) s = 0.7;
      else continue;
      const wx = (tx + 0.5) / LMS - x, d2 = wx * wx + wy * wy;
      if (d2 >= r2) continue;
      const I = (1 - Math.pow(Math.sqrt(d2) / r, 1.8)) * k * s;
      lmAcc[i * 3] += col[0] * I; lmAcc[i * 3 + 1] += col[1] * I; lmAcc[i * 3 + 2] += col[2] * I;
    }
  }
}
function updateLightmap(dark) {
  const day = 1 - dark / NIGHT_DARK;
  const amb = 0.95 * day;
  for (let i = 0, n = LMW * LMH; i < n; i++) {
    const r = texRoom[i];
    const a = r ? amb * (1 - (r.dayDark || 0)) : texDoor[i] ? amb * 0.9 : 0;
    lmAcc[i * 3] = a; lmAcc[i * 3 + 1] = a * 0.97; lmAcc[i * 3 + 2] = a * 0.92;
  }
  for (const L of G.lights) {
    const c = L.color || (L.candle ? [255, 160, 70] : bulbRGB(L.tier));
    const col = [toLin(c[0]), toLin(c[1]), toLin(c[2])];
    const k = L.f * (L.candle ? 0.9 : 0.85 + L.tier * 0.04);
    addLight(L.x, L.y, L.r, L.room, col, k);
  }
  // 玩家身邊一點點微光，才不會完全看不到自己腳邊
  if (mode === 'play') {
    const p = G.p, tx = Math.floor(p.x), ty = Math.floor(p.y);
    const rooms = roomGrid[ty][tx] ? [roomGrid[ty][tx]] : doorGrid[ty][tx] ? doorGrid[ty][tx].rooms : [];
    for (const r of rooms) addLight(p.x, p.y, 2.2, r, [0.55, 0.58, 0.7], 0.2);
  }
  for (let i = 0, n = LMW * LMH; i < n; i++) {
    lmBytes[i * 4] = Math.min(255, lmAcc[i * 3] * 127.5);
    lmBytes[i * 4 + 1] = Math.min(255, lmAcc[i * 3 + 1] * 127.5);
    lmBytes[i * 4 + 2] = Math.min(255, lmAcc[i * 3 + 2] * 127.5);
    lmBytes[i * 4 + 3] = 255;
  }
  lmTex.needsUpdate = true;
}

// ====================================================================
// 房子：地板、天花板、牆、門、窗
// ====================================================================
const windows = [];
let frontDoorPanel;
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}
function addFloor(x, y, w, h, type) {
  const g = new THREE.PlaneGeometry(w, h);
  scaleUV(g, w, h);
  const m = new THREE.Mesh(g, floorMat(type));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x + w / 2, 0, y + h / 2);
  m.receiveShadow = true;
  scene.add(m);
}
const floorMats = {};
function floorMat(type) {
  return floorMats[type] || (floorMats[type] = patchLM(new THREE.MeshLambertMaterial({ map: floorTex(type) })));
}
function buildHouse() {
  for (const r of ROOMS) addFloor(r.x, r.y, r.w, r.h, r.floor);
  for (const d of DOORS) addFloor(d.x, d.y, 1, 1, d.rooms[0] ? d.rooms[0].floor : 'wood');

  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W, MAP_H), lm('#6d6674'));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(MAP_W / 2, WALL_H, MAP_H / 2);
  scene.add(ceil);

  // 牆（只放在靠近室內的牆格）
  const list = [];
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (tiles[y][x] !== 0) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = tiles[y + dy] && tiles[y + dy][x + dx];
      if (t) { near = true; break; }
    }
    if (near) list.push([x, y]);
  }
  const wallMat = patchLM(new THREE.MeshLambertMaterial({ map: wallTex }));
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), wallMat, list.length);
  const mtx = new THREE.Matrix4();
  list.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, WALL_H / 2, y + 0.5); walls.setMatrixAt(i, mtx); });
  walls.castShadow = true; walls.receiveShadow = true;
  walls.computeBoundingSphere();
  scene.add(walls);

  // 門楣與門框
  const trim = lm('#4a3a2e');
  for (const d of DOORS) {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.y); scene.add(g);
    box(g, 0, 1, 2.15, WALL_H, 0, 1, wallMat);
    // 門上下是牆 → 通道東西向，門框在南北兩側；否則在東西兩側
    const eastWest = !!(tiles[d.y - 1] && tiles[d.y - 1][d.x] === 0);
    if (eastWest) { box(g, 0, 1, 0, 2.15, 0, 0.06, trim); box(g, 0, 1, 0, 2.15, 0.94, 1, trim); }
    else { box(g, 0, 0.06, 0, 2.15, 0, 1, trim); box(g, 0.94, 1, 0, 2.15, 0, 1, trim); }
    if (d.front) {
      frontDoorPanel = new THREE.Group(); g.add(frontDoorPanel);
      box(frontDoorPanel, 0.05, 0.2, 0, 2.15, 0.05, 0.95, lm('#6b3d22'));
      box(frontDoorPanel, 0.2, 0.23, 0.2, 1.0, 0.2, 0.8, lm('#8a5230'));
      box(frontDoorPanel, 0.2, 0.23, 1.15, 1.95, 0.2, 0.8, lm('#8a5230'));
      sph(frontDoorPanel, 0.035, 0.27, 1.0, 0.82, lm('#e0b84a'));
    }
  }

  // 窗戶（白天透進光、晚上一片漆黑）
  const W = [['n', 17.5], ['n', 27.5], ['n', 38.5], ['e', 19.5], ['e', 22.5], ['e', 12.5], ['w', 23.5], ['e', 30.5], ['s', 21.5], ['s', 28.5]];
  const frameMat = lm('#d8d2c8');
  for (const [side, at] of W) {
    const g = new THREE.Group(); scene.add(g);
    const pane = new THREE.Mesh(geo('pane', () => new THREE.PlaneGeometry(1.1, 1.0)), ownBasic({ color: 0xd9ecf7, fog: false }));
    g.add(pane);
    box(g, -0.6, 0.6, -0.56, -0.5, -0.03, 0.03, frameMat, false); box(g, -0.6, 0.6, 0.5, 0.56, -0.03, 0.03, frameMat, false);
    box(g, -0.6, -0.55, -0.5, 0.5, -0.03, 0.03, frameMat, false); box(g, 0.55, 0.6, -0.5, 0.5, -0.03, 0.03, frameMat, false);
    box(g, -0.02, 0.02, -0.5, 0.5, -0.02, 0.02, frameMat, false); box(g, -0.55, 0.55, -0.02, 0.02, -0.02, 0.02, frameMat, false);
    if (side === 'n') { g.position.set(at, 1.5, 1.01); }
    if (side === 's') { g.position.set(at, 1.5, MAP_H - 1.01); g.rotation.y = Math.PI; }
    if (side === 'e') { g.position.set(MAP_W - 1.01, 1.5, at); g.rotation.y = -Math.PI / 2; }
    if (side === 'w') { g.position.set(1.01, 1.5, at); g.rotation.y = Math.PI / 2; }
    windows.push(pane);
  }
}

// ====================================================================
// 家具
// ====================================================================
const furn3d = {};
function frontSide(f) {
  const walk = (x, y) => inMap(x, y) && !isSolid(x, y) ? 1 : 0;
  const c = { s: 0, n: 0, e: 0, w: 0 };
  for (let x = f.x; x < f.x + f.w; x++) { c.n += walk(x, f.y - 1); c.s += walk(x, f.y + f.h); }
  for (let y = f.y; y < f.y + f.h; y++) { c.w += walk(f.x - 1, y); c.e += walk(f.x + f.w, y); }
  return ['s', 'n', 'e', 'w'].reduce((a, b) => (c[b] > c[a] ? b : a), 's');
}
// 以「正面」為準的座標：u 沿著正面、v 從正面往內
function fb(g, f, side, u0, u1, y0, y1, v0, v1, mat, shadow) {
  const W = f.w, D = f.h;
  if (side === 's') return box(g, u0, u1, y0, y1, D - v1, D - v0, mat, shadow);
  if (side === 'n') return box(g, u0, u1, y0, y1, v0, v1, mat, shadow);
  if (side === 'e') return box(g, W - v1, W - v0, y0, y1, u0, u1, mat, shadow);
  return box(g, v0, v1, y0, y1, u0, u1, mat, shadow);
}
const frontLen = (f, side) => (side === 's' || side === 'n' ? f.w : f.h);

function buildFurniture() {
  for (const f of FURN) {
    const g = new THREE.Group(); g.position.set(f.x, 0, f.y); scene.add(g);
    const r = { g, top: 0.8 };
    furn3d[f.id] = r;
    const W = f.w, D = f.h, side = frontSide(f), len = frontLen(f, side);
    const wood = lm('#8a6a4e'), dark = lm('#2a2226'), knob = lm('#e0c080');
    const cabinet = (h, col) => {
      box(g, 0.04, W - 0.04, 0, h, 0.04, D - 0.04, lm(col));
      const n = Math.max(1, Math.round(len));
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) * len / n;
        fb(g, f, side, (i * len / n) + 0.06, ((i + 1) * len / n) - 0.06, 0.08, h - 0.08, 0.02, 0.05, lm(shade(col, -12)), false);
        fb(g, f, side, u - 0.04, u + 0.04, h * 0.55, h * 0.55 + 0.05, 0, 0.03, knob, false);
      }
      r.top = h;
    };
    switch (f.type) {
      case 'rug': {
        const t = canvasTex(128, 128, (c) => {
          c.fillStyle = f.color; c.fillRect(0, 0, 128, 128);
          c.strokeStyle = 'rgba(255,220,160,.45)'; c.lineWidth = 4; c.strokeRect(12, 12, 104, 104);
          c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 2; c.strokeRect(20, 20, 88, 88);
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, D - 0.2), patchLM(new THREE.MeshLambertMaterial({ map: t })));
        m.rotation.x = -Math.PI / 2; m.position.set(W / 2, 0.006, D / 2); m.receiveShadow = true;
        g.add(m);
        break;
      }
      case 'tvcab':
        cabinet(0.5, '#4a3528');
        fb(g, f, side, len * 0.2, len * 0.8, 0.52, 1.15, 0.35, 0.45, dark);
        r.screen = fb(g, f, side, len * 0.22, len * 0.78, 0.55, 1.12, 0.33, 0.35, ownBasic({ map: staticTex, color: 0x0a0d14, fog: false }), false);
        break;
      case 'sofa': {
        const c = lm('#7b4b5a'), c2 = lm('#6a3f4d'), c3 = lm('#8d5b6b');
        box(g, 0, W, 0, 0.42, 0, D, c);
        box(g, 0, W, 0.42, 0.95, D - 0.25, D, c2);
        box(g, 0, 0.2, 0.42, 0.65, 0, D, c2); box(g, W - 0.2, W, 0.42, 0.65, 0, D, c2);
        for (let i = 0; i < 3; i++) box(g, 0.25 + i * (W - 0.5) / 3, 0.2 + (i + 1) * (W - 0.5) / 3, 0.42, 0.52, 0.08, D - 0.28, c3);
        r.top = 0.95;
        break;
      }
      case 'table': case 'desk': {
        const c = lm(f.type === 'desk' ? '#6b4a33' : '#9a7650');
        box(g, 0.05, W - 0.05, 0.72, 0.77, 0.05, D - 0.05, c);
        for (const [x, z] of [[0.12, 0.12], [W - 0.12, 0.12], [0.12, D - 0.12], [W - 0.12, D - 0.12]]) box(g, x - 0.03, x + 0.03, 0, 0.72, z - 0.03, z + 0.03, c);
        if (f.type === 'desk') { box(g, 0.4, 0.75, 0.77, 0.79, 0.3, 0.6, lm('#eeeeee')); box(g, 1.2, 1.5, 0.77, 0.8, 0.25, 0.7, lm('#dddddd')); box(g, 2.2, 2.4, 0.77, 1.05, 0.3, 0.5, lm('#b0463c')); }
        r.top = 0.8;
        break;
      }
      case 'bookshelf': {
        box(g, 0.02, W - 0.02, 0, 1.9, 0.02, D - 0.02, lm('#5c4030'));
        const cols = ['#b23a48', '#3a6ea5', '#e0a526', '#4c8c4a', '#8e5ea2', '#d9d9d9'];
        for (let s = 0; s < 4; s++) {
          let u = 0.06;
          while (u < len - 0.1) {
            const bw = 0.04 + rnd() * 0.05, bh = 0.24 + rnd() * 0.12;
            fb(g, f, side, u, u + bw, 0.12 + s * 0.44, 0.12 + s * 0.44 + bh, 0, 0.22, lm(cols[(rnd() * cols.length) | 0]), false);
            u += bw + 0.005;
          }
        }
        r.top = 1.9;
        break;
      }
      case 'phone': {
        box(g, 0.15, W - 0.15, 0, 0.7, 0.15, D - 0.15, lm('#6d5237'));
        box(g, 0.3, 0.7, 0.7, 0.8, 0.35, 0.65, dark);
        r.handset = ownLM('#8a2020');
        box(g, 0.28, 0.72, 0.8, 0.86, 0.38, 0.5, r.handset, false);
        r.top = 0.86;
        break;
      }
      case 'plant':
        cyl(g, 0.2, 0.15, 0.35, 0.5, 0, 0.5, lm('#8d5a3b'));
        for (let i = 0; i < 4; i++) sph(g, 0.2, 0.5 + Math.cos(i * 1.6) * 0.12, 0.62 + (i % 2) * 0.18, 0.5 + Math.sin(i * 1.6) * 0.12, lm('#3f8f4a'));
        r.top = 1;
        break;
      case 'fridge':
        box(g, 0.05, W - 0.05, 0, 1.85, 0.05, D - 0.05, lm('#dfe6ea'));
        fb(g, f, side, 0.1, len - 0.1, 1.15, 1.17, 0, 0.02, lm('#9aa5ab'), false);
        fb(g, f, side, len - 0.25, len - 0.2, 0.6, 1.05, 0, 0.05, lm('#9aa5ab'), false);
        fb(g, f, side, len - 0.25, len - 0.2, 1.3, 1.6, 0, 0.05, lm('#9aa5ab'), false);
        r.top = 1.85;
        break;
      case 'counter':
        cabinet(0.88, '#b99873');
        box(g, 0, W, 0.88, 0.92, 0, D, lm('#d9cbb5'));
        r.top = 0.92;
        break;
      case 'stove':
        box(g, 0.02, W - 0.02, 0, 0.9, 0.02, D - 0.02, lm('#3b3b3b'));
        for (const [x, z] of [[0.5, 0.3], [1.5, 0.3], [0.5, 0.7], [1.5, 0.7]]) cyl(g, 0.14, 0.14, 0.02, x, 0.9, z, lm('#1c1c1c'));
        r.top = 0.92;
        break;
      case 'cabinet': {
        const h = { shoecab: 0.9, nightstand: 0.55, dresser: 1.0, filecab: 1.3, toolcab: 1.6, kcab: 0.9 }[f.id] || 0.9;
        cabinet(h, f.id === 'filecab' || f.id === 'toolcab' ? '#7d8288' : '#8a6a4e');
        if (f.id === 'kcab') box(g, 0, W, 0.9, 0.94, 0, D, lm('#d9cbb5'));
        if (f.id === 'dresser') fb(g, f, side, 0.2, len - 0.2, 1.1, 1.9, 0.02, 0.05, lm('#b9d3de'), false);
        break;
      }
      case 'sink':
        cabinet(0.88, '#b99873');
        box(g, 0, W, 0.88, 0.92, 0, D, lm('#d9cbb5'));
        box(g, 0.4, W - 0.4, 0.86, 0.93, 0.25, D - 0.25, lm('#cfd8dc'), false);
        box(g, W / 2 - 0.03, W / 2 + 0.03, 0.92, 1.2, 0.1, 0.16, lm('#b0bec5'));
        r.top = 0.92;
        break;
      case 'shelf': {
        const m = lm('#6d7178');
        for (const [x, z] of [[0.05, 0.1], [W - 0.05, 0.1], [0.05, D - 0.1], [W - 0.05, D - 0.1]]) box(g, x - 0.03, x + 0.03, 0, 1.8, z - 0.03, z + 0.03, m);
        for (const y of [0.1, 0.7, 1.3, 1.78]) box(g, 0, W, y, y + 0.03, 0.05, D - 0.05, m);
        const cols = ['#b08a5a', '#5a7bb5', '#a33', '#999', '#4c8c4a'];
        for (const y of [0.13, 0.73, 1.33]) {
          let u = 0.1;
          while (u < W - 0.4) { const bw = 0.25 + rnd() * 0.3; box(g, u, u + bw, y, y + 0.2 + rnd() * 0.25, 0.15, D - 0.15, lm(cols[(rnd() * cols.length) | 0])); u += bw + 0.1; }
        }
        r.top = 1.8;
        break;
      }
      case 'box': {
        const c = lm('#b08a5a'), tape = lm('#d8c29a');
        if (W >= 2 && D >= 2) {
          box(g, 0.1, 0.95, 0, 0.7, 0.1, 0.95, c); box(g, 1.0, 1.9, 0, 0.6, 0.15, 0.9, c);
          box(g, 0.3, 1.5, 0, 0.75, 1.05, 1.9, c); box(g, 0.25, 0.9, 0.7, 1.2, 0.2, 0.85, c);
          box(g, 0.5, 0.55, 0.7, 0.71, 0.1, 0.95, tape, false);
          r.top = 1.2;
        } else {
          box(g, 0.1, W - 0.1, 0, 0.55, 0.1, D - 0.1, c);
          box(g, W / 2 - 0.05, W / 2 + 0.05, 0.55, 0.56, 0.1, D - 0.1, tape, false);
          r.top = 0.56;
        }
        break;
      }
      case 'bed': {
        box(g, 0, W, 0, 0.35, 0, D, lm('#5a4032'));
        box(g, 0.05, W - 0.05, 0.35, 0.55, 0.05, D - 0.05, lm('#d6d9e8'));
        box(g, 0.2, W - 0.2, 0.55, 0.68, 0.12, 0.55, lm('#ffffff'));
        box(g, 0.04, W - 0.04, 0.55, 0.63, 1.0, D - 0.03, lm('#5a7bb5'));
        box(g, 0, W, 0, 1.1, 0, 0.08, lm('#4a3226'));
        // 床底下伸出來的手
        r.hand = new THREE.Group(); g.add(r.hand); r.hand.visible = false;
        const skin = lm('#cfc6c0');
        box(r.hand, 0.9, 1.05, 0.02, 0.08, D - 0.1, D + 0.25, skin, false);
        for (let i = 0; i < 4; i++) box(r.hand, 0.88 + i * 0.05, 0.91 + i * 0.05, 0.02, 0.05, D + 0.25, D + 0.4, skin, false);
        r.top = 0.7;
        break;
      }
      case 'closet': {
        box(g, 0, W, 0, 2.1, 0, D * 0.9, lm('#6e4f3a'));
        r.gap = box(g, W / 2 - 0.06, W / 2 + 0.06, 0.1, 2.0, D * 0.9 - 0.02, D * 0.9 + 0.01, ownBasic({ color: 0x000000 }), false);
        r.gap.visible = false;
        r.doors = new THREE.Group(); g.add(r.doors);
        box(r.doors, 0.05, W / 2 - 0.01, 0.1, 2.0, D * 0.9, D * 0.9 + 0.03, lm('#7d5b44'), false);
        box(r.doors, W / 2 + 0.01, W - 0.05, 0.1, 2.0, D * 0.9, D * 0.9 + 0.03, lm('#7d5b44'), false);
        box(r.doors, W / 2 - 0.12, W / 2 - 0.08, 1.0, 1.25, D * 0.9 + 0.03, D * 0.9 + 0.06, knob, false);
        box(r.doors, W / 2 + 0.08, W / 2 + 0.12, 1.0, 1.25, D * 0.9 + 0.03, D * 0.9 + 0.06, knob, false);
        r.top = 2.1;
        break;
      }
      case 'toilet': {
        const w = lm('#f2f4f5');
        cyl(g, 0.2, 0.16, 0.4, 0.5, 0, 0.55, w);
        box(g, 0.25, 0.75, 0.4, 0.8, 0.05, 0.25, w);
        r.top = 0.8;
        break;
      }
      case 'medcab': {
        const w = lm('#f2f4f5');
        box(g, 0.1, W - 0.1, 1.1, 1.75, 0, 0.25, w);
        box(g, W / 2 - 0.04, W / 2 + 0.04, 1.28, 1.58, 0.25, 0.27, lm('#d7263d'), false);
        box(g, W / 2 - 0.15, W / 2 + 0.15, 1.39, 1.47, 0.25, 0.27, lm('#d7263d'), false);
        box(g, 0.45, W - 0.45, 0.75, 0.88, 0.05, 0.55, w);
        cyl(g, 0.08, 0.08, 0.75, W / 2, 0, 0.3, w);
        r.top = 1.75;
        break;
      }
      case 'bathtub':
        box(g, 0.05, W - 0.05, 0, 0.55, 0.05, D - 0.05, lm('#f2f4f5'));
        box(g, 0.18, W - 0.18, 0.45, 0.56, 0.18, D - 0.18, lm('#7fb8d6'), false);
        r.top = 0.56;
        break;
      case 'chest': {
        const c = lm('#6b3f22'), gold = lm('#d4a93a');
        box(g, 0.1, W - 0.1, 0, 0.45, 0.12, D - 0.12, c);
        box(g, 0.08, W - 0.08, 0.45, 0.58, 0.1, D - 0.1, lm('#5a331b'));
        box(g, 0.35, 0.42, 0, 0.59, 0.1, D - 0.1, gold, false); box(g, W - 0.42, W - 0.35, 0, 0.59, 0.1, D - 0.1, gold, false);
        r.top = 0.58;
        break;
      }
      case 'doll': {
        const cone = new THREE.Mesh(geo('dollbody', () => new THREE.ConeGeometry(0.13, 0.32, 10)), lm('#9b2d3a'));
        cone.position.set(0.5, 0.16, 0.5); cone.castShadow = true; g.add(cone);
        r.head = new THREE.Group(); r.head.position.set(0.5, 0.4, 0.5); g.add(r.head);
        sph(r.head, 0.09, 0, 0, 0, lm('#efe0d0'));
        sph(r.head, 0.095, 0, 0.03, -0.01, lm('#4a2e1a'), 1, 0.8, 1);
        for (const ex of [-0.035, 0.035]) sph(r.head, 0.015, ex, 0.005, 0.083, ownBasic({ color: 0x000000 }), 1, 1, 1, 6);
        r.top = 0.5;
        break;
      }
      case 'boiler':
        cyl(g, 0.5, 0.5, 2.0, W / 2, 0, D / 2, lm('#4b4f55'), 18);
        cyl(g, 0.06, 0.06, WALL_H - 2.0, W / 2 + 0.2, 2.0, D / 2, lm('#6d7178'), 8);
        box(g, W / 2 - 0.12, W / 2 + 0.12, 1.2, 1.44, D / 2 - 0.56, D / 2 - 0.5, lm('#dddddd'), false);
        r.top = 2;
        break;
      case 'car': {
        const red = lm('#8a1f2b'), glass = lm('#2a3344'), tire = lm('#111111');
        box(g, 0.2, W - 0.2, 0.25, 0.85, 0.3, D - 0.3, red);
        box(g, 1.3, W - 1.4, 0.85, 1.35, 0.45, D - 0.45, glass);
        box(g, 1.25, W - 1.35, 1.33, 1.4, 0.42, D - 0.42, red);
        for (const [x, z] of [[1.0, 0.3], [W - 1.0, 0.3], [1.0, D - 0.3], [W - 1.0, D - 0.3]]) {
          const w = cyl(g, 0.3, 0.3, 0.22, x, 0.3 - 0.11, z, tire, 14);
          w.rotation.x = Math.PI / 2; w.position.y = 0.3;
        }
        box(g, W - 0.22, W - 0.18, 0.55, 0.7, 0.45, 0.8, lm('#ffe9a8'), false);
        box(g, W - 0.22, W - 0.18, 0.55, 0.7, D - 0.8, D - 0.45, lm('#ffe9a8'), false);
        r.top = 1.4;
        break;
      }
      case 'toolbox':
        box(g, 0.2, W - 0.2, 0, 0.35, 0.25, D - 0.25, lm('#b3262e'));
        box(g, W / 2 - 0.25, W / 2 + 0.25, 0.35, 0.45, 0.47, 0.53, dark);
        r.top = 0.45;
        break;
      case 'washer': {
        box(g, 0.05, W - 0.05, 0, 0.9, 0.05, D - 0.05, lm('#eef1f3'));
        box(g, 1.05, W - 0.05, 0, 0.9, 0.05, D - 0.05, lm('#e3e7ea'));
        for (const u of [0.5, 1.5]) {
          const d = fb(g, f, side, u - 0.22, u + 0.22, 0.25, 0.69, 0, 0.02, lm('#6f8a99'), false);
          d.scale.multiplyScalar(1);
        }
        r.top = 0.9;
        break;
      }
      case 'breaker': {
        const m = patchLM(new THREE.MeshLambertMaterial({ map: breakerTex }));
        fb(g, f, side, 0.2, 0.8, 1.1, 1.7, 0.85, 1.0, m, false);
        r.led = new THREE.Mesh(geo('led', () => new THREE.SphereGeometry(0.03, 8, 6)), ownBasic({ color: 0x33ff66 }));
        const lp = { e: [0.99, 1.75, 0.5], w: [0.01, 1.75, 0.5], s: [0.5, 1.75, 0.99], n: [0.5, 1.75, 0.01] }[side];
        r.led.position.set(...lp);
        g.add(r.led);
        r.top = 1.75;
        break;
      }
      case 'workbench': {
        const top = lm('#8a6a4a'), leg = lm('#5e4633'), metal = lm('#8d9399');
        box(g, 0.02, W - 0.02, 0.82, 0.9, 0.05, D - 0.05, top);
        for (const [x, z] of [[0.08, 0.1], [W - 0.08, 0.1], [0.08, D - 0.1], [W - 0.08, D - 0.1]]) box(g, x - 0.04, x + 0.04, 0, 0.82, z - 0.04, z + 0.04, leg);
        box(g, 0.08, W - 0.08, 0.2, 0.24, 0.1, D - 0.1, top);
        box(g, 0.3, 0.34, 0.9, 0.93, 0.3, 0.62, lm('#6d4c34'));  // 鐵鎚
        box(g, 0.24, 0.4, 0.9, 0.96, 0.6, 0.66, metal);
        box(g, 0.9, 1.35, 0.9, 0.91, 0.35, 0.55, metal);           // 鋸子
        box(g, 1.35, 1.45, 0.9, 0.95, 0.4, 0.5, lm('#b3262e'));
        box(g, W - 0.35, W - 0.1, 0.9, 1.05, 0.3, 0.5, metal);    // 老虎鉗
        sph(g, 0.05, 0.7, 0.96, 0.5, lm('#ffe7a8'));             // 燈泡
        r.top = 1.05;
        break;
      }
      case 'gacha': {
        const red = lm('#d4263a');
        box(g, 0.14, 0.86, 0, 0.78, 0.14, 0.86, red);
        cyl(g, 0.3, 0.3, 0.04, 0.5, 0.78, 0.5, lm('#b01c2e'), 20);
        const glass = ownLM('#dff0ff', { transparent: true, opacity: 0.3, depthWrite: false });
        const dome = new THREE.Mesh(geo('dome', () => new THREE.SphereGeometry(0.3, 20, 14)), glass);
        dome.position.set(0.5, 1.1, 0.5); g.add(dome);
        const caps = ['#ffd166', '#4db8ff', '#7ee081', '#ff6b9a', '#c38bff', '#ff9f43', '#ffffff', '#4dffd2'];
        caps.forEach((c, i) => { const a = i * 2.4; sph(g, 0.075, 0.5 + Math.cos(a) * 0.14, 0.9 + (i % 3) * 0.1, 0.5 + Math.sin(a) * 0.14, lm(c), 1, 1, 1, 10); });
        cyl(g, 0.12, 0.16, 0.08, 0.5, 1.38, 0.5, red, 16);
        fb(g, f, side, 0.3, 0.7, 0.5, 0.62, 0, 0.03, lm('#222222'), false);   // 投幣口
        fb(g, f, side, 0.42, 0.58, 0.22, 0.38, 0, 0.06, lm('#f2c14e'), false); // 轉把
        r.top = 1.46;
        break;
      }
      case 'tchest': {
        const wood = lm('#7a4a22'), gold = lm('#e0b040');
        box(g, 0.1, W - 0.1, 0, 0.48, 0.15, D - 0.15, wood);
        box(g, 0.1, W - 0.1, 0.08, 0.12, 0.14, D - 0.14, gold, false);
        // 蓋子用鉸鏈轉開（鉸鏈在背面）
        const back = { s: [W / 2, 0.15, 0], n: [W / 2, D - 0.15, Math.PI], e: [0.1, D / 2, Math.PI / 2], w: [W - 0.1, D / 2, -Math.PI / 2] }[side];
        const piv = new THREE.Group(); piv.position.set(back[0], 0.48, back[1]); piv.rotation.y = back[2]; g.add(piv);
        r.lid = new THREE.Group(); piv.add(r.lid);
        const L = side === 's' || side === 'n' ? W - 0.2 : D - 0.3, Dp = side === 's' || side === 'n' ? D - 0.3 : W - 0.2;
        box(r.lid, -L / 2, L / 2, 0, 0.14, 0, Dp, lm('#8a5528'));
        box(r.lid, -L / 2, L / 2, 0.04, 0.08, -0.005, Dp + 0.005, gold, false);
        r.lock = box(r.lid, -0.06, 0.06, -0.1, 0.06, Dp, Dp + 0.04, gold, false);
        r.inside = ownSprite(glowTex, 0xffd060); r.inside.position.set(W / 2, 0.5, D / 2); r.inside.scale.setScalar(0.8); r.inside.visible = false;
        g.add(r.inside);
        r.top = 0.62;
        break;
      }
      default:
        box(g, 0.05, W - 0.05, 0, 0.8, 0.05, D - 0.05, lm('#777777'));
    }
    if (f.loot) {
      r.glint = ownSprite(glowTex, 0xfff0c0);
      r.glint.scale.setScalar(0.25);
      r.glint.position.set(W / 2, r.top + 0.18, D / 2);
      g.add(r.glint);
    }
  }
}
function updateFurniture(t) {
  const ev = G.ev, p = G.p;
  const cl = furn3d.closet;
  const rattling = ev.closet > 0;
  cl.gap.visible = rattling;
  cl.doors.position.x = rattling ? Math.sin(t * 45) * 0.012 * (1 + (18 - ev.closet) / 6) : 0;
  cl.g.rotation.z = rattling ? Math.sin(t * 38) * 0.004 : 0;
  furn3d.bed.hand.visible = ev.bedTimer > 0.6;
  if (furn3d.bed.hand.visible) furn3d.bed.hand.position.z = Math.sin(t * 9) * 0.03;
  const ph = furn3d.phone.handset;
  ph.emissive.setRGB(ev.phone > 0 && Math.sin(t * 20) > 0 ? 0.8 : 0, 0, 0);
  furn3d.phone.g.position.x = FURN_BY_ID.phone.x + (ev.phone > 0 ? Math.sin(t * 70) * 0.01 : 0);
  const led = furn3d.breaker.led.material.color;
  if (G.power) led.set(0x33ff66); else led.set(Math.sin(t * 8) > 0 ? 0xff2020 : 0x220000);
  // 娃娃的頭會轉向你
  const doll = furn3d.doll.head, df = FURN_BY_ID.doll;
  doll.rotation.y = Math.atan2(p.x - (df.x + 0.5), p.y - (df.y + 0.5));
  // 打開過的寶箱蓋子是開著的
  for (const id of ['tchest1', 'tchest2', 'tchest3']) {
    const r = furn3d[id], open = !!(G.chests && G.chests[id]);
    r.lid.rotation.x = open ? -1.15 : 0;
    r.lock.visible = !open;
  }
  // 電視自己打開時顯示雜訊
  const scr = furn3d.tvcab.screen.material;
  if (G.ev.tvOn) { drawStatic(); scr.color.setRGB(1, 1, 1); } else scr.color.set(0x0a0d14);
  // 敲門時門在震
  if (frontDoorPanel) frontDoorPanel.position.x = ev.knock > 0 && ev.knockTick > 1.9 ? Math.sin(t * 60) * 0.015 : 0;
  for (const f of FURN) {
    const r = furn3d[f.id];
    if (!r.glint) continue;
    const has = mode === 'play' && G.containers[f.id] && G.containers[f.id].items.length > 0;
    r.glint.visible = has;
    if (has) r.glint.material.opacity = (0.45 + 0.35 * Math.sin(t * 4 + f.x)) * (G.phase === 'night' ? 0.5 : 1);
  }
}

// ====================================================================
// 燈具（燈泡等級決定外觀）
// ====================================================================
const THEME = [
  { metal: '#5b5b60', edge: '#35353a' }, { metal: '#7a5d48', edge: '#4a3629' }, { metal: '#e3e3e3', edge: '#a8a8a8' },
  { metal: '#cfd8e0', edge: '#7f95a6' }, { metal: '#e6f8ff', edge: '#8fd3f0' }, { metal: '#f2c14e', edge: '#9c6f0b' },
  { metal: '#dfe7f0', edge: '#3a78d8', gem: [80, 160, 255] }, { metal: '#f0e0e2', edge: '#c8283e', gem: [255, 70, 100] },
  { metal: '#ece2f5', edge: '#8a3fd6', gem: [190, 90, 255] }, { metal: '#ffffff', edge: '#dddddd', gem: 'rainbow' },
  { metal: '#3a2a22', edge: '#ff7a1a', gem: [255, 150, 40] },
  { metal: '#1c2350', edge: '#8fa6ff' }, { metal: '#fff8e8', edge: '#e8c060' }, { metal: '#3f7a3a', edge: '#8be070' },
];
const fixMap = new Map();
function setSRGB(color, c, k = 1) { color.setRGB(c[0] / 255 * k, c[1] / 255 * k, c[2] / 255 * k, SRGB); }
function addBulb(res, g, x, y, z, tier, s = 1) {
  if (!tier) { sph(g, 0.045 * s, x, y, z, lm('#2b2b2e'), 1, 1, 1, 8); return; }
  let gm;
  if (tier === FIRE_TIER) gm = geo('flame', () => new THREE.ConeGeometry(0.045, 0.15, 10));
  else if (tier === SLIME_TIER) gm = blobGeo;
  else if (tier >= 6 && tier <= 9) gm = geo('gem', () => new THREE.OctahedronGeometry(0.075));
  else gm = geo('bulb', () => new THREE.SphereGeometry(0.06, 14, 10));
  const m = new THREE.Mesh(gm, ownBasic({ color: 0xffffff, fog: false, map: tier === STAR_TIER ? starBulbTex : null }));
  if (tier === SLIME_TIER) { m.scale.set(0.075 * s, 0.07 * s, 0.075 * s); m.position.set(x, y, z); g.add(m); res.bulbs.push(m); return; }
  m.position.set(x, y, z); m.scale.setScalar(s);
  g.add(m); res.bulbs.push(m);
  const halo = ownSprite(glowTex, 0xffffff);
  halo.position.set(x, y, z); halo.scale.setScalar((0.45 + tier * 0.09) * s);
  g.add(halo); res.halos.push(halo);
}
function addDecor(res, g, y, tier, th) {
  if (tier === 4) {
    const m = ownBasic({ color: 0xcdf3ff, transparent: true, opacity: 0.9, fog: false });
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const o = octa(g, 0.03, Math.cos(a) * 0.2, y - 0.13, Math.sin(a) * 0.2, m); o.scale.y = 1.8; }
  }
  if (tier === 5) {
    const ring = new THREE.Mesh(geo('ring', () => new THREE.TorusGeometry(0.2, 0.014, 6, 28)), lm('#f2c14e'));
    ring.rotation.x = Math.PI / 2; ring.position.y = y; g.add(ring);
  }
  if (tier > FIRE_TIER) { addSpecialDecor(res, g, y, tier); return; }
  if (tier >= 6) {
    res.spin = new THREE.Group(); res.spin.position.y = y; g.add(res.spin);
    const n = tier === FIRE_TIER ? 8 : tier === 9 ? 7 : 6;
    res.gems = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      const m = ownBasic({ color: 0xffffff, fog: false });
      const o = tier === FIRE_TIER ? sph(res.spin, 0.03, Math.cos(a) * 0.19, 0, Math.sin(a) * 0.19, m, 1, 1, 1, 8) : octa(res.spin, 0.034, Math.cos(a) * 0.23, 0, Math.sin(a) * 0.23, m);
      if (tier !== 9) setSRGB(m.color, th.gem);
      res.gems.push(o);
    }
  }
  if (tier >= 5) {
    res.rays = ownSprite(raysTex, 0xffffff);
    res.rays.position.y = y; res.rays.scale.setScalar(0.9 + tier * 0.1);
    g.add(res.rays);
  }
}
function buildFixture(o) {
  const g = new THREE.Group(); g.position.set(o.x + 0.5, 0, o.y + 0.5); scene.add(g);
  const th = THEME[o.bulb], metal = lm(th.metal), edge = lm(th.edge), metal2 = lm(th.metal, { side: THREE.DoubleSide });
  const bh = bulbPos(o).h;
  const res = { g, bulbs: [], halos: [], spin: null, rays: null, gems: null };
  if (o.bulb === SLIME_TIER) addSlimePuddle(g, o);
  if (o.type === 'socket') {
    cyl(g, 0.16, 0.16, 0.04, 0, WALL_H - 0.04, 0, edge);
    cyl(g, 0.01, 0.01, WALL_H - 0.04 - (bh + 0.1), 0, bh + 0.1, 0, edge, 6);
    cyl(g, 0.07, 0.25, 0.17, 0, bh - 0.02, 0, metal2, 18, true);
    addBulb(res, g, 0, bh - 0.02, 0, o.bulb);
    addDecor(res, g, bh - 0.02, o.bulb, th);
  } else if (o.type === 'desk') {
    cyl(g, 0.12, 0.13, 0.03, 0, 0, 0, edge);
    cyl(g, 0.015, 0.015, 0.4, 0, 0.03, 0, edge, 6);
    cyl(g, 0.06, 0.15, 0.14, 0, 0.44, 0, metal2, 16, true);
    addBulb(res, g, 0, bh, 0, o.bulb, 0.8);
    addDecor(res, g, bh + 0.02, o.bulb, th);
  } else if (o.type === 'floor') {
    cyl(g, 0.17, 0.18, 0.04, 0, 0, 0, edge);
    cyl(g, 0.018, 0.018, 1.36, 0, 0.04, 0, edge, 6);
    cyl(g, 0.18, 0.23, 0.32, 0, 1.36, 0, metal2, 20, true);
    addBulb(res, g, 0, bh, 0, o.bulb);
    addDecor(res, g, bh + 0.25, o.bulb, th);
  } else {
    cyl(g, 0.012, 0.012, WALL_H - 2.28, 0, 2.28, 0, edge, 6);
    sph(g, 0.07, 0, 2.24, 0, metal);
    const ring = new THREE.Mesh(geo('chring', () => new THREE.TorusGeometry(0.3, 0.012, 6, 30)), metal);
    ring.rotation.x = Math.PI / 2; ring.position.y = 2.17; g.add(ring);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, x = Math.cos(a) * 0.3, z = Math.sin(a) * 0.3;
      const arm = new THREE.Mesh(BOX, metal);
      arm.scale.set(0.3, 0.018, 0.018); arm.position.set(x / 2, 2.2, z / 2); arm.rotation.y = -a;
      g.add(arm);
      cyl(g, 0.035, 0.025, 0.05, x, 2.17, z, metal, 8);
      addBulb(res, g, x, 2.26, z, o.bulb, 0.7);
    }
    const drop = ownBasic({ color: 0xcdf3ff, transparent: true, opacity: 0.85, fog: false });
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 + 0.3; const d = octa(g, 0.028, Math.cos(a) * 0.36, 2.06, Math.sin(a) * 0.36, drop); d.scale.y = 2; }
    addDecor(res, g, 2.1, o.bulb, th);
  }
  return res;
}
function syncFixtures(t) {
  const seen = new Set();
  for (const o of [...G.sockets, ...G.lamps]) {
    seen.add(o);
    let f = fixMap.get(o);
    const key = `${o.type}:${o.bulb}:${o.x},${o.y}`;
    if (!f || f.key !== key) {
      if (f) disposeGroup(f.g);
      f = buildFixture(o); f.key = key;
      fixMap.set(o, f);
    }
  }
  for (const [o, f] of fixMap) if (!seen.has(o)) { disposeGroup(f.g); fixMap.delete(o); }
  const byObj = new Map();
  for (const L of G.lights) if (L.obj) byObj.set(L.obj, L);
  for (const [o, f] of fixMap) {
    if (!o.bulb) continue;
    const L = byObj.get(o), k = L ? L.f : 0;
    const col = bulbRGB(o.bulb);
    for (const b of f.bulbs) {
      if (o.bulb === SLIME_TIER) { const k2 = 0.7 + 0.3 * Math.sin(t * 3 + o.x); b.material.color.setRGB(0.35 * k2, 0.9 * k2, 0.3 * k2); continue; }
      if (L) setSRGB(b.material.color, o.bulb === STAR_TIER ? [255, 255, 255] : col, 0.55 + 0.45 * k); else b.material.color.setRGB(0.08, 0.08, 0.09);
      if (o.bulb === FIRE_TIER) b.scale.set(1, 0.85 + 0.3 * Math.abs(Math.sin(t * 13 + o.x)), 1);
    }
    if (f.stars) f.stars.forEach((st, i) => { st.visible = !!L; st.material.opacity = 0.5 + 0.5 * Math.abs(Math.sin(t * 3 + i * 1.7)); });
    for (const h of f.halos) { h.visible = !!L; if (L) { setSRGB(h.material.color, col); h.material.opacity = 0.35 + 0.65 * k; } }
    if (f.rays) { f.rays.visible = !!L; setSRGB(f.rays.material.color, col); f.rays.material.opacity = 0.75 * k; f.rays.material.rotation = t * (o.bulb === 5 ? 0.4 : 0.7); }
    if (f.spin) {
      f.spin.rotation.y = t * (o.bulb === STAR_TIER ? 0.35 : 0.6);
      if (o.bulb === 9) f.gems.forEach((gm, i) => setSRGB(gm.material.color, hsl((t * 90 + i * 51) % 360, 0.9, 0.6)));
      if (o.bulb === FIRE_TIER) f.gems.forEach((gm, i) => gm.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(t * 11 + i * 2))));
    }
  }
}

// ====================================================================
// 蠟燭、敵人、幻覺、粒子
// ====================================================================
const candleMap = new Map();
function syncCandles(t) {
  const seen = new Set();
  for (const c of G.candles) {
    seen.add(c);
    let r = candleMap.get(c);
    if (!r) {
      const g = new THREE.Group(); g.position.set(c.x, 0, c.y); scene.add(g);
      cyl(g, 0.03, 0.03, 0.14, 0, 0, 0, lm('#f3ecd8'), 8);
      const fl = new THREE.Mesh(geo('cflame', () => new THREE.ConeGeometry(0.018, 0.06, 8)), ownBasic({ color: 0xffcf6a, fog: false }));
      fl.position.y = 0.18; g.add(fl);
      const halo = ownSprite(glowTex, 0xffa040); halo.position.y = 0.18; halo.scale.setScalar(0.35); g.add(halo);
      r = { g, fl, halo }; candleMap.set(c, r);
    }
    const k = c.life < 10 ? c.life / 10 : 1;
    r.fl.scale.set(1, 0.8 + 0.4 * Math.abs(Math.sin(t * 17 + c.x)), 1);
    r.halo.material.opacity = 0.7 * k;
  }
  for (const [c, r] of candleMap) if (!seen.has(c)) { disposeGroup(r.g); candleMap.delete(c); }
}

// ====================================================================
// 第二批怪物的 3D 模型（火柴人、眼球花、爬行女、鳥腳女、小丑）
// ====================================================================
let stickFaceTex, momoFaceTex, crawlerFaceTex, clownFaceTex, eyeballTex, irisTex, leafTex, stripeTex, balloonTex;
let staticTex, staticCv, staticCtx, staticImg, leafMat;
function makeMonsterTextures() {
  const faceT = draw => { const t = canvasTex(512, 512, c => draw(c, 512)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  stickFaceTex = faceT(drawStickFace);
  momoFaceTex = faceT(drawMomoFace);
  crawlerFaceTex = faceT(drawCrawlerFace);
  clownFaceTex = faceT(drawClownFace);
  // 眼球：正面（u = 0.25）是白的、越往後越紅，布滿從瞳孔往外散開的血絲
  eyeballTex = canvasTex(512, 256, (c) => {
    const img = c.createImageData(512, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
      const dx = Math.min(Math.abs(x - 128), 512 - Math.abs(x - 128)) / 256, dy = Math.abs(y - 128) / 128;
      const k = Math.min(1, Math.hypot(dx * 1.4, dy)), i = (y * 512 + x) * 4;
      img.data[i] = 250 - k * 30; img.data[i + 1] = 244 - k * 95; img.data[i + 2] = 238 - k * 95; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    c.lineCap = 'round'; c.strokeStyle = 'rgba(178,40,52,.85)';
    const seg = (x0, y0, x1, y1, w) => { c.lineWidth = w; for (const o of [0, 512, -512]) { c.beginPath(); c.moveTo(x0 + o, y0); c.lineTo(x1 + o, y1); c.stroke(); } };
    for (let v = 0; v < 18; v++) {
      let a = v / 18 * Math.PI * 2 + rnd() * 0.3, x = 128 + Math.cos(a) * 34, y = 128 + Math.sin(a) * 34, w = 3;
      for (let s = 0; s < 14 && y > 4 && y < 252; s++) {
        const nx = x + Math.cos(a) * 9, ny = y + Math.sin(a) * 8;
        seg(x, y, nx, ny, w);
        if (rnd() < 0.25) {
          let ba = a + (rnd() - 0.5) * 1.4, bx = nx, by = ny;
          for (let k = 0; k < 4; k++) { const ex = bx + Math.cos(ba) * 7, ey = by + Math.sin(ba) * 7; seg(bx, by, ex, ey, w * 0.6); bx = ex; by = ey; ba += (rnd() - 0.5) * 0.6; }
        }
        x = nx; y = ny; a += (rnd() - 0.5) * 0.5; w = Math.max(0.8, w * 0.9);
      }
    }
  });
  // 瞳孔：灰色虹膜，中間是草稿裡的一圈螺旋
  irisTex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#6d6660'; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.strokeStyle = 'rgba(35,30,28,.5)'; c.lineWidth = 2;
    for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2; c.beginPath(); c.moveTo(128 + Math.cos(a) * 40, 128 + Math.sin(a) * 40); c.lineTo(128 + Math.cos(a) * 118, 128 + Math.sin(a) * 118); c.stroke(); }
    c.strokeStyle = '#231e1b'; c.lineWidth = 8; c.beginPath(); c.arc(128, 128, 120, 0, 7); c.stroke();
    c.fillStyle = '#141010'; c.beginPath(); c.arc(128, 128, 46, 0, 7); c.fill();
    c.strokeStyle = '#5a5450'; c.lineWidth = 4; c.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.12) { const rr = 4 + a * 2.1; c.lineTo(128 + Math.cos(a) * rr, 128 + Math.sin(a) * rr); }
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,.75)'; c.beginPath(); c.arc(96, 92, 14, 0, 7); c.fill();
  });
  // 葉子：草稿裡用綠色斜線塗的
  leafTex = canvasTex(128, 64, (c) => {
    c.fillStyle = '#a3d8ad'; c.fillRect(0, 0, 128, 64);
    c.strokeStyle = 'rgba(40,120,70,.85)'; c.lineWidth = 2.5;
    for (let x = -64; x < 192; x += 9) { c.beginPath(); c.moveTo(x, 64); c.lineTo(x + 40, 0); c.stroke(); }
  });
  // 小丑的條紋衣服、滴著紅色的氣球
  stripeTex = canvasTex(64, 64, (c) => { for (let y = 0; y < 64; y += 16) { c.fillStyle = '#e9e5dd'; c.fillRect(0, y, 64, 9); c.fillStyle = '#3b3a40'; c.fillRect(0, y + 9, 64, 7); } });
  balloonTex = canvasTex(128, 128, (c) => {
    c.fillStyle = '#d4101e'; c.fillRect(0, 0, 128, 128);
    c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(0, 20, 128, 10);
    for (let i = 0; i < 12; i++) {
      const x = rnd() * 124, y0 = 62 + rnd() * 16, len = 20 + rnd() * 38;
      c.fillStyle = 'rgba(95,0,10,.85)'; c.fillRect(x, y0, 4, len);
      c.beginPath(); c.arc(x + 2, y0 + len, 4, 0, 7); c.fill();
    }
  });
  // 電視雜訊
  staticCv = document.createElement('canvas'); staticCv.width = 80; staticCv.height = 60;
  staticCtx = staticCv.getContext('2d'); staticImg = staticCtx.createImageData(80, 60);
  staticTex = new THREE.CanvasTexture(staticCv); staticTex.colorSpace = SRGB;
  leafMat = patchLM(new THREE.MeshLambertMaterial({ map: leafTex }));
}
function drawStatic() {
  const d = staticImg.data;
  for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255; d[i] = v * 0.85; d[i + 1] = v * 0.9; d[i + 2] = v; d[i + 3] = 255; }
  staticCtx.putImageData(staticImg, 0, 0);
  // 快爬出來之前，雜訊裡會閃過她的臉
  const cr = G.enemies.find(e => e.kind === 'crawler');
  if ((cr && cr.emerge > 0) || G.ev.tvT > tvEmergeTime() - 4) {
    staticCtx.globalAlpha = 0.3 + Math.random() * 0.4;
    staticCtx.save(); staticCtx.translate(10, 0); drawCrawlerFace(staticCtx, 60); staticCtx.restore();
    staticCtx.globalAlpha = 1;
  }
  staticTex.needsUpdate = true;
}

// 在兩點之間放一根細圓柱（手腳、莖、線）
const UP = new THREE.Vector3(0, 1, 0);
function limb(g, a, b, r, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), dir = vb.clone().sub(va);
  const m = new THREE.Mesh(geo(`limb${r}`, () => new THREE.CylinderGeometry(r, r, 1, 7)), mat);
  m.scale.set(1, dir.length(), 1);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  g.add(m);
  return m;
}

// 火柴人：黑色線條身體、一隻手在揮、圓圓的白臉
function buildStick(r, g) {
  const ink = ownBasic({ color: 0x151515, transparent: true });
  limb(g, [0, 1.36, 0], [0, 0.82, 0], 0.022, ink);
  limb(g, [0, 0.82, 0], [-0.2, 0, 0.02], 0.022, ink);
  limb(g, [0, 0.82, 0], [0.2, 0, -0.02], 0.022, ink);
  limb(g, [0, 1.22, 0], [-0.46, 1.16, 0.04], 0.02, ink);
  limb(g, [0, 1.22, 0], [0.3, 1.3, 0.04], 0.02, ink);
  r.fore = new THREE.Group(); r.fore.position.set(0.3, 1.3, 0.04); g.add(r.fore);
  limb(r.fore, [0, 0, 0], [0.06, 0.32, 0], 0.02, ink);
  limb(r.fore, [0.06, 0.32, 0], [0.01, 0.41, 0], 0.012, ink);
  limb(r.fore, [0.06, 0.32, 0], [0.12, 0.4, 0], 0.012, ink);
  const faceMat = ownBasic({ map: stickFaceTex, transparent: true, alphaTest: 0.3, color: 0xb4b0aa });
  r.face = new THREE.Mesh(geo('stickface', () => new THREE.CircleGeometry(0.2, 28)), faceMat);
  r.face.position.set(0, 1.56, 0.02); g.add(r.face);
  r.mats.push(ink, faceMat);
}
// 鳥腳女：反折的鳥腳和爪子、圓圓的身體、長鼻子凸出來的臉
function buildMomo(r, g) {
  const skin = ownLM('#d8cfc4', { transparent: true }), leg = ownLM('#b8a37e', { transparent: true }), claw = ownLM('#3a3230', { transparent: true });
  for (const s of [-1, 1]) {
    limb(g, [s * 0.1, 0.8, 0], [s * 0.12, 0.56, 0.1], 0.05, skin);
    limb(g, [s * 0.12, 0.56, 0.1], [s * 0.12, 0.3, -0.1], 0.028, leg);
    limb(g, [s * 0.12, 0.3, -0.1], [s * 0.12, 0.03, 0], 0.024, leg);
    for (const a of [-0.5, 0, 0.5]) limb(g, [s * 0.12, 0.03, 0], [s * 0.12 + Math.sin(a) * 0.15, 0.01, Math.cos(a) * 0.15], 0.012, claw);
    limb(g, [s * 0.12, 0.03, 0], [s * 0.12, 0.01, -0.09], 0.012, claw);
    limb(g, [s * 0.24, 1.22, 0], [s * 0.3, 0.85, 0.05], 0.03, skin);
  }
  sph(g, 0.27, 0, 1.02, 0, skin, 1, 1.15, 0.9, 14);
  limb(g, [0, 1.28, 0], [0, 1.42, 0], 0.045, skin);
  const hairMat = ownBasic({ map: hairTex, transparent: true, alphaTest: 0.35 });
  const hair = new THREE.Mesh(geo('momohair', () => new THREE.PlaneGeometry(0.62, 1.0)), hairMat);
  hair.position.set(0, 1.3, -0.1); g.add(hair);
  const faceMat = ownBasic({ map: momoFaceTex, transparent: true, alphaTest: 0.35, color: 0xc9c3bd });
  r.face = new THREE.Mesh(geo('momoface', () => new THREE.PlaneGeometry(0.58, 0.58)), faceMat);
  r.face.position.set(0, 1.64, 0.04); g.add(r.face);
  const nose = new THREE.Mesh(geo('nose', () => new THREE.ConeGeometry(0.03, 0.2, 8)), skin);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.6, 0.14); g.add(nose);
  r.mats.push(skin, leg, claw, hairMat, faceMat);
}
// 爬行女：趴在地上、兩隻長手往前伸、長髮蓋住臉，只露出一隻發亮的眼睛
function buildCrawler(r, g) {
  const skin = ownLM('#7d8a94', { transparent: true }), dress = ownLM('#cfcfc6', { transparent: true });
  r.body = new THREE.Group(); g.add(r.body);
  sph(r.body, 0.2, 0, 0.36, -0.08, dress, 0.95, 0.7, 2.0, 14);
  for (const s of [-1, 1]) {
    limb(r.body, [s * 0.1, 0.3, -0.38], [s * 0.15, 0.06, -0.64], 0.042, skin);
    limb(r.body, [s * 0.15, 0.06, -0.64], [s * 0.12, 0.2, -0.88], 0.035, skin);
  }
  r.arms = [];
  for (const s of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(s * 0.17, 0.42, 0.26); r.body.add(sh);
    limb(sh, [0, 0, 0], [s * 0.14, -0.12, 0.26], 0.035, skin);
    limb(sh, [s * 0.14, -0.12, 0.26], [s * 0.08, -0.4, 0.46], 0.03, skin);
    for (let k = -2; k <= 2; k++) limb(sh, [s * 0.08, -0.4, 0.46], [s * 0.08 + k * 0.03, -0.41, 0.58], 0.008, skin);
    r.arms.push(sh);
  }
  const hairMat = ownBasic({ map: hairTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide });
  const hair = new THREE.Mesh(geo('crawlhair', () => new THREE.PlaneGeometry(0.5, 0.8)), hairMat);
  hair.rotation.x = Math.PI / 2 - 0.3; hair.position.set(0, 0.54, 0.1); r.body.add(hair);
  const faceMat = ownBasic({ map: crawlerFaceTex, transparent: true, alphaTest: 0.35, color: 0xb8bcc4 });
  r.face = new THREE.Mesh(geo('crawlface', () => new THREE.PlaneGeometry(0.46, 0.46)), faceMat);
  r.face.position.set(0, 0.52, 0.5); r.face.rotation.x = -0.25; r.body.add(r.face);
  const eye = ownSprite(glowTex, 0xdfe8ff);
  eye.position.set(0.043, 0.545, 0.53); eye.scale.setScalar(0.06); r.body.add(eye);
  r.eyes.push(eye);
  r.mats.push(skin, dress, hairMat, faceMat);
}
// 紅氣球（小丑出現前會先飄過來）
function balloonMesh(g, x, y, r) {
  const bm = ownBasic({ map: balloonTex, transparent: true, fog: false });
  const b = new THREE.Mesh(geo('balloon', () => new THREE.SphereGeometry(0.2, 20, 16)), bm);
  b.scale.set(1, 1.18, 1); b.position.set(x, y, 0); g.add(b);
  r.mats.push(bm);
  return b;
}
function buildBalloon(r, g) {
  r.balloon = balloonMesh(g, 0, 1.75, r);
  const str = ownBasic({ color: 0xdddddd, transparent: true });
  limb(g, [0, 1.5, 0], [0.03, 0.75, 0], 0.004, str);
  r.mats.push(str);
}
// 小丑：條紋衣褲、皺摺領、小禮帽、一手拿刀一手拉著紅氣球
function buildClown(r, g) {
  const stripe = ownLM('#ffffff', { map: stripeTex, transparent: true }), white = ownLM('#ece8e0', { transparent: true });
  const black = ownLM('#1b1a1d', { transparent: true }), steel = ownLM('#c9ced4', { transparent: true });
  for (const s of [-1, 1]) {
    cyl(g, 0.085, 0.09, 0.8, s * 0.1, 0, 0, stripe, 10);
    box(g, s * 0.1 - 0.06, s * 0.1 + 0.06, 0, 0.07, -0.05, 0.12, black, false);
  }
  cyl(g, 0.19, 0.24, 0.58, 0, 0.8, 0, stripe, 12);
  const ruff = new THREE.Mesh(geo('ruff', () => new THREE.TorusGeometry(0.16, 0.055, 8, 22)), white);
  ruff.rotation.x = Math.PI / 2; ruff.position.y = 1.41; g.add(ruff);
  limb(g, [-0.22, 1.33, 0], [-0.3, 0.98, 0.05], 0.035, stripe);
  r.balloon = balloonMesh(g, -0.42, 2.12, r);
  const str = ownBasic({ color: 0xdddddd, transparent: true });
  limb(g, [-0.3, 0.98, 0.05], [-0.41, 1.88, 0], 0.004, str);
  r.knife = new THREE.Group(); r.knife.position.set(0.22, 1.33, 0); g.add(r.knife);
  limb(r.knife, [0, 0, 0], [0.08, -0.36, 0.05], 0.035, stripe);
  box(r.knife, 0.06, 0.1, -0.42, -0.34, 0.03, 0.07, black, false);
  box(r.knife, 0.07, 0.09, -0.66, -0.42, 0.04, 0.06, steel, false);
  const faceMat = ownBasic({ map: clownFaceTex, transparent: true, alphaTest: 0.35, color: 0xb9b4ac });
  r.face = new THREE.Mesh(geo('clownface', () => new THREE.PlaneGeometry(0.52, 0.52)), faceMat);
  r.face.position.set(0, 1.66, 0.04); g.add(r.face);
  r.mats.push(stripe, white, black, steel, str, faceMat);
}
const NEW_BUILD = { stick: buildStick, momo: buildMomo, crawler: buildCrawler, balloon: buildBalloon, clown: buildClown };

function syncNewMonster(e, r, t) {
  const p = G.p, d = Math.hypot(e.x - p.x, e.y - p.y);
  switch (e.kind) {
    case 'stick': {
      r.fore.rotation.z = Math.sin(e.wob * 7) * 0.5;
      const burn = e.burn || 0;
      r.g.scale.set(1, 1 - burn / 1.4 * 0.35, 1);
      r.face.material.color.setRGB(0.7 + burn * 0.2, 0.69 - burn * 0.1, 0.66 - burn * 0.3);
      break;
    }
    case 'momo': {
      r.g.position.y = (e.air || 0) * 0.45;
      const crouch = e.hopping > 0 ? 1 - e.air : (e.hopT < 0.15 && e.stun <= 0 && e.cd <= 0 ? 1 : 0);
      r.g.scale.set(1, 1 - 0.12 * crouch, 1);
      r.face.rotation.z = e.stun > 0 ? Math.sin(t * 30) * 0.12 : 0;
      if (e.state !== 'hunt' && e.stun <= 0) r.g.rotation.y += Math.sin(t * 1.7) * 0.9; // 東張西望
      break;
    }
    case 'crawler': {
      if (e.emerge > 0) {
        // 從電視螢幕裡爬出來
        const k = 1 - e.emerge / 2.2;
        r.g.position.set(TV_FLOOR.x, 0.62 * (1 - k), 15.7 + (TV_FLOOR.y - 15.7) * k);
        r.g.rotation.set(0.9 * (1 - k), 0, 0);
      } else {
        r.g.rotation.x = 0;
        const moving = e.pauseT <= 0, ph = e.wob * 8;
        r.arms[0].rotation.x = moving ? Math.sin(ph) * 0.35 : 0;
        r.arms[1].rotation.x = moving ? -Math.sin(ph) * 0.35 : 0;
        r.body.rotation.z = moving ? Math.sin(ph) * 0.05 : 0;
        r.face.rotation.z = moving ? 0 : Math.sin(t * 25) * 0.15; // 停下來時頭會抽動
      }
      break;
    }
    case 'balloon': {
      const b = 1 + (e.burn || 0) * 0.3;
      r.balloon.scale.set(b, 1.18 * b, b);
      r.balloon.position.set(e.burn ? (Math.random() - 0.5) * 0.04 : 0, 1.75 + Math.sin(e.wob * 1.3) * 0.1, 0);
      r.g.rotation.y = e.wob * 0.3;
      break;
    }
    case 'clown':
      r.knife.rotation.x = d < 1.8 ? -1.4 * Math.pow(Math.abs(Math.sin(t * 7)), 2) : 0;
      r.balloon.position.y = 2.12 + Math.sin(e.wob * 1.3) * 0.06;
      break;
  }
}

// 眼球花：綠色的莖和兩片葉子，花是一顆會轉過來盯著你的大眼球
const flowerMap = new Map();
function buildFlower(f) {
  const g = new THREE.Group(); g.position.set(f.x, 0, f.y); scene.add(g);
  const stem = lm('#4f8a4a');
  limb(g, [0, 0, 0], [0.04, 0.55, 0], 0.024, stem);
  limb(g, [0.04, 0.55, 0], [0, 1.08, 0], 0.022, stem);
  for (const s of [-1, 1]) {
    const leaf = new THREE.Mesh(geo('leaf', () => new THREE.SphereGeometry(1, 14, 8)), leafMat);
    leaf.scale.set(0.2, 0.014, 0.085); leaf.position.set(s * 0.17, 0.52, 0); leaf.rotation.z = s * 0.45;
    g.add(leaf);
  }
  const eyeG = new THREE.Group(); eyeG.position.y = 1.28; eyeG.rotation.order = 'YXZ'; g.add(eyeG);
  const eyeMat = ownLM('#ffffff', { map: eyeballTex, emissive: 0x1a1414 });
  const ball = new THREE.Mesh(geo('eyeball', () => new THREE.SphereGeometry(0.24, 28, 20)), eyeMat);
  eyeG.add(ball);
  const irisMat = ownLM('#ffffff', { map: irisTex, emissive: 0x141010 });
  const iris = new THREE.Mesh(geo('iris', () => new THREE.CircleGeometry(0.095, 24)), irisMat);
  iris.position.z = 0.236; eyeG.add(iris);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g, eyeG, ball, iris, eyeMat, irisMat };
}
function syncFlowers(t) {
  const p = G.p, seen = new Set(), awake = G.phase === 'night';
  for (const f of G.flowers) {
    seen.add(f);
    let r = flowerMap.get(f);
    if (!r) { r = buildFlower(f); flowerMap.set(f, r); }
    r.g.scale.setScalar(Math.max(0.05, f.grow));
    const dx = p.x - f.x, dz = p.y - f.y, dist = Math.hypot(dx, dz);
    if (awake) {
      r.eyeG.rotation.y = Math.atan2(dx, dz) + Math.sin(t * 7 + f.x) * 0.02;
      r.eyeG.rotation.x = -Math.atan2(EYE - 1.28, Math.max(0.5, dist));
    } else { r.eyeG.rotation.y = Math.sin(t * 0.3 + f.x); r.eyeG.rotation.x = 0.95; } // 白天垂著頭睡覺
    const squint = 1 - (f.burn || 0) / 1.5 * 0.6;
    r.ball.scale.y = squint; r.iris.scale.y = squint;
    const al = f.alarm > 0 ? 0.35 + 0.35 * Math.sin(t * 30) : 0;
    r.eyeMat.emissive.setRGB(0.1 + al, 0.08, 0.08);
    r.irisMat.emissive.setRGB(0.08 + al, 0.06, 0.06);
  }
  for (const [f, r] of flowerMap) if (!seen.has(f)) { disposeGroup(r.g); flowerMap.delete(f); }
}

// ====================================================================
// 新燈泡（星空、天使、粘液）與取得物品的東西（商人、禮物、星星、掉落物、天使）
// ====================================================================
let starBulbTex, starShapeTex, moonTex, featherTex, slimeTex;
function makeExtraTextures() {
  starBulbTex = canvasTex(128, 64, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, '#0e1540'); g.addColorStop(0.5, '#23307a'); g.addColorStop(1, '#0e1540');
    c.fillStyle = g; c.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 46; i++) { c.fillStyle = `rgba(255,255,255,${0.5 + rnd() * 0.5})`; const s = rnd() < 0.2 ? 2.2 : 1.2; c.fillRect(rnd() * 128, rnd() * 64, s, s); }
  });
  starShapeTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,.8)'); g.addColorStop(0.3, 'rgba(255,255,255,.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fff'; c.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 9 : 24, a = -Math.PI / 2 + i * Math.PI / 5; c.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    c.closePath(); c.fill();
  });
  moonTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,245,200,.5)'); g.addColorStop(1, 'rgba(255,245,200,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fff6d0'; c.beginPath(); c.arc(32, 32, 19, 0, 7); c.fill();
    c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(42, 25, 17, 0, 7); c.fill();
  });
  featherTex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#fffaf0'; c.strokeStyle = '#d9c9a8'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(2, 30); c.quadraticCurveTo(30, 0, 62, 6);
    for (let i = 0; i < 5; i++) c.quadraticCurveTo(58 - i * 12, 24 + i * 5, 52 - i * 12, 20 + i * 6);
    c.quadraticCurveTo(14, 46, 2, 30); c.fill(); c.stroke();
  });
  slimeTex = canvasTex(256, 256, (c) => {
    c.fillStyle = 'rgba(90,210,70,.75)';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 70, r = 36 + rnd() * 34;
      c.beginPath(); c.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, r, 0, 7); c.fill();
    }
    c.fillStyle = 'rgba(190,255,160,.55)';
    for (let i = 0; i < 18; i++) { c.beginPath(); c.arc(40 + rnd() * 176, 40 + rnd() * 176, 3 + rnd() * 7, 0, 7); c.fill(); }
  });
  slimeTex.wrapS = slimeTex.wrapT = THREE.ClampToEdgeWrapping;
}

// 星空燈泡：繞著轉的小星星和彎月；天使燈泡：光環和翅膀；粘液燈泡：往下滴的黏液
function addSpecialDecor(res, g, y, tier) {
  if (tier === STAR_TIER) {
    res.spin = new THREE.Group(); res.spin.position.y = y; g.add(res.spin);
    res.stars = [];
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2, st = ownSprite(starShapeTex, 0xffffff);
      st.position.set(Math.cos(a) * 0.26, Math.sin(a * 2) * 0.05, Math.sin(a) * 0.26); st.scale.setScalar(0.1);
      res.spin.add(st); res.stars.push(st);
    }
    const moon = ownSprite(moonTex, 0xffffff);
    moon.position.set(0.32, 0.1, 0); moon.scale.setScalar(0.16);
    res.spin.add(moon);
  } else if (tier === ANGEL_TIER) {
    const halo = new THREE.Mesh(geo('lamphalo', () => new THREE.TorusGeometry(0.1, 0.012, 6, 24)), ownBasic({ color: 0xffd54a, fog: false }));
    halo.rotation.x = Math.PI / 2; halo.position.y = y + 0.14; g.add(halo);
    const wm = ownBasic({ map: featherTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, fog: false });
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(geo('lampwing', () => new THREE.PlaneGeometry(0.2, 0.15)), wm);
      w.position.set(s * 0.15, y + 0.02, 0); w.scale.x = s; w.rotation.y = s * 0.3;
      g.add(w);
    }
  } else if (tier === SLIME_TIER) {
    const dm = ownBasic({ color: 0x6fe05a, transparent: true, opacity: 0.85, fog: false });
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2, d = sph(g, 0.02, Math.cos(a) * 0.06, y - 0.08 - (i % 2) * 0.05, Math.sin(a) * 0.06, dm, 1, 2.2, 1, 8);
      d.castShadow = false;
    }
  }
}
// 粘液燈泡在地上流出的一灘黏液（只在同一個房間裡）
function addSlimePuddle(g, o) {
  const cx = o.x + 0.5, cy = o.y + 0.5, R = SLIME_R, pos = [], uv = [], idx = [];
  for (let y = Math.floor(cy - R); y <= Math.floor(cy + R); y++) for (let x = Math.floor(cx - R); x <= Math.floor(cx + R); x++) {
    if (!inMap(x, y)) continue;
    const dg = doorGrid[y][x];
    if (!(roomGrid[y][x] === o.room || (dg && !dg.front && dg.rooms.includes(o.room)))) continue;
    const v0 = pos.length / 3;
    for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const wx = x + dx, wy = y + dy;
      pos.push(wx - cx, 0.012, wy - cy);
      uv.push((wx - cx) / (2 * R) + 0.5, 1 - ((wy - cy) / (2 * R) + 0.5));
    }
    idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
  }
  const gm = new THREE.BufferGeometry();
  gm.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gm.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gm.setIndex(idx);
  gm.computeVertexNormals();
  const m = new THREE.Mesh(gm, ownBasic({ map: slimeTex, transparent: true, depthWrite: false, color: 0xb8c8b0 }));
  m.userData.ownGeo = true;
  g.add(m);
}

// ---------- 天使 ----------
const angelMap = new Map();
function buildAngel() {
  const g = new THREE.Group(); scene.add(g);
  const robe = new THREE.Mesh(geo('angelbody', () => new THREE.ConeGeometry(0.07, 0.2, 12)), ownBasic({ color: 0xfff4de, fog: false }));
  robe.position.y = -0.02; g.add(robe);
  const head = new THREE.Mesh(geo('angelhead', () => new THREE.SphereGeometry(0.045, 12, 8)), ownBasic({ color: 0xffe2c4, fog: false }));
  head.position.y = 0.11; g.add(head);
  const halo = new THREE.Mesh(geo('angelhalo', () => new THREE.TorusGeometry(0.045, 0.008, 6, 20)), ownBasic({ color: 0xffd54a, fog: false }));
  halo.rotation.x = Math.PI / 2; halo.position.y = 0.18; g.add(halo);
  const wm = ownBasic({ map: featherTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, fog: false });
  const wings = [];
  for (const s of [-1, 1]) {
    const piv = new THREE.Group(); piv.position.set(s * 0.02, 0.05, -0.02); g.add(piv);
    const w = new THREE.Mesh(geo('wing', () => new THREE.PlaneGeometry(0.16, 0.12)), wm);
    w.position.x = s * 0.08; w.scale.x = s; piv.add(w);
    wings.push(piv);
  }
  const glow = ownSprite(glowTex, 0xffe8a8); glow.scale.setScalar(0.45); g.add(glow);
  g.scale.setScalar(1.5);
  return { g, wings, glow };
}
function syncAngels(t) {
  const seen = new Set();
  for (const a of angels.values()) {
    seen.add(a);
    let r = angelMap.get(a);
    if (!r) { r = buildAngel(); angelMap.set(a, r); }
    r.g.position.set(a.x, a.h, a.y);
    const look = a.target && a.target.x !== undefined ? a.target : G.p;
    r.g.rotation.y = Math.atan2(look.x - a.x, look.y - a.y);
    const flap = Math.sin(t * (a.state === 'home' ? 8 : 18)) * 0.6;
    r.wings[0].rotation.y = flap; r.wings[1].rotation.y = -flap;
    r.glow.material.opacity = a.state === 'smite' ? 0.8 + 0.2 * Math.sin(t * 40) : 0.5;
    r.glow.scale.setScalar(a.state === 'smite' ? 0.9 : 0.45);
  }
  for (const [a, r] of angelMap) if (!seen.has(a)) { disposeGroup(r.g); angelMap.delete(a); }
}

// ---------- 神秘商人、早晨禮物、寶藏星星、掉落物 ----------
let merchant, gift, treasureStar;
function buildExtras() {
  // 神秘商人：紫色斗篷、帽兜裡兩顆發亮的黃眼睛、手上提著燈
  merchant = new THREE.Group(); scene.add(merchant);
  const robe = lm('#3b2a4a'), dark = lm('#1a1320');
  const body = new THREE.Mesh(geo('mrobe', () => new THREE.ConeGeometry(0.34, 1.35, 16)), robe);
  body.position.y = 0.68; merchant.add(body);
  const hood = new THREE.Mesh(geo('mhood', () => new THREE.SphereGeometry(0.2, 16, 12)), robe);
  hood.position.y = 1.45; hood.scale.set(1, 1.1, 1); merchant.add(hood);
  const face = new THREE.Mesh(geo('mface', () => new THREE.SphereGeometry(0.15, 12, 10)), ownBasic({ color: 0x07050a }));
  face.position.set(0, 1.43, 0.08); merchant.add(face);
  for (const s of [-1, 1]) { const e = ownSprite(glowTex, 0xffd23a); e.position.set(s * 0.05, 1.45, 0.22); e.scale.setScalar(0.07); merchant.add(e); }
  const sack = new THREE.Mesh(geo('msack', () => new THREE.SphereGeometry(0.22, 12, 10)), lm('#8a6a44'));
  sack.position.set(-0.1, 0.9, -0.3); merchant.add(sack);
  box(merchant, 0.2, 0.34, 0.86, 1.02, 0.18, 0.32, dark, false);
  const lampGlow = ownSprite(glowTex, 0xffb060); lampGlow.position.set(0.27, 0.94, 0.25); lampGlow.scale.setScalar(0.5); merchant.add(lampGlow);
  merchant.position.set(MERCHANT_POS.x, 0, MERCHANT_POS.y);
  merchant.traverse(o => { if (o.isMesh) o.castShadow = true; });
  // 早晨禮物：紅色盒子、金色緞帶
  gift = new THREE.Group(); scene.add(gift);
  box(gift, -0.2, 0.2, 0, 0.3, -0.2, 0.2, lm('#c8263a'));
  box(gift, -0.04, 0.04, 0, 0.31, -0.205, 0.205, lm('#f2c14e'), false);
  box(gift, -0.205, 0.205, 0, 0.31, -0.04, 0.04, lm('#f2c14e'), false);
  for (const s of [-1, 1]) { const bow = new THREE.Mesh(geo('bow', () => new THREE.TorusGeometry(0.06, 0.018, 6, 14)), lm('#f2c14e')); bow.position.set(s * 0.06, 0.34, 0); bow.rotation.y = Math.PI / 2; gift.add(bow); }
  const gg = ownSprite(glowTex, 0xffe0a0); gg.position.y = 0.2; gg.scale.setScalar(0.9); gift.add(gg); gift.userData.glow = gg;
  gift.position.set(GIFT_POS.x, 0, GIFT_POS.y);
  // 寶藏星星：會旋轉、發光的金色星星
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.07 : 0.17, a = Math.PI / 2 + i * Math.PI / 5; if (i) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r); else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  const sg = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1 });
  sg.center();
  treasureStar = new THREE.Group(); scene.add(treasureStar);
  treasureStar.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0xffd54a })));
  const tg = ownSprite(glowTex, 0xfff0a0); tg.scale.setScalar(0.9); treasureStar.add(tg);
}
const pickTex = {};
function pickupTex(id) {
  if (pickTex[id]) return pickTex[id];
  const t = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,240,180,.6)'); g.addColorStop(1, 'rgba(255,240,180,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    const it = ITEMS[id];
    if (it.kind === 'bulb') {
      const col = BULBS[it.tier].color === 'rainbow' ? [255, 190, 255] : BULBS[it.tier].color;
      c.fillStyle = `rgb(${col.join(',')})`; c.beginPath(); c.arc(32, 28, 13, 0, 7); c.fill();
      c.fillStyle = '#aab'; c.fillRect(26, 40, 12, 9);
    } else if (id === 'coin') {
      c.fillStyle = '#f2c14e'; c.beginPath(); c.arc(32, 32, 16, 0, 7); c.fill();
      c.strokeStyle = '#9c6f0b'; c.lineWidth = 3; c.stroke();
      c.fillStyle = '#9c6f0b'; c.font = 'bold 18px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('$', 32, 33);
    } else {
      c.font = '34px "Apple Color Emoji","Segoe UI Emoji",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(it.icon || '?', 32, 35);
    }
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return (pickTex[id] = t);
}
const pickMap = new Map();
function syncExtras(t) {
  merchant.visible = !!(G.stock && G.stock.length) && merchantHere();
  if (merchant.visible) merchant.rotation.y = Math.atan2(G.p.x - MERCHANT_POS.x, G.p.y - MERCHANT_POS.y);
  gift.visible = !!G.gift && mode !== 'title';
  if (gift.visible) gift.userData.glow.material.opacity = 0.45 + 0.3 * Math.sin(t * 3);
  treasureStar.visible = !!G.treasure && mode !== 'title';
  if (treasureStar.visible) {
    treasureStar.position.set(G.treasure.x, 0.7 + Math.sin(t * 2) * 0.08, G.treasure.y);
    treasureStar.rotation.y = t * 1.5;
  }
  const seen = new Set();
  for (const pk of G.pickups) {
    seen.add(pk);
    let s = pickMap.get(pk);
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pickupTex(pk.id), transparent: true, depthWrite: false }));
      s.material.userData.own = true; s.scale.setScalar(0.32); scene.add(s); pickMap.set(pk, s);
    }
    s.position.set(pk.x, 0.3 + Math.sin(pk.t * 3) * 0.05, pk.y);
    s.visible = !(pk.age > 100 && Math.sin(t * 12) < 0); // 快消失時會閃
  }
  for (const [pk, s] of pickMap) if (!seen.has(pk)) { scene.remove(s); s.material.dispose(); pickMap.delete(pk); }
}

const enemyMap = new Map();
function eyePair(g, y, z, color, size, gap) {
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = ownSprite(glowTex, color);
    e.position.set(s * gap, y, z); e.scale.setScalar(size);
    g.add(e); eyes.push(e);
  }
  return eyes;
}
function buildEnemy(e) {
  const g = new THREE.Group(); scene.add(g);
  const mat = ownBasic({ color: 0x000000, transparent: true, opacity: 1 });
  const r = { g, mat, wisps: [], eyes: [], mats: [mat] };
  if (e.kind === 'woman') {
    // 深色長裙、蒼白細長的手、垂到背後的長髮、永遠面向你的臉
    const dress = new THREE.Mesh(geo('dress', () => new THREE.ConeGeometry(0.34, 1.32, 16, 1, true)), mat);
    dress.position.y = 0.72; g.add(dress);
    const skin = ownBasic({ color: 0x6f6a66, transparent: true });
    for (const sd of [-1, 1]) {
      const arm = cyl(g, 0.02, 0.015, 0.82, sd * 0.2, 0.5, 0.06, skin, 6); arm.rotation.z = sd * 0.08;
      for (let k = -1; k <= 1; k++) cyl(g, 0.006, 0.004, 0.16, sd * 0.2 + k * 0.013, 0.35, 0.07, skin, 4);
    }
    const hairMat = ownBasic({ map: hairTex, transparent: true, alphaTest: 0.35 });
    const hair = new THREE.Mesh(geo('hairplane', () => new THREE.PlaneGeometry(0.9, 1.45)), hairMat);
    hair.position.set(0, 1.12, -0.07); g.add(hair);
    const faceMat = ownBasic({ map: faceTex, transparent: true, alphaTest: 0.35, color: 0xc9c3bd });
    r.face = new THREE.Mesh(geo('faceplane', () => new THREE.PlaneGeometry(0.7, 0.7)), faceMat);
    r.face.position.set(0, 1.55, 0.03); g.add(r.face);
    r.mats.push(skin, hairMat, faceMat);
  } else if (e.kind === 'blob') {
    // 歪歪的黑球＋兩個紅色圈圈眼睛
    const bm = patchLM(new THREE.MeshLambertMaterial({ map: scribbleTex, transparent: true }));
    bm.userData.own = true;
    r.body = new THREE.Mesh(blobGeo, bm); g.add(r.body);
    r.mats = [bm];
    r.eyeG = new THREE.Group(); g.add(r.eyeG);
    for (let i = 0; i < 2; i++) { const ey = ownSprite(ringEyeTex, 0xffffff); r.eyeG.add(ey); r.eyes.push(ey); }
  } else if (NEW_BUILD[e.kind]) {
    NEW_BUILD[e.kind](r, g);
  } else if (e.kind === 'tall') {
    cyl(g, 0.1, 0.15, 1.2, 0, 1.0, 0, mat, 8);
    cyl(g, 0.04, 0.05, 1.0, -0.07, 0, 0, mat, 6); cyl(g, 0.04, 0.05, 1.0, 0.07, 0, 0, mat, 6);
    sph(g, 0.15, 0, 2.36, 0, mat, 0.9, 1.25, 0.9, 10);
    for (const s of [-1, 1]) { const a = cyl(g, 0.025, 0.03, 1.7, s * 0.24, 0.45, 0, mat, 6); a.rotation.z = s * 0.1; }
    r.eyes = eyePair(g, 2.38, 0.2, 0xff2030, 0.12, 0.055);
  } else {
    const fast = e.kind === 'fast';
    const bodyY = fast ? 0.6 : 0.95, headY = fast ? 1.0 : 1.62;
    sph(g, 0.3, 0, bodyY, 0, mat, 1.05, fast ? 1.4 : 2.1, 0.85, 10);
    sph(g, 0.17, 0, headY, 0.03, mat, 1, 1.1, 1, 10);
    for (let i = 0; i < 4; i++) r.wisps.push(sph(g, 0.14, 0, 0.3, 0, mat, 1, 1, 1, 8));
    r.eyes = eyePair(g, headY + 0.01, 0.25, fast ? 0xffd23a : 0xff3344, 0.09, 0.06);
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return r;
}
function syncEnemies(t) {
  const p = G.p, seen = new Set();
  for (const e of G.enemies) {
    seen.add(e);
    let r = enemyMap.get(e);
    if (!r) { r = buildEnemy(e); enemyMap.set(e, r); }
    const a = enemyAlpha(e);
    r.g.visible = a > 0.02;
    r.g.position.set(e.x, Math.sin(e.wob * 2) * 0.04, e.y);
    r.g.rotation.y = Math.atan2(p.x - e.x, p.y - e.y);
    for (const m of r.mats) m.opacity = a * (m === r.mat ? 0.94 : 1);
    const eo = a * (0.6 + 0.4 * Math.sin(e.wob * 5));
    for (const ey of r.eyes) ey.material.opacity = eo;
    r.wisps.forEach((w, i) => w.position.set(Math.sin(e.wob * 3 + i * 1.7) * 0.22, 0.25 + Math.abs(Math.sin(e.wob * 2 + i)) * 0.3, Math.cos(e.wob * 2.5 + i * 2.1) * 0.18));
    if (e.kind === 'woman') {
      // 被看著時完全不動、頭歪一邊；沒被看著時飄著、會抖
      const jit = e.seen ? 0 : (Math.random() - 0.5) * 0.015;
      r.g.position.set(e.x + jit, e.seen ? 0.06 : 0.06 + Math.sin(e.wob * 1.6) * 0.05, e.y + jit);
      r.face.rotation.z = e.seen ? 0.22 : Math.sin(e.wob * 0.8) * 0.1;
    } else if (e.kind === 'blob') {
      const R = 0.4 * (e.size || 1), eating = e.eatT > 0;
      const hop = !eating && e.h < R + 0.05 ? Math.abs(Math.sin(e.wob * 6)) * 0.14 : 0;
      r.g.position.set(e.x, e.h + hop, e.y);
      const sq = eating ? Math.sin(e.wob * 14) * 0.1 : Math.sin(e.wob * 12) * 0.07;
      r.body.scale.set(R * (1 + sq), R * (1 - sq), R * (1 + sq));
      r.body.rotation.y = e.wob * 0.5;
      r.eyeG.position.set(0, R * 0.22, R * 0.97);
      r.eyes.forEach((ey, i) => { ey.position.set((i ? 1 : -1) * R * 0.2, 0, 0); ey.scale.setScalar(0.1 * (e.size || 1)); });
    } else if (NEW_BUILD[e.kind]) syncNewMonster(e, r, t);
  }
  for (const [e, r] of enemyMap) if (!seen.has(e)) { disposeGroup(r.g); enemyMap.delete(e); }
}
const ghostMap = new Map();
function syncGhosts() {
  const p = G.p, seen = new Set();
  for (const gh of G.ghosts) {
    seen.add(gh);
    let r = ghostMap.get(gh);
    if (!r) { const g = new THREE.Group(); scene.add(g); r = { g, eyes: eyePair(g, 1.5, 0, 0xdddddd, 0.07, 0.06) }; ghostMap.set(gh, r); }
    r.g.position.set(gh.x, 0, gh.y);
    r.g.rotation.y = Math.atan2(p.x - gh.x, p.y - gh.y);
    for (const ey of r.eyes) ey.material.opacity = clamp(gh.life, 0, 1) * 0.7;
  }
  for (const [gh, r] of ghostMap) if (!seen.has(gh)) { disposeGroup(r.g); ghostMap.delete(gh); }
}

const PMAX = 600;
let glowPts, smokePts;
function makePoints(size, blending) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PMAX * 3), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PMAX * 3), 3));
  const m = new THREE.PointsMaterial({ size, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending, fog: false });
  const pts = new THREE.Points(geom, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
}
function syncParticles() {
  let ng = 0, ns = 0;
  const gp = glowPts.geometry.attributes.position.array, gc = glowPts.geometry.attributes.color.array;
  const sp = smokePts.geometry.attributes.position.array, sc = smokePts.geometry.attributes.color.array;
  for (const f of G.fx) {
    const k = clamp(f.life / f.max, 0, 1);
    if (f.type === 'smoke') {
      if (ns >= PMAX) continue;
      sp.set([f.x, f.h, f.y], ns * 3); sc.set([f.color[0] / 255, f.color[1] / 255, f.color[2] / 255], ns * 3); ns++;
    } else {
      if (ng >= PMAX) continue;
      gp.set([f.x, f.h, f.y], ng * 3); gc.set([f.color[0] / 255 * k, f.color[1] / 255 * k, f.color[2] / 255 * k], ng * 3); ng++;
    }
  }
  glowPts.geometry.setDrawRange(0, ng); smokePts.geometry.setDrawRange(0, ns);
  glowPts.geometry.attributes.position.needsUpdate = glowPts.geometry.attributes.color.needsUpdate = true;
  smokePts.geometry.attributes.position.needsUpdate = smokePts.geometry.attributes.color.needsUpdate = true;
}

// ====================================================================
// 手電筒、放置預覽、鏡頭
// ====================================================================
function buildFlashlight() {
  spot = new THREE.SpotLight(0xfff0d8, 0, FL_RANGE + 1.5, FL_HALF * 1.1, 0.55, 1);
  spot.position.set(0.18, -0.15, 0);
  spot.target.position.set(0.05, -0.1, -1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(512, 512);
  spot.shadow.camera.near = 0.1; spot.shadow.camera.far = FL_RANGE + 1.5;
  spot.shadow.bias = -0.002;
  camera.add(spot); camera.add(spot.target);
  // 手上的手電筒
  viewFlash = new THREE.Group();
  viewFlash.position.set(0.17, -0.16, -0.32);
  camera.add(viewFlash);
  const body = cyl(viewFlash, 0.014, 0.017, 0.12, 0, -0.06, 0, lm('#55555c'), 12);
  body.rotation.x = Math.PI / 2; body.position.set(0, 0, 0.02);
  body.castShadow = false;
  const head = cyl(viewFlash, 0.022, 0.016, 0.035, 0, -0.0175, 0, lm('#3a3a40'), 12);
  head.rotation.x = Math.PI / 2; head.position.set(0, 0, -0.055);
  head.castShadow = false;
  lensMat = ownBasic({ color: 0x333333 });
  const lens = new THREE.Mesh(geo('lens', () => new THREE.CircleGeometry(0.021, 14)), lensMat);
  lens.position.z = -0.0735; lens.rotation.y = Math.PI;
  viewFlash.add(lens);
  placeGhost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.9, 0.9, 0.9)), new THREE.LineBasicMaterial({ color: 0xffdc78, transparent: true, opacity: 0.8 }));
  placeGhost.visible = false;
  scene.add(placeGhost);
}
let bobPh = 0, bobAmt = 0, baseFov = 72;
const yawOf = f => Math.atan2(-Math.cos(f), -Math.sin(f));
function updateCamera(dt, t) {
  let x, y, z, face, pitch;
  if (mode === 'title') {
    x = 16.3 + Math.sin(t * 0.12) * 0.8; y = 1.6; z = 23.2;
    face = Math.atan2(12.4 - z, 19.7 - x) + Math.sin(t * 0.21) * 0.05; pitch = 0.04;
  } else {
    const p = G.p;
    const moving = (p.moved || 0) > 0.001;
    bobPh += (p.moved || 0) * 6.5;
    bobAmt += ((moving ? 1 : 0) - bobAmt) * Math.min(1, dt * 8);
    x = p.x; z = p.y; y = EYE + Math.sin(bobPh) * 0.035 * bobAmt;
    face = p.face; pitch = p.pitch;
    if (G.shake > 0) { x += (Math.random() - 0.5) * G.shake * 0.12; y += (Math.random() - 0.5) * G.shake * 0.12; }
    viewFlash.position.set(0.17 + Math.cos(bobPh * 0.5) * 0.006 * bobAmt, -0.16 + Math.abs(Math.sin(bobPh * 0.5)) * 0.008 * bobAmt, -0.32);
  }
  camera.position.set(x, y, z);
  const stare = mode === 'play' ? (G.stare || 0) : 0;
  camera.rotation.set(pitch, yawOf(face), Math.sin(t * 2.3) * 0.05 * stare);
  const fov = baseFov - stare * 8;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  viewFlash.visible = mode !== 'title';
  const on = mode !== 'title' && flashOn();
  let k = on ? 1 : 0;
  if (on && G.p.bat < 15 && Math.random() < 0.15) k = 0.3;
  spot.intensity = 3.2 * k;
  lensMat.color.set(on ? 0xfff6dd : 0x333333);
}
function updatePlaceGhost() {
  const it = mode === 'play' && G.selId && ITEMS[G.selId];
  const show = !!(it && it.kind === 'lamp');
  placeGhost.visible = false;
  if (!show) return;
  const tt = lampTile();
  if (!tt) return;
  const h = { desk: 0.6, floor: 1.7, chand: 0.6 }[it.lamp];
  placeGhost.visible = true;
  placeGhost.scale.set(1, h / 0.9, 1);
  placeGhost.position.set(tt.x + 0.5, it.lamp === 'chand' ? 2.3 : h / 2, tt.y + 0.5);
}

// ====================================================================
// 霧、窗戶、主繪圖
// ====================================================================
const cDayFog = new THREE.Color('#1b1720'), cNightFog = new THREE.Color('#020104'), cBloodFog = new THREE.Color('#160205');
const cWinDay = new THREE.Color('#dcebf5'), cWinDusk = new THREE.Color('#e89a5a'), cWinNight = new THREE.Color('#0a1022'), cWinBlood = new THREE.Color('#4a0610');
const tmpC = new THREE.Color();
function updateAtmosphere(dark) {
  const k = dark / NIGHT_DARK;
  const night = G.ev.blood && G.phase === 'night' ? cBloodFog : cNightFog;
  tmpC.copy(cDayFog).lerp(night, k);
  scene.fog.color.copy(tmpC); scene.background.copy(tmpC);
  scene.fog.near = 10 - 8.5 * k; scene.fog.far = 45 - 32 * k;
  const winNight = G.ev.blood && G.phase === 'night' ? cWinBlood : cWinNight;
  if (k < 0.5) tmpC.copy(cWinDay).lerp(cWinDusk, k * 2); else tmpC.copy(cWinDusk).lerp(winNight, (k - 0.5) * 2);
  for (const w of windows) w.material.color.copy(tmpC);
}
function render(dt) {
  if (!G) return;
  const t = G.time, dark = darkLevel();
  syncFixtures(t);
  syncCandles(t);
  syncEnemies(t);
  syncFlowers(t);
  syncAngels(t);
  syncExtras(t);
  syncGhosts();
  syncParticles();
  updateFurniture(t);
  updateLightmap(dark);
  updateAtmosphere(dark);
  updateCamera(dt, t);
  updatePlaceGhost();
  renderer.render(scene, camera);
}
function resize() {
  const touch = document.body.classList.contains('touch');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? 1.4 : 2));
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  baseFov = camera.aspect < 1 ? 85 : 72;
  camera.fov = baseFov;
  camera.updateProjectionMatrix();
}

function init() {
  const canvas = document.getElementById('game');
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('saveInfo').textContent = '這台裝置不支援 3D（WebGL），無法執行遊戲。';
    return;
  }
  renderer.outputColorSpace = SRGB;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020104);
  scene.fog = new THREE.Fog(0x020104, 1.5, 13);
  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 60);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  lmTex = new THREE.DataTexture(lmBytes, LMW, LMH, THREE.RGBAFormat);
  lmTex.magFilter = lmTex.minFilter = THREE.LinearFilter;
  lmTex.needsUpdate = true;
  uni.uLM.value = lmTex;
  precomputeTexels();
  makeTextures();
  makeMonsterTextures();
  makeExtraTextures();
  buildHouse();
  buildFurniture();
  buildFlashlight();
  buildExtras();
  glowPts = makePoints(0.07, THREE.AdditiveBlending);
  smokePts = makePoints(0.3, THREE.NormalBlending);
  window.Renderer = { render, resize };
  resize();
}
init();
