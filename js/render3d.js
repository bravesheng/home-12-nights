// ===== 在家生存 99 夜 — 3D 畫面（Three.js） =====
// 光照做法：遊戲邏輯本來就用「每個房間各自計算」的光（lightAt），
// 這裡把同樣的光算成一張「光照貼圖」（每格 4×4 像素），所有牆、地板、家具都用它上色。
// 所以畫面上亮的地方＝遊戲判定安全的地方，而且不會有光穿牆的問題。
import * as THREE from '../lib/three.module.js';

const WALL_H = 2.7, EYE = 1.55, LMS = 4;
const LMW = MAP_W * LMS, LMH = MAP_H * LMS;
const SRGB = THREE.SRGBColorSpace;

let renderer, scene, camera, spot, viewFlash, lensMat, placeGhost, strongRing;
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
      // 第二世界：草地、花田、石板、小路、泥土、沙子
      case 'grass': case 'grass2': case 'flowers': {
        c.fillStyle = type === 'grass2' ? '#6aa952' : '#5c9c48'; c.fillRect(0, 0, w, h);
        for (let i = 0; i < 220; i++) {
          const g = 120 + rnd() * 80 | 0;
          c.strokeStyle = `rgba(${g * 0.45 | 0},${g},${g * 0.4 | 0},.7)`; c.lineWidth = 1;
          const x = rnd() * w, y = rnd() * h; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 3, y - 3 - rnd() * 4); c.stroke();
        }
        const cols = ['#ffb3d6', '#fff3a8', '#ffffff', '#b8d8ff', '#ffd0a0'];
        for (let i = 0, n = type === 'flowers' ? 26 : 5; i < n; i++) { c.fillStyle = cols[(rnd() * cols.length) | 0]; c.beginPath(); c.arc(rnd() * w, rnd() * h, 1.6 + rnd() * 1.4, 0, 7); c.fill(); }
        break;
      }
      case 'stone': {
        c.fillStyle = '#b9b3a8'; c.fillRect(0, 0, w, h);
        for (const [x, y, sw, sh] of [[1, 1, 30, 20], [33, 1, 30, 26], [1, 23, 22, 40], [25, 29, 38, 16], [25, 47, 38, 16]]) { c.fillStyle = shade('#c9c3b6', (rnd() - 0.5) * 24); c.fillRect(x, y, sw, sh); }
        c.fillStyle = 'rgba(80,120,60,.5)'; for (let i = 0; i < 30; i++) c.fillRect(rnd() * w, rnd() * h, 2, 2);
        break;
      }
      case 'path': {
        c.fillStyle = '#7da35e'; c.fillRect(0, 0, w, h);
        for (let i = 0; i < 9; i++) { c.fillStyle = shade('#d8c8a6', (rnd() - 0.5) * 30); c.beginPath(); c.ellipse(8 + (i % 3) * 24 + rnd() * 4, 10 + Math.floor(i / 3) * 22 + rnd() * 4, 10, 8, rnd(), 0, 7); c.fill(); }
        break;
      }
      case 'dirt': speckle('#7a5a3e', 200, 'rgba(0,0,0,.2)'); break;
      case 'dirt2': speckle('#4c3828', 220, 'rgba(0,0,0,.25)'); break;
      case 'sand': speckle('#e0cf9f', 240, 'rgba(120,90,40,.25)'); break;
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

// 第二世界：樹牆、藍天白雲天花板（萬物甦醒時雲會睜開眼睛）、草葉、牆上的眼睛、門外的光
let treeWallTex, skyTex, skyEyeTex, bladeTex, wallEyeTex, doorGlowTex, clothTex, snailFaceTex, grassFaceTex, girlFaceTex, sunPetalTex, flowerEyeTex, capTex;
function makeGardenTextures() {
  // 小眼球（球面貼圖：正面 u = 0.25 是瞳孔）
  flowerEyeTex = canvasTex(128, 64, (c) => {
    c.fillStyle = '#f6efe6'; c.fillRect(0, 0, 128, 64);
    c.strokeStyle = 'rgba(180,40,50,.75)'; c.lineWidth = 1;
    for (let i = 0; i < 26; i++) { const a = rnd() * Math.PI * 2; c.beginPath(); c.moveTo(32 + Math.cos(a) * 11, 32 + Math.sin(a) * 11); c.lineTo(32 + Math.cos(a) * (18 + rnd() * 14), 32 + Math.sin(a) * (18 + rnd() * 10)); c.stroke(); }
    c.fillStyle = '#6a3a1e'; c.beginPath(); c.arc(32, 32, 9, 0, 7); c.fill();
    c.fillStyle = '#0d0808'; c.beginPath(); c.arc(32, 32, 4.5, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(29, 29, 2, 0, 7); c.fill();
  });
  // 千眼菇的菇傘：紅色上面有很多眼睛
  capTex = canvasTex(256, 128, (c) => {
    c.fillStyle = '#c8303e'; c.fillRect(0, 0, 256, 128);
    c.fillStyle = 'rgba(255,255,255,.08)'; for (let i = 0; i < 40; i++) c.fillRect(rnd() * 256, rnd() * 128, 3, 3);
    for (let i = 0; i < 26; i++) {
      const x = 8 + rnd() * 240, y = 10 + rnd() * 92, rr = 6 + rnd() * 5;
      c.fillStyle = '#f6efe6'; c.beginPath(); c.ellipse(x, y, rr * 1.3, rr, 0, 0, 7); c.fill();
      c.fillStyle = '#5a3a26'; c.beginPath(); c.arc(x, y, rr * 0.55, 0, 7); c.fill();
      c.fillStyle = '#0d0808'; c.beginPath(); c.arc(x, y, rr * 0.25, 0, 7); c.fill();
      c.strokeStyle = '#7a1a22'; c.lineWidth = 1.5; c.beginPath(); c.ellipse(x, y, rr * 1.3, rr, 0, 0, 7); c.stroke();
    }
  });
  treeWallTex = canvasTex(64, 128, (c, w, h) => {
    c.fillStyle = '#2c5629'; c.fillRect(0, 0, w, h);
    const leaf = n => { for (let i = 0; i < n; i++) { c.fillStyle = ['#3c7a36', '#4f8f45', '#2a4f28', '#5ea050', '#356b30'][(rnd() * 5) | 0]; c.beginPath(); c.arc(rnd() * w, rnd() * h * 0.62, 4 + rnd() * 7, 0, 7); c.fill(); } };
    leaf(140);
    // 樹幹（下半部）和旁邊的矮樹叢
    for (let i = 0; i < 60; i++) { c.fillStyle = ['#3c7a36', '#2a4f28', '#4a8a40'][(rnd() * 3) | 0]; c.beginPath(); c.arc(rnd() * w, h * 0.55 + rnd() * h * 0.45, 4 + rnd() * 6, 0, 7); c.fill(); }
    c.fillStyle = '#5a3b22'; c.beginPath(); c.moveTo(24, 58); c.lineTo(40, 58); c.lineTo(43, 118); c.lineTo(50, 128); c.lineTo(14, 128); c.lineTo(21, 118); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(30,18,10,.6)'; c.lineWidth = 1;
    for (let i = 0; i < 9; i++) { const x = 24 + rnd() * 16; c.beginPath(); c.moveTo(x, 60 + rnd() * 10); c.lineTo(x + (rnd() - 0.5) * 3, 120); c.stroke(); }
    leaf(40);
    const cols = ['#ffb3d6', '#ffffff', '#fff3a8'];
    for (let i = 0; i < 10; i++) { c.fillStyle = cols[(rnd() * 3) | 0]; c.beginPath(); c.arc(rnd() * w, rnd() * h * 0.9, 1.6, 0, 7); c.fill(); }
  });
  const drawSky = (c, w, h, eyes) => {
    const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#9fcfff'); g.addColorStop(1, '#c6e2ff');
    c.fillStyle = eyes === 'glow' ? '#000' : g; c.fillRect(0, 0, w, h);
    const clouds = [[60, 70], [190, 50], [130, 170], [30, 210], [220, 200]];
    for (const [x, y] of clouds) {
      if (eyes !== 'glow') { c.fillStyle = 'rgba(255,255,255,.92)'; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(x + (i - 2.5) * 13, y + Math.sin(i * 1.7) * 6, 15 + (i % 3) * 5, 0, 7); c.fill(); } }
      if (eyes) {
        // 萬物甦醒時，雲上睜開一隻眼睛
        c.fillStyle = eyes === 'glow' ? '#fff' : '#fbfbff'; c.beginPath(); c.ellipse(x, y, 16, 9, 0, 0, 7); c.fill();
        c.fillStyle = eyes === 'glow' ? '#ff6aa0' : '#5a3a6a'; c.beginPath(); c.arc(x, y, 6, 0, 7); c.fill();
        c.fillStyle = '#000'; c.beginPath(); c.arc(x, y, 2.6, 0, 7); c.fill();
      }
    }
  };
  skyTex = canvasTex(256, 256, (c, w, h) => drawSky(c, w, h, false));
  skyEyeTex = canvasTex(256, 256, (c, w, h) => drawSky(c, w, h, 'glow'));
  bladeTex = canvasTex(64, 64, (c) => {
    for (let i = 0; i < 16; i++) {
      const x = 6 + rnd() * 52, top = 6 + rnd() * 26, g = 120 + rnd() * 90 | 0;
      c.strokeStyle = `rgb(${g * 0.42 | 0},${g},${g * 0.38 | 0})`; c.lineWidth = 2.5 + rnd() * 2;
      c.beginPath(); c.moveTo(x, 64); c.quadraticCurveTo(x + (rnd() - 0.5) * 10, 40, x + (rnd() - 0.5) * 18, top); c.stroke();
    }
  });
  bladeTex.wrapS = bladeTex.wrapT = THREE.ClampToEdgeWrapping;
  wallEyeTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,150,200,.5)'); g.addColorStop(1, 'rgba(255,150,200,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fbf6ee'; c.beginPath(); c.ellipse(32, 32, 22, 13, 0, 0, 7); c.fill();
    c.fillStyle = '#7a2a4a'; c.beginPath(); c.arc(32, 32, 8, 0, 7); c.fill();
    c.fillStyle = '#000'; c.beginPath(); c.arc(32, 32, 3.5, 0, 7); c.fill();
  });
  wallEyeTex.wrapS = wallEyeTex.wrapT = THREE.ClampToEdgeWrapping;
  doorGlowTex = canvasTex(64, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#bfe0ff'); g.addColorStop(0.5, '#fff4fb'); g.addColorStop(1, '#ffc8e4');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  clothTex = canvasTex(64, 64, (c) => { for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { c.fillStyle = (x + y) % 2 ? '#e2394a' : '#fff4f0'; c.fillRect(x * 8, y * 8, 8, 8); } });
  sunPetalTex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#f7d23a'; c.beginPath(); c.ellipse(32, 32, 30, 12, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(180,120,10,.6)'; c.lineWidth = 2; c.beginPath(); c.moveTo(4, 32); c.lineTo(60, 32); c.stroke();
  });
  sunPetalTex.wrapS = sunPetalTex.wrapT = THREE.ClampToEdgeWrapping;
  const faceT = draw => { const t = canvasTex(512, 512, c => draw(c, 512)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  snailFaceTex = faceT(drawSnailFace);
  grassFaceTex = faceT(drawGrassFace);
  girlFaceTex = faceT(drawGirlFace);
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
  const tg = isW2() ? 0.95 : 0.97, tb = isW2() ? 1.02 : 0.92; // 第二世界的白天帶一點粉紫色
  for (let i = 0, n = LMW * LMH; i < n; i++) {
    const r = texRoom[i];
    const a = r ? amb * (1 - (r.dayDark || 0)) : texDoor[i] ? amb * 0.9 : 0;
    lmAcc[i * 3] = a; lmAcc[i * 3 + 1] = a * tg; lmAcc[i * 3 + 2] = a * tb;
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
let frontDoorPanel, doorGlow, houseGroup = null, ceilMat = null, wallEyes = null, flowerEyes = null;
const decoFlowers = [];   // 第二世界地上的小花（萬物甦醒時會長出眼睛看著你）
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}
function addFloor(x, y, w, h, type) {
  const g = new THREE.PlaneGeometry(w, h);
  scaleUV(g, w, h);
  const m = new THREE.Mesh(g, floorMat(type));
  m.userData.ownGeo = true;
  m.rotation.x = -Math.PI / 2;
  m.position.set(x + w / 2, 0, y + h / 2);
  m.receiveShadow = true;
  houseGroup.add(m);
}
const floorMats = {};
function floorMat(type) {
  return floorMats[type] || (floorMats[type] = patchLM(new THREE.MeshLambertMaterial({ map: floorTex(type) })));
}
// 換世界：拆掉整個房子（地板、牆、家具），用新的世界重新蓋
function setWorld() {
  if (houseGroup) {
    scene.remove(houseGroup);
    houseGroup.traverse(o => {
      if (o.userData.ownGeo) o.geometry.dispose();
      if (o.material && o.material.userData.own) o.material.dispose();
    });
  }
  windows.length = 0; decoFlowers.length = 0;
  frontDoorPanel = null; doorGlow = null; wallEyes = null; flowerEyes = null; ceilMat = null;
  for (const k in furn3d) delete furn3d[k];
  buildHouse();
  buildFurniture();
}
function buildHouse() {
  houseGroup = new THREE.Group(); scene.add(houseGroup);
  const w2 = isW2();
  for (const r of ROOMS) addFloor(r.x, r.y, r.w, r.h, r.floor);
  for (const d of DOORS) addFloor(d.x, d.y, 1, 1, d.rooms[0] ? d.rooms[0].floor : 'wood');

  // 天花板：第二世界是藍天白雲（萬物甦醒時雲會睜開眼睛發光）
  let cm;
  if (w2) {
    const sky = skyTex.clone(); sky.needsUpdate = true; sky.repeat.set(MAP_W / 6, MAP_H / 6);
    const glow = skyEyeTex.clone(); glow.needsUpdate = true; glow.repeat.set(MAP_W / 6, MAP_H / 6);
    cm = ceilMat = patchLM(new THREE.MeshLambertMaterial({ map: sky, emissiveMap: glow, emissive: 0x000000 }));
    cm.userData.own = true;
  } else cm = lm('#6d6674');
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W, MAP_H), cm);
  ceil.userData.ownGeo = true;
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(MAP_W / 2, WALL_H, MAP_H / 2);
  houseGroup.add(ceil);

  // 牆（只放在靠近室內的牆格）；第二世界是一棵一棵的樹
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
  const wallMat = patchLM(new THREE.MeshLambertMaterial({ map: w2 ? treeWallTex : wallTex }));
  wallMat.userData.own = true;
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), wallMat, list.length);
  walls.userData.ownGeo = true;
  const mtx = new THREE.Matrix4();
  list.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, WALL_H / 2, y + 0.5); walls.setMatrixAt(i, mtx); });
  walls.castShadow = true; walls.receiveShadow = true;
  walls.computeBoundingSphere();
  houseGroup.add(walls);

  // 門楣與門框（第二世界：花拱門）
  const trim = lm('#4a3a2e'), vine = lm('#4f8a3a');
  const archFlowers = [];
  for (const d of DOORS) {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.y); houseGroup.add(g);
    box(g, 0, 1, 2.15, WALL_H, 0, 1, wallMat);
    // 門上下是牆 → 通道東西向，門框在南北兩側；否則在東西兩側
    const eastWest = !!(tiles[d.y - 1] && tiles[d.y - 1][d.x] === 0);
    if (w2 && !d.front) {
      const arch = new THREE.Group(); arch.position.set(0.5, 0, 0.5); arch.rotation.y = eastWest ? Math.PI / 2 : 0; g.add(arch);
      for (const s of [-1, 1]) cyl(arch, 0.045, 0.05, 1.62, s * 0.45, 0, 0, vine, 8);
      const top = new THREE.Mesh(geo('archTop', () => new THREE.TorusGeometry(0.45, 0.05, 6, 18, Math.PI)), vine);
      top.position.y = 1.62; arch.add(top);
      g.updateMatrixWorld(true);
      for (const z of [0.05, -0.05]) {
        for (let i = 0; i < 9; i++) { const a = i / 8 * Math.PI; archFlowers.push(arch.localToWorld(new THREE.Vector3(Math.cos(a) * 0.45, 1.62 + Math.sin(a) * 0.45, z))); }
        for (const s of [-1, 1]) for (let k = 0; k < 3; k++) archFlowers.push(arch.localToWorld(new THREE.Vector3(s * 0.45, 0.4 + k * 0.45, z)));
      }
    } else if (eastWest) { box(g, 0, 1, 0, 2.15, 0, 0.06, trim); box(g, 0, 1, 0, 2.15, 0.94, 1, trim); }
    else { box(g, 0, 0.06, 0, 2.15, 0, 1, trim); box(g, 0.94, 1, 0, 2.15, 0, 1, trim); }
    if (d.front) {
      frontDoorPanel = new THREE.Group(); g.add(frontDoorPanel);
      box(frontDoorPanel, 0.05, 0.2, 0, 2.15, 0.05, 0.95, lm('#6b3d22'));
      box(frontDoorPanel, 0.2, 0.23, 0.2, 1.0, 0.2, 0.8, lm('#8a5230'));
      box(frontDoorPanel, 0.2, 0.23, 1.15, 1.95, 0.2, 0.8, lm('#8a5230'));
      sph(frontDoorPanel, 0.035, 0.27, 1.0, 0.82, lm('#e0b84a'));
      // 破關動畫：門打開後，門外是一片粉紅、淡藍的光
      doorGlow = new THREE.Group(); doorGlow.position.set(-1.1, 0, 0.5); doorGlow.visible = false; g.add(doorGlow);
      const pl = new THREE.Mesh(geo('doorGlowPl', () => new THREE.PlaneGeometry(3.0, 4.6)), ownBasic({ map: doorGlowTex, fog: false }));
      pl.position.y = 0.9; pl.rotation.y = Math.PI / 2; doorGlow.add(pl);
      const sp = ownSprite(glowTex, 0xffe8f6); sp.position.set(0.9, 1.2, 0); sp.scale.setScalar(3.2); doorGlow.add(sp);
      doorGlow.userData.sprite = sp;
    }
  }
  if (archFlowers.length) addInstancedFlowers(archFlowers, 0.05, ['#ff9ec8', '#ffffff', '#fff3a8', '#c9a8ff']);

  if (w2) { buildGardenDeco(list); return; }
  // 窗戶（白天透進光、晚上一片漆黑）
  const W = [['n', 17.5], ['n', 27.5], ['n', 38.5], ['e', 19.5], ['e', 22.5], ['e', 12.5], ['w', 23.5], ['e', 30.5], ['s', 21.5], ['s', 28.5]];
  const frameMat = lm('#d8d2c8');
  for (const [side, at] of W) {
    const g = new THREE.Group(); houseGroup.add(g);
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
// 一次畫很多朵小花（只用一個 InstancedMesh，平板才跑得動）
function addInstancedFlowers(points, r, cols) {
  const m = patchLM(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  m.userData.own = true;
  const im = new THREE.InstancedMesh(geo('dflower' + r, () => new THREE.SphereGeometry(r, 6, 4)), m, points.length);
  const mtx = new THREE.Matrix4(), col = new THREE.Color();
  points.forEach((p, i) => { mtx.makeTranslation(p.x, p.y, p.z); im.setMatrixAt(i, mtx); im.setColorAt(i, col.set(cols[i % cols.length])); });
  im.computeBoundingSphere();
  houseGroup.add(im);
  return im;
}
// 第二世界的地面裝飾：一叢一叢的草、小花；萬物甦醒時牆上和花上冒出的眼睛
function buildGardenDeco(wallList) {
  const grass = [], heads = [], stems = [];
  const r = seeded(424242);
  for (const room of ROOMS) {
    const fl = room.floor;
    const pg = fl === 'sand' || fl === 'stone' ? 0.08 : fl === 'dirt2' ? 0.15 : fl === 'path' ? 0.25 : 0.5;
    const pf = fl === 'flowers' ? 0.8 : fl === 'sand' || fl === 'dirt2' || fl === 'stone' ? 0.03 : fl === 'path' ? 0.15 : 0.28;
    for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) {
      const f = furnGrid[y][x];
      if (f) continue;
      const bed = FURN.some(o => o.solid === false && x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h);
      if (r() < pg) grass.push([x + 0.15 + r() * 0.7, y + 0.15 + r() * 0.7, 0.6 + r() * 0.6, r() * Math.PI]);
      for (let k = 0, n = bed ? 3 : 1; k < n; k++) {
        if (r() > (bed ? 0.9 : pf)) continue;
        const fx = x + 0.12 + r() * 0.76, fy = y + 0.12 + r() * 0.76, h = 0.18 + r() * 0.22;
        heads.push(new THREE.Vector3(fx, h, fy)); stems.push([fx, fy, h]);
      }
    }
  }
  // 草叢：兩片交叉的草葉貼圖
  const bm = patchLM(new THREE.MeshLambertMaterial({ map: bladeTex, alphaTest: 0.45, side: THREE.DoubleSide }));
  bm.userData.own = true;
  const bg = geo('tuft', () => {
    const a = new THREE.PlaneGeometry(0.6, 0.42), b = new THREE.PlaneGeometry(0.6, 0.42);
    a.translate(0, 0.21, 0); b.translate(0, 0.21, 0); b.rotateY(Math.PI / 2);
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, new THREE.Float32BufferAttribute([...a.attributes[k].array, ...b.attributes[k].array], a.attributes[k].itemSize));
    const ia = [...a.index.array], ib = [...b.index.array].map(i => i + a.attributes.position.count);
    g.setIndex([...ia, ...ib]);
    return g;
  });
  const tufts = new THREE.InstancedMesh(bg, bm, grass.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
  grass.forEach(([x, z, k, a], i) => { q.setFromAxisAngle(UP, a); s.set(k, k, k); pos.set(x, 0, z); mtx.compose(pos, q, s); tufts.setMatrixAt(i, mtx); });
  tufts.computeBoundingSphere();
  houseGroup.add(tufts);
  // 小花：綠色的莖＋彩色的花
  const sm = lm('#4f8a3a');
  const st = new THREE.InstancedMesh(geo('dstem', () => new THREE.CylinderGeometry(0.008, 0.01, 1, 4)), sm, stems.length);
  stems.forEach(([x, z, h], i) => { mtx.compose(pos.set(x, h / 2, z), q.identity(), s.set(1, h, 1)); st.setMatrixAt(i, mtx); });
  st.computeBoundingSphere();
  houseGroup.add(st);
  addInstancedFlowers(heads, 0.045, ['#ff9ec8', '#fff3a8', '#ffffff', '#b8d8ff', '#ffb070', '#d8a8ff']);
  decoFlowers.push(...heads);
  // 萬物甦醒：花上長出眼睛（會轉過來看著你）
  const em = ownLM('#ffffff', { map: flowerEyeTex, emissive: 0x3a2a2a });
  flowerEyes = new THREE.InstancedMesh(geo('feye', () => new THREE.SphereGeometry(0.055, 10, 8)), em, heads.length);
  flowerEyes.visible = false; flowerEyes.frustumCulled = false;
  houseGroup.add(flowerEyes);
  // 萬物甦醒：樹牆上冒出眼睛
  const eyes = [];
  for (const [x, y] of wallList) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inMap(nx, ny) || tiles[ny][nx] === 0 || r() > 0.35) continue;
      const along = r() - 0.5;
      eyes.push(x + 0.5 + dx * 0.53 + (dy ? along * 0.8 : 0), 0.5 + r() * 1.9, y + 0.5 + dy * 0.53 + (dx ? along * 0.8 : 0));
    }
  }
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(eyes, 3));
  wallEyes = new THREE.Points(eg, new THREE.PointsMaterial({ map: wallEyeTex, size: 0.32, transparent: true, depthWrite: false, fog: false }));
  wallEyes.material.userData.own = true; wallEyes.userData.ownGeo = true;
  wallEyes.visible = false;
  houseGroup.add(wallEyes);
}
// 萬物甦醒的夜晚：天花板的雲睜開眼睛、牆上和花上冒出眼睛
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();
function updateAwaken(t, dark) {
  if (!isW2() || !ceilMat) return;
  const on = !!(G.ev && G.ev.blood && G.phase === 'night' && mode !== 'title');
  // 晚上天花板的藍天變成深藍紫色（就算有燈照著也是夜空）
  const k = clamp(dark / NIGHT_DARK, 0, 1);
  ceilMat.color.setRGB(1 - 0.62 * k, 1 - 0.66 * k, 1 - 0.38 * k);
  ceilMat.emissive.setRGB(on ? 0.55 : 0, on ? 0.3 : 0, on ? 0.45 : 0);
  if (wallEyes) { wallEyes.visible = on; if (on) wallEyes.material.opacity = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.7)); }
  if (flowerEyes) {
    flowerEyes.visible = on;
    if (on) {
      const p = G.p;
      decoFlowers.forEach((h, i) => {
        _e.set(-Math.atan2(EYE - h.y, Math.max(0.3, Math.hypot(p.x - h.x, p.y - h.z))) * 0.6, Math.atan2(p.x - h.x, p.y - h.z), 0, 'YXZ');
        _q.setFromEuler(_e);
        _m4.compose(_v.set(h.x, h.y + 0.02, h.z), _q, _one);
        flowerEyes.setMatrixAt(i, _m4);
      });
      flowerEyes.instanceMatrix.needsUpdate = true;
    }
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
    const g = new THREE.Group(); g.position.set(f.x, 0, f.y); houseGroup.add(g);
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
    if (!gardenFurniture(f, g, r, W, D, side, len, cabinet)) switch (f.type) {
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
// ====================================================================
// 第二世界的家具：同一個位置、同樣大小，換成花園裡的東西
// ====================================================================
function gardenFurniture(f, g, r, W, D, side, len, cabinet) {
  const w2 = isW2();
  if (!w2 && f.type !== 'flowerbed') return false;
  const wood = lm('#9a7650'), dark = lm('#5e4633'), stone = lm('#b3aea3'), stone2 = lm('#97928a');
  const bark = lm('#6b4a2e'), leaf = lm('#4f8f45'), white = lm('#f2f0ea'), hole = lm('#140c08');
  const ownCloth = () => { const m = patchLM(new THREE.MeshLambertMaterial({ map: clothTex })); m.userData.own = true; return m; };
  switch (f.type) {
    case 'flowerbed': {
      const t = canvasTex(128, 128, (c) => {
        c.fillStyle = '#6b4a30'; c.fillRect(0, 0, 128, 128);
        for (let i = 0; i < 220; i++) { c.fillStyle = 'rgba(0,0,0,.15)'; c.fillRect(rnd() * 128, rnd() * 128, 2, 2); }
        const cols = [f.color, '#ffffff', '#fff3a8', f.color];
        for (let i = 0; i < 80; i++) {
          const x = 6 + rnd() * 116, y = 6 + rnd() * 116;
          c.fillStyle = '#4f8f45'; c.fillRect(x - 1, y, 2, 5);
          c.fillStyle = cols[(rnd() * cols.length) | 0]; c.beginPath(); c.arc(x, y, 3 + rnd() * 2.5, 0, 7); c.fill();
        }
        c.strokeStyle = 'rgba(210,200,180,.95)'; c.lineWidth = 6; c.strokeRect(3, 3, 122, 122);
      });
      const mat = patchLM(new THREE.MeshLambertMaterial({ map: t })); mat.userData.own = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, D - 0.2), mat); m.userData.ownGeo = true;
      m.rotation.x = -Math.PI / 2; m.position.set(W / 2, 0.008, D / 2); m.receiveShadow = true; g.add(m);
      return true;
    }
    case 'mailbox': { // 一排粉彩色的信箱
      const cols = ['#ff9ec8', '#8cc8ff', '#ffe27a', '#9be8b0'], n = Math.max(1, Math.round(len));
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) * len / n;
        fb(g, f, side, u - 0.04, u + 0.04, 0, 0.95, 0.46, 0.54, wood);
        fb(g, f, side, u - 0.2, u + 0.2, 0.95, 1.25, 0.25, 0.75, lm(cols[i % 4]));
        fb(g, f, side, u - 0.15, u + 0.15, 1.04, 1.12, 0.22, 0.25, lm('#3a3040'), false);
        fb(g, f, side, u + 0.2, u + 0.23, 1.12, 1.42, 0.55, 0.6, lm('#e2394a'), false);
      }
      r.top = 1.3;
      return true;
    }
    case 'bench': { // 公園長椅
      const iron = lm('#2f3a33');
      for (const v0 of [0.12, 0.26, 0.4]) fb(g, f, side, 0.1, len - 0.1, 0.42, 0.47, v0, v0 + 0.12, wood);
      for (const y0 of [0.6, 0.76]) fb(g, f, side, 0.1, len - 0.1, y0, y0 + 0.11, 0.62, 0.68, wood);
      for (const u of [0.35, len - 0.35]) { fb(g, f, side, u - 0.04, u + 0.04, 0, 0.42, 0.14, 0.52, iron); fb(g, f, side, u - 0.04, u + 0.04, 0, 0.92, 0.64, 0.7, iron); }
      r.top = 0.95;
      return true;
    }
    case 'stump': // 樹樁
      for (const x of [0.5, W - 0.5]) { cyl(g, 0.3, 0.36, 0.45, x, 0, D / 2, bark, 12); cyl(g, 0.29, 0.29, 0.01, x, 0.45, D / 2, lm('#d9b88a'), 12); }
      r.top = 0.46;
      return true;
    case 'log': { // 倒下來的樹幹，正面有一個樹洞
      const L = Math.max(W, D), m = cyl(g, 0.38, 0.4, L - 0.1, 0, 0, 0, bark, 12);
      if (D >= W) m.rotation.x = Math.PI / 2; else m.rotation.z = Math.PI / 2;
      m.position.set(W / 2, 0.4, D / 2);
      fb(g, f, side, len / 2 - 0.22, len / 2 + 0.22, 0.22, 0.6, 0.06, 0.11, hole, false);
      for (let i = 0; i < 4; i++) sph(g, 0.15, W / 2 + (rnd() - 0.5) * 0.3, 0.78, D / 2 + (rnd() - 0.5) * (L - 0.8), leaf, 1, 0.55, 1, 8);
      r.top = 0.85;
      return true;
    }
    case 'bigflower': { // 比人還高的大花
      cyl(g, 0.03, 0.04, 1.1, 0.5, 0, 0.5, lm('#4f8a3a'), 8);
      for (const s of [-1, 1]) { const lf = sph(g, 0.16, 0.5 + s * 0.14, 0.45, 0.5, leaf, 1, 0.25, 0.55, 8); lf.rotation.z = s * 0.5; }
      const pm = lm(f.color || '#ff9ec8');
      for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, p = sph(g, 0.13, 0.5 + Math.cos(a) * 0.15, 1.15, 0.5 + Math.sin(a) * 0.15, pm, 1, 0.35, 0.6, 8); p.rotation.y = -a; }
      sph(g, 0.09, 0.5, 1.17, 0.5, lm('#ffe066'), 1, 0.6, 1, 10);
      r.top = 1.25;
      return true;
    }
    case 'vending': { // 粉紅色的自動販賣機
      box(g, 0.08, W - 0.08, 0, 1.9, 0.08, D - 0.08, lm('#f2a6c4'));
      fb(g, f, side, 0.15, len - 0.55, 0.75, 1.75, 0, 0.02, ownLM('#bfe6ff', { emissive: 0x24404e }), false);
      const cans = ['#e2394a', '#4da3ff', '#7ee081', '#ffd166', '#c38bff'];
      for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) fb(g, f, side, 0.22 + i * 0.27, 0.34 + i * 0.27, 0.85 + row * 0.3, 1.03 + row * 0.3, -0.02, 0, lm(cans[(row * 4 + i) % 5]), false);
      fb(g, f, side, len - 0.45, len - 0.2, 1.1, 1.4, -0.02, 0, lm('#3a3040'), false);
      fb(g, f, side, 0.2, len - 0.6, 0.18, 0.4, -0.02, 0, lm('#2a2226'), false);
      r.top = 1.9;
      return true;
    }
    case 'picnicbox': // 蓋著紅白格子布的野餐箱
      box(g, 0.08, W - 0.08, 0, 0.62, 0.1, D - 0.1, lm('#a8784a'));
      for (const u of [0.3, len - 0.3]) fb(g, f, side, u - 0.03, u + 0.03, 0.05, 0.6, -0.01, 0.01, dark, false);
      box(g, 0.02, W - 0.02, 0.62, 0.66, 0.04, D - 0.04, ownCloth());
      r.top = 0.66;
      return true;
    case 'grill': { // 烤肉架
      const blk = lm('#2b2b30');
      for (const x of [0.55, W - 0.55]) {
        for (const [dx, dz] of [[-0.18, -0.15], [0.18, -0.15], [0, 0.2]]) limb(g, [x + dx, 0, D / 2 + dz], [x, 0.55, D / 2], 0.02, blk);
        sph(g, 0.3, x, 0.68, D / 2, blk, 1, 0.5, 1, 12);
        cyl(g, 0.29, 0.29, 0.02, x, 0.7, D / 2, lm('#77777c'), 14);
      }
      r.top = 0.8;
      return true;
    }
    case 'baskets': { // 小桌子上放著野餐籃
      box(g, 0.05, W - 0.05, 0.5, 0.56, 0.08, D - 0.08, wood);
      for (const [x, z] of [[0.15, 0.15], [W - 0.15, 0.15], [0.15, D - 0.15], [W - 0.15, D - 0.15]]) box(g, x - 0.03, x + 0.03, 0, 0.5, z - 0.03, z + 0.03, wood);
      const bm = lm('#c9965a');
      for (let i = 0; i < Math.round(W); i++) {
        box(g, 0.25 + i, 0.75 + i, 0.56, 0.84, 0.25, D - 0.25, bm);
        const h = new THREE.Mesh(geo('bhandle', () => new THREE.TorusGeometry(0.2, 0.02, 6, 14, Math.PI)), bm); h.position.set(0.5 + i, 0.84, D / 2); g.add(h);
      }
      r.top = 1.05;
      return true;
    }
    case 'tap': // 石頭洗手台
      box(g, 0.15, W - 0.15, 0, 0.75, 0.15, D - 0.15, stone);
      box(g, 0.3, W - 0.3, 0.7, 0.76, 0.3, D - 0.3, lm('#7fb8d6'), false);
      fb(g, f, side, len / 2 - 0.04, len / 2 + 0.04, 0.75, 1.15, 0.72, 0.8, lm('#9aa5ab'));
      fb(g, f, side, len / 2 - 0.04, len / 2 + 0.04, 1.08, 1.14, 0.52, 0.8, lm('#9aa5ab'));
      r.top = 1.15;
      return true;
    case 'picnic': // 野餐桌和兩條長椅
      box(g, 0.1, W - 0.1, 0.72, 0.78, 0.5, D - 0.5, wood);
      for (const z of [0.15, D - 0.15]) box(g, 0.2, W - 0.2, 0.42, 0.47, z - 0.13, z + 0.13, wood);
      for (const x of [0.5, W - 0.5]) { box(g, x - 0.05, x + 0.05, 0, 0.72, 0.6, D - 0.6, dark); box(g, x - 0.05, x + 0.05, 0, 0.42, 0.05, D - 0.05, dark); }
      box(g, 0.9, W - 0.9, 0.78, 0.785, 0.55, D - 0.55, ownCloth(), false);
      r.top = 0.8;
      return true;
    case 'pots': { // 放著花盆的木架
      for (const y of [0.05, 0.6]) box(g, 0.05, W - 0.05, y, y + 0.05, 0.1, D - 0.1, wood);
      for (const [x, z] of [[0.1, 0.15], [W - 0.1, 0.15], [0.1, D - 0.15], [W - 0.1, D - 0.15]]) box(g, x - 0.03, x + 0.03, 0, 1.0, z - 0.03, z + 0.03, wood);
      const tc = lm('#c96a3a'), fl = ['#ff9ec8', '#fff3a8', '#c9a8ff'];
      for (const y of [0.1, 0.65]) for (let x = 0.3; x < W - 0.15; x += 0.45) { cyl(g, 0.13, 0.1, 0.22, x, y, D / 2, tc, 10); sph(g, 0.12, x, y + 0.3, D / 2, rnd() < 0.5 ? leaf : lm(fl[(rnd() * 3) | 0]), 1, 0.8, 1, 8); }
      r.top = 1.0;
      return true;
    }
    case 'crate': { // 疊起來的木箱
      const cw = lm('#a07a4e'), slat = lm('#7a5a36');
      const crate = (x0, z0, s, y0) => { box(g, x0, x0 + s, y0, y0 + s * 0.85, z0, z0 + s, cw); box(g, x0 - 0.005, x0 + s + 0.005, y0 + s * 0.38, y0 + s * 0.47, z0 - 0.005, z0 + s + 0.005, slat, false); };
      if (W >= 2 && D >= 2) { crate(0.1, 0.1, 0.85, 0); crate(1.05, 0.15, 0.8, 0); crate(0.3, 1.05, 0.8, 0); crate(0.2, 0.2, 0.6, 0.72); r.top = 1.25; }
      else { crate(0.1, 0.1, Math.min(W, D) - 0.2, 0); if (Math.max(W, D) >= 2) crate(W >= 2 ? 1.05 : 0.15, W >= 2 ? 0.15 : 1.05, 0.7, 0); r.top = 0.75; }
      return true;
    }
    case 'gardentools': // 綠色的園藝工具櫃，旁邊掛著鏟子
      cabinet(1.7, '#5f8f5a');
      fb(g, f, side, 0.3, 0.35, 0.3, 1.5, -0.04, -0.01, lm('#8a6a4a'), false);
      fb(g, f, side, 0.2, 0.45, 0.15, 0.4, -0.05, -0.02, lm('#9aa5ab'), false);
      return true;
    case 'smallcab':
      cabinet(f.id === 'dresser' ? 1.0 : 0.6, '#c9a27a');
      return true;
    case 'clothesline': { // 曬衣繩、掛著的衣服、地上的曬衣籃
      for (const u of [0.15, len - 0.15]) fb(g, f, side, u - 0.04, u + 0.04, 0, 1.9, 0.5, 0.58, wood);
      fb(g, f, side, 0.15, len - 0.15, 1.82, 1.84, 0.53, 0.55, lm('#eeeeee'), false);
      const cl = ['#ff9ec8', '#8cc8ff', '#ffffff', '#ffe27a'];
      for (let i = 0; i < 4; i++) { const u = 0.45 + i * (len - 0.9) / 3; fb(g, f, side, u - 0.17, u + 0.17, 1.3, 1.82, 0.52, 0.56, lm(cl[i]), false); }
      fb(g, f, side, len / 2 - 0.35, len / 2 + 0.35, 0, 0.32, 0.12, 0.72, lm('#c9965a'));
      r.top = 0.4;
      return true;
    }
    case 'birdbath': // 鳥浴盆
      cyl(g, 0.12, 0.16, 0.75, 0.5, 0, 0.5, stone, 10);
      cyl(g, 0.38, 0.2, 0.12, 0.5, 0.75, 0.5, stone, 16);
      cyl(g, 0.33, 0.33, 0.01, 0.5, 0.86, 0.5, lm('#8fc8e8'), 16);
      r.top = 0.88;
      return true;
    case 'firstaid': // 掛在柱子上的白色急救箱
      fb(g, f, side, len / 2 - 0.05, len / 2 + 0.05, 0, 1.1, 0.45, 0.55, wood);
      fb(g, f, side, len / 2 - 0.4, len / 2 + 0.4, 1.0, 1.6, 0.3, 0.6, white);
      fb(g, f, side, len / 2 - 0.05, len / 2 + 0.05, 1.12, 1.48, 0.27, 0.3, lm('#d7263d'), false);
      fb(g, f, side, len / 2 - 0.18, len / 2 + 0.18, 1.25, 1.35, 0.27, 0.3, lm('#d7263d'), false);
      r.top = 1.6;
      return true;
    case 'fountain': // 噴水池
      box(g, 0.05, W - 0.05, 0, 0.45, 0.05, 0.25, stone); box(g, 0.05, W - 0.05, 0, 0.45, D - 0.25, D - 0.05, stone);
      box(g, 0.05, 0.25, 0, 0.45, 0.25, D - 0.25, stone); box(g, W - 0.25, W - 0.05, 0, 0.45, 0.25, D - 0.25, stone);
      box(g, 0.25, W - 0.25, 0.3, 0.36, 0.25, D - 0.25, ownLM('#8fd0f0', { emissive: 0x0a2a3a }), false);
      cyl(g, 0.12, 0.16, 0.9, W / 2, 0.3, D / 2, stone2, 12);
      cyl(g, 0.4, 0.15, 0.14, W / 2, 1.2, D / 2, stone2, 16);
      cyl(g, 0.34, 0.34, 0.01, W / 2, 1.33, D / 2, lm('#8fd0f0'), 16);
      r.top = 1.35;
      return true;
    case 'hollow': // 三棵靠在一起的大樹，中間那棵有樹洞
      for (let i = 0; i < 3; i++) cyl(g, 0.4, 0.46, WALL_H, (i + 0.5) * W / 3, 0, D / 2, bark, 12);
      fb(g, f, side, len / 2 - 0.22, len / 2 + 0.22, 0.5, 1.15, 0, 0.07, hole, false);
      r.top = 1.2;
      return true;
    case 'stonetable': // 石桌，上面放著書
      box(g, 0.05, W - 0.05, 0.68, 0.8, 0.05, D - 0.05, stone);
      for (const x of [0.4, W - 0.4]) box(g, x - 0.2, x + 0.2, 0, 0.68, 0.2, D - 0.2, stone2);
      box(g, 0.5, 0.85, 0.8, 0.86, 0.3, 0.6, lm('#eeeeee')); box(g, 1.3, 1.6, 0.8, 0.9, 0.3, 0.7, lm('#b0463c')); box(g, W - 0.9, W - 0.65, 0.8, 0.88, 0.3, 0.6, lm('#3a6ea5'));
      r.top = 0.9;
      return true;
    case 'rootbox': { // 被樹根纏住的木箱
      box(g, 0.1, W - 0.1, 0, 0.5, 0.12, D - 0.12, lm('#6b3f22'));
      box(g, 0.08, W - 0.08, 0.5, 0.6, 0.1, D - 0.1, lm('#5a331b'));
      for (let i = 0; i < 3; i++) { const x = 0.3 + i * (W - 0.6) / 2; limb(g, [x, 0, 0.04], [x + 0.08, 0.63, D / 2], 0.035, bark); limb(g, [x + 0.08, 0.63, D / 2], [x - 0.04, 0, D - 0.04], 0.03, bark); }
      r.top = 0.66;
      return true;
    }
    case 'scarecrow': { // 稻草人：頭會轉過來看你
      limb(g, [0.5, 0, 0.5], [0.5, 1.7, 0.5], 0.035, wood);
      limb(g, [0.05, 1.3, 0.5], [0.95, 1.3, 0.5], 0.03, wood);
      const body = new THREE.Mesh(geo('scbody', () => new THREE.ConeGeometry(0.22, 0.75, 10)), lm('#4a6ea8')); body.position.set(0.5, 1.05, 0.5); body.castShadow = true; g.add(body);
      for (const s of [-1, 1]) sph(g, 0.06, 0.5 + s * 0.45, 1.27, 0.5, lm('#e8c860'), 1.4, 0.6, 1, 6);
      r.head = new THREE.Group(); r.head.position.set(0.5, 1.62, 0.5); g.add(r.head);
      sph(r.head, 0.16, 0, 0, 0, lm('#d8c08a'));
      for (const ex of [-0.055, 0.055]) sph(r.head, 0.026, ex, 0.02, 0.145, ownBasic({ color: 0x111111 }), 1, 1, 0.5, 6);
      box(r.head, -0.07, 0.07, -0.06, -0.05, 0.13, 0.16, lm('#5a2a1a'), false);
      cyl(r.head, 0.24, 0.24, 0.02, 0, 0.12, 0, lm('#a07a3a'), 14); cyl(r.head, 0.11, 0.13, 0.14, 0, 0.13, 0, lm('#a07a3a'), 12);
      r.top = 1.8;
      return true;
    }
    case 'roots': // 從天花板長下來的大樹根
      cyl(g, 0.45, 0.6, WALL_H, W / 2, 0, D / 2, bark, 12);
      for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; limb(g, [W / 2 + Math.cos(a) * 0.4, 0.8 + rnd() * 0.6, D / 2 + Math.sin(a) * 0.4], [W / 2 + Math.cos(a) * 0.95, 0.02, D / 2 + Math.sin(a) * 1.3], 0.08, bark); }
      r.top = 1.5;
      return true;
    case 'toybox': // 玩具箱
      box(g, 0.15, W - 0.15, 0, 0.5, 0.15, D - 0.15, lm('#5aa0e0'));
      box(g, 0.12, W - 0.12, 0.5, 0.58, 0.12, D - 0.12, lm('#ffd166'));
      sph(g, 0.12, 0.5, 0.7, D / 2, lm('#e2394a'), 1, 1, 1, 10); box(g, W - 0.9, W - 0.65, 0.58, 0.83, D / 2 - 0.12, D / 2 + 0.13, lm('#7ee081'));
      r.top = 0.85;
      return true;
    case 'toyshelf': { // 放著積木和球的白色架子
      for (const y of [0.05, 0.65, 1.25]) box(g, 0.05, W - 0.05, y, y + 0.05, 0.1, D - 0.1, white);
      for (const [x, z] of [[0.1, 0.15], [W - 0.1, 0.15], [0.1, D - 0.15], [W - 0.1, D - 0.15]]) box(g, x - 0.03, x + 0.03, 0, 1.3, z - 0.03, z + 0.03, white);
      const tc = ['#e2394a', '#4da3ff', '#ffd166', '#7ee081', '#c38bff'];
      for (const y of [0.1, 0.7]) for (let x = 0.3; x < W - 0.15; x += 0.5) {
        if (rnd() < 0.5) sph(g, 0.14, x, y + 0.14, D / 2, lm(tc[(rnd() * 5) | 0]), 1, 1, 1, 10);
        else box(g, x - 0.14, x + 0.14, y, y + 0.28, D / 2 - 0.14, D / 2 + 0.14, lm(tc[(rnd() * 5) | 0]));
      }
      r.top = 1.3;
      return true;
    }
    case 'slide': { // 沒有人的遊樂場：溜滑梯
      const red = lm('#e2394a'), yel = lm('#ffd166'), blue = lm('#4da3ff'), metal = lm('#c9ced4');
      box(g, 0.6, 1.6, 1.35, 1.45, 0.8, D - 0.8, yel);
      for (const [x, z] of [[0.65, 0.85], [1.55, 0.85], [0.65, D - 0.85], [1.55, D - 0.85]]) box(g, x - 0.05, x + 0.05, 0, 2.1, z - 0.05, z + 0.05, blue);
      box(g, 0.55, 1.65, 2.1, 2.2, 0.75, D - 0.75, red);
      for (const z of [0.95, D - 0.95]) limb(g, [0.1, 0, z], [0.6, 1.4, z], 0.035, metal);
      for (let k = 1; k < 6; k++) { const t = k / 6; limb(g, [0.1 + t * 0.5, t * 1.4, 0.95], [0.1 + t * 0.5, t * 1.4, D - 0.95], 0.025, metal); }
      const sl = new THREE.Mesh(BOX, red); sl.scale.set(3.45, 0.06, 0.9); sl.position.set(3.2, 0.78, D / 2); sl.rotation.z = -0.386; sl.castShadow = true; g.add(sl);
      for (const z of [D / 2 - 0.47, D / 2 + 0.47]) { const rl = new THREE.Mesh(BOX, yel); rl.scale.set(3.45, 0.15, 0.05); rl.position.set(3.2, 0.86, z); rl.rotation.z = -0.386; g.add(rl); }
      r.top = 2.2;
      return true;
    }
    case 'well': { // 石頭水井
      const cx = W / 2, cz = D / 2;
      cyl(g, 0.45, 0.48, 0.75, cx, 0, cz, stone, 16);
      cyl(g, 0.38, 0.38, 0.01, cx, 0.75, cz, lm('#0a0f14'), 16);
      for (const s of [-1, 1]) box(g, cx + s * 0.5 - 0.04, cx + s * 0.5 + 0.04, 0, 1.6, cz - 0.04, cz + 0.04, wood);
      for (const s of [-1, 1]) { const rf = new THREE.Mesh(BOX, lm('#8a3a2a')); rf.scale.set(1.3, 0.05, 0.5); rf.position.set(cx, 1.68, cz + s * 0.2); rf.rotation.x = s * 0.6; g.add(rf); }
      limb(g, [cx - 0.5, 1.35, cz], [cx + 0.5, 1.35, cz], 0.03, wood);
      cyl(g, 0.1, 0.08, 0.15, cx, 1.0, cz, lm('#9aa5ab'), 10);
      r.top = 0.8;
      return true;
    }
    case 'buckets': // 水桶
      for (const [x, z, s] of [[0.5, 0.5, 1], [1.35, 0.42, 0.85], [1.05, 0.72, 0.7]]) { cyl(g, 0.2 * s, 0.16 * s, 0.32 * s, x, 0, z, lm('#9aa5ab'), 12); cyl(g, 0.17 * s, 0.17 * s, 0.01, x, 0.31 * s, z, lm('#6fa8d6'), 12); }
      r.top = 0.35;
      return true;
    case 'phone': { // 第二世界：紅色電話亭
      const red = lm('#d4263a'), glass = ownLM('#cfe8ff', { transparent: true, opacity: 0.3, depthWrite: false });
      for (const [x, z] of [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) box(g, x - 0.05, x + 0.05, 0, 2.3, z - 0.05, z + 0.05, red);
      box(g, 0.02, 0.98, 2.3, 2.45, 0.02, 0.98, red);
      for (const [x0, x1, z0, z1] of [[0.12, 0.88, 0.08, 0.1], [0.12, 0.88, 0.9, 0.92], [0.08, 0.1, 0.12, 0.88], [0.9, 0.92, 0.12, 0.88]]) box(g, x0, x1, 0.25, 2.2, z0, z1, glass, false);
      box(g, 0.38, 0.62, 1.0, 1.35, 0.4, 0.6, lm('#2a2226'));
      r.handset = ownLM('#8a2020');
      box(g, 0.36, 0.64, 1.35, 1.41, 0.42, 0.58, r.handset, false);
      r.top = 2.45;
      return true;
    }
    case 'workbench': // 第二世界：石頭工作台
      box(g, 0.02, W - 0.02, 0.78, 0.92, 0.05, D - 0.05, stone);
      for (const x of [0.3, W - 0.3]) box(g, x - 0.18, x + 0.18, 0, 0.78, 0.2, D - 0.2, stone2);
      box(g, 0.4, 0.75, 0.92, 0.95, 0.3, 0.6, lm('#8a6a4a')); sph(g, 0.06, 1.2, 0.98, 0.5, lm('#ffe7a8')); box(g, 1.5, 1.8, 0.92, 1.0, 0.35, 0.6, lm('#9aa5ab'));
      r.top = 1.0;
      return true;
  }
  return false;
}
function updateFurniture(t) {
  const ev = G.ev, p = G.p;
  const cl = furn3d.closet;
  const rattling = ev.closet > 0;
  if (cl && cl.doors) {
    cl.gap.visible = rattling;
    cl.doors.position.x = rattling ? Math.sin(t * 45) * 0.012 * (1 + (18 - ev.closet) / 6) : 0;
    cl.g.rotation.z = rattling ? Math.sin(t * 38) * 0.004 : 0;
  }
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
  // 電視自己打開時顯示雜訊（第二世界沒有電視）
  if (furn3d.tvcab && furn3d.tvcab.screen) {
    const scr = furn3d.tvcab.screen.material;
    if (G.ev.tvOn) { drawStatic(); scr.color.setRGB(1, 1, 1); } else scr.color.set(0x0a0d14);
  }
  // 敲門時門在震；破關動畫時門往外打開，門外透出光
  if (frontDoorPanel) {
    frontDoorPanel.position.x = ev.knock > 0 && ev.knockTick > 1.9 ? Math.sin(t * 60) * 0.015 : 0;
    const k = mode === 'cutscene' && CUT && !CUT.switched ? CUT.doorK : 0;
    frontDoorPanel.rotation.y = -k * 1.45;
    if (doorGlow) { doorGlow.visible = k > 0.01; doorGlow.userData.sprite.material.opacity = 0.6 + 0.4 * k; }
  }
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
  { metal: '#e8fff0', edge: '#3fbf6a' },
];
const fixMap = new Map();
function setSRGB(color, c, k = 1) { color.setRGB(c[0] / 255 * k, c[1] / 255 * k, c[2] / 255 * k, SRGB); }
// 第二世界的花燈泡（繡球花）、樹燈泡（楓樹）、水燈泡（水滴）：發光的部分放進 res.bulbs 一起變色
function addGardenBulb(res, g, x, y, z, tier, s) {
  const glow = () => ownBasic({ color: 0xffffff, fog: false });
  const grp = new THREE.Group(); grp.position.set(x, y, z); grp.scale.setScalar(s); g.add(grp);
  if (tier === 6) {
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, m = new THREE.Mesh(geo('petal', () => new THREE.SphereGeometry(0.045, 8, 6)), glow()); m.position.set(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05); m.scale.set(1, 0.45, 0.7); m.rotation.y = -a; grp.add(m); res.bulbs.push(m); }
    const c = new THREE.Mesh(geo('pcenter', () => new THREE.SphereGeometry(0.03, 8, 6)), glow()); grp.add(c); res.bulbs.push(c);
  } else if (tier === 7) {
    const trunk = new THREE.Mesh(geo('btrunk', () => new THREE.CylinderGeometry(0.012, 0.018, 0.09, 6)), lm('#6b4a2e')); trunk.position.y = -0.06; grp.add(trunk);
    for (const [px, py, pr] of [[0, 0.02, 0.055], [-0.04, -0.005, 0.04], [0.04, -0.005, 0.04]]) { const m = new THREE.Mesh(geo('bcan' + pr, () => new THREE.SphereGeometry(pr, 10, 8)), glow()); m.position.set(px, py, 0); grp.add(m); res.bulbs.push(m); }
  } else {
    const d = new THREE.Mesh(geo('drop', () => new THREE.SphereGeometry(0.055, 12, 10)), glow()); d.position.y = -0.01; grp.add(d); res.bulbs.push(d);
    const tip = new THREE.Mesh(geo('droptip', () => new THREE.ConeGeometry(0.039, 0.07, 12)), glow()); tip.position.y = 0.055; grp.add(tip); res.bulbs.push(tip);
  }
  const halo = ownSprite(glowTex, 0xffffff);
  halo.position.set(x, y, z); halo.scale.setScalar((0.45 + tier * 0.09) * s);
  g.add(halo); res.halos.push(halo);
}
function addBulb(res, g, x, y, z, tier, s = 1) {
  if (!tier) { sph(g, 0.045 * s, x, y, z, lm('#2b2b2e'), 1, 1, 1, 8); return; }
  if (isW2() && tier >= 6 && tier <= 8) { addGardenBulb(res, g, x, y, z, tier, s); return; }
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
    const garden = isW2() && tier <= 8; // 第二世界：繞著轉的是花瓣、紅葉、水滴
    res.gems = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      const m = ownBasic({ color: 0xffffff, fog: false });
      let o;
      if (tier === FIRE_TIER) o = sph(res.spin, 0.03, Math.cos(a) * 0.19, 0, Math.sin(a) * 0.19, m, 1, 1, 1, 8);
      else if (garden) { o = sph(res.spin, 0.032, Math.cos(a) * 0.23, Math.sin(a * 3) * 0.02, Math.sin(a) * 0.23, m, tier === 8 ? 0.7 : 1, tier === 8 ? 1.5 : 0.35, tier === 8 ? 0.7 : 0.7, 8); o.rotation.y = -a; }
      else o = octa(res.spin, 0.034, Math.cos(a) * 0.23, 0, Math.sin(a) * 0.23, m);
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
    const key = `${curWorld}:${o.type}:${o.bulb}:${o.x},${o.y}`;
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
// ---------- 第二世界：草叢人、大嘴觸角蟲、眼花女孩 ----------
// 草叢人：平常只看得到一叢會動的長草；站起來時，長長的身體和臉從草裡升上來
function buildGrass(r, g) {
  const bm = ownLM('#ffffff', { map: bladeTex, alphaTest: 0.45, side: THREE.DoubleSide, transparent: true });
  r.tuft = new THREE.Group(); g.add(r.tuft);
  for (let i = 0; i < 3; i++) {
    const pl = new THREE.Mesh(geo('gtuft', () => new THREE.PlaneGeometry(0.95, 0.85)), bm);
    pl.position.y = 0.42; pl.rotation.y = i / 3 * Math.PI; r.tuft.add(pl);
  }
  r.body = new THREE.Group(); g.add(r.body);
  const skin = ownLM('#8c8a6a', { transparent: true }), streak = ownLM('#a4323a', { transparent: true });
  cyl(r.body, 0.11, 0.15, 1.25, 0, 0, 0, skin, 8);
  limb(r.body, [0.06, 0.4, 0.13], [0.04, 1.1, 0.14], 0.02, streak);
  for (const s of [-1, 1]) { limb(r.body, [s * 0.13, 1.1, 0.02], [s * 0.3, 0.75, 0.25], 0.03, skin); limb(r.body, [s * 0.3, 0.75, 0.25], [s * 0.22, 0.45, 0.45], 0.025, skin); }
  const faceMat = ownBasic({ map: grassFaceTex, transparent: true, alphaTest: 0.3, color: 0xc9c3b0 });
  r.face = new THREE.Mesh(geo('grassface', () => new THREE.PlaneGeometry(0.62, 0.62)), faceMat);
  r.face.position.set(0, 1.5, 0.08); r.body.add(r.face);
  r.mats.push(bm, skin, streak, faceMat);
}
// 大嘴觸角蟲：粉紅色的大肉團、4 根長著眼睛的觸角、滿口尖牙的大嘴、身體下面一排小芽
function buildSnail(r, g) {
  const skin = ownLM('#e8a2b2', { transparent: true }), skin2 = ownLM('#d98c9c', { transparent: true });
  const eye = ownLM('#ffffff', { map: flowerEyeTex, emissive: 0x2a1a1a, transparent: true });
  r.body = new THREE.Group(); g.add(r.body);
  sph(r.body, 0.5, 0, 0.36, -0.1, skin, 0.85, 0.62, 1.25, 16);
  sph(r.body, 0.36, 0, 0.42, 0.32, skin2, 0.95, 0.85, 0.75, 14);
  const faceMat = ownBasic({ map: snailFaceTex, transparent: true, alphaTest: 0.3, color: 0xd9c9c9 });
  r.face = new THREE.Mesh(geo('snailface', () => new THREE.PlaneGeometry(0.78, 0.68)), faceMat);
  r.face.position.set(0, 0.42, 0.6); r.face.rotation.x = -0.1; r.body.add(r.face);
  r.stalks = new THREE.Group(); r.stalks.position.set(0, 0.62, 0.12); r.body.add(r.stalks);
  for (const [x, z] of [[-0.3, 0.1], [-0.12, 0.2], [0.12, 0.2], [0.3, 0.1]]) {
    limb(r.stalks, [x * 0.5, 0, 0], [x, 0.45, z], 0.025, skin2);
    const e = new THREE.Mesh(geo('stalkeye', () => new THREE.SphereGeometry(0.065, 10, 8)), eye); e.position.set(x, 0.48, z); r.stalks.add(e);
  }
  const sprout = ownLM('#efe6d6', { transparent: true }), stem = ownLM('#7a8a6a', { transparent: true });
  for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; limb(r.body, [Math.cos(a) * 0.55, 0, Math.sin(a) * 0.62 - 0.1], [Math.cos(a) * 0.58, 0.12, Math.sin(a) * 0.66 - 0.1], 0.01, stem); sph(r.body, 0.035, Math.cos(a) * 0.58, 0.14, Math.sin(a) * 0.66 - 0.1, sprout, 1, 1, 1, 6); }
  r.mats.push(skin, skin2, eye, faceMat, sprout, stem);
}
// 眼花女孩：藍色上衣和百褶裙、流血的眼睛、眼睛裡長出開著眼球花的樹枝
function buildGirl(r, g) {
  const top = ownLM('#5f7fae', { transparent: true }), skirt = ownLM('#4a5f84', { transparent: true }), skin = ownLM('#d8cfc4', { transparent: true });
  const blood = ownLM('#a3121c', { transparent: true }), branch = ownLM('#5c3a22', { transparent: true }), petal = ownLM('#e88aa8', { transparent: true });
  const eye = ownLM('#ffffff', { map: flowerEyeTex, emissive: 0x2a1a1a, transparent: true });
  for (const s of [-1, 1]) limb(g, [s * 0.08, 0, 0], [s * 0.08, 0.62, 0], 0.035, skin);
  const sk = new THREE.Mesh(geo('gskirt', () => new THREE.ConeGeometry(0.3, 0.45, 14, 1, true)), skirt); sk.position.y = 0.72; g.add(sk);
  cyl(g, 0.16, 0.2, 0.5, 0, 0.92, 0, top, 12);
  for (const s of [-1, 1]) { limb(g, [s * 0.2, 1.36, 0], [s * 0.26, 0.92, 0.06], 0.03, top); limb(g, [s * 0.26, 0.92, 0.06], [s * 0.27, 0.68, 0.1], 0.025, skin); sph(g, 0.045, s * 0.27, 0.64, 0.11, blood, 1, 1, 1, 8); }
  const hairMat = ownBasic({ map: hairTex, transparent: true, alphaTest: 0.35 });
  const hair = new THREE.Mesh(geo('girlhair', () => new THREE.PlaneGeometry(0.6, 0.75)), hairMat); hair.position.set(0, 1.5, -0.06); g.add(hair);
  const faceMat = ownBasic({ map: girlFaceTex, transparent: true, alphaTest: 0.3, color: 0xc9c3bd });
  r.face = new THREE.Mesh(geo('girlface', () => new THREE.PlaneGeometry(0.62, 0.62)), faceMat);
  r.face.position.set(0, 1.62, 0.05); g.add(r.face);
  // 從右眼長出來的樹枝和兩顆眼球花（被手電筒照到會閉起來）
  r.blooms = [];
  limb(g, [0.06, 1.66, 0.1], [0.36, 1.9, 0.18], 0.018, branch);
  limb(g, [0.24, 1.8, 0.15], [0.42, 1.72, 0.2], 0.014, branch);
  for (const [x, y, z, s] of [[0.38, 1.94, 0.19, 1], [0.44, 1.71, 0.21, 0.8]]) {
    const bl = new THREE.Group(); bl.position.set(x, y, z); bl.scale.setScalar(s); g.add(bl);
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, p = sph(bl, 0.05, Math.cos(a) * 0.075, Math.sin(a) * 0.075, -0.01, petal, 1, 0.55, 0.4, 6); p.rotation.z = a; }
    const e = new THREE.Mesh(geo('bloomeye', () => new THREE.SphereGeometry(0.055, 10, 8)), eye); bl.add(e);
    r.blooms.push(bl);
  }
  r.mats.push(top, skirt, skin, blood, branch, petal, eye, hairMat, faceMat);
}
const NEW_BUILD = { stick: buildStick, momo: buildMomo, crawler: buildCrawler, balloon: buildBalloon, clown: buildClown, grass: buildGrass, snail: buildSnail, girl: buildGirl };

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
    case 'grass': {
      // 草叢一直在晃；站起來時身體和臉從草裡升上來
      const k = e.rise || 0;
      r.tuft.rotation.z = Math.sin(e.wob * (e.hidden ? 9 : 3)) * (e.hidden ? 0.12 : 0.05);
      r.tuft.scale.set(1, e.hidden ? 0.9 + Math.abs(Math.sin(e.wob * 7)) * 0.2 : 1, 1);
      r.body.visible = k > 0.02;
      r.body.position.y = -1.6 * (1 - k);
      r.body.rotation.x = e.state === 'lunge' ? 0.5 : e.state === 'grab' ? 0.12 + Math.sin(t * 20) * 0.04 : 0;
      r.g.position.y = 0;
      break;
    }
    case 'snail': {
      // 一伸一縮地爬；手電筒照到時觸角縮起來；咬完在嚼
      const crawl = e.retract > 0 || e.chew > 0 ? 0 : Math.sin(e.wob * 5) * 0.06;
      r.body.scale.set(1 - crawl * 0.5, 1 + crawl * 0.3, 1 + crawl);
      const st = e.retract > 0 ? 0.25 : 1;
      r.stalks.scale.y += (st - r.stalks.scale.y) * 0.2;
      r.stalks.rotation.z = Math.sin(t * 1.3) * 0.08;
      r.face.scale.y = e.chew > 0 ? 0.85 + Math.abs(Math.sin(t * 14)) * 0.25 : 1;
      r.g.position.y = 0;
      break;
    }
    case 'girl': {
      // 被手電筒照到時，樹枝上的眼球花會閉起來
      const shut = e.blind > 0 ? 0.15 : 1;
      for (const bl of r.blooms) bl.scale.y += (shut * bl.scale.x - bl.scale.y) * 0.25;
      r.face.rotation.z = e.blind > 0 ? Math.sin(t * 6) * 0.15 : Math.sin(e.wob * 0.9) * 0.06;
      r.g.position.y = Math.sin(e.wob * 1.5) * 0.03;
      break;
    }
  }
}

// 向日葵眼：粗粗的莖、一圈黃色花瓣，中間是一顆布滿血絲的大眼睛
function buildSunflower(f, g) {
  const stem = lm('#4f8a3a');
  limb(g, [0, 0, 0], [0.05, 0.6, 0], 0.035, stem);
  limb(g, [0.05, 0.6, 0], [0, 1.18, 0], 0.032, stem);
  for (const s of [-1, 1]) {
    const leaf = new THREE.Mesh(geo('leaf', () => new THREE.SphereGeometry(1, 14, 8)), leafMat);
    leaf.scale.set(0.24, 0.016, 0.1); leaf.position.set(s * 0.2, 0.55, 0); leaf.rotation.z = s * 0.45;
    g.add(leaf);
  }
  const eyeG = new THREE.Group(); eyeG.position.y = 1.32; eyeG.rotation.order = 'YXZ'; g.add(eyeG);
  const disc = new THREE.Mesh(geo('sundisc', () => new THREE.CylinderGeometry(0.25, 0.25, 0.06, 20)), lm('#6a4a1a'));
  disc.rotation.x = Math.PI / 2; eyeG.add(disc);
  const pm = ownLM('#ffffff', { map: sunPetalTex, alphaTest: 0.3, side: THREE.DoubleSide, emissive: 0x2a2205 });
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2, p = new THREE.Mesh(geo('sunpetal', () => new THREE.PlaneGeometry(0.26, 0.11)), pm);
    p.position.set(Math.cos(a) * 0.33, Math.sin(a) * 0.33, -0.01); p.rotation.z = a; eyeG.add(p);
  }
  const eyeMat = ownLM('#ffffff', { map: eyeballTex, emissive: 0x1a1414 });
  const ball = new THREE.Mesh(geo('suneye', () => new THREE.SphereGeometry(0.19, 24, 16)), eyeMat);
  ball.position.z = 0.02; eyeG.add(ball);
  const irisMat = ownLM('#ffffff', { map: irisTex, emissive: 0x141010 });
  const iris = new THREE.Mesh(geo('suniris', () => new THREE.CircleGeometry(0.085, 24)), irisMat);
  iris.position.z = 0.206; eyeG.add(iris);
  return { g, eyeG, ball, iris, eyeMat, irisMat, pm };
}
// 千眼菇：奶油色的粗菇柄、長滿眼睛的紅色菇傘，邊緣滴下藍色和紅色的水
function buildShroom(f, g) {
  cyl(g, 0.17, 0.22, 1.12, 0, 0, 0, lm('#efe6c8'), 12);
  const capMat = ownLM('#ffffff', { map: capTex, emissive: 0x200508 });
  const cap = new THREE.Mesh(geo('shcap', () => new THREE.SphereGeometry(0.72, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), capMat);
  cap.scale.y = 0.72; cap.position.y = 1.08; cap.castShadow = true; g.add(cap);
  const under = new THREE.Mesh(geo('shunder', () => new THREE.CircleGeometry(0.72, 24)), lm('#8a3a3a'));
  under.rotation.x = Math.PI / 2; under.position.y = 1.08; g.add(under);
  const drips = [];
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2 + 0.2, dm = ownBasic({ color: i % 2 ? 0x4a7ae0 : 0xd43a4a, transparent: true, opacity: 0.85 });
    const d = new THREE.Mesh(geo('drip', () => new THREE.CylinderGeometry(0.012, 0.018, 1, 5)), dm);
    d.position.set(Math.cos(a) * 0.66, 1.0, Math.sin(a) * 0.66); g.add(d);
    drips.push({ d, ph: Math.random() * 6 });
  }
  return { g, capMat, drips };
}
// 眼球花：綠色的莖和兩片葉子，花是一顆會轉過來盯著你的大眼球
const flowerMap = new Map();
function buildFlower(f) {
  const g = new THREE.Group(); g.position.set(f.x, 0, f.y); scene.add(g);
  if (f.ptype === 'sunflower') return buildSunflower(f, g);
  if (f.ptype === 'shroom') return buildShroom(f, g);
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
    if (f.ptype === 'sunflower') {
      // 轉向最亮的光（看到你的手電筒時就盯著你）；白天垂著頭睡覺
      const yaw = Math.PI / 2 - f.face;
      let dy = yaw - (r.yaw === undefined ? yaw : r.yaw);
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.yaw = (r.yaw === undefined ? yaw : r.yaw) + dy * 0.08;
      if (awake) { r.eyeG.rotation.y = r.yaw; r.eyeG.rotation.x = f.lock >= SUN_LOCK ? -Math.atan2(EYE - 1.32, Math.max(0.5, dist)) : -0.1; }
      else { r.eyeG.rotation.y = Math.sin(t * 0.3 + f.x); r.eyeG.rotation.x = 0.9; }
      const glare = f.lock >= SUN_LOCK ? 0.25 + 0.2 * Math.sin(t * 12) : 0;
      r.eyeMat.emissive.setRGB(0.1 + glare, 0.08, 0.08);
      const squint = 1 - Math.min(1, (f.burn || 0)) * 0.5;
      r.ball.scale.y = squint; r.iris.scale.y = squint;
      continue;
    }
    if (f.ptype === 'shroom') {
      // 被手電筒照到時，菇傘上的眼睛全部閉起來（變暗）；撒孢子時發亮
      const shut = f.shut > 0 || !awake;
      r.capMat.emissive.setRGB(shut ? 0.03 : f.spore ? 0.35 + 0.15 * Math.sin(t * 10) : 0.12, shut ? 0.0 : 0.04, shut ? 0.01 : 0.06);
      r.capMat.color.setRGB(shut ? 0.55 : 1, shut ? 0.45 : 1, shut ? 0.45 : 1);
      for (const dr of r.drips) { const len = 0.12 + 0.18 * Math.abs(Math.sin(t * 1.5 + dr.ph)); dr.d.scale.y = len; dr.d.position.y = 1.0 - len / 2; }
      continue;
    }
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
let starBulbTex, starShapeTex, moonTex, featherTex, slimeTex, plusTex;
function makeExtraTextures() {
  plusTex = canvasTex(64, 64, (c) => {
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(160,255,190,.6)'); g.addColorStop(1, 'rgba(160,255,190,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#fff'; c.fillRect(27, 12, 10, 40); c.fillRect(12, 27, 40, 10);
  });
  plusTex.wrapS = plusTex.wrapT = THREE.ClampToEdgeWrapping;
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
  } else if (tier === HEAL_TIER) {
    // 回血燈泡：繞著轉的綠色「+」
    res.spin = new THREE.Group(); res.spin.position.y = y; g.add(res.spin);
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2, pl = ownSprite(plusTex, 0xa8ffc4);
      pl.position.set(Math.cos(a) * 0.24, 0.02, Math.sin(a) * 0.24); pl.scale.setScalar(0.12);
      res.spin.add(pl);
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

// ====================================================================
// 怪物頭上的等級與血條、火焰燈泡的火球
// ====================================================================
function barH(t) {
  if (!t.kind) return t.ptype === 'shroom' ? 1.95 : t.ptype === 'sunflower' ? 1.82 : 1.72;
  switch (t.kind) {
    case 'grass': return 0.95 + (t.rise || 0) * 1.0;
    case 'snail': return 1.45;
    case 'girl': return 2.12;
    case 'tall': return 2.85;
    case 'fast': return 1.45;
    case 'blob': return (t.h || 0.4) + 0.4 * (t.size || 1) + 0.3;
    case 'woman': return 2.05;
    case 'momo': return 2.1 + (t.air || 0) * 0.45;
    case 'crawler': return 1.0;
    case 'balloon': return 2.25;
    case 'clown': return 2.55;
    case 'stick': return 1.95;
    default: return 2.0;
  }
}
function drawHpBar(c, t, ratio) {
  c.clearRect(0, 0, 160, 44);
  c.fillStyle = 'rgba(8,6,12,.6)';
  c.beginPath(); c.roundRect(0, 0, 160, 44, 10); c.fill();
  c.font = 'bold 17px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = BOSSES.includes(t.kind) ? '#ffb347' : '#f0ecf5';
  c.fillText(`Lv.${t.lv} ${MONSTER_NAME[kindOf(t)]}`, 80, 14);
  c.fillStyle = '#3a0a10'; c.fillRect(10, 28, 140, 9);
  c.fillStyle = ratio > 0.5 ? '#e6394a' : ratio > 0.25 ? '#ff8a2a' : '#ffd23a';
  c.fillRect(10, 28, 140 * ratio, 9);
}
const hpMap = new Map();
function syncHpBars() {
  const p = G.p, seen = new Set();
  if (mode !== 'title') for (const t of [...G.enemies, ...G.flowers]) {
    if (!t.maxHp) continue;
    seen.add(t);
    let b = hpMap.get(t);
    if (!b) {
      const cv = document.createElement('canvas'); cv.width = 160; cv.height = 44;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = SRGB;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      sp.scale.set(0.8, 0.22, 1); scene.add(sp);
      b = { ctx: cv.getContext('2d'), tex, sp, key: '' };
      hpMap.set(t, b);
    }
    const ratio = clamp(t.hp / t.maxHp, 0, 1), d = Math.hypot(t.x - p.x, t.y - p.y);
    const key = t.lv + ':' + Math.ceil(ratio * 40);
    if (key !== b.key) { b.key = key; drawHpBar(b.ctx, t, ratio); b.tex.needsUpdate = true; }
    b.sp.visible = !t.dead && !t.hidden && d < 11 && (ratio < 1 || d < 7) && (t.kind ? enemyAlpha(t) > 0.1 : t.grow >= 1);
    b.sp.position.set(t.x, barH(t), t.y);
  }
  for (const [t, b] of hpMap) if (!seen.has(t)) { scene.remove(b.sp); b.sp.material.dispose(); b.tex.dispose(); hpMap.delete(t); }
}
const fbMap = new Map();
function syncFireballs(t) {
  const seen = new Set();
  for (const f of G.fireballs || []) {
    seen.add(f);
    let r = fbMap.get(f);
    if (!r) {
      const g = new THREE.Group();
      const outer = ownSprite(glowTex, 0xff7a1a), core = ownSprite(glowTex, 0xffe08a);
      outer.scale.setScalar(0.55); core.scale.setScalar(0.22);
      g.add(outer, core); scene.add(g);
      r = { g, outer }; fbMap.set(f, r);
    }
    r.g.position.set(f.x, f.h, f.y);
    r.outer.scale.setScalar(0.5 + 0.1 * Math.sin(t * 30));
  }
  for (const [f, r] of fbMap) if (!seen.has(f)) { disposeGroup(r.g); fbMap.delete(f); }
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
// 武器：左手拿的武器、飛出去的彈珠和鞭炮、被敲暈的星星
// ====================================================================
let viewWeapon, sprayGlow;
const weaponModels = {};
const wmCache = new Map();
function ownWM(c, e) {
  let m = wmCache.get(c);
  if (!m) {
    const col = new THREE.Color(c);
    m = patchLM(new THREE.MeshLambertMaterial({ color: col, emissive: col.clone().multiplyScalar(0.14) }));
    wmCache.set(c, m);
  }
  return m;
}
function buildWeapons() {
  viewWeapon = new THREE.Group();
  viewWeapon.scale.setScalar(0.62);
  camera.add(viewWeapon);
  // 武器材質帶一點點自發光，黑暗中也看得到手上拿著什麼
  const lm = (c, e = '#000000') => ownWM(c, e);
  const add = (id, g) => {
    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    weaponModels[id] = g; viewWeapon.add(g);
  };
  const flat = (m, x, y, z) => { m.rotation.x = Math.PI / 2; m.position.set(x, y, z); return m; };
  // 🍳 平底鍋：木頭把手＋黑色鍋子
  let g = new THREE.Group();
  box(g, -0.008, 0.008, -0.02, 0.1, -0.006, 0.006, lm('#6a4a30'));
  flat(cyl(g, 0.07, 0.066, 0.012, 0, 0, 0, lm('#7a7a86'), 20), 0, 0.165, 0);
  flat(cyl(g, 0.062, 0.062, 0.004, 0, 0, 0, lm('#3a3a44'), 20), 0, 0.165, 0.0065);
  add('pan', g);
  // 🎯 彈弓：Y 字形的樹枝＋紅色橡皮筋
  g = new THREE.Group();
  const wood = lm('#8a5a2b');
  cyl(g, 0.009, 0.01, 0.08, 0, -0.03, 0, wood, 8);
  for (const sd of [-1, 1]) {
    const pr = cyl(g, 0.007, 0.008, 0.06, 0, 0, 0, wood, 8);
    pr.position.set(sd * 0.014, 0.075, 0); pr.rotation.z = -sd * 0.5;
  }
  box(g, -0.03, 0.03, 0.098, 0.104, -0.003, 0.003, lm('#c0392b'));
  box(g, -0.01, 0.01, 0.094, 0.108, 0.002, 0.012, lm('#5a3a22'));
  add('slingshot', g);
  // 🔫 聖水槍：藍色水槍＋透明水箱＋金色槍口
  g = new THREE.Group();
  box(g, -0.016, 0.016, 0.02, 0.058, -0.14, 0.02, lm('#2f8fe0'));
  box(g, -0.013, 0.013, -0.045, 0.028, -0.005, 0.024, lm('#1f5fa8'));
  sph(g, 0.026, 0, 0.078, -0.05, lm('#bfe6ff'), 1, 0.8, 1.3, 12);
  flat(cyl(g, 0.007, 0.009, 0.03, 0, 0, 0, lm('#ffd166'), 8), 0, 0.04, -0.155);
  sprayGlow = ownSprite(glowTex, 0x8fd0ff); sprayGlow.position.set(0, 0.04, -0.18); sprayGlow.scale.setScalar(0.07); g.add(sprayGlow);
  add('watergun', g);
  // 🧂 鹽巴罐
  g = new THREE.Group();
  cyl(g, 0.026, 0.028, 0.08, 0, -0.02, 0, lm('#f2f2f2'), 14);
  cyl(g, 0.027, 0.027, 0.022, 0, 0.06, 0, lm('#aeb4bd'), 14);
  box(g, -0.02, 0.02, 0.01, 0.035, 0.022, 0.03, lm('#3a78c2'));
  add('salt', g);
  // 🧨 鞭炮：三根紅色炮竹綁在一起
  g = new THREE.Group();
  for (const [x, z] of [[-0.013, 0], [0.013, 0], [0, -0.012]]) cyl(g, 0.011, 0.011, 0.085, x, -0.02, z, lm('#d62828'), 10);
  cyl(g, 0.024, 0.024, 0.012, 0, 0.02, -0.004, lm('#e8b53a'), 12);
  cyl(g, 0.002, 0.002, 0.035, 0, 0.065, -0.004, lm('#3a2a1a'), 5);
  add('firecracker', g);
}
function updateViewWeapon() {
  const it = mode !== 'title' && G.selId && ITEMS[G.selId];
  const id = it && it.kind === 'weapon' ? G.selId : null;
  viewWeapon.visible = !!id;
  for (const k in weaponModels) weaponModels[k].visible = k === id;
  if (!id) return;
  const sw = G.swingId === id ? G.swingT : 0, ph = sw > 0 ? Math.sin((1 - sw) * Math.PI) : 0;
  const bx = -0.25 - Math.cos(bobPh * 0.5) * 0.006 * bobAmt, by = -0.165 + Math.abs(Math.sin(bobPh * 0.5)) * 0.008 * bobAmt;
  const m = weaponModels[id];
  viewWeapon.position.set(bx, by, -0.36);
  viewWeapon.rotation.set(0, 0, 0);
  m.position.set(0, 0, 0);
  if (id === 'pan') {
    m.rotation.set(-0.75 - ph * 0.6, 0.3, -0.2 - ph * 1.3);
    m.position.set(ph * 0.2, ph * 0.08, -ph * 0.12);
  } else if (id === 'slingshot') {
    m.rotation.set(-0.15, 0.2, 0.15);
    m.position.set(0.02, 0.02, ph * 0.05);
  } else if (id === 'watergun') {
    const on = G.spray > 0;
    m.rotation.set(0.05, -0.18, 0);
    m.position.set(0.02 + (on ? (Math.random() - 0.5) * 0.004 : 0), 0.02, on ? 0.012 : 0);
    sprayGlow.visible = on;
  } else {
    m.rotation.set(-0.2 - ph * 0.8, 0.3, 0.2 + ph * 0.5);
    m.position.set(0.02 + ph * 0.06, 0.02 + ph * 0.1, -ph * 0.14);
  }
}
// ---------- 第二世界：向日葵眼吐的種子、眼睛種子、大嘴觸角蟲的黏液 ----------
const seedMap = new Map(), seedlingMap = new Map();
let trailMesh = null;
const TRAIL_MAX = 160;
function syncWorld2(t) {
  let seen = new Set();
  for (const s of G.seeds || []) {
    seen.add(s);
    let g = seedMap.get(s);
    if (!g) {
      g = new THREE.Group();
      const sd = sph(g, 0.05, 0, 0, 0, ownBasic({ color: 0x3a3226 }), 1.5, 0.8, 1, 8); sd.castShadow = false;
      sph(g, 0.052, 0, 0.01, 0, ownBasic({ color: 0xd8d0b8 }), 1.2, 0.3, 0.3, 6).castShadow = false;
      const gl = ownSprite(glowTex, 0xffe080); gl.scale.setScalar(0.22); g.add(gl);
      scene.add(g); seedMap.set(s, g);
    }
    g.position.set(s.x, s.h, s.y);
    g.rotation.set(s.spin, s.spin * 0.7, 0);
  }
  for (const [s, g] of seedMap) if (!seen.has(s)) { disposeGroup(g); seedMap.delete(s); }
  seen = new Set();
  for (const s of G.seedlings || []) {
    seen.add(s);
    let r = seedlingMap.get(s);
    if (!r) {
      const g = new THREE.Group(); g.position.set(s.x, 0, s.y); scene.add(g);
      const em = ownLM('#ffffff', { map: flowerEyeTex, emissive: 0x3a2a2a });
      const eye = new THREE.Mesh(geo('seedeye', () => new THREE.SphereGeometry(0.1, 12, 10)), em); eye.rotation.x = -Math.PI / 2; g.add(eye);
      const sprout = new THREE.Group(); g.add(sprout);
      limb(sprout, [0, 0.05, 0], [0.02, 0.3, 0], 0.012, lm('#5fae4a'));
      for (const sd of [-1, 1]) { const lf = sph(sprout, 0.05, sd * 0.05, 0.28, 0, lm('#6fbf4a'), 1, 0.3, 0.6, 6); lf.rotation.z = sd * 0.6; }
      const gl = ownSprite(glowTex, 0xff9ec8); gl.position.y = 0.1; gl.scale.setScalar(0.35); g.add(gl);
      r = { g, eye, sprout, gl }; seedlingMap.set(s, r);
    }
    const k = 1 - clamp(s.t / (s.max || 15), 0, 1);
    r.eye.position.y = 0.02 + k * 0.05;
    r.sprout.scale.setScalar(0.4 + k * 1.2);
    r.gl.material.opacity = 0.4 + 0.3 * Math.sin(t * 6);
  }
  for (const [s, r] of seedlingMap) if (!seen.has(s)) { disposeGroup(r.g); seedlingMap.delete(s); }
  // 黏液：地上一灘一灘發亮的痕跡
  const trails = G.trails || [];
  if (!trailMesh && trails.length) {
    trailMesh = new THREE.InstancedMesh(geo('trail', () => new THREE.CircleGeometry(1, 14)), new THREE.MeshBasicMaterial({ color: 0xd8f0a8, transparent: true, opacity: 0.38, depthWrite: false }), TRAIL_MAX);
    trailMesh.frustumCulled = false; trailMesh.count = 0;
    scene.add(trailMesh);
  }
  if (trailMesh) {
    const n = Math.min(TRAIL_MAX, trails.length);
    for (let i = 0; i < n; i++) {
      const tr = trails[trails.length - n + i], k = Math.min(1, tr.life / 4);
      _q.setFromEuler(_e.set(-Math.PI / 2, 0, tr.a, 'XYZ'));
      _m4.compose(_v.set(tr.x, 0.013 + i * 0.00005, tr.y), _q, _sc.set(tr.r * k, tr.r * k * 0.8, 1));
      trailMesh.setMatrixAt(i, _m4);
    }
    trailMesh.count = n;
    trailMesh.instanceMatrix.needsUpdate = true;
  }
}
const _sc = new THREE.Vector3();
const shotMap = new Map(), bombMap = new Map();
function syncProjectiles(t) {
  let seen = new Set();
  for (const sh of G.shots || []) {
    seen.add(sh);
    let g = shotMap.get(sh);
    if (!g) {
      g = new THREE.Group();
      sph(g, 0.035, 0, 0, 0, lm('#7fc8f8'), 1, 1, 1, 10).castShadow = false;
      const gl = ownSprite(glowTex, 0x9fd8ff); gl.scale.setScalar(0.16); g.add(gl);
      scene.add(g); shotMap.set(sh, g);
    }
    g.position.set(sh.x, sh.h, sh.y);
  }
  for (const [sh, g] of shotMap) if (!seen.has(sh)) { disposeGroup(g); shotMap.delete(sh); }
  seen = new Set();
  for (const b of G.bombs || []) {
    seen.add(b);
    let r = bombMap.get(b);
    if (!r) {
      const g = new THREE.Group();
      cyl(g, 0.02, 0.02, 0.1, 0, -0.05, 0, lm('#d62828'), 10).castShadow = false;
      const spark = ownSprite(glowTex, 0xffc060); spark.position.y = 0.065; g.add(spark);
      scene.add(g); r = { g, spark }; bombMap.set(b, r);
    }
    r.g.position.set(b.x, b.h + 0.02, b.y);
    r.g.rotation.set(0, b.spin * 0.3, Math.PI / 2 + (b.h > 0.07 ? b.spin : 0));
    const fast = b.fuse < 0.4;
    r.spark.scale.setScalar((fast ? 0.16 : 0.1) + Math.random() * 0.08);
  }
  for (const [b, r] of bombMap) if (!seen.has(b)) { disposeGroup(r.g); bombMap.delete(b); }
}
const stunMap = new Map();
function syncStun(t) {
  const seen = new Set();
  if (mode !== 'title') for (const e of G.enemies) {
    if (!(e.stunT > 0) || e.dead) continue;
    seen.add(e);
    let g = stunMap.get(e);
    if (!g) {
      g = new THREE.Group();
      for (let i = 0; i < 3; i++) { const st = ownSprite(starShapeTex, 0xffe066); st.scale.setScalar(0.17); g.add(st); }
      scene.add(g); stunMap.set(e, g);
    }
    g.position.set(e.x, barH(e) - 0.32, e.y);
    g.children.forEach((st, i) => {
      const a = t * 5 + i * Math.PI * 2 / 3;
      st.position.set(Math.cos(a) * 0.27, Math.sin(t * 7 + i) * 0.03, Math.sin(a) * 0.27);
    });
  }
  for (const [e, g] of stunMap) if (!seen.has(e)) { disposeGroup(g); stunMap.delete(e); }
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
  strongRing = cyl(viewFlash, 0.025, 0.025, 0.014, 0, 0, 0, ownLM('#e0b43a'), 12);
  strongRing.rotation.x = Math.PI / 2; strongRing.position.set(0, 0, -0.05); strongRing.castShadow = false;
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
  let x, y, z, face, pitch, roll = 0;
  const cut = mode === 'cutscene' && CUT && CUT.cam;
  if (mode === 'title') {
    x = 16.3 + Math.sin(t * 0.12) * 0.8; y = 1.6; z = 23.2;
    face = Math.atan2(12.4 - z, 19.7 - x) + Math.sin(t * 0.21) * 0.05; pitch = 0.04;
  } else if (cut) {
    // 破關動畫：鏡頭照著設定好的路線走
    const c = CUT.cam;
    x = c.x; z = c.y; y = EYE + (c.h || 0) + Math.sin(t * 2.2) * 0.01; face = c.face; pitch = c.pitch;
  } else {
    const p = G.p;
    const moving = (p.moved || 0) > 0.001 && !(p.z > 0);
    bobPh += moving ? (p.moved || 0) * 6.5 : 0;
    bobAmt += ((moving ? 1 : 0) - bobAmt) * Math.min(1, dt * 8);
    x = p.x; z = p.y; y = EYE + (p.z || 0) + Math.sin(bobPh) * 0.035 * bobAmt;
    face = p.face; pitch = p.pitch;
    // 被草叢人抓住：鏡頭往下看、抖動
    if (p.grabbed) { pitch -= 0.1; y -= 0.12; x += (Math.random() - 0.5) * 0.02; }
    // 眼花：畫面左右晃、歪一邊
    const dz = mode === 'play' ? (G.dizzy || 0) + (G.spore || 0) * 0.5 : 0;
    if (dz > 0) { face += Math.sin(t * 1.7) * 0.06 * dz; roll += Math.sin(t * 1.3) * 0.1 * dz; pitch += Math.sin(t * 2.1) * 0.03 * dz; }
    if (G.shake > 0) { x += (Math.random() - 0.5) * G.shake * 0.12; y += (Math.random() - 0.5) * G.shake * 0.12; }
    viewFlash.position.set(0.17 + Math.cos(bobPh * 0.5) * 0.006 * bobAmt, -0.16 + Math.abs(Math.sin(bobPh * 0.5)) * 0.008 * bobAmt, -0.32);
  }
  camera.position.set(x, y, z);
  const stare = mode === 'play' ? (G.stare || 0) : 0;
  camera.rotation.set(pitch, yawOf(face), Math.sin(t * 2.3) * 0.05 * stare + roll);
  const dizzy = mode === 'play' ? (G.dizzy || 0) : 0;
  const fov = baseFov - stare * 8 + Math.sin(t * 1.9) * 4 * dizzy;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  viewFlash.visible = mode !== 'title' && mode !== 'cutscene';
  const on = mode !== 'title' && mode !== 'cutscene' && flashOn();
  let k = on ? 1 : 0;
  if (on && G.p.bat < 15 && Math.random() < 0.15) k = 0.3;
  // 手電筒等級：稀有更亮、巨光更亮更寬
  const lv = mode === 'title' ? 1 : clamp(G.p.flashLv || 1, 1, 3);
  spot.intensity = 3.2 * k * [1, 1, 1.3, 1.6][lv];
  spot.distance = flRange() + 1.5;
  spot.angle = flHalf() * 1.1;
  strongRing.visible = lv >= 2;
  if (lv >= 2) strongRing.material.color.set(lv === 3 ? 0xffc23a : 0x4da3ff);
  lensMat.color.set(on ? (lv === 3 ? 0xfff2c0 : 0xfff6dd) : 0x333333);
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
// 第二世界：白天是淡淡的粉紫色霧，晚上深藍紫色；萬物甦醒時在紫色和綠色之間變來變去
const cW2Day = new THREE.Color('#cdbfe0'), cW2Night = new THREE.Color('#05041a'), cAwakeA = new THREE.Color('#1c0a2c'), cAwakeB = new THREE.Color('#06221a');
const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
function updateAtmosphere(dark, t) {
  const k = dark / NIGHT_DARK;
  if (isW2()) {
    const awake = G.ev.blood && G.phase === 'night';
    const night = awake ? tmpC2.copy(cAwakeA).lerp(cAwakeB, 0.5 + 0.5 * Math.sin(t * 0.5)) : cW2Night;
    tmpC.copy(cW2Day).lerp(night, k);
    scene.fog.color.copy(tmpC); scene.background.copy(tmpC);
    scene.fog.near = 10 - 8.5 * k; scene.fog.far = 45 - 32 * k;
    return;
  }
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
  syncFireballs(t);
  syncProjectiles(t);
  syncWorld2(t);
  syncStun(t);
  syncHpBars();
  syncGhosts();
  syncParticles();
  updateFurniture(t);
  updateAwaken(t, dark);
  updateLightmap(dark);
  updateAtmosphere(dark, t);
  updateCamera(dt, t);
  updateViewWeapon();
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
  makeGardenTextures();
  buildHouse();
  buildFurniture();
  buildFlashlight();
  buildWeapons();
  buildExtras();
  glowPts = makePoints(0.07, THREE.AdditiveBlending);
  smokePts = makePoints(0.3, THREE.NormalBlending);
  window.Renderer = { render, resize, setWorld };
  resize();
}
init();
