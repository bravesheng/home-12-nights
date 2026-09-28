'use strict';
// ===== 在家生存 12 夜（3D 第一人稱）— 遊戲邏輯與介面 =====

const T = TILE;
const DAY_LEN = 150, NIGHT_LEN = 150, DUSK = 20, DAWN = 8;
const LAST_NIGHT = 12;
const SAVE_KEY = 'home99_save_v1';
const PLAYER_R = 0.32, ENEMY_R = 0.3;
const FL_RANGE = 7.5, FL_HALF = 0.42;
const NIGHT_DARK = 0.94;

const $ = id => document.getElementById(id);
// 舊版 iPad Safari 沒有 roundRect
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) { this.rect(x, y, w, h); };
}
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const grid = v => Array.from({ length: MAP_H }, () => Array(MAP_W).fill(v));
function weighted(obj) {
  let s = 0; for (const k in obj) s += obj[k];
  let r = Math.random() * s;
  for (const k in obj) { r -= obj[k]; if (r <= 0) return k; }
  return Object.keys(obj)[0];
}
function hsl(h, s, l) {
  h /= 360;
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ====================================================================
// 地圖
// ====================================================================
let tiles, roomGrid, doorGrid, furnGrid, solid, mapCv;
const FURN_BY_ID = {}; FURN.forEach(f => (FURN_BY_ID[f.id] = f));
const FRONT_DOOR = DOORS.find(d => d.front);
const ROOM_CLIP = {};

function buildMap() {
  tiles = grid(0); roomGrid = grid(null); doorGrid = grid(null); furnGrid = grid(null); solid = grid(true);
  for (const r of ROOMS)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) { tiles[y][x] = 1; roomGrid[y][x] = r; }
  for (const d of DOORS) {
    tiles[d.y][d.x] = 2; doorGrid[d.y][d.x] = d; d.rooms = [];
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const r = roomGrid[d.y + dy] && roomGrid[d.y + dy][d.x + dx];
      if (r && !d.rooms.includes(r)) d.rooms.push(r);
    }
  }
  for (const f of FURN) {
    f.room = roomGrid[f.y][f.x];
    if (f.solid === false) continue;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) furnGrid[y][x] = f;
  }
  for (const s of SOCKETS) s.room = roomGrid[s.y][s.x];
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      solid[y][x] = tiles[y][x] === 0 || !!(doorGrid[y][x] && doorGrid[y][x].front) || !!furnGrid[y][x];
  // 每個房間的光線裁切範圍（房間 + 相連的門）
  for (const r of ROOMS) {
    const p = new Path2D();
    p.rect(r.x * T, r.y * T, r.w * T, r.h * T);
    for (const d of DOORS) if (!d.front && d.rooms.includes(r)) p.rect(d.x * T, d.y * T, T, T);
    ROOM_CLIP[r.id] = p;
  }
}
const inMap = (tx, ty) => tx >= 0 && ty >= 0 && tx < MAP_W && ty < MAP_H;
function isWall(tx, ty) {
  if (!inMap(tx, ty)) return true;
  if (tiles[ty][tx] === 0) return true;
  const d = doorGrid[ty][tx];
  return !!(d && d.front);
}
const isSolid = (tx, ty) => !inMap(tx, ty) || solid[ty][tx];
function rectDist(px, py, r) {
  const nx = clamp(px, r.x, r.x + r.w), ny = clamp(py, r.y, r.y + r.h);
  return Math.hypot(px - nx, py - ny);
}

// ====================================================================
// 遊戲狀態
// ====================================================================
let G = null;
let mode = 'title';
let invDirty = true;
let flow = null, flowTimer = 0;

function freshState() {
  return {
    day: 1, phase: 'day', t: 0, time: 0, power: true,
    p: { x: 19.5, y: 23, hp: 100, san: 100, hunger: 100, bat: 100, stam: 100, flash: false, face: -Math.PI / 2, pitch: 0, inv: 0, hurt: 0, batWarned: false },
    inv: {}, selId: null,
    sockets: SOCKETS.map(s => ({ kind: 'socket', type: 'socket', id: s.id, x: s.x, y: s.y, room: s.room, bulb: 0, dying: 0 })),
    lamps: [], candles: [], containers: {}, flowers: [],
    coins: 0, pickups: [], chests: {}, gift: null, treasure: null, stock: [], nightStats: null, fireballs: [],
    enemies: [], fx: [], ghosts: [], lights: [],
    ev: { schedule: [], blood: false, knock: 0, knockTick: 0, phone: 0, phoneTick: 0, closet: 0, closetTick: 0, closetLight: 0,
          bedTimer: 0, bedCd: 0, bedWarned: false, duskWarned: false, ghostT: 5, beatT: 0, whisperT: 10,
          tvOn: false, tvT: 0, alarm: 0, deliveryAt: -1, delivery: 0, dTick: 0 },
    spawnT: 8, shake: 0,
    target: null, holdId: null, holdProg: 0, holdLock: false,
    stats: { searched: 0, dissolved: 0, bestTier: 1 },
  };
}

function newGame() {
  G = freshState();
  G.sockets.find(s => s.id === 's_living').bulb = 1;
  for (const f of FURN) if (f.loot) G.containers[f.id] = { items: [] };
  refillContainers(0.6);
  prepareDay();
  addItem('bulb1', 2); addItem('lamp_desk', 1); addItem('snack', 2); addItem('battery', 1); addItem('candle', 1);
  G.selId = 'bulb1';
  saveGame();
  startPlay();
  showBig('第 1 天', '白天趕快找燈泡');
}

function startPlay() {
  mode = 'play';
  flow = null;
  invDirty = true;
  for (const id of ['title', 'help', 'pause', 'gameover', 'book', 'transfer']) $(id).classList.add('hidden');
  $('hud').classList.remove('hidden');
  lockPointer();
}

// ====================================================================
// 存檔
// ====================================================================
function saveGame() {
  const s = {
    v: 1, day: G.day,
    p: { x: G.p.x, y: G.p.y, hp: G.p.hp, san: G.p.san, hunger: G.p.hunger, bat: G.p.bat },
    inv: G.inv, selId: G.selId,
    sockets: G.sockets.map(s => s.bulb),
    lamps: G.lamps.map(l => ({ type: l.type, x: l.x, y: l.y, bulb: l.bulb })),
    containers: G.containers, stats: G.stats,
    flowers: G.flowers.map(f => ({ x: f.x, y: f.y, lv: f.lv })),
    coins: G.coins, chests: G.chests, gift: G.gift, treasure: G.treasure, stock: G.stock,
    pickups: G.pickups.map(pk => ({ x: pk.x, y: pk.y, id: pk.id, n: pk.n })), delivery: G.ev.deliveryAt,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { /* 無法存檔時忽略 */ }
}
function readSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; }
}
function loadGame() {
  const s = readSave();
  if (!s) return false;
  G = freshState();
  G.day = Math.min(s.day, LAST_NIGHT);
  Object.assign(G.p, s.p);
  G.inv = s.inv || {};
  G.selId = s.selId;
  (s.sockets || []).forEach((b, i) => { if (G.sockets[i]) G.sockets[i].bulb = b; });
  G.lamps = (s.lamps || []).map(l => ({ kind: 'lamp', ...l, dying: 0, room: roomGrid[l.y][l.x] }));
  G.containers = s.containers || {};
  for (const f of FURN) if (f.loot && !G.containers[f.id]) G.containers[f.id] = { items: [] };
  G.stats = Object.assign(G.stats, s.stats || {});
  G.flowers = (s.flowers || []).map(f => ({ ...setLevel(newFlower(f.x, f.y), 'flower', f.lv || 1), grow: 1 }));
  G.coins = s.coins || 0; G.chests = s.chests || {}; G.gift = s.gift || null; G.treasure = s.treasure || null;
  G.pickups = (s.pickups || []).map(pk => ({ ...pk, t: Math.random() * 6 }));
  G.ev.deliveryAt = s.delivery === undefined ? -1 : s.delivery;
  if (s.stock && s.stock.length) G.stock = s.stock; else makeStock();
  return true;
}

// ====================================================================
// 物品與搜索
// ====================================================================
function rollTier(level, day) {
  const mu = 0.3 + level * 0.6 + day * 0.62;
  const w = {};
  for (let t = 1; t <= NORMAL_MAX; t++) w[t] = Math.exp(-((t - mu) ** 2) / 2.4) * (t === NORMAL_MAX ? 0.35 : t === FIRE_TIER ? 0.6 : 1);
  return +weighted(w);
}
function rollItem(table, level, day) {
  const k = weighted(LOOT[table]);
  return k === 'bulb' ? 'bulb' + rollTier(level, day) : k;
}
function refillContainers(chance = 0.35) {
  for (const f of FURN) {
    if (!f.loot) continue;
    const c = G.containers[f.id];
    if (c.items.length || Math.random() > chance) continue;
    const n = Math.random() < 0.2 ? 2 : 1;
    for (let i = 0; i < n; i++) c.items.push(rollItem(f.loot, f.room.level, G.day));
  }
}
function addItem(id, n = 1) {
  G.inv[id] = (G.inv[id] || 0) + n;
  if (!G.selId || !G.inv[G.selId]) G.selId = id;
  const it = ITEMS[id];
  if (it.kind === 'bulb' && it.tier > G.stats.bestTier) G.stats.bestTier = it.tier;
  invDirty = true;
}
function removeItem(id, n = 1) {
  const list = invList();
  const idx = list.indexOf(id);
  G.inv[id] -= n;
  if (G.inv[id] <= 0) {
    delete G.inv[id];
    if (G.selId === id) {
      const nl = invList();
      G.selId = nl.length ? nl[Math.min(idx, nl.length - 1)] : null;
    }
  }
  invDirty = true;
}
const invList = () => ITEM_ORDER.filter(id => G.inv[id] > 0);
const lampItemId = type => ({ desk: 'lamp_desk', floor: 'lamp_floor', chand: 'lamp_chand' })[type];

function search(f) {
  const c = G.containers[f.id];
  makeNoise(4);
  if (!c.items.length) { toast(`${f.name}裡什麼都沒有。`); Sound.play('empty'); return; }
  const counts = {};
  for (const id of c.items) {
    if (id === 'coin') { const n = 1; addCoins(n); counts.coin = (counts.coin || 0) + n; }
    else { addItem(id); counts[id] = (counts[id] || 0) + 1; }
  }
  const best = Math.max(0, ...c.items.map(id => ITEMS[id].tier || 0));
  c.items = [];
  G.stats.searched++;
  toast('找到：' + Object.entries(counts).map(([id, n]) => ITEMS[id].name + (n > 1 ? ` ×${n}` : '')).join('、'), 'item');
  Sound.play('pickup');
  if (best >= 5) { toast(`✨ 稀有燈泡！${BULBS[best].name}（第 ${best} 級）`, 'good'); Sound.play('dawn'); }
}

// ====================================================================
// 燈光
// ====================================================================
function bulbRGB(tier) {
  const c = BULBS[tier].color;
  return c === 'rainbow' ? hsl((G.time * 70) % 360, 0.9, 0.62) : c;
}
function buildLights() {
  const L = [];
  const add = (o, mult) => {
    if (!o.bulb || !G.power || BULBS[o.bulb].noLight) return;
    let f = 1;
    if (o.bulb === 1) f = 0.8 + 0.2 * Math.sin(G.time * 11 + o.x * 3) * Math.sin(G.time * 5.7 + o.y);
    if (o.bulb === FIRE_TIER) f = 0.93 + 0.07 * Math.sin(G.time * 8 + o.x);
    if (o.bulb === STAR_TIER) f = 0.95 + 0.05 * Math.sin(G.time * 3 + o.y);
    if (o.dying > 0) f = Math.random() < 0.5 ? 0.12 : 0.9;
    if (o.eaten > 0) f *= (1 - 0.65 * o.eaten) * (Math.random() < 0.25 ? 0.5 : 1);
    L.push({ x: o.x + 0.5, y: o.y + 0.5, r: BULBS[o.bulb].r * mult, tier: o.bulb, room: o.room, f, obj: o });
  };
  G.sockets.forEach(s => add(s, 1));
  G.lamps.forEach(l => add(l, LAMP_TYPES[l.type].mult));
  if (G.stock && merchantHere()) L.push({ x: MERCHANT_POS.x + 0.3, y: MERCHANT_POS.y, r: 3.2, tier: 0, room: roomGrid[29][11], f: 0.85 + Math.random() * 0.08, color: [255, 190, 110] });
  if (G.ev && G.ev.tvOn) L.push({ x: 15, y: 15.9, r: 2.6, tier: 0, room: roomGrid[16][15], f: 0.55 + Math.random() * 0.35, color: [140, 170, 255], tv: true });
  for (const c of G.candles) {
    const k = c.life < 10 ? c.life / 10 : 1;
    L.push({ x: c.x, y: c.y, r: 2.6 * (0.6 + 0.4 * k), tier: 0, room: c.room, f: (0.85 + 0.12 * Math.random()) * k, candle: true });
  }
  G.lights = L;
}
function lightAt(x, y, minTier = 0) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inMap(tx, ty)) return 0;
  let rooms, scale = 1;
  if (roomGrid[ty][tx]) rooms = [roomGrid[ty][tx]];
  else if (doorGrid[ty][tx] && !doorGrid[ty][tx].front) { rooms = doorGrid[ty][tx].rooms; scale = 0.7; }
  else return 0;
  let best = 0;
  for (const L of G.lights) {
    if (L.tier < minTier || !rooms.includes(L.room)) continue;
    const d = Math.hypot(x - L.x, y - L.y);
    if (d >= L.r) continue;
    const i = (1 - Math.pow(d / L.r, 1.8)) * L.f;
    if (i > best) best = i;
  }
  return best * scale;
}
const flashOn = () => G.p.flash && G.p.bat > 0;
function castRay(x, y, a, maxD) {
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let d = 0.08; d < maxD; d += 0.08)
    if (isWall(Math.floor(x + dx * d), Math.floor(y + dy * d))) return d;
  return maxD;
}
function inBeam(e) {
  if (!flashOn()) return false;
  const p = G.p, dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
  if (d > FL_RANGE) return false;
  const a = Math.atan2(dy, dx);
  let da = a - p.face;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  if (Math.abs(da) > FL_HALF + 0.1) return false;
  return castRay(p.x, p.y, a, d) >= d - 0.05;
}

// ====================================================================
// 移動與尋路
// ====================================================================
function hits(x, y, r) {
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++)
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (!isSolid(tx, ty)) continue;
      const nx = clamp(x, tx, tx + 1), ny = clamp(y, ty, ty + 1);
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
    }
  return false;
}
function move(e, dx, dy, r) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.15));
  dx /= steps; dy /= steps;
  for (let i = 0; i < steps; i++) {
    if (!hits(e.x + dx, e.y, r)) e.x += dx;
    else if (dy === 0) nudge(e, 'y', Math.abs(dx), r);
    if (!hits(e.x, e.y + dy, r)) e.y += dy;
    else if (dx === 0) nudge(e, 'x', Math.abs(dy), r);
  }
}
// 在門口卡住時自動滑到門中央
function nudge(e, axis, amt, r) {
  const c = Math.floor(e[axis]) + 0.5, dir = Math.sign(c - e[axis]);
  if (!dir) return;
  const s = Math.min(amt, Math.abs(c - e[axis]));
  const nx = axis === 'x' ? e.x + dir * s : e.x, ny = axis === 'y' ? e.y + dir * s : e.y;
  if (!hits(nx, ny, r)) { e.x = nx; e.y = ny; }
}
function computeFlow() { flow = computeFlowFrom(Math.floor(G.p.x), Math.floor(G.p.y)); }
// 從燈具走過去的路線（家具和牆都不會動，算一次就好）
const fixFlows = new Map();
function flowTo(x, y) {
  const k = x + ',' + y;
  let f = fixFlows.get(k);
  if (!f) { f = computeFlowFrom(x, y); fixFlows.set(k, f); }
  return f;
}
function computeFlowFrom(sx, sy) {
  const f = grid(Infinity);
  const q = [[sx, sy]]; f[sy][sx] = 0;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (isSolid(nx, ny) || f[ny][nx] !== Infinity) continue;
      f[ny][nx] = f[y][x] + 1;
      q.push([nx, ny]);
    }
  }
  return f;
}
// 沿著路線 f 走向 (gx, gy)
function pathDir(e, f, gx, gy, wobble = 0.35) {
  const tx = Math.floor(e.x), ty = Math.floor(e.y);
  const d = f && inMap(tx, ty) ? f[ty][tx] : Infinity;
  if (d !== Infinity && d > 1) {
    let bv = d, best = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const v = f[ty + dy] ? f[ty + dy][tx + dx] : Infinity;
      if (v < bv) { bv = v; best = [tx + dx, ty + dy]; }
    }
    if (best) { gx = best[0] + 0.5; gy = best[1] + 0.5; }
  }
  let vx = gx - e.x, vy = gy - e.y;
  const l = Math.hypot(vx, vy) || 1;
  vx /= l; vy /= l;
  const w = Math.sin(e.wob * 2.3) * wobble, c = Math.cos(w), s = Math.sin(w);
  return { x: vx * c - vy * s, y: vx * s + vy * c };
}
const chaseDir = e => pathDir(e, flow, G.p.x, G.p.y);
function findSpawn(minDist = 9) {
  if (!flow) computeFlow();
  for (let i = 0; i < 80; i++) {
    const r = pick(ROOMS);
    const x = r.x + Math.floor(Math.random() * r.w), y = r.y + Math.floor(Math.random() * r.h);
    if (isSolid(x, y)) continue;
    const d = flow[y][x];
    if (d === Infinity || d < minDist) continue;
    return { x: x + 0.5, y: y + 0.5 };
  }
  return null;
}

// ====================================================================
// 怪物的等級與血量：手電筒、天使、火球都會扣血，血扣光就打倒了
// ====================================================================
const FL_DPS = 1;                // 手電筒每秒對怪物造成的傷害
const BASE_HP = { shadow: 1, fast: 0.8, blob: 1.3, stick: 1.5, balloon: 0.8, flower: 1.5, woman: 4, momo: 4, crawler: 3.5, clown: 4, tall: 6 };
const MONSTER_NAME = { shadow: '黑影', fast: '衣櫃怪', blob: '黑球', stick: '火柴人', balloon: '紅氣球', flower: '眼球花', woman: '血淚女', momo: '鳥腳女', crawler: '爬行女', clown: '小丑', tall: '它' };
const BOSSES = ['woman', 'momo', 'crawler', 'clown', 'tall'];
const kindOf = t => t.kind || 'flower';
function rollLevel() {
  let lv = 1 + Math.floor((G.day - 1) / 2) + (Math.random() < 0.35 ? 1 : 0);
  if (G.ev && G.ev.blood) lv++;
  return clamp(lv, 1, 8);
}
function setLevel(m, kind, lv) {
  m.lv = lv;
  m.maxHp = BASE_HP[kind] * (1 + 0.4 * (lv - 1));
  m.hp = m.maxHp;
  return m;
}
const initHp = (m, kind) => setLevel(m, kind, rollLevel());
function hurtMonster(t, dmg) {
  if (t.dead || !(t.hp > 0)) return;
  t.hp -= dmg * (kindOf(t) === 'tall' ? 0.5 : 1); // 「它」很耐打
  t.hitT = 0.3;
  if (t.hp <= 0) defeatMonster(t);
}
// 手電筒照著怪物時每一幀呼叫
function flashHurt(t, dt) {
  hurtMonster(t, FL_DPS * dt);
  if (Math.random() < dt * 12) G.fx.push({ type: 'spark', x: t.x + rand(-0.2, 0.2), y: t.y + rand(-0.2, 0.2), h: targetH(t) + rand(-0.3, 0.3), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vh: rand(0, 0.8), life: 0.4, max: 0.4, color: [255, 240, 200] });
}
function defeatMonster(t) {
  const kind = kindOf(t);
  t.hp = 0; t.dead = true;
  G.stats.dissolved++;
  if (kind === 'flower') { puff(t.x, t.y, [70, 110, 60], 14, 1.2); Sound.play('dissolve'); }
  else if (kind === 'balloon') { puff(t.x, t.y, [200, 20, 30], 12, 1.8); Sound.play('pop'); }
  else if (kind === 'stick') { puff(t.x, t.y, [40, 30, 20], 16, 1); Sound.play('burn'); }
  else { puff(t.x, t.y, [10, 6, 16], 18, targetH(t)); Sound.play('dissolve'); }
  if (kind === 'blob' && t.target) t.target.eaten = 0;
  if (kind === 'crawler') { G.ev.tvOn = false; G.ev.tvT = 0; }
  onKill(t);
  const msg = {
    blob: '⚫ 黑球被打散了！', stick: '✏️ 火柴人被燒掉了！', balloon: '🎈 氣球破了！小丑找不到你了。', flower: '🌼 眼球花枯萎了。',
    woman: '😢 血淚女消散了！', momo: '🐦 鳥腳女被打跑了！', crawler: '📺 爬行女被打倒了，電視也關掉了！', clown: '🤡 小丑被打倒了！', tall: '👁️ 你打倒了「它」！',
  }[kind];
  if (msg && (BOSSES.includes(kind) || !G.ev['kill_' + kind])) { G.ev['kill_' + kind] = 1; toast(`${msg}（Lv.${t.lv}）`, 'good'); }
}

// ====================================================================
// 敵人
// ====================================================================
function spawnEnemy(kind, at) {
  const pos = at || findSpawn(['tall', 'woman', 'momo', 'balloon'].includes(kind) ? 12 : kind === 'stick' ? 10 : 8);
  if (!pos) return null;
  const e = initHp({ kind, x: pos.x, y: pos.y, spawn: 1, wob: Math.random() * 10 }, kind);
  if (kind === 'blob') Object.assign(e, { size: 1, h: 0.4, eatT: 0, target: null, retarget: 0, slurpT: 0 });
  if (kind === 'woman') Object.assign(e, { cd: 0, sobT: 1, giggleT: 2, seen: false });
  if (kind === 'stick') Object.assign(e, { burn: 0, whistleT: 2 });
  if (kind === 'momo') Object.assign(e, { state: 'idle', cd: 0, stun: 0, stunCd: 0, hopT: 1, hopping: 0, air: 0, lost: 0 });
  if (kind === 'crawler') Object.assign(e, { emerge: 0, pauseT: 0, crawlT: 0 });
  if (kind === 'balloon') Object.assign(e, { burn: 0, squeakT: 3 });
  if (kind === 'clown') Object.assign(e, { chase: 8, laughT: 1 });
  G.enemies.push(e);
  return e;
}
function puff(x, y, color = [10, 6, 16], n = 14, h = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(0.3, 1.4);
    G.fx.push({ type: 'smoke', x, y, h: h + rand(-0.4, 0.4), vx: Math.cos(a) * s, vy: Math.sin(a) * s, vh: rand(-0.2, 0.7), life: rand(0.5, 1), max: 1, color });
  }
}
function updateEnemies(dt) {
  const p = G.p, n = diffN();
  G.stare = Math.max(0, (G.stare || 0) - dt * 1.5);
  for (const e of G.enemies) {
    e.wob += dt;
    if (e.spawn > 0) e.spawn = Math.max(0, e.spawn - dt);
    const edt = dt * slimeFactor(e.x, e.y); // 在黏液裡動作變慢
    if (SPECIAL_AI[e.kind]) { SPECIAL_AI[e.kind](e, edt); continue; }
    const beam = inBeam(e);
    const dir = chaseDir(e);
    let sp;
    if (e.kind === 'tall') sp = Math.min(1.5 + n * 0.012, 2.6) * (beam ? 0.8 : 1);
    else sp = Math.min(1.8 + n * 0.025, 3.6) * (e.kind === 'fast' ? 1.5 : 1) * (G.ev.alarm > 0 ? 1.4 : 1) * (beam ? 0.35 : 1);
    if (beam) { flashHurt(e, dt); if (e.dead) continue; }
    if (e.spawn > 0) sp *= 0.3;
    move(e, dir.x * sp * edt, dir.y * sp * edt, ENEMY_R);

    if (Math.hypot(e.x - p.x, e.y - p.y) < 0.62 && e.spawn <= 0 && p.inv <= 0) hurtPlayer(e);
  }
  G.enemies = G.enemies.filter(e => !e.dead);
}
function hurtPlayer(e) {
  const p = G.p, n = diffN();
  if (e.kind === 'tall') {
    damage(35 + n * 0.15, 25);
    toast('「它」抓住了你！快逃！', 'warn');
    const pos = findSpawn(14);
    if (pos) { e.x = pos.x; e.y = pos.y; e.spawn = 1.5; }
  } else {
    damage(15 + n * 0.2, 12);
    e.dead = true; puff(e.x, e.y);
  }
  p.inv = 1;
}
function damage(hp, san) {
  const p = G.p;
  p.hp -= hp; p.san -= san;
  p.hurt = 1; G.shake = 0.4;
  if (G.nightStats && G.phase === 'night') G.nightStats.caught++;
  Sound.play('hurt');
}

// ====================================================================
// 新怪物：血淚女、黑球（依照草稿設計）
// ====================================================================
// 是否正在看著某個位置（水平角度＋沒有被牆擋住）
function lookedAt(e) {
  const p = G.p;
  if (Math.abs(p.pitch) > 0.95) return false;
  const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
  if (d > 14 || lookAngle(e.x, e.y) > 0.62) return false;
  return castRay(p.x, p.y, Math.atan2(dy, dx), d) >= d - 0.05;
}
const nearVol = d => clamp(1.1 - d / 12, 0.12, 1);

// 血淚女：你看著她就不會動，但盯著她理智會一直掉
function updateWoman(e, dt) {
  const p = G.p, n = diffN();
  const d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  e.seen = e.spawn <= 0 && lookedAt(e);
  if (e.seen) {
    const k = clamp(1.2 - d / 10, 0.3, 1);
    p.san -= (3 + n * 0.04) * k * dt;
    G.stare = Math.min(1, G.stare + dt * 3);
    e.giggleT -= dt;
    if (e.giggleT <= 0) { Sound.play('giggle', nearVol(d)); e.giggleT = rand(3, 6); }
    if (!G.ev.stareTip) { G.ev.stareTip = 1; toast('😢 你看著她時她不會動……但一直盯著她，理智會崩潰！', 'warn'); }
  } else if (e.cd <= 0) {
    const dir = chaseDir(e);
    const sp = Math.min(2.2 + n * 0.012, 3.3) * (e.spawn > 0 ? 0.3 : 1);
    move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    e.sobT -= dt;
    if (e.sobT <= 0 && d < 12) { Sound.play('sob', nearVol(d)); e.sobT = rand(2.5, 4.5); }
  }
  if (d < 0.7 && e.spawn <= 0 && e.cd <= 0 && p.inv <= 0) {
    jumpscare();
    damage(25 + n * 0.15, 25);
    p.inv = 1.5;
    toast('😱 血淚女抓住了你！', 'warn');
    womanVanish(e, 14);
    e.cd = 10;
  }
}
function womanVanish(e, minDist) {
  puff(e.x, e.y, [40, 30, 40], 12, 1.3);
  const pos = findSpawn(minDist);
  if (pos) { e.x = pos.x; e.y = pos.y; }
  e.spawn = 1.5;
}

// 黑球：不追你，專門去吃燈，把燈泡吸掉一級（特殊燈泡直接吃掉）
const EAT_TIME = 6;
const isLitFixture = o => o.bulb > 0 && G.power;
function blobTarget(e) {
  let best = null, bd = Infinity;
  const tx = Math.floor(e.x), ty = Math.floor(e.y);
  for (const o of [...G.sockets, ...G.lamps]) {
    if (!isLitFixture(o)) continue;
    if (G.enemies.some(b => b !== e && b.kind === 'blob' && b.target === o)) continue;
    const d = flowTo(o.x, o.y)[ty][tx];
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function updateBlob(e, dt) {
  const p = G.p, n = diffN();
  const R = 0.4 * e.size;
  const beam = inBeam(e);
  if (beam) { flashHurt(e, dt); if (e.dead) return; }
  e.retarget -= dt;
  if (!e.target || !isLitFixture(e.target) || e.retarget <= 0) {
    const nt = blobTarget(e);
    if (nt !== e.target) { if (e.target) e.target.eaten = 0; e.target = nt; e.eatT = 0; }
    e.retarget = 2;
  }
  let goalH = R;
  const slow = (beam ? 0.3 : 1) * (e.spawn > 0 ? 0.3 : 1);
  if (e.target) {
    const o = e.target, bp = bulbPos(o);
    const cx = o.x + 0.5, cy = o.y + 0.5;
    if (Math.hypot(cx - e.x, cy - e.y) < 0.55) {
      // 爬上去把燈包住
      goalH = bp.h - R * 0.2;
      move(e, (cx - e.x) * Math.min(1, dt * 3), (cy - e.y) * Math.min(1, dt * 3), ENEMY_R);
      if (e.h > goalH - 0.3) {
        if (!e.warned) { e.warned = true; toast(`⚫ 黑球正在吃${o.room.name}的燈！快用手電筒照它！`, 'warn'); }
        e.eatT += dt * (beam ? 0.3 : 1);
        o.eaten = e.eatT / EAT_TIME;
        e.slurpT -= dt;
        if (e.slurpT <= 0) { Sound.play('slurp', nearVol(Math.hypot(e.x - p.x, e.y - p.y))); e.slurpT = 1.3; }
        // 光被吸進去的粒子
        if (Math.random() < dt * 25) {
          const a = Math.random() * Math.PI * 2, rr = rand(0.5, 0.9), hh = rand(-0.4, 0.4);
          G.fx.push({ type: 'spark', x: bp.x + Math.cos(a) * rr, y: bp.y + Math.sin(a) * rr, h: bp.h + hh, vx: -Math.cos(a) * rr * 2, vy: -Math.sin(a) * rr * 2, vh: -hh * 2, life: 0.5, max: 0.5, color: bulbRGB(o.bulb) });
        }
        if (e.eatT >= EAT_TIME) eatBulb(e, o);
      }
    } else {
      const dir = pathDir(e, flowTo(o.x, o.y), cx, cy, 0.15);
      const sp = Math.min(1.3 + n * 0.012, 2.2) * slow;
      move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    }
  } else {
    // 沒有亮著的燈：慢慢跟著你
    const dir = chaseDir(e);
    move(e, dir.x * 1.2 * slow * dt, dir.y * 1.2 * slow * dt, ENEMY_R);
  }
  e.h += clamp(goalH - e.h, -2.5 * dt, 2.5 * dt);
  // 撞到玩家會被彈開
  const d = Math.hypot(e.x - p.x, e.y - p.y);
  if (e.h < 1.1 && d < 0.35 + R && e.spawn <= 0 && p.inv <= 0) {
    damage(8 + n * 0.1, 10);
    p.inv = 1;
    const a = Math.atan2(e.y - p.y, e.x - p.x);
    move(e, Math.cos(a) * 1.2, Math.sin(a) * 1.2, ENEMY_R);
    Sound.play('plop');
  }
}
function eatBulb(e, o) {
  const old = o.bulb;
  o.bulb = isSpecialBulb(old) ? 0 : old - 1; // 特殊燈泡被吃掉就直接消失
  o.eaten = 0; o.dying = 0;
  e.eatT = 0; e.target = null; e.retarget = 0; e.warned = false;
  e.size = Math.min(1.7, e.size + 0.15);
  Sound.play('gulp');
  const bp = bulbPos(o);
  puff(bp.x, bp.y, [20, 10, 30], 10, bp.h);
  toast(`⚫ 黑球吞掉了${o.room.name}的光！${BULBS[old].name} → ${o.bulb ? BULBS[o.bulb].name : '燈泡沒了'}`, 'warn');
}

// 被血淚女抓到時，她的臉會撲到畫面上
let jsTimer = 0;
function jumpscare(draw = drawWomanFace) {
  const cj = $('jumpscare'), c = cj.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cj.width = Math.round(innerWidth * dpr); cj.height = Math.round(innerHeight * dpr);
  const g = c.createRadialGradient(cj.width / 2, cj.height / 2, 0, cj.width / 2, cj.height / 2, Math.max(cj.width, cj.height) * 0.7);
  g.addColorStop(0, '#3a0006'); g.addColorStop(1, '#000');
  c.fillStyle = g; c.fillRect(0, 0, cj.width, cj.height);
  const S = Math.min(cj.width, cj.height) * 1.15;
  c.save(); c.translate((cj.width - S) / 2, (cj.height - S) / 2 + S * 0.04);
  draw(c, S);
  c.restore();
  cj.classList.remove('show'); void cj.offsetWidth;
  cj.classList.add('show');
  Sound.play('scream');
  G.shake = 0.8;
  clearTimeout(jsTimer);
  jsTimer = setTimeout(() => cj.classList.remove('show'), 900);
}

// 血淚女的臉（依照草稿：亂亂的長黑髮、螺旋眼、血淚、裂得很寬的大嘴）
// 畫在 S×S 的範圍裡；3D 貼圖和驚嚇畫面共用
function drawWomanFace(c, S) {
  let sd = 20260928;
  const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  c.save();
  c.scale(S / 512, S / 512);
  c.lineCap = 'round'; c.lineJoin = 'round';
  // 後面的一大團黑髮
  c.fillStyle = '#121014';
  c.beginPath();
  c.moveTo(256, 30);
  c.bezierCurveTo(88, 26, 38, 170, 42, 330);
  c.bezierCurveTo(44, 420, 58, 480, 68, 512);
  c.lineTo(444, 512);
  c.bezierCurveTo(454, 480, 468, 420, 470, 330);
  c.bezierCurveTo(474, 170, 424, 26, 256, 30);
  c.fill();
  for (let i = 0; i < 160; i++) {
    const side = i % 2 ? 1 : -1;
    const sx = 256 + side * r() * 120, sy = 36 + r() * 40;
    const ex = 256 + side * (140 + r() * 88), ey = 300 + r() * 212;
    const gg = 38 + r() * 50 | 0;
    c.strokeStyle = `rgba(${gg},${gg - 4},${gg + 6},${0.45 + r() * 0.4})`;
    c.lineWidth = 1.5 + r() * 2.5;
    c.beginPath(); c.moveTo(sx, sy);
    c.bezierCurveTo(sx + side * (60 + r() * 60), sy + 20, ex + side * r() * 30, ey - 200, ex + (r() - 0.5) * 30, ey);
    c.stroke();
  }
  // 臉
  const fg = c.createRadialGradient(256, 290, 40, 256, 300, 190);
  fg.addColorStop(0, '#ece6dc'); fg.addColorStop(0.75, '#d6cec3'); fg.addColorStop(1, '#a89e94');
  c.fillStyle = fg;
  c.beginPath(); c.ellipse(256, 300, 150, 178, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(70,64,60,.8)'; c.lineWidth = 2.5; c.stroke();
  // 眼睛：紅色眼眶、布滿血絲、螺旋眼珠
  const eyePath = (ex, ey) => {
    c.beginPath();
    c.moveTo(ex - 50, ey + 2);
    c.quadraticCurveTo(ex, ey - 44, ex + 50, ey + 2);
    c.quadraticCurveTo(ex, ey + 36, ex - 50, ey + 2);
    c.closePath();
  };
  for (const ex of [192, 320]) {
    const ey = 256;
    c.fillStyle = 'rgba(60,30,40,.28)'; c.beginPath(); c.ellipse(ex, ey + 6, 60, 44, 0, 0, 7); c.fill();
    eyePath(ex, ey); c.fillStyle = '#f4efe6'; c.fill();
    c.strokeStyle = 'rgba(190,30,40,.6)'; c.lineWidth = 1.3;
    for (let k = 0; k < 6; k++) {
      const sg = k % 2 ? 1 : -1;
      c.beginPath(); c.moveTo(ex + sg * 46, ey + (r() - 0.5) * 10); c.lineTo(ex + sg * (30 + r() * 8), ey + (r() - 0.5) * 16); c.stroke();
    }
    c.fillStyle = '#b9b6b2'; c.beginPath(); c.arc(ex, ey, 25, 0, 7); c.fill();
    c.strokeStyle = '#3d3a3a'; c.lineWidth = 2.6;
    c.beginPath();
    for (let a = 0; a < Math.PI * 7; a += 0.1) {
      const rr = 3 + a, px = ex + Math.cos(a) * rr, py = ey + Math.sin(a) * rr;
      if (a === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.stroke();
    c.fillStyle = '#111'; c.beginPath(); c.arc(ex, ey, 4, 0, 7); c.fill();
    c.strokeStyle = '#a3261f'; c.lineWidth = 4.5; eyePath(ex, ey); c.stroke();
    c.lineWidth = 3; c.beginPath(); c.moveTo(ex - 44, ey - 16); c.quadraticCurveTo(ex, ey - 56, ex + 46, ey - 14); c.stroke();
  }
  // 大嘴：兩排波浪狀的牙齦和牙齒
  const mx0 = 146, mx1 = 366, my0 = 352, my1 = 450, rad = [36, 36, 50, 50];
  c.beginPath(); c.roundRect(mx0, my0, mx1 - mx0, my1 - my0, rad);
  c.fillStyle = '#3a0508'; c.fill();
  c.save(); c.clip();
  c.fillStyle = '#c24a58';
  c.beginPath(); c.moveTo(mx0, my0);
  for (let x = mx0; x <= mx1; x += 8) c.lineTo(x, my0 + 22 + Math.sin(x * 0.18) * 5);
  c.lineTo(mx1, my0); c.closePath(); c.fill();
  c.strokeStyle = '#7a5a4c'; c.lineWidth = 1.5;
  for (let x = mx0 + 6; x < mx1 - 6; x += 17) {
    const top = my0 + 19 + Math.sin(x * 0.18) * 5;
    c.fillStyle = '#eee5d6';
    c.beginPath(); c.moveTo(x, top); c.lineTo(x + 15, top); c.lineTo(x + 13, top + 20 + r() * 6); c.quadraticCurveTo(x + 7.5, top + 30, x + 2, top + 20); c.closePath(); c.fill(); c.stroke();
  }
  c.fillStyle = '#c24a58';
  c.beginPath(); c.moveTo(mx0, my1);
  for (let x = mx0; x <= mx1; x += 8) c.lineTo(x, my1 - 20 + Math.sin(x * 0.18 + 1.5) * 5);
  c.lineTo(mx1, my1); c.closePath(); c.fill();
  for (let x = mx0 + 14; x < mx1 - 10; x += 17) {
    const bot = my1 - 17 + Math.sin(x * 0.18 + 1.5) * 5;
    c.fillStyle = '#e6dccb';
    c.beginPath(); c.moveTo(x, bot); c.lineTo(x + 14, bot); c.lineTo(x + 12, bot - 18 - r() * 6); c.quadraticCurveTo(x + 7, bot - 26, x + 2, bot - 18); c.closePath(); c.fill(); c.stroke();
  }
  c.restore();
  c.strokeStyle = '#b3121b'; c.lineWidth = 6;
  c.beginPath(); c.roundRect(mx0, my0, mx1 - mx0, my1 - my0, rad); c.stroke();
  c.lineWidth = 4; c.beginPath(); c.moveTo(mx0 - 12, my0 + 2); c.quadraticCurveTo(256, my0 - 16, mx1 + 12, my0 + 2); c.stroke();
  // 血淚（從眼睛一路流過嘴巴）與嘴角的血
  c.strokeStyle = '#9e0f18'; c.fillStyle = '#9e0f18';
  for (const [x0, y0, len] of [[168, 280, 190], [208, 282, 130], [298, 282, 205], [340, 280, 120]]) {
    c.lineWidth = 6;
    c.beginPath(); c.moveTo(x0, y0);
    c.bezierCurveTo(x0 + 4, y0 + len * 0.3, x0 - 4, y0 + len * 0.7, x0 + 2, y0 + len);
    c.stroke();
    c.beginPath(); c.ellipse(x0 + 2, y0 + len + 5, 6, 9, 0, 0, 7); c.fill();
  }
  for (const [x, len] of [[mx0 + 8, 60], [mx1 - 8, 48]]) {
    c.lineWidth = 5; c.beginPath(); c.moveTo(x, my1 - 6); c.lineTo(x + 2, my1 + len); c.stroke();
    c.beginPath(); c.ellipse(x + 2, my1 + len + 4, 5, 8, 0, 0, 7); c.fill();
  }
  // 瀏海與垂在臉旁的髮絲
  for (let i = 0; i < 80; i++) {
    const x = 118 + r() * 276;
    const end = 165 + r() * 42 * (1 - Math.abs(x - 256) / 260);
    const gg = 18 + r() * 40 | 0;
    c.strokeStyle = `rgba(${gg},${gg - 2},${gg + 4},${0.7 + r() * 0.3})`;
    c.lineWidth = 2 + r() * 3.5;
    c.beginPath(); c.moveTo(x + (r() - 0.5) * 20, 60 + r() * 30);
    c.quadraticCurveTo(x + (r() - 0.5) * 30, 140, x + (r() - 0.5) * 24, end);
    c.stroke();
  }
  for (const side of [-1, 1]) for (let i = 0; i < 30; i++) {
    const x = 256 + side * (112 + r() * 44);
    const gg = 18 + r() * 36 | 0;
    c.strokeStyle = `rgba(${gg},${gg - 2},${gg + 4},${0.75 + r() * 0.25})`;
    c.lineWidth = 2 + r() * 3;
    c.beginPath(); c.moveTo(x - side * 10, 110 + r() * 40);
    c.bezierCurveTo(x + side * 14, 260, x - side * 12, 380, x + side * (r() * 24), 470 + r() * 42);
    c.stroke();
  }
  c.restore();
}

// ====================================================================
// 第二批怪物（依照草稿設計）：火柴人、眼球花、爬行女、鳥腳女、小丑
// ====================================================================
const MAX_FLOWERS = 6;
const HOP_DUR = 0.32;
const TV_FLOOR = { x: 15, y: 16.5 };            // 電視前面的地板
const tvEmergeTime = () => Math.max(8, 18 - diffN() * 0.25);
const newFlower = (x, y) => initHp({ x, y, watch: 0, burn: 0, alarm: 0, sees: false, grow: 0 }, 'flower');

function playerNoise() { return Math.max(G.p.noise || 0, G.p.noiseBurst || 0); }
function makeNoise(r) { if (G) G.p.noiseBurst = Math.max(G.p.noiseBurst || 0, r); }
function findSpawnNear(cx, cy, rMin, rMax) {
  for (let i = 0; i < 60; i++) {
    const a = Math.random() * Math.PI * 2, d = rand(rMin, rMax);
    const x = Math.floor(cx + Math.cos(a) * d), y = Math.floor(cy + Math.sin(a) * d);
    if (!inMap(x, y) || isSolid(x, y) || tiles[y][x] !== 1) continue;
    if (flow && flow[y][x] === Infinity) continue;
    return { x: x + 0.5, y: y + 0.5 };
  }
  return null;
}

// ---------- 火柴人：會穿牆，被手電筒照到會燒起來 ----------
function updateStick(e, dt) {
  const p = G.p, n = diffN();
  const dx = p.x - e.x, dy = p.y - e.y, d = Math.hypot(dx, dy) || 0.001;
  if (inBeam(e)) {
    e.burn = Math.min(1.4, e.burn + dt);
    if (Math.random() < dt * 30) G.fx.push({ type: 'ember', x: e.x + rand(-0.2, 0.2), y: e.y + rand(-0.2, 0.2), h: rand(0.2, 1.7), vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vh: rand(0.6, 1.4), life: rand(0.5, 1), max: 1, color: pick([[255, 200, 60], [255, 120, 30], [255, 80, 20]]) });
    flashHurt(e, dt);
    if (e.dead) return;
  } else e.burn = Math.max(0, e.burn - dt * 0.3);
  const sp = Math.min(1.1 + n * 0.008, 1.8) * (e.spawn > 0 ? 0.3 : 1) * (e.burn > 0 ? 0.5 : 1);
  e.x = clamp(e.x + dx / d * sp * dt, 0.5, MAP_W - 0.5);
  e.y = clamp(e.y + dy / d * sp * dt, 0.5, MAP_H - 0.5);
  e.whistleT -= dt;
  if (e.whistleT <= 0 && d < 12) { Sound.play('whistle', nearVol(d)); e.whistleT = rand(5, 8); }
  if (d < 0.6 && e.spawn <= 0 && p.inv <= 0) {
    damage(12 + n * 0.1, 20); p.inv = 1;
    e.dead = true; puff(e.x, e.y);
    toast('✏️ 火柴人笑著抱住了你……', 'warn');
  }
}

// ---------- 眼球花：長在屋子裡不會動，盯著你 3 秒就尖叫、把黑影叫過來 ----------
function spawnFlower() {
  if (G.flowers.length >= MAX_FLOWERS) return false;
  if (!flow) computeFlow();
  for (let i = 0; i < 80; i++) {
    const r = pick(ROOMS);
    const x = r.x + Math.floor(Math.random() * r.w), y = r.y + Math.floor(Math.random() * r.h);
    if (isSolid(x, y) || flow[y][x] === Infinity || flow[y][x] < 5) continue;
    if ([...G.sockets, ...G.lamps].some(o => o.x === x && o.y === y)) continue;
    if (G.flowers.some(f => Math.hypot(f.x - x - 0.5, f.y - y - 0.5) < 2)) continue;
    G.flowers.push(newFlower(x + 0.5, y + 0.5));
    return true;
  }
  return false;
}
function updateFlowers(dt) {
  const p = G.p, night = G.phase === 'night';
  let watching = 0;
  for (const f of G.flowers) {
    f.grow = Math.min(1, f.grow + dt * 0.5);
    f.alarm = Math.max(0, f.alarm - dt);
    f.sees = false;
    if (!night || f.grow < 1) { f.watch = 0; continue; }
    const d = Math.hypot(f.x - p.x, f.y - p.y);
    if (d < 7 && inBeam(f)) {
      f.burn = Math.min(1.5, f.burn + dt);
      flashHurt(f, dt);
      if (f.dead) continue;
    } else f.burn = Math.max(0, f.burn - dt * 0.5);
    f.sees = d < 9 && castRay(f.x, f.y, Math.atan2(p.y - f.y, p.x - f.x), d) >= d - 0.05;
    if (f.sees) {
      watching++;
      f.watch += dt;
      if (f.watch >= 3) { flowerAlarm(f, d); f.watch = -5; }
    } else f.watch = f.watch < 0 ? Math.min(0, f.watch + dt) : Math.max(0, f.watch - dt);
  }
  if (watching) p.san -= Math.min(watching, 2) * 1.5 * dt;
  G.flowers = G.flowers.filter(f => !f.dead);
}
function flowerAlarm(f, d) {
  f.alarm = 1.5;
  G.ev.alarm = 6;
  Sound.play('shriek', nearVol(d));
  const pos = findSpawnNear(G.p.x, G.p.y, 4, 8);
  if (pos) { const e = spawnEnemy('shadow', pos); if (e) e.spawn = 0.6; }
  toast('👁️ 眼球花盯著你尖叫！黑影朝你衝過來了！', 'warn');
}
function pullFlower(f) {
  const i = G.flowers.indexOf(f);
  if (i < 0) return;
  G.flowers.splice(i, 1);
  puff(f.x, f.y, [70, 110, 60], 10, 0.8);
  Sound.play('pickup');
  makeNoise(3);
  toast('🌼 你把眼球花連根拔掉了。', 'good');
}

// ---------- 爬行女：電視自己打開，不關掉她就會從螢幕爬出來 ----------
function tvOff() {
  G.ev.tvOn = false; G.ev.tvT = 0;
  Sound.play('click');
  const c = G.enemies.find(e => e.kind === 'crawler');
  if (c) { c.dead = true; puff(c.x, c.y, [20, 20, 30], 14, 0.4); toast('📺 你關掉了電視，她被吸回螢幕裡了！', 'good'); }
  else toast('📺 你把電視關掉了。', 'good');
}
function updateTV(dt) {
  const ev = G.ev;
  if (!ev.tvOn) return;
  ev.tvT += dt;
  if (!G.enemies.some(e => e.kind === 'crawler') && ev.tvT >= tvEmergeTime()) {
    const e = spawnEnemy('crawler', { x: TV_FLOOR.x, y: TV_FLOOR.y });
    if (e) {
      e.emerge = 2.2; e.spawn = 0;
      Sound.play('sob', 0.6);
      toast('📺 有東西從電視裡爬出來了！快去把電視關掉！', 'warn');
    }
  }
}
function updateCrawler(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  if (e.emerge > 0) { e.emerge -= dt; return; }
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pauseT > 0) e.pauseT -= dt; // 一頓一頓地爬
  else {
    const sp = Math.min(2.5 + n * 0.012, 3.4) * (inBeam(e) ? 0.45 : 1);
    const dir = chaseDir(e);
    move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    if (Math.random() < dt * 1.2) e.pauseT = rand(0.1, 0.35);
  }
  e.crawlT -= dt;
  if (e.crawlT <= 0 && d < 10) { Sound.play('crawl', nearVol(d)); e.crawlT = rand(0.35, 0.6); }
  if (d < 0.7 && p.inv <= 0) {
    jumpscare(drawCrawlerFace);
    damage(25 + n * 0.15, 20); p.inv = 1.5;
    toast('📺 爬行女抓住了你的腳！她又爬回電視裡了……', 'warn');
    e.dead = true; G.ev.tvT = 0;
  }
}

// ---------- 鳥腳女：眼睛不好，靠聲音找人；一跳一跳地追；手電筒照眼鏡會暫時看不見 ----------
function setMomoTarget(e, x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (e.ftx !== tx || e.fty !== ty) { e.ftx = tx; e.fty = ty; e.flow = computeFlowFrom(tx, ty); }
  e.tx = x; e.ty = y;
}
function pickWander(e) {
  for (let i = 0; i < 20; i++) {
    const x = Math.floor(e.x + rand(-6, 6)), y = Math.floor(e.y + rand(-6, 6));
    if (inMap(x, y) && !isSolid(x, y) && tiles[y][x] === 1) { setMomoTarget(e, x + 0.5, y + 0.5); e.lost = 0; return; }
  }
  setMomoTarget(e, e.x, e.y);
}
function updateMomo(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.stun = Math.max(0, e.stun - dt); e.stunCd = Math.max(0, e.stunCd - dt);
  const beam = d < 8 && inBeam(e);
  if (beam) { flashHurt(e, dt); if (e.dead) return; }
  if (e.stunCd <= 0 && beam) {
    e.stun = 2.5; e.stunCd = 6; e.hopping = 0; e.air = 0;
    Sound.play('cackle', nearVol(d) * 0.6);
    if (!G.ev.momoStunTip) { G.ev.momoStunTip = 1; toast('🐦 手電筒照到她的眼鏡反光，她暫時看不見了！', 'good'); }
  }
  if (e.cd <= 0 && e.stun <= 0 && d <= playerNoise()) {
    if (e.state !== 'hunt') Sound.play('cackle', nearVol(d));
    e.state = 'hunt'; e.lost = 0;
    setMomoTarget(e, p.x, p.y);
  }
  if (e.stun > 0 || e.cd > 0) { e.air = 0; return; }
  if (e.hopping > 0) {
    e.hopping -= dt;
    e.air = Math.sin(Math.PI * (1 - Math.max(0, e.hopping) / HOP_DUR));
    const dist = e.state === 'hunt' ? 2.6 : 0.9;
    // 跳的途中也沿著路線轉彎，才不會在門口衝過頭撞牆
    const dir = pathDir(e, e.flow, e.tx, e.ty, 0);
    if (Math.hypot(e.tx - e.x, e.ty - e.y) > 0.3) move(e, dir.x * dist / HOP_DUR * dt, dir.y * dist / HOP_DUR * dt, ENEMY_R);
    if (e.hopping <= 0) { e.air = 0; Sound.play('hop', nearVol(d)); e.hopT = e.state === 'hunt' ? 0.45 : 1.3; }
  } else {
    e.hopT -= dt;
    if (Math.hypot(e.tx - e.x, e.ty - e.y) < 0.7) {
      // 到了卻沒再聽到聲音：四處張望，然後隨便走走
      e.lost += dt;
      if (e.lost > 2.5) { e.state = 'idle'; pickWander(e); }
    } else if (e.hopT <= 0) e.hopping = HOP_DUR;
  }
  if (d < 0.8 && p.inv <= 0 && e.spawn <= 0) {
    damage(30 + n * 0.15, 15); p.inv = 1.2;
    Sound.play('cackle');
    toast('🐦 鳥腳女抓到你了！她咯咯笑著跳走了……', 'warn');
    const pos = findSpawn(12);
    puff(e.x, e.y, [30, 25, 30], 10, 1);
    if (pos) { e.x = pos.x; e.y = pos.y; }
    e.cd = 8; e.state = 'idle'; e.spawn = 1; e.hopping = 0; e.air = 0;
    pickWander(e);
  }
}

// ---------- 小丑：先飄來一顆紅氣球；氣球碰到你，小丑就出現在你背後 ----------
function updateBalloon(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  if (d < 9 && inBeam(e)) {
    e.burn = Math.min(1, e.burn + dt);
    flashHurt(e, dt);
    if (e.dead) return;
  } else e.burn = Math.max(0, e.burn - dt * 0.5);
  const sp = Math.min(0.9 + n * 0.006, 1.5) * (e.spawn > 0 ? 0.3 : 1);
  const dir = chaseDir(e);
  move(e, dir.x * sp * dt, dir.y * sp * dt, 0.2);
  e.squeakT -= dt;
  if (e.squeakT <= 0 && d < 10) { Sound.play('laugh', nearVol(d) * 0.5); e.squeakT = rand(6, 10); }
  if (d < 0.8 && e.spawn <= 0) { e.dead = true; Sound.play('pop'); clownAppears(); }
}
function clownAppears() {
  const p = G.p;
  let pos = null;
  for (const dist of [1.8, 1.4, 1.0]) {
    const x = p.x - Math.cos(p.face) * dist, y = p.y - Math.sin(p.face) * dist;
    if (!hits(x, y, ENEMY_R)) { pos = { x, y }; break; }
  }
  if (!pos) pos = findSpawnNear(p.x, p.y, 1, 3) || { x: p.x - Math.cos(p.face) * 0.9, y: p.y - Math.sin(p.face) * 0.9 };
  const e = spawnEnemy('clown', pos);
  if (!e) return;
  e.spawn = 0.5;
  Sound.play('laugh');
  toast('🤡 氣球破了……有人站在你背後！快跑，或用手電筒打他！', 'warn');
}
function updateClown(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.chase -= dt;
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.chase <= 0) {
    e.dead = true; puff(e.x, e.y, [30, 20, 30], 14, 1);
    Sound.play('laugh', nearVol(d) * 0.7);
    toast('🤡 小丑笑著消失在黑暗裡……');
    return;
  }
  const sp = Math.min(3.3 + n * 0.01, 4.2) * (e.spawn > 0 ? 0.3 : 1);
  const dir = chaseDir(e);
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  e.laughT -= dt;
  if (e.laughT <= 0) { Sound.play('laugh', nearVol(d)); e.laughT = rand(2, 3.5); }
  if (d < 0.7 && e.spawn <= 0 && p.inv <= 0) {
    jumpscare(drawClownFace);
    damage(35 + n * 0.15, 15); p.inv = 1.5;
    Sound.play('stab');
    toast('🤡 小丑的刀劃過你的手臂！', 'warn');
    e.dead = true;
  }
}

// 每種特殊怪物自己的行為
const SPECIAL_AI = {
  woman: (e, dt) => updateWoman(e, dt), blob: (e, dt) => updateBlob(e, dt), stick: updateStick,
  momo: updateMomo, crawler: updateCrawler, balloon: updateBalloon, clown: updateClown,
};

// ====================================================================
// 怪物的臉（2D 畫法；3D 貼圖、驚嚇畫面、怪物圖鑑共用）
// ====================================================================
function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

// 火柴人：白色圓臉、紅色直線眼睛、紅色笑臉
function drawStickFace(c, S) {
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round';
  c.fillStyle = '#f2efe8'; c.beginPath(); c.arc(256, 256, 236, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#2a2a2a'; c.lineWidth = 14; c.stroke();
  c.lineWidth = 5; c.beginPath(); c.arc(256, 256, 206, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = '#d0201e'; c.lineWidth = 24;
  c.beginPath(); c.moveTo(190, 150); c.lineTo(194, 234); c.moveTo(322, 150); c.lineTo(318, 234); c.stroke();
  c.lineWidth = 26; c.beginPath(); c.moveTo(126, 292); c.quadraticCurveTo(256, 440, 392, 282); c.stroke();
  c.restore();
}
// 鳥腳女：直直的長黑髮、方框眼鏡後面凸出的大眼睛、長鼻子、裂到兩頰的 V 字嘴
function drawMomoFace(c, S) {
  const r = seeded(777);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  c.fillStyle = '#111013';
  c.beginPath(); c.moveTo(256, 36);
  c.bezierCurveTo(120, 36, 92, 120, 92, 220); c.lineTo(84, 512); c.lineTo(428, 512); c.lineTo(420, 220);
  c.bezierCurveTo(420, 120, 392, 36, 256, 36); c.fill();
  for (let i = 0; i < 90; i++) {
    const x = 96 + r() * 320, g = 30 + r() * 40 | 0;
    c.strokeStyle = `rgba(${g},${g - 3},${g + 5},.7)`; c.lineWidth = 1.5 + r() * 2;
    c.beginPath(); c.moveTo(256 + (x - 256) * 0.5, 44 + Math.abs(x - 256) * 0.25);
    c.quadraticCurveTo(x, 200, x + (x - 256) * 0.05, 512); c.stroke();
  }
  const fg = c.createRadialGradient(256, 270, 30, 256, 290, 190);
  fg.addColorStop(0, '#ebe3d6'); fg.addColorStop(0.8, '#d4cabb'); fg.addColorStop(1, '#a99f92');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 290, 122, 172, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(70,64,60,.7)'; c.lineWidth = 2.5; c.stroke();
  for (let i = 0; i < 60; i++) {
    const sd = i % 2 ? 1 : -1, x0 = 256 + sd * r() * 12, x1 = 256 + sd * (40 + r() * 100), g = 20 + r() * 35 | 0;
    c.strokeStyle = `rgba(${g},${g - 2},${g + 4},.9)`; c.lineWidth = 2 + r() * 3;
    c.beginPath(); c.moveTo(x0, 60); c.quadraticCurveTo(x1 - sd * 10, 110, x1, 150 + r() * 60); c.stroke();
  }
  for (const ex of [204, 308]) {
    const ey = 236;
    c.fillStyle = 'rgba(80,50,50,.35)'; c.beginPath(); c.ellipse(ex, ey, 40, 34, 0, 0, 7); c.fill();
    c.fillStyle = '#f6f1e8'; c.beginPath(); c.arc(ex, ey, 29, 0, 7); c.fill();
    c.strokeStyle = 'rgba(190,40,40,.55)'; c.lineWidth = 1.3;
    for (let k = 0; k < 7; k++) { const a = r() * Math.PI * 2; c.beginPath(); c.moveTo(ex + Math.cos(a) * 28, ey + Math.sin(a) * 28); c.lineTo(ex + Math.cos(a) * 17, ey + Math.sin(a) * 17); c.stroke(); }
    c.fillStyle = '#2a2420'; c.beginPath(); c.arc(ex + 2, ey + 1, 13, 0, 7); c.fill();
    c.fillStyle = '#000'; c.beginPath(); c.arc(ex + 2, ey + 1, 6, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(ex - 4, ey - 6, 3.5, 0, 7); c.fill();
  }
  c.strokeStyle = '#141414'; c.lineWidth = 9;
  for (const ex of [204, 308]) { c.beginPath(); c.roundRect(ex - 46, 204, 92, 64, 10); c.stroke(); }
  c.lineWidth = 7; c.beginPath(); c.moveTo(250, 232); c.quadraticCurveTo(256, 224, 262, 232);
  c.moveTo(158, 226); c.lineTo(134, 220); c.moveTo(354, 226); c.lineTo(378, 220); c.stroke();
  c.strokeStyle = 'rgba(90,70,60,.8)'; c.lineWidth = 4;
  c.beginPath(); c.moveTo(252, 262); c.lineTo(246, 340); c.quadraticCurveTo(256, 352, 270, 340); c.stroke();
  c.fillStyle = '#b3121b';
  c.beginPath(); c.moveTo(124, 294); c.quadraticCurveTo(200, 362, 256, 414); c.quadraticCurveTo(312, 362, 388, 294);
  c.quadraticCurveTo(312, 348, 256, 390); c.quadraticCurveTo(200, 348, 124, 294); c.fill();
  c.strokeStyle = '#5a0508'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(130, 298); c.quadraticCurveTo(200, 356, 256, 402); c.quadraticCurveTo(312, 356, 382, 298); c.stroke();
  c.restore();
}
// 爬行女：灰藍色的臉被長髮蓋住，只露出一隻眼睛和紅色的嘴
function drawCrawlerFace(c, S) {
  const r = seeded(4321);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round';
  const fg = c.createRadialGradient(270, 250, 30, 256, 270, 200);
  fg.addColorStop(0, '#a3afb8'); fg.addColorStop(0.8, '#7e8b95'); fg.addColorStop(1, '#56626c');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 270, 140, 175, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = 'rgba(20,20,30,.55)'; c.beginPath(); c.ellipse(304, 232, 46, 30, 0.1, 0, 7); c.fill();
  c.fillStyle = '#ecebe6'; c.beginPath(); c.ellipse(304, 232, 30, 17, 0.1, 0, 7); c.fill();
  c.strokeStyle = 'rgba(180,40,40,.6)'; c.lineWidth = 1.2;
  for (let k = 0; k < 5; k++) { c.beginPath(); c.moveTo(278 + r() * 6, 226 + r() * 12); c.lineTo(290 + r() * 4, 230 + r() * 6); c.stroke(); }
  c.fillStyle = '#111'; c.beginPath(); c.arc(300, 232, 7, 0, 7); c.fill();
  c.fillStyle = '#2a0406'; c.beginPath(); c.ellipse(272, 366, 44, 20, -0.08, 0, 7); c.fill();
  c.strokeStyle = '#b01520'; c.lineWidth = 7; c.beginPath(); c.ellipse(272, 366, 46, 22, -0.08, 0, 7); c.stroke();
  c.save();
  c.beginPath(); c.rect(0, 0, 512, 512);
  c.ellipse(304, 232, 40, 26, 0.1, 0, Math.PI * 2);
  c.ellipse(272, 366, 54, 30, -0.08, 0, Math.PI * 2);
  c.clip('evenodd');
  for (let i = 0; i < 230; i++) {
    const x = 60 + r() * 392, g = 14 + r() * 30 | 0;
    c.strokeStyle = `rgba(${g},${g - 2},${g + 4},${0.75 + r() * 0.25})`; c.lineWidth = 2 + r() * 3.5;
    c.beginPath(); c.moveTo(256 + (x - 256) * 0.4, 26 + r() * 20);
    c.bezierCurveTo(x + (r() - 0.5) * 40, 180, x + (r() - 0.5) * 40, 340, x + (r() - 0.5) * 30, 512);
    c.stroke();
  }
  c.restore();
  c.strokeStyle = 'rgba(15,14,18,.85)'; c.lineWidth = 2;
  for (let i = 0; i < 7; i++) { const x = 250 + r() * 90; c.beginPath(); c.moveTo(x, 150); c.bezierCurveTo(x + 10, 260, x - 10, 330, x + 6, 512); c.stroke(); }
  c.restore();
}
// 小丑：白色的臉、歪戴的小禮帽、紅色眼妝、張得大大的紅嘴、脖子上的皺摺領
function drawClownFace(c, S) {
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  const fg = c.createRadialGradient(256, 280, 40, 256, 300, 190);
  fg.addColorStop(0, '#f7f3ec'); fg.addColorStop(0.8, '#e2dcd2'); fg.addColorStop(1, '#bdb5aa');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 300, 150, 170, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(80,70,65,.7)'; c.lineWidth = 3; c.stroke();
  c.save(); c.translate(296, 124); c.rotate(0.18);
  c.fillStyle = '#1b1a1d'; c.beginPath(); c.ellipse(0, 22, 90, 20, 0, 0, 7); c.fill();
  c.fillRect(-52, -72, 104, 94);
  c.save(); c.beginPath(); c.rect(-52, -72, 104, 94); c.clip();
  c.strokeStyle = 'rgba(110,110,118,.55)'; c.lineWidth = 3;
  for (let x = -150; x < 60; x += 14) { c.beginPath(); c.moveTo(x, 22); c.lineTo(x + 100, -72); c.stroke(); }
  c.restore();
  c.restore();
  for (const ex of [198, 314]) {
    const ey = 258;
    c.fillStyle = '#c8141e';
    c.beginPath(); c.moveTo(ex, ey - 58); c.lineTo(ex + 17, ey); c.lineTo(ex, ey + 64); c.lineTo(ex - 17, ey); c.closePath(); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.ellipse(ex, ey, 27, 18, 0, 0, 7); c.fill();
    c.strokeStyle = '#c8141e'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#120808'; c.beginPath(); c.arc(ex, ey + 2, 10, 0, 7); c.fill();
    c.strokeStyle = '#1b1a1d'; c.lineWidth = 4; c.beginPath(); c.moveTo(ex - 30, ey - 36); c.quadraticCurveTo(ex, ey - 64, ex + 30, ey - 38); c.stroke();
  }
  c.fillStyle = '#c8141e';
  c.beginPath(); c.moveTo(146, 358); c.quadraticCurveTo(256, 326, 366, 358); c.quadraticCurveTo(352, 474, 256, 480); c.quadraticCurveTo(160, 474, 146, 358); c.fill();
  c.fillStyle = '#2a0306';
  c.beginPath(); c.moveTo(174, 372); c.quadraticCurveTo(256, 350, 338, 372); c.quadraticCurveTo(324, 452, 256, 456); c.quadraticCurveTo(188, 452, 174, 372); c.fill();
  c.fillStyle = '#efe8da';
  for (let x = 190; x < 320; x += 19) { const y = 364 + Math.pow((x + 9 - 256) / 80, 2) * 8; c.fillRect(x, y, 15, 17); }
  c.fillStyle = '#8a1e2a'; c.beginPath(); c.ellipse(256, 440, 44, 15, 0, 0, 7); c.fill();
  c.fillStyle = '#ece8e0'; c.strokeStyle = 'rgba(90,85,80,.8)'; c.lineWidth = 2.5;
  for (let i = 0; i < 9; i++) { c.beginPath(); c.ellipse(96 + i * 40, 504, 26, 18, 0, 0, 7); c.fill(); c.stroke(); }
  c.restore();
}

// ====================================================================
// 怪物圖鑑
// ====================================================================
function thumbShadow(eye, crouch) {
  return (c, S) => {
    c.save(); c.scale(S / 200, S / 200);
    c.fillStyle = '#050307';
    c.beginPath(); c.ellipse(100, crouch ? 145 : 125, 44, crouch ? 42 : 66, 0, 0, 7); c.fill();
    c.beginPath(); c.arc(100, crouch ? 96 : 56, 27, 0, 7); c.fill();
    c.shadowColor = eye; c.shadowBlur = 14; c.fillStyle = eye;
    for (const x of [90, 110]) { c.beginPath(); c.arc(x, crouch ? 96 : 56, 4.5, 0, 7); c.fill(); }
    c.restore();
  };
}
function thumbTall(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.fillStyle = '#050307'; c.strokeStyle = '#050307'; c.lineCap = 'round';
  c.beginPath(); c.ellipse(100, 110, 16, 62, 0, 0, 7); c.fill();
  c.beginPath(); c.ellipse(100, 36, 13, 17, 0, 0, 7); c.fill();
  c.lineWidth = 6; c.beginPath(); c.moveTo(88, 62); c.quadraticCurveTo(66, 120, 72, 190); c.moveTo(112, 62); c.quadraticCurveTo(134, 120, 128, 190);
  c.moveTo(94, 160); c.lineTo(92, 198); c.moveTo(106, 160); c.lineTo(108, 198); c.stroke();
  c.shadowColor = '#ff2030'; c.shadowBlur = 12; c.fillStyle = '#ff2030';
  for (const x of [94, 106]) { c.beginPath(); c.arc(x, 36, 3.5, 0, 7); c.fill(); }
  c.restore();
}
function thumbBlob(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.fillStyle = '#0b0a0d';
  c.beginPath();
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.2) { const rr = 70 + Math.sin(a * 3 + 1) * 7 + Math.sin(a * 5) * 4; c.lineTo(100 + Math.cos(a) * rr, 105 + Math.sin(a) * rr * 0.9); }
  c.closePath(); c.fill();
  c.save(); c.clip();
  c.strokeStyle = 'rgba(80,76,86,.8)'; c.lineWidth = 2;
  c.beginPath();
  for (let y = 30; y < 190; y += 12) { c.moveTo(20, y); for (let x = 20; x < 180; x += 12) { c.lineTo(x + 6, y - 14); c.lineTo(x + 12, y); } }
  c.stroke();
  c.restore();
  c.strokeStyle = '#ff5a46'; c.fillStyle = '#ff4030'; c.lineWidth = 2.5;
  for (const x of [86, 112]) { c.beginPath(); c.arc(x, 100, 8, 0, 7); c.stroke(); c.beginPath(); c.arc(x, 100, 3.5, 0, 7); c.fill(); }
  c.restore();
}
function thumbStick(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.strokeStyle = '#e8e4dc'; c.lineWidth = 4; c.lineCap = 'round';
  c.beginPath();
  c.moveTo(100, 80); c.lineTo(100, 140); c.lineTo(78, 192); c.moveTo(100, 140); c.lineTo(124, 192);
  c.moveTo(100, 96); c.lineTo(58, 100); c.moveTo(100, 96); c.lineTo(134, 88); c.lineTo(142, 50);
  c.stroke();
  c.translate(76, 12); drawStickFace(c, 48);
  c.restore();
}
function thumbFlower(c, S) {
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  c.strokeStyle = '#4f8a4a'; c.lineWidth = 5; c.beginPath(); c.moveTo(100, 196); c.quadraticCurveTo(108, 140, 100, 92); c.stroke();
  c.fillStyle = '#9fd4a8'; c.strokeStyle = '#3f8f5a'; c.lineWidth = 2;
  for (const s of [-1, 1]) { c.beginPath(); c.ellipse(100 + s * 34, 138, 34, 12, s * -0.45, 0, 7); c.fill(); c.stroke(); }
  c.fillStyle = '#f6efe8'; c.beginPath(); c.arc(100, 58, 44, 0, 7); c.fill();
  c.strokeStyle = '#b3303a'; c.lineWidth = 1.5;
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; c.beginPath(); c.moveTo(100 + Math.cos(a) * 12, 58 + Math.sin(a) * 12); c.quadraticCurveTo(100 + Math.cos(a + 0.3) * 28, 58 + Math.sin(a + 0.3) * 28, 100 + Math.cos(a) * 42, 58 + Math.sin(a) * 42); c.stroke(); }
  c.fillStyle = '#6b6560'; c.beginPath(); c.arc(100, 58, 12, 0, 7); c.fill();
  c.strokeStyle = '#1a1614'; c.lineWidth = 1.5; c.beginPath();
  for (let a = 0; a < Math.PI * 5; a += 0.2) { const rr = 1 + a * 0.6; c.lineTo(100 + Math.cos(a) * rr, 58 + Math.sin(a) * rr); }
  c.stroke();
  c.restore();
}
function thumbClown(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.strokeStyle = '#ccc'; c.lineWidth = 1; c.beginPath(); c.moveTo(168, 150); c.lineTo(160, 70); c.stroke();
  c.fillStyle = '#d4101e'; c.beginPath(); c.ellipse(166, 44, 24, 30, 0.15, 0, 7); c.fill();
  c.translate(-8, 16); drawClownFace(c, 180);
  c.restore();
}
const BESTIARY = [
  { name: '黑影', night: 1, draw: thumbShadow('#ff3344'), desc: '到處追你，燈光也擋不住牠。手電筒照著牠會一直扣血，血扣光就消失。' },
  { name: '衣櫃怪', night: 2, draw: thumbShadow('#ffd23a', true), desc: '衣櫃晃動時沒去按住 E 壓住門，就會衝出來，速度很快。' },
  { name: '黑球', night: 3, draw: thumbBlob, desc: '不追你，專門去吃燈，每吃一次燈泡降一級，特殊燈泡會直接被吃掉。用手電筒把牠的血扣光。' },
  { name: '血淚女', night: 4, draw: drawWomanFace, desc: '你看著她，她就不會動；但一直盯著她，理智會快速下降。手電筒可以扣她的血，但你得一直看著她。' },
  { name: '它', night: 5, draw: thumbTall, desc: '高大又非常耐打，手電筒對它只有一半效果。最好靠天使和火球幫忙。' },
  { name: '火柴人', night: 6, draw: thumbStick, desc: '會穿牆，一邊吹口哨一邊朝你揮手走過來。紙做的身體被手電筒照到就會燒起來。' },
  { name: '眼球花', night: 7, draw: thumbFlower, desc: '長在屋子裡、白天也不會消失。被它盯 3 秒它就會尖叫，把黑影叫過來。用手電筒照它，或走過去按住 E 拔掉。' },
  { name: '爬行女', night: 8, draw: drawCrawlerFace, desc: '客廳的電視自己打開後，不快點關掉，她就會從螢幕裡爬出來。關掉電視或把她打倒都可以。' },
  { name: '鳥腳女', night: 9, draw: drawMomoFace, desc: '眼睛不好，靠聲音找你，一跳一跳地追過來。別奔跑，輕輕推搖桿慢慢走。手電筒照到她的眼鏡會讓她暫時看不見，也會扣血。' },
  { name: '小丑', night: 10, draw: thumbClown, desc: '先會飄來一顆紅氣球，用手電筒把它照破。讓氣球碰到你，小丑就會拿著刀出現在你背後，快跑或用手電筒打他！' },
];
let bookBuilt = false, bookFrom = 'title';
function openBook(from) {
  bookFrom = from;
  $(from).classList.add('hidden');
  $('book').classList.remove('hidden');
  if (bookBuilt) return;
  bookBuilt = true;
  const list = $('bookList');
  for (const m of BESTIARY) {
    const card = document.createElement('div');
    card.className = 'card';
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = 176;
    m.draw(cvs.getContext('2d'), 176);
    const info = document.createElement('div');
    info.innerHTML = `<h4>${m.name}<span class="night">第 ${m.night} 夜起</span></h4><p>${m.desc}</p>`;
    card.append(cvs, info);
    list.appendChild(card);
  }
}

// ====================================================================
// 12 夜版的難度：越後面越難（第 12 夜大約是原本的第 30 夜）
// ====================================================================
const diffN = () => G.day * 2.5;
const randi = (a, b) => Math.floor(rand(a, b + 1));
const fixtures = () => [...G.sockets, ...G.lamps];

// ====================================================================
// 特殊燈泡：粘液燈泡（讓怪物變慢）、天使燈泡（飛出去打怪物）
// ====================================================================
const SLIME_R = 3.2;
function slimeFactor(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inMap(tx, ty)) return 1;
  const rooms = roomGrid[ty][tx] ? [roomGrid[ty][tx]] : doorGrid[ty][tx] ? doorGrid[ty][tx].rooms : [];
  for (const o of fixtures()) {
    if (o.bulb !== SLIME_TIER || !rooms.includes(o.room)) continue;
    if (Math.hypot(o.x + 0.5 - x, o.y + 0.5 - y) < SLIME_R) return 0.4;
  }
  return 1;
}

const ANGEL_RANGE = 6;
const angels = new Map(); // 燈具 → 住在裡面的天使
function angelHome(o) { const b = bulbPos(o); return { x: b.x, y: b.y, h: b.h - 0.05 }; }
const targetAlive = t => !t.dead && (t.kind ? G.enemies.includes(t) : G.flowers.includes(t));
function targetH(t) {
  if (!t.kind) return 1.28;
  return { tall: 2.2, blob: t.h || 0.4, balloon: 1.75, crawler: 0.5 }[t.kind] || 1.3;
}
// 找範圍內最近、而且看得到的怪物（天使和火球共用）
function findTarget(x, y, range, skip) {
  let best = null, bd = range;
  for (const t of [...G.enemies, ...G.flowers]) {
    if (t.dead || (skip && skip.has(t)) || t.emerge > 0 || (!t.kind && t.grow < 1)) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d >= bd || castRay(x, y, Math.atan2(t.y - y, t.x - x), d) < d - 0.05) continue;
    bd = d; best = t;
  }
  return best;
}
function findAngelTarget(o, a) {
  const home = angelHome(o);
  const taken = new Set([...angels.values()].filter(x => x !== a && x.target).map(x => x.target));
  return findTarget(home.x, home.y, ANGEL_RANGE, taken);
}
function updateAngels(dt) {
  const seen = new Set();
  for (const o of fixtures()) {
    if (o.bulb !== ANGEL_TIER) continue;
    seen.add(o);
    const home = angelHome(o);
    let a = angels.get(o);
    if (!a) { a = { x: home.x, y: home.y, h: home.h, state: 'home', cd: 0, t: Math.random() * 6, target: null, smite: 0 }; angels.set(o, a); }
    a.t += dt; a.cd = Math.max(0, a.cd - dt);
    const fly = (tx, ty, th, sp) => {
      const dx = tx - a.x, dy = ty - a.y, dh = th - a.h, d = Math.hypot(dx, dy, dh);
      if (d < 1e-3) return 0;
      const s = Math.min(d, sp * dt);
      a.x += dx / d * s; a.y += dy / d * s; a.h += dh / d * s;
      return d - s;
    };
    if (a.state === 'home') {
      fly(home.x + Math.cos(a.t * 1.5) * 0.35, home.y + Math.sin(a.t * 1.5) * 0.35, home.h + Math.sin(a.t * 2) * 0.08, 2);
      if (G.phase === 'night' && a.cd <= 0) {
        const tg = findAngelTarget(o, a);
        if (tg) { a.target = tg; a.state = 'fly'; Sound.play('angel', nearVol(Math.hypot(a.x - G.p.x, a.y - G.p.y))); }
      }
    } else if (a.state === 'fly' || a.state === 'smite') {
      const tg = a.target;
      if (!targetAlive(tg)) { a.state = 'back'; a.target = null; }
      else if (a.state === 'fly') { if (fly(tg.x, tg.y, targetH(tg), 7) < 0.45) { a.state = 'smite'; a.smite = 0; } }
      else {
        fly(tg.x, tg.y, targetH(tg), 7);
        a.smite += dt;
        if (Math.random() < dt * 40) G.fx.push({ type: 'spark', x: tg.x + rand(-0.3, 0.3), y: tg.y + rand(-0.3, 0.3), h: targetH(tg) + rand(-0.4, 0.4), vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5), vh: rand(-0.2, 0.8), life: 0.6, max: 0.6, color: [255, 230, 150] });
        if (a.smite >= 0.7) { angelSmite(tg, a); a.state = 'back'; a.target = null; a.cd = 3; }
      }
    } else if (fly(home.x, home.y, home.h, 5) < 0.1) a.state = 'home';
  }
  for (const o of [...angels.keys()]) if (!seen.has(o)) angels.delete(o);
}
const ANGEL_DMG = 2.5;
function angelSmite(t, a) {
  const h = targetH(t);
  for (let i = 0; i < 16; i++) {
    const r = Math.random() * Math.PI * 2, s = rand(0.5, 2);
    G.fx.push({ type: 'spark', x: t.x, y: t.y, h, vx: Math.cos(r) * s, vy: Math.sin(r) * s, vh: rand(-0.5, 1.5), life: rand(0.4, 0.9), max: 0.9, color: [255, 225, 140] });
  }
  Sound.play('smite');
  hurtMonster(t, ANGEL_DMG);
  // 大怪物沒被打倒的話會被撞開
  if (!t.dead && t.kind && BOSSES.includes(t.kind)) {
    const r = Math.atan2(t.y - a.y, t.x - a.x);
    move(t, Math.cos(r) * 1.5, Math.sin(r) * 1.5, ENEMY_R);
  }
  if (!G.ev.angelTip) { G.ev.angelTip = 1; toast('😇 天使飛出去打怪物了！', 'good'); }
}

// ====================================================================
// 火焰燈泡：射出火球攻擊怪物（停電也會）
// ====================================================================
const FIRE_RANGE = 7, FIRE_CD = 1.6, FIRE_SPEED = 8, FIRE_DMG = 1.2;
const EMBER_COLORS = [[255, 200, 60], [255, 120, 30], [255, 80, 20]];
function updateFireLamps(dt) {
  if (G.phase !== 'night') return;
  for (const o of fixtures()) {
    if (o.bulb !== FIRE_TIER) continue;
    o.fireCd = Math.max(0, (o.fireCd || 0) - dt);
    if (o.fireCd > 0) continue;
    const from = bulbPos(o), tg = findTarget(from.x, from.y, FIRE_RANGE);
    if (!tg) continue;
    o.fireCd = FIRE_CD;
    G.fireballs.push({ x: from.x, y: from.y, h: from.h, target: tg, life: 3 });
    Sound.play('fireball', nearVol(Math.hypot(from.x - G.p.x, from.y - G.p.y)));
    if (!G.ev.fireTip) { G.ev.fireTip = 1; toast('🔥 火焰燈泡射出火球攻擊怪物！', 'good'); }
  }
}
function updateFireballs(dt) {
  for (const f of G.fireballs) {
    f.life -= dt;
    const t = f.target;
    if (!targetAlive(t) || f.life <= 0) { f.dead = true; continue; }
    const dx = t.x - f.x, dy = t.y - f.y, dh = targetH(t) - f.h, d = Math.hypot(dx, dy, dh);
    if (d < 0.35) {
      f.dead = true;
      hurtMonster(t, FIRE_DMG);
      Sound.play('fireHit', nearVol(Math.hypot(f.x - G.p.x, f.y - G.p.y)));
      for (let i = 0; i < 14; i++) {
        const r = Math.random() * Math.PI * 2, s = rand(0.5, 2.2);
        G.fx.push({ type: 'ember', x: f.x, y: f.y, h: f.h, vx: Math.cos(r) * s, vy: Math.sin(r) * s, vh: rand(-0.5, 1.5), life: rand(0.3, 0.7), max: 0.7, color: pick(EMBER_COLORS) });
      }
      continue;
    }
    const step = Math.min(d, FIRE_SPEED * dt);
    f.x += dx / d * step; f.y += dy / d * step; f.h += dh / d * step;
    if (Math.random() < dt * 30) G.fx.push({ type: 'ember', x: f.x, y: f.y, h: f.h, vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vh: rand(0, 0.4), life: rand(0.2, 0.45), max: 0.45, color: [255, 150, 40] });
  }
  G.fireballs = G.fireballs.filter(f => !f.dead);
}

// ====================================================================
// 硬幣、怪物掉寶
// ====================================================================
function addCoins(n) { G.coins = (G.coins || 0) + n; }
function onKill(e) {
  if (G.nightStats) G.nightStats.kills++;
  dropLoot(e.x, e.y, e.lv || 1);
}
function dropLoot(x, y, lv = 1) {
  if (Math.random() > Math.min(0.4, 0.18 + 0.03 * lv)) return;
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inMap(tx, ty) || isSolid(tx, ty)) return;
  const r = Math.random();
  let id = 'coin', n = 1 + Math.floor(lv / 3);
  if (r > 0.62) {
    n = 1;
    if (r < 0.74) id = 'battery';
    else if (r < 0.84) id = pick(['snack', 'canned', 'cocoa']);
    else if (r < 0.97) id = 'bulb' + Math.min(NORMAL_MAX, rollTier(1 + lv * 0.3, G.day));
    else id = 'key';
  }
  G.pickups.push({ x, y, id, n, t: Math.random() * 6 });
}
function updatePickups(dt) {
  const p = G.p;
  for (const pk of G.pickups) {
    pk.t += dt;
    pk.age = (pk.age || 0) + dt;
    if (pk.age > 120) { pk.got = true; continue; } // 放太久沒撿就消失
    if (Math.hypot(pk.x - p.x, pk.y - p.y) > 0.75) continue;
    pk.got = true;
    if (pk.id === 'coin') addCoins(pk.n); else addItem(pk.id, pk.n);
    Sound.play('pickup');
    toast(`撿到了${ITEMS[pk.id].name}${pk.n > 1 ? ' ×' + pk.n : ''}`, 'item');
  }
  G.pickups = G.pickups.filter(pk => !pk.got);
  const tr = G.treasure;
  if (tr && Math.hypot(tr.x - p.x, tr.y - p.y) < 0.8) { G.treasure = null; openTreasure(); }
}

// ====================================================================
// 每天早上：禮物、尋寶星星、商人進貨、送貨員
// ====================================================================
function prepareDay() {
  const ev = G.ev;
  if (G.day > 1) makeGift();
  hideTreasure();
  makeStock();
  ev.deliveryAt = G.day === 1 || Math.random() < 0.35 ? rand(20, DAY_LEN - 50) : -1;
  ev.delivery = 0;
}
function makeGift() {
  const k = G.nightStats || { kills: 0, caught: 0 };
  const score = Math.min(3, Math.floor(k.kills / 3)) + (k.caught === 0 ? 2 : k.caught <= 2 ? 1 : 0); // 0～5
  const items = [[pick(['battery', 'cocoa', 'canned', 'medkit']), 1]];
  for (let i = 0, nb = score >= 4 ? 2 : score >= 2 ? 1 : 0; i < nb; i++) items.push(['bulb' + Math.min(NORMAL_MAX, rollTier(1 + score * 0.5, G.day)), 1]);
  if (score >= 4 && Math.random() < 0.4) items.push(['key', 1]);
  if (score >= 5 && Math.random() < 0.3) items.push(['bulb' + pick([ANGEL_TIER, SLIME_TIER]), 1]);
  G.gift = { items, coins: 1 + score, kills: k.kills, caught: k.caught };
}
function openGift() {
  const g = G.gift;
  if (!g) return;
  G.gift = null;
  for (const [id, n] of g.items) addItem(id, n);
  addCoins(g.coins);
  Sound.play('win');
  showReward('🎁 早晨禮物', `昨晚你消滅了 ${g.kills} 隻怪物、被抓到 ${g.caught} 次。表現越好，禮物越好！`, [...g.items, ['coin', g.coins]]);
}
function hideTreasure() {
  G.treasure = null;
  for (let i = 0; i < 100; i++) {
    const r = pick(ROOMS.filter(r => r.id !== 'living'));
    const x = r.x + Math.floor(Math.random() * r.w), y = r.y + Math.floor(Math.random() * r.h);
    if (isSolid(x, y) || tiles[y][x] !== 1 || fixtures().some(o => o.x === x && o.y === y)) continue;
    G.treasure = { x: x + 0.5, y: y + 0.5, room: r.name };
    return;
  }
}
function openTreasure() {
  const coins = randi(3, 6);
  const b = Math.random() < 0.3 ? 'key' : 'bulb' + Math.min(NORMAL_MAX, rollTier(2, G.day) + 1);
  addCoins(coins); addItem(b);
  Sound.play('win');
  showReward('⭐ 找到今天的寶藏星星了！', '', [[b, 1], ['coin', coins]]);
}
function makeStock() {
  const d = G.day;
  const tiers = [...new Set([Math.min(FIRE_TIER, rollTier(1, d) + 1), Math.min(NORMAL_MAX, rollTier(2, d) + 2), pick([ANGEL_TIER, SLIME_TIER, STAR_TIER])])];
  G.stock = [
    ...tiers.map(t => ({ id: 'bulb' + t, price: BULB_PRICE[t], qty: 1 })),
    { id: 'lamp_floor', price: 5, qty: 1 }, { id: 'lamp_desk', price: 3, qty: 1 },
    { id: 'battery', price: 2, qty: 2 }, { id: 'key', price: 8, qty: 1 },
    { id: 'medkit', price: 6, qty: 1 }, { id: 'cocoa', price: 3, qty: 1 },
  ];
}
const merchantHere = () => !!G && G.phase === 'day' && G.t < DAY_LEN - DUSK;
function updateDelivery(dt) {
  const ev = G.ev;
  if (G.phase !== 'day') return;
  if (ev.deliveryAt > 0 && G.t >= ev.deliveryAt) {
    ev.deliveryAt = -1; ev.delivery = 30; ev.dTick = 0;
    toast('📦 有人在敲前門……是送貨員！白天可以放心開門。', 'good');
  }
  if (ev.delivery > 0) {
    ev.delivery -= dt; ev.dTick -= dt;
    if (ev.dTick <= 0) { Sound.play('knock', 0.6); ev.dTick = 4; }
    if (ev.delivery <= 0) toast('送貨員等不到人，走掉了。');
  }
}
function takeDelivery() {
  const ev = G.ev;
  ev.delivery = 0;
  const pool = ['bulb' + Math.min(NORMAL_MAX, rollTier(1, G.day) + 1), 'battery', 'canned', 'candle', 'lamp_desk', 'cocoa'];
  const items = [[pool[0], 1], [pick(pool.slice(1)), 1]];
  const coins = randi(2, 4);
  for (const [id, n] of items) addItem(id, n);
  addCoins(coins);
  Sound.play('pickup');
  showReward('📦 送貨員的包裹', '門口放著一個寫著你名字的包裹……', [...items, ['coin', coins]]);
}

// ====================================================================
// 工作台、扭蛋機、神秘商人、寶箱
// ====================================================================
function craftRecipes() {
  const list = [];
  for (let t = 1; t < NORMAL_MAX; t++) list.push({ need: ['bulb' + t, 3], out: 'bulb' + (t + 1) });
  list.push({ need: ['lamp_desk', 2], out: 'lamp_floor' }, { need: ['lamp_floor', 2], out: 'lamp_chand' });
  return list;
}
function openCraft() {
  openModal('🔧 工作台', () => {
    const rows = craftRecipes().map((r, i) => {
      const [id, n] = r.need, have = G.inv[id] || 0, ok = have >= n;
      return `<div class="row${ok ? ' ok' : ''}"><span class="ic">${itemIcon(id)}</span><span class="txt">${ITEMS[id].name} ×${n}<small>你有 ${have} 個</small></span>` +
        `<span class="arrow">→</span><span class="ic">${itemIcon(r.out)}</span><span class="txt">${ITEMS[r.out].name}</span>` +
        `<button data-act="craft:${i}" ${ok ? '' : 'disabled'}>合成</button></div>`;
    }).join('');
    return `<p class="hint">3 顆一樣的燈泡可以合成 1 顆高一級的；3 顆火焰燈泡可以合成星空燈泡！</p><div class="rows">${rows}</div>`;
  }, act => {
    const r = craftRecipes()[+act.split(':')[1]];
    if (!r || (G.inv[r.need[0]] || 0) < r.need[1]) return;
    removeItem(r.need[0], r.need[1]);
    addItem(r.out);
    Sound.play('install');
    toast(`🔧 合成了${ITEMS[r.out].name}！`, 'good');
  });
}
const GACHA_PRICE = 3;
const GACHA_TABLE = {
  bulb1: 8, bulb2: 10, bulb3: 12, bulb4: 11, bulb5: 10, bulb6: 8, bulb7: 7, bulb8: 6, bulb9: 5, bulb10: 4,
  bulb11: 2.5, bulb12: 3, bulb13: 3, lamp_floor: 4, lamp_chand: 1.5, key: 2, coin5: 3,
};
function openGacha() {
  let last = null;
  openModal('🎰 扭蛋機', () => {
    const res = last
      ? `<div class="gacha${last.rare ? ' rare' : ''}"><div class="ic big">${itemIcon(last.id)}</div><div class="nm">轉到了：${ITEMS[last.id].name}${last.n > 1 ? ' ×' + last.n : ''}！</div></div>`
      : `<div class="gacha"><div class="ic big">🎰</div><div class="nm">投 ${GACHA_PRICE} 枚硬幣轉一次，看看會轉出什麼！</div></div>`;
    return res + `<div class="btns"><button data-act="spin" ${G.coins >= GACHA_PRICE ? '' : 'disabled'}>🪙 ${GACHA_PRICE} 轉一次</button></div>`;
  }, act => {
    if (act !== 'spin' || G.coins < GACHA_PRICE) return;
    G.coins -= GACHA_PRICE;
    const k = weighted(GACHA_TABLE);
    if (k === 'coin5') { addCoins(5); last = { id: 'coin', n: 5 }; }
    else { addItem(k); last = { id: k, n: 1, rare: (ITEMS[k].tier || 0) >= 9 || k === 'lamp_chand' }; }
    Sound.play(last.rare ? 'win' : 'pickup');
  });
}
function openShop() {
  openModal('🛒 神秘商人', () => {
    const cards = G.stock.map((s, i) => {
      const it = ITEMS[s.id], can = s.qty > 0 && G.coins >= s.price;
      return `<div class="shopcard${s.qty > 0 ? '' : ' sold'}"><div class="ic">${itemIcon(s.id)}</div><div class="nm">${it.name}</div>` +
        `<div class="ds">${it.desc}</div><button data-act="buy:${i}" ${can ? '' : 'disabled'}>${s.qty > 0 ? `🪙 ${s.price}` : '賣完了'}</button></div>`;
    }).join('');
    return `<p class="hint">「嘿嘿……要買點好東西嗎？天黑之前我就會離開。」</p><div class="shop">${cards}</div>`;
  }, act => {
    const s = G.stock[+act.split(':')[1]];
    if (!s || s.qty <= 0 || G.coins < s.price) return;
    G.coins -= s.price; s.qty--;
    addItem(s.id);
    Sound.play('pickup');
  });
}
function openChest(f) {
  if (G.chests[f.id] || !G.inv.key) return;
  removeItem('key');
  G.chests[f.id] = true;
  const b = Math.random() < 0.6 ? pick([STAR_TIER, ANGEL_TIER, SLIME_TIER]) : Math.min(NORMAL_MAX, Math.max(8, rollTier(3, G.day) + 2));
  const items = [['bulb' + b, 1]];
  if (Math.random() < 0.35) items.push(['lamp_chand', 1]);
  const coins = randi(6, 10);
  for (const [id, n] of items) addItem(id, n);
  addCoins(coins);
  Sound.play('win');
  showReward('🗝️ 寶箱打開了！', '', [...items, ['coin', coins]]);
}

// ====================================================================
// 視窗（工作台、商人、扭蛋、獎勵共用）
// ====================================================================
let modalRender = null, modalAct = null;
function openModal(title, render, onAct, closeLabel = '離開') {
  if (document.pointerLockElement) document.exitPointerLock();
  for (const k in keys) keys[k] = false;
  mode = 'modal';
  modalRender = render; modalAct = onAct;
  $('mTitle').textContent = title;
  $('mClose').textContent = closeLabel;
  refreshModal();
  $('modal').classList.remove('hidden');
}
function refreshModal() {
  $('mBody').innerHTML = modalRender();
  $('mCoins').textContent = G.coins || 0;
}
function closeModal() {
  $('modal').classList.add('hidden');
  mode = 'play';
  invDirty = true;
  lockPointer();
}
function showReward(title, sub, items) {
  const merged = {};
  for (const [id, n] of items) merged[id] = (merged[id] || 0) + n;
  openModal(title, () => (sub ? `<p class="hint">${sub}</p>` : '') + '<div class="reward">' +
    Object.entries(merged).map(([id, n]) => `<div class="rw"><div class="ic">${itemIcon(id)}</div><div class="nm">${ITEMS[id].name}${n > 1 ? ' ×' + n : ''}</div></div>`).join('') +
    '</div>', null, '太好了！');
}

function updateSpawns(dt) {
  if (G.phase !== 'night') return;
  const n = diffN(), ev = G.ev;
  const mult = ev.blood ? 1.5 : 1;
  const maxS = Math.round((G.day === 1 ? 4 : Math.min(5 + Math.floor(n / 2.5), 24)) * mult);
  const interval = Math.max(1.4, 6 - n * 0.12) / mult / (G.power ? 1 : 1.4);
  G.spawnT -= dt;
  if (G.spawnT <= 0) {
    G.spawnT = interval * rand(0.7, 1.3);
    if (G.enemies.filter(e => e.kind === 'shadow' || e.kind === 'fast').length < maxS) spawnEnemy('shadow');
  }
}

// ====================================================================
// 日夜與事件
// ====================================================================
function startNight() {
  const night = G.day, n = diffN(), ev = G.ev; // night：第幾夜（決定新怪物登場）；n：難度
  G.phase = 'night'; G.t = 0; G.spawnT = 5;
  G.nightStats = { kills: 0, caught: 0 };
  if (G.treasure) { G.treasure = null; toast('⭐ 今天的寶藏星星消失了……明天再找吧。'); }
  ev.schedule = []; ev.blood = night % 6 === 0; // 第 6 夜和最後一夜是血月
  const add = (type, a, b) => ev.schedule.push({ type, at: rand(a, b) });
  if (night === 1) add('knock', 40, 60);
  else if (Math.random() < 0.8) add('knock', 15, NIGHT_LEN - 25);
  if (night === 2) add('blackout', 40, 60);
  else if (night > 2 && Math.random() < Math.min(0.45 + n * 0.015, 0.9)) add('blackout', 20, NIGHT_LEN - 30);
  if (n >= 12 && Math.random() < Math.min(0.2 + (n - 12) * 0.01, 0.55)) add('blackout', 40, NIGHT_LEN - 20);
  if (night >= 2 && Math.random() < 0.75) add('closet', 20, NIGHT_LEN - 35);
  if (Math.random() < 0.5) add('phone', 10, NIGHT_LEN - 20);
  if (night >= 5 && (ev.blood || Math.random() < Math.min(0.3 + n * 0.01, 0.9))) add('tall', 15, 60);
  // 黑球：第 3 夜第一次出現，之後越來越多
  if (night === 3) add('blob', 30, 50);
  else if (night > 3) {
    const k = 1 + (n >= 12) + (n >= 24);
    for (let i = 0; i < k; i++) if (Math.random() < Math.min(0.5 + n * 0.012, 0.9) * (ev.blood ? 1.3 : 1)) add('blob', 15, NIGHT_LEN - 40);
  }
  // 血淚女：第 4 夜第一次出現
  if (night === 4) add('woman', 25, 45);
  else if (night > 4 && (ev.blood || Math.random() < Math.min(0.45 + n * 0.01, 0.85))) add('woman', 20, 90);
  // 第二批怪物：第 6～10 夜每晚介紹一隻新的
  if (night === 6) add('stick', 20, 40);
  else if (night > 6) { for (let i = 0, k = 1 + (n >= 18); i < k; i++) if (Math.random() < Math.min(0.45 + n * 0.01, 0.85)) add('stick', 15, NIGHT_LEN - 30); }
  if (night === 7) add('flower', 5, 15);
  else if (night > 7 && Math.random() < 0.7) add('flower', 5, 60);
  if (night === 8) add('tv', 30, 50);
  else if (night > 8 && Math.random() < Math.min(0.45 + n * 0.01, 0.85)) add('tv', 20, NIGHT_LEN - 40);
  if (night === 9) add('momo', 25, 45);
  else if (night > 9 && Math.random() < Math.min(0.45 + n * 0.01, 0.85)) add('momo', 15, 80);
  if (night === 10) add('clown', 30, 50);
  else if (night > 10 && Math.random() < Math.min(0.4 + n * 0.01, 0.8)) add('clown', 20, NIGHT_LEN - 40);
  if (night === LAST_NIGHT) showBig('最後一夜', '🩸 血月之夜：撐到天亮就贏了！');
  else showBig(`第 ${night} 夜`, ev.blood ? '🩸 血月之夜：怪物更多、等級更高' : '拿好手電筒');
  Sound.play('dusk');
  if (night === 1) toast('🌙 夜晚來了。燈光擋不住怪物，但待在亮處理智不會掉。按 F 開手電筒，照著怪物可以扣牠的血！', 'warn');
}
function startDay(d) {
  G.day = d; G.phase = 'day'; G.t = 0; G.power = true;
  for (const e of G.enemies) puff(e.x, e.y);
  G.enemies = []; G.ghosts = []; G.fireballs = [];
  Object.assign(G.ev, { knock: 0, phone: 0, closet: 0, bedTimer: 0, bedWarned: false, duskWarned: false, blood: false, schedule: [], merchantBye: 0 });
  for (const o of [...G.sockets, ...G.lamps]) { o.dying = 0; o.eaten = 0; }
  G.stare = 0;
  G.ev.tvOn = false; G.ev.tvT = 0; G.ev.alarm = 0;
  refillContainers();
  prepareDay();
  showBig(`第 ${d} 天`, d === LAST_NIGHT ? '今晚是最後一夜！' : `你撐過了第 ${d - 1} 夜，還剩 ${LAST_NIGHT - d + 1} 夜`);
  Sound.play('dawn');
  saveGame();
  toast('💾 已自動存檔，櫃子裡的物資也刷新了。', 'good');
  if (G.gift) toast('🎁 臥室床邊有一份早晨禮物！', 'good');
  if (G.treasure) toast(`⭐ 今天的寶藏星星藏在「${G.treasure.room}」，快去找！`, 'good');
}
function triggerEvent(type) {
  const ev = G.ev;
  switch (type) {
    case 'blackout':
      if (!G.power) return;
      G.power = false;
      Sound.play('powerDown');
      toast('⚡ 停電了！拿手電筒去洗衣間的電箱，按住 E 恢復電力。', 'warn');
      break;
    case 'knock':
      ev.knock = 20; ev.knockTick = 0;
      toast('🚪 有人在敲前門……晚上千萬不要開門。', 'warn');
      break;
    case 'closet':
      ev.closet = 18; ev.closetLight = 0; ev.closetTick = 0;
      toast('🚪 臥室的衣櫃在晃動……快去按住 E 壓住它！', 'warn');
      break;
    case 'phone':
      ev.phone = 15; ev.phoneTick = 0;
      toast('☎️ 客廳的電話響了。');
      break;
    case 'blob': {
      if (!spawnEnemy('blob')) break;
      Sound.play('plop');
      if (!ev.blobTip) { ev.blobTip = 1; toast('⚫ 一團黑球溜進了屋子……它會去吃燈泡的光！用手電筒照它才能消滅它。', 'warn'); }
      else toast('⚫ 又有黑球溜進屋子了。', 'warn');
      break;
    }
    case 'woman': {
      if (G.enemies.some(e => e.kind === 'woman') || !spawnEnemy('woman')) break;
      Sound.play('sob', 0.5);
      if (!ev.womanTip) { ev.womanTip = 1; toast('😢 你聽到女人的哭聲……她只會在你「沒看著她」的時候移動。', 'warn'); }
      else toast('😢 女人的哭聲又出現了……', 'warn');
      break;
    }
    case 'stick': {
      if (G.enemies.filter(e => e.kind === 'stick').length >= 2 || !spawnEnemy('stick')) break;
      Sound.play('whistle', 0.5);
      toast(ev.stickTip ? '✏️ 你聽到口哨聲……火柴人又來了。' : '✏️ 一個塗鴉火柴人從牆裡走出來了……它會穿牆、燈光擋不住，用手電筒把它燒掉！', 'warn');
      ev.stickTip = 1;
      break;
    }
    case 'flower': {
      let grown = 0;
      for (let i = 0, k = G.day === 7 ? 2 : 1 + (Math.random() < 0.4); i < k; i++) if (spawnFlower()) grown++;
      if (!grown) break;
      toast(ev.flowerTip ? `🌼 屋子裡又長出了 ${grown} 朵眼球花。` : '🌼 屋子裡長出了眼球花……被它盯 3 秒它就會尖叫！用手電筒照它，或走過去按住 E 拔掉。', 'warn');
      ev.flowerTip = 1;
      break;
    }
    case 'tv':
      if (ev.tvOn) break;
      ev.tvOn = true; ev.tvT = 0;
      Sound.play('tvOn');
      toast(ev.tvTip ? '📺 客廳的電視又自己打開了……' : '📺 客廳的電視自己打開了……快去把它關掉，不然會有東西爬出來！', 'warn');
      ev.tvTip = 1;
      break;
    case 'momo': {
      if (G.enemies.some(e => e.kind === 'momo')) break;
      const e = spawnEnemy('momo');
      if (!e) break;
      pickWander(e);
      Sound.play('cackle', 0.5);
      toast(ev.momoTip ? '🐦 咯咯咯……鳥腳女又來了。' : '🐦 鳥腳女跳進了屋子……她靠聲音找人，別奔跑！輕輕推搖桿就能安靜地走。', 'warn');
      ev.momoTip = 1;
      break;
    }
    case 'clown':
      if (G.enemies.some(e => e.kind === 'balloon' || e.kind === 'clown') || !spawnEnemy('balloon')) break;
      Sound.play('laugh', 0.4);
      toast(ev.clownTip ? '🎈 又有一顆紅氣球飄進來了……' : '🎈 一顆紅氣球飄進了屋子……用手電筒把它照破！千萬別讓它碰到你。', 'warn');
      ev.clownTip = 1;
      break;
    case 'tall':
      if (spawnEnemy('tall')) {
        Sound.play('tall');
        toast('👁️ 有個高大的東西進了屋子……只有 LED（第 3 級）以上的燈擋得住它。', 'warn');
      }
      break;
  }
}
function updateTime(dt) {
  G.t += dt;
  const ev = G.ev;
  if (G.phase === 'day') {
    if (G.day === 1) {
      if (G.t > 3 && !ev.tip1) { ev.tip1 = 1; toast('👉 走到櫃子、箱子旁邊按住 E 搜索，找燈泡！'); }
      if (G.t > 18 && !ev.tip2) { ev.tip2 = 1; toast('👉 選中燈泡，走到圓形的天花板燈座旁按 Q 安裝。'); }
      if (G.t > 36 && !ev.tip3) { ev.tip3 = 1; toast('👉 檯燈可以按 Q 放在地上，再裝上燈泡。燈泡等級越高照越遠。'); }
      if (G.t > 55 && !ev.tip4) { ev.tip4 = 1; toast('🪙 搜索會找到硬幣：地下室的神秘商人會賣東西，車庫有扭蛋機，儲藏室有工作台。'); }
      if (G.t > 75 && !ev.tip5 && G.treasure) { ev.tip5 = 1; toast(`⭐ 每天都有一顆寶藏星星藏在屋子裡，今天在「${G.treasure.room}」。`); }
    }
    updateDelivery(dt);
    if (!ev.merchantBye && G.t >= DAY_LEN - DUSK) { ev.merchantBye = 1; toast('🛒 神秘商人收攤離開了。'); }
    if (!ev.duskWarned && G.t >= DAY_LEN - DUSK) { ev.duskWarned = true; toast('🌆 天快黑了！準備好燈光。', 'warn'); }
    if (G.t >= DAY_LEN) startNight();
  } else {
    for (const s of ev.schedule) if (!s.done && G.t >= s.at) { s.done = true; triggerEvent(s.type); }
    if (G.t >= NIGHT_LEN) {
      if (G.day >= LAST_NIGHT) victory();
      else startDay(G.day + 1);
    }
  }
}
function updateEvents(dt) {
  const ev = G.ev, p = G.p, n = G.day;
  if (G.phase !== 'night') return;
  ev.alarm = Math.max(0, ev.alarm - dt);
  updateTV(dt);
  if (ev.knock > 0) {
    ev.knock -= dt; ev.knockTick -= dt;
    if (ev.knockTick <= 0) { Sound.play('knock'); ev.knockTick = 2.6; G.shake = Math.max(G.shake, 0.08); }
  }
  if (ev.phone > 0) {
    ev.phone -= dt; ev.phoneTick -= dt;
    if (ev.phoneTick <= 0) { Sound.play('ring'); ev.phoneTick = 1.4; }
    if (ev.phone <= 0) toast('電話不響了。');
  }
  if (ev.closet > 0) {
    ev.closet -= dt; ev.closetTick -= dt;
    if (ev.closetTick <= 0) { Sound.play('thump'); ev.closetTick = Math.max(0.6, ev.closet / 12); }
    if (ev.closet < 0) {
      ev.closet = 0;
      const e = spawnEnemy('fast', { x: 30.5, y: 2.5 });
      if (e) e.spawn = 0.4;
      p.san -= 12;
      Sound.play('hurt');
      toast('衣櫃門猛然打開！有東西衝了出來！', 'warn');
    }
  }
  // 床底下
  if (n >= 2) {
    const bed = FURN_BY_ID.bed;
    ev.bedCd -= dt;
    const near = rectDist(p.x, p.y, bed) < 1.2;
    if (near && ev.bedCd <= 0) {
      ev.bedTimer += dt;
      if (ev.bedTimer > 0.5 && !ev.bedWarned) { ev.bedWarned = true; toast('床底下有東西在動……', 'warn'); }
      if (ev.bedTimer >= 1.2) {
        damage(20, 18); ev.bedTimer = 0; ev.bedCd = 20;
        toast('一隻手從床底下抓住了你的腳！', 'warn');
      }
    } else ev.bedTimer = Math.max(0, ev.bedTimer - dt);
  }
  // 低理智：幻覺與低語
  if (p.san < 35) {
    ev.ghostT -= dt;
    if (ev.ghostT <= 0) {
      ev.ghostT = rand(3, 7);
      const a = Math.random() * Math.PI * 2, d = rand(3.5, 6.5);
      const gx = p.x + Math.cos(a) * d, gy = p.y + Math.sin(a) * d;
      if (!isWall(Math.floor(gx), Math.floor(gy))) G.ghosts.push({ x: gx, y: gy, life: 4 });
    }
    ev.whisperT -= dt;
    if (ev.whisperT <= 0) { ev.whisperT = rand(6, 14); Sound.play('whisper'); }
  }
  for (const g of G.ghosts) { g.life -= dt; if (Math.hypot(g.x - p.x, g.y - p.y) < 2.5) g.life = Math.min(g.life, 0.3); }
  G.ghosts = G.ghosts.filter(g => g.life > 0);
}
function updateBulbs(dt) {
  if (G.phase !== 'night' || !G.power) return;
  for (const o of [...G.sockets, ...G.lamps]) {
    if (!o.bulb) continue;
    if (o.dying > 0) {
      o.dying -= dt;
      if (o.dying <= 0) {
        const name = BULBS[o.bulb].name;
        o.bulb = 0; o.dying = 0;
        Sound.play('pop');
        puff(o.x + 0.5, o.y + 0.5, [230, 230, 240], 8, bulbPos(o).h);
        toast(`💥 ${o.room.name}的${name}燒壞了！`, 'warn');
      }
      continue;
    }
    const rate = o.bulb === 1 ? 0.007 : o.bulb === 2 ? 0.0025 : 0;
    if (rate && Math.random() < rate * dt) o.dying = 1.5;
  }
}

// ====================================================================
// 玩家
// ====================================================================
function updatePlayer(dt) {
  const p = G.p;
  let fwd = 0, str = 0;
  if (keys.w || keys.arrowup) fwd += 1;
  if (keys.s || keys.arrowdown) fwd -= 1;
  if (keys.a) str -= 1;
  if (keys.d) str += 1;
  if (keys.arrowleft) p.face -= 2.4 * dt;
  if (keys.arrowright) p.face += 2.4 * dt;
  fwd -= joy.y; str += joy.x;
  const mag = Math.hypot(fwd, str);
  if (mag > 1) { fwd /= mag; str /= mag; }
  const moving = mag > 0.05;
  const sprint = (keys.shift || Math.hypot(joy.x, joy.y) > 0.92) && moving && p.stam > 1;
  const sneakKey = keys.c;
  const sp = (sprint ? 4.8 : 3.0) * (sneakKey && !sprint ? 0.45 : 1);
  if (sprint) p.stam -= 28 * dt; else p.stam = Math.min(100, p.stam + 16 * dt);
  const c = Math.cos(p.face), s = Math.sin(p.face);
  const mx = c * fwd - s * str, my = s * fwd + c * str;
  const ox = p.x, oy = p.y;
  move(p, mx * sp * dt, my * sp * dt, PLAYER_R);
  p.moved = Math.hypot(p.x - ox, p.y - oy);
  const spd = p.moved / Math.max(dt, 1e-4);
  p.noise = spd > 4 ? 12 : spd > 2.2 ? 5 : spd > 0.3 ? 1.5 : 0;
  p.noiseBurst = Math.max(0, (p.noiseBurst || 0) - dt * 12);

  if (flashOn()) {
    p.bat = Math.max(0, p.bat - 0.8 * dt);
    if (p.bat <= 0 && !p.batWarned) { p.batWarned = true; toast('🔦 手電筒沒電了！', 'warn'); }
  }
  if (p.bat > 0) p.batWarned = false;
  p.inv = Math.max(0, p.inv - dt);
  p.hurt = Math.max(0, p.hurt - dt * 2);

  // 狀態
  const n = diffN();
  p.hunger -= 0.18 * dt;
  if (p.hunger <= 0) { p.hunger = 0; p.hp -= 0.8 * dt; }
  const L = lightAt(p.x, p.y);
  if (G.phase === 'night') {
    if (L < 0.3) p.san -= (1.6 + n * 0.03) * (flashOn() ? 0.65 : 1) * (G.ev.blood ? 1.3 : 1) * dt;
    else p.san += 2 * L * dt;
  } else p.san += 1.2 * dt;
  if (p.san <= 0) { p.san = 0; p.hp -= 2 * dt; }
  if (p.hunger > 60 && p.san > 50) p.hp += 0.2 * dt;
  p.san = clamp(p.san, 0, 100); p.hp = Math.min(100, p.hp); p.hunger = Math.min(100, p.hunger);

  // 心跳聲
  if (p.san < 30 || p.hp < 30) {
    G.ev.beatT -= dt;
    if (G.ev.beatT <= 0) { Sound.play('heartbeat'); G.ev.beatT = p.hp < 20 || p.san < 15 ? 0.7 : 1.1; }
  }
  if (p.hp <= 0) gameOver();
}

// ====================================================================
// 互動
// ====================================================================
// 目標在面向的哪個角度（0 = 正前方）
function lookAngle(tx, ty) {
  let da = Math.atan2(ty - G.p.y, tx - G.p.x) - G.p.face;
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  return Math.abs(da);
}
function fixtureScore(o) {
  const p = G.p, d = Math.hypot(o.x + 0.5 - p.x, o.y + 0.5 - p.y);
  if (d > 1.7) return null;
  const a = lookAngle(o.x + 0.5, o.y + 0.5);
  if (a > 1.1 && d > 0.6) return null;
  return d + a * 0.9;
}
function nearestFixture() {
  let best = null, bs = Infinity;
  for (const o of [...G.sockets, ...G.lamps]) {
    const sc = fixtureScore(o);
    if (sc !== null && sc < bs) { bs = sc; best = o; }
  }
  return best;
}
function fixtureName(o) { return LAMP_TYPES[o.type].name; }

function getTarget() {
  const p = G.p, ev = G.ev;
  const cands = [];
  const fx = nearestFixture();
  if (fx) {
    const d = fixtureScore(fx) - 0.35;
    const sel = G.selId && ITEMS[G.selId].kind === 'bulb' ? ITEMS[G.selId] : null;
    const bulbTxt = fx.bulb ? BULBS[fx.bulb].name : '沒有燈泡';
    if (sel) cands.push({ d, id: 'fx', label: `安裝 ${sel.name}`, sub: `${fixtureName(fx)}：${bulbTxt}`, hold: 0, action: () => installBulb(fx, sel.tier) });
    else cands.push({ d, id: 'fx', label: `${fixtureName(fx)}：${bulbTxt}`, sub: fx.kind === 'lamp' ? '[R] 拿起燈具' : fx.bulb ? '[R] 拆下燈泡' : '選擇燈泡後按 E / Q 安裝' });
  }
  for (const f of FURN) {
    const rd = rectDist(p.x, p.y, f);
    if (rd > 1.15) continue;
    const nx = clamp(p.x, f.x, f.x + f.w), ny = clamp(p.y, f.y, f.y + f.h);
    const a = Math.min(lookAngle(nx, ny), lookAngle(f.x + f.w / 2, f.y + f.h / 2));
    if (a > 1.0 && rd > 0.35) continue;
    const d = rd + a * 0.9;
    if (f.id === 'tvcab' && ev.tvOn) cands.push({ d: d - 0.5, id: 'tvOff', label: '關掉電視', hold: 1, action: tvOff });
    else if (f.id === 'closet' && ev.closet > 0) cands.push({ d: d - 0.5, id: 'closetHold', label: '壓住衣櫃門', hold: 2, action: () => { ev.closet = 0; Sound.play('thump'); toast('你用力壓住衣櫃門……裡面安靜了。', 'good'); } });
    else if (f.loot) cands.push({ d, id: 'search:' + f.id, label: `搜索 ${f.name}`, hold: 0.7, action: () => search(f) });
    else if (f.type === 'phone' && ev.phone > 0) cands.push({ d: d - 0.5, id: 'phone', label: '接電話', hold: 0, action: answerPhone });
    else if (f.type === 'bed' && G.phase === 'day') {
      if (G.t < DAY_LEN - 25) cands.push({ d, id: 'bed', label: '睡到傍晚', sub: '按住 E', hold: 1.2, action: sleep });
    } else if (f.type === 'workbench') cands.push({ d, id: 'workbench', label: '使用工作台（合成燈泡）', hold: 0, action: openCraft });
    else if (f.type === 'gacha') cands.push({ d, id: 'gacha', label: `轉扭蛋（${GACHA_PRICE} 🪙 一次）`, hold: 0, action: openGacha });
    else if (f.type === 'tchest') {
      if (G.chests[f.id]) cands.push({ d, id: 'chestOpen', label: '寶箱：已經打開過了' });
      else if (G.inv.key) cands.push({ d: d - 0.3, id: 'chest:' + f.id, label: '用鑰匙打開寶箱', hold: 0.8, action: () => openChest(f) });
      else cands.push({ d, id: 'chestLocked', label: '上鎖的寶箱（需要鑰匙）' });
    } else if (f.type === 'breaker') {
      if (!G.power) cands.push({ d: d - 0.5, id: 'breaker', label: '重啟電源', hold: 3, action: restorePower });
      else cands.push({ d, id: 'breakerOk', label: '電箱：運作正常' });
    }
  }
  for (const fl of G.flowers) {
    const rd = Math.hypot(fl.x - p.x, fl.y - p.y);
    if (rd > 1.5) continue;
    const a = lookAngle(fl.x, fl.y);
    if (a > 1.0 && rd > 0.5) continue;
    cands.push({ d: rd - 0.3 + a * 0.9, id: 'flower', label: '拔掉眼球花', hold: 1.5, action: () => pullFlower(fl) });
  }
  if (merchantHere()) {
    const md = Math.hypot(MERCHANT_POS.x - p.x, MERCHANT_POS.y - p.y);
    if (md < 1.7 && (lookAngle(MERCHANT_POS.x, MERCHANT_POS.y) < 1.0 || md < 0.7)) cands.push({ d: md - 0.4, id: 'merchant', label: '跟神秘商人買東西', hold: 0, action: openShop });
  }
  if (G.gift) {
    const gd = Math.hypot(GIFT_POS.x - p.x, GIFT_POS.y - p.y);
    if (gd < 1.5 && (lookAngle(GIFT_POS.x, GIFT_POS.y) < 1.0 || gd < 0.6)) cands.push({ d: gd - 0.3, id: 'gift', label: '打開早晨禮物', hold: 0.6, action: openGift });
  }
  const fd = rectDist(p.x, p.y, { x: FRONT_DOOR.x, y: FRONT_DOOR.y, w: 1, h: 1 });
  if (fd < 1.15 && lookAngle(FRONT_DOOR.x + 0.5, FRONT_DOOR.y + 0.5) < 1.0) cands.push({ d: fd, id: 'front', label: '打開前門', hold: 0, action: openFrontDoor });
  cands.sort((a, b) => a.d - b.d);
  return cands[0] || null;
}
function interactPress() {
  const t = G.target;
  if (t && t.action && !t.hold) t.action();
}
function updateHold(dt) {
  const t = G.target;
  if (t && t.hold && keys.e && !G.holdLock) {
    if (G.holdId !== t.id) { G.holdId = t.id; G.holdProg = 0; }
    G.holdProg += dt;
    if (G.holdProg >= t.hold) { G.holdProg = 0; G.holdLock = true; t.action(); }
  } else { G.holdProg = 0; G.holdId = null; }
}
function restorePower() {
  G.power = true;
  Sound.play('breaker'); Sound.play('powerUp');
  toast('💡 電力恢復了！', 'good');
}
function sleep() {
  G.t = Math.max(G.t, DAY_LEN - 25);
  G.p.san = Math.min(100, G.p.san + 20);
  toast('你睡了一覺……醒來時天快黑了。', 'good');
}
function answerPhone() {
  G.ev.phone = 0;
  if (Math.random() < 0.4) {
    const f = pick(FURN.filter(f => f.loot));
    const tier = Math.min(NORMAL_MAX, rollTier(f.room.level, G.day) + 1);
    G.containers[f.id].items.push('bulb' + tier);
    Sound.play('dawn');
    toast(`☎️ 一個溫柔的聲音說：「${f.room.name}的${f.name}裡……有光。」`, 'good');
  } else {
    G.p.san -= 15;
    if (G.day >= 9 && !G.enemies.some(e => e.kind === 'momo') && Math.random() < 0.4) {
      const e = spawnEnemy('momo');
      if (e) {
        e.state = 'hunt'; setMomoTarget(e, G.p.x, G.p.y);
        Sound.play('cackle', 0.6);
        toast('☎️ 話筒那頭傳來咯咯的笑聲：「我聽到你了。」', 'warn');
        return;
      }
    }
    Sound.play('whisper');
    toast('☎️ 話筒裡只有沙沙聲……還有人在叫你的名字。', 'warn');
  }
}
function openFrontDoor() {
  const ev = G.ev;
  makeNoise(10);
  if (G.phase === 'night' && ev.knock > 0) {
    ev.knock = 0;
    for (const at of [{ x: 1.5, y: 12.5 }, { x: 1.6, y: 11.6 }]) { const e = spawnEnemy('shadow', at); if (e) e.spawn = 0.3; }
    G.p.san -= 20; G.shake = 0.6;
    Sound.play('hurt');
    toast('你打開了門……門外什麼都沒有。然後，有東西擠了進來！', 'warn');
  } else if (G.phase === 'night') toast('門外一片漆黑……還是別開了。');
  else if (ev.delivery > 0) takeDelivery();
  else toast('門外被濃霧包圍，什麼都看不見。還是待在家裡吧。');
}

function useSelected() {
  const id = G.selId;
  if (!id || !G.inv[id]) return;
  const it = ITEMS[id], p = G.p;
  switch (it.kind) {
    case 'food': {
      makeNoise(3);
      if (it.hunger) p.hunger = Math.min(100, p.hunger + it.hunger);
      if (it.san) p.san = Math.min(100, p.san + it.san);
      if (it.hp) p.hp = Math.min(100, p.hp + it.hp);
      removeItem(id); Sound.play('eat'); toast(`使用了${it.name}（${it.desc}）`);
      break;
    }
    case 'battery':
      if (p.bat >= 99) { toast('手電筒電量已經滿了。'); return; }
      p.bat = Math.min(100, p.bat + 50); removeItem(id); Sound.play('click'); toast('🔋 換上新電池。');
      break;
    case 'candle': {
      const room = roomGrid[Math.floor(p.y)][Math.floor(p.x)];
      if (!room) { toast('這裡不能放蠟燭。'); return; }
      G.candles.push({ x: p.x, y: p.y + 0.1, room, life: 90 });
      removeItem(id); Sound.play('place'); toast('🕯️ 點了一根蠟燭。');
      break;
    }
    case 'lamp': placeLamp(it.lamp, id); break;
    case 'key': toast('🗝️ 走到上鎖的寶箱前按 E 就會用鑰匙打開。'); break;
    case 'bulb': {
      const fx = nearestFixture();
      if (!fx) { toast('靠近天花板燈座或燈具才能安裝燈泡。'); return; }
      installBulb(fx, it.tier);
      break;
    }
  }
}
function lampTile() {
  const p = G.p;
  const ok = (x, y) => inMap(x, y) && tiles[y][x] === 1 && !solid[y][x] &&
    ![...G.sockets, ...G.lamps].some(o => o.x === x && o.y === y);
  const tx = Math.floor(p.x + Math.cos(p.face) * 0.95), ty = Math.floor(p.y + Math.sin(p.face) * 0.95);
  if (ok(tx, ty)) return { x: tx, y: ty };
  if (ok(Math.floor(p.x), Math.floor(p.y))) return { x: Math.floor(p.x), y: Math.floor(p.y) };
  return null;
}
function placeLamp(type, id) {
  const t = lampTile();
  if (!t) { toast('這裡放不下。'); return; }
  G.lamps.push({ kind: 'lamp', type, x: t.x, y: t.y, room: roomGrid[t.y][t.x], bulb: 0, dying: 0 });
  removeItem(id); Sound.play('place');
  toast(`放下了${ITEMS[id].name}。選擇燈泡後靠近按 Q 裝上。`);
  const bulbs = invList().filter(i => ITEMS[i].kind === 'bulb');
  if (bulbs.length) { G.selId = bulbs[0]; invDirty = true; }
}
function installBulb(fx, tier) {
  if (fx.bulb === tier) { toast('已經是同一種燈泡了。'); return; }
  const old = fx.bulb;
  if (old) addItem('bulb' + old);
  fx.bulb = tier; fx.dying = 0;
  removeItem('bulb' + tier);
  Sound.play('install');
  let msg = `💡 在${fixtureName(fx)}裝上了${BULBS[tier].name}`;
  if (old) msg += `（換下${BULBS[old].name}）`;
  if (!G.power) msg += '，但現在停電了';
  toast(msg, 'good');
  const bp = bulbPos(fx);
  for (let i = 0; i < 6 + tier * 2; i++) {
    const a = Math.random() * Math.PI * 2, s = rand(0.3, 1.2);
    G.fx.push({ type: 'spark', x: bp.x, y: bp.y, h: bp.h, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vh: rand(-1, 1), life: rand(0.4, 0.9), max: 0.9, color: bulbRGB(tier) });
  }
}
function pickUp() {
  const fx = nearestFixture();
  if (!fx) return;
  if (fx.kind === 'lamp') {
    addItem(lampItemId(fx.type));
    if (fx.bulb) addItem('bulb' + fx.bulb);
    G.lamps.splice(G.lamps.indexOf(fx), 1);
    Sound.play('pickup'); toast(`拿起了${fixtureName(fx)}。`);
  } else if (fx.bulb) {
    addItem('bulb' + fx.bulb);
    toast(`拆下了${BULBS[fx.bulb].name}。`);
    fx.bulb = 0; Sound.play('click');
  } else toast('燈座是空的。');
}

// ====================================================================
// 更新
// ====================================================================
function update(dt) {
  G.time += dt;
  buildLights();
  updatePlayer(dt);
  if (mode !== 'play') return;
  updateTime(dt);
  if (mode !== 'play') return;
  updateEvents(dt);
  updateFlowers(dt);
  updateAngels(dt);
  updateFireLamps(dt);
  updateFireballs(dt);
  updatePickups(dt);
  updateBulbs(dt);
  flowTimer -= dt;
  if (flowTimer <= 0 || !flow) { flowTimer = 0.25; computeFlow(); }
  updateSpawns(dt);
  updateEnemies(dt);
  for (const c of G.candles) c.life -= dt;
  G.candles = G.candles.filter(c => c.life > 0);
  updateFx(dt);
  G.shake = Math.max(0, G.shake - dt);
  G.target = getTarget();
  updateHold(dt);
  Sound.setDrone(G.phase === 'night' ? 0.7 + musicIntensity() * 0.6 : 0);
}
function updateFx(dt) {
  // 高級燈泡的粒子效果
  for (const o of fixtures()) {
    if (o.bulb !== SLIME_TIER || Math.random() > dt * 3) continue;
    const pos = bulbPos(o), life = Math.max(0.2, pos.h / 1.6);
    G.fx.push({ type: 'spark', x: pos.x + rand(-0.08, 0.08), y: pos.y + rand(-0.08, 0.08), h: pos.h - 0.1, vx: 0, vy: 0, vh: -1.6, life, max: life, color: [110, 230, 80] });
  }
  for (const L of G.lights) {
    if (!L.obj || L.tier < 4) continue;
    const rate = L.tier === ANGEL_TIER ? 2 : L.tier === STAR_TIER ? 8 : (L.tier - 3) * 1.4;
    if (Math.random() < rate * dt) {
      const pos = bulbPos(L.obj);
      if (L.tier === STAR_TIER) G.fx.push({ type: 'spark', x: pos.x + rand(-0.7, 0.7), y: pos.y + rand(-0.7, 0.7), h: pos.h + rand(-0.4, 0.3), vx: 0, vy: 0, vh: rand(-0.05, 0.05), life: rand(0.5, 1.2), max: 1.2, color: pick([[255, 255, 255], [190, 210, 255], [255, 240, 170]]) });
      else if (L.tier === ANGEL_TIER) G.fx.push({ type: 'spark', x: pos.x + rand(-0.3, 0.3), y: pos.y + rand(-0.3, 0.3), h: pos.h, vx: rand(-0.1, 0.1), vy: rand(-0.1, 0.1), vh: -rand(0.1, 0.3), life: 1.5, max: 1.5, color: [255, 230, 160] });
      else if (L.tier === FIRE_TIER) G.fx.push({ type: 'ember', x: pos.x + rand(-0.15, 0.15), y: pos.y + rand(-0.15, 0.15), h: pos.h, vx: rand(-0.15, 0.15), vy: rand(-0.15, 0.15), vh: rand(0.5, 1.1), life: rand(0.8, 1.5), max: 1.5, color: pick([[255, 200, 60], [255, 120, 30], [255, 80, 20]]) });
      else G.fx.push({ type: 'spark', x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(-0.4, 0.4), h: pos.h + rand(-0.2, 0.2), vx: rand(-0.1, 0.1), vy: rand(-0.1, 0.1), vh: -rand(0.1, 0.4), life: rand(0.8, 1.6), max: 1.6, color: L.tier === 9 ? hsl(Math.random() * 360, 0.9, 0.65) : bulbRGB(L.tier) });
    }
  }
  for (const f of G.fx) {
    f.x += f.vx * dt; f.y += f.vy * dt; f.h += f.vh * dt; f.life -= dt;
    if (f.type === 'smoke') { f.vx *= 0.94; f.vy *= 0.94; f.vh *= 0.94; }
  }
  G.fx = G.fx.filter(f => f.life > 0);
  if (G.fx.length > 500) G.fx.splice(0, G.fx.length - 500);
}
// 燈泡在 3D 空間的位置（h = 離地高度）
function bulbPos(o) {
  const h = { socket: 2.3, chand: 2.2, floor: 1.5, desk: 0.48 }[o.type];
  return { x: o.x + 0.5, y: o.y + 0.5, h };
}

// ====================================================================
// 結束
// ====================================================================
function gameOver() {
  mode = 'over';
  Sound.setDrone(0);
  const s = readSave();
  $('goTitle').textContent = '你倒下了……';
  $('goText').innerHTML = `你在<b>第 ${G.day} ${G.phase === 'night' ? '夜' : '天'}</b>倒下了。<br>搜索了 ${G.stats.searched} 次，驅散了 ${G.stats.dissolved} 個黑影。<br>最好的燈泡：${BULBS[G.stats.bestTier].name}`;
  $('btnRetry').classList.toggle('hidden', !s);
  if (s) $('btnRetry').textContent = `從第 ${s.day} 天早上重來`;
  $('gameover').classList.remove('hidden');
}
function victory() {
  mode = 'over';
  Sound.setDrone(0);
  Sound.play('win');
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  $('goTitle').textContent = `🌅 你撐過了 ${LAST_NIGHT} 夜！`;
  $('goText').innerHTML = `太陽升起，濃霧散去了。<br>你搜索了 ${G.stats.searched} 次，驅散了 ${G.stats.dissolved} 個黑影。<br>最好的燈泡：${BULBS[G.stats.bestTier].name}`;
  $('btnRetry').classList.add('hidden');
  $('gameover').classList.remove('hidden');
}

// ====================================================================
// 畫面輔助（3D 繪圖在 render3d.js）
// ====================================================================
const cv = $('game');
const isTouch = () => document.body.classList.contains('touch');

function darkLevel() {
  if (G.phase === 'day') {
    if (G.t < DAWN) return lerp(NIGHT_DARK, 0.06, G.t / DAWN);
    if (G.t > DAY_LEN - DUSK) return lerp(0.06, NIGHT_DARK, (G.t - (DAY_LEN - DUSK)) / DUSK);
    return 0.06;
  }
  if (G.t > NIGHT_LEN - 4) return lerp(NIGHT_DARK, 0.6, (G.t - NIGHT_LEN + 4) / 4);
  return NIGHT_DARK;
}
// 越沒血越透明
const enemyAlpha = e => clamp(1 - e.spawn * 0.8, 0, 1) * (e.maxHp ? 0.55 + 0.45 * Math.max(0, e.hp) / e.maxHp : 1);
function resize() { if (window.Renderer) Renderer.resize(); }

// 主選單背景用的展示場景
function demoState() {
  const s = freshState();
  s.phase = 'night'; s.t = 30;
  const set = (id, b) => { s.sockets.find(o => o.id === id).bulb = b; };
  set('s_living', 3); set('s_hall2', 1); set('s_kitchen', 5);
  s.lamps.push({ kind: 'lamp', type: 'floor', x: 24, y: 17, room: roomGrid[17][24], bulb: 9, dying: 0 });
  s.lamps.push({ kind: 'lamp', type: 'desk', x: 13, y: 17, room: roomGrid[17][13], bulb: 6, dying: 0 });
  s.enemies.push({ kind: 'shadow', x: 19.6, y: 12.4, fade: 0, spawn: 0, wob: 0 });
  return s;
}

// ---------- 小地圖 ----------
const mm = $('minimap'), mmc = mm.getContext('2d');
function drawMinimap() {
  const s = 3.2, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(MAP_W * s * dpr), h = Math.round(MAP_H * s * dpr);
  if (mm.width !== w) { mm.width = w; mm.height = h; mm.style.width = MAP_W * s + 'px'; mm.style.height = MAP_H * s + 'px'; }
  const c = mmc;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  c.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
  for (const r of ROOMS) {
    const lit = G.lights.some(L => L.room === r && !L.candle);
    c.fillStyle = lit ? 'rgba(255,220,140,.3)' : 'rgba(120,110,140,.28)';
    c.fillRect(r.x, r.y, r.w, r.h);
  }
  c.fillStyle = 'rgba(120,110,140,.28)';
  for (const d of DOORS) if (!d.front) c.fillRect(d.x, d.y, 1, 1);
  for (const L of G.lights) {
    c.fillStyle = rgba(L.color || (L.candle ? [255, 170, 80] : bulbRGB(L.tier)), 1);
    c.beginPath(); c.arc(L.x, L.y, 0.55, 0, 7); c.fill();
  }
  const blink = Math.sin(G.time * 8) > 0;
  const mark = (x, y, col) => { if (!blink) return; c.fillStyle = col; c.beginPath(); c.arc(x, y, 0.95, 0, 7); c.fill(); };
  if (!G.power) mark(42.5, 28.5, '#ffd400');
  if (G.ev.knock > 0) mark(0.5, 12.5, '#ff4455');
  if (G.ev.closet > 0) mark(30.5, 1.5, '#ff4455');
  if (G.ev.phone > 0) mark(26.5, 23.5, '#7ee081');
  for (const o of [...G.sockets, ...G.lamps]) if (o.eaten > 0) mark(o.x + 0.5, o.y + 0.5, '#b06bff');
  if (G.ev.tvOn) mark(15, 15.5, '#6fa8ff');
  if (G.phase === 'day' && G.ev.delivery > 0) mark(0.5, 12.5, '#7ee081');
  if (G.gift) { c.fillStyle = '#ffd166'; c.beginPath(); c.arc(GIFT_POS.x, GIFT_POS.y, 0.8, 0, 7); c.fill(); }
  if (merchantHere()) { c.fillStyle = '#c38bff'; c.beginPath(); c.arc(MERCHANT_POS.x, MERCHANT_POS.y, 0.8, 0, 7); c.fill(); }
  c.fillStyle = '#5fd37a';
  for (const fl of G.flowers) { c.beginPath(); c.arc(fl.x, fl.y, 0.6, 0, 7); c.fill(); }
  c.fillStyle = '#ff2a3a';
  for (const e of G.enemies) if (e.kind === 'balloon') { c.beginPath(); c.arc(e.x, e.y, 0.75, 0, 7); c.fill(); }
  // 玩家與面向
  const p = G.p;
  c.save(); c.translate(p.x, p.y); c.rotate(p.face);
  c.fillStyle = '#fff';
  c.beginPath(); c.moveTo(1.3, 0); c.lineTo(-0.8, 0.8); c.lineTo(-0.4, 0); c.lineTo(-0.8, -0.8); c.closePath(); c.fill();
  c.restore();
}

// ---------- 畫面特效與互動提示 ----------
function updateOverlays() {
  const p = G.p;
  let v = p.san < 60 ? clamp((60 - p.san) / 60 * 0.95 + (p.san < 25 ? 0.1 * Math.sin(G.time * 6) : 0), 0, 1) : 0;
  v = Math.max(v, (G.stare || 0) * (0.55 + 0.1 * Math.sin(G.time * 9)));
  $('vignette').style.opacity = v.toFixed(3);
  $('hurtfx').style.opacity = (p.hurt * 0.35).toFixed(3);
  $('bloodfx').style.opacity = G.ev.blood && G.phase === 'night' ? '1' : '0';
}
function updatePrompt() {
  const t = G.target, el = $('prompt');
  if (!t) { if (el.dataset.k) { el.innerHTML = ''; el.dataset.k = ''; } return; }
  const e = isTouch() ? 'E' : '[E]';
  const main = (t.action ? (t.hold ? `按住 ${e} ` : `${e} `) : '') + t.label;
  const key = main + '|' + (t.sub || '') + '|' + !!t.hold;
  if (el.dataset.k !== key) {
    el.innerHTML = `<div class="pm${t.action ? ' act' : ''}">${main}</div>` + (t.sub ? `<div class="ps">${t.sub}</div>` : '') +
      (t.hold ? '<div class="pbar"><i></i></div>' : '');
    el.dataset.k = key;
  }
  if (t.hold) el.querySelector('.pbar i').style.width = (G.holdId === t.id ? G.holdProg / t.hold * 100 : 0) + '%';
}

// ====================================================================
// 介面
// ====================================================================
function bulbSVG(t) {
  const c = BULBS[t].color;
  const col = c === 'rainbow' ? `url(#rb${t})` : `rgb(${c.join(',')})`;
  const defs = `<defs><radialGradient id="gl${t}"><stop offset="0" stop-color="${c === 'rainbow' ? '#fff' : `rgb(${c.join(',')})`}" stop-opacity=".8"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    (c === 'rainbow' ? `<linearGradient id="rb${t}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4d4d"/><stop offset=".3" stop-color="#ffd84d"/><stop offset=".5" stop-color="#4dff88"/><stop offset=".7" stop-color="#4db8ff"/><stop offset="1" stop-color="#c04dff"/></linearGradient>` : '') + '</defs>';
  let body;
  if (t === STAR_TIER) body = `<circle cx="18" cy="14" r="9.5" fill="#1d2a6e"/><circle cx="18" cy="14" r="9.5" fill="none" stroke="#a9bbff" stroke-width="1"/>` +
    [[14, 10, 1.3], [21, 12, 1], [17, 17, 1.1], [23, 17, 0.8], [13, 16, 0.7]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`).join('') +
    `<path d="M26 4 a4 4 0 1 0 4 5 a3 3 0 1 1 -4 -5z" fill="#fff3c4"/>`;
  else if (t === ANGEL_TIER) body = `<ellipse cx="18" cy="5" rx="6" ry="1.8" fill="none" stroke="#ffd54a" stroke-width="1.5"/>` +
    `<path d="M11 15 Q3 9 4 20 Q9 18 12 19Z M25 15 Q33 9 32 20 Q27 18 24 19Z" fill="#fff" stroke="#e3d3b0" stroke-width=".7"/>` +
    `<circle cx="18" cy="15" r="7.5" fill="#ffeec8"/><circle cx="16" cy="12.5" r="2" fill="#fff"/>`;
  else if (t === SLIME_TIER) body = `<path d="M10 17 Q9 7 18 6 Q27 7 26 17 Q26 22 23 22 Q22 27 20 23 Q18 29 16 23 Q14 26 13 22 Q10 22 10 17Z" fill="#6fe05a" stroke="#2f8f2a" stroke-width="1"/>` +
    `<circle cx="15" cy="12" r="2" fill="rgba(255,255,255,.7)"/><circle cx="21" cy="16" r="1.3" fill="rgba(255,255,255,.5)"/>`;
  else if (t === FIRE_TIER) body = `<path d="M18 4 C26 14 25 22 18 27 C11 22 10 14 18 4Z" fill="#ff6a10"/><path d="M18 12 C22 18 21 22 18 25 C15 22 14 18 18 12Z" fill="#ffe08a"/>`;
  else if (t >= 6) body = `<path d="M18 4 L27 15 L18 27 L9 15Z" fill="${col}" stroke="#fff" stroke-width="1"/><path d="M9 15 L27 15 M18 4 L14 15 L18 27 L22 15 Z" fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".8"/>`;
  else {
    body = `<circle cx="18" cy="14" r="8.5" fill="${col}"/><circle cx="15" cy="11" r="2.5" fill="rgba(255,255,255,.7)"/>`;
    if (t === 1) body += `<path d="M16 9 L19 14 L17 18" stroke="#5a3a1a" stroke-width="1" fill="none"/>`;
    if (t === 4) body += `<path d="M12 12 L18 7 L24 12 M12 12 L18 22 L24 12" stroke="rgba(120,200,240,.9)" stroke-width="1" fill="none"/>`;
    if (t === 5) body += `<path d="M11 5 L13.5 9 L18 3.5 L22.5 9 L25 5 L24 10 L12 10Z" fill="#f2c14e" stroke="#9c6f0b" stroke-width=".7"/>`;
  }
  const base = t >= 6 ? '' : `<rect x="14" y="22" width="8" height="6" rx="1.5" fill="${t === 5 ? '#d4a93a' : '#9aa'}"/>`;
  return `<svg viewBox="0 0 36 36">${defs}<circle cx="18" cy="15" r="16" fill="url(#gl${t})"/>${body}${base}</svg>`;
}
function lampSVG(type) {
  if (type === 'desk') return `<svg viewBox="0 0 36 36"><ellipse cx="16" cy="30" rx="8" ry="3" fill="#8a8f96"/><path d="M16 29 L12 18 L20 11" stroke="#8a8f96" stroke-width="2.5" fill="none"/><path d="M14 13 L28 13 L24 4 L17 4Z" fill="#e8d7b0" stroke="#a88f5f"/></svg>`;
  if (type === 'floor') return `<svg viewBox="0 0 36 36"><ellipse cx="18" cy="32" rx="7" ry="2.5" fill="#8a8f96"/><path d="M18 32 L18 12" stroke="#8a8f96" stroke-width="2.5"/><path d="M9 13 L27 13 L23 3 L13 3Z" fill="#f0e6cf" stroke="#a88f5f"/></svg>`;
  return `<svg viewBox="0 0 36 36"><path d="M18 3 L18 12" stroke="#d4a93a" stroke-width="2"/><path d="M5 18 Q18 28 31 18" stroke="#d4a93a" stroke-width="2" fill="none"/><circle cx="18" cy="14" r="4" fill="#f2c14e"/>${[5, 11.5, 18, 24.5, 31].map((x, i) => `<path d="M${x} ${18 + (i % 2) * 3} l2 4 l-2 4 l-2 -4z" fill="#cdf3ff" stroke="#7ec8e8" stroke-width=".6"/>`).join('')}</svg>`;
}
function itemIcon(id) {
  const it = ITEMS[id];
  if (it.kind === 'bulb') return bulbSVG(it.tier);
  if (it.kind === 'lamp') return lampSVG(it.lamp);
  return `<span>${it.icon}</span>`;
}
function renderHotbar() {
  invDirty = false;
  const list = invList();
  $('hotbar').innerHTML = list.map((id, i) => {
    const it = ITEMS[id];
    return `<div class="slot${id === G.selId ? ' sel' : ''}" data-id="${id}" title="${it.name}">` +
      (i < 10 ? `<span class="key">${(i + 1) % 10}</span>` : '') +
      itemIcon(id) +
      (it.tier ? `<span class="tier">${isSpecialBulb(it.tier) ? '★' : it.tier}</span>` : '') +
      `<span class="cnt">${G.inv[id] > 1 ? G.inv[id] : ''}</span></div>`;
  }).join('');
  const it = G.selId && ITEMS[G.selId];
  let hint = '';
  if (it) hint = { bulb: '[Q] 裝到看著的燈座／燈具', lamp: '[Q] 放在前方', food: '[Q] 使用', battery: '[Q] 換電池', candle: '[Q] 點蠟燭' }[it.kind];
  $('itemInfo').innerHTML = it ? `<b>${it.name}</b>　${it.desc}<span class="hint">${hint}</span>` : '';
}
function setBar(id, v) {
  const el = $(id);
  el.style.width = clamp(v, 0, 100) + '%';
  el.classList.toggle('low', v < 25);
}
function fmtClock() {
  const h = G.phase === 'day' ? 6 + 12 * G.t / DAY_LEN : (18 + 12 * G.t / NIGHT_LEN) % 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60 / 10) * 10;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function updateHUD() {
  const p = G.p, night = G.phase === 'night';
  $('dayLabel').textContent = `${night ? '🌙' : '☀️'} 第 ${G.day} ${night ? '夜' : '天'}`;
  $('phaseFill').style.width = (G.t / (night ? NIGHT_LEN : DAY_LEN) * 100) + '%';
  $('phaseFill').classList.toggle('night', night);
  const left = Math.ceil((night ? NIGHT_LEN : DAY_LEN) - G.t);
  $('phaseText').textContent = `${fmtClock()}　${night ? '天亮' : '天黑'}還有 ${left} 秒`;
  const alerts = [];
  if (!G.power) alerts.push('⚡ 停電中！→ 洗衣間電箱');
  if (G.ev.knock > 0) alerts.push('🚪 有人在敲門（別開）');
  if (G.ev.closet > 0) alerts.push(`🚪 衣櫃在晃動（${Math.ceil(G.ev.closet)} 秒）`);
  if (G.ev.phone > 0) alerts.push('☎️ 電話在響');
  if (G.enemies.some(e => e.kind === 'tall')) alerts.push('👁️ 「它」在屋子裡');
  if (G.enemies.some(e => e.kind === 'blob' && e.eatT > 0)) alerts.push('⚫ 黑球在吃燈！快用手電筒照它');
  else if (G.enemies.some(e => e.kind === 'blob')) alerts.push('⚫ 黑球在屋子裡');
  if (G.enemies.some(e => e.kind === 'woman')) alerts.push('😢 血淚女在屋子裡');
  if (G.ev.tvOn) alerts.push(G.enemies.some(e => e.kind === 'crawler') ? '📺 爬行女爬出來了！快去關電視' : '📺 電視自己打開了！快去關掉');
  if (G.enemies.some(e => e.kind === 'stick')) alerts.push('✏️ 火柴人會穿牆過來');
  if (G.flowers.some(f => f.sees)) alerts.push('👁️ 眼球花正在盯著你！');
  const momo = G.enemies.find(e => e.kind === 'momo');
  if (momo) alerts.push(momo.state === 'hunt' ? '🐦 鳥腳女聽到你了！' : '🐦 鳥腳女在找你（別出聲）');
  if (G.enemies.some(e => e.kind === 'balloon')) alerts.push('🎈 紅氣球飄過來了！用手電筒照破它');
  if (G.enemies.some(e => e.kind === 'clown')) alerts.push('🤡 小丑在追你！快跑到燈光下');
  $('noiseBar').classList.toggle('hidden', !momo);
  if (momo) $('noiseFill').style.width = clamp(playerNoise() / 12 * 100, 0, 100) + '%';
  if (G.phase === 'day' && G.ev.delivery > 0) alerts.push('📦 送貨員在前門，快去開門！');
  if (G.gift) alerts.push('🎁 臥室床邊有早晨禮物');
  if (G.treasure) alerts.push(`⭐ 寶藏星星在「${G.treasure.room}」`);
  const html = alerts.join('<br>');
  if ($('alert').innerHTML !== html) $('alert').innerHTML = html;
  $('coinText').textContent = G.coins || 0;
  setBar('hpFill', p.hp); setBar('sanFill', p.san); setBar('hungerFill', p.hunger);
  setBar('batFill', p.bat); setBar('stamFill', p.stam);
  if (invDirty) renderHotbar();
  drawMinimap();
  updateOverlays();
  updatePrompt();
}
let lastToast = '', lastToastT = 0;
function toast(msg, cls = '') {
  const now = performance.now();
  if (msg === lastToast && now - lastToastT < 1500) return;
  lastToast = msg; lastToastT = now;
  const box = $('toasts'), el = document.createElement('div');
  el.className = 'toast ' + cls; el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 500); }, 4200);
}
let bigTimer = 0;
function showBig(title, sub) {
  const el = $('bigText');
  el.innerHTML = `${title}<small>${sub || ''}</small>`;
  el.classList.add('show');
  clearTimeout(bigTimer);
  bigTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ====================================================================
// 輸入
// ====================================================================
const keys = {};
const LOOK_MOUSE = 0.0024, LOOK_TOUCH_X = 0.0085, LOOK_TOUCH_Y = 0.0058;
function look(dx, dy) {
  const p = G.p;
  p.face += dx;
  p.pitch = clamp(p.pitch - dy, -1.2, 1.2);
}
function selectIndex(i) {
  const list = invList();
  if (list[i]) { G.selId = list[i]; invDirty = true; }
}
function cycleSel(dir) {
  const list = invList();
  if (!list.length) return;
  const i = Math.max(0, list.indexOf(G.selId));
  G.selId = list[(i + dir + list.length) % list.length];
  invDirty = true;
}
function lockPointer() {
  if (isTouch() || !cv.requestPointerLock || document.pointerLockElement === cv) return;
  try { const r = cv.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* 不支援就算了 */ }
}
function releaseInputs() {
  for (const k in keys) keys[k] = false;
  joy.id = null; joy.x = joy.y = 0; setStick(null);
  lookId = null;
  if (G) G.holdLock = false;
}
function pauseGame() {
  if (mode !== 'play') return;
  mode = 'pause';
  Sound.setDrone(0);
  releaseInputs();
  if (document.pointerLockElement) document.exitPointerLock();
  $('pause').classList.remove('hidden');
  $('jumpscare').classList.remove('show');
}
function resumeGame() {
  $('pause').classList.add('hidden');
  $('help').classList.add('hidden');
  mode = 'play';
  lockPointer();
}
addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return; // 在輸入框打字時不當成遊戲操作
  Sound.init();
  const k = e.key.toLowerCase();
  if (k === 'tab' || k === ' ' || k.startsWith('arrow')) e.preventDefault();
  if (mode === 'pause' && k === 'escape') { resumeGame(); return; }
  if (mode === 'modal' && k === 'escape') { closeModal(); return; }
  if (mode !== 'play') return;
  if (k === 'escape') { pauseGame(); return; }
  keys[k] = true;
  if (e.code === 'KeyW') keys.w = true; else if (e.code === 'KeyA') keys.a = true;
  else if (e.code === 'KeyS') keys.s = true; else if (e.code === 'KeyD') keys.d = true;
  else if (e.code === 'KeyE') keys.e = true;
  if (e.repeat) return;
  const code = e.code;
  if (code === 'KeyF') toggleFlash();
  else if (code === 'KeyE') interactPress();
  else if (code === 'KeyQ') useSelected();
  else if (code === 'KeyR') pickUp();
  else if (code === 'KeyM') { toast(Sound.toggleMute() ? '🔇 已靜音' : '🔊 已開啟聲音'); refreshMuteBtn(); }
  else if (/^Digit\d$/.test(code)) selectIndex((+code.slice(5) + 9) % 10);
});
addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  const map = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyE: 'e' };
  if (map[e.code]) keys[map[e.code]] = false;
  if (e.code === 'KeyE' && G) G.holdLock = false;
});
addEventListener('blur', pauseGame);
function toggleFlash() {
  if (G.p.bat <= 0) toast('🔦 手電筒沒電了，需要電池。');
  else { G.p.flash = !G.p.flash; Sound.play('click'); makeNoise(3); }
}
function releaseE() { keys.e = false; if (G) G.holdLock = false; }

// ---------- 滑鼠（電腦）：點畫面鎖定滑鼠，移動滑鼠轉頭 ----------
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== cv && mode === 'play' && !isTouch()) pauseGame();
});
cv.addEventListener('mousemove', e => {
  if (document.pointerLockElement === cv && mode === 'play') look(e.movementX * LOOK_MOUSE, e.movementY * LOOK_MOUSE);
});
cv.addEventListener('pointerdown', e => {
  Sound.init();
  if (e.pointerType !== 'mouse' || mode !== 'play') return;
  if (document.pointerLockElement !== cv) { lockPointer(); return; }
  if (e.button === 0) { keys.e = true; interactPress(); }
  if (e.button === 2) useSelected();
});
addEventListener('pointerup', e => { if (e.pointerType === 'mouse' && e.button === 0) releaseE(); });
cv.addEventListener('contextmenu', e => e.preventDefault());

// ---------- 觸控：左半邊搖桿移動、右半邊滑動轉頭 ----------
const joy = { x: 0, y: 0, id: null, ox: 0, oy: 0 };
let lookId = null, lookX = 0, lookY = 0;
const JOY_R = 85;
function enableTouch() {
  if (isTouch()) return;
  document.body.classList.add('touch');
  resize();
}
if (window.matchMedia && matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
function setStick(x, y) {
  const st = $('stick');
  if (x === null) { st.classList.remove('active'); st.style.left = st.style.top = st.style.bottom = ''; $('knob').style.transform = ''; return; }
  st.classList.add('active');
  st.style.left = (x - JOY_R) + 'px'; st.style.top = (y - JOY_R) + 'px'; st.style.bottom = 'auto';
}
cv.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  enableTouch();
  if (mode !== 'play') return;
  e.preventDefault();
  if (e.clientX < innerWidth * 0.45 && joy.id === null) {
    joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY;
    setStick(e.clientX, e.clientY);
  } else if (lookId === null) {
    lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
  }
});
cv.addEventListener('pointermove', e => {
  if (e.pointerId === joy.id) {
    let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
    const l = Math.hypot(dx, dy);
    if (l > JOY_R) { dx *= JOY_R / l; dy *= JOY_R / l; }
    joy.x = dx / JOY_R; joy.y = dy / JOY_R;
    $('knob').style.transform = `translate(${dx}px, ${dy}px)`;
  } else if (e.pointerId === lookId && mode === 'play') {
    look((e.clientX - lookX) * LOOK_TOUCH_X, (e.clientY - lookY) * LOOK_TOUCH_Y);
    lookX = e.clientX; lookY = e.clientY;
  }
});
function endTouch(e) {
  if (e.pointerId === joy.id) { joy.id = null; joy.x = joy.y = 0; setStick(null); }
  if (e.pointerId === lookId) lookId = null;
}
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);

// ---------- 觸控按鈕 ----------
for (const b of document.querySelectorAll('#tbtns .tb')) {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    Sound.init();
    if (mode !== 'play') return;
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* 部分瀏覽器不支援 */ }
    b.classList.add('down');
    if (k === 'e') { keys.e = true; interactPress(); }
    else if (k === 'q') useSelected();
    else if (k === 'f') toggleFlash();
    else if (k === 'r') pickUp();
  });
  const up = () => { b.classList.remove('down'); if (k === 'e') releaseE(); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}
$('tpause').addEventListener('pointerdown', e => { e.preventDefault(); pauseGame(); });

// 長按按鈕時，阻止瀏覽器跳出選取文字、放大鏡、右鍵選單等功能
for (const el of [cv, $('touch')]) {
  el.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  el.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}
addEventListener('contextmenu', e => { if (isTouch() || e.target === cv) e.preventDefault(); });
addEventListener('selectstart', e => { if (mode === 'play') e.preventDefault(); });
addEventListener('wheel', e => { if (mode === 'play') cycleSel(e.deltaY > 0 ? 1 : -1); }, { passive: true });
$('hotbar').addEventListener('click', e => {
  const s = e.target.closest('.slot');
  if (s) { G.selId = s.dataset.id; invDirty = true; }
});
addEventListener('resize', resize);

// ---------- 選單按鈕 ----------
function refreshTitle() {
  const s = readSave();
  $('btnContinue').disabled = !s;
  $('saveInfo').textContent = s ? `存檔：第 ${s.day} 天早上` : '還沒有存檔';
}
function toTitle() {
  mode = 'title';
  Sound.setDrone(0);
  if (document.pointerLockElement) document.exitPointerLock();
  G = demoState();
  for (const id of ['pause', 'gameover', 'help', 'book']) $(id).classList.add('hidden');
  $('hud').classList.add('hidden');
  $('title').classList.remove('hidden');
  refreshTitle();
}
let helpFrom = 'title';
$('btnNew').onclick = () => {
  Sound.init();
  if (readSave() && !confirm('開始新遊戲會覆蓋目前的存檔，確定嗎？')) return;
  newGame();
};
$('btnContinue').onclick = () => {
  Sound.init();
  if (!loadGame()) return;
  startPlay();
  showBig(`第 ${G.day} 天`, '繼續生存');
};
$('btnHelp').onclick = () => { helpFrom = 'title'; $('title').classList.add('hidden'); $('help').classList.remove('hidden'); };
$('btnPauseHelp').onclick = () => { helpFrom = 'pause'; $('pause').classList.add('hidden'); $('help').classList.remove('hidden'); };
$('btnHelpBack').onclick = () => { $('help').classList.add('hidden'); $(helpFrom).classList.remove('hidden'); };
$('btnResume').onclick = resumeGame;
$('mClose').onclick = closeModal;
$('mBody').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b || b.disabled || !modalAct) return;
  modalAct(b.dataset.act);
  refreshModal();
});
$('btnBook').onclick = () => openBook('title');
$('btnPauseBook').onclick = () => openBook('pause');
$('btnBookBack').onclick = () => { $('book').classList.add('hidden'); $(bookFrom).classList.remove('hidden'); };
function refreshMuteBtn() { $('btnMute').textContent = Sound.isMuted() ? '🔇 聲音：關' : '🔊 聲音：開'; }
$('btnMute').onclick = () => { Sound.toggleMute(); refreshMuteBtn(); };
refreshMuteBtn();
$('btnQuit').onclick = toTitle;
$('btnGoMenu').onclick = toTitle;
$('btnRetry').onclick = () => {
  if (!loadGame()) return;
  startPlay();
  showBig(`第 ${G.day} 天`, '再試一次');
};

// ====================================================================
// 主迴圈
// ====================================================================
let lastT = 0;
// 背景音樂的緊張程度：停電、「它」、敵人靠近、理智低都會讓音樂更恐怖
function musicIntensity() {
  if (G.phase !== 'night') return 0;
  const p = G.p;
  let i = 0.2;
  if (!G.power) i += 0.3;
  if (G.enemies.some(e => e.kind === 'tall')) i += 0.3;
  if (G.ev.blood) i += 0.2;
  if (G.enemies.some(e => Math.hypot(e.x - p.x, e.y - p.y) < 5)) i += 0.2;
  if (G.enemies.some(e => e.kind === 'woman' && Math.hypot(e.x - p.x, e.y - p.y) < 9)) i += 0.2;
  if (G.ev.tvOn) i += 0.1;
  if (G.enemies.some(e => e.kind === 'crawler' || e.kind === 'clown')) i += 0.3;
  if (G.enemies.some(e => e.kind === 'momo' && e.state === 'hunt')) i += 0.2;
  if (G.flowers.some(f => f.sees)) i += 0.15;
  i += (1 - p.san / 100) * 0.3;
  return clamp(i, 0, 1);
}
function musicState() {
  if (mode === 'play' || mode === 'modal') return G.phase;
  if (mode === 'title') return 'title';
  return 'off';
}
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastT) / 1000 || 0);
  lastT = ts;
  if (mode === 'play') update(dt);
  else if (mode === 'title') { G.time += dt; for (const e of G.enemies) e.wob += dt; buildLights(); }
  else buildLights();
  Sound.music(musicState(), mode === 'play' ? musicIntensity() : 0);
  Sound.setStatic(mode === 'play' && G.ev.tvOn ? nearVol(Math.hypot(G.p.x - 15, G.p.y - 16)) : 0);
  if (window.Renderer) Renderer.render(dt);
  if (mode === 'play') updateHUD();
  requestAnimationFrame(frame);
}

// ---------- 存檔轉移 ----------
const SAVE_PREFIX = 'H12:';
function saveCode() {
  const raw = localStorage.getItem(SAVE_KEY);
  return raw ? SAVE_PREFIX + btoa(unescape(encodeURIComponent(raw))) : '';
}
function openTransfer() {
  $('title').classList.add('hidden');
  $('transfer').classList.remove('hidden');
  $('saveOut').value = saveCode() || '（這裡還沒有存檔）';
  $('saveIn').value = '';
  $('transferMsg').textContent = '';
}
$('btnTransfer').onclick = openTransfer;
$('btnTransferBack').onclick = () => { $('transfer').classList.add('hidden'); $('title').classList.remove('hidden'); refreshTitle(); };
$('btnCopySave').onclick = async () => {
  const code = saveCode();
  if (!code) { $('transferMsg').textContent = '這裡還沒有存檔可以複製。'; return; }
  let ok = false;
  try { await navigator.clipboard.writeText(code); ok = true; } catch (e) { /* http 網址不能用剪貼簿 API */ }
  if (!ok) { const t = $('saveOut'); t.focus(); t.select(); try { ok = document.execCommand('copy'); } catch (e) { ok = false; } }
  $('transferMsg').textContent = ok ? '✅ 已複製！到新的地方打開「存檔轉移」貼上。' : '請長按上面的代碼，選「全選」再「複製」。';
};
$('btnLoadSave').onclick = () => {
  const code = $('saveIn').value.trim();
  try {
    if (!code.startsWith(SAVE_PREFIX)) throw new Error('prefix');
    const raw = decodeURIComponent(escape(atob(code.slice(SAVE_PREFIX.length))));
    const s = JSON.parse(raw);
    if (!s || !s.day || !s.inv) throw new Error('bad');
    if (readSave() && !confirm('這會蓋掉這裡現在的存檔，確定嗎？')) return;
    localStorage.setItem(SAVE_KEY, raw);
    $('saveOut').value = saveCode();
    $('transferMsg').textContent = `✅ 讀取成功！存檔是第 ${Math.min(s.day, LAST_NIGHT)} 天，回主選單按「繼續遊戲」。`;
  } catch (e) {
    $('transferMsg').textContent = '❌ 這不是正確的存檔代碼，請整段複製再貼上一次。';
  }
};

// ---------- 網頁 App：離線也能玩（只在正式的 https 網址啟用，本機開發時不快取） ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // 第一次安裝不用提示
    if (mode === 'title') location.reload();
    else toast('✨ 遊戲更新好了，下次打開就是新版本。', 'good');
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

buildMap();
G = demoState();
refreshTitle();
requestAnimationFrame(frame);
