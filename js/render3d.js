// ===== 在家生存 99 夜 — 3D 畫面（Three.js） =====
// 光照做法：遊戲邏輯本來就用「每個房間各自計算」的光（lightAt），
// 這裡把同樣的光算成一張「光照貼圖」（每格 4×4 像素），所有牆、地板、家具都用它上色。
// 所以畫面上亮的地方＝遊戲判定安全的地方，而且不會有光穿牆的問題。
import * as THREE from '../lib/three.module.js';

const WALL_H = 2.7, EYE = 1.55, LMS = 4;
// 第二世界的天花板比較高（設計師要求：溜滑梯要能玩，站在溜滑梯的平台上才不會撞到天花板）
const CEIL_W2 = 4.6;
const ceilH = () => (isW2() ? CEIL_W2 : isW3() ? CEIL_W3 : isW5() ? 40 : isW4() ? CEIL_W4 : WALL_H);   // 第五世界沒有天花板   // 第三世界的車廂 3.3 公尺、第四世界的賣場 6.2 公尺
let LMW = 0, LMH = 0;   // 光照貼圖的大小（跟著地圖走，見 allocLM）
const SRGB = THREE.SRGBColorSpace;

let renderer, scene, camera, spot, viewFlash, lensMat, placeGhost, strongRing, handCandle = null, poseDrop = 0;
const uni = { uLM: { value: null }, uLMSize: { value: new THREE.Vector2(MAP_W, MAP_H) }, uAmb: { value: 0.012 } };
let lmBytes, lmAcc, texRoom, texDoor, lmTex;
// 光照貼圖的大小跟著地圖走（第三世界的地圖是一列長長的列車）：第一次和換世界時配置
function allocLM() {
  if (LMW === MAP_W * LMS && LMH === MAP_H * LMS) return;
  LMW = MAP_W * LMS; LMH = MAP_H * LMS;
  lmBytes = new Uint8Array(LMW * LMH * 4); lmAcc = new Float32Array(LMW * LMH * 3);
  texRoom = new Array(LMW * LMH).fill(null); texDoor = new Array(LMW * LMH).fill(null);
  if (lmTex) lmTex.dispose();
  lmTex = new THREE.DataTexture(lmBytes, LMW, LMH, THREE.RGBAFormat);
  lmTex.magFilter = lmTex.minFilter = THREE.LinearFilter;
  lmTex.needsUpdate = true;
  uni.uLM.value = lmTex;
  uni.uLMSize.value.set(MAP_W, MAP_H);
}

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
// 一個物件的材質（可能是一個或一組，例如面向月台的牆有六個面）裡自己建的那些
const ownMats = o => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []).filter(m => m.userData.own);
function disposeGroup(g) {
  g.parent && g.parent.remove(g);
  g.traverse(o => {
    for (const m of ownMats(o)) m.dispose();
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
// ---------- 照片貼圖：用 Gemini 生成的寫實材質（原圖在 generated-images/，用 tools/make-photo-tex.py 做成 tex/*.webp） ----------
// 遊戲開始前先載入；載入失敗或太慢（例如舊的離線快取裡沒有）就用程式畫的
const PHOTO_TEX = ['w3-wall', 'w3-ironwall', 'w3-velvet', 'w3-runner', 'w3-carpet', 'w3-tile', 'w3-ceiling', 'w3-iron', 'w3-herringbone', 'w3-concrete',
  'w3-wood', 'w3-leather', 'w3-brass', 'w3-linen', 'w3-station', 'w3-carriage', 'w3-cardoor', 'w3-door', 'w3-roof', 'w3-rug',
  'w3-far', 'w3-mid-plain', 'w3-mid-trees', 'w3-mid-bridge', 'w3-mid-snow', 'w3-mid-city', 'w3-yard', 'w3-timetable', 'w3-poster-bridge', 'w3-poster-snow', 'w3-poster-meadow',
  // 怪物：d-* 是細節紋路（見 withDetail），m-* 是直接拿來用的照片（菇傘、菌褶、菇柄、葵花籽、花瓣、熔岩）
  'd-skin', 'd-birdleg', 'd-cotton', 'd-bone', 'd-steel', 'd-rag', 'd-bark', 'd-moss', 'd-hair', 'd-grass', 'd-fur', 'd-sclera', 'd-slug', 'd-corpse',
  'm-capred', 'm-capk', 'm-gills', 'm-stem', 'm-seeds', 'm-petal', 'm-rock', 'm-lava'];
const photos = {};
function loadPhotos() {
  const all = Promise.all(PHOTO_TEX.map(n => new Promise(res => {
    const im = new Image();
    im.onload = () => { photos[n] = im; res(); };
    im.onerror = () => res();
    im.src = `tex/${n}.webp`;
  })));
  return Promise.race([all, new Promise(res => setTimeout(res, 5000))]);
}
// 有照片就用照片做貼圖，沒有就用程式畫的（fallback）
function photoTex(name, fallback) {
  const im = photos[name];
  if (!im) return fallback();
  const t = new THREE.Texture(im);
  t.colorSpace = SRGB; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
// 家具用的照片材質（胡桃木、皮箱、黃銅、桌布床單）：同一張照片乘上不同的顏色，深淺跟原本的純色一樣；沒有照片就用純色
const photoShared = {}, photoMats = new Map();
function photoMean(name) {
  const im = photos[name];
  if (!im.mean) {
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data, m = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k] / 64 / 255;
    im.mean = new THREE.Color().setRGB(m[0], m[1], m[2], SRGB);
  }
  return im.mean;
}
function photoMat(name, color) {
  if (!photos[name]) return lm(color);
  const key = name + color;
  let m = photoMats.get(key);
  if (!m) {
    const want = new THREE.Color(color), mean = photoMean(name);
    const tint = new THREE.Color(want.r / Math.max(0.02, mean.r), want.g / Math.max(0.02, mean.g), want.b / Math.max(0.02, mean.b));
    m = patchLM(new THREE.MeshLambertMaterial({ map: photoShared[name] || (photoShared[name] = photoTex(name)), color: tint }));
    photoMats.set(key, m);
  }
  return m;
}
// ---------- 怪物的照片材質：形狀、顏色、臉和設計圖上的花紋都不變，只把表面換成真的皮膚、骨頭、布、鐵、毛 ----------
// 細節貼圖（d-*）：照片只留下細部的紋路（平均是灰色），乘兩倍再乘在原本的顏色上。
// 不用 UV，用模型自己的座標從三個方向投影（三向投影）：細長的手腳、壓扁的球都不會把紋路拉長，怪物走路、轉身時紋路也不會滑動。
// scale 是一公尺排幾張，k 是強度（0 不變、1 照片的紋路全部疊上去，大於 1 是再加強對比：皮膚的紋路很淡）
const detailTexs = {};
function withDetail(m, name, scale = 4, k = 1) {
  const im = photos['d-' + name];
  if (!im) return m;
  let t = detailTexs[name];
  if (!t) {
    t = detailTexs[name] = new THREE.Texture(im);
    t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true;
  }
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, rd) => {
    prev.call(m, sh, rd);
    Object.assign(sh.uniforms, { uDt: { value: t }, uDtS: { value: scale }, uDtK: { value: k } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDtP;\nvarying vec3 vDtN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec3 dtS = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
        vDtP = position * dtS; vDtN = normal / dtS;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDtP;\nvarying vec3 vDtN;\nuniform sampler2D uDt;\nuniform float uDtS, uDtK;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 dtW = pow(abs(normalize(vDtN)), vec3(4.0)); dtW /= dtW.x + dtW.y + dtW.z + 1e-5;
        vec3 dtP = vDtP * uDtS;
        vec3 dtC = texture2D(uDt, dtP.zy).rgb * dtW.x + texture2D(uDt, dtP.xz).rgb * dtW.y + texture2D(uDt, dtP.xy).rgb * dtW.z;
        diffuseColor.rgb *= mix(vec3(1.0), dtC * 2.0, uDtK);`);
  };
  m.customProgramCacheKey = () => key + '-dt';
  return m;
}
// 畫布的平均顏色（0～255，照不透明度加權；每 4 個像素取一個就夠準）
function canvasMean(c, w, h) {
  const d = c.getImageData(0, 0, w, h).data, m = [0, 0, 0];
  let a = 0;
  for (let i = 0; i < d.length; i += 16) { const al = d[i + 3]; m[0] += d[i] * al; m[1] += d[i + 1] * al; m[2] += d[i + 2] * al; a += al; }
  return m.map(v => v / Math.max(1, a));
}
// 把畫布的顏色拉回某個平均色（每個顏色各自乘一個倍數，不透明度不變）
function matchMean(c, w, h, m0) {
  const img = c.getImageData(0, 0, w, h), d = img.data, m1 = canvasMean(c, w, h), k = m0.map((v, i) => v / Math.max(1, m1[i]));
  for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, d[i] * k[0]); d[i + 1] = Math.min(255, d[i + 1] * k[1]); d[i + 2] = Math.min(255, d[i + 2] * k[2]); }
  c.putImageData(img, 0, 0);
}
// 把照片畫進程式畫的貼圖（取代原本畫的紋路），再拉回原本的平均色：怪物的顏色跟設計圖一樣，紋路變成照片
function photoInto(tex, name, draw = (c, im, w, h) => c.drawImage(im, 0, 0, w, h)) {
  const im = photos[name];
  if (!im) return;
  const cv = tex.image, c = cv.getContext('2d'), w = cv.width, h = cv.height, m0 = canvasMean(c, w, h);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); draw(c, im, w, h); c.restore();
  matchMean(c, w, h, m0);
  tex.needsUpdate = true;
}
// 在不透明的畫布上疊一層細節紋路（「覆蓋」混合：灰色的地方不變），原本畫的花紋和顏色都留著；n 是橫的排幾張
function overlayDetail(c, name, w, h, n = 1, alpha = 1) {
  const im = photos['d-' + name];
  if (!im) return;
  const s = w / n;
  c.save(); c.globalCompositeOperation = 'overlay'; c.globalAlpha = alpha;
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) c.drawImage(im, x, y, s, s);
  c.restore();
}
// 第三世界的地板換成照片：走道的地毯、景觀車廂的綠地毯、餐車的黑白磁磚、機車室的鐵板、候車室的人字拼、月台的水泥
// 第二個數字是一公尺貼幾張（花紋細的放大成兩公尺一張，遠看才不會糊成雜訊）
const FLOOR_PHOTO = { runner: ['w3-runner', 0.5], carpet3: ['w3-carpet', 1], tile3: ['w3-tile', 0.5], iron: ['w3-iron', 1], wood3: ['w3-herringbone', 0.5], platform: ['w3-concrete', 1], roof: ['w3-roof', 1] };
function shade(hex, v) {
  const n = parseInt(hex.slice(1), 16);
  const c = x => Math.max(0, Math.min(255, x + v)) | 0;
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const floorTexCache = {};
function floorTex(type) {
  if (floorTexCache[type]) return floorTexCache[type];
  const ph = FLOOR_PHOTO[type];
  if (ph && photos[ph[0]]) { const t = photoTex(ph[0]); t.repeat.set(ph[1], ph[1]); return (floorTexCache[type] = t); }
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
      case 'roof': {   // 車頂的鋼板：黑漆、一排排鉚釘、煤灰
        c.fillStyle = '#2b2b2f'; c.fillRect(0, 0, w, h);
        c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1.5; c.strokeRect(0.5, 0.5, w - 1, h - 1);
        for (let i = 4; i < w; i += 8) { c.fillStyle = '#4a4b50'; c.beginPath(); c.arc(i, 4, 1.4, 0, 7); c.fill(); c.beginPath(); c.arc(i, h - 4, 1.4, 0, 7); c.fill(); }
        for (let i = 0; i < 8; i++) { c.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 12, 3 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
        for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(255,255,255,${rnd() * 0.06})`; c.fillRect(rnd() * w, rnd() * h, 2, 1); }
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
  capTex = photoTex('m-capred', () => canvasTex(512, 256, (c) => {
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
  }));
  capTex.wrapT = THREE.ClampToEdgeWrapping;
  // 菇傘下面的菌褶、菇柄（奶油色、有纖維；向日葵和草叢人的莖也拿它染色用）
  gillTex = canvasTex(512, 512, (c) => {
    c.scale(2, 2);
    c.fillStyle = '#6a2a2e'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2; c.strokeStyle = i % 2 ? 'rgba(240,200,190,.55)' : 'rgba(30,5,8,.6)'; c.lineWidth = i % 2 ? 2 : 1.4; c.beginPath(); c.moveTo(128 + Math.cos(a) * 26, 128 + Math.sin(a) * 26); c.lineTo(128 + Math.cos(a) * 130, 128 + Math.sin(a) * 130); c.stroke(); }
  });
  stemTex = canvasTex(512, 512, (c) => {
    c.scale(4, 4);
    const g = c.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, '#f1e9cf'); g.addColorStop(1, '#cdbf96');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) { c.strokeStyle = `rgba(${120 + rnd() * 60 | 0},${100 + rnd() * 50 | 0},60,${0.15 + rnd() * 0.25})`; c.lineWidth = 1 + rnd() * 2; const x = rnd() * 128; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(x + (rnd() - 0.5) * 10, 64, x + (rnd() - 0.5) * 8, 128); c.stroke(); }
    for (let i = 0; i < 25; i++) { c.fillStyle = `rgba(90,60,40,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * 128, rnd() * 128, 2 + rnd() * 6, 1 + rnd() * 3, 0, 0, 7); c.fill(); }
  });
  photoInto(gillTex, 'm-gills'); photoInto(stemTex, 'm-stem');
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
  sunDiscTex = canvasTex(512, 512, (c) => {
    c.scale(2, 2);
    c.fillStyle = '#3a2412'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const a = i * 2.39996, d = 8 + Math.sqrt(i) * 4.2; if (d > 128) break;
      const x = 128 + Math.cos(a) * d, y = 128 + Math.sin(a) * d, sz = 2.6 + d * 0.022;
      c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.ellipse(x + 1, y + 1.2, sz * 1.1, sz * 0.7, a, 0, 7); c.fill();
      c.fillStyle = `rgb(${52 + rnd() * 30 | 0},${34 + rnd() * 20 | 0},${16 + rnd() * 10 | 0})`; c.beginPath(); c.ellipse(x, y, sz * 1.1, sz * 0.7, a, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,220,150,.3)'; c.beginPath(); c.ellipse(x - 0.8, y - 0.8, sz * 0.6, sz * 0.32, a, 0, 7); c.fill();
    }
    if (photos['m-seeds']) { const m0 = canvasMean(c, 512, 512); c.drawImage(photos['m-seeds'], 0, 0, 256, 256); matchMean(c, 512, 512, m0); }
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
  sunPetalTex = canvasTex(128, 256, (c) => {
    c.scale(2, 2);
    const g = c.createLinearGradient(0, 128, 0, 0); g.addColorStop(0, '#8a4a10'); g.addColorStop(0.25, '#d9901e'); g.addColorStop(0.6, '#f3c22e'); g.addColorStop(1, '#e8b43a');
    c.fillStyle = g; c.beginPath(); c.moveTo(32, 126); c.bezierCurveTo(2, 100, 2, 50, 32, 4); c.bezierCurveTo(62, 50, 62, 100, 32, 126); c.fill();
    c.strokeStyle = 'rgba(140,70,10,.55)'; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(32, 126); c.lineTo(32, 8); c.stroke();
    for (let i = 0; i < 6; i++) { const y = 110 - i * 16; c.beginPath(); c.moveTo(32, y); c.quadraticCurveTo(20, y - 12, 10 + i * 2, y - 24); c.moveTo(32, y); c.quadraticCurveTo(44, y - 12, 54 - i * 2, y - 24); c.stroke(); }
    c.globalCompositeOperation = 'source-atop';
    if (photos['m-petal']) { const m0 = canvasMean(c, 128, 256); c.globalAlpha = 0.8; c.drawImage(photos['m-petal'], 0, 0, 64, 128); c.globalAlpha = 1; matchMean(c, 128, 256, m0); }
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
  // 第四世界：隔間牆和柱子沒有天花板，牆上面的天花板要跟旁邊的房間一樣亮（不然天花板上會有一條一條黑色的影子）
  const near4 = (x, y) => { for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const r = inMap(x + dx, y + dy) && roomGrid[y + dy][x + dx]; if (r) return r; } return null; };
  const w4 = isW4();
  for (let ty = 0; ty < LMH; ty++) for (let tx = 0; tx < LMW; tx++) {
    const x = Math.floor(tx / LMS), y = Math.floor(ty / LMS), i = ty * LMW + tx;
    texRoom[i] = roomGrid[y][x] || (isW5() ? ROOMS[0] : w4 && !doorGrid[y][x] ? near4(x, y) : null);   // 第五世界：水上也一樣亮（一整片草原）
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
  // 第五世界：下雨、起霧暗一點；閃電的一瞬間整片草原亮起來；晚上有一點點月光（草原沒有屋頂）
  const amb = isW5() ? 0.95 * day * (rain5() >= 1 ? 0.62 : rain5() > 0 ? 0.8 : fog5() ? 0.88 : 1) + (G.flash5 || 0) * 0.9 + (1 - day) * 0.035 : 0.95 * day;
  const cold = isW3() && G.cold;   // 寒寂之境：偏白偏藍
  const cold4 = isW4() && G.cold;   // 第四世界：日光燈偏白偏冷，寒寂之境更藍
  const w5 = isW5(), tg = isW2() ? 0.95 : cold ? 1.0 : isW3() ? 0.9 : cold4 ? 1.02 : w5 ? 0.98 : isW4() ? 0.99 : 0.97, tb = isW2() ? 1.02 : cold ? 1.08 : isW3() ? 0.74 : cold4 ? 1.12 : w5 ? 0.98 : isW4() ? 1.0 : 0.92; // 第二世界的白天帶一點粉紫色，第三世界偏褐色（像老照片）
  const blood = !!(G.ev && G.ev.blood && G.phase === 'night'), moon = (1 - day) * 0.05;   // 車頂晚上有一點月光（紅月偏紅）
  for (let i = 0, n = LMW * LMH; i < n; i++) {
    const r = texRoom[i];
    const a = r ? amb * (1 - (r.dayDark || 0)) : texDoor[i] ? amb * 0.9 : 0;
    lmAcc[i * 3] = a; lmAcc[i * 3 + 1] = a * tg; lmAcc[i * 3 + 2] = a * tb;
    if (r && r.roof) { lmAcc[i * 3] += moon * (blood ? 1 : 0.5); lmAcc[i * 3 + 1] += moon * (blood ? 0.3 : 0.62); lmAcc[i * 3 + 2] += moon * (blood ? 0.25 : 1); }
  }
  const w4 = isW4();   // 第四世界的光被自己蓋的牆擋住（addLight4）
  for (const L of G.lights) {
    const c = L.color || (L.candle ? [255, 160, 70] : bulbRGB(L.tier));
    const col = [toLin(c[0]), toLin(c[1]), toLin(c[2])];
    const k = L.f * (L.candle ? 0.9 : 0.85 + L.tier * 0.04);
    if (w4) addLight4(L, col, k); else addLight(L.x, L.y, L.r, L.room, col, k);
  }
  // 玩家身邊一點點微光，才不會完全看不到自己腳邊
  if (mode === 'play' && w4) addLight4({ x: G.p.x, y: G.p.y, r: 2.2 }, [0.55, 0.58, 0.7], 0.2);
  else if (mode === 'play') {
    const p = G.p, tx = Math.floor(p.x), ty = Math.floor(p.y);
    const rooms = roomGrid[ty][tx] ? [roomGrid[ty][tx]] : doorGrid[ty][tx] ? doorGrid[ty][tx].rooms : [];
    for (const r of rooms) addLight(p.x, p.y, 2.2, r, [0.55, 0.58, 0.7], 0.2);
  }
  // 跟朋友一起玩：朋友的手電筒照到的地方（syncFriends 算好的）
  if (mode !== 'title') for (const L of friendLights) {
    const col = [toLin(L.col[0]), toLin(L.col[1]), toLin(L.col[2])];
    if (w4) { addLight4(L, col, L.k); continue; }
    const tx = Math.floor(L.x), ty = Math.floor(L.y);
    if (!inMap(tx, ty)) continue;
    for (const r of roomGrid[ty][tx] ? [roomGrid[ty][tx]] : doorGrid[ty][tx] ? doorGrid[ty][tx].rooms : []) addLight(L.x, L.y, L.r, r, col, L.k);
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
function addFloor(x, y, w, h, type, hgt = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  scaleUV(g, w, h);
  const m = new THREE.Mesh(g, floorMat(type));
  m.userData.ownGeo = true;
  m.rotation.x = -Math.PI / 2;
  m.position.set(x + w / 2, hgt, y + h / 2);
  m.receiveShadow = true;
  houseGroup.add(m);
}
const floorMats = {};
function floorMat(type) {
  return floorMats[type] || (floorMats[type] = patchLM(new THREE.MeshLambertMaterial({ map: floorTex(type) })));
}
// 草叢：兩片交叉的草葉（第二世界的花園、第四世界紅月長出來的草）
const tuftGeo = () => geo('tuft', () => {
  const a = new THREE.PlaneGeometry(0.6, 0.42), b = new THREE.PlaneGeometry(0.6, 0.42);
  a.translate(0, 0.21, 0); b.translate(0, 0.21, 0); b.rotateY(Math.PI / 2);
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, new THREE.Float32BufferAttribute([...a.attributes[k].array, ...b.attributes[k].array], a.attributes[k].itemSize));
  const ia = [...a.index.array], ib = [...b.index.array].map(i => i + a.attributes.position.count);
  g.setIndex([...ia, ...ib]);
  return g;
});
// 換世界：拆掉整個房子（地板、牆、家具），用新的世界重新蓋
function setWorld() {
  if (houseGroup) {
    scene.remove(houseGroup);
    houseGroup.traverse(o => {
      if (o.userData.ownGeo) o.geometry.dispose();
      for (const m of ownMats(o)) { for (const t of m.userData.maps || []) t.dispose(); m.dispose(); }
      if (o.isInstancedMesh) o.dispose();
    });
  }
  windows.length = 0; decoFlowers.length = 0;
  frontDoorPanel = null; doorGlow = null; wallEyes = null; flowerEyes = null; ceilMat = null;
  if (backdrop) { disposeGroup(backdrop.g); backdrop = null; }
  doorPanels.clear(); panes3 = []; walnutMat = stationMat = ironMat = wallMat3 = null; stopEyes = null; curtains = []; locoSmoke = null;
  for (const [c, r] of chestMap) { disposeGroup(r.g); chestMap.delete(c); }
  for (const k in furn3d) delete furn3d[k];
  // 第四世界：自己蓋的牆、屋頂、地上的板子、地上一灘一灘的東西、震波（不在房子群組裡，要自己拆）
  for (const m of [wall4Map, roof4Map, loose4Map, ramp4Map]) { for (const r of m.values()) disposeGroup(r.g); m.clear(); }
  for (const k in puddle4) { scene.remove(puddle4[k]); puddle4[k].material.dispose(); puddle4[k].dispose(); delete puddle4[k]; }
  for (const [w, m] of wave4Map) { scene.remove(m); m.material.dispose(); wave4Map.delete(w); }
  panel4 = null; panel4Info = []; grass4Mesh = null;
  sky5 = null; water5 = null; trees5 = null;   // 第五世界的天空、水、樹在房子群組裡，上面已經拆掉了
  allocLM();
  precomputeTexels();
  bookPlace();
  buildHouse();
  buildFurniture();
}
function buildHouse() {
  houseGroup = new THREE.Group(); scene.add(houseGroup);
  if (isW5()) { buildMeadow5(); return; }   // 第五世界：沒有天花板的草原
  if (isW4()) { buildStore4(); return; }   // 第四世界：一整間賣場
  const w2 = isW2(), w3 = isW3();
  for (const r of ROOMS) addFloor(r.x, r.y, r.w, r.h, r.floor, r.roof ? ROOF_H : 0);   // 車頂的地板比較高
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
    const ct = ceil3Tex.clone(); ct.needsUpdate = true;
    cm = patchLM(new THREE.MeshLambertMaterial({ map: ct })); cm.userData.own = true;
  } else cm = lm('#6d6674');
  if (w3) {
    // 第三世界：每個房間各一片天花板（車頂沒有天花板，看得到天空）；車站的屋頂從車頂看得到，上面再蓋一片柏油屋頂
    const top = patchLM(new THREE.MeshLambertMaterial({ map: tarTex })); top.userData.own = true;
    for (const r of ROOMS) {
      if (r.roof || r.open) continue;   // 車頂和露天的月台沒有天花板，看得到藍天白雲
      const g = new THREE.PlaneGeometry(r.w, r.h); scaleUV(g, r.w / 2, r.h / 2);
      const m = new THREE.Mesh(g, cm); m.userData.ownGeo = true; m.rotation.x = Math.PI / 2; m.position.set(r.x + r.w / 2, CEIL_W3, r.y + r.h / 2); houseGroup.add(m);
      if (r.station) { const tp = new THREE.Mesh(g, top); tp.rotation.x = -Math.PI / 2; tp.position.set(r.x + r.w / 2, CEIL_W3 + 0.03, r.y + r.h / 2); houseGroup.add(tp); }
    }
  } else {
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W, MAP_H), cm);
    ceil.userData.ownGeo = true;
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(MAP_W / 2, ceilH(), MAP_H / 2);   // 第二世界的藍天比較高
    houseGroup.add(ceil);
  }

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
  if (w3) { buildTrainWalls(list); buildPosters3(); }   // 第三世界：車廂的壁板、車站的磚牆、車身、真的窗戶、牆上的海報
  else {
    const H = ceilH();   // 第二世界的樹牆跟著天花板一起變高
    const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, H, 1), wallMat, list.length);
    walls.userData.ownGeo = true;
    const mtx = new THREE.Matrix4();
    list.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, H / 2, y + 0.5); walls.setMatrixAt(i, mtx); });
    walls.castShadow = true; walls.receiveShadow = true;
    walls.computeBoundingSphere();
    houseGroup.add(walls);
  }

  // 門楣與門框（第二世界：花拱門；第三世界：深色的木框，加上會滑開的門板）
  const trim = w3 ? lm('#2a1a10') : lm('#4a3a2e'), vine = lm('#4f8a3a');
  const archFlowers = [];
  for (const d of DOORS) {
    const g = new THREE.Group(); g.position.set(d.x, 0, d.y); houseGroup.add(g);
    box(g, 0, 1, 2.15, ceilH(), 0, 1, w3 ? wallMat3(d.x, d.y) : wallMat);
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
  if (w3) { buildBackdrop(); buildStopEyes(); buildRoof3(); return; }
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
  const bg = tuftGeo();
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
  for (const f of FURN) if (!f.held) buildOneFurn(f);
}
// 一件家具（第四世界的家具搬動時會拆掉重建：Renderer.furn4）
function buildOneFurn(f) {
  {
    const g = new THREE.Group(); g.position.set(f.x, floorH(f.x + 0.5, f.y + 0.5), f.y); houseGroup.add(g);   // 車頂上的家具比較高
    const r = { g, top: 0.8 };
    furn3d[f.id] = r;
    const W = f.w, D = f.h, side = f.side || frontSide(f), len = frontLen(f, side);   // 第四世界的家具有自己的方向（可以轉）
    const wood = lm('#8a6a4e'), dark = lm('#2a2226'), knob = lm('#e0c080');
    const w3 = isW3(), cm = c => (w3 ? photoMat('w3-wood', c) : lm(c));   // 第三世界的櫃子是胡桃木照片、黃銅把手
    const cabinet = (h, col) => {
      box(g, 0.04, W - 0.04, 0, h, 0.04, D - 0.04, cm(col));
      const n = Math.max(1, Math.round(len));
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) * len / n;
        fb(g, f, side, (i * len / n) + 0.06, ((i + 1) * len / n) - 0.06, 0.08, h - 0.08, 0.02, 0.05, cm(shade(col, -12)), false);
        fb(g, f, side, u - 0.04, u + 0.04, h * 0.55, h * 0.55 + 0.05, 0, 0.03, w3 ? photoMat('w3-brass', '#b8923a') : knob, false);
      }
      r.top = h;
    };
    if (!meadow5Furniture(f, g, r, W, D) && !gardenFurniture(f, g, r, W, D, side, len, cabinet) && !trainFurniture(f, g, r, W, D, side, len, cabinet) && !store4Furniture(f, g, r, W, D, side, len, cabinet)) switch (f.type) {
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
        const h = { shoecab: 0.9, nightstand: 0.55, dresser: 1.0, filecab: 1.3, toolcab: 1.6, kcab: 0.9 }[f.id.replace(/\d+$/, '')] || 0.9;
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
    if (f.loot && !isW4()) {   // 第四世界不要一團光（設計師：東西就直接是實體，不要只能看光尋找）
      r.glint = ownSprite(glowTex, 0xfff0c0);
      r.glint.scale.setScalar(0.25);
      r.glint.position.set(W / 2, r.top + 0.18, D / 2);
      g.add(r.glint);
    }
    if (isW4()) mergeByMat(g);   // 賣場的家具很多：零件照材質合成幾個網格，平板才跑得動
    if (f.yaw) {
      // 第四世界擺得斜斜的家具（轉 15°、45°）：繞家具的中心轉
      const th = -f.yaw * Math.PI / 180, cx = W / 2, cz = D / 2;
      g.rotation.y = th;
      g.position.x = f.x + cx - (cx * Math.cos(th) + cz * Math.sin(th));
      g.position.z = f.y + cz - (-cx * Math.sin(th) + cz * Math.cos(th));
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
      for (let i = 0; i < 3; i++) cyl(g, 0.4, 0.46, ceilH(), (i + 0.5) * W / 3, 0, D / 2, bark, 12);
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
      cyl(g, 0.45, 0.6, ceilH(), W / 2, 0, D / 2, bark, 12);
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
    case 'slide': { // 沒有人的遊樂場：溜滑梯（可以玩：對著西邊的爬梯按住 E，game.js 的 startSlide）。遮陽棚拉高到 3.3，站在平台上頭才不會撞到
      const red = lm('#e2394a'), yel = lm('#ffd166'), blue = lm('#4da3ff'), metal = lm('#c9ced4');
      box(g, 0.6, 1.6, 1.35, 1.45, 0.8, D - 0.8, yel);
      for (const [x, z] of [[0.65, 0.85], [1.55, 0.85], [0.65, D - 0.85], [1.55, D - 0.85]]) box(g, x - 0.05, x + 0.05, 0, 3.3, z - 0.05, z + 0.05, blue);
      for (const z of [0.85, D - 0.85]) box(g, 0.6, 1.6, 2.2, 2.26, z - 0.03, z + 0.03, metal);   // 平台的扶手
      box(g, 0.55, 1.65, 3.3, 3.4, 0.75, D - 0.75, red);
      for (const z of [0.95, D - 0.95]) limb(g, [0.1, 0, z], [0.6, 1.4, z], 0.035, metal);
      for (let k = 1; k < 6; k++) { const t = k / 6; limb(g, [0.1 + t * 0.5, t * 1.4, 0.95], [0.1 + t * 0.5, t * 1.4, D - 0.95], 0.025, metal); }
      const sl = new THREE.Mesh(BOX, red); sl.scale.set(3.45, 0.06, 0.9); sl.position.set(3.2, 0.78, D / 2); sl.rotation.z = -0.386; sl.castShadow = true; g.add(sl);
      for (const z of [D / 2 - 0.47, D / 2 + 0.47]) { const rl = new THREE.Mesh(BOX, yel); rl.scale.set(3.45, 0.15, 0.05); rl.position.set(3.2, 0.86, z); rl.rotation.z = -0.386; g.add(rl); }
      r.top = 3.4;
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
  if (furn3d.bed && furn3d.bed.hand) {   // 第四世界沒有床底下的手、電話
    furn3d.bed.hand.visible = ev.bedTimer > 0.6;
    if (furn3d.bed.hand.visible) furn3d.bed.hand.position.z = Math.sin(t * 9) * 0.03;
  }
  if (furn3d.phone && furn3d.phone.handset) {
    furn3d.phone.handset.emissive.setRGB(ev.phone > 0 && Math.sin(t * 20) > 0 ? 0.8 : 0, 0, 0);
    furn3d.phone.g.position.x = FURN_BY_ID.phone.x + (ev.phone > 0 ? Math.sin(t * 70) * 0.01 : 0);
  }
  if (furn3d.breaker && furn3d.breaker.led) {
    const led = furn3d.breaker.led.material.color;
    if (G.power) led.set(0x33ff66); else led.set(Math.sin(t * 8) > 0 ? 0xff2020 : 0x220000);
  }
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
  if (isW4()) updateStoreFurniture4(t);
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
    if (!r || !r.glint) continue;   // 第四世界拿在手上的家具沒有模型
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
  const g = new THREE.Group(); g.position.set(o.x + 0.5, floorH(o.x + 0.5, o.y + 0.5), o.y + 0.5); scene.add(g);
  const th = THEME[o.bulb], metal = lm(th.metal), edge = lm(th.edge), metal2 = lm(th.metal, { side: THREE.DoubleSide });
  const bh = bulbPos(o).h;
  const res = { g, bulbs: [], halos: [], spin: null, rays: null, gems: null };
  if (o.bulb === SLIME_TIER) addSlimePuddle(g, o);
  if (o.type === 'socket' && o.room && o.room.open) {
    // 露天的月台：燈座做成鑄鐵燈柱，燈泡吊在彎出來的燈臂下面
    cyl(g, 0.05, 0.07, bh + 0.38, 0.32, 0, 0, edge, 8);
    box(g, -0.02, 0.36, bh + 0.3, bh + 0.36, -0.03, 0.03, edge);
    cyl(g, 0.01, 0.01, 0.2, 0, bh + 0.1, 0, edge, 6);
    cyl(g, 0.07, 0.25, 0.17, 0, bh - 0.02, 0, metal2, 18, true);
    addBulb(res, g, 0, bh - 0.02, 0, o.bulb);
    addDecor(res, g, bh - 0.02, o.bulb, th);
  } else if (o.type === 'socket') {
    cyl(g, 0.16, 0.16, 0.04, 0, ceilH() - 0.04, 0, edge);   // 第二世界的天花板比較高，吊線比較長
    cyl(g, 0.01, 0.01, ceilH() - 0.04 - (bh + 0.1), 0, bh + 0.1, 0, edge, 6);
    cyl(g, 0.07, 0.25, 0.17, 0, bh - 0.02, 0, metal2, 18, true);
    addBulb(res, g, 0, bh - 0.02, 0, o.bulb);
    addDecor(res, g, bh - 0.02, o.bulb, th);
  } else if (o.type === 'desk') {
    cyl(g, 0.12, 0.13, 0.03, 0, 0, 0, edge);
    cyl(g, 0.015, 0.015, 0.4, 0, 0.03, 0, edge, 6);
    cyl(g, 0.06, 0.15, 0.14, 0, 0.44, 0, metal2, 16, true);
    addBulb(res, g, 0, bh, 0, o.bulb, 0.8);
    addDecor(res, g, bh + 0.02, o.bulb, th);
  } else if (o.type === 'tv') {
    // 第四世界的電視（第 6 級以上的燈泡）：黑色矮櫃上一台電視，螢幕亮著燈泡的顏色，就是它的光
    const black = lm('#1c1d20');
    const tv = new THREE.Group(); tv.rotation.y = o.face !== undefined ? Math.PI / 2 - o.face : (o.x * 7 + o.y * 3) % 4 * Math.PI / 2; g.add(tv);
    box(tv, -0.32, 0.32, 0, 0.3, -0.18, 0.18, lm('#3a2e26'));
    box(tv, -0.06, 0.06, 0.3, 0.36, -0.06, 0.06, black);
    box(tv, -0.34, 0.34, 0.36, 0.78, -0.03, 0.03, black);
    const sc = new THREE.Mesh(geo('tvscreen', () => new THREE.PlaneGeometry(0.62, 0.36)), ownBasic({ color: 0xffffff, fog: false, map: tvShowTex(o.bulb) }));
    sc.position.set(0, 0.57, 0.032); tv.add(sc); res.bulbs.push(sc);
    const halo = ownSprite(glowTex, 0xffffff); halo.position.set(0, 0.57, 0.15); halo.scale.set(1.3, 0.9, 1); tv.add(halo); res.halos.push(halo);
  } else if (o.type === 'floor') {
    cyl(g, 0.17, 0.18, 0.04, 0, 0, 0, edge);
    cyl(g, 0.018, 0.018, 1.36, 0, 0.04, 0, edge, 6);
    cyl(g, 0.18, 0.23, 0.32, 0, 1.36, 0, metal2, 20, true);
    addBulb(res, g, 0, bh, 0, o.bulb);
    addDecor(res, g, bh + 0.25, o.bulb, th);
  } else {
    cyl(g, 0.012, 0.012, ceilH() - 2.28, 0, 2.28, 0, edge, 6);
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
      f.g.rotation.z = a; f.g.position.x = o.x + 0.5 + Math.sin(a) * CEIL_W3; f.g.position.y = floorH(o.x + 0.5, o.y + 0.5) + CEIL_W3 * (1 - Math.cos(a));
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
      const g = new THREE.Group(); g.position.set(c.x, floorH(c.x, c.y), c.y); scene.add(g);
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
  overlayDetail(c, 'sclera', W, H, 2, 0.75);   // 照片的眼白：濕濕的表面、細細的微血管
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
  // 照片的細節：皮膚、鳥腳的鱗片、爪子（骨頭）、頭髮
  const skin = withDetail(ownLM('#d8cfc4', { transparent: true }), 'skin', 5, 1.5), leg = withDetail(ownLM('#b8a37e', { transparent: true }), 'birdleg', 14, 1.4), claw = withDetail(ownLM('#3a3230', { transparent: true }), 'bone', 10, 0.7);
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
  const scalp = withDetail(ownLM('#141216', { transparent: true }), 'hair', 4);
  sph(g, 0.16, 0, 1.68, -0.1, scalp, 1, 1.1, 0.75, 12);
  const hairM = withDetail(hairMat(), 'hair', 3, 0.9);
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
  // 照片的細節：皮膚、髒髒的布（白色連身裙）、頭髮
  const skin = withDetail(ownLM('#7d8a94', { transparent: true }), 'skin', 5, 1.4), dress = withDetail(ownLM('#cfcfc6', { transparent: true }), 'rag', 4);
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
  const scalp = withDetail(ownLM('#221f25', { transparent: true }), 'hair', 4);
  sph(r.head, 0.13, 0, 0.064, -0.128, scalp, 1, 1.15, 1, 12);
  sph(r.body, 0.2, 0, 0.5, -0.02, scalp, 0.95, 0.32, 1.5, 12); // 披在肩膀和背上的頭髮底下那一層
  const faceMat = ownLM('#ffffff', { map: crawlerFaceTex, transparent: true, alphaTest: 0.35 });
  r.face = new THREE.Mesh(faceGeo('crawlface2', 0.46, 0.13, 0.16, -0.0126, 0.05), faceMat);
  r.head.add(r.face);
  const hairM = withDetail(hairMat(), 'hair', 3, 0.9);
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
  const stripe = withDetail(ownLM('#ffffff', { map: stripeTex, transparent: true }), 'cotton', 6), white = withDetail(ownLM('#ece8e0', { transparent: true }), 'cotton', 6);
  const black = withDetail(ownLM('#1b1a1d', { transparent: true }), 'cotton', 6), steel = withDetail(ownLM('#c9ced4', { transparent: true }), 'steel', 6);
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
  const gm = withDetail(hairMat(grassStrandTex, 0.6), 'grass', 2.5, 0.8);
  r.tuft = new THREE.Group(); g.add(r.tuft);
  r.tuft.add(new THREE.Mesh(hairGeo('gtuft2', [...grassStrands(44, 0.34, 0.55, 1.05, 0.22, 4401), ...grassStrands(22, 0.2, 0.3, 0.55, 0.1, 4402)]), gm));
  r.grassU = gm.userData.hair;
  r.body = new THREE.Group(); g.add(r.body);
  // 像樹幹的身體（樹皮）、纏著的藤蔓（苔蘚）、鬚根（樹皮）
  const skin = withDetail(ownLM('#a09a72', { map: stemTex, shade: 0.85, transparent: true }), 'bark', 3, 0.9), streak = ownLM('#a4323a', { shade: 0.5, transparent: true });
  const vine = withDetail(ownLM('#3f6a2c', { shade: 0.7, transparent: true }), 'moss', 6, 0.8), root = withDetail(ownLM('#5a4a30', { shade: 0.7, transparent: true }), 'bark', 8);
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
  const hm = withDetail(hairMat(grassStrandTex, 0.6), 'grass', 2.5, 0.8);
  r.body.add(new THREE.Mesh(hairGeo('ghead', grassStrands(26, 0.1, 0.25, 0.45, 0.12, 4403, 1.63, 0.06, 0.6)), hm));
  r.headU = hm.userData.hair;
  r.mats.push(gm, skin, streak, vine, root, faceMat, hm);
}
// 大嘴觸角蟲：粉紅色的大肉團（蛞蝓形、濕濕的皮有皺紋和疙瘩，被手電筒照到會反光）、4 根長著眼睛的觸角、
// 一圈肉唇和上下兩排尖牙的大嘴（3D 的，咬完會一張一合地嚼）、嘴邊兩顆嵌在肉裡的大眼睛、身體下面一排小芽
function buildSnail(r, g) {
  // 照片的細節：濕濕的蛞蝓皮（皺紋和疙瘩照原本畫的）、牙齒（骨頭）
  const skin = withDetail(ownPhong('#ffffff', { map: snailSkinTex, specular: 0x664455, shininess: 22, shade: 0.8, transparent: true }), 'slug', 3, 0.8);
  const skin2 = withDetail(ownPhong('#ffd9e2', { map: snailSkinTex, specular: 0x664455, shininess: 22, shade: 0.8, transparent: true }), 'slug', 3, 0.8);
  const lip = withDetail(ownLM('#b84a62', { shade: 0.8, transparent: true }), 'slug', 5), inner = ownLM('#2a0408', { transparent: true }), tooth = withDetail(ownLM('#efe4cf', { shade: 0.7, transparent: true }), 'bone', 12, 0.7);
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
  const sprout = ownLM('#efe6d6', { shade: 0.6, transparent: true }), stem = withDetail(ownLM('#7a8a6a', { transparent: true }), 'moss', 8, 0.6);
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
  // 照片的細節：衣服、裙子、領子、襪子是棉布，皮膚、樹枝（樹皮）、頭髮
  const cloth = (c, o) => withDetail(ownLM(c, { shade: 0.7, transparent: true, ...o }), 'cotton', 7);
  const top = cloth('#5f7fae', { shade: 0.75 }), skirt = cloth('#ffffff', { map: pleatTex }), skin = withDetail(ownLM('#d8cfc4', { shade: 0.75, transparent: true }), 'skin', 5, 1.3);
  const blood = ownLM('#a3121c', { shade: 0.6, transparent: true }), branch = withDetail(ownLM('#5c3a22', { shade: 0.7, transparent: true }), 'bark', 8), petal = ownLM('#e88aa8', { shade: 0.7, transparent: true });
  const eye = wetEyeMat(flowerEyeTex, 0x2a1a1a, 0x444444, { transparent: true }), white = cloth('#f2efe8', { shade: 0.6 });
  const sock = cloth('#eeeeee'), shoe = ownLM('#222226', { shade: 0.7, transparent: true }), hemM = cloth('#2f3f5c');
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
  const scalp = withDetail(ownLM('#141216', { shade: 0.5, transparent: true }), 'hair', 4);
  sph(g, 0.175, 0, 1.65, -0.03, scalp, 1, 1.05, 1, 14);
  const faceMat = ownLM('#ffffff', { map: girlFaceTex, transparent: true, alphaTest: 0.3, shade: 0.55 });
  r.face = new THREE.Mesh(faceGeo('girlface2', 0.5, 0.13, 0.165, -0.012, 0.07), faceMat);
  r.face.position.set(0, 1.62, 0.1); g.add(r.face);
  r.eye = new THREE.Mesh(geo('geye', () => new THREE.SphereGeometry(0.04, 14, 10)), eye); r.eye.position.set(-0.055, 1.624, 0.146); g.add(r.eye);
  const hairM = withDetail(hairMat(strandTex, 0.5), 'hair', 3, 0.9);
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
const NEW_BUILD = { stick: buildStick, momo: buildMomo, crawler: buildCrawler, balloon: buildBalloon, clown: buildClown, grass: buildGrass, snail: buildSnail, girl: buildGirl,
  kronos: buildKronos, tyrant: buildTyrant, warlord: buildWarlord, taowu: buildTaowu,
  staff: buildStaff, shake: buildShake, mimic: buildMimic, hubert: buildHubert, ember: buildEmber,
  cradle: buildCradle, leak: buildLeak, daydream: buildDaydream, slice: buildSlice, gaze: buildGaze, green: buildGreen, clone: buildClone };

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
      r.g.position.y = floorH(e.x, e.y) + (e.air || 0) * 0.45;
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
      r.g.position.y = floorH(e.x, e.y);
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
      r.g.position.y = floorH(e.x, e.y);
      break;
    }
    case 'kronos': case 'tyrant': case 'warlord': case 'taowu': syncMonster3(e, r, t, p, d, dt); break;
    case 'staff': case 'shake': case 'mimic': case 'hubert': case 'ember': syncMonster4(e, r, t, p, d, dt); break;
    case 'cradle': case 'leak': case 'daydream': case 'slice': case 'gaze': case 'green': case 'clone': syncMonster5(e, r, t, p, d, dt); break;
    case 'girl': {
      // 被手電筒照到時，樹枝上的眼球花會閉起來
      const shut = e.blind > 0 ? 0.15 : 1;
      for (const bl of r.blooms) bl.scale.y += (shut * bl.scale.x - bl.scale.y) * 0.25;
      r.face.rotation.z = e.blind > 0 ? Math.sin(t * 6) * 0.15 : Math.sin(e.wob * 0.9) * 0.06;
      r.g.position.y = floorH(e.x, e.y) + Math.sin(e.wob * 1.5) * 0.03;
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
  const back = new THREE.Mesh(geo('sunback', () => new THREE.CylinderGeometry(0.27, 0.2, 0.08, 20)), withDetail(ownLM('#3f6a2c', { shade: 0.7 }), 'moss', 6, 0.8));
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
  const flesh = withDetail(ownLM('#5a2a26', { shade: 0.85 }), 'slug', 8);
  const rim = new THREE.Mesh(geo('sunrim', () => new THREE.TorusGeometry(0.165, 0.04, 10, 24)), flesh); rim.position.z = 0.04; eyeG.add(rim);
  const eyeMat = wetEyeMat(eyeballTex, 0x1a1414);
  const ball = new THREE.Mesh(geo('suneye', () => new THREE.SphereGeometry(0.19, 24, 16)), eyeMat);
  ball.position.z = 0.02; eyeG.add(ball);
  const irisMat = wetEyeMat(irisTex, 0x141010, 0x777777);
  const iris = new THREE.Mesh(irisGeo('suniris', 0.19, 0.085, 0.02), irisMat);
  eyeG.add(iris);
  const lidMat = withDetail(ownLM('#6a3a30', { shade: 0.9 }), 'slug', 8), lids = [];
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
  const lids = new THREE.InstancedMesh(geo('shlid', () => new THREE.TorusGeometry(0.065, 0.022, 8, 14)), withDetail(ownLM('#7a2028', { shade: 0.8 }), 'slug', 10), N);
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
  const upf = UPG[f.ptype || 'eye'];
  if (upf && upf.flower) return upf.flower.build(f, g);   // 照第五世界的做法重做過的花：UPG.<ptype>.flower = { build(f, g), sync(f, r, t, p, awake) }
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
    const upf = UPG[f.ptype || 'eye'];
    if (upf && upf.flower) { upf.flower.sync(f, r, t, p, awake); return; }
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

// ====================================================================
// 第三世界的 4 隻新怪物（照紙本設計圖做成寫實風，貼圖 512、全部打開自己的明暗）：
// 克羅諾斯・蕈裂、熔岩暴君、墮落戰神、檮杌・九瞳；熔岩暴君走過留下的熔岩
// ====================================================================
let kronosSkinTex, kronosCapTex, kronosFaceTex, rockTex, lavaCrackTex, tyrantFaceTex, cloakTex, bandageTex, skullTex, taowuFurTex, taowuStrandTex, taowuEyeTex;
function makeMonster3Textures() {
  const faceT = draw => { const t = canvasTex(512, 512, c => draw(c, 512)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  kronosFaceTex = faceT((c, S) => drawKronosFace(c, S, true));
  tyrantFaceTex = faceT(drawTyrantFace);
  skullTex = faceT(drawSkullFace);
  // 蕈裂：灰綠色乾裂的屍皮
  kronosSkinTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#5f6e4e'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(${90 + rnd() * 60 | 0},${110 + rnd() * 50 | 0},${70 + rnd() * 30 | 0},.35)`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 4, 2 + rnd() * 4); }
    c.strokeStyle = 'rgba(25,30,20,.7)'; c.lineWidth = 1.5;
    for (let i = 0; i < 60; i++) { let x = rnd() * w, y = rnd() * h; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * 30; y += (rnd() - 0.5) * 30; c.lineTo(x, y); } c.stroke(); }
    for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(40,30,30,${0.15 + rnd() * 0.3})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 10, 2 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
  });
  // 蘑菇傘（半球貼圖）：紫藍色、白斑、從頂上裂開的縫透出紫光；有照片的話紫色菇傘和白斑用照片（兩倍大），裂縫照原本的畫在上面
  const capK = photos['m-capk'];
  kronosCapTex = canvasTex(capK ? 1024 : 512, capK ? 512 : 256, (c, w, h) => {
    if (capK) { c.drawImage(capK, 0, 0, w, h); c.scale(w / 512, h / 256); w = 512; h = 256; }
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#5a3a8c'); g.addColorStop(0.6, '#3e2868'); g.addColorStop(1, '#6a5aa0');
    if (!capK) { c.fillStyle = g; c.fillRect(0, 0, w, h); }
    if (!capK) for (let i = 0; i < 40; i++) { const x = rnd() * w, y = rnd() * h * 0.8, rr = 6 + rnd() * 16; c.fillStyle = 'rgba(40,20,70,.5)'; c.beginPath(); c.ellipse(x + 2, y + 3, rr * 1.2, rr * 0.8, 0, 0, 7); c.fill(); c.fillStyle = `rgba(${225 + rnd() * 25 | 0},${220 + rnd() * 25 | 0},${235 + rnd() * 20 | 0},.9)`; c.beginPath(); c.ellipse(x, y, rr * 1.2, rr * 0.8, 0, 0, 7); c.fill(); }
    c.lineCap = 'round';
    for (let i = 0; i < 5; i++) { const x0 = i / 5 * w + rnd() * 60; c.strokeStyle = 'rgba(200,150,255,.45)'; c.lineWidth = 12; c.beginPath(); c.moveTo(x0, 0); c.lineTo(x0 + (rnd() - 0.5) * 40, 60); c.lineTo(x0 + (rnd() - 0.5) * 60, 150); c.lineTo(x0 + (rnd() - 0.5) * 50, 230); c.stroke(); c.strokeStyle = '#e8c8ff'; c.lineWidth = 4; c.stroke(); }
    if (!capK) for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(20,10,30,${0.1 + rnd() * 0.25})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 6 + rnd() * 20, 3 + rnd() * 10, rnd() * 3, 0, 7); c.fill(); }
  });
  kronosCapTex.wrapT = THREE.ClampToEdgeWrapping;
  // 熔岩暴君：黑色岩塊（diffuse）和縫隙裡的熔岩光（emissiveMap，亮度會呼吸）；有照片就用照片（裂縫抓出來當發光的那張）
  const cracks = [];
  for (let i = 0; i < 26; i++) { let x = rnd() * 512, y = rnd() * 512; const pts = [[x, y]]; for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 90; y += (rnd() - 0.5) * 90; pts.push([x, y]); } cracks.push(pts); }
  const strokeCracks = (c, col, lw) => { c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round'; for (const pts of cracks) { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); } };
  rockTex = photoTex('m-rock', () => canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#17150f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) { const x = rnd() * w, y = rnd() * h, bw = 20 + rnd() * 60, bh = 16 + rnd() * 50; c.fillStyle = `rgb(${22 + rnd() * 26 | 0},${20 + rnd() * 20 | 0},${18 + rnd() * 16 | 0})`; c.beginPath(); c.moveTo(x, y); c.lineTo(x + bw, y + (rnd() - 0.5) * 12); c.lineTo(x + bw + (rnd() - 0.5) * 12, y + bh); c.lineTo(x + (rnd() - 0.5) * 12, y + bh); c.closePath(); c.fill(); c.strokeStyle = 'rgba(80,70,60,.35)'; c.lineWidth = 1; c.stroke(); }
    strokeCracks(c, '#000', 6);
  }));
  lavaCrackTex = photoTex('m-lava', () => canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); strokeCracks(c, 'rgba(255,80,10,.5)', 12); strokeCracks(c, '#ff6a10', 5); strokeCracks(c, '#ffd060', 2); }));
  // 照片的岩塊比較細：繞一圈排兩張，上下一張（球的貼圖是寬的兩倍長），岩塊才不會被拉成長條
  if (photos['m-rock'] && photos['m-lava']) for (const t of [rockTex, lavaCrackTex]) t.repeat.set(2, 1);
  // 墮落戰神的斗篷（一片一片的布，用頭髮的做法）：泛黃的白布、鏽褐色的污漬、下擺破破爛爛；腳上的髒布條
  cloakTex = canvasTex(64, 256, (c, w, h) => {
    c.fillStyle = '#ddd6c6'; c.fillRect(6, 0, w - 12, h);
    for (let i = 0; i < 14; i++) { c.fillStyle = `rgba(110,60,30,${0.15 + rnd() * 0.35})`; c.beginPath(); c.ellipse(rnd() * w, 60 + rnd() * 180, 4 + rnd() * 10, 8 + rnd() * 30, 0, 0, 7); c.fill(); }
    for (let i = 0; i < 20; i++) { c.fillStyle = `rgba(60,55,50,${0.1 + rnd() * 0.2})`; c.fillRect(6 + rnd() * (w - 12), rnd() * h, 2, 10 + rnd() * 40); }
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6; i++) { c.beginPath(); c.moveTo(i * 12, h); c.lineTo(i * 12 + 6, h - 20 - rnd() * 40); c.lineTo(i * 12 + 12, h); c.fill(); }
    for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(10 + rnd() * 44, 100 + rnd() * 120, 2 + rnd() * 4, 0, 7); c.fill(); }
    c.globalCompositeOperation = 'source-over';
  });
  cloakTex.wrapS = cloakTex.wrapT = THREE.ClampToEdgeWrapping;
  bandageTex = canvasTex(64, 64, (c, w, h) => {
    c.fillStyle = '#9a8a6a'; c.fillRect(0, 0, w, h);
    for (let y = -8; y < h + 8; y += 11) { c.fillStyle = shade('#b8a680', (rnd() - 0.5) * 30); c.save(); c.translate(0, y); c.rotate(-0.25); c.fillRect(-10, 0, w + 20, 8); c.restore(); }
    for (let i = 0; i < 12; i++) { c.fillStyle = `rgba(80,40,20,${0.2 + rnd() * 0.3})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 6, 2 + rnd() * 4, 0, 0, 7); c.fill(); }
  });
  // 檮杌：紫黑色的粗毛、鬃毛（一束一束）、紫色瞳孔的眼睛
  taowuFurTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#9c8ab0'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1200; i++) { const x = rnd() * w, y = rnd() * h, g = rnd(); c.strokeStyle = `rgba(${40 + g * 80 | 0},${20 + g * 40 | 0},${70 + g * 100 | 0},.5)`; c.lineWidth = 1 + rnd(); c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 4, y + 6 + rnd() * 10); c.stroke(); }
  });
  taowuStrandTex = canvasTex(64, 256, (c, w, h) => {
    for (let i = 0; i < 120; i++) { const x = 32 + (rnd() + rnd() + rnd() - 1.5) * 38, end = 150 + rnd() * 100, g = rnd(); c.strokeStyle = `rgba(${50 + g * 60 | 0},${20 + g * 30 | 0},${80 + g * 90 | 0},${0.7 + rnd() * 0.3})`; c.lineWidth = 1.5 + rnd() * 2.5; c.beginPath(); c.moveTo(x, 0); c.quadraticCurveTo(x + (rnd() - 0.5) * 10, end * 0.5, x + (rnd() - 0.5) * 14, end); c.stroke(); }
  }, true);
  taowuStrandTex.wrapS = taowuStrandTex.wrapT = THREE.ClampToEdgeWrapping;
  taowuEyeTex = canvasTex(256, 128, (c) => {
    paintEyeball(c, 256, 128);
    c.fillStyle = '#5a2a8c'; c.beginPath(); c.arc(64, 64, 22, 0, 7); c.fill();
    c.strokeStyle = 'rgba(20,5,30,.7)'; c.lineWidth = 2; c.beginPath(); c.arc(64, 64, 21, 0, 7); c.stroke();
    c.fillStyle = '#080410'; c.beginPath(); c.arc(64, 64, 10, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(57, 57, 4, 0, 7); c.fill();
  }, true);
}
// 克羅諾斯・蕈裂：1.5 公尺、駝背的矮人，灰綠色乾裂的屍皮，頭上一頂裂開的紫色蘑菇傘（裂縫透出紫光），
// 肩膀和腰上長著小蘑菇，右手拿骨矛、左手拿一朵小蘑菇，身上是綠色的破布衣。走路一跛一跛
function buildKronos(r, g) {
  // 照片的細節：乾裂的屍皮（原本畫的斑和裂紋留著）、破布、骨頭；小蘑菇用紫色菇傘的照片
  const skin = withDetail(ownLM('#ffffff', { map: kronosSkinTex, shade: 0.8, transparent: true }), 'corpse', 3, 1.2);
  const cloth = withDetail(ownLM('#3f5a2e', { shade: 0.7, transparent: true }), 'rag', 4), bone = withDetail(ownLM('#d8d0b8', { shade: 0.7, transparent: true }), 'bone', 6);
  const cap = ownLM('#ffffff', { map: kronosCapTex, emissive: 0x2a1040, shade: 0.75, transparent: true });
  const small = photos['m-capk'] ? ownLM('#ffffff', { map: photoShared['m-capk'] || (photoShared['m-capk'] = photoTex('m-capk')), shade: 0.7, transparent: true })
    : ownLM('#8a5aa8', { shade: 0.7, transparent: true });
  r.body = new THREE.Group(); g.add(r.body);
  for (const s of [-1, 1]) { taper(r.body, [s * 0.12, 0.55, 0], [s * 0.16, 0.28, 0.06], 0.06, 0.05, skin); taper(r.body, [s * 0.16, 0.28, 0.06], [s * 0.15, 0.03, -0.04], 0.05, 0.04, skin); sph(r.body, 0.07, s * 0.15, 0.03, 0.04, skin, 1.1, 0.5, 1.6, 8); }
  r.torso = new THREE.Group(); r.torso.position.set(0, 0.55, 0); r.torso.rotation.x = 0.55; r.body.add(r.torso);
  sph(r.torso, 0.24, 0, 0.3, -0.02, cloth, 1, 1.3, 0.8, 12);
  sph(r.torso, 0.2, 0, 0.62, -0.12, skin, 1.2, 0.8, 1, 10);
  for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; const strip = box(r.torso, -0.03, 0.03, -0.12, 0.1, -0.01, 0.01, cloth, false); strip.position.set(Math.cos(a) * 0.22, 0, Math.sin(a) * 0.2); strip.rotation.y = -a; }
  r.head = new THREE.Group(); r.head.position.set(0, 0.86, 0.1); r.head.rotation.x = -0.45; r.torso.add(r.head);
  sph(r.head, 0.17, 0, 0, -0.02, skin, 1, 1.1, 1, 12);
  const faceMat = ownLM('#ffffff', { map: kronosFaceTex, transparent: true, alphaTest: 0.3, shade: 0.6 });
  r.face = new THREE.Mesh(faceGeo('kronosface', 0.42, 0.13, 0.16, -0.01, 0.06), faceMat); r.face.position.set(0, -0.01, 0.13); r.head.add(r.face);
  r.cap = new THREE.Mesh(geo('kcap', () => new THREE.SphereGeometry(0.4, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2)), cap);
  r.cap.position.set(0, 0.12, -0.02); r.cap.scale.y = 0.55; r.cap.castShadow = true; r.head.add(r.cap);
  const under = new THREE.Mesh(geo('kunder', () => new THREE.CircleGeometry(0.4, 22)), ownLM('#5a3a7a', { map: gillTex, shade: 0.5, transparent: true })); under.rotation.x = Math.PI / 2; under.position.set(0, 0.115, -0.02); r.head.add(under);
  r.capGlow = ownSprite(glowTex, 0xb070ff); r.capGlow.position.set(0, 0.25, 0); r.capGlow.scale.setScalar(0.5); r.head.add(r.capGlow);
  for (const [x, y, z, s] of [[0.22, 0.75, -0.05, 1], [-0.2, 0.72, 0.02, 0.8], [0.18, 0.2, 0.18, 0.7], [-0.15, 0.15, 0.2, 0.6]]) { cyl(r.torso, 0.012 * s, 0.015 * s, 0.07 * s, x, y, z, bone, 6); sph(r.torso, 0.04 * s, x, y + 0.07 * s, z, small, 1, 0.6, 1, 8); }
  r.armR = new THREE.Group(); r.armR.position.set(0.25, 0.5, 0.05); r.torso.add(r.armR);
  taper(r.armR, [0, 0, 0], [0.1, -0.25, 0.2], 0.045, 0.035, skin); taper(r.armR, [0.1, -0.25, 0.2], [0.05, -0.2, 0.45], 0.035, 0.03, skin);
  r.spear = new THREE.Group(); r.spear.position.set(0.05, -0.2, 0.45); r.armR.add(r.spear);
  const shaft = cyl(r.spear, 0.016, 0.018, 1.7, 0, 0, 0, bone, 7); shaft.rotation.x = Math.PI / 2; shaft.position.set(0, 0, 0.3);
  const tip = new THREE.Mesh(geo('ktip', () => new THREE.ConeGeometry(0.03, 0.22, 6)), bone); tip.rotation.x = Math.PI / 2; tip.position.set(0, 0, 1.25); r.spear.add(tip);
  const armL = new THREE.Group(); armL.position.set(-0.25, 0.5, 0.05); r.torso.add(armL);
  taper(armL, [0, 0, 0], [-0.08, -0.3, 0.12], 0.045, 0.035, skin); taper(armL, [-0.08, -0.3, 0.12], [-0.02, -0.45, 0.3], 0.035, 0.03, skin);
  cyl(armL, 0.012, 0.014, 0.1, -0.02, -0.5, 0.3, bone, 6); sph(armL, 0.055, -0.02, -0.4, 0.3, small, 1, 0.6, 1, 8);
  r.mats.push(skin, cloth, bone, cap, faceMat, small);
}
// 熔岩暴君：2.6 公尺的岩石巨人，全身是冷卻的黑色岩塊，縫隙透出橘紅色的熔岩光（會呼吸），沒有脖子，
// 兇狠的臉陷在肩膀裡，眼睛是兩個熔岩洞；走動時掉火星，被聖水冷卻時全身變黑
function buildTyrant(r, g) {
  const rock = ownLM('#ffffff', { map: rockTex, emissiveMap: lavaCrackTex, emissive: 0xff6a10, shade: 0.85, transparent: true });
  r.rock = rock;
  r.body = new THREE.Group(); g.add(r.body);
  r.legs = [];
  for (const s of [-1, 1]) { const leg = new THREE.Group(); leg.position.set(s * 0.42, 1.1, 0); r.body.add(leg); sph(leg, 0.3, 0, -0.5, 0, rock, 1, 1.5, 1, 10); sph(leg, 0.34, 0, -1.0, 0.08, rock, 1.1, 0.5, 1.4, 10); r.legs.push(leg); }
  sph(r.body, 0.62, 0, 1.55, 0, rock, 1.25, 1.0, 0.9, 14);
  sph(r.body, 0.5, 0, 2.05, -0.05, rock, 1.45, 0.65, 0.9, 12);
  for (let i = 0; i < 8; i++) { const a = i * 2.4; sph(r.body, 0.18 + (i % 3) * 0.06, Math.cos(a) * 0.55, 1.3 + (i % 4) * 0.25, Math.sin(a) * 0.4, rock, 1.2, 0.8, 1, 8); }
  r.head = new THREE.Group(); r.head.position.set(0, 2.2, 0.18); r.body.add(r.head);
  sph(r.head, 0.3, 0, 0, -0.08, rock, 1.1, 0.9, 1, 12);
  const faceMat = ownLM('#ffffff', { map: tyrantFaceTex, emissive: 0x401000, shade: 0.5, transparent: true, alphaTest: 0.3 });
  r.face = new THREE.Mesh(faceGeo('tyrantface', 0.62, 0.2, 0.2, 0, 0.08), faceMat); r.face.position.set(0, -0.02, 0.2); r.head.add(r.face);
  r.eyes = [];
  for (const s of [-1, 1]) { const e = ownSprite(glowTex, 0xffb020); e.position.set(s * 0.1, 0.02, 0.3); e.scale.setScalar(0.16); r.head.add(e); r.eyes.push(e); }
  r.arms = [];
  for (const s of [-1, 1]) { const arm = new THREE.Group(); arm.position.set(s * 0.85, 2.0, 0); r.body.add(arm); sph(arm, 0.24, 0, -0.45, 0.05, rock, 1, 1.6, 1, 10); sph(arm, 0.3, 0, -1.05, 0.15, rock, 1.1, 1, 1.1, 10); arm.rotation.z = s * 0.15; r.arms.push(arm); }
  r.heat = ownSprite(glowTex, 0xff6020); r.heat.position.set(0, 1.5, 0); r.heat.scale.setScalar(2.4); r.body.add(r.heat);
  r.mats.push(rock, faceMat);
}
// 墮落戰神：2.4 公尺，披著破爛的白斗篷（會飄的布片），頭盔上兩根彎角，面罩下是骷髏的臉，胸口的鎧甲破了露出肋骨和
// 空空的胸腔；拖著一把比人還長的大劍（劍尖在地上磨出火花），腳上綁著髒布條。走路很慢、很重
function buildWarlord(r, g) {
  // 照片的細節：骨頭、生鏽刮傷的鐵、髒布條、斗篷的破布
  const bone = withDetail(ownLM('#d8d0bc', { shade: 0.75, transparent: true }), 'bone', 5, 1.4), steel = withDetail(ownPhong('#8a8f96', { specular: 0x666666, shininess: 30, shade: 0.8, transparent: true }), 'steel', 3);
  const dark = ownLM('#0e0c0a', { transparent: true }), bandage = withDetail(ownLM('#ffffff', { map: bandageTex, shade: 0.7, transparent: true }), 'rag', 6), horn = withDetail(ownLM('#aab4bc', { shade: 0.8, transparent: true }), 'bone', 6);
  r.body = new THREE.Group(); g.add(r.body);
  r.legs = [];
  for (const s of [-1, 1]) { const leg = new THREE.Group(); leg.position.set(s * 0.2, 1.15, 0); r.body.add(leg); cyl(leg, 0.09, 0.11, 0.6, 0, -0.6, 0, bandage, 10); cyl(leg, 0.08, 0.1, 0.55, 0, -1.15, 0.02, bandage, 10); box(leg, -0.1, 0.1, -1.15, -1.05, -0.08, 0.2, dark); r.legs.push(leg); }
  cyl(r.body, 0.18, 0.14, 0.2, 0, 1.1, 0, bone, 10);
  cyl(r.body, 0.05, 0.05, 0.75, 0, 1.3, -0.04, bone, 8);
  box(r.body, -0.32, 0.32, 1.35, 2.05, -0.2, 0.04, dark);
  for (let i = 0; i < 5; i++) { const rib = new THREE.Mesh(geo('rib', () => new THREE.TorusGeometry(0.22, 0.018, 6, 14, Math.PI)), bone); rib.position.set(0, 1.5 + i * 0.12, 0); rib.rotation.x = Math.PI / 2; rib.scale.set(1, 0.8, 1); r.body.add(rib); }
  box(r.body, -0.36, 0.36, 2.0, 2.15, -0.22, 0.14, steel); box(r.body, -0.36, -0.26, 1.35, 2.05, -0.22, 0.12, steel); box(r.body, 0.26, 0.36, 1.35, 2.05, -0.22, 0.12, steel);
  for (const s of [-1, 1]) sph(r.body, 0.17, s * 0.4, 2.12, 0, steel, 1.2, 0.7, 1.1, 10);
  r.head = new THREE.Group(); r.head.position.set(0, 2.3, 0.02); r.body.add(r.head);
  sph(r.head, 0.17, 0, 0.02, 0, steel, 1, 1.15, 1, 12);
  for (const s of [-1, 1]) { taper(r.head, [s * 0.12, 0.1, -0.02], [s * 0.28, 0.32, -0.08], 0.035, 0.02, horn); taper(r.head, [s * 0.28, 0.32, -0.08], [s * 0.3, 0.5, 0.04], 0.02, 0.008, horn); }
  const faceMat = ownLM('#ffffff', { map: skullTex, transparent: true, alphaTest: 0.3, shade: 0.6 });
  r.face = new THREE.Mesh(faceGeo('skullface', 0.36, 0.12, 0.14, -0.02, 0.05), faceMat); r.face.position.set(0, -0.04, 0.13); r.head.add(r.face);
  const cm = withDetail(hairMat(cloakTex, 0.6), 'rag', 3), S = [];
  for (let x = -0.34; x <= 0.341; x += 0.06) { const j = Math.sin(x * 50) * 0.5 + 0.5; S.push({ a: [x, 2.1, -0.18], b: [x * 1.2, 1.4, -0.3], c: [x * 1.3, 0.35 + j * 0.3, -0.34], w: 0.1, f: Math.PI, ph: x * 9, tp: 0.2 }); }
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) S.push({ a: [s * 0.36, 2.05, -0.1 + k * 0.08], b: [s * 0.46, 1.4, -0.12 + k * 0.08], c: [s * 0.44, 0.5 + k * 0.15, -0.15 + k * 0.08], w: 0.11, f: s * 1.4, ph: s * 2 + k, tp: 0.25 });
  r.body.add(new THREE.Mesh(hairGeo('cloak', S), cm)); r.hairU = cm.userData.hair;
  r.armR = new THREE.Group(); r.armR.position.set(0.42, 2.0, 0); r.body.add(r.armR);
  cyl(r.armR, 0.05, 0.06, 0.5, 0, -0.28, 0.02, bone, 8); cyl(r.armR, 0.045, 0.05, 0.5, 0.02, -0.75, 0.08, bone, 8);
  r.sword = new THREE.Group(); r.sword.position.set(0.02, -0.98, 0.1); r.armR.add(r.sword);
  cyl(r.sword, 0.03, 0.03, 0.3, 0, 0, 0, dark, 8);
  box(r.sword, -0.16, 0.16, -0.17, -0.13, -0.03, 0.03, steel);
  box(r.sword, -0.07, 0.07, -1.75, -0.17, -0.012, 0.012, steel);
  r.sword.rotation.x = 0.95;   // 劍尖拖在前面的地上
  const armL = new THREE.Group(); armL.position.set(-0.42, 2.0, 0); r.body.add(armL);
  cyl(armL, 0.05, 0.06, 0.5, 0, -0.28, 0.02, bone, 8); cyl(armL, 0.045, 0.05, 0.45, -0.04, -0.72, 0.1, bone, 8);
  r.spark = ownSprite(glowTex, 0xffd080); r.spark.position.set(0, -1.75, 0); r.spark.scale.setScalar(0.25); r.sword.add(r.spark);
  r.mats.push(bone, steel, dark, bandage, horn, faceMat, cm);
}
// 檮杌・九瞳：四腳的巨獸（肩高 2.2 公尺），紫黑色的粗毛、背上一排骨刺、帶刺的尾巴、長爪子；
// 臉上沒有鼻子和嘴，只有一團九顆大小不一的眼睛（紫色瞳孔，各自會轉、會閉），脖子一圈鬃毛
function buildTaowu(r, g) {
  // 照片的細節：粗獸毛（原本畫的紫黑色毛流留著）、骨刺和爪子是骨頭
  const fur = withDetail(ownLM('#ffffff', { map: taowuFurTex, shade: 0.8, transparent: true }), 'fur', 3, 1.1);
  const spine = withDetail(ownLM('#4a2a6e', { shade: 0.7, transparent: true }), 'bone', 6, 0.8), claw = withDetail(ownLM('#2a1a30', { shade: 0.6, transparent: true }), 'bone', 10, 0.7);
  r.body = new THREE.Group(); g.add(r.body);
  sph(r.body, 0.5, 0, 1.3, -0.2, fur, 0.9, 0.85, 1.9, 16);
  sph(r.body, 0.42, 0, 1.4, 0.75, fur, 1.1, 0.95, 0.9, 14);
  r.legs = [];
  for (const [x, z] of [[-0.35, 0.6], [0.35, 0.6], [-0.3, -0.95], [0.3, -0.95]]) {
    const leg = new THREE.Group(); leg.position.set(x, 1.15, z); r.body.add(leg);
    taper(leg, [0, 0, 0], [0, -0.6, 0.05], 0.13, 0.1, fur, 10); taper(leg, [0, -0.6, 0.05], [0, -1.12, -0.05], 0.1, 0.08, fur, 10);
    sph(leg, 0.12, 0, -1.12, 0.02, fur, 1.2, 0.5, 1.4, 8);
    for (let k = -1; k <= 1; k++) { const c = new THREE.Mesh(geo('claw', () => new THREE.ConeGeometry(0.03, 0.14, 6)), claw); c.position.set(k * 0.07, -1.15, 0.18); c.rotation.x = Math.PI / 2; leg.add(c); }
    r.legs.push(leg);
  }
  for (let i = 0; i < 9; i++) { const s = new THREE.Mesh(geo('tspine', () => new THREE.ConeGeometry(0.06, 0.32, 6)), spine); s.position.set(0, 1.68 - Math.abs(i - 3) * 0.04, 0.7 - i * 0.22); s.rotation.x = -0.4; s.scale.setScalar(1 - Math.abs(i - 4) * 0.08); r.body.add(s); }
  r.tail = new THREE.Group(); r.tail.position.set(0, 1.35, -1.15); r.body.add(r.tail);
  taper(r.tail, [0, 0, 0], [0, 0.15, -0.6], 0.09, 0.06, fur); taper(r.tail, [0, 0.15, -0.6], [0, -0.1, -1.2], 0.06, 0.03, fur);
  for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(geo('tspine2', () => new THREE.ConeGeometry(0.035, 0.18, 6)), spine); s.position.set(0, 0.2 - i * 0.05, -0.3 - i * 0.22); s.rotation.x = -0.6; r.tail.add(s); }
  r.head = new THREE.Group(); r.head.position.set(0, 1.55, 1.15); r.body.add(r.head);
  sph(r.head, 0.34, 0, 0, 0, fur, 1, 0.9, 1.1, 14);
  const mm = withDetail(hairMat(taowuStrandTex, 0.6), 'fur', 3);
  r.head.add(new THREE.Mesh(hairGeo('tmane', grassStrands(48, 0.3, 0.3, 0.55, 0.3, 7701, -0.1, -0.25, 0.9)), mm)); r.maneU = mm.userData.hair;
  r.body.add(new THREE.Mesh(hairGeo('tmane2', grassStrands(60, 0.45, 0.25, 0.5, 0.2, 7702, 1.55, 0.3, 0.9)), mm));
  r.eyeMat = wetEyeMat(taowuEyeTex, 0x201030, 0x555555, { transparent: true });
  r.eyes = [];
  for (const [x, y, z, rr] of [[0, 0.02, 0.3, 0.085], [-0.14, 0.08, 0.27, 0.06], [0.15, 0.06, 0.27, 0.065], [-0.08, -0.12, 0.28, 0.055], [0.09, -0.13, 0.28, 0.058], [-0.22, -0.04, 0.22, 0.045], [0.23, -0.02, 0.22, 0.05], [0, -0.2, 0.26, 0.045], [0.01, 0.17, 0.26, 0.04]]) {
    const e = new THREE.Mesh(geo('teye' + rr, () => new THREE.SphereGeometry(rr, 12, 10)), r.eyeMat); e.position.set(x, y, z); r.head.add(e); r.eyes.push(e);
  }
  r.litGlow = ownSprite(glowTex, 0xffffff); r.litGlow.scale.setScalar(0.22); r.litGlow.visible = false; r.head.add(r.litGlow);
  r.mats.push(fur, spine, claw, mm, r.eyeMat);
}
// 面向某個方向（地圖的角度）的 group 旋轉
const faceRot = a => Math.atan2(Math.cos(a), Math.sin(a));
function syncMonster3(e, r, t, p, d, dt) {
  const moving = !e.pose && !(e.stunT > 0) && !(e.cooled > 0);
  switch (e.kind) {
    case 'kronos': {
      const lp = e.limpT || t;
      r.body.position.y = Math.abs(Math.sin(lp * 3.2)) * 0.07 - 0.03; r.body.rotation.z = Math.sin(lp * 3.2) * 0.07;
      const th = e.thrust > 0 ? 1 - e.thrust / 0.5 : 0;
      r.spear.position.z = 0.45 + th * 0.7; r.armR.rotation.x = -th * 0.9;
      r.head.rotation.z = Math.sin(t * 0.8) * 0.08;
      r.capGlow.material.opacity = (0.25 + 0.2 * Math.sin(t * 2.5) + (e.retreat > 0 ? 0.35 : 0)) * enemyAlpha(e);
      break;
    }
    case 'tyrant': {
      const cool = e.cooled > 0, k = cool ? 0 : 0.55 + 0.45 * Math.sin(t * 2.2);
      r.rock.emissive.setRGB(k, k * 0.4, k * 0.06);
      for (const ey of r.eyes) ey.material.opacity = cool ? 0.05 : 0.7 + 0.3 * Math.sin(t * 5);
      r.heat.material.opacity = cool ? 0 : 0.1 + 0.06 * Math.sin(t * 3);
      const w = e.wob * 2.2, st = e.stomp > 0 ? 1 - e.stomp / 0.6 : 0;
      r.legs[0].rotation.x = moving ? Math.sin(w) * 0.3 : 0; r.legs[1].rotation.x = moving ? -Math.sin(w) * 0.3 : 0;
      if (st > 0) { r.legs[1].rotation.x = -1.1 * Math.sin(st * Math.PI); r.body.position.y = 0.15 * Math.sin(st * Math.PI); } else r.body.position.y = moving ? Math.abs(Math.sin(w)) * 0.05 : 0;
      r.body.rotation.z = moving ? Math.sin(w) * 0.04 : 0;
      r.arms[0].rotation.x = moving ? -Math.sin(w) * 0.25 : 0; r.arms[1].rotation.x = moving ? Math.sin(w) * 0.25 : 0;
      break;
    }
    case 'warlord': {
      r.g.rotation.y = faceRot(e.face || 0);
      const w = e.wob * 3.0, mv = moving && e.state !== 'wait';
      r.legs[0].rotation.x = mv ? Math.sin(w) * 0.45 : 0; r.legs[1].rotation.x = mv ? -Math.sin(w) * 0.45 : 0;
      r.body.position.y = mv ? Math.abs(Math.sin(w)) * 0.06 : 0;
      const sw = e.swing > 0 ? 1 - e.swing / 0.6 : 0, cdk = e.cd > 0 && e.swing <= 0 ? clamp(e.cd / 1.2, 0, 1) : 0;
      r.armR.rotation.x = -2.0 * sw - 0.9 * cdk; r.armR.rotation.y = -1.6 * cdk * (1 - cdk);
      r.sword.rotation.x = 0.95 - 1.5 * sw;
      r.spark.material.opacity = mv && e.swing <= 0 ? 0.5 + 0.5 * Math.random() : 0;
      const hu = r.hairU; hu.uHT.value = t; hu.uHAmp.value = 0.02 + (e.state === 'charge' ? 0.03 : 0);
      hu.uHDrag.value.set(spring(r, 'hx', Math.sin(w) * 0.01, dt), spring(r, 'hz', e.state === 'charge' ? -0.12 : -0.03, dt));
      break;
    }
    case 'taowu': {
      if (moving || e.pose) r.g.rotation.y = faceRot(e.face || 0);
      let dy = Math.atan2(p.x - e.x, p.y - e.y) - r.g.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      r.head.rotation.y = clamp(dy, -1.2, 1.2) * (e.blind > 0 ? 0.2 : 1);
      r.head.rotation.x = -0.5 * (e.roar || 0);
      const w = e.wob * 5, mv = moving && !(e.pounce > 0);
      r.legs.forEach((leg, i) => { leg.rotation.x = mv ? Math.sin(w + (i % 2 ? Math.PI : 0) + (i < 2 ? 0 : Math.PI * 0.5)) * 0.45 : 0; });
      r.body.position.y = e.pounce > 0 ? 0.25 : mv ? Math.abs(Math.sin(w)) * 0.04 : 0;
      r.body.rotation.x = e.pounce > 0 ? -0.25 : 0;
      r.tail.rotation.y = Math.sin(t * 2.5) * 0.3;
      const mu = r.maneU; mu.uHT.value = t; mu.uHAmp.value = 0.03 + (e.roar > 0 ? 0.08 : 0);
      const openIdx = e.eyes ? e.eyes.findIndex(x => !x.shut) : -1;
      r.eyes.forEach((ey, i) => {
        const shut = e.blind > 0 || !!(e.eyes && e.eyes[i] && e.eyes[i].shut);
        ey.scale.y += ((shut ? 0.12 : 1) - ey.scale.y) * 0.2;
        ey.rotation.set(Math.sin(t * 1.3 + i) * 0.2, Math.sin(t * 0.9 + i * 2) * 0.3, 0);
      });
      const litEye = e.lit && openIdx >= 0 && !(e.blind > 0) ? r.eyes[openIdx] : null;
      r.litGlow.visible = !!litEye;
      if (litEye) { r.litGlow.position.copy(litEye.position); r.litGlow.position.z += 0.05; r.litGlow.material.opacity = 0.5 + 0.4 * Math.sin(t * 20); }
      r.eyeMat.emissive.setRGB(e.blind > 0 ? 0.05 : 0.15 + 0.1 * Math.sin(t * 3), 0.05, e.blind > 0 ? 0.05 : 0.2);
      r.eyeMat.opacity = enemyAlpha(e);   // syncEnemy 會讓 r.eyes 一閃一閃（那是給發光的眼睛用的），九顆眼球要一直看得清楚
      break;
    }
  }
}
// ====================================================================
// 第四世界的 5 隻新怪物（照設計圖做成寫實風，皮膚、布、塑膠用照片的細節紋路）：
// SCP-3008-2（店員）、葵氏奶昔、紅涎偽人、Hubert、燼皇；還有神秘店員（不是怪物，是賣東西的）
// 臉都是 world4.js 的 2D 畫法畫成貼圖（驚嚇畫面、圖鑑縮圖也用同一張）
// ====================================================================
let staffShirtTex, staffFaceTex, mimicFaceTex, emberFaceTex, clerkFaceTex, shakeFrontTex, shakeIrisTex, cartonTex, emberCapeTex, clerkRobeTex, mimicSkinTex, emberSkinTex, emberWingTex;
function makeMonster4Textures() {
  if (staffShirtTex) return;
  const faceT = (draw, S = 512) => { const t = canvasTex(S, S, c => draw(c, S)); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  staffFaceTex = faceT(drawStaffFace); mimicFaceTex = faceT(drawMimicFace); emberFaceTex = faceT(drawEmberFace); clerkFaceTex = faceT(drawClerkFace, 256);
  shakeFrontTex = faceT((c, S) => drawShakeFront(c, S, 1, true), 512);   // 只有眼窩：眼球和眼皮是 3D 的
  // 葵氏奶昔的虹膜：淡褐色帶一點綠（照設計圖），一絲一絲的紋路、黑色的瞳孔、反光
  shakeIrisTex = canvasTex(256, 256, c => {
    const g = c.createRadialGradient(128, 128, 30, 128, 128, 124); g.addColorStop(0, '#6a4a1c'); g.addColorStop(0.45, '#9a7a3a'); g.addColorStop(0.8, '#6a7a4a'); g.addColorStop(1, '#2a2416');
    c.fillStyle = g; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.lineWidth = 2;
    for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2 + rnd() * 0.03; c.strokeStyle = `rgba(${rnd() < 0.5 ? '40,26,8' : '200,170,100'},${0.25 + rnd() * 0.3})`; c.beginPath(); c.moveTo(128 + Math.cos(a) * 46, 128 + Math.sin(a) * 46); c.lineTo(128 + Math.cos(a) * (100 + rnd() * 22), 128 + Math.sin(a) * (100 + rnd() * 22)); c.stroke(); }
    c.strokeStyle = '#1a140a'; c.lineWidth = 8; c.beginPath(); c.arc(128, 128, 120, 0, 7); c.stroke();
    c.fillStyle = '#050302'; c.beginPath(); c.arc(128, 128, 44, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(98, 96, 15, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.arc(156, 160, 7, 0, 7); c.fill();
  });
  // 店員的制服（照設計圖）：黃色的布、一條一條粗的紫色直條紋，洗舊的皺褶和污漬
  staffShirtTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#e8b524'; c.fillRect(0, 0, w, h);
    for (let x = 10; x < w; x += 36) { c.fillStyle = '#7a3aa8'; c.fillRect(x, 0, 9, h); c.fillStyle = 'rgba(70,30,110,.5)'; c.fillRect(x + 9, 0, 2, h); }
    for (let i = 0; i < 900; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '255,240,180' : '90,60,10'},${0.04 + rnd() * 0.07})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 3); }
    for (let i = 0; i < 14; i++) { c.strokeStyle = `rgba(80,55,10,${0.1 + rnd() * 0.12})`; c.lineWidth = 2 + rnd() * 4; c.beginPath(); const x = rnd() * w, y = rnd() * h; c.moveTo(x, y); c.quadraticCurveTo(x + (rnd() - 0.5) * 40, y + 30, x + (rnd() - 0.5) * 30, y + 60 + rnd() * 40); c.stroke(); }
  });
  // 奶昔紙盒的側面（照設計圖）：米白色的紙板，上下各兩條紅色的橫條紋，受潮的污漬
  cartonTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#f2ebe0'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(${150 + rnd() * 60 | 0},${140 + rnd() * 50 | 0},${110 + rnd() * 40 | 0},${0.04 + rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 5, 1 + rnd() * 5); }
    c.fillStyle = '#d24a52'; for (const y of [14, 36, 206, 228]) c.fillRect(0, y, w, 10);
    for (let i = 0; i < 4; i++) { c.fillStyle = `rgba(150,120,70,${0.08 + rnd() * 0.1})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 14 + rnd() * 30, 8 + rnd() * 20, rnd() * 3, 0, 7); c.fill(); }
  });
  // 紅涎偽人的皮膚（照設計圖）：灰白色，整身爬滿一道一道龜裂的紋路
  mimicSkinTex = canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#b8b2aa'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 1600; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '230,226,220' : '80,74,70'},${0.05 + rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 1 + rnd() * 4); }
    c.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      let x = rnd() * w, y = rnd() * h;
      c.strokeStyle = `rgba(${50 + rnd() * 30 | 0},${44 + rnd() * 20 | 0},${44 + rnd() * 20 | 0},${0.5 + rnd() * 0.4})`; c.lineWidth = 0.8 + rnd() * 2.2;
      c.beginPath(); c.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 60; y += (rnd() - 0.5) * 60; c.lineTo(x, y); if (rnd() < 0.3) { c.moveTo(x, y); } }
      c.stroke();
    }
  });
  mimicSkinTex.wrapS = mimicSkinTex.wrapT = THREE.RepeatWrapping;
  // 燼皇的身體（照設計圖）：蒼白、剝了皮一樣，一條一條紅色的肌肉紋路
  emberSkinTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#d8c4bc'; c.fillRect(0, 0, w, h);
    c.lineCap = 'round';
    for (let i = 0; i < 70; i++) { const x = rnd() * w; c.strokeStyle = `rgba(${150 + rnd() * 80 | 0},${10 + rnd() * 30 | 0},${20 + rnd() * 20 | 0},${0.4 + rnd() * 0.5})`; c.lineWidth = 1 + rnd() * 3; c.beginPath(); c.moveTo(x, rnd() * h * 0.3); c.bezierCurveTo(x + (rnd() - 0.5) * 30, h * 0.4, x + (rnd() - 0.5) * 30, h * 0.7, x + (rnd() - 0.5) * 20, h); c.stroke(); }
    for (let i = 0; i < 600; i++) { c.fillStyle = `rgba(120,30,30,${0.04 + rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 2, 2); }
  });
  emberSkinTex.wrapS = emberSkinTex.wrapT = THREE.RepeatWrapping;
  // 燼皇的翅膀披風（照設計圖）：從手臂張開到地上的大片紅色薄膜，上緣是黑色的骨架，下半部燒成橘黃色的火
  emberWingTex = canvasTex(256, 512, (c, w, h) => {
    c.beginPath(); c.moveTo(0, 30); c.lineTo(w * 0.95, 0);
    for (let k = 0; k < 5; k++) { const y0 = h * (0.15 + k * 0.17); c.quadraticCurveTo(w * (0.75 - k * 0.04), y0 + 30, w * (0.92 - k * 0.05), y0 + h * 0.17); }
    c.lineTo(w * 0.55, h); c.lineTo(0, h); c.closePath();
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1a0204'); g.addColorStop(0.08, '#8a0a12'); g.addColorStop(0.45, '#c8141c'); g.addColorStop(0.62, '#d82a14'); g.addColorStop(0.75, '#ff6a14'); g.addColorStop(0.9, '#ffb02a'); g.addColorStop(1, '#ffe070');
    c.fillStyle = g; c.fill();
    c.save(); c.clip();
    for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(20,0,0,${0.15 + rnd() * 0.25})`; c.lineWidth = 1 + rnd() * 2; c.beginPath(); const x = rnd() * w; c.moveTo(x, 0); c.lineTo(x + (rnd() - 0.5) * 60, h * 0.6); c.stroke(); }
    // 下擺的火舌
    for (let i = 0; i < 14; i++) { const x = rnd() * w * 0.9, y = h * (0.62 + rnd() * 0.3); c.fillStyle = rnd() < 0.5 ? 'rgba(255,230,120,.7)' : 'rgba(255,120,30,.6)'; c.beginPath(); c.moveTo(x - 10, y + 40); c.quadraticCurveTo(x - 6, y, x, y - 40 - rnd() * 40); c.quadraticCurveTo(x + 6, y, x + 10, y + 40); c.fill(); }
    c.restore();
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(30 + rnd() * 160, 60 + rnd() * 280, 3 + rnd() * 7, 0, 7); c.fill(); }
    for (let i = 0; i < 9; i++) { const x = i * 16; c.beginPath(); c.moveTo(x, h); c.lineTo(x + 8, h - 20 - rnd() * 40); c.lineTo(x + 16, h); c.fill(); }
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = '#120002'; c.lineWidth = 7; c.beginPath(); c.moveTo(0, 30); c.lineTo(w * 0.95, 2); c.stroke();
  });
  // 神秘店員的黃色破斗篷（照設計圖）：土黃色的破布、補丁、髒污
  clerkRobeTex = canvasTex(128, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#d8a828'); g.addColorStop(1, '#a87818'); c.fillStyle = g; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 600; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '255,230,150' : '90,60,10'},${0.05 + rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 4); }
    for (let i = 0; i < 16; i++) { c.strokeStyle = `rgba(90,60,10,${0.2 + rnd() * 0.2})`; c.lineWidth = 1 + rnd() * 2; c.beginPath(); const x = rnd() * w; c.moveTo(x, rnd() * h * 0.5); c.lineTo(x + (rnd() - 0.5) * 20, h); c.stroke(); }
    c.fillStyle = 'rgba(150,110,40,.6)'; c.fillRect(70, 120, 30, 26); c.strokeStyle = 'rgba(60,40,10,.6)'; c.setLineDash([3, 3]); c.strokeRect(70, 120, 30, 26); c.setLineDash([]);
  });
}
// SCP-3008-2（照設計圖）：白色的骷髏頭、又大又黑的眼窩、紅色的嘴唇；脖子露出一節一節的脊椎；
// 黃底粗紫直條紋的制服、胸前綠色的「3008」名牌、白色的手臂、藍色長褲、白色的鞋子
function buildStaff(r, g) {
  makeMonster4Textures();
  const shirt = withDetail(ownLM('#ffffff', { map: staffShirtTex, shade: 0.7, transparent: true }), 'cotton', 4, 0.8);
  const pants = withDetail(ownLM('#2a44b0', { shade: 0.7, transparent: true }), 'cotton', 5, 0.9);
  const bone = withDetail(ownLM('#f0ebe0', { shade: 0.7, transparent: true }), 'bone', 6, 0.9);
  const arm = withDetail(ownLM('#ece4d4', { shade: 0.75, transparent: true }), 'skin', 6, 0.9);
  const shoe = ownLM('#e8e8e4', { shade: 0.6, transparent: true }), sole = ownLM('#9a9a98', { transparent: true });
  const badge = ownLM('#3a9a3a', { transparent: true }), badgeTx = ownBasic({ map: sign4Tex('3008', '#e8c23a'), transparent: true });
  r.body = new THREE.Group(); g.add(r.body);
  r.legs = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(s * 0.12, 1.0, 0); r.body.add(leg);
    taper(leg, [0, 0, 0], [0, -0.48, 0.01], 0.095, 0.085, pants, 10);
    taper(leg, [0, -0.48, 0.01], [0, -0.9, -0.01], 0.085, 0.075, pants, 10);
    box(leg, -0.075, 0.075, -1.0, -0.88, -0.09, 0.17, shoe); box(leg, -0.08, 0.08, -1.0, -0.97, -0.1, 0.18, sole);
    r.legs.push(leg);
  }
  cyl(r.body, 0.21, 0.2, 0.16, 0, 0.94, 0, pants, 14).scale.z = 0.7;
  // 方方的上衣（設計圖的店員比較壯）
  const torso = cyl(r.body, 0.25, 0.22, 0.66, 0, 1.08, 0, shirt, 16); torso.scale.z = 0.62;
  sph(r.body, 0.25, 0, 1.72, 0, shirt, 1.05, 0.3, 0.62, 14);
  // 胸前的綠色橢圓名牌
  const bd = cyl(r.body, 0.075, 0.075, 0.012, 0.1, 1.5, 0.155, badge, 16); bd.rotation.x = Math.PI / 2; bd.scale.set(1.3, 1, 0.75);
  const bt = new THREE.Mesh(geo('badge4', () => new THREE.PlaneGeometry(0.15, 0.06)), badgeTx); bt.position.set(0.1, 1.5, 0.163); r.body.add(bt);
  // 一節一節的脊椎（脖子）
  for (let i = 0; i < 4; i++) cyl(r.body, 0.042, 0.048, 0.035, 0, 1.76 + i * 0.05, -0.01, bone, 10);
  r.head = new THREE.Group(); r.head.position.set(0, 1.98, 0); r.body.add(r.head);
  sph(r.head, 0.15, 0, 0.12, -0.01, bone, 1.0, 1.15, 1.0, 16);
  sph(r.head, 0.1, 0, 0.0, 0.03, bone, 0.95, 0.6, 0.85, 12);   // 下巴
  const faceMat = ownLM('#ffffff', { map: staffFaceTex, transparent: true, alphaTest: 0.3, shade: 0.5 });
  r.face = new THREE.Mesh(faceGeo('staffface2', 0.36, 0.13, 0.16, 0.0, 0.06), faceMat); r.face.position.set(0, 0.1, 0.09); r.head.add(r.face);
  r.arms = [];
  for (const s of [-1, 1]) {
    const a = new THREE.Group(); a.position.set(s * 0.28, 1.66, 0); r.body.add(a);
    taper(a, [0, 0, 0], [s * 0.04, -0.2, 0], 0.08, 0.075, shirt, 10);   // 短袖
    taper(a, [s * 0.03, -0.16, 0], [s * 0.05, -0.5, 0.02], 0.055, 0.05, arm, 10);
    taper(a, [s * 0.05, -0.5, 0.02], [s * 0.06, -0.82, 0.05], 0.05, 0.042, arm, 10);
    sph(a, 0.055, s * 0.06, -0.87, 0.05, arm, 0.8, 1.2, 0.6, 8);
    r.arms.push(a);
  }
  r.mats.push(shirt, pants, bone, arm, shoe, sole, badge, badgeTx, faceMat);
}
// 葵氏奶昔（照設計圖）：一盒 50 公分高的屋頂形紙盒，米白色、上下各兩條紅條紋，盒頂插著一根白吸管；
// 正面嵌著一顆真的人眼（設計師：眼睛要畫出來！）：立體的眼球（眼白有血絲、淡褐色的虹膜、黑瞳孔）、上下肉色的眼皮。
// 平常站在地上，眼皮半閉、偶爾眨眼；醒過來眼睛睜得很大，一直盯著你
const _shakeV = new THREE.Vector3();
function buildShake(r, g) {
  makeMonster4Textures();
  const side = ownLM('#ffffff', { map: cartonTex, shade: 0.5, transparent: true }), top = ownLM('#f2ebe0', { shade: 0.5, transparent: true });
  r.front = ownLM('#ffffff', { map: shakeFrontTex, shade: 0.4, transparent: true });
  const straw = ownLM('#f4f4f2', { transparent: true });
  const W = 0.32, H = 0.5;
  r.body = new THREE.Group(); g.add(r.body);
  r.carton = new THREE.Group(); r.body.add(r.carton);
  const m = new THREE.Mesh(geo('carton4b', () => new THREE.BoxGeometry(W, H, W)), [side, side, top, top, r.front, side]);
  m.position.y = H / 2; r.carton.add(m);
  const roof = new THREE.Mesh(geo('cartonroof4b', () => {
    const s = new THREE.Shape(); s.moveTo(-W / 2, 0); s.lineTo(W / 2, 0); s.lineTo(0, 0.12); s.closePath();
    const gg = new THREE.ExtrudeGeometry(s, { depth: W, bevelEnabled: false }); gg.translate(0, 0, -W / 2); gg.rotateY(Math.PI / 2); return gg;
  }), side);
  roof.position.y = H; r.carton.add(roof);
  box(r.carton, -W / 2, W / 2, H + 0.11, H + 0.17, -0.01, 0.01, top);
  const st = cyl(r.carton, 0.009, 0.009, 0.26, 0, 0, 0, straw, 8); st.position.set(0.05, H + 0.16, 0.04); st.rotation.z = -0.15;
  // 眼睛：眼球（往外凸一點）、虹膜、上下眼皮；eyeG 轉向看的方向，眼皮另外開闔
  const R = 0.084, eyeMat = wetEyeMat(eyeballTex, 0x241818, 0x666666, { transparent: true }), irisMat = wetEyeMat(shakeIrisTex, 0x18120a, 0x888888, { transparent: true });
  const lidMat = withDetail(ownLM('#c8907c', { shade: 0.6, transparent: true }), 'skin', 10, 1.1);
  const socket = new THREE.Group(); socket.position.set(0, H * 0.488, W / 2 - R * 0.35); socket.scale.set(1.12, 0.92, 0.75); r.carton.add(socket);
  r.eyeG = new THREE.Group(); r.eyeG.rotation.order = 'YXZ'; socket.add(r.eyeG);
  r.eyeG.add(new THREE.Mesh(geo('shakeball', () => new THREE.SphereGeometry(R, 24, 16)), eyeMat));
  r.eyeG.add(new THREE.Mesh(irisGeo('shakeiris', R, R * 0.48, 0), irisMat));
  r.lids = [1, -1].map(s => { const l = new THREE.Mesh(lidGeo('shakelid', R * 1.08, 0, 1.15), lidMat); l.scale.y = s; socket.add(l); return l; });
  r.eyeMat = eyeMat;
  r.mats.push(side, top, r.front, straw, eyeMat, irisMat, lidMat);
}
// 紅涎偽人（照設計圖）：灰白色、皮包骨的人形，全身爬滿龜裂的紋路；大頭、瞪得很大的眼睛，
// 紅色的涎液從頭頂一道一道流過臉、從嘴巴一路流到胸口；細長的手臂往兩邊張開，長腿
function buildMimic(r, g) {
  makeMonster4Textures();
  const skin = withDetail(ownLM('#ffffff', { map: mimicSkinTex, shade: 0.75, transparent: true }), 'corpse', 5, 0.8);
  const drool = ownPhong('#a00a14', { specular: 0xffaaaa, shininess: 90, emissive: 0x200000, transparent: true, shade: 0.4 });
  r.hip = new THREE.Group(); r.hip.position.y = 1.02; g.add(r.hip);
  r.legs = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(s * 0.1, 0, 0); r.hip.add(leg);
    taper(leg, [0, 0, 0], [s * 0.03, -0.52, 0.03], 0.055, 0.04, skin, 8);
    sph(leg, 0.042, s * 0.03, -0.53, 0.03, skin, 1, 1, 1, 8);
    taper(leg, [s * 0.03, -0.53, 0.03], [s * 0.05, -0.98, -0.02], 0.038, 0.028, skin, 8);
    box(leg, s * 0.05 - 0.035, s * 0.05 + 0.035, -1.02, -0.98, -0.05, 0.13, skin);
    r.legs.push(leg);
  }
  r.torso = new THREE.Group(); r.hip.add(r.torso);
  const pel = sph(r.torso, 0.13, 0, 0.02, 0, skin, 1.0, 0.6, 0.7, 12); void pel;
  const ch = cyl(r.torso, 0.15, 0.09, 0.56, 0, 0.02, 0, skin, 12); ch.scale.z = 0.55;   // 凹進去的肚子、突出的胸廓
  for (let i = 0; i < 5; i++) { const rib = new THREE.Mesh(geo('mrib4', () => new THREE.TorusGeometry(0.13, 0.012, 5, 12, Math.PI)), skin); rib.position.set(0, 0.26 + i * 0.065, 0.03); rib.rotation.x = Math.PI / 2; rib.scale.set(1.05 - i * 0.02, 0.6, 1); r.torso.add(rib); }
  cyl(r.torso, 0.035, 0.045, 0.18, 0, 0.56, 0.01, skin, 8);
  // 從嘴巴一路流到胸口的紅涎（垂在胸前）
  for (const [x, len] of [[-0.03, 0.3], [0.015, 0.42], [0.05, 0.26]]) taper(r.torso, [x, 0.6, 0.11], [x * 1.3, 0.6 - len, 0.13], 0.016, 0.008, drool, 5);
  r.head = new THREE.Group(); r.head.position.set(0, 0.92, 0.03); r.torso.add(r.head);
  sph(r.head, 0.2, 0, 0, -0.03, skin, 0.95, 1.18, 0.95, 16);
  const faceMat = ownLM('#ffffff', { map: mimicFaceTex, transparent: true, alphaTest: 0.3, shade: 0.5 });
  r.face = new THREE.Mesh(faceGeo('mimicface2', 0.52, 0.19, 0.235, 0.015, 0.09), faceMat); r.face.position.set(0, -0.01, 0.08); r.head.add(r.face);
  // 頭頂往下流過臉的紅色涎液畫在臉的貼圖上；從嘴巴垂下來的幾條是真的（會晃）
  r.drool = [];
  for (const [x, len] of [[-0.04, 0.3], [0.02, 0.44], [0.07, 0.26]]) { const d = taper(r.head, [x, -0.12, 0.16], [x * 1.1, -0.12 - len, 0.15], 0.01, 0.004, drool, 5); r.drool.push(d); }
  r.arms = [];
  for (const s of [-1, 1]) {
    const a = new THREE.Group(); a.position.set(s * 0.16, 0.5, 0); r.torso.add(a);
    taper(a, [0, 0, 0], [s * 0.06, -0.45, 0.02], 0.04, 0.03, skin, 8);
    sph(a, 0.032, s * 0.06, -0.46, 0.02, skin, 1, 1, 1, 8);
    taper(a, [s * 0.06, -0.46, 0.02], [s * 0.08, -0.92, 0.06], 0.03, 0.022, skin, 8);
    for (let k = -1; k <= 1; k++) taper(a, [s * 0.08 + k * 0.012, -0.92, 0.06], [s * 0.08 + k * 0.03, -1.1, 0.1], 0.007, 0.003, skin, 5);
    r.arms.push(a);
  }
  r.mats.push(skin, drool, faceMat);
}
// Hubert（照設計圖和設計師說的）：牠是一隻蜘蛛，不是假人——黑色、胖胖的大圓肚子，上面一顆小圓頭，
// 八隻粗粗的圓柱腳，一隻前腳抓著一根鐵管；底下透著紅光
function buildHubert(r, g) {
  const shell = withDetail(ownPhong('#18181b', { specular: 0x777780, shininess: 55, shade: 0.85, transparent: true }), 'steel', 2, 0.35);
  const leg = withDetail(ownPhong('#202024', { specular: 0x555560, shininess: 40, shade: 0.8, transparent: true }), 'steel', 4, 0.4);
  const eye = ownPhong('#3a0608', { specular: 0xff8080, shininess: 120, emissive: 0x2a0000, transparent: true });
  const pipeM = withDetail(ownPhong('#5a5d62', { specular: 0x888888, shininess: 60, shade: 0.8, transparent: true }), 'steel', 4, 0.8);
  r.body = new THREE.Group(); g.add(r.body);
  sph(r.body, 0.56, 0, 1.0, -0.05, shell, 1.0, 0.95, 1.05, 22);   // 胖胖的大肚子
  sph(r.body, 0.17, -0.18, 1.22, 0.42, ownBasic({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false }), 1, 1, 0.3, 10);   // 肚子上的反光
  cyl(r.body, 0.08, 0.1, 0.16, 0, 1.52, 0.05, shell, 12);
  r.head = new THREE.Group(); r.head.position.set(0, 1.78, 0.08); r.body.add(r.head);
  sph(r.head, 0.24, 0, 0, 0, shell, 1, 0.95, 1, 18);
  // 蜘蛛的眼睛：前面一小群濕亮的暗紅色眼睛
  for (const [x, y, s] of [[-0.06, 0.03, 0.035], [0.06, 0.03, 0.035], [-0.12, 0.07, 0.022], [0.12, 0.07, 0.022], [-0.03, 0.1, 0.02], [0.03, 0.1, 0.02], [-0.15, 0.0, 0.016], [0.15, 0.0, 0.016]]) sph(r.head, s, x, y, 0.22 - Math.abs(x) * 0.4, eye, 1, 1, 0.6, 8);
  // 八隻腳：從肚子的腰上往外伸、膝蓋拱起來、腳尖踩在地上
  r.legs = [];
  for (let i = 0; i < 8; i++) {
    const side = i < 4 ? -1 : 1, k = i % 4, a = side * (0.42 + k * 0.76);   // 左右各四隻，從前面排到後面
    const lg = new THREE.Group(); lg.position.set(Math.sin(a) * 0.45, 0.95, Math.cos(a) * 0.45); lg.rotation.y = a; r.body.add(lg);
    taper(lg, [0, 0, 0], [0, 0.3, 0.42], 0.11, 0.1, leg, 12);   // 粗粗的圓柱腳（照設計圖）
    sph(lg, 0.105, 0, 0.3, 0.42, leg, 1, 1, 1, 10);
    taper(lg, [0, 0.3, 0.42], [0, -0.95, 0.72], 0.1, 0.085, leg, 12);
    sph(lg, 0.088, 0, -0.95, 0.72, leg, 1, 0.6, 1, 8);
    r.legs.push(lg);
  }
  // 抓著鐵管的前腳（設計圖右邊那根圓柱）
  r.armR = new THREE.Group(); r.armR.position.set(0.4, 1.25, 0.32); r.body.add(r.armR);
  taper(r.armR, [0, 0, 0], [0.28, 0.05, 0.12], 0.075, 0.065, leg, 10); sph(r.armR, 0.07, 0.28, 0.05, 0.12, leg, 1, 1, 1, 10);
  r.pipe = new THREE.Group(); r.pipe.position.set(0.3, 0.05, 0.14); r.armR.add(r.pipe);
  cyl(r.pipe, 0.06, 0.06, 1.0, 0, -0.55, 0, pipeM, 12);
  cyl(r.pipe, 0.065, 0.065, 0.05, 0, 0.42, 0, leg, 12);
  r.pipe.rotation.x = 0.1;
  r.glow = ownSprite(glowTex, 0xff2418); r.glow.position.y = 0.05; r.glow.scale.set(2.4, 0.9, 1); g.add(r.glow);
  r.mats.push(shell, leg, eye, pipeM);
}
// 燼皇（閻羅，照設計圖）：又高又瘦、像剝了皮一樣蒼白帶紅紋的身體，長長的頭，頭上一圈紅色的荊棘光環；
// 兩隻手臂張開一大片紅色的翅膀披風一直垂到地上，下半部燒著橘黃色的火；右手拖著一條黑色的長鞭；
// 腳邊圍著一圈開著紅玫瑰的荊棘藤。整個飄著
function buildEmber(r, g) {
  makeMonster4Textures();
  const skin = withDetail(ownLM('#ffffff', { map: emberSkinTex, shade: 0.8, transparent: true }), 'corpse', 5, 0.6);
  const dark = withDetail(ownLM('#5a2a26', { shade: 0.7, transparent: true }), 'corpse', 4, 1.0);
  const claw = ownLM('#1a1210', { shade: 0.6, transparent: true }), whip = ownLM('#141012', { transparent: true });
  r.body = new THREE.Group(); g.add(r.body);
  // 細長的腿、骨盆、肋骨很明顯的身體
  for (const s of [-1, 1]) { taper(r.body, [s * 0.1, 1.2, 0], [s * 0.12, 0.62, 0.02], 0.055, 0.04, skin, 8); taper(r.body, [s * 0.12, 0.62, 0.02], [s * 0.13, 0.05, -0.02], 0.04, 0.03, skin, 8); }
  sph(r.body, 0.16, 0, 1.25, 0, skin, 1.15, 0.6, 0.75, 12);
  const tor = cyl(r.body, 0.21, 0.13, 0.9, 0, 1.3, 0, skin, 12); tor.scale.z = 0.6;
  for (let i = 0; i < 6; i++) { const rib = new THREE.Mesh(geo('erib4b', () => new THREE.TorusGeometry(0.2, 0.016, 6, 14, Math.PI)), dark); rib.position.set(0, 1.6 + i * 0.09, 0.02); rib.rotation.x = Math.PI / 2; rib.scale.set(1 - Math.abs(i - 2.5) * 0.04, 0.7, 1); r.body.add(rib); }
  for (const s of [-1, 1]) sph(r.body, 0.09, s * 0.27, 2.2, 0, skin, 1.2, 0.8, 1, 10);
  cyl(r.body, 0.04, 0.05, 0.18, 0, 2.24, 0, skin, 8);
  r.head = new THREE.Group(); r.head.position.set(0, 2.55, 0.0); r.body.add(r.head);
  sph(r.head, 0.14, 0, 0.02, -0.02, skin, 0.95, 1.55, 1.0, 14);   // 長長的頭
  const faceMat = ownLM('#ffffff', { map: emberFaceTex, transparent: true, alphaTest: 0.3, shade: 0.5 });
  r.face = new THREE.Mesh(faceGeo('emberface2', 0.5, 0.13, 0.22, -0.0, 0.07), faceMat); r.face.position.set(0, 0.02, 0.07); r.head.add(r.face);
  r.eyes = eyePair(r.head, 0.03, 0.16, 0xff4a20, 0.1, 0.045);
  // 紅色的荊棘光環（設計圖是紅色的）
  r.halo = new THREE.Group(); r.halo.position.set(0, 2.98, -0.04); r.halo.rotation.x = -0.25; r.body.add(r.halo);
  r.haloMat = ownBasic({ color: 0xff3a3a, transparent: true });
  const ring = new THREE.Mesh(geo('halo4', () => new THREE.TorusGeometry(0.27, 0.02, 6, 32)), r.haloMat); ring.rotation.x = Math.PI / 2; r.halo.add(ring);
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, sp = new THREE.Mesh(geo('halospike4', () => new THREE.ConeGeometry(0.018, 0.12, 5)), r.haloMat);
    sp.position.set(Math.cos(a) * 0.31, (i % 2) * 0.02, Math.sin(a) * 0.31); sp.lookAt(Math.cos(a) * 2, 0, Math.sin(a) * 2); sp.rotateX(Math.PI / 2); r.halo.add(sp);
  }
  r.haloGlow = ownSprite(glowTex, 0xff5040); r.haloGlow.scale.setScalar(1.2); r.halo.add(r.haloGlow);
  // 手臂往兩邊張開，翅膀披風掛在手臂上
  r.arms = []; r.wings = [];
  const wingMat = ownBasic({ map: emberWingTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, depthWrite: true });
  for (const s of [-1, 1]) {
    const a = new THREE.Group(); a.position.set(s * 0.3, 2.2, 0); a.rotation.z = s * 0.95; r.body.add(a);
    taper(a, [0, 0, 0], [0, -0.62, 0.04], 0.045, 0.035, skin, 8);
    taper(a, [0, -0.62, 0.04], [0, -1.2, 0.1], 0.035, 0.026, skin, 8);
    for (let k = 0; k < 4; k++) { const c = new THREE.Mesh(geo('eclaw4', () => new THREE.ConeGeometry(0.014, 0.22, 5)), claw); c.position.set((k - 1.5) * 0.025, -1.32, 0.12); c.rotation.x = Math.PI + 0.3; a.add(c); }
    r.arms.push(a);
    // 翅膀：從肩膀張到手腕、往下垂到地上（不跟著手臂轉，在 sync 裡跟著張開的程度拉寬）
    const wg = new THREE.Group(); wg.position.set(s * 0.2, 2.35, -0.1); r.body.add(wg);
    // 薄膜：上緣從肩膀往外斜斜地翹起來（像蝙蝠翅膀的尖端），下面垂到地上；外側往前彎一點
    const wing = new THREE.Mesh(geo('ewing4b', () => {
      const gg = new THREE.PlaneGeometry(1.8, 2.7, 8, 8), p = gg.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = (p.getX(i) + 0.9) / 1.8, v = (p.getY(i) + 1.35) / 2.7;   // u：0 肩膀 → 1 翅膀尖；v：0 地上 → 1 上緣
        p.setX(i, u * (1.6 + (1 - v) * 0.35)); p.setY(i, -2.45 + v * (2.45 + u * 0.75 * v)); p.setZ(i, u * u * 0.45 - Math.sin(u * Math.PI) * 0.12);
      }
      gg.computeVertexNormals(); return gg;
    }), wingMat);
    wing.scale.x = s; wg.add(wing);
    r.wings.push(wg);
  }
  // 右手拖著的黑色長鞭（一節一節，會晃）
  r.whip = [];
  let prev = [0, -1.25, 0.12];
  for (let i = 0; i < 8; i++) { const nx = [0.02 * Math.sin(i), prev[1] - 0.16, prev[2] + 0.06 + i * 0.01]; r.whip.push(taper(r.arms[1], prev, nx, 0.012 - i * 0.001, 0.011 - i * 0.001, whip, 5)); prev = nx; }
  // 腳邊一圈開著紅玫瑰的荊棘藤（放在地上，不跟著飄）
  const vine = ownLM('#1e3a1a', { transparent: true }), rose = ownPhong('#b0101c', { specular: 0x553333, shininess: 30, transparent: true }), leafM = ownLM('#2e6a28', { transparent: true });
  r.roses = new THREE.Group(); r.roses.position.y = 0.03; g.add(r.roses);
  const tor2 = new THREE.Mesh(geo('rosering4', () => new THREE.TorusGeometry(1.05, 0.02, 5, 48)), vine); tor2.rotation.x = Math.PI / 2; r.roses.add(tor2);
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2 + (i % 3) * 0.1, x = Math.cos(a) * 1.05, z = Math.sin(a) * 1.05;
    sph(r.roses, 0.06, x, 0.05, z, rose, 1, 0.75, 1, 10); sph(r.roses, 0.035, x, 0.09, z, rose, 1, 0.8, 1, 8);
    const lf = sph(r.roses, 0.05, Math.cos(a + 0.12) * 1.08, 0.02, Math.sin(a + 0.12) * 1.08, leafM, 1, 0.25, 0.5, 6); lf.rotation.y = -a;
    if (i % 2) { const th = new THREE.Mesh(geo('thorn4', () => new THREE.ConeGeometry(0.01, 0.05, 4)), vine); th.position.set(Math.cos(a + 0.22) * 1.05, 0.03, Math.sin(a + 0.22) * 1.05); r.roses.add(th); }
  }
  r.flames = [];
  for (let i = 0; i < 10; i++) { const s = i < 5 ? -1 : 1, k = i % 5, f = ownSprite(glowTex, i % 2 ? 0xff6a10 : 0xffa030); f.position.set(s * (0.4 + k * 0.28), 0.3 + (k % 2) * 0.25, -0.1); f.scale.setScalar(0.45); r.body.add(f); r.flames.push(f); }
  r.mats.push(skin, dark, claw, whip, faceMat, wingMat, vine, rose, leafM);
}
// 走多快（從位置的變化算；圖鑑裡用劇本的狀態）
function moveSpeed4(e, r, dt) {
  if (e.pose) return e.state === 'chase' || e.state === 'hunt' ? 2.8 : e.state === 'patrol' || e.state === 'wander' ? 1.3 : 0;
  const v = r.px === undefined || dt <= 0 ? 0 : Math.hypot(e.x - r.px, e.y - r.py) / dt;
  r.px = e.x; r.py = e.y;
  r.spd = (r.spd || 0) + (Math.min(v, 6) - (r.spd || 0)) * Math.min(1, dt * 6);
  return r.spd;
}
const wrapA = a => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
function syncMonster4(e, r, t, p, d, dt) {
  switch (e.kind) {
    case 'staff': {
      const mv = moveSpeed4(e, r, dt), walk = clamp(mv / 1.4, 0, 1.4);
      r.wph = (r.wph || 0) + dt * mv * 3.4;
      const w = r.wph;
      if (e.state !== 'chase' || e.idle) r.g.rotation.y = faceRot(e.face || 0);
      r.legs[0].rotation.x = Math.sin(w) * 0.5 * walk; r.legs[1].rotation.x = -Math.sin(w) * 0.5 * walk;
      const punch = e.cd > 1.1 ? (e.cd - 1.1) / 0.5 : 0;
      r.arms[0].rotation.x = -Math.sin(w) * 0.3 * walk;
      r.arms[1].rotation.x = Math.sin(w) * 0.3 * walk - punch * 1.6;
      r.body.position.y = Math.abs(Math.sin(w)) * 0.04 * walk;
      r.body.rotation.x = e.state === 'chase' ? 0.1 : 0;
      // 頭：白天你靠近時慢慢轉過來看你（轉得比人能轉的還多）
      const hy = e.look != null ? clamp(wrapA(faceRot(e.look) - r.g.rotation.y), -2.3, 2.3) : 0;
      r.head.rotation.y += (hy - r.head.rotation.y) * Math.min(1, dt * 1.1);
      r.head.rotation.z = Math.sin(t * 0.7 + (e.x || 0)) * 0.05 + (e.look != null ? 0.2 : 0);
      r.g.position.y = floorH(e.x, e.y);
      break;
    }
    case 'shake': {
      const awake = !!e.awake;
      r.g.position.y = floorH(e.x, e.y);
      // 眼睛：醒著睜得很大、一直盯著你（鏡頭）；睡著眼皮半閉、慢慢飄來飄去，偶爾眨一下
      const v = _shakeV.copy(camera.position); r.eyeG.parent.worldToLocal(v);
      const ly = clamp(Math.atan2(v.x, v.z), -0.75, 0.75), lx = clamp(-Math.atan2(v.y, Math.hypot(v.x, v.z)), -0.5, 0.5);
      const blink = Math.sin(t * 0.8 + (e.x || 0) * 3.1) > 0.985 ? 1 : 0;
      if (awake) { r.eyeG.rotation.y += (ly - r.eyeG.rotation.y) * Math.min(1, dt * 10); r.eyeG.rotation.x += (lx - r.eyeG.rotation.x) * Math.min(1, dt * 10); }
      else { r.eyeG.rotation.y = Math.sin(t * 0.4 + (e.y || 0)) * 0.35; r.eyeG.rotation.x = 0.15; }
      const k = Math.max(blink, awake ? 0 : 0.5);
      r.lids[0].rotation.x = -0.55 + 1.05 * k; r.lids[1].rotation.x = 0.5 - 0.95 * k;
      r.eyeMat.emissive.setRGB(awake ? 0.16 : 0.1, awake ? 0.1 : 0.08, awake ? 0.1 : 0.08);
      if (!awake) {
        // 睡著：像一盒放在地上的奶昔，站著、稍微歪一邊
        r.g.rotation.y = faceRot(e.face || 0);
        r.carton.rotation.set(0, 0, 0.06); r.carton.position.set(0, 0, 0); r.carton.scale.set(1, 1, 1);
        break;
      }
      const hop = Math.abs(Math.sin((e.hopT || 0) * 7)), spit = e.spitT > 3.6 ? (e.spitT - 3.6) / 0.4 : 0;
      r.carton.rotation.set(-0.35 * spit, 0, Math.sin((e.hopT || 0) * 7) * 0.08);
      r.carton.position.set(0, hop * 0.22, 0);
      r.carton.scale.set(1 + (1 - hop) * 0.08, 1 - (1 - hop) * 0.12, 1 + (1 - hop) * 0.08);
      break;
    }
    case 'mimic': {
      const mv = moveSpeed4(e, r, dt), crawl = e.state === 'hunt' && !(e.retreat > 0) ? 1 : 0;
      r.crawlK = (r.crawlK || 0) + (crawl - (r.crawlK || 0)) * Math.min(1, dt * 5);
      const k = r.crawlK;
      r.wph = (r.wph || 0) + dt * mv * (2.6 + k * 1.6);
      const w = r.wph, walk = clamp(mv / 1.3, 0, 1.5);
      if (e.retreat > 0) r.g.rotation.y = faceRot(e.face || 0);
      r.hip.position.y = 0.95 - 0.22 * k + Math.abs(Math.sin(w)) * 0.05 * walk;
      r.torso.rotation.x = 0.18 + 1.2 * k;
      r.head.rotation.x = -1.05 * k + (e.retreat > 0 ? -0.3 : 0);
      r.head.rotation.y = e.retreat > 0 ? Math.sin(t * 30) * 0.25 : Math.sin(t * 0.9) * 0.08;
      r.head.rotation.z = (1 - k) * 0.25 + Math.sin(t * 1.3) * 0.05;   // 站著的時候頭歪一邊
      for (const [i, leg] of r.legs.entries()) leg.rotation.x = -0.35 * k + Math.sin(w + i * Math.PI) * 0.5 * walk;
      const knock = e.knock > 0 && (e.knockTick || 0) > 1.6 ? Math.abs(Math.sin(t * 14)) : 0;
      r.arms[0].rotation.x = -1.2 * k + Math.sin(w + Math.PI) * (0.25 + 0.4 * k) * walk;
      r.arms[1].rotation.x = -1.2 * k + Math.sin(w) * (0.25 + 0.4 * k) * walk - (e.knock > 0 ? 1.6 + knock * 0.4 : 0);
      // 站著的時候細長的手臂往兩邊張開（照設計圖），手指一直抽動
      r.arms[0].rotation.z = -(0.55 + Math.sin(t * 1.7) * 0.06) * (1 - k); r.arms[1].rotation.z = (0.55 + Math.sin(t * 1.5 + 1) * 0.06) * (1 - k) * (e.knock > 0 ? 0 : 1);
      r.drool.forEach((s, i) => { s.rotation.x = r.head.rotation.x * -0.8 + Math.sin(t * 2 + i) * 0.06; });
      r.g.position.y = floorH(e.x, e.y);
      break;
    }
    case 'hubert': {
      // 黑色的胖蜘蛛：八隻腳輪流踩，肚子一上一下；看到你時舉起抓著鐵管的前腳往地上砸
      if (e.home && !(e.raise > 0)) r.g.rotation.y = faceRot(e.face || 0);
      const mv = moveSpeed4(e, r, dt);
      r.wph = (r.wph || 0) + dt * (1.5 + mv * 5);
      r.body.position.y = 0.02 + Math.sin(r.wph * 2) * 0.03 + Math.sin(t * 1.6 + (e.x || 0)) * 0.015;
      r.g.position.y = floorH(e.x, e.y);
      r.legs.forEach((lg, i) => { const ph = r.wph + (i % 2 ? Math.PI : 0) + (i < 4 ? 0 : Math.PI / 2); lg.rotation.x = Math.sin(ph) * 0.12 * Math.min(1, 0.2 + mv); lg.position.y = 0.95 + Math.max(0, Math.sin(ph)) * 0.05 * Math.min(1, mv); });
      const raise = e.raise > 0 ? clamp((1 - e.raise) * 2, 0, 1) : 0, slam = e.cd > 4.1 ? 1 : 0, swing = e.swing > 0 ? e.swing / 0.35 : 0;
      r.armR.rotation.x = raise > 0 ? -1.9 * raise : swing > 0 ? -1.6 * swing + 0.2 : slam ? 0.55 : Math.sin(t * 0.8) * 0.05;
      r.pipe.rotation.x = raise > 0 ? 0.1 + 0.6 * raise : 0.1;
      r.head.rotation.y = Math.sin(t * 0.6) * 0.3;
      r.head.rotation.x = Math.sin(t * 0.9) * 0.06;
      r.glow.material.opacity = (0.55 + 0.3 * Math.sin(t * 3.1) + (raise > 0 ? 0.3 : 0)) * enemyAlpha(e);
      break;
    }
    case 'ember': {
      const kneel = e.kneel > 0, rain = e.rain > 0;
      r.kneelK = (r.kneelK || 0) + ((kneel ? 1 : 0) - (r.kneelK || 0)) * Math.min(1, dt * 3);
      r.rainK = (r.rainK || 0) + ((rain ? 1 : 0) - (r.rainK || 0)) * Math.min(1, dt * 4);
      const kk = r.kneelK, rk = r.rainK;
      r.body.position.y = 0.22 + Math.sin(t * 1.2) * 0.08 - kk * 0.85;
      r.body.rotation.x = kk * 0.35;
      r.head.rotation.x = kk * 0.45;
      const atk = e.cd > 1.6 ? (e.cd - 1.6) / 0.6 : 0;
      // 手臂張開（下燼雨時張得更開），翅膀跟著張、慢慢地拍
      r.arms.forEach((a, i) => {
        const s = i ? 1 : -1;
        a.rotation.z = s * (0.85 + rk * 0.45 - kk * 0.5 + Math.sin(t * 1.4 + i) * 0.05);
        a.rotation.x = -rk * 0.2 - (i ? atk * 1.4 : 0) + kk * 0.5;
      });
      r.wings.forEach((w, i) => { const s = i ? 1 : -1; w.rotation.y = s * (-0.1 - rk * 0.25 + kk * 0.6) + Math.sin(t * 1.1 + i) * 0.06; w.rotation.z = s * kk * 0.3; w.scale.y = 1 - kk * 0.25; });
      r.whip.forEach((m, i) => { m.rotation.z = Math.sin(t * 2.2 - i * 0.6) * 0.15 * (1 + atk); });
      const hk = kneel ? 0.08 : e.haloLit ? 0.65 + 0.35 * Math.abs(Math.sin(t * 20)) : 0.85 + 0.15 * Math.sin(t * 3);
      r.haloMat.color.setRGB(hk, hk * 0.24, hk * 0.2);   // 紅色的荊棘光環
      r.haloGlow.material.opacity = hk * 0.8 * enemyAlpha(e);
      r.halo.rotation.y = t * 0.6;
      for (const f of r.flames) { f.scale.setScalar(0.3 + Math.random() * 0.3); f.material.opacity = (0.5 + Math.random() * 0.4) * enemyAlpha(e) * (kneel ? 0.4 : 1); }
      r.roses.rotation.y = -r.g.rotation.y * 0.0 + t * 0.05;
      r.g.position.y = floorH(e.x, e.y);
      break;
    }
  }
}
// 神秘店員（賣東西的，不是怪物）：黃色的塑膠雨衣和帽兜，帽兜裡一片黑，只看得到兩點發亮的眼睛和一排鋸齒狀的牙；
// 左手提著一盞油燈、右手拿著鈴鐺，背上一個塞滿東西的大竹簍
let clerk4 = null;
function buildClerk4() {
  // 照設計圖：破破爛爛的土黃色連帽斗篷（下擺撕成一條一條）、帽兜裡一張鋸齒狀的大嘴和兩點發亮的眼睛，
  // 露出綠色的手和腳；一手提著鐵桶（裡面有一點光當燈籠），一手拿著一根黑色的長棍
  makeMonster4Textures();
  const g = new THREE.Group(); scene.add(g);
  const robe = withDetail(ownLM('#ffffff', { map: clerkRobeTex, shade: 0.6, side: THREE.DoubleSide }), 'rag', 3, 0.9);
  const skin = withDetail(ownLM('#4a6a3a', { shade: 0.7 }), 'skin', 6, 1.3), metal = withDetail(ownPhong('#7a7c80', { specular: 0x999999, shininess: 50 }), 'steel', 6, 0.9), stick = lm('#1e1a18');
  // 綠色的腿和腳
  for (const s of [-1, 1]) { taper(g, [s * 0.1, 0.5, 0], [s * 0.11, 0.05, 0.02], 0.055, 0.045, skin, 8); box(g, s * 0.11 - 0.05, s * 0.11 + 0.05, 0, 0.06, -0.04, 0.14, skin); }
  const body = new THREE.Mesh(geo('crobe4b', () => new THREE.CylinderGeometry(0.22, 0.42, 1.1, 18, 1, true)), robe); body.position.y = 0.95; g.add(body);
  // 下擺撕成一條一條的破布
  for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2, len = 0.18 + (i * 7 % 5) * 0.05; box(g, -0.045, 0.045, 0.4 - len, 0.42, -0.005, 0.005, robe, false).position.set(Math.sin(a) * 0.41, 0.41 - len / 2, Math.cos(a) * 0.41); }
  sph(g, 0.24, 0, 1.48, 0, robe, 1.12, 0.45, 0.9, 14);
  const hood = new THREE.Mesh(geo('chood4b', () => new THREE.SphereGeometry(0.22, 18, 14, Math.PI / 2 + 0.7, Math.PI * 2 - 1.4)), robe);
  hood.position.set(0, 1.72, -0.02); hood.scale.set(1, 1.3, 1.05); g.add(hood);
  const tip = taper(g, [0, 1.95, -0.08], [0.06, 2.12, -0.2], 0.08, 0.01, robe, 8); void tip;   // 帽兜尖尖的頂
  const face = new THREE.Mesh(geo('cface4b', () => new THREE.PlaneGeometry(0.3, 0.3)), ownBasic({ map: clerkFaceTex }));
  face.position.set(0, 1.68, 0.11); g.add(face);
  // 破袖子、綠色的手
  for (const s of [-1, 1]) {
    taper(g, [s * 0.24, 1.45, 0], [s * 0.3, 1.02, 0.14], 0.08, 0.1, robe, 10);
    taper(g, [s * 0.3, 1.02, 0.14], [s * 0.3, 0.92, 0.18], 0.035, 0.03, skin, 8);
    for (let k = -1; k <= 1; k++) taper(g, [s * 0.3 + k * 0.015, 0.92, 0.18], [s * 0.3 + k * 0.025, 0.84, 0.2], 0.01, 0.006, skin, 5);
  }
  // 鐵桶（左手）：舊舊的鐵皮、提把，裡面一點暖光
  const lamp = new THREE.Group(); lamp.position.set(-0.3, 0.9, 0.2); g.add(lamp);
  cyl(lamp, 0.12, 0.1, 0.24, 0, -0.42, 0, metal, 14, true);
  cyl(lamp, 0.1, 0.1, 0.01, 0, -0.42, 0, metal, 14);
  for (const y of [-0.38, -0.24]) cyl(lamp, 0.122, 0.122, 0.015, 0, y, 0, lm('#5a5c60'), 14, true);
  const handle = new THREE.Mesh(geo('bucketH4', () => new THREE.TorusGeometry(0.11, 0.006, 4, 16, Math.PI)), lm('#3a3a3c')); handle.position.y = -0.18; lamp.add(handle);
  const lg = ownSprite(glowTex, 0xffb060); lg.position.y = -0.2; lg.scale.setScalar(0.55); lamp.add(lg);
  // 黑色的長棍（右手），斜斜地拄著
  const bell = new THREE.Group(); bell.position.set(0.3, 0.9, 0.2); g.add(bell);
  const st = cyl(bell, 0.016, 0.012, 1.2, 0, -0.85, 0, stick, 6); st.rotation.z = 0.25;
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, lamp, bell, lg };
}
// ====================================================================
// 第五世界「世界夾層」的怪物（照設計師第五次手稿 docs/sketches/IMG_7436.jpeg 做成寫實風）：搖籃囈語、記憶洩漏源、白日夢、夢境切片、404視線、綠溫室、複製人
// 貼圖（m5Tex）有的一張要算好幾百萬個像素、有的畫幾百筆模糊的線，太慢了：預先畫好存成 tex/m5-<key>.webp（tools/make-monster5-tex.mjs），遊戲直接載入，
// 2048×1024 的縮成 1024×512（記憶體剩四分之一）。圖檔載入好之前先用一個像素的灰色頂著；載不到才當場畫（畫完一樣縮小）。
// 網址有 &bake5 就一律當場畫（做圖檔的工具用）。同一張貼圖只載一次，同一種怪物晚上再出來就不用再載
const m5Texs = {};
const M5_BAKE = /[?&]bake5\b/.test(location.search);
const m5Size = (w, h) => (w >= 2048 ? [w / 2, h / 2] : [w, h]);
function m5Paint(w, h, paint) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d', { willReadFrequently: true }), w, h);
  const [tw, th] = m5Size(w, h);
  if (tw === w) return c;
  const s = document.createElement('canvas'); s.width = tw; s.height = th;
  const g = s.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, tw, th);
  return s;
}
let m5Blank = null;
function m5Tex(key, w, h, paint) {
  if (m5Texs[key]) return m5Texs[key];
  const t = new THREE.Texture();
  t.colorSpace = SRGB; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  // 換成不一樣大的圖：GPU 上的那份要先丟掉重新配置（three.js 的貼圖配置好就不能改大小）
  const use = im => { if (t.image && (t.image.width !== im.width || t.image.height !== im.height)) t.dispose(); t.image = im; t.needsUpdate = true; };
  if (M5_BAKE) use(m5Paint(w, h, paint));
  else {
    if (!m5Blank) { m5Blank = document.createElement('canvas'); m5Blank.width = m5Blank.height = 1; const g = m5Blank.getContext('2d'); g.fillStyle = '#a89c94'; g.fillRect(0, 0, 1, 1); }
    use(m5Blank);
    const im = new Image();
    im.onload = () => use(im);
    im.onerror = () => use(m5Paint(w, h, paint));
    im.src = `tex/m5-${key}.webp`;
  }
  return (m5Texs[key] = t);
}
// ====================================================================
// 搖籃囈語（判官級，4.5～5.8 公尺）：一顆光禿禿、比人還大的嬰兒頭飄在半空，後腦勺長出四片淡黃色的蛾翅膀
// （上面兩片尖端往外勾，下面兩片拖著往下的尾巴）。翅膀上長著九顆人的眼睛（照設計圖：左上 3、右上 3、左下 2、右下 1），
// 眼眶紅腫、流著血淚，血一滴一滴往下掉。嬰兒睜大眼睛一直盯著你，整隻像搖籃一樣慢慢左右搖，翅膀慢慢搧。
// 尺寸照設計圖量（頭寬 304 像素 ≈ 2 公尺）：翅膀張開大約 8 公尺寬，最下面的翅膀尾巴離地 0.4 公尺
const CR_PX = 0.0066;                                            // 設計圖上 1 像素是幾公尺
const CR_HEAD = { rx: 1.0, ry: 1.13, rz: 1.06 }, CR_Y = 2.65;   // 頭的半徑（左右、上下、前後）、頭的中心離地多高
// 臉上的起伏：[X、Y（正面看，單位球上的位置）、寬、高、凸起多少（負的是凹進去）、左右對稱]
const CR_FACE = [
  [0, 0.25, 0.55, 0.45, 0.035, 0],         // 鼓鼓的額頭
  [0.3, -0.1, 0.2, 0.06, 0.012, 1],        // 眉骨（嬰兒的很淡）
  [0.36, -0.27, 0.22, 0.17, -0.03, 1],     // 眼窩（眼皮另外做，貼著眼球）
  [0.37, -0.43, 0.15, 0.055, 0.018, 1],    // 眼睛底下的肉
  [0, -0.34, 0.055, 0.11, 0.02, 0],        // 低低的鼻樑
  [0, -0.47, 0.085, 0.075, 0.07, 0],       // 鼻子
  [0, -0.505, 0.05, 0.04, 0.03, 0],        // 鼻頭
  [0.075, -0.53, 0.045, 0.035, 0.028, 1],  // 鼻翼
  [0.042, -0.556, 0.022, 0.016, -0.03, 1], // 鼻孔
  [0, -0.6, 0.022, 0.035, -0.01, 0],       // 人中
  [0, -0.65, 0.14, 0.032, 0.045, 0],       // 上唇
  [0.03, -0.637, 0.025, 0.02, 0.008, 1],   // 唇峰
  [0, -0.676, 0.155, 0.014, -0.03, 0],     // 嘴縫
  [0.15, -0.675, 0.03, 0.03, -0.022, 1],   // 嘴角
  [0, -0.706, 0.115, 0.034, 0.05, 0],      // 下唇
  [0, -0.765, 0.1, 0.03, -0.018, 0],       // 下唇底下的凹
  [0, -0.85, 0.13, 0.07, 0.05, 0],         // 下巴
  [0.44, -0.56, 0.22, 0.2, 0.085, 1],      // 胖胖的臉頰
  [0.8, -0.05, 0.15, 0.3, -0.02, 1],       // 太陽穴
];
// 單位球上的點 → 嬰兒的頭：腦袋又大又圓、臉小小的在下半部；下半臉往前推（嘴巴才不會長在頭的底部），
// 下巴和下顎往內收、脖子後面收進去，後腦勺凸出來；再加上臉上的起伏
// 眼睛：眼球的大小和位置（單位球上），開口的大小照眼球半徑算
const CR_EYE = { x: 0.36, y: -0.29, R: 0.165 };
// 杏仁形的開口：dx、dy 是離眼睛中心多遠（公尺，往外眼角是 +dx），R 是眼球半徑。
// 回傳 e：在開口外面多遠（負的是在開口裡面），upper：靠上眼皮那邊。外眼角比內眼角高一點
// S 是開口的形狀（乘眼球半徑）：w 半寬、hu 上眼皮、hl 下眼皮離中心多遠、lift 外眼角抬高多少（負的是往下垂）
const CR_LID = { w: 0.92, hu: 0.6, hl: 0.5, lift: 0.08 };
function crLidE(dx, dy, R, S = CR_LID) {
  const w = S.w * R, hu = S.hu * R, hl = S.hl * R, u = dx / w, lift = S.lift * 0.6 * R * u, k = Math.max(0, 1 - u * u);
  const top = hu * k ** 0.7 + lift, bot = -hl * k ** 0.85 + lift, upper = dy > (top + bot) / 2;
  let e = upper ? dy - top : bot - dy;
  if (Math.abs(u) > 1) e = Math.max(e, Math.hypot((Math.abs(u) - 1) * w, dy - lift));
  return { e, upper, top, bot };
}
// 眼皮在眼球外面多厚：上眼皮靠近邊緣鼓起來、上面一道摺痕，下眼皮薄；開口裡面縮到眼球後面（邊緣是一道陡陡的眼瞼緣）
function crLidT(e, upper, R) {
  const g = x => Math.exp(-x * x), T = x => R * (upper ? 0.06 + 0.1 * g((x / R - 0.18) / 0.13) - 0.035 * g((x / R - 0.5) / 0.1) : 0.05 + 0.04 * g((x / R - 0.12) / 0.1));
  if (e >= 0) return T(e);
  const q = sstep(0, 0.09 * R, -e);
  return T(0) * (1 - q) - 0.35 * R * q;
}
// 把眼睛附近的點貼到眼球外面（眼皮）：P 是原本的位置，C 是眼球中心、F 是眼睛朝前的方向，dx、dy 是 P 在開口的哪裡。
// 從正面看位置不變，只改前後的深度：開口邊上貼著眼球（半徑 R 加上眼皮的厚度），離開口遠一點就只往外推、不往內拉，再慢慢回到原本的位置。
// 開口裡面縮到眼球後面；開口邊上一圈的點移到邊緣的曲線上，眼瞼緣才是平滑的曲線（不會鋸齒狀）
const _crQ = new THREE.Vector3(), _crL = new THREE.Vector3();
function crSnapLid(P, C, F, dx, dy, R, S = CR_LID) {
  const L = crLidE(dx, dy, R, S), e = L.e, w = 1 - sstep(0.4 * R, 0.9 * R, e);
  if (w <= 0) return e;
  if (e < 0 && e > -0.2 * R && Math.abs(dx) < S.w * R) P.y += (L.upper ? L.top : L.bot) - dy;
  const v = _crQ.copy(P).sub(C), zP = v.dot(F), lat = _crL.copy(v).addScaledVector(F, -zP), l = lat.length(), rT = R + crLidT(e, L.upper, R);
  const zS = l < rT ? Math.sqrt(rT * rT - l * l) : 0;
  const z = e < 0 ? zS : e < 0.25 * R ? zS + (Math.max(zS, zP) - zS) * sstep(0, 0.25 * R, e) : Math.max(zS, zP);
  _crQ.copy(C).add(lat).addScaledVector(F, z);
  P.lerp(_crQ, w);
  return e;
}
// 頭上兩顆眼球的中心和朝向（第一次用時才算）：眼球的正面比原本的臉稍微凸出一點
let crEyeAt = null;
function crEyes() {
  if (crEyeAt) return crEyeAt;
  crEyeAt = [-1, 1].map(s => {
    const X = s * CR_EYE.x, Y = CR_EYE.y, S0 = crHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), new THREE.Vector3(), true);
    const F = new THREE.Vector3(s * 0.1, -0.05, 1).normalize();
    return { s, F, C: S0.addScaledVector(F, -0.92 * CR_EYE.R) };
  });
  return crEyeAt;
}
function crHeadPt(x, y, z, out, noEye) {
  let X = x, Y = y, Z = z;
  if (Y < 0) {
    const t = -Y;
    X *= 1 - 0.16 * t * t;
    Z *= Z > 0 ? 1 + 0.32 * sstep(0.15, 0.85, t) * (1 - 0.5 * sstep(0.88, 1, t)) : 1 - 0.3 * t * t;
  }
  if (Z < 0) Z *= 1 + 0.07 * sstep(-0.5, 0.1, Y);
  let d = 0;
  if (z > 0.05) {
    for (const f of CR_FACE) for (const s of f[5] ? [-1, 1] : [1]) {
      const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3];
      if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v);
    }
    d *= sstep(0.05, 0.4, z);
  }
  const k = 1 + d / (Math.hypot(X, Y, Z) || 1);
  out.set(X * k * CR_HEAD.rx, Y * k * CR_HEAD.ry, Z * k * CR_HEAD.rz);
  if (noEye || z < 0.3) return out;
  for (const E of crEyes()) {
    const dx = (x - E.s * CR_EYE.x) * E.s * CR_HEAD.rx, dy = (y - CR_EYE.y) * CR_HEAD.ry;
    if (dx * dx + dy * dy < (CR_EYE.R * 2.4) ** 2) crSnapLid(out, E.C, E.F, dx, dy, CR_EYE.R);
  }
  return out;
}
// 頭的貼圖座標：臉那一塊分到比較多的像素（u 繞一圈、正面是 0.5；v 從頭頂到下巴底下）。
// 回傳的函式把角度換成 0～1；.inv 反過來（逐點畫貼圖時從貼圖的位置找回角度）
function crWarp(lo, hi, dens) {
  const N = 512, cum = new Float32Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + dens(lo + (i + 0.5) / N * (hi - lo));
  const f = x => { const q = clamp((x - lo) / (hi - lo), 0, 1) * N, i = Math.min(N - 1, q | 0); return (cum[i] + (cum[i + 1] - cum[i]) * (q - i)) / cum[N]; };
  f.inv = t => {
    const c = clamp(t, 0, 1) * cum[N];
    let i = 0, j = N;
    while (j - i > 1) { const m = (i + j) >> 1; if (cum[m] <= c) i = m; else j = m; }
    return lo + (i + (c - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i])) / N * (hi - lo);
  };
  return f;
}
const crU = crWarp(-Math.PI, Math.PI, a => 1 + 1.6 * Math.exp(-((a / 0.7) ** 2)));
const crV = crWarp(0, Math.PI, th => 1 + 1.6 * Math.exp(-(((th - 2.05) / 0.55) ** 2)));
// 雕出來的頭：一圈一圈的網格（th 從頭頂往下、a 從正後方繞一圈，a = 0 是正面、往 +x 是正的），
// pt(x, y, z, out) 把單位球上的點變成頭的形狀，U、V 是貼圖座標（crWarp）；
// thW、phW 回傳 0～1：那一段的格子要多密（1 用 fine、0 用 coarse 的角度間隔）
function sculptGeo(key, pt, U, V, thW, phW, fine = [0.0105, 0.012], coarse = [0.04, 0.045]) {
  return geo(key, () => {
    const steps = (lo, hi, fine, coarse, w) => {
      const a = [lo];
      while (a[a.length - 1] < hi) { const x = a[a.length - 1]; a.push(x + coarse + (fine - coarse) * w(x)); }
      const k = (hi - lo) / (a[a.length - 1] - lo);
      return a.map(x => lo + (x - lo) * k);
    };
    const TH = steps(0, Math.PI, fine[0], coarse[0], thW), PH = steps(-Math.PI, Math.PI, fine[1], coarse[1], phW);
    const R = TH.length, N = PH.length - 1, C1 = N + 1, pos = new Float32Array(R * C1 * 3), uv = new Float32Array(R * C1 * 2), v = new THREE.Vector3();
    for (let i = 0; i < R; i++) for (let j = 0; j <= N; j++) {
      const th = TH[i], a = PH[j % N], st = Math.sin(th), k = i * C1 + j;
      pt(st * Math.sin(a), Math.cos(th), st * Math.cos(a), v);
      pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
      uv[k * 2] = j === N ? 1 : U(a); uv[k * 2 + 1] = 1 - V(th);
    }
    const idx = [];
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < N; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    fixSeam(g, N, R);
    return g;
  });
}
// 頭：臉那一塊（眉毛到下巴、左右各 40°）的格子密很多，眼皮、鼻孔、嘴縫才做得出來
const crHeadGeo = () => sculptGeo('crHead', crHeadPt, crU, crV, th => sstep(1.25, 1.42, th) * (1 - sstep(2.6, 2.8, th)), a => sstep(-0.8, -0.62, a) * (1 - sstep(0.62, 0.8, a)));
// 頭的貼圖：嬰兒的皮膚（一點一點的紅斑、太陽穴和頭皮底下透出來的青色血管），眼睛周圍深深的黑眼圈（設計圖上塗得很深），
// 紅紅的臉頰和鼻頭、嘟嘟的嘴唇、淡淡的眉毛；後頸有一圈一圈的肉摺
// 畫雕出來的頭的臉（sculptGeo 的貼圖，U、V 是 crWarp）：at(X, Y, fn, mirror) 在臉上某一點畫東西，那附近的單位是單位球的 1/100（y 往上），
// mirror = -1 左右翻過來；soft 是邊緣淡出的一團顏色，curve 是一條線（兩點或二次曲線）
function headPainter(c, W, H, U, V) {
  const map = (X, Y) => { const z = Math.sqrt(Math.max(0, 1 - X * X - Y * Y)); return [U(Math.atan2(X, z)) * W, V(Math.acos(clamp(Y, -1, 1))) * H]; };
  const at = (X, Y, fn, mirror = 1) => {
    const [x0, y0] = map(X, Y), [x1] = map(X + 0.0025, Y), [, y1] = map(X, Y + 0.0025);
    c.save(); c.setTransform((x1 - x0) / 0.25 * mirror, 0, 0, (y1 - y0) / 0.25, x0, y0); fn(); c.restore();
  };
  const soft = (x, y, rx, ry, col, a) => { c.save(); c.translate(x, y); c.scale(rx, ry); const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, rgbaOf(col, a)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 7); c.fill(); c.restore(); };
  const curve = (pts, col, w) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); c.moveTo(pts[0], pts[1]); if (pts.length === 6) c.quadraticCurveTo(pts[2], pts[3], pts[4], pts[5]); else c.lineTo(pts[2], pts[3]); c.stroke(); };
  return { at, soft, curve };
}
function crPaintHead(c, W, H) {
  const { at, soft, curve } = headPainter(c, W, H, crU, crV);
  const r = seeded(5150), sh = '#7a4434';
  c.fillStyle = '#e9bca2'; c.fillRect(0, 0, W, H);
  for (let i = 0; i < 1400; i++) {
    const x = r() * W, y = r() * H, rr = 6 + r() * 30, q = r(), col = q < 0.45 ? '#d98a78' : q < 0.75 ? '#f6dcc8' : '#cfa070';
    const g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, rgbaOf(col, 0.07 + r() * 0.06)); g.addColorStop(1, rgbaOf(col, 0));
    c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // 頭皮和太陽穴底下的青色血管：彎彎曲曲、越分越細
  c.lineCap = 'round';
  const vein = (x, y, a, w, n) => {
    c.beginPath(); c.moveTo(x, y);
    for (let k = 0; k < n; k++) {
      a += (r() - 0.5) * 0.7; x += Math.cos(a) * 9; y += Math.sin(a) * 9; c.lineTo(x, y);
      if (w > 1.4 && r() < 0.08) { c.lineWidth = w; c.stroke(); vein(x, y, a + (r() < 0.5 ? 0.9 : -0.9), w * 0.6, n - k); c.beginPath(); c.moveTo(x, y); }
    }
    c.lineWidth = w; c.stroke();
  };
  c.strokeStyle = 'rgba(96,118,160,.09)'; c.shadowColor = 'rgba(100,122,165,.3)'; c.shadowBlur = 7;   // 隔著皮膚看到的：邊緣模糊
  for (let i = 0; i < 26; i++) {
    const side = r() < 0.5 ? -1 : 1, temple = i < 12, a0 = temple ? side * (0.85 + r() * 0.5) : (r() - 0.5) * 5;
    const [x, y] = [crU(clamp(a0, -3.1, 3.1)) * W, crV(temple ? 1.15 + r() * 0.5 : 0.25 + r() * 0.9) * H];
    vein(x, y, temple ? -Math.PI / 2 + (r() - 0.5) : r() * 6.28, 2.2 + r() * 1.6, 18 + (r() * 20 | 0));
  }
  c.shadowBlur = 0;
  // 下巴底下和後頸比較暗；後頸一圈一圈的肉摺
  const yb = crV(2.45) * H, gd = c.createLinearGradient(0, yb, 0, H); gd.addColorStop(0, rgbaOf(sh, 0)); gd.addColorStop(1, rgbaOf(sh, 0.55));
  c.fillStyle = gd; c.fillRect(0, yb, W, H - yb);
  for (const th of [2.55, 2.7, 2.84]) for (const [u0, u1] of [[0, crU(-1.5)], [crU(1.5), 1]]) {
    const y = crV(th) * H;
    c.strokeStyle = rgbaOf(sh, 0.32); c.lineWidth = 3; c.beginPath(); c.moveTo(u0 * W, y);
    for (let u = u0; u <= u1; u += 0.01) c.lineTo(u * W, y + Math.sin(u * 40) * 3);
    c.stroke();
    c.strokeStyle = 'rgba(255,235,220,.18)'; c.lineWidth = 2; c.beginPath(); c.moveTo(u0 * W, y + 4); c.lineTo(u1 * W, y + 4); c.stroke();
  }
  // 整張臉的明暗：額頭亮、太陽穴暗
  at(0, 0.3, () => soft(0, 0, 40, 26, '#ffffff', 0.1));
  for (const s of [-1, 1]) at(s * 0.76, -0.05, () => soft(0, 0, 16, 34, sh, 0.22));
  // 黑眼圈：眼窩一圈深深的紫褐色，眼睛底下一彎更深
  // 眼皮（立體的，貼著眼球）：開口上下緣是粉紅色濕濕的眼瞼緣，上眼皮有一道摺痕和短短的睫毛，開口裡面是暗紅色（被眼球擋住）
  const E = CR_EYE.R, lidPt = (u, k, off = 0) => { const L = crLidE(u * 0.92 * E, 0, E); return [u * 92 * E, ((k ? L.top : L.bot) + off * (k ? 1 : -1)) / CR_HEAD.ry * 100]; };
  const lidLine = (k, off, col, w, u0 = -1, u1 = 1) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); for (let u = u0; u <= u1 + 1e-6; u += 0.05) c.lineTo(...lidPt(u, k, off)); c.stroke(); };
  for (const s of [-1, 1]) at(s * CR_EYE.x, CR_EYE.y, () => {
    soft(0, 0.5, 24, 18, '#5e3442', 0.42);
    soft(1, -11.5, 17, 6, '#4a2638', 0.42);
    c.fillStyle = '#4a1818'; c.beginPath();
    for (let u = -1; u <= 1.001; u += 0.05) c.lineTo(...lidPt(u, 1));
    for (let u = 1; u >= -1.001; u -= 0.05) c.lineTo(...lidPt(u, 0));
    c.fill();
    lidLine(1, 0.5 * E, rgbaOf(sh, 0.12), 3, -0.8, 0.9); lidLine(1, 0.5 * E, rgbaOf(sh, 0.18), 0.8, -0.75, 0.85);   // 上眼皮的摺痕
    lidLine(0, 0.3 * E, rgbaOf(sh, 0.1), 2.5, -0.7, 0.8);                                                            // 下眼皮底下淡淡的影子
    lidLine(1, 0.004, '#b4706a', 1.5); lidLine(0, 0.004, '#c27e74', 1.2);
    for (let i = 0; i < 38; i++) {   // 睫毛：往上、越靠外眼角越往外翹
      const u = -0.88 + i / 37 * 1.82, [x, y] = lidPt(u, 1, 0.011), l = 1.3 + r() * 1.0 + 0.5 * Math.sin((u + 1) * 1.5);
      curve([x, y, x + (u * 0.9 + 0.3) * l * 0.6, y + l * 0.7, x + (u * 1.2 + 0.5) * l, y + l * 0.85], 'rgba(58,40,32,.75)', 0.26);
    }
  }, s);
  // 眉毛：淡淡的、稀稀疏疏的細毛
  for (const s of [-1, 1]) at(s * 0.33, -0.1, () => {
    for (let i = 0; i < 46; i++) { const t = i / 45, x = -13 + t * 26, y = 1.8 * Math.sin(t * Math.PI) - t * 1.2 + (r() - 0.5) * 1.6; curve([x, y, x + 1.6 + t, y + 0.9 - t * 0.6], 'rgba(150,110,80,.28)', 0.35); }
  }, s);
  // 鼻子：兩邊的影子、紅紅的鼻頭、鼻孔、底下的影子、人中
  at(0, -0.48, () => { for (const s of [-1, 1]) soft(s * 7, 1, 3.5, 9, sh, 0.22); soft(0, -2, 4.5, 3.5, '#d4766a', 0.24); soft(0, 1.5, 2.2, 3.2, '#ffffff', 0.13); });
  for (const s of [-1, 1]) at(s * 0.042, -0.556, () => { c.fillStyle = 'rgba(58,24,22,.85)'; c.beginPath(); c.ellipse(0, 0, 1.9, 1.15, -0.25, 0, 7); c.fill(); }, s);
  at(0, -0.585, () => { soft(0, 0, 7, 2, sh, 0.25); for (const s of [-1, 1]) curve([s * 2.2, 0, s * 2.6, -5.5], rgbaOf(sh, 0.18), 0.5); });
  // 嘴：嘟嘟的小嘴，上唇有唇峰、下唇比較亮
  at(0, -0.676, () => {
    c.fillStyle = '#bf6c62';
    c.beginPath(); c.moveTo(-15, 0); c.bezierCurveTo(-9, 1.6, -4.6, 4.2, -1.7, 3.7); c.quadraticCurveTo(0, 2.8, 1.7, 3.7); c.bezierCurveTo(4.6, 4.2, 9, 1.6, 15, 0); c.quadraticCurveTo(0, -0.8, -15, 0); c.fill();
    c.fillStyle = '#cd8074';
    c.beginPath(); c.moveTo(-13, -0.3); c.quadraticCurveTo(0, -8, 13, -0.3); c.quadraticCurveTo(0, -1, -13, -0.3); c.fill();
    curve([-15.5, 0.1, 0, -1.1, 15.5, 0.1], 'rgba(80,30,30,.85)', 0.8);
    soft(0, -3, 5.5, 1.3, '#ffffff', 0.16);
    for (const s of [-1, 1]) soft(s * 15.5, -0.4, 2.2, 2.2, sh, 0.32);
    soft(0, -8.5, 9, 2.6, sh, 0.24);
  });
  at(0, -0.86, () => soft(0, 0, 10, 5, '#ffffff', 0.08));
  // 臉頰紅紅的
  for (const s of [-1, 1]) at(s * 0.44, -0.56, () => soft(0, 0, 18, 15, '#df7866', 0.26));
  // 耳朵根部的影子
  for (const s of [-1, 1]) at(s * 0.93, -0.38, () => soft(0, 0, 6, 22, sh, 0.35));
}
// 翅膀的輪廓（設計圖上的像素，+x 往外、+y 往上，原點是頭的中心；第三個數字是尖角）：上面那片尖端往外勾，下面那片拖著往下的尾巴
const CR_WING = {
  U: [[40, 170], [70, 205], [110, 240], [170, 276], [250, 304], [340, 320], [440, 318], [515, 300], [565, 275], [596, 246, 1], [560, 236], [500, 222], [445, 198], [402, 160], [384, 110], [390, 60], [398, 18], [380, -18], [330, -36], [250, -42], [170, -34], [100, -18], [40, 10]],
  L: [[60, -20], [150, -30], [250, -36], [340, -42], [410, -55], [465, -92], [505, -155], [530, -235], [548, -300], [560, -345, 1], [525, -330], [470, -298], [415, -262], [355, -246], [295, -258], [240, -282], [185, -274], [145, -238], [128, -180], [115, -110], [70, -60]],
};
const CR_ROOT = { U: [60, 90], L: [80, -70] };   // 翅脈從哪裡長出來
// 翅膀上的眼睛：[哪一片（U 上、L 下）、哪一邊（1 是 +x）、x、y、大小（像素）、流多少血]
const CR_EYES = [['U', 1, 305, 250, 33, 1], ['U', 1, 237, 178, 33, 0.8], ['U', 1, 288, 78, 33, 0.9],
  ['U', -1, 390, 240, 35, 0.15], ['U', -1, 270, 138, 34, 0], ['U', -1, 287, 30, 36, 0.3],
  ['L', 1, 272, -140, 38, 1], ['L', -1, 350, -180, 40, 1], ['L', -1, 213, -188, 38, 0.9]];
// 翅膀的彎度（公尺）：越往外越往後彎，上面那片的尖端往前勾，下面那片的尾巴往後捲；表面有一點起伏
const crWingZ = (w, x, y) => w === 'U'
  ? -0.3 * ((x - 40) / 560) ** 2 + 0.22 * sstep(470, 600, x) * sstep(170, 290, y) + 0.035 * Math.sin(x * 0.021 + y * 0.013)
  : -0.22 * ((x - 60) / 500) ** 2 - 0.15 * sstep(-120, -345, y) + 0.035 * Math.sin(x * 0.018 - y * 0.02);
// 點到輪廓的距離（在裡面是 0）
function crPolyDist(pts, x, y) {
  let inside = false, best = 1e9;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi, dy = yj - yi, t = clamp(((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(x - xi - dx * t, y - yi - dy * t));
  }
  return inside ? 0 : best;
}
const crBox = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return [Math.min(...xs) - 14, Math.max(...xs) + 14, Math.min(...ys) - 14, Math.max(...ys) + 14]; };
// 翅膀的網格：蓋住輪廓的方格（輪廓外面的格子丟掉），形狀由貼圖的透明度決定
function crWingGeo(w) {
  return geo('crWing' + w, () => {
    const pts = CR_WING[w], [x0, x1, y0, y1] = crBox(pts);
    const g = new THREE.PlaneGeometry(1, 1, 40, 28), P = g.attributes.position, I = g.index.array, near = new Uint8Array(P.count), keep = [];
    for (let i = 0; i < P.count; i++) {
      const x = x0 + (P.getX(i) + 0.5) * (x1 - x0), y = y0 + (P.getY(i) + 0.5) * (y1 - y0);
      near[i] = crPolyDist(pts, x, y) < 26 ? 1 : 0;
      P.setXYZ(i, x * CR_PX, y * CR_PX, crWingZ(w, x, y));
    }
    for (let k = 0; k < I.length; k += 3) if (near[I[k]] | near[I[k + 1]] | near[I[k + 2]]) keep.push(I[k], I[k + 1], I[k + 2]);
    g.setIndex(keep);
    g.computeVertexNormals();
    return g;
  });
}
// 一片翅膀的貼圖（四片各自畫，眼睛和血淚的位置不一樣）：淡淡的奶油色蛾翅，根部黃褐色，邊緣和一條一條從根部往外的黃色（照設計圖的黃色筆觸），
// 分岔的翅脈、細細的鱗粉、幾塊污漬，眼睛周圍紅腫，眼睛底下流著血淚（另外畫一張只有血的，讓血看起來濕濕亮亮的）；邊緣一圈深色的邊和細毛
const crWingTexs = {};
function crWingTex(w, side) {
  const key = w + side;
  if (crWingTexs[key]) return crWingTexs[key];
  const pts = CR_WING[w], [x0, x1, y0, y1] = crBox(pts), W = 768, H = 512, eyes = CR_EYES.filter(e => e[0] === w && e[1] === side), drips = [];
  const setT = c => c.setTransform(W / (x1 - x0), 0, 0, -H / (y1 - y0), -x0 * W / (x1 - x0), y1 * H / (y1 - y0));
  const path = c => {
    const n = pts.length, mid = i => [(pts[i % n][0] + pts[(i + 1) % n][0]) / 2, (pts[i % n][1] + pts[(i + 1) % n][1]) / 2];
    c.beginPath(); c.moveTo(...mid(n - 1));
    for (let i = 0; i < n; i++) { const m = mid(i); if (pts[i][2]) { c.lineTo(pts[i][0], pts[i][1]); c.lineTo(m[0], m[1]); } else c.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]); }
    c.closePath();
  };
  // 血淚：每顆眼睛底下一到三道，往下流、越來越細，尾端一顆血珠（mask 是只有血的那張：白色）
  const blood = (c, mask) => {
    for (const e of eyes) {
      const [, , ex, ey, er, b] = e;
      if (b <= 0) continue;
      const r = seeded(Math.round(ex * 7 + ey * 13 + 99)), n = 1 + (b > 0.6 ? 1 : 0) + (r() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const main = k === 0, len = main ? 70 + 90 * b : (25 + 40 * r()) * b, w0 = main ? 4 + 4 * b : 2 + 2 * r();
        let x = ex + (main ? (r() - 0.5) * er * 0.3 : (r() - 0.5) * er * 1.1), y = ey - er * 0.6;
        const P = [[x, y]];
        for (let s = 0; s < 12; s++) { x += (r() - 0.5) * 5; y -= len / 12; P.push([x, y]); }
        for (const [col, wk] of mask ? [['#ffffff', 1.1]] : [['#a3161c', 1], ['#5e070b', 0.55]]) {
          c.strokeStyle = col; c.lineCap = 'round';
          for (let s = 0; s < 12; s++) { c.lineWidth = w0 * wk * (1 - 0.45 * s / 12); c.beginPath(); c.moveTo(...P[s]); c.lineTo(...P[s + 1]); c.stroke(); }
        }
        c.fillStyle = mask ? '#ffffff' : '#62070b'; c.beginPath(); c.ellipse(x, y - 2, w0 * 0.8, w0 * 1.1, 0, 0, 7); c.fill();
        if (!mask && main) drips.push({ e, x, y: y - 4 });
      }
    }
  };
  const r = seeded(w === 'U' ? 11 + side : 23 + side), [rx, ry] = CR_ROOT[w];
  const map = canvasTex(W, H, c => {
    setT(c);
    c.save(); path(c); c.clip();
    c.fillStyle = '#f1ecd8'; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    let g = c.createRadialGradient(rx, ry, 0, rx, ry, 430);
    g.addColorStop(0, 'rgba(176,142,62,.5)'); g.addColorStop(0.3, 'rgba(212,186,100,.16)'); g.addColorStop(1, 'rgba(230,215,150,0)');
    c.fillStyle = g; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    // 邊緣一圈比較黃（設計圖的黃色多塗在邊上）
    c.lineJoin = 'round';
    for (const [lw, a] of [[80, 0.08], [44, 0.12], [20, 0.16]]) { c.strokeStyle = `rgba(228,204,62,${a})`; c.lineWidth = lw; path(c); c.stroke(); }
    // 從根部往外一筆一筆的黃色
    c.lineCap = 'round';
    for (let i = 0; i < 70; i++) {
      const q = pts[r() * pts.length | 0], t0 = 0.2 + r() * 0.45, t1 = 0.85 + r() * 0.2;
      c.strokeStyle = `rgba(226,200,56,${(0.03 + r() * 0.08).toFixed(3)})`; c.lineWidth = 6 + r() * 18;
      c.beginPath(); c.moveTo(rx + (q[0] - rx) * t0, ry + (q[1] - ry) * t0); c.lineTo(rx + (q[0] - rx) * t1 + (r() - 0.5) * 30, ry + (q[1] - ry) * t1 + (r() - 0.5) * 30); c.stroke();
    }
    // 翅脈：從根部分岔出去，一直到邊緣
    const outer = pts.filter((p, i) => i % 2 === 0 && Math.hypot(p[0] - rx, p[1] - ry) > 230);
    for (let i = 0; i < outer.length; i++) {
      const q = outer[i], cx = rx + (q[0] - rx) * 0.5 + (r() - 0.5) * 110, cy = ry + (q[1] - ry) * 0.5 + (r() - 0.5) * 110;
      for (const [col, lw] of [['rgba(186,156,84,.12)', 6], ['rgba(140,110,56,.22)', 1.4]]) {
        c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(rx, ry); c.quadraticCurveTo(cx, cy, q[0], q[1]); c.stroke();
        if (i % 2) { const b0x = rx + (cx - rx) * 1.1, b0y = ry + (cy - ry) * 1.1, nb = outer[(i + 1) % outer.length]; c.beginPath(); c.moveTo(b0x, b0y); c.quadraticCurveTo((b0x + nb[0]) / 2 + (r() - 0.5) * 30, (b0y + nb[1]) / 2, (q[0] + nb[0]) / 2, (q[1] + nb[1]) / 2); c.stroke(); }
      }
    }
    // 鱗粉：很多短短的細線，順著從根部往外的方向（亮的、暗的各畫一層）
    for (const col of ['rgba(255,250,228,.16)', 'rgba(140,110,48,.13)']) {
      c.strokeStyle = col; c.lineWidth = 0.9; c.beginPath();
      for (let i = 0; i < 5000; i++) {
        const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0), a = Math.atan2(y - ry, x - rx), l = 3 + r() * 6;
        c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      }
      c.stroke();
    }
    // 幾塊污漬
    for (let i = 0; i < 12; i++) {
      const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0), rr = 10 + r() * 34;
      g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, 'rgba(130,100,52,.12)'); g.addColorStop(1, 'rgba(130,100,52,0)');
      c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    // 眼睛周圍紅腫
    for (const [, , ex, ey, er] of eyes) {
      g = c.createRadialGradient(ex, ey, er * 0.7, ex, ey, er * 2.1);
      g.addColorStop(0, 'rgba(160,52,56,.7)'); g.addColorStop(0.45, 'rgba(196,112,100,.32)'); g.addColorStop(1, 'rgba(210,150,120,0)');
      c.fillStyle = g; c.fillRect(ex - er * 2.2, ey - er * 2.2, er * 4.4, er * 4.4);
    }
    blood(c, false);
    c.restore();
    // 邊緣：深色的邊，外面一圈細細的毛
    c.strokeStyle = 'rgba(92,78,52,.9)'; c.lineWidth = 3; path(c); c.stroke();
    c.strokeStyle = 'rgba(228,214,172,.75)'; c.lineWidth = 1.3; c.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length], L = Math.hypot(bx - ax, by - ay);
      let nx = (by - ay) / L, ny = -(bx - ax) / L;
      if (crPolyDist(pts, (ax + bx) / 2 + nx * 4, (ay + by) / 2 + ny * 4) === 0) { nx = -nx; ny = -ny; }
      for (let d = 0; d < L; d += 3.5) { const x = ax + (bx - ax) * d / L, y = ay + (by - ay) * d / L, l = 3 + r() * 7; c.moveTo(x - nx * 2, y - ny * 2); c.lineTo(x + nx * l + (r() - 0.5) * 3, y + ny * l + (r() - 0.5) * 3); }
    }
    c.stroke();
  }, true);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  const spec = canvasTex(W, H, c => {
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H); setT(c);
    for (const [, , ex, ey, er] of eyes) { const g = c.createRadialGradient(ex, ey, er * 0.7, ex, ey, er * 1.5); g.addColorStop(0, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(ex - er * 2, ey - er * 2, er * 4, er * 4); }
    blood(c, true);
  }, true);
  spec.colorSpace = THREE.NoColorSpace; spec.wrapS = spec.wrapT = THREE.ClampToEdgeWrapping;
  return (crWingTexs[key] = { map, spec, drips });
}
// 耳朵（右耳：+x 朝外、+z 朝臉的前面）：扁扁的耳廓中間凹進去（耳甲），外圈捲起來的耳輪、裡面一道對耳輪、前面的耳屏、下面肉肉的耳垂
// 耳廓用頂點顏色：耳甲（凹進去的地方）暗紅褐色、邊緣紅一點
function crEar(parent, mat, plateMat) {
  const ear = new THREE.Group(); parent.add(ear);
  ear.add(new THREE.Mesh(geo('crEarPlate', () => {
    const g = new THREE.SphereGeometry(1, 28, 20), P = g.attributes.position, col = [], c0 = new THREE.Color('#e3a690'), c1 = new THREE.Color('#8a4a40'), c2 = new THREE.Color('#d9867a'), cc = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i), bowl = x > 0 ? Math.exp(-(((y + 0.12) / 0.42) ** 2) - (((z - 0.12) / 0.45) ** 2)) : 0;
      P.setXYZ(i, x * 0.075 - 0.07 * bowl * x, y * 0.31, z * 0.19);
      cc.copy(c0).lerp(c2, sstep(0.6, 0.95, Math.hypot(y, z))).lerp(c1, bowl * x * 0.75);
      col.push(cc.r, cc.g, cc.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }), plateMat));
  ear.add(new THREE.Mesh(tubeGeo('crHelix', [[0.02, 0.17, 0.14], [0.04, 0.25, 0.08], [0.05, 0.285, -0.03], [0.05, 0.21, -0.125], [0.05, 0.05, -0.175], [0.045, -0.12, -0.16], [0.04, -0.235, -0.1]],
    [0.022, 0.034, 0.042, 0.045, 0.045, 0.04, 0.034], 8, 26), mat));
  ear.add(new THREE.Mesh(tubeGeo('crAntihelix', [[0.045, 0.19, -0.03], [0.055, 0.09, -0.095], [0.055, -0.03, -0.1], [0.05, -0.13, -0.05]], [0.018, 0.026, 0.024, 0.018], 7, 14), mat));
  sph(ear, 1, 0.006, -0.245, -0.035, mat, 0.03, 0.07, 0.07, 14);     // 耳垂
  sph(ear, 1, 0.028, -0.06, 0.135, mat, 0.022, 0.042, 0.03, 10);      // 耳屏
  return ear;
}
// 翅膀上的眼睛（照設計圖是一顆一顆杏仁形的人眼）：眼球大半埋在翅膀裡，只從杏仁形的開口露出來；眼睛周圍的肉微微腫起來，
// 眼皮貼著眼球（跟頭上的眼睛一樣，見 crSnapLid）。顏色用頂點顏色：外圍是翅膀的奶油色、越靠近眼睛越紅腫，眼瞼緣暗紅色。
// 外圍沉到翅膀底下一點，看起來是從翅膀長出來的
const CR_WEYE_Z = -0.55;   // 眼球中心在翅膀後面多深（乘眼球半徑）
// cols：[外圍, 眼皮, 眼瞼緣, 開口裡面] 的顏色（預設是翅膀上紅腫的眼睛）
function crMoundGeo(R, cols = ['#d9a890', '#b25a54', '#5a0e12', '#2a0606']) {
  return geo('crMound' + R + cols.join(), () => {
    const NR = 36, NA = 56, C = new THREE.Vector3(0, 0, CR_WEYE_Z * R), p = new THREE.Vector3(), pos = [], col = [], idx = [];
    const [cOut, cIn, cRim, cHole] = cols.map(c => new THREE.Color(c)), cc = new THREE.Color();
    for (let i = 0; i <= NR; i++) for (let j = 0; j < NA; j++) {
      const rr = 1.6 * R * i / NR, a = j / NA * Math.PI * 2, dx = Math.cos(a) * rr, dy = Math.sin(a) * rr;
      p.set(dx, dy, R * 0.32 * (1 - sstep(0.5 * R, 1.25 * R, rr)) - 0.08 * sstep(0.8 * R, 1.5 * R, rr) - 0.01);
      const e = crSnapLid(p, C, Z_AXIS, dx, dy, R);
      pos.push(p.x, p.y, p.z);
      cc.copy(cOut).lerp(cIn, 1 - sstep(0.25 * R, 0.9 * R, e));
      if (e < 0.1 * R) cc.lerp(cRim, 1 - sstep(0, 0.1 * R, e));
      if (e < 0) cc.copy(cHole);
      col.push(cc.r, cc.g, cc.b);
    }
    for (let i = 0; i < NR; i++) for (let j = 0; j < NA; j++) { const a = i * NA + j, b = i * NA + (j + 1) % NA, c = a + NA, d = b + NA; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}
// 一顆眼睛：眼球（會轉）和虹膜；z 是眼球中心離 sock 多遠。m.lid 有的話加一片眨眼用的眼皮（只有眨眼時看得到，從上眼皮裡面蓋下來）
// cut：眼球只做離正面 cut 弧度以內的那一塊（翅膀上的眼睛後面切掉，從開口看不到，翅膀背面的包才不用那麼大）；
// 貼圖照完整的球對齊（正面 u = 0.25）
function crBallGeo(R, cut) {
  return geo('crBall' + R + ',' + cut, () => {
    if (!cut) return new THREE.SphereGeometry(R, 28, 20);
    const g = new THREE.SphereGeometry(R, 28, 14, 0, Math.PI * 2, 0, cut).rotateX(Math.PI / 2), P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      const ph = Math.atan2(P.getZ(i), -P.getX(i));
      U.setXY(i, (ph < -Math.PI / 2 ? ph + Math.PI * 2 : ph) / (Math.PI * 2), 1 - Math.acos(clamp(P.getY(i) / R, -1, 1)) / Math.PI);
    }
    return g;
  });
}
function crEye(parent, R, m, z = 0, cut = 0) {
  const sock = new THREE.Group(); parent.add(sock);
  const gaze = new THREE.Group(); gaze.rotation.order = 'YXZ'; gaze.position.z = z; sock.add(gaze);
  gaze.add(new THREE.Mesh(crBallGeo(R, cut), m.ball));
  gaze.add(new THREE.Mesh(irisGeo('crIris' + R, R, R * 0.42, 0), m.iris));
  let lid = null;
  if (m.lid) { lid = new THREE.Mesh(lidGeo('crLid' + R, R * 1.03, 0, 1.42), m.lid); lid.position.z = z; lid.rotation.x = -1.2; sock.add(lid); }
  return { sock, gaze, lid };
}
let crScleraTex, crIrisTex, crIrisWTex, lkWispTex;
function makeMonster5Textures() {
  if (crScleraTex) return;
  // 嬰兒的眼白：乾淨、有一點藍，細細的血絲
  crScleraTex = m5Tex('crSclera', 512, 256, c => {
    const W = 512, H = 256, cx = W / 4, cy = H / 2, img = c.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const lon = (x - cx) / W * Math.PI * 2, lat = (cy - y) / H * Math.PI, th = Math.acos(clamp(Math.cos(lat) * Math.cos(lon), -1, 1)), k = clamp((th - 0.5) / 1.4, 0, 1), i = (y * W + x) * 4;
      img.data[i] = 240 - k * 28; img.data[i + 1] = 240 - k * 75; img.data[i + 2] = 242 - k * 70; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    overlayDetail(c, 'sclera', W, H, 2, 0.6);
    drawVeins(c, cx, cy, 60, 130, 5, 8642, 0.6, W);
  }, true);
  // 虹膜：一絲一絲的放射紋、深色的外圈、很小的瞳孔（瞪著你）、反光
  const iris = (cols, pupil) => m5Tex('iris' + pupil, 256, 256, c => {
    const g = c.createRadialGradient(128, 128, 18, 128, 128, 124);
    cols.forEach((col, i) => g.addColorStop(i / (cols.length - 1), col));
    c.fillStyle = g; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.lineWidth = 2;
    for (let i = 0; i < 140; i++) { const a = i / 140 * Math.PI * 2 + rnd() * 0.03; c.strokeStyle = `rgba(${rnd() < 0.5 ? '20,24,28' : '220,226,230'},${0.15 + rnd() * 0.25})`; c.beginPath(); c.moveTo(128 + Math.cos(a) * (pupil + 6), 128 + Math.sin(a) * (pupil + 6)); c.lineTo(128 + Math.cos(a) * (96 + rnd() * 24), 128 + Math.sin(a) * (96 + rnd() * 24)); c.stroke(); }
    c.strokeStyle = 'rgba(20,22,26,.85)'; c.lineWidth = 12; c.beginPath(); c.arc(128, 128, 118, 0, 7); c.stroke();
    c.fillStyle = '#050505'; c.beginPath(); c.arc(128, 128, pupil, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.85)'; c.beginPath(); c.arc(100, 96, 13, 0, 7); c.fill();
  });
  crIrisTex = iris(['#585f64', '#7b858c', '#949da2', '#626a70'], 26);   // 嬰兒的頭：灰色帶一點藍（照設計圖）
  crIrisWTex = iris(['#4e463e', '#7a7062', '#8a8070', '#5e554a'], 22);  // 翅膀上的：灰褐色
  slIrisTex = iris(['#2a0e0b', '#5a2219', '#6e2c21', '#3a130e'], 30);    // 夢境切片：深紅褐色
  // 記憶洩漏源的細絲：淺色的細髮絲（乘上褐色），中間密、兩邊稀疏
  lkWispTex = m5Tex('lkWisp', 64, 256, c => {
    for (let i = 0; i < 70; i++) {
      const x = 32 + (rnd() + rnd() + rnd() - 1.5) * 34, end = 150 + rnd() * 106, g = 170 + rnd() * 70 | 0;
      c.strokeStyle = `rgba(${g},${g - 6},${g - 14},${(0.6 + rnd() * 0.35).toFixed(2)})`; c.lineWidth = 1 + rnd() * 1.6;
      c.beginPath(); c.moveTo(x, 0); c.bezierCurveTo(x + (rnd() - 0.5) * 8, end * 0.4, x + (rnd() - 0.5) * 12, end * 0.75, x + (rnd() - 0.5) * 14, end); c.stroke();
    }
  }, true);
  lkWispTex.wrapS = lkWispTex.wrapT = THREE.ClampToEdgeWrapping;
}
function buildCradle(r, g) {
  makeMonster5Textures();
  const T = { transparent: true };
  const skin = withDetail(ownLM('#ffffff', { map: m5Tex('cr', 2048, 1024, crPaintHead), shade: 0.75, ...T }), 'skin', 6, 0.55);
  skin.map.wrapS = THREE.ClampToEdgeWrapping;
  const earM = withDetail(ownLM('#e3a690', { shade: 0.8, ...T }), 'skin', 5, 1.1), earP = withDetail(ownLM('#ffffff', { vertexColors: true, shade: 0.85, ...T }), 'skin', 5, 1.1);
  const headEye = { ball: wetEyeMat(crScleraTex, 0x0a0808, 0x555555, T), iris: wetEyeMat(crIrisTex, 0x060606, 0x888888, T) };
  const wLidM = withDetail(ownLM('#a85650', { shade: 0.8, ...T }), 'skin', 7, 1.2);
  const wingEye = { ball: wetEyeMat(eyeballTex, 0x1a0808, 0x555555, T), iris: wetEyeMat(crIrisWTex, 0x060606, 0x888888, T), lid: wLidM };
  const mound = withDetail(ownPhong('#ffffff', { vertexColors: true, specular: 0x3a2020, shininess: 25, shade: 0.8, ...T }), 'skin', 7, 1.0);
  const bulge = withDetail(ownLM('#e6dab2', { shade: 0.8, ...T }), 'skin', 5, 0.6);
  const fur = withDetail(ownLM('#cdb57a', { shade: 0.85, ...T }), 'fur', 9, 0.8);
  r.mats.push(skin, earM, earP, headEye.ball, headEye.iris, wLidM, wingEye.ball, wingEye.iris, mound, bulge, fur);
  r.body = new THREE.Group(); r.body.position.y = CR_Y; g.add(r.body);
  r.head = new THREE.Group(); r.body.add(r.head);
  r.head.add(new THREE.Mesh(crHeadGeo(), skin));
  r.crEyes = [];
  // 頭上的兩顆眼睛：眼皮是頭的一部分（貼著眼球），睜得很大、上下都露出眼白，一直瞪著你、不眨眼
  for (const E of crEyes()) {
    const ey = crEye(r.head, CR_EYE.R, headEye);
    ey.sock.position.copy(E.C); ey.sock.quaternion.setFromUnitVectors(Z_AXIS, E.F);
    r.crEyes.push(ey);
  }
  const v = new THREE.Vector3();
  // 耳朵
  for (const s of [-1, 1]) {
    crHeadPt(s * 0.97, -0.36, 0.17, v);
    const ear = crEar(r.head, earM, earP);
    ear.position.set(v.x - s * 0.02, v.y, v.z - 0.12);
    ear.rotation.set(0.08, -s * 0.38, 0);
    ear.scale.set(s * 1.1, 1.1, 1.1);
  }
  // 後腦勺長翅膀的地方：一團毛茸茸的蛾胸
  const th = new THREE.Mesh(geo('crThorax', () => new THREE.SphereGeometry(1, 20, 16)), fur);
  th.position.set(0, -0.05, -1.08); th.scale.set(0.55, 0.85, 0.45); r.body.add(th);
  // 四片翅膀（左邊的翻過來）和翅膀上的眼睛
  r.wings = [];
  for (const w of ['U', 'L']) for (const s of [1, -1]) {
    const tx = crWingTex(w, s);
    const mat = ownPhong('#ffffff', { map: tx.map, specularMap: tx.spec, specular: 0x9a7070, shininess: 55, side: THREE.DoubleSide, alphaTest: 0.35, shade: 0.6, ...T });
    r.mats.push(mat);
    const wg = new THREE.Group(); wg.position.z = w === 'U' ? -0.9 : -0.97; wg.scale.x = s; r.body.add(wg);
    wg.add(new THREE.Mesh(crWingGeo(w), mat));
    wg.userData = { s, base: w === 'U' ? 0.12 : 0.08, amp: w === 'U' ? 0.16 : 0.12, lag: w === 'U' ? 0 : 0.55 };
    for (const e of CR_EYES) {
      if (e[0] !== w || e[1] !== s) continue;
      const [, , x, y, er] = e, R = er * CR_PX * 0.92, z = crWingZ(w, x, y);
      const n = new THREE.Vector3(-(crWingZ(w, x + 1, y) - crWingZ(w, x - 1, y)) / (2 * CR_PX), -(crWingZ(w, x, y + 1) - crWingZ(w, x, y - 1)) / (2 * CR_PX), 1).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, n);
      const ey = crEye(wg, R, wingEye, CR_WEYE_Z * R, 1.45);
      ey.sock.position.set(x * CR_PX, y * CR_PX, z); ey.sock.quaternion.copy(q);
      // 眼睛周圍腫起來的肉和眼皮、翅膀背面鼓起來的包（眼球從背面看不到）
      ey.sock.add(new THREE.Mesh(crMoundGeo(R), mound));
      const back = new THREE.Mesh(geo('crBulge' + R, () => new THREE.SphereGeometry(R * 1.22, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)), bulge);
      back.rotation.x = Math.PI / 2; back.scale.set(1.05, 0.95, 1.05); ey.sock.add(back);
      ey.jig = 0.08; ey.lim = 0.25; ey.ph = hash01(x * 0.37 + y * 0.11); ey.rate = 0.16 + hash01(x + y) * 0.1;
      r.crEyes.push(ey);
    }
    wg.userData.drips = tx.drips;
    r.wings.push(wg);
  }
  // 血珠：在血淚的尾端慢慢變大，滴下去掉到地上
  const dropM = ownPhong('#5a0408', { specular: 0xaa6666, shininess: 90, shade: 0.5, ...T });
  r.mats.push(dropM);
  r.drops = [];
  for (let i = 0; i < 4; i++) { const m = sph(g, 0.04, 0, 0, 0, dropM, 1, 1.5, 1, 10); m.visible = false; r.drops.push({ m, n: -1 }); }
}
const _crV = new THREE.Vector3();
// 眼睛全部盯著你（ey.jig 是會飄來飄去多少、ey.lim 最多轉幾度；有眨眼的眼皮就偶爾眨一下）
function crLook(r, t, dt, p) {
  r.crEyes.forEach((ey, i) => {
    _crV.set(p.x, 1.5, p.y); ey.sock.worldToLocal(_crV);
    const jig = ey.jig ?? 0.01, lim = ey.lim ?? 0.6;
    const yaw = clamp(Math.atan2(_crV.x, _crV.z) + Math.sin(t * (1.1 + i * 0.37) + i) * jig, -lim, lim);
    const pitch = clamp(Math.atan2(-_crV.y, Math.hypot(_crV.x, _crV.z)) + Math.cos(t * (0.9 + i * 0.29)) * jig, -lim * 0.8, lim * 0.8);
    const k = Math.min(1, dt * 8);
    ey.gaze.rotation.y += (yaw - ey.gaze.rotation.y) * k; ey.gaze.rotation.x += (pitch - ey.gaze.rotation.x) * k;
    if (ey.lid) { const ph = (t * ey.rate + ey.ph) % 1, b = ph < 0.04 ? Math.sin(ph / 0.04 * Math.PI) : 0; ey.lid.rotation.x = -1.2 + 1.8 * b; ey.lid.visible = b > 0.02; }
  });
}
function syncMonster5(e, r, t, p, d, dt) {
  if (e.kind === 'leak') { syncLeak(r, t, p, dt); return; }
  if (e.kind === 'daydream') { syncDaydream(r, t); return; }
  if (e.kind === 'slice') { syncSlice(r, t, p, dt); return; }
  if (e.kind === 'gaze') { syncGaze(r, t, p, dt); return; }
  if (e.kind === 'green') { syncGreen(r, t); return; }
  if (e.kind === 'clone') { syncClone(r, t); return; }
  // 搖籃囈語：像搖籃一樣慢慢左右搖、上下飄；翅膀慢慢搧（下面那片慢半拍）
  r.body.position.y = CR_Y + Math.sin(t * 0.8) * 0.12;
  r.body.rotation.z = Math.sin(t * 1.05) * 0.09;
  r.body.rotation.x = Math.sin(t * 0.8 + 1) * 0.035;
  for (const w of r.wings) { const f = w.userData; w.rotation.y = f.s * (f.base + f.amp * Math.sin(t * 1.6 - f.lag)); }
  crLook(r, t, dt, p);
  // 血珠：每 2.6 秒從一顆流血的眼睛滴一滴（先在血淚的尾端變大 1.2 秒，再掉下去）
  r.drops.forEach((dr, k) => {
    const P = 2.6, tt = t + k * 0.65, n = Math.floor(tt / P), tau = tt - n * P;
    if (n !== dr.n) {
      dr.n = n; dr.rel = null;
      const all = r.wings.flatMap(w => w.userData.drips.map(q => [w, q]));
      dr.src = all[Math.floor(hash01(n * 7.13 + k * 3.7) * all.length)];
    }
    const [w, q] = dr.src;
    if (tau < 1.2) {
      _crV.set(q.x * CR_PX, q.y * CR_PX, crWingZ(q.e[0], q.x, q.y) + 0.03); w.localToWorld(_crV); r.g.worldToLocal(_crV);
      dr.m.position.copy(_crV); dr.m.scale.set(tau / 1.2, tau / 1.2 * 1.5, tau / 1.2); dr.m.visible = true;
    } else {
      if (!dr.rel) dr.rel = dr.m.position.clone();
      const f = tau - 1.2, y = dr.rel.y - 4.9 * f * f;
      dr.m.position.set(dr.rel.x, y, dr.rel.z); dr.m.scale.set(0.8, 1.8, 0.8); dr.m.visible = y > 0.03;
    }
  });
}
// ---------- 記憶洩漏源（酆都級，20～30 公尺）----------
// 一顆灰白色、像石頭又像死掉的皮膚的巨大嬰兒頭，底部壓扁了靠在地上（肉往外垂成一圈摺）；臉小小的長在右下方、往下看著你：
// 兩個空空的黑眼窩、小小的鼻子、嘴巴微微張開。左下方裂開一個大洞，邊緣是撕開的皮和紅色的肉，洞裡塞滿黑色的頭髮，
// 頭髮後面有一張蒼白的臉，一隻眼睛從洞裡盯著你；洞裡伸出兩根又長又尖的米色骨爪（長的那根拄到地上），
// 幾縷褐色的細絲往左邊飄（設計圖上的細線），一點一點發光的「記憶」從洞裡飄出去
const LK_R = 12, LK_BASE = -0.82;   // 頭的半徑（公尺）、底部壓扁的高度（乘半徑）：整顆大約 22 公尺高
// 朝某個方向的座標系：f 往前、r 往右、u 往上（yaw 往 +x 轉、pitch 往上抬）
function lkFrame(yaw, pitch) {
  const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  return { f, r, u: new THREE.Vector3().crossVectors(f, r) };
}
// 臉在右下方、往下看；洞在左下方（照設計圖量）；洞的半寬、半高（單位球上）；洞裡那隻眼睛在洞的哪裡
const LK_FACE = lkFrame(0.4, -0.42), LK_HOLE = lkFrame(-0.27, -0.55), LK_HW = 0.25, LK_HH = 0.3, LK_IEYE = [-0.52, -0.33];
// 臉上的起伏（臉的座標：X 往右、Y 往上）：[X, Y, 寬, 高, 凸起多少（負的是凹）, 左右對稱, 邊緣多陡（1 是一般的高斯）, 種類（畫貼圖用）]
const LK_FEAT = [
  [0.26, 0.17, 0.085, 0.07, -0.09, 1, 2.5, 'sock'],   // 空空的眼窩（又深又陡）
  [0.26, 0.26, 0.12, 0.04, 0.02, 1, 1],               // 眉骨
  [0, 0.06, 0.05, 0.11, 0.015, 0, 1],                 // 鼻樑
  [0, -0.035, 0.06, 0.06, 0.045, 0, 1],               // 鼻子
  [0, -0.065, 0.04, 0.035, 0.022, 0, 1],              // 鼻頭
  [0.05, -0.08, 0.035, 0.03, 0.02, 1, 1],             // 鼻翼
  [0.03, -0.095, 0.018, 0.013, -0.025, 1, 1, 'nost'], // 鼻孔
  [0, -0.14, 0.02, 0.035, -0.008, 0, 1],              // 人中
  [0, -0.205, 0.11, 0.025, 0.03, 0, 1, 'lip'],        // 上唇
  [0, -0.237, 0.1, 0.013, -0.05, 0, 1.5, 'gap'],      // 嘴巴微微張開的縫
  [0.115, -0.235, 0.03, 0.025, -0.02, 1, 1],          // 嘴角
  [0, -0.272, 0.09, 0.03, 0.035, 0, 1, 'lip'],        // 下唇
  [0, -0.32, 0.09, 0.025, -0.012, 0, 1],              // 下唇底下的凹
  [0, -0.38, 0.12, 0.06, 0.03, 0, 1],                 // 下巴
  [0.3, -0.13, 0.17, 0.17, 0.06, 1, 1],               // 臉頰
];
// 單位球上的一點有什麼：d 凸起多少；sock、gap、lip、nost 是那種五官的份量（畫貼圖用）；rho 離洞的中心多遠（1 是洞的邊緣）、ha 在洞的哪個方向
const _lk = { d: 0, sock: 0, gap: 0, lip: 0, nost: 0, rho: 9, ha: 0, hx: 0, hy: 0 };
function lkShape(x, y, z) {
  const o = _lk, F = LK_FACE, H = LK_HOLE;
  o.d = 0; o.sock = 0; o.gap = 0; o.lip = 0; o.nost = 0; o.rho = 9;
  const fz = x * F.f.x + y * F.f.y + z * F.f.z;
  if (fz > 0.55) {
    const fx = x * F.r.x + y * F.r.y + z * F.r.z, fy = x * F.u.x + y * F.u.y + z * F.u.z, w = sstep(0.55, 0.8, fz);
    for (const f of LK_FEAT) for (const s of f[5] ? [-1, 1] : [1]) {
      const u = (fx - s * f[0]) / f[2], v = (fy - f[1]) / f[3], q = u * u + v * v;
      if (q > 16) continue;
      const g = Math.exp(-(q ** f[6])) * w;
      o.d += f[4] * g;
      if (f[7]) o[f[7]] = Math.max(o[f[7]], g);
    }
  }
  const hz = x * H.f.x + y * H.f.y + z * H.f.z;
  if (hz > 0.7) {
    const hx = (x * H.r.x + y * H.r.y + z * H.r.z) / LK_HW, hy = (x * H.u.x + y * H.u.y + z * H.u.z) / LK_HH, a = Math.atan2(hy, hx);
    const rho = Math.hypot(hx, hy) / (1 + 0.12 * Math.sin(5 * a + 1) + 0.07 * Math.sin(9 * a + 2) + 0.05 * Math.sin(14 * a + 0.3));
    o.rho = rho; o.ha = a; o.hx = hx; o.hy = hy;
    const fd = Math.hypot(hx - LK_IEYE[0], (hy - LK_IEYE[1]) * 0.8);
    o.d += -0.33 * sstep(1, 0.86, rho) + 0.03 * Math.sin(hx * 9) * Math.sin(hy * 7) * sstep(0.95, 0.6, rho)   // 洞底凹凸不平
      + 0.12 * Math.exp(-((fd / 0.38) ** 2)) * sstep(1, 0.8, rho)                                            // 洞裡那張臉往外擠
      + 0.035 * Math.exp(-(((rho - 1.03) / 0.05) ** 2)) * (0.55 + 0.45 * Math.sin(23 * a + 1.7))             // 撕開翻出來的皮
      + 0.012 * Math.exp(-(((rho - 1.35) / 0.25) ** 2));                                                     // 洞周圍腫起來
  }
  return o;
}
// 單位球上的點 → 頭（公尺，原點是頭的中心）：靠近地面的肉往外垂成一圈摺（摺上有一點皺），底部壓扁貼在地上
function lkHeadPt(x, y, z, out) {
  const o = lkShape(x, y, z);
  const k = 1 + o.d + 0.045 * Math.exp(-(((y + 0.7) / 0.09) ** 2)) + 0.012 * Math.sin(Math.atan2(x, z) * 7) * Math.exp(-(((y + 0.66) / 0.05) ** 2));
  let Y = y * k * 1.04;
  if (Y < LK_BASE) Y = LK_BASE + (Y - LK_BASE) * 0.06;
  return out.set(x * k * LK_R, Y * LK_R, z * k * LK_R);
}
// 洞的座標（hx、hy：洞的半寬、半高是 1）→ 頭上那一點（公尺）；out 是再往洞外（正的）或洞裡推幾公尺
function lkHolePt(hx, hy, out = 0) {
  const H = LK_HOLE, v = new THREE.Vector3().copy(H.f).addScaledVector(H.r, hx * LK_HW).addScaledVector(H.u, hy * LK_HH).normalize();
  return lkHeadPt(v.x, v.y, v.z, new THREE.Vector3()).addScaledVector(H.f, out);
}
const lkU = crWarp(-Math.PI, Math.PI, a => 1 + 1.4 * Math.exp(-(((a - 0.15) / 0.75) ** 2)));
const lkV = crWarp(0, Math.PI, th => 1 + 1.5 * Math.exp(-(((th - 2.1) / 0.5) ** 2)));
const lkHeadGeo = () => sculptGeo('lkHead', lkHeadPt, lkU, lkV, th => sstep(1.3, 1.45, th) * (1 - sstep(2.85, 3.0, th)), a => sstep(-0.95, -0.8, a) * (1 - sstep(1.25, 1.4, a)), [0.013, 0.015]);
// 頭的貼圖（一個一個像素算，跟頭的形狀用同一個 lkShape）：灰白色、斑駁的皮膚，一塊一塊粉紅米色（設計圖左邊塗了粉紅），
// 靠近地面又暗又髒；黑洞洞的眼窩和鼻孔、灰紫色的嘴唇、張開的嘴縫；洞裡是暗紅色的肉，洞裡那張蒼白的臉，
// 邊緣撕開的皮是紅色的肉、外面一圈瘀青；最後畫從洞往外裂開的紋路和底部的皺摺
function lkPaintHead(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, A = new Float32Array(W), TH = new Float32Array(H);
  for (let x = 0; x < W; x++) A[x] = lkU.inv((x + 0.5) / W);
  for (let y = 0; y < H; y++) TH[y] = lkV.inv((y + 0.5) / H);
  const mix = (o, col, k) => { o[0] += (col[0] - o[0]) * k; o[1] += (col[1] - o[1]) * k; o[2] += (col[2] - o[2]) * k; }, C = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const st = Math.sin(TH[y]), py = Math.cos(TH[y]);
    for (let x = 0; x < W; x++) {
      const px = st * Math.sin(A[x]), pz = st * Math.cos(A[x]), o = lkShape(px, py, pz);
      const n1 = Math.sin(px * 9.1 + py * 3.7) * Math.sin(py * 8.3 - pz * 5.1 + 1.3) * Math.sin(pz * 7.7 + px * 2.9 + 0.4);
      const n2 = Math.sin(px * 23 + pz * 11) * Math.sin(py * 19 + 2) * Math.sin(pz * 21 - px * 7);
      C[0] = 166 + n1 * 16 + n2 * 7; C[1] = 163 + n1 * 15 + n2 * 7; C[2] = 160 + n1 * 13 + n2 * 7;
      mix(C, [198, 170, 158], clamp((0.5 + 0.5 * Math.sin(px * 3.1 + 1.1) * Math.sin(py * 2.7 + pz * 1.9)) * 0.35 + sstep(0.1, -0.7, px) * 0.3, 0, 1));
      mix(C, [104, 98, 94], sstep(-0.5, -0.8, py) * 0.45);
      if (o.sock) { mix(C, [70, 62, 62], sstep(0.05, 0.4, o.sock) * 0.6); mix(C, [6, 5, 5], sstep(0.35, 0.8, o.sock)); }
      if (o.lip) mix(C, [148, 118, 122], o.lip * 0.7);
      if (o.gap) mix(C, [16, 7, 7], sstep(0.25, 0.7, o.gap));
      if (o.nost) mix(C, [20, 12, 12], sstep(0.3, 0.8, o.nost));
      if (o.rho < 1.7) {
        const r = o.rho, a = o.ha;
        mix(C, [138, 112, 128], (1 - sstep(1.1, 1.7, r)) * 0.5);                                    // 瘀青
        if (r < 1.14) {
          mix(C, [192, 136, 126], sstep(1.14, 1.06, r + 0.02 * Math.sin(a * 31)));                // 翻開的皮
          mix(C, [150, 62, 60], sstep(1.06, 1.0, r));                                              // 紅色的肉
          mix(C, [74, 16, 18], sstep(1.0, 0.95, r));
          mix(C, [22, 9, 9], sstep(0.96, 0.88, r));                                                // 洞裡又深又暗
          const fd = Math.hypot(o.hx - LK_IEYE[0], (o.hy - LK_IEYE[1]) * 0.8);                     // 洞裡那張蒼白的臉
          if (r < 0.9) mix(C, [178, 162, 152], (1 - sstep(0.12, 0.42, fd)) * 0.85);
        }
      }
      const i = (y * W + x) * 4;
      D[i] = C[0]; D[i + 1] = C[1]; D[i + 2] = C[2]; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // 從洞往外裂開的紋路、底部垂下來那圈肉的皺摺
  const r = seeded(4040), H0 = LK_HOLE, v = new THREE.Vector3();
  const toPx = (hx, hy) => { v.copy(H0.f).addScaledVector(H0.r, hx * LK_HW).addScaledVector(H0.u, hy * LK_HH).normalize(); return [lkU(Math.atan2(v.x, v.z)) * W, lkV(Math.acos(clamp(v.y, -1, 1))) * H]; };
  c.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    let a = r() * Math.PI * 2, d = 1.08;
    const n = 6 + (r() * 10 | 0);
    c.strokeStyle = `rgba(70,52,54,${(0.22 + r() * 0.2).toFixed(2)})`; c.lineWidth = 1.2 + r() * 1.3; c.beginPath(); c.moveTo(...toPx(Math.cos(a) * d, Math.sin(a) * d));
    for (let k = 0; k < n; k++) { a += (r() - 0.5) * 0.12; d += 0.03 + r() * 0.03; c.lineTo(...toPx(Math.cos(a) * d, Math.sin(a) * d)); }
    c.stroke();
  }
  for (const th of [2.5, 2.56, 2.63]) {
    c.strokeStyle = 'rgba(60,54,52,.35)'; c.lineWidth = 3; c.beginPath();
    for (let u = 0; u <= 1.0001; u += 0.004) c.lineTo(u * W, lkV(th + 0.012 * Math.sin(u * 60)) * H);
    c.stroke();
  }
}
function buildLeak(r, g) {
  makeMonster5Textures();
  const T = { transparent: true };
  const skin = withDetail(ownLM('#ffffff', { map: m5Tex('lk', 2048, 1024, lkPaintHead), shade: 0.8, ...T }), 'skin', 1.2, 0.6);
  skin.map.wrapS = THREE.ClampToEdgeWrapping;
  const bone = withDetail(ownPhong('#cfae84', { specular: 0x2a2a2a, shininess: 18, shade: 0.8, ...T }), 'bone', 1.4, 0.9);
  const eyeM = { ball: wetEyeMat(crScleraTex, 0x0a0808, 0x555555, T), iris: wetEyeMat(crIrisWTex, 0x060606, 0x888888, T), lid: withDetail(ownLM('#a8988e', { shade: 0.8, ...T }), 'skin', 5, 1) };
  const mound = withDetail(ownPhong('#ffffff', { vertexColors: true, specular: 0x2a2020, shininess: 20, shade: 0.8, ...T }), 'skin', 5, 1);
  const hair = hairMat(strandTex, 0.6), wisp = hairMat(lkWispTex, 0.5);
  hair.userData.hair.uHAmp.value = 0.25; wisp.color.set('#8a6448'); wisp.userData.hair.uHAmp.value = 0.6;
  r.hairU = [hair.userData.hair, wisp.userData.hair];
  r.mats.push(skin, bone, eyeM.ball, eyeM.iris, eyeM.lid, mound, hair, wisp);
  r.body = new THREE.Group(); r.body.position.y = -LK_BASE * LK_R; g.add(r.body);
  r.body.add(new THREE.Mesh(lkHeadGeo(), skin));
  const H = LK_HOLE, yawH = Math.atan2(H.f.x, H.f.z), rr = seeded(77);
  // 洞裡那張臉的眼睛：嵌在洞底，一直盯著你
  const R = 0.45, ey = crEye(r.body, R, eyeM, CR_WEYE_Z * R, 1.45);
  ey.sock.position.copy(lkHolePt(LK_IEYE[0], LK_IEYE[1], 0.05)); ey.sock.quaternion.setFromUnitVectors(Z_AXIS, H.f);
  ey.sock.add(new THREE.Mesh(crMoundGeo(R, ['#a89890', '#b4a49a', '#4a2a28', '#1a0808']), mound));
  ey.lim = 0.4; ey.jig = 0.03; ey.ph = 0.2; ey.rate = 0.09;
  r.crEyes = [ey];
  // 黑頭髮：長在洞裡上半部，垂下來、從洞的下緣掛出去
  const strands = [];
  for (let i = 0; i < 130; i++) {
    let hx = -0.85 + rr() * 1.6;
    if (Math.abs(hx - LK_IEYE[0]) < 0.2) hx += hx < LK_IEYE[0] ? -0.2 : 0.2;   // 眼睛那裡分開
    const top = Math.sqrt(Math.max(0, 1 - hx * hx)) * 0.85, out = rr() < 0.55, a = lkHolePt(hx, top - rr() * 0.1, -0.4);
    const c = out ? lkHolePt(hx * 0.9 + (rr() - 0.5) * 0.15, -1.08 - rr() * 0.12, 0.4 + rr() * 0.5) : lkHolePt(hx + (rr() - 0.5) * 0.2, -0.3 - rr() * 0.5, 1.2 + rr() * 0.8);
    const b = a.clone().lerp(c, 0.4).addScaledVector(H.f, 1.4 + rr() * 1.2);
    const d = out ? c.clone().add(new THREE.Vector3((rr() - 0.5) * 1.2, -1.5 - rr() * 3, 0)).addScaledVector(H.f, 0.3) : c.clone().add(new THREE.Vector3((rr() - 0.5) * 0.6, -0.6 - rr(), 0));
    d.y = Math.max(d.y, LK_BASE * LK_R + 0.15);
    strands.push({ a: a.toArray(), b: b.toArray(), c: c.toArray(), d: d.toArray(), w: 0.16 + rr() * 0.18, f: yawH + (rr() - 0.5) * 0.9, ph: rr() * 6, tp: 0.55 });
  }
  r.body.add(new THREE.Mesh(hairGeo('lkHair', strands, 12), hair));
  // 褐色的細絲：從洞的左邊往左飄
  const ws = [];
  for (let i = 0; i < 9; i++) {
    const a = lkHolePt(-0.85 + rr() * 0.4, -0.25 + rr() * 0.6, 0.2), L = 7 + rr() * 4;
    ws.push({ a: a.toArray(), b: [a.x - L * 0.35, a.y + 0.6 * rr(), a.z + 1], c: [a.x - L * 0.7, a.y - 0.4 + rr(), a.z + 1.4], d: [a.x - L, a.y - 0.8 + rr() * 2, a.z + 1 + rr() * 2], w: 0.2 + rr() * 0.2, f: 0.3 + rr() * 0.4, ph: rr() * 6, tp: 0.6 });
  }
  r.body.add(new THREE.Mesh(hairGeo('lkWisp', ws, 14), wisp));
  // 兩根骨爪：從洞裡伸出來，長的那根往左下拄到地上、短的往左邊伸；一節一節的關節，尾端很尖（在出口那裡會動）
  r.claws = [];
  const ground = LK_BASE * LK_R + 0.05;
  for (const [key, pts, rad] of [
    ['lkClaw1', [lkHolePt(0.45, 0.15, -3.5), lkHolePt(0.15, -0.45, 4.6)], [0.55, 0.62, 0.55, 0.58, 0.5, 0.53, 0.44, 0.47, 0.36, 0.24, 0.1, 0.02]],
    ['lkClaw2', [lkHolePt(0.2, 0.5, -3.5), lkHolePt(-0.45, 0.3, 4.8)], [0.45, 0.5, 0.44, 0.47, 0.4, 0.42, 0.34, 0.25, 0.14, 0.04, 0.012]],
  ]) {
    const E = pts[1], long = key === 'lkClaw1';
    const rest = long ? [[-3, -2.8, 1.4], [-6, -5.6, 2.2], [-8.6, -99, 2.8]] : [[-3.6, -0.5, -0.3], [-7, -0.6, -1.1], [-10, -0.4, -2.2]];
    const all = [pts[0], E, ...rest.map(q => new THREE.Vector3(E.x + q[0], Math.max(ground, E.y + q[1]), E.z + q[2]))];
    const cg = new THREE.Group(); cg.position.copy(E); r.body.add(cg);
    cg.add(new THREE.Mesh(tubeGeo(key, all.map(q => [q.x - E.x, q.y - E.y, q.z - E.z]), rad, 10, 48), bone));
    r.claws.push(cg);
  }
  // 從洞裡飄出去的記憶：淡淡發光的光點
  r.motes = [];
  for (let i = 0; i < 14; i++) { const m = ownSprite(glowTex, i % 3 ? 0xcfe2ff : 0xffe8c8); r.body.add(m); r.motes.push(m); }
  r.moteO = lkHolePt(-0.1, 0, 0.5);
}
function syncLeak(r, t, p, dt) {
  // 慢慢地呼吸（整顆一脹一縮）、骨爪偶爾抽一下、頭髮和細絲飄
  r.body.scale.setScalar(1 + 0.006 * Math.sin(t * 0.6));
  r.body.rotation.z = Math.sin(t * 0.23) * 0.008;
  r.claws.forEach((c, i) => { c.rotation.set(Math.sin(t * 0.5 + i) * 0.02, 0, Math.sin(t * 0.7 + i * 2) * 0.025 + (Math.sin(t * 2.3 + i) > 0.97 ? 0.03 : 0)); });
  for (const u of r.hairU) u.uHT.value = t;
  r.hairU[1].uHDrag.value.set(-0.4 + Math.sin(t * 0.4) * 0.3, 0.2);
  // 記憶的光點：從洞口飄出來，往外、往上，越飄越淡
  const H = LK_HOLE;
  r.motes.forEach((m, i) => {
    const ph = (t * 0.07 + i / r.motes.length) % 1, k = Math.sin(ph * Math.PI);
    m.position.copy(r.moteO).addScaledVector(H.f, ph * 9).addScaledVector(H.r, Math.sin(ph * 5 + i * 1.7) * 2 - ph * 3).add(_crV.set(0, ph * 7 + Math.sin(i) * 0.5, 0));
    m.material.opacity = k * 0.4; m.scale.setScalar(0.2 + 0.2 * k + (i % 3) * 0.08);
  });
  crLook(r, t, dt, p);
}
// ---------- 白日夢（鬼將級，10.2～15.7 公尺）----------
// 一大團軟軟的、奶油黃帶一點桃色的肉，像雲一樣飄在半空（大約 16 公尺長、最高 10.4 公尺），左邊厚、右邊薄，上面有幾道摺痕，
// 底下垂著一條一條黃黃的黏液（設計圖上的黃色直線），一滴一滴往下滴。左邊那頭是一張睡著的臉：閉著眼睛、又長又直的鼻子、豐滿的嘴唇，
// 左半邊是桃色的；臉底下是一條像融化的蠟一樣往下流的脖子，接到地上。地上躺著一條長長的手臂一樣的東西，往右延伸、尾端是一顆圓球；
// 左下方是一層一層攤在地上的融化的肉。整團慢慢地呼吸、臉輕輕地晃，像在做夢
// 尺寸照設計圖量（1 像素 ≈ 1.24 公分，原點是雲的中間、地上）
const DM_PX = 0.0124, dmX = xp => (xp - 690) * DM_PX, dmY = yp => (900 - yp) * DM_PX;
// 雲的上緣、下緣（設計圖上的像素 → 公尺）：左邊厚、右邊薄
const DM_TOP = [[30, 175], [100, 150], [180, 92], [300, 64], [420, 72], [550, 60], [700, 64], [790, 112], [860, 150], [1000, 172], [1150, 192], [1290, 236], [1350, 262]].map(([x, y]) => [dmX(x), dmY(y)]);
const DM_BOT = [[30, 440], [100, 470], [250, 545], [450, 562], [650, 548], [900, 484], [1100, 442], [1250, 402], [1350, 372]].map(([x, y]) => [dmX(x), dmY(y)]);
const dmTab = (T, x) => {
  if (x <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const k = sstep(0, 1, (x - T[i - 1][0]) / (T[i][0] - T[i - 1][0])); return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * k; }
  return T[T.length - 1][1];
};
// 雲上的摺痕（設計圖上三道「︵」形的線）：[x, y, 半寬]（公尺）
const DM_FOLD = [[dmX(665), dmY(292), 0.85], [dmX(845), dmY(205), 0.7], [dmX(1005), dmY(305), 0.7]];
// 雲：單位球的 y 是雲長的方向（頭頂 y = 1 是左邊那頭），x、z 繞一圈（z 是前面、x 是上面）。斷面上面圓鼓鼓、下面平一點，表面一坨一坨；
// 上下緣照設計圖，兩頭照球的形狀收起來
function dmCloudPt(x, y, z, out) {
  const s = Math.sqrt(Math.max(0, 1 - y * y)), X = -y * 8.25, cx = s > 1e-6 ? x / s : 0, cz = s > 1e-6 ? z / s : 1;
  const top = dmTab(DM_TOP, X), bot = dmTab(DM_BOT, X), yc = (top + bot) / 2, hy = (top - bot) / 2, k = Math.sqrt(s);   // 兩頭圓圓的收起來
  const D = (0.5 + hy * 0.75) * (1 - 0.12 * Math.max(0, -cx));   // 前後的厚度（跟上下一樣跟著變薄，兩頭才是圓的；下面收一點）
  let r = 1 + (0.07 * Math.sin(X * 1.3 + cx * 2) * Math.sin(cz * 3 + X * 0.7) + 0.035 * Math.sin(X * 3.1 + cz * 4 + cx * 2.3) + 0.06 * Math.max(0, cx) * Math.sin(X * 0.9 + 1.7)) * sstep(0.05, 0.5, s);   // 兩頭的尖端不要有皺（不然會像肚臍）
  const Y0 = yc + cx * hy * k, Z0 = cz * D * k, fr = sstep(0.2, 0.7, cz);
  for (const [fx, fy, fw] of DM_FOLD) {   // 摺痕：一道拱起來的凹痕，上面鼓一點
    const u = (X - fx) / fw;
    if (Math.abs(u) > 1.6) continue;
    const arc = fy + 0.3 * (1 - u * u), dv = Y0 - arc, w = Math.exp(-u * u * 1.4) * fr;
    r += (-0.05 * Math.exp(-((dv / 0.09) ** 2)) + 0.025 * Math.exp(-(((dv - 0.22) / 0.16) ** 2))) * w;
  }
  r += 0.04 * Math.exp(-(((Y0 - bot - 0.55) / 0.14) ** 2)) * fr * sstep(-2.5, -1, X);   // 下緣上面一道摺（設計圖底下那兩條線）
  return out.set(X, yc + (Y0 - yc) * r, Z0 * r);
}
const dmCU = crWarp(-Math.PI, Math.PI, () => 1), dmCV = crWarp(0, Math.PI, th => 1 + 0.8 * Math.sin(th));
const dmCloudGeo = () => sculptGeo('dmCloud', dmCloudPt, dmCU, dmCV, () => 0.6, () => 0.6, [0.02, 0.025], [0.04, 0.045]);
// 雲的貼圖（u 繞一圈：0.5 前面、0.75 上面、0.25 下面；v 從左邊那頭到右邊）：奶油色，上面亮、下面桃色，一筆一筆往下的黃色（設計圖），摺痕的陰影
function dmPaintCloud(c, W, H) {
  const r = seeded(808);
  c.fillStyle = '#efe5c6'; c.fillRect(0, 0, W, H);
  const band = (u0, u1, col) => { const g = c.createLinearGradient(u0 * W, 0, u1 * W, 0); g.addColorStop(0, rgbaOf(col, 0)); g.addColorStop(0.5, rgbaOf(col, 1)); g.addColorStop(1, rgbaOf(col, 0)); return g; };
  c.globalAlpha = 0.5; c.fillStyle = band(0.05, 0.45, '#dea482'); c.fillRect(0, 0, W, H);   // 下面桃色
  c.globalAlpha = 0.35; c.fillStyle = band(0.55, 0.95, '#fbf6e6'); c.fillRect(0, 0, W, H);  // 上面亮
  c.globalAlpha = 1;
  // 左邊那頭（臉那邊）桃色多一點
  let g = c.createLinearGradient(0, 0, 0, H * 0.4); g.addColorStop(0, 'rgba(226,160,124,.45)'); g.addColorStop(1, 'rgba(226,160,124,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H * 0.4);
  // 斑駁
  for (let i = 0; i < 900; i++) {
    const x = r() * W, y = r() * H, rr = 8 + r() * 40, col = r() < 0.5 ? '#e7d07a' : r() < 0.5 ? '#f7efd8' : '#d9a88a';
    g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, rgbaOf(col, 0.12 + r() * 0.1)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // 往下的黃色筆觸：從前面往下面（u 0.55 → 0.2），越往右邊越多（設計圖）
  c.lineCap = 'round'; c.filter = 'blur(5px)';
  for (let i = 0; i < 150; i++) {
    const y = H * (0.15 + r() * 0.8), u0 = 0.42 + r() * 0.16, u1 = u0 - 0.1 - r() * 0.22;
    c.strokeStyle = `rgba(${r() < 0.7 ? '230,206,74' : '220,150,110'},${(0.06 + r() * 0.12).toFixed(2)})`; c.lineWidth = 2 + r() * 9;
    c.beginPath(); c.moveTo(u0 * W, y); c.lineTo(u1 * W, y + (r() - 0.5) * 16); c.stroke();
  }
  c.filter = 'none';
  // 兩頭（貼圖的最上面、最下面幾排）換成一樣的顏色，不然會畫出放射狀的紋路
  for (const [y0, y1] of [[0, H * 0.07], [H, H * 0.93]]) { g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(238,226,196,1)'); g.addColorStop(1, 'rgba(238,226,196,0)'); c.fillStyle = g; c.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); }
  // 摺痕的陰影（跟形狀上的摺痕同一個位置）
  for (const [fx, fy, fw] of DM_FOLD) {
    c.strokeStyle = 'rgba(150,100,70,.35)'; c.lineWidth = 5; c.beginPath();
    for (let u = -1; u <= 1.001; u += 0.05) {
      const X = fx + u * fw, Yp = fy + 0.3 * (1 - u * u), top = dmTab(DM_TOP, X), bot = dmTab(DM_BOT, X), cx = clamp((Yp - (top + bot) / 2) / ((top - bot) / 2), -0.99, 0.99);
      c.lineTo(dmCU(Math.atan2(cx, Math.sqrt(1 - cx * cx))) * W, dmCV(Math.acos(clamp(-X / 8.25, -1, 1))) * H);
    }
    c.stroke();
  }
}
// 睡著的臉：一張長長的臉（像面具一樣從雲裡凸出來，後腦勺埋在雲裡），閉著的眼皮鼓鼓的、睫毛往下，又長又直的鼻子，豐滿的嘴唇
const DM_HEAD = { rx: 1.65, ry: 2.9, rz: 1.55 };
const DM_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]（單位球上，正面看；五官的大小照設計圖的比例）
  [0, 0.55, 0.65, 0.35, 0.02, 0],          // 額頭
  [0.33, 0.3, 0.26, 0.07, 0.035, 1],       // 眉骨
  [0, 0.28, 0.08, 0.06, 0.01, 0],          // 眉心
  [0.33, 0.17, 0.25, 0.13, -0.05, 1],      // 眼窩
  [0.33, 0.175, 0.2, 0.065, 0.04, 1],      // 閉著的上眼皮（蓋著眼球，鼓鼓的）
  [0.33, 0.135, 0.2, 0.014, -0.018, 1],    // 眼皮閉起來的那條縫
  [0.33, 0.11, 0.18, 0.03, 0.01, 1],       // 下眼皮
  [0, 0.08, 0.075, 0.22, 0.06, 0],         // 鼻樑
  [0, -0.1, 0.11, 0.1, 0.09, 0],           // 鼻子
  [0, -0.18, 0.08, 0.05, 0.05, 0],         // 鼻頭
  [0.1, -0.205, 0.06, 0.04, 0.035, 1],     // 鼻翼
  [0.055, -0.225, 0.028, 0.014, -0.035, 1],// 鼻孔
  [0, -0.28, 0.03, 0.045, -0.012, 0],      // 人中
  [0, -0.34, 0.24, 0.035, 0.045, 0],       // 上唇
  [0.05, -0.325, 0.04, 0.02, 0.012, 1],    // 唇峰
  [0, -0.372, 0.27, 0.013, -0.035, 0],     // 嘴縫
  [0.27, -0.37, 0.04, 0.03, -0.02, 1],     // 嘴角
  [0, -0.405, 0.19, 0.04, 0.05, 0],        // 下唇
  [0, -0.48, 0.16, 0.035, -0.02, 0],       // 下唇底下的凹
  [0, -0.6, 0.2, 0.11, 0.045, 0],          // 下巴
  [0.5, 0, 0.2, 0.13, 0.04, 1],            // 顴骨
  [0.22, -0.27, 0.04, 0.1, -0.012, 1],     // 法令紋
  [0.45, -0.3, 0.18, 0.14, -0.02, 1],      // 兩頰有一點凹
  [0.75, 0.25, 0.15, 0.25, -0.025, 1],     // 太陽穴
];
// R 是頭的半徑（綠溫室的臉用同一套五官，頭圓一點）
function dmHeadPt(x, y, z, out, R = DM_HEAD) {
  let X = x, Z = z;
  if (y < 0) { const t = -y; X *= 1 - 0.24 * t * t; if (Z > 0) Z *= 1 + 0.15 * sstep(0.1, 0.8, t) * (1 - 0.5 * sstep(0.85, 1, t)); }
  if (Z > 0) Z *= 1 - 0.12 * Math.max(0, 1 - Math.abs(x) * 1.4);   // 臉的正面平一點（不像雞蛋）
  let d = 0;
  if (z > 0.05) {
    for (const f of DM_FACE) for (const s of f[5] ? [-1, 1] : [1]) {
      const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3];
      if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v);
    }
    d *= sstep(0.05, 0.4, z);
  }
  const k = 1 + d / (Math.hypot(X, y, Z) || 1);
  return out.set(X * k * R.rx, y * k * R.ry, Z * k * R.rz);
}
const dmU = crWarp(-Math.PI, Math.PI, a => 1 + 1.6 * Math.exp(-((a / 0.75) ** 2))), dmV = crWarp(0, Math.PI, th => 1 + 1.4 * Math.exp(-(((th - 1.75) / 0.6) ** 2)));
const dmHeadGeo = () => sculptGeo('dmHead', dmHeadPt, dmU, dmV, th => sstep(0.9, 1.05, th) * (1 - sstep(2.5, 2.7, th)), a => sstep(-0.85, -0.7, a) * (1 - sstep(0.7, 0.85, a)));
// 臉的貼圖：淡淡的膚色，左半邊桃色（設計圖），閉著的眼睛（往下彎的睫毛）、淡淡的眉毛、鼻子的陰影、玫瑰色的嘴唇
// o.tone 皮膚的底色、o.peach 左半邊帶桃色（白日夢；綠溫室的臉不用）、o.seed 斑點
function dmPaintFace(c, W, H, o = {}) {
  const { at, soft, curve } = headPainter(c, W, H, dmU, dmV), r = seeded(o.seed || 321), sh = '#8a5a40';
  c.fillStyle = o.tone || '#efdcc2'; c.fillRect(0, 0, W, H);
  const g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0.22, 'rgba(228,160,120,.5)'); g.addColorStop(0.45, 'rgba(228,160,120,.28)'); g.addColorStop(0.6, 'rgba(228,160,120,0)');
  c.fillStyle = g; if (o.peach !== false) c.fillRect(0, 0, W, H);
  for (let i = 0; i < 900; i++) { const x = r() * W, y = r() * H, rr = 5 + r() * 24, col = r() < 0.5 ? '#e0a088' : '#f6ead6'; const gr = c.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, rgbaOf(col, 0.1)); gr.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = gr; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
  for (const s of [-1, 1]) at(s * 0.33, 0.14, () => {
    soft(0, 2, 26, 14, sh, 0.26);                                                  // 眼窩的影子
    soft(0, 4, 20, 6, '#d49482', 0.3);                                              // 眼皮紅一點
    soft(0, -1, 20, 2.2, '#5a3428', 0.5);                                           // 閉起來的眼縫的陰影
    c.fillStyle = 'rgba(64,36,28,.8)'; c.beginPath(); c.moveTo(-20, 1); c.quadraticCurveTo(0, -4, 20, 0.6); c.quadraticCurveTo(0, -2.8, -20, 1); c.fill();   // 閉著的眼縫
    for (let i = 0; i < 40; i++) { const t = i / 39, x = -18 + t * 36, y = -3.6 * (1 - (2 * t - 1) ** 2) + 0.6; curve([x, y, x + (t - 0.5) * 2.5, y - 2.2 - r() * 0.9], 'rgba(56,34,26,.55)', 0.45); }   // 往下的睫毛
    curve([-17, 8.2, 0, 12.6, 18, 7.6], rgbaOf(sh, 0.16), 0.7);   // 眼皮的摺痕
    for (let i = 0; i < 44; i++) { const t = i / 43, x = -20 + t * 41, y = 16 + 3 * Math.sin(t * Math.PI) - t * 2 + (r() - 0.5); curve([x, y, x + 2, y + 0.8], 'rgba(140,100,74,.28)', 0.5); }   // 淡淡的眉毛
  }, s);
  at(0, -0.08, () => { for (const s of [-1, 1]) soft(s * 10, 6, 4.5, 18, sh, 0.2); soft(0, -9, 6.5, 4, '#e09a86', 0.2); soft(0, 8, 3, 12, '#ffffff', 0.12); });
  for (const s of [-1, 1]) at(s * 0.055, -0.225, () => { c.fillStyle = 'rgba(64,30,26,.85)'; c.beginPath(); c.ellipse(0, 0, 2.6, 1.3, -0.2, 0, 7); c.fill(); }, s);
  for (const s of [-1, 1]) at(s * 0.22, -0.27, () => soft(0, 0, 2.5, 9, sh, 0.2), s);   // 法令紋
  at(0, -0.372, () => {
    c.fillStyle = '#c47e6e';
    c.beginPath(); c.moveTo(-26, 0); c.bezierCurveTo(-15, 2.4, -7, 5.6, -3, 5); c.quadraticCurveTo(0, 3.8, 3, 5); c.bezierCurveTo(7, 5.6, 15, 2.4, 26, 0); c.quadraticCurveTo(0, -1, -26, 0); c.fill();
    c.fillStyle = '#d28c7a'; c.beginPath(); c.moveTo(-21, -0.4); c.quadraticCurveTo(0, -11, 21, -0.4); c.quadraticCurveTo(0, -1.2, -21, -0.4); c.fill();
    curve([-26.5, 0.1, 0, -1.4, 26.5, 0.1], 'rgba(86,38,34,.8)', 1);
    soft(0, -4.5, 8, 1.8, '#ffffff', 0.15);
    soft(0, -12, 14, 3.5, sh, 0.2);
    for (const s of [-1, 1]) soft(s * 27, -0.5, 3, 3, sh, 0.3);
  });
  for (const s of [-1, 1]) at(s * 0.5, -0.12, () => soft(0, 0, 20, 14, '#e39a84', 0.2));
}
// 地上的肉（脖子、手臂、圓球、攤開的肉）共用的貼圖：奶油色，一條一條直的黃色和桃色
let dmFleshTex = null;
function makeDmFlesh() {
  if (dmFleshTex) return;
  dmFleshTex = m5Tex('dmFlesh', 256, 512, (c, w, h) => {
    c.fillStyle = '#ecdcb6'; c.fillRect(0, 0, w, h);
    c.filter = 'blur(4px)';
    for (let i = 0; i < 120; i++) { const x = rnd() * w; c.strokeStyle = `rgba(${rnd() < 0.65 ? '228,200,70' : '214,146,108'},${(0.05 + rnd() * 0.1).toFixed(2)})`; c.lineWidth = 2 + rnd() * 7; c.beginPath(); c.moveTo(x, rnd() * h * 0.3); c.lineTo(x + (rnd() - 0.5) * 12, h * (0.5 + rnd() * 0.5)); c.stroke(); }
    c.filter = 'none';
    for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '250,244,226' : '190,150,100'},${(0.05 + rnd() * 0.08).toFixed(2)})`; c.beginPath(); c.arc(rnd() * w, rnd() * h, 1 + rnd() * 6, 0, 7); c.fill(); }
  }, true);
}
function buildDaydream(r, g) {
  makeMonster5Textures(); makeDmFlesh();
  const T = { transparent: true };
  const fleshM = map => { const m = withDetail(ownPhong('#ffffff', { map, specular: 0x262018, shininess: 14, shade: 0.75, ...T }), 'skin', 1.5, 0.5); r.mats.push(m); return m; };
  const cloudM = fleshM(m5Tex('dmCloud', 1024, 512, dmPaintCloud)), faceM = fleshM(m5Tex('dmFace', 2048, 1024, dmPaintFace)), stalkM = fleshM(dmFleshTex);
  faceM.map.wrapS = THREE.ClampToEdgeWrapping;
  const dripM = ownPhong('#ecdca0', { specular: 0x777055, shininess: 70, shade: 0.6, ...T }); r.mats.push(dripM);
  r.body = new THREE.Group(); g.add(r.body);
  r.cloud = new THREE.Group(); r.body.add(r.cloud);
  r.cloud.add(new THREE.Mesh(dmCloudGeo(), cloudM));
  // 睡著的臉：長在雲的左邊那頭，往前凸出來、稍微轉向左邊（設計圖），後腦勺埋在雲裡
  r.face = new THREE.Group(); r.face.position.set(dmX(368), dmY(330), 1.95); r.face.rotation.set(0.05, -0.2, 0); r.cloud.add(r.face);
  r.face.add(new THREE.Mesh(dmHeadGeo(), faceM));
  // 融化的脖子：從下巴底下流到地上，表面一條一條往下的皺褶（越往下越明顯），底部攤開
  const sx = dmX(330);
  r.body.add(new THREE.Mesh(loftGeo('dmStalk', [
    { y: 7.2, x: sx + 0.2, z: 0.4, w: 1.4, d: 1.0 },
    { y: 5.6, x: sx + 0.1, z: 0.4, w: 1.8, d: 1.45 },
    { y: 4.2, x: sx, z: 0.5, w: 1.7, d: 1.4, wv: 0.05 },
    { y: 2.8, x: sx + 0.15, z: 0.5, w: 1.35, d: 1.15, wv: 0.13 },
    { y: 1.4, x: sx + 0.25, z: 0.45, w: 1.25, d: 1.1, wv: 0.17 },
    { y: 0.5, x: sx + 0.2, z: 0.5, w: 1.75, d: 1.6, wv: 0.2 },
    { y: 0.05, x: sx + 0.1, z: 0.6, w: 2.6, d: 2.3, wv: 0.1 },
  ], { seg: 40, sub: 4, uv: [0, 1, 0, 1] }), stalkM));
  // 地上：往右躺著的長手臂（中間拱起一點，尾端一顆圓球）、往左前方攤開一層一層的肉
  const flat = (key, pts, rs, sy) => { const m = new THREE.Mesh(tubeGeo(key, pts, rs, 12, 40), stalkM); m.scale.y = sy; r.body.add(m); return m; };
  flat('dmArm', [[sx + 0.6, 0.55, 0.2], [dmX(470), 0.6, 0.1], [dmX(560), 0.95, 0], [dmX(660), 0.55, -0.1], [dmX(850), 0.6, -0.3], [dmX(1010), 0.85, -0.4], [dmX(1080), 1, -0.45]], [0.85, 0.7, 0.62, 0.55, 0.52, 0.6, 0.7], 0.8);
  r.bulb = sph(r.body, 1.3, dmX(1150), 1.15, -0.45, stalkM, 1, 0.88, 1, 28);
  const lobe = (key, pts, rs, sy) => { flat(key, pts, rs, sy); const e = pts[pts.length - 1], m = sph(r.body, rs[rs.length - 1], e[0], e[1] * sy, e[2], stalkM, 1, sy, 1, 16); return m; };
  lobe('dmSheet1', [[sx - 0.4, 0.5, 0.8], [sx - 2.2, 0.45, 1.9], [sx - 3.5, 0.4, 2.5]], [1.4, 1.15, 0.75], 0.24);
  lobe('dmSheet2', [[sx + 0.2, 0.5, 1.2], [sx + 2.6, 0.45, 2.8], [sx + 5.4, 0.4, 4.2], [sx + 7.6, 0.36, 5]], [1.3, 1.05, 0.8, 0.55], 0.22);
  lobe('dmSheet3', [[sx - 0.6, 0.55, 0.3], [sx - 2.4, 0.5, 0.9], [sx - 4, 0.45, 1.2]], [1.2, 0.95, 0.6], 0.26);
  // 雲底下垂著的黏液：一條一條往下、越來越細、尾端一顆水滴（會晃）
  r.drips = [];
  const rr = seeded(99);
  for (let i = 0; i < 22; i++) {
    const X = dmX(380 + rr() * 820), bot = dmTab(DM_BOT, X), hy = (dmTab(DM_TOP, X) - bot) / 2, zz = (rr() - 0.45) * (0.5 + hy * 0.75) * 0.9, L = 0.4 + rr() * rr() * 3.2, rad = 0.05 + rr() * 0.08;
    const dg = new THREE.Group(); dg.position.set(X, bot + 0.5, zz); r.cloud.add(dg);
    dg.add(new THREE.Mesh(tubeGeo('dmDrip' + i, [[0, 0.1, 0], [(rr() - 0.5) * 0.15, -L * 0.3, (rr() - 0.5) * 0.15], [(rr() - 0.5) * 0.2, -L * 0.7, (rr() - 0.5) * 0.1], [(rr() - 0.5) * 0.25, -L, 0]], [rad * 4, rad * 1.6, rad, rad * 0.8, rad * 1.1], 8, 18), dripM));
    sph(dg, rad * 1.5, 0, -L - rad * 0.9, 0, dripM, 1, 1.7, 1, 10);
    dg.userData = { ph: rr() * 6, L };
    r.drips.push(dg);
  }
  // 滴下去的黏液
  r.drops = [];
  for (let i = 0; i < 4; i++) { const m = sph(g, 0.12, 0, 0, 0, dripM, 1, 1.5, 1, 10); m.visible = false; r.drops.push({ m, n: -1 }); }
}
const _dmV = new THREE.Vector3();
function syncDaydream(r, t) {
  // 慢慢地呼吸（雲一脹一縮、上下飄一點），臉像睡著一樣輕輕地晃，黏液晃，圓球一脹一縮
  r.cloud.scale.set(1, 1 + 0.012 * Math.sin(t * 0.45), 1 + 0.01 * Math.sin(t * 0.45 + 0.5));
  r.cloud.position.y = Math.sin(t * 0.3) * 0.08;
  r.face.rotation.z = Math.sin(t * 0.22) * 0.025;
  for (const d of r.drips) { const u = d.userData; d.rotation.set(Math.sin(t * 0.9 + u.ph) * 0.06, 0, Math.sin(t * 0.7 + u.ph * 1.3) * 0.08); d.scale.y = 1 + 0.06 * Math.sin(t * 0.5 + u.ph); }
  r.bulb.scale.set(1 + 0.03 * Math.sin(t * 0.8), 0.88 + 0.03 * Math.sin(t * 0.8 + 1), 1 + 0.03 * Math.sin(t * 0.8));
  // 每 2 秒左右從一條黏液的尾端滴下一滴，掉到地上
  r.drops.forEach((dr, k) => {
    const P = 2.2, tt = t + k * 0.55, n = Math.floor(tt / P), tau = tt - n * P;
    if (n !== dr.n) { dr.n = n; dr.src = r.drips[Math.floor(hash01(n * 5.1 + k * 2.3) * r.drips.length)]; dr.rel = null; }
    if (tau < 0.8) { dr.m.visible = false; return; }
    if (!dr.rel) { const u = dr.src.userData; _dmV.set(0, -u.L - 0.2, 0); dr.src.localToWorld(_dmV); r.g.worldToLocal(_dmV); dr.rel = _dmV.clone(); }
    const f = tau - 0.8, y = dr.rel.y - 4.9 * f * f;
    dr.m.position.set(dr.rel.x, y, dr.rel.z); dr.m.visible = y > 0.1;
  });
}
// ---------- 夢境切片（鬼王級，2～4 公尺）----------
// 一個巨大的硨磲貝：下面的殼像一個碗，一條一條從殼頂（後面的鉸鏈）放射出去的肋，邊緣是鋸齒狀的；上面的殼掀開來、往右邊歪，
// 邊緣一層一層皺皺的（設計圖上像縐紗）。殼裡塞滿一大團淡紫色、一摺一摺垂下來的肉，像布幔一樣蓋過下面殼的邊緣，
// 一片一片的裙邊之間露出黑黑的殼裡面。肉的正中間擠出一顆蒼白的嬰兒頭：額頭又高又大、下巴尖尖的（倒過來的蛋），
// 臉擠在下半部、整張臉歪向一邊：垂垂的眼皮、深紅褐色的小眼睛、紅紅的眼眶和臉頰，一張咧到臉頰的大嘴笑著，露出一排小牙。
// 尺寸照設計圖量（整隻 540 像素 ≈ 3.2 公尺高、4.6 公尺寬）
const SL = {
  A: 2.3, B: 1.6, z0: 0.05,        // 殼的邊緣（從上面看是橢圓）：左右半徑、前後半徑、中心
  uz: -1.45, rim: 0.82, N: 28,     // 殼頂（鉸鏈）在後面哪裡、邊緣多高、一圈幾條肋
  dome: 1.45, open: 0.62, roll: -0.15,   // 上殼鼓起來多高、掀開的角度、往右邊歪（右邊低）
};
// 從殼頂往 b 方向（0 是正前面、往 +x 是正的）到殼的邊緣多遠
function slRho(b) {
  const sb = Math.sin(b), cb = Math.cos(b), pz = SL.uz - SL.z0, B2 = SL.B * SL.B;
  const qa = sb * sb / (SL.A * SL.A) + cb * cb / B2, qb = 2 * pz * cb / B2, qc = pz * pz / B2 - 1;
  return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
}
// 平滑的殼（還沒有肋，關起來的位置）：s 從殼頂（0）到邊緣（1）；下殼是碗（中間碰到地、邊緣直直的），上殼是圓頂。兩片在殼頂接在一起
function slBowl(s, b, up, out) {
  const rho = slRho(b), x = Math.sin(b) * rho * s, z = SL.uz + Math.cos(b) * rho * s;
  const q = Math.min(1, Math.hypot(x / SL.A, (z - SL.z0) / SL.B)), bowl = Math.sqrt(Math.max(0, 1 - q * q)) * sstep(0, 0.4, s);
  return out.set(x, up ? SL.rim + SL.dome * bowl ** 0.7 : SL.rim * (1 - bowl ** 0.9), z);
}
const SL_C = [new THREE.Vector3(0, SL.rim + 1.2, SL.z0), new THREE.Vector3(0, SL.rim - 0.6, SL.z0)];   // 殼的「裡面」（算法線朝外用）
const _slT = [0, 1].map(() => [0, 1, 2, 3].map(() => new THREE.Vector3()));
// 往外的法線（數值微分）：f(s, b, up, out) 是表面，T 是暫存的向量（f 裡面又算法線的話要用另一組）
function slNormal(f, s, b, up, P, out, T) {
  const e = 0.003, A = f(Math.min(1, s + e), b, up, T[0]).sub(f(Math.max(0.005, s - e), b, up, T[1])), Bv = f(s, b + e, up, T[2]).sub(f(s, b - e, up, T[3]));
  out.crossVectors(Bv, A).normalize();
  if (out.dot(T[0].copy(P).sub(SL_C[up ? 1 : 0])) < 0) out.negate();
  return out;
}
// 真的殼：沿著法線加上肋的起伏（越靠近邊緣越深），邊緣跟著肋變成鋸齒（上下兩片的鋸齒剛好咬在一起）；上殼的邊緣再加一層細細的皺摺
const _slN = new THREE.Vector3();
function slShellPt(s, b, up, out) {
  const P = slBowl(s, b, up, out), n = slNormal(slBowl, s, b, up, P, _slN, _slT[0]);
  const c = Math.cos(SL.N * b + (up ? Math.PI : 0)), near = sstep(0.15, 1.3, slRho(b) * s), rib = Math.sign(c) * Math.abs(c) ** 0.6 * near, edge = sstep(0.72, 1, s);   // 鉸鏈附近（離殼頂很近）是平滑的
  let a = (up ? 0.065 : 0.1) * (sstep(0.05, 0.85, s) + (up ? 0.5 : 0.2) * edge) * rib;
  if (up) a += near * (0.045 * Math.sin(SL.N * 3 * b + 1.3 + 2 * Math.sin(b * 5)) + 0.025 * Math.sin(SL.N * 7 * b + 0.4 + 3 * Math.sin(b * 3))) * sstep(0.6, 1, s) * (0.6 + 0.4 * Math.sin(b * 7 + 1));
  P.addScaledVector(n, a);
  P.y += (up ? -1 : 1) * 0.13 * rib * edge * edge;
  return P;
}
// 一片殼的網格：外面（s 從殼頂到邊緣）→ 圓圓的邊緣 → 裡面（往回到殼頂），外面和唇是第 0 組材質、裡面是第 1 組
function slValveGeo(up) {
  return geo('slValve' + (up ? 'U' : 'L'), () => {
    const M = up ? 448 : 336, NS = 44, S = [];
    for (let i = 0; i <= NS; i++) S.push(0.01 + 0.99 * (i / NS) ** 0.75);   // 靠近邊緣密一點
    const R = NS * 2 + 3, C1 = M + 1, pos = new Float32Array(R * C1 * 3), uv = new Float32Array(R * C1 * 2);
    const P = new THREE.Vector3(), Q = new THREE.Vector3(), n = new THREE.Vector3(), tg = new THREE.Vector3();
    const put = (i, j, v, t) => { const k = i * C1 + j; pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z; uv[k * 2] = j / M; uv[k * 2 + 1] = 1 - t; };
    for (let j = 0; j <= M; j++) {
      const b = -Math.PI + 2 * Math.PI * (j % M) / M;
      S.forEach((s, i) => {
        slShellPt(s, b, up, P); put(i, j, P, s);
        slNormal(slShellPt, s, b, up, P, n, _slT[1]);
        Q.copy(P).addScaledVector(n, -(0.085 - 0.04 * s) * (0.2 + 0.8 * sstep(0.05, 0.6, slRho(b) * s))); put(R - 1 - i, j, Q, s);   // 裡面：往內縮殼的厚度（殼頂附近薄）
        if (i === NS) {   // 邊緣：外面和裡面的中間，往外凸一點（圓圓的唇）
          slShellPt(0.985, b, up, tg); tg.subVectors(P, tg).normalize();
          Q.add(P).multiplyScalar(0.5).addScaledVector(tg, 0.025); put(NS + 1, j, Q, 1);
        }
      });
    }
    const idx = [];
    for (let i = 0; i < R - 1; i++) for (let j = 0; j < M; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; idx.push(a, c, b, b, c, d); }
    // 三角形的方向：外面要朝外
    const k0 = (20 * C1 + (M >> 1)) * 3, k1 = k0 + C1 * 3, k2 = k0 + 3, va = new THREE.Vector3(pos[k1] - pos[k0], pos[k1 + 1] - pos[k0 + 1], pos[k1 + 2] - pos[k0 + 2]), vb = new THREE.Vector3(pos[k2] - pos[k0], pos[k2 + 1] - pos[k0 + 1], pos[k2 + 2] - pos[k0 + 2]);
    if (va.cross(vb).dot(new THREE.Vector3(pos[k0], pos[k0 + 1], pos[k0 + 2]).sub(SL_C[up ? 1 : 0])) < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const half = (NS + 1) * M * 6;
    g.addGroup(0, half, 0); g.addGroup(half, idx.length - half, 1);
    g.computeVertexNormals();
    fixSeam(g, M, R);
    return g;
  });
}
// 殼外面的貼圖（u 繞一圈、v 從殼頂到邊緣）：奶油色，越靠近殼頂越舊越黃褐；肋凹下去的地方暗、凸起來的地方亮，
// 一筆一筆褐色的線（設計圖的鉛筆線）、一圈一圈的生長紋（越靠近邊緣越密、跟著肋彎），下殼碰到地的地方髒髒的
function slPaintShell(c, W, H, up) {
  const r = seeded(up ? 616 : 515), ph = up ? Math.PI : 0;
  c.fillStyle = up ? '#e0d6bf' : '#d4c6a8'; c.fillRect(0, 0, W, H);
  let g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(140,116,80,.6)'); g.addColorStop(0.45, 'rgba(170,150,110,.2)'); g.addColorStop(1, 'rgba(246,240,224,.3)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x++) {
    const b = (x + 0.5) / W * Math.PI * 2 - Math.PI, cc = Math.cos(SL.N * b + ph), col = cc < 0 ? '86,64,46' : '255,250,236', k = cc < 0 ? -cc * 0.42 : cc * 0.16;
    g = c.createLinearGradient(0, H * 0.1, 0, H * 0.85); g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},${k.toFixed(3)})`);
    c.fillStyle = g; c.fillRect(x, 0, 1, H);
  }
  for (let i = 0; i < 700; i++) {   // 斑駁
    const x = r() * W, y = r() * H, rr = 4 + r() * 22, col = r() < 0.5 ? '#b8a07a' : r() < 0.6 ? '#f4eedc' : '#8a7a68';
    g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, rgbaOf(col, 0.1 + r() * 0.1)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  c.lineCap = 'round';
  for (let k = 0; k < 46; k++) {   // 生長紋
    const s = 1 - 0.92 * (k / 46) ** 1.5;
    c.strokeStyle = `rgba(${r() < 0.5 ? '110,84,60' : '150,130,104'},${(0.12 + r() * 0.16).toFixed(2)})`; c.lineWidth = 0.8 + r() * 1.6; c.beginPath();
    for (let x = 0; x <= W; x += 4) { const b = x / W * Math.PI * 2 - Math.PI; c.lineTo(x, s * H + 4 * s * Math.cos(SL.N * b + ph) + 1.5 * Math.sin(x * 0.05 + k)); }
    c.stroke();
  }
  for (let i = 0; i < 700; i++) {   // 順著肋的褐色鉛筆線
    const x = r() * W, y0 = H * (0.3 + r() * 0.55), len = H * (0.06 + r() * 0.25);
    c.strokeStyle = `rgba(${r() < 0.6 ? '128,82,50' : '84,66,52'},${(0.08 + r() * 0.2).toFixed(2)})`; c.lineWidth = 0.8 + r() * 2;
    c.beginPath(); c.moveTo(x, y0); c.lineTo(x + (r() - 0.5) * 5, Math.min(H, y0 + len)); c.stroke();
  }
  for (let i = 0; i < 160; i++) { c.fillStyle = `rgba(60,46,36,${(0.15 + r() * 0.3).toFixed(2)})`; c.beginPath(); c.arc(r() * W, H * (0.1 + r() * 0.85), 0.8 + r() * 2.2, 0, 7); c.fill(); }   // 小小的蛀洞
  if (!up) {   // 下殼碰到地的地方：泥巴
    g = c.createLinearGradient(0, H * 0.25, 0, H * 0.75); g.addColorStop(0, 'rgba(90,76,58,0)'); g.addColorStop(0.5, 'rgba(90,76,58,.4)'); g.addColorStop(1, 'rgba(90,76,58,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }
  g = c.createLinearGradient(0, H * 0.94, 0, H); g.addColorStop(0, 'rgba(250,246,234,0)'); g.addColorStop(1, 'rgba(250,246,234,.55)');   // 邊緣白白的
  c.fillStyle = g; c.fillRect(0, H * 0.94, W, H * 0.06);
}
// 殼裡面：又黑又深的褐色，靠近邊緣有一圈淡淡的珍珠光
let slInTex = null;
function makeSlInTex() {
  if (slInTex) return;
  slInTex = m5Tex('slIn', 512, 256, (c, W, H) => {
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1a130f'); g.addColorStop(0.75, '#2a1f19'); g.addColorStop(0.93, '#4c3f36'); g.addColorStop(1, '#8c7e6c');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 260; i++) { const x = rnd() * W, y = H * (0.5 + rnd() * 0.5), rr = 3 + rnd() * 16, gr = c.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, `rgba(${rnd() < 0.5 ? '120,104,130' : '96,80,64'},.18)`); gr.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gr; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
  }, true);
}
// 嬰兒的頭（在肉的正前面）：中心、半徑、往右歪多少（順時針）
const SL_HEAD = { x: -0.18, y: 1.7, z: 1.55, rx: 0.58, ry: 0.79, rz: 0.58, tilt: -0.08, nod: -0.1 };
// 紫色的肉：一摺一摺（只跟角度有關，越往下越深），裙邊垂下來的那幾片（角度，0 是正前面；中間下巴底下是一道縫）
const slFold = a => 0.55 * Math.sin(a * 9 + 0.4) + 0.3 * Math.sin(a * 15 + 2.2) + 0.2 * Math.sin(a * 23 + 1.1);
const SL_LOBES = [[-1.5, 0.45], [-1.0, 0.55], [-0.47, 1], [0.37, 1], [0.92, 0.6], [1.45, 0.45]];   // [角度, 垂多長]：正面兩片最大
const slLobe = a => { let L = 0; for (const [c, k] of SL_LOBES) L = Math.max(L, k * Math.exp(-((angD(a, c) / 0.22) ** 2))); return L; };
// 肉的表面：v 從頂上（0）到裙邊（1），再往裡面捲起來（到 1.12，有厚度）；a 繞一圈（0 是正前面）。
// 像鐘一樣：頂上在上殼底下（不會穿出上殼），越往下越寬、裙邊直直地垂下來；垂下來的那幾片蓋過殼的邊緣，中間的縫縮在殼裡面。
// 頭的周圍鼓起來一圈包著頭
function slMantlePt(v, a, out) {
  const L = slLobe(a), sa = Math.sin(a), ca = Math.cos(a), t = Math.min(v, 1) * Math.PI / 2;
  const hs = (0.87 + 0.24 * L) * (1 - 0.07 * sstep(0.9, 1.6, Math.abs(a))), ex = SL.A * hs, ez = (ca > 0 ? SL.B + 0.05 * ca : SL.B * (1 + 0.1 * ca)) * hs, yh = 1.02 - 0.46 * L, top = 2.95;
  const rr = Math.sin(t) ** 0.9 * (1 + 0.06 * Math.sin(t * 2.2)), f = 0.075 * slFold(a) * sstep(0.12, 0.55, v) * (1 + 0.3 * L) * (1 - 0.6 * sstep(0.8, 1, v));
  let x = sa * (ex * rr + f), z = SL.z0 + ca * (ez * rr + f), y = yh + (top - yh) * Math.cos(t) ** 1.3;
  if (v > 1) { const k = Math.min(1, (v - 1) / 0.12) * Math.PI * 1.1, c = 0.055; x -= sa * c * (1 - Math.cos(k)); z -= ca * c * (1 - Math.cos(k)); y -= c * Math.sin(k); }
  // 上殼底下：壓在上殼邊緣的平面底下
  const yp = SL.rim + (z - SL.uz) * Math.tan(SL.open) + x * Math.tan(SL.roll) - 0.06, w = sstep(1.25, 0.85, z);
  if (y > yp) y -= (y - yp) * w;
  const H = SL_HEAD, hy = (y - H.y) / (H.ry * 1.02), q = Math.hypot((x - H.x) / (H.rx * 1.02 * (1 - 0.42 * sstep(0.1, -1, hy) ** 1.4)), hy), fw = sstep(0.4, 1.0, z);
  z += fw * (0.2 * Math.exp(-(((q - 1.02) / 0.17) ** 2)) * (1 - 0.8 * sstep(-0.2, -0.8, hy)) - 0.4 * sstep(1.0, 0.6, q)
    - 0.32 * sstep(-0.55, -0.95, hy) * Math.exp(-(((x - H.x) / 0.42) ** 2)) * (1 - sstep(-1.5, -2.1, hy)));   // 下巴底下凹進去（下巴才露得出來）
  return out.set(x, y, z);
}
function slMantleGeo() {
  return geo('slMantle', () => {
    const M = 288, NV = 76, C1 = M + 1, pos = new Float32Array((NV + 1) * C1 * 3), uv = new Float32Array((NV + 1) * C1 * 2), P = new THREE.Vector3();
    for (let i = 0; i <= NV; i++) for (let j = 0; j <= M; j++) {
      const t = i / NV, v = t < 0.85 ? t / 0.85 : 1 + (t - 0.85) / 0.15 * 0.12, a = -Math.PI + 2 * Math.PI * (j % M) / M, k = i * C1 + j;
      slMantlePt(v, a, P);
      pos[k * 3] = P.x; pos[k * 3 + 1] = P.y; pos[k * 3 + 2] = P.z; uv[k * 2] = j / M; uv[k * 2 + 1] = 1 - v / 1.12;
    }
    const idx = [];
    for (let i = 0; i < NV; i++) for (let j = 0; j < M; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    fixSeam(g, M, NV + 1);
    return g;
  });
}
// 肉的貼圖（u 繞一圈、v 從頂上到捲起來的裙邊）：淡紫色，摺進去的地方深紫、摺出來的地方白白的藍紫；一筆一筆往下的條紋，
// 頂上（上殼底下）和裙邊底下暗，細細的紫紅色血管
function slPaintMantle(c, W, H) {
  const r = seeded(737), vy = v => v / 1.12 * H;
  c.fillStyle = '#a6a4cb'; c.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x++) {
    const a = (x + 0.5) / W * Math.PI * 2 - Math.PI, f = slFold(a), col = f < 0 ? '80,74,128' : '232,234,246', k = Math.min(1, Math.abs(f)) * (f < 0 ? 0.5 : 0.36);
    const g = c.createLinearGradient(0, vy(0.08), 0, vy(0.6)); g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},${k.toFixed(3)})`);
    c.fillStyle = g; c.fillRect(x, 0, 1, vy(1.0));
  }
  c.lineCap = 'round'; c.filter = 'blur(3px)';
  for (let i = 0; i < 260; i++) {
    const x = r() * W, y0 = vy(0.1 + r() * 0.4), y1 = vy(0.7 + r() * 0.3);
    c.strokeStyle = `rgba(${r() < 0.5 ? '230,230,244' : r() < 0.6 ? '96,84,140' : '176,140,170'},${(0.06 + r() * 0.12).toFixed(2)})`; c.lineWidth = 2 + r() * 8;
    c.beginPath(); c.moveTo(x, y0); c.quadraticCurveTo(x + (r() - 0.5) * 14, (y0 + y1) / 2, x + (r() - 0.5) * 10, y1); c.stroke();
  }
  c.filter = 'none';
  for (let i = 0; i < 500; i++) {
    const x = r() * W, y = r() * vy(1), rr = 3 + r() * 18, col = r() < 0.5 ? '#cdcae0' : r() < 0.5 ? '#6e6496' : '#a88aa6';
    const g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, rgbaOf(col, 0.1 + r() * 0.1)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // 血管：彎彎曲曲往下、分岔
  const vein = (x, y, a, w, n) => {
    c.beginPath(); c.moveTo(x, y);
    for (let k = 0; k < n; k++) {
      a += (r() - 0.5) * 0.6; x += Math.cos(a) * 5; y += Math.sin(a) * 5; c.lineTo(x, y);
      if (w > 1 && r() < 0.1) { c.lineWidth = w; c.stroke(); vein(x, y, a + (r() < 0.5 ? 0.8 : -0.8), w * 0.6, n - k); c.beginPath(); c.moveTo(x, y); }
    }
    c.lineWidth = w; c.stroke();
  };
  c.strokeStyle = 'rgba(120,52,104,.16)'; c.shadowColor = 'rgba(120,52,104,.3)'; c.shadowBlur = 4;
  for (let i = 0; i < 30; i++) vein(r() * W, vy(0.15 + r() * 0.5), Math.PI / 2 + (r() - 0.5) * 0.8, 1.6 + r() * 1.2, 14 + (r() * 16 | 0));
  c.shadowBlur = 0;
  let g = c.createLinearGradient(0, 0, 0, vy(0.32)); g.addColorStop(0, 'rgba(52,40,84,.75)'); g.addColorStop(1, 'rgba(52,40,84,0)'); c.fillStyle = g; c.fillRect(0, 0, W, vy(0.32));
  g = c.createLinearGradient(0, vy(0.9), 0, vy(1.12)); g.addColorStop(0, 'rgba(96,64,120,0)'); g.addColorStop(0.5, 'rgba(96,64,120,.4)'); g.addColorStop(1, 'rgba(70,40,84,.8)'); c.fillStyle = g; c.fillRect(0, vy(0.9), W, H - vy(0.9));
}
// 臉：整張臉（五官）逆時針歪 SL_ROT、繞著 SL_RY 那個高度轉（臉的座標 fx、fy 是擺正的五官）
const SL_ROT = 0.24, SL_RY = -0.38;
const slToFace = (x, y) => [x * Math.cos(SL_ROT) + (y - SL_RY) * Math.sin(SL_ROT), -x * Math.sin(SL_ROT) + (y - SL_RY) * Math.cos(SL_ROT) + SL_RY];
const slFromFace = (fx, fy) => [fx * Math.cos(SL_ROT) - (fy - SL_RY) * Math.sin(SL_ROT), fx * Math.sin(SL_ROT) + (fy - SL_RY) * Math.cos(SL_ROT) + SL_RY];
const SL_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]（臉的座標，單位球上）
  [0, 0.3, 0.6, 0.5, 0.03, 0],             // 又高又鼓的額頭
  [0.32, -0.08, 0.2, 0.05, 0.012, 1],      // 淡淡的眉骨
  [0.35, -0.2, 0.19, 0.14, -0.035, 1],     // 眼窩
  [0.37, -0.34, 0.15, 0.045, 0.03, 1],     // 眼睛底下鼓起來（被笑起來的臉頰推上來）
  [0, -0.27, 0.05, 0.09, 0.022, 0],        // 低低的鼻樑
  [0, -0.37, 0.07, 0.07, 0.07, 0],         // 小小的鼻子
  [0, -0.405, 0.045, 0.035, 0.035, 0],     // 鼻頭
  [0.06, -0.425, 0.035, 0.028, 0.03, 1],   // 鼻翼
  [0.036, -0.445, 0.018, 0.013, -0.03, 1], // 鼻孔
  [0.43, -0.47, 0.17, 0.15, 0.1, 1],       // 笑得鼓起來的臉頰
  [0.31, -0.52, 0.035, 0.12, -0.025, 1],   // 笑紋
  [0, -0.68, 0.18, 0.05, -0.015, 0],       // 下唇底下的凹
  [0, -0.86, 0.12, 0.08, 0.045, 0],        // 尖尖的下巴
];
// 咧開的大嘴（往上彎、右邊高一點）：e 離開口多遠（負的是在嘴裡面），upper 靠上唇那邊，u 橫的位置（-1～1 是嘴角到嘴角）
const SL_M = { y: -0.55, w: 0.45 }, _slm = { e: 0, upper: false, u: 0 };
const slMouthUp = u => SL_M.y + 0.05 + 0.07 * u * u + 0.04 * u, slMouthLo = u => SL_M.y - 0.1 + 0.22 * u * u + 0.04 * u;
function slMouth(fx, fy) {
  const o = _slm, u = fx / SL_M.w;
  o.u = u;
  if (Math.abs(u) <= 1) { const up = slMouthUp(u), lo = slMouthLo(u); o.upper = fy > (up + lo) / 2; o.e = o.upper ? fy - up : lo - fy; }
  else { const cy = slMouthUp(Math.sign(u)); o.upper = fy > cy; o.e = Math.hypot((Math.abs(u) - 1) * SL_M.w, fy - cy); }
  return o;
}
// 眼睛（臉的座標）和眼皮的形狀：眼皮垂下來蓋住半個虹膜，外眼角往下垂
const SL_EYE = { x: 0.35, y: -0.2, R: 0.105 }, SL_LID = { w: 0.95, hu: 0.1, hl: 0.44, lift: -0.3 };
let slEyeAt = null;
function slEyes() {
  if (slEyeAt) return slEyeAt;
  slEyeAt = [-1, 1].map(s => {
    const [X, Y] = slFromFace(s * SL_EYE.x, SL_EYE.y), S0 = slHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), new THREE.Vector3(), true);
    const F = new THREE.Vector3(s * 0.12, -0.06, 1).applyAxisAngle(Z_AXIS, SL_ROT).normalize();
    return { s, F, C: S0.addScaledVector(F, -0.9 * SL_EYE.R) };
  });
  return slEyeAt;
}
function slHeadPt(x, y, z, out, noEye) {
  const lo = sstep(0.1, -1, y);   // 越往下越窄（倒過來的蛋，下巴尖尖的）
  let X = x * (1 - 0.42 * lo ** 1.4), Z = z * (1 - 0.3 * lo ** 1.6);
  if (Z > 0) Z *= (1 - 0.1 * Math.max(0, 1 - Math.abs(x) * 1.3) * sstep(-0.1, -0.5, y)) * (1 + 0.38 * sstep(0.05, 0.8, -y) * (1 - 0.6 * sstep(0.85, 1, -y)));   // 臉平一點、下半臉往前（下巴才不會長在頭的底部）
  let d = 0;
  if (z > 0.05) {
    const [fx, fy] = slToFace(x, y);
    for (const f of SL_FACE) for (const s of f[5] ? [-1, 1] : [1]) {
      const u = (fx - s * f[0]) / f[2], v = (fy - f[1]) / f[3];
      if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v);
    }
    const m = slMouth(fx, fy);
    if (m.e < 0.15) d += -0.24 * sstep(0.004, -0.03, m.e) + (m.upper ? 0.03 : 0.042) * Math.exp(-(((m.e - 0.03) / 0.028) ** 2)) * (1 - 0.5 * sstep(0.75, 1.1, Math.abs(m.u)));
    d *= sstep(0.05, 0.4, z);
  }
  const k = 1 + d / (Math.hypot(X, y, Z) || 1);
  out.set(X * k * SL_HEAD.rx, y * k * SL_HEAD.ry, Z * k * SL_HEAD.rz);
  if (noEye || z < 0.3) return out;
  const [fx, fy] = slToFace(x, y);
  for (const E of slEyes()) {
    const dx = (fx - E.s * SL_EYE.x) * E.s * SL_HEAD.rx * 0.92, dy = (fy - SL_EYE.y) * SL_HEAD.ry;
    if (dx * dx + dy * dy < (SL_EYE.R * 2.4) ** 2) crSnapLid(out, E.C, E.F, dx, dy, SL_EYE.R, SL_LID);
  }
  return out;
}
const slU = crWarp(-Math.PI, Math.PI, a => 1 + 1.6 * Math.exp(-((a / 0.75) ** 2))), slV = crWarp(0, Math.PI, th => 1 + 1.6 * Math.exp(-(((th - 2.0) / 0.55) ** 2)));
const slHeadGeo = () => sculptGeo('slHead', slHeadPt, slU, slV, th => sstep(1.35, 1.5, th) * (1 - sstep(2.75, 2.9, th)), a => sstep(-0.85, -0.7, a) * (1 - sstep(0.7, 0.85, a)));
// 頭的貼圖：蒼白的嬰兒皮膚（額頭左上方帶一點橘色，照設計圖），兩邊和後面跟紫色的肉長在一起（越往後越紫）；
// 眼睛周圍又紅又腫、深深的黑眼圈，垂下來的厚眼皮，紅紅的臉頰和鼻頭；嘴巴一個一個像素算（跟形狀用同一個 slMouth）：
// 嘴唇、濕濕的嘴唇內側、上面的牙齦、下面的舌頭、喉嚨又黑又深
function slPaintHead(c, W, H) {
  const { at, soft, curve } = headPainter(c, W, H, slU, slV), r = seeded(9191), sh = '#74463a';
  c.fillStyle = '#e8c7ab'; c.fillRect(0, 0, W, H);
  for (let i = 0; i < 1200; i++) {
    const x = r() * W, y = r() * H, rr = 6 + r() * 28, q = r(), col = q < 0.45 ? '#d68a76' : q < 0.75 ? '#f5e0cc' : '#c9a07a';
    const g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, rgbaOf(col, 0.07 + r() * 0.06)); g.addColorStop(1, rgbaOf(col, 0));
    c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // 兩邊和後面：跟紫色的肉長在一起
  for (const [u0, u1] of [[slU(-0.95), slU(-1.6)], [slU(0.95), slU(1.6)]]) {
    const g = c.createLinearGradient(u0 * W, 0, u1 * W, 0); g.addColorStop(0, 'rgba(150,120,160,0)'); g.addColorStop(1, 'rgba(140,116,160,.85)');
    c.fillStyle = g; c.fillRect(Math.min(u0, u1) * W, 0, Math.abs(u1 - u0) * W, H);
  }
  c.fillStyle = 'rgba(140,116,160,.85)'; c.fillRect(0, 0, slU(-1.6) * W, H); c.fillRect(slU(1.6) * W, 0, W - slU(1.6) * W, H);
  const at2 = (fx, fy, fn, s = 1) => { const [X, Y] = slFromFace(fx, fy); at(X, Y, () => { c.rotate(SL_ROT); c.scale(s, 1); fn(); }); };
  // 頭皮底下的青色血管
  c.lineCap = 'round';
  const vein = (x, y, a, w, n) => {
    c.beginPath(); c.moveTo(x, y);
    for (let k = 0; k < n; k++) {
      a += (r() - 0.5) * 0.7; x += Math.cos(a) * 9; y += Math.sin(a) * 9; c.lineTo(x, y);
      if (w > 1.4 && r() < 0.08) { c.lineWidth = w; c.stroke(); vein(x, y, a + (r() < 0.5 ? 0.9 : -0.9), w * 0.6, n - k); c.beginPath(); c.moveTo(x, y); }
    }
    c.lineWidth = w; c.stroke();
  };
  c.strokeStyle = 'rgba(96,118,160,.09)'; c.shadowColor = 'rgba(100,122,165,.3)'; c.shadowBlur = 7;
  for (let i = 0; i < 18; i++) { const s = r() < 0.5 ? -1 : 1; vein(slU(s * (0.6 + r() * 0.35)) * W, slV(0.5 + r() * 0.9) * H, Math.PI / 2 + (r() - 0.5), 2 + r() * 1.5, 16 + (r() * 18 | 0)); }
  c.shadowBlur = 0;
  // 額頭左上方一點橘色、額頭亮
  at(-0.3, 0.45, () => soft(0, 0, 40, 30, '#e09a68', 0.2));
  at(0, 0.3, () => soft(0, 0, 45, 30, '#ffffff', 0.1));
  // 眼睛：眼窩深深的紅褐色黑眼圈，眼眶紅腫，眼瞼緣濕濕的紅色，垂下來的厚眼皮上面一道摺痕，下眼皮紅紅腫腫，稀稀疏疏往下的睫毛
  const E = SL_EYE.R, kx = 100 / (SL_HEAD.rx * 0.92), ky = 100 / SL_HEAD.ry;
  const lidPt = (u, k, off = 0) => { const L = crLidE(u * SL_LID.w * E, 0, E, SL_LID); return [u * SL_LID.w * E * kx, ((k ? L.top : L.bot) + off * (k ? 1 : -1)) * ky]; };
  const lidLine = (k, off, col, w, u0 = -1, u1 = 1) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); for (let u = u0; u <= u1 + 1e-6; u += 0.05) c.lineTo(...lidPt(u, k, off)); c.stroke(); };
  for (const s of [-1, 1]) at2(s * SL_EYE.x, SL_EYE.y, () => {
    soft(0, 0, 25, 19, '#5a2a30', 0.45);
    soft(0, -9, 18, 6, '#a83c3c', 0.4);
    soft(0, 7, 18, 7, '#7a3a3a', 0.3);
    c.fillStyle = '#3a0c0c'; c.beginPath();
    for (let u = -1; u <= 1.001; u += 0.05) c.lineTo(...lidPt(u, 1));
    for (let u = 1; u >= -1.001; u -= 0.05) c.lineTo(...lidPt(u, 0));
    c.fill();
    lidLine(1, 0.3 * E, rgbaOf(sh, 0.14), 2.2, -0.8, 0.9); lidLine(1, 0.3 * E, rgbaOf(sh, 0.2), 0.6, -0.75, 0.85);
    lidLine(0, 0.25 * E, 'rgba(150,50,50,.3)', 2.4, -0.8, 0.85);
    lidLine(1, 0.004, '#a2423e', 1.6); lidLine(0, 0.004, '#b4504a', 1.5);
    for (let i = 0; i < 22; i++) {
      const u = -0.85 + i / 21 * 1.75, [x, y] = lidPt(u, 1, 0.008), l = 1 + r() * 1.1;
      curve([x, y, x + (u * 0.6 + 0.4) * l * 0.5, y - l * 0.4, x + (u * 1 + 0.6) * l, y - l * 0.6], 'rgba(52,36,30,.7)', 0.28);
    }
  }, s);
  for (const s of [-1, 1]) at2(s * 0.32, -0.04, () => { for (let i = 0; i < 30; i++) { const t = i / 29, x = -12 + t * 24, y = 1.5 * Math.sin(t * Math.PI) - t + (r() - 0.5) * 1.5; curve([x, y, x + 1.6 + t, y + 0.8 - t * 0.5], 'rgba(150,112,84,.12)', 0.3); } }, s);
  // 臉頰紅紅的、鼻子
  for (const s of [-1, 1]) at2(s * 0.42, -0.43, () => soft(0, 0, 16, 13, '#d8665e', 0.38), s);
  at2(0, -0.39, () => { for (const s of [-1, 1]) soft(s * 6.5, 1, 3.2, 8, sh, 0.22); soft(0, -2, 4.2, 3.4, '#d0705e', 0.3); soft(0, 1.5, 2, 3, '#ffffff', 0.12); });
  for (const s of [-1, 1]) at2(s * 0.036, -0.445, () => { c.fillStyle = 'rgba(56,22,20,.88)'; c.beginPath(); c.ellipse(0, 0, 1.8, 1.1, -0.25, 0, 7); c.fill(); }, s);
  for (const s of [-1, 1]) at2(s * 0.31, -0.52, () => curve([1.5, 8, -0.5, 0, 1.8, -8], rgbaOf(sh, 0.3), 1.6), s);   // 笑紋
  at2(0, -0.69, () => soft(0, 0, 11, 3.5, sh, 0.2));
  at2(0, -0.86, () => soft(0, 0, 9, 5, '#ffffff', 0.08));
  // 嘴：一個一個像素算
  const img = c.getImageData(0, 0, W, H), D = img.data, mix = (i, col, k) => { D[i] += (col[0] - D[i]) * k; D[i + 1] += (col[1] - D[i + 1]) * k; D[i + 2] += (col[2] - D[i + 2]) * k; };
  const xa = Math.floor(slU(-0.9) * W), xb = Math.ceil(slU(0.9) * W), ya = Math.floor(slV(1.85) * H), yb = Math.ceil(slV(2.85) * H);
  for (let py = ya; py < yb; py++) {
    const th = slV.inv((py + 0.5) / H), st = Math.sin(th), Y = Math.cos(th);
    for (let px = xa; px < xb; px++) {
      const a = slU.inv((px + 0.5) / W), X = st * Math.sin(a), [fx, fy] = slToFace(X, Y), m = slMouth(fx, fy);
      if (m.e > 0.09) continue;
      const i = (py * W + px) * 4, cor = sstep(0.7, 1.05, Math.abs(m.u));
      if (m.e >= 0) {
        mix(i, m.upper ? [176, 112, 102] : [188, 124, 114], Math.exp(-(((m.e - 0.022) / 0.024) ** 2)) * 0.75 * (1 - 0.6 * cor));
        mix(i, [70, 30, 28], (1 - sstep(0, 0.008, m.e)) * 0.8);
      } else {
        const dp = -m.e;
        mix(i, [110, 40, 40], 1);
        if (m.upper) mix(i, [168, 82, 80], sstep(0.004, 0.01, dp) * (1 - sstep(0.022, 0.03, dp)));        // 牙齦
        else mix(i, [128, 56, 56], sstep(0.006, 0.014, dp) * (1 - sstep(0.03, 0.045, dp)));              // 舌頭
        mix(i, [16, 4, 4], sstep(m.upper ? 0.025 : 0.035, m.upper ? 0.04 : 0.05, dp));                    // 喉嚨
      }
    }
  }
  c.putImageData(img, 0, 0);
}
let slIrisTex = null;
function buildSlice(r, g) {
  makeMonster5Textures(); makeSlInTex();
  const T = { transparent: true };
  const shellM = up => { const m = withDetail(ownPhong('#ffffff', { map: m5Tex('slShell' + up, 1024, 512, (c, w, h) => slPaintShell(c, w, h, up)), specular: 0x2a2620, shininess: 18, shade: 0.75, ...T }), 'bone', 2.2, 0.8); m.map.wrapT = THREE.ClampToEdgeWrapping; return m; };
  const outL = shellM(false), outU = shellM(true), inM = withDetail(ownPhong('#ffffff', { map: slInTex, specular: 0x5a4c44, shininess: 50, shade: 0.6, ...T }), 'bone', 2.5, 0.6);
  const mantle = withDetail(ownPhong('#ffffff', { map: m5Tex('slMantle', 1024, 512, slPaintMantle), specular: 0x40344e, shininess: 34, shade: 0.75, ...T }), 'slug', 2.2, 0.85);
  const skin = withDetail(ownLM('#ffffff', { map: m5Tex('slHead', 2048, 1024, slPaintHead), shade: 0.75, ...T }), 'skin', 4, 0.6);
  skin.map.wrapS = THREE.ClampToEdgeWrapping; mantle.map.wrapT = THREE.ClampToEdgeWrapping;
  const eye = { ball: wetEyeMat(eyeballTex, 0x0a0606, 0x555555, T), iris: wetEyeMat(slIrisTex, 0x060404, 0x888888, T), lid: withDetail(ownLM('#d8ae94', { shade: 0.8, ...T }), 'skin', 6, 0.8) };
  const tooth = withDetail(ownPhong('#cdbd98', { specular: 0x555048, shininess: 40, shade: 0.7, ...T }), 'bone', 8, 0.6);
  r.mats.push(outL, outU, inM, mantle, skin, eye.ball, eye.iris, eye.lid, tooth);
  r.body = new THREE.Group(); g.add(r.body);
  r.body.add(new THREE.Mesh(slValveGeo(false), [outL, inM]));
  // 上殼：繞著後面的鉸鏈掀開、往右邊歪
  r.lidRoll = new THREE.Group(); r.lidRoll.position.set(0, SL.rim, SL.uz); r.lidRoll.rotation.z = SL.roll; r.body.add(r.lidRoll);
  r.lidHinge = new THREE.Group(); r.lidHinge.rotation.x = -SL.open; r.lidRoll.add(r.lidHinge);
  const lid = new THREE.Mesh(slValveGeo(true), [outU, inM]); lid.position.set(0, -SL.rim, -SL.uz); r.lidHinge.add(lid);
  // 鉸鏈後面一條深褐色、像橡膠一樣的韌帶
  const lig = withDetail(ownPhong('#3a2a20', { specular: 0x403028, shininess: 30, shade: 0.7, ...T }), 'skin', 4, 0.8);
  r.mats.push(lig);
  sph(r.body, 0.09, 0, SL.rim + 0.03, SL.uz - 0.13, lig, 6.5, 1.1, 1, 16);
  r.mantle = new THREE.Mesh(slMantleGeo(), mantle); r.body.add(r.mantle);
  // 嬰兒頭
  r.head = new THREE.Group(); r.head.position.set(SL_HEAD.x, SL_HEAD.y, SL_HEAD.z); r.head.rotation.set(SL_HEAD.nod, 0, SL_HEAD.tilt); r.body.add(r.head);
  r.head.add(new THREE.Mesh(slHeadGeo(), skin));
  r.crEyes = [];
  for (const E of slEyes()) {
    const ey = crEye(r.head, SL_EYE.R, eye);
    ey.sock.position.copy(E.C); ey.sock.quaternion.setFromUnitVectors(Z_AXIS, E.F); ey.sock.rotateZ(SL_ROT);
    ey.jig = 0.02; ey.lim = 0.45; ey.rate = 0.13; ey.ph = E.s > 0 ? 0 : 0.002;
    r.crEyes.push(ey);
  }
  // 牙：上面一排小小的、黃黃的、不太整齊，下面幾顆
  const v = new THREE.Vector3(), rr = seeded(4242);
  const toothAt = (u, upper, s) => {
    const fy = upper ? slMouthUp(u) + 0.01 : slMouthLo(u) - 0.01, [X, Y] = slFromFace(u * SL_M.w, fy);
    slHeadPt(X, Y, Math.sqrt(Math.max(0, 1 - X * X - Y * Y)), v, true);
    const m = sph(r.head, s, v.x, v.y + (upper ? -1 : 1) * s * 0.7, v.z - 0.04, tooth, 0.75 + rr() * 0.35, 1.3 + rr() * 0.5, 0.6, 8);
    m.rotation.z = SL_ROT + (rr() - 0.5) * 0.5;
  };
  for (let i = 0; i < 12; i++) if (i !== 3 && i !== 9) toothAt(-0.8 + i * 0.145 + (rr() - 0.5) * 0.05, true, 0.011 + rr() * 0.005);   // 缺了兩顆
  for (let i = 0; i < 5; i++) toothAt(-0.4 + i * 0.2 + (rr() - 0.5) * 0.05, false, 0.009 + rr() * 0.003);
}
function syncSlice(r, t, p, dt) {
  // 上殼慢慢開合（像在呼吸）、肉一脹一縮；頭慢慢歪來歪去、稍微轉向你；眼睛一直盯著你，偶爾慢慢眨一下
  r.lidHinge.rotation.x = -(SL.open + 0.035 * Math.sin(t * 0.7));
  r.mantle.scale.set(1 + 0.012 * Math.sin(t * 0.7 + 0.6), 1 + 0.01 * Math.sin(t * 0.7 + 0.3), 1 + 0.012 * Math.sin(t * 0.7 + 0.6));
  _crV.set(p.x, 1.5, p.y); r.g.worldToLocal(_crV);
  const yaw = clamp(Math.atan2(_crV.x - SL_HEAD.x, _crV.z - SL_HEAD.z), -0.25, 0.25);
  r.head.rotation.y += (yaw - r.head.rotation.y) * Math.min(1, dt * 2);
  r.head.rotation.z = SL_HEAD.tilt + 0.06 * Math.sin(t * 0.45);
  r.head.rotation.x = SL_HEAD.nod + 0.03 * Math.sin(t * 0.33 + 1);
  crLook(r, t, dt, p);
}
// ---------- 404視線（鬼王級，3.7～4.8 公尺）----------
// 一個又高又瘦、全身黑色的人形：皮包骨，肋骨一根一根看得到，全身掛滿濕濕的黑色長毛（從頭、肩膀、手臂、腿一條一條垂下來，設計圖上像在滴）。
// 頭又大又圓，黑頭髮像頭罩一樣包著一張灰白色的臉：兩顆又大又圓、充血發紅的眼睛（眼眶紅紅的，兩個眼眶連在一起像蛙鏡），
// 底下一張咧到耳朵的大嘴，嘴唇被扯得薄薄的，露出上下兩排又長又不整齊的牙。手臂垂到膝蓋、手指又長又尖；兩腳張得很開、微微蹲著，身體往前駝。
// 動作：慢慢地呼吸、手指抽動、頭偶爾突然「卡」一下歪到一邊（像畫面當掉，404）；兩顆眼睛一直盯著你
// 尺寸照設計圖量（頭頂到腳 610 像素 ≈ 4.3 公尺）
const GZ_PX = 0.00705, gzX = px => (px - 215) * GZ_PX, gzY = py => (640 - py) * GZ_PX;
const GZ_HEAD = { x: gzX(207), y: gzY(122), z: 0.3, rx: 0.64, ry: 0.6, rz: 0.6 };
const GZ_EYE = { x: 0.29, y: 0.17, R: 0.15 }, GZ_LID = { w: 1.0, hu: 0.8, hl: 0.74, lift: 0.04 };   // 眼睛睜得又大又圓，上下都露出眼白
const GZ_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]（單位球上，正面看）
  [0.29, 0.17, 0.25, 0.22, -0.06, 1],     // 深深的眼窩
  [0.3, 0.4, 0.26, 0.06, 0.03, 1],        // 眉骨
  [0, 0.3, 0.08, 0.1, -0.015, 0],         // 兩個眼窩中間
  [0.52, -0.02, 0.15, 0.1, 0.05, 1],      // 高高的顴骨
  [0.45, -0.2, 0.13, 0.09, -0.035, 1],    // 顴骨底下凹進去（瘦）
  [0, -0.06, 0.06, 0.09, 0.025, 0],       // 扁扁的鼻子
  [0.032, -0.12, 0.016, 0.035, -0.045, 1],// 兩條縫一樣的鼻孔
  [0.66, -0.3, 0.1, 0.12, 0.04, 1],       // 嘴角被扯上去的肉
  [0, -0.74, 0.16, 0.09, 0.035, 0],       // 下巴
];
// 咧到耳朵的嘴（往上彎）：e 離開口多遠（負的是在嘴裡面），upper 靠上唇那邊，u 橫的位置
const GZ_M = { y: -0.38, w: 0.62 }, _gzm = { e: 0, upper: false, u: 0 };
const gzMouthUp = u => GZ_M.y + 0.07 + 0.1 * u * u, gzMouthLo = u => GZ_M.y - 0.14 + 0.31 * u * u;
function gzMouth(x, y) {
  const o = _gzm, u = x / GZ_M.w;
  o.u = u;
  if (Math.abs(u) <= 1) { const up = gzMouthUp(u), lo = gzMouthLo(u); o.upper = y > (up + lo) / 2; o.e = o.upper ? y - up : lo - y; }
  else { const cy = gzMouthUp(1); o.upper = y > cy; o.e = Math.hypot((Math.abs(u) - 1) * GZ_M.w, y - cy); }
  return o;
}
let gzEyeAt = null;
function gzEyes() {
  if (gzEyeAt) return gzEyeAt;
  gzEyeAt = [-1, 1].map(s => {
    const X = s * GZ_EYE.x, Y = GZ_EYE.y, S0 = gzHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), new THREE.Vector3(), true);
    const F = new THREE.Vector3(s * 0.18, 0, 1).normalize();
    return { s, F, C: S0.addScaledVector(F, -0.78 * GZ_EYE.R) };   // 眼球凸出來
  });
  return gzEyeAt;
}
function gzHeadPt(x, y, z, out, noEye) {
  let X = x, Z = z;
  if (y < 0) { const t = -y; X *= 1 - 0.18 * t * t; }
  if (Z > 0) Z *= 0.86 + 0.14 * Math.min(1, Math.abs(x) * 1.6);   // 臉是平的
  let d = 0;
  if (z > 0.05) {
    for (const f of GZ_FACE) for (const s of f[5] ? [-1, 1] : [1]) {
      const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3];
      if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v);
    }
    const m = gzMouth(x, y);
    if (m.e < 0.15) d += -0.26 * sstep(0.004, -0.035, m.e) + 0.022 * Math.exp(-(((m.e - 0.022) / 0.02) ** 2)) * (1 - 0.6 * sstep(0.8, 1.1, Math.abs(m.u)));
    d *= sstep(0.05, 0.4, z);
  }
  const k = 1 + d / (Math.hypot(X, y, Z) || 1);
  out.set(X * k * GZ_HEAD.rx, y * k * GZ_HEAD.ry, Z * k * GZ_HEAD.rz);
  if (noEye || z < 0.3) return out;
  for (const E of gzEyes()) {
    const dx = (x - E.s * GZ_EYE.x) * E.s * GZ_HEAD.rx * 0.95, dy = (y - GZ_EYE.y) * GZ_HEAD.ry;
    if (dx * dx + dy * dy < (GZ_EYE.R * 2.4) ** 2) crSnapLid(out, E.C, E.F, dx, dy, GZ_EYE.R, GZ_LID);
  }
  return out;
}
const gzU = crWarp(-Math.PI, Math.PI, a => 1 + 1.4 * Math.exp(-((a / 0.85) ** 2))), gzV = crWarp(0, Math.PI, th => 1 + 1.3 * Math.exp(-(((th - 1.75) / 0.6) ** 2)));
const gzHeadGeo = () => sculptGeo('gzHead', gzHeadPt, gzU, gzV, th => sstep(0.95, 1.1, th) * (1 - sstep(2.3, 2.5, th)), a => sstep(-1.05, -0.9, a) * (1 - sstep(0.9, 1.05, a)));
// 頭的貼圖（一個一個像素算）：頭皮是黑的；臉是一塊灰白色、髒髒的、有細細裂紋的皮，邊緣慢慢變黑；
// 眼眶一圈又濕又紅的肉、外面一圈暗紅的瘀青（兩邊在鼻樑上連在一起）；嘴唇又薄又暗紅，牙齦紅色、喉嚨黑的
function gzPaintHead(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, A = new Float32Array(W), TH = new Float32Array(H), C = [0, 0, 0];
  for (let x = 0; x < W; x++) A[x] = gzU.inv((x + 0.5) / W);
  for (let y = 0; y < H; y++) TH[y] = gzV.inv((y + 0.5) / H);
  const mix = (col, k) => { C[0] += (col[0] - C[0]) * k; C[1] += (col[1] - C[1]) * k; C[2] += (col[2] - C[2]) * k; };
  for (let py = 0; py < H; py++) {
    const st = Math.sin(TH[py]), y = Math.cos(TH[py]);
    for (let px = 0; px < W; px++) {
      const x = st * Math.sin(A[px]), z = st * Math.cos(A[px]);
      const n1 = Math.sin(x * 23 + y * 9) * Math.sin(y * 19 - z * 13 + 1.3) * Math.sin(z * 17 + x * 7 + 0.4), n2 = Math.sin(x * 61 + z * 37) * Math.sin(y * 53 + 2) * Math.sin(z * 47 - x * 29);
      C[0] = 30 + n1 * 6 + n2 * 3; C[1] = 27 + n1 * 5 + n2 * 3; C[2] = 26 + n1 * 5 + n2 * 3;
      if (z > 0) {
        const fo = Math.hypot(x / 0.8, (y + 0.12) / 0.74) + 0.05 * Math.sin(Math.atan2(y, x) * 9 + 1);
        const face = (1 - sstep(0.78, 1.0, fo)) * sstep(0.1, 0.35, z);
        if (face > 0) {
          mix([182 + n1 * 14 + n2 * 8, 174 + n1 * 13 + n2 * 8, 166 + n1 * 12 + n2 * 8], face);
          mix([120, 108, 102], sstep(0.5, 0.95, fo) * face * 0.6);
          for (const s of [-1, 1]) {
            const dx = (x - s * GZ_EYE.x) * s * GZ_HEAD.rx * 0.95, dy = (y - GZ_EYE.y) * GZ_HEAD.ry, e = crLidE(dx, dy, GZ_EYE.R, GZ_LID).e;
            if (e > 0.16) continue;
            mix([78, 46, 44], (1 - sstep(0.04, 0.14, e)) * 0.55);   // 瘀青
            mix([120, 34, 32], 1 - sstep(0.01, 0.04, e));           // 紅紅的眼眶
            mix([170, 52, 48], (1 - sstep(0, 0.014, e)) * 0.8);     // 濕濕的眼瞼緣
            if (e < 0) mix([30, 6, 6], 1);
          }
          const m = gzMouth(x, y);
          if (m.e < 0.07) {
            const cor = sstep(0.75, 1.05, Math.abs(m.u));
            if (m.e >= 0) { mix([120, 50, 48], Math.exp(-(((m.e - 0.018) / 0.018) ** 2)) * 0.85); mix([40, 14, 12], (1 - sstep(0, 0.006, m.e)) * 0.8); }
            else {
              const dp = -m.e;
              mix([96, 26, 26], 1);
              mix([150, 56, 52], sstep(0.003, 0.008, dp) * (1 - sstep(0.02, 0.03, dp)));   // 牙齦
              mix([12, 3, 3], sstep(0.025, 0.045, dp) * (1 - 0.3 * cor));                   // 喉嚨
            }
          }
        }
      }
      const i = (py * W + px) * 4;
      D[i] = C[0]; D[i + 1] = C[1]; D[i + 2] = C[2]; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // 臉上細細的裂紋、鼻孔、兩頰的髒污
  const { at, soft, curve } = headPainter(c, W, H, gzU, gzV), r = seeded(404);
  for (const s of [-1, 1]) at(s * 0.032, -0.12, () => { c.fillStyle = 'rgba(16,8,8,.9)'; c.beginPath(); c.ellipse(0, 0, 0.9, 2.6, s * 0.3, 0, 7); c.fill(); });
  for (let i = 0; i < 40; i++) {
    let x = (r() - 0.5) * 120, y = (r() - 0.5) * 110 - 10, a = r() * 6.28;
    const n = 4 + (r() * 8 | 0);
    at(0, 0, () => { c.strokeStyle = `rgba(70,58,54,${(0.15 + r() * 0.25).toFixed(2)})`; c.lineWidth = 0.25 + r() * 0.3; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < n; k++) { a += (r() - 0.5) * 1.2; x += Math.cos(a) * 2.5; y += Math.sin(a) * 2.5; c.lineTo(x, y); } c.stroke(); });
  }
  for (let i = 0; i < 30; i++) at((r() - 0.5) * 1.3, (r() - 0.5) * 1.2 - 0.1, () => soft(0, 0, 3 + r() * 8, 3 + r() * 8, r() < 0.5 ? '#5a4a44' : '#8a3a34', 0.12 + r() * 0.12));
  for (const s of [-1, 1]) at(s * 0.3, 0.42, () => curve([-14, -1, 0, 3, 14, -2], 'rgba(30,24,22,.35)', 2.5));   // 眉骨底下的影子
}
// 身體的皮：又黑又乾、一條一條往下的紋路（設計圖的鉛筆線），身體那張多畫肋骨（u 0.5 是正前面、v 從屁股往上到脖子）
function gzSkinTex(ribs) {
  return m5Tex('gzSkin' + ribs, 512, 512, (c, W, H) => {
    const r = seeded(ribs ? 4041 : 4042);
    c.fillStyle = '#3e3836'; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 600; i++) { const x = r() * W, y = r() * H, rr = 4 + r() * 24, g = c.createRadialGradient(x, y, 0, x, y, rr), col = r() < 0.5 ? '70,62,58' : '14,12,12'; g.addColorStop(0, `rgba(${col},${(0.15 + r() * 0.2).toFixed(2)})`); g.addColorStop(1, `rgba(${col},0)`); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
    c.lineCap = 'round';
    for (let i = 0; i < 900; i++) { const x = r() * W, y = r() * H, l = 6 + r() * 30; c.strokeStyle = `rgba(${r() < 0.5 ? '80,72,68' : '10,8,8'},${(0.1 + r() * 0.25).toFixed(2)})`; c.lineWidth = 0.6 + r() * 1.4; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 3, y + l); c.stroke(); }
    if (!ribs) return;
    // 肋骨：從胸骨往兩邊、往下彎，每根上面亮、下面暗
    for (let k = 0; k < 7; k++) {
      const y = H * (0.45 + k * 0.055);
      for (const s of [-1, 1]) for (const [dy, col, w] of [[-2.5, 'rgba(110,100,96,.28)', 3], [3, 'rgba(6,4,4,.3)', 4]]) {
        c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(W * (0.5 + s * 0.025), y + dy); c.quadraticCurveTo(W * (0.5 + s * 0.09), y + dy + 6 + k * 1.5, W * (0.5 + s * 0.17), y + dy + 22 + k * 2.5); c.stroke();
      }
    }
    c.strokeStyle = 'rgba(8,6,6,.25)'; c.lineWidth = 5; c.beginPath(); c.moveTo(W * 0.5, H * 0.42); c.lineTo(W * 0.5, H * 0.82); c.stroke();   // 胸骨
  }, true);
}
// 四肢（世界座標，照設計圖量）：[點, 半徑]
const GZ_LIMBS = {
  armL: [[[-0.6, 2.84, 0.12], [-0.84, 2.48, 0.13], [-1.0, 1.96, 0.16], [-1.1, 1.62, 0.21], [-1.17, 1.32, 0.24]], [0.15, 0.115, 0.095, 0.105, 0.065]],
  armR: [[[0.58, 2.82, 0.12], [0.77, 2.44, 0.12], [0.84, 1.98, 0.15], [0.82, 1.76, 0.21], [0.8, 1.56, 0.26]], [0.15, 0.115, 0.095, 0.105, 0.065]],
  legL: [[[-0.2, 1.8, 0], [-0.42, 1.4, 0.06], [-0.6, 1.0, 0.13], [-0.74, 0.6, 0.06], [-0.86, 0.17, 0]], [0.21, 0.15, 0.12, 0.11, 0.075]],
  legR: [[[0.2, 1.8, 0], [0.38, 1.4, 0.06], [0.53, 1.0, 0.13], [0.64, 0.6, 0.06], [0.74, 0.17, 0]], [0.21, 0.15, 0.12, 0.11, 0.075]],
};
// 手：手掌、四根又長又彎的手指（尾端黑黑的尖爪）、大拇指；s 是左右，w 是手腕的位置、dir 手指往哪個方向伸（大概往下）
function gzHand(parent, key, w, s, skin, claw) {
  const h = new THREE.Group(); h.position.set(...w); parent.add(h);
  sph(h, 0.09, 0, -0.08, 0.01, skin, 0.95, 1.4, 0.5, 12);
  const fingers = [];
  for (let i = 0; i < 5; i++) {
    const th = i === 4, ox = s * (th ? -0.08 : -0.06 + i * 0.04), L = th ? 0.26 : [0.44, 0.52, 0.5, 0.4][i], sp = s * (th ? -0.5 : (-0.15 + i * 0.1));
    const f = new THREE.Group(); f.position.set(ox, th ? -0.05 : -0.15, th ? 0.04 : 0.01); f.rotation.set(0, 0, sp); h.add(f);
    f.add(new THREE.Mesh(tubeGeo(key + i, [[0, 0, 0], [0, -L * 0.4, 0.03], [0, -L * 0.75, 0.09], [0, -L, 0.16]], [0.028, 0.023, 0.019, 0.012], 7, 12), skin));
    for (const k of [0.4, 0.75]) sph(f, 0.026, 0, -L * k, 0.03 + k * 0.06, skin, 1, 1, 1, 8);   // 指節
    const cl = sph(f, 0.012, 0, -L - 0.03, 0.2, claw, 0.8, 3.2, 0.8, 8); cl.rotation.x = -0.6;
    fingers.push(f);
  }
  return { h, fingers };
}
function buildGaze(r, g) {
  const T = { transparent: true };
  const head = withDetail(ownLM('#ffffff', { map: m5Tex('gzHead', 2048, 1024, gzPaintHead), shade: 0.75, ...T }), 'skin', 3, 0.8);
  head.map.wrapS = THREE.ClampToEdgeWrapping;
  const skin = withDetail(ownPhong('#ffffff', { map: gzSkinTex(false), specular: 0x2a2626, shininess: 22, shade: 0.75, ...T }), 'corpse', 3, 0.7);
  const torsoM = withDetail(ownPhong('#ffffff', { map: gzSkinTex(true), specular: 0x2a2626, shininess: 22, shade: 0.75, ...T }), 'corpse', 3, 0.7);
  const claw = ownPhong('#141010', { specular: 0x666060, shininess: 60, shade: 0.6, ...T });
  const eye = { ball: wetEyeMat(eyeballTex, 0x0a0202, 0x666666, T), iris: wetEyeMat(gzIrisTex(), 0x120000, 0x999999, T) };
  const tooth = withDetail(ownPhong('#d8ccb0', { specular: 0x555048, shininess: 40, shade: 0.7, ...T }), 'bone', 8, 0.7);
  const hair = hairMat(strandTex, 0.55), hair2 = hairMat(strandTex, 0.55);
  hair.color.set('#5a5250'); hair2.color.set('#5a5250');
  hair.userData.hair.uHAmp.value = 0.03; hair2.userData.hair.uHAmp.value = 0.025;
  r.hairU = [hair.userData.hair, hair2.userData.hair];
  r.mats.push(head, skin, torsoM, claw, eye.ball, eye.iris, tooth, hair, hair2);
  r.body = new THREE.Group(); g.add(r.body);
  // 身體：細細的腰、凸出來的肋骨、聳起來的肩膀，往前駝
  r.torso = new THREE.Mesh(loftGeo('gzTorso', [
    { y: 1.72, w: 0.38, d: 0.28 }, { y: 1.95, w: 0.35, d: 0.26 }, { y: 2.15, w: 0.28, d: 0.21, z: 0.01 },
    { y: 2.36, w: 0.38, d: 0.28, z: 0.04 }, { y: 2.56, w: 0.54, d: 0.34, z: 0.06 }, { y: 2.72, w: 0.64, d: 0.34, z: 0.08 },
    { y: 2.86, w: 0.76, d: 0.3, z: 0.1 }, { y: 2.97, w: 0.45, d: 0.24, z: 0.13 }, { y: 3.08, w: 0.17, d: 0.17, z: 0.2 }, { y: 3.3, w: 0.17, d: 0.17, z: 0.26 },
  ], { seg: 32, sub: 4, capA: 0.12, uv: [0, 1, 0, 1] }), torsoM);
  r.body.add(r.torso);
  sph(r.body, 0.26, 0, 1.78, 0, skin, 1.5, 0.9, 1.1, 14);   // 骨盆
  // 頭
  r.head = new THREE.Group(); r.head.position.set(GZ_HEAD.x, GZ_HEAD.y, GZ_HEAD.z); r.body.add(r.head);
  r.head.add(new THREE.Mesh(gzHeadGeo(), head));
  r.crEyes = [];
  for (const E of gzEyes()) {
    const ey = crEye(r.head, GZ_EYE.R, eye);
    ey.sock.position.copy(E.C); ey.sock.quaternion.setFromUnitVectors(Z_AXIS, E.F);
    ey.jig = 0.04; ey.lim = 0.5;
    r.crEyes.push(ey);
  }
  // 牙：上下兩排又長又不整齊（中間的長、往嘴角越來越小）
  const v = new THREE.Vector3(), rr = seeded(4404);
  for (const upper of [true, false]) {
    const n = upper ? 18 : 16;
    for (let i = 0; i < n; i++) {
      const u = -0.9 + 1.8 * (i + 0.5) / n + (rr() - 0.5) * 0.03, Y = upper ? gzMouthUp(u) + 0.008 : gzMouthLo(u) - 0.008, X = u * GZ_M.w;
      gzHeadPt(X, Y, Math.sqrt(Math.max(0, 1 - X * X - Y * Y)), v, true);
      const s = (0.017 + rr() * 0.006) * (1 - 0.35 * Math.abs(u)), m = sph(r.head, s, v.x, v.y + (upper ? -1 : 1) * s * 1.4, v.z - 0.03, tooth, 0.8 + rr() * 0.3, 2.0 + rr() * 0.7, 0.55, 8);
      m.rotation.z = (rr() - 0.5) * 0.25 + (upper ? 1 : -1) * u * 0.25;
    }
  }
  // 四肢、手肘和膝蓋凸出來的骨頭、手、腳
  r.limbs = {};
  for (const [k, [pts, rs]] of Object.entries(GZ_LIMBS)) {
    const piv = new THREE.Group(); piv.position.set(...pts[0]); r.body.add(piv);
    const loc = pts.map(p => [p[0] - pts[0][0], p[1] - pts[0][1], p[2] - pts[0][2]]);
    piv.add(new THREE.Mesh(tubeGeo('gz' + k, loc, rs, 12, 30), skin));
    sph(piv, rs[2] * 1.15, ...loc[2], skin, 1, 1, 1, 10);
    const s = k.endsWith('L') ? -1 : 1;
    if (k.startsWith('arm')) r.limbs[k] = { piv, ...gzHand(piv, 'gzF' + k, loc[4], s, skin, claw) };
    else {
      r.limbs[k] = { piv };
      const ft = new THREE.Group(); ft.position.set(...loc[4]); ft.rotation.y = s * 0.45; piv.add(ft);
      sph(ft, 0.16, 0, -0.1, 0.14, skin, 0.8, 0.45, 1.8, 12);   // 又長又瘦的腳
      for (let i = 0; i < 4; i++) {
        const tx = -0.06 + i * 0.04, L = 0.14 - Math.abs(i - 1.2) * 0.02;
        ft.add(new THREE.Mesh(tubeGeo('gzToe' + i, [[tx, -0.12, 0.36], [tx, -0.13, 0.36 + L * 0.6], [tx, -0.15, 0.36 + L]], [0.028, 0.024, 0.017], 6, 6), skin));
        const cl = sph(ft, 0.013, tx, -0.155, 0.38 + L, claw, 0.9, 0.7, 2.4, 6); cl.rotation.x = 0.4;
      }
    }
  }
  // 濕濕的黑色長毛：頭上（臉露出來，兩邊垂到胸口）、肩膀、手臂、腿、身體兩側，一條一條往下垂
  const hs = [];
  for (let i = 0; i < 260; i++) {
    const th = 0.15 + rr() * 1.85, ph = (rr() - 0.5) * 2 * Math.PI;
    if (Math.abs(ph) < 0.85 && th > 0.5) continue;   // 臉
    const ux = Math.sin(th) * Math.sin(ph), uy = Math.cos(th), uz = Math.sin(th) * Math.cos(ph), a = gzHeadPt(ux, uy, uz, new THREE.Vector3(), true).multiplyScalar(0.97);
    const side = Math.sign(Math.sin(ph)) || 1, oph = Math.abs(ph) < 1.1 ? side * 1.1 : ph, L = 0.35 + rr() * 0.6;
    const b = a.clone().multiplyScalar(1.12); b.y -= 0.1;
    const cc = [Math.sin(oph) * (GZ_HEAD.rx + 0.08 + rr() * 0.06), -0.3 - rr() * 0.25, Math.cos(oph) * (GZ_HEAD.rz + 0.06 + rr() * 0.06)];
    hs.push({ a: a.toArray(), b: b.toArray(), c: cc, d: [cc[0] * (1.05 + rr() * 0.2), cc[1] - L, cc[2] * (1 + rr() * 0.2) - 0.05], w: 0.04 + rr() * 0.05, f: oph, ph: rr() * 6, tp: 0.75 });
  }
  r.head.add(new THREE.Mesh(hairGeo('gzHair', hs, 12), hair));
  const bs = [], add = (p, L, f) => bs.push({ a: [p.x, p.y + 0.02, p.z], b: [p.x + Math.sin(f) * 0.03, p.y - L * 0.45, p.z + Math.cos(f) * 0.03], c: [p.x + Math.sin(f) * 0.05 + (rr() - 0.5) * 0.06, p.y - L, p.z + Math.cos(f) * 0.05], w: 0.025 + rr() * 0.035, f, ph: rr() * 6, tp: 0.85 });
  for (const [k, [pts, rs]] of Object.entries(GZ_LIMBS)) {
    const cv = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), arm = k.startsWith('arm'), n = arm ? 110 : 80;
    for (let i = 0; i < n; i++) {
      const t = rr() * 0.9, p = cv.getPoint(t), f = rr() * Math.PI * 2, rad = rs[Math.min(rs.length - 1, Math.round(t * (rs.length - 1)))];
      if (!arm && Math.cos(f) > 0.6 && rr() < 0.7) continue;
      p.x += Math.sin(f) * rad; p.z += Math.cos(f) * rad;
      add(p.sub(new THREE.Vector3(...pts[0])), (arm ? 0.3 : 0.25) + rr() * (arm ? 0.55 : 0.45), f);
      bs[bs.length - 1].limb = k;
    }
  }
  for (const k of Object.keys(GZ_LIMBS)) r.limbs[k].piv.add(new THREE.Mesh(hairGeo('gzHair' + k, bs.filter(q => q.limb === k), 8), hair2));
  const ts = [];
  for (let i = 0; i < 160; i++) {   // 肩膀、身體兩側和背後
    const s = rr() < 0.5 ? -1 : 1, y = 1.9 + rr() * 1.02, w = y > 2.75 ? 0.42 + (y - 2.75) * 2.2 : 0.3 + (y - 2.2) * 0.4, f = s * (0.8 + rr() * 2.2), p = new THREE.Vector3(Math.sin(f) * w, y, 0.06 + Math.cos(f) * 0.25);
    ts.push({ a: [p.x, p.y + 0.02, p.z], b: [p.x * 1.05, p.y - 0.2, p.z], c: [p.x * 1.08 + (rr() - 0.5) * 0.05, p.y - 0.35 - rr() * 0.5, p.z], w: 0.025 + rr() * 0.04, f, ph: rr() * 6, tp: 0.7 });
  }
  r.body.add(new THREE.Mesh(hairGeo('gzHairT', ts, 8), hair2));
  r.glitch = { n: -1, x: 0, z: 0 };
}
let gzIris = null;
function gzIrisTex() {
  if (gzIris) return gzIris;
  gzIris = m5Tex('gzIris', 256, 256, c => {
    const g = c.createRadialGradient(128, 128, 10, 128, 128, 124);
    g.addColorStop(0, '#1a0202'); g.addColorStop(0.3, '#6a0c0a'); g.addColorStop(0.7, '#8e1612'); g.addColorStop(1, '#2a0404');
    c.fillStyle = g; c.beginPath(); c.arc(128, 128, 124, 0, 7); c.fill();
    c.lineWidth = 2;
    for (let i = 0; i < 120; i++) { const a = i / 120 * Math.PI * 2; c.strokeStyle = `rgba(${rnd() < 0.5 ? '20,0,0' : '200,60,50'},${(0.2 + rnd() * 0.3).toFixed(2)})`; c.beginPath(); c.moveTo(128 + Math.cos(a) * 22, 128 + Math.sin(a) * 22); c.lineTo(128 + Math.cos(a) * (90 + rnd() * 30), 128 + Math.sin(a) * (90 + rnd() * 30)); c.stroke(); }
    c.fillStyle = '#030000'; c.beginPath(); c.arc(128, 128, 16, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,230,220,.8)'; c.beginPath(); c.arc(104, 100, 11, 0, 7); c.fill();
  });
  return gzIris;
}
function syncGaze(r, t, p, dt) {
  // 慢慢地呼吸、身體一起一伏；手臂晃、手指抽動；頭髮飄
  const br = Math.sin(t * 1.1);
  r.torso.scale.set(1 + 0.025 * br, 1, 1 + 0.03 * br);
  r.body.position.y = 0.02 * Math.sin(t * 1.1 + 1);
  const L = r.limbs;
  L.armL.piv.rotation.set(0.05 * Math.sin(t * 0.7), 0, -0.04 + 0.04 * Math.sin(t * 0.9));
  L.armR.piv.rotation.set(0.05 * Math.sin(t * 0.7 + 2), 0, 0.04 - 0.04 * Math.sin(t * 0.9 + 1));
  for (const k of ['armL', 'armR']) L[k].fingers.forEach((f, i) => { f.rotation.x = 0.15 + 0.12 * Math.sin(t * 2.3 + i * 0.9 + (k === 'armL' ? 0 : 2)) + (Math.sin(t * 5.1 + i) > 0.95 ? 0.25 : 0); });
  for (const u of r.hairU) u.uHT.value = t;
  // 頭：慢慢歪來歪去；每 2.8 秒左右「卡」一下（突然歪到一邊、停一下，再跳回來，像畫面當掉）
  const P = 2.8, n = Math.floor(t / P), tau = t - n * P, gl = r.glitch;
  if (n !== gl.n) { gl.n = n; gl.z = (hash01(n * 3.7) - 0.5) * 0.9; gl.x = (hash01(n * 1.3) - 0.5) * 0.12; }
  const on = tau < 0.22 || (tau > 0.3 && tau < 0.36);
  r.head.rotation.set(0.06 * Math.sin(t * 0.5) + (on ? gl.x * 2 : 0), 0, 0.08 * Math.sin(t * 0.37) + (on ? gl.z : 0));
  r.head.position.x = GZ_HEAD.x + (on ? gl.x : 0);
  crLook(r, t, dt, p);
}
// ---------- 綠溫室（判官級，2.5～3 公尺）----------
// 一個直立的巨大豆莢：外面是一片一片厚厚的、帶蠟質光澤的綠葉（設計圖上一條一條直的綠色筆觸），正面裂開一道縫，
// 縫裡面是一根黑黑的、一絲一絲纖維的芯，芯上像豌豆一樣長著四顆睡著的人頭（上面一顆大的、中間兩顆小的、最下面一顆橫躺著快掉出來），
// 每顆頭用一條短短的肉柄連在芯上。一片長長的葉子從豆莢頂上往左邊彎下來拖到地上，底下一條捲捲的鬚。
// 動作：豆莢像在呼吸一樣慢慢開合，臉輕輕地轉、一起呼吸，葉子晃。尺寸照設計圖量（710 像素 ≈ 2.8 公尺）
const GF_PX = 0.00394, gfX = px => (px - 390) * GF_PX, gfY = py => (770 - py) * GF_PX;
const GF = { cx: gfX(380), cy: 1.42, ax: 1.1, ay: 1.4, az: 0.88 };
// 正面的縫：每一個高度（th 從頂上往下）開多寬（角度的一半）：中間最寬，底下也開著（最下面那顆頭從那裡露出來）
const gfGap = th => 0.3 + 0.55 * Math.exp(-(((th - 1.75) / 0.5) ** 2)) + 0.45 * sstep(2.3, 2.85, th);
// 豆莢的表面（th 從頂上往下、ph 繞一圈，0 是正前面）：頂上尖一點，一片一片葉子的稜、葉子邊緣疊在一起的地方凸一點
function gfPodPt(th, ph, out) {
  const st = Math.sin(th), y = Math.cos(th), top = Math.max(0, y);
  const k = (1 - 0.3 * top ** 2.5) * (1 + 0.035 * Math.sin(ph * 9 + th * 1.5) + 0.02 * Math.abs(Math.sin(ph * 4.5 + 0.7)) + 0.012 * Math.sin(th * 13 + ph * 3));
  return out.set(GF.cx + st * Math.sin(ph) * GF.ax * k, GF.cy + y * GF.ay * (1 + 0.06 * top), st * Math.cos(ph) * GF.az * k);
}
// 一半的豆莢（s = 1 右邊、-1 左邊）：從正面的縫繞到後面
function gfValveGeo(s) {
  return geo('gfValve' + s, () => {
    const NT = 64, NU = 44, C1 = NU + 1, pos = new Float32Array((NT + 1) * C1 * 3), uv = new Float32Array((NT + 1) * C1 * 2), P = new THREE.Vector3();
    for (let i = 0; i <= NT; i++) for (let j = 0; j <= NU; j++) {
      const th = 0.03 + (Math.PI - 0.06) * i / NT, g0 = gfGap(th), ph = s * (g0 + (Math.PI - g0) * j / NU), k = i * C1 + j;
      gfPodPt(th, ph, P);
      pos[k * 3] = P.x; pos[k * 3 + 1] = P.y; pos[k * 3 + 2] = P.z; uv[k * 2] = j / NU * 0.5 + (s > 0 ? 0.5 : 0); uv[k * 2 + 1] = 1 - i / NT;
    }
    const idx = [];
    for (let i = 0; i < NT; i++) for (let j = 0; j < NU; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; if (s > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}
// 葉子的貼圖：綠色，一條一條直的深淺綠（照設計圖的筆觸）、細細的葉脈、幾塊發黃、邊緣深一點
function gfLeafTex(inner) {
  return m5Tex('gfLeaf' + inner, 512, 512, (c, W, H) => {
    const r = seeded(inner ? 919 : 818);
    c.fillStyle = inner ? '#3e5a2a' : '#78ad55'; c.fillRect(0, 0, W, H);
    c.lineCap = 'round'; c.filter = 'blur(2px)';
    for (let i = 0; i < 420; i++) { const x = r() * W, y = r() * H * 0.9, l = 30 + r() * 140; c.strokeStyle = `rgba(${r() < 0.5 ? (inner ? '30,48,20' : '70,130,50') : (inner ? '90,110,60' : '170,214,120')},${(0.1 + r() * 0.2).toFixed(2)})`; c.lineWidth = 2 + r() * 10; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 8, y + l); c.stroke(); }
    c.filter = 'none';
    for (let i = 0; i < 60; i++) {   // 葉脈：一條主脈往兩邊斜斜地分出去
      const x = r() * W, y0 = r() * H;
      c.strokeStyle = inner ? 'rgba(110,130,80,.25)' : 'rgba(210,236,170,.35)'; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(x, y0); c.lineTo(x + (r() - 0.5) * 6, y0 + 90); c.stroke();
      for (let k = 0; k < 4; k++) { const yy = y0 + 15 + k * 18, sd = r() < 0.5 ? -1 : 1; c.lineWidth = 0.7; c.beginPath(); c.moveTo(x, yy); c.quadraticCurveTo(x + sd * 10, yy + 4, x + sd * 22, yy + 14); c.stroke(); }
    }
    for (let i = 0; i < 18; i++) { const x = r() * W, y = r() * H, rr = 10 + r() * 40, g = c.createRadialGradient(x, y, 0, x, y, rr); g.addColorStop(0, inner ? 'rgba(60,40,20,.3)' : 'rgba(200,190,80,.3)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
  }, true);
}
// 芯的貼圖：又黑又濕、一絲一絲直的纖維
let gfCoreTex = null;
function makeGfCore() {
  if (gfCoreTex) return;
  gfCoreTex = m5Tex('gfCore', 256, 512, (c, W, H) => {
    c.fillStyle = '#262220'; c.fillRect(0, 0, W, H);
    c.lineCap = 'round';
    for (let i = 0; i < 700; i++) { const x = rnd() * W, y = rnd() * H, l = 20 + rnd() * 120; c.strokeStyle = `rgba(${rnd() < 0.5 ? '70,62,56' : '8,6,6'},${(0.2 + rnd() * 0.4).toFixed(2)})`; c.lineWidth = 0.8 + rnd() * 2.2; c.beginPath(); c.moveTo(x, y); c.bezierCurveTo(x + (rnd() - 0.5) * 10, y + l * 0.3, x + (rnd() - 0.5) * 10, y + l * 0.7, x + (rnd() - 0.5) * 8, y + l); c.stroke(); }
  }, true);
}
// 四顆睡著的頭（照設計圖量）：[x, y, 頭的半寬, 往右歪, 往旁邊轉]
const GF_FACES = [[gfX(345), gfY(245), 0.34, 0.18, -0.12], [gfX(280), gfY(478), 0.22, -0.1, -0.35], [gfX(410), gfY(468), 0.28, 0.05, 0.15], [gfX(420), gfY(705), 0.34, -0.55, 0.2]];
const GF_HEAD = { rx: 1, ry: 1.28, rz: 0.95 };
const gfHeadGeo = () => sculptGeo('gfHead', (x, y, z, out) => dmHeadPt(x, y, z, out, GF_HEAD), dmU, dmV, th => sstep(0.9, 1.05, th) * (1 - sstep(2.5, 2.7, th)), a => sstep(-0.85, -0.7, a) * (1 - sstep(0.7, 0.85, a)), [0.016, 0.018]);
// 一條平平的長葉子（沿著曲線，寬度往兩頭變細，中間一條葉脈凸起來）
function gfBladeGeo(key, pts, w0) {
  return geo(key, () => {
    const cv = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), N = 60, pos = [], uv = [], idx = [], P = new THREE.Vector3(), Tn = new THREE.Vector3(), B = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const t = i / N, w = w0 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.05)) ** 0.5;
      cv.getPointAt(t, P); cv.getTangentAt(t, Tn); B.crossVectors(Tn, Z_AXIS).normalize();
      for (const k of [-1, -0.5, 0, 0.5, 1]) { pos.push(P.x + B.x * w * k / 2, P.y + B.y * w * k / 2, P.z + (1 - k * k) * w * 0.12); uv.push((k + 1) / 2, 1 - t); }
      if (i < N) for (let k = 0; k < 4; k++) { const a = i * 5 + k; idx.push(a, a + 5, a + 1, a + 1, a + 5, a + 6); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  });
}
function buildGreen(r, g) {
  makeDmFlesh(); makeGfCore();
  const T = { transparent: true };
  const leafO = withDetail(ownPhong('#ffffff', { map: gfLeafTex(false), specular: 0x3a4a2a, shininess: 40, shade: 0.75, ...T }), 'grass', 3, 0.5);
  const leafI = withDetail(ownLM('#ffffff', { map: gfLeafTex(true), side: THREE.BackSide, shade: 0.7, ...T }), 'grass', 3, 0.5);
  const leafD = withDetail(ownPhong('#ffffff', { map: gfLeafTex(false), specular: 0x3a4a2a, shininess: 40, side: THREE.DoubleSide, shade: 0.75, ...T }), 'grass', 3, 0.5);
  const core = withDetail(ownPhong('#ffffff', { map: gfCoreTex, specular: 0x302a26, shininess: 30, shade: 0.7, ...T }), 'bark', 2, 0.7);
  const stalk = withDetail(ownPhong('#9a7a62', { specular: 0x302a26, shininess: 30, shade: 0.7, ...T }), 'skin', 4, 0.8);
  const faceTex = [{ tone: '#d8aa8a', seed: 11 }, { tone: '#c8987a', seed: 12 }, { tone: '#deb294', seed: 13 }, { tone: '#cc9c80', seed: 14 }].map(o => { const m = withDetail(ownLM('#ffffff', { map: m5Tex('gfFace' + o.seed, 2048, 1024, (c, w, h) => dmPaintFace(c, w, h, { ...o, peach: false })), shade: 0.75, ...T }), 'skin', 6, 0.6); m.map.wrapS = THREE.ClampToEdgeWrapping; return m; });
  r.mats.push(leafO, leafI, leafD, core, stalk, ...faceTex);
  r.body = new THREE.Group(); g.add(r.body);
  // 兩半的豆莢（繞著後面慢慢開合）
  r.valves = [1, -1].map(s => {
    const piv = new THREE.Group(); piv.position.set(GF.cx, 0, -GF.az); r.body.add(piv);
    const geo = gfValveGeo(s);
    for (const m of [leafO, leafI]) { const mesh = new THREE.Mesh(geo, m); mesh.position.set(-GF.cx, 0, GF.az); piv.add(mesh); }
    // 縫的邊緣：圓圓的一圈（葉子的厚度）
    const pts = [];
    for (let i = 0; i <= 24; i++) { const th = 0.06 + (Math.PI - 0.12) * i / 24, P = gfPodPt(th, s * gfGap(th), new THREE.Vector3()); pts.push([P.x - GF.cx, P.y, P.z + GF.az]); }
    piv.add(new THREE.Mesh(tubeGeo('gfRim' + s, pts, pts.map(() => 0.03), 6, 60), leafO));
    piv.userData.s = s;
    return piv;
  });
  // 黑黑的芯
  const cx = gfX(350);
  r.body.add(new THREE.Mesh(loftGeo('gfCore', [
    { y: 0.12, x: cx + 0.05, z: -0.05, w: 0.22, d: 0.2 }, { y: 0.5, x: cx, z: -0.02, w: 0.3, d: 0.26, wv: 0.02 }, { y: 1.1, x: cx - 0.03, z: 0, w: 0.34, d: 0.28, wv: 0.03 },
    { y: 1.7, x: cx, z: 0, w: 0.32, d: 0.27, wv: 0.03 }, { y: 2.3, x: cx + 0.02, z: -0.03, w: 0.3, d: 0.25, wv: 0.02 }, { y: 2.7, x: cx + 0.04, z: -0.08, w: 0.18, d: 0.16 },
  ], { seg: 24, sub: 4, capA: 0.1, capB: 0.12, uv: [0, 2, 0, 1] }), core));
  // 四顆頭，各用一條肉柄連在芯上
  const hg = gfHeadGeo();
  r.faces = GF_FACES.map(([x, y, s, tilt, yaw], i) => {
    const grp = new THREE.Group(), z = 0.62 - s * 0.6 + (i === 3 ? -0.05 : 0);
    grp.position.set(x, y, z); grp.rotation.set(0, yaw, tilt); r.body.add(grp);
    const m = new THREE.Mesh(hg, faceTex[i]); m.scale.setScalar(s); grp.add(m);
    r.body.add(new THREE.Mesh(tubeGeo('gfStalk' + i, [[cx + (x - cx) * 0.2, y + 0.04, -0.02], [cx + (x - cx) * 0.6, y + 0.02, z - s * 0.9], [x, y, z - s * 0.6]], [0.07, 0.06, 0.08].map(v => v * (0.6 + s)), 8, 10), stalk));
    grp.userData = { y, tilt, yaw, ph: i * 1.7 };
    return grp;
  });
  // 從頂上往左邊彎下來拖到地上的長葉子、底下捲捲的鬚
  r.blade = new THREE.Group(); r.blade.position.set(GF.cx, 2.85, -0.1); r.body.add(r.blade);
  r.blade.add(new THREE.Mesh(gfBladeGeo('gfBlade', [[0, 0, 0], [-0.45, 0.28, 0.05], [-1.05, 0.2, 0.15], [-1.4, -0.4, 0.25], [-1.55, -1.4, 0.3], [-1.6, -2.4, 0.3], [-1.62, -2.8, 0.32]], 0.2), leafD));
  const tp = [];
  for (let i = 0; i <= 30; i++) { const t = i / 30, a = t * Math.PI * 5; tp.push([gfX(500) + t * 0.15 + Math.cos(a) * 0.05 * t, 0.08 - t * 0.04 + Math.sin(a) * 0.05 * t, 0.45 + Math.sin(a) * 0.03]); }
  r.body.add(new THREE.Mesh(tubeGeo('gfTendril', tp, tp.map((_, i) => 0.012 * (1 - i / 36)), 5, 60), leafO));
}
function syncGreen(r, t) {
  // 豆莢像在呼吸一樣慢慢開合；臉一起呼吸、輕輕地轉；長葉子晃
  const br = Math.sin(t * 0.6);
  for (const v of r.valves) v.rotation.y = v.userData.s * (0.03 + 0.03 * br);
  for (const f of r.faces) { const u = f.userData; f.rotation.set(0.03 * Math.sin(t * 0.4 + u.ph), u.yaw + 0.06 * Math.sin(t * 0.3 + u.ph), u.tilt + 0.04 * Math.sin(t * 0.35 + u.ph)); f.scale.setScalar(1 + 0.012 * Math.sin(t * 0.6 + u.ph * 0.2)); }
  r.blade.rotation.set(0.03 * Math.sin(t * 0.8), 0, 0.02 * Math.sin(t * 0.5));
}
// ---------- 複製人（羅剎級，7.9～10.2 公尺）----------
// 一大團粉紫色、像蛞蝓一樣的肉，貼在地上往兩邊攤開（左邊拖著一條越來越細的尾巴），上面一排長著六顆一模一樣的男人的頭
// （複製出來的：短短的黑頭髮、鬍渣、皺著眉頭、閉著眼睛），每顆頭用粗粗的脖子連在肉上、垂著頭；最左邊那顆特別大、轉向左邊（側臉）。
// 肉上一條一條斜斜的皺摺（設計圖的鉛筆線），左邊和右邊中間有一道往下的摺。
// 動作：整團肉慢慢地呼吸，六顆頭各自慢慢地晃、偶爾其中一顆突然抽一下。尺寸照設計圖量（405 像素 ≈ 9 公尺高）
const CL_PX = 0.0222, clX = px => (px - 330) * CL_PX, clY = py => (420 - py) * CL_PX;
// 身體沿著 x：[x, 中間多高, 前後多寬]
const CL_BODY = [[clX(8), 0.12, 0.5], [clX(40), 0.9, 1.5], [clX(95), 2.6, 2.4], [clX(140), 3.6, 3.0], [clX(210), 4.0, 3.3], [clX(330), 4.1, 3.4], [clX(450), 4.1, 3.4], [clX(540), 3.95, 3.3], [clX(590), 3.4, 3.2], [clX(622), 1.6, 3.0], [clX(640), 0.45, 2.7], [clX(648), 0.08, 2.4]];
function clTab(x) {
  const T = CL_BODY;
  let i = 0;
  while (i < T.length - 2 && x > T[i + 1][0]) i++;
  const a = T[Math.max(0, i - 1)], b = T[i], c = T[i + 1], d = T[Math.min(T.length - 1, i + 2)], t = clamp((x - b[0]) / (c[0] - b[0]), 0, 1);
  const cr = k => 0.5 * (2 * b[k] + (c[k] - a[k]) * t + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * t * t + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * t * t * t);
  return [Math.max(0.05, cr(1)), Math.max(0.3, cr(2))];
}
// 身體的表面：u 沿著 x、t 從後面（-1）到前面（1）；像一塊垂下來的布，中間圓圓的，往兩邊攤開貼到地上；斜斜的皺摺、左右中間一道往下的摺
function clBodyPt(x, t, out) {
  const [H, W] = clTab(x), at = Math.abs(t);
  let y = H * (1 - t * t) ** 1.7 * (1 + 0.3 * t * t), z = W * t * (1 + 0.22 * t ** 4) + 0.2;
  const fold = 0.14 * Math.sin(x * 1.25 + t * 2.6 + Math.sin(x * 0.4) * 2) * sstep(0.25, 0.85, at) + 0.06 * Math.sin(x * 3.1 - t * 4 + 1.3) * sstep(0.2, 0.7, at);
  z += Math.sign(t) * fold * (1 - sstep(0.85, 1, at));
  y += 0.05 * Math.sin(x * 2.3 + t * 7) * sstep(0.1, 0.5, at) * (1 - sstep(0.9, 1, at));
  const cr = Math.exp(-(((x - clX(255)) / 0.6) ** 2)) * sstep(0.25, 0.8, t);   // 左右中間往下的摺（只在正面）
  z -= 0.55 * cr; y -= 0.25 * cr * (1 - at);
  return out.set(x, Math.max(0, y), z);
}
function clBodyGeo() {
  return geo('clBody', () => {
    const NU = 150, NT = 56, C1 = NT + 1, x0 = CL_BODY[0][0], x1 = CL_BODY[CL_BODY.length - 1][0], pos = new Float32Array((NU + 1) * C1 * 3), uv = new Float32Array((NU + 1) * C1 * 2), P = new THREE.Vector3();
    for (let i = 0; i <= NU; i++) for (let j = 0; j <= NT; j++) {
      const k = i * C1 + j, x = x0 + (x1 - x0) * i / NU, t = -1 + 2 * j / NT;
      clBodyPt(x, t, P);
      pos[k * 3] = P.x; pos[k * 3 + 1] = P.y; pos[k * 3 + 2] = P.z; uv[k * 2] = i / NU * 6; uv[k * 2 + 1] = (1 - j / NT) * 2;
    }
    const idx = [];
    for (let i = 0; i < NU; i++) for (let j = 0; j < NT; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; idx.push(a, b, c, b, d, c); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  });
}
// 肉的貼圖：粉紫色，一筆一筆斜斜的深淺（設計圖的鉛筆線），幾塊比較紅、幾塊比較紫，細細的皺紋
let clSkinTex = null;
function makeClSkin() {
  if (clSkinTex) return;
  clSkinTex = m5Tex('clSkin', 512, 512, (c, W, H) => {
    c.fillStyle = '#c8939e'; c.fillRect(0, 0, W, H);
    for (let i = 0; i < 500; i++) { const x = rnd() * W, y = rnd() * H, rr = 10 + rnd() * 50, g = c.createRadialGradient(x, y, 0, x, y, rr), col = rnd() < 0.45 ? '206,120,128' : rnd() < 0.5 ? '160,128,168' : '226,196,198'; g.addColorStop(0, `rgba(${col},${(0.08 + rnd() * 0.1).toFixed(2)})`); g.addColorStop(1, `rgba(${col},0)`); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
    c.lineCap = 'round'; c.filter = 'blur(1.5px)';
    for (let i = 0; i < 900; i++) { const x = rnd() * W, y = rnd() * H, l = 10 + rnd() * 50; c.strokeStyle = `rgba(${rnd() < 0.5 ? '120,74,96' : '236,210,214'},${(0.04 + rnd() * 0.09).toFixed(2)})`; c.lineWidth = 0.8 + rnd() * 2.5; c.beginPath(); c.moveTo(x, y); c.lineTo(x + l * 0.5, y + l); c.stroke(); }
    c.filter = 'none';
  }, true);
}
// 六顆頭（照設計圖量）：[x 像素, y 像素, 頭的半寬（公尺）, 往旁邊轉, 低頭, 歪]
// [x 像素, 前後, 頭的半寬（公尺）, 往旁邊轉, 低頭, 歪]：頭擠在一起、一前一後疊著，下巴直接靠在肉上
const CL_HEADS = [[165, 0.2, 1.38, -1.25, 0.22, 0.05], [262, 0.8, 1.15, -0.08, 0.26, 0.08], [334, 0.1, 1.2, -0.42, 0.22, -0.05], [406, 0.7, 1.15, -0.6, 0.3, 0.1], [480, 0.05, 1.2, -0.15, 0.24, -0.06], [556, 0.6, 1.15, -0.45, 0.22, 0.04]];
const CL_HEAD = { rx: 1, ry: 1.65, rz: 1.08 };   // 長長的臉
const clHeadGeo = () => sculptGeo('clHead', (x, y, z, out) => dmHeadPt(x, y, z, out, CL_HEAD), dmU, dmV, th => sstep(0.9, 1.05, th) * (1 - sstep(2.5, 2.7, th)), a => sstep(-0.85, -0.7, a) * (1 - sstep(0.7, 0.85, a)), [0.016, 0.018]);
// 複製人的臉：白日夢那張睡著的臉（同一套五官），加上短短的黑頭髮、鬍渣、皺著的濃眉
function clPaintHead(c, W, H) {
  dmPaintFace(c, W, H, { tone: '#d9ac8e', peach: false, seed: 77 });
  const { at, soft, curve } = headPainter(c, W, H, dmU, dmV), r = seeded(7070);
  // 鬍渣：下巴、兩頰下半、上唇（一點一點）
  for (let i = 0; i < 2600; i++) {
    const X = (r() - 0.5) * 1.3, Y = -0.2 - r() * 0.65;
    if (Math.abs(X) < 0.3 && Math.abs(Y + 0.39) < 0.06) continue;   // 嘴唇
    if (Math.hypot(X / 0.62, (Y + 0.2) / 0.62) > 1) continue;
    at(X, Y, () => { c.fillStyle = `rgba(60,48,46,${(0.1 + r() * 0.2).toFixed(2)})`; c.fillRect(0, 0, 0.7, 0.7); });
  }
  at(0, -0.5, () => soft(0, 0, 40, 30, '#6a6066', 0.18));
  // 皺著的濃眉、眉心的皺紋
  for (const s of [-1, 1]) at(s * 0.33, 0.29, () => { for (let i = 0; i < 70; i++) { const t = i / 69, x = -20 + t * 41, y = 3 * Math.sin(t * Math.PI) - t * 4 + (r() - 0.5) * 2; curve([x, y, x + 2.5, y + 0.6 - t * 1.5], 'rgba(40,30,26,.55)', 0.7); } }, s);
  at(0, 0.3, () => { for (const s of [-1, 1]) curve([s * 2.5, -4, s * 1.5, 5], 'rgba(90,60,46,.4)', 0.8); });
  // 短短的黑頭髮：頭頂和後腦勺（前面的髮際線在額頭上面，往兩邊、往後越來越低）
  const r2 = seeded(7171);
  for (let x = 0; x < W; x++) {
    const a = dmU.inv((x + 0.5) / W), th = 0.62 + 1.25 * sstep(0.7, 2.6, Math.abs(a)), y1 = dmV(th) * H;
    const g = c.createLinearGradient(0, y1 - 14, 0, y1 + 6); g.addColorStop(0, 'rgba(26,22,20,.95)'); g.addColorStop(1, 'rgba(26,22,20,0)');
    c.fillStyle = 'rgba(26,22,20,.95)'; c.fillRect(x, 0, 1, y1 - 14); c.fillStyle = g; c.fillRect(x, y1 - 14, 1, 20);
  }
  c.lineCap = 'round';
  for (let i = 0; i < 4000; i++) { const x = r2() * W, a = dmU.inv(x / W), th = (0.62 + 1.25 * sstep(0.7, 2.6, Math.abs(a))) * r2(), y = dmV(th) * H; c.strokeStyle = `rgba(${r2() < 0.5 ? '60,52,48' : '8,6,6'},.5)`; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r2() - 0.5) * 3, y + 4 + r2() * 5); c.stroke(); }
}
function buildClone(r, g) {
  makeDmFlesh(); makeClSkin();
  const T = { transparent: true };
  const skin = withDetail(ownPhong('#ffffff', { map: clSkinTex, specular: 0x2a2024, shininess: 20, side: THREE.DoubleSide, shade: 0.75, ...T }), 'skin', 0.8, 0.7);
  const neckM = withDetail(ownPhong('#ffffff', { map: clSkinTex, specular: 0x2a2024, shininess: 20, shade: 0.75, ...T }), 'skin', 0.8, 0.7);
  const face = withDetail(ownLM('#ffffff', { map: m5Tex('clHead', 2048, 1024, clPaintHead), shade: 0.75, ...T }), 'skin', 2, 0.7);
  face.map.wrapS = THREE.ClampToEdgeWrapping;
  r.mats.push(skin, neckM, face);
  r.body = new THREE.Group(); g.add(r.body);
  r.flesh = new THREE.Mesh(clBodyGeo(), skin); r.body.add(r.flesh);
  const hg = clHeadGeo();
  r.heads = CL_HEADS.map(([px, z, s, yaw, nod, tilt], i) => {
    const x = clX(px), ridge = clTab(x)[0], y = ridge + 0.1 + s * CL_HEAD.ry * 0.95;
    const piv = new THREE.Group(); piv.position.set(x, ridge - 0.6, 0.2); r.body.add(piv);
    const hy = y - (ridge - 0.6), head = new THREE.Group(); head.position.set(0, hy, z - 0.2); head.rotation.set(nod, yaw, tilt, 'YXZ'); piv.add(head);
    const m = new THREE.Mesh(hg, face); m.scale.setScalar(s); head.add(m);
    // 粗粗的脖子：從肉裡長出來，接到下巴底下、後腦勺下面
    piv.add(new THREE.Mesh(tubeGeo('clNeck' + i, [[0, -0.8, 0], [0, (hy - s * 1.2) * 0.5, 0.05], [Math.sin(yaw) * s * 0.1, hy - s * 1.2, z - 0.2 - s * 0.25]], [s * 1.05, s * 0.8, s * 0.62], 14, 10), neckM));
    piv.userData = { ph: i * 1.9, yaw, nod, tilt, head };
    return piv;
  });
  r.twitch = { n: -1, k: 0 };
}
function syncClone(r, t) {
  // 慢慢地呼吸；六顆頭各自慢慢地晃，每 3.5 秒其中一顆突然抽一下
  r.flesh.scale.set(1, 1 + 0.015 * Math.sin(t * 0.5), 1 + 0.012 * Math.sin(t * 0.5 + 0.4));
  const P = 3.5, n = Math.floor(t / P), tau = t - n * P, tw = r.twitch;
  if (n !== tw.n) { tw.n = n; tw.k = Math.floor(hash01(n * 2.3) * r.heads.length); }
  r.heads.forEach((piv, i) => {
    const u = piv.userData, jerk = i === tw.k && tau < 0.25 ? Math.sin(tau / 0.25 * Math.PI) : 0;
    piv.rotation.set(0.04 * Math.sin(t * 0.4 + u.ph), 0, 0.05 * Math.sin(t * 0.33 + u.ph));
    u.head.rotation.set(u.nod + 0.06 * Math.sin(t * 0.5 + u.ph) - 0.3 * jerk, u.yaw + 0.08 * Math.sin(t * 0.27 + u.ph), u.tilt + 0.25 * jerk, 'YXZ');
  });
}
// 熔岩暴君走過留下的熔岩：地上一灘一灘發光的痕跡，15 秒後慢慢冷卻變黑
let lavaMesh = null;
const LAVA_MAX = 60, _lcol = new THREE.Color();
function syncLava3(t) {
  const lava = G.lava || [];
  if (!lavaMesh && lava.length) {
    lavaMesh = new THREE.InstancedMesh(geo('trail', () => new THREE.CircleGeometry(1, 14)), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false }), LAVA_MAX);
    lavaMesh.frustumCulled = false; lavaMesh.count = 0;
    scene.add(lavaMesh);
  }
  if (!lavaMesh) return;
  const n = Math.min(LAVA_MAX, lava.length);
  for (let i = 0; i < n; i++) {
    const l = lava[lava.length - n + i], hot = clamp((l.life - 4) / 11, 0, 1);
    _q.setFromEuler(_e.set(-Math.PI / 2, 0, l.a, 'XYZ'));
    _m4.compose(_v.set(l.x, floorH(l.x, l.y) + 0.014 + i * 0.00005, l.y), _q, _sc.set(l.r, l.r * 0.8, 1));
    lavaMesh.setMatrixAt(i, _m4);
    _lcol.setRGB(0.12 + hot * 0.88, 0.06 + hot * 0.4 * (0.7 + 0.3 * Math.sin(t * 4 + i)), 0.04 + hot * 0.05);
    lavaMesh.setColorAt(i, _lcol);
  }
  lavaMesh.count = n; lavaMesh.instanceMatrix.needsUpdate = true;
  if (lavaMesh.instanceColor) lavaMesh.instanceColor.needsUpdate = true;
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
    r.g.position.set(a.x, a.h + floorH(a.x, a.y), a.y);
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
// ====================================================================
// 第四世界：真的東西的 3D 模型（設計師：東西就直接是實體，不要只能看光尋找）。架上、地上的 G.pickups 都用這個；
// 每一種東西做一個原型（底部在 y = 0、正面朝 +z），用的時候 clone（共用幾何和材質）
// ====================================================================
const item3dProto = new Map(), labelMats = new Map();
// 包裝上印的圖：底色、emoji、一行字
function labelMat(key, bg, icon, text = '', fg = '#fff') {
  if (labelMats.has(key)) return labelMats.get(key);
  const t = canvasTex(128, 128, c => {
    c.fillStyle = bg; c.fillRect(0, 0, 128, 128);
    c.fillStyle = 'rgba(255,255,255,.18)'; c.fillRect(0, 0, 128, 18);
    c.font = '64px "Apple Color Emoji","Segoe UI Emoji",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(icon, 64, text ? 56 : 66);
    if (text) { c.fillStyle = fg; c.font = 'bold 22px sans-serif'; c.fillText(text, 64, 108); }
  });
  const m = patchLM(new THREE.MeshLambertMaterial({ map: t }));
  labelMats.set(key, m); return m;
}
function bulbCol(t) { const c = BULBS[t] && BULBS[t].color; return c === 'rainbow' || !c ? '#ffd8ff' : `rgb(${c.join(',')})`; }
function buildItem3D(id) {
  const g = new THREE.Group(), it = ITEMS[id] || {};
  const cup = (r0, r1, h, mat, y = 0, x = 0, z = 0) => cyl(g, r0, r1, h, x, y, z, mat, 14);
  const pack = (w, h, d, mat, front) => { box(g, -w / 2, w / 2, 0, h, -d / 2, d / 2, mat); if (front) box(g, -w / 2 + 0.004, w / 2 - 0.004, 0.004, h - 0.004, d / 2, d / 2 + 0.002, front, false); };
  switch (id) {
    case 'hotdog':
      box(g, -0.1, 0.1, 0, 0.012, -0.045, 0.045, lm('#f2efe8'));
      sph(g, 0.03, 0, 0.035, -0.012, lm('#d8a058'), 3.2, 0.95, 0.9); sph(g, 0.03, 0, 0.035, 0.012, lm('#d8a058'), 3.2, 0.95, 0.9);
      sph(g, 0.017, 0, 0.055, 0, lm('#a8442a'), 6.2, 1, 1); box(g, -0.07, 0.07, 0.07, 0.074, -0.004, 0.004, lm('#e8c23a'), false);
      break;
    case 'pizza': pack(0.3, 0.045, 0.3, lm('#d8c8a8')); box(g, -0.12, 0.12, 0.045, 0.047, -0.12, 0.12, labelMat('pizza', '#c8382a', '🍕', '披薩'), false); break;
    case 'fries':
      cup(0.05, 0.035, 0.09, lm('#c8262a'));
      for (let i = 0; i < 9; i++) box(g, -0.035 + (i % 5) * 0.016, -0.027 + (i % 5) * 0.016, 0.06, 0.13 + (i % 3) * 0.012, -0.012 + (i % 2) * 0.016, -0.004 + (i % 2) * 0.016, lm('#f2c84a'), false);
      break;
    case 'soda':
      cup(0.045, 0.036, 0.15, labelMat('soda', '#d8302a', '🥤', '汽水')); cup(0.048, 0.048, 0.01, lm('#f2f2f2'), 0.15);
      cyl(g, 0.005, 0.005, 0.09, 0.012, 0.15, 0, lm('#e8e8e8'), 6);
      break;
    case 'cake': cup(0.085, 0.09, 0.07, lm('#f4ead8')); cup(0.087, 0.087, 0.012, lm('#f8f4f0'), 0.07); sph(g, 0.014, 0, 0.09, 0, lm('#c8202a')); break;
    case 'meatball':
      cup(0.11, 0.09, 0.015, lm('#f4f4f2'));
      for (let i = 0; i < 6; i++) sph(g, 0.022, Math.cos(i) * 0.05, 0.035, Math.sin(i) * 0.05, lm('#6a3a22'));
      sph(g, 0.03, 0, 0.03, 0, lm('#e8d8a8'), 1.3, 0.6, 1.3);
      break;
    case 'snack': { const m = sph(g, 0.08, 0, 0.1, 0, labelMat('snack', '#e8742a', '🍪', '餅乾'), 1, 1.3, 0.38); m.rotation.y = Math.PI / 2; break; }
    case 'canned': cup(0.04, 0.04, 0.11, labelMat('canned', '#3a7a3a', '🥫', '罐頭')); cup(0.04, 0.04, 0.006, lm('#b8bcc0'), 0.11); break;
    case 'noodles': cup(0.058, 0.045, 0.1, labelMat('noodles', '#e8e2d0', '🍜', '泡麵', '#c8262a')); cup(0.06, 0.06, 0.006, lm('#c8262a'), 0.1); break;
    case 'cocoa': cup(0.04, 0.035, 0.09, lm('#7a4a2a')); box(g, 0.035, 0.055, 0.02, 0.07, -0.006, 0.006, lm('#7a4a2a')); cup(0.036, 0.036, 0.004, lm('#4a2a1a'), 0.085); break;
    case 'chocolate': pack(0.16, 0.02, 0.07, lm('#5a3020')); box(g, -0.05, 0.05, 0, 0.022, -0.036, 0.036, labelMat('choco', '#6a2a8a', '🍫', ''), false); break;
    case 'milk': pack(0.07, 0.16, 0.07, lm('#f4f4f2'), labelMat('milk', '#f4f4f2', '🥛', '牛奶', '#2a5aa8')); { const r = cyl(g, 0, 0.05, 0.045, 0, 0.16, 0, lm('#3a7ad8'), 4); r.rotation.y = Math.PI / 4; } break;
    case 'battery':
      box(g, -0.04, 0.04, 0, 0.1, -0.005, 0.005, labelMat('batt', '#2a2a2a', '🔋', '電池', '#ffd23a'));
      for (const x of [-0.02, 0.02]) { cyl(g, 0.013, 0.013, 0.05, x, 0.03, 0.02, lm('#1e1e1e'), 10); cyl(g, 0.013, 0.013, 0.012, x, 0.07, 0.02, lm('#c8902a'), 10); }
      break;
    case 'candle': cup(0.025, 0.026, 0.13, lm('#f2ece0')); cyl(g, 0.002, 0.002, 0.015, 0, 0.13, 0, lm('#222'), 4); cup(0.04, 0.04, 0.008, lm('#b8902a')); break;
    case 'pan': cup(0.11, 0.09, 0.035, lm('#2a2a2c')); box(g, 0.1, 0.27, 0.025, 0.04, -0.012, 0.012, lm('#3a2a1e')); break;
    case 'slingshot':
      box(g, -0.012, 0.012, 0, 0.1, -0.012, 0.012, lm('#8a5a32'));
      for (const s of [-1, 1]) { const b = box(g, -0.01, 0.01, 0, 0.08, -0.01, 0.01, lm('#8a5a32')); b.position.set(s * 0.025, 0.13, 0); b.rotation.z = -s * 0.4; }
      break;
    case 'watergun': box(g, -0.09, 0.09, 0.03, 0.08, -0.02, 0.02, lm('#2a8ad8')); box(g, -0.06, -0.03, 0, 0.05, -0.018, 0.018, lm('#e8742a')); cup(0.03, 0.03, 0.05, lm('#9ad8f8'), 0.08, -0.02); break;
    case 'firecracker': for (let i = 0; i < 5; i++) { const c = cyl(g, 0.012, 0.012, 0.14, (i - 2) * 0.026, 0.012, 0, lm('#c8202a'), 8); c.rotation.z = Math.PI / 2; c.position.y = 0.012 + (i % 2) * 0.02; } break;
    case 'salt': cup(0.035, 0.035, 0.12, labelMat('salt', '#2a5aa8', '🧂', '鹽巴')); cup(0.036, 0.036, 0.015, lm('#f2f2f2'), 0.12); break;
    case 'marble': for (let i = 0; i < 5; i++) sph(g, 0.012, (i - 2) * 0.026, 0.012, (i % 2) * 0.02, lm(['#3a8ad8', '#d83a5a', '#3ad87a', '#e8c23a', '#9a5ad8'][i], { transparent: true, opacity: 0.85 })); break;
    case 'holywater': cup(0.03, 0.032, 0.12, lm('#9ad8f8', { transparent: true, opacity: 0.7 })); cup(0.012, 0.012, 0.03, lm('#e8e8f0'), 0.12); box(g, -0.02, 0.02, 0.05, 0.08, 0.031, 0.033, lm('#f2d24a'), false); break;
    case 'amulet': box(g, -0.025, 0.025, 0, 0.07, -0.004, 0.004, lm('#c8202a')); box(g, -0.015, 0.015, 0.02, 0.05, 0.004, 0.006, lm('#f2c84a'), false); break;
    case 'bandage': { const c = cyl(g, 0.035, 0.035, 0.05, 0, 0.035, 0, lm('#f4f0ea'), 14); c.rotation.x = Math.PI / 2; break; }
    case 'medkit': pack(0.18, 0.1, 0.08, lm('#c8262a'), labelMat('medkit', '#c8262a', '➕', '急救箱')); box(g, -0.03, 0.03, 0.1, 0.115, -0.006, 0.006, lm('#2a2a2a')); break;
    case 'key': box(g, -0.006, 0.006, 0, 0.004, -0.04, 0.02, lm('#e8c23a')); cyl(g, 0.016, 0.016, 0.004, 0, 0, 0.035, lm('#e8c23a'), 10); break;
    case 'coin': for (let i = 0; i < 3; i++) cyl(g, 0.028, 0.028, 0.006, (i - 1) * 0.004, i * 0.006, 0, lm('#f2c14e'), 14); break;
    case 'wood': for (let i = 0; i < 3; i++) { const c = cyl(g, 0.035, 0.035, 0.32, 0, 0.035 + (i === 2 ? 0.06 : 0), (i === 2 ? 0 : i - 0.5) * 0.072, lm('#8a5a32'), 8); c.rotation.z = Math.PI / 2; } break;
    case 'charcoal': for (let i = 0; i < 4; i++) sph(g, 0.035, (i - 1.5) * 0.04, 0.03, (i % 2) * 0.03, lm('#222222'), 1.2, 0.8, 1); break;
    default:
      if (it.kind === 'bulb' && isTvTier(it.tier)) {
        // 電視（第 6 級以上的燈泡）：一台小電視，螢幕是那一級燈泡的顏色
        box(g, -0.2, 0.2, 0, 0.03, -0.08, 0.08, lm('#2a2c30'));
        box(g, -0.025, 0.025, 0.03, 0.08, -0.02, 0.02, lm('#2a2c30'));
        box(g, -0.24, 0.24, 0.08, 0.38, -0.02, 0.02, lm('#1a1b1e'));
        box(g, -0.22, 0.22, 0.1, 0.36, 0.02, 0.024, ownBasic({ color: bulbCol(it.tier) }), false);
      } else if (it.kind === 'bulb' || it.kind === 'lamp') {
        // 檯燈（設計師：燈泡不要了，直接就是檯燈）：圓底座、金屬桿、布燈罩，燈泡的顏色看得出等級
        const tier = it.tier || 0, col = it.kind === 'bulb' ? bulbCol(tier) : '#fff4d8', tall = it.lamp === 'floor';
        const H = tall ? 0.62 : 0.3;
        cup(0.06, 0.07, 0.025, lm('#3a3c40'));
        cyl(g, 0.008, 0.008, H, 0, 0.025, 0, lm('#b8a070'), 6);
        sph(g, 0.035, 0, H + 0.01, 0, ownBasic({ color: col }));
        cyl(g, 0.06, 0.1, 0.11, 0, H - 0.03, 0, lm(tier >= 9 ? '#e8d8a8' : '#f2ead8', { side: THREE.DoubleSide }), 16, true);
        if (it.lamp === 'chand') for (let i = 0; i < 6; i++) sph(g, 0.015, Math.cos(i) * 0.09, H - 0.05, Math.sin(i) * 0.09, lm('#dff0ff', { transparent: true, opacity: 0.8 }));
      } else if (FLASH_UP[id]) {
        const lv = FLASH_UP[id], c = FLASH_TIERS[lv].color;
        const b = cyl(g, 0.022, 0.022, 0.17, 0, 0.022, 0, lm(lv >= 4 ? c : '#3a3a3a'), 12); b.rotation.x = Math.PI / 2;
        const h = cyl(g, 0.034, 0.024, 0.05, 0, 0.022, 0.1, lm('#c8ccd0'), 12); h.rotation.x = Math.PI / 2;
      } else pack(0.1, 0.12, 0.06, lm('#e8e4dc'), labelMat('it:' + id, '#5a6a7a', it.icon || '📦', it.name ? it.name.slice(0, 4) : ''));
  }
  g.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return g;
}
function item3D(id) {
  let p = item3dProto.get(id);
  if (!p) { p = buildItem3D(id); item3dProto.set(id, p); }
  return p.clone();
}
const pickMap = new Map();
function syncExtras(t) {
  const shop = !!(G.stock && G.stock.length) && merchantHere() && mode !== 'title';
  merchant.visible = shop && !isW4();
  if (merchant.visible) { merchant.position.set(MERCHANT_POS.x, floorH(MERCHANT_POS.x, MERCHANT_POS.y), MERCHANT_POS.y); merchant.rotation.y = Math.atan2(G.p.x - MERCHANT_POS.x, G.p.y - MERCHANT_POS.y); }
  // 第四世界是神秘店員（每天在不同的地方）：面向你、鈴鐺輕輕晃、油燈的火一閃一閃
  if (isW4() && shop && !clerk4) clerk4 = buildClerk4();
  if (clerk4) {
    clerk4.g.visible = shop && isW4();
    if (clerk4.g.visible) {
      clerk4.g.position.set(MERCHANT_POS.x, 0, MERCHANT_POS.y);
      clerk4.g.rotation.y = Math.atan2(G.p.x - MERCHANT_POS.x, G.p.y - MERCHANT_POS.y);
      clerk4.bell.rotation.z = Math.sin(t * 0.9) * 0.06;   // 長棍慢慢晃
      clerk4.lamp.rotation.z = Math.sin(t * 1.3) * 0.08;
      clerk4.lg.material.opacity = 0.7 + 0.2 * Math.sin(t * 13) * Math.sin(t * 7);
    }
  }
  gift.visible = !!G.gift && mode !== 'title';
  if (gift.visible) gift.userData.glow.material.opacity = 0.45 + 0.3 * Math.sin(t * 3);
  treasureStar.visible = !!G.treasure && mode !== 'title';
  if (treasureStar.visible) {
    treasureStar.position.set(G.treasure.x, floorH(G.treasure.x, G.treasure.y) + 0.7 + Math.sin(t * 2) * 0.08, G.treasure.y);
    treasureStar.rotation.y = t * 1.5;
  }
  const seen = new Set();
  const w4 = isW4();
  for (const pk of G.pickups) {
    seen.add(pk);
    let s = pickMap.get(pk);
    if (s && !!s.isSprite === w4) { scene.remove(s); if (s.isSprite) s.material.dispose(); s = null; }
    if (!s) {
      if (w4) { s = item3D(pk.id); s.rotation.y = Math.PI / 2 - (pk.a || 0); }   // 第四世界：真的東西（架上、地上）
      else { s = new THREE.Sprite(new THREE.SpriteMaterial({ map: pickupTex(pk.id), transparent: true, depthWrite: false })); s.material.userData.own = true; s.scale.setScalar(0.32); }
      scene.add(s); pickMap.set(pk, s);
    }
    if (w4) {
      // 太遠的不畫（架上的東西很多，平板才跑得動）
      s.visible = (pk.x - camera.position.x) ** 2 + (pk.y - camera.position.z) ** 2 < Math.min(16, scene.fog.far) ** 2;
      if (s.visible) s.position.set(pk.x, pk.z !== undefined ? pk.z : floorH(pk.x, pk.y), pk.y);
      continue;
    }
    s.position.set(pk.x, floorH(pk.x, pk.y) + 0.3 + Math.sin(pk.t * 3) * 0.05, pk.y);
    s.visible = !(pk.age > 100 && Math.sin(t * 12) < 0); // 快消失時會閃
  }
  for (const [pk, s] of pickMap) if (!seen.has(pk)) { scene.remove(s); if (s.isSprite) s.material.dispose(); pickMap.delete(pk); }
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
    case 'kronos': return 1.95;
    case 'tyrant': return 3.0;
    case 'warlord': return 2.9;
    case 'taowu': return 2.6;
    case 'staff': return 2.4;
    case 'shake': return t.awake ? 0.85 : 0.6;
    case 'mimic': return t.state === 'hunt' ? 1.5 : 2.1;
    case 'hubert': return 2.4;
    case 'ember': return 3.35;
    default: return 2.0;
  }
}
function drawHpBar(c, t, ratio) {
  c.clearRect(0, 0, 160, 44);
  c.fillStyle = 'rgba(8,6,12,.6)';
  c.beginPath(); c.roundRect(0, 0, 160, 44, 10); c.fill();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = BOSSES.includes(t.kind) ? '#ffb347' : '#f0ecf5';
  const label = `Lv.${t.lv} ${MONSTER_NAME[kindOf(t)]}`;
  c.font = 'bold 17px sans-serif';
  if (c.measureText(label).width > 150) c.font = 'bold 13px sans-serif';   // 名字太長就縮小
  c.fillText(label, 80, 14);
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
    b.sp.position.set(t.x, barH(t) + floorH(t.x, t.y), t.y);
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
    r.g.position.set(f.x, f.h + floorH(f.x, f.y), f.y);
    r.outer.scale.setScalar(0.5 + 0.1 * Math.sin(t * 30));
  }
  for (const [f, r] of fbMap) if (!seen.has(f)) { disposeGroup(r.g); fbMap.delete(f); }
}

// ====================================================================
// 舊怪物照第五世界的做法重做：雕出來的網格（sculptGeo、loftGeo、tubeGeo）、逐點畫的貼圖，
// 貼圖一樣預先畫好存成 tex/m5-<key>.webp（m5Tex；tools/make-monster5-tex.mjs 會把 UPG 裡的怪物也蓋一次）。
// 每隻重做好的怪物在自己那一段登記：UPG.<kind> = { build(r, g), sync(e, r, t, p, dt), view }（view 是圖鑑的鏡頭，跟 BOOK_VIEW 一樣），
// buildEnemy、syncEnemy、圖鑑會先用這裡的（舊的 build*、NEW_BUILD、BOOK_VIEW 不用改）。順序和進度在 docs/monster-upgrade-plan.md
// ====================================================================
const UPG = {};
// 3D 的雜訊（逐點畫貼圖用）：在單位球、圓柱上取樣，繞一圈不會有接縫
const nHash3 = (x, y, z, s) => { const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19) * 43758.5453; return h - Math.floor(h); };
function vnoise3(x, y, z, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf), h = (i, j, k) => nHash3(xi + i, yi + j, zi + k, s), L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h(0, 0, 0), h(1, 0, 0), u), L(h(0, 1, 0), h(1, 1, 0), u), v), L(L(h(0, 0, 1), h(1, 0, 1), u), L(h(0, 1, 1), h(1, 1, 1), u), v), w);
}
const fbm3 = (x, y, z, oct = 4, s = 0) => { let a = 0, k = 0.5, f = 1; for (let i = 0; i < oct; i++) { a += k * vnoise3(x * f, y * f, z * f, s + i * 7); k *= 0.5; f *= 2.03; } return a / (1 - 0.5 ** oct); };
// 幾個網格照各自的位置合成一個（手掌和手指合成一隻手，一隻手只要畫一次）
function mergeParts(key, parts) {
  return geo(key, () => {
    const gs = parts.map(([gm, m]) => { const c = (gm.index ? gm.toNonIndexed() : gm.clone()); c.applyMatrix4(m); return c; });
    let n = 0; for (const c of gs) n += c.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const c of gs) { pos.set(c.attributes.position.array, o * 3); nor.set(c.attributes.normal.array, o * 3); if (c.attributes.uv) uv.set(c.attributes.uv.array, o * 2); o += c.attributes.position.count; c.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  });
}
const mat4 = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

// ---------- 黑影 ----------
// 一個用很濃的黑煙凝成的人形，比人高一點：駝著背、頭往前伸，長長的手臂垂到膝蓋、手指又細又長；
// 腰以下散成一縷一縷的煙、飄在地上；臉上沒有五官，只有兩個很深的眼窩，裡面亮著紅光，照得眼窩周圍紅紅的。身上一直冒出黑煙
const SH_HEAD = { x: 0, y: 1.72, z: 0.15, rx: 0.098, ry: 0.128, rz: 0.112 };
const SH_EYE = { x: 0.37, y: 0.05, R: 0.016 };
const SH_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]（單位球上，正面看）
  [0, 0.25, 0.55, 0.085, 0.09, false],            // 眉骨
  [SH_EYE.x, SH_EYE.y, 0.15, 0.115, -0.32, true],  // 眼窩（很深）
  [0.52, -0.17, 0.12, 0.09, 0.05, true],          // 顴骨
  [0.4, -0.42, 0.15, 0.15, -0.07, true],          // 臉頰凹下去
  [0, 0.03, 0.05, 0.2, 0.035, false],             // 鼻樑（沒有鼻子，只有一條隆起）
  [0, -0.55, 0.3, 0.06, -0.025, false],           // 嘴的地方淡淡的一條凹痕（沒有嘴）
];
function shHeadPt(x, y, z, out) {
  let X = x, Y = y, Z = z;
  if (Y < 0) { const t = -Y; X *= 1 - 0.3 * t * t; if (Z > 0) Z *= 1 + 0.1 * t; }   // 下巴窄、往前
  if (Z < 0) Z *= 1.12;   // 後腦勺大一點
  else Z *= 1 - 0.14 * (1 - Y * Y);   // 臉平一點（不是一顆蛋）
  let d = 0;
  if (z > 0) {
    for (const f of SH_FACE) for (const s of f[5] ? [-1, 1] : [1]) { const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3]; if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v); }
    d *= sstep(0.05, 0.45, z);
  }
  const k = 1 + d / (Math.hypot(X, Y, Z) || 1);
  return out.set(X * k * SH_HEAD.rx, Y * k * SH_HEAD.ry, Z * k * SH_HEAD.rz);
}
const shU = crWarp(-Math.PI, Math.PI, a => 1 + 1.2 * Math.exp(-((a / 0.8) ** 2))), shV = crWarp(0, Math.PI, th => 1 + 1.0 * Math.exp(-(((th - 1.5) / 0.6) ** 2)));
const shHeadGeo = () => sculptGeo('shHead', shHeadPt, shU, shV, th => sstep(0.85, 1.0, th) * (1 - sstep(2.2, 2.4, th)), a => sstep(-1.0, -0.85, a) * (1 - sstep(0.85, 1.0, a)), [0.065, 0.07], [0.16, 0.17]);   // 五官都是大範圍的起伏，格子不用很密（一隻黑影常常好幾隻一起出來）
// 身體：脖子往下到散開的煙（往前駝，肩膀在脖子後面一點）；SH_SHELL 是外面那層薄薄的煙（大一圈）
const SH_BODY = [
  { y: 0.08, w: 0.03, d: 0.03, x: 0.05, z: -0.12 }, { y: 0.28, w: 0.075, d: 0.065, x: 0.025, z: -0.09 }, { y: 0.52, w: 0.13, d: 0.1, z: -0.06 },
  { y: 0.78, w: 0.175, d: 0.125, z: -0.03 }, { y: 0.97, w: 0.165, d: 0.115, z: -0.02 }, { y: 1.13, w: 0.162, d: 0.105, z: 0 },
  { y: 1.3, w: 0.2, d: 0.118, z: 0.02 }, { y: 1.44, w: 0.238, d: 0.12, z: 0.05 }, { y: 1.52, w: 0.25, d: 0.11, z: 0.075 },
  { y: 1.575, w: 0.15, d: 0.088, z: 0.095 }, { y: 1.63, w: 0.056, d: 0.054, z: 0.12 }, { y: 1.7, w: 0.05, d: 0.05, z: 0.135 },
];
const SH_SHELL = SH_BODY.map(r => ({ ...r, w: r.w * 1.1 + 0.014, d: r.d * 1.1 + 0.014 }));
// 手臂（從肩膀往下，左手；右手 x 反過來）：上臂、手肘、前臂、手腕
const SH_ARM = [[[0, 0, 0], [-0.045, -0.2, -0.02], [-0.065, -0.38, -0.01], [-0.07, -0.56, 0.04], [-0.068, -0.74, 0.09]], [0.05, 0.043, 0.036, 0.031, 0.026]];
const SH_SHOULDER = { x: 0.215, y: 1.5, z: 0.065 };
// 煙的貼圖：很黑，有一點點灰紫色的煙紋往上流；身體那張腰以下慢慢散掉（透明），剩下一縷一縷的煙
function shSmokeLum(cx, cy, cz, s) {
  const q = fbm3(cx * 1.2, cy * 1.2, cz * 1.2, 3, s);
  const n = fbm3(cx * 2.6 + q * 1.6, cy * 2.6 - q * 1.2, cz * 2.6, 5, s + 3);
  return n;
}
function shPaintBody(c, W, H) {
  const img = c.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) {
    const t = (py + 0.5) / H, fade = sstep(0.5, 1.0, t);
    for (let px = 0; px < W; px++) {
      const a = (px + 0.5) / W * Math.PI * 2, cx = Math.cos(a) * 1.2, cz = Math.sin(a) * 1.2, cy = t * 5.5;
      const n = shSmokeLum(cx, cy * 0.55, cz, 31), streak = fbm3(cx * 3.5, cy * 0.35, cz * 3.5, 4, 47);
      const L = 7 + 30 * n * n + 10 * streak * streak;
      const al = fade ? clamp((streak * 0.75 + n * 0.45 + 0.35 - fade * 1.15) * 5, 0, 1) : 1;
      const i = (py * W + px) * 4;
      d[i] = L * 0.93; d[i + 1] = L * 0.9; d[i + 2] = L * 1.1; d[i + 3] = al * 255;
    }
  }
  c.putImageData(img, 0, 0);
}
// 外面那層煙：一塊一塊破破的、邊緣很淡（只用透明度，顏色是黑的）
function shPaintShell(c, W, H) {
  const img = c.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) {
    const t = (py + 0.5) / H;
    for (let px = 0; px < W; px++) {
      const a = (px + 0.5) / W * Math.PI * 2, n = fbm3(Math.cos(a) * 2.2, t * 7, Math.sin(a) * 2.2, 5, 61);
      const al = clamp((n - 0.42) * 2.6, 0, 1) * (1 - sstep(0.7, 1, t)) * sstep(0, 0.06, t);
      const i = (py * W + px) * 4;
      d[i] = 6; d[i + 1] = 5; d[i + 2] = 8; d[i + 3] = al * 255;
    }
  }
  c.putImageData(img, 0, 0);
}
function shPaintLimb(c, W, H) {
  const img = c.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const a = (px + 0.5) / W * Math.PI * 2, n = shSmokeLum(Math.cos(a), (py + 0.5) / H * 3, Math.sin(a), 71), L = 7 + 28 * n * n, i = (py * W + px) * 4;
    d[i] = L * 0.93; d[i + 1] = L * 0.9; d[i + 2] = L * 1.1; d[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 頭：一樣是黑煙，眼窩裡最黑；emissive 那張是眼睛的紅光照在眼窩周圍
function shPaintHead(c, W, H, glow) {
  const img = c.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) {
    const th = shV.inv((py + 0.5) / H), st = Math.sin(th), y = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const a = shU.inv((px + 0.5) / W), x = st * Math.sin(a), z = st * Math.cos(a), i = (py * W + px) * 4;
      let e = 0;
      if (z > 0) for (const s of [-1, 1]) { const u = (x - s * SH_EYE.x) / (glow ? 0.1 : 0.13), v = (y - SH_EYE.y) / (glow ? 0.08 : 0.1); e += Math.exp(-(u * u + v * v)); }
      if (glow) {
        const n = fbm3(x * 6, y * 6, z * 6, 3, 91), k = clamp(e * (0.5 + 0.4 * n), 0, 1);
        d[i] = clamp(255 * k, 0, 255); d[i + 1] = 30 * k * k; d[i + 2] = 34 * k * k; d[i + 3] = 255;
      } else {
        const n = shSmokeLum(x * 1.6, y * 1.6, z * 1.6, 83), L = (8 + 26 * n * n) * (1 - 0.65 * clamp(e, 0, 1));
        d[i] = L * 0.93; d[i + 1] = L * 0.9; d[i + 2] = L * 1.1; d[i + 3] = 255;
      }
    }
  }
  c.putImageData(img, 0, 0);
}
// 一團冒出來的煙（看板）：中間濃、邊緣破破的
function shPaintPuff(c, W, H) {
  const img = c.createImageData(W, H), d = img.data;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const x = (px + 0.5) / W * 2 - 1, y = (py + 0.5) / H * 2 - 1, q = fbm3(x * 1.5, y * 1.5, 2.5, 3, 107), n = fbm3(x * 3 + q * 2, y * 3 - q, 0.5, 5, 101), r = Math.hypot(x, y);
    const al = clamp((1 - r * (0.9 + 1.1 * (1 - n))) * 2.2, 0, 1) * clamp(n * 1.6 - 0.2, 0, 1), i = (py * W + px) * 4;
    d[i] = 10; d[i + 1] = 9; d[i + 2] = 12; d[i + 3] = al * 255;
  }
  c.putImageData(img, 0, 0);
}
// 手：小小的手掌、四根很長的手指（尾端尖尖的）、大拇指，合成一個網格
function shHandGeo(s) {
  const parts = [[geo('shPalm', () => new THREE.SphereGeometry(1, 10, 8)), mat4(0, -0.035, 0.004, 0, 0, 0, 0.021, 0.038, 0.01)], [geo('shPalm', () => null), mat4(0, 0, 0, 0, 0, 0, 0.027)]];   // 手掌、手腕（蓋住手臂的切口）
  for (let i = 0; i < 5; i++) {
    const th = i === 4, L = th ? 0.09 : [0.165, 0.2, 0.19, 0.15][i];
    const f = tubeGeo('shFinger' + i, [[0, 0, 0], [0, -L * 0.4, 0.012], [0, -L * 0.75, 0.032], [0, -L, 0.06]], [0.0095, 0.008, 0.0062, 0.0022], 6, 10);
    parts.push([f, mat4(s * (th ? 0.024 : -0.02 + i * 0.013), th ? -0.025 : -0.066, th ? 0.012 : 0.004, th ? 0.25 : 0, 0, s * (th ? 0.55 : -0.08 + i * 0.05))]);
  }
  return mergeParts('shHand' + s, parts);
}
function buildShadow(r, g) {
  const T = { transparent: true };
  const body = ownPhong('#ffffff', { map: m5Tex('shBody', 512, 1024, shPaintBody), specular: 0x0c0b10, shininess: 6, shade: 0.8, depthWrite: true, ...T });
  const limb = ownPhong('#ffffff', { map: m5Tex('shLimb', 256, 256, shPaintLimb), specular: 0x0c0b10, shininess: 6, shade: 0.8, ...T });
  const head = ownPhong('#ffffff', { map: m5Tex('shHead', 1024, 512, (c, W, H) => shPaintHead(c, W, H, false)), emissiveMap: m5Tex('shGlow', 512, 256, (c, W, H) => shPaintHead(c, W, H, true)), emissive: 0xffffff, specular: 0x0c0b10, shininess: 6, shade: 0.8, ...T });
  for (const m of [head]) { m.map.wrapS = THREE.ClampToEdgeWrapping; m.emissiveMap.wrapS = THREE.ClampToEdgeWrapping; }
  const ball = ownPhong('#050405', { specular: 0x553333, shininess: 80, shade: 0.5, ...T });
  const pupil = ownBasic({ color: 0xff2630, ...T });
  r.mats.push(body, limb, head, ball, pupil);
  r.headM = head;
  r.body = new THREE.Group(); g.add(r.body);
  r.body.add(new THREE.Mesh(loftGeo('shBody', SH_BODY, { seg: 26, sub: 4, capA: 0.04, capB: 0.02, uv: [0, 1, 1, 0] }), body));
  // 外面那層薄薄的煙：不寫深度、慢慢轉，邊緣看起來一直在飄（透明度在 syncShadow 照怪物的透明度算）
  r.shellM = ownBasic({ map: m5Tex('shShell', 256, 512, shPaintShell), transparent: true, depthWrite: false });
  r.shell = new THREE.Mesh(loftGeo('shShell', SH_SHELL, { seg: 22, sub: 3, uv: [0, 1, 1, 0] }), r.shellM); r.body.add(r.shell);
  // 頭和眼睛（眼睛縮在眼窩最裡面：黑黑亮亮的眼球、紅色的瞳孔、往外透的紅光）
  r.head = new THREE.Group(); r.head.position.set(SH_HEAD.x, SH_HEAD.y, SH_HEAD.z); r.body.add(r.head);
  r.head.add(new THREE.Mesh(shHeadGeo(), head));
  const v = new THREE.Vector3();
  for (const s of [-1, 1]) {
    const X = s * SH_EYE.x, Y = SH_EYE.y;
    shHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), v);
    const e = new THREE.Group(); e.position.set(v.x - s * 0.002, v.y, v.z - SH_EYE.R * 1.1); r.head.add(e);
    e.add(new THREE.Mesh(geo('shBall', () => new THREE.SphereGeometry(SH_EYE.R, 14, 10)), ball));
    const pu = new THREE.Mesh(geo('shPupil', () => new THREE.SphereGeometry(SH_EYE.R * 0.5, 10, 8)), pupil); pu.position.z = SH_EYE.R * 0.62; pu.scale.z = 0.5; e.add(pu);
    const gl = ownSprite(glowTex, 0xff3344); gl.position.z = SH_EYE.R * 1.4; gl.scale.setScalar(0.075); e.add(gl);
    const halo = ownSprite(glowTex, 0x4a0a10); halo.position.z = SH_EYE.R * 2; halo.scale.setScalar(0.12); e.add(halo);
    r.eyes.push(gl, halo);
  }
  // 手臂和手（肩膀那裡可以轉：走路時前後晃）
  r.arms = [];
  for (const s of [-1, 1]) {
    const a = new THREE.Group(); a.position.set(s * SH_SHOULDER.x, SH_SHOULDER.y, SH_SHOULDER.z); r.body.add(a);
    const P = SH_ARM[0].map(([x, y, z]) => [x * -s, y, z]);
    a.add(new THREE.Mesh(tubeGeo('shArm' + s, P, SH_ARM[1], 9, 14), limb));
    const h = new THREE.Mesh(shHandGeo(s), limb); h.position.set(...P[P.length - 1]); h.rotation.set(0.18, 0, s * 0.05); a.add(h);
    r.arms.push(a);
  }
  // 冒出來的黑煙：從肩膀、頭、背、手臂和散開的下半身往上飄、越飄越大、越淡
  r.puffs = [];
  const puffTex = m5Tex('shPuff', 128, 128, shPaintPuff);
  const at = [[0.18, 1.5, -0.02], [-0.2, 1.48, 0], [0, 1.82, 0.1], [-0.06, 1.15, -0.1], [0.3, 0.92, 0.1], [0.02, 0.4, -0.05]];
  at.forEach((p, i) => {
    const m = new THREE.SpriteMaterial({ map: puffTex, color: 0xffffff, transparent: true, depthWrite: false, fog: true }); m.userData.own = true;
    const sp = new THREE.Sprite(m); sp.userData = { p, ph: hash01(i * 3.7 + 1), rate: 0.35 + hash01(i * 1.3) * 0.25, dx: (hash01(i * 5.1) - 0.5) * 0.25, rot: (hash01(i * 2.9) - 0.5) * 2 };
    r.body.add(sp); r.puffs.push(sp);
  });
}
function syncShadow(e, r, t, p, dt) {
  const a = enemyAlpha(e);
  // 往前駝，追你的時候更往前傾；頭偶爾歪一下、抽一下
  const sp = r.lx === undefined ? 0 : Math.hypot(e.x - r.lx, e.y - r.ly) / Math.max(dt, 1e-3);
  r.lx = e.x; r.ly = e.y;
  r.spd = (r.spd || 0) + (Math.min(sp, 3) - (r.spd || 0)) * Math.min(1, dt * 3);
  r.body.rotation.x = 0.05 + r.spd * 0.05;
  const jerk = Math.sin(t * 0.37 + e.wob) > 0.93 ? Math.sin(t * 40) * 0.06 : 0;
  r.head.rotation.set(-0.05 + Math.sin(t * 0.8 + e.wob) * 0.05, Math.sin(t * 0.45 + e.wob * 0.5) * 0.12, Math.sin(t * 0.6) * 0.1 + jerk);
  r.arms.forEach((arm, i) => { const s = i ? 1 : -1; arm.rotation.set(Math.sin(e.wob * 2.2 + i * Math.PI) * (0.06 + r.spd * 0.06), 0, s * (0.04 + Math.sin(t * 0.9 + i) * 0.03)); });
  r.headM.emissiveIntensity = 0.75 + 0.25 * Math.sin(e.wob * 5);
  // 外面那層煙慢慢轉、一漲一縮
  r.shellM.opacity = a * 0.7;
  r.shell.rotation.y = Math.sin(t * 0.4 + e.wob) * 0.25;
  const br = 1 + Math.sin(t * 1.3 + e.wob) * 0.025; r.shell.scale.set(br, 1, br);
  for (const sp2 of r.puffs) {
    const u = sp2.userData, k = (t * u.rate + u.ph) % 1;
    sp2.position.set(u.p[0] + u.dx * k, u.p[1] + 0.45 * k - (u.p[1] < 0.7 ? 0.25 * k : 0), u.p[2] - 0.12 * k);
    sp2.scale.setScalar(0.12 + 0.34 * k);
    sp2.material.rotation = u.rot * k;
    sp2.material.opacity = a * 0.38 * Math.sin(Math.PI * k);
  }
}
UPG.shadow = { build: buildShadow, sync: syncShadow, view: { h: 1.9, d: 3.7, cy: 0.95 } };

// ---------- 第一世界重做的怪物（火柴人、衣櫃怪、黑球、血淚女、小丑和紅氣球、爬行女、鳥腳女、它；眼球花） ----------

// ---------- 火柴人 ----------
// 圖鑑說牠「紙做的身體被手電筒照到就會燒起來」：又高又瘦（頭頂大約 2 公尺），手腳是一條一條扭緊的黑紙
// （斜斜的一圈一圈紙縫、關節鼓起來、手指又長又尖）；頭是揉皺的紙糊成的，一摺一摺的稜角，臉的邊緣燒焦了（遠看就是原本那圈黑筆描的輪廓）。
// 眼睛是撕開的兩個黑洞，洞裡一條紅線（原本畫的紅色直線眼睛）微微發光，紅色從洞裡流下來；
// 咧到耳朵的大嘴也是撕開的，上下兩排又尖又黃的牙，嘴唇塗滿了紅，嘴角裂到臉頰。
// 動作跟原本一樣：一手長長地垂著、一手舉起來慢慢揮，頭歪一邊，像手繪動畫一格一格地抖，越靠近你越興奮；
// 被手電筒照到時整個縮下去，紙縫透出火光。脖子、手腳、手指是同一個網格，每幀照關節的位置重算頂點（一隻只要畫一次）
const SK_HEAD = { rx: 0.185, ry: 0.19, rz: 0.165, y: 0.17 };   // 頭的半徑；頭的中心在脖子頂端上面多高
const SK_EYE = { x: 0.35, y: 0.2, w: 0.15, h: 0.18 };         // 眼睛的洞（單位球上，正面看）
const SK_M = { w: 0.76 }, skMouthUp = u => -0.1 - 0.15 * (1 - u * u), skMouthLo = u => -0.1 - 0.7 * Math.max(0, 1 - u * u) ** 0.7;
const SK_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]
  [0.31, 0.43, 0.2, 0.07, 0.05, true],    // 眉骨
  [0.6, -0.02, 0.15, 0.12, 0.06, true],   // 咧嘴擠上來的臉頰
  [0, 0.27, 0.08, 0.14, 0.02, false],     // 兩個洞中間
  [0, -0.93, 0.25, 0.08, 0.035, false],   // 下巴
];
const skRidge = n => 1 - Math.abs(2 * n - 1);
// 揉皺的紙：十幾道直直的摺痕（每一道是一個穿過頭的平面，摺痕兩邊各往同一邊彎，像揉過再攤開的紙），加上一點小皺紋
const SK_FOLD = (() => {
  const r = seeded(4711), F = [];
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2, b = Math.acos(r() * 2 - 1), a2 = r() * Math.PI * 2, b2 = Math.acos(r() * 2 - 1), p = [Math.sin(b2) * Math.cos(a2), Math.cos(b2), Math.sin(b2) * Math.sin(a2)];
    const n = [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)];
    F.push({ n, c: n[0] * p[0] + n[1] * p[1] + n[2] * p[2], p, R: 0.35 + r() * 0.4, a: (r() < 0.5 ? -1 : 1) * (0.14 + r() * 0.2), w: 0.07 + r() * 0.12 });
  }
  return F;
})();
function skCrumple(x, y, z) {
  let d = 0;
  for (const f of SK_FOLD) {   // 每道摺痕只摺到附近一塊（離 p 越遠越淡）
    const q = ((x - f.p[0]) ** 2 + (y - f.p[1]) ** 2 + (z - f.p[2]) ** 2) / (f.R * f.R);
    if (q < 4) d += f.a * (Math.min(Math.abs(f.n[0] * x + f.n[1] * y + f.n[2] * z - f.c), f.w) - f.w * 0.6) * Math.exp(-q);
  }
  const b = skRidge(fbm3(x * 3.6, y * 3.6 - 2, z * 3.6, 2, 17));
  return d + 0.012 * (b * b - 0.45);
}
// 摺痕的線有多深（畫貼圖用）：離最近的摺痕多近
function skCrease(x, y, z) {
  let k = 0;
  for (const f of SK_FOLD) {
    const s = Math.abs(f.n[0] * x + f.n[1] * y + f.n[2] * z - f.c);
    if (s < 0.03) k = Math.max(k, Math.exp(-((s / 0.008) ** 2)) * Math.exp(-((x - f.p[0]) ** 2 + (y - f.p[1]) ** 2 + (z - f.p[2]) ** 2) / (f.R * f.R) * 1.5));
  }
  return k;
}
// 眼睛的洞：q < 1 在洞裡面，邊緣是撕開的（鋸齒）
function skEyeQ(x, y) {
  const s = x < 0 ? -1 : 1, dx = (x - s * SK_EYE.x) / SK_EYE.w, dy = (y - SK_EYE.y) / SK_EYE.h;
  return Math.hypot(dx, dy) + 0.16 * (vnoise3(x * 16, y * 16, s, 23) - 0.5) + 0.06 * (vnoise3(x * 40, y * 40, s, 29) - 0.5);
}
// 撕開的嘴：e 離嘴的邊多遠（負的是在嘴裡面），upper 靠上面那排牙，u 橫的位置
const _skm = { e: 0, upper: false, u: 0 };
function skMouth(x, y) {
  const o = _skm, u = x / SK_M.w;
  o.u = u;
  if (Math.abs(u) <= 1) { const up = skMouthUp(u), lo = skMouthLo(u); o.upper = y > (up + lo) / 2; o.e = o.upper ? y - up : lo - y; }
  else { const cy = skMouthUp(1); o.upper = y > cy; o.e = Math.hypot((Math.abs(u) - 1) * SK_M.w, y - cy); }
  o.e += 0.014 * (vnoise3(x * 34, y * 34, 0, 31) - 0.5);
  return o;
}
// 洞和嘴是往後壓進去的（不是往頭的中心：嘴在臉的下半部，往中心壓的話嘴底會翹起來蓋住下排的牙）
function skHeadPt(x, y, z, out) {
  let X = x, Z = z;
  if (Z > 0) Z *= 0.74 + 0.26 * sstep(0.5, 1, Math.hypot(x, y));   // 臉平平的，像紙糊的面具
  if (y < 0) X *= 1 - 0.08 * y * y;
  let d = skCrumple(x, y, z) * (z > 0.3 ? 0.7 : 1), back = 0;
  if (z > 0.05) {
    let f = 0;
    for (const b of SK_FACE) for (const s of b[5] ? [-1, 1] : [1]) { const u = (x - s * b[0]) / b[2], v = (y - b[1]) / b[3]; if (u * u + v * v < 16) f += b[4] * Math.exp(-u * u - v * v); }
    const q = skEyeQ(x, y);
    if (q < 1.6) { back += 0.3 * (1 - sstep(0.82, 1.02, q)); f += 0.02 * Math.exp(-(((q - 1.08) / 0.08) ** 2)); }   // 洞很深，撕開的邊微微翹起來
    const m = skMouth(x, y);
    if (m.e < 0.12) { back += 0.36 * sstep(0.004, -0.03, m.e); f += 0.024 * Math.exp(-(((m.e - 0.022) / 0.018) ** 2)); }
    const w = sstep(0.05, 0.35, z);
    d += f * w; back *= w;
  }
  const k = 1 + d / (Math.hypot(X, y, Z) || 1);
  return out.set(X * k * SK_HEAD.rx, y * k * SK_HEAD.ry, (Z * k - back) * SK_HEAD.rz);
}
const skU = crWarp(-Math.PI, Math.PI, a => 1 + 1.4 * Math.exp(-((a / 0.9) ** 2))), skV = crWarp(0, Math.PI, th => 1 + 1.2 * Math.exp(-(((th - 1.85) / 0.65) ** 2)));
const skHeadGeo = () => sculptGeo('skHead', skHeadPt, skU, skV, th => sstep(0.85, 1.0, th) * (1 - sstep(2.65, 2.8, th)), a => sstep(-1.15, -1.0, a) * (1 - sstep(1.0, 1.15, a)), [0.056, 0.058], [0.15, 0.16]);   // 火柴人常常兩隻一起出來，格子不要太密
// 頭的貼圖（一個一個像素算）：髒髒的舊紙、褐色的水漬、摺痕；臉的邊緣一圈燒焦（褐色到黑色）；
// 撕開的洞邊露出白白的紙纖維、周圍燻黑；紅色的直線穿過眼睛；嘴唇塗滿紅色、嘴裡是暗紅色的牙齦和黑黑的喉嚨。
// glow 是自發光那張：只有洞裡那條紅線
function skPaintHead(c, W, H, glow) {
  const img = c.createImageData(W, H), D = img.data, C = [0, 0, 0];
  const mix = (col, k) => { C[0] += (col[0] - C[0]) * k; C[1] += (col[1] - C[1]) * k; C[2] += (col[2] - C[2]) * k; };
  for (let py = 0; py < H; py++) {
    const th = skV.inv((py + 0.5) / H), st = Math.sin(th), y = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const a = skU.inv((px + 0.5) / W), x = st * Math.sin(a), z = st * Math.cos(a), i = (py * W + px) * 4;
      const q = z > 0.05 ? skEyeQ(x, y) : 9, ex = Math.abs(Math.abs(x) - SK_EYE.x), ey = y - SK_EYE.y;
      const slit = (1 - sstep(0.014, 0.026, ex + 0.004 * Math.sin(y * 60))) * sstep(-0.29, -0.24, ey) * (1 - sstep(0.21, 0.25, ey));
      if (glow) {
        const k = q < 1.05 ? slit * (1 - sstep(0.9, 1.05, q)) + 0.45 * Math.exp(-((ex / 0.04) ** 2)) * (1 - sstep(0.55, 1.0, q)) : 0;
        D[i] = 255 * clamp(k, 0, 1); D[i + 1] = 26 * k; D[i + 2] = 20 * k; D[i + 3] = 255;
        continue;
      }
      const n = fbm3(x * 3, y * 3, z * 3, 4, 41), f = fbm3(x * 26, y * 26, z * 26, 2, 43), stain = fbm3(x * 1.3 + 5, y * 1.3, z * 1.3, 3, 47);
      C[0] = 212 + (n - 0.5) * 26 + (f - 0.5) * 14; C[1] = 208 + (n - 0.5) * 24 + (f - 0.5) * 13; C[2] = 200 + (n - 0.5) * 22 + (f - 0.5) * 12;
      mix([170, 150, 118], sstep(0.55, 0.72, stain) * 0.4);                                    // 水漬
      if (z < 0) mix([150, 138, 116], sstep(0, -0.5, z) * 0.55);                               // 後腦勺比較舊、比較髒
      const cr2 = skRidge(fbm3(x * 3.6, y * 3.6 - 2, z * 3.6, 2, 17));
      mix([132, 118, 98], skCrease(x, y, z) * 0.32 + sstep(0.95, 0.995, cr2) * 0.12);          // 摺痕（灰塵卡在裡面）
      mix([168, 150, 124], sstep(0.4, 0.75, fbm3(x * 2.2, y * 2.2 - 4, z * 2.2, 3, 49)) * 0.2);  // 舊紙有點泛黃
      // 臉的邊緣燒焦：先是褐色、再來是黑的（正面看是一圈輪廓）
      const zb = z - 0.03 + 0.09 * (n - 0.5) + 0.04 * (f - 0.5);
      mix([120, 74, 38], Math.exp(-((zb / 0.3) ** 2)) * 0.7);
      mix([20, 16, 14], Math.exp(-((zb / 0.16) ** 2)) * 0.95);
      if (q < 1.7) {
        mix([36, 30, 27], (1 - sstep(1.0, 1.65, q + 0.15 * (f - 0.5))) * 0.85);   // 洞的周圍燻黑（原本原子筆一圈一圈塗黑的地方）
        mix([206, 198, 182], Math.exp(-(((q - 1.0) / 0.03) ** 2)) * 0.45 * f);   // 撕開的邊露出一點紙纖維
        if (q < 0.98) { mix([8, 6, 6], 1); mix([46, 10, 10], (1 - sstep(0.4, 0.95, q)) * 0.6); }
      }
      if (slit > 0 && z > 0.3) mix([176, 16, 22], slit * (q < 1 ? 1 : 0.9));   // 紅色的直線（穿過眼睛的洞）
      if (z > 0.05) {
        const m = skMouth(x, y);
        if (m.e < 0.09) {
          if (m.e >= 0) mix([150, 18, 24], (1 - sstep(0.012, 0.045, m.e + 0.02 * (n - 0.5) + 0.015 * (f - 0.5))) * 0.92);   // 塗滿紅色的嘴唇
          else {
            const dp = -m.e;
            mix([110, 20, 24], 1);
            mix([14, 3, 4], sstep(0.008, 0.03, dp));   // 牙齦後面就是黑黑的喉嚨
          }
        }
      }
      D[i] = C[0]; D[i + 1] = C[1]; D[i + 2] = C[2]; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  if (glow) return;
  // 流下來的紅色、嘴角裂到臉頰
  const { at } = headPainter(c, W, H, skU, skV), r = seeded(913);
  const drip = (X, Y, len, w) => at(X, Y, () => {
    const dx = (r() - 0.5) * 3;
    c.strokeStyle = 'rgba(150,14,20,.92)'; c.lineWidth = w; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(dx, -len * 0.6, dx * 0.6, -len); c.stroke();
    c.fillStyle = 'rgba(120,8,14,.95)'; c.beginPath(); c.ellipse(dx * 0.6, -len - w * 0.3, w * 0.8, w * 1.1, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(70,4,8,.5)'; c.lineWidth = w * 0.4; c.beginPath(); c.moveTo(w * 0.3, 0); c.quadraticCurveTo(dx + w * 0.3, -len * 0.6, dx * 0.6 + w * 0.3, -len); c.stroke();
  });
  for (const s of [-1, 1]) {
    drip(s * SK_EYE.x + (r() - 0.5) * 0.01, SK_EYE.y - 0.21, 16 + r() * 16, 2.4);
    drip(s * SK_EYE.x + 0.02 + r() * 0.015, SK_EYE.y - 0.19, 7 + r() * 9, 1.6);
    at(s * SK_M.w, skMouthUp(1), () => {
      c.lineCap = 'round';
      for (const [col, w] of [['rgba(150,20,24,.85)', 3.4], ['rgba(70,6,8,.95)', 1.2]]) { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(s * 3, 10, s * 9, 22); c.lineTo(s * 9 + (r() - 0.5) * 3, 26); c.stroke(); }
    }, 1);
  }
  for (const u of [-0.55, -0.12, 0.38, 0.7]) drip(u * SK_M.w, skMouthLo(u) - 0.025, 8 + r() * 16, 1.8 + r());
}
// 扭緊的黑紙（手腳）：u 繞一圈、v 沿著手腳（一公尺 4 張）；斜斜的紙縫一圈一圈繞上去，紙縫旁邊翹起來的邊比較亮，加上皺紋。
// ember 是燒起來時的火光：紙縫和皺紋裡透出來
function skPaintLimb(c, W, H, ember) {
  const img = c.createImageData(W, H), D = img.data, T = Math.PI * 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H, cu = Math.cos(T * u), su = Math.sin(T * u), cv = Math.cos(T * v), sv = Math.sin(T * v);
    const n = fbm3(cu * 0.8 + cv * 1.6, su * 0.8, sv * 1.6, 4, 51), m = fbm3(cu * 2.2 + cv * 4.4, su * 2.2, sv * 4.4, 3, 53);
    const w = ((u + 4 * v + (n - 0.5) * 0.5) % 1 + 1) % 1, w2 = ((3 * u - 9 * v + (m - 0.5) * 0.4) % 1 + 1) % 1;
    const seam = 1 - sstep(0, 0.035, Math.min(w, 1 - w)), ridge = Math.exp(-(((w - 0.07) / 0.035) ** 2)), crease = Math.exp(-(((w2 - 0.5) / 0.03) ** 2));
    const i = (py * W + px) * 4;
    if (ember) {
      const k = clamp(seam * 0.9 + crease * 0.5 * sstep(0.45, 0.65, n) + sstep(0.62, 0.75, m) * 0.35, 0, 1);
      D[i] = 255 * k; D[i + 1] = 120 * k * k; D[i + 2] = 30 * k * k * k; D[i + 3] = 255;
    } else {
      const L = 20 + (n - 0.5) * 16 + (m - 0.5) * 10 + ridge * 14 - seam * 13 - crease * 5 - w * 5;
      D[i] = L * 1.03; D[i + 1] = L; D[i + 2] = L * 0.95; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}
// 關節：脖子、手腳、每根手指多一個指節（m）
const SK_J = ['neck', 'head', 'hip', 'kneeL', 'footL', 'kneeR', 'footR', 'arms', 'elbL', 'handL', 'elbR', 'handR', 'mL0', 'mL1', 'mL2', 'fL0', 'fL1', 'fL2', 'mR0', 'mR1', 'mR2', 'fR0', 'fR1', 'fR2'];
// 每一根：[起點, 終點, 粗細, 種類（0 一般、1 指尖（尖的）、2 腳（尾端收圓）), 起點鼓多少, 終點鼓多少, 一根幾圈, 起點收口, 終點收口]
// 收口：多兩圈收成圓頭（關節彎起來時兩根接起來的地方才不會看到切口）
const SK_B = [
  ['neck', 'hip', 0.024, 0, 0.25, 0.5, 13, 1, 1], ['neck', 'head', 0.019, 0, 0.3, 0, 6, 0, 0],
  ...['L', 'R'].flatMap(s => [['hip', 'knee' + s, 0.021, 0, 0.45, 0.55, 10, 1, 1], ['knee' + s, 'foot' + s, 0.019, 2, 0.55, 0, 10, 1, 0],
    ['arms', 'elb' + s, 0.018, 0, 0.5, 0.55, 9, 1, 1], ['elb' + s, 'hand' + s, 0.016, 0, 0.55, 0.5, 9, 1, 1],
    ...[0, 1, 2].flatMap(i => [['hand' + s, 'm' + s + i, 0.0085, 0, 0.3, 0.5, 5, 0, 1], ['m' + s + i, 'f' + s + i, 0.0075, 1, 0.45, 0, 6, 0, 0]])]),
];
// 一組會動的管子（手腳、手指）合成一個網格：skTubesGeo 排好三角形，skTubesUpdate 每幀照關節的位置重算頂點（衣櫃怪也用）
const SK_SEG = 6, skRings = b => b[6] + 2 * b[7] + 2 * b[8];
function skTubesGeo(B, box) {
  let nv = 0, idx = [];
  for (const b of B) {
    const base = nv, n = skRings(b);
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < SK_SEG; j++) { const a = base + i * (SK_SEG + 1) + j, c = a + SK_SEG + 1; idx.push(a, a + 1, c, a + 1, c + 1, c); }
    nv += n * (SK_SEG + 1);
  }
  const g = new THREE.BufferGeometry();
  for (const [k, n] of [['position', 3], ['normal', 3], ['uv', 2]]) { const at = new THREE.BufferAttribute(new Float32Array(nv * n), n); at.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, at); }
  g.setIndex(idx);
  g.boundingSphere = box;   // 每幀改頂點，不用每次重算
  return g;
}
// 每一根的粗細（t 從起點 0 到終點 1）：兩頭的關節鼓起來，中間細，紙皺皺的粗細不太平均
function skRad(b, t, bi) {
  let r = b[2] * (0.78 + b[4] * Math.exp(-((t / 0.09) ** 2)) + b[5] * Math.exp(-(((1 - t) / 0.09) ** 2))) * (1 + 0.07 * Math.sin(t * 23 + bi * 1.7) * Math.sin(t * 7 + bi));
  if (b[3] === 1) r *= 1 - 0.92 * t ** 1.4;
  else if (b[3] === 2 && t > 0.82) r *= Math.sqrt(Math.max(0, 1 - ((t - 0.82) / 0.18) ** 2));
  return r;
}
const _skD = new THREE.Vector3(), _skU = new THREE.Vector3(), _skW = new THREE.Vector3(), _skN = new THREE.Vector3();
const SK_CAP = [[-1, 0, -1, 0], [-0.5, 0.87, -0.5, 0.87]];   // 收口的兩圈：[往外多少（乘那頭的粗細）, 粗細的倍數, 法線往軸的方向, 法線往外的方向]
function skTubesUpdate(g, J, B) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, UV = g.attributes.uv.array;
  let o = 0;
  B.forEach((b, bi) => {
    const A = J[b[0]], B = J[b[1]], len = _skD.subVectors(B, A).length() || 1e-4, n = b[6], rA = skRad(b, 0, bi), rB = skRad(b, 1, bi);
    _skD.multiplyScalar(1 / len);
    _skU.set(0, 0, 1); if (Math.abs(_skD.z) > 0.9) _skU.set(1, 0, 0);
    _skU.cross(_skD).normalize(); _skW.crossVectors(_skD, _skU);
    const ring = (sAt, r, na, nr) => {   // 一圈：沿著軸在 sAt（公尺）、粗細 r、法線 = 往外 × nr + 沿著軸 × na
      const cx = A.x + _skD.x * sAt, cy = A.y + _skD.y * sAt, cz = A.z + _skD.z * sAt;
      for (let j = 0; j <= SK_SEG; j++) {
        const th = j / SK_SEG * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const rx = _skU.x * cs + _skW.x * sn, ry = _skU.y * cs + _skW.y * sn, rz = _skU.z * cs + _skW.z * sn;
        P[o * 3] = cx + rx * r; P[o * 3 + 1] = cy + ry * r; P[o * 3 + 2] = cz + rz * r;
        _skN.set(rx * nr + _skD.x * na, ry * nr + _skD.y * na, rz * nr + _skD.z * na).normalize();
        N[o * 3] = _skN.x; N[o * 3 + 1] = _skN.y; N[o * 3 + 2] = _skN.z;
        UV[o * 2] = j / SK_SEG; UV[o * 2 + 1] = sAt * 4 + bi * 0.37;
        o++;
      }
    };
    if (b[7]) for (const [k, kr, na, nr] of SK_CAP) ring(k * rA, kr * rA, na, nr);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), t0 = Math.max(0, t - 0.02), t1 = Math.min(1, t + 0.02), dr = (skRad(b, t1, bi) - skRad(b, t0, bi)) / ((t1 - t0) * len);
      ring(t * len, skRad(b, t, bi), -dr, 1);
    }
    if (b[8]) for (let q = SK_CAP.length - 1; q >= 0; q--) { const [k, kr, na, nr] = SK_CAP[q]; ring(len - k * rB, kr * rB, -na, nr); }
  });
  g.attributes.position.needsUpdate = g.attributes.normal.needsUpdate = g.attributes.uv.needsUpdate = true;
}
// 牙：上下兩排，又尖又黃、長短不齊（中間長、往嘴角越來越小），沿著嘴的邊排、尖端往嘴裡面指；合成一個網格
function skTeethGeo() {
  const parts = [], v = new THREE.Vector3(), r = seeded(9131), cone = geo('skTooth', () => new THREE.ConeGeometry(1, 1, 6, 1).translate(0, 0.5, 0));
  for (const upper of [true, false]) {
    const n = upper ? 15 : 12;
    for (let i = 0; i < n; i++) {
      const u = (upper ? -0.93 : -0.86) + (upper ? 1.86 : 1.72) * (i + 0.5) / n + (r() - 0.5) * 0.03, X = u * SK_M.w, du = 0.01;
      const Y = upper ? skMouthUp(u) : skMouthLo(u), Y2 = upper ? skMouthUp(u + du) : skMouthLo(u + du);
      let nx = -(Y2 - Y), ny = du * SK_M.w;   // 邊的法線（往嘴裡面）
      if ((ny > 0) === upper) { nx = -nx; ny = -ny; }
      skHeadPt(X, Y, Math.sqrt(Math.max(0, 1 - X * X - Y * Y)), v);
      const L = (upper ? 0.03 : 0.026) * (0.75 + r() * 0.6) * (1 - 0.45 * Math.abs(u)), w = 0.0075 + r() * 0.003;
      parts.push([cone, mat4(v.x - nx * 0.004, v.y - ny * 0.004, v.z - 0.012, (upper ? 0.25 : -0.25) * (0.6 + r() * 0.6), 0, Math.atan2(-nx, ny) + (r() - 0.5) * 0.25, w, L, w * 0.55)]);
    }
  }
  return mergeParts('skTeeth', parts);
}
function buildStickUpg(r, g) {
  const T = { transparent: true };
  r.bodyM = ownPhong('#ffffff', { map: m5Tex('skLimb', 256, 256, (c, W, H) => skPaintLimb(c, W, H, false)), emissiveMap: m5Tex('skEmber', 256, 256, (c, W, H) => skPaintLimb(c, W, H, true)), emissive: 0xffffff, emissiveIntensity: 0, specular: 0x262422, shininess: 16, shade: 0.8, ...T });
  r.headM = ownPhong('#ffffff', { map: m5Tex('skHead', 1024, 512, (c, W, H) => skPaintHead(c, W, H, false)), emissiveMap: m5Tex('skGlow', 512, 256, (c, W, H) => skPaintHead(c, W, H, true)), emissive: 0xffffff, specular: 0x1c1a16, shininess: 8, shade: 0.75, ...T });
  r.headM.map.wrapS = r.headM.emissiveMap.wrapS = THREE.ClampToEdgeWrapping;
  const tooth = withDetail(ownPhong('#d4c39c', { specular: 0x4a4436, shininess: 30, shade: 0.7, ...T }), 'bone', 10, 0.7);
  r.mats.push(r.bodyM, r.headM, tooth);
  r.J = Object.fromEntries(SK_J.map(k => [k, new THREE.Vector3()]));
  r.bodyG = skTubesGeo(SK_B, new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 1.6));
  const body = new THREE.Mesh(r.bodyG, r.bodyM); body.userData.ownGeo = true; body.frustumCulled = false; g.add(body);
  r.head = new THREE.Group(); g.add(r.head);
  const hm = new THREE.Mesh(skHeadGeo(), r.headM); hm.position.y = SK_HEAD.y; r.head.add(hm);
  const tm = new THREE.Mesh(skTeethGeo(), tooth); tm.position.y = SK_HEAD.y; r.head.add(tm);
  skPose({ wob: 0 }, r, 5, 0, 0);
}
// 姿勢（跟原本的火柴人一樣）：兩條腿一前一後地交叉，左手垂到膝蓋、右手舉起來揮；手指每根兩節、指尖往你這邊彎
const _skF = new THREE.Vector3();
function skFinger(J, s, i, hand, dx, dy, dz, L, curl) {
  const m = J['m' + s + i], f = J['f' + s + i];
  _skF.set(dx, dy, dz).normalize();
  m.copy(hand).addScaledVector(_skF, L * 0.5);
  _skF.multiplyScalar(Math.cos(curl)); _skF.z += Math.sin(curl); _skF.normalize();
  f.copy(m).addScaledVector(_skF, L * 0.5);
}
function skPose(e, r, d, t, dt) {
  const J = r.J, w = e.wob * 4.2, set = (k, x, y, z) => J[k].set(x, y, z), near = clamp(1 - (d - 1.2) / 3, 0, 1);
  r.wavePh = (r.wavePh || 0) + dt * (2.2 + near * 3.5); r.twPh = (r.twPh || e.wob) + dt * (1.9 + near * 5);
  set('neck', 0, 1.7, 0); set('head', 0, 1.8, 0.01); set('hip', 0, 1.02, 0); set('arms', 0, 1.54, 0);
  for (const [s, ph] of [['L', 0], ['R', Math.PI]]) {
    const sw = Math.sin(w + ph) * 0.34, bend = Math.max(0, -Math.cos(w + ph)) * 0.55, x = s === 'L' ? -1 : 1;
    set('knee' + s, x * 0.08, 1.02 - Math.cos(sw) * 0.5, Math.sin(sw) * 0.5);
    set('foot' + s, x * 0.12, J['knee' + s].y - Math.cos(sw - bend) * 0.5, J['knee' + s].z + Math.sin(sw - bend) * 0.5);
  }
  const as = Math.sin(w) * 0.12, crl = 0.3 + near * 0.35;
  set('elbL', -0.2, 1.18, 0.03 + as * 0.3); set('handL', -0.26, 0.74, 0.08 + as);
  for (let i = 0; i < 3; i++) skFinger(J, 'L', i, J.handL, (i - 1) * 0.28 - 0.06, -1, 0.12 + (i - 1) * 0.12, 0.18, crl + 0.12 * Math.sin(t * 2.1 + i * 1.3));
  const wave = 0.25 + Math.sin(r.wavePh) * 0.4;
  set('elbR', 0.36, 1.58, 0.05);
  set('handR', 0.36 + Math.sin(wave) * 0.36, 1.58 + Math.cos(wave) * 0.36, 0.08);
  for (let i = 0; i < 3; i++) { const a = wave + (i - 1) * 0.35; skFinger(J, 'R', i, J.handR, Math.sin(a), Math.cos(a), 0.08, 0.17, crl * 0.8 + 0.1 * Math.sin(t * 2.6 + i)); }
  // 手繪動畫的抖動：每 0.1 秒換一格
  const tick = Math.floor(t * 10);
  SK_J.forEach((k, i) => J[k].add(_skF.set(hash01(tick * 31 + i) - 0.5, hash01(tick * 17 + i * 3) - 0.5, hash01(tick * 7 + i * 5) - 0.5).multiplyScalar(0.018 + near * 0.02)));
  skTubesUpdate(r.bodyG, J, SK_B);
  // 頭歪一邊，偶爾突然抽一下（繞著脖子轉）
  const twitch = Math.min(1, Math.max(0, Math.sin(r.twPh) - 0.9 + near * 0.3) * 10) * (Math.sin(e.wob * 0.37) < 0 ? -1 : 1);
  r.head.position.copy(J.head);
  r.head.rotation.set(-0.06 + twitch * 0.08, 0, 0.32 + Math.sin(e.wob * 0.7) * 0.12 + twitch * 0.45 + (hash01(tick) - 0.5) * (0.04 + near * 0.1));
}
function syncStickUpg(e, r, t, p, dt) {
  skPose(e, r, Math.hypot(e.x - p.x, e.y - p.y), t, dt);
  // 被手電筒照到：整個縮下去，紙縫透出火光，臉被火烤得發黃發紅
  const burn = e.burn || 0, k = burn / 1.4;
  r.g.scale.set(1, 1 - k * 0.35, 1);
  r.bodyM.emissiveIntensity = k * (1.1 + 0.5 * Math.sin(t * 13 + e.wob) * Math.sin(t * 7.3));
  r.headM.color.setRGB(1 + k * 0.15, 1 - k * 0.2, 1 - k * 0.5);
  r.headM.emissiveIntensity = 0.85 + 0.15 * Math.sin(t * 3 + e.wob);
}
UPG.stick = { build: buildStickUpg, sync: syncStickUpg, view: { h: 2.3, d: 4.4, cy: 1.1 } };

// ---------- 衣櫃怪 ----------
// 衣櫃裡衝出來的東西：瘦得只剩皮包骨的黑色人形，四肢著地蹲著（頭頂大約 1.15 公尺），膝蓋高高拱在身體兩側，
// 長長的手臂撐在前面的地上、細長的手指張開；背往上拱，看得到一節一節的脊椎、肩胛骨和兩側的肋骨。
// 光禿禿的長頭往前伸，深深的眼窩裡兩顆黃色的眼睛像動物的眼睛在黑暗中反光，嘴是一條緊閉的長縫。
// 皮膚幾乎是黑的、乾乾亮亮的：黑暗中只看得到黑色的輪廓和兩個黃點，被手電筒照到才看得到皮包骨的身體。
// 動作：不動的時候蹲著喘氣、頭歪來歪去、手指在地上敲；衝過來的時候前腳一起、後腳一起地奔跑，身體一起一伏。
// 手腳和手指跟火柴人一樣是一組會動的管子（skTubesGeo），關節用兩節的 IK 算（手肘往外、膝蓋往上拱）
const FS = { hip: [0, 0.56, -0.2], pitch: 0.95 };   // 身體：屁股的位置、往前趴多少（弧度）
const fsTab = (k, T) => { if (k <= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (k <= T[i][0]) { const [a, va] = T[i - 1], [b, vb] = T[i], q = sstep(0, 1, (k - a) / (b - a)); return va + (vb - va) * q; } return T[T.length - 1][1]; };
// 身體（直立時的樣子，再整個往前趴）：骨盆 → 細細的腰 → 肋骨撐開 → 肩膀 → 脖子；背上一節一節的脊椎、兩塊肩胛骨，兩側六根肋骨
const FS_BUMPS = [{ a: 1.35, w: 0.75, sym: true }, { a: Math.PI, w: 0.12 }, { a: 2.45, w: 0.32, sym: true }];
function fsTorsoRings() {
  const R = [];
  for (let i = 0; i <= 26; i++) {
    const k = i / 26, y = k * 0.62;
    const w = fsTab(k, [[0, 0.115], [0.14, 0.125], [0.3, 0.085], [0.46, 0.12], [0.7, 0.14], [0.86, 0.165], [0.95, 0.1], [1, 0.05]]);
    const f = fsTab(k, [[0, 0.08], [0.3, 0.05], [0.46, 0.08], [0.7, 0.095], [0.9, 0.075], [1, 0.045]]);
    const b = fsTab(k, [[0, 0.085], [0.3, 0.07], [0.6, 0.09], [0.85, 0.095], [1, 0.045]]);
    const rib = k > 0.4 && k < 0.84 ? Math.cos((k - 0.4) / 0.44 * Math.PI * 12) : 0, vert = Math.max(0, Math.cos(k * Math.PI * 22)) ** 2;
    R.push({ y, w, f, b, z: -0.03 * Math.sin(k * Math.PI) + 0.03 * sstep(0.85, 1, k), s: [rib * 0.007, vert * 0.014 * sstep(0.05, 0.2, k), 0.022 * Math.exp(-(((k - 0.8) / 0.1) ** 2))] });
  }
  return R;
}
const FS_HEAD = { rx: 0.08, ry: 0.1, rz: 0.125 };
const FS_EYE = { x: 0.36, y: 0.06, R: 0.017 };
const FS_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]
  [0.34, 0.24, 0.3, 0.07, 0.08, true],    // 很重的眉骨
  [FS_EYE.x, FS_EYE.y, 0.16, 0.13, -0.28, true],   // 深深的眼窩
  [0.55, -0.12, 0.13, 0.08, 0.1, true],   // 高高的顴骨
  [0.45, -0.36, 0.15, 0.13, -0.09, true], // 凹下去的臉頰
  [0.65, 0.38, 0.18, 0.22, -0.04, true],  // 太陽穴凹下去
  [0, -0.04, 0.05, 0.16, 0.035, false],   // 扁扁的鼻樑
  [0.035, -0.21, 0.02, 0.03, -0.05, true],// 兩條縫一樣的鼻孔
  [0, -0.42, 0.3, 0.045, 0.018, false],   // 上唇
  [0, -0.48, 0.42, 0.018, -0.035, false], // 緊閉的長嘴縫
  [0, -0.76, 0.14, 0.1, 0.045, false],    // 尖尖的下巴
];
function fsHeadPt(x, y, z, out) {
  let X = x, Y = y, Z = z;
  if (y < 0) { const t = -y; X *= 1 - 0.32 * t * t; Y *= 1.18; Z *= 1 - 0.12 * t; }   // 長長的臉、下巴窄
  else { Y *= 0.86; X *= 1 - 0.12 * y; }   // 頭頂扁一點、窄一點（不要像一顆蛋）
  if (Z < 0) Z *= 1.12;     // 後腦勺長
  let d = 0;
  if (z > 0.05) {
    for (const f of FS_FACE) for (const s of f[5] ? [-1, 1] : [1]) { const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3]; if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v); }
    d *= sstep(0.05, 0.4, z);
  }
  d += 0.012 * (fbm3(x * 3, y * 3, z * 3, 2, 61) - 0.5);   // 頭骨凹凸不平
  const k = 1 + d / (Math.hypot(X, Y, Z) || 1);
  return out.set(X * k * FS_HEAD.rx, Y * k * FS_HEAD.ry, Z * k * FS_HEAD.rz);
}
const fsU = crWarp(-Math.PI, Math.PI, a => 1 + 1.2 * Math.exp(-((a / 0.9) ** 2))), fsV = crWarp(0, Math.PI, th => 1 + 1.0 * Math.exp(-(((th - 1.6) / 0.6) ** 2)));
const fsHeadGeo = () => sculptGeo('fsHead', fsHeadPt, fsU, fsV, th => sstep(0.95, 1.1, th) * (1 - sstep(2.35, 2.5, th)), a => sstep(-1.0, -0.85, a) * (1 - sstep(0.85, 1.0, a)), [0.065, 0.07], [0.16, 0.17]);
// 皮膚（可以重複貼）：幾乎是黑的、有一點灰紫色，一塊一塊乾掉的皮比較亮、皺紋、底下黑黑的血管
function fsSkinLum(cx, cy, cz, s) {
  const n = fbm3(cx, cy, cz, 4, s), m = fbm3(cx * 3.1, cy * 3.1, cz * 3.1, 3, s + 5), vein = skRidge(fbm3(cx * 1.2 + 4, cy * 1.2, cz * 1.2, 3, s + 9));
  return 16 + (n - 0.5) * 9 + sstep(0.6, 0.8, m) * 6 - sstep(0.94, 0.99, vein) * 5;
}
function fsPaintSkin(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, T = Math.PI * 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H, A = 1.4, B = 2.2;
    const cx = Math.cos(T * u) * A + Math.cos(T * v) * B, cy = Math.sin(T * u) * A, cz = Math.sin(T * v) * B;
    const L = fsSkinLum(cx * 2.6, cy * 2.6, cz * 2.6, 71) - 4 * skRidge(fbm3(cx * 0.6, cy * 4, cz * 4, 2, 79)) ** 6;   // 一圈一圈的皺紋
    const i = (py * W + px) * 4;
    D[i] = L * 0.95; D[i + 1] = L * 0.93; D[i + 2] = L * 1.05; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 頭：一樣的皮，眼窩、鼻孔、嘴縫比較黑，眉骨和顴骨上的皮比較乾（亮一點）
function fsPaintHead(c, W, H) {
  const img = c.createImageData(W, H), D = img.data;
  for (let py = 0; py < H; py++) {
    const th = fsV.inv((py + 0.5) / H), st = Math.sin(th), y = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const a = fsU.inv((px + 0.5) / W), x = st * Math.sin(a), z = st * Math.cos(a);
      let L = fsSkinLum(x * 5, y * 5, z * 5, 81), k = 1;
      if (z > 0.1) {
        const g = (X, Y, w, h) => Math.exp(-(((Math.abs(x) - X) / w) ** 2) - (((y - Y) / h) ** 2));
        k *= 1 - 0.75 * g(FS_EYE.x, FS_EYE.y, 0.12, 0.1);                 // 眼窩
        k *= 1 - 0.6 * Math.exp(-((x / 0.4) ** 2) - (((y + 0.48) / 0.02) ** 2));   // 嘴縫
        k *= 1 - 0.7 * g(0.035, -0.21, 0.018, 0.025);                     // 鼻孔
        L += 9 * g(0.34, 0.26, 0.25, 0.05) + 7 * g(0.55, -0.1, 0.1, 0.06);  // 眉骨、顴骨
      }
      const i = (py * W + px) * 4;
      L *= k;
      D[i] = L * 0.95; D[i + 1] = L * 0.93; D[i + 2] = L * 1.05; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}
// 眼睛：像動物的眼睛在黑暗中反光，整顆黃黃亮亮的，中間一個暗一點的直瞳孔（球的正面是 u = 0.25）
function fsPaintEye(c, W, H) {
  c.fillStyle = '#2a2008'; c.fillRect(0, 0, W, H);
  const cx = W * 0.25, cy = H / 2, g = c.createRadialGradient(cx, cy, 0, cx, cy, W * 0.16);
  g.addColorStop(0, '#fff2a0'); g.addColorStop(0.45, '#ffd23a'); g.addColorStop(0.85, '#b07a10'); g.addColorStop(1, '#2a2008');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.fillStyle = 'rgba(70,40,4,.75)'; c.beginPath(); c.ellipse(cx, cy, W * 0.018, H * 0.13, 0, 0, 7); c.fill();
}
// 手腳：[起點, 終點, 粗細, 種類, 起點鼓多少, 終點鼓多少, 一根幾圈, 起點收口, 終點收口]（跟火柴人的 SK_B 一樣）
const FS_B = [
  ['nk', 'hj', 0.034, 0, 0.1, 0.2, 6, 0, 0],
  ...['L', 'R'].flatMap(s => [
    ['sh' + s, 'el' + s, 0.034, 0, 0.35, 0.45, 9, 1, 1], ['el' + s, 'wr' + s, 0.026, 0, 0.45, 0.35, 9, 1, 1], ['wr' + s, 'pa' + s, 0.022, 0, 0.3, 0.3, 4, 1, 1],
    ...[0, 1, 2, 3].flatMap(i => [['pa' + s, 'k' + s + i, 0.0085, 0, 0.3, 0.45, 4, 0, 1], ['k' + s + i, 't' + s + i, 0.007, 1, 0.4, 0, 5, 0, 0]]),
    ['wr' + s, 'tk' + s, 0.009, 0, 0.3, 0.4, 4, 0, 1], ['tk' + s, 'tt' + s, 0.008, 1, 0.4, 0, 4, 0, 0],
    ['hp' + s, 'kn' + s, 0.045, 0, 0.3, 0.5, 9, 1, 1], ['kn' + s, 'an' + s, 0.032, 0, 0.5, 0.35, 9, 1, 1], ['an' + s, 'ba' + s, 0.024, 0, 0.35, 0.3, 5, 1, 1],
    ...[0, 1, 2].map(j => ['ba' + s, 'o' + s + j, 0.009, 1, 0.35, 0, 5, 0, 0]),
  ]),
];
const FS_J = [...new Set(FS_B.flatMap(b => [b[0], b[1]]))];
const FS_ARM = [0.36, 0.38], FS_LEG = [0.38, 0.42];   // 上臂、前臂；大腿、小腿多長
// 兩節的 IK：從 A 伸到 T（構不到就把 T 拉近），中間的關節往 pole 那邊彎
const _fsD = new THREE.Vector3(), _fsP = new THREE.Vector3();
function fsIK(A, T, L1, L2, pole, out) {
  _fsD.subVectors(T, A);
  let d = _fsD.length();
  const mx = (L1 + L2) * 0.995;
  if (d > mx) { _fsD.multiplyScalar(mx / d); T.copy(A).add(_fsD); d = mx; }
  _fsD.multiplyScalar(1 / Math.max(d, 1e-4));
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _fsP.copy(pole).addScaledVector(_fsD, -pole.dot(_fsD)).normalize();
  return out.copy(A).addScaledVector(_fsD, a).addScaledVector(_fsP, h);
}
function buildFast(r, g) {
  const T = { transparent: true };
  const skin = withDetail(ownPhong('#ffffff', { map: m5Tex('fsSkin', 512, 512, fsPaintSkin), specular: 0x2e2c30, shininess: 26, shade: 0.8, ...T }), 'corpse', 3, 0.7);
  const head = withDetail(ownPhong('#ffffff', { map: m5Tex('fsHead', 1024, 512, fsPaintHead), specular: 0x2e2c30, shininess: 26, shade: 0.8, ...T }), 'corpse', 3, 0.7);
  head.map.wrapS = THREE.ClampToEdgeWrapping;
  const eye = ownBasic({ map: m5Tex('fsEye', 128, 64, fsPaintEye), ...T });
  r.mats.push(skin, head, eye);
  r.body = new THREE.Group(); g.add(r.body);
  r.torso = new THREE.Group(); r.torso.position.set(...FS.hip); r.torso.rotation.x = FS.pitch; r.body.add(r.torso);
  r.torso.add(new THREE.Mesh(loftGeo('fsTorso', fsTorsoRings(), { seg: 20, sub: 2, capA: 0.05, capB: 0.03, bumps: FS_BUMPS }), skin));
  r.J = Object.fromEntries(FS_J.map(k => [k, new THREE.Vector3()]));
  r.limbG = skTubesGeo(FS_B, new THREE.Sphere(new THREE.Vector3(0, 0.5, 0.1), 1.1));
  const lm = new THREE.Mesh(r.limbG, skin); lm.userData.ownGeo = true; lm.frustumCulled = false; r.body.add(lm);
  r.head = new THREE.Group(); r.body.add(r.head);
  r.head.add(new THREE.Mesh(fsHeadGeo(), head));
  const v = new THREE.Vector3();
  for (const s of [-1, 1]) {
    const X = s * FS_EYE.x, Y = FS_EYE.y;
    fsHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), v);
    const e = new THREE.Group(); e.position.set(v.x, v.y, v.z - FS_EYE.R * 0.55); e.rotation.y = s * 0.15; r.head.add(e);
    e.add(new THREE.Mesh(geo('fsEye', () => new THREE.SphereGeometry(FS_EYE.R, 12, 8)), eye));
    const gl = ownSprite(glowTex, 0xffd23a); gl.position.z = FS_EYE.R * 1.3; gl.scale.setScalar(0.08); e.add(gl);
    const halo = ownSprite(glowTex, 0x4a3606); halo.position.z = FS_EYE.R * 2; halo.scale.setScalar(0.11); e.add(halo);   // 遠遠的也看得到兩個黃點
    r.eyes.push(gl, halo);
  }
  r.ph = 0; r.spd = 0;
  syncFast({ x: 0, y: 0, wob: 0 }, r, 0, { x: 0, y: 3 }, 0);
  r.lx = undefined;
}
const _fsV = new THREE.Vector3(), _fsW = new THREE.Vector3(), _fsPole = new THREE.Vector3();
function syncFast(e, r, t, p, dt) {
  // 跑多快（照位置算）：慢慢跟上，停下來時慢慢回到蹲著
  const sp = r.lx === undefined ? 0 : Math.hypot(e.x - r.lx, e.y - r.ly) / Math.max(dt, 1e-3);
  r.lx = e.x; r.ly = e.y;
  r.spd += (Math.min(sp, 5) - r.spd) * Math.min(1, dt * 4);
  const run = clamp(r.spd / 2.5, 0, 1);
  r.ph += dt * r.spd * 3.4;
  const J = r.J, S = 0.12 + 0.26 * run, br = Math.sin(t * 2.4 + e.wob);
  // 身體：喘氣、跑的時候一起一伏（前腳落地時往前栽、後腳蹬地時往上拱）
  r.body.position.y = run * 0.04 * Math.abs(Math.sin(r.ph));
  r.torso.rotation.x = FS.pitch + 0.015 * br + run * 0.09 * Math.sin(r.ph + 0.6);
  r.torso.scale.set(1 + 0.02 * br * (1 - run), 1, 1 + 0.03 * br * (1 - run));
  r.torso.updateMatrix();
  const at = (k, x, y, z) => J[k].set(x, y, z).applyMatrix4(r.torso.matrix);
  at('nk', 0, 0.6, 0.005);
  for (const [s, sx] of [['L', -1], ['R', 1]]) { at('sh' + s, sx * 0.14, 0.53, -0.015); at('hp' + s, sx * 0.095, 0.04, -0.01); }
  // 腳步：前腳一起、後腳一起（左右差一點點），撐地的時候往後滑、抬起來的時候往前甩
  const step = (ph, base, lift, out) => {
    const c = ((ph / (Math.PI * 2)) % 1 + 1) % 1;
    let dz, dy;
    if (c < 0.5) { dz = S * (0.5 - 2 * c); dy = 0; } else { const u = (c - 0.5) * 2; dz = S * (sstep(0, 1, u) - 0.5); dy = lift * Math.sin(Math.PI * u); }
    return out.set(base[0], base[1] + dy * run, base[2] + dz * run);
  };
  for (const [s, sx, off] of [['L', -1, 0], ['R', 1, 0.5]]) {
    // 手：手腕撐在前面的地上，手肘往外、往後拱（像蜘蛛）
    const W = step(r.ph + off, [sx * 0.3, 0.055, 0.6], 0.16, J['wr' + s]), up = W.y - 0.055;
    fsIK(J['sh' + s], W, FS_ARM[0], FS_ARM[1], _fsPole.set(sx, 0.7, -0.5), J['el' + s]);
    const dir = _fsV.set(sx * 0.3, 0, 1).normalize();
    J['pa' + s].copy(W).addScaledVector(dir, 0.06).setY(W.y - 0.03);
    const curl = sstep(0.01, 0.08, up), tap = Math.max(0, Math.sin(t * 5 + e.wob * 3 + sx)) ** 12 * (1 - run);   // 抬起來時手指捲起來；蹲著時偶爾一根手指在地上敲
    for (let i = 0; i < 4; i++) {
      const a = (i - 1.5) * 0.3 * sx, fx = dir.x * Math.cos(a) + dir.z * Math.sin(a), fz = -dir.x * Math.sin(a) + dir.z * Math.cos(a), K = J['k' + s + i], Tp = J['t' + s + i];
      const lift = i === 2 ? tap * 0.04 : 0;
      K.copy(J['pa' + s]).add(_fsW.set(fx * 0.055, 0.028 + lift, fz * 0.055));
      Tp.copy(K).add(_fsW.set(fx * (0.08 - curl * 0.05), -0.045 * (1 - curl) - curl * 0.04 + lift * 0.5, fz * (0.08 - curl * 0.05)));
      Tp.y = Math.max(Tp.y, 0.006);
    }
    J['tk' + s].copy(W).add(_fsW.set(-sx * 0.03, -0.012, 0.03)); J['tt' + s].copy(J['tk' + s]).add(_fsW.set(-sx * 0.02, -0.02, 0.05)); J['tt' + s].y = Math.max(J['tt' + s].y, 0.006);
    // 腳：蹲著、腳跟抬起來，膝蓋往上、往外拱在身體兩側
    const A = step(r.ph + Math.PI + off * 0.6, [sx * 0.21, 0.13, -0.24], 0.12, J['an' + s]);
    fsIK(J['hp' + s], A, FS_LEG[0], FS_LEG[1], _fsPole.set(sx * 0.7, 1, 0.6), J['kn' + s]);
    const fd = _fsV.set(sx * 0.15, 0, 1).normalize();
    J['ba' + s].copy(A).addScaledVector(fd, 0.1).setY(Math.max(0.025, A.y - 0.1));
    for (let j = 0; j < 3; j++) { const a = (j - 1) * 0.25; J['o' + s + j].copy(J['ba' + s]).add(_fsW.set((fd.x * Math.cos(a) + fd.z * Math.sin(a)) * 0.08, -0.018, (-fd.x * Math.sin(a) + fd.z * Math.cos(a)) * 0.08)); J['o' + s + j].y = Math.max(J['o' + s + j].y, 0.006); }
  }
  // 頭：從脖子往前伸、抬起來看著你；不動的時候歪來歪去，偶爾突然抽一下
  const nk = J.nk, d = Math.hypot(p.x - e.x, p.y - e.y), jerk = Math.sin(t * 0.43 + e.wob) > 0.9 ? Math.sin(t * 38) * 0.08 : 0;
  r.head.position.set(nk.x, nk.y + 0.07, nk.z + 0.14);
  r.head.rotation.set(-Math.atan2(1.5 - r.head.position.y, Math.max(0.6, d)) + 0.15 + run * 0.1 * Math.sin(r.ph * 2), Math.sin(t * 0.5 + e.wob) * 0.12 * (1 - run), (0.3 * Math.sin(t * 0.7 + e.wob) + jerk) * (1 - run * 0.7));
  r.head.updateMatrix();
  J.hj.set(0, -0.045, -0.075).applyMatrix4(r.head.matrix);
  skTubesUpdate(r.limbG, J, FS_B);
}
UPG.fast = { build: buildFast, sync: syncFast, view: { h: 1.2, d: 2.9, cy: 0.55 } };

// ---------- 黑球 ----------
// 一團黏黏稠稠、黑得發亮的焦油（原本草稿用鉛筆塗的鋸齒線，變成表面一圈一圈的波紋，帶一點點油亮的紫藍色），
// 歪歪扭扭的一團，表面一直慢慢地蠕動（vertex shader），底下垂著幾條黏液，爬到燈上吃燈的時候會掛下來。
// 兩顆濕濕的黑眼睛半埋在焦油裡，周圍的焦油鼓起來，眼睛裡是原本那兩個發光的紅色圈圈。
// 大小、跳、吃燈時抖、變大都照原本的（網格是半徑 1 的一團，整個照 0.4 × size 縮放）
const BL_EYE = { x: 0.25, y: 0.24, R: 0.13 };
function blBodyPt(x, y, z, out) {
  let k = 1 + 0.06 * Math.sin(3 * x + 1.3) * Math.cos(2.4 * y) + 0.04 * Math.sin(5 * z + 2 * x) + 0.025 * Math.sin(9 * y + 4 * z) + 0.07 * (fbm3(x * 1.8, y * 1.8, z * 1.8, 3, 91) - 0.5);
  if (z > 0.3) for (const s of [-1, 1]) {   // 眼睛的地方凹下去、周圍的焦油鼓起來
    const q = Math.hypot(x - s * BL_EYE.x, y - BL_EYE.y);
    k += -0.07 * Math.exp(-((q / 0.09) ** 2)) + 0.05 * Math.exp(-(((q - 0.15) / 0.05) ** 2));
  }
  const sag = y < 0 ? 1 + 0.14 * Math.sin(-y * Math.PI) : 1 - 0.06 * y;   // 很重、往下垂：下半部鼓出來，頂上窄一點
  return out.set(x * k * sag, Math.max(y * k * 0.88, -0.8 - 0.06 * (1 - x * x - z * z)), z * k * sag);   // 底部被自己壓扁
}
const blU = a => (a + Math.PI) / (Math.PI * 2), blV = th => th / Math.PI;
blU.inv = u => u * Math.PI * 2 - Math.PI; blV.inv = v => v * Math.PI;
// 焦油的表面：很黑，一圈一圈細細的波紋（亮一點，帶一點油亮的顏色）、小小的氣泡；bump 是同樣的波紋（被手電筒照到時反光會跟著起伏）
function blPaint(c, W, H, bump) {
  const img = c.createImageData(W, H), D = img.data;
  for (let py = 0; py < H; py++) {
    const th = blV.inv((py + 0.5) / H), st = Math.sin(th), y = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const a = blU.inv((px + 0.5) / W), x = st * Math.sin(a), z = st * Math.cos(a);
      const q = fbm3(x * 1.4, y * 1.4, z * 1.4, 3, 93), n = fbm3(x * 2.6 + q * 2.2, y * 2.6 - q * 1.6, z * 2.6, 4, 95);
      const rip = sstep(0.86, 0.99, skRidge(n)) + 0.5 * sstep(0.9, 0.99, skRidge(fbm3(x * 6 + q, y * 6, z * 6, 2, 97)));
      const bub = sstep(0.8, 0.86, fbm3(x * 14, y * 14, z * 14, 2, 99)) * (1 - sstep(0.86, 0.9, fbm3(x * 14, y * 14, z * 14, 2, 99)));
      const i = (py * W + px) * 4;
      if (bump) { const h = 128 + rip * 70 + bub * 60 + (n - 0.5) * 50; D[i] = D[i + 1] = D[i + 2] = h; D[i + 3] = 255; continue; }
      const L = 7 + rip * 11 + bub * 9 + (q - 0.5) * 6, oil = n * 18;
      D[i] = L * (0.9 + 0.12 * Math.sin(oil)); D[i + 1] = L * (0.86 + 0.1 * Math.sin(oil + 2)); D[i + 2] = L * (1.12 + 0.14 * Math.sin(oil + 4)); D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}
// 眼睛（球的正面是 u = 0.25）：黑得發亮的眼球、一圈紅色的虹膜和紅色的瞳孔；glow 是自己發光的那張（紅圈和中間的紅點）
function blPaintEye(c, W, H, glow) {
  const img = c.createImageData(W, H), D = img.data;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const ph = (px + 0.5) / W * Math.PI * 2, th = (py + 0.5) / H * Math.PI, z = Math.sin(ph) * Math.sin(th), ang = Math.acos(clamp(z, -1, 1));
    const ring = Math.exp(-(((ang - 0.42) / 0.07) ** 2)), dot = 1 - sstep(0.14, 0.22, ang), haze = Math.exp(-((ang / 0.55) ** 2)) * 0.35, i = (py * W + px) * 4;
    if (glow) { const k = clamp(ring + dot + haze * 0.5, 0, 1); D[i] = 255 * k; D[i + 1] = 70 * k * k; D[i + 2] = 50 * k * k; }
    else { const k = clamp(ring + dot, 0, 1) * 0.6 + haze * 0.3; D[i] = 12 + 160 * k; D[i + 1] = 8 + 30 * k; D[i + 2] = 10 + 26 * k; }
    D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 焦油的材質：表面在 vertex shader 裡慢慢蠕動（uBT 是時間，每隻一份）
function blGooMat(opts) {
  const m = ownPhong('#ffffff', opts), u = { uBT: { value: 0 }, uBA: { value: 0.035 } }, prev = m.onBeforeCompile, key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, rd) => {
    prev.call(m, sh, rd);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uBT, uBA;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float bw = sin(uBT * 1.7 + position.x * 5.0 + position.y * 3.0) * sin(uBT * 1.3 + position.z * 4.0 - position.y * 2.0) + 0.5 * sin(uBT * 2.3 - position.y * 7.0 + position.x * 2.0);
        transformed += normal * bw * uBA;`);
  };
  m.customProgramCacheKey = () => key + '-goo';
  m.userData.goo = u;
  return m;
}
const blBodyGeo = () => sculptGeo('blBody', blBodyPt, blU, blV, th => sstep(0.9, 1.1, th) * (1 - sstep(1.5, 1.7, th)), a => sstep(-0.8, -0.6, a) * (1 - sstep(0.6, 0.8, a)), [0.07, 0.07], [0.12, 0.12]);   // 黑球常常好幾隻
// 底下垂著的黏液：從表面往下拉長、尾端一滴（在地上時縮回身體裡，爬上去吃燈時才掛下來）
function blDripGeo() {
  const parts = [], r = seeded(4242), v = new THREE.Vector3();
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * Math.PI * 2 + r() * 0.8, th = 2.2 + r() * 0.5, L = 0.25 + r() * 0.35;
    blBodyPt(Math.sin(th) * Math.sin(a), Math.cos(th), Math.sin(th) * Math.cos(a), v).multiplyScalar(0.96);
    const P = [[v.x, v.y, v.z], [v.x * 0.97, v.y - L * 0.4, v.z * 0.97], [v.x * 0.95 + (r() - 0.5) * 0.05, v.y - L * 0.8, v.z * 0.95], [v.x * 0.95, v.y - L, v.z * 0.95]];
    parts.push([tubeGeo('blDrip' + i, P, [0.11, 0.05, 0.03, 0.035], 6, 8), new THREE.Matrix4()]);
    parts.push([geo('blDrop', () => new THREE.SphereGeometry(1, 8, 6)), mat4(v.x * 0.95, v.y - L - 0.02, v.z * 0.95, 0, 0, 0, 0.055, 0.075, 0.055)]);
  }
  return mergeParts('blDrips', parts);
}
function buildBlob(r, g) {
  const T = { transparent: true };
  r.bodyM = blGooMat({ map: m5Tex('blSkin', 1024, 512, (c, W, H) => blPaint(c, W, H, false)), bumpMap: m5Tex('blBump', 1024, 512, (c, W, H) => blPaint(c, W, H, true)), bumpScale: 2.5, specular: 0x6a6878, shininess: 85, shade: 0.7, ...T });
  r.bodyM.map.wrapS = r.bodyM.bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  r.bodyM.bumpMap.colorSpace = THREE.NoColorSpace;
  const eye = ownPhong('#ffffff', { map: m5Tex('blEye', 256, 128, (c, W, H) => blPaintEye(c, W, H, false)), emissiveMap: m5Tex('blEyeGlow', 256, 128, (c, W, H) => blPaintEye(c, W, H, true)), emissive: 0xffffff, specular: 0xffffff, shininess: 110, shade: 0.5, ...T });
  r.mats.push(r.bodyM, eye);
  r.body = new THREE.Group(); g.add(r.body);
  r.body.add(new THREE.Mesh(blBodyGeo(), r.bodyM));
  r.drips = new THREE.Mesh(blDripGeo(), r.bodyM); r.drips.scale.y = 0.01; r.drips.visible = false; r.body.add(r.drips);
  const v = new THREE.Vector3();
  for (const s of [-1, 1]) {
    const X = s * BL_EYE.x, Y = BL_EYE.y;
    blBodyPt(X, Y, Math.sqrt(1 - X * X - Y * Y), v);
    const e = new THREE.Group(); e.position.copy(v).multiplyScalar(0.93); e.rotation.y = s * 0.2; r.body.add(e);
    e.add(new THREE.Mesh(geo('blEye', () => new THREE.SphereGeometry(BL_EYE.R, 16, 12)), eye));
    const gl = ownSprite(glowTex, 0xff3a2a); gl.position.z = BL_EYE.R * 1.2; gl.scale.setScalar(0.32); e.add(gl);
    r.eyes.push(gl);
  }
}
function syncBlob(e, r, t, p, dt) {
  // 跟原本一樣：在地上一跳一跳的（落地時壓扁、跳起來時拉長），吃燈的時候抖；整團照大小縮放
  const R = 0.4 * (e.size || 1), eating = e.eatT > 0, grounded = !eating && e.h < R + 0.05, hk = Math.abs(Math.sin(e.wob * 6));
  r.g.position.set(e.x, floorH(e.x, e.y) + e.h + (grounded ? hk * 0.14 : 0), e.y);
  const sq = eating ? Math.sin(e.wob * 14) * 0.1 : grounded ? 0.12 * (1 - sstep(0, 0.35, hk)) - 0.05 * sstep(0.5, 1, hk) : Math.sin(e.wob * 12) * 0.05;
  r.body.scale.set(R * (1 + sq), R * (1 - sq), R * (1 + sq));
  const hang = clamp((e.h - R - 0.1) / 0.4, 0, 1);   // 離地多高：黏液慢慢垂下來
  r.drips.scale.y = Math.max(0.01, hang); r.drips.visible = hang > 0.02;
  const u = r.bodyM.userData.goo;
  u.uBT.value = t + e.wob; u.uBA.value = eating ? 0.06 : 0.035;
}
UPG.blob = { build: buildBlob, sync: syncBlob, view: { h: 1.0, d: 2.4, cy: 0.45 } };

// ---------- 眼球花 ----------
// 設計師：「眼球的血絲畫真點」。一根有點彎的綠莖、兩片垂下來的真的葉子，頂上一圈肉肉的萼片像手一樣托著一顆比頭還大的眼球；
// 眼球轉過來盯著你（在萼片裡轉）。眼白越往後越紅、濕濕的，一條一條真的血管從後面爬過來：越往前越細、彎彎曲曲地分岔，
// 到虹膜旁邊變成很細的微血管，血管周圍的眼白淡淡地充血。虹膜是灰色的、一絲一絲放射狀的紋路、一圈花環、深色的外圈，
// 中間淡淡一圈螺旋（照草稿），黑色的瞳孔；虹膜上面是一層會反光的角膜。動作跟原本一樣（盯著你、被照到瞇起來、尖叫時發紅、白天垂下來睡）。
// 花不是怪物：buildFlower、syncFlower 開頭的鉤子會用 UPG.eye.flower（第二世界的花也用同一個鉤子）
const EF = { y: 1.28, R: 0.24, iris: 0.098 };
// 眼白（球的正面是 u = 0.25）：W × H（H = W / 2）
function efPaintSclera(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, irisA = Math.asin(EF.iris / EF.R);
  for (let py = 0; py < H; py++) {
    const th = (py + 0.5) / H * Math.PI, y = Math.cos(th), st = Math.sin(th);
    for (let px = 0; px < W; px++) {
      const ph = (px + 0.5) / W * Math.PI * 2, x = -Math.cos(ph) * st, z = Math.sin(ph) * st, ang = Math.acos(clamp(z, -1, 1));
      const n = fbm3(x * 2.5, y * 2.5, z * 2.5, 4, 111), k = sstep(1.1, 2.8, ang + (n - 0.5) * 0.5), i = (py * W + px) * 4;
      let R = 244 - k * 30, G2 = 238 - k * 92, B = 228 - k * 90;
      const flush = sstep(0.6, 0.85, fbm3(x * 4, y * 4, z * 4, 3, 113)) * (0.15 + 0.85 * k);   // 一塊一塊充血
      R -= flush * 10; G2 -= flush * 44; B -= flush * 40;
      const lim = Math.exp(-(((ang - irisA - 0.06) / 0.07) ** 2));   // 虹膜旁邊淡淡的灰影
      R -= lim * 40; G2 -= lim * 40; B -= lim * 30;
      D[i] = R; D[i + 1] = G2; D[i + 2] = B; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  overlayDetail(c, 'sclera', W, H, 4, 0.5);   // 照片的眼白：濕濕的表面
  // 血管：從後面往前（往虹膜）長，越長越細、彎彎曲曲地分岔；先畫一層淡淡的充血，再畫血管（外面暗紅、中間比較亮）
  const r = seeded(7311), segs = [], toPx = (a, b) => {
    const st = Math.sin(a), x = st * Math.cos(b), y = st * Math.sin(b), z = Math.cos(a);
    return [((Math.atan2(z, -x) / (Math.PI * 2)) % 1 + 1) % 1 * W, Math.acos(clamp(y, -1, 1)) / Math.PI * H];
  };
  const grow = (a, b, dir, w, depth) => {   // a 離正面的角度、b 繞一圈的角度、dir 往哪個方向長（在 a-b 平面上，0 是往正面）
    let prev = toPx(a, b);
    while (w > 0.35 && a > irisA + 0.05) {
      const st = 0.012 + w * 0.004;
      dir += (r() - 0.5) * 0.9 - dir * 0.08;
      a -= Math.cos(dir) * st; b += Math.sin(dir) * st / Math.max(0.2, Math.sin(a));
      w *= 0.985 - (a < 1 ? 0.012 : 0);
      const q = toPx(a, b);
      if (Math.abs(q[0] - prev[0]) < W / 4) segs.push([prev[0], prev[1], q[0], q[1], w]);
      prev = q;
      if (depth < 3 && r() < 0.03) grow(a, b, dir + (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6), w * (0.55 + r() * 0.2), depth + 1);
    }
  };
  const sc = W / 1024;
  for (let i = 0; i < 16; i++) grow(1.8 + r() * 0.9, i / 16 * Math.PI * 2 + r() * 0.3, (r() - 0.5) * 0.6, (2.4 + r() * 3) * sc, 0);
  for (let i = 0; i < 28; i++) grow(0.8 + r() * 0.55, r() * Math.PI * 2, (r() - 0.5) * 1.5, (0.7 + r() * 0.8) * sc, 2);   // 虹膜旁邊的微血管
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const [col, kw] of [['rgba(214,90,96,.07)', 3.5], ['rgba(116,10,18,.85)', 1], ['rgba(198,48,56,.7)', 0.45]]) {
    c.strokeStyle = col;
    for (const s of segs) { c.lineWidth = s[4] * kw; c.beginPath(); c.moveTo(s[0], s[1]); c.lineTo(s[2], s[3]); c.stroke(); }
  }
}
// 虹膜：灰色、一絲一絲放射狀的紋路、小小的凹洞、一圈花環、深色的外圈、淡淡一圈螺旋（照草稿），中間黑色的瞳孔
function efPaintIris(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, C = W / 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const dx = (px + 0.5 - C) / C, dy = (py + 0.5 - C) / C, rr = Math.hypot(dx, dy), a = Math.atan2(dy, dx), i = (py * W + px) * 4;
    if (rr > 1) { D[i] = 60; D[i + 1] = 56; D[i + 2] = 54; D[i + 3] = 255; continue; }
    const fib = vnoise3(Math.cos(a) * 26, Math.sin(a) * 26, rr * 2.5, 121), fib2 = vnoise3(Math.cos(a) * 70, Math.sin(a) * 70, rr * 5, 123);
    let L = 104 + (fib - 0.5) * 60 + (fib2 - 0.5) * 30;
    L += 26 * Math.exp(-(((rr - 0.5 - 0.04 * Math.sin(a * 9)) / 0.05) ** 2));   // 花環
    L -= 40 * sstep(0.55, 0.75, fbm3(Math.cos(a) * 6, Math.sin(a) * 6, rr * 4, 3, 125)) * sstep(0.45, 0.6, rr) * (1 - sstep(0.85, 0.9, rr));   // 凹洞
    const sp = ((a + Math.PI) / (Math.PI * 2) + rr * 2.2) % 1;   // 螺旋
    L -= 34 * Math.exp(-(((sp - 0.5) / 0.08) ** 2)) * sstep(0.3, 0.38, rr) * (1 - sstep(0.78, 0.88, rr));
    L *= 1 - 0.55 * sstep(0.84, 0.98, rr);   // 深色的外圈
    const pu = 1 - sstep(0.3, 0.335, rr);
    L = L * (1 - pu) + 3 * pu;
    D[i] = L * 1.02; D[i + 1] = L * 0.98; D[i + 2] = L * 0.93; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 莖（u 沿著莖、v 繞一圈）：綠色、一條一條細細的直紋、一點一點深色的斑，根部和頂上有一點紫紅
function efPaintStem(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, T = Math.PI * 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H, cv = Math.cos(T * v), sv = Math.sin(T * v);
    const n = fbm3(cv * 0.6, sv * 0.6, u * 8, 3, 131), st = vnoise3(cv * 9, sv * 9, u * 2, 133), spot = sstep(0.72, 0.78, fbm3(cv * 2, sv * 2, u * 40, 2, 135));
    const red = sstep(0.12, 0, u) + sstep(0.9, 1, u) * 0.8, i = (py * W + px) * 4, k = 0.85 + (n - 0.5) * 0.3 + (st - 0.5) * 0.25 - spot * 0.3;
    D[i] = (74 + red * 50) * k; D[i + 1] = (118 - red * 40) * k; D[i + 2] = (62 - red * 6) * k; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 葉子（u 從葉柄到葉尖、v 橫的）：中間一條淺色的主脈、斜斜往外的側脈、邊緣暗一點，葉尖有一點枯黃、幾個褐色的小斑
function efPaintLeaf(c, W, H) {
  const img = c.createImageData(W, H), D = img.data;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H * 2 - 1, av = Math.abs(v), i = (py * W + px) * 4;
    const n = fbm3(u * 5, v * 3, 0.5, 4, 141), mid = Math.exp(-((v / 0.035) ** 2)), side = Math.exp(-(((((u - av * 0.45) * 7) % 1 + 1) % 1 - 0.5) ** 2 / 0.006)) * sstep(0.05, 0.15, av);
    const dry = sstep(0.75, 1, u + (n - 0.5) * 0.3) * 0.6, spot = sstep(0.74, 0.8, fbm3(u * 18, v * 9, 3, 2, 143));
    let R = 60 + (n - 0.5) * 30 + mid * 50 + side * 22, G2 = 112 + (n - 0.5) * 34 + mid * 46 + side * 22, B = 52 + (n - 0.5) * 18 + mid * 24 + side * 10;
    const edge = sstep(0.7, 1, av); R *= 1 - edge * 0.3; G2 *= 1 - edge * 0.3; B *= 1 - edge * 0.3;
    R += (150 - R) * dry; G2 += (130 - G2) * dry; B += (60 - B) * dry;
    R += (90 - R) * spot; G2 += (60 - G2) * spot; B += (30 - B) * spot;
    D[i] = R; D[i + 1] = G2; D[i + 2] = B; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 一片葉子：沿著 +x 長，中間沿著主脈往上摺一點、越往葉尖越往下垂，邊緣微微波浪
function efLeafGeo(key, L, w) {
  return geo(key, () => {
    const NL = 10, NW = 6, pos = [], uv = [], idx = [];
    for (let i = 0; i <= NL; i++) for (let j = 0; j <= NW; j++) {
      const t = i / NL, s = j / NW * 2 - 1, W2 = w * Math.sin(Math.PI * Math.min(1, t ** 0.7)) * (1 - 0.15 * t) + 0.004;
      pos.push(t * L, -0.3 * L * t * t + Math.abs(s) * W2 * 0.3 + 0.006 * Math.sin(t * 14 + s * 3), s * W2);
      uv.push(t, j / NW);
      if (i < NL && j < NW) { const a = i * (NW + 1) + j, b = a + NW + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  });
}
// 托著眼球的萼片：頂上一個鼓鼓的花托，六片肉肉的萼片從底下往上包住眼球的下半部，尖端往外翹
function efCalyxGeo() {
  return geo('efCalyx', () => {
    const parts = [[new THREE.SphereGeometry(1, 14, 8), mat4(0, EF.y - EF.R - 0.005, 0, 0, 0, 0, 0.07, 0.05, 0.07)]];
    for (let k = 0; k < 6; k++) {
      const az = k / 6 * Math.PI * 2 + 0.3, NL = 9, NW = 4, pos = [], uv = [], idx = [];
      for (let i = 0; i <= NL; i++) for (let j = 0; j <= NW; j++) {
        const t = i / NL, s = j / NW * 2 - 1, hw = 0.62 * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.8)) ** 0.6 * (1 - 0.35 * t), p = Math.PI - 0.06 - t * (1.0 + 0.12 * (k % 2)), b = az + s * hw, rr = EF.R + 0.006 + 0.004 * (k % 2) + 0.022 * t * t * t - 0.004 * s * s;
        pos.push(rr * Math.sin(p) * Math.cos(b), EF.y + rr * Math.cos(p), rr * Math.sin(p) * Math.sin(b));
        uv.push(t, j / NW);
        if (i < NL && j < NW) { const a = i * (NW + 1) + j, c2 = a + NW + 1; idx.push(a, a + 1, c2, a + 1, c2 + 1, c2); }
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      gg.setIndex(idx); gg.computeVertexNormals();
      parts.push([gg, new THREE.Matrix4()]);
    }
    const gs = parts.map(([gm, m]) => { const c = gm.toNonIndexed(); c.applyMatrix4(m); return c; });
    let n = 0; for (const c of gs) n += c.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const c of gs) { pos.set(c.attributes.position.array, o * 3); nor.set(c.attributes.normal.array, o * 3); uv.set(c.attributes.uv.array, o * 2); o += c.attributes.position.count; c.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  });
}
// 萼片：綠色、往尖端越來越紅（像充血），一條一條紅色的細脈
function efPaintCalyx(c, W, H) {
  const img = c.createImageData(W, H), D = img.data;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H * 2 - 1, n = fbm3(u * 6, v * 3, 1.5, 4, 151), vein = Math.exp(-((((v * 3 + (n - 0.5) * 0.6) % 1 + 1) % 1 - 0.5) ** 2 / 0.004)), red = sstep(0.4, 1, u) * 0.7 + vein * 0.5 * sstep(0.2, 0.6, u), i = (py * W + px) * 4;
    D[i] = (66 + (n - 0.5) * 30) * (1 - red) + (128 + (n - 0.5) * 30) * red; D[i + 1] = (100 + (n - 0.5) * 30) * (1 - red) + (34 + (n - 0.5) * 16) * red; D[i + 2] = (50 + (n - 0.5) * 16) * (1 - red) + (40 + (n - 0.5) * 14) * red; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
function buildEyeFlower(f, g) {
  const stemM = ownLM('#ffffff', { map: m5Tex('efStem', 512, 64, efPaintStem), shade: 0.75 });
  const leafM = ownLM('#ffffff', { map: m5Tex('efLeaf', 256, 128, efPaintLeaf), side: THREE.DoubleSide, shade: 0.7 });
  const calyxM = ownPhong('#ffffff', { map: m5Tex('efCalyx', 128, 128, efPaintCalyx), specular: 0x2a2a22, shininess: 30, side: THREE.DoubleSide, shade: 0.75 });
  for (const m of [stemM, leafM, calyxM]) m.map.wrapS = THREE.ClampToEdgeWrapping;
  g.add(new THREE.Mesh(tubeGeo('efStem', [[0, 0, 0], [0.03, 0.3, 0.01], [0.045, 0.6, 0], [0.02, 0.88, -0.01], [0, EF.y - EF.R - 0.02, 0]], [0.03, 0.026, 0.024, 0.023, 0.03], 8, 24), stemM));
  for (const s of [-1, 1]) {
    const lf = new THREE.Group(); lf.position.set(0.04 + s * 0.012, 0.5 + (s > 0 ? 0.06 : 0), 0); lf.rotation.set(s * 0.15, s > 0 ? 0 : Math.PI, 0.45); g.add(lf);
    lf.add(new THREE.Mesh(efLeafGeo('efLeaf', 0.32, 0.075), leafM));
  }
  g.add(new THREE.Mesh(efCalyxGeo(), calyxM));
  const eyeG = new THREE.Group(); eyeG.position.y = EF.y; eyeG.rotation.order = 'YXZ'; g.add(eyeG);
  const eyeMat = ownPhong('#ffffff', { map: m5Tex('efSclera', 2048, 1024, efPaintSclera), emissive: 0x1a1414, specular: 0x888888, shininess: 95, shade: 0.6 });
  const ball = new THREE.Mesh(geo('efBall', () => new THREE.SphereGeometry(EF.R, 32, 22)), eyeMat); eyeG.add(ball);
  const irisMat = ownPhong('#ffffff', { map: m5Tex('efIris', 512, 512, efPaintIris), emissive: 0x141010, specular: 0xcccccc, shininess: 140, shade: 0.6 });
  const iris = new THREE.Mesh(irisGeo('efIris', EF.R, EF.iris, 0), irisMat); eyeG.add(iris);
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { g, eyeG, ball, iris, eyeMat, irisMat };
}
// 跟原本的眼球花一樣：晚上轉過來盯著你（眼球微微地抖）、白天垂下來睡；被手電筒照到瞇起來；尖叫時發紅
function syncEyeFlower(f, r, t, p, awake) {
  const dx = p.x - f.x, dz = p.y - f.y, dist = Math.hypot(dx, dz);
  if (awake) {
    r.eyeG.rotation.y = Math.atan2(dx, dz) + Math.sin(t * 7 + f.x) * 0.02;
    r.eyeG.rotation.x = -Math.atan2(EYE - EF.y, Math.max(0.5, dist));
  } else { r.eyeG.rotation.y = Math.sin(t * 0.3 + f.x); r.eyeG.rotation.x = 0.95; }
  const squint = 1 - (f.burn || 0) / 1.5 * 0.6;
  r.ball.scale.y = squint; r.iris.scale.y = squint;
  const al = f.alarm > 0 ? 0.35 + 0.35 * Math.sin(t * 30) : 0;
  r.eyeMat.emissive.setRGB(0.1 + al, 0.08, 0.08);
  r.irisMat.emissive.setRGB(0.08 + al, 0.06, 0.06);
}
// ---------- 血淚女 ----------
// 穿著黑色長裙的女人（大約 1.8 公尺），微微飄在地上：裙子有一條一條垂下來的皺褶，裙襬破破爛爛的，胸前有往下滴的血漬；
// 兩隻蒼白、瘦得見骨的長手垂在身體兩側，手指又細又長。濕濕的長黑髮：厚厚的瀏海蓋到眉毛，兩邊垂到胸前、後面垂到腰。
// 臉比真人大一點，灰白色的死人皮膚：一雙瞪得大大的眼睛（布滿血絲、灰色的螺旋眼珠，跟原本畫的一樣），眼皮紅腫，
// 底下一張張得很大的方嘴，上下露出牙齦和兩排參差不齊的牙；血淚從眼睛一路流過臉頰和嘴巴，嘴角也在滴血。
// 動作跟原本一樣：被你看著時完全不動、頭歪一邊（連頭髮都停住），沒被看著時飄著、會抖；眼睛一直盯著你
const WM_HEAD = { y: 1.59, rx: 0.132, ry: 0.172, rz: 0.138 };   // 臉比真人大一點（原本是一張很大的臉）
const WM_EYE = { x: 0.34, y: 0.1, R: 0.029 }, WM_LID = { w: 1.05, hu: 0.8, hl: 0.66, lift: -0.02 };   // 瞪得大大的
const WM_M = { top: -0.29, bot: -0.63, hw: 0.42, rad: 0.12 };
const WM_FACE = [   // [X, Y, 寬, 高, 凸起多少, 左右對稱]
  [0.33, 0.3, 0.28, 0.06, 0.04, true],    // 眉骨
  [0.34, 0.1, 0.22, 0.15, -0.05, true],   // 眼窩
  [0.56, -0.12, 0.14, 0.09, 0.05, true],  // 顴骨
  [0.52, -0.4, 0.14, 0.15, -0.06, true],  // 凹下去的臉頰
  [0.7, 0.3, 0.15, 0.2, -0.03, true],     // 太陽穴
  [0, 0.0, 0.05, 0.14, 0.075, false],     // 鼻樑
  [0, -0.15, 0.07, 0.06, 0.13, false],    // 鼻頭
  [0.06, -0.19, 0.035, 0.03, 0.03, true], // 鼻翼
  [0.035, -0.215, 0.02, 0.015, -0.03, true], // 鼻孔
  [0, -0.86, 0.18, 0.08, 0.05, false],    // 下巴
];
// 張開的方嘴（圓角的長方形）：e 離嘴的邊多遠（負的是在嘴裡面），upper 靠上面那排牙
const _wmm = { e: 0, upper: false };
function wmMouth(x, y) {
  const cy = (WM_M.top + WM_M.bot) / 2, hh = (WM_M.top - WM_M.bot) / 2, qx = Math.abs(x) - (WM_M.hw - WM_M.rad), qy = Math.abs(y - cy) - (hh - WM_M.rad);
  _wmm.e = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - WM_M.rad;
  _wmm.upper = y > cy;
  return _wmm;
}
let wmEyeAt = null;
function wmEyes() {
  if (wmEyeAt) return wmEyeAt;
  wmEyeAt = [-1, 1].map(s => {
    const X = s * WM_EYE.x, Y = WM_EYE.y, S0 = wmHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), new THREE.Vector3(), true);
    const F = new THREE.Vector3(s * 0.12, 0, 1).normalize();
    return { s, F, C: S0.addScaledVector(F, -0.82 * WM_EYE.R) };
  });
  return wmEyeAt;
}
function wmHeadPt(x, y, z, out, noEye) {
  let X = x, Y = y, Z = z;
  if (y < 0) { const t = -y; X *= 1 - 0.25 * t * t; Z *= 1 - 0.1 * t * t; }   // 下巴窄
  if (Z > 0) Z *= 0.88 + 0.12 * Math.min(1, Math.abs(x) * 1.6);            // 臉平一點
  else Z *= 1.08;
  let d = 0, back = 0;
  if (z > 0.05) {
    for (const f of WM_FACE) for (const s of f[5] ? [-1, 1] : [1]) { const u = (x - s * f[0]) / f[2], v = (y - f[1]) / f[3]; if (u * u + v * v < 16) d += f[4] * Math.exp(-u * u - v * v); }
    const m = wmMouth(x, y);
    if (m.e < 0.12) { back += 0.34 * sstep(0.004, -0.03, m.e); d += 0.03 * Math.exp(-(((m.e - 0.02) / 0.018) ** 2)); }
    const w = sstep(0.05, 0.4, z);
    d *= w; back *= w;
  }
  const k = 1 + d / (Math.hypot(X, Y, Z) || 1);
  out.set(X * k * WM_HEAD.rx, Y * k * WM_HEAD.ry, (Z * k - back) * WM_HEAD.rz);
  if (noEye || z < 0.3) return out;
  for (const E of wmEyes()) {
    const dx = (x - E.s * WM_EYE.x) * E.s * WM_HEAD.rx * 0.95, dy = (y - WM_EYE.y) * WM_HEAD.ry;
    if (dx * dx + dy * dy < (WM_EYE.R * 2.4) ** 2) crSnapLid(out, E.C, E.F, dx, dy, WM_EYE.R, WM_LID);
  }
  return out;
}
const wmU = crWarp(-Math.PI, Math.PI, a => 1 + 1.4 * Math.exp(-((a / 0.8) ** 2))), wmV = crWarp(0, Math.PI, th => 1 + 1.3 * Math.exp(-(((th - 1.75) / 0.55) ** 2)));
const wmHeadGeo = () => sculptGeo('wmHead', wmHeadPt, wmU, wmV, th => sstep(1.1, 1.25, th) * (1 - sstep(2.7, 2.85, th)), a => sstep(-1.3, -1.15, a) * (1 - sstep(1.15, 1.3, a)), [0.05, 0.055], [0.17, 0.18]);   // 頭頂和後腦勺被頭髮蓋住，格子可以很粗
// 頭的貼圖（一個一個像素算）：灰白色的死人皮膚、太陽穴底下青色的血管、深深的黑眼圈、紅腫的眼皮（上面一道紅紅的摺痕）、
// 暗紅的嘴唇、嘴裡粉紅色的牙齦和黑黑的喉嚨；頭頂、兩邊和後腦勺是頭髮的顏色（髮束中間的縫才不會露出皮膚）；最後畫流下來的血淚
function wmPaintHead(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, C = [0, 0, 0];
  const mix = (col, k) => { C[0] += (col[0] - C[0]) * k; C[1] += (col[1] - C[1]) * k; C[2] += (col[2] - C[2]) * k; };
  for (let py = 0; py < H; py++) {
    const th = wmV.inv((py + 0.5) / H), st = Math.sin(th), y = Math.cos(th);
    for (let px = 0; px < W; px++) {
      const a = wmU.inv((px + 0.5) / W), x = st * Math.sin(a), z = st * Math.cos(a), i = (py * W + px) * 4;
      const n = fbm3(x * 4, y * 4, z * 4, 4, 161), f = fbm3(x * 30, y * 30, z * 30, 2, 163);
      C[0] = 208 + (n - 0.5) * 22 + (f - 0.5) * 10; C[1] = 202 + (n - 0.5) * 20 + (f - 0.5) * 10; C[2] = 198 + (n - 0.5) * 18 + (f - 0.5) * 10;
      mix([150, 160, 176], sstep(0.88, 0.97, skRidge(fbm3(x * 3 + 7, y * 3, z * 3, 3, 167))) * 0.35 * sstep(0.4, 0.75, Math.abs(x)));   // 青色的血管
      if (z > 0.05) {
        for (const s of [-1, 1]) {
          const dx = (x - s * WM_EYE.x) * s * WM_HEAD.rx * 0.95, dy = (y - WM_EYE.y) * WM_HEAD.ry, L = crLidE(dx, dy, WM_EYE.R, WM_LID), e = L.e;
          if (e > 0.05) continue;
          mix([92, 72, 80], (1 - sstep(0.006, 0.03, e + 0.01 * (n - 0.5))) * 0.5);   // 黑眼圈
          if (L.upper) mix([140, 46, 50], Math.exp(-(((e - 0.01) / 0.003) ** 2)) * 0.7);   // 上眼皮一道紅紅的摺痕
          mix([156, 50, 52], (1 - sstep(0.0015, 0.005, e)) * 0.9);   // 紅腫的眼皮
          if (e < 0) mix([60, 10, 12], 1);
        }
        const m = wmMouth(x, y);
        if (m.e < 0.06) {
          if (m.e >= 0) mix([120, 22, 28], (1 - sstep(0.01, 0.035, m.e + 0.01 * (n - 0.5))) * 0.95);   // 暗紅的嘴唇
          else { mix([176, 76, 88], 1); mix([16, 3, 5], sstep(0.03, 0.07, -m.e)); }   // 牙齦、喉嚨
        }
      }
      // 頭髮蓋住的地方：額頭上面、兩邊、後腦勺
      const hair = z < 0.1 ? 1 : Math.max(sstep(0.42, 0.5, y + 0.05 * (f - 0.5)), sstep(0.74, 0.92, Math.abs(x)) * sstep(0.05, 0.3, z) + (1 - sstep(0.05, 0.3, z)));
      mix([18, 16, 20], hair);
      D[i] = C[0]; D[i + 1] = C[1]; D[i + 2] = C[2]; D[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  // 血淚：從下眼皮流下來，一路流過臉頰和嘴巴到下巴；嘴角也在滴血
  const { at } = headPainter(c, W, H, wmU, wmV), r = seeded(20260928);
  const tear = (X, Y, len, w) => at(X, Y, () => {
    const dx1 = (r() - 0.5) * 4, dx2 = (r() - 0.5) * 4;
    c.lineCap = 'round';
    for (const [col, k] of [['rgba(120,10,16,.85)', 1], ['rgba(170,24,30,.6)', 0.45]]) { c.strokeStyle = col; c.lineWidth = w * k; c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(dx1, -len * 0.3, dx2, -len * 0.7, dx1 * 0.5, -len); c.stroke(); }
    c.fillStyle = 'rgba(110,8,14,.9)'; c.beginPath(); c.ellipse(dx1 * 0.5, -len - w * 0.4, w * 0.75, w * 1.1, 0, 0, 7); c.fill();
  });
  for (const s of [-1, 1]) {
    tear(s * (WM_EYE.x - 0.08), WM_EYE.y - 0.1, 66, 3.6);
    tear(s * (WM_EYE.x + 0.06), WM_EYE.y - 0.1, 50 + r() * 20, 3);
    tear(s * (WM_M.hw - 0.04), WM_M.bot - 0.01, 18 + r() * 10, 2.8);
  }
}
// 虹膜：灰色、一絲一絲的紋路，上面一圈很明顯的深色螺旋（跟原本畫的一樣），小小的瞳孔
function wmPaintIris(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, C2 = W / 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const dx = (px + 0.5 - C2) / C2, dy = (py + 0.5 - C2) / C2, rr = Math.hypot(dx, dy), a = Math.atan2(dy, dx), i = (py * W + px) * 4;
    const fib = vnoise3(Math.cos(a) * 30, Math.sin(a) * 30, rr * 3, 171);
    let L = rr > 1 ? 70 : 150 + (fib - 0.5) * 50;
    const sp = ((a + Math.PI) / (Math.PI * 2) + rr * 3.2) % 1;
    L -= 95 * Math.exp(-(((sp - 0.5) / 0.09) ** 2)) * sstep(0.14, 0.2, rr) * (1 - sstep(0.85, 0.95, rr));
    L *= 1 - 0.6 * sstep(0.86, 0.99, rr);
    const pu = 1 - sstep(0.13, 0.16, rr);
    L = L * (1 - pu) + 4 * pu;
    D[i] = L; D[i + 1] = L * 0.98; D[i + 2] = L * 0.96; D[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
// 長裙（loft 的 u 繞一圈、v 從領口往下到裙襬）：黑色的布、一條一條細細的直紋，裙襬附近沾了灰、破破爛爛的（透明度），胸前一片往下滴的血漬
function wmPaintDress(c, W, H) {
  const img = c.createImageData(W, H), D = img.data, T = Math.PI * 2;
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const u = (px + 0.5) / W, v = (py + 0.5) / H, cu = Math.cos(T * u), su = Math.sin(T * u);
    const n = fbm3(cu * 1.5, su * 1.5, v * 4, 4, 181), st = vnoise3(cu * 60, su * 60, v * 3, 183), i = (py * W + px) * 4;
    let L = 14 + (n - 0.5) * 8 + (st - 0.5) * 5;
    L += sstep(0.75, 1, v) * 10 * sstep(0.45, 0.7, fbm3(cu * 3, su * 3, v * 10, 3, 185));   // 裙襬沾的灰
    const fu = Math.abs(u - 0.5), drip = Math.exp(-((fu / (0.05 + 0.05 * (1 - v))) ** 2)) * sstep(0.03, 0.06, v) * (1 - sstep(0.18 + 0.25 * sstep(0.4, 0.7, fbm3(u * 40, 0, 0, 2, 187)), 0.45, v));
    const bl = clamp(drip * sstep(0.45, 0.6, n + 0.1), 0, 1) * 0.6;
    const R = L + bl * 16, G2 = L * 0.95 * (1 - bl * 0.5), B = L * 1.05 * (1 - bl * 0.5);
    const rag = 1 - sstep(0.965 - 0.03 * fbm3(cu * 6, su * 6, 2, 3, 189), 0.985, v);   // 破破爛爛的裙襬
    D[i] = R; D[i + 1] = G2; D[i + 2] = B; D[i + 3] = rag * 255;
  }
  c.putImageData(img, 0, 0);
}
const WM_DRESS = [
  { y: 1.44, w: 0.045, d: 0.045, z: 0.005 }, { y: 1.39, w: 0.07, d: 0.065 }, { y: 1.35, w: 0.16, d: 0.09 }, { y: 1.31, w: 0.205, d: 0.1 },
  { y: 1.2, w: 0.175, d: 0.105, f: 0.115 }, { y: 1.02, w: 0.13, d: 0.088 }, { y: 0.86, w: 0.16, d: 0.11 },
  { y: 0.6, w: 0.21, d: 0.16, wv: 0.006 }, { y: 0.35, w: 0.27, d: 0.22, wv: 0.013 }, { y: 0.13, w: 0.33, d: 0.29, wv: 0.019 }, { y: 0.04, w: 0.35, d: 0.32, wv: 0.022 },
];
// 手臂、手和脖子合成一個網格：手臂從肩膀垂下來、手指又細又長微微彎著
function wmSkinGeo() {
  const parts = [[tubeGeo('wmNeck', [[0, 1.37, 0.005], [0, 1.43, 0.0], [0, 1.5, -0.035]], [0.044, 0.042, 0.046], 10, 4), new THREE.Matrix4()]];   // 脖子接在下巴後面（不要從嘴裡穿出來）
  for (const s of [-1, 1]) {
    const W = [s * 0.235, 0.66, 0.07];
    parts.push([tubeGeo('wmArm' + s, [[s * 0.19, 1.3, 0], [s * 0.215, 1.12, 0.01], [s * 0.225, 0.98, 0.03], [s * 0.232, 0.82, 0.05], W], [0.034, 0.026, 0.024, 0.02, 0.016], 8, 16), new THREE.Matrix4()]);
    parts.push([geo('wmPalm', () => new THREE.SphereGeometry(1, 10, 8)), mat4(W[0], W[1] - 0.045, W[2] + 0.004, 0, s * 0.3, 0, 0.012, 0.05, 0.026)]);
    for (let i = 0; i < 5; i++) {
      const th = i === 4, L = th ? 0.07 : [0.12, 0.145, 0.14, 0.115][i];
      const f = tubeGeo('wmFinger' + i, [[0, 0, 0], [0, -L * 0.4, 0.008], [0, -L * 0.75, 0.02], [0, -L, 0.034]], [0.0075, 0.0065, 0.0052, 0.0032], 6, 8);
      const ry = s * 0.3, ox = th ? 0.004 : 0, oz = th ? 0.026 : -0.016 + i * 0.011;   // 手掌朝著身體：手指沿著手掌前後排
      parts.push([f, mat4(W[0] + s * ox, W[1] - (th ? 0.03 : 0.085), W[2] + oz, th ? 0.3 : 0.05 + (i - 1.5) * 0.04, ry, s * (th ? -0.25 : 0.04))]);
    }
  }
  return mergeParts('wmSkin', parts);
}
// 頭髮：厚厚的瀏海蓋到眉毛、兩邊垂到胸前、後面垂到腰（頭的座標：頭的中心是 0）
function wmHair() {
  const r = seeded(7272), S = [], v = new THREE.Vector3(), P = (x, y, k = 1.02) => { const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)); wmHeadPt(x, y, z, v, true); return [v.x * k, v.y * k, v.z * k]; };
  for (const [z0, k] of [[0.55, 1.04], [0.45, 1.07]]) for (let x = -0.55; x <= 0.551; x += 0.05) {   // 瀏海
    const j = r(), a = P(x * 0.7, 0.8, k), b = P(x * 0.95, 0.55, k + 0.04), cEnd = P(x, 0.3 - j * 0.05, k + 0.05);
    S.push({ a, b, c: cEnd, w: 0.035, f: 0, ph: x * 9 + j, tp: 0.35 });
  }
  const surf = (ang, lat, k) => { wmHeadPt(Math.sin(ang) * Math.cos(lat), Math.sin(lat), Math.cos(ang) * Math.cos(lat), v, true); return [v.x * k, v.y * k, v.z * k]; };
  for (const s of [-1, 1]) for (let k = 0; k < 12; k++) {   // 兩邊：從頭頂沿著頭往下蓋住耳朵和臉的兩邊，再直直地垂到胸前
    const j = r(), ang = s * (0.78 + k * 0.075), a = surf(ang, 0.85, 1.0), b = surf(ang, 0.15, 1.1 + k * 0.006);
    S.push({ a, b, c: [b[0] * 1.04 + s * j * 0.01, -0.2, b[2] * 0.95], d: [b[0] * 1.08 + s * j * 0.025, -0.44 - j * 0.08, b[2] * 0.85 - 0.015], w: 0.045, f: ang, ph: s * 2 + k, tp: 0.4 });
  }
  for (let k = 0; k < 26; k++) {   // 後面：從頭頂往後垂到腰
    const j = r(), ang = Math.PI + (k / 25 - 0.5) * 2.6, rx = Math.sin(ang), rz = Math.cos(ang);
    S.push({ a: [rx * 0.05, 0.14, rz * 0.05], b: [rx * (WM_HEAD.rx + 0.03), 0.02, rz * (WM_HEAD.rz + 0.04)], c: [rx * (WM_HEAD.rx + 0.06), -0.35, rz * (WM_HEAD.rz + 0.06)], d: [rx * (WM_HEAD.rx + 0.08) + (j - 0.5) * 0.04, -0.62 - j * 0.12, rz * (WM_HEAD.rz + 0.09) - 0.02], w: 0.06, f: ang, ph: k * 0.7, tp: 0.45 });
  }
  return S;
}
// 一顆會轉的眼睛（跟 crEye 一樣，crLook 可以用），眼球的格子粗一點（小小的眼睛不用那麼多三角形）
function w1Eye(parent, R, m) {
  const sock = new THREE.Group(); parent.add(sock);
  const gaze = new THREE.Group(); gaze.rotation.order = 'YXZ'; sock.add(gaze);
  gaze.add(new THREE.Mesh(geo('w1Ball' + R, () => new THREE.SphereGeometry(R, 18, 12)), m.ball));
  gaze.add(new THREE.Mesh(irisGeo('w1Iris' + R + ',' + (m.irisK || 0.42), R, R * (m.irisK || 0.42), 0), m.iris));
  return { sock, gaze, lid: null };
}
function buildWoman(r, g) {
  const T = { transparent: true };
  const head = withDetail(ownLM('#ffffff', { map: m5Tex('wmHead', 2048, 1024, wmPaintHead), shade: 0.75, ...T }), 'skin', 5, 0.8);
  head.map.wrapS = THREE.ClampToEdgeWrapping;
  const skin = withDetail(ownPhong('#cdc6be', { specular: 0x1e1c1a, shininess: 12, shade: 0.75, ...T }), 'skin', 6, 1.2);
  const dress = ownLM('#ffffff', { map: m5Tex('wmDress', 512, 512, wmPaintDress), alphaTest: 0.5, side: THREE.DoubleSide, shade: 0.8, ...T });
  dress.map.wrapT = THREE.ClampToEdgeWrapping;
  const eye = { ball: wetEyeMat(m5Tex('efSclera', 2048, 1024, efPaintSclera), 0x1a1212, 0x888888, T), iris: wetEyeMat(m5Tex('wmIris', 256, 256, wmPaintIris), 0x101010, 0xaaaaaa, T), irisK: 0.5 };   // 大大的螺旋眼珠
  const tooth = withDetail(ownPhong('#e2d8c2', { specular: 0x4a4436, shininess: 40, shade: 0.7, ...T }), 'bone', 10, 0.6);
  const hair = withDetail(hairMat(strandTex, 0.55), 'hair', 3, 0.9);
  r.hairU = hair.userData.hair;
  r.mats.push(head, skin, dress, eye.ball, eye.iris, tooth, hair);
  r.body = new THREE.Group(); g.add(r.body);
  r.body.add(new THREE.Mesh(loftGeo('wmDress', WM_DRESS, { seg: 24, sub: 2, uv: [0, 1, 0, 1] }), dress));
  r.body.add(new THREE.Mesh(wmSkinGeo(), skin));
  r.head = new THREE.Group(); r.head.position.y = WM_HEAD.y; r.body.add(r.head);
  r.head.add(new THREE.Mesh(wmHeadGeo(), head));
  r.crEyes = [];
  for (const E of wmEyes()) {
    const ey = w1Eye(r.head, WM_EYE.R, eye);
    ey.sock.position.copy(E.C); ey.sock.quaternion.setFromUnitVectors(Z_AXIS, E.F);
    ey.jig = 0.012; ey.lim = 0.5;
    r.crEyes.push(ey);
  }
  // 牙：上下兩排參差不齊（有的歪、有的短），沿著嘴的上緣和下緣排
  const parts = [], vv = new THREE.Vector3(), rr = seeded(5150), cyl = geo('wmTooth', () => new THREE.CylinderGeometry(0.75, 1, 1, 6, 1).translate(0, 0.5, 0));
  for (const upper of [true, false]) for (let i = 0; i < 12; i++) {
    const u = -0.86 + 1.72 * (i + 0.5) / 12 + (rr() - 0.5) * 0.03, X = u * (WM_M.hw - 0.03), Y = upper ? WM_M.top : WM_M.bot;
    wmHeadPt(X, Y, Math.sqrt(1 - X * X - Y * Y), vv, true);
    const L = (0.011 + rr() * 0.006) * (1 - 0.3 * Math.abs(u)), w = 0.0038 + rr() * 0.0008;
    parts.push([cyl, mat4(vv.x, vv.y + (upper ? 0.004 : -0.004), vv.z - 0.008, (upper ? 0.2 : -0.2) + (rr() - 0.5) * 0.2, 0, (upper ? Math.PI : 0) + (rr() - 0.5) * 0.25, w, L, w * 0.6)]);
  }
  r.head.add(new THREE.Mesh(mergeParts('wmTeeth', parts), tooth));
  r.head.add(new THREE.Mesh(hairGeo('wmHair', wmHair(), 9), hair));
}
function syncWoman(e, r, t, p, dt) {
  // 被看著時完全不動、頭歪一邊（頭髮也停住）；沒被看著時飄著、會抖
  const fh = floorH(e.x, e.y), jit = e.seen ? 0 : (Math.random() - 0.5) * 0.015;
  r.g.position.set(e.x + jit, fh + (e.seen ? 0.06 : 0.06 + Math.sin(e.wob * 1.6) * 0.05), e.y + jit);
  r.head.rotation.z = e.seen ? 0.22 : Math.sin(e.wob * 0.8) * 0.1;
  r.head.rotation.x = e.seen ? 0.06 : 0;
  const hu = r.hairU;
  if (!e.seen) { r.hairT = (r.hairT || 0) + dt; hu.uHT.value = r.hairT; }
  hu.uHAmp.value += ((e.seen ? 0 : 0.02) - hu.uHAmp.value) * Math.min(1, dt * 6);
  crLook(r, t, dt, p);
}
UPG.woman = { build: buildWoman, sync: syncWoman, view: { h: 1.9, d: 3.9, cy: 1.0 } };

// 看模型（?model=eye）和預先畫貼圖（bake5）時當成怪物蓋：裡面放一朵假的花
UPG.eye = {
  build(r, g) { r.f = { x: 0, y: 0, ptype: 'eye', grow: 1, burn: 0, alarm: 0 }; r.fr = buildEyeFlower(r.f, g); },
  sync(e, r, t, p) { r.f.x = e.x; r.f.y = e.y; r.g.rotation.y = 0; syncEyeFlower(r.f, r.fr, t, p, true); },
  view: { h: 1.65 },
  flower: { build: buildEyeFlower, sync: syncEyeFlower },
};

// ---------- 第一世界到這裡 ----------


// ---------- 第二世界重做的怪物（草叢人、大嘴觸角蟲、眼花女孩；向日葵眼、千眼菇） ----------

// ---------- 第二世界到這裡 ----------


// ---------- 第三世界重做的怪物（克羅諾斯・蕈裂、熔岩暴君、墮落戰神、檮杌・九瞳） ----------

// ---------- 第三世界到這裡 ----------


// ---------- 第四世界重做的怪物（葵氏奶昔、紅涎偽人、SCP-3008-2、Hubert、燼皇） ----------

// ---------- 第四世界到這裡 ----------


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
  if (UPG[e.kind]) UPG[e.kind].build(r, g);   // 照第五世界的做法重做過的
  else if (e.kind === 'woman') {
    // 深色長裙、蒼白細長的手、垂到背後的長髮、永遠面向你的臉
    const dress = new THREE.Mesh(geo('dress', () => new THREE.ConeGeometry(0.34, 1.32, 16, 1, true)), mat);
    dress.position.y = 0.72; g.add(dress);
    const skin = withDetail(ownBasic({ color: 0x6f6a66, transparent: true }), 'skin', 6, 1.3);
    for (const sd of [-1, 1]) {
      const arm = cyl(g, 0.02, 0.015, 0.82, sd * 0.2, 0.5, 0.06, skin, 6); arm.rotation.z = sd * 0.08;
      for (let k = -1; k <= 1; k++) cyl(g, 0.006, 0.004, 0.16, sd * 0.2 + k * 0.013, 0.35, 0.07, skin, 4);
    }
    const hairMat = withDetail(ownBasic({ map: hairTex, transparent: true, alphaTest: 0.35 }), 'hair', 2.5, 0.9);
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
    const fh = floorH(e.x, e.y);   // 在車頂上的怪物比較高
    r.g.position.set(e.x, fh + Math.sin(e.wob * 2) * 0.04, e.y);
    r.g.rotation.y = Math.atan2(p.x - e.x, p.y - e.y);
    for (const m of r.mats) m.opacity = a * (m === r.mat ? 0.94 : 1);
    const eo = a * (0.6 + 0.4 * Math.sin(e.wob * 5));
    for (const ey of r.eyes) ey.material.opacity = eo;
    r.wisps.forEach((w, i) => w.position.set(Math.sin(e.wob * 3 + i * 1.7) * 0.22, 0.25 + Math.abs(Math.sin(e.wob * 2 + i)) * 0.3, Math.cos(e.wob * 2.5 + i * 2.1) * 0.18));
    if (UPG[e.kind]) { const dt = clamp(t - (r.lastT ?? t), 0, 0.1); r.lastT = t; UPG[e.kind].sync(e, r, t, p, dt); }
    else if (e.kind === 'woman') {
      // 被看著時完全不動、頭歪一邊；沒被看著時飄著、會抖
      const jit = e.seen ? 0 : (Math.random() - 0.5) * 0.015;
      r.g.position.set(e.x + jit, fh + (e.seen ? 0.06 : 0.06 + Math.sin(e.wob * 1.6) * 0.05), e.y + jit);
      r.face.rotation.z = e.seen ? 0.22 : Math.sin(e.wob * 0.8) * 0.1;
    } else if (e.kind === 'blob') {
      const R = 0.4 * (e.size || 1), eating = e.eatT > 0;
      const hop = !eating && e.h < R + 0.05 ? Math.abs(Math.sin(e.wob * 6)) * 0.14 : 0;
      r.g.position.set(e.x, fh + e.h + hop, e.y);
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
    r.g.position.set(gh.x, floorH(gh.x, gh.y), gh.y);
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
      sp.set([f.x, f.h + floorH(f.x, f.y), f.y], ns * 3); sc.set([f.color[0] / 255, f.color[1] / 255, f.color[2] / 255], ns * 3); ns++;
    } else {
      if (ng >= PMAX) continue;
      gp.set([f.x, f.h + floorH(f.x, f.y), f.y], ng * 3); gc.set([f.color[0] / 255 * k, f.color[1] / 255 * k, f.color[2] / 255 * k], ng * 3); ng++;
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
    g.position.set(sh.x, sh.h + floorH(sh.x, sh.y), sh.y);
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
    r.g.position.set(b.x, b.h + 0.02 + floorH(b.x, b.y), b.y);
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
    g.position.set(e.x, barH(e) - 0.32 + floorH(e.x, e.y), e.y);
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
let bobPh = 0, bobAmt = 0, baseFov = 72, crouchK = 0;
// 手上拿著的蠟燭（物品列選中蠟燭時，左手拿著一根點著的蠟燭：銅燭台、白蠟、會晃的火焰和光暈）；寒寂之境時拿著它體溫掉得慢
function syncHandCandle(t) {
  const show = mode === 'play' && G && G.selId === 'candle' && G.inv.candle > 0 && !(isW4() && G.hand && G.hand.k !== 'item');
  if (!handCandle && !show) return;
  if (!handCandle) {
    handCandle = new THREE.Group(); camera.add(handCandle);
    handCandle.position.set(-0.19, -0.2, -0.42); handCandle.rotation.set(0.12, 0.25, 0.05);
    const skin = lm('#c99a7a'), brass = lm('#8a6a2a');
    sph(handCandle, 0.045, 0, -0.03, 0.01, skin, 1.1, 0.75, 1, 10);                        // 握著燭台的手
    for (let i = 0; i < 4; i++) sph(handCandle, 0.014, -0.03 + i * 0.02, -0.005, -0.035, skin, 1, 1, 1, 6);   // 手指
    cyl(handCandle, 0.05, 0.035, 0.012, 0, 0.0, 0, brass, 14);                            // 燭台的盤子
    cyl(handCandle, 0.016, 0.016, 0.13, 0, 0.012, 0, lm('#efe6cf'), 10);                 // 白蠟燭
    sph(handCandle, 0.006, 0.012, 0.13, 0.01, lm('#f4ecd8'), 1, 2.2, 1, 5);               // 流下來的蠟
    cyl(handCandle, 0.0018, 0.0018, 0.014, 0, 0.142, 0, lm('#1a1410'), 4);                // 燭芯
    const flame = new THREE.Mesh(geo('handFlame', () => new THREE.ConeGeometry(0.011, 0.04, 8)), ownBasic({ color: 0xffc860, fog: false }));
    flame.position.set(0, 0.172, 0); handCandle.add(flame); handCandle.userData.flame = flame;
    const glow = ownSprite(glowTex, 0xffa040); glow.position.set(0, 0.17, 0); glow.scale.setScalar(0.16); handCandle.add(glow); handCandle.userData.glow = glow;
  }
  handCandle.visible = show;
  if (!show) return;
  const { flame, glow } = handCandle.userData;
  flame.scale.set(1, 0.85 + 0.3 * Math.abs(Math.sin(t * 13)) * Math.abs(Math.sin(t * 5.3)), 1);
  flame.rotation.z = Math.sin(t * 3.1) * 0.12;
  glow.material.opacity = 0.55 + 0.25 * Math.sin(t * 9);
  handCandle.position.y = -0.2 + Math.abs(Math.sin(bobPh * 0.5)) * 0.008 * bobAmt;
}
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
    x = c.x; z = c.y; y = EYE + (c.h || 0) + floorH(c.x, c.y) + Math.sin(t * 2.2) * 0.01; face = c.face; pitch = c.pitch;
  } else {
    const p = G.p;
    const moving = (p.moved || 0) > 0.001 && !p.air;
    bobPh += moving ? (p.moved || 0) * 6.5 : 0;
    bobAmt += ((moving ? 1 : 0) - bobAmt) * Math.min(1, dt * 8);
    crouchK += ((isW4() && p.crouch ? 1 : 0) - crouchK) * Math.min(1, dt * 10);   // 第四世界可以蹲下
    poseDrop += ((p.camDrop || 0) - poseDrop) * Math.min(1, dt * 8);             // 坐下、躺下：鏡頭慢慢降下去
    x = p.x; z = p.y; y = EYE + (p.z || 0) + floorH(p.x, p.y) + Math.sin(bobPh) * 0.035 * bobAmt - crouchK * 0.6 - poseDrop;   // 車頂比較高；站在家具上 p.z 就是家具的高度
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
  syncHandCandle(t);
  const on = mode !== 'title' && mode !== 'cutscene' && flashOn();
  let k = on ? 1 : 0;
  if (on && G.p.bat < 15 && Math.random() < 0.15) k = 0.3;
  // 手電筒等級：稀有更亮、巨光更亮更寬；第四世界的 4～7 級有自己的顏色，而且會在幾個顏色之間慢慢變（星辰是黑白交替，光裡有星星）
  const lv = mode === 'title' ? 1 : clamp(G.p.flashLv || 1, 1, FLASH_MAX);
  const ft = FLASH_TIERS[lv];
  spot.intensity = 3.2 * k * [1, 1, 1.3, 1.6, 1.8, 2.0, 2.4, 2.2][lv];
  spot.distance = flRange() + 1.5;
  spot.angle = flHalf() * 1.1;
  strongRing.visible = lv >= 2;
  if (lv >= 2) strongRing.material.color.set(ft.color);
  if (ft.beam) {
    const B = ft.beam, ph = (t * (ft.stars ? 0.5 : 0.35)) % B.length, i0 = Math.floor(ph), u = ph - i0, a = B[i0], b = B[(i0 + 1) % B.length];
    const e = u * u * (3 - 2 * u);
    spot.color.setRGB((a[0] + (b[0] - a[0]) * e) / 255, (a[1] + (b[1] - a[1]) * e) / 255, (a[2] + (b[2] - a[2]) * e) / 255, SRGB);
    if (ft.stars) spot.intensity *= 0.75 + 0.25 * Math.sin(t * 9) * Math.sin(t * 5.3);
    lensMat.color.copy(on ? spot.color : tmpC.set(0x333333));
  } else {
    spot.color.set(0xfff0d8);
    lensMat.color.set(on ? (lv === 3 ? 0xfff2c0 : 0xfff6dd) : 0x333333);
  }
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
  placeGhost.position.set(tt.x + 0.5, floorH(tt.x + 0.5, tt.y + 0.5) + (it.lamp === 'chand' ? 2.3 : h / 2), tt.y + 0.5);
}

// ====================================================================
// 朋友（跟朋友一起玩，js/net.js）：寫實的人（不要可愛風），每個朋友一個顏色的 T 恤，配牛仔褲、球鞋，頭上寫名字。
// 身體是一圈一圈的斷面放樣出來的（loftGeo）：肩膀、胸、腰、臀有真人的形狀，上臂有三角肌和二頭肌、大腿比小腿粗；
// 衣服的縫線、羅紋領口、下擺、皺褶和牛仔褲的口袋、鉚釘、刷白都畫在每個朋友自己的貼圖上；手有手掌和五根手指（右手握著手電筒）、
// 球鞋有鞋底、鞋帶、鞋舌。頭借用第三世界乘客的寫實頭（畫布畫的臉、立體的鼻子和耳朵，活人的膚色、睜著眼），脖子和頭髮自己做。
// 關節：走路兩腳一前一後、膝蓋會彎、手臂反著擺；頭先轉向看的方向（最多 65°），身體慢慢跟上；蹲下、坐下、躺下、倒下各有姿勢。
// 開手電筒時右手舉起來照著看的方向，有一道淡淡的光束，照到的地方光照貼圖也會亮一圈。
// 每一節（腰、上半身、頭、上臂、前臂、大腿、小腿、腳）的零件照材質合成一、兩個網格，一個朋友大約 18 個網格。
// 位置由 net.js 平滑內插過；只畫同一個世界的朋友；小地圖不畫（第四世界要吹口哨才看得到藍點）
// ====================================================================
const FRIEND_HIP = 0.94, FRIEND_PANTS = ['#2f3b52', '#3b3631', '#272b31', '#4a5262'];
// 球鞋：鞋面、鞋帶、鞋底、後跟的小布標
const FRIEND_SHOES = [['#e4e1da', '#f3f0ea', '#ece8e0', '#3a3a40'], ['#29292d', '#dcdad4', '#ece8e0', '#8a2a2a'], ['#5d626b', '#e6e4de', '#e8e4dc', '#26262a'], ['#6b4c36', '#d8cfc0', '#d6c6a6', '#2a2018']];
const friendMap = new Map(), friendLights = [];
const _fv = new THREE.Vector3(), _fv2 = new THREE.Vector3();
let friendBeamTex = null;
// 長相（膚色、髮色、褲子、球鞋）：照名字固定，同一個朋友每次都一樣；男生短髮、女生鮑伯頭
function friendSpec(f) {
  const h = hash4(f.name + '|' + f.look), girl = f.look === 'f';
  const skin = PAX_SKIN[h % PAX_SKIN.length];
  const hair = (girl ? ['#15110e', '#2b1d14', '#4a3020', '#6b3a22'] : ['#15110e', '#2b1d14', '#3a2616', '#1c1612'])[(h >>> 4) & 3];
  return { kind: 'friend', sex: girl ? 'f' : 'm', build: girl ? 'f' : 'm', age: 0.1, sc: girl ? 0.95 : 1, skin, deadSkin: skin, hair, style: girl ? 'bob' : 'short', hat: null, pose: 'still',
    iris: ['#2a1a10', '#3a2414', '#4a3018'][(h >>> 7) % 3], brow: mixHex(hair, '#000000', 0.1), lips: mixHex(skin, girl ? '#b0505a' : '#8a4a44', girl ? 0.45 : 0.35),
    hd: PAX_HEADS[girl ? 'f' : 'm'], pants: FRIEND_PANTS[(h >>> 9) & 3], shoe: FRIEND_SHOES[(h >>> 11) & 3] };
}

// ---------- 放樣：一圈一圈的斷面連成平滑的身體、手腳 ----------
// 每一圈 ring：y 高度；x、z 中心；xn／xp 往 -x、+x 的半寬（w 兩邊一樣）；f／b 往前（+z）、往後的深度（d 一樣）；
// p 方圓（1 是橢圓，越小越方）；ty 正前方比正後方低多少（領口）；s 對應 o.bumps 每個鼓包的高度；wv 布料直向的波浪（垂下來的皺褶）；n 名字（畫貼圖用）
// o：seg 一圈幾個點、sub 每兩圈中間平滑地插幾圈、capA／capB 頭尾收成圓頂的高度、bumps 鼓包（a 角度：0 正前方、往 +x 是正的；w 寬度；sym 左右對稱）、
//    uv [u0, u1, t0, t1]（貼圖範圍；t 是畫布從上往下的比例，第一圈在 t0、最後一圈在 t1）、flipU 貼圖左右翻（右手、右腳）。
// 貼圖的 u 繞一圈：0 和 1 是正後方、0.5 是正前方、0.75 是 +x 那一側。geometry.userData.at：有名字的圈在畫布上的高度（比例）
const angD = (a, b) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
function loftBuild(rings, o = {}) {
  const N = o.seg || 24, sub = o.sub || 3, bumps = o.bumps || [], [u0, u1, t0, t1] = o.uv || [0, 1, 0, 1];
  const F = ['y', 'x', 'z', 'xn', 'xp', 'f', 'b', 'p', 'ty', 'wv'];
  const K = rings.map(r => ({ y: r.y, x: r.x || 0, z: r.z || 0, xn: r.xn ?? r.w, xp: r.xp ?? r.w, f: r.f ?? r.d, b: r.b ?? r.d, p: r.p || 1, ty: r.ty || 0, wv: r.wv || 0, s: bumps.map((_, i) => (r.s && r.s[i]) || 0), n: r.n }));
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  let rs = [];
  K.forEach((B, i) => {
    rs.push(B);
    if (i === K.length - 1) return;
    const A = K[Math.max(0, i - 1)], C = K[i + 1], D = K[Math.min(K.length - 1, i + 2)];
    for (let j = 1; j < sub; j++) {
      const t = j / sub, r = { s: B.s.map((_, q) => cr(A.s[q], B.s[q], C.s[q], D.s[q], t)) };
      for (const k of F) r[k] = cr(A[k], B[k], C[k], D[k], t);
      rs.push(r);
    }
  });
  // 收成圓頂：斷面照四分之一圓縮到一個點
  const cap = (e, h, dir) => Array.from({ length: 4 }, (_, j) => {
    const a = (j + 1) / 4 * Math.PI / 2, k = j === 3 ? 0 : Math.cos(a);
    return { ...e, n: undefined, y: e.y + dir * Math.sin(a) * h, xn: e.xn * k, xp: e.xp * k, f: e.f * k, b: e.b * k, wv: e.wv * k, s: e.s.map(v => v * k) };
  });
  if (o.capA) rs = [...cap(rs[0], o.capA, Math.sign(rs[0].y - rs[1].y)).reverse(), ...rs];
  if (o.capB) rs = [...rs, ...cap(rs[rs.length - 1], o.capB, Math.sign(rs[rs.length - 1].y - rs[rs.length - 2].y))];
  const R = rs.length, C1 = N + 1, pos = new Float32Array(R * C1 * 3), uv = new Float32Array(R * C1 * 2);
  for (let i = 0; i < R; i++) {
    const r = rs[i];
    for (let j = 0; j <= N; j++) {
      const th = -Math.PI + 2 * Math.PI * (j % N) / N, sx = Math.sin(th), cz = Math.cos(th);
      let X = Math.sign(sx) * Math.abs(sx) ** r.p * (sx < 0 ? r.xn : r.xp), Z = Math.sign(cz) * Math.abs(cz) ** r.p * (cz > 0 ? r.f : r.b);
      let add = r.wv * (Math.sin(th * 9 + 0.7) + 0.5 * Math.sin(th * 14 + 2.1));
      bumps.forEach((bp, q) => { if (r.s[q]) for (const a of bp.sym ? [bp.a, -bp.a] : [bp.a]) add += r.s[q] * Math.exp(-((angD(th, a) / bp.w) ** 2)); });
      if (add) { const l = Math.hypot(X, Z) || 1; X += X / l * add; Z += Z / l * add; }
      const k = (i * C1 + j) * 3;
      pos[k] = r.x + X; pos[k + 1] = r.y + r.ty * cz; pos[k + 2] = r.z + Z;
    }
  }
  // 貼圖的 t 照沿著身體的長度分配（領口捲起來的那幾圈也有位置畫）
  const cum = [0];
  for (let i = 1; i < R; i++) {
    let s = 0;
    for (const j of [0, N >> 2, N >> 1, (3 * N) >> 2]) { const a = ((i - 1) * C1 + j) * 3, b = (i * C1 + j) * 3; s += Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]); }
    cum.push(cum[i - 1] + s / 4);
  }
  const tot = cum[R - 1] || 1, tOf = i => t0 + (t1 - t0) * cum[i] / tot, at = { first: t0, last: t1 };
  rs.forEach((r, i) => { if (r.n) at[r.n] = tOf(i); });
  for (let i = 0; i < R; i++) for (let j = 0; j <= N; j++) { const k = (i * C1 + j) * 2, u = j / N; uv[k] = u0 + (u1 - u0) * (o.flipU ? 1 - u : u); uv[k + 1] = 1 - tOf(i); }
  const idx = [];
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < N; j++) { const a = i * C1 + j, b = a + 1, c = a + C1, d = c + 1; idx.push(a, c, b, b, c, d); }
  // 三角形的方向：中間那一圈的面要朝外，不是的話全部翻過來
  const mi = R >> 1, ctr = rs[mi], va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  let out = 0;
  for (let j = 0; j < N; j++) {
    const a = mi * C1 + j;
    va.fromArray(pos, a * 3); vb.fromArray(pos, (a + 1) * 3).sub(va); vc.fromArray(pos, (a + C1) * 3).sub(va);
    out += vc.cross(vb).dot(_fv.set(va.x - ctr.x, 0, va.z - ctr.z));
  }
  if (out < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  fixSeam(g, N, R);
  g.userData.at = at;
  return g;
}
const loftGeo = (key, rings, o) => geo(key, () => loftBuild(rings, o));
// 一圈一圈排的網格（放樣、球）：接縫兩邊的法線取平均（不然看得到一條線），縮成一點的那圈（圓頂、頭頂）全部朝同一個方向
function fixSeam(g, N, R) {
  const Nm = g.attributes.normal, P = g.attributes.position, C1 = N + 1, v = new THREE.Vector3();
  for (let i = 0; i < R; i++) {
    const a = i * C1, b = a + N;
    if (Math.abs(P.getX(a) - P.getX(a + (N >> 1))) + Math.abs(P.getZ(a) - P.getZ(a + (N >> 1))) < 1e-7) {
      v.set(0, 0, 0);
      for (let j = 0; j <= N; j++) v.x += Nm.getX(a + j), v.y += Nm.getY(a + j), v.z += Nm.getZ(a + j);
      v.normalize();
      for (let j = 0; j <= N; j++) Nm.setXYZ(a + j, v.x, v.y, v.z);
    } else {
      v.set(Nm.getX(a) + Nm.getX(b), Nm.getY(a) + Nm.getY(b), Nm.getZ(a) + Nm.getZ(b)).normalize();
      Nm.setXYZ(a, v.x, v.y, v.z); Nm.setXYZ(b, v.x, v.y, v.z);
    }
  }
  Nm.needsUpdate = true;
}
// 左右翻：s = 1 照寫的（+x 是外側），-1 換成右邊的（xn、xp 對調，x 變號）
const frSide = (s, rings, k = 1) => rings.map(r => {
  const xn = (r.xn ?? r.w) * k, xp = (r.xp ?? r.w) * k;
  return { ...r, x: (r.x || 0) * k * s, z: (r.z || 0) * k, xn: s > 0 ? xn : xp, xp: s > 0 ? xp : xn, f: (r.f ?? r.d) * k, b: (r.b ?? r.d) * k };
});
// 沿著幾個點掃出來的管子（手指、拇指）：點會連成平滑的曲線，rs 是每個點的半徑（中間照比例內插）
function tubeGeo(key, pts, rs, seg = 7, n = 10) {
  return geo(key, () => {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const g = new THREE.TubeGeometry(curve, n, 1, seg, false), P = g.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const u = i / n, x = u * (rs.length - 1), q = Math.min(rs.length - 2, Math.floor(x)), r = rs[q] + (rs[q + 1] - rs[q]) * (x - q);
      curve.getPointAt(u, c);
      for (let j = 0; j <= seg; j++) { const k = i * (seg + 1) + j; v.fromBufferAttribute(P, k).sub(c).multiplyScalar(r).add(c); P.setXYZ(k, v.x, v.y, v.z); }
    }
    return g;
  });
}

// ---------- 身體的尺寸和形狀 ----------
// 公尺（男生 sc 1 大約 172 公分、女生再乘 0.95）：肩關節、脖子底、髖關節的位置，上臂、前臂的長度；k 手的大小、ar 手臂粗細
const FR_DIM = {
  m: { shX: 0.188, shY: 0.442, nkY: 0.535, hipX: 0.09, ua: 0.285, fa: 0.235, k: 1, ar: 1 },
  f: { shX: 0.166, shY: 0.43, nkY: 0.52, hipX: 0.092, ua: 0.272, fa: 0.225, k: 0.9, ar: 0.86 },
};
// 貼圖的位置：T 恤（256×256）上面是身體、下面是袖子；牛仔褲（256×512）從上到下是腰、大腿、小腿
const FR_UV = { torso: [0, 1, 0.74, 0.004], sleeve: [0, 1, 0.77, 0.996], pelvis: [0, 1, 0.3, 0.004], thigh: [0, 1, 0.31, 0.655], shin: [0, 1, 0.665, 0.996] };
function friendGeos(sex) {
  const girl = sex === 'f', D = FR_DIM[sex], key = 'fr' + sex, out = { sleeve: {}, upper: {}, fore: {}, thigh: {}, shin: {} };
  // T 恤的上半身：下擺（蓋住褲頭，鬆鬆的有波浪）→ 腰 → 胸 → 腋下 → 肩膀斜下來 → 羅紋圓領（前面比後面低，捲一圈收進去）
  out.torso = loftGeo(key + 'Torso', girl ? [
    { y: -0.045, w: 0.188, f: 0.114, b: 0.134, z: -0.006, wv: 0.0035, n: 'hem' },
    { y: -0.025, w: 0.183, f: 0.111, b: 0.128, z: -0.006, wv: 0.003 },
    { y: 0.04, w: 0.163, f: 0.103, b: 0.111, z: -0.004, wv: 0.0018 },
    { y: 0.12, w: 0.139, f: 0.096, b: 0.095, z: -0.002, n: 'waist' },
    { y: 0.2, w: 0.143, f: 0.099, b: 0.095 },
    { y: 0.26, w: 0.148, f: 0.103, b: 0.097, z: 0.002, s: [0.012, 0] },
    { y: 0.31, w: 0.152, f: 0.106, b: 0.1, z: 0.004, s: [0.029, 0.003], n: 'chest' },
    { y: 0.36, w: 0.149, f: 0.103, b: 0.103, z: 0.004, s: [0.021, 0.006], n: 'pit' },
    { y: 0.41, w: 0.152, f: 0.092, b: 0.098, p: 0.84, s: [0.005, 0.006] },
    { y: 0.43, w: 0.152, f: 0.084, b: 0.09, z: -0.004, p: 0.78 },
    { y: 0.456, w: 0.146, f: 0.07, b: 0.078, z: -0.006, p: 0.74, ty: -0.006 },
    { y: 0.481, w: 0.12, f: 0.06, b: 0.068, z: -0.006, p: 0.78, ty: -0.01 },
    { y: 0.498, w: 0.094, f: 0.056, b: 0.063, z: -0.006, p: 0.82, ty: -0.013 },
    { y: 0.512, w: 0.076, f: 0.053, b: 0.058, z: -0.005, ty: -0.017 },
    { y: 0.52, w: 0.064, f: 0.054, b: 0.055, z: -0.004, ty: -0.021, n: 'collar' },
    { y: 0.527, w: 0.059, f: 0.05, b: 0.051, z: -0.004, ty: -0.021 },
    { y: 0.52, w: 0.053, f: 0.045, b: 0.046, z: -0.004, ty: -0.021, n: 'top' },
  ] : [
    { y: -0.04, w: 0.18, f: 0.12, b: 0.132, z: -0.005, wv: 0.004, n: 'hem' },
    { y: -0.02, w: 0.177, f: 0.118, b: 0.127, z: -0.005, wv: 0.003 },
    { y: 0.05, w: 0.166, f: 0.113, b: 0.114, z: -0.003, wv: 0.002 },
    { y: 0.13, w: 0.157, f: 0.108, b: 0.104, n: 'waist' },
    { y: 0.22, w: 0.161, f: 0.115, b: 0.104, z: 0.002 },
    { y: 0.31, w: 0.166, f: 0.122, b: 0.107, z: 0.004, s: [0.006, 0.004], n: 'chest' },
    { y: 0.385, w: 0.16, f: 0.116, b: 0.112, z: 0.002, s: [0.004, 0.008], n: 'pit' },
    { y: 0.435, w: 0.174, f: 0.1, b: 0.106, z: -0.003, p: 0.8, s: [0, 0.006] },
    { y: 0.467, w: 0.17, f: 0.083, b: 0.091, z: -0.007, p: 0.72, ty: -0.006 },
    { y: 0.494, w: 0.14, f: 0.069, b: 0.079, z: -0.008, p: 0.76, ty: -0.01 },
    { y: 0.512, w: 0.11, f: 0.062, b: 0.072, z: -0.008, p: 0.8, ty: -0.014 },
    { y: 0.526, w: 0.084, f: 0.059, b: 0.066, z: -0.006, ty: -0.018 },
    { y: 0.533, w: 0.071, f: 0.06, b: 0.061, z: -0.004, ty: -0.023, n: 'collar' },
    { y: 0.54, w: 0.065, f: 0.056, b: 0.057, z: -0.004, ty: -0.023 },
    { y: 0.533, w: 0.059, f: 0.05, b: 0.051, z: -0.004, ty: -0.023, n: 'top' },
  ], { seg: 34, sub: 2, bumps: [{ a: 0.5, w: 0.36, sym: true }, { a: Math.PI - 0.6, w: 0.4, sym: true }], uv: FR_UV.torso });
  // 牛仔褲的腰和屁股：褲頭 → 臀部（後面兩塊鼓起來、中間一條凹）→ 胯下收成圓頂（大腿從兩邊接上）
  out.pelvis = loftGeo(key + 'Pelvis', girl ? [
    { y: -0.14, w: 0.13, f: 0.072, b: 0.092, z: -0.014, n: 'crotch' },
    { y: -0.11, w: 0.17, f: 0.088, b: 0.112, z: -0.014, s: [0.016, -0.009] },
    { y: -0.07, w: 0.183, f: 0.096, b: 0.116, z: -0.012, s: [0.021, -0.011], n: 'seat' },
    { y: -0.03, w: 0.181, f: 0.098, b: 0.113, z: -0.01, s: [0.009, -0.007], n: 'hip' },
    { y: 0.012, w: 0.162, f: 0.096, b: 0.103, z: -0.008, s: [0.003, -0.003], n: 'wbBot' },
    { y: 0.045, w: 0.146, f: 0.093, b: 0.095, z: -0.006, n: 'wbTop' },
    { y: 0.07, w: 0.136, f: 0.088, b: 0.088, z: -0.004 },
  ] : [
    { y: -0.14, w: 0.122, f: 0.07, b: 0.086, z: -0.012, n: 'crotch' },
    { y: -0.11, w: 0.158, f: 0.088, b: 0.106, z: -0.012, s: [0.012, -0.008] },
    { y: -0.07, w: 0.17, f: 0.096, b: 0.111, z: -0.01, s: [0.015, -0.009], n: 'seat' },
    { y: -0.03, w: 0.171, f: 0.1, b: 0.11, z: -0.008, s: [0.006, -0.006], n: 'hip' },
    { y: 0.012, w: 0.165, f: 0.102, b: 0.105, z: -0.006, s: [0.002, -0.003], n: 'wbBot' },
    { y: 0.045, w: 0.158, f: 0.102, b: 0.101, z: -0.004, n: 'wbTop' },
    { y: 0.07, w: 0.15, f: 0.097, b: 0.096, z: -0.004 },
  ], { seg: 30, sub: 2, capA: 0.032, bumps: [{ a: Math.PI - 0.5, w: 0.42, sym: true }, { a: Math.PI, w: 0.12 }], uv: FR_UV.pelvis });
  const ar = D.ar, lr = girl ? 0.95 : 1;
  for (const s of [-1, 1]) {
    // 袖子：上面是三角肌（圓圓的、往外鼓，頂端往脖子那邊斜上去，接上肩膀的斜度），袖口比手臂寬，反摺的邊往內收
    out.sleeve[s] = loftGeo(`${key}Slv${s}`, frSide(s, [
      { y: 0.037, w: 0, d: 0, x: -0.03 },
      { y: 0.033, xn: 0.026, xp: 0.021, f: 0.027, b: 0.029, x: -0.025 },
      { y: 0.024, xn: 0.04, xp: 0.041, f: 0.044, b: 0.046, x: -0.014 },
      { y: 0.012, xn: 0.045, xp: 0.052, f: 0.05, b: 0.052, x: -0.005 },
      { y: 0, xn: 0.046, xp: 0.055, f: 0.052, b: 0.054, n: 'seam' },
      { y: -0.05, xn: 0.046, xp: 0.053, f: 0.051, b: 0.052 },
      { y: -0.1, xn: 0.047, xp: 0.051, f: 0.05, b: 0.051, wv: 0.0015 },
      { y: girl ? -0.128 : -0.145, xn: 0.048, xp: 0.051, f: 0.05, b: 0.051, wv: 0.002, n: 'hem' },
      { y: girl ? -0.131 : -0.148, xn: 0.042, xp: 0.045, f: 0.044, b: 0.045, n: 'lip' },
    ], ar), { seg: 18, sub: 2, uv: FR_UV.sleeve, flipU: s < 0 });
    // 上臂（袖子底下）：前面二頭肌、後面三頭肌，到手肘收成圓的
    out.upper[s] = loftGeo(`${key}Ua${s}`, frSide(s, [
      { y: -0.1, xn: 0.043, xp: 0.045, f: 0.045, b: 0.047 },
      { y: -0.16, xn: 0.041, xp: 0.043, f: 0.046, b: 0.045 },
      { y: -0.215, xn: 0.038, xp: 0.039, f: 0.04, b: 0.041 },
      { y: -D.ua + 0.03, xn: 0.035, xp: 0.037, f: 0.034, b: 0.037 },
      { y: -D.ua, xn: 0.034, xp: 0.036, f: 0.032, b: 0.036 },
    ], ar), { seg: 14, sub: 2, capB: 0.034 * ar });
    // 前臂：手肘下面的肌肉比較粗，到手腕變扁（手掌那個方向寬）
    out.fore[s] = loftGeo(`${key}Fa${s}`, frSide(s, [
      { y: 0, xn: 0.034, xp: 0.037, f: 0.034, b: 0.037 },
      { y: -0.045, xn: 0.035, xp: 0.04, f: 0.037, b: 0.036 },
      { y: -0.1, xn: 0.031, xp: 0.035, f: 0.032, b: 0.031 },
      { y: -0.165, xn: 0.024, xp: 0.026, f: 0.028, b: 0.026 },
      { y: -D.fa + 0.02, xn: 0.019, xp: 0.02, f: 0.027, b: 0.025 },
      { y: -D.fa, xn: 0.018, xp: 0.019, f: 0.026, b: 0.024 },
    ], ar), { seg: 14, sub: 2, capA: 0.033 * ar });
    // 大腿（牛仔褲）：上面粗、外側有一點臀部的弧度，往膝蓋慢慢變細、稍微往內
    out.thigh[s] = loftGeo(`${key}Th${s}`, frSide(s, girl ? [
      { y: 0, xn: 0.072, xp: 0.097, f: 0.088, b: 0.096, z: -0.008, n: 'top' },
      { y: -0.08, xn: 0.07, xp: 0.09, f: 0.087, b: 0.09, z: -0.004 },
      { y: -0.18, xn: 0.062, xp: 0.076, f: 0.079, b: 0.076, z: 0.002, x: -0.002 },
      { y: -0.28, xn: 0.055, xp: 0.064, f: 0.068, b: 0.064, z: 0.004, x: -0.004 },
      { y: -0.37, xn: 0.051, xp: 0.055, f: 0.058, b: 0.056, z: 0.002, x: -0.005 },
      { y: -0.43, xn: 0.051, xp: 0.053, f: 0.056, b: 0.054, x: -0.006, n: 'knee' },
    ] : [
      { y: 0, xn: 0.074, xp: 0.093, f: 0.088, b: 0.094, z: -0.006, n: 'top' },
      { y: -0.08, xn: 0.071, xp: 0.088, f: 0.088, b: 0.088, z: -0.002 },
      { y: -0.18, xn: 0.065, xp: 0.078, f: 0.082, b: 0.078, z: 0.003, x: -0.002 },
      { y: -0.28, xn: 0.059, xp: 0.068, f: 0.072, b: 0.068, z: 0.004, x: -0.004 },
      { y: -0.37, xn: 0.055, xp: 0.06, f: 0.062, b: 0.06, z: 0.002, x: -0.005 },
      { y: -0.43, xn: 0.055, xp: 0.057, f: 0.06, b: 0.058, x: -0.006, n: 'knee' },
    ]), { seg: 20, sub: 2, capA: 0.06, capB: 0.045, uv: FR_UV.thigh, flipU: s < 0 });
    // 小腿（牛仔褲）：後面有一點小腿肚，褲管直直的，到腳踝堆起來、褲腳蓋在球鞋上
    out.shin[s] = loftGeo(`${key}Sh${s}`, frSide(s, [
      { y: 0, xn: 0.055, xp: 0.057, f: 0.06, b: 0.058, n: 'top' },
      { y: -0.07, xn: 0.054, xp: 0.056, f: 0.056, b: 0.064, z: -0.002 },
      { y: -0.15, xn: 0.053, xp: 0.055, f: 0.054, b: 0.064, z: -0.004 },
      { y: -0.25, xn: 0.052, xp: 0.053, f: 0.053, b: 0.056, z: -0.002 },
      { y: -0.325, xn: 0.053, xp: 0.054, f: 0.055, b: 0.054, wv: 0.0022, n: 'stack' },
      { y: -0.368, xn: 0.056, xp: 0.057, f: 0.061, b: 0.056, z: 0.004, wv: 0.003, n: 'hem' },
      { y: -0.371, xn: 0.049, xp: 0.05, f: 0.054, b: 0.049, z: 0.004, n: 'lip' },
    ], lr), { seg: 18, sub: 2, capA: 0.05, uv: FR_UV.shin, flipU: s < 0 });
  }
  // 脖子：底下寬（藏在領口裡面），往上變細、稍微往前；男生有一點喉結
  const nk = girl ? 0.88 : 1;
  out.neck = loftGeo(key + 'Neck', [
    { y: -0.065, w: 0.066 * nk, f: 0.054 * nk, b: 0.064 * nk, z: -0.012 },
    { y: -0.02, w: 0.058 * nk, f: 0.052 * nk, b: 0.057 * nk, z: -0.006 },
    { y: 0.03, w: 0.05 * nk, f: 0.047 * nk, b: 0.05 * nk, z: 0.004, s: [girl ? 0 : 0.004] },
    { y: 0.08, w: 0.047 * nk, f: 0.045 * nk, b: 0.047 * nk, z: 0.012 },
    { y: 0.12, w: 0.045 * nk, f: 0.042 * nk, b: 0.045 * nk, z: 0.016 },
  ], { seg: 16, sub: 2, bumps: [{ a: 0, w: 0.3 }] });
  return out;
}

// ---------- 手：手掌、四根手指、拇指（在前臂的座標裡，手腕在 y = -fa）；s = 1 左手、-1 右手（手掌朝身體），grip 握拳（握著手電筒） ----------
const FR_FING = [[0.027, 0.07, 0.0092, 0.07], [0.009, 0.078, 0.0096, 0], [-0.009, 0.073, 0.009, -0.06], [-0.025, 0.058, 0.008, -0.14]];   // 食指到小指：位置 z、長度、粗細、張開的角度
function friendHand(q, D, s, grip, skin) {
  const k = D.k, w = -D.fa, yk = w - 0.075 * k, key = `frH${k}${s}${grip ? 'g' : 'r'}`, cup = grip ? -0.004 : 0;
  pmesh(q, loftGeo(key + 'p', frSide(s, [
    { y: w + 0.014, xn: 0.017, xp: 0.018, f: 0.026, b: 0.024 },
    { y: w - 0.018 * k, xn: 0.018, xp: 0.016, f: 0.033, b: 0.029, z: 0.003 },
    { y: w - 0.048 * k, xn: 0.016, xp: 0.014, f: 0.037, b: 0.033, z: 0.002, x: -0.002 + cup },
    { y: yk, xn: 0.013, xp: 0.012, f: 0.038, b: 0.035, x: -0.003 + cup },
  ].map(r => ({ ...r, xn: r.xn * k, xp: r.xp * k, f: r.f * k, b: r.b * k, z: (r.z || 0) * k, x: (r.x || 0) * k }))), { seg: 14, sub: 2, capB: 0.011 * k }), skin, 0, 0, 0);
  pel(q, -0.008 * k * s, w - 0.024 * k, 0.019 * k, 0.012 * k, 0.022 * k, 0.014 * k, skin, 10);   // 拇指根部的肉
  // 手指：三節，放鬆的時候微微彎向手心，握拳的時候整根捲起來
  const curl = grip ? [1.25, 1.5, 0.95] : [0.22, 0.38, 0.24], ph = [0.45, 0.3, 0.22];
  FR_FING.forEach(([z, L, rr, sp], i) => {
    let x = (-0.003 + cup) * k, y = yk + 0.014 * k, zz = z * k, a = 0;
    const pts = [[x * s, y, zz], [x * s, yk, zz]];
    y = yk;
    for (let j = 0; j < 3; j++) {
      a += curl[j];
      const l = ph[j] * L * k;
      x -= Math.sin(a) * l; y -= Math.cos(a) * Math.cos(sp) * l; zz += Math.cos(a) * Math.sin(sp) * l;
      pts.push([x * s, y, zz]);
    }
    pmesh(q, tubeGeo(`${key}f${i}`, pts, [1, 1, 0.95, 0.9, 0.82].map(v => v * rr * k), 6, 8), skin, 0, 0, 0);
    const tp = pts[4], tr = 0.82 * rr * k;
    pel(q, tp[0], tp[1], tp[2], tr, tr, tr, skin, 6);   // 指尖
  });
  // 拇指：放鬆的時候往前下方，握拳的時候扣在食指外面
  const th = (grip ? [[-0.004, 0, 0.016], [-0.014, -0.027, 0.04], [-0.03, -0.047, 0.04], [-0.043, -0.057, 0.027]] : [[-0.004, 0, 0.016], [-0.012, -0.03, 0.04], [-0.019, -0.054, 0.05], [-0.023, -0.074, 0.05]])
    .map(([x, y, z]) => [x * k * s, w + y * k, z * k]);
  pmesh(q, tubeGeo(key + 't', th, [0.0135, 0.0118, 0.0102, 0.0092].map(v => v * k), 7, 8), skin, 0, 0, 0);
  pel(q, th[3][0], th[3][1], th[3][2], 0.0088 * k, 0.0088 * k, 0.0088 * k, skin, 6);
}
// 手電筒（右手握著，順著前臂的方向）：握把、防滑紋、燈頭、亮亮的燈罩；回傳燈頭前面的位置
function friendFlashlight(q, D, s) {
  const k = D.k, yk = -D.fa - 0.075 * k, x = -0.026 * k * s, z = 0.008 * k;
  const body = pcol('#2b2b30'), dark = pcol('#18181a'), rim = pcol('#74757a'), lens = pcol('#f2ead2');
  cyl(q, 0.0155, 0.0155, 0.1, x, yk - 0.06, z, body, 12);              // 握把
  cyl(q, 0.016, 0.016, 0.008, x, yk + 0.04, z, dark, 12);              // 尾蓋
  for (let i = 0; i < 3; i++) cyl(q, 0.0162, 0.0162, 0.004, x, yk - 0.05 + i * 0.008, z, dark, 12);   // 防滑紋
  cyl(q, 0.0165, 0.021, 0.028, x, yk - 0.088, z, body, 14);            // 燈頭（往前變粗）
  cyl(q, 0.0215, 0.0215, 0.007, x, yk - 0.095, z, rim, 14);            // 金屬框
  cyl(q, 0.018, 0.018, 0.002, x, yk - 0.0965, z, lens, 14);            // 燈罩
  return [x, yk - 0.1, z];
}
// 球鞋（腳踝的座標，地板在 y = -0.085）：鞋底（白色的橡膠，腳尖翹一點）、鞋面、鞋舌、鞋帶和蝴蝶結、後跟的布標、襪子；s = 1 左腳、-1 右腳（大拇趾在內側）
const FR_FOOT = [[0, -0.079], [0.026, -0.071], [0.035, -0.045], [0.038, 0], [0.044, 0.06], [0.05, 0.11], [0.046, 0.155], [0.033, 0.188], [0.012, 0.205], [-0.012, 0.21], [-0.036, 0.195], [-0.049, 0.155], [-0.05, 0.11], [-0.04, 0.05], [-0.033, 0], [-0.032, -0.045], [-0.024, -0.071]];
const FR_UPPER = [   // 鞋面：z 從後跟到腳尖，xn 內側、xp 外側的半寬，h 鞋面的高度（鞋底上面），x 中心往內偏
  [-0.07, 0.024, 0.024, 0.05], [-0.056, 0.032, 0.033, 0.066], [-0.03, 0.036, 0.037, 0.074], [0, 0.036, 0.039, 0.077], [0.03, 0.037, 0.042, 0.072],
  [0.065, 0.041, 0.045, 0.058], [0.1, 0.045, 0.046, 0.046], [0.135, 0.046, 0.043, 0.038, -0.002], [0.165, 0.042, 0.034, 0.032, -0.004], [0.186, 0.033, 0.022, 0.026, -0.007], [0.197, 0.022, 0.013, 0.021, -0.009],
];
const frToe = z => 1.6 * Math.max(0, z - 0.11) ** 2;   // 腳尖翹起來的高度（z 是沒縮放的位置）
const frUpperY = k => -0.088 + 0.024 * k;              // 鞋面的底（鞋底上面一點點，k 是腳的大小）
const frUpperTop = (z, k) => {   // 鞋面頂端的高度（鞋帶放在這上面）
  let h = FR_UPPER[FR_UPPER.length - 1][3];
  for (let i = 1; i < FR_UPPER.length; i++) if (z <= FR_UPPER[i][0]) { const a = FR_UPPER[i - 1], b = FR_UPPER[i], t = clamp((z - a[0]) / (b[0] - a[0]), 0, 1); h = a[3] + (b[3] - a[3]) * t; break; }
  return frUpperY(k) + (h + frToe(z)) * k;
};
function friendShoe(q, s, k, cols) {
  const [upC, laceC, soleC, tabC] = cols, up = pcol(upC), sole = pcol(soleC), lace = pcol(laceC), tab = pcol(tabC);
  const key = `frShoe${k}${s}`;
  const lift = g => { const P = g.attributes.position; for (let i = 0; i < P.count; i++) P.setY(i, P.getY(i) + frToe(P.getZ(i) / k) * k); return g; };
  // 鞋底：腳的形狀擠出來，邊是圓的
  pmesh(q, geo(key + 'sole', () => {
    const pts = new THREE.CatmullRomCurve3(FR_FOOT.map(([x, z]) => new THREE.Vector3(x * s * k * 0.94, 0, z * k * 0.97 + 0.002)), true).getPoints(40);
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, -p.z))), { depth: 0.012 * k, bevelEnabled: true, bevelThickness: 0.006 * k, bevelSize: 0.0055 * k, bevelSegments: 2, curveSegments: 1 });
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox(); g.translate(0, -0.085 - g.boundingBox.min.y, 0);
    g.setIndex([...Array(g.attributes.position.count).keys()]);
    g.clearGroups();
    return lift(g);
  }), sole, 0, 0, 0);
  // 鞋面：沿著腳從後跟放樣到腳尖（放樣的 y 是 -z，再轉成躺平）
  pmesh(q, geo(key + 'up', () => {
    const g = loftBuild(frSide(s, FR_UPPER.map(([z, xn, xp, h, x]) => ({ y: -z * k, xn: xn * k, xp: xp * k, f: h * k, b: 0.006, z: frUpperY(k), x: (x || 0) * k, p: 0.78 }))), { seg: 16, sub: 2, capA: 0.012 * k, capB: 0.01 * k });
    g.rotateX(-Math.PI / 2);
    return lift(g);
  }), up, 0, 0, 0);
  // 鞋帶：五條橫過鞋舌（照鞋面的斜度），上面打一個蝴蝶結
  const zs = [0.026, 0.044, 0.062, 0.08, 0.098];
  for (const z of zs) {
    const y = frUpperTop(z, k) + 0.0015, sl = Math.atan2(frUpperTop(z - 0.01, k) - frUpperTop(z + 0.01, k), 0.02 * k);
    box(q, -0.017 * k, 0.017 * k, y - 0.002, y + 0.002, z * k - 0.0035, z * k + 0.0035, lace).rotation.x = sl;
  }
  const ty = frUpperTop(0.014, k);
  box(q, -0.016 * k, 0.016 * k, ty - 0.004, ty + 0.013, 0.004 * k, 0.016 * k, up).rotation.x = -0.25;   // 鞋舌
  for (const t of [-1, 1]) pel(q, t * 0.012 * k, ty + 0.004, 0.022 * k, 0.011 * k, 0.004, 0.006 * k, lace).rotation.z = t * 0.3;   // 蝴蝶結
  const hy = frUpperTop(-0.066, k);
  box(q, -0.007 * k, 0.007 * k, hy - 0.006, hy + 0.01, -0.074 * k, -0.066 * k, tab);   // 後跟的布標
  cyl(q, 0.033 * k, 0.035 * k, 0.07, 0, -0.03, -0.012 * k, pcol('#2b2b2e'), 10);   // 襪子（褲管和鞋口中間）
}

// ---------- 衣服的貼圖 ----------
// 在放樣的貼圖上畫：u 繞一圈（0.5 正前方、0 和 1 正後方、0.75 是左手左腳的外側；右邊的貼圖左右翻過，所以外側也是 0.75），t 從上往下（照 userData.at 的名字）
function frCanvas(c, W, H) {
  const path = pts => { c.beginPath(); pts.forEach(([u, t], i) => (i ? c.lineTo(u * W, t * H) : c.moveTo(u * W, t * H))); };
  const line = (pts, col, w, dash) => { c.save(); c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round'; if (dash) c.setLineDash(dash); path(pts); c.stroke(); c.restore(); };
  // 柔和的皺褶、刷白：先畫在另一張透明的圖層上，最後整張模糊一次再疊上去（每一筆都模糊的話很慢）
  let layer = null;
  const soft = (pts, col, w) => {
    if (!layer) { layer = document.createElement('canvas'); layer.width = W; layer.height = H; }
    const x = layer.getContext('2d'); x.strokeStyle = col; x.lineWidth = w; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); pts.forEach(([u, t], i) => (i ? x.lineTo(u * W, t * H) : x.moveTo(u * W, t * H))); x.stroke();
  };
  const flush = b => { if (!layer) return; c.save(); c.filter = `blur(${b}px)`; c.drawImage(layer, 0, 0); c.restore(); layer = null; };
  const glow = (u, t, ru, rt, col, a) => { c.save(); c.translate(u * W, t * H); c.scale(ru * W, rt * H); const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, rgbaOf(col, a)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 7); c.fill(); c.restore(); };
  const band = (t0, t1, col) => { c.fillStyle = col; c.fillRect(0, t0 * H, W, (t1 - t0) * H); };
  // 一條曲線上取幾個點（二次曲線）
  const quad = (a, b, d, n = 12) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n, m = 1 - t; return [m * m * a[0] + 2 * m * t * b[0] + t * t * d[0], m * m * a[1] + 2 * m * t * b[1] + t * t * d[1]]; });
  return { path, line, soft, flush, glow, band, quad };
}
// T 恤：針織的布紋、腋下往腰拉的斜皺褶、下擺上面堆起來的橫皺褶、肩膀到兩側的縫線、羅紋圓領、反摺的下擺和袖口
function paintFriendShirt(c, W, H, col, GM) {
  const { line, soft, flush, glow, band } = frCanvas(c, W, H), T = GM.torso.userData.at, S = GM.sleeve[1].userData.at, Dk = a => `rgba(0,0,0,${a})`, Lt = a => `rgba(255,255,255,${a})`;
  c.fillStyle = col; c.fillRect(0, 0, W, H);
  for (let y = 0; y < H; y += 2) { c.fillStyle = Dk(0.025 + rnd() * 0.02); c.fillRect(0, y, W, 1); }
  for (let i = 0; i < 1600; i++) { c.fillStyle = rnd() < 0.5 ? Lt(0.05) : Dk(0.06); c.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1); }
  // 身體：腋下往腰的斜皺褶（前後各兩條，旁邊一條亮的）
  for (const [ua, ub] of [[0.31, 0.43], [0.69, 0.57], [0.19, 0.08], [0.81, 0.92]]) {
    const pts = [[ua, T.pit], [(ua * 2 + ub) / 3 + 0.01 * Math.sign(ub - ua), (T.pit * 2 + T.waist) / 3], [ub, T.waist + (T.hem - T.waist) * 0.35]];
    soft(pts, Dk(0.15), 6);
    soft(pts.map(([u, t]) => [u + 0.014 * Math.sign(ub - ua), t - 0.01]), Lt(0.07), 4);
  }
  // 下擺上面堆起來的橫皺褶（彎彎的）
  for (let k = 0; k < 4; k++) {
    const t0 = T.waist + (T.hem - T.waist) * (0.32 + k * 0.17), ph = rnd() * 6, amp = 0.004 + rnd() * 0.004, pts = [];
    for (let u = 0; u <= 1.001; u += 0.02) pts.push([u, t0 + Math.sin(u * 18 + ph) * amp + Math.sin(u * 41 + ph * 2) * amp * 0.4]);
    soft(pts, Dk(0.06 + rnd() * 0.05), 3);
    soft(pts.map(([u, t]) => [u, t - 0.012]), Lt(0.05), 3);
  }
  // 袖子腋下那一側的斜皺褶
  for (let i = 0; i < 3; i++) { const t = S.seam + (S.hem - S.seam) * (0.15 + i * 0.22); soft([[0.12, t], [0.25, t + 0.025], [0.38, t + 0.01]], Dk(0.13), 4); }
  soft([[0.6, S.seam + 0.03], [0.95, S.seam + 0.05]], Dk(0.07), 4);
  flush(2.5);
  glow(0.5, T.chest + (T.waist - T.chest) * 0.35, 0.14, 0.05, '#000000', 0.08);   // 胸口底下的影子
  // 肩膀到兩側的縫線
  for (const u of [0.25, 0.75]) { line([[u, T.top], [u, T.hem]], Dk(0.3), 1); line([[u + 0.006, T.collar], [u + 0.006, T.hem]], Lt(0.08), 1); }
  // 羅紋圓領：顏色深一點、直的細條紋，下面一條縫線
  band(0, T.collar + 0.004, mixHex(col, '#000000', 0.12));
  for (let x = 0; x < W; x += 2) { c.fillStyle = Dk(0.13); c.fillRect(x, (T.top - 0.004) * H, 1, (T.collar - T.top + 0.008) * H); }
  line([[0, T.collar + 0.008], [1, T.collar + 0.008]], Dk(0.3), 1);
  line([[0, T.collar + 0.016], [1, T.collar + 0.016]], Dk(0.16), 1, [2, 1.5]);
  // 下擺：反摺的邊、兩條縫線、最下面摺起來的地方比較暗
  const hb = T.hem - 0.03;
  band(hb, T.hem + 0.01, Dk(0.05));
  line([[0, hb], [1, hb]], Dk(0.28), 1, [2, 1.5]); line([[0, hb + 0.007], [1, hb + 0.007]], Dk(0.2), 1, [2, 1.5]);
  band(T.hem - 0.004, T.hem + 0.01, Dk(0.1));
  // 袖子：接肩膀的縫線是斜的一圈：外側在三角肌上面、腋下那一側比較低
  const arm = Array.from({ length: 41 }, (_, i) => { const u = i / 40; return [u, S.seam - 0.01 + 0.022 * Math.cos(2 * Math.PI * (u - 0.25))]; });
  line(arm, Dk(0.22), 1);
  line(arm.map(([u, t]) => [u, t + 0.006]), Lt(0.06), 1);
  line([[0.25, S.seam], [0.25, S.hem]], Dk(0.25), 1);   // 腋下那一側的縫線
  const sb = S.hem - 0.035;
  band(sb, S.hem, Dk(0.03));
  line([[0, sb], [1, sb]], Dk(0.28), 1, [2, 1.5]); line([[0, sb + 0.008], [1, sb + 0.008]], Dk(0.2), 1, [2, 1.5]);
  band(S.hem - 0.004, S.last, Dk(0.08));
}
// 牛仔褲：斜紋布、竹節紗、刷白（大腿前面、膝蓋、屁股）、貓鬚、金黃色的縫線（雙線）、褲頭、皮帶和皮帶環、前口袋（鉚釘）、零錢袋、門襟的 J 字縫線、後面的育克和兩個後口袋、褲管堆起來的皺褶、褲腳
function paintFriendJeans(c, W, H, col, GM) {
  const { line, soft, flush, glow, band, quad } = frCanvas(c, W, H), P = GM.pelvis.userData.at, Q = GM.thigh[1].userData.at, R = GM.shin[1].userData.at;
  const thr = 'rgba(205,150,72,.8)', thr2 = 'rgba(205,150,72,.55)', Dk = a => `rgba(0,0,0,${a})`, Lt = a => `rgba(255,255,255,${a})`, dash = [2.5, 1.5];
  const stitch = (pts, w = 1) => line(pts, thr, w, dash);
  c.fillStyle = col; c.fillRect(0, 0, W, H);
  c.save(); c.lineWidth = 1;
  for (let x = -H; x < W; x += 2) { c.strokeStyle = (x & 2) ? Lt(0.05) : Dk(0.09); c.beginPath(); c.moveTo(x, 0); c.lineTo(x + H * 0.5, H); c.stroke(); }
  c.restore();
  for (let i = 0; i < 700; i++) { c.fillStyle = Lt(0.03 + rnd() * 0.05); c.fillRect(rnd() * W, rnd() * H, 1, 3 + rnd() * 10); }
  // 刷白：大腿前面、膝蓋、屁股
  glow(0.5, Q.top + (Q.knee - Q.top) * 0.45, 0.13, (Q.knee - Q.top) * 0.42, '#ffffff', 0.13);
  glow(0.5, R.top + 0.02, 0.12, 0.05, '#ffffff', 0.1);
  for (const u of [0.11, 0.89]) glow(u, P.seat, 0.09, (P.crotch - P.hip) * 0.6, '#ffffff', 0.08);
  // 貓鬚：胯下前面短短的白色橫紋
  for (let i = 0; i < 7; i++) {
    const t = P.crotch - (P.crotch - P.seat) * (0.1 + rnd() * 0.9), u0 = 0.04 + rnd() * 0.05;
    for (const sd of [-1, 1]) soft([[0.5 + sd * u0, t], [0.5 + sd * (u0 + 0.06 + rnd() * 0.05), t - 0.004 - rnd() * 0.006]], Lt(0.13), 1.6);
  }
  for (let i = 0; i < 5; i++) { const t = Q.top + rnd() * (Q.knee - Q.top) * 0.18, u = 0.36 + rnd() * 0.06; soft([[u, t], [u + 0.07 + rnd() * 0.04, t - 0.003]], Lt(0.11), 1.6); }
  // 膝蓋後面、褲管下面堆起來的皺褶
  for (let i = 0; i < 4; i++) { const t = Q.knee - 0.005 - i * 0.012; soft([[0.86, t], [0.95, t + 0.004], [1, t]], Dk(0.12), 2); soft([[0, t], [0.05, t + 0.004], [0.14, t]], Dk(0.12), 2); }
  for (let k = 0; k < 5; k++) {
    const t0 = R.stack + (R.hem - R.stack) * (k / 5) - 0.012, ph = rnd() * 6, pts = [];
    for (let u = 0; u <= 1.001; u += 0.02) pts.push([u, t0 + Math.sin(u * 13 + ph) * 0.006]);
    soft(pts, Dk(0.14), 2.5);
    soft(pts.map(([u, t]) => [u, t - 0.006]), Lt(0.07), 2);
  }
  flush(1.4);
  // 褲管：外側的縫線（單線＋布邊的深色線）、內側的縫線（雙線）
  for (const [t0, t1] of [[Q.first, Q.last], [R.first, R.hem]]) {
    line([[0.75, t0], [0.75, t1]], Dk(0.35), 1.2); line([[0.758, t0], [0.758, t1]], Lt(0.07), 1); stitch([[0.742, t0], [0.742, t1]]);
    line([[0.25, t0], [0.25, t1]], Dk(0.3), 1); stitch([[0.243, t0], [0.243, t1]]); stitch([[0.257, t0], [0.257, t1]]);
  }
  // 褲腳：反摺的邊、兩條縫線
  band(R.hem - 0.022, R.hem + 0.003, Dk(0.08)); stitch([[0, R.hem - 0.02], [1, R.hem - 0.02]]); stitch([[0, R.hem - 0.012], [1, R.hem - 0.012]]);
  band(R.hem - 0.003, R.last, Dk(0.2));
  // 腰：側邊縫線、後中線
  line([[0.25, P.wbBot], [0.25, P.crotch]], Dk(0.3), 1); stitch([[0.243, P.wbBot], [0.243, P.crotch]]);
  line([[0.75, P.wbBot], [0.75, P.crotch]], Dk(0.3), 1); stitch([[0.757, P.wbBot], [0.757, P.crotch]]);
  for (const u of [0.003, 0.997]) line([[u, P.wbBot], [u, P.crotch]], Dk(0.35), 1.5);
  stitch([[0.012, P.wbBot], [0.012, P.crotch]]); stitch([[0.988, P.wbBot], [0.988, P.crotch]]);
  // 門襟：中間一條深色的邊、J 字縫線
  const fe = P.wbBot + (P.crotch - P.wbBot) * 0.62;
  line([[0.5, P.wbBot], [0.5, fe + 0.01]], Dk(0.4), 1.2);
  for (const o of [0, 0.008]) stitch([[0.533 + o, P.wbBot], [0.533 + o, fe - 0.02 + o], [0.52, fe + o * 0.6], [0.502, fe + 0.012 + o]]);
  // 前口袋：彎彎的袋口（深色的邊＋縫線）、鉚釘；右邊口袋裡的零錢袋
  for (const sd of [-1, 1]) {
    const a = [0.5 + sd * 0.085, P.wbBot], b = [0.5 + sd * 0.11, P.wbBot + (P.hip - P.wbBot) * 1.15], d = [0.5 + sd * 0.25, P.wbBot + (P.crotch - P.wbBot) * 0.45];
    line(quad(a, b, d), Dk(0.5), 2);
    line(quad([a[0] + sd * 0.006, a[1]], [b[0] + sd * 0.006, b[1] - 0.004], [d[0], d[1] - 0.008]), Lt(0.1), 1);
    stitch(quad([a[0] - sd * 0.008, a[1]], [b[0] - sd * 0.009, b[1] + 0.006], [d[0] - sd * 0.002, d[1] + 0.012]));
    for (const [u, t] of [[a[0] - sd * 0.004, a[1] + 0.006], [d[0] - sd * 0.012, d[1] + 0.004]]) { c.fillStyle = '#b07a3a'; c.beginPath(); c.arc(u * W, t * H, 1.6, 0, 7); c.fill(); c.fillStyle = 'rgba(255,230,180,.6)'; c.fillRect(u * W - 0.6, t * H - 0.8, 1, 1); }
  }
  stitch([[0.41, P.wbBot + 0.004], [0.41, P.wbBot + (P.crotch - P.wbBot) * 0.28], [0.36, P.wbBot + (P.crotch - P.wbBot) * 0.28], [0.36, P.wbBot + 0.004]]);
  // 後面：育克（V 字）、兩個後口袋（五角形的雙縫線、裡面一條裝飾的弧線）
  const ty1 = P.wbBot + (P.crotch - P.wbBot) * 0.22, ty2 = P.wbBot + (P.crotch - P.wbBot) * 0.36, yoke = u => ty1 + (ty2 - ty1) * (0.25 - Math.min(u, 1 - u)) / 0.25;
  for (const [ua, ub] of [[0.25, 0], [0.75, 1]]) { line([[ua, ty1], [ub, ty2]], Dk(0.35), 1.2); stitch([[ua, ty1 + 0.008], [ub, ty2 + 0.008]]); stitch([[ua, ty1 + 0.016], [ub, ty2 + 0.016]]); }
  for (const cu of [0.11, 0.89]) {
    const w = 0.065, top = yoke(cu) + 0.022, bot = top + (P.crotch - P.wbBot) * 0.42, tip = bot + 0.03;
    const shp = [[cu - w, top], [cu + w, top], [cu + w * 0.88, bot], [cu, tip], [cu - w * 0.88, bot], [cu - w, top]];
    line(shp.map(([u, t]) => [u + 0.004, t + 0.004]), Dk(0.3), 2);
    line(shp, Dk(0.2), 1);
    stitch(shp.map(([u, t]) => [cu + (u - cu) * 0.9, top + (t - top) * 0.94 + 0.004]));
    line(quad([cu - w * 0.7, top + 0.045], [cu, top + 0.085], [cu + w * 0.7, top + 0.045]), thr2, 1, dash);
    line(quad([cu - w * 0.7, top + 0.06], [cu, top + 0.1], [cu + w * 0.7, top + 0.06]), thr2, 1, dash);
  }
  // 褲頭、皮帶、皮帶環
  band(0, P.wbBot, mixHex(col, '#000000', 0.08));
  stitch([[0, P.wbBot - 0.006], [1, P.wbBot - 0.006]]);
  const b0 = P.wbTop + (P.wbBot - P.wbTop) * 0.12, b1 = P.wbBot - (P.wbBot - P.wbTop) * 0.12;
  band(b0, b1, '#2a1e17'); line([[0, b0], [1, b0]], 'rgba(0,0,0,.6)', 1); line([[0, b1], [1, b1]], 'rgba(0,0,0,.6)', 1);
  line([[0, b0 + 0.004], [1, b0 + 0.004]], 'rgba(255,220,180,.12)', 1, [2, 2]);
  for (const u of [0.04, 0.22, 0.38, 0.62, 0.78, 0.96]) { c.fillStyle = mixHex(col, '#000000', 0.15); c.fillRect(u * W - 2.5, P.wbTop * H, 5, (P.wbBot - P.wbTop) * H); c.fillStyle = Lt(0.08); c.fillRect(u * W - 2.5, P.wbTop * H, 1, (P.wbBot - P.wbTop) * H); }
  c.fillStyle = '#8f9096'; c.fillRect(0.5 * W - 8, (b0 - 0.006) * H, 16, (b1 - b0 + 0.012) * H);   // 皮帶扣
  c.fillStyle = '#2a1e17'; c.fillRect(0.5 * W - 5, (b0 + 0.001) * H, 10, (b1 - b0 - 0.002) * H);
  c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0.5 * W - 8, (b0 - 0.006) * H, 16, 1);
}

// 朋友的頭：第三世界乘客的寫實頭（畫布畫的臉：活人的膚色、睜著眼；立體的鼻子、男生有耳朵），脖子和頭髮自己做
function friendHead(pose, p, px) {
  const hd = p.hd, girl = p.sex === 'f', skin = pcol(p.skin, 'skin'), hc = new THREE.Group();
  hc.position.set(0, girl ? 0.128 : 0.134, 0.024); pose.add(hc);
  pmesh(pose, friendGeos(p.sex).neck, skin, 0, 0, 0);
  const tex = canvasTex(PAX_TEX, PAX_TEX, c => paintPaxHead(c, p, 'alive'), true);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  px.tex.alive = tex; px.headMat = paxTexMat([tex]);
  pmesh(hc, paxHeadGeo(hd), px.headMat, 0, 0, 0);
  pel(hc, 0, -0.022, hd.rz * 0.95, 0.0125, 0.021, 0.023, skin).rotation.x = -0.4;   // 鼻頭
  for (const s of [-1, 1]) pel(hc, s * 0.009, -0.03, hd.rz * 0.93, 0.008, 0.008, 0.012, skin);   // 鼻翼
  pel(hc, 0, 0.002, hd.rz * 0.975, 0.0075, 0.024, 0.012, skin);                      // 鼻樑
  if (!girl) for (const s of [-1, 1]) pel(hc, s * hd.rx * 0.96, -0.008, -0.01, 0.009, 0.026, 0.017, skin).rotation.y = s * 0.35;   // 耳朵
  pmesh(hc, friendHairGeo(p.style, hd), pcol(p.hair, 'hair'), 0, 0, 0);
}
// 頭髮：照髮際線從頭長出來（跟乘客的一樣），但更細、更自然：
// 男生的短髮頭頂蓬一點、前面有一點瀏海蓋在額頭上（一撮一撮參差不齊），旁邊和後面往下剃短；女生的鮑伯頭從耳朵上面開始直直地垂到下巴，髮尾往內收；都有一點一撮一撮的起伏
function friendHairGeo(style, hd) {
  return geo('frHair' + style + hd.key, () => {
    const W = 56, Hs = 36, g = new THREE.SphereGeometry(1, W, Hs, -Math.PI / 2), P = g.attributes.position, I = g.index.array, fn = paxHairLine(style), bob = style === 'bob';
    const d = new Float32Array(P.count), keep = [], q = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3(), TH = 1.15;
    for (let i = 0; i < P.count; i++) {
      const a = Math.atan2(P.getX(i), P.getZ(i)), th0 = Math.acos(clamp(P.getY(i), -1, 1));
      // 男生的瀏海：額頭那一段的髮際線往下長一點，髮尾一撮一撮的
      const line = t => Math.max(fn(a, t), bob ? -1 : 0.86 + (0.15 + 0.035 * Math.sin(a * 23) + 0.02 * Math.sin(a * 41 + 1)) * (1 - sstep(0.45, 0.95, Math.abs(a))) - t);
      const dd = line(th0), D = Math.max(0, dd);
      d[i] = dd;
      // 髮際線外面的點拉到髮際線上（邊緣才會照著髮際線彎，不會一格一格的）
      const th = dd < 0 ? th0 + dd : th0, st = Math.sin(th);
      paxHeadPt(st * Math.sin(a), Math.cos(th), st * Math.cos(a), hd, q);
      n.copy(q).normalize();
      const fade = sstep(0, 0.12 + 0.3 * sstep(1.2, 1.8, th), D);   // 男生旁邊和後面往下越剃越短
      const top = 1 - sstep(0.5, 1.5, th), tuft = 0.0016 * Math.sin(a * 11 + th * 7) * Math.sin(th * 13 - a * 5) + 0.0012 * Math.sin(a * 23 - th * 17) + 0.001 * Math.sin(a * 37 + th * 29);
      const T = bob ? 0.005 + sstep(0, 0.12, D) * (0.009 + 0.008 * top) + tuft * 0.6
        : 0.0025 + fade * (0.006 + 0.016 * top) + 0.008 * Math.exp(-(((th - 0.7) / 0.2) ** 2)) * (1 - sstep(0.4, 0.9, Math.abs(a))) + tuft * (0.3 + 0.7 * fade);
      q.addScaledVector(n, T);
      if (bob && th > TH) {
        // 耳朵以下直直地垂下來（不跟著下巴往內收），髮尾往內收一點
        paxHeadPt(Math.sin(TH) * Math.sin(a), Math.cos(TH), Math.sin(TH) * Math.cos(a), hd, e);
        const rh = Math.hypot(e.x, e.z) + T, cur = Math.hypot(q.x, q.z) || 1, k = Math.max(1, rh / cur) * (1 - 0.08 * (1 - sstep(0, 0.16, D)));
        q.x *= k; q.z *= k;
      }
      P.setXYZ(i, q.x, q.y, q.z);
    }
    for (let k = 0; k < I.length; k += 3) if (Math.max(d[I[k]], d[I[k + 1]], d[I[k + 2]]) > 0) keep.push(I[k], I[k + 1], I[k + 2]);
    g.setIndex(keep);
    g.computeVertexNormals();
    fixSeam(g, W, Hs + 1);
    return g;
  });
}
// 頭髮的明暗：頭頂有光澤、下面暗一點，一撮一撮深淺不同（合併之後改頂點顏色）
function friendHairShade(root) {
  const hm = paxHairMat();
  root.traverse(o => {
    if (!o.isMesh || o.material !== hm) return;
    const C = o.geometry.attributes.color, N = o.geometry.attributes.normal;
    for (let i = 0; i < C.count; i++) { const v = 0.78 + 0.34 * sstep(0.2, 0.95, N.getY(i)) + (hash01(i * 0.37) - 0.5) * 0.1; C.setXYZ(i, C.getX(i) * v, C.getY(i) * v, C.getZ(i) * v); }
    C.needsUpdate = true;
  });
}
function buildFriend(f) {
  const p = friendSpec(f), s0 = seed, D = FR_DIM[p.sex], k = D.k;   // 畫臉、畫衣服會用到亂數：用完放回去，第三世界的乘客才不會因為朋友來了就變臉
  seed = 1 + hash4('fr|' + f.name) % 2147483646;   // 衣服的皺褶照名字固定
  const g = new THREE.Group(); scene.add(g);
  const body = new THREE.Group(); body.scale.setScalar(p.sc); g.add(body);
  const r = { g, body, p, id: f.id, look: f.look, color: f.color, name: f.name, yaw: faceRot(f.face || 0), ph: 0, walkK: 0, crK: 0, init: false };
  const GM = friendGeos(p.sex), sh = { shade: 0.55 };
  const shirtTex = canvasTex(256, 256, (c, w, h) => paintFriendShirt(c, w, h, f.color || '#8a8a8a', GM));
  const jeansTex = canvasTex(256, 512, (c, w, h) => paintFriendJeans(c, w, h, p.pants, GM));
  r.texs = [shirtTex, jeansTex];
  const shirt = withDetail(ownLM('#ffffff', { map: shirtTex, ...sh }), 'cotton', 5, 0.8);
  const jeans = withDetail(ownLM('#ffffff', { map: jeansTex, ...sh }), 'cotton', 7, 0.9);
  const skin = withDetail(ownLM(p.skin, sh), 'skin', 8, 1.2);
  // 每一節自己一個小群組，零件照材質合併（子關節不放在裡面，才不會被合進去）
  const seg = (parent, fill) => { const q = new THREE.Group(); parent.add(q); fill(q); paxMerge(q, []); return q; };
  const put = (q, gm, mat) => pmesh(q, gm, mat, 0, 0, 0);
  // 腰：大腿和上半身都從這裡出發
  const hips = new THREE.Group(); hips.position.y = FRIEND_HIP; body.add(hips); r.hips = hips;
  seg(hips, q => put(q, GM.pelvis, jeans));
  // 上半身（蹲下、跑步時往前彎）
  const torso = new THREE.Group(); hips.add(torso); r.torso = torso;
  seg(torso, q => put(q, GM.torso, shirt));
  // 頭：脖子底下 → 轉頭（yaw）→ 抬頭低頭（pose）
  const neck = new THREE.Group(); neck.position.set(0, D.nkY, -0.004); torso.add(neck);
  r.headYaw = new THREE.Group(); neck.add(r.headYaw);
  r.headPose = new THREE.Group(); r.headYaw.add(r.headPose);
  const px = { kind: 'friend', p, g, skins: [], tex: {}, state: 'alive' };
  friendHead(r.headPose, p, px);
  paxMerge(r.headPose, px.skins);
  friendHairShade(r.headPose);
  r.px = px;
  // 手臂：肩膀（袖子、上臂）→ 手肘 → 前臂和手（arms[0] 是右手，握著手電筒）
  r.arms = [-1, 1].map(s => {
    const shp = new THREE.Group(); shp.position.set(s * D.shX, D.shY, -0.006); shp.rotation.order = 'YXZ'; torso.add(shp);
    seg(shp, q => { put(q, GM.sleeve[s], shirt); put(q, GM.upper[s], skin); });
    const el = new THREE.Group(); el.position.set(0, -D.ua, 0); shp.add(el);
    const fa = new THREE.Group(); el.add(fa);
    let tip = null;
    seg(fa, q => { put(q, GM.fore[s], skin); friendHand(q, D, s, s < 0, skin); if (s < 0) tip = friendFlashlight(q, D, s); });
    if (tip) { r.tip = new THREE.Object3D(); r.tip.position.set(...tip); fa.add(r.tip); }
    return { sh: shp, el, fa };
  });
  r.lens = ownSprite(glowTex, 0xfff0d0); r.lens.scale.setScalar(0.22); r.tip.add(r.lens);
  // 腳：大腿 → 膝蓋 → 小腿 → 腳踝和球鞋（腳踝會轉回來，腳底板才會平平地踩在地上；legs[0] 是右腳）
  r.legs = [-1, 1].map(s => {
    const hp = new THREE.Group(); hp.position.set(s * D.hipX, -0.04, 0); hips.add(hp);
    seg(hp, q => put(q, GM.thigh[s], jeans));
    const kn = new THREE.Group(); kn.position.set(-0.006 * s, -0.43, 0); hp.add(kn);
    seg(kn, q => put(q, GM.shin[s], jeans));
    const an = new THREE.Group(); an.position.set(0, -0.385, 0); kn.add(an);
    seg(an, q => friendShoe(q, s, k, p.shoe));
    return { hp, kn, an };
  });
  // 手電筒的光束：放在場景裡（不跟著手臂轉），每一幀照著看的方向擺；尖端亮、越遠越淡
  if (!friendBeamTex) friendBeamTex = canvasTex(8, 128, (c, w, h) => { const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, h); });
  r.beam = new THREE.Mesh(geo('frBeam', () => new THREE.ConeGeometry(1.25, 5.5, 20, 1, true).translate(0, -2.75, 0).rotateX(-Math.PI / 2)),
    ownBasic({ map: friendBeamTex, color: 0xfff0d8, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  r.beam.renderOrder = 4; r.beam.visible = false; scene.add(r.beam);
  seed = s0;
  return r;
}
// 頭上的名字（倒下時前面加 💤），底下是衣服的顏色和血量條（綠 → 黃 → 紅）
function friendLabel(r, text, color, hp, key) {
  if (r.label) { r.g.remove(r.label); r.label.material.map.dispose(); r.label.material.dispose(); }
  const font = n => `bold ${n}px "PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif`;
  const tex = canvasTex(256, 80, (c, w) => {
    c.font = font(34);
    const tw = c.measureText(text).width;
    if (tw > 236) c.font = font(Math.floor(34 * 236 / tw));
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    c.lineWidth = 7; c.strokeStyle = 'rgba(0,0,0,.8)'; c.strokeText(text, w / 2, 27);
    c.fillStyle = '#ffffff'; c.fillText(text, w / 2, 27);
    c.fillStyle = color || '#888888'; c.fillRect(w / 2 - 28, 50, 56, 6);   // 衣服的顏色
    const k = clamp(hp / 100, 0, 1), bw = 112;
    c.fillStyle = 'rgba(0,0,0,.75)'; c.fillRect(w / 2 - bw / 2 - 3, 61, bw + 6, 14);
    c.fillStyle = k > 0.5 ? '#3fd16b' : k > 0.25 ? '#f2c230' : '#e8413c'; c.fillRect(w / 2 - bw / 2, 64, bw * k, 8);
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(0.84, 0.2625, 1); s.renderOrder = 6;
  r.g.add(s); r.label = s; r.labelKey = key;
}
// 朋友手上拿的東西（net.js 的 hand）：武器、蠟燭拿在左手（握的地方在原點，往手指的方向（-y）伸出去；蠟燭是直立的），
// 第四世界的板子（P 加等級，門是 D）夾在左手臂下、家具（F）兩手抱在胸前
function friendHeld(r, code) {
  const g = new THREE.Group(), D = FR_DIM[r.p.sex], k = D.k, dark = lm('#26262a'), wood = lm('#7a4a22');
  if (code === 'F') {
    box(g, -0.3, 0.3, -0.22, 0.22, -0.24, 0.24, lm('#b98d5a'));                 // 搬著的家具：用一個紙箱代表
    box(g, -0.301, 0.301, 0.02, 0.06, -0.241, 0.241, lm('#d8c39a'), false);       // 封箱膠帶
    g.position.set(0, 1.0, 0.42); r.g.add(g);
    return g;
  }
  if (code[0] === 'P' || code[0] === 'D') {
    // 真的板子是 2×2 公尺，整片畫出來會把朋友整個擋住：夾在手臂下的畫成 1.1 公尺
    const tier = clamp(+code.slice(1) || 1, 1, PLANK_MAX), S = 1.1, col = code[0] === 'D' ? '#8a5a32' : PLANKS[tier].color;
    box(g, -0.025, 0.025, 0, S, -S / 2, S / 2, lm(col, tier === GLASS_TIER ? { transparent: true, opacity: 0.45 } : undefined));
    if (code[0] === 'D') sph(g, 0.03, 0.04, S * 0.48, S * 0.35, lm('#d4b24a'), 1, 1, 1, 8);   // 門把
    g.position.set(0.34, 0.25, 0.08); r.g.add(g);
    return g;
  }
  if (code === 'pan') {
    cyl(g, 0.012, 0.014, 0.17, 0, -0.17, 0, dark, 8);                           // 握把
    const pan = cyl(g, 0.115, 0.1, 0.03, 0, -0.3, 0, lm('#3a3a40'), 18);        // 鍋子（鍋面朝側邊）
    pan.rotation.z = Math.PI / 2; pan.position.set(0, -0.28, 0);
  } else if (code === 'slingshot') {
    cyl(g, 0.013, 0.013, 0.1, 0, -0.1, 0, wood, 8);
    for (const sx of [-1, 1]) { const m = cyl(g, 0.009, 0.009, 0.08, sx * 0.02, -0.17, 0, wood, 6); m.rotation.z = sx * 0.45; }
    box(g, -0.04, 0.04, -0.205, -0.195, -0.004, 0.004, lm('#c9a46a'), false);   // 橡皮筋
  } else if (code === 'watergun') {
    box(g, -0.022, 0.022, -0.2, -0.02, -0.03, 0.03, lm('#e8e8ee'));
    cyl(g, 0.03, 0.03, 0.09, 0, -0.13, 0.05, lm('#4aa3ff', { transparent: true, opacity: 0.75 }), 12);   // 聖水的水箱
    box(g, -0.015, 0.015, -0.05, 0.02, -0.06, -0.02, lm('#3a78c2'));          // 握把
  } else if (code === 'salt') {
    cyl(g, 0.028, 0.03, 0.09, 0, -0.1, 0, lm('#f2f2f2'), 12);
    cyl(g, 0.029, 0.029, 0.022, 0, -0.122, 0, lm('#aeb4bd'), 12);
    box(g, -0.031, 0.031, -0.07, -0.04, -0.031, 0.031, lm('#3a78c2'), false);
  } else if (code === 'firecracker') {
    for (const [x, z] of [[-0.013, 0], [0.013, 0], [0, -0.012]]) cyl(g, 0.011, 0.011, 0.09, x, -0.1, z, lm('#d62828'), 8);
    cyl(g, 0.0025, 0.0025, 0.04, 0, -0.14, -0.004, lm('#3a2a1a'), 5);
  } else if (code === 'candle') {
    cyl(g, 0.045, 0.035, 0.012, 0, 0, 0, lm('#8a6a2a'), 12);                    // 銅燭台
    cyl(g, 0.016, 0.016, 0.13, 0, 0.012, 0, lm('#efe6cf'), 10);                 // 白蠟燭
    const flame = new THREE.Mesh(geo('frFlame', () => new THREE.ConeGeometry(0.012, 0.045, 8)), ownBasic({ color: 0xffc860, fog: false }));
    flame.position.set(0, 0.17, 0); g.add(flame); g.userData.flame = flame;
    const glow = ownSprite(glowTex, 0xffa040); glow.position.set(0, 0.17, 0); glow.scale.setScalar(0.3); g.add(glow); g.userData.glow = glow;
  }
  g.position.set(0, -D.fa - 0.075 * k - 0.02, 0.012);
  r.arms[1].fa.add(g);
  return g;
}
function disposeFriend(r) {
  if (r.held) disposeGroup(r.held);
  disposeGroup(r.g);
  for (const t of (r.px && r.px.headMat && r.px.headMat.userData.maps) || []) t.dispose();
  for (const t of r.texs || []) t.dispose();   // T 恤、牛仔褲的貼圖
  if (r.label) { r.label.material.map.dispose(); r.label.material.dispose(); }
  scene.remove(r.beam); r.beam.material.dispose();
}
function poseFriend(f, r, t, dt, darkK) {
  const p = r.p, fh = floorH(f.x, f.y), lying = f.down || f.pose === 'lie', sit = !f.down && f.pose === 'sit';
  const dx = r.init ? f.x - r.lx : 0, dy = r.init ? f.y - r.ly : 0, dist = Math.hypot(dx, dy);
  r.lx = f.x; r.ly = f.y; r.init = true;
  const sp = dist > 1 ? 0 : dist / Math.max(dt, 1e-3);   // 瞬間移動（爬梯子、醒過來）不算走路
  r.walkK += ((lying || sit ? 0 : clamp(sp / 3.2, 0, 1.35)) - r.walkK) * Math.min(1, dt * 8);
  if (dist < 1) r.ph += dist * 4.4;
  r.crK += ((f.crouch && !lying && !sit ? 1 : 0) - r.crK) * Math.min(1, dt * 10);
  // 頭先轉、身體慢慢跟上（走路時跟得快）；頭最多轉 65°
  const target = faceRot(f.face), HEAD = 1.13;
  let diff = wrapA(target - r.yaw);
  if (Math.abs(diff) > HEAD) { r.yaw = wrapA(r.yaw + diff - Math.sign(diff) * HEAD); diff = Math.sign(diff) * HEAD; }
  r.yaw = wrapA(r.yaw + diff * Math.min(1, dt * (r.walkK > 0.15 || lying || sit ? 9 : 2.2)));
  diff = wrapA(target - r.yaw);
  const A = 0.42 * Math.min(1, r.walkK), run = clamp(r.walkK - 1, 0, 0.35) * 1.4, cr = r.crK, armR = r.arms[0];
  let y = fh + (f.z || 0), lean = 0;
  r.body.rotation.set(0, 0, 0); r.body.position.set(0, 0, 0);
  if (lying) {
    // 躺著（倒下是躺在地上）：臉朝上，頭在玩家的位置，身體往面向的方向伸出去
    r.yaw = target; diff = 0;
    r.body.rotation.x = -Math.PI / 2; r.body.position.set(0, 0.12, 1.6 * p.sc);
    for (const L of r.legs) { L.hp.rotation.x = 0; L.kn.rotation.x = 0.06; L.an.rotation.x = 0.3; }
    r.arms.forEach((a, i) => { a.sh.rotation.set(0.06, 0, (i ? 1 : -1) * 0.12); a.el.rotation.x = -0.15; });
    r.headYaw.rotation.y = f.down ? 0.45 : 0; r.headPose.rotation.set(0, 0, 0);
    if (f.down) y = fh;
  } else if (sit) {
    // 坐著：大腿往前平放、小腿垂下來，手放在腿上
    y += 0.07 - FRIEND_HIP * p.sc;
    for (const L of r.legs) { L.hp.rotation.x = -Math.PI / 2 + 0.05; L.kn.rotation.x = Math.PI / 2 - 0.05; L.an.rotation.x = 0; }
    r.arms.forEach((a, i) => { a.sh.rotation.set(-0.35, 0, (i ? 1 : -1) * 0.1); a.el.rotation.x = -0.95; });
    lean = -0.05;
  } else {
    // 走路：兩腳一前一後（跑步步伐大一點）；蹲下：屁股往下、膝蓋往前，腳底板還是平的
    y += Math.abs(Math.cos(r.ph)) * 0.025 * r.walkK - cr * 0.31 * p.sc;
    r.legs.forEach((L, i) => {
      const ph = r.ph + (i ? Math.PI : 0), s = Math.sin(ph);
      L.hp.rotation.x = -s * A * (1 + run) - cr * 1.05;
      L.kn.rotation.x = Math.max(0, Math.sin(ph + 1.9)) * (0.7 + run * 0.6) * Math.min(1, r.walkK) + cr * 1.75 + 0.04;
      L.an.rotation.x = -(L.hp.rotation.x + L.kn.rotation.x) * (0.75 + 0.25 * cr);
    });
    lean = cr * 0.3 + r.walkK * 0.04 + run * 0.12;
    r.arms.forEach((a, i) => {
      const s = Math.sin(r.ph + (i ? Math.PI : 0));
      a.sh.rotation.set(s * A * 0.8, 0, (i ? 1 : -1) * 0.1);   // 跟同一邊的腳反著擺（手臂稍微張開，才不會穿進身體）
      a.el.rotation.x = -0.18 - 0.45 * Math.min(1, r.walkK) - cr * 0.4;
    });
  }
  r.torso.rotation.x = lean;
  // 手上拿的東西（左手）：拿武器時手臂稍微舉起來，揮的時候往前上方一甩；蠟燭舉在胸前；板子夾在手臂下；家具兩手抱著
  const hold = lying || sit ? '' : f.hand || '', armL = r.arms[1];
  if (hold !== r.holdKey) { if (r.held) disposeGroup(r.held); r.held = hold ? friendHeld(r, hold) : null; r.holdKey = hold; }
  if (f.swing && !r.swPrev) r.swT = 1;   // 朋友那邊揮了一下
  r.swPrev = !!f.swing;
  r.swT = Math.max(0, (r.swT || 0) - dt * 3.5);
  if (hold === 'F') for (const a of r.arms) { a.sh.rotation.set(-1.15 - lean, 0, 0); a.el.rotation.x = -0.4; }
  else if (hold[0] === 'P' || hold[0] === 'D') { armL.sh.rotation.set(-0.1, 0, 0.32); armL.el.rotation.x = -0.25; }
  else if (hold === 'candle') {
    armL.sh.rotation.set(-0.5 - lean, 0, 0.1); armL.el.rotation.x = -1.05;
    r.held.rotation.x = -(lean + armL.sh.rotation.x + armL.el.rotation.x);   // 蠟燭要直立
    const fl = r.held.userData.flame;
    fl.scale.set(1, 0.85 + 0.25 * Math.sin(t * 17 + r.ph), 1);
    r.held.userData.glow.material.opacity = 0.55 + 0.15 * Math.sin(t * 11);
    friendLights.push({ x: f.x, y: f.y, r: 1.8, col: [255, 170, 90], k: 0.35 });
  } else if (hold) {
    const ph = r.swT > 0 ? Math.sin((1 - r.swT) * Math.PI) : 0;
    armL.sh.rotation.set(-0.3 - ph * 1.5 - lean, 0, 0.12); armL.el.rotation.x = -0.55 + ph * 0.35;
  }
  // 手電筒：右手舉起來照著看的方向（上下也跟著看的方向）
  const flash = f.flash && !lying && hold !== 'F';
  if (flash) { armR.sh.rotation.set(-Math.PI / 2 - clamp(f.pitch, -1.1, 1.1) * 0.95 - lean, diff * 0.9, 0); armR.el.rotation.x = -0.05; }
  // 頭：轉向看的方向、抬頭低頭（身體往前彎時頭抬回來）
  if (!lying) { r.headYaw.rotation.y = diff; r.headPose.rotation.set(clamp(-f.pitch * 0.75, -0.6, 0.5) - lean * 0.7, 0, 0); }
  r.g.position.set(f.x, y, f.y); r.g.rotation.y = r.yaw;
  const text = f.down ? '💤 ' + f.name : f.name, hp = f.down ? 0 : clamp(f.hp === undefined ? 100 : f.hp, 0, 100), key = text + '|' + Math.ceil(hp / 5);
  if (key !== r.labelKey) friendLabel(r, text, f.color, hp, key);
  r.label.position.set(0, lying ? 0.55 : (FRIEND_HIP + 0.93 - cr * 0.27 - (sit ? 0.42 : 0)) * p.sc, 0);
  r.lens.visible = flash; r.beam.visible = flash;
  if (!flash) return;
  r.g.updateMatrixWorld(true);
  r.tip.getWorldPosition(_fv);
  const cp = Math.cos(f.pitch), dir = _fv2.set(Math.cos(f.face) * cp, Math.sin(f.pitch), Math.sin(f.face) * cp);
  r.beam.position.copy(_fv); r.beam.lookAt(_fv.x + dir.x, _fv.y + dir.y, _fv.z + dir.z);
  const ft = FLASH_TIERS[clamp(f.flashLv || 1, 1, FLASH_MAX)], col = ft.beam ? ft.beam[0] : [255, 240, 216];   // 第四世界的手電筒 4～7 級有顏色
  r.beam.material.color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255, SRGB); r.lens.material.color.copy(r.beam.material.color);
  r.beam.material.opacity = (0.025 + 0.12 * darkK) * (0.93 + 0.07 * Math.sin(t * 13 + r.ph));
  // 照到的地方（往下照：照在腳前面的地上；往前照：牆前面一點）在光照貼圖上亮一圈
  let d = Math.min(castRay(f.x, f.y, f.face, 6.5) - 0.35, 3.4);
  if (f.pitch < -0.12) d = Math.min(d, 1.35 / Math.tan(-f.pitch));
  if (f.pitch < 0.6 && d > 0.3) friendLights.push({ x: f.x + Math.cos(f.face) * d, y: f.y + Math.sin(f.face) * d, r: 2.3, col, k: 0.5 });
}
function syncFriends(t, dt, dark) {
  friendLights.length = 0;
  const active = typeof Net !== 'undefined' && Net.active;
  const show = active && !!G && mode !== 'title' && mode !== 'cutscene';
  const list = active ? Net.friends() : [], seen = new Set(), darkK = clamp(dark / NIGHT_DARK, 0, 1);
  if (show) for (const f of list) {
    if (!f.ingame || f.world !== curWorld) continue;
    let r = friendMap.get(f.id);
    if (r && (r.look !== f.look || r.color !== f.color || r.name !== f.name)) { disposeFriend(r); friendMap.delete(f.id); r = null; }
    if (!r) { r = buildFriend(f); friendMap.set(f.id, r); }
    seen.add(f.id);
    r.g.visible = true;
    poseFriend(f, r, t, dt, darkK);
  }
  for (const [id, r] of friendMap) {
    if (seen.has(id)) continue;
    if (active && list.some(f => f.id === id)) { r.g.visible = false; r.beam.visible = false; r.init = false; }   // 不在同一個世界、回到主選單、過場動畫：先藏起來
    else { disposeFriend(r); friendMap.delete(id); }   // 離開房間了
  }
}
// 試玩測試用：畫面上的朋友
function friendStats() {
  return [...friendMap.values()].map(r => {
    let n = 0, held = 0;
    r.g.traverse(o => { if (o.isMesh) n++; });
    if (r.held) r.held.traverse(o => { if (o.isMesh) held++; });
    return { id: r.id, name: r.name, visible: r.g.visible, x: r.g.position.x, y: r.g.position.z, h: r.g.position.y, beam: r.beam.visible, meshes: n - held, held: r.holdKey || '', label: r.labelKey || '' };   // meshes 不算手上拿的東西
  });
}

// ====================================================================
// 第三世界：末班列車。鍍金年代的豪華特快車（深胡桃木、黃銅、暗紅絨布、象牙白的天花板），全部都要「舊」；
// 最下面一排是車站。牆上有真的窗戶，窗外是會捲動的三層風景（遠山和天空、樹林、電線桿）
// ====================================================================
let walnutTex, stationWallTex, carriageTex, ceil3Tex, doorPanelTex, carriageDoorTex, glassTex, skyFarTex, skyTopTex, cloudTex, nearTex, yardTex, velvetTex, ironWallTex, tarTex, ballastTex;
const midTexes = {};
let backdrop = null, panes3 = [], walnutMat = null, stationMat = null, ironMat = null, wallMat3 = null, curtains = [], locoSmoke = null;
const doorPanels = new Map();
function makeTrainTextures() {
  const grime = (c, w, h, n, a = 0.18) => { for (let i = 0; i < n; i++) { c.fillStyle = `rgba(20,12,6,${rnd() * a})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 20, 2 + rnd() * 10, rnd() * 3, 0, 7); c.fill(); } };
  // 車廂內牆：上面是泛黃的象牙白壁紙（扇形的裝飾藝術花紋）和線板，中間一條發黑長銅綠的黃銅線，下面是深胡桃木的鑲板（木紋、刮痕、踢腳板）
  walnutTex = photoTex('w3-wall', () => canvasTex(256, 512, (c, w, h) => {
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
  }));
  // 車站的牆：上面是有裂痕和煤灰的灰泥，下面是泛黃的釉面磚
  stationWallTex = photoTex('w3-station', () => canvasTex(256, 512, (c, w, h) => {
    c.fillStyle = '#b3a890'; c.fillRect(0, 0, w, 290);
    c.strokeStyle = 'rgba(0,0,0,.3)'; c.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) { let x = rnd() * w, y = rnd() * 290; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 30; y += 10 + rnd() * 25; c.lineTo(x, y); } c.stroke(); }
    c.fillStyle = '#6e6254'; c.fillRect(0, 286, w, 10);
    for (let y = 296; y < h; y += 36) for (let x = (y / 36 | 0) % 2 ? 0 : 32; x < w + 64; x += 64) { c.fillStyle = shade('#c9bb9a', (rnd() - 0.5) * 20); c.fillRect(x - 32, y, 62, 34); }
    c.fillStyle = 'rgba(255,255,255,.12)'; for (let y = 296; y < h; y += 36) c.fillRect(0, y + 2, w, 3);
    grime(c, w, 290, 18, 0.3); grime(c, w, h, 12, 0.25);
    c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, 0, w, 10);
  }));
  // 列車的外觀（從月台看到的車身）：墨綠色的車身、金色的細線、黃銅框的車窗、鉚釘、鏽水痕
  carriageTex = photoTex('w3-carriage', () => canvasTex(256, 512, (c, w, h) => {
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
  }));
  // 天花板：象牙白，一格一格的線板，泛黃、有水漬
  ceil3Tex = photoTex('w3-ceiling', () => canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#e2d7bd'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(120,100,60,.45)'; c.lineWidth = 3; c.strokeRect(10, 10, w - 20, h - 20);
    c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 1.5; c.strokeRect(14, 14, w - 28, h - 28);
    for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(150,120,70,${0.08 + rnd() * 0.18})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 8 + rnd() * 20, 6 + rnd() * 14, rnd() * 3, 0, 7); c.fill(); }
  }));
  // 包廂的門：胡桃木滑門，上面是蝕刻玻璃（霧面、扇形花紋），黃銅把手；車站側的車門是墨綠色的車身
  doorPanelTex = photoTex('w3-door', () => canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#3a2316'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(20,10,6,${0.25 + rnd() * 0.4})`; c.lineWidth = 1; const x = rnd() * w; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + (rnd() - 0.5) * 4, h); c.stroke(); }
    c.fillStyle = '#b9c4c2'; c.fillRect(18, 18, w - 36, 100);
    c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 1.5; for (let r = 12; r <= 44; r += 8) { c.beginPath(); c.arc(w / 2, 118, r, Math.PI, 0); c.stroke(); }
    c.strokeStyle = '#5a3a24'; c.lineWidth = 4; c.strokeRect(18, 18, w - 36, 100); c.strokeRect(18, 138, w - 36, 96);
    c.fillStyle = '#c9a24a'; c.fillRect(w - 28, 150, 8, 26);
    grime(c, w, h, 8, 0.25);
  }));
  carriageDoorTex = photoTex('w3-cardoor', () => canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#17301f'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#9c7b35'; c.fillRect(16, 24, w - 32, 96); c.fillStyle = '#0b1420'; c.fillRect(22, 30, w - 44, 84);
    c.fillStyle = '#c9a24a'; c.fillRect(0, 140, w, 3); c.fillStyle = '#0d0e0c'; c.fillRect(0, 200, w, 56);
    c.fillStyle = '#c9a24a'; c.fillRect(w - 24, 150, 6, 30);
    grime(c, w, h, 8, 0.3);
  }));
  for (const t of [doorPanelTex, carriageDoorTex]) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  // 髒髒的玻璃（寒寂之境會結霜：用顏色和透明度調）
  glassTex = canvasTex(64, 96, (c, w, h) => {
    c.fillStyle = 'rgba(200,215,225,.25)'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) { c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.12})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 3 + rnd() * 12, 2 + rnd() * 6, rnd() * 3, 0, 7); c.fill(); }
    const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, 60); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(220,235,245,.55)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  glassTex.wrapS = glassTex.wrapT = THREE.ClampToEdgeWrapping;
  // 磨破的暗紅絨布
  velvetTex = photoTex('w3-velvet', () => canvasTex(64, 64, (c, w, h) => {
    c.fillStyle = '#5a1f26'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(${120 + rnd() * 60 | 0},${30 + rnd() * 20 | 0},${40 + rnd() * 20 | 0},.35)`; c.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
    for (let i = 0; i < 5; i++) { c.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 5 + rnd() * 12, 3 + rnd() * 8, rnd() * 3, 0, 7); c.fill(); }
  }));
  // 機車室的牆：鉚釘鐵板，有鏽水和煤灰
  ironWallTex = photoTex('w3-ironwall', () => canvasTex(256, 512, (c, w, h) => {
    c.fillStyle = '#3a3b3f'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 3;
    for (let y = 0; y <= h; y += 128) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.beginPath(); c.moveTo(128, 0); c.lineTo(128, h); c.stroke();
    for (let y = 16; y < h; y += 32) for (const x of [12, 116, 140, 244]) { c.fillStyle = '#55575c'; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill(); c.fillStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(x + 1.5, y + 1.5, 2.2, 0, 7); c.fill(); }
    for (let i = 0; i < 10; i++) { c.fillStyle = `rgba(120,70,30,${0.12 + rnd() * 0.25})`; const x = rnd() * w; c.fillRect(x, rnd() * h * 0.6, 2 + rnd() * 4, 60 + rnd() * 160); }
    grime(c, w, h, 24, 0.35);
  }));
  // 車站的柏油屋頂（從車頂往下看得到）
  tarTex = canvasTex(128, 128, (c, w, h) => { c.fillStyle = '#1e1d1f'; c.fillRect(0, 0, w, h); for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`; c.fillRect(rnd() * w, rnd() * h, 2, 2); } grime(c, w, h, 10, 0.3); });
  // 地面：碎石路基、枕木和一條平行的鐵軌（一張貼圖是 4×4 格）
  ballastTex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#4a4742'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) { const g = 50 + rnd() * 70 | 0; c.fillStyle = `rgb(${g},${g - 4},${g - 8})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 3, 2 + rnd() * 3); }
    c.fillStyle = '#3a2d22'; for (let x = 6; x < w; x += 38) c.fillRect(x, 96, 14, 72);
    c.fillStyle = '#6a6a6e'; c.fillRect(0, 108, w, 5); c.fillRect(0, 150, w, 5); c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0, 108, w, 1); c.fillRect(0, 150, w, 1);
    grime(c, w, h, 14, 0.25);
  });
  // ---------- 車外的風景（三層視差）：遠山和天空、中景（照天數換）、近景的電線桿；白天停在車站看到的站場 ----------
  // 設計師要的夢核風：飽和的藍天、白白的雲、紫藍色的遠山、綠色的山丘，山腳下是開滿花的草原
  const SKY_TOP = '#3d8fe0';
  // 一朵雲；靠近貼圖邊緣的話在另一邊也畫一份，貼圖重複排的時候雲才不會被切掉
  // wrapY：上下也要接得起來（頭頂的雲）；遠山那張上下不重複，雲只在左右接
  const cloud = (c, x, y, sc, a = 0.92, wrapY = false) => {
    const w = c.canvas.width, h = c.canvas.height;
    c.fillStyle = `rgba(255,255,255,${a})`;
    for (const dx of [-w, 0, w]) for (const dy of wrapY ? [-h, 0, h] : [0]) {
      if (Math.abs(x + dx - w / 2) > w / 2 + 60 * sc || Math.abs(y + dy - h / 2) > h / 2 + 30 * sc) continue;
      for (let i = 0; i < 7; i++) { c.beginPath(); c.arc(x + dx + (i - 3) * 11 * sc, y + dy + Math.sin(i * 1.9) * 5 * sc, (11 + (i % 3) * 5) * sc, 0, 7); c.fill(); }
      c.beginPath(); c.ellipse(x + dx, y + dy + 8 * sc, 42 * sc, 9 * sc, 0, 0, 7); c.fill();
    }
  };
  skyFarTex = photoTex('w3-far', () => canvasTex(1024, 256, (c, w, h) => {
    // 四面牆的天空不畫雲（四面牆在角落接起來，雲會被切成一條）；雲都在頭頂那一片。上面一段是純色，跟頭頂那一片的邊接得起來
    const g = c.createLinearGradient(0, 0, 0, 175); g.addColorStop(0, SKY_TOP); g.addColorStop(0.4, SKY_TOP); g.addColorStop(0.8, '#9ecbf5'); g.addColorStop(1, '#d9ecfb');
    c.fillStyle = g; c.fillRect(0, 0, w, 175);
    const range = (base, amp, col, y0) => { c.fillStyle = col; c.beginPath(); c.moveTo(0, h); c.lineTo(0, y0); let x = 0; while (x < w) { x += 30 + rnd() * 60; c.lineTo(x, y0 - amp * Math.abs(Math.sin(x * base)) - rnd() * 12); } c.lineTo(w, h); c.fill(); };
    range(0.011, 70, '#7a8fcc', 168); range(0.017, 46, '#4f8a74', 176); range(0.03, 22, '#5fa04a', 184);
    c.fillStyle = '#5c9c40'; c.fillRect(0, 188, w, h - 188);
    for (let i = 0; i < 160; i++) { c.fillStyle = ['#ff9ec8', '#ffe066', '#ffffff', '#8fb8ff', '#ff6a6a'][(rnd() * 5) | 0]; c.beginPath(); c.arc(rnd() * w, 190 + rnd() * 66, 1.2 + rnd() * 2, 0, 7); c.fill(); }
  }));
  skyFarTex.wrapT = THREE.ClampToEdgeWrapping;   // 上下不重複，接天空的地方才不會有一條線
  // 遠山上面再接一片天空（從車頂看得到更高的地方）：顏色跟遠山那張貼圖的最上面一樣
  skyTopTex = canvasTex(8, 8, (c, w, h) => { c.fillStyle = SKY_TOP; c.fillRect(0, 0, w, h); });
  // 頭頂的藍天白雲（露天的月台和車頂抬頭看得到）：一大片會跟著列車慢慢飄的雲
  cloudTex = canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = SKY_TOP; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 9; i++) cloud(c, rnd() * w, rnd() * h, 1.2 + rnd() * 1.6, 0.9, true);
  });
  const mid = (name, draw) => { midTexes[name] = canvasTex(1024, 256, (c, w, h) => { c.clearRect(0, 0, w, h); draw(c, w, h); }); };
  // 草原（夢核風）：開滿花的綠草地、幾棵圓圓的樹、一段白籬笆
  mid('plain', (c, w, h) => {
    const g = c.createLinearGradient(0, 150, 0, h); g.addColorStop(0, '#76bf52'); g.addColorStop(1, '#4b8c36');
    c.fillStyle = g; c.fillRect(0, 150, w, h - 150);
    for (let i = 0; i < 80; i++) { c.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.08})`; c.beginPath(); c.ellipse(rnd() * w, 160 + rnd() * 90, 14 + rnd() * 50, 2 + rnd() * 3, 0, 0, 7); c.fill(); }
    for (let i = 0; i < 6; i++) { const x = rnd() * w, r = 16 + rnd() * 14; c.fillStyle = '#5a3b22'; c.fillRect(x - 3, 150 - r, 6, r + 8); c.fillStyle = ['#3f8f3a', '#56a84a', '#2f7a30'][(rnd() * 3) | 0]; c.beginPath(); c.arc(x, 150 - r, r, 0, 7); c.fill(); }
    c.fillStyle = '#f4f1e6'; for (let x = 0; x < w; x += 34) c.fillRect(x, 150, 4, 22); c.fillRect(0, 156, w, 3); c.fillRect(0, 166, w, 3);
    for (let i = 0; i < 420; i++) { c.fillStyle = ['#ff9ec8', '#ffe066', '#ffffff', '#8fb8ff', '#ff6a6a', '#ffb347'][(rnd() * 6) | 0]; c.beginPath(); c.arc(rnd() * w, 176 + rnd() * 80, 1.5 + rnd() * 3, 0, 7); c.fill(); }
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
  yardTex = photoTex('w3-yard', () => canvasTex(1024, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#9a9484'; c.fillRect(0, 196, w, 60); c.fillStyle = '#b8b2a2'; c.fillRect(0, 196, w, 6);
    for (let i = 0; i < 90; i++) { c.fillStyle = ['#ff9ec8', '#ffe066', '#ffffff', '#8fb8ff'][(rnd() * 4) | 0]; c.beginPath(); c.arc(rnd() * w, 230 + rnd() * 26, 1.5 + rnd() * 2, 0, 7); c.fill(); }
    c.fillStyle = '#5a4034'; c.fillRect(120, 100, 300, 96); c.fillStyle = '#3a2a22'; c.beginPath(); c.moveTo(110, 100); c.lineTo(270, 50); c.lineTo(430, 100); c.fill();
    for (let x = 140; x < 400; x += 44) { c.fillStyle = '#1a2230'; c.fillRect(x, 126, 24, 40); c.fillStyle = '#c9a24a'; c.fillRect(x - 2, 124, 28, 2); }
    c.fillStyle = '#6b4a3a'; c.fillRect(600, 20, 50, 176); c.fillStyle = '#e8e0c8'; c.beginPath(); c.arc(625, 50, 16, 0, 7); c.fill(); c.strokeStyle = '#222'; c.lineWidth = 2; c.beginPath(); c.moveTo(625, 50); c.lineTo(625, 40); c.moveTo(625, 50); c.lineTo(633, 54); c.stroke();
    c.fillStyle = '#4a4a4e'; c.fillRect(800, 60, 80, 60); c.fillRect(806, 120, 8, 76); c.fillRect(866, 120, 8, 76); c.fillRect(820, 120, 40, 8);
    for (const x of [40, 520, 760, 960]) { c.fillStyle = '#2a2320'; c.fillRect(x - 3, 90, 6, 106); c.fillStyle = '#e8d8a0'; c.fillRect(x - 8, 76, 16, 18); }
    grime(c, w, h, 20, 0.2);
  }));
  // 中景換成照片（Gemini 畫在洋紅色背景上再去背的）：五種都有才換，大小才會一樣（換中景時是直接換圖）
  const MIDS = ['plain', 'trees', 'bridge', 'snow', 'city'];
  if (MIDS.every(n => photos['w3-mid-' + n])) for (const n of MIDS) midTexes[n] = photoTex('w3-mid-' + n);
}
// 牆上的旅行海報（W3.posters）：一張薄薄的紙貼在牆上，被燈照到才看得清楚
function buildPosters3() {
  if (!W3.posters) return;
  for (const p of W3.posters) {
    const name = 'w3-poster-' + p.img;
    if (!photos[name]) continue;
    const m = new THREE.Mesh(geo('poster3', () => new THREE.PlaneGeometry(0.72, 0.96)), photoMat(name, '#ffffff'));
    const s = p.face === 's' ? 1 : -1;
    m.position.set(p.x, 1.55, p.z + s * 0.012); m.rotation.y = p.face === 's' ? 0 : Math.PI;
    m.receiveShadow = true; houseGroup.add(m);
  }
}
// 牆的一小塊（窗戶上下左右）：貼圖照它在整面牆上的位置取，壁紙、黃銅線、鑲板才跟旁邊整面的牆對得上
function wallPiece(g, x0, x1, y0, y1, z0, z1, mat) {
  const gm = geo(`wallpc${x0},${x1},${y0},${y1},${z0},${z1}`, () => {
    const b = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), P = b.attributes.position, N = b.attributes.normal, U = b.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      if (Math.abs(N.getY(i)) > 0.5) continue;
      const x = P.getX(i) + (x0 + x1) / 2, y = P.getY(i) + (y0 + y1) / 2, z = P.getZ(i) + (z0 + z1) / 2, nx = N.getX(i), nz = N.getZ(i);
      U.setXY(i, Math.abs(nz) > 0.5 ? (nz > 0 ? x : 1 - x) : (nx > 0 ? 1 - z : z), y / CEIL_W3);
    }
    return b;
  });
  const m = new THREE.Mesh(gm, mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}
// ---------- 牆：車廂是胡桃木壁板（機車室是鉚釘鐵板）、車站是磚牆；列車面向月台的那一面是墨綠色的車身；牆上開真的窗戶 ----------
function buildTrainWalls(list) {
  walnutMat = patchLM(new THREE.MeshLambertMaterial({ map: walnutTex })); walnutMat.userData.own = true;
  stationMat = patchLM(new THREE.MeshLambertMaterial({ map: stationWallTex })); stationMat.userData.own = true;
  ironMat = patchLM(new THREE.MeshLambertMaterial({ map: ironWallTex })); ironMat.userData.own = true;
  const carriage = patchLM(new THREE.MeshLambertMaterial({ map: carriageTex })); carriage.userData.own = true;
  const sideMats = [walnutMat, walnutMat, walnutMat, walnutMat, carriage, walnutMat];   // +z 那一面朝著月台
  // 每一格牆是哪一種：看它旁邊（含斜角）是哪些房間。只跟車頂相鄰的是車頂的邊緣，不蓋牆（邊條在 buildRoof3）
  const roomN = (x, y) => (inMap(x, y) ? roomGrid[y][x] : null);
  const kindOf = (x, y) => {
    let train = false, station = false, engine = false, platformS = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const r = roomN(x + dx, y + dy);
      if (!r || r.roof) continue;
      if (r.station) { station = true; if (dy === 1) platformS = true; } else { train = true; if (r.id === 'engine') engine = true; }
    }
    if (!train && !station) return 'roof';
    if (train && platformS) return 'side';
    if (train) return engine ? 'iron' : 'walnut';
    return 'station';
  };
  const matOf = k => (k === 'side' ? sideMats : k === 'station' ? stationMat : k === 'iron' ? ironMat : walnutMat);
  wallMat3 = (x, y) => matOf(kindOf(x, y));
  const win = new Set(W3_WINDOWS.map(w => w.x + ',' + w.y));
  const groups = { walnut: [], iron: [], station: [], side: [] };
  for (const [x, y] of list) {
    if (win.has(x + ',' + y)) continue;
    const k = kindOf(x, y);
    if (k !== 'roof') groups[k].push([x, y]);
  }
  const mtx = new THREE.Matrix4();
  const inst = (tiles, mat) => {
    if (!tiles.length) return;
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, CEIL_W3, 1), mat, tiles.length);
    im.userData.ownGeo = true;
    tiles.forEach(([x, y], i) => { mtx.makeTranslation(x + 0.5, CEIL_W3 / 2, y + 0.5); im.setMatrixAt(i, mtx); });
    im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere();
    houseGroup.add(im);
  };
  for (const k in groups) inst(groups[k], matOf(k));
  // 窗戶：牆上真的開一個洞（窗台到 0.9、窗楣 2.35 以上、兩邊留窗框），黃銅窗框、髒玻璃；外面是會捲動的風景（窗戶都在東西向的牆上）
  const brass = lm('#6e5726'), W0 = 0.9, W1 = 2.35;
  panes3 = [];
  for (const w of W3_WINDOWS) {
    const { x, y } = w, g = new THREE.Group(); g.position.set(x, 0, y); houseGroup.add(g);
    const m = matOf(kindOf(x, y));
    wallPiece(g, 0, 1, 0, W0, 0, 1, m); wallPiece(g, 0, 1, W1, CEIL_W3, 0, 1, m);
    wallPiece(g, 0, 0.15, W0, W1, 0, 1, m); wallPiece(g, 0.85, 1, W0, W1, 0, 1, m);
    const fr = (a0, a1, b0, b1) => box(g, a0, a1, b0, b1, 0.47, 0.53, brass, false);
    fr(0.12, 0.88, W0 - 0.02, W0 + 0.03); fr(0.12, 0.88, W1 - 0.02, W1 + 0.03); fr(0.12, 0.17, W0, W1); fr(0.83, 0.88, W0, W1); fr(0.485, 0.515, W0, W1);
    const pm = ownBasic({ map: glassTex, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide, fog: false, color: 0xffffff });
    const pane = new THREE.Mesh(geo('pane3', () => new THREE.PlaneGeometry(0.7, W1 - W0)), pm);
    pane.position.set(0.5, (W0 + W1) / 2, 0.5);
    g.add(pane); panes3.push(pm);
    // 列車的窗戶：車廂那一側掛著暗紅絨布的窗簾，列車開的時候會微微飄（用頭髮的做法）
    if (w.train) {
      const cm = hairMat(velvetTex, 0.55), S = [];
      for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
        const u = 0.5 + side * (0.42 + k * 0.05), zz = 1.04 + k * 0.01;
        S.push({ a: [u, 2.5, zz], b: [u + side * 0.02, 1.7, zz + 0.02], c: [u + side * 0.05, 0.8, zz + 0.03], w: 0.09, f: 0, ph: k + side * 2, tp: 0.1 });
      }
      const cur = new THREE.Mesh(hairGeo(`curtain${x},${y}`, S), cm);
      if (w.dir === 's') { cur.position.z = 1; cur.scale.z = -1; }   // 南牆的窗：窗簾翻到北邊（車廂裡）
      cur.userData.ownGeo = true; g.add(cur);
      curtains.push(cm.userData.hair);
    }
  }
}
// 包廂的滑門（打開時滑進旁邊的牆裡）和車站側的車門（晚上鎖起來）
function addDoorPanel(d, g, eastWest) {
  const face = patchLM(new THREE.MeshLambertMaterial({ map: d.station ? carriageDoorTex : doorPanelTex })); face.userData.own = true;
  const edge = lm('#2a1a10');
  const pm = new THREE.Mesh(geo('doorpanel', () => new THREE.BoxGeometry(0.94, 2.12, 0.07)), [edge, edge, edge, edge, face, face]);
  const piv = new THREE.Group(); piv.position.set(0.5, 1.06, 0.5); g.add(piv);
  if (eastWest) piv.rotation.y = Math.PI / 2;   // 通道東西向：門板要橫跨南北
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
// ---------- 車外的風景：地圖南北各放幾層大貼圖，列車往西開的時候往東捲（遠的慢、近的快）；地上是會往後跑的碎石路基和平行的鐵軌 ----------
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
  // 北面（列車的窗戶、車頂看出去）和南面（車站的窗戶）各三層加白天的站場；東西面只有遠山和中景（正面的風景不會捲動）
  for (const [z, ry, dir] of [[-12, 0, -1], [MAP_H + 12, Math.PI, 1]]) {
    const back = dir < 0 ? -1 : 1;   // 往地圖外面是哪個方向（北面是 -z）：中景、近景、站場都往地圖裡面放，才會在遠景前面
    mk(skyFarTex, 300, 26, cx, 6, z, ry, true, 0.012).dir = dir;
    mk(skyTopTex, 300, 50, cx, 44, z, ry, true, 0);
    const mid = mk(midTexes.plain, 230, 9, cx, 3.2, z - back * 7, ry, false, 0.07); mid.dir = dir; mid.isMid = true;
    const nearIn = dir < 0 ? 11.5 : 8;   // 南面是車站，近景和站場離候車室的南牆遠一點（不然從窗戶看像貼在玻璃上）
    const near = mk(nearTex, 200, 6, cx, 2.6, z - back * nearIn, ry, false, 0.24); near.dir = dir; near.isNear = true;
    const yard = mk(yardTex, 200, 7, cx, 2.9, z - back * (nearIn + 0.3), ry, false, 0); yard.isYard = true;
  }
  for (const [x, ry] of [[-15, Math.PI / 2], [MAP_W + 15, -Math.PI / 2]]) {
    mk(skyFarTex, 240, 26, x, 6, cz, ry, true, 0);
    mk(skyTopTex, 240, 50, x, 44, cz, ry, true, 0);
    const mid = mk(midTexes.plain, 170, 9, x + (x < 0 ? 7 : -7), 3.2, cz, ry, false, 0); mid.isMid = true;
  }
  // 頭頂的藍天白雲：一大片蓋在整張地圖上面（露天的月台、車頂抬頭看得到），列車開的時候雲慢慢往後飄
  const ct = cloudTex.clone(); ct.needsUpdate = true; ct.repeat.set((MAP_W + 40) / 40, (MAP_H + 30) / 40);
  const cmat = new THREE.MeshBasicMaterial({ map: ct, fog: false, side: THREE.DoubleSide }); cmat.userData.own = true;
  const sky = new THREE.Mesh(geo(`sky${MAP_W}x${MAP_H}`, () => new THREE.PlaneGeometry(MAP_W + 40, MAP_H + 30)), cmat);
  sky.rotation.x = Math.PI / 2; sky.position.set(cx, 16, cz); backdrop.g.add(sky);   // 放低一點，從車窗抬頭也看得到雲
  backdrop.layers.push({ m: sky, t: ct, speed: 0.006, dir: -1, isSky: true });
  // 地面：在車廂地板下面 1.2 公尺，從車頂的邊緣、窗戶往下看得到；列車開的時候跟著往後跑
  const gt = ballastTex.clone(); gt.needsUpdate = true; gt.repeat.set(300 / 4, (MAP_H + 28) / 4);
  const gm = new THREE.MeshBasicMaterial({ map: gt }); gm.userData.own = true;
  const ground = new THREE.Mesh(geo(`ground${MAP_W}x${MAP_H}`, () => new THREE.PlaneGeometry(300, MAP_H + 28)), gm);
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -1.2, cz); backdrop.g.add(ground);
  backdrop.layers.push({ m: ground, t: gt, speed: 1.44, dir: -1, isGround: true });
  backdrop.moon = ownSprite(moonTex, 0xfff4d0); backdrop.moon.scale.setScalar(4.5); backdrop.moon.position.set(cx - 14, 12, -11.5); backdrop.g.add(backdrop.moon);
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
    // 換成那一種中景的圖（換 source，不要改 image：image 是跟原本的貼圖共用的，改了草原那張就回不來了）
    for (const L of backdrop.layers) if (L.isMid) { L.t.source = tex.source; L.t.needsUpdate = true; }
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
  // 窗簾：列車在開的時候飄得比較厲害
  for (const u of curtains) { u.uHT.value = t; u.uHAmp.value = 0.012 + 0.03 * k; }
  syncLocoSmoke(dt, k);
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
let velvetMat = null;
const velvet = () => velvetMat || (velvetMat = patchLM(new THREE.MeshLambertMaterial({ map: velvetTex })));
// 以「正面」為準的位置（u 沿著正面、v 從正面往內）換算成家具的本地座標；faceOf 是朝著正面的角度
function fpos(f, side, u, v) {
  const W = f.w, D = f.h;
  if (side === 's') return [u, D - v];
  if (side === 'n') return [u, v];
  if (side === 'e') return [W - v, u];
  return [v, u];
}
const faceOf = side => ({ s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 })[side];
// ====================================================================
// 第三世界的乘客：寫實、形形色色的 1920 年代乘客
// 紳士、摩登女郎、老婆婆、學生、和服婦人、工人、胖商人、老先生、穿袴的女學生、車掌；膚色、髮色、衣服的顏色和花紋每個都不一樣
// 平常（都死了）：臉色灰白、閉著眼，頭垂著、歪著或往後仰，一動也不動；過場動畫上車那一段還活著（膚色正常、睜著眼、坐直）
// 夜晚事件「乘客轉頭」：頭慢慢抬起來轉向你，眼睛睜開，是混濁的死人眼
// 臉和衣服的花紋都用畫布畫。一個乘客有幾十塊零件，做好之後合併成四、五個網格（純色的零件用頂點顏色合成一個），平板上才不會卡
// 乘客自己的座標：y 從地板往上、+z 是面向的方向；z = -0.2 是背靠著椅背的地方，seat 是座面的高度
// ====================================================================
const PAX_TEX = 256, PAX_SHADE = 0.5, PAX_JAW = 0.22;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, k) => { const A = hexRGB(a), B = hexRGB(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join(''); };
const rgbaOf = (h, al) => `rgba(${hexRGB(h).join(',')},${al})`;
const pickR = a => a[(rnd() * a.length) | 0];
const PAX_SKIN = ['#f1d8c4', '#e9c7a8', '#dcb28c', '#c99870', '#a37050', '#70472f'];
const PAX_DARK = ['#15110e', '#2b1d14', '#4a3020'];
// 頭的大小（公尺）：男、女、胖
const PAX_HEADS = { m: { key: 'm', rx: 0.077, ry: 0.107, rz: 0.094 }, f: { key: 'f', rx: 0.072, ry: 0.101, rz: 0.089 }, h: { key: 'h', rx: 0.085, ry: 0.108, rz: 0.097 } };
const PAX_KINDS = {
  // 紳士：三件式西裝、白襯衫打領帶、圓頂禮帽、修得很整齊的小鬍子
  gent: () => ({ sex: 'm', age: 0.3 + rnd() * 0.35, skin: pickR(PAX_SKIN), hair: pickR([...PAX_DARK, '#6b3a22', '#a8874f']), style: 'short',
    hat: rnd() < 0.75 ? 'bowler' : null, hatCol: pickR(['#14120f', '#2a2018', '#2c2c30']), bandCol: '#0c0b0a',
    top: 'suit', c1: pickR(['#2b2b30', '#232a3c', '#3b2d22', '#4b4b50']), c2: pickR(['#6e1f26', '#1f2c4c', '#2a4a34', '#5a4420']),
    legs: 'trousers', shoe: 'men', collar: 'shirt', cuff: '#e8e4da', hands: 'lap', mustache: rnd() < 0.6 ? 'thin' : null }),
  // 摩登女郎：壓得低低的鐘形帽、鮑伯頭、毛領大衣、長長的珍珠項鍊、手套、紅唇，腿上放著手提包
  lady: () => ({ sex: 'f', age: 0.15 + rnd() * 0.25, skin: pickR(PAX_SKIN.slice(0, 5)), hair: pickR([...PAX_DARK, '#6b3a22', '#a8874f']), style: 'bob',
    hat: 'cloche', hatCol: pickR(['#5a1f2a', '#1f2a44', '#5a5650', '#8a6a48', '#1c1a1e']), bandCol: pickR(['#c9a24a', '#1c1a1e', '#e0d6c4', '#7a1a24']),
    top: 'coat', c1: pickR(['#9a7450', '#5e2228', '#24484a', '#4a2a44', '#2a2a30']), c2: pickR(['#7a1a2a', '#e0d6c4', '#2a3a5a']),
    legs: 'skirt', shoe: 'heel', shoeCol: pickR(['#141210', '#4a1a1e']), collar: 'fur', collarCol: pickR(['#8a6a4a', '#d8d0c0', '#3a2a20', '#6a6460']),
    hands: 'bag', bagCol: pickR(['#2a1a14', '#5a2a1a', '#1c1c20']), glove: pickR(['#e8e0d0', '#1c1a1e', '#5a3a2a']), makeup: true, lips: '#8e2228' }),
  // 老婆婆：灰白的髮髻、披肩、開襟毛衣、駝著背，手上捏著手帕
  granny: () => ({ sex: 'f', age: 0.85 + rnd() * 0.15, skin: pickR(PAX_SKIN.slice(0, 5)), hair: pickR(['#8e8a84', '#b4b0aa', '#d8d4cc']), style: 'bun',
    top: 'cardigan', c1: pickR(['#6a5a4c', '#7a5858', '#5a5a44', '#4a4e58']), c2: '#d8cfbd', legs: 'long', legCol: pickR(['#2a2622', '#3a3230', '#2c2a34']),
    shoe: 'men', collar: 'shawl', collarCol: pickR(['#3a3436', '#4a3a30', '#5a4a4a', '#2e3a3a']), hands: 'kerchief', glasses: rnd() < 0.4, hunch: 0.16 }),
  // 學生：立領的黑色學生服、一排金色鈕扣、學生帽，腿上放著課本
  student: () => ({ sex: 'm', age: 0, skin: pickR(PAX_SKIN.slice(1, 5)), hair: pickR(PAX_DARK.slice(0, 2)), style: 'short',
    hat: 'student', hatCol: '#141418', top: 'gakuran', c1: '#17181d', legs: 'trousers', shoe: 'men', collar: 'stand', collarCol: '#17181d', collarTrim: '#e8e4da',
    hands: 'book', bookCol: pickR(['#5a1e1e', '#1e3a2a', '#2a2a4a', '#5a4a2a']), glasses: rnd() < 0.35 }),
  // 和服婦人：花紋和服、寬腰帶、盤起來的日本髮髻和髮簪
  kimono: () => ({ sex: 'f', age: 0.3 + rnd() * 0.25, skin: pickR(PAX_SKIN.slice(0, 3)), hair: '#15110e', style: 'updo',
    top: 'kimono', pat: pickR(['flower', 'asanoha', 'flower']), c1: pickR(['#26304a', '#5a2a40', '#245250', '#6a1f24', '#4a3a5a']), c2: pickR(['#e8d8c8', '#e8b8c0', '#d8c080']),
    c3: pickR(['#b8964a', '#8a2a2a', '#d8ccb0', '#2a2a2a']), c4: pickR(['#c83a4a', '#e8e0d0', '#3a6a8a']),
    legs: 'kimono', shoe: 'zori', hands: 'folded', lips: '#a8242c', smallLips: true }),
  // 工人：鴨舌帽、背心、袖子捲到手肘、鬍渣，手上攤開一份報紙
  worker: () => ({ sex: 'm', age: 0.3 + rnd() * 0.3, skin: pickR(PAX_SKIN.slice(2)), hair: pickR(PAX_DARK), style: 'short',
    hat: 'flat', hatCol: pickR(['#3a342c', '#4a4238', '#2c2e30']), top: 'vest', c1: pickR(['#cfc8b6', '#8090a4', '#b8b0a0']), c2: pickR(['#3e3026', '#45454a', '#2a2624']), stripe: rnd() < 0.5,
    rolled: true, legs: 'trousers', legCol: pickR(['#3a3630', '#2e3440', '#4a3e30']), shoe: 'boot', shoeCol: '#2a1e16', hands: 'paper', stubble: true }),
  // 胖商人：禿頭、八字鬍、背心上掛著懷錶鏈，兩手放在肚子上
  merchant: () => ({ sex: 'm', age: 0.5 + rnd() * 0.2, build: 'h', skin: pickR(PAX_SKIN.slice(0, 5)), hair: pickR(['#4a3020', '#8e8a84', '#2b1d14']), style: 'bald',
    top: 'vestW', c1: '#e4e0d6', c2: pickR(['#4a1f24', '#22332a', '#3a2a1c']), c3: pickR(['#1c1a1e', '#6e1f26', '#2a3a5a']),
    legs: 'trousers', legCol: pickR(['#2a2a2e', '#3a3026']), shoe: 'men', collar: 'shirt', hands: 'belly', mustache: 'walrus' }),
  // 老先生：白髮、白鬍子、圓眼鏡、粗呢大衣和圍巾，兩手拄著拐杖
  oldman: () => ({ sex: 'm', age: 0.9 + rnd() * 0.1, skin: pickR(PAX_SKIN), hair: '#d8d4cc', style: 'thin',
    top: 'tweed', c1: pickR(['#5a5048', '#4a4a44', '#5a4a3a']), legs: 'trousers', legCol: pickR(['#3a3632', '#2e2e30']), shoe: 'men', shoeCol: '#2a1a10',
    collar: 'scarf', collarCol: pickR(['#6a2026', '#2a3a5a', '#5a4a2a']), hands: 'cane', beard: true, glasses: true }),
  // 女學生（大正時代）：矢絣花紋的和服配深紅的袴、半束的長髮綁著大緞帶、皮靴
  girl: () => ({ sex: 'f', age: 0, sc: 0.94, skin: pickR(PAX_SKIN.slice(0, 4)), hair: pickR(PAX_DARK.slice(0, 2)), style: 'half', ribbon: pickR(['#b0222a', '#e8e0d0', '#3a5a8a', '#6a2a6a']),
    top: 'hakama', pat: 'yagasuri', c1: pickR(['#5a2a6a', '#8a2a3a', '#2a3a6a']), c2: '#ece4ea', c3: pickR(['#5a1e2e', '#3a1e3a', '#2a2a40']),
    legs: 'hakama', shoe: 'boot', shoeCol: '#4a2e1a', hands: 'folded' }),
  // 車掌：深藍色制服、兩排金扣子、立領、有帽徽的大盤帽
  conductor: () => ({ sex: 'm', age: 0.4 + rnd() * 0.3, skin: pickR(PAX_SKIN), hair: pickR([...PAX_DARK, '#8e8a84']), style: 'short',
    hat: 'conductor', hatCol: '#1a2134', top: 'uniform', c1: '#1b2236', legs: 'trousers', shoe: 'men', collar: 'stand', collarCol: '#1b2236', collarTrim: '#c9a24a',
    cuff: '#c9a24a', hands: 'lap', mustache: rnd() < 0.5 ? 'thin' : null }),
};
// 死掉的姿勢：頭往前垂、歪向一邊、往後仰（嘴巴開開的）、直挺挺地坐著
const PAX_POSES = { slump: [0.62, 0.15], side: [0.18, 0.5], back: [-0.42, 0.1], still: [0.06, 0] };
function paxSpec(kind) {
  const p = { kind, sc: 1, ...PAX_KINDS[kind]() };
  p.build = p.build || p.sex;
  p.hd = PAX_HEADS[p.build];
  p.sc *= 0.96 + rnd() * 0.08;
  // 死人的膚色：往同樣深淺的青灰色靠（深膚色的人還是深的，只是沒了血色）
  const [sr, sg, sb] = hexRGB(p.skin), lum = 0.3 * sr + 0.59 * sg + 0.11 * sb;
  p.deadSkin = mixHex(p.skin, '#' + [0.95, 0.98, 1.05].map(k => Math.round(clamp(lum * k, 0, 255)).toString(16).padStart(2, '0')).join(''), 0.6);
  p.iris = p.skin === PAX_SKIN[0] && rnd() < 0.6 ? pickR(['#4a6a8a', '#5a6a4a', '#6a6a6a']) : pickR(['#2a1a10', '#3a2414', '#4a3018']);
  p.brow = p.age > 0.8 ? mixHex(p.hair, '#8a8680', 0.3) : mixHex(p.hair, '#000000', 0.1);
  p.lips = p.lips || mixHex(p.skin, p.sex === 'f' ? '#a24a4a' : '#8a4a44', p.sex === 'f' ? 0.45 : 0.35);
  p.shoeCol = p.shoeCol || pickR(['#141210', '#3a2416']);
  p.legCol = p.legCol || (p.legs === 'hakama' ? p.c3 : p.c1);
  p.sleeve = p.c1;
  p.torsoH = p.build === 'h' ? 0.62 : p.sex === 'f' ? 0.58 : 0.6;
  p.pose = p.hands === 'paper' ? 'slump' : p.kind === 'granny' ? pickR(['slump', 'side']) : pickR(['slump', 'side', 'back', 'still', 'slump', 'side']);
  const [px, pz] = PAX_POSES[p.pose], s = rnd() < 0.5 ? -1 : 1;
  p.deadPose = { x: px, y: 0, z: pz * s };
  p.alivePose = { x: p.hands === 'paper' ? 0.32 : 0.05, y: 0, z: 0 };
  return p;
}
// 每種乘客輪流出現，相鄰的才不會一樣；prefer 是這個位置比較適合的種類（例如餐車多半是穿得體面的人）
let paxBag = [];
function paxNextKind(prefer) {
  if (!paxBag.length) {
    paxBag = Object.keys(PAX_KINDS);
    for (let i = paxBag.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [paxBag[i], paxBag[j]] = [paxBag[j], paxBag[i]]; }
  }
  const i = prefer ? Math.max(0, paxBag.findIndex(k => prefer.includes(k))) : 0;
  return paxBag.splice(i, 1)[0];
}

// ---------- 材質 ----------
// 純色零件用的「假材質」：只記顏色，合併時換成頂點顏色；skin 是皮膚（活著和死掉的顏色不同）、hair 是頭髮（有髮絲的紋路）
const paxColCache = new Map();
function pcol(color, flag = '') {
  const key = color + flag;
  let m = paxColCache.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial(); Object.assign(m.userData, { vc: color, skin: flag === 'skin', hair: flag === 'hair' }); paxColCache.set(key, m); }
  return m;
}
let paxVCMatC = null, paxHairMatC = null, paxPaperMatC = null;
const paxVCMat = () => paxVCMatC || (paxVCMatC = patchLM(new THREE.MeshLambertMaterial({ vertexColors: true }), PAX_SHADE));
function paxHairMat() {
  if (paxHairMatC) return paxHairMatC;
  // 一絲一絲的灰階髮絲，顏色用頂點顏色乘上去
  const t = canvasTex(64, 128, (c, w, h) => {
    c.fillStyle = '#d8d8d8'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      const v = 110 + rnd() * 145 | 0, x = rnd() * w;
      c.strokeStyle = `rgba(${v},${v},${v},.6)`; c.lineWidth = 0.6 + rnd();
      c.beginPath(); c.moveTo(x, 0); c.bezierCurveTo(x + (rnd() - 0.5) * 6, h * 0.3, x + (rnd() - 0.5) * 6, h * 0.7, x + (rnd() - 0.5) * 4, h); c.stroke();
    }
  });
  t.repeat.set(6, 1);
  return (paxHairMatC = patchLM(new THREE.MeshLambertMaterial({ vertexColors: true, map: t, side: THREE.DoubleSide }), PAX_SHADE));
}
// 自己畫的貼圖（臉、衣服）：材質和貼圖都跟著家具一起丟掉
function paxTexMat(maps, opts = {}) {
  const m = patchLM(new THREE.MeshLambertMaterial({ map: maps[0], ...opts }), PAX_SHADE);
  m.userData.own = true; m.userData.maps = maps;
  return m;
}
// 報紙：報頭「末班日報」、頭條、一欄一欄的字和一張照片
function paxPaperMat() {
  if (paxPaperMatC) return paxPaperMatC;
  const t = canvasTex(512, 384, (c, w, h) => {
    c.fillStyle = '#d9d1bd'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#2a2622'; c.textAlign = 'center';
    c.font = 'bold 40px "Songti TC","Noto Serif TC","PingFang TC",serif'; c.fillText('末班日報', w / 4, 48);
    c.font = 'bold 32px "Songti TC","Noto Serif TC","PingFang TC",serif'; c.fillText('乘客全數失蹤', w * 3 / 4, 46);
    for (const x0 of [0, w / 2]) {
      c.fillRect(x0 + 14, 60, w / 2 - 28, 3);
      for (let col = 0; col < 4; col++) for (let y = 72; y < h - 14; y += 8) {
        if (x0 > 0 && col < 2 && y < 180) continue;
        if (rnd() < 0.06) continue;
        c.fillStyle = `rgba(40,36,32,${0.35 + rnd() * 0.3})`; c.fillRect(x0 + 18 + col * 58, y, 50 * (0.55 + rnd() * 0.45), 3);
      }
    }
    // 照片：黑黑的一列火車
    c.fillStyle = '#7a7468'; c.fillRect(w / 2 + 18, 72, 108, 100);
    c.fillStyle = '#2a2622'; c.fillRect(w / 2 + 24, 120, 96, 30); c.fillRect(w / 2 + 30, 104, 14, 18);
    for (let i = 0; i < 4; i++) { c.fillStyle = '#c8c0a8'; c.fillRect(w / 2 + 50 + i * 18, 126, 10, 8); }
    for (let i = 0; i < 8; i++) { c.fillStyle = `rgba(140,110,60,${0.08 + rnd() * 0.12})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, 10 + rnd() * 30, 8 + rnd() * 20, rnd() * 3, 0, 7); c.fill(); }
    c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(w / 2 - 1, 0, 2, h);
  });
  return (paxPaperMatC = patchLM(new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide }), PAX_SHADE));
}

// ---------- 合併零件 ----------
const _pv = new THREE.Vector3(), _pn = new THREE.Matrix3(), _pc = new THREE.Color(), _pa = new THREE.Vector3(), _pw = new THREE.Vector3();
// 把 root 底下的零件照材質合成幾個網格：純色的零件合成一個頂點顏色的網格，頭髮另外一個；皮膚的頂點範圍記在 skins（換膚色用）
function paxMerge(root, skins) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), buckets = new Map(), parts = [];
  root.traverse(o => { if (o.isMesh) parts.push(o); });
  for (const o of parts) {
    const u = o.material.userData, key = u.vc ? (u.hair ? 'hair' : 'vc') : o.material.uuid;
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { mat: u.vc ? (u.hair ? paxHairMat() : paxVCMat()) : o.material, list: [] });
    b.list.push({ o, m: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
  }
  for (const b of buckets.values()) {
    if (b.list.length === 1 && !b.mat.vertexColors) continue;   // 只有一塊（頭、身體）就不用合併
    let nv = 0, ni = 0;
    for (const { o } of b.list) { nv += o.geometry.attributes.position.count; ni += o.geometry.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = b.mat.vertexColors ? new Float32Array(nv * 3) : null, idx = new Uint32Array(ni), skinR = [];
    let vo = 0, io = 0;
    for (const { o, m } of b.list) {
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, I = g.index, n = P.count;
      _pn.getNormalMatrix(m);
      if (col) _pc.set(o.material.userData.vc);
      for (let i = 0; i < n; i++) {
        const k = (vo + i) * 3;
        _pv.fromBufferAttribute(P, i).applyMatrix4(m); pos[k] = _pv.x; pos[k + 1] = _pv.y; pos[k + 2] = _pv.z;
        _pv.fromBufferAttribute(N, i).applyMatrix3(_pn).normalize(); nor[k] = _pv.x; nor[k + 1] = _pv.y; nor[k + 2] = _pv.z;
        if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
        if (col) { col[k] = _pc.r; col[k + 1] = _pc.g; col[k + 2] = _pc.b; }
      }
      for (let i = 0; i < I.count; i++) idx[io++] = I.getX(i) + vo;
      if (col && o.material.userData.skin) skinR.push(vo, n);
      vo += n;
      o.parent.remove(o);
      if (o.userData.ownGeo) g.dispose();
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); mg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) mg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mg.setIndex(new THREE.BufferAttribute(idx, 1));
    mg.computeBoundingSphere();
    const mesh = new THREE.Mesh(mg, b.mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.ownGeo = true;
    root.add(mesh);
    if (skinR.length) skins.push({ attr: mg.attributes.color, r: skinR });
  }
}

// ---------- 小零件 ----------
const pel = (g, x, y, z, sx, sy, sz, mat, seg = 8) => sph(g, 1, x, y, z, mat, sx, sy, sz, seg);
function pmesh(g, gm, mat, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(gm, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.set(rx, ry, rz); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
}
// 兩點之間的膠囊（手腳）：兩頭是圓的，關節接起來才不會有縫
function pcap(g, a, b, r, mat) {
  const d = _pa.subVectors(b, a), l = Math.max(0.01, Math.round(d.length() * 100) / 100);
  const m = new THREE.Mesh(geo(`pcap${r},${l}`, () => new THREE.CapsuleGeometry(r, l, 2, 8)), mat);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  g.add(m);
  return m;
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const P_DOME = () => geo('paxDome', () => new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2));
const P_DISC = () => geo('paxDisc', () => new THREE.CylinderGeometry(1, 1, 1, 24));
const P_RING = () => geo('paxRing', () => new THREE.CylinderGeometry(1, 1, 1, 24, 1, true));
const P_VISOR = () => geo('paxVisor', () => new THREE.CylinderGeometry(1, 1, 1, 14, 1, false, -Math.PI / 2, Math.PI));
// 手肘的位置：從肩膀和手的位置反推（往外、往下、往後彎）
function paxElbow(sh, h, lu, lf, pole) {
  const d = h.clone().sub(sh), len = Math.min(d.length(), lu + lf - 0.001), dir = d.normalize();
  const a = (lu * lu - lf * lf + len * len) / (2 * len), hh = Math.sqrt(Math.max(0, lu * lu - a * a));
  const n = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
  return sh.clone().addScaledVector(dir, a).addScaledVector(n, hh);
}

// ---------- 頭 ----------
// 單位球上的點 → 頭的形狀：下巴和下顎比較窄、後腦勺凸一點、脖子後面收進去
function paxHeadPt(x, y, z, hd, out) {
  if (y < 0) { const t = -y; x *= 1 - PAX_JAW * t * t; z *= z > 0 ? 1 - 0.06 * t * t : 1 - 0.25 * t * t; }
  if (z < 0) z *= 1 + 0.06 * sstep(-0.6, 0, y);
  return out.set(x * hd.rx, y * hd.ry, z * hd.rz);
}
// 頭：貼圖只畫前半個頭（左右各 90°），後腦勺用貼圖最左、最右一欄的顏色（頭髮或脖子）
function paxHeadGeo(hd) {
  return geo('paxhead' + hd.key, () => {
    const g = new THREE.SphereGeometry(1, 28, 20, -Math.PI / 2), P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) { paxHeadPt(P.getX(i), P.getY(i), P.getZ(i), hd, _pv); P.setXYZ(i, _pv.x, _pv.y, _pv.z); U.setX(i, U.getX(i) * 2 - 0.5); }
    g.computeVertexNormals();
    return g;
  });
}
// 頭髮蓋住的範圍：a 是從正面往右轉的角度、th 是從頭頂往下的角度；回傳離髮際線多遠（正的是頭髮）。畫在臉上的頭髮和頭髮的立體形狀都照這個
function paxHairLine(style) {
  const A = Math.abs;
  switch (style) {
    case 'bald': return (a, th) => Math.min(th - 1.05 - 2 * (1 - sstep(0.85, 1.25, A(a))), 1.95 - th);   // 禿頭：只剩耳朵上面和後腦勺一圈
    case 'thin': return (a, th) => 0.62 - 0.16 * Math.exp(-(((A(a) - 0.5) / 0.2) ** 2)) + 0.98 * sstep(0.7, 1.25, A(a)) + 0.35 * sstep(1.35, 1.57, A(a)) - th;   // 額頭兩邊禿上去
    case 'bob': return (a, th) => 0.8 + 0.05 * Math.sin(a * 3) + 1.42 * sstep(0.85, 1.12, A(a)) - th;   // 鮑伯頭：兩邊蓋住耳朵到下巴
    case 'half': return (a, th) => 0.8 + 1.55 * sstep(0.88, 1.12, A(a)) - th;
    case 'bun': case 'updo': return (a, th) => 0.8 + 0.8 * sstep(0.62, 1.2, A(a)) + 0.32 * sstep(1.35, 1.57, A(a)) - th;   // 往上梳，露出後頸
    default: return (a, th) => 0.86 + 0.76 * sstep(0.62, 1.2, A(a)) + 0.36 * sstep(1.35, 1.57, A(a)) - th;   // 短髮：鬢角到耳朵中間
  }
}
// 頭髮的厚度（公尺）
const PAX_HAIR_T = {
  short: (a, th, d) => 0.003 + 0.011 * sstep(0, 0.3, d),
  thin: (a, th, d) => 0.002 + 0.005 * sstep(0, 0.3, d),
  bald: (a, th, d) => 0.002 + 0.005 * sstep(0, 0.12, d),
  bob: (a, th, d) => 0.004 + 0.012 * sstep(0, 0.25, d) + 0.014 * sstep(1.5, 2.1, th) * sstep(0.85, 1.2, Math.abs(a)),
  half: (a, th, d) => 0.004 + 0.012 * sstep(0, 0.25, d) + 0.01 * sstep(1.5, 2.2, th),
  bun: (a, th, d) => 0.003 + 0.009 * sstep(0, 0.3, d),
  updo: (a, th, d) => 0.004 + 0.01 * sstep(0, 0.3, d) + 0.02 * Math.exp(-(((th - 1.3) / 0.3) ** 2)) * sstep(0.7, 1.3, Math.abs(a)),
};
// 頭髮：從同一顆頭的網格裡挑出頭髮蓋住的三角形，往外推出厚度（髮際線那邊薄到貼著皮膚）
function paxHairGeo(style, hd, hat) {
  return geo('paxhair' + style + hd.key + (hat ? 'h' : ''), () => {
    const g = new THREE.SphereGeometry(1, 28, 20, -Math.PI / 2), P = g.attributes.position, I = g.index.array, fn = paxHairLine(style), T = PAX_HAIR_T[style] || PAX_HAIR_T.short;
    const d = new Float32Array(P.count), keep = [];
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i), a = Math.atan2(x, z), th = Math.acos(clamp(y, -1, 1));
      d[i] = fn(a, th);
      paxHeadPt(x, y, z, hd, _pv);
      const len = _pv.length() || 1;
      _pv.multiplyScalar((len + T(a, th, Math.max(0, d[i])) * (hat ? 0.15 + 0.85 * sstep(0.9, 1.4, th) : 1)) / len);
      P.setXYZ(i, _pv.x, _pv.y, _pv.z);
    }
    for (let k = 0; k < I.length; k += 3) { const a = d[I[k]], b = d[I[k + 1]], c = d[I[k + 2]]; if (Math.max(a, b, c) > 0 && a + b + c > -0.06) keep.push(I[k], I[k + 1], I[k + 2]); }
    g.setIndex(keep);
    g.computeVertexNormals();
    return g;
  });
}
// 臉上的位置（公分，以頭的中心為原點，x 往右、y 往上）→ 貼圖上的位置
function paxFaceMap(hd, x, y) {
  const v = clamp(y / 100 / hd.ry, -0.995, 0.995), th = Math.acos(v), t = Math.max(0, -v);
  const u = clamp(x / 100 / (hd.rx * (1 - PAX_JAW * t * t) * Math.sin(th)), -0.995, 0.995);
  return [PAX_TEX / 2 + Math.asin(u) * PAX_TEX / Math.PI, th * PAX_TEX / Math.PI];
}
// 畫臉：st 是 alive（活著，睜眼）、dead（死了，閉眼）、stare（死了，轉過頭來睜著混濁的眼睛）
function paintPaxHead(c, p, st) {
  const S = PAX_TEX, hd = p.hd, dead = st !== 'alive', f = p.sex === 'f', age = p.age;
  const skin = dead ? p.deadSkin : p.skin, sh = mixHex(skin, dead ? '#2a2a3a' : '#4a2418', 0.4);
  // 在臉上某一點畫東西：在那附近把座標換成公分（y 往上），mirror = -1 左右翻過來（左右對稱的五官）
  const at = (x, y, fn, mirror = 1) => {
    const [X, Y] = paxFaceMap(hd, x, y), [X1] = paxFaceMap(hd, x + 0.25, y), [, Y1] = paxFaceMap(hd, x, y + 0.25);
    c.save(); c.setTransform((X1 - X) / 0.25 * mirror, 0, 0, (Y1 - Y) / 0.25, X, Y); fn(); c.restore();
  };
  // soft：邊緣淡出的一團顏色（陰影、紅暈），比實心的橢圓自然
  const soft = (x, y, rx, ry, col, a) => { c.save(); c.translate(x, y); c.scale(rx, ry); const g = c.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, rgbaOf(col, a)); g.addColorStop(1, rgbaOf(col, 0)); c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 7); c.fill(); c.restore(); };
  const ell = (x, y, rx, ry, col) => { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fill(); };
  const curve = (pts, col, w) => {
    c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.beginPath(); c.moveTo(pts[0], pts[1]);
    if (pts.length === 6) c.quadraticCurveTo(pts[2], pts[3], pts[4], pts[5]); else c.lineTo(pts[2], pts[3]);
    c.stroke();
  };
  c.fillStyle = skin; c.fillRect(0, 0, S, S);
  for (let i = 0; i < 500; i++) { c.fillStyle = rgbaOf(sh, 0.035); c.fillRect(rnd() * S, rnd() * S, 2, 2); }
  const gd = c.createLinearGradient(0, S * 0.72, 0, S); gd.addColorStop(0, rgbaOf(sh, 0)); gd.addColorStop(1, rgbaOf(sh, 0.6));
  c.fillStyle = gd; c.fillRect(0, S * 0.72, S, S * 0.28);   // 下巴底下比較暗
  // 整張臉的明暗：額頭和鼻樑比較亮、太陽穴和兩頰外側比較暗、眉毛底下凹進去；男生下巴有一點青青的鬍渣影
  at(0, 0, () => {
    soft(0, 4.6, 4.6, 2.6, '#ffffff', dead ? 0.06 : 0.1);
    for (const s of [-1, 1]) { soft(s * 5.8, 0.5, 2.6, 6.5, sh, 0.35); soft(s * 4.6, -4.5, 2.2, 3.5, sh, 0.22); soft(s * 3.0, 1.7, 2.3, 0.9, sh, dead ? 0.35 : 0.22); }
    soft(0, -1.6, 0.9, 2.2, '#ffffff', 0.07);
    if (!f && !p.beard) soft(0, -7.2, 4.2, 2.8, '#3a4048', 0.13);
  });
  // 臉頰：活著是紅潤的，死了是凹陷、發青的
  for (const s of [-1, 1]) at(s * 3.7, -2.6, () => soft(0, 0, 2.6, 2.2, dead ? '#505a6e' : '#c8604f', dead ? 0.22 : f ? 0.25 : 0.14));
  // 眼睛
  const ex = f ? 3.0 : 3.15, ey = 0.9, ew = f ? 1.35 : 1.4;
  for (const s of [-1, 1]) at(s * ex, ey, () => {
    soft(0.1, 0.2, 2.3, 1.5, sh, dead ? 0.42 : 0.2);                   // 眼窩的影子
    if (dead) soft(0.2, -1.0, 1.8, 0.8, '#463c5f', 0.35);              // 發青的眼袋
    if (p.makeup) soft(0.1, 0.6, 1.8, 0.9, '#46283c', 0.45);            // 眼影
    if (st === 'dead') {
      // 閉著的眼睛：往下彎的眼皮線（女生有睫毛）
      c.fillStyle = rgbaOf(sh, 0.22); c.beginPath(); c.moveTo(-ew, -0.05); c.quadraticCurveTo(-0.1, 1.05, ew, 0.15); c.quadraticCurveTo(0, -0.5, -ew, -0.05); c.fill();
      curve([-ew, -0.05, 0, -0.5, ew, 0.15], '#2a1a16', f ? 0.24 : 0.17);
      if (f) for (let i = 1; i < 7; i++) {
        const t = i / 7, x = ew * (2 * t - 1), y = (1 - t) * (1 - t) * -0.05 + 2 * (1 - t) * t * -0.25 + t * t * 0.15;
        curve([x, y, x + (t - 0.3) * 0.3, y - 0.4], '#2a1a16', 0.08);
      }
    } else {
      const path = () => { c.beginPath(); c.moveTo(-ew, -0.05); c.quadraticCurveTo(-0.15, 1.05, ew, 0.18); c.quadraticCurveTo(0.1, -0.7, -ew, -0.05); c.closePath(); };
      path(); c.fillStyle = st === 'stare' ? '#c6c4ba' : '#e6dfd2'; c.fill();
      c.save(); path(); c.clip();
      ell(-0.05, 0.12, 0.62, 0.62, st === 'stare' ? mixHex(p.iris, '#a8aaa8', 0.65) : p.iris);   // 虹膜
      ell(-0.05, 0.12, st === 'stare' ? 0.34 : 0.25, st === 'stare' ? 0.34 : 0.25, st === 'stare' ? '#4a4a4c' : '#0a0706');   // 瞳孔
      if (st === 'stare') ell(-0.05, 0.12, 0.7, 0.7, 'rgba(225,230,230,.35)');   // 混濁的一層
      c.fillStyle = 'rgba(40,20,15,.3)'; c.fillRect(-2, 0.45, 4, 1);           // 上眼皮的影子
      c.restore();
      if (st === 'alive') ell(0.15, 0.42, 0.13, 0.13, 'rgba(255,255,255,.85)');
      curve([-ew, -0.05, -0.15, 1.05, ew, 0.18], '#24160f', f ? 0.26 : 0.18);   // 上眼皮和睫毛
      curve([-ew * 0.9, -0.1, 0.1, -0.7, ew * 0.95, 0.12], rgbaOf(sh, 0.5), 0.08);
    }
    curve([-ew * 0.85, 0.75, 0, 1.55, ew * 1.05, 0.85], rgbaOf(sh, 0.45), 0.1);   // 眼皮的摺痕
    if (age > 0.55) {
      curve([-ew * 0.7, -0.75, 0, -1.3, ew * 0.95, -0.6], rgbaOf(sh, age * 0.4), 0.1);   // 眼袋
      for (let k = -1; k <= 1; k++) curve([ew + 0.4, 0.1 + k * 0.35, ew + 1.4, k * 0.6], rgbaOf(sh, (age - 0.4) * 0.45), 0.08);   // 魚尾紋
    }
  }, s);
  // 眉毛
  for (const s of [-1, 1]) at(s * 3.0, 2.55, () => {
    const w = f ? 0.3 : 0.55, arch = f ? 0.9 : 0.45;
    c.globalAlpha = 0.55;
    for (let k = 0; k < 4; k++) curve([-1.85, -0.15 + k * 0.06, 0.1, arch - k * 0.05, 1.75, f ? -0.25 : -0.05], p.brow, w * (1 - k * 0.18));
    c.globalAlpha = 1;
  }, s);
  // 鼻子：鼻樑兩邊的影子、鼻孔、鼻子底下的影子（鼻子本身是立體的）
  at(0, -1.2, () => { for (const s of [-1, 1]) soft(s * 1.05, -0.6, 0.55, 2.0, sh, 0.25); soft(0, -1.6, 0.5, 0.45, '#ffffff', 0.14); });
  for (const s of [-1, 1]) at(s * 0.85, -3.6, () => ell(0, 0, 0.38, 0.2, 'rgba(45,22,18,.55)'));
  at(0, -3.3, () => { soft(0, -0.6, 1.6, 0.5, sh, 0.3); for (const s of [-1, 1]) curve([s * 0.3, -0.9, s * 0.35, -1.9], rgbaOf(sh, 0.25), 0.12); });   // 鼻子底下的影子、人中
  // 法令紋、抬頭紋、嘴角往下的紋
  at(0, -4.6, () => { for (const s of [-1, 1]) curve([s * 1.35, 1.3, s * 2.5, 0.3, s * 2.7, -1.6], rgbaOf(sh, 0.1 + age * 0.35), 0.16); });
  if (age > 0.55) {
    at(0, 4.4, () => { for (let k = 0; k < 3; k++) curve([-3.2, k * 0.75, 0, k * 0.75 + 0.35, 3.2, k * 0.75], rgbaOf(sh, (age - 0.4) * 0.45), 0.12); });
    for (const s of [-1, 1]) at(s * 2.7, -7.2, () => curve([0, 0.8, 0.15, -0.4, 0.5, -1.6], rgbaOf(sh, (age - 0.4) * 0.4), 0.14), s);
  }
  // 嘴：上唇有唇峰、下唇比較亮；死了嘴唇發紫灰，頭往後仰的嘴巴開開的
  at(0, -5.9, () => {
    const lip = dead ? mixHex(p.lips, '#7c7888', 0.65) : p.lips, w = p.smallLips ? 1.35 : f ? 1.85 : 2.2;
    c.fillStyle = mixHex(lip, '#000000', 0.2);
    c.beginPath(); c.moveTo(-w, 0); c.bezierCurveTo(-w * 0.6, 0.3, -0.55, 0.72, 0, 0.48); c.bezierCurveTo(0.55, 0.72, w * 0.6, 0.3, w, 0); c.quadraticCurveTo(0, -0.12, -w, 0); c.fill();
    c.fillStyle = lip;
    c.beginPath(); c.moveTo(-w * 0.88, -0.04); c.quadraticCurveTo(0, f ? -1.2 : -1.0, w * 0.88, -0.04); c.quadraticCurveTo(0, -0.18, -w * 0.88, -0.04); c.fill();
    if (dead && p.pose === 'back') { soft(0, -0.25, w * 0.55, 0.55, '#160a0a', 1); ell(0, -0.25, w * 0.4, 0.32, '#120808'); }
    curve([-w, 0, 0, -0.16, w, 0], 'rgba(45,18,18,.7)', 0.11);
    soft(0, -0.55, w * 0.4, 0.2, '#ffffff', 0.12);   // 下唇的光
    soft(0, -1.7, w * 0.8, 0.5, sh, 0.3);            // 下唇底下的影子
  });
  // 鬍子
  if (p.stubble) at(0, -6, () => {
    for (let i = 0; i < 320; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()), x = Math.cos(a) * 4.8 * rr, y = Math.sin(a) * 3.8 * rr;
      if (Math.abs(x) < 2.4 && y > -1.3 && y < 0.7) continue;
      c.fillStyle = rgbaOf(p.hair, 0.22); c.fillRect(x, y, 0.16, 0.16);
    }
  });
  if (p.mustache === 'thin') at(0, -4.85, () => {
    c.fillStyle = rgbaOf(p.hair, 0.92); c.beginPath(); c.moveTo(-2.1, -0.35); c.quadraticCurveTo(-1.1, 0.45, 0, 0.2); c.quadraticCurveTo(1.1, 0.45, 2.1, -0.35); c.quadraticCurveTo(1.0, -0.05, 0, -0.15); c.quadraticCurveTo(-1.0, -0.05, -2.1, -0.35); c.fill();
  });
  if (p.mustache === 'walrus' || p.beard) at(0, -4.9, () => {
    c.fillStyle = p.hair; c.beginPath(); c.moveTo(-3.0, -1.3); c.bezierCurveTo(-2.6, 0.2, -1.0, 0.7, 0, 0.35); c.bezierCurveTo(1.0, 0.7, 2.6, 0.2, 3.0, -1.3); c.bezierCurveTo(2.0, -0.7, 1.0, -0.9, 0, -0.75); c.bezierCurveTo(-1.0, -0.9, -2.0, -0.7, -3.0, -1.3); c.fill();
    for (let i = 0; i < 40; i++) { const x = (rnd() - 0.5) * 5.6; curve([x, 0.2 - Math.abs(x) * 0.25, x * 1.08, -0.6 - Math.abs(x) * 0.18], rgbaOf(mixHex(p.hair, '#000000', 0.3), 0.4), 0.07); }
  });
  if (p.beard) at(0, -6.0, () => {
    // 白色的大鬍子：從兩頰包到下巴，露出下唇
    c.fillStyle = p.hair; c.beginPath(); c.moveTo(-4.7, 3.2); c.bezierCurveTo(-4.9, -1.5, -2.8, -5.2, 0, -5.6); c.bezierCurveTo(2.8, -5.2, 4.9, -1.5, 4.7, 3.2);
    c.lineTo(3.4, 1.6); c.quadraticCurveTo(2.6, 0.2, 2.1, 0.1); c.quadraticCurveTo(0, -1.5, -2.1, 0.1); c.quadraticCurveTo(-2.6, 0.2, -3.4, 1.6); c.closePath(); c.fill();
    for (let i = 0; i < 90; i++) { const x = (rnd() - 0.5) * 8.6, y = 2.5 - rnd() * 7; curve([x, y, x * 0.96, y - 1.2], rgbaOf(mixHex(p.hair, '#000000', 0.25), 0.3), 0.08); }
  });
  // 頭髮：照髮際線一格一格填（往下的髮絲紋路），邊緣淡淡的
  const fn = paxHairLine(p.style), img = c.getImageData(0, 0, S, S), dt = img.data, [hr, hg, hb] = hexRGB(p.hair);
  for (let Y = 0; Y < S; Y++) {
    const th = (Y + 0.5) / S * Math.PI;
    for (let X = 0; X < S; X++) {
      const dd = fn(((X + 0.5) / S - 0.5) * Math.PI, th);
      if (dd <= -0.03) continue;
      const k = sstep(-0.03, 0.03, dd), v = 0.8 + 0.32 * hash01(Math.floor(X * 1.7 + Y * 0.05)) + (hash01(X * 7.1 + Y * 13.3) - 0.5) * 0.12, i = (Y * S + X) * 4;
      dt[i] += (Math.min(255, hr * v) - dt[i]) * k; dt[i + 1] += (Math.min(255, hg * v) - dt[i + 1]) * k; dt[i + 2] += (Math.min(255, hb * v) - dt[i + 2]) * k;
    }
  }
  c.putImageData(img, 0, 0);
  if (p.style === 'bald') at(0, 7.5, () => ell(0, 0, 3.4, 1.4, 'rgba(255,255,255,.12)'));   // 禿頭的反光
  // 圓眼鏡：鏡框、鼻樑架、拉到耳朵的鏡腳，鏡片有一點反光
  if (p.glasses) {
    for (const s of [-1, 1]) at(s * ex, ey, () => { c.strokeStyle = '#2b2520'; c.lineWidth = 0.2; c.beginPath(); c.ellipse(0, 0, 1.75, 1.55, 0, 0, 7); c.stroke(); curve([-0.6, 0.9, 0.2, 1.2, 0.9, 0.6], 'rgba(255,255,255,.3)', 0.12); });
    at(0, ey + 0.2, () => curve([-1.4, 0, 0, 0.35, 1.4, 0], '#2b2520', 0.2));
    for (const s of [-1, 1]) { const [X0, Y0] = paxFaceMap(hd, s * (ex + 1.75), ey); c.strokeStyle = '#2b2520'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(X0, Y0); c.lineTo(s > 0 ? S - 3 : 3, Y0 + 3); c.stroke(); }
  }
}
// 換臉：活著、死了、轉頭時睜眼的貼圖各畫一張（用到才畫）
function paxFaceTex(px, st) {
  if (!px.tex[st]) {
    const t = canvasTex(PAX_TEX, PAX_TEX, c => paintPaxHead(c, px.p, st), true);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    px.tex[st] = t; px.headMat.userData.maps.push(t);
  }
  return px.tex[st];
}
// 帽子（在頭的中心的座標裡）
function paxHat(hc, p) {
  const hd = p.hd, col = pcol(p.hatCol), band = pcol(p.bandCol || mixHex(p.hatCol, '#000000', 0.4)), gold = pcol('#b8923a'), black = pcol('#0e0e10');
  const H = new THREE.Group(); hc.add(H);
  switch (p.hat) {
    case 'bowler':   // 圓頂禮帽：圓圓的帽頂、窄窄的帽簷、緞帶
      H.position.set(0, 0.035, -0.004); H.rotation.x = 0.06;
      pmesh(H, P_DOME(), col, 0, 0, 0, hd.rx * 1.22, 0.095, hd.rz * 1.14);
      pmesh(H, P_DISC(), col, 0, 0, 0, hd.rx * 1.75, 0.008, hd.rz * 1.6);
      pmesh(H, P_RING(), band, 0, 0.012, 0, hd.rx * 1.23, 0.022, hd.rz * 1.15);
      break;
    case 'cloche':   // 鐘形帽：壓到眉毛、包住後腦勺，一圈緞帶和側邊的花飾
      H.rotation.x = -0.33;
      pmesh(H, geo('paxCloche', () => new THREE.SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.505)), col, 0, 0, 0, hd.rx * 1.25, hd.ry * 1.2, hd.rz * 1.2);
      pmesh(H, geo('paxClocheBrim', () => new THREE.CylinderGeometry(1, 1.12, 1, 20, 1, true)), col, 0, -0.012, 0, hd.rx * 1.25, 0.022, hd.rz * 1.2);
      pmesh(H, P_RING(), band, 0, 0.012, 0, hd.rx * 1.26, 0.02, hd.rz * 1.21);
      pel(H, hd.rx * 1.22, 0.014, 0.025, 0.012, 0.02, 0.02, band);
      break;
    case 'student': {   // 學生帽：直直的帽身、平平的帽頂、黑色的帽簷、帽徽
      pmesh(H, geo('paxCapS', () => new THREE.CylinderGeometry(1.03, 1, 1, 22)), col, 0, 0.076, -0.004, hd.rx * 1.15, 0.068, hd.rz * 1.12);
      pmesh(H, P_VISOR(), black, 0, 0.04, hd.rz * 1.02, hd.rx * 1.12, 0.006, 0.065, 0.3);
      box(H, -0.012, 0.012, 0.07, 0.09, hd.rz * 1.12 - 0.004, hd.rz * 1.12 + 0.002, gold, false);
      break;
    }
    case 'conductor': {   // 車掌的大盤帽：帽圈上一條金帶，上面是往外撐開的帽頂，帽徽、帽簷
      pmesh(H, P_DISC(), col, 0, 0.055, -0.004, hd.rx * 1.15, 0.04, hd.rz * 1.12);
      pmesh(H, geo('paxCapTop', () => new THREE.CylinderGeometry(1.35, 1, 1, 22)), col, 0, 0.094, -0.004, hd.rx * 1.15, 0.038, hd.rz * 1.12);
      pmesh(H, P_RING(), gold, 0, 0.05, -0.004, hd.rx * 1.16, 0.012, hd.rz * 1.13);
      pmesh(H, P_VISOR(), black, 0, 0.037, hd.rz * 1.02, hd.rx * 1.12, 0.006, 0.065, 0.3);
      box(H, -0.014, 0.014, 0.068, 0.092, hd.rz * 1.15 - 0.002, hd.rz * 1.15 + 0.004, gold, false);
      break;
    }
    case 'flat':   // 鴨舌帽：扁扁的帽頂往前壓、短短的帽簷
      H.position.set(0, 0.07, 0.012); H.rotation.x = 0.18;
      pmesh(H, P_DOME(), col, 0, 0, 0, hd.rx * 1.24, 0.055, hd.rz * 1.3);
      pmesh(H, P_VISOR(), col, 0, -0.004, hd.rz * 1.15, hd.rx * 1.08, 0.008, 0.05, 0.22);
      break;
  }
}
// 脖子、頭、鼻子、耳朵、頭髮、帽子、鬍子（pose 是可以低頭、歪頭的那一層，原點在脖子底下）
function paxHead(pose, p, px) {
  const hd = p.hd, skin = pcol(p.deadSkin, 'skin'), hairM = pcol(p.hair, 'hair'), hc = new THREE.Group();
  hc.position.set(0, p.sex === 'f' ? 0.124 : 0.13, 0.022); pose.add(hc);
  const nr = p.build === 'h' ? 0.053 : p.sex === 'f' ? 0.04 : 0.045;
  cyl(pose, nr, nr * 1.08, 0.13, 0, -0.03, -0.005, skin, 12);
  const tex = canvasTex(PAX_TEX, PAX_TEX, c => paintPaxHead(c, p, 'dead'), true);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  px.tex.dead = tex; px.headMat = paxTexMat([tex]);
  pmesh(hc, paxHeadGeo(hd), px.headMat, 0, 0, 0);
  pel(hc, 0, -0.022, hd.rz * 0.95, 0.0125, 0.021, 0.023, skin).rotation.x = -0.4;   // 鼻頭
  for (const s of [-1, 1]) pel(hc, s * 0.009, -0.03, hd.rz * 0.93, 0.008, 0.008, 0.012, skin);   // 鼻翼
  pel(hc, 0, 0.002, hd.rz * 0.975, 0.0075, 0.024, 0.012, skin);                      // 鼻樑
  if (p.style !== 'bob' && p.style !== 'half') for (const s of [-1, 1]) pel(hc, s * hd.rx * 0.96, -0.008, -0.01, 0.009, 0.026, 0.017, skin).rotation.y = s * 0.35;
  pmesh(hc, paxHairGeo(p.style, hd, !!p.hat), hairM, 0, 0, 0);
  if (p.style === 'bun') pel(hc, 0, 0.045, -hd.rz * 1.02, 0.042, 0.036, 0.034, hairM);   // 後腦勺的髮髻
  if (p.style === 'updo') {
    // 日本髮髻：頭頂一大團、後面一個髻，插著髮簪
    pel(hc, 0, 0.088, -0.018, 0.075, 0.05, 0.085, hairM);
    pel(hc, 0, 0.03, -0.1, 0.055, 0.045, 0.045, hairM);
    limb(hc, [0.02, 0.115, -0.05], [0.11, 0.15, -0.07], 0.004, pcol('#c9a24a'));
    pel(hc, 0.112, 0.152, -0.07, 0.009, 0.009, 0.009, pcol(p.c4));
  }
  if (p.style === 'half') {
    // 垂到背上的長髮，後面綁著一個大緞帶
    pel(hc, 0, -0.13, -0.072, 0.085, 0.17, 0.045, hairM);
    for (const s of [-1, 1]) pel(hc, s * 0.045, 0.045, -0.1, 0.045, 0.03, 0.015, pcol(p.ribbon)).rotation.z = s * 0.3;
    pel(hc, 0, 0.045, -0.105, 0.016, 0.016, 0.014, pcol(p.ribbon));
  }
  if (p.beard) { pel(hc, 0, -0.078, 0.062, 0.052, 0.05, 0.035, hairM); pel(hc, 0, -0.044, 0.087, 0.03, 0.01, 0.014, hairM); }
  if (p.mustache === 'walrus') pel(hc, 0, -0.045, hd.rz * 0.92, 0.032, 0.011, 0.015, hairM);
  if (p.hat) paxHat(hc, p);
}

// ---------- 身體和衣服 ----------
// 衣服花紋（和服的櫻花、麻葉，女學生的矢絣）
function paxPattern(c, w, h, p) {
  c.fillStyle = p.c1; c.fillRect(0, 0, w, h);
  if (p.pat === 'yagasuri') {
    // 矢絣：一直排一直排的箭羽，兩種顏色交錯
    const cw = 16, ch = 14;
    for (let col = 0; col * cw < w; col++) for (let row = -1; row * ch < h + ch; row++) {
      if ((row + col) & 1) continue;
      const x = col * cw, y = row * ch + (col & 1) * ch / 2;
      c.fillStyle = p.c2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + cw / 2, y + ch / 2); c.lineTo(x + cw, y); c.lineTo(x + cw, y + ch / 2); c.lineTo(x + cw / 2, y + ch); c.lineTo(x, y + ch / 2); c.closePath(); c.fill();
    }
  } else if (p.pat === 'asanoha') {
    // 麻葉：六角星的格子
    c.strokeStyle = rgbaOf(p.c2, 0.45); c.lineWidth = 1;
    const s = 14;
    for (let j = 0; j * s * 0.866 < h + s; j++) for (let x = (j & 1) * s / 2; x < w + s; x += s) for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3, y = j * s * 0.866;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * s / 2, y + Math.sin(a) * s / 2); c.stroke();
    }
  } else {
    // 散落的櫻花
    for (let i = 0; i < w * h / 450; i++) {
      const x = rnd() * w, y = rnd() * h, r = 3 + rnd() * 3.5, rot = rnd() * 7;
      c.fillStyle = rgbaOf(p.c2, 0.75);
      for (let k = 0; k < 5; k++) { const a = rot + k * 1.2566; c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.5, r * 0.32, a, 0, 7); c.fill(); }
      c.fillStyle = rgbaOf(p.c4 || '#c9a24a', 0.8); c.beginPath(); c.arc(x, y, r * 0.18, 0, 7); c.fill();
    }
  }
  for (let i = 0; i < w * h / 200; i++) { c.fillStyle = 'rgba(0,0,0,.06)'; c.fillRect(rnd() * w, rnd() * h, 2, 2); }
}
// 上半身的貼圖：圍著身體一圈（中間是正面，左右兩邊是背後），上面是脖子、下面是屁股；位置用公分（x 從正中間往右、y 從脖子往下）
function paintPaxTorso(c, p) {
  const W = 256, H = 192, TH = p.torsoH * 100;
  const X = cm => W / 2 + Math.asin(clamp(cm / 16, -1, 1)) * W / (2 * Math.PI), Y = cm => cm / TH * H;
  const path = pts => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)))); };
  const poly = (pts, col) => { c.fillStyle = col; path(pts); c.closePath(); c.fill(); };
  const line = (pts, col, w) => { c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; path(pts); c.stroke(); };
  const button = (x, y, r, col) => { c.fillStyle = col; c.beginPath(); c.arc(X(x), Y(y), r, 0, 7); c.fill(); c.fillStyle = 'rgba(255,255,255,.25)'; c.beginPath(); c.arc(X(x) - r * 0.3, Y(y) - r * 0.3, r * 0.4, 0, 7); c.fill(); };
  const band = (y0, y1, col) => { c.fillStyle = col; c.fillRect(0, Y(y0), W, Y(y1) - Y(y0)); };
  const fabric = (col, n = 600, k = 0.06) => { c.fillStyle = col; c.fillRect(0, 0, W, H); for (let i = 0; i < n; i++) { c.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${k})` : `rgba(0,0,0,${k * 1.5})`; c.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2); } };
  const dk = (col, k) => mixHex(col, '#000000', k), lt = (col, k) => mixHex(col, '#ffffff', k);
  switch (p.top) {
    case 'suit': {   // 西裝外套、背心、白襯衫和領帶、口袋巾
      fabric(p.c1);
      for (let x = 0; x < W; x += 7) { c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(x, 0, 1, H); }
      const vest = dk(p.c1, 0.18);
      poly([[-7.5, 0], [7.5, 0], [0, 32]], vest);
      poly([[-4.5, 0], [4.5, 0], [0, 17]], '#e6e2d8');
      poly([[-1.1, 1], [1.1, 1], [1.6, 17], [-1.6, 17]], p.c2);
      poly([[-1.4, 0], [1.4, 0], [0.9, 3], [-0.9, 3]], dk(p.c2, 0.25));
      for (const y of [20, 25, 30]) button(0, y, 1.3, dk(vest, 0.45));
      for (const s of [-1, 1]) { line([[s * 7.5, 0], [0, 34]], dk(p.c1, 0.5), 2); line([[s * 8.5, 0], [s * 12.5, 10], [s * 9.5, 9.5], [s * 2.5, 31]], dk(p.c1, 0.35), 1.2); }
      line([[0, 34], [0, 50]], dk(p.c1, 0.45), 1.5);
      button(0.5, 41, 2.2, dk(p.c1, 0.5));
      poly([[0, 50], [-7, 61], [7, 61]], dk(p.legCol, 0.05));
      line([[7, 17], [12, 17]], dk(p.c1, 0.4), 1.2); poly([[8.3, 17], [10.8, 17], [9.6, 14.2]], '#e8e4da');
      for (const s of [-1, 1]) line([[s * 7, 48], [s * 13, 48]], dk(p.c1, 0.4), 1.2);
      break;
    }
    case 'coat': {   // 大衣：V 領露出裡面的洋裝、垂到胸口的長珍珠項鍊、雙排釦、腰帶
      fabric(p.c1, 900, 0.07);
      poly([[-5.5, 0], [5.5, 0], [0, 15]], p.c2);
      line([[3.5, 15], [3.5, 58]], dk(p.c1, 0.35), 1.5);
      for (const y of [22, 32, 46]) for (const x of [-4, 7]) button(x, y, 2.6, dk(p.c1, 0.45));
      band(36, 40, dk(p.c1, 0.18));
      c.strokeStyle = '#a88a3a'; c.lineWidth = 1.2; c.strokeRect(X(-1.8), Y(35.6), X(1.8) - X(-1.8), Y(4.8));
      for (let i = 0; i <= 26; i++) { const t = i / 26; button(-5 + 10 * t, 1 + 24 * Math.pow(Math.max(0, 1 - (2 * t - 1) ** 2), 0.7), 1.5, '#e8e2d4'); }
      break;
    }
    case 'cardigan': {   // 開襟毛衣：毛線的直紋、小圓領的襯衫、胸針
      fabric(p.c1, 300, 0.05);
      for (let x = 0; x < W; x += 3) { c.fillStyle = (x / 3) % 2 ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.06)'; c.fillRect(x, 0, 1.5, H); }
      poly([[-7, 0], [7, 0], [1, 24]], p.c2);
      for (const s of [-1, 1]) { c.fillStyle = '#ece6da'; c.beginPath(); c.ellipse(X(s * 3.2), Y(2), 9, 6, s * 0.4, 0, 7); c.fill(); }
      button(0, 4.5, 2.2, '#b8963a'); button(0, 4.5, 1.1, '#4a1a2a');
      line([[1, 24], [1, 58]], dk(p.c1, 0.4), 1.5);
      for (let y = 28; y < 56; y += 8) button(2.2, y, 1.6, dk(p.c1, 0.5));
      break;
    }
    case 'gakuran': {   // 學生服：黑色、一排五顆金扣子、胸前口袋
      fabric(p.c1, 300, 0.04);
      const sg = c.createLinearGradient(X(-14), 0, X(14), 0); sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,.06)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sg; c.fillRect(0, 0, W, H);
      line([[0.4, 0], [0.4, 60]], 'rgba(0,0,0,.6)', 1.2);
      for (let i = 0; i < 5; i++) { const y = 4 + i * 11; button(0, y, 2.5, '#a8862e'); c.strokeStyle = '#5a4416'; c.lineWidth = 0.8; c.beginPath(); c.arc(X(0), Y(y), 2.5, 0, 7); c.stroke(); }
      line([[7, 12], [12, 12]], 'rgba(255,255,255,.12)', 1.2);
      break;
    }
    case 'kimono': case 'hakama': {
      paxPattern(c, W, H, p);
      // 衣領：左前（從你這邊看，右肩那片疊在上面，斜斜往左下），露出白色的半襟
      const eri = dk(p.c1, 0.35), han = '#ece6da';
      poly([[-8, 0], [8, 0], [0.5, 13]], han);
      line([[-8, 0], [0.5, 13]], eri, 5); line([[8, 0], [-7, 32]], eri, 5);
      line([[-6.4, 0], [0.4, 10.5]], han, 1.6); line([[6.4, 0], [-0.4, 10.5]], han, 1.6);
      if (p.top === 'kimono') {
        // 寬腰帶、帶揚、帶締
        band(25, 41, p.c3);
        for (let x = 0; x < W; x += 10) { c.fillStyle = rgbaOf(lt(p.c3, 0.35), 0.3); c.fillRect(x, Y(25), 4, Y(16)); }
        band(24, 25.6, lt(p.c4, 0.3)); band(32.6, 33.6, p.c4);
        c.fillStyle = p.c4; c.beginPath(); c.ellipse(X(0), Y(33.1), 4, 2.5, 0, 0, 7); c.fill();
      } else {
        // 袴：從胸口下面開始，一條一條的褶子
        band(24, 62, p.c3);
        for (let x = 0; x < W; x += 9) { c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(x, Y(27), 1.5, H); }
        band(24, 26, dk(p.c3, 0.25));
      }
      break;
    }
    case 'vest': case 'vestW': {   // 背心：V 領露出襯衫；胖商人的背心有花紋、領帶和懷錶鏈
      const w = p.top === 'vestW';
      fabric(p.c1, 300, 0.05);
      if (p.stripe) for (let x = 0; x < W; x += 5) { c.fillStyle = rgbaOf(dk(p.c1, 0.3), 0.4); c.fillRect(x, 0, 1, H); }
      c.save(); c.beginPath(); c.rect(0, 0, W, H);
      c.moveTo(X(-6.5), 0); c.lineTo(X(6.5), 0); c.lineTo(X(0), Y(w ? 20 : 22)); c.closePath();
      for (const s of [-1, 1]) { const cx = W / 2 + s * W / 4; c.moveTo(cx + 13, Y(5)); c.ellipse(cx, Y(5), 13, Y(13), 0, 0, 7); }   // 袖口露出襯衫
      c.clip('evenodd'); fabric(p.c2, 400, 0.05);
      if (w) for (let y = 0; y < H; y += 8) for (let x = (y / 8 % 2) * 4; x < W; x += 8) { c.fillStyle = rgbaOf(lt(p.c2, 0.3), 0.18); c.fillRect(x, y, 2, 2); }
      c.restore();
      if (w) { poly([[-1, 1], [1, 1], [1.5, 20], [-1.5, 20]], p.c3); poly([[-1.3, 0], [1.3, 0], [0.9, 3], [-0.9, 3]], dk(p.c3, 0.25)); }
      else { for (const s of [-1, 1]) poly([[s * 6.5, 0], [s * 1, 0], [s * 4, 6]], lt(p.c1, 0.12)); for (const y of [7, 13, 19]) button(0, y, 1, '#e8e4da'); }
      for (let y = w ? 23 : 25; y < 56; y += 7) button(0.3, y, 1.5, dk(p.c2, 0.5));
      for (const s of [-1, 1]) line([[s * 6, 36], [s * 11, 36]], dk(p.c2, 0.45), 1);
      if (w) { c.strokeStyle = '#c9a24a'; c.lineWidth = 1.2; c.setLineDash([2, 1.5]); path([[-9, 36], [-5, 41], [0, 32]]); c.stroke(); c.setLineDash([]); }
      break;
    }
    case 'tweed': {   // 粗呢大衣：人字紋、V 領露出襯衫、大大的扣子
      fabric(p.c1, 300, 0.05);
      for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 6) { c.strokeStyle = (x / 6) % 2 ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.14)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + 3, y + ((x / 6) % 2 ? 4 : -4) + 4); c.stroke(); }
      poly([[-8, 0], [8, 0], [0, 24]], '#d8d2c4');
      poly([[-1, 1], [1, 1], [1.3, 22], [-1.3, 22]], dk(p.c1, 0.4));
      for (const s of [-1, 1]) { line([[s * 8, 0], [0, 26]], dk(p.c1, 0.5), 2); line([[s * 9, 0], [s * 13, 11], [s * 3, 28]], dk(p.c1, 0.35), 1.2); }
      for (const y of [32, 42, 52]) button(1.2, y, 2.6, '#3a2a1c');
      break;
    }
    case 'uniform': {   // 車掌制服：兩排金扣子、胸前的徽章、口袋
      fabric(p.c1, 300, 0.04);
      line([[0, 0], [0, 60]], 'rgba(0,0,0,.5)', 1.2);
      for (const y of [8, 20, 32, 44]) for (const x of [-5, 5]) button(x, y, 2.2, '#c9a24a');
      c.fillStyle = '#c9a24a'; c.fillRect(X(9), Y(9), X(12.5) - X(9), Y(2.5));
      for (const s of [-1, 1]) line([[s * 7.5, 14], [s * 13, 14]], 'rgba(255,255,255,.12)', 1.2);
      break;
    }
  }
}
// 身體：屁股、大腿、小腿、鞋子、上半身（往前傾 lean）、肩膀、兩隻手臂和手、衣領、手上拿的東西；回傳脖子底下的位置（頭裝在那裡）
function paxBody(B, p, S, o) {
  const f = p.sex === 'f', heavy = p.build === 'h', TH = p.torsoH;
  const lean = (p.hunch || 0) + (o.table ? 0.08 : 0.02);
  const P0 = V3(0, S + 0.05, -0.09);
  const L = (x, y, z) => V3(x, y * Math.cos(lean) - z * Math.sin(lean), y * Math.sin(lean) + z * Math.cos(lean)).add(P0);
  const skin = pcol(p.deadSkin, 'skin');
  if (!p.patMat && (p.top === 'kimono' || p.top === 'hakama')) {
    const t = canvasTex(128, 128, c => paxPattern(c, 128, 128, p));
    p.patMat = paxTexMat([t]);
  }
  const legM = p.legs === 'kimono' ? p.patMat : pcol(p.legCol), sleeveM = p.patMat || pcol(p.sleeve), shoeM = pcol(p.shoeCol);
  // 上半身：繞著中心轉出來的形狀（壓扁成橢圓），衣服畫在貼圖上
  const prof = heavy ? [0.19, 0.205, 0.215, 0.21, 0.2, 0.196, 0.195, 0.168, 0.072] : f ? [0.172, 0.16, 0.14, 0.14, 0.152, 0.16, 0.162, 0.14, 0.058] : [0.165, 0.16, 0.152, 0.155, 0.168, 0.182, 0.188, 0.165, 0.07];
  const lg = new THREE.LatheGeometry(prof.map((r, j) => new THREE.Vector2(r, TH * j / 8)), 22, Math.PI, Math.PI * 2);
  const torsoTex = canvasTex(256, 192, c => paintPaxTorso(c, p));
  const torso = pmesh(B, lg, paxTexMat([torsoTex]), P0.x, P0.y, P0.z, 1, 1, heavy ? 0.82 : f ? 0.66 : 0.62, lean);
  torso.userData.ownGeo = true;
  // 屁股和腿
  const skirt = p.legs !== 'trousers', long = p.legs === 'long' || p.legs === 'kimono' || p.legs === 'hakama';
  const kx = heavy ? 0.13 : f ? 0.075 : 0.11, tr = heavy ? 0.08 : p.legs === 'hakama' ? 0.088 : skirt ? 0.078 : 0.068;
  pel(B, 0, S + 0.1, -0.08, heavy ? 0.19 : f ? 0.178 : 0.165, 0.1, 0.15, legM);
  const kneeY = S + 0.075, kz = 0.36, ankY = 0.085, shinL = 0.42;
  const az = kz + Math.sqrt(Math.max(0, shinL * shinL - (kneeY - ankY) ** 2));
  for (const s of [-1, 1]) {
    const knee = V3(s * kx, kneeY, kz), ank = V3(s * (kx + 0.005), ankY, az);
    pcap(B, V3(s * 0.09, S + 0.085, -0.04), knee, tr, legM);
    const sockM = p.legs === 'skirt' ? pcol(mixHex(p.skin, '#2a2420', 0.4)) : legM;   // 女郎的絲襪
    pcap(B, knee, ank, long ? 0.07 : p.legs === 'skirt' ? 0.042 : 0.048, sockM);
    // 鞋子
    if (p.shoe === 'zori') { pel(B, ank.x, 0.045, ank.z + 0.05, 0.04, 0.035, 0.1, pcol('#ece8e0')); box(B, ank.x - 0.045, ank.x + 0.045, 0, 0.016, ank.z - 0.06, ank.z + 0.17, pcol('#c8b48a')); }
    else if (p.shoe === 'heel') { pel(B, ank.x, 0.05, ank.z + 0.05, 0.036, 0.032, 0.1, shoeM).rotation.x = -0.25; box(B, ank.x - 0.012, ank.x + 0.012, 0, 0.05, ank.z - 0.06, ank.z - 0.035, shoeM); }
    else {
      pel(B, ank.x, 0.04, ank.z + 0.06, 0.048, 0.04, 0.12, shoeM);
      if (p.shoe === 'boot') cyl(B, 0.05, 0.052, 0.16, ank.x, 0.02, ank.z, shoeM, 12);
    }
  }
  if (skirt) {
    // 裙子：兩腿之間的大腿上蓋著布，從膝蓋垂下來
    box(B, -kx, kx, S + 0.03, S + 0.15, -0.05, kz + 0.02, legM);
    box(B, -kx - 0.07, kx + 0.07, long ? 0.06 : kneeY - 0.16, kneeY + 0.05, kz + 0.01, kz + 0.07, legM);
    if (long) for (const s of [-1, 1]) box(B, s * (kx + 0.07) - 0.015, s * (kx + 0.07) + 0.015, 0.06, kneeY + 0.03, -0.02, kz + 0.07, legM);
  }
  // 肩膀、手臂、手
  const shX = heavy ? 0.195 : f ? 0.155 : 0.18, ar = heavy ? 0.055 : f ? 0.042 : 0.047, fr = ar * 0.85;
  const T = o.table || 0, hs = {
    lap: [[-0.13, S + 0.15, 0.2], [0.13, S + 0.15, 0.2]],
    folded: [[-0.035, S + 0.17, 0.15], [0.03, S + 0.185, 0.16]],
    kerchief: [[-0.035, S + 0.17, 0.15], [0.03, S + 0.185, 0.16]],
    bag: [[-0.07, S + 0.3, 0.17], [0.07, S + 0.3, 0.17]],
    book: [[-0.09, S + 0.2, 0.2], [0.09, S + 0.2, 0.21]],
    belly: [[-0.06, S + 0.29, 0.14], [0.06, S + 0.29, 0.14]],
    cane: [[-0.02, S + 0.27, 0.38], [0.02, S + 0.31, 0.375]],
    paper: [[-0.26, S + 0.32, 0.25], [0.26, S + 0.32, 0.25]],
    table: [[-0.12, T + 0.03, 0.31], [0.12, T + 0.03, 0.32]],
  }[p.hands];
  const handM = p.glove ? pcol(p.glove) : skin;
  for (const i of [0, 1]) {
    const s = i ? 1 : -1, sh = L(s * shX, TH * 0.82, 0), hand = V3(...hs[i]);
    pel(B, sh.x, sh.y + 0.005, sh.z, ar * 1.12, ar * 1.05, ar * 1.12, sleeveM);   // 肩膀
    const el = paxElbow(sh, hand, 0.28, 0.27, V3(s * 0.55, -0.45, -0.7)), dir = hand.clone().sub(el).normalize(), wr = hand.clone().addScaledVector(dir, -0.06);
    pcap(B, sh, el, ar, sleeveM);
    if (p.rolled) { pcap(B, el, wr, fr * 0.9, skin); pcap(B, el.clone().addScaledVector(dir, -0.01), el.clone().addScaledVector(dir, 0.04), ar * 1.05, sleeveM); }
    else pcap(B, el, wr, fr, sleeveM);
    if (p.cuff) pcap(B, wr.clone().addScaledVector(dir, -0.035), wr.clone().addScaledVector(dir, -0.005), fr * 1.02, pcol(p.cuff));
    if (p.patMat) {
      // 和服的袖子：從手臂垂下來的一大片
      const mid = el.clone().add(wr).multiplyScalar(0.5), hd2 = V3(dir.x, 0, dir.z).normalize(), len = el.distanceTo(wr);
      const m = pmesh(B, BOX, p.patMat, mid.x, mid.y - 0.1, mid.z, len * 0.95, 0.22, 0.03);
      m.rotation.y = Math.atan2(hd2.x, hd2.z) + Math.PI / 2;
    }
    // 手：手掌平平的
    const hdir = V3(dir.x, p.hands === 'paper' ? dir.y : dir.y * 0.35, dir.z).normalize();
    const hm = pel(B, hand.x, hand.y, hand.z, f ? 0.036 : 0.04, 0.02, f ? 0.075 : 0.085, handM, 10);
    hm.quaternion.setFromUnitVectors(Z_AXIS, hdir);
    if (p.hands === 'paper') hm.rotateZ(s * 1.3);
  }
  // 衣領、圍巾、披肩、毛領
  const N = L(0, TH - 0.035, 0.005);
  switch (p.collar) {
    case 'shirt': pmesh(B, P_RING(), pcol('#e8e4da'), N.x, N.y - 0.005, N.z + 0.005, 0.056, 0.042, 0.054, lean); break;
    case 'stand':
      pmesh(B, P_RING(), pcol(p.collarCol), N.x, N.y + 0.005, N.z, 0.058, 0.05, 0.056, lean);
      pmesh(B, P_RING(), pcol(p.collarTrim), N.x, N.y + 0.031, N.z, 0.0585, 0.006, 0.0565, lean);
      break;
    case 'fur': {
      const fm = pcol(p.collarCol);
      pmesh(B, geo('paxTorus', () => new THREE.TorusGeometry(1, 0.38, 8, 20)), fm, N.x, N.y - 0.02, N.z + 0.01, 0.095, 0.095, 0.08, Math.PI / 2 + lean);
      for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; pel(B, N.x + Math.sin(a) * 0.1, N.y - 0.015 + rnd() * 0.02, N.z + 0.01 + Math.cos(a) * 0.085, 0.035, 0.03, 0.035, fm, 8); }
      break;
    }
    case 'scarf': {
      const sm = pcol(p.collarCol);
      pmesh(B, geo('paxTorus', () => new THREE.TorusGeometry(1, 0.38, 8, 20)), sm, N.x, N.y - 0.005, N.z + 0.005, 0.075, 0.075, 0.068, Math.PI / 2 + lean);
      for (const s of [-1, 1]) pmesh(B, BOX, sm, N.x + s * 0.035, N.y - 0.13, N.z + 0.1 + lean * 0.3, 0.07, 0.22, 0.02, -0.12 + lean, 0, s * 0.08);
      break;
    }
    case 'shawl': {
      // 披肩：從脖子罩到手臂上
      const sg = new THREE.LatheGeometry([[0.2, 0.36], [0.205, 0.43], [0.2, 0.49], [0.17, 0.545], [0.11, 0.58], [0.065, 0.6]].map(([r, y]) => new THREE.Vector2(r, y * TH / 0.6)), 22, Math.PI, Math.PI * 2);
      const m = pmesh(B, sg, pcol(p.collarCol), P0.x, P0.y, P0.z, 1, 1, 0.7, lean); m.userData.ownGeo = true;
      break;
    }
  }
  // 手上拿的東西
  switch (p.hands) {
    case 'bag': box(B, -0.11, 0.11, S + 0.14, S + 0.28, 0.12, 0.2, pcol(p.bagCol)); box(B, -0.03, 0.03, S + 0.28, S + 0.295, 0.15, 0.17, pcol('#b8923a')); break;
    case 'book': box(B, -0.1, 0.1, S + 0.15, S + 0.18, 0.07, 0.32, pcol(p.bookCol)); box(B, -0.095, 0.095, S + 0.155, S + 0.175, 0.075, 0.322, pcol('#d8cfb8')); break;
    case 'kerchief': box(B, -0.03, 0.03, S + 0.165, S + 0.19, 0.12, 0.2, pcol('#ece6da')); break;
    case 'cane': limb(B, [0, 0, 0.5], [0, S + 0.26, 0.385], 0.012, pcol('#2a1a10')); pel(B, 0, S + 0.27, 0.395, 0.022, 0.016, 0.03, pcol('#3a2414')); break;
    case 'paper': {
      // 攤開的報紙：兩頁往你這邊折成 V 字，兩手捏著下面的角
      const pm = paxPaperMat(), fold = new THREE.Group(); fold.position.set(0, S + 0.44, 0.35); B.add(fold);
      for (const s of [-1, 1]) {
        const pg = new THREE.Group(); pg.rotation.y = s * 0.4; fold.add(pg);
        pmesh(pg, geo('paxPage' + s, () => { const g = new THREE.PlaneGeometry(0.3, 0.42), U = g.attributes.uv; for (let i = 0; i < U.count; i++) U.setX(i, U.getX(i) * 0.5 + (s > 0 ? 0.5 : 0)); return g; }), pm, s * 0.15, 0, 0);
      }
      break;
    }
  }
  return { N, lean };
}
// 坐著的乘客：x, z 是背靠椅背往前 0.2 的地方，face 是面向的角度，seat 是座面高度；o.table 是桌面高度（手放在桌上）、o.prefer 是比較適合的種類
function addPassenger(g, r, x, z, face, seat, o = {}) {
  const p = paxSpec(paxNextKind(o.prefer));
  if (o.table && p.hands !== 'paper' && (rnd() < 0.6 || ['cane', 'bag', 'book'].includes(p.hands))) p.hands = 'table';
  const pg = new THREE.Group(); pg.position.set(x, 0, z); pg.rotation.y = face; pg.scale.setScalar(p.sc); g.add(pg);
  const px = { kind: p.kind, p, g: pg, skins: [], tex: {}, state: 'dead', deadPose: p.deadPose, alivePose: p.alivePose };
  const B = new THREE.Group(); pg.add(B);
  const { N, lean } = paxBody(B, p, seat / p.sc, o);
  // 頭：脖子底下 → 轉頭（yaw）→ 低頭、歪頭（pose）
  px.piv = new THREE.Group(); px.piv.position.copy(N); px.piv.rotation.x = lean; pg.add(px.piv);
  px.yaw = new THREE.Group(); px.piv.add(px.yaw);
  px.pose = new THREE.Group(); px.yaw.add(px.pose);
  paxHead(px.pose, p, px);
  px.pose.rotation.set(p.deadPose.x, p.deadPose.y, p.deadPose.z);
  paxMerge(B, px.skins); paxMerge(px.pose, px.skins);
  (r.pax = r.pax || []).push(px);
}
// 躺著的乘客（臥鋪的下鋪）：頭枕在枕頭上、毯子蓋到胸口、兩手交疊放在毯子上；u 是枕頭中間的位置，身體往 u 變大的方向躺
function addLyingPassenger(g, r, f, side, u, y) {
  const p = paxSpec(paxNextKind()); p.hat = null;
  const [hx, hz] = fpos(f, side, u, f.h / 2), [tx, tz] = fpos(f, side, u + 1, f.h / 2);
  const pg = new THREE.Group(); pg.position.set(hx, y, hz); pg.rotation.y = Math.atan2(tx - hx, tz - hz); g.add(pg);
  const px = { kind: p.kind, p, g: pg, skins: [], tex: {}, state: 'dead', deadPose: { x: 0, y: (rnd() < 0.5 ? -1 : 1) * 0.35, z: 0 }, alivePose: { x: 0, y: 0, z: 0 } };
  const B = new THREE.Group(); pg.add(B);
  const blanket = pcol(pickR(['#8a7a62', '#6a7282', '#7a6a72'])), night = pcol(pickR(['#d8d0c0', '#c0c8d0', '#d0c0c0'])), skin = pcol(p.deadSkin, 'skin');
  pel(B, 0, 0.05, 0.34, 0.2, 0.07, 0.12, night);              // 肩膀（睡衣）
  pel(B, 0, 0.05, 0.98, 0.24, 0.12, 0.72, blanket);           // 蓋著毯子的身體
  pel(B, 0, 0.1, 0.62, 0.22, 0.08, 0.2, blanket);             // 胸口
  for (const s of [-1, 1]) pel(B, s * 0.08, 0.1, 1.58, 0.06, 0.07, 0.07, blanket);   // 腳尖頂起來的地方
  limb(B, [-0.24, 0.1, 0.42], [0.24, 0.1, 0.42], 0.03, pcol('#d6cdb9'));          // 反折的被單
  for (const s of [-1, 1]) {
    const el = V3(s * 0.2, 0.12, 0.72), hand = V3(s * 0.035, 0.2, 0.52), dir = hand.clone().sub(el).normalize();
    pcap(B, el, hand.clone().addScaledVector(dir, -0.06), 0.04, night);
    pel(B, hand.x, hand.y, hand.z, 0.04, 0.02, 0.085, skin, 10).quaternion.setFromUnitVectors(Z_AXIS, V3(dir.x, 0, dir.z).normalize());
  }
  // 頭：臉朝上（轉頭的時候繞著頭頂到下巴那條軸，往你這邊轉過來）
  px.piv = new THREE.Group(); px.piv.position.set(0, 0.15, 0.165); px.piv.rotation.x = -Math.PI / 2; pg.add(px.piv);
  px.yaw = new THREE.Group(); px.piv.add(px.yaw);
  px.pose = new THREE.Group(); px.yaw.add(px.pose);
  paxHead(px.pose, p, px);
  px.pose.rotation.set(px.deadPose.x, px.deadPose.y, px.deadPose.z);
  paxMerge(B, px.skins); paxMerge(px.pose, px.skins);
  (r.pax = r.pax || []).push(px);
}
// 換成活著／死了／睜眼：臉的貼圖和皮膚的顏色
function paxState(px, st) {
  px.state = st;
  px.headMat.map = paxFaceTex(px, st);
  _pc.set(st === 'alive' ? px.p.skin : px.p.deadSkin);
  for (const s of px.skins) {
    const a = s.attr.array;
    for (let k = 0; k < s.r.length; k += 2) for (let i = s.r[k]; i < s.r[k] + s.r[k + 1]; i++) { a[i * 3] = _pc.r; a[i * 3 + 1] = _pc.g; a[i * 3 + 2] = _pc.b; }
    s.attr.needsUpdate = true;
  }
}
// 每一幀：過場動畫時活著；「乘客轉頭」事件讓某個乘客的頭慢慢抬起來轉向你、睜開眼睛。
// 晚上（設計師：「晚上詭異點，每個人看到我都會一直盯著，頭會轉」）：看得到你的乘客全部慢慢把頭轉過來盯著你，
// 轉得比正常人能轉的角度還多（快要轉到背後），眼睛睜開；你走開、看不到你了，頭才慢慢轉回去垂下來
const PAX_STARE_R = 9, PAX_TWIST = 2.3;
let paxSeeT = 0;
function updatePassengers(dt = 0.016) {
  const alive = !!(mode === 'cutscene' && CUT && CUT.kind === 2 && CUT.alive);
  const pt = G.ev && G.ev.paxTurn;
  const night = !alive && mode === 'play' && G.phase === 'night' && isW3() && !onRoof(G.p.x, G.p.y);
  paxSeeT -= dt;
  const recheck = paxSeeT <= 0;   // 看不看得到你：每 0.25 秒算一次就好（平板上省一點）
  if (recheck) paxSeeT = 0.25;
  for (const f of FURN) {
    const r = furn3d[f.id];
    if (!r || !r.pax) continue;
    for (const px of r.pax) {
      if (recheck) {
        px.sees = false;
        if (night) {
          px.g.getWorldPosition(_pw);
          const dx = G.p.x - _pw.x, dy = G.p.y - _pw.z, d = Math.hypot(dx, dy);
          px.sees = d < PAX_STARE_R && (d < 1.2 || castRay(_pw.x, _pw.z, Math.atan2(dy, dx), d) >= d - 0.6);
        }
      }
      px.stareK = clamp((px.stareK || 0) + (px.sees ? dt * 0.45 : -dt * 0.3), 0, 1);   // 轉過來很慢（2 秒多），轉回去更慢
      const ev = !alive && pt && pt.id === f.id && px === r.pax[0] ? clamp(Math.min(pt.t / 3, (16 - pt.t) / 2), 0, 1) : 0;
      const turn = Math.max(ev, px.stareK), twist = px.stareK > ev ? PAX_TWIST : 1.4;
      const st = alive ? 'alive' : turn > 0.3 ? 'stare' : 'dead';
      if (st !== px.state) paxState(px, st);
      if (turn > 0) {
        camera.getWorldPosition(_pw); px.piv.worldToLocal(_pw);
        px.yaw.rotation.y = clamp(Math.atan2(_pw.x, _pw.z), -twist, twist) * turn;
      } else px.yaw.rotation.y = 0;
      const ps = alive ? px.alivePose : px.deadPose, k = 1 - turn;
      px.pose.rotation.set(ps.x * k, ps.y * k, ps.z * k);
    }
  }
}
// 試玩測試用：有幾個乘客、幾種、各自坐在哪裡（家具、位置、面向）
function paxStats() {
  const list = [];
  for (const k in furn3d) for (const px of furn3d[k].pax || []) { px.g.getWorldPosition(_pw); list.push({ kind: px.kind, id: k, x: _pw.x, y: _pw.z, face: px.g.rotation.y + (px.g.parent ? px.g.parent.rotation.y : 0), state: px.state }); }
  return { n: list.length, kinds: [...new Set(list.map(p => p.kind))], list };
}
// 留聲機的黃銅喇叭
function gramHorn(g, x, y, z, brass) {
  cyl(g, 0.04, 0.06, 0.1, x, y, z, brass, 10);
  const horn = new THREE.Mesh(geo('horn', () => new THREE.ConeGeometry(0.22, 0.45, 16, 1, true)), lm('#8a6a2a', { side: THREE.DoubleSide }));
  horn.position.set(x, y + 0.42, z - 0.12); horn.rotation.x = -0.9; horn.rotation.z = Math.PI; g.add(horn);
}
function trainFurniture(f, g, r, W, D, side, len, cabinet) {
  if (!isW3()) return false;
  // 胡桃木、黃銅、皮箱、象牙白的布（桌布、枕頭）都用照片材質，顏色跟原本的一樣
  const walnut = photoMat('w3-wood', '#3b2416'), walnut2 = photoMat('w3-wood', '#5a3a24'), brass = photoMat('w3-brass', '#8a6a2a'), brass2 = photoMat('w3-brass', '#5e4a1e'), iron = lm('#3a3a3e'), ivory = photoMat('w3-linen', '#d8cfbd');
  const leather = photoMat('w3-leather', '#5a3a22'), leather2 = photoMat('w3-leather', '#2a2a2e'), glassM = ownLM('#cfe0e8', { transparent: true, opacity: 0.35, depthWrite: false });
  // 在正面座標 (u, v) 放一個坐著的乘客（v 是背靠椅背往前 0.2 的地方），seat 是座面高度
  const paxOn = (u, v, seat, o) => { const [x, z] = fpos(f, side, u, v); addPassenger(g, r, x, z, faceOf(side), seat, o); };
  switch (f.type) {
    case 'rug': {
      if (!f.deco) return false;
      // 裝飾藝術的地毯：深色底、金色的花邊和一圈圓花紋，磨得有點舊
      const t = photoTex('w3-rug', () => canvasTex(256, 256, (c) => {
        c.fillStyle = f.color; c.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 400; i++) { c.fillStyle = 'rgba(255,255,255,.04)'; c.fillRect(rnd() * 256, rnd() * 256, 2, 2); }
        c.strokeStyle = 'rgba(214,180,90,.7)'; c.lineWidth = 5; c.strokeRect(14, 14, 228, 228); c.lineWidth = 2; c.strokeRect(26, 26, 204, 204);
        for (let k = 0; k < 7; k++) { const p = 32 + k * 32; for (const [x, y] of [[p, 32], [p, 224], [32, p], [224, p]]) { c.beginPath(); c.arc(x, y, 10, 0, 7); c.stroke(); } }
        for (let i = 0; i < 6; i++) { c.fillStyle = `rgba(0,0,0,${0.1 + rnd() * 0.2})`; c.beginPath(); c.ellipse(rnd() * 256, rnd() * 256, 10 + rnd() * 30, 6 + rnd() * 20, rnd() * 3, 0, 7); c.fill(); }
      }));
      const mat = patchLM(new THREE.MeshLambertMaterial({ map: t })); mat.userData.own = true; mat.userData.maps = [t];
      const m = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, D - 0.2), mat); m.userData.ownGeo = true;
      m.rotation.x = -Math.PI / 2; m.position.set(W / 2, 0.006, D / 2); m.receiveShadow = true; g.add(m);
      return true;
    }
    case 'throttle': { // 駕駛台（車頭是開車的）：鐵製的控制台，上面有兩個壓力表、黃銅的節流閥和煞車閥拉桿、一個手輪；按 E 拉汽笛
      const dark = lm('#1c1c20'), glassT = ownLM('#e8e4d8', { emissive: 0x222018 });
      box(g, 0.1, W - 0.1, 0, 0.92, 0.15, D - 0.15, iron);
      box(g, 0.05, W - 0.05, 0.92, 1.0, 0.1, D - 0.1, dark);
      for (const u of [0.55, 1.35]) { const [x, z] = fpos(f, side, u, 0.5); cyl(g, 0.15, 0.15, 0.06, x, 1.0, z, brass, 16); cyl(g, 0.12, 0.12, 0.02, x, 1.06, z, glassT, 16); box(g, x - 0.01, x + 0.01, 1.08, 1.09, z - 0.1, z + 0.02, lm('#a01818'), false); }
      for (const [u, a] of [[2.0, -0.35], [2.5, 0.25]]) { const [x, z] = fpos(f, side, u, 0.35); limb(g, [x, 1.0, z], [x + Math.sin(a) * 0.3, 1.55, z - 0.25], 0.025, brass); sph(g, 0.05, x + Math.sin(a) * 0.3, 1.57, z - 0.25, lm('#3a1a10')); }
      const [wx, wz] = fpos(f, side, len - 0.45, 0.5);
      const wheel = new THREE.Mesh(geo('handwheel', () => new THREE.TorusGeometry(0.2, 0.025, 8, 20)), brass); wheel.position.set(wx, 1.3, wz); wheel.rotation.x = Math.PI / 2 - 0.6; g.add(wheel);
      cyl(g, 0.03, 0.03, 0.3, wx, 1.0, wz, brass2, 8);
      for (const u of [0.3, len - 0.3]) fb(g, f, side, u - 0.04, u + 0.04, 0.3, 0.9, 0.0, 0.02, brass2, false);
      r.top = 1.6;
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
    case 'seat3': // 絨布長椅：胡桃木框、磨破的暗紅絨布，上面坐著死去的乘客
      box(g, 0.05, W - 0.05, 0, 0.18, 0.05, D - 0.05, walnut);
      fb(g, f, side, 0.08, len - 0.08, 0.18, 0.48, 0.08, D - 0.08, velvet());
      fb(g, f, side, 0.08, len - 0.08, 0.48, 1.0, D - 0.3, D - 0.08, velvet());
      fb(g, f, side, 0.04, len - 0.04, 1.0, 1.06, D - 0.32, D - 0.06, walnut2, false);
      for (const u of [0.12, len - 0.12]) fb(g, f, side, u - 0.08, u + 0.08, 0.48, 0.72, 0.1, D - 0.1, walnut2);
      if (f.pax) { const o = { prefer: ['gent', 'lady', 'merchant', 'kimono', 'oldman', 'girl'] }; paxOn(len * 0.3, 0.5, 0.48, o); if (len >= 4) paxOn(len * 0.72, 0.5, 0.48, o); }
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
    case 'passenger': // 扶手椅上坐著一個死去的乘客
      box(g, 0.1, 0.9, 0, 0.42, 0.1, 0.9, velvet()); fb(g, f, side, 0.1, 0.9, 0.42, 1.0, 0.7, 0.9, velvet());
      for (const u of [0.1, 0.9]) fb(g, f, side, u - 0.08, u + 0.08, 0.42, 0.66, 0.1, 0.9, walnut2);
      paxOn(0.5, 0.5, 0.42, { prefer: ['gent', 'lady', 'merchant', 'oldman', 'kimono'] });
      r.top = 1.0;
      return true;
    case 'icebox': // 冰櫃：胡桃木箱子、黃銅鉸鏈
      box(g, 0.05, W - 0.05, 0, 1.3, 0.05, D - 0.05, walnut);
      fb(g, f, side, 0.1, len - 0.1, 0.1, 1.2, 0, 0.03, walnut2, false);
      fb(g, f, side, len - 0.25, len - 0.18, 0.5, 0.8, -0.02, 0.01, brass, false);
      for (const y of [0.2, 1.1]) fb(g, f, side, 0.15, len - 0.15, y, y + 0.05, -0.01, 0.01, brass2, false);
      r.top = 1.3;
      return true;
    case 'dining': { // 餐桌：白桌布、銀器、燭台；兩端各一張絨布椅，坐著面對面死去的乘客（腿伸到桌子底下，手放在桌上）。三格長的餐桌：兩端的格子是椅子、中間是桌子
      const t0 = W >= 3 ? 0.8 : 0.55, t1 = W - t0, cz = D / 2;
      box(g, t0, t1, 0.72, 0.76, 0.15, D - 0.15, walnut2);
      box(g, t0 - 0.02, t1 + 0.02, 0.76, 0.775, 0.12, D - 0.12, ivory, false);
      for (const z of [0.115, D - 0.125]) box(g, t0 - 0.02, t1 + 0.02, 0.6, 0.775, z, z + 0.01, ivory, false);   // 垂下來的桌布
      for (const [x, z] of [[t0 + 0.08, 0.25], [t1 - 0.08, 0.25], [t0 + 0.08, D - 0.25], [t1 - 0.08, D - 0.25]]) box(g, x - 0.03, x + 0.03, 0, 0.72, z - 0.03, z + 0.03, walnut2);
      cyl(g, 0.03, 0.05, 0.22, W / 2, 0.775, cz, brass, 8); cyl(g, 0.015, 0.015, 0.12, W / 2, 0.99, cz, ivory, 6);
      for (const x of [t0 + 0.17, t1 - 0.17]) { cyl(g, 0.1, 0.1, 0.01, x, 0.775, cz, lm('#c9ced4'), 12); for (const s of [-1, 1]) box(g, x - 0.008, x + 0.008, 0.775, 0.782, cz + s * 0.14 - 0.06, cz + s * 0.14 + 0.06, lm('#c9ced4'), false); }
      for (const s of [-1, 1]) {   // 椅子：絨布座面、胡桃木椅背
        const xb = s < 0 ? 0.04 : W - 0.04, xf = s < 0 ? 0.5 : W - 0.5, x0 = Math.min(xb, xf), x1 = Math.max(xb, xf);
        box(g, x0, x1, 0.38, 0.45, cz - 0.23, cz + 0.23, velvet());
        for (const x of [x0 + 0.03, x1 - 0.03]) for (const z of [cz - 0.2, cz + 0.2]) box(g, x - 0.02, x + 0.02, 0, 0.38, z - 0.02, z + 0.02, walnut);
        box(g, xb - 0.03, xb + 0.03, 0.38, 1.05, cz - 0.23, cz + 0.23, walnut2);
        const pv = xb - s * 0.04; box(g, pv - 0.005, pv + 0.005, 0.5, 0.98, cz - 0.19, cz + 0.19, velvet());
      }
      if (f.pax) {
        const o = { table: 0.775, prefer: ['gent', 'lady', 'merchant', 'kimono', 'conductor', 'oldman'] };
        addPassenger(g, r, 0.3, cz, Math.PI / 2, 0.45, o); addPassenger(g, r, W - 0.3, cz, -Math.PI / 2, 0.45, o);
      }
      r.top = 1.05;
      return true;
    }
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
      cyl(g, 0.3, 0.3, 0.6, W / 2, 1.6, D / 2, iron, 14); cyl(g, 0.12, 0.12, CEIL_W3 - 2.2, W / 2, 2.2, D / 2, dark, 8);
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
    case 'bench3': case 'benches': { // 長椅：鑄鐵腳、木條座面；候車室那一排坐著死去的乘客
      const slat = lm('#6a4a2e');
      for (const v0 of [0.15, 0.3, 0.45]) fb(g, f, side, 0.1, len - 0.1, 0.42, 0.46, v0, v0 + 0.11, slat);
      for (const y0 of [0.6, 0.75]) fb(g, f, side, 0.1, len - 0.1, y0, y0 + 0.1, 0.62, 0.68, slat);
      for (const u of (len >= 4 ? [0.3, len / 2, len - 0.3] : [0.3, len - 0.3])) { fb(g, f, side, u - 0.04, u + 0.04, 0, 0.42, 0.14, 0.56, iron); fb(g, f, side, u - 0.04, u + 0.04, 0, 0.9, 0.64, 0.7, iron); }
      if (f.pax) { const o = { prefer: ['worker', 'granny', 'student', 'girl', 'oldman', 'conductor'] }; paxOn(len * 0.25, 0.42, 0.46, o); paxOn(len * 0.78, 0.42, 0.46, o); }
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
    case 'timetable': // 牆上的時刻表：木框、泛黃的紙、一行一行的字（有照片就是印著十二個站名和時間的舊時刻表）
      if (photos['w3-timetable']) {
        fb(g, f, side, len / 2 - 0.45, len / 2 + 0.45, 0.75, 1.95, D - 0.05, D - 0.01, photoMat('w3-timetable', '#ffffff'));
        r.top = 1.95;
        return true;
      }
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
    case 'seats': { // 普通車廂的座位：一格一個座位（暗紅絨布、胡桃木扶手），一組有靠窗和靠走道兩排，椅背朝車尾、面向車頭；牆那一側的上方是黃銅行李架
      const vel = velvet();
      for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
        const x0 = i + 0.08, x1 = i + 0.92, z0 = j + 0.06, z1 = j + 0.94;
        box(g, x0, x1, 0, 0.44, z0, z1, walnut);
        box(g, x0 + 0.02, x1 - 0.02, 0.44, 0.52, z0 + 0.02, z1 - 0.02, vel);
        box(g, x1 - 0.16, x1 - 0.02, 0.52, 1.12, z0 + 0.02, z1 - 0.02, vel);
        box(g, x1 - 0.18, x1 - 0.16, 0.5, 1.14, z0, z1, walnut2, false);
      }
      for (let i = 0; i < W; i++) {
        fb(g, f, side, i + 0.1, i + 0.9, 0.52, 0.64, 0.02, 0.1, walnut2);       // 走道側的扶手
        fb(g, f, side, i + 0.1, i + 0.9, 0.52, 0.64, D / 2 - 0.04, D / 2 + 0.04, walnut2);   // 兩個座位中間的扶手
      }
      // 行李架：天花板加高了，架子也跟著放高一點
      fb(g, f, side, 0.05, len - 0.05, 2.3, 2.33, D - 0.7, D - 0.65, brass2, false);
      fb(g, f, side, 0.05, len - 0.05, 2.28, 2.31, D - 0.3, D - 0.25, brass2, false);
      for (let u = 0.25; u < len; u += 0.75) { fb(g, f, side, u, u + 0.03, 2.25, 2.33, D - 0.7, D - 0.08, brass2, false); fb(g, f, side, u, u + 0.03, 1.9, 2.25, D - 0.1, D - 0.07, brass2, false); }
      // 乘客：坐在 paxAt 那幾格（data.js 的 paxSpots，跟站上乘客頭頂的判定用同一份）
      for (const [dx, dy] of paxSpots(f)) addPassenger(g, r, dx + 0.56, dy + 0.5, -Math.PI / 2, 0.5, { prefer: ['student', 'worker', 'granny', 'girl', 'oldman', 'conductor', 'gent'] });
      r.top = 1.14;
      return true;
    }
    case 'bunk': { // 臥鋪的上下鋪：胡桃木床架、兩層泛黃的床墊和暗紅的毯子、小鐵梯；下鋪躺著一個死去的乘客（頭枕在枕頭上）
      const mat = photoMat('w3-linen', '#d6cdb9');
      for (const [y0, y1] of [[0.35, 0.47], [1.35, 1.47]]) {
        box(g, 0.03, W - 0.03, y0 - 0.08, y0, 0.03, D - 0.03, walnut);
        box(g, 0.06, W - 0.06, y0, y1, 0.06, D - 0.06, mat);
        fb(g, f, side, 0.1, 0.5, y1, y1 + 0.1, 0.15, D - 0.15, ivory);
        fb(g, f, side, 0.6, len - 0.08, y1 - 0.02, y1 + 0.06, 0.08, D - 0.08, velvet());
      }
      for (const [x, z] of [[0.05, 0.05], [W - 0.05, 0.05], [0.05, D - 0.05], [W - 0.05, D - 0.05]]) box(g, x - 0.03, x + 0.03, 0, 1.6, z - 0.03, z + 0.03, walnut);
      fb(g, f, side, len - 0.3, len - 0.27, 0, 1.4, 0.02, 0.05, iron, false); fb(g, f, side, len - 0.08, len - 0.05, 0, 1.4, 0.02, 0.05, iron, false);
      for (let y = 0.3; y < 1.4; y += 0.28) fb(g, f, side, len - 0.3, len - 0.05, y, y + 0.03, 0.02, 0.05, iron, false);
      if (f.pax) addLyingPassenger(g, r, f, side, 0.3, 0.47);
      r.top = 1.6;
      return true;
    }
    case 'bed': { // 景觀車廂的床（原本臥鋪 A 的床搬過來）：胡桃木床框、泛黃的床單和枕頭、暗紅的毯子；床底下會伸出手（跟第一世界一樣）
      box(g, 0.03, W - 0.03, 0, 0.3, 0.03, D - 0.03, walnut);
      box(g, 0.06, W - 0.06, 0.3, 0.48, 0.06, D - 0.06, photoMat('w3-linen', '#d6cdb9'));
      fb(g, f, side, 0.1, 0.55, 0.48, 0.6, 0.15, D - 0.15, ivory);
      fb(g, f, side, 0.65, len - 0.06, 0.46, 0.56, 0.08, D - 0.08, velvet());
      r.hand = new THREE.Group(); g.add(r.hand); r.hand.visible = false;
      const skin = lm('#cfc6c0');
      fb(r.hand, f, side, 0.9, 1.05, 0.02, 0.08, -0.25, 0.1, skin, false);
      for (let i = 0; i < 4; i++) fb(r.hand, f, side, 0.88 + i * 0.05, 0.91 + i * 0.05, 0.02, 0.05, -0.4, -0.25, skin, false);
      r.top = 0.6;
      return true;
    }
    case 'ladder': { // 爬上車頂的鐵梯：釘在牆上的兩根鐵桿和橫桿，天花板上是艙口蓋
      for (const u of [0.3, 0.7]) fb(g, f, side, u - 0.03, u + 0.03, 0.1, CEIL_W3, D - 0.22, D - 0.16, iron);
      for (let y = 0.3; y < CEIL_W3 - 0.1; y += 0.3) fb(g, f, side, 0.26, 0.74, y, y + 0.04, D - 0.24, D - 0.14, iron, false);
      fb(g, f, side, 0.12, 0.88, CEIL_W3 - 0.04, CEIL_W3 - 0.005, D - 0.55, D - 0.05, lm('#2a2a2e'), false);
      r.top = CEIL_W3;
      return true;
    }
    case 'hatch': { // 車頂的艙口：鐵蓋子和拉環
      box(g, 0.12, 0.88, 0, 0.05, 0.12, 0.88, iron);
      const ring = new THREE.Mesh(geo('hatchring', () => new THREE.TorusGeometry(0.08, 0.015, 6, 14)), lm('#5e5e64')); ring.rotation.x = Math.PI / 2; ring.position.set(0.5, 0.06, 0.3); g.add(ring);
      r.top = 0.1;
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
  for (const w of W3_WINDOWS) {
    if (!w.train) continue;   // 只有列車的窗戶
    const oz = w.dir === 's' ? w.y + 1.15 : w.y - 0.15;
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      g.position.set(w.x + 0.3 + i * 0.4, 1.3 + rnd() * 0.5, oz);
      const e = ownSprite(glowTex, rnd() < 0.5 ? 0xffd9a0 : 0xff6a50); e.scale.setScalar(0.07 + rnd() * 0.05); g.add(e);
      const e2 = e.clone(); e2.position.x = 0.09; g.add(e2);
      if (rnd() < 0.6) { box(g, -0.06, 0.06, -0.3, -0.1, -0.02, 0.02, hand, false); for (let k = 0; k < 4; k++) box(g, -0.05 + k * 0.03, -0.035 + k * 0.03, -0.1, 0.02, -0.01, 0.01, hand, false); }
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
// ---------- 車頂：走得到的北側低車頂（車頂房間的地板）、中間凸起的天窗層（一排小窗）、通風帽、車廂之間的蛇腹、車尾的邊條；
// 車頭是煤水車（堆著煤）、駕駛室、鍋爐和煙囪，都在機車室的天花板上面，從車頂往車頭看得到 ----------
function buildRoof3() {
  const steel = lm('#28282c'), dark = lm('#17171a'), bellows = lm('#101012'), glass = ownBasic({ color: 0x3a2a14, transparent: true, opacity: 0.85, fog: false });
  const g = new THREE.Group(); houseGroup.add(g);
  const Z0 = W3.body.z0, Z1 = W3.body.z1, ZC = (Z0 + Z1) / 2, R = ROOF_H;   // 天窗層蓋住列車的北牆到南牆（y=4～12）
  for (let i = 0; i < W3_CARS.length; i++) {
    const c = W3_CARS[i], X0 = c.x0 - 1, X1 = c.x1 + 2;
    if (c.id === 'engine') continue;
    box(g, X0 + 0.35, X1 - 0.35, R - 0.2, R + 0.62, Z0 + 0.05, Z1 - 0.05, steel);       // 天窗層的身體
    box(g, X0 + 0.25, X1 - 0.25, R + 0.62, R + 0.72, Z0 - 0.08, Z1 + 0.08, dark);        // 頂板（兩邊微微突出）
    for (let x = X0 + 1; x < X1 - 1.2; x += 2) box(g, x + 0.2, x + 0.8, R + 0.18, R + 0.46, Z0 + 0.02, Z0 + 0.07, glass, false);   // 一排天窗
    for (let x = X0 + 2.5; x < X1 - 2; x += 4) { cyl(g, 0.12, 0.12, 0.2, x, R + 0.72, ZC, dark, 10); cyl(g, 0.3, 0.1, 0.1, x, R + 0.92, ZC, dark, 10); }   // 通風帽
    box(g, X0, X1, R - 0.12, R + 0.08, 0.86, 1.0, dark);                                // 北側的邊條
    if (i < W3_CARS.length - 1) box(g, X1 - 0.5, X1 + 0.5, R - 0.2, R + 0.35, Z0 + 0.3, Z1 - 0.3, bellows);   // 車廂之間的蛇腹
  }
  box(g, MAP_W - 1, MAP_W - 0.85, R - 0.1, R + 0.3, 0.9, Z1, dark);   // 車尾的邊條
  buildLoco(g, steel, dark);
}
// 車頭（復古蒸汽機車）：煤水車、駕駛室、橫躺的大鍋爐、蒸汽包、汽笛、煙囪；全部都在車頂的高度以上
function buildLoco(g, steel, dark) {
  const R = ROOF_H, black = lm('#141416'), coal = ownLM('#141416', { shade: 0.6 }), brass = lm('#8a6a2a');
  const Z1 = W3.body.z1, ZC = (W3.body.z0 + Z1) / 2;   // 車身的南邊、中線
  // 煤水車：x 5～10（車頂走道的西端就是它的後壁），上面堆著煤；從車頂的北邊一直蓋到車身的南邊
  box(g, 5, 10, R - 0.2, R + 0.9, 0.9, Z1 + 0.1, steel);
  box(g, 5.2, 9.8, R + 0.9, R + 0.95, 1.1, Z1 - 0.1, dark);
  for (let i = 0; i < 30; i++) { const x = 5.6 + rnd() * 3.8, z = 1.6 + rnd() * (Z1 - 2.2); sph(g, 0.22 + rnd() * 0.2, x, R + 0.95 + rnd() * 0.25, z, coal, 1 + rnd() * 0.5, 0.6 + rnd() * 0.3, 1 + rnd() * 0.5, 7); }
  // 駕駛室：x 1.8～5，屋頂比車頂高 1.3
  box(g, 1.8, 5, R - 0.2, R + 1.25, 4.2, Z1 - 0.2, steel);
  box(g, 1.7, 5.1, R + 1.25, R + 1.35, 4.0, Z1, dark);
  // 鍋爐：橫躺的大圓筒（底部剛好貼著機車室的天花板），箍著幾圈鐵環；前面是煙囪、上面是蒸汽包和汽笛
  const boiler = cyl(g, 1.25, 1.25, 6.3, 0, 0, 0, black, 24); boiler.rotation.z = Math.PI / 2; boiler.position.set(-1.35, R + 1.0, ZC);
  for (const x of [-3.6, -1.2, 1.2]) { const ring = cyl(g, 1.29, 1.29, 0.12, 0, 0, 0, dark, 24); ring.rotation.z = Math.PI / 2; ring.position.set(x, R + 1.0, ZC); }
  const C = W3.loco.chimney;
  cyl(g, 0.3, 0.34, 1.3, C.x, R + 2.0, C.y, black, 14); cyl(g, 0.46, 0.3, 0.3, C.x, R + 3.3, C.y, black, 14);
  sph(g, 0.6, -0.4, R + 2.1, ZC, black, 1, 0.8, 1, 14); cyl(g, 0.06, 0.06, 0.5, 0.6, R + 2.1, ZC, brass, 8);
  for (const z of [ZC - 1.2, ZC + 1.2]) box(g, -4.4, 1.8, R + 1.9, R + 1.94, z - 0.02, z + 0.02, brass, false);   // 扶手
  // 煙囪的煙：十幾個會長大、變淡、往車尾飄的煙團
  locoSmoke = { g: new THREE.Group(), puffs: [], x: C.x, y: R + 3.6, z: C.y };
  g.add(locoSmoke.g);
  for (let i = 0; i < 14; i++) {
    const m = new THREE.SpriteMaterial({ map: glowTex, color: 0x3a383c, transparent: true, depthWrite: false, opacity: 0.5 }); m.userData.own = true;
    const sp = new THREE.Sprite(m); locoSmoke.g.add(sp);
    locoSmoke.puffs.push({ sp, age: i / 14 * 4, life: 4, dz: (rnd() - 0.5) * 0.6, dx: rnd() * 0.3 });
  }
}
function syncLocoSmoke(dt, k) {
  if (!locoSmoke) return;
  for (const p of locoSmoke.puffs) {
    p.age += dt * (0.6 + 0.4 * k);
    if (p.age > p.life) { p.age -= p.life; p.dz = (rnd() - 0.5) * 0.6; }
    const a = p.age, f = a / p.life;
    p.sp.position.set(locoSmoke.x + p.dx + a * (0.4 + 3.2 * k), locoSmoke.y + a * 1.1 + f * f * 0.8, locoSmoke.z + p.dz * f);
    p.sp.scale.setScalar(0.9 + f * 2.6);
    p.sp.material.opacity = 0.5 * (1 - f) * (1 - f);
  }
}
// 每一幀：火爐的火、煤氣燈閃爍、站牌的站名、乘客（過場動畫時活著；夜晚事件讓某個乘客的頭慢慢轉過來看你）
let lastTF = 0;
function updateTrainFurniture(t) {
  const dtF = clamp(t - lastTF, 0, 0.1); lastTF = t;
  const fb3 = furn3d.firebox;
  if (fb3 && fb3.fire) {
    const k = fireBurning() ? 1 : (G.fire && G.fire.queue.length ? 0.35 : 0.08);
    fb3.fire.visible = k > 0.1;
    fb3.fire.children.forEach((fl, i) => fl.scale.set(1, 0.4 + (0.6 + 0.7 * Math.abs(Math.sin(t * 11 + i * 1.3))) * k, 1));
    fb3.fireMat.color.setRGB(1, 0.35 + 0.3 * k, 0.1);
    fb3.fireGlow.material.opacity = (0.3 + 0.5 * Math.abs(Math.sin(t * 9))) * k;
  }
  for (const f of FURN) { if (f.type !== 'gaslamp') continue; const r = furn3d[f.id]; if (!r || !r.flame) continue; r.flame.scale.set(1, 0.8 + 0.5 * Math.random(), 1); r.glow.material.opacity = 0.3 + 0.2 * Math.random(); }
  const sg = furn3d.sign;
  if (sg && sg.signCv && sg.signName !== curStation()) {
    sg.signName = curStation();
    const c = sg.signCv.getContext('2d');
    c.fillStyle = '#1e2a3a'; c.fillRect(0, 0, 256, 96); c.strokeStyle = '#c9c0a8'; c.lineWidth = 4; c.strokeRect(6, 6, 244, 84);
    c.fillStyle = '#e8e0c8'; c.font = 'bold 44px "PingFang TC","Noto Sans TC",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(sg.signName, 128, 50);
    sg.signTex.needsUpdate = true;
  }
  updatePassengers(dtF);
}

// ====================================================================
// 第四世界：3008 無盡賣場（照 Roblox 的《3008》）。灰色的水泥地（主走道是淺色地磚，畫著指引方向的箭頭）、方形的水泥柱、
// 一間一間彩色牆的樣品間、4.2 公尺高的天花板上一格一格的日光燈板（白天亮、晚上熄，天快黑時一排一排閃掉）、
// 吊著的區域招牌、入口打不開的玻璃自動門（門外只有白霧）。家具大部分可以搬（拿起來時拆掉、放下時重建）；
// 自己蓋的牆、門、屋頂、地上的板子、板材堆；拿著東西時前面的預覽
// ====================================================================
let store4Tex = null, plankMats = null, panel4 = null, panel4Info = [], grass4Mesh = null, ghostMesh4 = null, handPlank4 = null;
const wall4Map = new Map(), roof4Map = new Map(), loose4Map = new Map(), ramp4Map = new Map();
let build4Ver = -1;
// 賣場的貼圖（全部用程式畫）
function makeStoreTextures() {
  const T = {};
  const speck = (c, w, h, n, col, s0 = 1, s1 = 3) => { for (let i = 0; i < n; i++) { c.fillStyle = col(); c.fillRect(rnd() * w, rnd() * h, s0 + rnd() * (s1 - s0), s0 + rnd() * (s1 - s0)); } };
  // 打磨過的水泥地：淺灰、一點一點的斑、偶爾一條裂縫，四邊一條很淡的縫（一格 1 公尺）
  T.store = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#9fa19f'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { const g = c.createRadialGradient(rnd() * w, rnd() * h, 0, rnd() * w, rnd() * h, 30 + rnd() * 50); g.addColorStop(0, `rgba(${rnd() < 0.5 ? '255,255,255' : '40,40,40'},${0.03 + rnd() * 0.05})`); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, 0, w, h); }
    speck(c, w, h, 900, () => `rgba(${rnd() < 0.5 ? '70,70,72' : '200,200,198'},${0.15 + rnd() * 0.2})`, 1, 2.5);
    c.strokeStyle = 'rgba(60,60,62,.35)'; c.lineWidth = 2; c.strokeRect(1, 1, w - 2, h - 2);
    if (rnd() < 1) { c.strokeStyle = 'rgba(50,50,52,.25)'; c.lineWidth = 1; c.beginPath(); let x = rnd() * w, y = 0; c.moveTo(x, y); while (y < h) { x += (rnd() - 0.5) * 18; y += 10 + rnd() * 14; c.lineTo(x, y); } c.stroke(); }
  });
  // 主走道：淺米灰色的大地磚
  T.aisle = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#d3cfc6'; c.fillRect(0, 0, w, h);
    speck(c, w, h, 700, () => `rgba(${rnd() < 0.5 ? '150,145,135' : '240,238,232'},${0.2 + rnd() * 0.2})`, 1, 2);
    c.strokeStyle = 'rgba(120,115,105,.5)'; c.lineWidth = 3; c.strokeRect(1.5, 1.5, w - 3, h - 3);
  });
  // 樣品間的淺色橡木地板、兒童房的灰藍色地毯
  T.oak = canvasTex(256, 256, (c, w, h) => {
    for (let y = 0; y < h; y += 32) {
      const off = ((y / 32) % 2) * 96;
      for (let x = -off; x < w; x += 192) {
        c.fillStyle = shade('#c9a77e', (rnd() - 0.5) * 26); c.fillRect(x, y, 192, 32);
        c.strokeStyle = 'rgba(120,85,50,.25)'; c.lineWidth = 1;
        for (let k = 0; k < 5; k++) { c.beginPath(); c.moveTo(x, y + 4 + rnd() * 24); c.bezierCurveTo(x + 60, y + rnd() * 32, x + 120, y + rnd() * 32, x + 192, y + 4 + rnd() * 24); c.stroke(); }
        c.fillStyle = 'rgba(70,45,25,.35)'; c.fillRect(x, y, 2, 32);
      }
      c.fillStyle = 'rgba(70,45,25,.3)'; c.fillRect(0, y, w, 1.5);
    }
  });
  T.carpet = canvasTex(128, 128, (c, w, h) => { c.fillStyle = '#7d8ea0'; c.fillRect(0, 0, w, h); speck(c, w, h, 900, () => `rgba(${rnd() < 0.5 ? '255,255,255' : '20,30,40'},${0.06 + rnd() * 0.08})`, 1, 2); });
  // 外牆：漆成白灰色的空心磚牆，底下一圈深灰色的踢腳板，上面一條藍灰色的線
  T.wall = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#d8d6d0'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) for (let x = ((y / 32) % 2) * 32; x < w + 64; x += 64) { c.fillStyle = shade('#d8d6d0', (rnd() - 0.5) * 12); c.fillRect(x - 64 + 2, y + 2, 60, 28); }
    speck(c, w, h, 300, () => `rgba(0,0,0,${0.03 + rnd() * 0.05})`, 1, 3);
    c.fillStyle = '#4a4d52'; c.fillRect(0, h - 14, w, 14);
  });
  // 樣品間的隔間牆：白色的油漆牆（貼圖是白的，每面牆再乘上自己的顏色），底下白色踢腳板
  T.part = canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#f2f0ea'; c.fillRect(0, 0, w, h);
    speck(c, w, h, 400, () => `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + rnd() * 0.03})`, 1, 4);
    c.fillStyle = '#fbfaf6'; c.fillRect(0, h - 20, w, 20); c.fillStyle = 'rgba(0,0,0,.12)'; c.fillRect(0, h - 21, w, 1.5);
  });
  // 柱子：灰色的清水模水泥，底下一圈黃黑相間的警示線
  T.pillar = canvasTex(128, 512, (c, w, h) => {
    c.fillStyle = '#9b9c99'; c.fillRect(0, 0, w, h);
    speck(c, w, h, 600, () => `rgba(${rnd() < 0.5 ? '60,60,60' : '210,210,205'},${0.1 + rnd() * 0.15})`, 1, 3);
    for (const y of [128, 256, 384]) { c.fillStyle = 'rgba(60,60,60,.25)'; c.fillRect(0, y, w, 2); }
    for (let x = -20; x < w; x += 20) { c.fillStyle = (x / 20) % 2 ? '#1a1a1a' : '#e8c23a'; c.beginPath(); c.moveTo(x, h); c.lineTo(x + 20, h); c.lineTo(x + 34, h - 24); c.lineTo(x + 14, h - 24); c.fill(); }
  });
  // 天花板：60 公分的吸音板
  T.ceil = canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#c9c8c3'; c.fillRect(0, 0, w, h);
    speck(c, w, h, 700, () => `rgba(80,80,80,${0.08 + rnd() * 0.12})`, 1, 2);
    c.fillStyle = '#e4e3de'; c.fillRect(0, 0, w, 3); c.fillRect(0, 0, 3, h); c.fillRect(0, h / 2, w, 2); c.fillRect(w / 2, 0, 2, h);
  });
  // 日光燈板：白色的擴散板，四周鋁框
  T.panel = canvasTex(128, 64, (c, w, h) => {
    c.fillStyle = '#9da0a4'; c.fillRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#f4f6ff'); g.addColorStop(0.5, '#ffffff'); g.addColorStop(1, '#eef0fa');
    c.fillStyle = g; c.fillRect(6, 6, w - 12, h - 12);
    c.strokeStyle = 'rgba(160,165,175,.6)'; c.lineWidth = 1; for (let x = 10; x < w - 6; x += 8) { c.beginPath(); c.moveTo(x, 6); c.lineTo(x, h - 6); c.stroke(); }
  });
  // 地上指方向的箭頭
  T.arrow = canvasTex(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h); c.fillStyle = 'rgba(70,70,70,.55)';
    c.beginPath(); c.moveTo(64, 14); c.lineTo(108, 62); c.lineTo(80, 62); c.lineTo(80, 114); c.lineTo(48, 114); c.lineTo(48, 62); c.lineTo(20, 62); c.closePath(); c.fill();
  });
  T.arrow.wrapS = T.arrow.wrapT = THREE.ClampToEdgeWrapping;
  T.crack = crack4Tex();
  store4Tex = T;
}
// 牆的裂痕（板子被打的時候疊上去，越破越明顯）：第五世界沒有蓋賣場（不會呼叫 makeStoreTextures），第一次放板子時才畫
let crack4 = null;
function crack4Tex() {
  if (crack4) return crack4;
  crack4 = canvasTex(256, 512, (c, w, h) => {
    c.clearRect(0, 0, w, h); c.lineCap = 'round'; c.lineJoin = 'round';
    // 幾個被打到的點，從那裡往外裂出細細的、折來折去的裂縫
    for (let k = 0; k < 4; k++) {
      const cx = 40 + rnd() * 176, cy = 80 + rnd() * 380;
      for (let i = 0; i < 7; i++) {
        let x = cx, y = cy, a = rnd() * Math.PI * 2;
        c.beginPath(); c.moveTo(x, y);
        for (let s = 0; s < 8; s++) { a += (rnd() - 0.5) * 0.9; const L = 8 + rnd() * 16; x += Math.cos(a) * L; y += Math.sin(a) * L; c.lineTo(x, y); }
        c.strokeStyle = 'rgba(25,18,12,.8)'; c.lineWidth = 1.2 + rnd() * 1.2; c.stroke();
        c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 0.6; c.stroke();
      }
      c.fillStyle = 'rgba(20,15,10,.55)'; c.beginPath(); c.arc(cx, cy, 3 + rnd() * 4, 0, 7); c.fill();
    }
  });
  crack4.wrapS = crack4.wrapT = THREE.ClampToEdgeWrapping;
  return crack4;
}
// 吊著的招牌（深灰色的板子、白字、下面一條顏色）
const sign4Cache = new Map();
function sign4Tex(text, col = '#e8c23a') {
  const key = text + col;
  if (sign4Cache.has(key)) return sign4Cache.get(key);
  const t = canvasTex(512, 128, (c, w, h) => {
    c.fillStyle = '#2b2d33'; c.fillRect(0, 0, w, h);
    c.fillStyle = col; c.fillRect(0, h - 14, w, 14);
    c.fillStyle = '#f4f2ec'; c.font = 'bold 58px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 - 6, w - 30);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  sign4Cache.set(key, t);
  return t;
}
// 五級板子的材質：木頭夾板、白色的牆面、亮金色的金屬、黑色岩石裡流著岩漿、透明的強化玻璃
function makePlankMats() {
  const wood = canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#b8895a'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { c.strokeStyle = `rgba(${110 + rnd() * 40 | 0},${70 + rnd() * 30 | 0},${40 + rnd() * 20 | 0},${0.25 + rnd() * 0.3})`; c.lineWidth = 1 + rnd() * 2; const x = rnd() * w; c.beginPath(); c.moveTo(x, 0); c.bezierCurveTo(x + (rnd() - 0.5) * 20, h * 0.3, x + (rnd() - 0.5) * 20, h * 0.7, x + (rnd() - 0.5) * 12, h); c.stroke(); }
    for (let i = 0; i < 3; i++) { const x = rnd() * w, y = rnd() * h; c.fillStyle = 'rgba(90,55,25,.6)'; c.beginPath(); c.ellipse(x, y, 4 + rnd() * 4, 7 + rnd() * 6, 0, 0, 7); c.fill(); }
    c.fillStyle = 'rgba(80,50,25,.45)'; c.fillRect(0, 0, 3, h); c.fillRect(w - 3, 0, 3, h);
  });
  const plaster = canvasTex(128, 256, (c, w, h) => {
    c.fillStyle = '#ece9e2'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + rnd() * 0.04})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 4, 1 + rnd() * 4); }
    c.fillStyle = '#d6d2c8'; c.fillRect(0, h - 16, w, 16); c.fillStyle = 'rgba(0,0,0,.15)'; c.fillRect(0, h - 17, w, 1.5);
  });
  const brushed = canvasTex(64, 128, (c, w, h) => { c.fillStyle = '#d8a83a'; c.fillRect(0, 0, w, h); for (let i = 0; i < 200; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '255,240,180' : '120,80,10'},${0.08 + rnd() * 0.1})`; c.fillRect(0, rnd() * h, w, 1); } });
  const M = [null];
  M[1] = patchLM(new THREE.MeshLambertMaterial({ map: wood }));
  M[2] = patchLM(new THREE.MeshLambertMaterial({ map: plaster }));
  M[3] = patchLM(new THREE.MeshPhongMaterial({ map: brushed, color: 0xffffff, specular: 0xfff0b0, shininess: 70, emissive: 0x2a1a00 }));
  M[4] = patchLM(new THREE.MeshLambertMaterial({ map: rockTex, emissiveMap: lavaCrackTex, emissive: 0xff5a10 }));
  M[5] = patchLM(new THREE.MeshPhongMaterial({ color: 0xcfe8f0, transparent: true, opacity: 0.26, specular: 0xffffff, shininess: 100, depthWrite: false, side: THREE.DoubleSide }));
  plankMats = M;
}
const PLANK_EDGE = ['', '#7a5532', '#bdb8ac', '#b8861a', '#2a1208', '#e8f6ff'];
// 一片牆（或門）：2×2 公尺的正方形板子（PLANK4），0.1 公尺厚，放在格子的邊上（橫跨兩個邊）；門是兩扇對開，可以打開
function buildWall4(w) {
  // 斜放的牆（free）：外層放在中心、照角度轉，裡面跟水平的牆（h）一樣從 0 到 2 公尺
  const W = PLANK4, H = PLANK4;
  const g0 = new THREE.Group(); scene.add(g0);
  const g = new THREE.Group(); g0.add(g);
  if (w.free) { g0.position.set(w.cx, w.lv || 0, w.cy); g0.rotation.y = -w.ang; g.position.x = -W / 2; } else g0.position.set(w.x, w.lv || 0, w.y);
  // 整片放在第 lv 公尺的高度（下面的被打破就往下掉，見 syncBuild4）
  const mat = plankMats[w.tier], edge = lm(PLANK_EDGE[w.tier]);
  const res = { g: g0, w };
  const piv = new THREE.Group(); g.add(piv); res.piv = piv;
  const hz = w.free || w.o === 'h';
  // 沿著牆（u：0～W）、高度（y）、厚度（t）的方塊
  const slab = (par, u0, u1, y0, y1, t, m, sh = true) => (hz ? box(par, u0, u1, y0, y1, -t, t, m, sh) : box(par, -t, t, y0, y1, u0, u1, m, sh));
  // 斜靠的牆（繞 X 或 Z 轉了 15°、45°）：從底部往一邊倒
  if (w.lean && !w.door) { if (hz) piv.rotation.x = w.lean * Math.PI / 180; else piv.rotation.z = -w.lean * Math.PI / 180; }
  if (w.door) {
    // 兩扇對開的門：門框 + 兩片可以轉的門板（各自繞外側的邊轉），門把是黃銅
    slab(g, 0.0, 0.06, 0, H, 0.07, edge); slab(g, W - 0.06, W, 0, H, 0.07, edge); slab(g, 0.0, W, H - 0.06, H, 0.07, edge);
    const leaf = (W - 0.12) / 2 - 0.005, kn = lm('#d6a84a');
    const piv2 = new THREE.Group(); g.add(piv2); res.piv2 = piv2;
    if (hz) { piv.position.x = 0.06; piv2.position.x = W - 0.06; } else { piv.position.z = 0.06; piv2.position.z = W - 0.06; }
    slab(piv, 0, leaf, 0, H - 0.07, 0.035, mat); slab(piv2, -leaf, 0, 0, H - 0.07, 0.035, mat);
    for (const [pv, u] of [[piv, leaf - 0.1], [piv2, -leaf + 0.1]]) {
      slab(pv, u > 0 ? 0.06 : -leaf + 0.06, u > 0 ? leaf - 0.06 : -0.06, H * 0.55, H * 0.55 + 0.04, 0.045, edge, false);   // 門板上的橫條（看得出是兩扇）
      for (const s of [-1, 1]) sph(pv, 0.03, hz ? u : s * 0.06, 1.0, hz ? s * 0.06 : u, kn);
    }
    res.panel = piv;
  } else {
    slab(piv, 0.02, W - 0.02, 0.01, H - 0.01, 0.05, mat, w.tier !== 5);
    if (w.tier !== 5) {
      // 四邊的收邊條（看得出是一片一片的正方形）；木頭板子中間多三條直的縫，像四片木板拼起來的
      const bar = (u0, u1, y0, y1) => slab(piv, u0, u1, y0, y1, 0.055, edge, false);
      bar(0.02, W - 0.02, H - 0.06, H - 0.01); bar(0.02, W - 0.02, 0.01, 0.06); bar(0.02, 0.07, 0.01, H - 0.01); bar(W - 0.07, W - 0.02, 0.01, H - 0.01);
      if (w.tier === 1) for (let i = 1; i < 4; i++) slab(piv, i * W / 4 - 0.008, i * W / 4 + 0.008, 0.06, H - 0.06, 0.052, edge, false);
    } else {   // 玻璃：細細的鋁框，中間一條橫的
      const al = lm('#c8ccd0');
      slab(piv, 0.0, 0.03, 0, H, 0.04, al); slab(piv, W - 0.03, W, 0, H, 0.04, al); slab(piv, 0, W, H - 0.04, H, 0.04, al); slab(piv, 0, W, 0, 0.04, 0.04, al); slab(piv, 0, W, H / 2 - 0.02, H / 2 + 0.02, 0.04, al);
    }
  }
  // 裂痕：兩面各一片，越破越明顯
  if (w.tier !== 5) {
    const cm = ownBasic({ map: crack4Tex(), transparent: true, opacity: 0, depthWrite: false });
    for (const s of [-1, 1]) {
      const pl = new THREE.Mesh(geo('crack4w' + W, () => new THREE.PlaneGeometry(W * 0.9, H * 0.9)), cm);
      if (hz) { pl.position.set(W / 2, H * 0.48, s * 0.056); pl.rotation.y = s > 0 ? 0 : Math.PI; } else { pl.position.set(s * 0.056, H * 0.48, W / 2); pl.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2; }
      piv.add(pl);
    }
    res.crack = cm;
  }
  res.fire = ownSprite(glowTex, 0xff7a20); res.fire.scale.set(2.2, 2.2, 1); res.fire.position.set(hz ? W / 2 : 0, H / 2, hz ? 0 : W / 2); res.fire.visible = false; g.add(res.fire);
  return res;
}
function buildRoof4(r) {
  // 屋頂：2×2 公尺躺平的板子，蓋住 2×2 格；沒有完全躺平的屋頂（倒了 60°、75°）斜斜的：繞中心轉
  const W = PLANK4, g = new THREE.Group(); g.position.set(r.x + W / 2, ROOF4_H, r.y + W / 2); scene.add(g);
  if (r.tilt) g.rotation[r.tax === 'z' ? 'z' : 'x'] = r.tilt * Math.PI / 180;
  box(g, -W / 2, W / 2, -0.04, 0.04, -W / 2, W / 2, plankMats[r.tier], r.tier !== 5);
  const edge = lm(PLANK_EDGE[r.tier]);
  for (const s of [-1, 1]) { box(g, -W / 2, W / 2, -0.05, 0.05, s * W / 2 - (s > 0 ? 0.05 : 0), s * W / 2 + (s < 0 ? 0.05 : 0), edge, false); box(g, s * W / 2 - (s > 0 ? 0.05 : 0), s * W / 2 + (s < 0 ? 0.05 : 0), -0.05, 0.05, -W / 2, W / 2, edge, false); }
  return { g, r };
}
// 斜坡：一片板子斜 45° 放在 2×2 格上，從 lv 公尺往 dir 的方向升高 2 公尺（可以走上去）
function buildRamp4(rp) {
  const W = PLANK4, g = new THREE.Group(); g.position.set(rp.x + W / 2, rp.lv + W / 2, rp.y + W / 2); scene.add(g);
  g.rotation.y = { e: -Math.PI / 2, w: Math.PI / 2, s: Math.PI, n: 0 }[rp.dir];
  const b = new THREE.Group(); b.rotation.x = Math.PI / 4; g.add(b);   // 往 -z（dir 的方向）翹起來
  const L = W * Math.SQRT2, mat = plankMats[rp.tier], edge = lm(PLANK_EDGE[rp.tier]), hw = W / 2 - 0.02;
  box(b, -hw, hw, -0.03, 0.02, -L / 2, L / 2, mat, rp.tier !== 5);
  for (const x of [-hw, hw - 0.04]) box(b, x, x + 0.04, 0.02, 0.04, -L / 2, L / 2, edge, false);
  for (let i = 1; i < 9; i++) box(b, -hw + 0.03, hw - 0.03, 0.02, 0.035, -L / 2 + i * L / 9 - 0.015, -L / 2 + i * L / 9 + 0.015, edge, false);   // 防滑條，看得出是可以走的斜坡
  return { g };
}
// 地上的板子（設計師：木板就是木板）：一片正方形的板子平躺在地上，旁邊是稀有度顏色的收邊
function buildLoose4(l) {
  const g = new THREE.Group(); g.position.set(l.x, 0, l.y); g.rotation.y = l.a || 0; scene.add(g);
  const L = 1.1, Wd = 1.1;   // 2×2 公尺的板子（門也是）縮小一點平躺在地上，才不會整片疊在一起
  box(g, -L / 2, L / 2, 0, 0.035, -Wd / 2, Wd / 2, plankMats[l.tier], false);
  box(g, -L / 2, L / 2, 0.035, 0.04, -Wd / 2 - 0.01, -Wd / 2 + 0.02, lm(RARITY[PLANKS[l.tier].rar].color), false);
  box(g, -L / 2, L / 2, 0.035, 0.04, Wd / 2 - 0.02, Wd / 2 + 0.01, lm(RARITY[PLANKS[l.tier].rar].color), false);
  if (l.door) sph(g, 0.03, L / 2 - 0.2, 0.06, 0.2, lm('#d6a84a'));
  return { g };
}
// 每一幀：自己蓋的牆、屋頂、地上的板子跟遊戲狀態對齊；牆被打的時候會抖、有裂痕、著火時有火光；門打開時轉開
function syncBuild4(t) {
  if (!G.b4) return;
  if (!plankMats) makePlankMats();
  const sync = (map, list, build) => {
    const seen = new Set();
    for (const o of list) { seen.add(o); if (!map.has(o)) map.set(o, build(o)); }
    for (const [o, r] of map) if (!seen.has(o)) { disposeGroup(r.g); map.delete(o); }
  };
  sync(wall4Map, G.b4.list, buildWall4);
  sync(roof4Map, roofList4(), buildRoof4);
  sync(ramp4Map, rampList4(), buildRamp4);
  sync(loose4Map, G.loose4, buildLoose4);
  for (const [w, r] of wall4Map) {
    const k = w.tier === 5 ? 1 : clamp(w.hp / PLANKS[w.tier].hp, 0, 1);
    if (r.crack) r.crack.opacity = k < 0.85 ? Math.min(0.9, (1 - k) * 1.2) : 0;
    const sh = w.hitT > 0 ? (Math.random() - 0.5) * 0.03 : 0;
    // 下面的板子被打破時，上面的慢慢掉下來（lv 變小）
    r.y = r.y === undefined ? w.lv : r.y > w.lv ? Math.max(w.lv, r.y - 0.15) : w.lv;
    if (w.free) r.g.position.set(w.cx + sh, r.y, w.cy); else r.g.position.set(w.x + (w.o === 'v' ? sh : 0), r.y, w.y + (w.o === 'h' ? sh : 0));
    if (w.door) { const a = w.open ? 1.45 : 0; r.piv.rotation.y += (-a - r.piv.rotation.y) * 0.25; r.piv2.rotation.y += (a - r.piv2.rotation.y) * 0.25; }
    r.fire.visible = w.burn > 0;
    if (r.fire.visible) r.fire.material.opacity = 0.5 + 0.4 * Math.random();
  }
  if (plankMats[4]) { const k = 0.6 + 0.4 * Math.sin(t * 2.2); plankMats[4].emissive.setRGB(k, k * 0.35, k * 0.06); }
}
// 吹口哨後的紅點（怪物）、藍點（朋友）：畫在 3D 畫面上、隔著牆也看得到（設計師：不要標在地圖上，要像 3008 一樣）
const whistleDots = [];
let whistleDotTex = null;
function syncWhistle4(t) {
  const dots = mode === 'play' && isW4() ? whistleDots4() : [];
  if (!whistleDotTex && dots.length) whistleDotTex = canvasTex(64, 64, c => { const g = c.createRadialGradient(32, 32, 0, 32, 32, 30); g.addColorStop(0, '#fff'); g.addColorStop(0.35, '#fff'); g.addColorStop(0.5, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, 64, 64); });
  while (whistleDots.length < dots.length) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: whistleDotTex, transparent: true, depthTest: false, depthWrite: false, fog: false, sizeAttenuation: false }));   // 遠近都一樣大
    s.material.userData.own = true; s.renderOrder = 999; scene.add(s); whistleDots.push(s);
  }
  whistleDots.forEach((s, i) => {
    const d = dots[i];
    s.visible = !!d;
    if (!d) return;
    s.position.set(d.x, d.h, d.y);
    s.material.color.setHex(d.red ? 0xff2a2a : 0x3a8aff);
    // 點越大代表離你越近（設計師：紅、藍點越大代表距離越近）：3 公尺內最大，越遠越小
    const dist = Math.hypot(d.x - camera.position.x, d.y - camera.position.z);
    s.scale.setScalar((0.022 + 0.09 * clamp(1 - (dist - 3) / 38, 0, 1)) * (1 + 0.12 * Math.sin(t * 8 + i)));
    s.material.opacity = d.a;
  });
}
// 預覽：拿著板子或家具時，前面放下的位置（綠色＝放得下、紅色＝放不下）
function syncGhost4() {
  if (!ghostMesh4) {
    ghostMesh4 = new THREE.Group(); scene.add(ghostMesh4);
    ghostMesh4.box = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0x60ff80, transparent: true, opacity: 0.28, depthWrite: false }));
    ghostMesh4.edge = new THREE.LineSegments(new THREE.EdgesGeometry(BOX), new THREE.LineBasicMaterial({ color: 0x9dffb0, transparent: true, opacity: 0.9 }));
    ghostMesh4.add(ghostMesh4.box, ghostMesh4.edge);
  }
  const g = mode === 'play' && isW4() && G.hand ? ghost4() : null;   // ghost4() 在 world4.js
  ghostMesh4.visible = !!g;
  if (!g) return;
  const col = g.ok ? 0x60ff80 : 0xff5050;
  ghostMesh4.box.material.color.setHex(col); ghostMesh4.edge.material.color.setHex(g.ok ? 0xb0ffc0 : 0xff9a9a);
  ghostMesh4.rotation.set(0, 0, 0, 'YXZ');
  if (g.kind === 'wall' || g.kind === 'free') {
    // 一片 2×2 公尺的正方形板子（門也是），疊在第 lv 公尺；斜靠的話從底部倒下去（中心跟著移）
    const W = PLANK4, H = PLANK4, y0 = g.lv || 0;
    const th = g.kind === 'free' ? -g.ang : g.o === 'h' ? 0 : -Math.PI / 2, lean = (g.lean || 0) * Math.PI / 180;
    const cx = g.kind === 'free' ? g.cx : g.o === 'h' ? g.x + W / 2 : g.x, cz = g.kind === 'free' ? g.cy : g.o === 'h' ? g.y : g.y + W / 2;
    ghostMesh4.rotation.set(lean, th, 0, 'YXZ');
    ghostMesh4.position.set(cx + Math.sin(th) * Math.sin(lean) * H / 2, y0 + Math.cos(lean) * H / 2, cz + Math.cos(th) * Math.sin(lean) * H / 2);
    ghostMesh4.scale.set(W - 0.04, H, 0.1);
  } else if (g.kind === 'ramp') {
    // 斜坡：2×2 格斜 45°，往 dir 的方向升高
    const W = PLANK4;
    ghostMesh4.rotation.set(Math.PI / 4, { e: -Math.PI / 2, w: Math.PI / 2, s: Math.PI, n: 0 }[g.dir], 0, 'YXZ');
    ghostMesh4.position.set(g.x + W / 2, g.lv + W / 2, g.y + W / 2); ghostMesh4.scale.set(W - 0.04, 0.06, W * Math.SQRT2);
  } else if (g.kind === 'roof') { ghostMesh4.position.set(g.x + PLANK4 / 2, ROOF4_H, g.y + PLANK4 / 2); ghostMesh4.scale.set(PLANK4, 0.08, PLANK4); if (g.tilt) ghostMesh4.rotation[g.tax === 'z' ? 'z' : 'x'] = g.tilt * Math.PI / 180; }
  else { const fh = G.hand.f.solid === false ? 0.05 : 1.0; ghostMesh4.position.set(g.x + g.w / 2, fh / 2, g.y + g.h / 2); ghostMesh4.scale.set(g.w, fh, g.h); ghostMesh4.rotation.y = -(g.yaw || 0) * Math.PI / 180; }
}
// 手上拿的板子（畫面右下角）
function syncHand4() {
  if (!handPlank4) {
    handPlank4 = new THREE.Group(); camera.add(handPlank4);
    handPlank4.position.set(0.32, -0.42, -0.62); handPlank4.rotation.set(0.15, -0.5, 0.1);
  }
  const h = mode === 'play' && isW4() && G.hand && G.hand.k !== 'item' ? G.hand : null;
  const key = h ? (h.k === 'plank' ? 'p' + h.tier + (h.door ? 'd' : '') : 'f') : '';
  if (handPlank4.userData.key !== key) {
    handPlank4.userData.key = key;
    while (handPlank4.children.length) { const c = handPlank4.children[0]; handPlank4.remove(c); }
    if (h && h.k === 'plank') { if (!plankMats) makePlankMats(); box(handPlank4, -0.26, 0.26, -0.26, 0.26, -0.015, 0.015, plankMats[h.tier], false); if (h.door) sph(handPlank4, 0.02, 0.2, 0, 0.02, lm('#d6a84a')); }   // 正方形的板子（門也是）
    else if (h) box(handPlank4, -0.14, 0.14, -0.1, 0.1, -0.1, 0.1, lm('#b08a5a'), false);
  }
  handPlank4.visible = !!h;
}
// ====================================================================
// 第四世界的家具（寫實風：布沙發、皮沙發、實木、鐵貨架、不鏽鋼）。布、皮、木頭用第三世界的照片乘上顏色（沒有照片就是純色）；
// 同一種家具每件的顏色照 id 有一點不一樣（搬動後重建也一樣）
// ====================================================================
const fab4 = c => photoMat('w3-linen', c), vel4 = c => photoMat('w3-velvet', c), wood4 = c => photoMat('w3-wood', c), leath4 = c => photoMat('w3-leather', c);
// 正面座標（u 沿著正面、v 從正面往內）換成家具群組裡的座標（跟 fb 一樣）
function fpt4(f, side, u, y, v) {
  const W = f.w, D = f.h;
  if (side === 's') return new THREE.Vector3(u, y, D - v);
  if (side === 'n') return new THREE.Vector3(u, y, v);
  if (side === 'e') return new THREE.Vector3(W - v, y, u);
  return new THREE.Vector3(v, y, u);
}
// 轉好方向的子群組：放在家具中間，本地的 +z 朝正面、x 沿著正面（形狀斜斜的家具用這個做比較方便）
function orient4(g, f, side) {
  const o = new THREE.Group(); o.position.set(f.w / 2, 0, f.h / 2);
  o.rotation.y = { s: 0, n: Math.PI, e: Math.PI / 2, w: -Math.PI / 2 }[side] || 0;
  g.add(o); return o;
}
// 兩點之間的一根方棒（梯子的腳、購物車的鐵條）
function beam4(g, x0, y0, z0, x1, y1, z1, t, mat, t2 = t) {
  const m = new THREE.Mesh(BOX, mat);
  _v.set(x1 - x0, y1 - y0, z1 - z0);
  m.scale.set(t, Math.max(0.001, _v.length()), t2);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.quaternion.setFromUnitVectors(UP, _v.normalize());
  m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
}
const hash4 = s => { let h = 7; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h >>> 0; };
// 地毯：五種花樣（米色羊毛、灰藍條紋、菱格、深灰流蘇、復古花邊），畫一次重複用
const rug4Mats = [];
function rug4Mat(k) {
  if (rug4Mats[k]) return rug4Mats[k];
  const t = canvasTex(256, 256, (c, w, h) => {
    const base = ['#cdbfa6', '#7d8ea0', '#d8d0c0', '#3e3f42', '#9a5a48'][k];
    c.fillStyle = base; c.fillRect(0, 0, w, h);
    if (k === 1) for (let x = 0; x < w; x += 32) { c.fillStyle = x % 64 ? '#5d6e80' : '#a8b4c0'; c.fillRect(x, 0, 12, h); }
    if (k === 2) { c.strokeStyle = '#8a7a62'; c.lineWidth = 3; for (let i = -h; i < w; i += 36) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.moveTo(i + h, 0); c.lineTo(i, h); c.stroke(); } }
    if (k === 4) { c.strokeStyle = '#e0c89a'; c.lineWidth = 6; c.strokeRect(14, 14, w - 28, h - 28); c.strokeStyle = '#3a2a3a'; c.lineWidth = 3; c.strokeRect(28, 28, w - 56, h - 56); c.fillStyle = '#e0c89a'; c.beginPath(); c.ellipse(w / 2, h / 2, 50, 34, 0, 0, 7); c.fill(); c.fillStyle = '#5a2e2a'; c.beginPath(); c.ellipse(w / 2, h / 2, 34, 20, 0, 0, 7); c.fill(); }
    if (k === 0) { c.strokeStyle = 'rgba(90,70,50,.35)'; c.lineWidth = 4; c.strokeRect(16, 16, w - 32, h - 32); }
    // 羊毛的毛絨感
    for (let i = 0; i < 2600; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + rnd() * 0.06})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); }
    if (k === 3) { c.fillStyle = '#d8d2c4'; for (let x = 0; x < w; x += 6) { c.fillRect(x, 0, 2, 8); c.fillRect(x, h - 8, 2, 8); } }
  });
  return (rug4Mats[k] = patchLM(new THREE.MeshLambertMaterial({ map: t })));
}
// 紙箱的貼圖（瓦楞紙、膠帶、一張白色的標籤）
let box4Mat = null;
function cardboard4() {
  if (box4Mat) return box4Mat;
  const t = canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#b48a5a'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 300; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? '90,60,30' : '220,190,150'},${0.08 + rnd() * 0.1})`; c.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1); }
    c.fillStyle = 'rgba(210,190,150,.8)'; c.fillRect(0, h / 2 - 8, w, 16);
    c.fillStyle = '#f2efe8'; c.fillRect(14, 16, 44, 28); c.fillStyle = '#333'; for (let y = 22; y < 40; y += 5) c.fillRect(18, y, 30 + (y % 3) * 4, 2);
  });
  return (box4Mat = patchLM(new THREE.MeshLambertMaterial({ map: t })));
}
// 貨架上一盒一盒的商品（顏色鮮豔的包裝）
const PRODUCT4 = ['#d84a3a', '#3a7ad8', '#e8c23a', '#4aa36a', '#f2efe8', '#7a4ad8', '#e8743a', '#2a2a2a', '#5ac8d8', '#c84a8a'];
function store4Furniture(f, g, r, W, D, side, len, cabinet) {
  if (!isW4()) return false;
  void cabinet;
  const dep = side === 's' || side === 'n' ? D : W;
  const F = (u0, u1, y0, y1, v0, v1, m, sh) => fb(g, f, side, u0, u1, y0, y1, v0, v1, m, sh);
  const legs = (x0, x1, z0, z1, h, m, t = 0.03) => { for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) box(g, x - t, x + t, 0, h, z - t, z + t, m); };
  const R = seeded(hash4(f.id) % 2000000 + 11), tone = hash4(f.id) % 5;
  const pick = a => a[tone % a.length];
  const black = lm('#1d1e20'), steel = lm('#a4a9ae'), dkSteel = lm('#4a4f55'), white = lm('#eef0ee'), porcelain = ownPhong('#f4f5f3', { specular: 0x666666, shininess: 60 });
  const WOODS = ['#8a6a48', '#e8e2d6', '#4a3428', '#b89470', '#f0ece4'];
  // 有門、有抽屜的櫃子：放在後面（靠牆），深度 d
  const caseBox = (h, d, col, doors = 2, drawers = 0) => {
    const w = wood4(col), w2 = wood4(shade(col, -10)), kb = lm('#b8b0a0');
    F(0.04, len - 0.04, 0.06, h, dep - d, dep - 0.03, w);
    F(0.06, len - 0.06, 0, 0.06, dep - d + 0.03, dep - 0.05, black, false);
    const n = Math.max(1, doors * Math.round(len));
    for (let i = 0; i < n; i++) {
      const a = i * len / n + 0.06, b = (i + 1) * len / n - 0.06;
      if (drawers) for (let k = 0; k < drawers; k++) { const y0 = 0.1 + k * (h - 0.14) / drawers, y1 = 0.1 + (k + 1) * (h - 0.14) / drawers - 0.03; F(a, b, y0, y1, dep - d - 0.02, dep - d, w2, false); F((a + b) / 2 - 0.06, (a + b) / 2 + 0.06, y1 - 0.08, y1 - 0.06, dep - d - 0.045, dep - d - 0.02, kb, false); }
      else { F(a, b, 0.1, h - 0.04, dep - d - 0.02, dep - d, w2, false); const hu = i % 2 ? a + 0.06 : b - 0.06; F(hu - 0.012, hu + 0.012, h * 0.45, h * 0.45 + 0.18, dep - d - 0.05, dep - d - 0.02, kb, false); }
    }
    r.top = h;
  };
  switch (f.type) {
    case 'sofa4': {
      const col = pick(['#6d7466', '#8a8178', '#4f5a6a', '#9a8f7e', '#5d4c44']), c = vel4(col), c2 = vel4(shade(col, -12));
      F(0.05, len - 0.05, 0.1, 0.42, 0.08, dep - 0.05, c);
      F(0.05, len - 0.05, 0.42, 0.98, dep - 0.26, dep - 0.05, c2);
      F(0.05, 0.22, 0.42, 0.68, 0.06, dep - 0.05, c2); F(len - 0.22, len - 0.05, 0.42, 0.68, 0.06, dep - 0.05, c2);
      const n = Math.max(1, Math.round(len - 0.5));
      for (let i = 0; i < n; i++) {
        const a = 0.23 + i * (len - 0.46) / n, b = 0.23 + (i + 1) * (len - 0.46) / n - 0.015;
        F(a, b, 0.42, 0.57, 0.08, dep - 0.26, c);
        F(a + 0.02, b - 0.02, 0.57, 0.92, dep - 0.42, dep - 0.26, c);
      }
      for (const u of [0.12, len - 0.12]) for (const v of [0.14, dep - 0.12]) F(u - 0.025, u + 0.025, 0, 0.1, v - 0.025, v + 0.025, wood4('#3a2a1e'));
      // 一個抱枕
      F(0.28, 0.62, 0.55, 0.88, dep - 0.5, dep - 0.4, fab4(pick(['#d8c8a8', '#a84a3a', '#e8e4dc', '#5a6a4a', '#c89a5a'])));
      r.top = 0.98;
      break;
    }
    case 'armchair': {
      const col = pick(['#6a4630', '#3e3a36', '#7a5a3e', '#4b3b30', '#5a3020']), c = leath4(col), c2 = leath4(shade(col, -10));
      F(0.08, 0.92, 0.12, 0.42, 0.1, 0.92, c);
      F(0.08, 0.92, 0.42, 0.98, 0.7, 0.92, c2);
      F(0.08, 0.2, 0.42, 0.66, 0.08, 0.92, c2); F(0.8, 0.92, 0.42, 0.66, 0.08, 0.92, c2);
      F(0.21, 0.79, 0.42, 0.54, 0.1, 0.7, c);
      for (const u of [0.14, 0.86]) for (const v of [0.16, 0.86]) F(u - 0.022, u + 0.022, 0, 0.12, v - 0.022, v + 0.022, wood4('#3a2a1e'));
      r.top = 0.98;
      break;
    }
    case 'coffee4': {
      const w = wood4(pick(WOODS));
      box(g, 0.08, W - 0.08, 0.38, 0.43, 0.14, D - 0.14, w);
      box(g, 0.14, W - 0.14, 0.1, 0.12, 0.2, D - 0.2, w);
      legs(0.14, W - 0.14, 0.2, D - 0.2, 0.38, w, 0.022);
      box(g, 0.25, 0.52, 0.43, 0.445, 0.3, 0.64, lm('#c8463a'), false);
      box(g, 0.28, 0.5, 0.445, 0.455, 0.34, 0.6, lm('#e8e4dc'), false);
      cyl(g, 0.045, 0.04, 0.12, W - 0.28, 0.43, D / 2, lm('#5a7a8a'), 10);
      r.top = 0.45;
      break;
    }
    case 'tv4': {
      const w = wood4(pick(['#4a3a2e', '#e8e2d6', '#2a2a2c', '#8a6a48', '#5a4a3a'])), w2 = wood4(pick(['#3e3026', '#d8d2c6', '#1e1e20', '#7a5a3a', '#4a3a2a']));
      const tv = 0.85;
      F(0.05, len - 0.05, 0.05, 0.5, dep - 0.48, dep - 0.04, w);
      F(0.1, len / 2 - 0.02, 0.09, 0.46, dep - 0.5, dep - 0.48, w2, false); F(len / 2 + 0.02, len - 0.1, 0.09, 0.46, dep - 0.5, dep - 0.48, w2, false);
      const c = dep - 0.26, sw = Math.min(len * 0.84, 1.5), u0 = (len - sw) / 2, sh = sw * 0.5625;
      F(len / 2 - 0.18, len / 2 + 0.18, 0.5, 0.52, c - 0.1, c + 0.1, black);
      F(len / 2 - 0.03, len / 2 + 0.03, 0.52, tv, c - 0.015, c + 0.015, black);
      F(u0, u0 + sw, tv - 0.05, tv - 0.05 + sh, c - 0.03, c + 0.02, black);
      r.screen = F(u0 + 0.02, u0 + sw - 0.02, tv - 0.03, tv - 0.07 + sh, c - 0.036, c - 0.03, ownBasic({ map: staticTex, color: 0x0a0d14, fog: false }), false);
      r.screen.userData.keep = true;
      r.top = tv + sh;
      break;
    }
    case 'tvshelf4': {
      // 電器區的電視展示台：黑色的兩層台子，上面擺的電視是真的東西（world4.js 的 shelfSlots4），後面一塊「電視・特價中」的看板
      const cab = lm('#2a2c30'), top = lm('#3a3c40');
      F(0.02, len - 0.02, 0, TVSHELF4_LEVELS[0], 0.15, dep - 0.15, cab);
      F(0, len, TVSHELF4_LEVELS[0], TVSHELF4_LEVELS[0] + 0.03, 0.1, dep - 0.1, top);
      F(0.3, len - 0.3, 1.9, 2.2, dep / 2 - 0.02, dep / 2 + 0.02, ownBasic({ map: sign4Tex('電視・特價中', '#4ab0e8') }), false).userData.keep = true;
      for (const u of [0.25, len - 0.25]) F(u - 0.02, u + 0.02, TVSHELF4_LEVELS[0], 1.9, dep / 2 - 0.02, dep / 2 + 0.02, top, false);
      r.top = TVSHELF4_LEVELS[0] + 0.03;
      break;
    }
    case 'bookcase4': {
      const col = pick(['#6a4a32', '#ece6da', '#3a2a20', '#8a6a48', '#f2eee6']), w = wood4(col), H = 1.95, b0 = dep - 0.4;
      F(0.03, 0.06, 0, H, b0, dep - 0.02, w); F(len - 0.06, len - 0.03, 0, H, b0, dep - 0.02, w);
      F(0.03, len - 0.03, 0, H, dep - 0.04, dep - 0.02, wood4(shade(col, -15)));
      F(0.03, len - 0.03, H - 0.03, H, b0, dep - 0.02, w);
      const BOOK = ['#7a2e2e', '#2e4a6a', '#c9b48a', '#3e5a3a', '#5a4a6a', '#d8d2c4', '#8a6a3a', '#2a2a2a', '#a85a3a'];
      for (let s = 0; s < 5; s++) {
        const y = 0.04 + s * 0.47;
        F(0.06, len - 0.06, y, y + 0.025, b0, dep - 0.04, w);
        if (s === 4) continue;
        let u = 0.08;
        while (u < len - 0.12) {
          if (R() < 0.1) { u += 0.12 + R() * 0.15; continue; }
          if (R() < 0.06) { cyl(g, 0.05, 0.04, 0.16, fpt4(f, side, u + 0.06, 0, b0 + 0.18).x, y + 0.025, fpt4(f, side, u + 0.06, 0, b0 + 0.18).z, lm(pick(['#d8d0c0', '#5a7a8a', '#3a3a3a'])), 10); u += 0.16; continue; }
          const bw = 0.025 + R() * 0.035, bh = 0.2 + R() * 0.17;
          F(u, u + bw, y + 0.025, y + 0.025 + bh, b0 + 0.03 + R() * 0.04, dep - 0.08, lm(BOOK[(R() * BOOK.length) | 0]), false);
          u += bw + 0.004;
        }
      }
      r.top = H;
      break;
    }
    case 'plant4': {
      const pot = lm(pick(['#e8e4dc', '#3a3a3a', '#b86a48', '#d8d0c0', '#6a7a6a']));
      cyl(g, 0.2, 0.15, 0.42, 0.5, 0, 0.5, pot, 16); cyl(g, 0.18, 0.18, 0.02, 0.5, 0.39, 0.5, lm('#3a2a1e'), 14);
      cyl(g, 0.014, 0.02, 0.95, 0.5, 0.4, 0.5, wood4('#5a4030'), 6);
      const leaf = lm('#2f5a2a'), leaf2 = lm('#3e6e34');
      for (let i = 0; i < 16; i++) {
        const a = i * 2.39, h = 0.62 + i * 0.05, rr = 0.08 + (16 - i) * 0.012;
        const m = sph(g, 0.1, 0.5 + Math.cos(a) * rr, h, 0.5 + Math.sin(a) * rr, i % 2 ? leaf : leaf2, 1.4, 0.16, 0.85, 8);
        m.rotation.set(0.35 * Math.cos(a), -a, 0.45);
      }
      r.top = 1.45;
      break;
    }
    case 'rug4': {
      const pl = new THREE.Mesh(geo('rug4' + W + 'x' + D, () => new THREE.PlaneGeometry(W - 0.16, D - 0.16)), rug4Mat(tone));
      pl.rotation.x = -Math.PI / 2; pl.position.set(W / 2, 0.009, D / 2); pl.receiveShadow = true; g.add(pl);
      r.top = 0.01;
      break;
    }
    case 'blanket4': {
      const col = pick(['#a33a3a', '#c8b89a', '#4a5a7a', '#7a8a6a', '#d8d0c8']), c = fab4(col);
      box(g, 0.14, W - 0.14, 0, 0.035, 0.14, D - 0.14, c, false);
      box(g, 0.14, W - 0.14, 0.035, 0.07, D * 0.55, D - 0.14, fab4(shade(col, -10)), false);
      box(g, 0.16, W - 0.16, 0.07, 0.1, D * 0.62, D - 0.18, c, false);
      for (const z of [0.3, D - 0.36]) box(g, 0.14, W - 0.14, 0.036, 0.04, z, z + 0.05, fab4('#efe8da'), false);
      r.top = 0.1;
      break;
    }
    case 'bed4': {
      const fr = pick(['#6a4a32', '#d8d2c8', '#3a3a3e', '#8a6a48', '#5a6a7a']), frm = tone === 1 || tone === 4 ? fab4(fr) : wood4(fr);
      const duvet = fab4(pick(['#e8e4dc', '#9aa8b8', '#c8b8a0', '#e0d8e8', '#a8b8a0'])), accent = fab4(pick(['#7a3a3a', '#3a4a6a', '#5a6a4a', '#8a6a3a', '#4a4a4a'])), pil = fab4('#f6f4ee');
      F(0.04, len - 0.04, 0.1, 0.32, 0.04, dep - 0.08, frm);
      for (const u of [0.1, len - 0.1]) F(u - 0.03, u + 0.03, 0, 0.1, 0.1, 0.16, black);
      F(0.02, len - 0.02, 0, 1.15, dep - 0.1, dep - 0.02, frm);
      F(0.08, len - 0.08, 0.32, 0.55, 0.08, dep - 0.12, fab4('#f2efe8'));
      F(0.06, len - 0.06, 0.55, 0.62, 0.05, dep * 0.72, duvet);
      F(0.06, len - 0.06, 0.24, 0.62, 0.035, 0.06, duvet);
      for (const s of [0, 1]) { const a = s ? len / 2 + 0.04 : 0.14, b = s ? len - 0.14 : len / 2 - 0.04; F(a, b, 0.55, 0.69, dep - 0.46, dep - 0.14, pil); }
      F(0.07, len - 0.07, 0.62, 0.64, 0.1, 0.42, accent);
      r.top = 0.69;
      break;
    }
    case 'bunk4': {
      const w = wood4('#c8a878'), mat = fab4('#f2efe8'), sheet = [fab4('#6a8ab8'), fab4('#c86a5a')], pil = fab4('#f6f4ee');
      for (const u of [0.06, len - 0.06]) for (const v of [0.06, dep - 0.06]) F(u - 0.04, u + 0.04, 0, 1.95, v - 0.04, v + 0.04, w);
      [0.26, 1.36].forEach((y, s) => {
        F(0.06, len - 0.06, y, y + 0.1, 0.03, dep - 0.03, w);
        F(0.1, len - 0.1, y + 0.1, y + 0.26, 0.08, dep - 0.08, mat);
        F(0.1, len - 0.36, y + 0.26, y + 0.3, 0.07, dep - 0.07, sheet[s]);
        F(len - 0.38, len - 0.12, y + 0.26, y + 0.36, 0.15, dep - 0.15, pil);
      });
      F(0.6, len - 0.06, 1.72, 1.78, 0.02, 0.06, w); F(0.06, len - 0.06, 1.72, 1.78, dep - 0.06, dep - 0.02, w);
      F(0.2, 0.24, 0, 1.78, 0, 0.04, w); F(0.52, 0.56, 0, 1.78, 0, 0.04, w);
      for (let y = 0.5; y < 1.7; y += 0.28) F(0.24, 0.52, y, y + 0.03, 0.005, 0.035, w);
      r.top = 1.95;
      break;
    }
    case 'nightstand4': {
      const col = pick(WOODS), w = wood4(col), w2 = wood4(shade(col, -10)), kb = lm('#b8a070'), d0 = dep - 0.46;
      F(0.12, len - 0.12, 0, 0.56, d0, dep - 0.04, w);
      for (const y of [0.08, 0.31]) { F(0.15, len - 0.15, y, y + 0.2, d0 - 0.02, d0, w2, false); F(len / 2 - 0.05, len / 2 + 0.05, y + 0.12, y + 0.14, d0 - 0.04, d0 - 0.02, kb, false); }
      F(0.24, 0.5, 0.56, 0.6, d0 + 0.08, d0 + 0.3, lm(pick(['#7a2e2e', '#2e4a6a', '#3e5a3a'])));
      r.top = 0.6;
      break;
    }
    case 'wardrobe4': {
      const col = pick(WOODS);
      caseBox(2.12, 0.6, col, 2);
      F(0.02, len - 0.02, 2.12, 2.17, dep - 0.62, dep - 0.02, wood4(shade(col, -6)));
      r.top = 2.17;
      break;
    }
    case 'dresser4': {
      const col = pick(WOODS);
      caseBox(1.08, 0.5, col, Math.max(1, Math.round(len)) > 1 ? 0.5 : 1, 5);
      F(0.04, len - 0.04, 1.08, 1.11, dep - 0.52, dep - 0.02, wood4(shade(col, -8)));
      // 上面一面鏡子、一個花瓶
      F(len * 0.3, len * 0.7, 1.11, 1.8, dep - 0.08, dep - 0.04, wood4(shade(col, -20)));
      F(len * 0.3 + 0.04, len * 0.7 - 0.04, 1.15, 1.76, dep - 0.085, dep - 0.08, ownPhong('#b8c4cc', { specular: 0xffffff, shininess: 120 }), false);
      const vp = fpt4(f, side, len * 0.15, 1.11, dep - 0.25);
      cyl(g, 0.05, 0.06, 0.2, vp.x, 1.11, vp.z, lm('#d8d0c0'), 10);
      r.top = 1.11;
      break;
    }
    case 'toybox': {
      F(0.12, len - 0.12, 0, 0.48, dep - 0.62, dep - 0.08, wood4('#e8dcc8'));
      F(0.1, len - 0.1, 0.48, 0.55, dep - 0.64, dep - 0.06, wood4('#5a8ab8'));
      F(0.2, 0.42, 0.14, 0.36, dep - 0.635, dep - 0.62, lm('#d84a3a'), false); F(0.55, 0.77, 0.14, 0.36, dep - 0.635, dep - 0.62, lm('#e8c23a'), false);
      const bp = fpt4(f, side, 0.22, 0, 0.18);
      sph(g, 0.1, bp.x, 0.1, bp.z, lm('#3a7ad8'), 1, 1, 1, 12);
      // 一隻舊舊的熊布偶靠在箱子上
      const tp = fpt4(f, side, len - 0.25, 0, dep - 0.72), bear = fab4('#8a6a48');
      sph(g, 0.12, tp.x, 0.13, tp.z, bear, 1, 1.15, 0.9); sph(g, 0.09, tp.x, 0.34, tp.z, bear);
      for (const s of [-1, 1]) { const ep = fpt4(f, side, len - 0.25 + s * 0.07, 0, dep - 0.72); sph(g, 0.035, ep.x, 0.42, ep.z, bear); }
      r.top = 0.55;
      break;
    }
    case 'desk4': {
      const top = wood4(pick(['#c8a878', '#e8e4dc', '#4a3a2e', '#8a6a48', '#d8d0c0'])), leg = lm('#3a3c40'), d0 = dep - 0.7;
      F(0.04, len - 0.04, 0.72, 0.76, d0, dep - 0.04, top);
      for (const u of [0.08, len - 0.08]) { F(u - 0.022, u + 0.022, 0, 0.72, d0 + 0.04, d0 + 0.08, leg); F(u - 0.022, u + 0.022, 0, 0.72, dep - 0.1, dep - 0.06, leg); F(u - 0.022, u + 0.022, 0.02, 0.05, d0 + 0.04, dep - 0.06, leg); }
      if (len >= 1.5) { F(len - 0.5, len - 0.1, 0.08, 0.72, d0 + 0.05, dep - 0.08, top); for (const y of [0.12, 0.32, 0.52]) { F(len - 0.48, len - 0.12, y, y + 0.17, d0 + 0.03, d0 + 0.05, wood4('#b8a080'), false); F(len - 0.33, len - 0.27, y + 0.12, y + 0.14, d0 + 0.01, d0 + 0.03, steel, false); } }
      F(0.3, 0.66, 0.76, 0.78, d0 + 0.2, d0 + 0.45, lm('#8a8d92'));
      F(0.3, 0.66, 0.78, 1.0, d0 + 0.45, d0 + 0.47, black);
      F(len * 0.5, len * 0.5 + 0.22, 0.76, 0.81, d0 + 0.32, d0 + 0.6, lm('#2e4a6a')); F(len * 0.5 + 0.01, len * 0.5 + 0.2, 0.81, 0.85, d0 + 0.34, d0 + 0.58, lm('#7a2e2e'));
      r.top = 0.78;
      break;
    }
    case 'chair4': {
      const w = wood4(pick(['#8a6a48', '#3a2a20', '#c8a878', '#5a4030', '#e8e2d6'])), seat = fab4(pick(['#8a8178', '#4f5a6a', '#c8b89a', '#6d7466', '#9a3a3a']));
      const u0 = len / 2 - 0.23, u1 = len / 2 + 0.23, v0 = dep / 2 - 0.22, v1 = dep / 2 + 0.22;
      for (const u of [u0 + 0.03, u1 - 0.03]) for (const v of [v0 + 0.03, v1 - 0.03]) F(u - 0.02, u + 0.02, 0, 0.44, v - 0.02, v + 0.02, w);
      F(u0, u1, 0.42, 0.46, v0, v1, w); F(u0 + 0.02, u1 - 0.02, 0.46, 0.5, v0 + 0.02, v1 - 0.04, seat);
      for (const u of [u0 + 0.03, u1 - 0.03]) F(u - 0.02, u + 0.02, 0.44, 0.96, v1 - 0.05, v1 - 0.01, w);
      F(u0 + 0.01, u1 - 0.01, 0.68, 0.94, v1 - 0.045, v1 - 0.015, w);
      r.top = 0.96;
      break;
    }
    case 'fireplace4': {
      // 會燒柴的鑄鐵火爐，放在石板上；正面的玻璃窗看得到火（有燃料才亮），煙囪管往上
      const iron = lm('#2a2a2c'), iron2 = lm('#3a3a3c'), stone = lm('#8a8680'), c = len / 2, m0 = dep / 2;
      F(0.05, len - 0.05, 0, 0.06, 0.05, dep - 0.05, stone);
      F(c - 0.42, c + 0.42, 0.06, 0.16, m0 - 0.3, m0 + 0.3, iron);
      F(c - 0.4, c + 0.4, 0.16, 0.86, m0 - 0.28, m0 + 0.28, iron);
      F(c - 0.44, c + 0.44, 0.86, 0.92, m0 - 0.31, m0 + 0.31, iron2);
      F(c - 0.31, c + 0.31, 0.26, 0.74, m0 - 0.3, m0 - 0.28, iron2, false);
      r.window = F(c - 0.27, c + 0.27, 0.3, 0.7, m0 - 0.305, m0 - 0.3, ownBasic({ color: 0x120804 }), false);
      r.window.userData.keep = true;
      F(c + 0.3, c + 0.34, 0.45, 0.55, m0 - 0.36, m0 - 0.3, steel, false);
      F(c - 0.08, c + 0.08, 0.92, ROOF4_H - 0.05, m0 + 0.06, m0 + 0.22, iron);
      // 旁邊一籃木柴
      for (let i = 0; i < 5; i++) F(len - 0.32 + (i % 3) * 0.07, len - 0.26 + (i % 3) * 0.07, 0.06 + (i > 2 ? 0.07 : 0), 0.13 + (i > 2 ? 0.07 : 0), 0.15, dep - 0.2, wood4('#6a4a30'));
      r.fireGlow = ownSprite(glowTex, 0xff8a30); r.fireGlow.position.copy(fpt4(f, side, c, 0.5, m0 - 0.45)); r.fireGlow.scale.set(1.6, 1.2, 1); r.fireGlow.visible = false; g.add(r.fireGlow);
      r.top = 0.92;
      break;
    }
    case 'ladder4': {
      if (f.tall) {
        // 倉儲區的高梯子（照 3008）：靠在貨架上的長鋁梯，底下有防滑腳
        const o = orient4(g, f, side), al = lm('#c8ccd0'), foot = lm('#2a2a2a'), H = 3.6, lean = 0.55;
        for (const x of [-0.22, 0.22]) { beam4(o, x, 0, lean * 0.5, x, H, -lean * 0.5, 0.06, al, 0.03); box(o, x - 0.04, x + 0.04, 0, 0.05, lean * 0.5 - 0.05, lean * 0.5 + 0.05, foot); }
        for (let i = 1; i <= 11; i++) { const k = i / 12; box(o, -0.22, 0.22, k * H - 0.015, k * H + 0.015, lean * 0.5 - k * lean - 0.03, lean * 0.5 - k * lean + 0.03, al); }
        r.top = 0.2;
        break;
      }
      // 鋁製 A 字梯
      const o = orient4(g, f, side), al = lm('#b8bcc0'), al2 = lm('#7a7e82'), H = 1.9;
      for (const x of [-0.22, 0.22]) { beam4(o, x * 1.05, 0, 0.32, x, H, 0.03, 0.05, al, 0.025); beam4(o, x * 1.05, 0, -0.32, x, H, -0.03, 0.045, al2, 0.025); }
      for (let i = 1; i <= 5; i++) { const k = i / 6, z = 0.32 * (1 - k) + 0.03 * k; box(o, -0.22, 0.22, k * H - 0.02, k * H + 0.01, z - 0.05, z + 0.05, al); }
      box(o, -0.24, 0.24, H, H + 0.05, -0.12, 0.12, lm('#c84a3a'));
      for (const x of [-0.18, 0.18]) beam4(o, x, 0.9, 0.17, x, 0.9, -0.17, 0.012, al2);
      r.top = H + 0.05;
      break;
    }
    case 'table4': {
      const w = wood4(pick(WOODS));
      box(g, 0.05, W - 0.05, 0.72, 0.77, 0.05, D - 0.05, w);
      legs(0.13, W - 0.13, 0.13, D - 0.13, 0.72, w, 0.032);
      box(g, 0.13, W - 0.13, 0.64, 0.72, 0.11, 0.14, w, false); box(g, 0.13, W - 0.13, 0.64, 0.72, D - 0.14, D - 0.11, w, false);
      if (W * D >= 2) {
        const pl = lm('#f4f2ec');
        for (let i = 0; i < Math.round(Math.max(W, D)); i++) { const x = W >= D ? i + 0.5 : W / 2, z = W >= D ? D / 2 : i + 0.5; cyl(g, 0.12, 0.1, 0.015, x, 0.77, z, pl, 16); }
        box(g, W >= D ? 0.2 : W / 2 - 0.15, W >= D ? W - 0.2 : W / 2 + 0.15, 0.771, 0.773, W >= D ? D / 2 - 0.15 : 0.2, W >= D ? D / 2 + 0.15 : D - 0.2, fab4('#d8c8a8'), false);
      }
      r.top = 0.78;
      break;
    }
    case 'sideboard4': {
      const col = pick(WOODS);
      caseBox(0.84, 0.46, col, 1);
      F(0.02, len - 0.02, 0.84, 0.87, dep - 0.48, dep - 0.02, wood4(shade(col, -8)));
      const lp = fpt4(f, side, len * 0.25, 0, dep - 0.25), vp = fpt4(f, side, len * 0.75, 0, dep - 0.25);
      cyl(g, 0.07, 0.05, 0.28, vp.x, 0.87, vp.z, lm('#3a5a6a'), 12);
      for (let i = 0; i < 3; i++) cyl(g, 0.13 - i * 0.01, 0.13 - i * 0.01, 0.015, lp.x, 0.87 + i * 0.016, lp.z, lm('#f4f2ec'), 16);
      r.top = 0.87;
      break;
    }
    case 'cabinet4': {
      caseBox(0.95, 0.5, pick(['#f2eee6', '#e8e2d6', '#8a6a48', '#cfd6d8', '#f4f2ec']), 1);
      r.top = 0.95;
      break;
    }
    case 'counter4': {
      // 廚房的下櫃、石頭檯面、牆上的吊櫃
      const col = pick(['#e8e4dc', '#4a5a5a', '#8a6a48', '#f2f0ea', '#3a3a3e']);
      caseBox(0.86, 0.6, col, 1);
      F(0, len, 0.86, 0.9, dep - 0.64, dep, ownPhong('#d8d4cc', { specular: 0x555555, shininess: 40 }));
      F(0.02, len - 0.02, 0.9, 1.45, dep - 0.02, dep, lm('#e8e6e0'));
      F(0.04, len - 0.04, 1.45, 2.15, dep - 0.36, dep - 0.02, wood4(col));
      for (let i = 0; i < Math.round(len); i++) { const a = i + 0.06, b = i + 0.94; F(a, b, 1.49, 2.11, dep - 0.38, dep - 0.36, wood4(shade(col, -10)), false); F(b - 0.08, b - 0.06, 1.52, 1.7, dep - 0.4, dep - 0.38, steel, false); }
      F(len * 0.3, len * 0.3 + 0.3, 0.9, 1.0, dep - 0.45, dep - 0.2, wood4('#c8a878'));
      r.top = 0.9;
      break;
    }
    case 'stove4': {
      F(0.03, len - 0.03, 0.06, 0.88, dep - 0.62, dep - 0.03, steel);
      F(0.03, len - 0.03, 0, 0.06, dep - 0.6, dep - 0.05, black);
      F(0.08, len - 0.08, 0.15, 0.62, dep - 0.64, dep - 0.62, ownPhong('#1a1a1c', { specular: 0x888888, shininess: 90 }), false);
      F(0.12, len - 0.12, 0.66, 0.68, dep - 0.67, dep - 0.64, steel, false);
      F(0.03, len - 0.03, 0.88, 0.91, dep - 0.62, dep - 0.03, ownPhong('#121214', { specular: 0x999999, shininess: 100 }));
      for (const [u, v] of [[0.28, 0.2], [0.72, 0.2], [0.28, 0.45], [0.72, 0.45]]) { const p = fpt4(f, side, u * len, 0, dep - 0.62 + v + 0.05); cyl(g, 0.09, 0.09, 0.008, p.x, 0.91, p.z, lm('#3a2220'), 18); }
      for (let i = 0; i < 4; i++) F(0.15 + i * 0.2, 0.2 + i * 0.2, 0.74, 0.8, dep - 0.66, dep - 0.62, black, false);
      F(0.04, len - 0.04, 1.75, 1.95, dep - 0.5, dep - 0.02, steel);
      F(len / 2 - 0.15, len / 2 + 0.15, 1.95, 2.6, dep - 0.2, dep - 0.02, steel);
      r.top = 0.91;
      break;
    }
    case 'sink4': {
      const cube = W4MAP.cubes.find(c => f.x >= c.x && f.x < c.x + c.w && f.y >= c.y && f.y < c.y + c.h), kitchen = cube && cube.kind === 'kitchen';
      const col = kitchen ? pick(['#e8e4dc', '#4a5a5a', '#8a6a48', '#f2f0ea', '#3a3a3e']) : '#f2f0ea';
      caseBox(0.84, 0.55, col, 1);
      F(0, len, 0.84, 0.88, dep - 0.58, dep, kitchen ? ownPhong('#d8d4cc', { specular: 0x555555, shininess: 40 }) : porcelain);
      F(0.15, len - 0.15, 0.82, 0.885, dep - 0.48, dep - 0.12, kitchen ? steel : porcelain, false);
      F(0.18, len - 0.18, 0.885, 0.887, dep - 0.45, dep - 0.15, lm(kitchen ? '#6a6e72' : '#c8d0d4'), false);
      F(len / 2 - 0.025, len / 2 + 0.025, 0.88, 1.15, dep - 0.08, dep - 0.04, steel); F(len / 2 - 0.025, len / 2 + 0.025, 1.12, 1.15, dep - 0.25, dep - 0.04, steel);
      if (!kitchen) { F(0.1, len - 0.1, 1.2, 1.85, dep - 0.03, dep - 0.01, lm('#d8d4cc')); F(0.13, len - 0.13, 1.23, 1.82, dep - 0.035, dep - 0.03, ownPhong('#aab8c0', { specular: 0xffffff, shininess: 120 }), false); }
      else F(0.02, len - 0.02, 0.88, 1.45, dep - 0.02, dep, lm('#e8e6e0'));
      r.top = 0.88;
      break;
    }
    case 'fridge4': {
      const body = ownPhong(pick(['#d8dcdf', '#c8ccd0', '#e8eaec', '#3a3c40', '#d0d4d8']), { specular: 0x777777, shininess: 50 });
      F(0.05, len - 0.05, 0.03, 1.88, dep - 0.7, dep - 0.04, body);
      F(0.07, len - 0.07, 1.25, 1.27, dep - 0.705, dep - 0.7, dkSteel, false);
      F(len - 0.16, len - 0.13, 0.55, 1.15, dep - 0.75, dep - 0.705, steel); F(len - 0.16, len - 0.13, 1.35, 1.7, dep - 0.75, dep - 0.705, steel);
      F(0.07, len - 0.07, 0, 0.03, dep - 0.68, dep - 0.06, black);
      r.top = 1.88;
      break;
    }
    case 'bathtub4': {
      F(0.03, len - 0.03, 0, 0.56, dep - 0.78, dep - 0.03, porcelain);
      F(0.13, len - 0.13, 0.2, 0.565, dep - 0.68, dep - 0.13, lm('#d8dcdc'), false);
      F(len - 0.24, len - 0.2, 0.56, 0.75, dep - 0.42, dep - 0.38, steel); F(len - 0.24, len - 0.2, 0.72, 0.75, dep - 0.5, dep - 0.38, steel);
      F(0.03, len - 0.03, 0.56, 1.6, dep - 0.03, dep, lm('#e8eef0'));
      r.top = 0.56;
      break;
    }
    case 'toilet4': {
      const o = orient4(g, f, side);
      cyl(o, 0.17, 0.13, 0.38, 0, 0, 0.02, porcelain, 18);
      const bowl = sph(o, 0.2, 0, 0.38, 0.06, porcelain, 0.95, 0.25, 1.15, 16);
      void bowl;
      box(o, -0.19, 0.19, 0.42, 0.45, -0.18, 0.3, lm('#f6f6f4'));
      box(o, -0.2, 0.2, 0.42, 0.8, -0.38, -0.2, porcelain);
      box(o, -0.21, 0.21, 0.8, 0.83, -0.39, -0.19, porcelain);
      box(o, 0.1, 0.16, 0.72, 0.75, -0.2, -0.18, steel, false);
      r.top = 0.83;
      break;
    }
    case 'rack4': {
      // 自助倉儲區 5.2 公尺高的鐵貨架（照 3008）：藍色的立柱、橘色的橫樑、木頭棧板。最下層疊著一捆一捆的木板，
      // 第二層前面空著放真的東西（world4.js 的 shelfSlots4，一個一個拿），後面和上面堆滿紙箱
      const blue = lm('#2a4a8a'), orange = lm('#d8742a'), ply = wood4('#c8a878'), cb = cardboard4(), board = wood4('#d8b888'), board2 = wood4('#c09a68');
      const bays = Math.max(1, Math.round(len / 2.7)), H = RACK4_H;
      for (let i = 0; i <= bays; i++) {
        const u = Math.min(len - 0.05, Math.max(0.05, i * len / bays));
        for (const v of [0.12, dep - 0.12]) F(u - 0.045, u + 0.045, 0, H, v - 0.045, v + 0.045, blue);
        // 前後兩根立柱中間的斜撐（Z 字形）
        for (let k = 0; k < 5; k++) {
          const y0 = 0.25 + k * 0.98, a = fpt4(f, side, u, y0, k % 2 ? dep - 0.12 : 0.12), b = fpt4(f, side, u, y0 + 0.98, k % 2 ? 0.12 : dep - 0.12);
          beam4(g, a.x, a.y, a.z, b.x, b.y, b.z, 0.025, blue);
          F(u - 0.012, u + 0.012, y0, y0 + 0.025, 0.12, dep - 0.12, blue, false);
        }
      }
      RACK4_LEVELS.forEach((y, lv) => {
        for (const v of [0.12, dep - 0.12]) F(0.05, len - 0.05, y, y + 0.1, v - 0.04, v + 0.04, orange);
        F(0.08, len - 0.08, y + 0.1, y + 0.13, 0.14, dep - 0.14, ply);
        for (let b = 0; b < bays; b++) {
          const ub = b * len / bays + 0.12, ue = (b + 1) * len / bays - 0.12;
          if (lv === 0) {
            // 最下層：一疊一疊的木板（夾板、松木板），偶爾一個空格
            if (R() < 0.15) continue;
            const n = 4 + ((R() * 8) | 0), m = R() < 0.5 ? board : board2;
            for (let k = 0; k < n; k++) F(ub + 0.03, ue - 0.03 - (k % 2) * 0.04, y + 0.13 + k * 0.045, y + 0.17 + k * 0.045, 0.2 + (k % 3) * 0.02, dep - 0.2, m, k === n - 1);
            continue;
          }
          // 第二層前面 1 公尺留給真的東西；其他地方疊幾個紙箱（設計師：紙箱少一點），最上層是空的（爬上來站的地方）
          if (lv === RACK4_LEVELS.length - 1) continue;
          const v0 = lv === 1 ? 1.0 : 0.18;
          let u = ub;
          while (u < ue - 0.3) {
            const bw = Math.min(ue - u, 0.45 + R() * 0.6), bh = 0.3 + R() * 0.6, bd = Math.min(dep - 0.2 - v0, 0.45 + R() * (dep - 0.75));
            if (R() < 0.4) F(u, u + bw - 0.03, y + 0.13, y + 0.13 + bh, v0, v0 + bd, cb);
            u += bw;
          }
        }
      });
      // 貨架頂上鋪一層木板（爬上來站的地方，高 RACK4_H）
      F(0.05, len - 0.05, H - 0.04, H, 0.08, dep - 0.08, ply);
      // 正面中間一把靠在貨架上的長鋁梯（可以爬：world4.js 的 ladders4），從地上一直到貨架頂
      const al = lm('#c8ccd0'), foot = lm('#2a2a2a');
      for (const du of [-0.24, 0.24]) {
        const a = fpt4(f, side, len / 2 + du, 0, -0.6), b = fpt4(f, side, len / 2 + du, H + 0.4, 0.02);
        beam4(g, a.x, a.y, a.z, b.x, b.y, b.z, 0.06, al, 0.035);
        F(len / 2 + du - 0.05, len / 2 + du + 0.05, 0, 0.05, -0.66, -0.54, foot);
      }
      for (let i = 1; i < 16; i++) { const k = i / 16; F(len / 2 - 0.24, len / 2 + 0.24, k * (H + 0.4) - 0.015, k * (H + 0.4) + 0.015, -0.6 + k * 0.62 - 0.03, -0.6 + k * 0.62 + 0.03, al, false); }
      r.top = H;
      break;
    }
    case 'goods4': {
      // 雙面的貨架：灰白色的鐵架、洞洞板、黃色的價格條。中間三層放真的東西（world4.js 的 shelfSlots4），最上層堆著一箱一箱的存貨
      const frame = lm('#d8dadc'), peg = lm('#c8cacc'), H = GOODS4_H, mid = dep / 2;
      F(0.02, len - 0.02, 0, 0.12, 0.05, dep - 0.05, lm('#5a5e64'));
      F(0.02, len - 0.02, 0.12, H, mid - 0.02, mid + 0.02, peg);
      for (const u of [0.03, len - 0.03]) F(u - 0.025, u + 0.025, 0, H + 0.05, 0.08, dep - 0.08, frame);
      for (const y of GOODS4_LEVELS) for (const [a, b] of [[0.08, mid - 0.03], [mid + 0.03, dep - 0.08]]) {
        F(0.05, len - 0.05, y, y + 0.025, a, b, frame);
        F(0.05, len - 0.05, y - 0.04, y + 0.025, a < mid ? a : b - 0.015, a < mid ? a + 0.015 : b, lm('#f2c84a'), false);
        if (y < GOODS4_LEVELS[GOODS4_LEVELS.length - 1]) continue;
        let u = 0.08;
        while (u < len - 0.3) { const bw = 0.3 + R() * 0.25; if (R() < 0.8) F(u, u + bw - 0.02, y + 0.025, y + 0.025 + 0.22 + R() * 0.12, a + 0.02, b - 0.02, cardboard4(), false); u += bw; }
      }
      F(0.02, len - 0.02, H, H + 0.05, 0.08, dep - 0.08, frame);
      r.top = H + 0.05;
      break;
    }
    case 'lampshelf': {
      // 燈具區的展示架：一層一層的木板，上面是真的檯燈（world4.js 的 shelfSlots4，可以一盞一盞拿）
      const frame = lm('#3a3c40'), H = 1.8, d0 = dep - 0.5;
      for (const u of [0.04, len - 0.04]) F(u - 0.02, u + 0.02, 0, H, d0, dep - 0.04, frame);
      F(0.04, len - 0.04, 0.1, H, dep - 0.05, dep - 0.03, lm('#e8e6e0'));
      for (const y of LAMPSHELF4_LEVELS) F(0.04, len - 0.04, y, y + 0.03, d0, dep - 0.04, wood4('#e8e2d6'));
      F(0.3, len - 0.3, 1.95, 2.3, dep - 0.08, dep - 0.04, ownBasic({ map: sign4Tex('檯燈・落地燈', '#f2d24a') }), false).userData.keep = true;
      r.top = H;
      break;
    }
    case 'bedding4': {
      // 寢具架：塑膠袋包著的被子、枕頭，一疊一疊
      const frame = lm('#d8dadc'), H = 1.75, d0 = dep - 0.6;
      for (const u of [0.04, len - 0.04]) F(u - 0.025, u + 0.025, 0, H, d0, dep - 0.04, frame);
      for (const y of [0.1, 0.65, 1.2]) {
        F(0.04, len - 0.04, y, y + 0.03, d0, dep - 0.04, frame);
        let u = 0.08;
        while (u < len - 0.4) {
          const m = fab4(['#e8e4dc', '#9aa8b8', '#c8b8a0', '#e0d8e8', '#a8b8a0', '#d8a8a0'][(R() * 6) | 0]);
          const n = 2 + ((R() * 3) | 0);
          for (let k = 0; k < n; k++) F(u, u + 0.45, y + 0.03 + k * 0.11, y + 0.13 + k * 0.11, d0 + 0.04, dep - 0.08, m, false);
          u += 0.5;
        }
      }
      r.top = H;
      break;
    }
    case 'crate4': {
      const cb = cardboard4(), pal = wood4('#c8a878');
      box(g, 0.08, 0.92, 0, 0.12, 0.08, 0.92, pal);
      box(g, 0.1, 0.62, 0.12, 0.6, 0.12, 0.6, cb); box(g, 0.48, 0.9, 0.12, 0.5, 0.4, 0.9, cb); box(g, 0.14, 0.52, 0.6, 0.92, 0.18, 0.55, cb);
      r.top = 0.92;
      break;
    }
    case 'plankpile': {
      // 板材堆（設計師：木板就是木板）：一片一片 1 公尺寬、2.6 公尺高的板子斜靠在貨架上（剩幾片就靠幾片），
      // 腳邊一張顏色是稀有度的價格牌
      if (!plankMats) makePlankMats();
      const o = orient4(g, f, f.lean || 's'), mat = plankMats[f.tier], edge = lm(PLANK_EDGE[f.tier]);
      r.stack = new THREE.Group(); r.stack.userData.keep = true; o.add(r.stack);
      const tilt = 0.28;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Group(); p.userData.i = i; r.stack.add(p);
        // 板子底部離貨架 0.75 公尺、頂端靠在貨架上；一片一片往外疊
        p.position.set((i % 3 - 1) * 0.015, 0, -0.5 + 0.35 - i * 0.045); p.rotation.x = -tilt;
        box(p, -0.48, 0.48, 0, 0.96, -0.02, 0.02, mat, i === 0);   // 1×1 公尺的正方形板子
        box(p, -0.49, 0.49, 0, 0.04, -0.025, 0.025, edge, false);
      }
      const tag = box(o, -0.15, 0.15, 0.02, 0.24, 0.3, 0.32, ownBasic({ color: new THREE.Color(RARITY[PLANKS[f.tier].rar].color) }), false);
      tag.userData.keep = true;
      if (f.special) { r.spGlow = ownSprite(glowTex, new THREE.Color(RARITY[PLANKS[f.tier].rar].color).getHex()); r.spGlow.position.set(0.5, 1.2, 0.5); r.spGlow.scale.setScalar(1.6); g.add(r.spGlow); }
      r.top = 0.3;
      break;
    }
    case 'foodcounter': {
      // 熱食櫃台：不鏽鋼的台子、玻璃擋板、一格一格的熱食（熱狗、肉丸、薯條、披薩）
      const glass = ownPhong('#dbe9f0', { transparent: true, opacity: 0.3, specular: 0xffffff, shininess: 90, depthWrite: false });
      F(0.02, len - 0.02, 0, 0.9, 0.1, dep - 0.05, steel);
      F(0.04, len - 0.04, 0.05, 0.85, 0.08, 0.1, lm('#b8bcc0'), false);
      F(0, len, 0.9, 0.94, 0.05, dep, ownPhong('#c8ccd0', { specular: 0xaaaaaa, shininess: 80 }));
      F(0.04, len - 0.04, 1.25, 1.28, 0.08, dep * 0.6, glass, false); F(0.04, len - 0.04, 0.94, 1.25, 0.08, 0.1, glass, false);
      // 熱食放在玻璃罩底下的不鏽鋼盤子上（真的東西，world4.js 的 shelfSlots4）
      for (let i = 0; i < Math.round(len * 2); i++) { const a = 0.1 + i * (len - 0.2) / Math.round(len * 2); F(a, a + (len - 0.2) / Math.round(len * 2) - 0.03, 0.9, 0.96, 0.2, dep * 0.6, steel, false); }
      F(0.3, len - 0.3, 1.9, 2.4, dep - 0.08, dep - 0.04, ownBasic({ map: sign4Tex('熱食・熱狗・肉丸', '#e8743a') }), false).userData.keep = true;
      r.top = 0.94;
      break;
    }
    case 'drink4': {
      F(0.1, len - 0.1, 0, 1.6, dep - 0.62, dep - 0.04, steel);
      F(0.12, len - 0.12, 0.95, 1.55, dep - 0.64, dep - 0.62, ownBasic({ map: sign4Tex('汽水', '#3a8fd8'), color: 0xcccccc }), false).userData.keep = true;
      for (let i = 0; i < 3; i++) F(0.2 + i * 0.22, 0.28 + i * 0.22, 0.7, 0.85, dep - 0.7, dep - 0.62, black, false);
      F(0.12, len - 0.12, 0.4, 0.45, dep - 0.85, dep - 0.62, dkSteel, false);
      const cp = fpt4(f, side, len * 0.25, 0, dep - 0.75);
      for (let i = 0; i < 3; i++) cyl(g, 0.045, 0.035, 0.12, cp.x, 0.45 + i * 0.02, cp.z, lm('#f2efe8'), 10, true);
      r.top = 1.6;
      break;
    }
    case 'coldcase': {
      // 冷藏櫃：玻璃門、裡面白色的燈、一排一排的飲料瓶
      const body = lm('#e8eaec'), glass = ownPhong('#e0f0f8', { transparent: true, opacity: 0.22, specular: 0xffffff, shininess: 100, depthWrite: false });
      F(0.03, len - 0.03, 0, 2.0, dep - 0.7, dep - 0.03, body);
      F(0.08, len - 0.08, 0.15, 1.85, dep - 0.705, dep - 0.69, ownBasic({ color: 0xdfeaf2 }), false).userData.keep = true;
      const BOT = ['#d84a3a', '#3a7ad8', '#4aa36a', '#e8c23a', '#f2efe8', '#2a2a2a'];
      for (const y of [0.2, 0.62, 1.04, 1.46]) {
        F(0.08, len - 0.08, y, y + 0.02, dep - 0.69, dep - 0.08, lm('#c8ccd0'), false);
        for (let u = 0.14; u < len - 0.1; u += 0.11) F(u, u + 0.07, y + 0.02, y + 0.3, dep - 0.2, dep - 0.12, lm(BOT[(R() * BOT.length) | 0]), false);   // 後面一排存貨；前面放真的東西
      }
      F(0.05, len - 0.05, 0.12, 1.88, dep - 0.73, dep - 0.71, glass, false);
      for (let i = 1; i < Math.round(len); i++) F(i - 0.02, i + 0.02, 0.12, 1.88, dep - 0.735, dep - 0.7, lm('#8a8d92'), false);
      r.top = 2.0;
      break;
    }
    case 'locker4': {
      const col = '#5a6e66', body = lm(col), door = lm(shade(col, 8)), vent = lm('#2a302e');
      F(0.03, len - 0.03, 0, 1.9, dep - 0.5, dep - 0.03, body);
      const n = Math.round(len * 2);
      for (let i = 0; i < n; i++) {
        const a = i * len / n + 0.03, b = (i + 1) * len / n - 0.03;
        F(a, b, 0.08, 1.85, dep - 0.52, dep - 0.5, door, false);
        for (let k = 0; k < 4; k++) F(a + 0.06, b - 0.06, 1.55 + k * 0.05, 1.57 + k * 0.05, dep - 0.525, dep - 0.52, vent, false);
        F(b - 0.07, b - 0.04, 0.9, 1.05, dep - 0.54, dep - 0.52, steel, false);
      }
      r.top = 1.9;
      break;
    }
    case 'vending4': {
      // 販賣機：紅色的機身、玻璃後面一排一排的零食、裡面亮著燈（停電時暗掉）
      const body = ownPhong('#a8262a', { specular: 0x444444, shininess: 40 });
      F(0.06, len - 0.06, 0, 1.85, dep - 0.8, dep - 0.04, body);
      r.vlight = F(0.1, len * 0.7, 0.55, 1.75, dep - 0.805, dep - 0.79, ownBasic({ color: 0xe8f0f4 }), false); r.vlight.userData.keep = true;
      for (const y of [0.6, 0.9, 1.2, 1.5]) for (let u = 0.14; u < len * 0.7 - 0.08; u += 0.1) F(u, u + 0.07, y, y + 0.16, dep - 0.82, dep - 0.808, lm(PRODUCT4[(R() * PRODUCT4.length) | 0]), false);
      F(len * 0.72, len - 0.1, 1.0, 1.4, dep - 0.82, dep - 0.8, black, false);
      F(0.12, len * 0.7, 0.15, 0.4, dep - 0.82, dep - 0.8, black, false);
      r.top = 1.85;
      break;
    }
    case 'bagrack': {
      const frame = lm('#3a3c40'), bag = fab4('#2a5aa8'), bag2 = fab4('#e8c23a');
      F(0.05, len - 0.05, 0, 0.05, 0.2, dep - 0.2, frame);
      for (const u of [0.1, len - 0.1]) F(u - 0.02, u + 0.02, 0, 1.3, dep / 2 - 0.02, dep / 2 + 0.02, frame);
      F(0.08, len - 0.08, 1.28, 1.31, dep / 2 - 0.02, dep / 2 + 0.02, frame);
      for (let u = 0.2; u < len - 0.15; u += 0.11) F(u, u + 0.08, 0.6, 1.28, dep / 2 - 0.25, dep / 2 + 0.25, R() < 0.8 ? bag : bag2, false);
      r.top = 1.31;
      break;
    }
    case 'infodesk': {
      const top = ownPhong('#e8e6e0', { specular: 0x555555, shininess: 40 });
      F(0.03, len - 0.03, 0, 1.05, 0.05, dep - 0.35, wood4('#d8c8a8'));
      F(0, len, 1.05, 1.1, 0, dep - 0.3, top);
      F(0.03, len - 0.03, 0.7, 0.74, dep - 0.35, dep - 0.03, top);
      F(len * 0.6, len * 0.6 + 0.45, 1.1, 1.13, dep - 0.55, dep - 0.4, black);
      F(len * 0.6 + 0.2, len * 0.6 + 0.25, 1.13, 1.25, dep - 0.5, dep - 0.45, black);
      F(len * 0.6, len * 0.6 + 0.45, 1.25, 1.55, dep - 0.5, dep - 0.47, black);
      F(0.3, len - 0.3, 0.55, 0.85, 0.035, 0.05, ownBasic({ map: sign4Tex('服務台', '#3a8fd8') }), false).userData.keep = true;
      r.top = 1.1;
      break;
    }
    case 'cart4': {
      // 購物車：鐵絲籃、塑膠把手、四個輪子
      const o = orient4(g, f, side), wire = lm('#b8bcc0'), wire2 = lm('#8a8e92'), red = lm('#c8262a');
      o.rotation.y += (hash4(f.id) % 40 - 20) / 100;
      for (const [x, z] of [[-0.22, 0.32], [0.22, 0.32], [-0.2, -0.32], [0.2, -0.32]]) { cyl(o, 0.045, 0.045, 0.04, x, 0.02, z, black, 10).rotation.z = Math.PI / 2; beam4(o, x, 0.06, z, x, 0.35, z * 0.95, 0.025, wire2); }
      box(o, -0.22, 0.22, 0.34, 0.37, -0.34, 0.32, wire2);
      for (let i = 0; i < 6; i++) { const y = 0.42 + i * 0.09; box(o, -0.26, 0.26, y, y + 0.01, -0.36, -0.35, wire, false); box(o, -0.24, 0.24, y, y + 0.01, 0.37, 0.38, wire, false); for (const x of [-0.25, 0.25]) box(o, x - 0.005, x + 0.005, y, y + 0.01, -0.36, 0.38, wire, false); }
      for (let k = -4; k <= 4; k++) { box(o, k * 0.06 - 0.004, k * 0.06 + 0.004, 0.42, 0.88, -0.355, -0.345, wire, false); box(o, -0.25, 0.25, 0.42, 0.425, k * 0.08 - 0.004, k * 0.08 + 0.004, wire, false); }
      for (const x of [-0.26, 0.26]) beam4(o, x, 0.88, -0.36, x, 1.0, -0.48, 0.02, wire2);
      box(o, -0.28, 0.28, 0.98, 1.03, -0.5, -0.46, red);
      r.top = 0.9;
      break;
    }
    default:
      return false;
  }
  return true;
}
// 電視展示的畫面：天空和山、海邊的夕陽、賣場的廣告（寫實一點的漸層和光暈）
const tvShows = [];
function tvShowTex(k) {
  k %= 3;
  if (tvShows[k]) return tvShows[k];
  return (tvShows[k] = canvasTex(256, 144, (c, w, h) => {
    if (k === 0) {
      const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#5aa0e8'); g.addColorStop(0.6, '#cfe6f8'); g.addColorStop(1, '#4a7a3a'); c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.fillStyle = '#6a7a8a'; c.beginPath(); c.moveTo(0, 100); c.lineTo(60, 50); c.lineTo(110, 90); c.lineTo(170, 40); c.lineTo(256, 95); c.lineTo(256, 144); c.lineTo(0, 144); c.fill();
      c.fillStyle = '#f4f8fc'; c.beginPath(); c.moveTo(60, 50); c.lineTo(72, 60); c.lineTo(50, 60); c.fill(); c.beginPath(); c.moveTo(170, 40); c.lineTo(185, 52); c.lineTo(156, 52); c.fill();
      c.fillStyle = '#3a6a2a'; c.fillRect(0, 118, w, 26);
    } else if (k === 1) {
      const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#2a1a4a'); g.addColorStop(0.5, '#e8743a'); g.addColorStop(0.62, '#f2c84a'); g.addColorStop(0.63, '#2a4a6a'); g.addColorStop(1, '#0a1a2a'); c.fillStyle = g; c.fillRect(0, 0, w, h);
      const s = c.createRadialGradient(128, 88, 2, 128, 88, 40); s.addColorStop(0, '#fff6c8'); s.addColorStop(1, 'rgba(255,200,80,0)'); c.fillStyle = s; c.fillRect(0, 40, w, 60);
      c.fillStyle = 'rgba(255,220,140,.5)'; for (let i = 0; i < 12; i++) c.fillRect(110 + Math.sin(i) * 20, 92 + i * 4, 36 - i * 2, 1.5);
    } else {
      c.fillStyle = '#f2c84a'; c.fillRect(0, 0, w, h); c.fillStyle = '#2a5aa8'; c.fillRect(0, 0, w, 40);
      c.fillStyle = '#fff'; c.font = 'bold 30px sans-serif'; c.textAlign = 'center'; c.fillText('3008', w / 2, 30);
      c.fillStyle = '#2a2a2a'; c.font = 'bold 26px sans-serif'; c.fillText('今日特價', w / 2, 78); c.fillStyle = '#c8262a'; c.font = 'bold 34px sans-serif'; c.fillText('99 元', w / 2, 120);
    }
    c.fillStyle = 'rgba(0,0,0,.08)'; for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
  }));
}
// 每一幀：電視開著有畫面、火爐有燃料時窗裡有火光、板材堆照剩幾片疊高、販賣機停電時暗掉
function updateStoreFurniture4(t) {
  // 賣場很大（100×76）：霧後面看不到的家具就不畫，平板才跑得動（霧的遠端再多 4 公尺，大的貨架再多一點）
  const cx = camera.position.x, cz = camera.position.z, far = scene.fog.far + 4;
  for (const f of FURN) {
    const r = furn3d[f.id];
    if (!r) continue;
    const dx = Math.max(f.x - cx, 0, cx - f.x - f.w), dz = Math.max(f.y - cz, 0, cz - f.y - f.h);
    r.g.visible = dx * dx + dz * dz < far * far;
    if (!r.g.visible) continue;
    if (r.screen && f.type === 'tv4') {
      // 開著的電視播節目（電器區的展示機白天開著）；停電或關掉就黑掉
      const on = !!(f.on && G.power), m = r.screen.material, show = tvShowTex(hash4(f.id));
      if (on) { if (m.map !== show) m.map = show; const k = 0.85 + 0.1 * Math.sin(t * 2.3 + f.x); m.color.setRGB(k, k, k); } else { if (m.map !== staticTex) m.map = staticTex; m.color.set(0x0a0d14); }
    } else if (r.window) {
      const lit = fireLeft4(f) > 0, k = lit ? 0.7 + 0.3 * Math.sin(t * 13 + f.x) * Math.sin(t * 7.3) : 0;
      r.window.material.color.setRGB(0.07 + k * 1.0, 0.03 + k * 0.42, 0.02 + k * 0.08);
      r.fireGlow.visible = lit;
      if (lit) r.fireGlow.material.opacity = 0.55 + 0.25 * k;
    } else if (r.stack) {
      const n = Math.max(0, Math.min(8, f.count || 0));
      for (const m of r.stack.children) m.visible = m.userData.i < n;
      if (r.spGlow) r.spGlow.material.opacity = 0.5 + 0.3 * Math.sin(t * 3);
    } else if (r.vlight) r.vlight.material.color.setHex(G.power ? 0xe8f0f4 : 0x1a1c1e);

  }
}
// 蓋賣場：地板、天花板和日光燈板、外牆、柱子、樣品間的彩色隔間牆、小房間、入口的玻璃門、招牌、地上的箭頭
function buildStore4() {
  if (!store4Tex) makeStoreTextures();
  if (!plankMats) makePlankMats();
  const T = store4Tex;
  const fm = (tex, rep = 1) => { const m = patchLM(new THREE.MeshLambertMaterial({ map: tex })); m.userData.own = true; void rep; return m; };
  const plane = (x, y, w, h, mat, hgt, su = w, sv = h, down = false) => {
    const g = new THREE.PlaneGeometry(w, h); scaleUV(g, su, sv);
    const m = new THREE.Mesh(g, mat); m.userData.ownGeo = true; m.rotation.x = down ? Math.PI / 2 : -Math.PI / 2; m.position.set(x + w / 2, hgt, y + h / 2); m.receiveShadow = !down;
    houseGroup.add(m); return m;
  };
  // 地板：賣場的水泥地、洗手間的磁磚、員工專用區的水泥；樣品間和主走道再鋪一層
  const floorM = { store4: fm(T.store), aisle4: fm(T.aisle), oak4: fm(T.oak), carpet4: fm(T.carpet), concrete: fm(T.store) };
  for (const r of ROOMS) plane(r.x, r.y, r.w, r.h, floorM[r.floor] || floorMat(r.floor), 0);
  for (const d of DOORS) if (!d.front) plane(d.x, d.y, 1, 1, floorM.store4, 0);
  for (const f of W4MAP.floors) plane(f.x, f.y, f.w, f.h, floorM[f.floor] || floorMat(f.floor), f.floor === 'aisle4' ? 0.003 : 0.005);
  // 主走道上指方向的箭頭（照 3008）
  const am = patchLM(new THREE.MeshLambertMaterial({ map: T.arrow, transparent: true, depthWrite: false, opacity: 0.8 })); am.userData.own = true;
  const arrows = [];
  for (let y = 4; y < MAP_H - 2; y += 5) if (y < W4AY - 1 || y > W4AY + 2) arrows.push([W4AX + 0.5, y + 0.5, y < W4AY ? 0 : Math.PI], [W4AX + 1.5, y + 0.5, y < W4AY ? Math.PI : 0]);
  for (let x = 4; x < MAP_W - 2; x += 5) if (x < W4AX - 1 || x > W4AX + 2) arrows.push([x + 0.5, W4AY + 0.5, x < W4AX ? -Math.PI / 2 : Math.PI / 2], [x + 0.5, W4AY + 1.5, x < W4AX ? Math.PI / 2 : -Math.PI / 2]);
  const ai = new THREE.InstancedMesh(geo('arrow4', () => new THREE.PlaneGeometry(0.7, 0.7)), am, arrows.length);
  arrows.forEach(([x, z, a], i) => { _q.setFromEuler(_e.set(-Math.PI / 2, 0, a, 'XYZ')); _m4.compose(_v.set(x, 0.007, z), _q, _one); ai.setMatrixAt(i, _m4); });
  ai.computeBoundingSphere(); houseGroup.add(ai);
  // 天花板：賣場 6.2 公尺高的吸音板；有天花板的小房間（洗手間、員工專用區）2.7 公尺
  const cm = patchLM(new THREE.MeshLambertMaterial({ map: T.ceil })); cm.userData.own = true;
  plane(0, 0, MAP_W, MAP_H, cm, CEIL_W4, MAP_W * 1.7, MAP_H * 1.7, true);
  for (const r of ROOMS) if (r.ceil) plane(r.x, r.y, r.w, r.h, cm, WALL_H, r.w * 1.7, r.h * 1.7, true);
  // 日光燈板：每 3 格一片（白天亮、晚上熄；天快黑時一排一排閃掉），用一個 InstancedMesh、每片自己的亮度
  panel4Info = [];
  for (let y = 2; y < MAP_H - 1; y += 3) for (let x = 2; x < MAP_W - 1; x += 3) { const r = roomGrid[y][x]; if (r && r.id === 'store') panel4Info.push({ x: x + 0.5, y: y + 0.5, row: Math.floor(y / 3), ph: Math.random() * 6 }); }
  panel4 = new THREE.InstancedMesh(geo('panel4', () => new THREE.PlaneGeometry(1.2, 0.6)), ownBasic({ map: T.panel, color: 0xffffff }), panel4Info.length);
  panel4Info.forEach((p, i) => { _q.setFromEuler(_e.set(Math.PI / 2, 0, 0, 'XYZ')); _m4.compose(_v.set(p.x, CEIL_W4 - 0.01, p.y), _q, _one); panel4.setMatrixAt(i, _m4); panel4.setColorAt(i, new THREE.Color(1, 1, 1)); });
  panel4.computeBoundingSphere(); houseGroup.add(panel4);
  // 牆：外牆和小房間的牆一直到天花板；柱子是方形的水泥柱；樣品間的隔間牆 2.75 公尺高，漆成那一間的顏色
  const inner = new Set(W4MAP.walls.map(([x, y]) => x + ',' + y));
  const isWallT = (x, y) => !inMap(x, y) || tiles[y][x] === 0;
  const tall = [], parts = [], pillars = [];
  const front = new Set(), fd = DOORS.find(d => d.front);
  for (let x = fd.x - 2; x <= fd.x + 3; x++) front.add(x + ',' + fd.y);
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (tiles[y][x] !== 0 || front.has(x + ',' + y)) continue;
    let near = false, ceilNear = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!inMap(x + dx, y + dy) || tiles[y + dy][x + dx] === 0) continue;
      near = true;
      const r = roomGrid[y + dy][x + dx] || (doorGrid[y + dy][x + dx] && doorGrid[y + dy][x + dx].rooms[0]);
      if (r && r.ceil) ceilNear = true;
    }
    if (!near) continue;
    if (!inner.has(x + ',' + y) || ceilNear || x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1) tall.push([x, y]);
    else if (!isWallT(x + 1, y) && !isWallT(x - 1, y) && !isWallT(x, y + 1) && !isWallT(x, y - 1)) pillars.push([x, y]);
    else {
      const cube = W4MAP.cubes.find(c => x >= c.x - 1 && x <= c.x + c.w && y >= c.y - 1 && y <= c.y + c.h);
      parts.push([x, y, cube ? cube.wall : '#e8e6e0']);
    }
  }
  const inst = (list, gm, mat, place) => {
    const im = new THREE.InstancedMesh(gm, mat, list.length);
    const col = new THREE.Color();
    list.forEach((it, i) => { place(it); im.setMatrixAt(i, _m4); if (it[2]) im.setColorAt(i, col.set(it[2])); });
    im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); houseGroup.add(im); return im;
  };
  const wm = patchLM(new THREE.MeshLambertMaterial({ map: T.wall })); wm.userData.own = true;
  inst(tall, geo('wall4t', () => { const g = new THREE.BoxGeometry(1, CEIL_W4, 1); scaleUV(g, 1, CEIL_W4 / 2); return g; }), wm, ([x, y]) => _m4.makeTranslation(x + 0.5, CEIL_W4 / 2, y + 0.5));
  const pm = patchLM(new THREE.MeshLambertMaterial({ map: T.pillar })); pm.userData.own = true;
  inst(pillars, geo('pillar4', () => new THREE.BoxGeometry(0.8, CEIL_W4, 0.8)), pm, ([x, y]) => _m4.makeTranslation(x + 0.5, CEIL_W4 / 2, y + 0.5));
  const PH = 3.0;
  const ptm = patchLM(new THREE.MeshLambertMaterial({ map: T.part, color: 0xffffff })); ptm.userData.own = true;
  inst(parts, geo('part4', () => new THREE.BoxGeometry(1, PH, 1)), ptm, ([x, y]) => _m4.makeTranslation(x + 0.5, PH / 2, y + 0.5));
  inst(parts.map(([x, y]) => [x, y]), geo('partcap4', () => new THREE.BoxGeometry(1.02, 0.05, 1.02)), lm('#d8d5cc'), ([x, y]) => _m4.makeTranslation(x + 0.5, PH + 0.025, y + 0.5));
  // 小房間的門框
  const trim = lm('#8a8d92');
  for (const d of DOORS) {
    if (d.front) continue;
    const g = new THREE.Group(); g.position.set(d.x, 0, d.y); houseGroup.add(g);
    const ew = !!(tiles[d.y - 1] && tiles[d.y - 1][d.x] === 0);
    box(g, 0, 1, 2.15, CEIL_W4, 0, 1, wm);
    if (ew) { box(g, 0, 1, 0, 2.15, 0, 0.06, trim); box(g, 0, 1, 0, 2.15, 0.94, 1, trim); } else { box(g, 0, 0.06, 0, 2.15, 0, 1, trim); box(g, 0.94, 1, 0, 2.15, 0, 1, trim); }
    const sg = new THREE.Mesh(geo('doorsign4', () => new THREE.PlaneGeometry(0.9, 0.22)), ownBasic({ map: sign4Tex(d.staff ? '員工專用' : '洗手間', d.staff ? '#d84a3a' : '#4aa3d8') }));
    if (ew) { sg.position.set(d.x < W4AX ? 1.02 : -0.02, 2.4, 0.5); sg.rotation.y = d.x < W4AX ? Math.PI / 2 : -Math.PI / 2; } else { sg.position.set(0.5, 2.4, 1.02); }
    g.add(sg);
  }
  // 入口：打不開的玻璃自動門，門外只有一片白霧；上面是「3008」的招牌和綠色的出口燈箱
  {
    const g = new THREE.Group(); g.position.set(fd.x - 2, 0, fd.y); houseGroup.add(g);
    const al = lm('#b9bdc2'), glass = ownPhong('#dbe9f0', { transparent: true, opacity: 0.35, specular: 0xffffff, shininess: 90, depthWrite: false });
    box(g, 0, 6, CEIL_W4 - 1.3, CEIL_W4, 0, 1, wm);
    for (let i = 0; i <= 6; i++) box(g, i - 0.04, i + 0.04, 0, CEIL_W4 - 1.3, 0.4, 0.6, al);
    box(g, 0, 6, CEIL_W4 - 1.38, CEIL_W4 - 1.3, 0.4, 0.6, al);
    for (let i = 0; i < 6; i++) box(g, i + 0.04, i + 0.96, 0, CEIL_W4 - 1.38, 0.47, 0.53, glass, false);
    const fog = new THREE.Mesh(geo('fog4', () => new THREE.PlaneGeometry(8, 4)), ownBasic({ color: 0xf4f6f8, fog: false }));
    fog.position.set(3, 1.6, 2.2); fog.rotation.y = Math.PI; g.add(fog);
    const glow = ownSprite(glowTex, 0xffffff); glow.position.set(3, 1.4, 1.2); glow.scale.set(9, 4, 1); g.add(glow);
    const logo = new THREE.Mesh(geo('logo4', () => new THREE.PlaneGeometry(3.2, 0.8)), ownBasic({ map: sign4Tex('無盡賣場', '#3a8fd8') }));
    logo.position.set(3, CEIL_W4 - 0.65, -0.02); logo.rotation.y = Math.PI; g.add(logo);
    const exit = new THREE.Mesh(geo('exit4', () => new THREE.PlaneGeometry(1.0, 0.3)), ownBasic({ map: exitTex4() }));
    exit.position.set(3, CEIL_W4 - 1.55, -0.03); exit.rotation.y = Math.PI; g.add(exit);
    const rg = ownSprite(glowTex, 0x40ff80); rg.position.set(3, CEIL_W4 - 1.55, -0.1); rg.scale.setScalar(0.9); g.add(rg);
  }
  // 吊著的招牌：每間樣品間的開口上面一塊，別的區域在中間一塊（兩面都有字），另外幾塊永遠走不到的「出口 →」
  const rod = lm('#55585e');
  const hang = (x, z, ry, text, col, w = 2.4) => {
    const g = new THREE.Group(); g.position.set(x, SIGN4_H, z); g.rotation.y = ry; houseGroup.add(g);
    const m = ownBasic({ map: sign4Tex(text, col) });
    for (const s of [0, Math.PI]) { const p = new THREE.Mesh(geo('sign4' + w, () => new THREE.PlaneGeometry(w, w / 4)), m); p.rotation.y = s; p.position.z = s ? -0.012 : 0.012; g.add(p); }
    box(g, -w / 2, w / 2, -w / 8 - 0.02, w / 8 + 0.02, -0.01, 0.01, lm('#1e2024'), false);
    for (const s of [-1, 1]) cyl(g, 0.008, 0.008, CEIL_W4 - SIGN4_H - w / 8, s * w * 0.4, w / 8, 0, rod, 4);
  };
  const ZCOL = { 自助倉儲區: '#e8c23a', 美食區: '#e8743a', 燈具區: '#f2d24a', 電器區: '#4ab0e8', 布料寢具區: '#b07ad8', 沙發區: '#6ab06a', 床墊區: '#5a9ad8', 書櫃區: '#a8805a', 雜貨區: '#d8a04a', 冷凍食品區: '#6ad0e8', 收銀區: '#e85a5a', 入口: '#3a8fd8', 餐桌區: '#d86a6a' };
  for (const c of W4MAP.cubes) hang(c.x + c.w / 2, c.open === 's' ? c.y + c.h + 0.1 : c.y - 0.1, 0, c.name.replace('樣品間', ''), c.wall.replace(/^#(..)(..)(..)$/, (m, a, b, d) => '#' + [a, b, d].map(h => Math.max(0, parseInt(h, 16) - 70).toString(16).padStart(2, '0')).join('')), 2.0);
  const done = new Set();
  for (const z of W4MAP.zones) {
    if (z.cube || z.aisle || done.has(z.name) || z.name === '洗手間' || z.name === '員工專用區') continue;
    done.add(z.name);
    hang(z.x + z.w / 2, z.y + z.h / 2, 0, z.name, ZCOL[z.name] || '#aaa');
  }
  for (const [x, z, a] of [[W4AX + 1, 12, 0], [14, W4AY + 1, Math.PI / 2], [80, W4AY + 1, -Math.PI / 2], [W4AX + 1, 58, 0], [W4AX + 1, 26, Math.PI]]) hang(x, z, a, '出口 →', '#3ad870', 1.6);
}
const SIGN4_H = 4.4;   // 吊著的招牌多高（天花板 6.2 公尺）
function exitTex4() {
  return canvasTex(256, 80, (c, w, h) => { c.fillStyle = '#1a8a3a'; c.fillRect(0, 0, w, h); c.fillStyle = '#eafff0'; c.font = 'bold 44px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('🏃 出口', w / 2, h / 2 + 2); });
}
// 每一幀：日光燈板白天亮、晚上熄；天快黑時一排一排閃掉，天亮時一排一排亮起來；停電時全熄
// ====================================================================
// 第五世界「世界夾層」的草原（world5.js）：沒有天花板，草地一直延伸到白霧裡；天空是夢核風的漸層（白天淡藍、地平線白白的霧），
// 池塘和彎彎曲曲的河（河水會流）、兩座木橋，一棵一棵粉粉白白的樹和一朵一朵大花（都用 InstancedMesh，砍倒的樹換成樹樁），
// 地上一叢一叢的草。下雨是一條一條的雨絲，雷暴雨會打閃電
// ====================================================================
let sky5 = null, water5 = null, trees5 = null, bolt5Mesh = null, rain5Mesh = null;
// 草地：鮮綠色、一點一點黃綠和深綠，偶爾幾朵小白花（夢核的草地顏色很飽和）
let grass5Tex = null;
function makeGrass5Tex() {
  if (grass5Tex) return grass5Tex;
  grass5Tex = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#6cae4c'; c.fillRect(0, 0, w, h);
    const r = seeded(5505);
    for (let i = 0; i < 260; i++) { const x = r() * w, y = r() * h, rr = 8 + r() * 30, g = c.createRadialGradient(x, y, 0, x, y, rr), col = r() < 0.5 ? '150,196,84' : r() < 0.6 ? '58,128,56' : '120,170,70'; g.addColorStop(0, `rgba(${col},.35)`); g.addColorStop(1, `rgba(${col},0)`); c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
    c.lineCap = 'round';
    for (let i = 0; i < 2600; i++) { const x = r() * w, y = r() * h, l = 3 + r() * 6; c.strokeStyle = `rgba(${r() < 0.5 ? '40,100,40' : '170,214,110'},${(0.25 + r() * 0.35).toFixed(2)})`; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x + (r() - 0.5) * 3, y - l); c.stroke(); }
    for (let i = 0; i < 26; i++) { c.fillStyle = r() < 0.7 ? 'rgba(250,250,240,.9)' : 'rgba(250,210,230,.9)'; const x = r() * w, y = r() * h; for (let k = 0; k < 5; k++) { c.beginPath(); c.arc(x + Math.cos(k * 1.26) * 1.6, y + Math.sin(k * 1.26) * 1.6, 1.2, 0, 7); c.fill(); } c.fillStyle = '#f4d040'; c.beginPath(); c.arc(x, y, 0.9, 0, 7); c.fill(); }
  });
  return grass5Tex;
}
// 水的貼圖：藍綠色、淡淡的波紋（河的貼圖會往下游捲動）
let water5Tex = null;
function makeWater5Tex() {
  if (water5Tex) return water5Tex;
  water5Tex = canvasTex(128, 128, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#5f9fb6'); g.addColorStop(1, '#4f8ea8'); c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.lineCap = 'round';
    for (let i = 0; i < 90; i++) { const x = rnd() * w, y = rnd() * h, l = 6 + rnd() * 16; c.strokeStyle = `rgba(${rnd() < 0.6 ? '220,240,250' : '40,90,110'},${(0.15 + rnd() * 0.25).toFixed(2)})`; c.lineWidth = 1 + rnd(); c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + l / 2, y - 2, x + l, y); c.stroke(); }
  });
  return water5Tex;
}
// 天空：一顆跟著鏡頭走的大球（裡面朝外），上面是天頂的顏色、往地平線越來越白（霧），加上淡淡的一團一團的雲
function makeSky5() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTop: { value: new THREE.Color('#8fbce8') }, uHor: { value: new THREE.Color('#eef2f6') }, uCloud: { value: 0.6 }, uT: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uTop, uHor; uniform float uCloud, uT; varying vec3 vP;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float y = clamp(vP.y, 0.0, 1.0);
        vec3 c = mix(uHor, uTop, pow(y, 0.55));
        vec2 q = vP.xz / max(0.18, vP.y) * 1.6 + vec2(uT * 0.01, 0.0);
        float cl = n(q) * 0.55 + n(q * 2.1) * 0.3 + n(q * 4.3) * 0.15;
        cl = smoothstep(0.52, 0.8, cl) * smoothstep(0.03, 0.25, vP.y) * uCloud;
        c = mix(c, mix(uHor, vec3(1.0), 0.6), cl);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  mat.userData.own = true;
  const m = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), mat);
  m.userData.ownGeo = true; m.renderOrder = -10; m.frustumCulled = false;
  return m;
}
// 樹：四種（粉紅色的花樹、白白像雲的樹、深綠色的圓樹、高高的白楊），樹冠是幾顆揉在一起的球（頂點稍微亂一點才不像氣球）
const TREE5 = [
  { col: '#f2b8cc', h: 2.1, blobs: [[0, 0, 0, 1.25], [0.75, -0.15, 0.2, 0.85], [-0.7, -0.1, -0.25, 0.9], [0.1, 0.55, -0.1, 0.8]] },
  { col: '#f4f1ea', h: 2.2, blobs: [[0, 0, 0, 1.2], [0.8, -0.2, 0, 0.8], [-0.75, -0.15, 0.1, 0.85], [0, 0.5, 0.3, 0.75]] },
  { col: '#5f9a52', h: 2.0, blobs: [[0, 0, 0, 1.3], [0.6, 0.3, 0.3, 0.8], [-0.6, 0.2, -0.3, 0.85]] },
  { col: '#9cc46a', h: 2.0, blobs: [[0, 0.2, 0, 0.75], [0, 1.1, 0, 0.62], [0, 1.9, 0, 0.45], [0, -0.55, 0, 0.7]] },
];
function treeCrownGeo(k) {
  return geo('tree5c' + k, () => {
    const parts = TREE5[k].blobs.map(([x, y, z, r], i) => {
      const s = new THREE.IcosahedronGeometry(r, 2), P = s.attributes.position;
      for (let j = 0; j < P.count; j++) { const vx = P.getX(j), vy = P.getY(j), vz = P.getZ(j), w = 1 + 0.12 * Math.sin(vx * 5.1 + i) * Math.sin(vy * 4.7 + vz * 3.9); P.setXYZ(j, vx * w + x, vy * w * 0.9 + y, vz * w + z); }
      return s.toNonIndexed();
    });
    const g = mergeGeos(parts);
    g.computeVertexNormals();
    return g;
  });
}
// 幾個網格合成一個（只有位置；法線另外算）
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) { pos.set(g.attributes.position.array, o * 3); if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2); o += g.attributes.position.count; }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3)); m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return m;
}
// 花：細細的莖、一圈花瓣、花心；五種顏色（粉紅、淡紫、白、黃、淡藍）
const FLOWER5 = ['#f6a8c8', '#c8b0ee', '#f8f6f0', '#f6dc70', '#a8d4f4'];
function buildMeadow5() {
  const g = houseGroup;
  // 草地（地圖外面也鋪，一直延伸到霧裡）
  const gt = makeGrass5Tex(), gm = patchLM(new THREE.MeshLambertMaterial({ map: gt }));
  gm.userData.own = true;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W + 240, MAP_H + 240), gm);
  scaleUV(ground.geometry, (MAP_W + 240) / 2.5, (MAP_H + 240) / 2.5);
  ground.userData.ownGeo = true; ground.rotation.x = -Math.PI / 2; ground.position.set(MAP_W / 2, 0, MAP_H / 2); ground.receiveShadow = true;
  g.add(ground);
  // 水：池塘和河（橋底下的河也畫，河的貼圖往南流）；岸邊一圈濕濕的泥土
  const wt = makeWater5Tex(), riverTex = wt.clone(); riverTex.needsUpdate = true;
  const quads = (cells, y) => {
    const pos = [], uv = [], idx = [];
    for (const [x, z] of cells) { const b = pos.length / 3; pos.push(x, y, z, x + 1, y, z, x, y, z + 1, x + 1, y, z + 1); uv.push(x / 3, z / 3, (x + 1) / 3, z / 3, x / 3, (z + 1) / 3, (x + 1) / 3, (z + 1) / 3); idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geom.setIndex(idx); geom.computeVertexNormals();
    return geom;
  };
  const river = new Set(), pond = [];
  for (let y = 0; y < MAP_H; y++) for (let x = W5MAP.riverX(y) - 1; x <= W5MAP.riverX(y) + 1; x++) river.add(x + ',' + y);
  for (const k of W5MAP.water) if (!river.has(k)) pond.push(k.split(',').map(Number));
  const wm = (map, op) => { const m = patchLM(new THREE.MeshPhongMaterial({ map, color: 0xffffff, specular: 0x88aabb, shininess: 70, transparent: true, opacity: op })); m.userData.own = true; return m; };
  const pm = new THREE.Mesh(quads(pond, 0.03), wm(wt, 0.92)); pm.userData.ownGeo = true; g.add(pm);
  const rm = new THREE.Mesh(quads([...river].map(k => k.split(',').map(Number)), 0.03), wm(riverTex, 0.92)); rm.userData.ownGeo = true; g.add(rm);
  water5 = { river: riverTex };
  const shore = [];
  for (let y = 1; y < MAP_H - 1; y++) for (let x = 1; x < MAP_W - 1; x++) {
    const k = x + ',' + y;
    if (W5MAP.water.has(k) || river.has(k)) continue;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => W5MAP.water.has((x + dx) + ',' + (y + dy)) || river.has((x + dx) + ',' + (y + dy)))) shore.push([x, y]);
  }
  const sm = patchLM(new THREE.MeshLambertMaterial({ color: '#7a6a48', transparent: true, opacity: 0.55 })); sm.userData.own = true;
  const shoreM = new THREE.Mesh(quads(shore, 0.012), sm); shoreM.userData.ownGeo = true; g.add(shoreM);
  // 木橋：橫跨河的那三排，兩邊有欄杆
  const plank = lm('#9a7650'), rail = lm('#6e5236');
  for (const b of W5MAP.bridges) {
    const bg = new THREE.Group(); bg.position.set(b.x + 0.5, 0, b.y + 0.5); g.add(bg);
    for (let i = -6; i <= 6; i++) box(bg, -2.6, 2.6, 0.12 + 0.06 * Math.cos(i / 6 * 1.2), 0.2 + 0.06 * Math.cos(i / 6 * 1.2), i * 0.24 - 0.11, i * 0.24 + 0.11, plank);
    for (const s of [-1, 1]) {
      box(bg, -2.6, 2.6, 0.9, 0.98, s * 1.45 - 0.05, s * 1.45 + 0.05, rail);
      for (let x = -2.4; x <= 2.41; x += 0.8) box(bg, x - 0.05, x + 0.05, 0.1, 0.95, s * 1.45 - 0.05, s * 1.45 + 0.05, rail);
    }
  }
  // 樹（每種一個 InstancedMesh）、樹幹、樹樁
  const trees = FURN.filter(f => f.type === 'tree5');
  const bark = withDetail(ownLM('#7a6252'), 'bark', 2, 1), stumpM = withDetail(ownLM('#8a6e56'), 'bark', 2, 1);
  const trunk = new THREE.InstancedMesh(geo('tree5t', () => new THREE.CylinderGeometry(0.16, 0.26, 1, 8).translate(0, 0.5, 0)), bark, trees.length);
  const stump = new THREE.InstancedMesh(geo('tree5s', () => new THREE.CylinderGeometry(0.24, 0.3, 0.32, 9).translate(0, 0.16, 0)), stumpM, trees.length);
  const crowns = TREE5.map((t, k) => { const m = withDetail(ownLM(t.col, { shade: 0.5 }), 'moss', 1.6, 0.9); return new THREE.InstancedMesh(treeCrownGeo(k), m, trees.length); });
  for (const im of [trunk, stump, ...crowns]) { im.count = 0; im.castShadow = true; im.frustumCulled = false; g.add(im); }
  trees5 = { trees, trunk, stump, crowns, slot: new Map() };
  const counts = TREE5.map(() => 0);
  trees.forEach((f, i) => { const k = f.kind % TREE5.length; trees5.slot.set(f.id, { i, k, c: counts[k]++ }); });
  for (const im of [trunk, stump]) im.count = trees.length;
  crowns.forEach((im, k) => { im.count = counts[k]; });
  for (const f of trees) setTree5(f);
  // 花（莖、花瓣、花心）
  const flowers = FURN.filter(f => f.type === 'flower5');
  const stemG = geo('fl5stem', () => new THREE.CylinderGeometry(0.025, 0.035, 1, 6).translate(0, 0.5, 0));
  const petalG = geo('fl5petal', () => {
    const parts = [];
    for (let i = 0; i < 8; i++) { const p = new THREE.SphereGeometry(0.16, 8, 6); p.scale(1, 0.25, 0.55); p.translate(0.2, 0, 0); p.rotateY(i / 8 * Math.PI * 2); parts.push(p.toNonIndexed()); }
    const m = mergeGeos(parts); m.computeVertexNormals(); return m;
  });
  const centerG = geo('fl5c', () => new THREE.SphereGeometry(0.1, 10, 6).scale(1, 0.5, 1));
  const stems = new THREE.InstancedMesh(stemG, lm('#4e8a3e'), flowers.length);
  const heads = new THREE.InstancedMesh(petalG, (() => { const m = patchLM(new THREE.MeshLambertMaterial({ color: 0xffffff })); m.userData.own = true; return m; })(), flowers.length);
  const centers = new THREE.InstancedMesh(centerG, lm('#f0c040'), flowers.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), C = new THREE.Color(), E = new THREE.Euler();
  flowers.forEach((f, i) => {
    const h = 1.0 * (f.big || 1), x = f.x + 0.5, z = f.y + 0.5;
    M.compose(P.set(x, 0, z), Q.identity(), S.set(1, h, 1)); stems.setMatrixAt(i, M);
    Q.setFromEuler(E.set(0.25 * Math.sin(f.rot || 0), f.rot || 0, 0.2 * Math.cos(f.rot || 0)));
    const s = 0.9 + 0.5 * ((f.big || 1) - 0.8);
    M.compose(P.set(x, h, z), Q, S.set(s, s, s)); heads.setMatrixAt(i, M); centers.setMatrixAt(i, M);
    heads.setColorAt(i, C.set(FLOWER5[f.kind % FLOWER5.length]));
  });
  for (const im of [stems, heads, centers]) { im.castShadow = true; im.frustumCulled = false; g.add(im); }
  // 地上一叢一叢的草（不長在水裡、樹和家具上）
  const pts = [], rr = seeded(5151);
  for (let y = 1; y < MAP_H - 1; y++) for (let x = 1; x < MAP_W - 1; x++) {
    if (tiles[y][x] !== 1 || furnGrid[y][x] || rr() > 0.42) continue;
    pts.push([x + 0.1 + rr() * 0.8, y + 0.1 + rr() * 0.8, 0.6 + rr() * 0.9, rr() * Math.PI]);
  }
  const bm = patchLM(new THREE.MeshLambertMaterial({ map: bladeTex, alphaTest: 0.45, side: THREE.DoubleSide, color: '#b8e08a' })); bm.userData.own = true;
  const tufts = new THREE.InstancedMesh(tuftGeo(), bm, pts.length);
  pts.forEach(([x, z, s, a], i) => { M.compose(P.set(x, 0, z), Q.setFromAxisAngle(UP, a), S.set(s, s * (0.8 + (i % 5) * 0.08), s)); tufts.setMatrixAt(i, M); });
  tufts.frustumCulled = false; g.add(tufts);
  // 天空、閃電
  sky5 = makeSky5(); g.add(sky5);
  bolt5Mesh = null;
}
// 一棵樹的樣子：站著的樹（樹幹、樹冠），砍倒了就只剩樹樁
const _t5M = new THREE.Matrix4(), _t5Q = new THREE.Quaternion(), _t5S = new THREE.Vector3(), _t5P = new THREE.Vector3(), _t5Z = new THREE.Matrix4().makeScale(0, 0, 0);
function setTree5(f) {
  if (!trees5) return;
  const sl = trees5.slot.get(f.id);
  if (!sl) return;
  const b = f.big || 1, x = f.x + 0.5, z = f.y + 0.5, T = TREE5[sl.k], up = !f.cut;
  _t5Q.setFromAxisAngle(UP, f.rot || 0);
  trees5.trunk.setMatrixAt(sl.i, up ? _t5M.compose(_t5P.set(x, 0, z), _t5Q, _t5S.set(b, T.h * b + 0.6, b)) : _t5Z);
  trees5.stump.setMatrixAt(sl.i, up ? _t5Z : _t5M.compose(_t5P.set(x, 0, z), _t5Q, _t5S.set(b, 1, b)));
  trees5.crowns[sl.k].setMatrixAt(sl.c, up ? _t5M.compose(_t5P.set(x, T.h * b + 1.2 * b, z), _t5Q, _t5S.set(b, b, b)) : _t5Z);
  for (const im of [trees5.trunk, trees5.stump, trees5.crowns[sl.k]]) im.instanceMatrix.needsUpdate = true;
}
// 第五世界的家具：樹和花（InstancedMesh 已經畫了，這裡什麼都不放）、工作台（上面攤開一本厚厚的合成書）、沐浴球機、木頭方塊
function meadow5Furniture(f, g, r, W, D) {
  if (!isW5()) return false;
  switch (f.type) {
    case 'tree5': case 'flower5': return true;
    case 'bench5': {
      const wood = lm('#9a7652'), top = lm('#b48a5e');
      box(g, 0.05, W - 0.05, 0.82, 0.9, 0.05, D - 0.05, top);
      for (const [x, z] of [[0.12, 0.12], [W - 0.12, 0.12], [0.12, D - 0.12], [W - 0.12, D - 0.12]]) box(g, x - 0.05, x + 0.05, 0, 0.82, z - 0.05, z + 0.05, wood);
      box(g, 0.1, W - 0.1, 0.25, 0.3, 0.1, D - 0.1, wood);
      // 攤開的書：兩頁、中間的書背，旁邊一把小鋸子和槌子
      const bk = new THREE.Group(); bk.position.set(W / 2, 0.9, D / 2); bk.rotation.y = 0.1; g.add(bk);
      const page = canvasTex(128, 96, (c, w, h) => { c.fillStyle = '#f2ead6'; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(80,60,40,.5)'; for (let y = 14; y < h - 8; y += 8) { c.beginPath(); c.moveTo(10, y); c.lineTo(w - 10 - (y % 24), y); c.stroke(); } c.strokeStyle = 'rgba(120,90,60,.7)'; c.strokeRect(w * 0.55, 16, 40, 30); });
      const pm = patchLM(new THREE.MeshLambertMaterial({ map: page })); pm.userData.own = true;
      for (const s of [-1, 1]) { const p = box(bk, s > 0 ? 0.01 : -0.3, s > 0 ? 0.3 : -0.01, 0.02, 0.04, -0.21, 0.21, pm); p.rotation.z = s * 0.06; }
      box(bk, -0.32, 0.32, 0, 0.02, -0.23, 0.23, lm('#6a2a2a'));
      box(g, W - 0.45, W - 0.15, 0.9, 0.93, 0.15, 0.25, lm('#8a8f96'));
      r.top = 0.9;
      return true;
    }
    case 'bath5': {
      // 沐浴球機：粉紅色的販賣機，玻璃裡面堆著一顆一顆彩色的沐浴球，上面一個大大的泡泡招牌
      const body = lm('#f2b6cc'), dk = lm('#c8809e');
      box(g, 0.08, W - 0.08, 0, 1.55, 0.08, D - 0.08, body);
      const glass = ownPhong('#dff4ff', { transparent: true, opacity: 0.35, specular: 0xffffff, shininess: 90 });
      fb(g, f, f.side || 's', 0.18, W - 0.18, 0.75, 1.42, -0.01, 0.02, glass, false);
      const balls = ['#ff9ac8', '#9ad8ff', '#c8f0a0', '#fff0a0', '#d0b0ff'].map(c => ownPhong(c, { specular: 0x555555, shininess: 30 }));
      for (let i = 0; i < 14; i++) { const u = 0.25 + (i % 4) * 0.17, y = 0.82 + Math.floor(i / 4) * 0.15; const m = sph(g, 0.07, 0, 0, 0, balls[i % balls.length], 1, 1, 1, 10); const [x, z] = side5(f, u, 0.18); m.position.set(x, y, z); }
      fb(g, f, f.side || 's', 0.3, W - 0.3, 0.3, 0.42, -0.02, 0.02, dk, false);
      const sign = sph(g, 0.22, W / 2, 1.85, D / 2, ownPhong('#e8f6ff', { transparent: true, opacity: 0.6, specular: 0xffffff, shininess: 100 }), 1, 1, 1, 16);
      sign.userData.keep = true;
      r.top = 1.55;
      return true;
    }
    case 'fireplace4': {
      // 第五世界的火爐是草地上的營火：一圈石頭、交叉的木柴，有燃料時火焰亮起來（火焰的顏色由 updateStoreFurniture4 改）
      const stone = lm('#8e8a82'), stone2 = lm('#77736c'), log = withDetail(ownLM('#6a4a30'), 'bark', 4, 0.9), cx = W / 2, cz = D / 2;
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; sph(g, 0.11, cx + Math.cos(a) * 0.36, 0.07, cz + Math.sin(a) * 0.36, i % 2 ? stone : stone2, 1.2, 0.75, 1, 8); }
      for (let i = 0; i < 4; i++) { const m = cyl(g, 0.045, 0.05, 0.62, cx, 0.05, cz, log, 7); m.rotation.set(Math.PI / 2 - 0.35, i / 4 * Math.PI, 0); m.position.y = 0.16; }
      r.window = new THREE.Mesh(geo('camp5f', () => new THREE.ConeGeometry(0.2, 0.55, 7, 1, true).translate(0, 0.27, 0)), ownBasic({ color: 0x120804, side: THREE.DoubleSide }));
      r.window.position.set(cx, 0.12, cz); r.window.userData.keep = true; g.add(r.window);
      r.fireGlow = ownSprite(glowTex, 0xff8a30); r.fireGlow.position.set(cx, 0.5, cz); r.fireGlow.scale.set(1.8, 1.4, 1); r.fireGlow.visible = false; g.add(r.fireGlow);
      r.top = 0.3;
      return true;
    }
    case 'cube5': {
      // 1 公尺的木頭方塊：木板拼成的面、深色的邊框
      const t = canvasTex(64, 64, (c, w, h) => { c.fillStyle = '#b8895a'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 16) { c.fillStyle = shade('#b8895a', (rnd() - 0.5) * 22); c.fillRect(0, y, w, 15); c.fillStyle = 'rgba(70,45,25,.6)'; c.fillRect(0, y + 15, w, 1); } c.strokeStyle = '#6a4a2a'; c.lineWidth = 5; c.strokeRect(2, 2, w - 4, h - 4); });
      const m = patchLM(new THREE.MeshLambertMaterial({ map: t })); m.userData.own = true;
      box(g, 0.01, W - 0.01, 0, 1.0, 0.01, D - 0.01, m);
      r.top = 1.0;
      return true;
    }
  }
  return false;
}
// 家具正面（side）上的一點：u 沿著正面、v 往裡面
function side5(f, u, v) {
  const s = f.side || 's', W = f.w, D = f.h;
  return s === 's' ? [u, D - v] : s === 'n' ? [u, v] : s === 'e' ? [W - v, u] : [v, u];
}
// 每一幀：天空跟著鏡頭走、顏色跟著時間和天氣變；河水往下游流；閃電
const cSky5 = { top: new THREE.Color('#8fbce8'), hor: new THREE.Color('#eef2f6'), duskT: new THREE.Color('#e7a6b8'), duskH: new THREE.Color('#ffe2c8'), nightT: new THREE.Color('#05060f'), nightH: new THREE.Color('#0d0f18'),
  rainT: new THREE.Color('#8e98a6'), rainH: new THREE.Color('#c4cad2'), stormT: new THREE.Color('#4a525e'), stormH: new THREE.Color('#7a828c'), fogT: new THREE.Color('#e8ecf0'), fogH: new THREE.Color('#f3f5f7'),
  bloodT: new THREE.Color('#2a0408'), bloodH: new THREE.Color('#3a0a0e'), acidH: new THREE.Color('#d4dab4'), coldT: new THREE.Color('#b8cce0'), coldH: new THREE.Color('#e6eef6') };
const _s5a = new THREE.Color(), _s5b = new THREE.Color();
function sky5Colors(k, top, hor) {
  const C = cSky5, rain = rain5(), fog = fog5(), storm = rain >= 1;
  top.copy(G.cold ? C.coldT : C.top); hor.copy(G.cold ? C.coldH : acidOn4() ? C.acidH : C.hor);
  if (rain > 0) { top.lerp(storm ? C.stormT : C.rainT, 0.85); hor.lerp(storm ? C.stormH : C.rainH, 0.8); }
  if (fog) { top.lerp(C.fogT, 0.9); hor.lerp(C.fogH, 0.9); }
  const dusk = G.phase === 'day' ? clamp((G.t - (DAY_LEN - DUSK * 2)) / (DUSK * 2), 0, 1) * (1 - k) : 0;
  if (dusk > 0 && !rain && !fog) { top.lerp(C.duskT, dusk * 0.7); hor.lerp(C.duskH, dusk * 0.7); }
  const blood = G.ev.blood && G.phase === 'night';
  top.lerp(blood ? C.bloodT : C.nightT, k); hor.lerp(blood ? C.bloodH : C.nightH, k);
  const fl = G.flash5 || 0;
  if (fl > 0) { top.lerp(_s5b.set('#e8ecff'), fl * 0.8); hor.lerp(_s5b.set('#f4f6ff'), fl * 0.8); }
}
// 第五世界的怪物很大、貼圖一個一個像素算：第一次出來會卡一下。天快黑的時候（最後 50 秒）每 1.5 秒先蓋一隻再拆掉，
// 網格和貼圖都記住了（geo、m5Tex），晚上真的出來就不會卡
const WARM5 = ['daydream', 'gaze', 'slice', 'green', 'cradle', 'clone', 'leak'];
let warm5i = 0, warm5T = 0;
function warmMonsters5(t) {
  if (warm5i >= WARM5.length || G.phase !== 'day' || G.t < DAY_LEN - 50 || t - warm5T < 1.5) return;
  warm5T = t;
  const r = buildEnemy({ kind: WARM5[warm5i++], x: 0, y: 0, wob: 0 });
  disposeGroup(r.g);
}
// tools/make-monster5-tex.mjs（網址有 &bake5）：7 隻和重做過的舊怪物（UPG）都蓋一次、當場畫貼圖，把每張貼圖壓成 WebP 傳回去，存成 tex/m5-<key>.webp；
// 沒有 &bake5 時只傳回每隻蓋多久（量卡頓用）
function bake5() {
  const ms = {};
  for (const kind of [...WARM5, ...Object.keys(UPG)]) { const t0 = performance.now(); disposeGroup(buildEnemy({ kind, x: 0, y: 0, wob: 0 }).g); ms[kind] = Math.round(performance.now() - t0); }
  const tex = !M5_BAKE ? [] : Object.entries(m5Texs).map(([key, t]) => ({ key, w: t.image.width, h: t.image.height, url: t.image.toDataURL('image/webp', 0.9) }));
  return { ms, tex };
}
function syncMeadow5(t, dark) {
  warmMonsters5(t);
  const k = clamp(dark / NIGHT_DARK, 0, 1);
  if (sky5) {
    sky5.position.copy(camera.position);
    const u = sky5.material.uniforms;
    sky5Colors(k, u.uTop.value, u.uHor.value);
    u.uCloud.value = (fog5() ? 0.1 : rain5() > 0 ? 0.9 : 0.55) * (1 - k * 0.7); u.uT.value = t;
  }
  if (water5) water5.river.offset.set(0, -t * 0.12);
  // 閃電：一條鋸齒狀的亮線從天上打到地上
  const b = G.bolt5;
  if (b && !bolt5Mesh) {
    const pts = [], rr = seeded(Math.floor(b.x * 7 + b.y * 13));
    let x = b.x + rand(-3, 3), z = b.y + rand(-3, 3);
    for (let h = 40; h > 0; h -= 2.5) { pts.push(new THREE.Vector3(x, h, z)); x += (b.x - x) * 0.18 + (rr() - 0.5) * 1.6; z += (b.y - z) * 0.18 + (rr() - 0.5) * 1.6; }
    pts.push(new THREE.Vector3(b.x, 0, b.y));
    const lg = new THREE.BufferGeometry().setFromPoints(pts), lmat = new THREE.LineBasicMaterial({ color: 0xf4f6ff, fog: false });
    bolt5Mesh = new THREE.Line(lg, lmat); scene.add(bolt5Mesh);
  } else if (!b && bolt5Mesh) { scene.remove(bolt5Mesh); bolt5Mesh.geometry.dispose(); bolt5Mesh.material.dispose(); bolt5Mesh = null; }
}
// 雨：一條一條往下掉的雨絲（線段），在玩家附近 14 公尺內；屋頂和樹底下沒有雨
function syncRain5(dt) {
  const amt = isW5() && G ? rain5() : 0;
  if (!amt) { if (rain5Mesh) rain5Mesh.visible = false; return; }
  if (!rain5Mesh) {
    const N = 1100, geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    rain5Mesh = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xc8d6e6, transparent: true, opacity: 0.45, depthWrite: false }));
    rain5Mesh.frustumCulled = false; scene.add(rain5Mesh);
    rain5Mesh.userData = { N, v: Array.from({ length: N }, () => ({ x: 0, y: -1, z: 0, s: Math.random() })), init: false };
  }
  const R = rain5Mesh.userData, pos = rain5Mesh.geometry.attributes.position.array, p = G.p, RR = 14, n = Math.round(R.N * amt), fall = 13;
  rain5Mesh.visible = true;
  for (let i = 0; i < R.N; i++) {
    const q = R.v[i], j = i * 6;
    if (i >= n) { pos[j + 1] = pos[j + 4] = -50; continue; }
    if (!R.init || q.y < 0 || Math.abs(q.x - p.x) > RR || Math.abs(q.z - p.y) > RR) { q.x = p.x + (Math.random() * 2 - 1) * RR; q.z = p.y + (Math.random() * 2 - 1) * RR; q.y = R.init ? 12 + Math.random() * 2 : Math.random() * 14; }
    q.y -= fall * dt * (0.8 + q.s * 0.4);
    const hide = q.y < ROOF4_H + 0.1 && sheltered4(q.x, q.z);
    pos[j] = q.x; pos[j + 1] = hide ? -50 : q.y; pos[j + 2] = q.z; pos[j + 3] = q.x + 0.03; pos[j + 4] = hide ? -50 : q.y + 0.45; pos[j + 5] = q.z + 0.02;
  }
  R.init = true;
  rain5Mesh.geometry.attributes.position.needsUpdate = true;
}
function syncStore4(t, dark) {
  if (!panel4) return;
  const k = 1 - clamp(dark / NIGHT_DARK, 0, 1), col = _c4;
  const dusk = G.phase === 'day' && G.t > DAY_LEN - DUSK;
  panel4Info.forEach((p, i) => {
    let v = k;
    if (dusk) { const off = (G.t - (DAY_LEN - DUSK)) / DUSK * 16 - p.row * 0.9; v = off > 1 ? 0 : off > 0 ? (Math.sin(t * 40 + p.ph) > 0 ? 0.9 : 0.05) : 1; }
    else if (G.phase === 'day' && G.t < DAWN) v = G.t / DAWN * 16 - p.row * 0.9 > 0 ? 1 : 0.04;
    v = Math.max(0.035, v);
    col.setRGB(v, v, v * 0.98);
    panel4.setColorAt(i, col);
  });
  panel4.instanceColor.needsUpdate = true;
}
const _c4 = new THREE.Color();
// 紅月的晚上：賣場的地上長出一叢一叢的草
function syncGrass4() {
  const on = !!(G.grass4 && G.ev.blood && G.phase === 'night');
  if (on && !grass4Mesh) {
    const pts = [], r = seeded(808);
    for (let y = 1; y < MAP_H - 1; y++) for (let x = 1; x < MAP_W - 1; x++) {
      if (tiles[y][x] !== 1 || furnGrid[y][x] || r() > 0.45) continue;
      for (let k = 0; k < 2; k++) pts.push([x + 0.15 + r() * 0.7, y + 0.15 + r() * 0.7, 0.5 + r() * 0.7, r() * Math.PI]);
    }
    const bm = patchLM(new THREE.MeshLambertMaterial({ map: bladeTex, alphaTest: 0.45, side: THREE.DoubleSide })); bm.userData.own = true;
    grass4Mesh = new THREE.InstancedMesh(tuftGeo(), bm, pts.length);
    const q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), m = new THREE.Matrix4();
    pts.forEach(([x, z, k, a], i) => { q.setFromAxisAngle(UP, a); sc.set(k, k, k); pos.set(x, 0, z); m.compose(pos, q, sc); grass4Mesh.setMatrixAt(i, m); });
    grass4Mesh.computeBoundingSphere(); houseGroup.add(grass4Mesh);
  }
  if (grass4Mesh) grass4Mesh.visible = on;
}
// 地上一灘一灘的東西：葵氏奶昔的奶（白）、紅涎偽人的紅涎（紅、濕亮）、燼皇的玫瑰藤（深紅、帶刺）
const puddle4 = {};
function syncPuddles4(t) {
  const kinds = [['milk4', [0.95, 0.93, 0.86]], ['drool4', [0.55, 0.02, 0.05]], ['thorns4', [0.32, 0.04, 0.06]]];
  for (const [k, c] of kinds) {
    const list = G[k] || [];
    let m = puddle4[k];
    if (!m && list.length) {
      m = puddle4[k] = new THREE.InstancedMesh(geo(k === 'thorns4' ? 'thornGeo' : 'trail', () => (k === 'thorns4' ? new THREE.RingGeometry(0.5, 1, 7, 1) : new THREE.CircleGeometry(1, 14))), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.88, depthWrite: false }), 40);
      m.frustumCulled = false; m.count = 0; scene.add(m);
    }
    if (!m) continue;
    const n = Math.min(40, list.length);
    for (let i = 0; i < n; i++) {
      const l = list[list.length - n + i], fade = clamp(l.life / 3, 0, 1);
      _q.setFromEuler(_e.set(-Math.PI / 2, 0, l.a + (k === 'thorns4' ? t * 0.1 : 0), 'XYZ'));
      _m4.compose(_v.set(l.x, 0.012 + i * 0.00005, l.y), _q, _sc.set(l.r, l.r * 0.85, 1));
      m.setMatrixAt(i, _m4);
      _c4.setRGB(c[0] * fade, c[1] * fade, c[2] * fade); m.setColorAt(i, _c4);
    }
    m.count = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}
// Hubert 的震波：從牠腳下往外擴散的紅色圓圈
const wave4Map = new Map();
function syncWaves4() {
  const seen = new Set();
  for (const w of G.waves4 || []) {
    seen.add(w);
    let m = wave4Map.get(w);
    if (!m) { m = new THREE.Mesh(geo('wave4', () => new THREE.RingGeometry(0.85, 1, 40)), ownBasic({ color: 0xff3020, transparent: true, depthWrite: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; scene.add(m); wave4Map.set(w, m); }
    m.position.set(w.x, 0.05, w.y); m.scale.setScalar(Math.max(0.1, w.r)); m.material.opacity = clamp(1 - w.r / (w.max + 0.5), 0, 1) * 0.85;
  }
  for (const [w, m] of wave4Map) if (!seen.has(w)) { scene.remove(m); m.material.dispose(); wave4Map.delete(w); }
}
// 寒寂之境的雪、酸雨：從賣場的天花板落下來的粒子（在你身邊一圈；屋頂底下、有天花板的小房間裡沒有）
let weather4 = null;
function syncWeather4(dt) {
  const snow = isW4() && !!G.cold, acid = isW4() && acidOn4(), top = isW5() ? 12 : CEIL_W4;   // 第五世界沒有天花板：從 12 公尺高落下來
  if (!snow && !acid) { if (weather4) weather4.pts.visible = false; return; }
  if (!weather4) {
    const N = 700, geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.07, map: glowTex, transparent: true, depthWrite: false, opacity: 0.85 }));
    pts.frustumCulled = false; scene.add(pts);
    weather4 = { pts, N, v: Array.from({ length: N }, () => ({ x: 0, y: -1, z: 0, s: Math.random() })), init: false };
  }
  const W = weather4, pos = W.pts.geometry.attributes.position.array, p = G.p, R = 9, fall = acid ? 9 : 0.9;
  W.pts.visible = true;
  W.pts.material.color.set(acid ? 0xb8e070 : 0xffffff); W.pts.material.size = acid ? 0.04 : 0.07;
  for (let i = 0; i < W.N; i++) {
    const q = W.v[i];
    if (!W.init || q.y < 0 || Math.abs(q.x - p.x) > R || Math.abs(q.z - p.y) > R) {
      q.x = p.x + (Math.random() * 2 - 1) * R; q.z = p.y + (Math.random() * 2 - 1) * R; q.y = W.init ? top - 0.05 : Math.random() * top;
    }
    q.y -= fall * dt * (0.7 + q.s * 0.6);
    if (snow) q.x += Math.sin(G.time * 0.7 + q.s * 9) * 0.3 * dt;
    const hide = (q.y < ROOF4_H && sheltered4(q.x, q.z)) || isWall(Math.floor(q.x), Math.floor(q.z));
    pos[i * 3] = q.x; pos[i * 3 + 1] = hide ? -50 : q.y; pos[i * 3 + 2] = q.z;
  }
  W.init = true;
  W.pts.geometry.attributes.position.needsUpdate = true;
}
// 第四世界的光照貼圖：光從燈往外一格一格擴散（world4.js 的 lightMask4），被牆、柱子和不透明的板子擋住
function addLight4(L, col, k) {
  const m = lightMask4(L), r = L.r, r2 = r * r;
  const x0 = Math.max(0, Math.floor((L.x - r) * LMS)), x1 = Math.min(LMW - 1, Math.ceil((L.x + r) * LMS));
  const y0 = Math.max(0, Math.floor((L.y - r) * LMS)), y1 = Math.min(LMH - 1, Math.ceil((L.y + r) * LMS));
  for (let ty = y0; ty <= y1; ty++) {
    const wy = (ty + 0.5) / LMS - L.y, gy = Math.floor(ty / LMS);
    for (let tx = x0; tx <= x1; tx++) {
      const wx = (tx + 0.5) / LMS - L.x, d2 = wx * wx + wy * wy;
      if (d2 >= r2 || !maskHas(m, Math.floor(tx / LMS), gy)) continue;
      const i = ty * LMW + tx, I = (1 - Math.pow(Math.sqrt(d2) / r, 1.8)) * k;
      lmAcc[i * 3] += col[0] * I; lmAcc[i * 3 + 1] += col[1] * I; lmAcc[i * 3 + 2] += col[2] * I;
    }
  }
}
// 把一件家具的零件照材質合成幾個網格（不會動的零件；userData.keep 的零件和光點不合併）
function mergeByMat(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), buckets = new Map(), parts = [];
  root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && !o.userData.keep && !(o.parent && o.parent.userData.keep) && o.geometry.attributes.uv && o.geometry.attributes.normal) parts.push(o); });
  for (const o of parts) {
    const key = o.material.uuid;
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { mat: o.material, list: [] });
    b.list.push({ o, m: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
  }
  for (const b of buckets.values()) {
    if (b.list.length < 2) continue;
    let nv = 0, ni = 0;
    for (const { o } of b.list) { const g = o.geometry; nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const { o, m } of b.list) {
      const g = o.geometry, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, I = g.index, n = P.count;
      _pn.getNormalMatrix(m);
      for (let i = 0; i < n; i++) {
        const k = (vo + i) * 3;
        _pv.fromBufferAttribute(P, i).applyMatrix4(m); pos[k] = _pv.x; pos[k + 1] = _pv.y; pos[k + 2] = _pv.z;
        _pv.fromBufferAttribute(N, i).applyMatrix3(_pn).normalize(); nor[k] = _pv.x; nor[k + 1] = _pv.y; nor[k + 2] = _pv.z;
        uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i);
      }
      if (I) for (let i = 0; i < I.count; i++) idx[io++] = I.getX(i) + vo; else for (let i = 0; i < n; i++) idx[io++] = i + vo;
      vo += n;
      o.parent.remove(o);
      if (o.userData.ownGeo) g.dispose();
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); mg.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); mg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    mg.setIndex(new THREE.BufferAttribute(idx, 1)); mg.computeBoundingSphere();
    const mesh = new THREE.Mesh(mg, b.mat); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.ownGeo = true;
    root.add(mesh);
  }
}
// 家具搬動：拿起來的時候拆掉，放下的時候照新的位置和方向重建（removed：整個從地圖上拿掉了，例如特別板材堆拿完了）
function furnChanged4(f, removed) {
  const r = furn3d[f.id];
  if (r) { disposeGroup(r.g); delete furn3d[f.id]; }
  if (!removed && !f.held && houseGroup) buildOneFurn(f);
}

// ====================================================================
// 霧、窗戶、主繪圖
// ====================================================================
const cDayFog = new THREE.Color('#1b1720'), cNightFog = new THREE.Color('#020104'), cBloodFog = new THREE.Color('#160205');
const cWinDay = new THREE.Color('#dcebf5'), cWinDusk = new THREE.Color('#e89a5a'), cWinNight = new THREE.Color('#0a1022'), cWinBlood = new THREE.Color('#4a0610');
// 第二世界：白天是淡淡的粉紫色霧，晚上深藍紫色；萬物甦醒時在紫色和綠色之間變來變去
const cW2Day = new THREE.Color('#cdbfe0'), cW2Night = new THREE.Color('#05041a'), cAwakeA = new THREE.Color('#1c0a2c'), cAwakeB = new THREE.Color('#06221a');
// 第三世界：白天是淡藍色的薄霧（窗外是夢核風的藍天白雲），晚上黑；紅月偏紅
const cW3Day = new THREE.Color('#a9c9e8'), cW3Night = new THREE.Color('#030204'), cW3Blood = new THREE.Color('#1a0406');
const cW4Day = new THREE.Color('#bfc3c6'), cW4Cold = new THREE.Color('#c8d6e6'), cW4Acid = new THREE.Color('#b9bea2');
const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();
function updateAtmosphere(dark, t) {
  const k = dark / NIGHT_DARK;
  // 第四世界：白天賣場裡有一層淡淡的灰白色霧（遠處看不到盡頭，像走不完一樣），晚上全黑；紅月偏紅、寒寂之境偏藍、酸雨偏黃綠
  const far = isW5() ? 160 : isW4() ? 46 : 160;
  if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
  if (isW5()) {
    sky5Colors(k, _s5a, tmpC);   // 地平線的顏色就是霧的顏色（遠處的草地融進天空）
    scene.fog.color.copy(tmpC); scene.background.copy(tmpC);
    const fog = fog5(), rain = rain5();
    scene.fog.near = (fog ? 2 : rain ? 9 : 16) * (1 - 0.75 * k); scene.fog.far = (fog ? 17 : rain ? 48 : 75) - (fog ? 4 : 40) * k;
    return;
  }
  if (isW4()) {
    const blood = G.ev.blood && G.phase === 'night';
    const day = G.cold ? cW4Cold : acidOn4() ? cW4Acid : cW4Day;
    tmpC.copy(day).lerp(blood ? cW3Blood : cW3Night, k);
    scene.fog.color.copy(tmpC); scene.background.copy(tmpC);
    scene.fog.near = 9 - 7.5 * k; scene.fog.far = 42 - 29 * k;
    return;
  }
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
// 每種怪物的取景：h 高度、d 鏡頭距離、cy 看著的高度（沒寫就用高度算）、ds 舞台放大幾倍（很大的怪物：記憶洩漏源 22 公尺）
const BOOK_VIEW = { crawler: { h: 1.0, d: 2.8, cy: 0.4 }, snail: { h: 1.45, d: 2.9, cy: 0.6 }, blob: { h: 1.0, d: 2.4, cy: 0.5 }, shroom: { h: 1.95, d: 3.7 }, grass: { h: 1.95 }, sunflower: { h: 1.75 }, eye: { h: 1.65 },
  kronos: { h: 1.7, d: 3.3, cy: 0.8 }, tyrant: { h: 3.0, d: 5.4, cy: 1.4 }, warlord: { h: 2.75, d: 5.0, cy: 1.3 }, taowu: { h: 2.3, d: 5.0, cy: 1.1 },
  staff: { h: 2.15, d: 4.3, cy: 1.1 }, shake: { h: 0.65, d: 1.8, cy: 0.3 }, mimic: { h: 1.95, d: 3.9, cy: 0.95 }, hubert: { h: 2.1, d: 4.6, cy: 1.0 }, ember: { h: 3.1, d: 6.8, cy: 1.55 },
  cradle: { h: 4.9, d: 12.5, cy: 2.55 }, leak: { h: 22, d: 58, cy: 10, ds: 5 }, daydream: { h: 10.5, d: 30, cy: 5.2, ds: 2.5 }, slice: { h: 3.3, d: 10.5, cy: 1.55 }, gaze: { h: 4.4, d: 10.5, cy: 2.2 }, green: { h: 3.0, d: 8.2, cy: 1.45 }, clone: { h: 9, d: 30, cy: 4.6, ds: 2.5 } };
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
    dome.position.set(BOOK_X, 1.0, BOOK_Y); book.scene.add(dome); book.dome = dome;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), new THREE.MeshBasicMaterial({ color: 0x231c2e, fog: false }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(BOOK_X, 0.002, BOOK_Y); book.scene.add(floor); book.floor = floor;
    book.lm = new THREE.DataTexture(new Uint8Array([100, 96, 108, 255]), 1, 1, THREE.RGBAFormat);
    book.lm.needsUpdate = true;
    book.okFlag = true;
  } catch (e) { book.okFlag = false; }
  return book.okFlag;
}
// 怪物都放在地圖中間同一個位置（lightAt 之類的函式要查得到房間），一次只顯示一隻
let BOOK_X = Math.floor(MAP_W / 2) + 0.5, BOOK_Y = Math.floor(MAP_H / 2) + 0.5;
// 換世界：怪物改放在這個世界最大的那間（第三世界是景觀車廂）的中間，舊的模型全部拆掉重建
function bookPlace() {
  const r = ROOMS.find(r => r.id === 'lounge') || ROOMS.find(r => r.id === 'living') || ROOMS[0];
  BOOK_X = Math.floor(r.x + r.w / 2) + 0.5; BOOK_Y = Math.floor(r.y + r.h / 2) + 0.5;
  for (const m of book.models.values()) disposeGroup(m.r.g);
  book.models.clear();
  if (book.dome) book.dome.position.set(BOOK_X, 1.0, BOOK_Y);
  if (book.floor) book.floor.position.set(BOOK_X, 0.002, BOOK_Y);
}
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
      burn: 0, emerge: 0, pauseT: 0, state: 'idle', cd: 0, stun: 0, hopT: 1, hopping: 0, air: 0, rise: 0, hidden: false, retract: 0, chew: 0, blind: 0, blindCd: 0,
      pose: true, thrust: 0, limpT: 0, retreat: 0, stomp: 0, cooled: 0, swing: 0, roar: 0, pounce: 0, lit: false, face: Math.PI / 2, eyes: Array.from({ length: 9 }, () => ({ shut: false })) };
    m = { key, e, r: buildEnemy(e, book.scene) };
  }
  const v = (!spec.flower && UPG[spec.kind] && UPG[spec.kind].view) || BOOK_VIEW[spec.flower || spec.kind] || {};
  m.h = v.h || barH(m.e || m.f); m.d = v.d || m.h * 1.85 + 0.3; m.cy = v.cy ?? m.h * 0.5;
  m.ds = v.ds || 1;
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
    // 第三世界
    case 'kronos': { const c = (t + ph) % 4; e.thrust = c < 0.5 ? 0.5 - c : 0; e.limpT = t; e.retreat = c > 2.5 && c < 3.2 ? 1 : 0; break; }   // 一跛一跛、刺矛、被光照到往後縮
    case 'tyrant': { const c = (t + ph) % 6; e.stomp = c < 0.6 ? 0.6 - c : 0; e.cooled = c > 3.5 && c < 5 ? 1 : 0; break; }                    // 跺腳、被聖水冷卻變黑
    case 'warlord': { const c = (t + ph) % 5; e.swing = c > 2 && c < 2.6 ? 2.6 - c : 0; e.cd = c >= 2.6 && c < 3.8 ? 3.8 - c : 0; e.state = c < 2 ? 'patrol' : 'charge'; break; }   // 走、舉劍、橫掃
    case 'taowu': { const c = (t + ph) % 14, k = Math.floor(c / 1.1); e.eyes.forEach((x, i) => { x.shut = i < k; }); e.lit = c < 9.9; e.blind = c >= 9.9 && c < 13 ? 1 : 0; e.roar = c > 13 ? 14 - c : 0; e.pounce = 0; break; }   // 眼睛一顆一顆閉上、瞎了、咆哮
    // 第四世界
    case 'staff': { const c = (t + ph) % 7; e.idle = c < 3; e.state = c < 3 ? 'idle' : 'chase'; e.face = Math.PI / 2 + 1.2; e.look = c < 3 && c > 0.8 ? Math.PI / 2 : null; e.cd = c > 5.4 && c < 5.9 ? 1.6 - (c - 5.4) : 0; if (!e.idle) e.face = Math.PI / 2; break; }   // 背對著站、頭慢慢轉過來、走過來、揮拳
    case 'shake': { const c = (t + ph) % 6; e.awake = c > 2; e.hopT = t; e.spitT = c > 4 && c < 4.4 ? 4 - (c - 4) : 1; break; }   // 躺著闔眼 → 睜眼跳 → 噴奶
    case 'mimic': { const c = (t + ph) % 8; e.state = c < 3.5 ? 'wander' : c < 6.5 ? 'hunt' : 'knock'; e.knock = c >= 6.5 ? 1 : 0; e.knockTick = 2.4 - ((c * 2.4) % 2.4) * 0.5; e.retreat = 0; break; }   // 站著歪頭、四腳著地衝、敲門
    case 'hubert': { const c = (t + ph) % 6; e.raise = c > 2 && c < 3 ? 3 - c : 0; e.cd = c >= 3 && c < 3.5 ? 4.5 - (c - 3) : 0; e.swing = c > 4.6 && c < 4.95 ? 4.95 - c : 0; e.home = false; break; }   // 舉起鐵管、砸地、敲牆
    case 'ember': { const c = (t + ph) % 10; e.rain = c > 1 && c < 4 ? 1 : 0; e.haloLit = c > 5 && c < 6.5; e.kneel = c > 6.5 && c < 9 ? 1 : 0; e.cd = c > 0.2 && c < 0.8 ? 2.2 - (c - 0.2) : 0; break; }   // 揮爪、燼雨張開手、光環被照、跪下
    // 第五世界
    case 'cradle': case 'leak': case 'daydream': case 'slice': case 'gaze': case 'green': case 'clone': near = 8; break;   // 眼睛看著遠一點的假玩家（看得到整個眼球）
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
    book.dome.scale.setScalar(m.ds); book.floor.scale.setScalar(m.ds); book.cam.far = 40 * m.ds;
    // 鏡頭：看著怪物的中間，慢慢左右繞
    // book.aim（看模型用，Renderer.book.aim 設定）：固定鏡頭的角度 a、仰角 el、距離 d（或照原本的距離乘 k）、看著的高度 cy、往旁邊移 x
    const v = book.aim || {}, a = v.a ?? Math.sin(book.t * 0.4 + it.ph) * 0.5, el = v.el ?? 0.16, md = (v.d ?? m.d) * (v.k ?? 1), cy = v.cy ?? m.cy, cam = book.cam;
    cam.aspect = rc.width / rc.height; cam.updateProjectionMatrix();
    const px = BOOK_X + (v.x || 0);
    cam.position.set(px + Math.sin(a) * md * Math.cos(el), cy + md * Math.sin(el), BOOK_Y + Math.cos(a) * md * Math.cos(el));
    cam.lookAt(px, cy, BOOK_Y);
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
  syncFriends(t, dt, dark);   // 跟朋友一起玩：朋友的人物（要在光照貼圖前面：手電筒照到的地方）
  syncFireballs(t);
  syncProjectiles(t);
  syncWorld2(t);
  if (isW3()) { syncChests3(t); syncStopEyes(t); syncLava3(t); }
  if (isW4()) { syncBuild4(t); syncStore4(t, dark); syncGrass4(); syncPuddles4(t); syncWaves4(); }
  if (isW5()) syncMeadow5(t, dark);   // 第五世界：天空、河水、閃電
  syncRain5(Math.min(dt, 0.1));
  if (isW4() || ghostMesh4) { syncGhost4(); syncHand4(); }
  if (isW4() || whistleDots.length) syncWhistle4(t);
  if (isW4() || weather4) syncWeather4(Math.min(dt, 0.1));
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
  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 160);   // 第三世界從車頂看得很遠（南面的風景在 35 格外）
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  allocLM();
  precomputeTexels();
  makeTextures();
  makeMonsterTextures();
  makeExtraTextures();
  makeGardenTextures();
  makeTrainTextures();
  makeMonster3Textures();
  buildHouse();
  buildFurniture();
  buildFlashlight();
  buildWeapons();
  buildExtras();
  glowPts = makePoints(0.07, THREE.AdditiveBlending);
  smokePts = makePoints(0.3, THREE.NormalBlending);
  window.Renderer = { render, resize, setWorld, furn4: furnChanged4, tree5: setTree5, dbg: () => ({ scene, camera, THREE }), book: { ok: bookOk, show: bookShow, stats: book.stats, aim: o => { book.aim = o; } }, pax: paxStats, friends: friendStats, photos: () => ({ loaded: Object.keys(photos), total: PHOTO_TEX.length }), bake5, m5: () => Object.fromEntries(Object.entries(m5Texs).map(([k, t]) => [k, t.image && t.image.tagName === 'IMG' ? 'file' : t.image === m5Blank ? 'wait' : 'paint'])) };
  resize();
}
loadPhotos().then(init);   // 照片貼圖載入好才開始（最多等 5 秒）
