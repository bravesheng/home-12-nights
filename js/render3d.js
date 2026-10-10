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
// shade（0～1）：模型自己的明暗。光照貼圖只有「這個位置多亮」、沒有方向，怪物沒被手電筒直射時會像紙片一樣平；
// 加上「面向你的地方亮、側面和朝下的地方暗」，球才看得出是球。只給怪物用，牆、地板、家具不變（shade 0）
function patchLM(m, shade = 0) {
  const shadeU = { value: shade };
  m.userData.shadeU = shadeU;
  m.onBeforeCompile = sh => {
    sh.uniforms.uLM = uni.uLM; sh.uniforms.uLMSize = uni.uLMSize; sh.uniforms.uAmb = uni.uAmb; sh.uniforms.uShade = shadeU;
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
      .replace('#include <common>', '#include <common>\nvarying vec3 vLMPos;\nuniform sampler2D uLM;\nuniform vec2 uLMSize;\nuniform float uAmb;\nuniform float uShade;')
      .replace('#include <aomap_fragment>', `vec3 lmc = texture2D(uLM, vLMPos.xz / uLMSize).rgb * 2.0;
        float lmUp = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)) * 0.5 + 0.5;
        lmc *= mix(1.0, 0.3 + 0.42 * abs(dot(normal, geometryViewDir)) + 0.28 * lmUp, uShade);
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
const ownLM = (color, opts = {}) => { const { shade = 0, ...o } = opts; const m = patchLM(new THREE.MeshLambertMaterial({ color, ...o }), shade); m.userData.own = true; return m; };
// 會反光的材質（濕濕的眼球）：被手電筒照到會有亮點
const ownPhong = (color, opts = {}) => { const { shade = 0, ...o } = opts; const m = patchLM(new THREE.MeshPhongMaterial({ color, ...o }), shade); m.userData.own = true; return m; };
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
    if (o.isInstancedMesh) o.dispose();
  });
}

// ====================================================================
// 貼圖（全部用程式畫）
// ====================================================================
// cpu：用 CPU 畫的畫布（要畫幾千條細線的貼圖用這個，放在 GPU 上畫反而很慢）
function canvasTex(w, h, draw, cpu = false) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d', cpu ? { willReadFrequently: true } : undefined), w, h);
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
      // 第三世界：機車室的鐵板、絨毛地毯、黑白小磁磚、走道的地毯、舊木板、月台的水泥、人字拼花地板（全部都舊舊髒髒的）
      case 'iron': {
        c.fillStyle = '#3b3d41'; c.fillRect(0, 0, w, h);
        c.strokeStyle = 'rgba(0,0,0,.45)'; c.lineWidth = 2; c.strokeRect(1, 1, w - 2, h - 2); c.beginPath(); c.moveTo(32, 0); c.lineTo(32, h); c.stroke();
        for (const [x, y] of [[6, 6], [26, 6], [38, 6], [58, 6], [6, 58], [26, 58], [38, 58], [58, 58], [6, 32], [58, 32]]) { c.fillStyle = '#55585d'; c.beginPath(); c.arc(x, y, 2.2, 0, 7); c.fill(); c.fillStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(x + 0.8, y + 0.8, 1.2, 0, 7); c.fill(); }
        for (let i = 0; i < 14; i++) { c.fillStyle = `rgba(120,70,30,${0.08 + rnd() * 0.18})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 8, 2 + rnd() * 4, rnd() * 3, 0, 7); c.fill(); }
        break;
      }
      case 'carpet3': {
        speckle('#1e3a2c', 160, 'rgba(255,255,255,.05)');
        c.strokeStyle = 'rgba(190,160,80,.45)'; c.lineWidth = 2; c.strokeRect(4, 4, w - 8, h - 8);
        c.strokeStyle = 'rgba(190,160,80,.3)'; c.lineWidth = 1;
        for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) { c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke(); }
        for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(0,0,0,${0.08 + rnd() * 0.15})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 10, 3 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
        break;
      }
      case 'tile3': {
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { c.fillStyle = (i + j) % 2 ? '#1c1b1e' : '#d6cdb4'; c.fillRect(i * 16, j * 16, 16, 16); }
        c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1;
        for (let i = 0; i <= 64; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 64); c.moveTo(0, i); c.lineTo(64, i); c.stroke(); }
        for (let i = 0; i < 10; i++) { c.fillStyle = `rgba(60,40,20,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 6, 2 + rnd() * 4, 0, 0, 7); c.fill(); }
        break;
      }
      case 'runner': {
        speckle('#4a1d22', 200, 'rgba(255,200,160,.06)');
        c.strokeStyle = 'rgba(200,160,70,.35)'; c.lineWidth = 1.5;
        for (let y = 8; y < h; y += 16) for (let x = 8; x < w; x += 16) { c.beginPath(); c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.closePath(); c.stroke(); }
        const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(0, 0, w, h);
        break;
      }
      case 'plank3': planks('#4a3222', '#241709', 16); for (let i = 0; i < 8; i++) { c.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 10, 1); } break;
      case 'platform': {
        speckle('#6e6c66', 180, 'rgba(0,0,0,.14)');
        c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1;
        for (let i = 0; i < 3; i++) { let x = rnd() * w, y = rnd() * h; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * 20; y += (rnd() - 0.5) * 20; c.lineTo(x, y); } c.stroke(); }
        c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, 0, w, 1); c.fillRect(0, 0, 1, h);
        break;
      }
      case 'wood3': {
        c.fillStyle = '#5a3d26'; c.fillRect(0, 0, w, h);
        c.lineWidth = 7;
        for (let i = -8; i < 16; i++) { c.strokeStyle = shade('#6b4a2e', (rnd() - 0.5) * 30); c.beginPath(); c.moveTo(i * 9, 0); c.lineTo(i * 9 + 32, 32); c.stroke(); c.strokeStyle = shade('#6b4a2e', (rnd() - 0.5) * 30); c.beginPath(); c.moveTo(i * 9, 64); c.lineTo(i * 9 + 32, 32); c.stroke(); }
        c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, 32); c.lineTo(w, 32); c.stroke();
        for (let i = 0; i < 10; i++) { c.fillStyle = `rgba(0,0,0,${0.08 + rnd() * 0.15})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 8, 2 + rnd() * 5, 0, 0, 7); c.fill(); }
        break;
      }
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
let treeWallTex, skyTex, skyEyeTex, bladeTex, wallEyeTex, doorGlowTex, clothTex, grassFaceTex, girlFaceTex, sunPetalTex, flowerEyeTex, capTex;
let grassStrandTex, snailSkinTex, gillTex, stemTex, sunDiscTex, pleatTex, bigEyeTex;
function makeGardenTextures() {
  // 小眼球（球面貼圖：正面 u = 0.25 是瞳孔）
  flowerEyeTex = canvasTex(256, 128, (c) => {
    paintEyeball(c, 256, 128);
    c.fillStyle = '#6a3a1e'; c.beginPath(); c.arc(64, 64, 18, 0, 7); c.fill();
    c.fillStyle = '#0d0808'; c.beginPath(); c.arc(64, 64, 9, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(58, 58, 4, 0, 7); c.fill();
  }, true);
  // 大一點的虹膜和瞳孔（千眼菇、大嘴觸角蟲的小眼球遠遠的也看得出是眼睛）
  bigEyeTex = canvasTex(256, 128, (c) => {
    paintEyeball(c, 256, 128);
    c.fillStyle = '#4a2a16'; c.beginPath(); c.arc(64, 64, 25, 0, 7); c.fill();
    c.strokeStyle = 'rgba(20,10,6,.7)'; c.lineWidth = 2.5; c.beginPath(); c.arc(64, 64, 24, 0, 7); c.stroke();
    c.strokeStyle = 'rgba(120,70,30,.5)'; c.lineWidth = 1.2;
    for (let i = 0; i < 36; i++) { const a = i / 36 * Math.PI * 2; c.beginPath(); c.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12); c.lineTo(64 + Math.cos(a + 0.1) * 23, 64 + Math.sin(a + 0.1) * 23); c.stroke(); }
    c.fillStyle = '#080404'; c.beginPath(); c.arc(64, 64, 11, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(57, 57, 4.5, 0, 7); c.fill();
  }, true);
  // 千眼菇的菇傘：暗紅色、中間深邊緣淡，有一塊一塊的斑和白色的疣（像毒蠅傘），從頂上往下的紋路；眼睛是 3D 的另外放
  capTex = canvasTex(512, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#6e1018'); g.addColorStop(0.55, '#b4222e'); g.addColorStop(1, '#cf4848');
    c.fillStyle = g; c.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(${40 + rnd() * 40 | 0},0,${rnd() * 20 | 0},${0.08 + rnd() * 0.14})`; c.beginPath(); c.ellipse(rnd() * 512, rnd() * 256, 6 + rnd() * 22, 3 + rnd() * 10, rnd() * 3, 0, 7); c.fill(); }
    c.strokeStyle = 'rgba(60,5,10,.35)'; c.lineWidth = 2;
    for (let i = 0; i < 48; i++) { const x = i / 48 * 512 + rnd() * 6; c.beginPath(); c.moveTo(x, 20 + rnd() * 30); c.quadraticCurveTo(x + (rnd() - 0.5) * 30, 150, x + (rnd() - 0.5) * 20, 256); c.stroke(); }
    for (let i = 0; i < 34; i++) {
      const x = rnd() * 512, y = 20 + rnd() * 200, rr = 5 + rnd() * 10;
      c.fillStyle = 'rgba(80,10,15,.5)'; c.beginPath(); c.ellipse(x + 2, y + 3, rr * 1.2, rr * 0.8, 0, 0, 7); c.fill();
      c.fillStyle = `rgb(${225 + rnd() * 25 | 0},${210 + rnd() * 30 | 0},${190 + rnd() * 30 | 0})`; c.beginPath(); c.ellipse(x, y, rr * 1.2, rr * 0.8, 0, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,255,255,.5)'; c.beginPath(); c.ellipse(x - rr * 0.3, y - rr * 0.3, rr * 0.5, rr * 0.3, 0, 0, 7); c.fill();
    }
  });
  // 菇傘下面的菌褶、菇柄（奶油色、有纖維；向日葵和草叢人的莖也拿它染色用）
  gillTex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#6a2a2e'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2; c.strokeStyle = i % 2 ? 'rgba(240,200,190,.55)' : 'rgba(30,5,8,.6)'; c.lineWidth = i % 2 ? 2 : 1.4; c.beginPath(); c.moveTo(128 + Math.cos(a) * 26, 128 + Math.sin(a) * 26); c.lineTo(128 + Math.cos(a) * 130, 128 + Math.sin(a) * 130); c.stroke(); }
  });
  stemTex = canvasTex(128, 128, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#f1e9cf'); g.addColorStop(1, '#cdbf96');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) { c.strokeStyle = `rgba(${120 + rnd() * 60 | 0},${100 + rnd() * 50 | 0},60,${0.15 + rnd() * 0.25})`; c.lineWidth = 1 + rnd() * 2; const x = rnd() * 128; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(x + (rnd() - 0.5) * 10, 64, x + (rnd() - 0.5) * 8, 128); c.stroke(); }
    for (let i = 0; i < 25; i++) { c.fillStyle = `rgba(90,60,40,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * 128, rnd() * 128, 2 + rnd() * 6, 1 + rnd() * 3, 0, 0, 7); c.fill(); }
  });
  // 草叢人的草葉：像頭髮那樣一束一束（根在上面、葉尖在下面），根部深、葉尖淡，有幾片枯黃的
  grassStrandTex = canvasTex(64, 256, (c) => {
    for (let i = 0; i < 22; i++) {
      const x = 32 + (rnd() + rnd() - 1) * 30, end = 150 + rnd() * 100, w = 3 + rnd() * 3, dead = rnd() < 0.15;
      const xm = x + (rnd() - 0.5) * 16, xt = xm + (rnd() - 0.5) * 20;
      const lo = dead ? '#6b5a2a' : `rgb(${30 + rnd() * 20 | 0},${70 + rnd() * 30 | 0},${28 + rnd() * 14 | 0})`;
      const hi = dead ? '#c9ad5a' : `rgb(${70 + rnd() * 50 | 0},${150 + rnd() * 70 | 0},${50 + rnd() * 30 | 0})`;
      const grad = c.createLinearGradient(0, 0, 0, end); grad.addColorStop(0, lo); grad.addColorStop(0.55, hi); grad.addColorStop(1, dead ? '#e0c878' : '#cfe08a');
      c.fillStyle = grad; c.beginPath(); c.moveTo(x - w, 0); c.quadraticCurveTo(xm - w * 0.6, end * 0.5, xt, end); c.quadraticCurveTo(xm + w * 0.6, end * 0.5, x + w, 0); c.fill();
      c.strokeStyle = 'rgba(20,50,20,.45)'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(xm, end * 0.5, xt, end * 0.96); c.stroke();
    }
  }, true);
  grassStrandTex.wrapS = grassStrandTex.wrapT = THREE.ClampToEdgeWrapping;
  // 大嘴觸角蟲的皮：粉紅色、上面淡下面深，一圈一圈的皺紋、斑點、小疙瘩和濕濕的亮點
  snailSkinTex = canvasTex(256, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#f0b3c2'); g.addColorStop(0.55, '#dd8ea2'); g.addColorStop(1, '#b86478');
    c.fillStyle = g; c.fillRect(0, 0, 256, 256);
    for (let y = 6; y < 256; y += 9 + rnd() * 6) {
      c.strokeStyle = `rgba(120,40,70,${0.18 + rnd() * 0.2})`; c.lineWidth = 1.2 + rnd() * 1.5; c.beginPath(); c.moveTo(0, y);
      for (let x = 0; x <= 256; x += 16) c.lineTo(x, y + Math.sin(x / 256 * Math.PI * 6 + y) * 3);
      c.stroke();
    }
    for (let i = 0; i < 70; i++) { c.fillStyle = `rgba(150,50,80,${0.12 + rnd() * 0.22})`; c.beginPath(); c.ellipse(rnd() * 256, rnd() * 256, 3 + rnd() * 9, 2 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
    for (let i = 0; i < 120; i++) { const x = rnd() * 256, y = rnd() * 256, rr = 1.5 + rnd() * 3; c.fillStyle = 'rgba(90,20,50,.35)'; c.beginPath(); c.arc(x + 1, y + 1, rr, 0, 7); c.fill(); c.fillStyle = 'rgba(255,220,230,.5)'; c.beginPath(); c.arc(x - 0.5, y - 0.5, rr * 0.7, 0, 7); c.fill(); }
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(255,240,245,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * 256, rnd() * 256, 2 + rnd() * 5, 1 + rnd() * 2, rnd() * 3, 0, 7); c.fill(); }
  });
  // 向日葵眼的花盤：鋪滿葵花籽（一顆顆有亮面和暗面），中間是暗紅色的眼窩，血絲往外爬
  sunDiscTex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#3a2412'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const a = i * 2.39996, d = 8 + Math.sqrt(i) * 4.2; if (d > 128) break;
      const x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d, sz = 2.6 + d * 0.022;
      c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.ellipse(x + 1, y + 1.2, sz * 1.1, sz * 0.7, a, 0, 7); c.fill();
      c.fillStyle = `rgb(${52 + rnd() * 30 | 0},${34 + rnd() * 20 | 0},${16 + rnd() * 10 | 0})`; c.beginPath(); c.ellipse(x, y, sz * 1.1, sz * 0.7, a, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,220,150,.3)'; c.beginPath(); c.ellipse(x - 0.8, y - 0.8, sz * 0.6, sz * 0.32, a, 0, 7); c.fill();
    }
    const g = c.createRadialGradient(128, 128, 22, 128, 128, 84); g.addColorStop(0, '#4a0c10'); g.addColorStop(0.6, 'rgba(90,20,24,.85)'); g.addColorStop(1, 'rgba(90,20,24,0)');
    c.fillStyle = g; c.beginPath(); c.arc(128, 128, 84, 0, 7); c.fill();
    drawVeins(c, 128, 128, 34, 112, 14, 4242, 0.6, 0);
  }, true);
  // 眼花女孩的百褶裙：一摺亮一摺暗
  pleatTex = canvasTex(128, 64, (c) => {
    for (let x = 0; x < 128; x += 16) { const g = c.createLinearGradient(x, 0, x + 16, 0); g.addColorStop(0, '#6d86b8'); g.addColorStop(0.5, '#4a5f84'); g.addColorStop(0.5, '#34446a'); g.addColorStop(1, '#5a709a'); c.fillStyle = g; c.fillRect(x, 0, 16, 64); }
  });
  pleatTex.repeat.set(4, 1);
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
  // 向日葵眼的花瓣（根在下面、尖在上面）：根部橘褐色、往上變黃，有葉脈；尖端和邊緣枯掉變咖啡色，有幾個破洞
  sunPetalTex = canvasTex(64, 128, (c) => {
    const g = c.createLinearGradient(0, 128, 0, 0); g.addColorStop(0, '#8a4a10'); g.addColorStop(0.25, '#d9901e'); g.addColorStop(0.6, '#f3c22e'); g.addColorStop(1, '#e8b43a');
    c.fillStyle = g; c.beginPath(); c.moveTo(32, 126); c.bezierCurveTo(2, 100, 2, 50, 32, 4); c.bezierCurveTo(62, 50, 62, 100, 32, 126); c.fill();
    c.strokeStyle = 'rgba(140,70,10,.55)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(32, 126); c.lineTo(32, 8); c.stroke();
    for (let i = 0; i < 6; i++) { const y = 110 - i * 16; c.beginPath(); c.moveTo(32, y); c.quadraticCurveTo(20, y - 12, 10 + i * 2, y - 24); c.moveTo(32, y); c.quadraticCurveTo(44, y - 12, 54 - i * 2, y - 24); c.stroke(); }
    c.globalCompositeOperation = 'source-atop';
    const d = c.createLinearGradient(0, 0, 0, 44); d.addColorStop(0, 'rgba(70,30,10,.85)'); d.addColorStop(1, 'rgba(70,30,10,0)'); c.fillStyle = d; c.fillRect(0, 0, 64, 44);
    for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(90,40,15,${0.3 + rnd() * 0.4})`; c.beginPath(); c.ellipse(10 + rnd() * 44, 20 + rnd() * 90, 2 + rnd() * 4, 1.5 + rnd() * 3, rnd() * 3, 0, 7); c.fill(); }
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(12 + rnd() * 40, 10 + rnd() * 60, 1.5 + rnd() * 2.5, 0, 7); c.fill(); }
    c.globalCompositeOperation = 'source-over';
  });
  sunPetalTex.wrapS = sunPetalTex.wrapT = THREE.ClampToEdgeWrapping;
  const faceT = draw => { const t = canvasTex(512, 512, c => draw(c, 512)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  grassFaceTex = faceT((c, S) => drawGrassFace(c, S, true));   // 頭頂的草用 3D 草葉
  girlFaceTex = faceT((c, S) => drawGirlFace(c, S, true));     // 頭髮、衣服、樹枝、左眼都是 3D 的
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
  const cold = isW3() && G.cold;   // 寒寂之境：偏白偏藍
  const tg = isW2() ? 0.95 : cold ? 1.0 : isW3() ? 0.9 : 0.97, tb = isW2() ? 1.02 : cold ? 1.08 : isW3() ? 0.74 : 0.92; // 第二世界的白天帶一點粉紫色，第三世界偏褐色（像老照片）
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
  if (backdrop) { disposeGroup(backdrop.g); backdrop = null; }
  doorPanels.clear(); panes3 = []; walnutMat = stationMat = null; stopEyes = null;
  for (const [c, r] of chestMap) { disposeGroup(r.g); chestMap.delete(c); }
  for (const k in furn3d) delete furn3d[k];
  buildHouse();
  buildFurniture();
}
function buildHouse() {
  houseGroup = new THREE.Group(); scene.add(houseGroup);
  const w2 = isW2(), w3 = isW3();
  for (const r of ROOMS) addFloor(r.x, r.y, r.w, r.h, r.floor);
  for (const d of DOORS) addFloor(d.x, d.y, 1, 1, d.rooms[0] ? d.rooms[0].floor : 'wood');

  // 天花板：第二世界是藍天白雲（萬物甦醒時雲會睜開眼睛發光）
  let cm;
  if (w2) {
    const sky = skyTex.clone(); sky.needsUpdate = true; sky.repeat.set(MAP_W / 6, MAP_H / 6);
    const glow = skyEyeTex.clone(); glow.needsUpdate = true; glow.repeat.set(MAP_W / 6, MAP_H / 6);
    cm = ceilMat = patchLM(new THREE.MeshLambertMaterial({ map: sky, emissiveMap: glow, emissive: 0x000000 }));
    cm.userData.own = true;
  } else if (w3) {
    // 第三世界：象牙白、一格一格線板的天花板（泛黃、有水漬）
    const ct = ceil3Tex.clone(); ct.needsUpdate = true; ct.repeat.set(MAP_W / 2, MAP_H / 2);
    cm = patchLM(new THREE.MeshLambertMaterial({ map: ct })); cm.userData.own = true;
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
  if (w3) buildTrainWalls(list);   // 第三世界：車廂的壁板、車站的磚牆、車身、真的窗戶
  else {
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), wallMat, list.length);
    walls.userData.ownGeo = true;
    const mtx = new THREE.Matrix4();
    list.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, WALL_H / 2, y + 0.5); walls.setMatrixAt(i, mtx); });
    walls.castShadow = true; walls.receiveShadow = true;
    walls.computeBoundingSphere();
    houseGroup.add(walls);
  }

  // 門楣與門框（第二世界：花拱門；第三世界：深色的木框，加上會滑開的門板）
  const trim = w3 ? lm('#2a1a10') : lm('#4a3a2e'), vine = lm('#4f8a3a');
  const archFlowers = [];
  for (const d of DOORS) {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.y); houseGroup.add(g);
    box(g, 0, 1, 2.15, WALL_H, 0, 1, w3 ? (d.y >= 26 ? stationMat : walnutMat) : wallMat);
    // 門上下是牆 → 通道東西向，門框在南北兩側；否則在東西兩側
    const eastWest = !!(tiles[d.y - 1] && tiles[d.y - 1][d.x] === 0);
    if (w3 && !d.front) addDoorPanel(d, g, eastWest);
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
  if (w3) { buildBackdrop(); buildStopEyes(); return; }
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
    if (!gardenFurniture(f, g, r, W, D, side, len, cabinet) && !trainFurniture(f, g, r, W, D, side, len, cabinet)) switch (f.type) {
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
  // 娃娃的頭會轉向你（第三世界沒有娃娃）
  if (furn3d.doll && furn3d.doll.head) {
    const doll = furn3d.doll.head, df = FURN_BY_ID.doll;
    doll.rotation.y = Math.atan2(p.x - (df.x + 0.5), p.y - (df.y + 0.5));
  }
  // 打開過的寶箱蓋子是開著的
  for (const id of ['tchest1', 'tchest2', 'tchest3']) {
    const r = furn3d[id], open = !!(G.chests && G.chests[id]);
    if (!r || !r.lid) continue;
    r.lid.rotation.x = open ? -1.15 : 0;
    r.lock.visible = !open;
  }
  if (isW3()) updateTrainFurniture(t);
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
  { metal: '#f1ece2', edge: '#cdbfa8' },
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
  if (isW3() && tier >= 6 && tier <= 8) { addTrainBulb(res, g, x, y, z, tier, s); return; }
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
    if (f.bm) syncBaymax(o, f, t);
    for (const h of f.halos) { h.visible = !!L; if (L) { setSRGB(h.material.color, col); h.material.opacity = 0.35 + 0.65 * k; } }
    if (f.rays) { f.rays.visible = !!L; setSRGB(f.rays.material.color, col); f.rays.material.opacity = 0.75 * k; f.rays.material.rotation = t * (o.bulb === 5 ? 0.4 : 0.7); }
    if (f.spin) {
      f.spin.rotation.y = t * (o.bulb === STAR_TIER ? 0.35 : 0.6);
      if (o.bulb === 9) f.gems.forEach((gm, i) => setSRGB(gm.material.color, hsl((t * 90 + i * 51) % 360, 0.9, 0.6)));
      if (o.bulb === FIRE_TIER) f.gems.forEach((gm, i) => gm.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(t * 11 + i * 2))));
    }
  }
  // 第三世界：列車在開的時候，天花板的燈和吊燈跟著車身輕輕晃（以天花板為支點）
  if (isW3()) {
    const sw = Math.sin(t * 2.2) * 0.03 * trainK() + Math.sin(t * 5.1) * 0.008 * trainK();
    for (const [o, f] of fixMap) {
      if (o.type !== 'socket' && o.type !== 'chand') continue;
      const a = sw * (o.type === 'chand' ? 1.5 : 1);
      f.g.rotation.z = a; f.g.position.x = o.x + 0.5 + Math.sin(a) * WALL_H; f.g.position.y = WALL_H * (1 - Math.cos(a));
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
let stickFaceTex, momoFaceTex, crawlerFaceTex, clownFaceTex, eyeballTex, irisTex, leafTex, stripeTex, balloonTex, strandTex, leafMatS;
let staticTex, staticCv, staticCtx, staticImg, leafMat;
function makeMonsterTextures() {
  const faceT = draw => { const t = canvasTex(512, 512, c => draw(c, 512)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  stickFaceTex = faceT(drawStickFace);
  momoFaceTex = faceT((c, S) => drawMomoFace(c, S, true));       // 垂下來的頭髮用 3D 髮束
  crawlerFaceTex = faceT((c, S) => drawCrawlerFace(c, S, true));
  // 一束頭髮：一根根直直的髮絲，中間密、兩邊稀疏、髮尾長短不齊
  strandTex = canvasTex(64, 256, (c) => {
    for (let i = 0; i < 150; i++) {
      const x = 32 + (rnd() + rnd() + rnd() - 1.5) * 38, end = 165 + rnd() * 91, g = 14 + rnd() * 32 | 0, edge = Math.min(1, Math.abs(x - 32) / 28);
      c.strokeStyle = `rgba(${g},${g - 2},${g + 5},${(0.95 - edge * 0.4).toFixed(2)})`;
      c.lineWidth = 1.5 + rnd() * 2.5 - edge;
      c.beginPath(); c.moveTo(x + (32 - x) * 0.15, 0);
      c.bezierCurveTo(x + (rnd() - 0.5) * 6, end * 0.4, x + (rnd() - 0.5) * 10, end * 0.75, x + (rnd() - 0.5) * 12, end); c.stroke();
    }
  }, true);
  strandTex.wrapS = strandTex.wrapT = THREE.ClampToEdgeWrapping;
  clownFaceTex = faceT(drawClownFace);
  // 眼球：正面（u = 0.25）是白的、越往後越紅，血絲從外圍彎彎曲曲地往瞳孔長
  eyeballTex = canvasTex(1024, 512, (c) => paintEyeball(c, 1024, 512), true);
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
  leafMatS = patchLM(new THREE.MeshLambertMaterial({ map: leafTex }), 0.7);  // 向日葵眼的葉子（有明暗）
}
// 球面眼球貼圖（寬 W、高 H = W / 2，正面 u = 0.25 是瞳孔）：眼白越往後越紅、虹膜周圍淡淡的陰影、
// 一塊一塊淡淡的充血，再畫上真實的血絲（drawVeins 在 game.js）；後面是比較粗的血管
function paintEyeball(c, W, H) {
  const sc = W / 512, cx = W / 4, cy = H / 2, img = c.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const lon = (x - cx) / W * Math.PI * 2, lat = (cy - y) / H * Math.PI;
    const th = Math.acos(clamp(Math.cos(lat) * Math.cos(lon), -1, 1)); // 離正面的角度
    const k = clamp((th - 0.35) / 1.5, 0, 1), i = (y * W + x) * 4;
    img.data[i] = 247 - k * 40; img.data[i + 1] = 241 - k * 120; img.data[i + 2] = 230 - k * 112; img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2, d = (60 + rnd() * 70) * sc, x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d, rr = (14 + rnd() * 26) * sc;
    const g = c.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, `rgba(215,90,95,${0.1 + rnd() * 0.12})`); g.addColorStop(1, 'rgba(215,90,95,0)');
    c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  const g = c.createRadialGradient(cx, cy, 30 * sc, cx, cy, 52 * sc);
  g.addColorStop(0, 'rgba(90,70,60,.35)'); g.addColorStop(1, 'rgba(90,70,60,0)');
  c.fillStyle = g; c.fillRect(cx - 52 * sc, cy - 52 * sc, 104 * sc, 104 * sc);
  drawVeins(c, cx, cy, 36 * sc, 132 * sc, 28, 2468, sc, W);
  drawVeins(c, cx + W / 2, cy, 10 * sc, 140 * sc, 10, 1357, 1.6 * sc, W);
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
const UP = new THREE.Vector3(0, 1, 0), Z_AXIS = new THREE.Vector3(0, 0, 1), _qI = new THREE.Quaternion(), _v2 = new THREE.Vector3();
function limb(g, a, b, r, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), dir = vb.clone().sub(va);
  const m = new THREE.Mesh(geo(`limb${r}`, () => new THREE.CylinderGeometry(r, r, 1, 7)), mat);
  m.scale.set(1, dir.length(), 1);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  g.add(m);
  return m;
}

// ---------- 會飄的頭髮（爬行女、鳥腳女） ----------
// 一束一束的髮片合成一個網格；擺動在 vertex shader 裡算，不用每幀改頂點
// 每束：a 髮根、b 中間彎的地方、c 髮尾（二次貝茲曲線；有 d 的話是 a→b→c→d 的三次曲線，d 是髮尾）、
// w 寬度、f 面向（繞 y 軸的角度，0 是面向 +z）、ph 擺動相位、tp 髮尾變細多少（0 不變細）
// 每束的貼圖左右輪流翻過來，排在一起才不會像一條條一樣的直紋
// aHair.x：髮根 0 → 髮尾 1（越往髮尾擺越大）；aHair.y：相位
function hairGeo(key, strands, seg = 8) {
  return geo(key, () => {
    const pos = [], uv = [], hr = [], idx = [];
    strands.forEach(({ a, b, c, d, w, f = 0, ph = 0, tp = 0.45 }, si) => {
      const base = pos.length / 3, sx = Math.cos(f), sz = -Math.sin(f), u0 = si % 2;
      for (let i = 0; i <= seg; i++) {
        const k = i / seg, u = 1 - k;
        const q = d ? j => u * u * u * a[j] + 3 * u * u * k * b[j] + 3 * u * k * k * c[j] + k * k * k * d[j]
          : j => u * u * a[j] + 2 * u * k * b[j] + k * k * c[j];
        const x = q(0), y = q(1), z = q(2), hw = w * (1 - k * tp) / 2;
        pos.push(x - sx * hw, y, z - sz * hw, x + sx * hw, y, z + sz * hw);
        uv.push(u0, 1 - k, 1 - u0, 1 - k);
        hr.push(k, ph, k, ph);
        if (i < seg) { const n = base + i * 2; idx.push(n, n + 2, n + 1, n + 1, n + 2, n + 3); }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aHair', new THREE.Float32BufferAttribute(hr, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}
// 頭髮的材質：會被燈光照亮；uniform 每隻怪物各一份（material.userData.hair）
// uHT 時間、uHAmp 自己飄的幅度、uHDrag 整片被甩的偏移（x 左右、y 前後）、uHLift 往上飄
// map 換成草葉貼圖就是會搖的草（草叢人）；shade 是自己的明暗
function hairMat(map = strandTex, shade = 0) {
  const u = { uHT: { value: 0 }, uHAmp: { value: 0.015 }, uHDrag: { value: new THREE.Vector2() }, uHLift: { value: 0 } };
  const m = ownLM('#ffffff', { map, alphaTest: 0.35, side: THREE.DoubleSide, transparent: true, shade });
  const lmCompile = m.onBeforeCompile;
  m.onBeforeCompile = (sh, rd) => {
    lmCompile(sh, rd);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aHair;\nuniform float uHT, uHAmp, uHLift;\nuniform vec2 uHDrag;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float hk = aHair.x * aHair.x;
        transformed.x += (sin(uHT * 1.9 + aHair.y + aHair.x * 2.4) * uHAmp + uHDrag.x) * hk;
        transformed.z += (cos(uHT * 1.4 + aHair.y * 1.3 + aHair.x * 1.8) * uHAmp * 0.7 + uHDrag.y) * hk;
        transformed.y += uHLift * hk;`);
  };
  m.customProgramCacheKey = () => 'lightmap-hair';
  m.userData.hair = u;
  return m;
}
// 簡單的彈簧：讓頭髮被甩的時候會晃一晃才停（s 存狀態，回傳現在的值）
function spring(s, key, target, dt, k = 120, damp = 9) {
  const v = key + 'V';
  s[v] = (s[v] || 0) + ((target - (s[key] || 0)) * k - (s[v] || 0) * damp) * dt;
  s[key] = (s[key] || 0) + s[v] * dt;
  return s[key];
}
// 臉：中間往前凸的曲面（被光照到才有立體的明暗），UV 跟平面一樣
// size 平面大小、rx ry 臉（橢圓）的半徑、cy 臉的中心往上偏多少、bulge 凸出多少
function faceGeo(key, size, rx, ry, cy, bulge) {
  return geo(key, () => {
    const g = new THREE.PlaneGeometry(size, size, 16, 16), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) / rx, y = (p.getY(i) - cy) / ry, k = 1 - x * x - y * y;
      p.setZ(i, k > 0 ? bulge * Math.sqrt(k) : 0);
    }
    g.computeVertexNormals();
    return g;
  });
}

// 火柴人：又高又瘦的黑色線條身體、垂到膝蓋的長手和長手指、一隻手慢慢地揮、頭歪一邊
// 線條像手繪動畫一樣一格一格地抖（每秒 10 格），走路時兩條腿一前一後地交叉；越靠近你越興奮（揮得更快、抖得更兇、頭一直抽）
const STICK_BONES = [
  ['neck', 'hip', 0.022], ['neck', 'head', 0.02],
  ['hip', 'kneeL', 0.02], ['kneeL', 'footL', 0.018], ['hip', 'kneeR', 0.02], ['kneeR', 'footR', 0.018],
  ['arms', 'elbL', 0.018], ['elbL', 'handL', 0.016], ['arms', 'elbR', 0.018], ['elbR', 'handR', 0.016],
  ['handL', 'fL0', 0.008], ['handL', 'fL1', 0.008], ['handL', 'fL2', 0.008],
  ['handR', 'fR0', 0.008], ['handR', 'fR1', 0.008], ['handR', 'fR2', 0.008],
];
const STICK_JOINTS = ['neck', 'head', 'hip', 'kneeL', 'footL', 'kneeR', 'footR', 'arms', 'elbL', 'handL', 'elbR', 'handR', 'fL0', 'fL1', 'fL2', 'fR0', 'fR1', 'fR2'];
function buildStick(r, g) {
  const ink = ownBasic({ color: 0x151515, transparent: true });
  r.bones = STICK_BONES.map(([a, b, w]) => ({ a, b, m: limb(g, [0, 0, 0], [0, 1, 0], w, ink) }));
  r.joints = Object.fromEntries(STICK_JOINTS.map(k => [k, new THREE.Vector3()]));
  const faceMat = ownBasic({ map: stickFaceTex, transparent: true, alphaTest: 0.3, color: 0xb4b0aa });
  r.face = new THREE.Mesh(geo('stickface2', () => new THREE.PlaneGeometry(0.44, 0.44)), faceMat);
  g.add(r.face);
  r.mats.push(ink, faceMat);
}
// 讓一根線（limb 做的圓柱）從 a 連到 b
const tmpLimb = new THREE.Vector3();
function aimLimb(m, a, b) {
  tmpLimb.subVectors(b, a);
  const len = tmpLimb.length() || 1e-4;
  m.scale.set(1, len, 1);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, tmpLimb.multiplyScalar(1 / len));
}
// 0～1 的雜湊亂數（同一格動畫裡每個關節抖的方向固定）
const hash01 = n => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
function poseStick(e, r, d, t, dt) {
  const J = r.joints, w = e.wob * 4.2, set = (k, x, y, z) => J[k].set(x, y, z), near = clamp(1 - (d - 1.2) / 3, 0, 1);
  // 揮手和抽動的相位用累加的，靠近時加速才不會突然跳一下
  r.wavePh = (r.wavePh || 0) + dt * (2.2 + near * 3.5); r.twPh = (r.twPh || e.wob) + dt * (1.9 + near * 5);
  set('neck', 0, 1.7, 0); set('head', 0, 1.8, 0.01); set('hip', 0, 1.02, 0); set('arms', 0, 1.54, 0);
  // 兩條腿：大腿前後擺，往後時膝蓋彎起來
  for (const [s, ph] of [['L', 0], ['R', Math.PI]]) {
    const sw = Math.sin(w + ph) * 0.34, bend = Math.max(0, -Math.cos(w + ph)) * 0.55, x = s === 'L' ? -1 : 1;
    set('knee' + s, x * 0.08, 1.02 - Math.cos(sw) * 0.5, Math.sin(sw) * 0.5);
    set('foot' + s, x * 0.12, J['knee' + s].y - Math.cos(sw - bend) * 0.5, J['knee' + s].z + Math.sin(sw - bend) * 0.5);
  }
  // 左手：長長地垂到膝蓋，跟著走路晃
  const as = Math.sin(w) * 0.12;
  set('elbL', -0.2, 1.18, 0.03 + as * 0.3); set('handL', -0.26, 0.74, 0.08 + as);
  for (let i = 0; i < 3; i++) set('fL' + i, -0.27 + (i - 1) * 0.035, 0.6, 0.1 + as + (i - 1) * 0.02);
  // 右手：舉起來慢慢地揮
  const wave = 0.25 + Math.sin(r.wavePh) * 0.4;
  set('elbR', 0.36, 1.58, 0.05);
  set('handR', 0.36 + Math.sin(wave) * 0.36, 1.58 + Math.cos(wave) * 0.36, 0.08);
  for (let i = 0; i < 3; i++) { const a = wave + (i - 1) * 0.35; set('fR' + i, J.handR.x + Math.sin(a) * 0.14, J.handR.y + Math.cos(a) * 0.14, 0.09); }
  // 手繪動畫的抖動：每 0.1 秒換一格
  const tick = Math.floor(t * 10);
  STICK_JOINTS.forEach((k, i) => J[k].add(tmpLimb.set(hash01(tick * 31 + i) - 0.5, hash01(tick * 17 + i * 3) - 0.5, hash01(tick * 7 + i * 5) - 0.5).multiplyScalar(0.018 + near * 0.02)));
  for (const b of r.bones) aimLimb(b.m, J[b.a], J[b.b]);
  // 頭歪一邊，偶爾突然抽一下
  const twitch = Math.min(1, Math.max(0, Math.sin(r.twPh) - 0.9 + near * 0.3) * 10) * (Math.sin(e.wob * 0.37) < 0 ? -1 : 1);
  r.face.position.set(J.head.x, J.head.y + 0.17, 0.03);
  r.face.rotation.z = 0.32 + Math.sin(e.wob * 0.7) * 0.12 + twitch * 0.45 + (hash01(tick) - 0.5) * (0.04 + near * 0.1);
}
// 鳥腳女：反折的鳥腳和爪子、圓圓的身體、長鼻子凸出來的臉、直直的長黑髮（跳起來時會飄）
// 頭髮：臉兩邊垂到胸前、後面一整片垂到背上
function momoHair() {
  const S = [];
  for (const s of [-1, 1]) {
    S.push({ a: [s * 0.15, 1.72, 0.06], b: [s * 0.17, 1.38, 0.16], c: [s * 0.2, 1.08, 0.24], w: 0.065, f: s * 0.3, ph: s * 1.3 });
    S.push({ a: [s * 0.18, 1.71, 0.02], b: [s * 0.22, 1.4, 0.08], c: [s * 0.26, 1.02, 0.14], w: 0.07, f: s * 0.8, ph: s * 1.3 + 0.7 });
    S.push({ a: [s * 0.19, 1.72, -0.06], b: [s * 0.25, 1.42, -0.04], c: [s * 0.29, 0.98, 0], w: 0.08, f: s * 1.3, ph: s * 1.3 + 1.4 });
  }
  for (const x of [-0.13, -0.065, 0, 0.065, 0.13]) S.push({ a: [x, 1.82, -0.19], b: [x * 1.3, 1.5, -0.27], c: [x * 1.6, 0.92, -0.3], w: 0.085, f: Math.PI, ph: x * 8 + 2 });
  return S;
}
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
  const scalp = ownLM('#141216', { transparent: true });
  sph(g, 0.16, 0, 1.68, -0.1, scalp, 1, 1.1, 0.75, 12);
  const hairM = hairMat();
  g.add(new THREE.Mesh(hairGeo('momohair2', momoHair()), hairM));
  r.hairU = hairM.userData.hair;
  const faceMat = ownBasic({ map: momoFaceTex, transparent: true, alphaTest: 0.35, color: 0xc9c3bd });
  r.face = new THREE.Mesh(geo('momoface', () => new THREE.PlaneGeometry(0.58, 0.58)), faceMat);
  r.face.position.set(0, 1.64, 0.04); g.add(r.face);
  const nose = new THREE.Mesh(geo('nose', () => new THREE.ConeGeometry(0.03, 0.2, 8)), skin);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.6, 0.14); g.add(nose);
  r.mats.push(skin, leg, claw, scalp, hairM, faceMat);
}
// 爬行女：趴在地上、兩隻長手往前伸；長髮從頭頂垂到地上蓋住臉，只從髮縫露出一隻眼睛和嘴巴
// 臉是往前凸的曲面，被燈光、手電筒照到才看得清楚（不會自己發光）；眼睛被光照到時才有一點反光
// 頭往後仰 CRAWL_TILT，臉朝著斜上方的你；頭髮跟著爬的動作甩，頭抽動時一起抖
const CRAWL_TILT = 0.25, CRAWL_HEAD = [0, 0.52, 0.5];
function crawlerHair() {
  // 先用身體的座標排（頭髮直直往下垂），再換成仰著的頭的座標
  const c = Math.cos(CRAWL_TILT), sn = Math.sin(CRAWL_TILT), S = [];
  const H = ([x, y, z]) => { const dy = y - CRAWL_HEAD[1], dz = z - CRAWL_HEAD[2]; return [x, dy * c - dz * sn, dy * sn + dz * c]; };
  const add = (a, b, e, w, f, ph, d) => S.push({ a: H(a), b: H(b), c: H(e), d: d && H(d), w, f, ph, tp: 0.15 });
  // 臉前面一整片髮簾（一束疊一束）：從頭頂翻過額頭垂到地上，中間偏右留一條縫（看得到一隻眼睛和嘴巴）
  // 兩邊往後彎（圍著頭），髮尾長短不一
  const curtain = x => {
    const back = (x / 0.22) ** 2 * 0.07, j = Math.sin(x * 91) * 0.5 + 0.5;
    add([x * 0.6, 0.72, 0.39], [x * 0.9, 0.71, 0.6 - back], [x * 1.05, 0.35, 0.68 - back], 0.065, 0, x * 9 + j, [x * 1.12, 0.03 + j * 0.09, 0.67 - back + j * 0.03]);
  };
  for (let x = -0.215; x < 0; x += 0.03) curtain(x);
  for (let x = 0.105; x < 0.23; x += 0.03) curtain(x);
  // 臉兩邊垂到地上
  for (const s of [-1, 1]) for (const k of [0, 1]) add([s * (0.13 + k * 0.03), 0.62, 0.42 - k * 0.06], [s * (0.17 + k * 0.03), 0.42, 0.5 - k * 0.05], [s * (0.2 + k * 0.04), 0.03, 0.56 - k * 0.06], 0.09, s * 0.5, s * 2 + k);
  // 從頭頂往後披在肩膀和背上
  for (let x = -0.12; x < 0.13; x += 0.04) add([x * 0.8, 0.71, 0.42], [x * 1.4, 0.66, 0.12], [x * 1.8, 0.56, -0.3], 0.085, 0, x * 5 + 3);
  return S;
}
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
  r.head = new THREE.Group(); r.head.position.set(...CRAWL_HEAD); r.head.rotation.x = -CRAWL_TILT; r.body.add(r.head);
  const scalp = ownLM('#221f25', { transparent: true });
  sph(r.head, 0.13, 0, 0.064, -0.128, scalp, 1, 1.15, 1, 12);
  sph(r.body, 0.2, 0, 0.5, -0.02, scalp, 0.95, 0.32, 1.5, 12); // 披在肩膀和背上的頭髮底下那一層
  const faceMat = ownLM('#ffffff', { map: crawlerFaceTex, transparent: true, alphaTest: 0.35 });
  r.face = new THREE.Mesh(faceGeo('crawlface2', 0.46, 0.13, 0.16, -0.0126, 0.05), faceMat);
  r.head.add(r.face);
  const hairM = hairMat();
  r.head.add(new THREE.Mesh(hairGeo('crawlhair2', crawlerHair()), hairM));
  r.hairU = hairM.userData.hair;
  r.glint = ownSprite(glowTex, 0xffffff);
  r.glint.position.set(0.043, 0.0216, 0.052); r.glint.scale.setScalar(0.022); r.head.add(r.glint);
  r.mats.push(skin, dress, scalp, hairM, faceMat);
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
// 草叢人：平常只看得到一叢會動的長草（幾十片草葉各自搖）；站起來時，像樹幹一樣纏著藤蔓和鬚根的長身體和臉從草裡升上來
// 臉是往前凸的曲面，被燈光照到才有明暗；頭頂的草也會搖
function buildGrass(r, g) {
  const gm = hairMat(grassStrandTex, 0.6);
  r.tuft = new THREE.Group(); g.add(r.tuft);
  r.tuft.add(new THREE.Mesh(hairGeo('gtuft2', [...grassStrands(44, 0.34, 0.55, 1.05, 0.22, 4401), ...grassStrands(22, 0.2, 0.3, 0.55, 0.1, 4402)]), gm));
  r.grassU = gm.userData.hair;
  r.body = new THREE.Group(); g.add(r.body);
  const skin = ownLM('#a09a72', { map: stemTex, shade: 0.85, transparent: true }), streak = ownLM('#a4323a', { shade: 0.5, transparent: true });
  const vine = ownLM('#3f6a2c', { shade: 0.7, transparent: true }), root = ownLM('#5a4a30', { shade: 0.7, transparent: true });
  taper(r.body, [0, 0, 0], [0, 1.28, 0], 0.17, 0.11, skin, 10);
  limb(r.body, [0.06, 0.4, 0.13], [0.04, 1.1, 0.14], 0.02, streak);
  limb(r.body, [-0.07, 0.3, 0.12], [-0.05, 0.9, 0.13], 0.014, streak);
  for (let i = 0; i < 10; i++) { const a0 = i * 0.9, a1 = a0 + 0.9, y0 = 0.1 + i * 0.1, rr = 0.155 - i * 0.0045; limb(r.body, [Math.cos(a0) * rr, y0, Math.sin(a0) * rr], [Math.cos(a1) * (rr - 0.0045), y0 + 0.1, Math.sin(a1) * (rr - 0.0045)], 0.016, vine); }
  for (const s of [-1, 1]) {
    taper(r.body, [s * 0.13, 1.1, 0.02], [s * 0.3, 0.75, 0.25], 0.035, 0.025, skin);
    taper(r.body, [s * 0.3, 0.75, 0.25], [s * 0.22, 0.45, 0.45], 0.025, 0.018, skin);
    for (let k = 0; k < 3; k++) limb(r.body, [s * 0.22, 0.45, 0.45], [s * (0.22 + (k - 1) * 0.05), 0.3, 0.52 + k * 0.02], 0.008, root);
  }
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; limb(r.body, [Math.cos(a) * 0.12, 0.3, Math.sin(a) * 0.12], [Math.cos(a) * 0.3, -0.1, Math.sin(a) * 0.3], 0.012, root); }
  const faceMat = ownLM('#ffffff', { map: grassFaceTex, transparent: true, alphaTest: 0.3, shade: 0.6 });
  r.face = new THREE.Mesh(faceGeo('grassface2', 0.62, 0.145, 0.24, -0.04, 0.07), faceMat);
  r.face.position.set(0, 1.5, 0.08); r.body.add(r.face);
  const hm = hairMat(grassStrandTex, 0.6);
  r.body.add(new THREE.Mesh(hairGeo('ghead', grassStrands(26, 0.1, 0.25, 0.45, 0.12, 4403, 1.63, 0.06, 0.6)), hm));
  r.headU = hm.userData.hair;
  r.mats.push(gm, skin, streak, vine, root, faceMat, hm);
}
// 大嘴觸角蟲：粉紅色的大肉團（蛞蝓形、濕濕的皮有皺紋和疙瘩，被手電筒照到會反光）、4 根長著眼睛的觸角、
// 一圈肉唇和上下兩排尖牙的大嘴（3D 的，咬完會一張一合地嚼）、嘴邊兩顆嵌在肉裡的大眼睛、身體下面一排小芽
function buildSnail(r, g) {
  const skin = ownPhong('#ffffff', { map: snailSkinTex, specular: 0x664455, shininess: 22, shade: 0.8, transparent: true });
  const skin2 = ownPhong('#ffd9e2', { map: snailSkinTex, specular: 0x664455, shininess: 22, shade: 0.8, transparent: true });
  const lip = ownLM('#b84a62', { shade: 0.8, transparent: true }), inner = ownLM('#2a0408', { transparent: true }), tooth = ownLM('#efe4cf', { shade: 0.7, transparent: true });
  const eye = wetEyeMat(bigEyeTex, 0x2a1a1a, 0x444444, { transparent: true });
  const drool = ownPhong('#eef3d2', { transparent: true, opacity: 0.6, specular: 0xffffff, shininess: 50, depthWrite: false });
  r.body = new THREE.Group(); g.add(r.body);
  const body = new THREE.Mesh(slugGeo(), skin); body.position.set(0, 0.27, -0.08); body.castShadow = true; body.receiveShadow = true; r.body.add(body);
  sph(r.body, 0.36, 0, 0.42, 0.32, skin2, 0.95, 0.85, 0.75, 18);
  // 背上的疙瘩
  for (let i = 0; i < 16; i++) {
    const a = i * 2.39, d = 0.25 + (i % 5) * 0.09, x = Math.cos(a) * d * 0.55, z = Math.sin(a) * d - 0.08, q = 1 - (x / 0.46) ** 2 - ((z + 0.08) / 0.68) ** 2;
    if (q > 0.05) sph(r.body, 0.025 + (i % 3) * 0.01, x, 0.26 + 0.34 * Math.sqrt(q), z, skin2, 1, 0.7, 1, 6);
  }
  // 大嘴
  r.mouth = new THREE.Group(); r.mouth.position.set(0, 0.36, 0.55); r.body.add(r.mouth);
  sph(r.mouth, 0.2, 0, 0, 0, inner, 1.25, 0.72, 0.3, 14).castShadow = false;
  const lipM = new THREE.Mesh(geo('snlip', () => new THREE.TorusGeometry(0.22, 0.035, 10, 24)), lip); lipM.scale.set(1.15, 0.7, 1); lipM.position.z = 0.06; r.mouth.add(lipM);
  const toothG = geo('tooth', () => new THREE.ConeGeometry(0.018, 0.075, 6));
  for (let i = 0; i < 11; i++) { const a = 0.2 + i / 10 * (Math.PI - 0.4), x = Math.cos(a) * 0.23; const th = new THREE.Mesh(toothG, tooth); th.position.set(x, Math.sin(a) * 0.14 - 0.01, 0.07); th.rotation.x = Math.PI; th.rotation.z = x * 0.6; r.mouth.add(th); }
  for (let i = 0; i < 9; i++) { const a = Math.PI + 0.3 + i / 8 * (Math.PI - 0.6), x = Math.cos(a) * 0.22; const th = new THREE.Mesh(toothG, tooth); th.position.set(x, Math.sin(a) * 0.13 + 0.01, 0.07); th.rotation.z = -x * 0.6; r.mouth.add(th); }
  for (const [x, len] of [[-0.09, 0.16], [0.06, 0.24], [0.15, 0.1]]) limb(r.mouth, [x, -0.11, 0.08], [x + 0.01, -0.11 - len, 0.07], 0.01, drool);
  // 嘴邊的大眼睛：一圈肉的眼眶，眼球微微往外看
  for (const s of [-1, 1]) {
    const ring = new THREE.Mesh(geo('snlid', () => new THREE.TorusGeometry(0.07, 0.022, 8, 16)), skin2); ring.position.set(s * 0.27, 0.52, 0.47); ring.rotation.y = s * 0.5; r.body.add(ring);
    const eb = new THREE.Mesh(geo('sneye', () => new THREE.SphereGeometry(0.068, 14, 10)), eye); eb.position.set(s * 0.27, 0.52, 0.47); eb.rotation.y = s * 0.25; r.body.add(eb);
  }
  // 觸角：一頭粗一頭細，尖端長著眼睛
  r.stalks = new THREE.Group(); r.stalks.position.set(0, 0.62, 0.12); r.body.add(r.stalks);
  for (const [x, z] of [[-0.3, 0.1], [-0.12, 0.2], [0.12, 0.2], [0.3, 0.1]]) {
    taper(r.stalks, [x * 0.5, 0, 0], [x, 0.45, z], 0.04, 0.022, skin2, 8);
    const ring = new THREE.Mesh(geo('snlid2', () => new THREE.TorusGeometry(0.05, 0.016, 8, 14)), skin2); ring.position.set(x, 0.47, z); r.stalks.add(ring);
    const e = new THREE.Mesh(geo('stalkeye', () => new THREE.SphereGeometry(0.065, 12, 10)), eye); e.position.set(x, 0.47, z); r.stalks.add(e);
  }
  const sprout = ownLM('#efe6d6', { shade: 0.6, transparent: true }), stem = ownLM('#7a8a6a', { transparent: true });
  for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; limb(r.body, [Math.cos(a) * 0.55, 0, Math.sin(a) * 0.62 - 0.1], [Math.cos(a) * 0.58, 0.12, Math.sin(a) * 0.66 - 0.1], 0.01, stem); sph(r.body, 0.035, Math.cos(a) * 0.58, 0.14, Math.sin(a) * 0.66 - 0.1, sprout, 1, 1, 1, 6); }
  r.mats.push(skin, skin2, lip, inner, tooth, eye, drool, sprout, stem);
}
// 眼花女孩：藍色上衣、白領子、百褶裙、白襪黑鞋，流血的手；短短的黑髮是一束一束會飄的 3D 髮束（瀏海、兩側、後面）
// 臉是往前凸的曲面，被燈光照到才有明暗；左眼是真的眼球（濕濕的、會反光、會微微抖），右眼是黑洞，長出開著眼球花的樹枝
function girlHair() {
  const r = seeded(2024), S = [];
  // 瀏海：兩層，從頭皮裡長出來、往前翻、垂到眉毛，一束一束長短不齊
  for (const [z0, z1, dy] of [[0.02, 0.19, 0], [-0.01, 0.165, 0.02]]) for (let x = -0.16; x <= 0.161; x += 0.025) { const j = r(); S.push({ a: [x * 0.6, 1.75 + dy, z0], b: [x * 0.95, 1.77, z1 - 0.03], c: [x, 1.66 - j * 0.04, z1], w: 0.065, f: 0, ph: x * 9 + j, tp: 0.35 }); }
  // 兩側：好幾層蓋住耳朵、垂到下巴
  for (const s of [-1, 1]) for (let k = 0; k < 6; k++) { const j = r(); S.push({ a: [s * (0.11 + k * 0.012), 1.78, 0.06 - k * 0.05], b: [s * (0.2 + k * 0.006), 1.62, 0.07 - k * 0.05], c: [s * (0.21 + k * 0.012), 1.34 - j * 0.06, 0.05 - k * 0.05], w: 0.09, f: s * (1.1 + k * 0.15), ph: s * 2 + k, tp: 0.3 }); }
  // 後面：從頭頂披到肩膀
  for (let x = -0.15; x <= 0.151; x += 0.03) { const j = r(); S.push({ a: [x * 0.7, 1.8, -0.1], b: [x * 1.2, 1.62, -0.25], c: [x * 1.35, 1.32 - j * 0.06, -0.25], w: 0.09, f: Math.PI, ph: x * 7 + 3, tp: 0.3 }); }
  return S;
}
function buildGirl(r, g) {
  const top = ownLM('#5f7fae', { shade: 0.75, transparent: true }), skirt = ownLM('#ffffff', { map: pleatTex, shade: 0.7, transparent: true }), skin = ownLM('#d8cfc4', { shade: 0.75, transparent: true });
  const blood = ownLM('#a3121c', { shade: 0.6, transparent: true }), branch = ownLM('#5c3a22', { shade: 0.7, transparent: true }), petal = ownLM('#e88aa8', { shade: 0.7, transparent: true });
  const eye = wetEyeMat(flowerEyeTex, 0x2a1a1a, 0x444444, { transparent: true }), white = ownLM('#f2efe8', { shade: 0.6, transparent: true });
  const sock = ownLM('#eeeeee', { shade: 0.7, transparent: true }), shoe = ownLM('#222226', { shade: 0.7, transparent: true }), hemM = ownLM('#2f3f5c', { shade: 0.7, transparent: true });
  for (const s of [-1, 1]) { limb(g, [s * 0.08, 0.1, 0], [s * 0.08, 0.62, 0], 0.035, skin); limb(g, [s * 0.08, 0.02, 0], [s * 0.08, 0.14, 0], 0.038, sock); sph(g, 0.05, s * 0.08, 0.03, 0.03, shoe, 1, 0.6, 1.5, 8); }
  const sk = new THREE.Mesh(geo('gskirt2', () => new THREE.ConeGeometry(0.3, 0.45, 28, 1, true)), skirt); sk.position.y = 0.72; g.add(sk);
  const hem = new THREE.Mesh(geo('ghem', () => new THREE.TorusGeometry(0.3, 0.012, 6, 28)), hemM); hem.rotation.x = Math.PI / 2; hem.position.y = 0.5; g.add(hem);
  cyl(g, 0.16, 0.2, 0.5, 0, 0.92, 0, top, 14);
  const collar = new THREE.Mesh(geo('gcollar', () => new THREE.TorusGeometry(0.15, 0.014, 6, 16)), white); collar.rotation.x = Math.PI / 2; collar.position.y = 1.41; g.add(collar);
  limb(g, [0, 1.38, 0], [0, 1.5, 0], 0.045, skin);
  for (const s of [-1, 1]) {
    taper(g, [s * 0.2, 1.36, 0], [s * 0.26, 0.92, 0.06], 0.04, 0.03, top);
    taper(g, [s * 0.26, 0.92, 0.06], [s * 0.27, 0.68, 0.1], 0.028, 0.022, skin);
    sph(g, 0.045, s * 0.27, 0.64, 0.11, blood, 1, 1.1, 0.8, 8);
    for (let k = -1; k <= 1; k++) limb(g, [s * 0.27, 0.62, 0.11], [s * 0.27 + k * 0.025, 0.54, 0.13], 0.008, blood);
  }
  // 頭：一顆黑色的頭皮（髮束之間不會露出皮膚，露出來的地方就是頭頂的頭髮），臉貼在頭的前面
  const scalp = ownLM('#141216', { shade: 0.5, transparent: true });
  sph(g, 0.175, 0, 1.65, -0.03, scalp, 1, 1.05, 1, 14);
  const faceMat = ownLM('#ffffff', { map: girlFaceTex, transparent: true, alphaTest: 0.3, shade: 0.55 });
  r.face = new THREE.Mesh(faceGeo('girlface2', 0.5, 0.13, 0.165, -0.012, 0.07), faceMat);
  r.face.position.set(0, 1.62, 0.1); g.add(r.face);
  r.eye = new THREE.Mesh(geo('geye', () => new THREE.SphereGeometry(0.04, 14, 10)), eye); r.eye.position.set(-0.055, 1.624, 0.146); g.add(r.eye);
  const hairM = hairMat(strandTex, 0.5);
  g.add(new THREE.Mesh(hairGeo('girlhair3', girlHair()), hairM));
  r.hairU = hairM.userData.hair;
  // 從右眼長出來的樹枝和兩顆眼球花（被手電筒照到會閉起來）
  r.blooms = [];
  taper(g, [0.055, 1.625, 0.15], [0.36, 1.9, 0.18], 0.022, 0.014, branch);
  limb(g, [0.24, 1.8, 0.16], [0.42, 1.72, 0.2], 0.012, branch);
  for (const [x, y, z, s] of [[0.38, 1.94, 0.19, 1], [0.44, 1.71, 0.21, 0.8]]) {
    const bl = new THREE.Group(); bl.position.set(x, y, z); bl.scale.setScalar(s); g.add(bl);
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2, p = sph(bl, 0.05, Math.cos(a) * 0.075, Math.sin(a) * 0.075, -0.01, petal, 1, 0.55, 0.4, 6); p.rotation.z = a; }
    const e = new THREE.Mesh(geo('bloomeye', () => new THREE.SphereGeometry(0.055, 12, 10)), eye); bl.add(e);
    r.blooms.push(bl);
  }
  r.mats.push(top, skirt, skin, blood, branch, petal, eye, white, sock, shoe, hemM, scalp, faceMat, hairM);
}
const NEW_BUILD = { stick: buildStick, momo: buildMomo, crawler: buildCrawler, balloon: buildBalloon, clown: buildClown, grass: buildGrass, snail: buildSnail, girl: buildGirl };

function syncNewMonster(e, r, t, p = G.p) {
  const d = Math.hypot(e.x - p.x, e.y - p.y);
  const dt = clamp(t - (r.lastT ?? t), 0, 0.1);   // 這一幀過了多久（頭髮的彈簧、火柴人的動作用）
  r.lastT = t;
  switch (e.kind) {
    case 'stick': {
      poseStick(e, r, d, t, dt);
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
      const look = e.state !== 'hunt' && e.stun <= 0 ? Math.sin(t * 1.7) * 0.9 : 0;
      r.g.rotation.y += look; // 東張西望
      // 頭髮：跳起來時往上飄、落地時甩一下；轉頭時髮尾慢半拍；手電筒照到眼鏡、她甩頭時跟著甩
      const hu = r.hairU, turn = dt > 0 ? (look - (r.look ?? look)) / dt : 0;
      r.look = look;
      hu.uHT.value = t;
      hu.uHAmp.value = 0.012 + (e.hopping > 0 ? 0.02 : 0);
      hu.uHLift.value = spring(r, 'hl', (e.air || 0) * 0.16, dt, 90, 7);
      hu.uHDrag.value.set(
        spring(r, 'hx', clamp(-turn * 0.05, -0.08, 0.08) + (e.stun > 0 ? Math.sin(t * 30) * 0.03 : 0), dt),
        spring(r, 'hz', e.hopping > 0 ? -0.04 : 0, dt));
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
        r.head.rotation.z = moving ? 0 : Math.sin(t * 25) * 0.15; // 停下來時頭會抽動
      }
      // 頭髮：爬的時候跟著身體左右甩、髮尾拖在後面；停下來時輕輕晃
      const crawl = !(e.emerge > 0) && e.pauseT <= 0, hu = r.hairU;
      hu.uHT.value = t;
      hu.uHAmp.value += ((crawl ? 0.04 : 0.015) - hu.uHAmp.value) * Math.min(1, dt * 4);
      hu.uHDrag.value.set(spring(r, 'hx', crawl ? Math.sin(e.wob * 8 - 0.8) * 0.03 : 0, dt), spring(r, 'hz', crawl ? -0.04 : 0, dt));
      // 眼睛只有被手電筒或燈照到時才反光
      const lit = clamp((inBeam(e) ? 1 : 0) + lightAt(e.x, e.y) * 0.7, 0, 1);
      r.glint.material.opacity = lit * enemyAlpha(e) * (0.75 + 0.25 * Math.sin(t * 3));
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
      // 草叢一直在晃：躲著走的時候每片草沙沙地抖，撲過來時草往後倒；站起來時身體和臉從草裡升上來，頭頂的草也在搖
      const k = e.rise || 0, hidden = e.hidden, gu = r.grassU, hu = r.headU;
      gu.uHT.value = t; hu.uHT.value = t;
      gu.uHAmp.value += ((hidden ? 0.06 : 0.025) - gu.uHAmp.value) * Math.min(1, dt * 5);
      hu.uHAmp.value = e.state === 'grab' ? 0.05 : 0.02;
      gu.uHDrag.value.set(spring(r, 'gx', hidden ? Math.sin(e.wob * 9) * 0.03 : 0, dt), spring(r, 'gz', e.state === 'lunge' ? -0.12 : 0, dt));
      r.tuft.rotation.z = Math.sin(e.wob * (hidden ? 9 : 3)) * (hidden ? 0.06 : 0.02);
      r.tuft.scale.set(1, hidden ? 0.92 + Math.abs(Math.sin(e.wob * 7)) * 0.16 : 1, 1);
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
      r.mouth.scale.y = e.chew > 0 ? 0.55 + Math.abs(Math.sin(t * 14)) * 0.6 : 0.92 + 0.08 * Math.sin(t * 2);  // 嚼：一張一合
      r.g.position.y = 0;
      break;
    }
    case 'girl': {
      // 被手電筒照到時，樹枝上的眼球花會閉起來
      const shut = e.blind > 0 ? 0.15 : 1;
      for (const bl of r.blooms) bl.scale.y += (shut * bl.scale.x - bl.scale.y) * 0.25;
      r.face.rotation.z = e.blind > 0 ? Math.sin(t * 6) * 0.15 : Math.sin(e.wob * 0.9) * 0.06;
      r.g.position.y = Math.sin(e.wob * 1.5) * 0.03;
      // 眼球微微抖；頭髮走路時跟著晃、被照瞎了甩頭時甩得更厲害，追你時往後飄
      r.eye.rotation.set(Math.sin(t * 9) * 0.05, Math.sin(t * 6.3) * 0.08 - 0.1, 0);
      const moving = e.state === 'hunt' || e.blind > 0, hu = r.hairU;
      hu.uHT.value = t;
      hu.uHAmp.value += ((moving ? 0.03 : 0.012) - hu.uHAmp.value) * Math.min(1, dt * 4);
      hu.uHDrag.value.set(spring(r, 'hx', e.blind > 0 ? Math.sin(t * 6) * 0.05 : Math.sin(e.wob * 1.5) * 0.01, dt), spring(r, 'hz', e.state === 'hunt' ? -0.03 : 0, dt));
      hu.uHLift.value = spring(r, 'hl', e.state === 'hunt' ? 0.02 : 0, dt);
      break;
    }
  }
}

// 眼球和虹膜：濕濕的、被手電筒照到會反光；自己有明暗（球的邊緣暗）
const wetEyeMat = (map, emissive, specular = 0x444444, extra = {}) => ownPhong('#ffffff', { map, emissive, specular, shininess: 70, shade: 0.6, ...extra });
// 一頭粗一頭細的圓柱（觸角、莖、手臂）
function taper(g, a, b, r0, r1, mat, seg = 8) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), dir = vb.clone().sub(va);
  const m = new THREE.Mesh(geo(`tp${r0},${r1},${seg}`, () => new THREE.CylinderGeometry(r1, r0, 1, seg)), mat);
  m.scale.set(1, dir.length(), 1);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  m.castShadow = true;
  g.add(m);
  return m;
}
// 花瓣：根在 y=0、尖在 y=len，越往尖端越往 curl 的方向彎，中間微微凹（貼圖 v=0 是根、v=1 是尖）
function petalGeo(key, w, len, curl) {
  return geo(key, () => {
    const g = new THREE.PlaneGeometry(w, len, 3, 8), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = p.getY(i) / len + 0.5, x = p.getX(i) / (w / 2);
      p.setY(i, k * len);
      p.setZ(i, curl * k * k * k + x * x * w * 0.25 * (1 - k * 0.6));
    }
    g.computeVertexNormals();
    return g;
  });
}
// 微微凸起的圓盤（葵花籽那一面），貼圖照平面貼
function domeGeo(key, R, h) {
  return geo(key, () => {
    const g = new THREE.RingGeometry(0, R, 28, 6), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i) / R, y = p.getY(i) / R; p.setZ(i, h * Math.sqrt(Math.max(0, 1 - x * x - y * y))); }
    g.computeVertexNormals();
    return g;
  });
}
// 眼皮：眼球前面半邊、從頭頂 th0 到 th1 的一片球殼（下眼皮用 scale.y = -1 翻過來）
const lidGeo = (key, r, th0, th1) => geo(key, () => new THREE.SphereGeometry(r, 20, 8, 0, Math.PI, th0, th1 - th0));
// 一叢草：n 片草葉長在半徑 R 的圓裡，高 h0～h1，往外倒 lean（用頭髮的做法，風吹會各自搖）
function grassStrands(n, R, h0, h1, lean, seed, dy = 0, dz = 0, wk = 1) {
  const r = seeded(seed), S = [];
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R, bx = Math.cos(a) * d, bz = Math.sin(a) * d + dz;
    const h = h0 + r() * (h1 - h0), out = lean * (0.5 + r()), ox = Math.cos(a) * out, oz = Math.sin(a) * out;
    S.push({ a: [bx, dy, bz], b: [bx + ox * 0.4, dy + h * 0.6, bz + oz * 0.4], c: [bx + ox, dy + h, bz + oz], w: (0.05 + r() * 0.05) * wk, f: a + Math.PI / 2 + (r() - 0.5) * 0.6, ph: r() * 6, tp: 0.8 });
  }
  return S;
}
// 大嘴觸角蟲的身體：前面胖、後面尖的蛞蝓形，底部平、表面凹凸不平
function slugGeo() {
  return geo('slug', () => {
    const g = new THREE.SphereGeometry(1, 30, 20), p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + 0.06 * Math.sin(5 * v.y + 2 * v.z) * Math.cos(3 * v.x) + 0.035 * Math.sin(9 * v.z + 1.5) * Math.sin(7 * v.x);
      const tail = v.z < -0.2 ? 1 - (-v.z - 0.2) / 0.8 * 0.45 : 1, flat = v.y < 0 ? 0.75 : 1;
      p.setXYZ(i, v.x * k * 0.46 * tail, v.y * k * 0.34 * tail * flat, v.z * k * 0.68);
    }
    g.computeVertexNormals();
    return g;
  });
}
// 虹膜：微微凸起的圓片（像眼角膜），邊緣貼著眼球表面，中間不會被眼球的面穿過去（以前會露出一塊白色菱形）
// ballR 眼球半徑、irisR 虹膜半徑、z0 眼球中心的 z
function irisGeo(key, ballR, irisR, z0) {
  return geo(key, () => {
    const g = new THREE.RingGeometry(0, irisR, 28, 4), p = g.attributes.position;
    const R = irisR * 1.8, edge = z0 + Math.sqrt(ballR * ballR - irisR * irisR) + 0.002, base = Math.sqrt(R * R - irisR * irisR);
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, edge + Math.sqrt(Math.max(0, R * R - x * x - y * y)) - base); }
    g.computeVertexNormals();
    return g;
  });
}
// 向日葵眼：有點彎的粗莖、垂下來的葉子；花盤鋪滿葵花籽、兩圈彎彎的花瓣（有的枯掉捲起來）；
// 中間是一圈暗紅色的眼眶，嵌著一顆布滿血絲的大眼睛，血管從眼睛爬到花盤上；上下眼皮會眨、被手電筒照到會瞇起來
function buildSunflower(f, g) {
  const r = seeded(Math.round(f.x * 131 + f.y * 17) + 7);
  const stem = ownLM('#5a9a40', { map: stemTex, shade: 0.8 });
  taper(g, [0, 0, 0], [0.04, 0.62, 0.01], 0.045, 0.036, stem, 10);
  taper(g, [0.04, 0.62, 0.01], [0, 1.2, 0], 0.036, 0.028, stem, 10);
  for (const s of [-1, 1]) {
    const leaf = new THREE.Mesh(geo('leaf', () => new THREE.SphereGeometry(1, 14, 8)), leafMatS);
    leaf.scale.set(0.26, 0.018, 0.11); leaf.position.set(s * 0.2, 0.55, 0); leaf.rotation.z = -s * 0.4;
    g.add(leaf);
  }
  const eyeG = new THREE.Group(); eyeG.position.y = 1.32; eyeG.rotation.order = 'YXZ'; g.add(eyeG);
  eyeG.add(new THREE.Mesh(domeGeo('sundome', 0.27, 0.05), ownLM('#ffffff', { map: sunDiscTex, shade: 0.7 })));
  const back = new THREE.Mesh(geo('sunback', () => new THREE.CylinderGeometry(0.27, 0.2, 0.08, 20)), ownLM('#3f6a2c', { shade: 0.7 }));
  back.rotation.x = Math.PI / 2; back.position.z = -0.045; eyeG.add(back);
  const pm = ownLM('#ffffff', { map: sunPetalTex, alphaTest: 0.4, side: THREE.DoubleSide, shade: 0.7 });
  for (const [n, rad, len, w, z, curl, off, tilt] of [[18, 0.24, 0.3, 0.11, -0.012, -0.08, 0, -0.2], [13, 0.22, 0.22, 0.09, 0.005, 0.05, 0.5, 0.15]]) {
    for (let i = 0; i < n; i++) {
      const a = (i + off) / n * Math.PI * 2, wilt = r() < 0.25, p = new THREE.Mesh(petalGeo(`sunpetal${len}`, w, len, curl), pm);
      p.position.set(Math.cos(a) * rad, Math.sin(a) * rad, z);
      p.rotation.order = 'ZYX';
      p.rotation.z = a - Math.PI / 2 + (r() - 0.5) * 0.25;
      p.rotation.x = tilt + (r() - 0.5) * 0.4 + (wilt ? -0.9 : 0);
      p.scale.set(0.85 + r() * 0.3, wilt ? 0.6 + r() * 0.3 : 0.9 + r() * 0.25, 1);
      eyeG.add(p);
    }
  }
  const flesh = ownLM('#5a2a26', { shade: 0.85 });
  const rim = new THREE.Mesh(geo('sunrim', () => new THREE.TorusGeometry(0.165, 0.04, 10, 24)), flesh); rim.position.z = 0.04; eyeG.add(rim);
  const eyeMat = wetEyeMat(eyeballTex, 0x1a1414);
  const ball = new THREE.Mesh(geo('suneye', () => new THREE.SphereGeometry(0.19, 24, 16)), eyeMat);
  ball.position.z = 0.02; eyeG.add(ball);
  const irisMat = wetEyeMat(irisTex, 0x141010, 0x777777);
  const iris = new THREE.Mesh(irisGeo('suniris', 0.19, 0.085, 0.02), irisMat);
  eyeG.add(iris);
  const lidMat = ownLM('#6a3a30', { shade: 0.9 }), lids = [];
  for (const s of [1, -1]) { const l = new THREE.Mesh(lidGeo('sunlid', 0.2, 0, 1.05), lidMat); l.position.z = 0.02; l.scale.y = s; eyeG.add(l); lids.push(l); }
  const vein = ownLM('#8a1e26', { shade: 0.6 });
  for (let i = 0; i < 5; i++) { const a = -0.3 - i * 0.6 - r() * 0.3, x0 = Math.cos(a) * 0.15, y0 = Math.sin(a) * 0.15; limb(eyeG, [x0, y0, 0.12], [x0 * 1.7, y0 * 1.7, 0.05], 0.006, vein); }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g, eyeG, ball, iris, eyeMat, irisMat, pm, lids };
}
// 千眼菇：奶油色的粗菇柄（有纖維、底部一圈菌托）、下面有菌褶的暗紅色菇傘，上面嵌著十幾顆眼睛（每顆都會轉過來盯著你，
// 周圍一圈肉色的眼眶，被手電筒照到會閉成一條縫）；每顆眼睛都在哭，眼淚沿著菇傘流到邊緣，一滴一滴掉下來
const SH_A = 0.72, SH_B = 0.72 * 0.72, SH_Y = 1.08;  // 菇傘：半徑、壓扁後的高度、底部的高度
function buildShroom(f, g) {
  const r = seeded(Math.round(f.x * 131 + f.y * 17) + 7);
  const stemM = ownLM('#ffffff', { map: stemTex, shade: 0.8 });
  cyl(g, 0.17, 0.25, 1.12, 0, 0, 0, stemM, 14);
  const volva = new THREE.Mesh(geo('shvolva', () => new THREE.TorusGeometry(0.24, 0.06, 8, 16)), stemM); volva.rotation.x = Math.PI / 2; volva.position.y = 0.06; g.add(volva);
  const capMat = ownLM('#ffffff', { map: capTex, emissive: 0x200508, shade: 0.75 });
  const cap = new THREE.Mesh(geo('shcap2', () => new THREE.SphereGeometry(SH_A, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2)), capMat);
  cap.scale.y = 0.72; cap.position.y = SH_Y; cap.castShadow = true; g.add(cap);
  const under = new THREE.Mesh(geo('shunder2', () => new THREE.CircleGeometry(SH_A, 28)), ownLM('#ffffff', { map: gillTex, shade: 0.5 }));
  under.rotation.x = Math.PI / 2; under.position.y = SH_Y - 0.005; g.add(under);
  // 眼睛的位置（th 從頂上算的角度、ph 繞一圈的角度）、那裡的法線
  const N = 15, eyes = [];
  for (let i = 0; i < N; i++) {
    const th = 0.5 + r() * 0.85, ph = i / N * Math.PI * 2 + r() * 0.3;
    const p = new THREE.Vector3(SH_A * Math.sin(th) * Math.cos(ph), SH_Y + SH_B * Math.cos(th), SH_A * Math.sin(th) * Math.sin(ph));
    const n = new THREE.Vector3(Math.sin(th) * Math.cos(ph) / SH_A, Math.cos(th) / SH_B, Math.sin(th) * Math.sin(ph) / SH_A).normalize();
    eyes.push({ th, ph, p, n, s: 0.75 + r() * 0.5, ph2: r() * 6 });
  }
  const balls = new THREE.InstancedMesh(geo('sheye', () => new THREE.SphereGeometry(0.065, 14, 10)), wetEyeMat(bigEyeTex, 0x1a1414), N);
  const lids = new THREE.InstancedMesh(geo('shlid', () => new THREE.TorusGeometry(0.065, 0.022, 8, 14)), ownLM('#7a2028', { shade: 0.8 }), N);
  for (let i = 0; i < N; i++) {
    const e = eyes[i];
    _q.setFromUnitVectors(Z_AXIS, e.n);
    _m4.compose(_v.copy(e.p).addScaledVector(e.n, 0.012), _q, _v2.setScalar(e.s)); lids.setMatrixAt(i, _m4);
  }
  g.add(balls); g.add(lids);
  // 眼淚：每顆眼睛一條薄薄的帶子，沿著菇傘的經線流到邊緣、再垂下來一點
  const pos = [], uv = [], idx = [];
  for (const e of eyes) {
    const base = pos.length / 3, steps = 8, w = 0.013 * e.s, sx = -Math.sin(e.ph), sz = Math.cos(e.ph);
    for (let i = 0; i <= steps + 1; i++) {
      const k = Math.min(1, i / steps), th = e.th + 0.07 + (Math.PI / 2 - e.th - 0.07) * k, ww = w * (1 + k * 0.8) * (i > steps ? 0.5 : 1);
      const nx = Math.sin(th) * Math.cos(e.ph) / SH_A, ny = Math.cos(th) / SH_B, nz = Math.sin(th) * Math.sin(e.ph) / SH_A, nl = Math.hypot(nx, ny, nz);
      const x = SH_A * Math.sin(th) * Math.cos(e.ph) + nx / nl * 0.006, y = SH_Y + SH_B * Math.cos(th) + ny / nl * 0.006 - (i > steps ? 0.05 : 0), z = SH_A * Math.sin(th) * Math.sin(e.ph) + nz / nl * 0.006;
      pos.push(x - sx * ww, y, z - sz * ww, x + sx * ww, y, z + sz * ww);
      uv.push(0, k, 1, k);
      if (i <= steps) { const nn = base + i * 2; idx.push(nn, nn + 2, nn + 1, nn + 1, nn + 2, nn + 3); }
    }
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tg.setIndex(idx); tg.computeVertexNormals();
  const tearMat = ownPhong('#e4f2ff', { transparent: true, opacity: 0.55, emissive: 0x2a3a50, specular: 0xffffff, shininess: 60, side: THREE.DoubleSide, depthWrite: false });
  const tears = new THREE.Mesh(tg, tearMat); tears.userData.ownGeo = true; g.add(tears);
  const drops = new THREE.InstancedMesh(geo('shdrop', () => new THREE.SphereGeometry(0.018, 8, 6)), ownPhong('#e8f4ff', { transparent: true, opacity: 0.85, emissive: 0x223044, specular: 0xffffff, shininess: 80 }), N);
  g.add(drops);
  g.traverse(o => { if (o.isMesh) { o.castShadow = o !== tears && o !== drops; o.receiveShadow = true; } });
  return { g, capMat, eyes, balls, lids, drops, tearMat };
}
// 眼球花：綠色的莖和兩片葉子，花是一顆會轉過來盯著你的大眼球
const flowerMap = new Map();
function buildFlower(f, parent = scene) {
  const g = new THREE.Group(); g.position.set(f.x, 0, f.y); parent.add(g);
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
  const eyeMat = wetEyeMat(eyeballTex, 0x1a1414);
  const ball = new THREE.Mesh(geo('eyeball', () => new THREE.SphereGeometry(0.24, 28, 20)), eyeMat);
  eyeG.add(ball);
  const irisMat = wetEyeMat(irisTex, 0x141010, 0x777777);
  const iris = new THREE.Mesh(irisGeo('iris', 0.24, 0.095, 0), irisMat);
  eyeG.add(iris);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g, eyeG, ball, iris, eyeMat, irisMat };
}
function syncFlowers(t) {
  const p = G.p, seen = new Set(), awake = G.phase === 'night';
  for (const f of G.flowers) {
    seen.add(f);
    let r = flowerMap.get(f);
    if (!r) { r = buildFlower(f); flowerMap.set(f, r); }
    syncFlower(f, r, t, p, awake);
  }
  for (const [f, r] of flowerMap) if (!seen.has(f)) { disposeGroup(r.g); flowerMap.delete(f); }
}
// 一朵植物怪的動作（p 是玩家的位置；圖鑑裡是假的玩家）
function syncFlower(f, r, t, p, awake) {
  {
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
      // 眼皮：被手電筒燒到瞇起來、盯著你時睜大、偶爾眨一下；白天閉著睡覺
      const blink = Math.sin(t * 0.9 + f.x * 2.7) > 0.975 ? 1 : 0;
      const k = !awake ? 0.85 : Math.max(Math.min(1, f.burn || 0) * 0.55, blink) - (f.lock >= SUN_LOCK ? 0.12 : 0);
      r.lids[0].rotation.x = -0.35 + 0.92 * k; r.lids[1].rotation.x = 0.35 - 0.92 * k;
      return;
    }
    if (f.ptype === 'shroom') {
      // 被手電筒照到時，菇傘上的眼睛全部閉起來（變暗）；撒孢子時發亮
      const shut = f.shut > 0 || !awake;
      r.capMat.emissive.setRGB(shut ? 0.03 : f.spore ? 0.35 + 0.15 * Math.sin(t * 10) : 0.12, shut ? 0.0 : 0.04, shut ? 0.01 : 0.06);
      r.capMat.color.setRGB(shut ? 0.55 : 1, shut ? 0.45 : 1, shut ? 0.45 : 1);
      // 每顆眼睛都轉過來盯著你（不會轉進菇傘裡）；閉起來時縮成一條縫、縮進眼眶裡
      const s = Math.max(0.05, f.grow), lx = dx / s, lz = dz / s, ly = EYE / s;
      for (let i = 0; i < r.eyes.length; i++) {
        const e = r.eyes[i];
        _v.set(lx - e.p.x, ly - e.p.y, lz - e.p.z).normalize();
        const dn = _v.dot(e.n);
        if (dn < 0.3) _v.addScaledVector(e.n, 0.3 - dn).normalize();
        _q.setFromUnitVectors(Z_AXIS, _v);
        _m4.compose(_v2.copy(e.p).addScaledVector(e.n, shut ? 0.004 : 0.024), _q, _v.set(e.s, e.s * (shut ? 0.18 : 1), e.s * (shut ? 0.6 : 1)));
        r.balls.setMatrixAt(i, _m4);
      }
      r.balls.instanceMatrix.needsUpdate = true;
      // 眼淚一直流；淚珠從眼睛滑到菇傘邊緣，再掉到地上
      r.tearMat.opacity = 0.5 + 0.15 * Math.sin(t * 1.7 + f.x);
      for (let i = 0; i < r.eyes.length; i++) {
        const e = r.eyes[i], k = (t * 0.25 + e.ph2) % 1.4;
        if (k < 1) { const th = e.th + 0.07 + (Math.PI / 2 - e.th - 0.07) * k; _v.set(SH_A * Math.sin(th) * Math.cos(e.ph), SH_Y + SH_B * Math.cos(th), SH_A * Math.sin(th) * Math.sin(e.ph)).addScaledVector(e.n, 0.012); }
        else _v.set(SH_A * Math.cos(e.ph), SH_Y - (k - 1) / 0.4 * SH_Y, SH_A * Math.sin(e.ph));
        _m4.compose(_v, _qI, _v2.setScalar(k < 1 ? 1 : 1.3)); r.drops.setMatrixAt(i, _m4);
      }
      r.drops.instanceMatrix.needsUpdate = true;
      return;
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
  } else if (tier === BAYMAX_TIER) addBaymax(res, g);
  else if (tier === HEAL_TIER) {
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

// ---------- 大白燈：燈下站著一個 2 公尺高的「大白」（寫實版：白色合成皮的人形充氣體，有接縫、磨損和泛黃；
// 臉是一條暗色的面罩線和兩點微光）。慢慢呼吸；你走到它面前，手臂會慢慢合起來抱住你；被黑球吃掉時慢慢消氣倒下 ----------
let baymaxTex = null;
function makeBaymaxTex() {
  baymaxTex = canvasTex(256, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#f3efe6'); g.addColorStop(1, '#e4d9c6');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(120,110,95,.45)'; c.lineWidth = 2;
    for (const y of [40, 128, 216]) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    for (const x of [64, 192]) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1; for (const y of [42, 130, 218]) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(150,130,90,${0.06 + rnd() * 0.14})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 6 + rnd() * 24, 3 + rnd() * 12, rnd() * 3, 0, 7); c.fill(); }
    for (let i = 0; i < 25; i++) { c.strokeStyle = `rgba(90,80,70,${0.15 + rnd() * 0.3})`; c.lineWidth = 1; const x = rnd() * w, y = rnd() * h; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 30, y + (rnd() - 0.5) * 10); c.stroke(); }
  });
}
function addBaymax(res, g) {
  if (!baymaxTex) makeBaymaxTex();
  const skin = ownPhong('#ffffff', { map: baymaxTex, specular: 0x333333, shininess: 14, shade: 0.85 });
  const b = new THREE.Group(); g.add(b);
  for (const s of [-1, 1]) { sph(b, 0.13, s * 0.17, 0.1, 0.03, skin, 1.1, 0.6, 1.4, 10); cyl(b, 0.1, 0.12, 0.55, s * 0.17, 0.12, 0, skin, 10); }
  sph(b, 0.42, 0, 1.05, 0, skin, 1, 1.15, 0.8, 16);
  sph(b, 0.3, 0, 1.68, 0, skin, 1.05, 0.9, 0.95, 14);
  sph(b, 0.25, 0, 1.9, 0, skin, 1.1, 0.78, 1, 14);
  box(b, -0.16, 0.16, 1.885, 1.905, 0.2, 0.26, ownBasic({ color: 0x1a1816 }), false);
  res.bmEyes = [];
  for (const s of [-1, 1]) { const e = ownSprite(glowTex, 0xfff1d8); e.position.set(s * 0.16, 1.895, 0.27); e.scale.setScalar(0.09); b.add(e); res.bmEyes.push(e); }
  res.bmArms = [];
  for (const s of [-1, 1]) {
    const piv = new THREE.Group(); piv.position.set(s * 0.42, 1.38, 0); b.add(piv);
    cyl(piv, 0.1, 0.12, 0.62, 0, -0.62, 0, skin, 10);
    sph(piv, 0.12, 0, -0.66, 0.02, skin, 1, 0.8, 1.1, 10);
    res.bmArms.push({ piv, s });
  }
  b.traverse(o => { if (o.isMesh) o.castShadow = true; });
  res.bm = b;
}
function syncBaymax(o, f, t) {
  const hug = G.hugObj === o ? (G.hug || 0) : 0, eaten = o.eaten || 0, breath = 1 + 0.015 * Math.sin(t * 1.4);
  f.bm.scale.set(breath, (2 - breath) * (1 - 0.55 * eaten), breath);
  f.bm.rotation.x = eaten * 0.9;
  f.bm.rotation.y = Math.atan2(G.p.x - (o.x + 0.5), G.p.y - (o.y + 0.5)) - f.g.rotation.y;
  for (const a of f.bmArms) { a.piv.rotation.z = a.s * (0.35 - 0.08 * Math.sin(t * 1.4)) * (1 - hug) + a.s * 0.95 * hug; a.piv.rotation.x = -1.25 * hug; a.piv.rotation.y = -a.s * 0.55 * hug; }
  for (const e of f.bmEyes) e.material.opacity = (0.45 + 0.25 * Math.sin(t * 2)) * (1 - eaten);
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
    case 'stick': return 2.3;
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
function buildEnemy(e, parent = scene) {
  const g = new THREE.Group(); parent.add(g);
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
    syncEnemy(e, r, t, p);
  }
  for (const [e, r] of enemyMap) if (!seen.has(e)) { disposeGroup(r.g); enemyMap.delete(e); }
}
// 一隻怪物的動作（p 是玩家的位置；圖鑑裡是假的玩家）
function syncEnemy(e, r, t, p) {
  {
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
    } else if (NEW_BUILD[e.kind]) syncNewMonster(e, r, t, p);
  }
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
    // 第三世界：列車在開的時候，車身輕輕地上下左右晃
    const tk = trainK();
    if (tk > 0) { y += Math.sin(t * 7.3) * 0.012 * tk + Math.sin(t * 1.9) * 0.006 * tk; x += Math.sin(t * 2.7) * 0.012 * tk; roll += Math.sin(t * 1.6) * 0.008 * tk; }
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
// 第三世界：末班列車。鍍金年代的豪華特快車（深胡桃木、黃銅、暗紅絨布、象牙白的天花板），全部都要「舊」；
// 最下面一排是車站。牆上有真的窗戶，窗外是會捲動的三層風景（遠山和天空、樹林、電線桿）
// ====================================================================
let walnutTex, stationWallTex, carriageTex, ceil3Tex, doorPanelTex, carriageDoorTex, glassTex, skyFarTex, nearTex, yardTex, sheetTex, velvetTex;
const midTexes = {};
let backdrop = null, panes3 = [], walnutMat = null, stationMat = null;
const doorPanels = new Map();
// 窗戶的位置（牆格）：列車的北、東、西面，車站的南、東、西面
const WINDOWS_W3 = [
  ...[3, 5, 7, 14, 16, 19, 25, 27, 30, 36, 38, 40].map(x => [x, 0]),
  ...[3, 6, 17, 20, 23, 28, 30].map(y => [0, y]),
  ...[3, 6, 12, 17, 20, 23, 28, 30].map(y => [43, y]),
  ...[4, 8, 12, 20, 24, 28, 34, 38].map(x => [x, 32]),
];
function makeTrainTextures() {
  const grime = (c, w, h, n, a = 0.18) => { for (let i = 0; i < n; i++) { c.fillStyle = `rgba(20,12,6,${rnd() * a})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 20, 2 + rnd() * 10, rnd() * 3, 0, 7); c.fill(); } };
  // 車廂內牆：上面是泛黃的象牙白壁紙（扇形的裝飾藝術花紋）和線板，中間一條發黑長銅綠的黃銅線，下面是深胡桃木的鑲板（木紋、刮痕、踢腳板）
  walnutTex = canvasTex(256, 512, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, 300); g.addColorStop(0, '#cfc2a4'); g.addColorStop(1, '#ddd1b6');
    c.fillStyle = g; c.fillRect(0, 0, w, 300);
    c.strokeStyle = 'rgba(150,120,70,.35)'; c.lineWidth = 1.5;
    for (let y = 40; y < 280; y += 80) for (let x = 0; x <= w; x += 64) for (let r = 10; r <= 30; r += 10) { c.beginPath(); c.arc(x, y, r, Math.PI, 0); c.stroke(); }
    c.fillStyle = '#b5a583'; c.fillRect(0, 0, w, 16); c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 16, w, 3); c.fillStyle = 'rgba(255,255,255,.2)'; c.fillRect(0, 4, w, 2);
    const br = c.createLinearGradient(0, 296, 0, 312); br.addColorStop(0, '#5a4518'); br.addColorStop(0.5, '#c9a24a'); br.addColorStop(1, '#4a3812');
    c.fillStyle = br; c.fillRect(0, 296, w, 16);
    for (let i = 0; i < 12; i++) { c.fillStyle = `rgba(60,120,90,${0.2 + rnd() * 0.4})`; c.beginPath(); c.ellipse(rnd() * w, 304, 3 + rnd() * 8, 3, 0, 0, 7); c.fill(); }
    c.fillStyle = '#3a2316'; c.fillRect(0, 312, w, 200);
    for (let i = 0; i < 70; i++) { c.strokeStyle = `rgba(${20 + rnd() * 40 | 0},${10 + rnd() * 20 | 0},6,${0.25 + rnd() * 0.4})`; c.lineWidth = 1 + rnd(); const x = rnd() * w; c.beginPath(); c.moveTo(x, 312); c.quadraticCurveTo(x + (rnd() - 0.5) * 6, 410, x + (rnd() - 0.5) * 4, 512); c.stroke(); }
    c.strokeStyle = '#5a3a24'; c.lineWidth = 3; c.strokeRect(24, 330, w - 48, 140); c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 2; c.strokeRect(28, 334, w - 56, 132);
    c.fillStyle = '#231408'; c.fillRect(0, 488, w, 24); c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(0, 488, w, 2);
    c.strokeStyle = 'rgba(200,170,130,.35)'; c.lineWidth = 1;
    for (let i = 0; i < 8; i++) { const x = rnd() * w, y = 330 + rnd() * 170; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 50, y + (rnd() - 0.5) * 12); c.stroke(); }
    grime(c, w, 300, 14, 0.14); grime(c, w, h, 10, 0.22);
  });
  // 車站的牆：上面是有裂痕和煤灰的灰泥，下面是泛黃的釉面磚
  stationWallTex = canvasTex(256, 512, (c, w, h) => {
    c.fillStyle = '#b3a890'; c.fillRect(0, 0, w, 290);
    c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) { let x = rnd() * w, y = rnd() * 290; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 30; y += 10 + rnd() * 25; c.lineTo(x, y); } c.stroke(); }
    c.fillStyle = '#6e6254'; c.fillRect(0, 286, w, 10);
    for (let y = 296; y < h; y += 36) for (let x = (y / 36 | 0) % 2 ? 0 : 32; x < w + 64; x += 64) { c.fillStyle = shade('#c9bb9a', (rnd() - 0.5) * 20); c.fillRect(x - 32, y, 62, 34); }
    c.fillStyle = 'rgba(255,255,255,.12)'; for (let y = 296; y < h; y += 36) c.fillRect(0, y + 2, w, 3);
    grime(c, w, 290, 18, 0.3); grime(c, w, h, 12, 0.25);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, 0, w, 10);
  });
  // 列車的外觀（從月台看到的車身）：墨綠色的車身、金色的細線、黃銅框的車窗、鉚釘、鏽水痕
  carriageTex = canvasTex(256, 512, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b3524'); g.addColorStop(0.7, '#142a1c'); g.addColorStop(1, '#0c0f0d');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#0d0e0c'; c.fillRect(0, 400, w, 112);
    c.fillStyle = '#c9a24a'; c.fillRect(0, 110, w, 3); c.fillRect(0, 392, w, 4);
    c.fillStyle = '#9c7b35'; c.fillRect(36, 140, 184, 196);
    const gl = c.createLinearGradient(0, 150, 0, 330); gl.addColorStop(0, '#1c2a3a'); gl.addColorStop(1, '#070b12');
    c.fillStyle = gl; c.fillRect(46, 150, 164, 176);
    c.fillStyle = 'rgba(255,255,255,.08)'; c.beginPath(); c.moveTo(46, 326); c.lineTo(120, 150); c.lineTo(160, 150); c.lineTo(86, 326); c.fill();
    c.fillStyle = '#6a6a66'; for (let x = 12; x < w; x += 24) { c.beginPath(); c.arc(x, 24, 2.5, 0, 7); c.fill(); c.beginPath(); c.arc(x, 388, 2.5, 0, 7); c.fill(); }
    for (let i = 0; i < 8; i++) { c.fillStyle = `rgba(120,70,30,${0.15 + rnd() * 0.3})`; const x = rnd() * w; c.fillRect(x, 330 + rnd() * 60, 2 + rnd() * 3, 40 + rnd() * 120); }
    grime(c, w, h, 16, 0.3);
  });
  // 天花板：象牙白，一格一格的線板，泛黃、有水漬
  ceil3Tex = canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#e2d7bd'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(120,100,60,.45)'; c.lineWidth = 3; c.strokeRect(10, 10, w - 20, h - 20);
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5; c.strokeRect(14, 14, w - 28, h - 28);
    for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(150,120,70,${0.08 + rnd() * 0.18})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 8 + rnd() * 20, 6 + rnd() * 14, rnd() * 3, 0, 7); c.fill(); }
  });
  // 包廂的門：胡桃木滑門，上面是蝕刻玻璃（霧面、扇形花紋），黃銅把手；車站側的車門是墨綠色的車身
  doorPanelTex = canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#3a2316'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(20,10,6,${0.25 + rnd() * 0.4})`; c.lineWidth = 1; const x = rnd() * w; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + (rnd() - 0.5) * 4, h); c.stroke(); }
    c.fillStyle = '#b9c4c2'; c.fillRect(18, 18, w - 36, 100);
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1.5; for (let r = 12; r <= 44; r += 8) { c.beginPath(); c.arc(w / 2, 118, r, Math.PI, 0); c.stroke(); }
    c.strokeStyle = '#5a3a24'; c.lineWidth = 4; c.strokeRect(18, 18, w - 36, 100); c.strokeRect(18, 138, w - 36, 96);
    c.fillStyle = '#c9a24a'; c.fillRect(w - 28, 150, 8, 26);
    grime(c, w, h, 8, 0.25);
  });
  carriageDoorTex = canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#17301f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#9c7b35'; c.fillRect(16, 24, w - 32, 96); c.fillStyle = '#0b1420'; c.fillRect(22, 30, w - 44, 84);
    c.fillStyle = '#c9a24a'; c.fillRect(0, 140, w, 3); c.fillStyle = '#0d0e0c'; c.fillRect(0, 200, w, 56);
    c.fillStyle = '#c9a24a'; c.fillRect(w - 24, 150, 6, 30);
    grime(c, w, h, 8, 0.3);
  });
  for (const t of [doorPanelTex, carriageDoorTex]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // 髒髒的玻璃（寒寂之境會結霜：用顏色和透明度調）
  glassTex = canvasTex(64, 96, (c, w, h) => {
    c.fillStyle = 'rgba(200,215,225,.25)'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) { c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.12})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 12, 2 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
    const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, 60); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(220,235,245,.55)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  glassTex.wrapS = glassTex.wrapT = THREE.ClampToEdgeWrapping;
  // 蓋在乘客身上的白布（灰撲撲、有皺褶）、磨破的暗紅絨布
  sheetTex = canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#cfc6b6'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) { c.strokeStyle = `rgba(80,70,60,${0.1 + rnd() * 0.2})`; c.lineWidth = 2 + rnd() * 3; const x = rnd() * w; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(x + (rnd() - 0.5) * 30, 64, x + (rnd() - 0.5) * 20, h); c.stroke(); }
    grime(c, w, h, 10, 0.2);
  });
  velvetTex = canvasTex(64, 64, (c, w, h) => {
    c.fillStyle = '#5a1f26'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(${120 + rnd() * 60 | 0},${30 + rnd() * 20 | 0},${40 + rnd() * 20 | 0},.35)`; c.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
    for (let i = 0; i < 5; i++) { c.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 5 + rnd() * 12, 3 + rnd() * 8, rnd() * 3, 0, 7); c.fill(); }
  });
  // ---------- 車外的風景（三層視差）：遠山和天空、中景（照天數換）、近景的電線桿；白天停在車站看到的站場 ----------
  skyFarTex = canvasTex(1024, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, 170); g.addColorStop(0, '#5f7ea3'); g.addColorStop(0.7, '#a9b4bd'); g.addColorStop(1, '#cfc4ad');
    c.fillStyle = g; c.fillRect(0, 0, w, 170);
    const range = (base, amp, col, y0) => { c.fillStyle = col; c.beginPath(); c.moveTo(0, h); c.lineTo(0, y0); let x = 0; while (x < w) { x += 30 + rnd() * 60; c.lineTo(x, y0 - amp * Math.abs(Math.sin(x * base)) - rnd() * 12); } c.lineTo(w, h); c.fill(); };
    range(0.011, 60, '#8a94a8', 168); range(0.019, 42, '#616b80', 174);
    c.fillStyle = '#4e5046'; c.fillRect(0, 178, w, h - 178);
    for (let i = 0; i < 60; i++) { c.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, 180 + rnd() * 76, 10 + rnd() * 40, 2 + rnd() * 4, 0, 0, 7); c.fill(); }
  });
  const mid = (name, draw) => { midTexes[name] = canvasTex(1024, 256, (c, w, h) => { c.clearRect(0, 0, w, h); draw(c, w, h); }); };
  // 平原：草地、籬笆、遠遠的農舍
  mid('plain', (c, w, h) => {
    c.fillStyle = '#4f5d3b'; c.fillRect(0, 150, w, h - 150);
    c.strokeStyle = '#2d2a24'; c.lineWidth = 3; for (let x = 0; x < w; x += 36) { c.beginPath(); c.moveTo(x, 150); c.lineTo(x, 178); c.stroke(); }
    c.lineWidth = 2; c.beginPath(); c.moveTo(0, 158); c.lineTo(w, 158); c.moveTo(0, 170); c.lineTo(w, 170); c.stroke();
    c.fillStyle = '#2a2622'; c.fillRect(600, 118, 70, 36); c.beginPath(); c.moveTo(594, 118); c.lineTo(635, 92); c.lineTo(676, 118); c.fill();
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(0,0,0,${0.12 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, 160 + rnd() * 90, 10 + rnd() * 50, 2 + rnd() * 4, 0, 0, 7); c.fill(); }
  });
  // 枯樹林：一棵一棵分岔的枯樹
  mid('trees', (c, w, h) => {
    c.fillStyle = '#2b2a26'; c.fillRect(0, 170, w, h - 170);
    c.strokeStyle = '#1a1816'; c.lineCap = 'round';
    const br = (x0, y0, a, len, wd, d) => { if (d > 4 || len < 6) return; const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len; c.lineWidth = wd; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); br(x1, y1, a - 0.5 - rnd() * 0.4, len * 0.65, wd * 0.6, d + 1); br(x1, y1, a + 0.5 + rnd() * 0.4, len * 0.65, wd * 0.6, d + 1); };
    for (let i = 0; i < 46; i++) br(rnd() * w, 176, -Math.PI / 2 + (rnd() - 0.5) * 0.3, 27 + rnd() * 40, 5, 0);
  });
  // 鐵橋：鋼樑的交叉支撐，底下是河
  mid('bridge', (c, w, h) => {
    const g = c.createLinearGradient(0, 190, 0, h); g.addColorStop(0, '#2c3a4a'); g.addColorStop(1, '#101820'); c.fillStyle = g; c.fillRect(0, 190, w, h - 190);
    for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(200,220,240,${0.1 + rnd() * 0.2})`; c.fillRect(rnd() * w, 196 + rnd() * 50, 10 + rnd() * 40, 1.5); }
    c.strokeStyle = '#3a3d44'; c.lineWidth = 7; c.beginPath(); c.moveTo(0, 60); c.lineTo(w, 60); c.moveTo(0, 186); c.lineTo(w, 186); c.stroke();
    c.lineWidth = 5; for (let x = 0; x <= w; x += 128) { c.beginPath(); c.moveTo(x, 60); c.lineTo(x, 186); c.moveTo(x, 60); c.lineTo(x + 128, 186); c.moveTo(x + 128, 60); c.lineTo(x, 186); c.stroke(); }
    c.fillStyle = '#4a4d55'; for (let x = 0; x <= w; x += 128) c.fillRect(x - 4, 50, 8, 14);
  });
  // 雪原：白色的雪地、一棵一棵黑色的杉樹頂上積著雪
  mid('snow', (c, w, h) => {
    c.fillStyle = '#dfe4ea'; c.fillRect(0, 160, w, h - 160);
    for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(150,170,195,${0.15 + rnd() * 0.25})`; c.beginPath(); c.ellipse(rnd() * w, 170 + rnd() * 80, 20 + rnd() * 60, 3 + rnd() * 5, 0, 0, 7); c.fill(); }
    for (let i = 0; i < 28; i++) {
      const x = rnd() * w, hh = 50 + rnd() * 70, ww = 14 + rnd() * 14;
      for (let k = 0; k < 3; k++) { const y = 170 - hh + k * hh * 0.3, sw = ww * (0.5 + k * 0.3); c.fillStyle = '#1e2a22'; c.beginPath(); c.moveTo(x, y); c.lineTo(x + sw, y + hh * 0.42); c.lineTo(x - sw, y + hh * 0.42); c.fill(); c.fillStyle = 'rgba(240,245,255,.8)'; c.beginPath(); c.moveTo(x, y); c.lineTo(x + sw * 0.5, y + hh * 0.2); c.lineTo(x - sw * 0.5, y + hh * 0.2); c.fill(); }
    }
  });
  // 城市燈火：黑色的大樓，窗戶亮著黃光
  mid('city', (c, w, h) => {
    c.fillStyle = '#14161c'; c.fillRect(0, 180, w, h - 180);
    let x = 0;
    while (x < w) { const bw = 40 + rnd() * 70, bh = 60 + rnd() * 120; c.fillStyle = shade('#1a1d26', (rnd() - 0.5) * 16); c.fillRect(x, 186 - bh, bw, bh); for (let yy = 194 - bh; yy < 180; yy += 12) for (let xx = x + 6; xx < x + bw - 8; xx += 11) if (rnd() < 0.55) { c.fillStyle = `rgba(255,${200 + rnd() * 40 | 0},120,${0.6 + rnd() * 0.4})`; c.fillRect(xx, yy, 6, 7); } x += bw + 4 + rnd() * 10; }
  });
  // 近景：電線桿和電線、籬笆柱
  nearTex = canvasTex(1024, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#1c1816'; c.lineWidth = 2;
    for (const y of [40, 52]) { c.beginPath(); for (let x = 0; x <= w; x += 32) c.lineTo(x, y + Math.sin(x / 256 * Math.PI * 2) * 6); c.stroke(); }
    c.fillStyle = '#2a2320';
    for (let x = 100; x < w; x += 256) { c.fillRect(x - 5, 30, 10, h - 30); c.fillRect(x - 28, 36, 56, 5); c.fillRect(x - 22, 50, 44, 4); }
    c.fillStyle = '#3a3129'; for (let x = 30; x < w; x += 64) c.fillRect(x, 200, 6, 56);
  });
  // 白天的站場：對面的月台、站房、鐘塔、水塔、煤氣燈
  yardTex = canvasTex(1024, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#6e6a62'; c.fillRect(0, 196, w, 60); c.fillStyle = '#8a8378'; c.fillRect(0, 196, w, 6);
    c.fillStyle = '#5a4034'; c.fillRect(120, 100, 300, 96); c.fillStyle = '#3a2a22'; c.beginPath(); c.moveTo(110, 100); c.lineTo(270, 50); c.lineTo(430, 100); c.fill();
    for (let x = 140; x < 400; x += 44) { c.fillStyle = '#1a2230'; c.fillRect(x, 126, 24, 40); c.fillStyle = '#c9a24a'; c.fillRect(x - 2, 124, 28, 2); }
    c.fillStyle = '#6b4a3a'; c.fillRect(600, 20, 50, 176); c.fillStyle = '#e8e0c8'; c.beginPath(); c.arc(625, 50, 16, 0, 7); c.fill(); c.strokeStyle = '#222'; c.lineWidth = 2; c.beginPath(); c.moveTo(625, 50); c.lineTo(625, 40); c.moveTo(625, 50); c.lineTo(633, 54); c.stroke();
    c.fillStyle = '#4a4a4e'; c.fillRect(800, 60, 80, 60); c.fillRect(806, 120, 8, 76); c.fillRect(866, 120, 8, 76); c.fillRect(820, 120, 40, 8);
    for (const x of [40, 520, 760, 960]) { c.fillStyle = '#2a2320'; c.fillRect(x - 3, 90, 6, 106); c.fillStyle = '#e8d8a0'; c.fillRect(x - 8, 76, 16, 18); }
    grime(c, w, h, 20, 0.2);
  });
}
// ---------- 牆：車廂是胡桃木壁板、車站是磚牆；從月台看到的那一面是墨綠色的車身；牆上開真的窗戶 ----------
function buildTrainWalls(list) {
  const win = new Set(WINDOWS_W3.map(([x, y]) => x + ',' + y));
  const train = [], station = [], side = [];
  for (const [x, y] of list) {
    if (win.has(x + ',' + y)) continue;
    if (y === 25) side.push([x, y]); else if (y >= 26) station.push([x, y]); else train.push([x, y]);
  }
  walnutMat = patchLM(new THREE.MeshLambertMaterial({ map: walnutTex })); walnutMat.userData.own = true;
  stationMat = patchLM(new THREE.MeshLambertMaterial({ map: stationWallTex })); stationMat.userData.own = true;
  const carriage = patchLM(new THREE.MeshLambertMaterial({ map: carriageTex })); carriage.userData.own = true;
  const mtx = new THREE.Matrix4();
  const inst = (tiles, mat) => {
    if (!tiles.length) return;
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, WALL_H, 1), mat, tiles.length);
    im.userData.ownGeo = true;
    tiles.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, WALL_H / 2, y + 0.5); im.setMatrixAt(i, mtx); });
    im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere();
    houseGroup.add(im);
  };
  inst(train, walnutMat); inst(station, stationMat);
  inst(side, [walnutMat, walnutMat, walnutMat, walnutMat, carriage, walnutMat]);   // +z 那一面朝著月台
  // 窗戶：牆上真的開一個洞（窗台到 0.95、窗楣 2.0 以上、兩邊留窗框），黃銅窗框、髒玻璃；外面是會捲動的風景
  const brass = lm('#6e5726');
  panes3 = [];
  for (const [x, y] of WINDOWS_W3) {
    const g = new THREE.Group(); g.position.set(x, 0, y); houseGroup.add(g);
    const m = y >= 26 ? stationMat : walnutMat, ns = y === 0 || y === 32;
    box(g, 0, 1, 0, 0.95, 0, 1, m); box(g, 0, 1, 2.0, WALL_H, 0, 1, m);
    if (ns) { box(g, 0, 0.15, 0.95, 2.0, 0, 1, m); box(g, 0.85, 1, 0.95, 2.0, 0, 1, m); }
    else { box(g, 0, 1, 0.95, 2.0, 0, 0.15, m); box(g, 0, 1, 0.95, 2.0, 0.85, 1, m); }
    const fr = (a0, a1, b0, b1) => (ns ? box(g, a0, a1, b0, b1, 0.47, 0.53, brass, false) : box(g, 0.47, 0.53, b0, b1, a0, a1, brass, false));
    fr(0.12, 0.88, 0.93, 0.98); fr(0.12, 0.88, 1.98, 2.03); fr(0.12, 0.17, 0.95, 2.0); fr(0.83, 0.88, 0.95, 2.0); fr(0.485, 0.515, 0.95, 2.0);
    const pm = ownBasic({ map: glassTex, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, fog: false, color: 0xffffff });
    const pane = new THREE.Mesh(geo('pane3', () => new THREE.PlaneGeometry(0.7, 1.05)), pm);
    pane.position.set(0.5, 1.475, 0.5); if (!ns) pane.rotation.y = Math.PI / 2;
    g.add(pane); panes3.push(pm);
  }
}
// 包廂的滑門（打開時滑進旁邊的牆裡）和車站側的車門（晚上鎖起來）
function addDoorPanel(d, g, eastWest) {
  const face = patchLM(new THREE.MeshLambertMaterial({ map: d.station ? carriageDoorTex : doorPanelTex })); face.userData.own = true;
  const edge = lm('#2a1a10');
  const pm = new THREE.Mesh(geo('doorpanel', () => new THREE.BoxGeometry(0.94, 2.12, 0.07)), [edge, edge, edge, edge, face, face]);
  const piv = new THREE.Group(); piv.position.set(0.5, 1.06, 0.5); g.add(piv);
  if (!eastWest) piv.rotation.y = Math.PI / 2;
  pm.castShadow = true; piv.add(pm);
  doorPanels.set(d, { pm, k: d.closed || d.locked ? 0 : 1 });
}
function syncDoors(dt) {
  for (const [d, r] of doorPanels) {
    const target = d.closed || d.locked ? 0 : 1;
    r.k += (target - r.k) * Math.min(1, dt * 6);
    r.pm.position.x = r.k * 0.96;
    r.pm.visible = r.k < 0.985;
  }
}
// ---------- 車外的風景：地圖四周各放幾層大貼圖，列車開的時候往後捲（遠的慢、近的快） ----------
function buildBackdrop() {
  backdrop = { g: new THREE.Group(), layers: [], scenery: '' };
  scene.add(backdrop.g);
  const mk = (tex, w, h, x, y, z, ry, opaque, speed) => {
    const t = tex.clone(); t.needsUpdate = true; t.repeat.set(w / (h * 4), 1);
    const mat = new THREE.MeshBasicMaterial({ map: t, transparent: !opaque, alphaTest: opaque ? 0 : 0.3, fog: false, depthWrite: opaque });
    mat.userData.own = true;
    const m = new THREE.Mesh(geo(`bd${w}x${h}`, () => new THREE.PlaneGeometry(w, h)), mat);
    m.position.set(x, y, z); m.rotation.y = ry; backdrop.g.add(m);
    const L = { m, t, speed, dir: 1 };
    backdrop.layers.push(L);
    return L;
  };
  const cx = MAP_W / 2, cz = MAP_H / 2;
  // 北面（列車的窗戶）和南面（車站的窗戶）各三層加白天的站場；東西面只有遠山和中景（列車往西開，正面的風景不會捲動）
  for (const [z, ry, dir] of [[-15, 0, 1], [MAP_H + 15, Math.PI, -1]]) {
    mk(skyFarTex, 240, 26, cx, 6, z, ry, true, 0.012).dir = dir;
    const mid = mk(midTexes.plain, 170, 9, cx, 3.2, z + dir * 7, ry, false, 0.07); mid.dir = dir; mid.isMid = true;
    const near = mk(nearTex, 120, 6, cx, 2.6, z + dir * 11.5, ry, false, 0.24); near.dir = dir; near.isNear = true;
    const yard = mk(yardTex, 120, 7, cx, 2.9, z + dir * 11.8, ry, false, 0); yard.isYard = true;
  }
  for (const [x, ry] of [[-15, Math.PI / 2], [MAP_W + 15, -Math.PI / 2]]) {
    mk(skyFarTex, 240, 26, x, 6, cz, ry, true, 0);
    const mid = mk(midTexes.plain, 170, 9, x + (x < 0 ? 7 : -7), 3.2, cz, ry, false, 0); mid.isMid = true;
  }
  backdrop.moon = ownSprite(moonTex, 0xfff4d0); backdrop.moon.scale.setScalar(3.2); backdrop.moon.position.set(cx + 20, 13, -13); backdrop.g.add(backdrop.moon);
}
// 每一幀：風景捲動、照白天晚上變色、換中景、門板、窗玻璃結霜
function syncTrain3(dt, t, dark) {
  if (!isW3()) return;
  syncDoors(dt);
  if (!backdrop) return;
  const sc = scenery3(), k = trainK(), night = sc !== 'yard';
  if (backdrop.scenery !== sc) {
    backdrop.scenery = sc;
    const tex = midTexes[sc === 'yard' ? 'plain' : sc === 'tunnel' ? 'trees' : sc];
    for (const L of backdrop.layers) if (L.isMid) { L.t.image = tex.image; L.t.needsUpdate = true; }
  }
  const dk = clamp(dark / NIGHT_DARK, 0, 1), blood = !!(G.ev && G.ev.blood && G.phase === 'night'), cold = !!G.cold;
  const r = 1 - dk * (blood ? 0.72 : 0.9), gg = 1 - dk * (blood ? 0.93 : 0.88), b = 1 - dk * (blood ? 0.94 : 0.78);
  for (const L of backdrop.layers) {
    if (L.speed) L.t.offset.x = (L.t.offset.x + L.dir * L.speed * k * dt) % 1;
    if (sc === 'tunnel' && !L.isYard) { L.m.visible = false; continue; }
    L.m.visible = L.isYard ? !night : L.isNear ? night : true;
    const lit = sc === 'city' && L.isMid ? 0.55 : 0;
    L.m.material.color.setRGB(Math.max(r, lit), Math.max(gg, lit * 0.9), Math.max(b, lit * 0.8));
    if (cold) L.m.material.color.multiplyScalar(1.08);
  }
  backdrop.moon.visible = night && sc !== 'tunnel';
  backdrop.moon.material.color.set(blood ? 0xff3a2a : 0xfff4d0);
  for (const pm of panes3) pm.opacity = cold ? 0.82 : 0.45;
}
// 第三世界的黃銅燈泡、鍍金燈泡、水晶吊燈燈泡（發光的部分放進 res.bulbs 一起變色）
function addTrainBulb(res, g, x, y, z, tier, s) {
  const grp = new THREE.Group(); grp.position.set(x, y, z); grp.scale.setScalar(s); g.add(grp);
  const b = new THREE.Mesh(geo('bulb', () => new THREE.SphereGeometry(0.06, 14, 10)), ownBasic({ color: 0xffffff, fog: false })); grp.add(b); res.bulbs.push(b);
  if (tier === 6) {
    // 黃銅燈泡：發黑長銅綠的黃銅籠子
    const br = lm('#6e5726');
    for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2; cyl(grp, 0.005, 0.005, 0.2, Math.cos(a) * 0.075, -0.1, Math.sin(a) * 0.075, br, 5); }
    for (const yy of [-0.09, 0.08]) { const ring = new THREE.Mesh(geo('bring', () => new THREE.TorusGeometry(0.075, 0.006, 5, 16)), br); ring.rotation.x = Math.PI / 2; ring.position.y = yy; grp.add(ring); }
    sph(grp, 0.012, 0.05, 0.03, 0.04, lm('#3f7f6a'), 1, 1, 1, 6);
  } else if (tier === 7) {
    // 鍍金燈泡：金色的底座（金漆剝落了），紅寶石色的玻璃
    cyl(grp, 0.045, 0.06, 0.07, 0, -0.1, 0, lm('#b8922e'), 12);
    cyl(grp, 0.035, 0.045, 0.02, 0, -0.03, 0, lm('#6b5a38'), 12);
  } else {
    // 水晶吊燈燈泡：掛著一串紫水晶墜飾
    const drop = ownBasic({ color: 0xd9b8ff, transparent: true, opacity: 0.85, fog: false });
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; const d = octa(grp, 0.02, Math.cos(a) * 0.07, -0.1 - (i % 2) * 0.04, Math.sin(a) * 0.07, drop); d.scale.y = 2.2; }
  }
  const halo = ownSprite(glowTex, 0xffffff);
  halo.position.set(x, y, z); halo.scale.setScalar((0.45 + tier * 0.09) * s);
  g.add(halo); res.halos.push(halo);
}
// ====================================================================
// 第三世界的家具：鍍金年代的列車內裝（胡桃木、黃銅、暗紅絨布）和車站的東西，全部都舊舊的
// ====================================================================
let velvetMat = null, sheetMatC = null;
const velvet = () => velvetMat || (velvetMat = patchLM(new THREE.MeshLambertMaterial({ map: velvetTex })));
const sheetMat = () => sheetMatC || (sheetMatC = patchLM(new THREE.MeshLambertMaterial({ map: sheetTex })));
// 以「正面」為準的位置（u 沿著正面、v 從正面往內）換算成家具的本地座標；faceOf 是朝著正面的角度
function fpos(f, side, u, v) {
  const W = f.w, D = f.h;
  if (side === 's') return [u, D - v];
  if (side === 'n') return [u, v];
  if (side === 'e') return [W - v, u];
  return [v, u];
}
const faceOf = side => ({ s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 })[side];
// 坐著不動的乘客：蓋著灰撲撲的白布，看不到臉；過場動畫才看得到活著的乘客（深色大衣和帽子）
function addPassenger(g, r, x, z, face, y = 0) {
  const pg = new THREE.Group(); pg.position.set(x, y, z); pg.rotation.y = face; g.add(pg);
  const dead = new THREE.Group(), alive = new THREE.Group(); pg.add(dead); pg.add(alive);
  const sheet = sheetMat(), coat = lm('#3a3632'), skin = lm('#cfc3b4'), hat = lm('#1c1a18');
  const head = sph(dead, 0.16, 0, 1.04, 0.02, sheet, 1, 1.12, 1, 12);
  sph(dead, 0.3, 0, 0.8, 0, sheet, 1.1, 0.72, 0.8, 12);
  box(dead, -0.25, 0.25, 0.4, 0.6, -0.1, 0.34, sheet);
  box(dead, -0.27, 0.27, 0.04, 0.42, 0.2, 0.4, sheet);
  box(alive, -0.22, 0.22, 0.48, 0.96, -0.14, 0.18, coat); box(alive, -0.24, 0.24, 0.4, 0.6, 0.1, 0.42, coat);
  for (const s of [-1, 1]) box(alive, s * 0.12 - 0.05, s * 0.12 + 0.05, 0.04, 0.42, 0.24, 0.38, coat);
  sph(alive, 0.12, 0, 1.06, 0, skin, 1, 1.15, 1, 12);
  cyl(alive, 0.12, 0.12, 0.12, 0, 1.13, 0, hat, 12); cyl(alive, 0.19, 0.19, 0.02, 0, 1.12, 0, hat, 14);
  alive.visible = false;
  (r.pax = r.pax || []).push({ g: pg, head, dead, alive, turn: 0, base: face });
}
// 留聲機的黃銅喇叭
function gramHorn(g, x, y, z, brass) {
  cyl(g, 0.04, 0.06, 0.1, x, y, z, brass, 10);
  const horn = new THREE.Mesh(geo('horn', () => new THREE.ConeGeometry(0.22, 0.45, 16, 1, true)), lm('#8a6a2a', { side: THREE.DoubleSide }));
  horn.position.set(x, y + 0.42, z - 0.12); horn.rotation.x = -0.9; horn.rotation.z = Math.PI; g.add(horn);
}
function trainFurniture(f, g, r, W, D, side, len, cabinet) {
  if (!isW3()) return false;
  const walnut = lm('#3b2416'), walnut2 = lm('#5a3a24'), brass = lm('#8a6a2a'), brass2 = lm('#5e4a1e'), iron = lm('#3a3a3e'), ivory = lm('#d8cfbd');
  const leather = lm('#5a3a22'), leather2 = lm('#2a2a2e'), glassM = ownLM('#cfe0e8', { transparent: true, opacity: 0.35, depthWrite: false });
  const paxOn = (u, v, y) => { const [x, z] = fpos(f, side, u, v); addPassenger(g, r, x, z, faceOf(side), y); };
  switch (f.type) {
    case 'rug': {
      if (!f.deco) return false;
      // 裝飾藝術的地毯：深色底、金色的花邊和一圈圓花紋，磨得有點舊
      const t = canvasTex(256, 256, (c) => {
        c.fillStyle = f.color; c.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 400; i++) { c.fillStyle = 'rgba(255,255,255,.04)'; c.fillRect(rnd() * 256, rnd() * 256, 2, 2); }
        c.strokeStyle = 'rgba(214,180,90,.7)'; c.lineWidth = 5; c.strokeRect(14, 14, 228, 228); c.lineWidth = 2; c.strokeRect(26, 26, 204, 204);
        for (let k = 0; k < 7; k++) { const p = 32 + k * 32; for (const [x, y] of [[p, 32], [p, 224], [32, p], [224, p]]) { c.beginPath(); c.arc(x, y, 10, 0, 7); c.stroke(); } }
        for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * 256, rnd() * 256, 10 + rnd() * 30, 6 + rnd() * 20, rnd() * 3, 0, 7); c.fill(); }
      });
      const mat = patchLM(new THREE.MeshLambertMaterial({ map: t })); mat.userData.own = true;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, D - 0.2), mat); m.userData.ownGeo = true;
      m.rotation.x = -Math.PI / 2; m.position.set(W / 2, 0.006, D / 2); m.receiveShadow = true; g.add(m);
      return true;
    }
    case 'gramocab': // 留聲機櫃：胡桃木櫃子，上面放著黃銅喇叭的留聲機
      cabinet(0.85, '#3b2416');
      box(g, W * 0.3, W * 0.3 + 0.4, 0.85, 1.0, D * 0.3, D * 0.3 + 0.35, walnut2);
      gramHorn(g, W * 0.3 + 0.2, 1.0, D * 0.3 + 0.18, brass);
      r.top = 1.4;
      return true;
    case 'gramophone': // 留聲機
      box(g, 0.2, 0.8, 0, 0.45, 0.2, 0.8, walnut2);
      gramHorn(g, 0.5, 0.45, 0.5, brass);
      r.top = 0.95;
      return true;
    case 'seat3': // 絨布長椅：胡桃木框、磨破的暗紅絨布，上面坐著蓋白布的乘客
      box(g, 0.05, W - 0.05, 0, 0.18, 0.05, D - 0.05, walnut);
      fb(g, f, side, 0.08, len - 0.08, 0.18, 0.48, 0.08, D - 0.08, velvet());
      fb(g, f, side, 0.08, len - 0.08, 0.48, 1.0, D - 0.3, D - 0.08, velvet());
      fb(g, f, side, 0.04, len - 0.04, 1.0, 1.06, D - 0.32, D - 0.06, walnut2, false);
      for (const u of [0.12, len - 0.12]) fb(g, f, side, u - 0.08, u + 0.08, 0.48, 0.72, 0.1, D - 0.1, walnut2);
      if (f.pax) { paxOn(len * 0.3, 0.5, 0.05); if (len >= 4) paxOn(len * 0.72, 0.5, 0.05); }
      r.top = 1.06;
      return true;
    case 'table3': { // 小圓桌：胡桃木桌面、黃銅底座，桌上有菸灰缸和倒了的酒杯
      cyl(g, 0.42, 0.42, 0.04, W / 2, 0.7, D / 2, walnut2, 18);
      cyl(g, 0.04, 0.04, 0.66, W / 2, 0.04, D / 2, brass2, 8); cyl(g, 0.22, 0.26, 0.04, W / 2, 0, D / 2, brass2, 14);
      cyl(g, 0.07, 0.06, 0.03, W / 2 - 0.2, 0.74, D / 2 + 0.1, iron, 10);
      const cup = cyl(g, 0.03, 0.03, 0.12, 0, 0, 0, glassM, 8); cup.rotation.z = Math.PI / 2; cup.position.set(W / 2 + 0.2, 0.77, D / 2 - 0.1);
      r.top = 0.8;
      return true;
    }
    case 'rack': { // 行李架：黃銅的架子，上面放著皮箱
      for (const [x, z] of [[0.08, 0.1], [W - 0.08, 0.1], [0.08, D - 0.1], [W - 0.08, D - 0.1]]) box(g, x - 0.025, x + 0.025, 0, 1.6, z - 0.025, z + 0.025, brass2);
      for (const y of [0.3, 0.95, 1.58]) box(g, 0.03, W - 0.03, y, y + 0.03, 0.06, D - 0.06, brass2);
      for (const y of [0.33, 0.98]) {
        let u = 0.1;
        while (u < len - 0.3) { const bw = 0.35 + rnd() * 0.3; fb(g, f, side, u, u + bw, y, y + 0.26 + rnd() * 0.12, 0.12, D - 0.12, rnd() < 0.5 ? leather : leather2); u += bw + 0.08; }
      }
      r.top = 1.6;
      return true;
    }
    case 'trunks': { // 行李箱堆：皮箱和帽盒疊在一起，皮帶綁著
      const strap = lm('#2a1a10');
      const trunk = (x0, z0, bw, bd, y0, bh, m) => { box(g, x0, x0 + bw, y0, y0 + bh, z0, z0 + bd, m); box(g, x0 + bw * 0.3, x0 + bw * 0.3 + 0.04, y0 - 0.005, y0 + bh + 0.005, z0 - 0.005, z0 + bd + 0.005, strap, false); };
      if (W >= 2 && D >= 2) { trunk(0.1, 0.15, 1.0, 0.7, 0, 0.5, leather); trunk(1.15, 0.2, 0.75, 0.6, 0, 0.42, leather2); trunk(0.25, 1.05, 0.9, 0.7, 0, 0.55, leather); trunk(0.3, 0.3, 0.7, 0.5, 0.5, 0.36, leather2); cyl(g, 0.2, 0.2, 0.22, 1.5, 0.42, 1.4, lm('#7a5a4a'), 14); r.top = 0.9; }
      else { const s = Math.min(W, D); trunk(0.1, 0.15, s - 0.2, s - 0.3, 0, 0.45, leather); if (Math.max(W, D) >= 2) trunk(W >= 2 ? 1.1 : 0.2, W >= 2 ? 0.2 : 1.1, 0.7, 0.6, 0, 0.36, leather2); r.top = 0.5; }
      return true;
    }
    case 'passenger': // 扶手椅上坐著一個蓋白布的乘客
      box(g, 0.1, 0.9, 0, 0.42, 0.1, 0.9, velvet()); fb(g, f, side, 0.1, 0.9, 0.42, 1.0, 0.7, 0.9, velvet());
      for (const u of [0.1, 0.9]) fb(g, f, side, u - 0.08, u + 0.08, 0.42, 0.66, 0.1, 0.9, walnut2);
      paxOn(0.5, 0.45, 0.05);
      r.top = 1.0;
      return true;
    case 'icebox': // 冰櫃：胡桃木箱子、黃銅鉸鏈
      box(g, 0.05, W - 0.05, 0, 1.3, 0.05, D - 0.05, walnut);
      fb(g, f, side, 0.1, len - 0.1, 0.1, 1.2, 0, 0.03, walnut2, false);
      fb(g, f, side, len - 0.25, len - 0.18, 0.5, 0.8, -0.02, 0.01, brass, false);
      for (const y of [0.2, 1.1]) fb(g, f, side, 0.15, len - 0.15, y, y + 0.05, -0.01, 0.01, brass2, false);
      r.top = 1.3;
      return true;
    case 'dining': // 餐桌：白桌布、銀器、燭台，兩端坐著蓋白布的乘客
      box(g, 0.1, W - 0.1, 0.72, 0.76, 0.15, D - 0.15, walnut2);
      box(g, 0.08, W - 0.08, 0.76, 0.775, 0.12, D - 0.12, ivory, false);
      for (const [x, z] of [[0.3, 0.3], [W - 0.3, 0.3], [0.3, D - 0.3], [W - 0.3, D - 0.3]]) box(g, x - 0.03, x + 0.03, 0, 0.72, z - 0.03, z + 0.03, walnut2);
      cyl(g, 0.03, 0.05, 0.22, W / 2, 0.775, D / 2, brass, 8); cyl(g, 0.015, 0.015, 0.12, W / 2, 0.99, D / 2, ivory, 6);
      for (let i = 0; i < 4; i++) cyl(g, 0.1, 0.1, 0.01, 0.6 + i * (W - 1.2) / 3, 0.775, i % 2 ? 0.45 : D - 0.45, lm('#c9ced4'), 12);
      addPassenger(g, r, 0.4, D / 2, Math.PI / 2, -0.22); addPassenger(g, r, W - 0.4, D / 2, -Math.PI / 2, -0.22);
      r.top = 1.0;
      return true;
    case 'crates3': { // 木箱：裡面放著木柴
      const cw = lm('#6a4a2e'), slat = lm('#3a2616'), log = lm('#8a6a44');
      const crate = (x0, z0, s, y0) => {
        box(g, x0, x0 + s, y0, y0 + s * 0.7, z0, z0 + s, cw); box(g, x0 - 0.005, x0 + s + 0.005, y0 + s * 0.3, y0 + s * 0.38, z0 - 0.005, z0 + s + 0.005, slat, false);
        for (let i = 0; i < 4; i++) { const l = cyl(g, 0.05, 0.05, s * 0.9, 0, 0, 0, log, 7); l.rotation.x = Math.PI / 2; l.position.set(x0 + 0.15 + i * s * 0.2, y0 + s * 0.7 + 0.05, z0 + s / 2); }
      };
      crate(0.1, 0.1, 0.85, 0); crate(1.05, 0.2, 0.75, 0); crate(0.3, 1.05, 0.8, 0);
      r.top = 0.75;
      return true;
    }
    case 'washstand': // 黃銅洗手台：兩個臉盆、水龍頭、發霉的鏡子
      box(g, 0.05, W - 0.05, 0, 0.85, 0.05, D - 0.05, walnut);
      box(g, 0, W, 0.85, 0.9, 0, D, lm('#cfc8b8'));
      for (const u of [len * 0.3, len * 0.7]) { const [x, z] = fpos(f, side, u, D / 2); cyl(g, 0.22, 0.17, 0.08, x, 0.86, z, lm('#e6e2d6'), 16); const [tx, tz] = fpos(f, side, u, D - 0.2); cyl(g, 0.02, 0.02, 0.25, tx, 0.9, tz, brass, 8); }
      fb(g, f, side, 0.2, len - 0.2, 1.1, 1.8, D - 0.06, D - 0.02, lm('#8a9aa0'), false);
      fb(g, f, side, 0.15, len - 0.15, 1.05, 1.85, D - 0.05, D - 0.03, brass2, false);
      r.top = 1.85;
      return true;
    case 'liquor': { // 酒櫃：胡桃木櫃子，架上一排酒瓶
      box(g, 0.02, W - 0.02, 0, 1.9, 0.02, D - 0.02, walnut);
      const cols = ['#3a6e3a', '#6a2a2a', '#c9a24a', '#2a4a6a', '#5a4a2a'];
      for (let s = 0; s < 3; s++) {
        let u = 0.12;
        while (u < len - 0.15) { fb(g, f, side, u, u + 0.09, 0.2 + s * 0.55, 0.5 + s * 0.55 + rnd() * 0.1, 0.05, 0.14, lm(cols[(rnd() * cols.length) | 0]), false); u += 0.14 + rnd() * 0.08; }
        fb(g, f, side, 0.05, len - 0.05, 0.18 + s * 0.55, 0.2 + s * 0.55, 0.03, D - 0.03, walnut2, false);
      }
      r.top = 1.9;
      return true;
    }
    case 'minibar': // 小吧台：大理石台面、黃銅扶手、幾個酒瓶和杯子
      cabinet(0.95, '#3b2416');
      box(g, 0, W, 0.95, 1.0, 0, D, lm('#cfc8b8'));
      fb(g, f, side, 0.05, len - 0.05, 0.9, 0.93, -0.03, 0, brass, false);
      for (let i = 0; i < 3; i++) fb(g, f, side, 0.3 + i * 0.35, 0.39 + i * 0.35, 1.0, 1.3, 0.5, 0.6, lm(['#3a6e3a', '#6a2a2a', '#c9a24a'][i]), false);
      fb(g, f, side, len - 0.4, len - 0.3, 1.0, 1.12, 0.3, 0.4, glassM, false);
      r.top = 1.3;
      return true;
    case 'coalpile': { // 煤堆：黑色的煤塊堆成一堆
      const coal = ownLM('#141416', { shade: 0.6 });
      for (let i = 0; i < 18; i++) { const x = 0.15 + rnd() * (W - 0.3), z = 0.15 + rnd() * (D - 0.3), hh = 0.1 + (1 - Math.hypot(x - W / 2, z - D / 2) / Math.max(W, D)) * 0.4; sph(g, 0.09 + rnd() * 0.08, x, hh * rnd() + 0.05, z, coal, 1 + rnd() * 0.5, 0.7 + rnd() * 0.4, 1 + rnd() * 0.5, 7); }
      r.top = 0.5;
      return true;
    }
    case 'pipes': { // 鍋爐的管線和壓力表
      for (const y of [1.2, 1.6, 2.0]) { const pp = cyl(g, 0.06, 0.06, W - 0.1, 0, 0, 0, iron, 10); pp.rotation.z = Math.PI / 2; pp.position.set(W / 2, y, 0.3); }
      for (let i = 0; i < 3; i++) cyl(g, 0.045, 0.045, 0.5, 0.3 + i * (W - 0.6) / 2, 1.2, 0.3, iron, 8);
      for (const x of [0.4, W - 0.4]) { const gauge = cyl(g, 0.12, 0.12, 0.05, 0, 0, 0, brass, 14); gauge.rotation.x = Math.PI / 2; gauge.position.set(x, 1.6, 0.42); const face = cyl(g, 0.09, 0.09, 0.01, 0, 0, 0, ivory, 14); face.rotation.x = Math.PI / 2; face.position.set(x, 1.6, 0.455); }
      box(g, 0.05, W - 0.05, 0, 1.0, 0.05, D - 0.05, iron);
      r.top = 2.1;
      return true;
    }
    case 'firebox': { // 火爐：鐵做的火箱，圓形的爐門開著，裡面燒著火；旁邊靠著鏟子
      const dark = lm('#2a2a2e');
      box(g, 0.1, W - 0.1, 0, 1.5, 0.1, D - 0.1, iron);
      box(g, 0.05, W - 0.05, 1.5, 1.6, 0.05, D - 0.05, dark);
      cyl(g, 0.3, 0.3, 0.6, W / 2, 1.6, D / 2, iron, 14); cyl(g, 0.12, 0.12, WALL_H - 2.2, W / 2, 2.2, D / 2, dark, 8);
      for (const [u, v] of [[0.3, 0.2], [len - 0.3, 0.2], [0.3, D - 0.3], [len - 0.3, D - 0.3]]) { const [x, z] = fpos(f, side, u, v); for (let i = 0; i < 5; i++) sph(g, 0.03, x, 0.3 + i * 0.28, z, dark, 1, 1, 1, 5); }
      const [dx, dz] = fpos(f, side, len / 2, 0.02);
      const door = new THREE.Group(); door.position.set(dx, 0.75, dz); door.rotation.y = faceOf(side); g.add(door);
      door.add(new THREE.Mesh(geo('fbring', () => new THREE.TorusGeometry(0.34, 0.05, 8, 24)), brass2));
      const hole = new THREE.Mesh(geo('fbhole', () => new THREE.CircleGeometry(0.33, 24)), ownBasic({ color: 0x1a0600, fog: false })); hole.position.z = -0.02; door.add(hole);
      r.fireMat = ownBasic({ color: 0xff7a1a, fog: false, transparent: true, opacity: 0.9 });
      r.fire = new THREE.Group(); door.add(r.fire);
      for (let i = 0; i < 5; i++) { const fl = new THREE.Mesh(geo('fbflame', () => new THREE.ConeGeometry(0.07, 0.3, 8)), r.fireMat); fl.position.set((i - 2) * 0.1, -0.1, 0.02); r.fire.add(fl); }
      r.fireGlow = ownSprite(glowTex, 0xff8a2a); r.fireGlow.position.set(0, 0, 0.1); r.fireGlow.scale.setScalar(1.3); door.add(r.fireGlow);
      const lid = new THREE.Mesh(geo('fbdoor', () => new THREE.CircleGeometry(0.36, 24)), iron); lid.position.set(0.5, 0, 0.03); lid.rotation.y = -1.3; door.add(lid);
      const [sx, sz] = fpos(f, side, 0.15, -0.25), [ex, ez] = fpos(f, side, 0.1, 0.1);
      limb(g, [sx, 0.02, sz], [ex, 1.1, ez], 0.02, lm('#5a3a1a')); box(g, sx - 0.1, sx + 0.1, 0, 0.03, sz - 0.1, sz + 0.1, iron, false);
      r.top = 1.6;
      return true;
    }
    case 'woodpile': { // 木堆：一根一根疊起來的木柴
      const log = lm('#8a6a44'), bark = lm('#5a3a22');
      for (let row = 0; row < 4; row++) for (let i = 0; i < 4 - (row > 2 ? 1 : 0); i++) {
        const l = cyl(g, 0.09, 0.09, D - 0.3, 0, 0, 0, row % 2 ? bark : log, 8);
        l.rotation.x = Math.PI / 2; l.position.set(0.25 + i * 0.2 + (row % 2) * 0.1, 0.09 + row * 0.16, D / 2);
      }
      r.top = 0.75;
      return true;
    }
    case 'bench3': case 'benches': { // 長椅：鑄鐵腳、木條座面；候車室那一排坐著蓋白布的乘客
      const slat = lm('#6a4a2e');
      for (const v0 of [0.15, 0.3, 0.45]) fb(g, f, side, 0.1, len - 0.1, 0.42, 0.46, v0, v0 + 0.11, slat);
      for (const y0 of [0.6, 0.75]) fb(g, f, side, 0.1, len - 0.1, y0, y0 + 0.1, 0.62, 0.68, slat);
      for (const u of (len >= 4 ? [0.3, len / 2, len - 0.3] : [0.3, len - 0.3])) { fb(g, f, side, u - 0.04, u + 0.04, 0, 0.42, 0.14, 0.56, iron); fb(g, f, side, u - 0.04, u + 0.04, 0, 0.9, 0.64, 0.7, iron); }
      if (f.pax) { paxOn(len * 0.25, 0.45, 0.02); paxOn(len * 0.78, 0.45, 0.02); }
      r.top = 0.9;
      return true;
    }
    case 'cart': // 行李推車：鐵架、兩個大輪子、上面堆著行李
      box(g, 0.15, W - 0.15, 0.3, 0.36, 0.2, D - 0.2, iron);
      for (const s of [0.3, D - 0.3]) { const wh = cyl(g, 0.3, 0.3, 0.06, 0, 0, 0, iron, 16); wh.rotation.z = Math.PI / 2; wh.position.set(W / 2, 0.3, s); }
      box(g, 0.15, 0.2, 0.36, 1.1, 0.25, D - 0.25, iron);
      box(g, 0.3, W - 0.3, 0.36, 0.8, 0.3, D - 0.3, leather); box(g, 0.5, W - 0.5, 0.8, 1.1, 0.4, D - 0.4, leather2);
      r.top = 1.1;
      return true;
    case 'ticket': // 售票口：木頭櫃台、玻璃窗和黃銅欄杆、上面的牌子
      cabinet(1.05, '#3b2416');
      fb(g, f, side, 0.1, len - 0.1, 1.05, 2.1, D - 0.1, D - 0.04, glassM, false);
      for (let i = 0; i < 6; i++) fb(g, f, side, 0.2 + i * (len - 0.4) / 5, 0.23 + i * (len - 0.4) / 5, 1.05, 2.0, D - 0.08, D - 0.06, brass2, false);
      fb(g, f, side, 0.1, len - 0.1, 1.2, 1.3, D - 0.09, D - 0.05, walnut2, false);
      fb(g, f, side, 0.3, len - 0.3, 2.1, 2.45, D - 0.2, D - 0.05, ivory);
      r.top = 2.45;
      return true;
    case 'telegraph': // 電報機：木桌上的黃銅電報鍵、線圈、散落的電報紙
      box(g, 0.05, W - 0.05, 0.72, 0.78, 0.1, D - 0.1, walnut2);
      for (const [x, z] of [[0.15, 0.15], [W - 0.15, 0.15], [0.15, D - 0.15], [W - 0.15, D - 0.15]]) box(g, x - 0.03, x + 0.03, 0, 0.72, z - 0.03, z + 0.03, walnut2);
      box(g, 0.4, 0.9, 0.78, 0.84, 0.3, 0.7, walnut); box(g, 0.55, 0.75, 0.84, 0.9, 0.4, 0.5, brass); limb(g, [0.65, 0.9, 0.5], [0.72, 0.95, 0.7], 0.01, brass);
      cyl(g, 0.08, 0.08, 0.2, 1.3, 0.78, 0.5, brass2, 12);
      for (let i = 0; i < 3; i++) { const x = 1.0 + rnd() * 0.5, z = 0.15 + rnd() * 0.4; box(g, x, x + 0.3, 0.78, 0.785, z, z + 0.3, ivory, false); }
      r.top = 0.95;
      return true;
    case 'coalsack': { // 煤袋：麻布袋，口開著露出煤塊
      const burlap = lm('#6a5a44'), coal = ownLM('#141416', { shade: 0.6 });
      for (const [x, z, s] of [[0.5, 0.5, 1], [1.4, 0.45, 0.85], [1.0, 0.75, 0.75]]) { sph(g, 0.3 * s, x, 0.3 * s, z, burlap, 1, 1.2, 1, 10); for (let i = 0; i < 4; i++) sph(g, 0.07, x + (rnd() - 0.5) * 0.25, 0.62 * s + rnd() * 0.05, z + (rnd() - 0.5) * 0.25, coal, 1, 0.8, 1, 6); }
      r.top = 0.75;
      return true;
    }
    case 'sign': { // 站牌：鐵柱和寫著站名的牌子（站名每天換）
      cyl(g, 0.03, 0.035, 1.9, W / 2, 0, D / 2, iron, 8);
      r.signCv = document.createElement('canvas'); r.signCv.width = 256; r.signCv.height = 96;
      r.signTex = new THREE.CanvasTexture(r.signCv); r.signTex.colorSpace = SRGB;
      const sm = patchLM(new THREE.MeshLambertMaterial({ map: r.signTex })); sm.userData.own = true;
      const board = new THREE.Mesh(geo('signboard', () => new THREE.BoxGeometry(1.4, 0.5, 0.06)), [iron, iron, iron, iron, sm, sm]);
      board.position.set(W / 2, 1.9, D / 2); board.rotation.y = faceOf(side); g.add(board);
      r.signName = '';
      r.top = 2.2;
      return true;
    }
    case 'gaslamp': // 煤氣燈：鑄鐵燈柱，上面的玻璃燈罩裡有一點會閃的火光
      cyl(g, 0.04, 0.06, 2.1, 0.5, 0, 0.5, iron, 8); cyl(g, 0.14, 0.18, 0.08, 0.5, 0, 0.5, iron, 10);
      box(g, 0.36, 0.64, 2.1, 2.42, 0.36, 0.64, glassM); box(g, 0.33, 0.67, 2.42, 2.5, 0.33, 0.67, iron); cyl(g, 0.02, 0.1, 0.1, 0.5, 2.5, 0.5, iron, 8);
      r.flame = new THREE.Mesh(geo('gasflame', () => new THREE.ConeGeometry(0.03, 0.12, 8)), ownBasic({ color: 0xffd080, fog: false })); r.flame.position.set(0.5, 2.22, 0.5); g.add(r.flame);
      r.glow = ownSprite(glowTex, 0xffb060); r.glow.position.set(0.5, 2.26, 0.5); r.glow.scale.setScalar(0.9); g.add(r.glow);
      r.top = 2.6;
      return true;
    case 'timetable': // 牆上的時刻表：木框、泛黃的紙、一行一行的字
      fb(g, f, side, 0.1, len - 0.1, 1.1, 1.9, D - 0.08, D - 0.02, walnut2);
      fb(g, f, side, 0.15, len - 0.15, 1.15, 1.85, D - 0.09, D - 0.03, ivory, false);
      for (let i = 0; i < 7; i++) fb(g, f, side, 0.25, len - 0.25 - rnd() * 0.3, 1.22 + i * 0.09, 1.24 + i * 0.09, D - 0.1, D - 0.03, lm('#3a3230'), false);
      r.top = 1.9;
      return true;
    case 'phone': { // 對講機：牆上的木盒子，黃銅的鈴和聽筒
      fb(g, f, side, 0.25, 0.75, 0.95, 1.55, D - 0.3, D - 0.05, walnut);
      for (const u of [0.38, 0.62]) { const bell = cyl(g, 0.06, 0.06, 0.04, 0, 0, 0, brass, 12); const [x, z] = fpos(f, side, u, 0.32); bell.rotation.x = Math.PI / 2; bell.position.set(x, 1.45, z); }
      r.handset = ownLM('#1c1a18');
      fb(g, f, side, 0.28, 0.4, 1.0, 1.3, D - 0.36, D - 0.28, r.handset, false);
      fb(g, f, side, 0.45, 0.6, 1.1, 1.2, D - 0.33, D - 0.3, brass2, false);
      r.top = 1.55;
      return true;
    }
    case 'gacha': { // 幸運機：胡桃木的箱子、黃銅的搖把、玻璃罩裡的彩球
      box(g, 0.14, 0.86, 0, 0.8, 0.14, 0.86, walnut);
      cyl(g, 0.3, 0.3, 0.04, 0.5, 0.8, 0.5, brass2, 20);
      const dome = new THREE.Mesh(geo('dome', () => new THREE.SphereGeometry(0.3, 20, 14)), ownLM('#dff0ff', { transparent: true, opacity: 0.3, depthWrite: false })); dome.position.set(0.5, 1.12, 0.5); g.add(dome);
      const caps = ['#c9a24a', '#6a2a2a', '#3a6e3a', '#d8cfbd', '#2a4a6a', '#8a3a6a'];
      caps.forEach((c, i) => { const a = i * 2.4; sph(g, 0.075, 0.5 + Math.cos(a) * 0.14, 0.92 + (i % 3) * 0.1, 0.5 + Math.sin(a) * 0.14, lm(c), 1, 1, 1, 10); });
      cyl(g, 0.12, 0.16, 0.08, 0.5, 1.4, 0.5, brass2, 16);
      fb(g, f, side, 0.3, 0.7, 0.5, 0.62, 0, 0.03, lm('#222222'), false);
      fb(g, f, side, 0.42, 0.58, 0.22, 0.38, 0, 0.06, brass, false);
      r.top = 1.48;
      return true;
    }
  }
  return false;
}
// ---------- 寶箱：櫃箱（舊木頭、鐵皮包角）、鐵寶箱（生鏽）、銀寶箱（發黑、有花紋）、鉑寶箱（幾乎沒磨損、微微發光） ----------
const chestMap = new Map();
let chestTexes = null;
function makeChestTextures() {
  const mk = (base, draw) => canvasTex(128, 128, (c, w, h) => { c.fillStyle = base; c.fillRect(0, 0, w, h); draw(c, w, h); });
  chestTexes = {
    1: mk('#6b4a2e', (c, w, h) => { for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(20,10,5,${0.2 + rnd() * 0.4})`; c.lineWidth = 1 + rnd(); const y = rnd() * h; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y + (rnd() - 0.5) * 6); c.stroke(); } c.fillStyle = '#4a4a4e'; c.fillRect(0, 0, 14, h); c.fillRect(w - 14, 0, 14, h); }),
    2: mk('#4a4a50', (c, w, h) => { for (let i = 0; i < 60; i++) { c.fillStyle = `rgba(150,70,30,${0.2 + rnd() * 0.5})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 12, 2 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); } c.fillStyle = '#2a2a2e'; for (let x = 8; x < w; x += 16) { c.beginPath(); c.arc(x, 8, 2.5, 0, 7); c.fill(); c.beginPath(); c.arc(x, h - 8, 2.5, 0, 7); c.fill(); } }),
    3: mk('#8a8f96', (c, w, h) => { c.strokeStyle = 'rgba(40,40,48,.55)'; c.lineWidth = 2; for (let i = 0; i < 6; i++) { c.beginPath(); c.arc(20 + i * 18, 64, 12, 0, 7); c.stroke(); } for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(20,20,26,${0.15 + rnd() * 0.4})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 14, 3 + rnd() * 8, rnd() * 3, 0, 7); c.fill(); } }),
    4: mk('#dfe3e8', (c, w, h) => { const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(0.5, 'rgba(200,210,230,0)'); g.addColorStop(1, 'rgba(255,255,255,.4)'); c.fillStyle = g; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(120,130,150,.5)'; c.lineWidth = 2; c.strokeRect(10, 10, w - 20, h - 20); }),
  };
}
function buildChest3(c) {
  if (!chestTexes) makeChestTextures();
  const g = new THREE.Group(); g.position.set(c.x + 0.5, 0, c.y + 0.5); g.rotation.y = c.face || 0; scene.add(g);
  const m = c.lv === 4 ? ownPhong('#ffffff', { map: chestTexes[4], specular: 0xffffff, shininess: 60 }) : c.lv === 3 ? ownPhong('#ffffff', { map: chestTexes[3], specular: 0x888888, shininess: 25 }) : ownLM('#ffffff', { map: chestTexes[c.lv] });
  const edge = lm(c.lv === 1 ? '#4a4a4e' : c.lv === 2 ? '#2a2a2e' : c.lv === 3 ? '#5a5e66' : '#c9cfd8');
  const W = 0.82, D = 0.6, H = 0.42;
  const body = new THREE.Mesh(BOX, m); body.scale.set(W, H, D); body.position.set(0, H / 2, 0); body.castShadow = true; body.receiveShadow = true; g.add(body);
  for (const s of [-1, 1]) box(g, s * W / 2 - 0.03, s * W / 2 + 0.03, 0, H + 0.02, -D / 2 - 0.01, D / 2 + 0.01, edge, false);
  // 蓋子：鉸鏈在後面（-z），打開時往後翻
  const piv = new THREE.Group(); piv.position.set(0, H, -D / 2); g.add(piv);
  const lid = new THREE.Mesh(BOX, m); lid.scale.set(W, 0.14, D); lid.position.set(0, 0.07, D / 2); lid.castShadow = true; piv.add(lid);
  box(piv, -0.05, 0.05, 0.02, 0.12, D - 0.02, D + 0.03, edge, false);   // 鎖
  const inside = ownSprite(glowTex, c.lv === 4 ? 0xcfe0ff : 0xffd060); inside.position.set(0, H + 0.1, 0); inside.scale.setScalar(0.7); inside.visible = false; g.add(inside);
  const glow = c.lv === 4 ? ownSprite(glowTex, 0xdfe8ff) : null;
  if (glow) { glow.position.set(0, H / 2, 0); glow.scale.setScalar(1.4); g.add(glow); }
  return { g, piv, inside, glow, k: c.open || c.out ? 1 : 0 };
}
function syncChests3(t) {
  const seen = new Set();
  for (const c of G.chests3 || []) {
    seen.add(c);
    let r = chestMap.get(c);
    if (!r) { r = buildChest3(c); chestMap.set(c, r); }
    const target = c.open || c.out ? 1 : 0;
    r.k += (target - r.k) * 0.15;
    r.piv.rotation.x = -1.6 * r.k;
    r.inside.visible = c.out && !c.open;
    if (r.inside.visible) r.inside.material.opacity = 0.5 + 0.3 * Math.sin(t * 5);
    if (r.glow) r.glow.material.opacity = (c.open ? 0.15 : 0.45) + 0.2 * Math.sin(t * 2);
  }
  for (const [c, r] of chestMap) if (!seen.has(c)) { disposeGroup(r.g); chestMap.delete(c); }
}
// ---------- 列車停下來：窗外貼著一雙雙發亮的眼睛和手 ----------
let stopEyes = null;
function buildStopEyes() {
  stopEyes = new THREE.Group(); houseGroup.add(stopEyes);
  const hand = ownLM('#8a8278', { transparent: true, opacity: 0.9 });
  for (const [x, y] of WINDOWS_W3) {
    if (y >= 26) continue;   // 只有列車的窗戶
    const ns = y === 0;
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const ox = ns ? x + 0.3 + i * 0.4 : (x === 0 ? -0.15 : x + 1.15), oz = ns ? -0.15 : y + 0.3 + i * 0.4;
      g.position.set(ox, 1.3 + rnd() * 0.5, oz);
      const e = ownSprite(glowTex, rnd() < 0.5 ? 0xffd9a0 : 0xff6a50); e.scale.setScalar(0.07 + rnd() * 0.05); g.add(e);
      const e2 = e.clone(); e2.position.x = ns ? 0.09 : 0; e2.position.z = ns ? 0 : 0.09; g.add(e2);
      if (rnd() < 0.6) { const h = box(g, -0.06, 0.06, -0.3, -0.1, -0.02, 0.02, hand, false); if (!ns) h.rotation.y = Math.PI / 2; for (let k = 0; k < 4; k++) { const f = box(g, -0.05 + k * 0.03, -0.035 + k * 0.03, -0.1, 0.02, -0.01, 0.01, hand, false); if (!ns) f.rotation.y = Math.PI / 2; } }
      g.userData.ph = rnd() * 6;
      stopEyes.add(g);
    }
  }
  stopEyes.visible = false;
}
function syncStopEyes(t) {
  if (!stopEyes) return;
  const on = isW3() && G.train && (G.train.state === 'stopped' || G.train.state === 'starting') && G.phase === 'night';
  stopEyes.visible = on;
  if (!on) return;
  for (const g of stopEyes.children) { const k = Math.sin(t * 3 + g.userData.ph); g.visible = k > -0.6; g.position.y += Math.sin(t * 7 + g.userData.ph) * 0.002; }
}
// 每一幀：火爐的火、煤氣燈閃爍、站牌的站名、乘客（過場動畫時活著；夜晚事件讓某個乘客的頭慢慢轉過來看你）
function updateTrainFurniture(t) {
  const fb3 = furn3d.firebox;
  if (fb3 && fb3.fire) {
    const k = fireBurning() ? 1 : (G.fire && G.fire.queue.length ? 0.35 : 0.08);
    fb3.fire.visible = k > 0.1;
    fb3.fire.children.forEach((fl, i) => fl.scale.set(1, 0.4 + (0.6 + 0.7 * Math.abs(Math.sin(t * 11 + i * 1.3))) * k, 1));
    fb3.fireMat.color.setRGB(1, 0.35 + 0.3 * k, 0.1);
    fb3.fireGlow.material.opacity = (0.3 + 0.5 * Math.abs(Math.sin(t * 9))) * k;
  }
  for (const id of ['gaslamp1', 'gaslamp2']) { const r = furn3d[id]; if (!r || !r.flame) continue; r.flame.scale.set(1, 0.8 + 0.5 * Math.random(), 1); r.glow.material.opacity = 0.3 + 0.2 * Math.random(); }
  const sg = furn3d.sign;
  if (sg && sg.signCv && sg.signName !== curStation()) {
    sg.signName = curStation();
    const c = sg.signCv.getContext('2d');
    c.fillStyle = '#1e2a3a'; c.fillRect(0, 0, 256, 96); c.strokeStyle = '#c9c0a8'; c.lineWidth = 4; c.strokeRect(6, 6, 244, 84);
    c.fillStyle = '#e8e0c8'; c.font = 'bold 44px "PingFang TC","Noto Sans TC",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(sg.signName, 128, 50);
    sg.signTex.needsUpdate = true;
  }
  const alive = !!(mode === 'cutscene' && CUT && CUT.kind === 2 && CUT.alive);
  for (const f of FURN) {
    const r = furn3d[f.id];
    if (!r || !r.pax) continue;
    for (const px of r.pax) {
      px.alive.visible = alive; px.dead.visible = !alive;
      if (px.turn > 0) {
        px.g.getWorldPosition(_v);
        let want = Math.atan2(G.p.x - _v.x, G.p.y - _v.z) - px.base;
        while (want > Math.PI) want -= Math.PI * 2;
        while (want < -Math.PI) want += Math.PI * 2;
        px.head.rotation.y = clamp(want, -1.4, 1.4) * px.turn;
      } else px.head.rotation.y = 0;
    }
  }
}

// ====================================================================
// 霧、窗戶、主繪圖
// ====================================================================
const cDayFog = new THREE.Color('#1b1720'), cNightFog = new THREE.Color('#020104'), cBloodFog = new THREE.Color('#160205');
const cWinDay = new THREE.Color('#dcebf5'), cWinDusk = new THREE.Color('#e89a5a'), cWinNight = new THREE.Color('#0a1022'), cWinBlood = new THREE.Color('#4a0610');
// 第二世界：白天是淡淡的粉紫色霧，晚上深藍紫色；萬物甦醒時在紫色和綠色之間變來變去
const cW2Day = new THREE.Color('#cdbfe0'), cW2Night = new THREE.Color('#05041a'), cAwakeA = new THREE.Color('#1c0a2c'), cAwakeB = new THREE.Color('#06221a');
// 第三世界：白天是像老照片的褐色調，晚上黑；紅月偏紅
const cW3Day = new THREE.Color('#2a2420'), cW3Night = new THREE.Color('#030204'), cW3Blood = new THREE.Color('#1a0406');
const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
function updateAtmosphere(dark, t) {
  const k = dark / NIGHT_DARK;
  if (isW3()) {
    const blood = G.ev.blood && G.phase === 'night';
    tmpC.copy(cW3Day).lerp(blood ? cW3Blood : cW3Night, k);
    scene.fog.color.copy(tmpC); scene.background.copy(tmpC);
    scene.fog.near = 10 - 8.5 * k; scene.fog.far = 45 - 32 * k;
    return;
  }
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
// ====================================================================
// 怪物圖鑑：用遊戲裡的 3D 模型即時畫在卡片上，而且會做動作
// 另外開一張透明、不吃觸控的 WebGL 畫布蓋在圖鑑畫面上，每張卡片的位置各畫一隻（用 scissor 裁在卡片和面板的範圍內）。
// 怪物用假的敵人資料驅動原本的動作程式，照劇本輪流做動作；鏡頭慢慢左右繞，看得出立體。
// 光線不用遊戲的光照貼圖（換成一張固定亮度的 1×1 貼圖），再加兩盞燈。WebGL 開不起來就回報 ok() = false，圖鑑改用 2D 縮圖。
// ====================================================================
const book = { active: false, items: [], models: new Map(), renderer: null, scene: null, cam: null, t: 0, w: 0, h: 0, okFlag: null, stats: { rendered: 0, built: 0 } };
const BOOK_P = { x: 0, y: 0, flash: false };   // 假的玩家：怪物會面向它
// 每種怪物的取景：h 高度、d 鏡頭距離、cy 看著的高度（沒寫就用高度算）
const BOOK_VIEW = { crawler: { h: 1.0, d: 2.8, cy: 0.4 }, snail: { h: 1.45, d: 2.9, cy: 0.6 }, blob: { h: 1.0, d: 2.4, cy: 0.5 }, shroom: { h: 1.95, d: 3.7 }, grass: { h: 1.95 }, sunflower: { h: 1.75 }, eye: { h: 1.65 } };
function bookOk() {
  if (book.okFlag !== null) return book.okFlag;
  try {
    const cv = document.createElement('canvas');
    cv.id = 'bookfx';
    document.getElementById('book').appendChild(cv);
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const R = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: !coarse, powerPreference: 'high-performance' });
    R.outputColorSpace = SRGB;
    R.setScissorTest(true);
    book.renderer = R;
    book.scene = new THREE.Scene();
    book.cam = new THREE.PerspectiveCamera(36, 1, 0.05, 40);
    const key = new THREE.DirectionalLight(0xfff0dc, 1.0); key.position.set(1.5, 3, 2.5); book.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa8b8ff, 0.3); fill.position.set(-2, 1, -1); book.scene.add(fill);
    // 舞台：四周是暗色漸層的背景、腳下一圈地板（圖鑑卡片的範圍全部由這裡畫滿）
    const bg = canvasTex(8, 64, (c, w, h) => { const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#171320'); g.addColorStop(0.5, '#2e2640'); g.addColorStop(1, '#4a3d5e'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(12, 16, 12), new THREE.MeshBasicMaterial({ map: bg, side: THREE.BackSide, fog: false }));
    dome.position.set(BOOK_X, 1.0, BOOK_Y); book.scene.add(dome);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), new THREE.MeshBasicMaterial({ color: 0x231c2e, fog: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(BOOK_X, 0.002, BOOK_Y); book.scene.add(floor);
    book.lm = new THREE.DataTexture(new Uint8Array([100, 96, 108, 255]), 1, 1, THREE.RGBAFormat);
    book.lm.needsUpdate = true;
    book.okFlag = true;
  } catch (e) { book.okFlag = false; }
  return book.okFlag;
}
// 怪物都放在地圖中間同一個位置（lightAt 之類的函式要查得到房間），一次只顯示一隻
const BOOK_X = Math.floor(MAP_W / 2) + 0.5, BOOK_Y = Math.floor(MAP_H / 2) + 0.5;
function bookModel(spec) {
  const key = spec.flower ? 'f:' + spec.flower : spec.kind;
  let m = book.models.get(key);
  if (m) return m;
  book.stats.built++;
  if (spec.flower) {
    const f = { x: BOOK_X, y: BOOK_Y, ptype: spec.flower, grow: 1, face: Math.PI / 2, lock: 0, burn: 0, alarm: 0, shut: 0, spore: false, sees: false, watch: 0 };
    m = { key, f, r: buildFlower(f, book.scene) };
  } else {
    const e = { kind: spec.kind, x: BOOK_X, y: BOOK_Y, wob: 0, spawn: 0, hp: 1, lv: 1, size: 1, h: 0.4, eatT: 0, seen: false,
      burn: 0, emerge: 0, pauseT: 0, state: 'idle', cd: 0, stun: 0, hopT: 1, hopping: 0, air: 0, rise: 0, hidden: false, retract: 0, chew: 0, blind: 0, blindCd: 0 };
    m = { key, e, r: buildEnemy(e, book.scene) };
  }
  const v = BOOK_VIEW[spec.flower || spec.kind] || {};
  m.h = v.h || barH(m.e || m.f); m.d = v.d || m.h * 1.85 + 0.3; m.cy = v.cy ?? m.h * 0.5;
  m.r.g.visible = false;
  book.models.set(key, m);
  return m;
}
// 劇本：每隻怪物輪流做自己的動作（c 是這隻的週期時間）
function bookAnimate(m, t, dt, ph) {
  const e = m.e, f = m.f;
  if (f) {
    const c = (t + ph) % 6;
    // 假玩家慢慢左右走，眼睛會跟著看；向日葵眼一半時間盯著你、一半時間看別的光；千眼菇偶爾閉眼
    BOOK_P.x = f.x + Math.sin(t * 0.7 + ph) * 1.6; BOOK_P.y = f.y + 2.6;
    if (f.ptype === 'sunflower') { f.lock = c < 3.2 ? 1 : 0; f.face = f.lock ? Math.atan2(BOOK_P.y - f.y, BOOK_P.x - f.x) : Math.PI / 2 + 1.1; }
    else if (f.ptype === 'shroom') f.shut = c > 4.6 ? 1 : 0;
    else f.alarm = c > 5.2 ? 1 : 0;
    syncFlower(f, m.r, t, BOOK_P, true);
    return;
  }
  e.wob += dt;
  let near = 2.5;
  switch (e.kind) {
    case 'momo': {   // 每 2 秒跳一下，跳之前先蹲
      const hc = (t + ph) % 2, HOP = 0.45;
      e.hopping = hc < HOP ? HOP - hc : 0;
      e.air = e.hopping > 0 ? Math.sin(Math.PI * (1 - e.hopping / HOP)) : 0;
      e.hopT = e.hopping > 0 ? 1 : 2 - hc;
      break;
    }
    case 'crawler': e.pauseT = (t + ph) % 3.5 < 2.4 ? 0 : 1; break;   // 爬一段、停一下（頭會抽動）
    case 'woman': e.seen = (t + ph) % 4.5 < 2; break;                  // 被看著時不動、沒被看著時飄
    case 'grass': {   // 躲在草裡 → 站起來 → 撲 → 抓 → 鑽回去
      const g = (t + ph) % 6.5;
      if (g < 2.2) { e.hidden = true; e.state = 'hidden'; e.rise = Math.max(0, e.rise - dt * 3); }
      else if (g < 2.65) { e.hidden = false; e.state = 'rise'; e.rise = Math.min(1, e.rise + dt / 0.42); }
      else if (g < 4.6) { e.state = 'up'; e.rise = 1; }
      else if (g < 5.0) e.state = 'lunge';
      else if (g < 5.6) e.state = 'grab';
      else { e.state = 'sink'; e.rise = Math.max(0, e.rise - dt / 0.6); }
      break;
    }
    case 'snail': { const g = (t + ph) % 7; e.chew = g > 5 ? 1 : 0; e.retract = g > 3.2 && g < 4.4 ? 1 : 0; break; }  // 爬、縮觸角、嚼
    case 'girl': { const g = (t + ph) % 7; e.state = g < 3 ? 'hunt' : 'wander'; e.blind = g > 4.5 && g < 6 ? 1 : 0; break; }  // 追、被照瞎甩頭
    case 'clown': near = (t + ph) % 5 < 2.4 ? 1.5 : 3; break;   // 靠近時揮刀
  }
  BOOK_P.x = e.x; BOOK_P.y = e.y + near;
  syncEnemy(e, m.r, t, BOOK_P);
}
function renderBook(dt) {
  if (!book.active || !book.renderer) return;
  const screen = document.getElementById('book');
  if (screen.classList.contains('hidden')) return;
  book.t += dt;
  const R = book.renderer, W = innerWidth, H = innerHeight;
  if (book.w !== W || book.h !== H) {
    book.w = W; book.h = H;
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, document.body.classList.contains('touch') ? 1.4 : 2));
    R.setSize(W, H, false);
  }
  R.setScissor(0, 0, W, H); R.setViewport(0, 0, W, H); R.setClearColor(0x000000, 0); R.clear();
  const panel = screen.querySelector('.panel').getBoundingClientRect();
  const lm0 = uni.uLM.value, amb0 = uni.uAmb.value;
  uni.uLM.value = book.lm; uni.uAmb.value = 0.05;
  for (const it of book.items) {
    const rc = it.el.getBoundingClientRect();
    const x0 = Math.max(rc.left, panel.left), y0 = Math.max(rc.top, panel.top), x1 = Math.min(rc.right, panel.right), y1 = Math.min(rc.bottom, panel.bottom);
    if (x1 - x0 < 4 || y1 - y0 < 4 || rc.width < 4) continue;   // 捲到面板外面就不畫
    const m = it.m || (it.m = bookModel(it.spec));
    bookAnimate(m, book.t, dt, it.ph);
    for (const o of book.models.values()) o.r.g.visible = o === m;
    // 鏡頭：看著怪物的中間，慢慢左右繞
    const a = Math.sin(book.t * 0.4 + it.ph) * 0.5, el = 0.16, cam = book.cam;
    cam.aspect = rc.width / rc.height; cam.updateProjectionMatrix();
    cam.position.set(BOOK_X + Math.sin(a) * m.d * Math.cos(el), m.cy + m.d * Math.sin(el), BOOK_Y + Math.cos(a) * m.d * Math.cos(el));
    cam.lookAt(BOOK_X, m.cy, BOOK_Y);
    R.setViewport(rc.left, H - rc.bottom, rc.width, rc.height);
    R.setScissor(x0, H - y1, x1 - x0, y1 - y0);
    R.setClearColor(0x14101b, 1); R.clear();
    R.render(book.scene, book.cam);
    book.stats.rendered++;
  }
  uni.uLM.value = lm0; uni.uAmb.value = amb0;
}
// 圖鑑畫面建好卡片後呼叫：items 是 [{ el: 卡片上放怪物的元素, kind 或 flower }]
function bookShow(items) {
  book.items = items.map(spec => ({ el: spec.el, spec, ph: Math.random() * 10 }));
  book.active = true;
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
  if (isW3()) { syncChests3(t); syncStopEyes(t); }
  syncStun(t);
  syncHpBars();
  syncGhosts();
  syncParticles();
  updateFurniture(t);
  updateAwaken(t, dark);
  updateLightmap(dark);
  updateAtmosphere(dark, t);
  syncTrain3(dt, t, dark);
  updateCamera(dt, t);
  updateViewWeapon();
  updatePlaceGhost();
  renderer.render(scene, camera);
  renderBook(dt);
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
  makeTrainTextures();
  buildHouse();
  buildFurniture();
  buildFlashlight();
  buildWeapons();
  buildExtras();
  glowPts = makePoints(0.07, THREE.AdditiveBlending);
  smokePts = makePoints(0.3, THREE.NormalBlending);
  window.Renderer = { render, resize, setWorld, book: { ok: bookOk, show: bookShow, stats: book.stats } };
  resize();
}
init();
