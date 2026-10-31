'use strict';
// ===== 第四世界：3008 無盡賣場 =====
// 照 Roblox 的《3008》：一間走不完的家具賣場。白天燈亮著，晚上燈全部熄掉，沒有臉的店員（SCP-3008-2）出來巡邏。
// 這次房子要自己蓋：板子放在格子的「邊」上（像真的牆，不佔一整格），躺平就是屋頂；賣場的家具大部分可以搬回家。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、toast、move… 都是遊戲跑起來之後才呼叫。

// ====================================================================
// 區域（樣品間、倉儲區、美食區……）：提示和寶藏星星用區域的名字，賣場本身只有一個大房間
// ====================================================================
function zoneAt(x, y) {
  for (const z of W4MAP.zones) if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z;
  return null;
}
const zoneName = (x, y) => { const z = zoneAt(x, y); return z ? z.name : '賣場'; };
// 主走道（墮落戰神只在這裡巡邏）
const inAisle4 = (x, y) => { const z = zoneAt(x, y); return !!(z && z.aisle); };
// 墮落戰神巡邏：主走道的四個端點裡離自己最遠的那個
const farPatrol4 = e => W4.patrol.reduce((a, b) => (Math.hypot(b.x - e.x, b.y - e.y) > Math.hypot(a.x - e.x, a.y - e.y) ? b : a));

// ====================================================================
// 自己蓋的牆：放在格子的邊上。h 是水平的邊（格子 (x, y) 的上緣，也就是 (x, y-1) 和 (x, y) 中間），
// v 是垂直的邊（格子 (x, y) 的左緣，(x-1, y) 和 (x, y) 中間）。屋頂是躺平的板子，放在某一格的上方。
// 牆：{ o, x, y, tier, hp, door, open }；玻璃（第 5 級）打不破、光透得過去
// ====================================================================
const WALL_T = 0.05;   // 牆的半個厚度（碰撞用）
let moveWho = null;    // 現在正在移動的是誰（黑球鑽得過木頭、水泥、黃金、岩漿板子的縫）
function initB4() {
  G.b4 = { h: new Array((MAP_H + 1) * MAP_W).fill(null), v: new Array(MAP_H * (MAP_W + 1)).fill(null), roofs: new Map(), n: 0, ver: 1, list: [], cells: new Map() };
}
// 斜放的牆（設計師：XYZ 也要有分 15°、45°、90°）：不在格子的邊上，{ free: true, cx, cy, ang（弧度）}，一片 1 公尺長。
// 碰撞照真的線段算；尋路、視線、光、「在家裡」把它穿過的格子當成有牆（G.b4.cells：格子 → 斜牆）
const freeIn = (x, y) => { const l = G.b4.cells.get(x + ',' + y); return l ? l.find(wallClosed) || null : null; };
function freeCells(w) {
  const out = new Set(), [x0, y0, x1, y1] = wallEnds(w);
  for (let k = 0; k <= 20; k++) out.add(Math.floor(x0 + (x1 - x0) * k / 20) + ',' + Math.floor(y0 + (y1 - y0) * k / 20));
  return [...out];
}
const b4On = () => !!(G && G.b4 && curWorld === 4);
function wallH(x, y) { const b = G.b4; return x >= 0 && x < MAP_W && y >= 0 && y <= MAP_H ? b.h[y * MAP_W + x] : null; }
function wallV(x, y) { const b = G.b4; return x >= 0 && x <= MAP_W && y >= 0 && y < MAP_H ? b.v[y * (MAP_W + 1) + x] : null; }
const wallAt = (o, x, y) => (o === 'h' ? wallH(x, y) : wallV(x, y));
// 兩個相鄰格子中間的牆（沒有就 null）
function wallBetween(ax, ay, bx, by) {
  if (!b4On() || !G.b4.n) return null;
  if (bx === ax + 1) return wallV(bx, ay);
  if (bx === ax - 1) return wallV(ax, ay);
  if (by === ay + 1) return wallH(ax, by);
  if (by === ay - 1) return wallH(ax, ay);
  return null;
}
const wallClosed = w => !!w && !(w.door && w.open);
const wallOpaque = w => wallClosed(w) && w.tier !== GLASS_TIER;
const blocksMove = (w, who) => wallClosed(w) && !(who && who.kind === 'blob' && w.tier !== GLASS_TIER);
function setWall(w) {
  const b = G.b4;
  if (w.free) { w.x = Math.floor(w.cx); w.y = Math.floor(w.cy); for (const k of freeCells(w)) { if (!b.cells.has(k)) b.cells.set(k, []); b.cells.get(k).push(w); } }
  else if (w.o === 'h') b.h[w.y * MAP_W + w.x] = w; else b.v[w.y * (MAP_W + 1) + w.x] = w;
  b.list.push(w); b.n++;
  b4Changed();
}
function removeWall(w) {
  const b = G.b4;
  if (w.free) { for (const k of freeCells(w)) { const l = b.cells.get(k); if (l) { l.splice(l.indexOf(w) >>> 0, 1); if (!l.length) b.cells.delete(k); } } }
  else if (w.o === 'h') { if (b.h[w.y * MAP_W + w.x] === w) b.h[w.y * MAP_W + w.x] = null; }
  else if (b.v[w.y * (MAP_W + 1) + w.x] === w) b.v[w.y * (MAP_W + 1) + w.x] = null;
  const i = b.list.indexOf(w);
  if (i >= 0) { b.list.splice(i, 1); b.n--; }
  b4Changed();
}
// 牆、門、家具改變了：路線、光、「在家裡」都要重算
function b4Changed() { G.b4.ver++; fixFlows.clear(); flow = null; encCache = null; }
// 牆的兩端（地圖座標）
const wallEnds = w => (w.free ? [w.cx - Math.cos(w.ang) * 0.5, w.cy - Math.sin(w.ang) * 0.5, w.cx + Math.cos(w.ang) * 0.5, w.cy + Math.sin(w.ang) * 0.5] : w.o === 'h' ? [w.x, w.y, w.x + 1, w.y] : [w.x, w.y, w.x, w.y + 1]);
// 點到牆（線段）的距離
function distToWall(x, y, w) {
  const [x0, y0, x1, y1] = wallEnds(w), dx = x1 - x0, dy = y1 - y0;
  const k = clamp(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(x - x0 - dx * k, y - y0 - dy * k);
}
// 碰撞：圓（x, y, r）有沒有撞到擋路的牆（game.js 的 hits 會呼叫）
function hitsWall4(x, y, r) {
  if (!G.b4.n) return false;
  const who = moveWho, x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  const r2 = r * r;
  for (let Y = Math.ceil(y - r - WALL_T); Y <= Math.floor(y + r + WALL_T); Y++) {
    const dy = Math.max(0, Math.abs(y - Y) - WALL_T);
    for (let X = x0; X <= x1; X++) {
      const w = wallH(X, Y);
      if (!w || !blocksMove(w, who)) continue;
      const dx = x - clamp(x, X, X + 1);
      if (dx * dx + dy * dy < r2) return true;
    }
  }
  for (let X = Math.ceil(x - r - WALL_T); X <= Math.floor(x + r + WALL_T); X++) {
    const dx = Math.max(0, Math.abs(x - X) - WALL_T);
    for (let Y = y0; Y <= y1; Y++) {
      const w = wallV(X, Y);
      if (!w || !blocksMove(w, who)) continue;
      const dy = y - clamp(y, Y, Y + 1);
      if (dx * dx + dy * dy < r2) return true;
    }
  }
  if (G.b4.cells.size) for (let Y = y0 - 1; Y <= y1 + 1; Y++) for (let X = x0 - 1; X <= x1 + 1; X++) {
    const l = G.b4.cells.get(X + ',' + Y);
    if (l) for (const w of l) if (blocksMove(w, who) && distToWall(x, y, w) < r + WALL_T) return true;
  }
  return false;
}
// 視線：從格子 a 走到相鄰（或斜對角）的格子 b 有沒有被不透明的牆擋住（castRay 用；玻璃看得穿）
function sightBlocked4(ax, ay, bx, by) {
  if (!G.b4.n) return false;
  if (wallOpaque(freeIn(bx, by)) && !wallOpaque(freeIn(ax, ay))) return true;   // 走進有斜牆的格子
  if (ax === bx || ay === by) return wallOpaque(wallBetween(ax, ay, bx, by));
  // 斜著跨過一個角：兩條路都被擋住才算擋住
  const p1 = wallOpaque(wallBetween(ax, ay, bx, ay)) || wallOpaque(wallBetween(bx, ay, bx, by));
  const p2 = wallOpaque(wallBetween(ax, ay, ax, by)) || wallOpaque(wallBetween(ax, by, bx, by));
  return p1 && p2;
}
// 子彈、鞭炮：從 (x0, y0) 飛到 (x1, y1) 有沒有穿過擋路的牆（玻璃也擋）
function moveBlocked4(x0, y0, x1, y1) {
  if (!b4On() || !G.b4.n) return false;
  const ax = Math.floor(x0), ay = Math.floor(y0), bx = Math.floor(x1), by = Math.floor(y1);
  if (ax === bx && ay === by) return false;
  if (freeIn(bx, by) && !freeIn(ax, ay)) return true;
  if (ax !== bx && ay !== by) return wallClosed(wallBetween(ax, ay, bx, ay)) || wallClosed(wallBetween(ax, ay, ax, by));
  return wallClosed(wallBetween(ax, ay, bx, by));
}

// ====================================================================
// 尋路：怪物會把牆算進路線。打得破的牆很「貴」（越耐打越貴），牆太貴就繞路找門口；繞不過去就站在牆前面打牆。
// 玻璃打不破（走不過去）。黑球（mode 'blob'）鑽得過木頭、水泥、黃金、岩漿板子的縫
// ====================================================================
function edgeCost4(ax, ay, bx, by, mode) {
  const w = wallBetween(ax, ay, bx, by) || (G.b4.cells.size ? freeIn(bx, by) : null);
  if (!wallClosed(w)) return 1;
  if (w.tier === GLASS_TIER) return Infinity;
  if (mode === 'blob') return 1;
  return 1 + Math.ceil(w.hp / 8);
}
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function computeFlow4(sx, sy, mode) {
  const f = grid(Infinity), buckets = [[[sx, sy]]];
  f[sy][sx] = 0;
  for (let d = 0; d < buckets.length; d++) {
    const q = buckets[d];
    if (!q) continue;
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      if (f[y][x] !== d) continue;
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (isSolid(nx, ny)) continue;
        const nd = d + edgeCost4(x, y, nx, ny, mode);
        if (nd < f[ny][nx]) { f[ny][nx] = nd; (buckets[nd] || (buckets[nd] = [])).push([nx, ny]); }
      }
    }
  }
  return f;
}
// pathDir 用：下一步往哪一格走（算上牆的代價）。順便記下路上擋著的牆（e.wallAhead），怪物撞到就會打它
function nextStep4(e, f, tx, ty) {
  let best = null, bv = Infinity, bw = null;
  for (const [dx, dy] of DIRS4) {
    const nx = tx + dx, ny = ty + dy;
    const v = f[ny] ? f[ny][nx] : Infinity;
    if (v === Infinity || v === undefined) continue;
    const c = edgeCost4(tx, ty, nx, ny, e.kind === 'blob' ? 'blob' : '');
    if (c === Infinity) continue;
    if (v + c < bv) { bv = v + c; best = [nx, ny]; bw = c > 1 ? wallBetween(tx, ty, nx, ny) || freeIn(nx, ny) : null; }
  }
  e.wallAhead = bw;
  return best;
}

// ====================================================================
// 光：從燈往外一格一格擴散，被牆、柱子和不透明的板子擋住（自己家的燈不會穿牆照到外面；玻璃透光）。
// 每盞燈算一次（牆改變或燈換位置才重算），game.js 的 lightAt 和 3D 的光照貼圖都用這個
// ====================================================================
const maskCache = new Map();
function lightMask4(L) {
  const tx = Math.floor(L.x), ty = Math.floor(L.y), R = Math.ceil(L.r) + 1, ver = G.b4 ? G.b4.ver : 0;
  const key = tx + ',' + ty + ',' + R;
  let m = maskCache.get(key);
  if (m && m.ver === ver) return m;
  if (maskCache.size > 300) maskCache.clear();
  const x0 = tx - R, y0 = ty - R, w = R * 2 + 1, mask = new Uint8Array(w * w), steps = new Uint8Array(w * w);
  m = { x0, y0, w, mask, ver };
  maskCache.set(key, m);
  if (!inMap(tx, ty)) return m;
  const q = [[tx, ty]];
  mask[(ty - y0) * w + (tx - x0)] = 1;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i], st = steps[(y - y0) * w + (x - x0)];
    if ((isWall(x, y) || (G.b4 && G.b4.cells.size && wallOpaque(freeIn(x, y)))) && i > 0) continue;   // 光照到牆（或斜牆）就停（牆本身會被照到，但不會穿過去）
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx, ny = y + dy, k = (ny - y0) * w + (nx - x0);
      if (nx < x0 || ny < y0 || nx >= x0 + w || ny >= y0 + w || mask[k] || !inMap(nx, ny)) continue;
      if ((nx + 0.5 - L.x) ** 2 + (ny + 0.5 - L.y) ** 2 > (R + 0.5) ** 2) continue;
      // 光不太會轉彎：繞路比直線多走超過 2 格的地方照不到（不然光會從玻璃出去、繞過整間房子照到另一邊）
      if (st + 1 > Math.abs(nx - tx) + Math.abs(ny - ty) + 2) continue;
      if (G.b4 && G.b4.n && wallOpaque(wallBetween(x, y, nx, ny))) continue;
      mask[k] = 1; steps[k] = st + 1;
      q.push([nx, ny]);
    }
  }
  return m;
}
const maskHas = (m, x, y) => { const lx = x - m.x0, ly = y - m.y0; return lx >= 0 && ly >= 0 && lx < m.w && ly < m.w && m.mask[ly * m.w + lx] === 1; };
function lightAt4(x, y, minTier) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inMap(tx, ty) || isWall(tx, ty)) return 0;
  let best = 0;
  for (const L of G.lights) {
    if (L.tier < minTier) continue;
    const d = Math.hypot(x - L.x, y - L.y);
    if (d >= L.r || !maskHas(lightMask4(L), tx, ty)) continue;
    const i = (1 - Math.pow(d / L.r, 1.8)) * L.f;
    if (i > best) best = i;
  }
  return best;
}

// ====================================================================
// 在家裡：玩家所在的地方被牆、門和板子圍起來（從玩家往外走 150 格以內走不出去）
// ====================================================================
let encCache = null;
const ENC_MAX = 150;
function enclosure4(tx, ty) {
  const ver = G.b4 ? G.b4.ver : 0;
  if (encCache && encCache.tx === tx && encCache.ty === ty && encCache.ver === ver) return encCache;
  const seen = new Set([tx + ',' + ty]), q = [[tx, ty]];
  let inside = !!(G.b4 && G.b4.n) && inMap(tx, ty) && !isSolid(tx, ty);
  for (let i = 0; i < q.length && inside; i++) {
    const [x, y] = q[i];
    for (const [dx, dy] of DIRS4) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (seen.has(k) || !inMap(nx, ny) || isWall(nx, ny)) continue;
      if (wallClosed(wallBetween(x, y, nx, ny)) || freeIn(nx, ny)) continue;
      seen.add(k); q.push([nx, ny]);
      if (seen.size > ENC_MAX) { inside = false; break; }
    }
  }
  encCache = { tx, ty, ver, inside, tiles: inside ? seen : null, cozy: 0 };
  if (inside) {
    // 溫馨度：家裡放了幾件家具（最多 5）
    let c = 0;
    for (const f of FURN) if (f.move && !f.held && seen.has(f.x + ',' + f.y)) c++;
    encCache.cozy = Math.min(5, c);
  }
  return encCache;
}
const atHome4 = () => b4On() && enclosure4(Math.floor(G.p.x), Math.floor(G.p.y)).inside;
const cozy4 = () => (atHome4() ? encCache.cozy : 0);

// ====================================================================
// 手上拿的東西（G.hand）：板子 { k: 'plank', tier, door }、家具 { k: 'furn', f }、背包滿了多拿的小東西 { k: 'item', id, n }（第 17 個）
// 拿著板子或家具時前面有預覽；X／Y／Z 選要繞哪個軸轉、「轉」轉 90 度、遠／近調距離、「放」放下
// ====================================================================
// 板子的小圖示（商店、物品欄的手上那一格）：照稀有度的顏色
function plankIcon(tier, door) {
  const pk = PLANKS[tier], col = pk.color, edge = RARITY[pk.rar].color;
  const grain = tier === 1 ? '<path d="M8 12 Q18 10 28 12 M8 18 Q18 20 28 17 M8 24 Q18 22 28 25" stroke="#7a5532" stroke-width="1" fill="none"/>' : tier === 4 ? '<path d="M10 10 L16 18 L12 26 M20 9 L24 17 L21 27" stroke="#ff8a2a" stroke-width="1.6" fill="none"/>' : tier === 5 ? '<path d="M10 9 L16 15 M20 9 L27 16" stroke="#fff" stroke-width="1.4" opacity=".8"/>' : '';
  const knob = door ? '<circle cx="25" cy="18" r="1.6" fill="#e0b84a"/>' : '';
  return `<div class="ic r-${pk.rar}"><svg viewBox="0 0 36 36"><rect x="7" y="5" width="22" height="26" rx="1.5" fill="${col}" stroke="${edge}" stroke-width="1.6" ${tier === 5 ? 'fill-opacity=".45"' : ''}/>${grain}${knob}</svg></div>`;
}
const plankName = (tier, door) => (door ? (tier === 1 ? '木門' : PLANKS[tier].name.replace('板子', '門')) : PLANKS[tier].name);
const handBig = () => !!(G.hand && G.hand.k !== 'item');
const BLD_DIST = [0.8, 4];
// 轉的角度（度）：rx、ry、rz 是繞 X／Y／Z 轉了幾度；step 是一次轉幾度（設計師：XYZ 也要有分 15°、45°、90°）
function bld() { const b = G.bld || (G.bld = { axis: 'y', rx: 0, ry: 0, rz: 0, dist: 1.6, step: 90 }); if (!b.step || b.rx % 15) Object.assign(b, { step: 90, rx: 0, ry: 0, rz: 0 }); return b; }
const ROT_STEPS = [90, 45, 15];
function cycleStep() { if (!handBig()) return; const b = bld(); b.step = ROT_STEPS[(ROT_STEPS.indexOf(b.step) + 1) % ROT_STEPS.length]; Sound.play('click'); toast(`🔄 一次轉 ${b.step}°`); }
// 板子倒下來的角度（0 是直立、90 是躺平）：繞 X 或 Z 轉，取比較大的那個
const tiltOf = d => { const t = ((d % 180) + 180) % 180; return Math.min(t, 180 - t); };
const plankTilt = b => Math.max(tiltOf(b.rx), tiltOf(b.rz));
const asRoof = (h, b) => h.k === 'plank' && !h.door && plankTilt(b) >= 60;   // 倒到 60° 以上就是屋頂
function holdThing(h) {
  G.hand = h;
  if (h.k === 'plank') markPlank(h.tier);   // 燈泡圖鑑也記板子
  const b = bld(); b.rx = b.rz = 0; b.ry = 0; b.dist = h.k === 'furn' ? Math.max(1.4, Math.max(h.f.w, h.f.h) * 0.75 + 0.9) : 1.6;
  invDirty = true;
  if (!G.ev.buildTip && h.k !== 'item') {
    G.ev.buildTip = 1;
    toast(isTouch() ? '🧱 拿起來了！前面的預覽是綠色就放得下：「轉」轉方向（X／Y／Z 選軸，「角度」換一次轉 90°、45° 或 15°；板子繞 X 或 Z 倒下來就變屋頂）、「遠」「近」調位置、「放」放下。' : '🧱 拿起來了！前面的預覽是綠色就放得下：R 轉方向（X／Y／Z 選軸，V 換一次轉 90°、45° 或 15°；板子繞 X 或 Z 倒下來就變屋頂）、T／B 或滾輪調遠近、E 放下。', 'good');
  }
}
function setAxis(a) { if (!handBig()) return; bld().axis = a; Sound.play('click'); invDirty = true; }
function rotateHand() {
  if (!handBig()) return;
  const b = bld();
  if (G.hand.k === 'furn' && b.axis !== 'y') { toast('🛋️ 家具只能繞 Y 軸轉（不能倒放）。'); Sound.play('empty'); return; }
  if (G.hand.k === 'plank' && G.hand.door && b.axis !== 'y') { toast('🚪 門只能繞 Y 軸轉。'); Sound.play('empty'); return; }
  b['r' + b.axis] = (b['r' + b.axis] + b.step) % 360;
  Sound.play('click');
}
function nudgeDist(k) { if (!handBig()) return; const b = bld(); b.dist = clamp(b.dist + k * 0.4, BLD_DIST[0], BLD_DIST[1]); }
const SIDES = ['s', 'w', 'n', 'e'];
const rotSide = (s, n) => SIDES[(SIDES.indexOf(s || 's') + n) % 4];
// 預覽：拿著的東西會放在哪裡、放不放得下（reason 是放不下的原因）
function ghost4() {
  const h = G.hand;
  if (!h || h.k === 'item') return null;
  const p = G.p, b = bld(), fx = Math.cos(p.face), fy = Math.sin(p.face);
  const px = p.x + fx * b.dist, py = p.y + fy * b.dist;
  if (h.k === 'plank') {
    if (asRoof(h, b)) {
      // 躺平（倒到 60° 以上）：放在那一格的上方當屋頂；沒有完全躺平的話看起來斜斜的
      const x = Math.floor(px), y = Math.floor(py);
      const g = { kind: 'roof', x, y, ok: true, tilt: 90 - plankTilt(b), tax: tiltOf(b.rx) >= tiltOf(b.rz) ? 'x' : 'z' };
      const r = inMap(x, y) ? roomGrid[y][x] : null;
      if (!inMap(x, y) || tiles[y][x] !== 1) { g.ok = false; g.why = '屋頂要放在地板上方'; }
      else if (r && r.ceil) { g.ok = false; g.why = '這裡本來就有天花板了'; }
      else if (G.b4.roofs.has(x + ',' + y)) { g.ok = false; g.why = '這裡已經有屋頂了'; }
      return g;
    }
    // 直立的牆：一開始面對你（你往東西看，牆就是南北向）；繞 Y 轉 90 度換另一個方向，轉 15°、45° 就是斜放的牆
    const ang = (Math.abs(fx) >= Math.abs(fy) ? 90 : 0) + b.ry, lean = plankTilt(b);
    if (ang % 90) return ghostFree4(px, py, ang * Math.PI / 180, lean);
    let o = (ang / 90) % 2 ? 'v' : 'h';
    const x = o === 'v' ? Math.round(px) : Math.floor(px), y = o === 'v' ? Math.floor(py) : Math.round(py);
    const g = { kind: 'wall', o, x, y, ok: true, lean };
    const [ax, ay, bx, by] = o === 'v' ? [x - 1, y, x, y] : [x, y - 1, x, y];
    const fl = (tx, ty) => inMap(tx, ty) && tiles[ty][tx] !== 0;
    const fA = inMap(ax, ay) && furnGrid[ay][ax], fB = inMap(bx, by) && furnGrid[by][bx];
    if (!(o === 'v' ? x >= 1 && x < MAP_W : y >= 1 && y < MAP_H) || (!fl(ax, ay) && !fl(bx, by))) { g.ok = false; g.why = '這裡放不下'; }
    else if (!fl(ax, ay) || !fl(bx, by)) { g.ok = false; g.why = '這裡已經有牆了'; }
    else if (wallAt(o, x, y)) { g.ok = false; g.why = '這裡已經有板子了'; }
    else if (fA && fA === fB) { g.ok = false; g.why = '會穿過家具'; }
    else if (distToWall(p.x, p.y, { o, x, y }) < PLAYER_R + WALL_T + 0.02) { g.ok = false; g.why = '會卡到你自己，往後退一點（或按「遠」）'; }
    else if (G.enemies.some(e => !e.dead && distToWall(e.x, e.y, { o, x, y }) < ENEMY_R + WALL_T)) { g.ok = false; g.why = '有東西擋在那裡'; }
    return g;
  }
  // 家具：照轉的方向，整塊都要是空地
  // 家具：佔的格子照最接近的 90 度算，多出來的角度（15°、45°）只是擺得斜斜的
  const q = Math.round(b.ry / 90) % 4, f = h.f, rot = q % 2, w = rot ? f.h0 : f.w0, hh = rot ? f.w0 : f.h0;
  const x = Math.round(px - w / 2), y = Math.round(py - hh / 2);
  const g = { kind: 'furn', x, y, w, h: hh, side: rotSide(f.side0, q), yaw: b.ry - q * 90, ok: true };
  const solidF = f.solid !== false;
  for (let ty = y; ty < y + hh && g.ok; ty++) for (let tx = x; tx < x + w; tx++) {
    if (!inMap(tx, ty) || tiles[ty][tx] !== 1 || (solidF && isSolid(tx, ty))) { g.ok = false; g.why = '要放在空的地板上'; break; }
    if ([...G.sockets, ...G.lamps].some(o => o.x === tx && o.y === ty)) { g.ok = false; g.why = '那裡有燈'; break; }
    if (!solidF && FURN.some(o => o !== f && o.solid === false && !o.held && tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h)) { g.ok = false; g.why = '那裡已經有地毯了'; break; }
    if (tx + 1 < x + w && wallClosed(wallBetween(tx, ty, tx + 1, ty))) { g.ok = false; g.why = '會壓到板子'; break; }
    if (ty + 1 < y + hh && wallClosed(wallBetween(tx, ty, tx, ty + 1))) { g.ok = false; g.why = '會壓到板子'; break; }
  }
  if (g.ok && solidF) {
    const inRect = (ex, ey, r) => ex + r > x && ex - r < x + w && ey + r > y && ey - r < y + hh;
    if (inRect(p.x, p.y, PLAYER_R)) { g.ok = false; g.why = '會壓到你自己，往後退一點（或按「遠」）'; }
    else if (G.enemies.some(e => !e.dead && inRect(e.x, e.y, ENEMY_R))) { g.ok = false; g.why = '有東西擋在那裡'; }
  }
  return g;
}
// 斜放的牆的預覽：中心對齊半格，整片不能穿過牆、家具、別的板子，也不能卡到人
function ghostFree4(px, py, ang, lean) {
  const cx = Math.round(px * 2) / 2, cy = Math.round(py * 2) / 2, w = { free: true, cx, cy, ang };
  const g = { kind: 'free', cx, cy, ang, lean, ok: true };
  const bad = why => { g.ok = false; g.why = why; return g; };
  const [x0, y0, x1, y1] = wallEnds(w);
  let px0 = Math.floor(x0), py0 = Math.floor(y0);
  for (let k = 0; k <= 20; k++) {
    const sx = x0 + (x1 - x0) * k / 20, sy = y0 + (y1 - y0) * k / 20, tx = Math.floor(sx), ty = Math.floor(sy);
    if (!inMap(tx, ty) || tiles[ty][tx] === 0) return bad('會穿過牆');
    if (furnGrid[ty][tx]) return bad('會穿過家具');
    if (tx !== px0 || ty !== py0) { if (wallClosed(wallBetween(px0, py0, tx, py0)) || wallClosed(wallBetween(tx, py0, tx, ty))) return bad('會碰到別的板子'); px0 = tx; py0 = ty; }
  }
  for (const k of freeCells(w)) for (const o of G.b4.cells.get(k) || []) if (Math.hypot(o.cx - cx, o.cy - cy) < 0.4 || segHit4(wallEnds(o), [x0, y0, x1, y1])) return bad('這裡已經有板子了');
  if (distToWall(G.p.x, G.p.y, w) < PLAYER_R + WALL_T + 0.02) return bad('會卡到你自己，往後退一點（或按「遠」）');
  if (G.enemies.some(e => !e.dead && distToWall(e.x, e.y, w) < ENEMY_R + WALL_T)) return bad('有東西擋在那裡');
  return g;
}
// 兩條線段有沒有交叉
function segHit4([a, b, c, d], [e, f, g, h]) {
  const cr = (x1, y1, x2, y2, x3, y3) => (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  return cr(a, b, c, d, e, f) * cr(a, b, c, d, g, h) < 0 && cr(e, f, g, h, a, b) * cr(e, f, g, h, c, d) < 0;
}
// 放下手上的板子或家具
function place4() {
  const h = G.hand;
  if (!h || h.k === 'item') return;
  const g = ghost4();
  if (!g || !g.ok) { toast('🧱 ' + ((g && g.why) || '這裡放不下') + '。'); Sound.play('empty'); return; }
  if (g.kind === 'wall' || g.kind === 'free') {
    const base = { tier: h.tier, hp: h.hp ?? PLANKS[h.tier].hp, door: !!h.door, open: false, lean: g.lean || 0 };
    setWall(g.kind === 'free' ? { free: true, cx: g.cx, cy: g.cy, ang: g.ang, ...base } : { o: g.o, x: g.x, y: g.y, ...base });
    Sound.play('plank'); makeNoise(4);
    if (!G.home) { setHome4(true); }
    if (!G.ev.wallTip) { G.ev.wallTip = 1; toast('🧱 放好第一片牆了！怪物打得破板子（玻璃打不破）；圍起來的地方就是你的家。對著自己的板子按住 E 可以再拿起來。', 'good'); }
  } else if (g.kind === 'roof') {
    G.b4.roofs.set(g.x + ',' + g.y, { x: g.x, y: g.y, tier: h.tier, hp: h.hp ?? PLANKS[h.tier].hp, tilt: g.tilt || 0, tax: g.tax });
    G.b4.ver++;
    Sound.play('plank'); makeNoise(4);
    if (!G.ev.roofTip4) { G.ev.roofTip4 = 1; toast('🏠 屋頂放好了！站在屋頂底下，酸雨和燼皇的燼雨都淋不到你。', 'good'); }
  } else {
    const f = h.f;
    Object.assign(f, { x: g.x, y: g.y, w: g.w, h: g.h, side: g.side, yaw: g.yaw || 0 });
    addFurn4(f);
    Sound.play('place'); makeNoise(3);
  }
  G.hand = null; invDirty = true;
}
// 把家具從地圖上拿起來（櫃子裡的東西跟著一起搬）／放回地圖上
function liftFurn4(f) {
  f.held = true;
  f.w0 = f.w; f.h0 = f.h; f.side0 = f.side || 's';   // 拿起來的時候的方向當 0 度
  for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) if (furnGrid[y][x] === f) { furnGrid[y][x] = null; solid[y][x] = tiles[y][x] === 0; }
  b4Changed();
  if (window.Renderer && Renderer.furn4) Renderer.furn4(f);
}
function addFurn4(f) {
  f.held = false;
  f.room = roomGrid[f.y][f.x];
  if (f.solid !== false) for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) { furnGrid[y][x] = f; solid[y][x] = true; }
  b4Changed();
  if (window.Renderer && Renderer.furn4) Renderer.furn4(f);
}
// 把牆或屋頂拿起來
function takeWall4(w) {
  if (G.hand) { toast('✋ 手上已經拿著東西了。'); return; }
  removeWall(w);
  holdThing({ k: 'plank', tier: w.tier, door: w.door, hp: w.hp });
  Sound.play('pickup');
}
function takeRoof4(r) {
  if (G.hand) { toast('✋ 手上已經拿著東西了。'); return; }
  G.b4.roofs.delete(r.x + ',' + r.y); G.b4.ver++;
  holdThing({ k: 'plank', tier: r.tier, hp: r.hp });
  bld().rx = 90;   // 拿下來的屋頂還是躺平的
  Sound.play('pickup');
}
function takeFurn4(f) {
  if (G.hand) { toast('✋ 手上已經拿著東西了。'); return; }
  liftFurn4(f);
  holdThing({ k: 'furn', f });
  Sound.play('pickup');
  if (G.containers[f.id] && G.containers[f.id].items.length && !G.ev.carryTip) { G.ev.carryTip = 1; toast('📦 櫃子裡的東西會跟著一起搬。'); }
}
// 對著自己面前的牆（看得到的第一片），最遠 1.8 公尺
function facingWall4(maxD = 1.8) {
  if (!G.b4.n) return null;
  const p = G.p, dx = Math.cos(p.face), dy = Math.sin(p.face);
  let px = Math.floor(p.x), py = Math.floor(p.y);
  for (let d = 0.1; d < maxD; d += 0.08) {
    const sx = p.x + dx * d, sy = p.y + dy * d;
    if (G.b4.cells.size) for (const w of G.b4.cells.get(Math.floor(sx) + ',' + Math.floor(sy)) || []) if (distToWall(sx, sy, w) < 0.12) return w;
    const tx = Math.floor(sx), ty = Math.floor(sy);
    if (tx === px && ty === py) continue;
    if (tx !== px && ty !== py) {
      const w = wallBetween(px, py, tx, py) || wallBetween(tx, py, tx, ty);
      if (w) return w;
    } else { const w = wallBetween(px, py, tx, ty); if (w) return w; }
    if (isWall(tx, ty)) return null;
    px = tx; py = ty;
  }
  return null;
}

// ====================================================================
// 板材堆、地上的板子：每天早上補一點。板子不能放進背包，一次拿一片
// ====================================================================
function refillPiles4(first) {
  for (const f of FURN) {
    if (f.type !== 'plankpile') continue;
    const max = f.tier === 1 ? 6 : f.tier === 2 ? 3 : 2;
    f.count = first ? max : Math.min(max, (f.count || 0) + (f.tier === 1 ? randi(2, 4) : randi(0, 1) + (Math.random() < 0.5 ? 1 : 0)));
  }
}
function takeFromPile4(f) {
  if (G.hand) { toast('✋ 手上已經拿著東西了，先放下來。'); return; }
  if (!(f.count > 0)) { toast(`${PLANKS[f.tier].name}堆空了，明天早上會再補。`); Sound.play('empty'); return; }
  f.count--;
  holdThing({ k: 'plank', tier: f.tier });
  if (f.special && !f.count) { FURN.splice(FURN.indexOf(f), 1); furnGrid[f.y][f.x] = null; solid[f.y][f.x] = false; b4Changed(); if (Renderer.furn4) Renderer.furn4(f, true); }
  Sound.play('pickup');
  if (G.tutorial4 === 1) G.tutorial4 = 2;
}
function dropLoose4(x, y, k) {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2, r = i ? rand(0.3, 1.4) : 0, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (walkable(px, py)) { G.loose4.push({ x: px, y: py, a: Math.random() * Math.PI, ...k }); return; }
  }
  G.loose4.push({ x, y, a: 0, ...k });
}
function takeLoose4(l) {
  if (G.hand) { toast('✋ 手上已經拿著東西了，先放下來。'); return; }
  G.loose4.splice(G.loose4.indexOf(l), 1);
  holdThing({ k: 'plank', tier: l.tier, door: l.door });
  Sound.play('pickup');
}

// ====================================================================
// 背包 16 格（一種東西一格），手上另外可以拿 1 個（第 17 個，照設計圖說的 bug）
// ====================================================================
const bagUsed = () => invList().length;
const bagFull = () => isW4() && bagUsed() >= BAG_SLOTS;
// 這樣東西放不放得進背包（已經有的一定放得進去；新的一種要有空格，或手上空著）
const bagFits = id => !isW4() || id === 'coin' || !!G.inv[id] || bagUsed() < BAG_SLOTS || !G.hand;
// 背包有空格了：手上的小東西自動收進去
function settleHand4() {
  const h = G.hand;
  if (h && h.k === 'item' && (bagUsed() < BAG_SLOTS || G.inv[h.id])) { G.hand = null; addItem(h.id, h.n); invDirty = true; }
}
// 選中的東西放在地上（空出背包的格子）：放在前面的地上，是真的東西，看著它按 E 就能再撿起來
function dropSelected4(all = true) {
  const id = G.selId;
  if (!id || !G.inv[id]) return;
  const n = all ? G.inv[id] : 1, p = G.p;
  removeItem(id, n);
  // 放在前面的地上（前面擋住了就放近一點，再不行就放在腳邊）
  let x = p.x, y = p.y;
  for (const r of [0.7, 0.45, 0.25]) { const tx = p.x + Math.cos(p.face) * r, ty = p.y + Math.sin(p.face) * r; if (walkable(tx, ty)) { x = tx; y = ty; break; } }
  G.pickups.push({ x, y, id, n, t: 0, keep: 1, a: p.face + Math.PI + rand(-0.3, 0.3) });
  Sound.play('place');
  toast(`把${itemName(id)}${n > 1 ? ` ×${n}` : ''}放在地上了（看著它按 E 可以再拿起來）。`);
}

// ====================================================================
// 真的東西擺在架上（設計師：食物框上就是食物、東西就直接是實體，不要只能看光尋找）：
// 倉儲貨架、雜貨架、燈具架、熱食櫃台、飲料機、冷藏櫃（DISPLAY4）的物資一個一個擺在架上的固定位置（shelfSlots4），
// 看著它按 E 拿起來；每天早上補貨。擺在架上的東西是 G.pickups 裡有 s（架子的 id）、si（第幾個位置）、z（高度）的那些
// ====================================================================
function shelfSlots4(f) {
  if (f._slots) return f._slots;
  const side = f.side || 's', ns = side === 's' || side === 'n', len = ns ? f.w : f.h, dep = ns ? f.h : f.w;
  const at = (u, v) => (side === 's' ? [f.x + u, f.y + f.h - v] : side === 'n' ? [f.x + u, f.y + v] : side === 'e' ? [f.x + f.w - v, f.y + u] : [f.x + v, f.y + u]);
  const out = { s: Math.PI / 2, n: -Math.PI / 2, e: 0, w: Math.PI }[side];   // 正面朝外的方向
  const slots = [];
  const row = (h, v, gap, back = false) => {
    const n = Math.max(1, Math.floor((len - 0.3) / gap));
    for (let i = 0; i < n; i++) { const [x, y] = at(0.15 + (i + 0.5) * (len - 0.3) / n, v); slots.push({ x, y, h, a: back ? out + Math.PI : out }); }
  };
  switch (f.type) {
    case 'goods4': for (const y of GOODS4_LEVELS.slice(1, 4)) { row(y + 0.025, 0.24, 0.42); row(y + 0.025, dep - 0.24, 0.42, true); } break;
    case 'rack4': row(RACK4_LEVELS[1] + 0.13, 0.45, 0.6); break;
    case 'lampshelf': for (const y of LAMPSHELF4_LEVELS) row(y + 0.03, dep - 0.27, 0.55); break;
    case 'foodcounter': row(0.96, 0.42, 0.45); break;
    case 'drink4': row(0.45, dep - 0.74, 0.3); break;
    case 'coldcase': for (const y of [0.2, 0.62, 1.04, 1.46]) row(y + 0.02, dep - 0.45, 0.32); break;
  }
  return (f._slots = slots);
}
// 每天早上補貨：每個架子補到大約三～四成滿（第 1 天多一點）
function stockShelves4(first) {
  const on = new Map();
  for (const pk of G.pickups) if (pk.s) { if (!on.has(pk.s)) on.set(pk.s, new Set()); on.get(pk.s).add(pk.si); }
  for (const f of FURN) {
    if (!DISPLAY4[f.type] || !f.loot) continue;
    const slots = shelfSlots4(f), used = on.get(f.id) || new Set();
    const target = Math.round(slots.length * (first ? 0.45 : 0.32) * Math.min(1.3, D().items));
    const free = slots.map((_, i) => i).filter(i => !used.has(i));
    for (let k = used.size; k < target && free.length; k++) {
      const si = free.splice(Math.floor(Math.random() * free.length), 1)[0], sl = slots[si];
      const id = rollItem(f.loot, f.room ? f.room.level : 1, G.day);
      G.pickups.push({ x: sl.x, y: sl.y, z: sl.h, a: sl.a, id, n: LOOT_QTY[id] || 1, s: f.id, si, keep: 1, t: Math.random() * 6 });
    }
  }
}
// 看著的東西（地上或架上，2.2 公尺內，看得到的方向）：回傳 { pk, ang, d }
function lookedPickup4() {
  const p = G.p, eye = (p.crouch ? 0.95 : 1.5) + (p.z || 0);
  const cp = Math.cos(p.pitch || 0), lx = Math.cos(p.face) * cp, ly = Math.sin(p.face) * cp, lz = Math.sin(p.pitch || 0);
  let best = null;
  for (const pk of G.pickups) {
    if (pk.id === 'coin' && !pk.s) continue;   // 地上的硬幣走過去就撿
    const dx = pk.x - p.x, dy = pk.y - p.y, dz = (pk.z || 0) + 0.1 - eye, d = Math.hypot(dx, dy, dz);
    if (d > 2.3 || Math.hypot(dx, dy) > 2.0) continue;
    let ang = Math.acos(clamp((dx * lx + dy * ly + dz * lz) / Math.max(d, 0.01), -1, 1));
    if (Math.hypot(dx, dy) < 0.4 && lz < -0.8) ang = Math.min(ang, 0.15);   // 就在腳邊：低頭看就拿得到
    if (ang > Math.max(0.16, 0.34 / d)) continue;
    if (!best || ang + d * 0.05 < best.ang + best.d * 0.05) best = { pk, ang, d };
  }
  return best;
}
function takePickup4(pk) {
  if (!G.pickups.includes(pk)) return;
  if (!bagFits(pk.id)) { toast(`🎒 背包滿了（${BAG_SLOTS} 格），手上也拿著東西，拿不下${itemName(pk.id)}。`, 'warn'); Sound.play('empty'); return; }
  G.pickups.splice(G.pickups.indexOf(pk), 1);
  const got = gainItem(pk.id, pk.n);
  if (!got.length) { G.pickups.push(pk); return; }
  Sound.play('pickup');
  if (pk.s) G.stats.searched++;
  toast('拿到了' + got.map(([id, n]) => itemName(id) + (n > 1 ? ' ×' + n : '')).join('、'), 'item');
  for (const [id] of got) if (ITEMS[id] && ITEMS[id].kind === 'bulb') showBulbCard(ITEMS[id].tier);
}

// ====================================================================
// 櫃子（收納）：家具裡的東西可以拿出來，背包的東西也可以放進去（背包只有 16 格，家裡的櫃子很重要）
// ====================================================================
const STORE_MAX = 12;
// 櫃子裡的一格：搜到的物資是 'id'（數量照 LOOT_QTY），自己放進去的是 'id:數量'
const storeEntry = e => { const i = e.indexOf(':'); return i < 0 ? [e, LOOT_QTY[e] || 1] : [e.slice(0, i), +e.slice(i + 1)]; };
function openStore4(f) {
  const c = G.containers[f.id] || (G.containers[f.id] = { items: [] });
  makeNoise(3);
  if (c.items.length) G.stats.searched++;
  const name = f.name || '櫃子';
  openModal(`📦 ${name}`, () => {
    const grouped = {};
    for (const e of c.items) { const [id, n] = storeEntry(e); grouped[id] = (grouped[id] || 0) + n; }
    const inside = Object.entries(grouped).map(([id, n]) => `<div class="shopcard">${icBox(id)}<div class="nm">${itemName(id)}${n > 1 ? ' ×' + n : ''}</div>${rarityTag(id)}<button data-act="take:${id}" ${bagFits(id) ? '' : 'disabled'}>拿出來</button></div>`).join('') || '<p class="hint">裡面是空的。</p>';
    const bag = invList().map(id => `<div class="shopcard">${icBox(id)}<div class="nm">${itemName(id)}${G.inv[id] > 1 ? ' ×' + G.inv[id] : ''}</div><button data-act="put:${id}" ${c.items.length < STORE_MAX ? '' : 'disabled'}>放進去</button></div>`).join('');
    const move = f.move ? `<div class="btns"><button data-act="lift">✋ 把${name}拿起來搬走</button></div>` : '';
    return `<p class="hint">${name}裡面（${c.items.length}/${STORE_MAX}）：</p><div class="shop">${inside}</div>` +
      `<p class="hint">🎒 你的背包（${bagUsed()}/${BAG_SLOTS}）：</p><div class="shop">${bag}</div>${move}`;
  }, act => {
    const [a, id] = act.split(':');
    if (a === 'take') {
      const i = c.items.findIndex(e => storeEntry(e)[0] === id);
      if (i < 0 || !bagFits(id)) return;
      const [, n] = storeEntry(c.items[i]);
      c.items.splice(i, 1);
      const got = gainItem(id, n);
      for (const [gid] of got) if (ITEMS[gid] && ITEMS[gid].kind === 'bulb') showBulbCard(ITEMS[gid].tier);
      Sound.play('pickup');
    } else if (a === 'put') {
      if (!G.inv[id] || c.items.length >= STORE_MAX) return;
      const n = G.inv[id];
      removeItem(id, n); c.items.push(`${id}:${n}`);
      Sound.play('place');
    } else if (a === 'lift') {
      closeModal();
      takeFurn4(f);
    }
  });
}

// ====================================================================
// 家（據點）：📍 記錄位置；第一次放板子時自動記在那裡。早晨禮物放在家裡、黑球只吃家裡的燈、Hubert 和紅涎偽人會去找你的家
// ====================================================================
function setHome4(auto) {
  const p = G.p;
  G.home = { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 };
  Sound.play(auto ? 'click' : 'install');
  toast(auto ? '📍 這裡記成你的家了（之後可以按 📍 記錄位置換地方）。早晨禮物會放在家裡。' : `📍 記住了！你的家在「${zoneName(p.x, p.y)}」。早晨禮物會放在這裡，狀態列會告訴你家在哪個方向。`, 'good');
}
const HOME_R = 9;   // 據點的範圍：家附近幾格內的燈算「據點的燈」
const nearHome4 = (x, y, r = HOME_R) => !!G.home && Math.hypot(x - G.home.x, y - G.home.y) < r;
// 家在哪個方向（狀態列用）：「左前方 18 公尺」
function homeDir4() {
  const h = G.home, p = G.p;
  if (!h) return '';
  const d = Math.hypot(h.x - p.x, h.y - p.y);
  if (d < 3) return '';
  let a = Math.atan2(h.y - p.y, h.x - p.x) - p.face;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  const dir = Math.abs(a) < 0.4 ? '正前方' : Math.abs(a) > 2.7 ? '後面' : a > 0 ? (a < 1.2 ? '右前方' : a < 2.0 ? '右邊' : '右後方') : (a > -1.2 ? '左前方' : a > -2.0 ? '左邊' : '左後方');
  return `🏠 家在${dir} ${Math.round(d)} 公尺`;
}

// ====================================================================
// 互動（game.js 的 getTarget 會呼叫）：拿著東西時 E 就是放下；空手時對著板子、板材堆、家具
// 家具同一顆 E：點一下是用它（打開櫃子、睡覺、丟燃料、開電視），按住是拿起來搬走（tap 和 hold 兩個動作）
// ====================================================================
function addTargets4(cands) {
  const p = G.p;
  if (handBig()) {
    const h = G.hand, g = ghost4(), name = h.k === 'plank' ? plankName(h.tier, h.door) + (asRoof(h, bld()) ? '（屋頂）' : '') : h.f.name;
    cands.push({ d: -9, id: 'place4', label: `放下${name}`, sub: g && g.ok ? '綠色的預覽就是放下的位置' : `❌ ${(g && g.why) || '這裡放不下'}`, hold: 0, action: place4 });
    return;
  }
  const look = (cx, cy, rd, max) => rd <= max && (rd < 0.5 || lookAngle(cx, cy) < 1.0);
  // 自己蓋的牆、門
  const w = facingWall4();
  if (w) {
    const [x0, y0, x1, y1] = wallEnds(w), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rd = distToWall(p.x, p.y, w);
    const hp = w.tier === GLASS_TIER ? '打不破' : `耐打 ${Math.ceil(w.hp)}/${PLANKS[w.tier].hp}`;
    if (w.door) cands.push({ d: rd - 0.4, id: `wall4:${w.o}${w.x},${w.y}`, label: w.open ? `關上${plankName(w.tier, true)}` : `打開${plankName(w.tier, true)}`, sub: `按住 E：拿起來（${hp}）`, hold: 0.6, tap: () => toggleDoor4(w), action: () => takeWall4(w) });
    else cands.push({ d: rd - 0.4, id: `wall4:${w.o}${w.x},${w.y}`, label: `拿起${plankName(w.tier)}`, sub: `按住 E（${hp}）`, hold: 0.45, action: () => takeWall4(w) });
    void cx; void cy;
  }
  // 頭上的屋頂：抬頭看
  const rf = G.b4.roofs.get(Math.floor(p.x) + ',' + Math.floor(p.y));
  if (rf && p.pitch > 0.35) cands.push({ d: 0.2, id: 'roof4', label: `拿起屋頂的${PLANKS[rf.tier].name}`, sub: '按住 E', hold: 0.45, action: () => takeRoof4(rf) });
  // 地上的板子
  for (const l of G.loose4) {
    const rd = Math.hypot(l.x - p.x, l.y - p.y);
    if (look(l.x, l.y, rd, 1.3)) cands.push({ d: rd - 0.3, id: 'loose4', label: `撿起${plankName(l.tier, l.door)}`, sub: '板子不能放進背包，一次拿一片', hold: 0, action: () => takeLoose4(l) });
  }
  // 看著的東西（架上或地上）：按 E 拿起來
  const lp = lookedPickup4();
  if (lp) cands.push({ d: lp.ang * 2 + lp.d * 0.15 - 0.8, id: 'pk4', label: `拿起${itemName(lp.pk.id)}${lp.pk.n > 1 ? ' ×' + lp.pk.n : ''}`, sub: bagFits(lp.pk.id) ? `🎒 ${bagUsed()}/${BAG_SLOTS}` : '🎒 背包滿了', hold: 0, action: () => takePickup4(lp.pk) });
  for (const f of FURN) {
    if (f.held) continue;
    const rd = rectDist(p.x, p.y, f);
    if (rd > 1.25) continue;
    const a = Math.min(lookAngle(clamp(p.x, f.x, f.x + f.w), clamp(p.y, f.y, f.y + f.h)), lookAngle(f.x + f.w / 2, f.y + f.h / 2));
    if (a > 1.0 && rd > 0.35) continue;
    const d = rd + a * 0.9, spec = FURN4[f.type] || {};
    if (f.type === 'plankpile') { cands.push({ d: d - 0.2, id: 'pile:' + f.id, label: `拿一片${PLANKS[f.tier].name}`, sub: `${PLANKS[f.tier].name}堆：剩 ${f.count || 0} 片`, hold: 0, action: () => takeFromPile4(f) }); continue; }
    if (!f.move) continue;   // 搬不動的家具（櫃台、貨架）照 game.js 原本的搜索
    const lift = () => takeFurn4(f), sub = '按住 E：拿起來搬走';
    if (spec.store) cands.push({ d, id: 'f4:' + f.id, label: `打開${f.name}`, sub, hold: 0.6, tap: () => openStore4(f), action: lift });
    else if (FURN_LIE[f.type] && !airborne(p)) cands.push({ d, id: 'f4:' + f.id, label: '躺下（點一下）', sub: (G.phase === 'day' && G.t < DAY_LEN - 25 ? '躺著按住 E 睡到傍晚・' : '') + sub, hold: 0.6, tap: () => lieDown(f), action: lift });
    else if (FURN_SIT[f.type] && seatSpots(f).length && !airborne(p)) cands.push({ d, id: 'f4:' + f.id, label: '坐下（點一下）', sub, hold: 0.6, tap: () => sitDown(f), action: lift });
    else if (spec.fn === 'fire') {
      const sel = G.selId && ITEMS[G.selId].kind === 'fuel' ? G.selId : worstFuel(), left = Math.round((f.fuel || []).reduce((s, q) => s + q.left, 0));
      cands.push({ d, id: 'f4:' + f.id, label: sel ? `丟${ITEMS[sel].name}進火爐` : `火爐：還能燒 ${left} 秒`, sub: (sel ? `還能燒 ${left} 秒・` : '背包裡沒有木柴或煤炭・') + sub, hold: 0.6, tap: () => sel && fuelFire4(f, sel), action: lift });
    } else if (spec.fn === 'tv') cands.push({ d, id: 'f4:' + f.id, label: f.on ? '關掉電視' : '打開電視', sub, hold: 0.6, tap: () => { f.on = !f.on; Sound.play(f.on ? 'tvOn' : 'click'); }, action: lift });
    else cands.push({ d, id: 'f4:' + f.id, label: `拿起${f.name}`, sub: `按住 E${f.solid === false ? '' : '（可以搬回家，讓家更溫馨）'}`, hold: 0.6, action: lift });
  }
}
function toggleDoor4(w) {
  if (w.open && G.enemies.some(e => !e.dead && distToWall(e.x, e.y, w) < 0.45)) { toast('門口有東西擋著，關不起來。'); return; }
  if (w.open && distToWall(G.p.x, G.p.y, w) < PLAYER_R + WALL_T) { toast('你站在門口，關不起來。'); return; }
  w.open = !w.open;
  b4Changed();
  Sound.play(w.open ? 'click' : 'doorSlam', 0.5);
  if (w.open) mimicDoorOpened4(w);
}

// ====================================================================
// 燈泡全變檯燈：賣場沒有天花板燈座，物品欄裡的「燈泡」在第四世界就是一整盞檯燈，選它按 Q 就放在前面
// ====================================================================
function useBulb4(tier) {
  const fx = nearestFixture();
  if (fx && fx.bulb !== tier) { installBulb(fx, tier); return; }
  const t = lampTile();
  if (!t) { toast('這裡放不下檯燈。'); return; }
  const o = { kind: 'lamp', type: 'desk', x: t.x, y: t.y, room: roomGrid[t.y][t.x], bulb: tier, dying: 0, free: true };
  G.lamps.push(o);
  removeItem('bulb' + tier);
  Sound.play('install');
  toast(`💡 放下了${bulbName(tier)}。對著它按 E 可以拿起來。`, 'good');
}

// ====================================================================
// 火爐（可以搬回家的家具）：丟木柴、煤炭進去燒，會發光、3 格內回體溫（抵禦寒寂之境）
// ====================================================================
const FIRE4_SLOTS = 4;
const fireLeft4 = f => (f.fuel || []).reduce((s, q) => s + q.left, 0);
function fuelFire4(f, id) {
  const it = ITEMS[id];
  if (!it || it.kind !== 'fuel' || !G.inv[id]) return;
  f.fuel = f.fuel || [];
  if (f.fuel.length >= FIRE4_SLOTS) { toast(`🔥 火爐已經放了 ${FIRE4_SLOTS} 份燃料，燒完才能再放。`, 'warn'); Sound.play('empty'); return; }
  removeItem(id);
  f.fuel.push({ id, left: it.burn });
  Sound.play('fuelIn'); makeNoise(3);
  toast(`🔥 把${itemName(id)}丟進了火爐（還能燒 ${Math.round(fireLeft4(f))} 秒）。火爐 3 格內很溫暖。`, 'good');
}
const burningFires4 = () => FURN.filter(f => f.type === 'fireplace4' && !f.held && f.fuel && f.fuel.length);
function updateFires4(dt) {
  for (const f of burningFires4()) {
    f.fuel[0].left -= dt;
    if (f.fuel[0].left <= 0) { f.fuel.shift(); if (!f.fuel.length && nearHome4(f.x + 1, f.y + 0.5, 12)) toast('🔥 家裡的火爐熄了。', 'warn'); }
  }
}
function addLights4(L) {
  for (const f of burningFires4()) L.push({ x: f.x + f.w / 2, y: f.y + f.h / 2, r: 3.6, tier: 0, room: f.room, f: 0.85 + Math.random() * 0.15, color: [255, 140, 50], fire: true });
  if (G.power) for (const f of FURN) if (f.type === 'tv4' && f.on && !f.held) L.push({ x: f.x + f.w / 2, y: f.y + f.h / 2, r: 2.4, tier: 0, room: f.room, f: 0.5 + Math.random() * 0.3, color: [150, 180, 255], tv: true });
  let n = 0;
  for (const w of G.b4.list) {
    if (w.tier !== LAVA_TIER || n >= 8) continue;
    n++;
    const [x0, y0, x1, y1] = wallEnds(w), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const nx = w.free ? -Math.sin(w.ang) * 0.3 : w.o === 'h' ? 0 : 0.3, ny = w.free ? Math.cos(w.ang) * 0.3 : w.o === 'h' ? 0.3 : 0;
    for (const s of [-1, 1]) L.push({ x: cx + nx * s, y: cy + ny * s, r: 1.9, tier: 0, room: null, f: 0.55 + 0.1 * Math.sin(G.time * 2 + w.x), color: [255, 110, 40], fire: true });
  }
}
// 寒寂之境的熱源：火爐（3 格內 +3）、岩漿板子（2 格內 +1.5）
function heat4(x, y) {
  let h = 0;
  for (const f of burningFires4()) if (Math.hypot(f.x + f.w / 2 - x, f.y + f.h / 2 - y) < 3) h += 3;
  for (const w of G.b4.list) if (w.tier === LAVA_TIER && distToWall(x, y, w) < 2) { h += 1.5; break; }
  return h;
}

// ====================================================================
// 怪物打牆：路上擋著牆（尋路時記下的 e.wallAhead），走到牆前面就一直打，打到壞掉為止。玻璃打不破
// ====================================================================
const BASH4 = { staff: 7, mimic: 3, tyrant: 14, warlord: 9, kronos: 4, tall: 10, woman: 4, clown: 5, momo: 5, snail: 3, girl: 4, grass: 3, shake: 1.5, ember: 6, shadow: 3 };
function bash4(e, dt) {
  const w = e.wallAhead;
  if (!w || !wallClosed(w) || w.tier === GLASS_TIER || e.spawn > 0 || e.stunT > 0) return;
  if (distToWall(e.x, e.y, w) > ENEMY_R + 0.3) return;
  const k = BASH4[e.kind];
  if (!k) return;
  e.bashing = 0.3;
  damageWall4(w, k * dt * (e.lv ? 0.85 + e.lv * 0.05 : 1), e, dt);
}
function damageWall4(w, amt, e, dt = 0) {
  if (w.tier === GLASS_TIER) return;
  w.hp -= amt; w.hitT = 0.25;
  if (e && w.tier === LAVA_TIER && dt) { hurtMonster(e, 1.2 * dt, 'lava'); if (Math.random() < dt * 8) G.fx.push({ type: 'ember', x: e.x, y: e.y, h: rand(0.5, 1.6), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), vh: rand(0.3, 1), life: 0.5, max: 0.5, color: pick(EMBER_COLORS) }); }
  w.sndT = (w.sndT || 0) - (dt || 0.3);
  if (w.sndT <= 0) {
    w.sndT = 0.55;
    const d = Math.hypot((w.x + 0.5) - G.p.x, (w.y + 0.5) - G.p.y);
    Sound.play('wallHit', nearVol(d)); if (d < 4) G.shake = Math.max(G.shake, 0.08);
    if (!w.warned && nearHome4(w.x, w.y, HOME_R + 3)) { w.warned = true; toast(`🔨 有東西在打你家的${plankName(w.tier, w.door)}！（耐打 ${Math.max(0, Math.ceil(w.hp))}/${PLANKS[w.tier].hp}）`, 'warn'); }
  }
  if (w.hp <= 0) breakWall4(w, e);
}
function breakWall4(w, e) {
  removeWall(w);
  const [x0, y0, x1, y1] = wallEnds(w), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  puff(cx, cy, w.tier === 2 ? [225, 220, 210] : w.tier === 3 ? [230, 190, 80] : w.tier === 4 ? [80, 40, 30] : [150, 110, 70], 18, 1.2);
  for (let i = 0; i < 12; i++) G.fx.push({ type: 'spark', x: cx, y: cy, h: rand(0.3, 2.2), vx: rand(-2, 2), vy: rand(-2, 2), vh: rand(-0.5, 1.5), life: 0.6, max: 0.6, color: w.tier === 4 ? pick(EMBER_COLORS) : [210, 180, 140] });
  Sound.play('plankBreak', nearVol(Math.hypot(cx - G.p.x, cy - G.p.y)));
  const who = e && e.kind ? MONSTER_NAME[e.kind] : '';
  if (nearHome4(cx, cy, HOME_R + 3) || Math.hypot(cx - G.p.x, cy - G.p.y) < 10) toast(`💥 你家的${plankName(w.tier, w.door)}被${who || '打'}破了！`, 'warn');
}

// ====================================================================
// 每天早上、天黑：日光燈、打烊廣播、神秘店員換位置（要自己去找）、板材堆補貨、禮物放在家裡
// ====================================================================
function startDay4(d) {
  G.cold = !!G.forceCold || COLD_DAYS_W4.includes(d);
  G.acid = null; G.acidT = 0;
  refillPiles4(d === 1);
  stockShelves4(d === 1);
  // 偶爾出現的特別板材堆：岩漿（傳說）或玻璃（神話），只有 1 片
  if (d >= 3 && Math.random() < 0.4) {
    const sp = randomSpot4(14);
    if (sp) {
      const tier = Math.random() < 0.3 ? GLASS_TIER : LAVA_TIER, f = { id: 'pile_sp' + d, type: 'plankpile', name: '板材堆', x: Math.floor(sp.x), y: Math.floor(sp.y), w: 1, h: 1, tier, count: 1, special: true };
      FURN.push(f); FURN_BY_ID[f.id] = f; addFurn4(f);
      toast(`✨ 聽說「${zoneName(f.x, f.y)}」出現了一片${PLANKS[tier].name}（${RARITY[PLANKS[tier].rar].name}）！`, 'good');
    }
  }
  // 神秘店員：每天出現在不同的地方，要自己去找（小地圖不會標，走到他附近看到之後才會標）
  const m = randomSpot4(16);
  if (m) Object.assign(MERCHANT_POS, m);
  G.merchantSeen = false; G.ev.bellT = 3;
  // 早晨禮物放在家裡；還沒有家就放在你旁邊
  const gp = G.home || { x: G.p.x + Math.cos(G.p.face) * 1.2, y: G.p.y + Math.sin(G.p.face) * 1.2 };
  Object.assign(GIFT_POS, walkable(gp.x, gp.y) ? gp : { x: G.p.x, y: G.p.y });
  for (const e of G.enemies) puff(e.x, e.y);
  G.enemies = [];
  spawnIdleStaff4();
  const wx = (G.wx4 && G.wx4.acid || []).find(a => a.day === d);
  if (wx) G.acid = { ...wx, started: false };
  if (G.cold) toast('❄️ 寒寂之境：今天整天下雪（雪從賣場的天花板飄下來），體溫歸零就會死。把火爐搬回家、丟木柴或煤炭進去燒，待在家裡也比較暖。', 'warn');
}
// 禮物準備好之後：第四世界的禮物另外附板子（表現越好板子越好），放在禮物旁邊的地上
function afterPrepare4() {
  const g = G.gift;
  if (!g) return;
  const score = Math.min(3, Math.floor(g.kills / 3)) + (g.caught === 0 ? 2 : g.caught <= 2 ? 1 : 0);
  const tiers = [1];
  if (score >= 2) tiers.push(score >= 4 ? 3 : 2);
  if (score >= 5 && Math.random() < 0.35) tiers.push(Math.random() < 0.4 ? GLASS_TIER : LAVA_TIER);
  for (const t of tiers) dropLoose4(GIFT_POS.x, GIFT_POS.y, { k: 'plank', tier: t });
  // 表現很好：手電筒升一級、大白燈（整局最多 2 顆）
  if (score >= 4 && (G.p.flashLv || 1) >= 3 && (G.p.flashLv || 1) < FLASH_MAX && Math.random() < 0.3) g.items.push(['flash' + ((G.p.flashLv || 1) + 1), 1]);
  if (score >= 5 && (G.baymaxGot || 0) < BAYMAX_MAX && Math.random() < 0.2) g.items.push(['bulb' + BAYMAX_TIER, 1]);
}
// 賣場裡一個空的地方（離你至少 minD 格、四周也是空地、不在樣品間和小房間裡）
function randomSpot4(minD = 10) {
  for (let i = 0; i < 200; i++) {
    const x = 1 + Math.floor(Math.random() * (MAP_W - 2)), y = 1 + Math.floor(Math.random() * (MAP_H - 2));
    if (Math.hypot(x + 0.5 - G.p.x, y + 0.5 - G.p.y) < minD) continue;
    let ok = roomGrid[y][x] && roomGrid[y][x].id === 'store';
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!walkable(x + dx + 0.5, y + dy + 0.5)) { ok = false; break; }
    const z = zoneAt(x, y);
    if (!ok || (z && (z.cube || z.aisle))) continue;
    if (nearHome4(x, y, 6)) continue;
    return { x: x + 0.5, y: y + 0.5 };
  }
  return null;
}
function startNight4() {
  Sound.play('lightsOff');
  toast('📢 賣場的燈全部熄了……廣播：「本店已經打烊，請離開。」穿黃色制服的店員們醒過來了。', 'warn');
  for (const e of G.enemies) if (e.kind === 'staff') { e.idle = false; e.state = 'patrol'; e.pt = null; }
}
function dayTips4() {
  const ev = G.ev, t = G.t;
  if (t > 3 && !ev.w4tip1) { ev.w4tip1 = 1; toast('🏬 歡迎來到 3008 無盡賣場。這裡沒有出口……白天 5 分鐘、晚上 6 分鐘。白天要蓋房子、找食物；晚上燈會全部熄掉，店員會出來。'); }
  if (t > 14 && !ev.w4tip2) { ev.w4tip2 = 1; toast('🧱 入口旁邊的地上有木頭板子：對著它按 E 拿起來，前面會出現預覽，再按 E（平板按「放」）放下，就變成一面牆。自助倉儲區（西北邊）有更多板材堆。'); }
  if (t > 28 && !ev.w4tip3) { ev.w4tip3 = 1; toast('🔄 拿著板子時：「轉」轉方向（X／Y／Z 選軸，繞 X 或 Z 轉就躺平變屋頂）、「遠」「近」調位置。把自己圍起來就是你的家！'); }
  if (t > 44 && !ev.w4tip4) { ev.w4tip4 = 1; toast('🎒 背包只有 16 格（一種東西一格），食物都要自己找：美食區在東南邊。板子和家具不能放進背包，一次搬一個。'); }
  if (t > 62 && !ev.w4tip5) { ev.w4tip5 = 1; toast('🛋️ 賣場的家具大部分可以搬回家（對著它按住 E）：火爐可以取暖、櫃子可以收納、家裡的家具越多越溫馨。'); }
  if (t > 80 && !ev.w4tip6) { ev.w4tip6 = 1; toast('💡 燈具區的架子上有一盞一盞的檯燈（等級越高越亮）：拿起來，選它按 Q 就放在前面的地上；對著它按 E 再拿起來。'); }
  if (t > 100 && !ev.w4tip7) { ev.w4tip7 = 1; toast('🛒 神秘店員每天在不同的地方，要自己去找（聽鈴鐺聲）。📍 記錄位置可以把這裡記成你的家。'); }
}
function updateDay4(dt) {
  const ev = G.ev;
  if (G.day === 1) dayTips4();
  if (!ev.paWarn && G.t >= DAY_LEN - DUSK) { ev.paWarn = 1; Sound.play('pa'); toast('📢 廣播：「本店即將打烊，請盡快離開……」日光燈開始一排一排閃了。', 'warn'); }
  // 神秘店員的鈴鐺：越近越大聲
  if (merchantHere()) {
    const d = Math.hypot(MERCHANT_POS.x - G.p.x, MERCHANT_POS.y - G.p.y);
    ev.bellT = (ev.bellT || 0) - dt;
    if (ev.bellT <= 0 && d < 28) { ev.bellT = rand(5, 8); Sound.play('bell', clamp(1.2 - d / 26, 0.08, 1)); }
    if (!G.merchantSeen && d < 8 && castRay(G.p.x, G.p.y, Math.atan2(MERCHANT_POS.y - G.p.y, MERCHANT_POS.x - G.p.x), d) >= d - 0.05) {
      G.merchantSeen = true; toast('🛒 找到神秘店員了！他提著鐵桶燈籠，天黑前會在這裡。', 'good');
    }
  }
}
// 每一幀（白天晚上都會跑）：火爐、背包、酸雨、寒寂之境
function update4(dt) {
  settleHand4();
  G.whistleT = Math.max(0, (G.whistleT || 0) - dt); G.whistleCd = Math.max(0, (G.whistleCd || 0) - dt);
  updateFires4(dt);
  updateAcid4(dt);
  updateTemp4(dt);
  if (mode !== 'play') return;
  if (G.phase === 'day') updateDay4(dt);
  for (const w of G.b4.list) if (w.hitT > 0) w.hitT -= dt;
}

// ====================================================================
// 天氣：紅月（第 5、11 夜）、寒寂之境（第 3、6、9、12 天）、酸雨（每局隨機 2～3 次，開新遊戲時排好）
// ====================================================================
function makeWeather4() {
  const days = [];
  for (let d = 2; d <= LAST_NIGHT; d++) if (!COLD_DAYS_W4.includes(d) && !RED_MOON_W4.includes(d)) days.push(d);
  const acid = [];
  for (let i = 0, n = randi(2, 3); i < n && days.length; i++) {
    const d = days.splice(Math.floor(Math.random() * days.length), 1)[0];
    const night = Math.random() < 0.5;
    acid.push({ day: d, night, at: Math.round(rand(40, (night ? NIGHT_SECS[4] : DAY_SECS[4]) - 120)), dur: randi(60, 90) });
  }
  return { acid: acid.sort((a, b) => a.day - b.day) };
}
// 有沒有遮著：屋頂（躺平的板子）底下，或是有自己天花板的小房間（洗手間、員工專用區）
function sheltered4(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!inMap(tx, ty)) return true;
  const r = roomGrid[ty][tx] || (doorGrid[ty][tx] && doorGrid[ty][tx].rooms[0]);
  return !!(r && r.ceil) || G.b4.roofs.has(tx + ',' + ty);
}
const acidOn4 = () => !!(G.acid && G.acid.started && G.acidT > 0);
function updateAcid4(dt) {
  const a = G.acid, p = G.p;
  G.acidFx = Math.max(0, (G.acidFx || 0) - dt * 2);
  if (!a) return;
  const ph = a.night ? 'night' : 'day';
  if (!a.started) {
    if (G.phase !== ph) return;
    if (!a.warned && G.t >= a.at - 5) { a.warned = true; Sound.play('drip'); toast('🌧️ 天花板開始滴水……是綠色的。酸雨要來了！快躲到屋頂（躺平的板子）底下，或洗手間、員工專用區。', 'warn'); }
    if (G.t >= a.at) { a.started = true; G.acidT = a.dur; Sound.play('acid'); showBig('🌧️ 酸雨', '躲到屋頂底下！沒遮著的木頭板子會被腐蝕'); }
    return;
  }
  if (G.acidT <= 0) return;
  G.acidT -= dt;
  if (G.acidT <= 0) { G.acid = null; toast('🌤️ 酸雨停了。', 'good'); return; }
  G.ev.acidSnd = (G.ev.acidSnd || 0) - dt;
  if (G.ev.acidSnd <= 0) { G.ev.acidSnd = 2.4; Sound.play('rain', 0.7); }
  if (mode === 'play' && !sheltered4(p.x, p.y)) {
    p.hp -= 2 * D().dmg * dt; p.hurt = Math.max(p.hurt, 0.2); G.acidFx = 1;
    if (!G.ev.acidTip) { G.ev.acidTip = 1; toast('🌧️ 酸雨淋到你了，每秒扣血！快躲到屋頂底下。', 'warn'); }
    if (p.hp <= 0) { gameOver('acid'); return; }
  }
  // 沒有屋頂遮著的木頭板子會被腐蝕
  for (const w of [...G.b4.list]) {
    if (w.tier !== 1) continue;
    const [x0, y0] = wallEnds(w), [ax, ay, bx, by] = w.free ? [w.x, w.y, w.x, w.y] : w.o === 'v' ? [x0 - 1, y0, x0, y0] : [x0, y0 - 1, x0, y0];
    if (G.b4.roofs.has(ax + ',' + ay) || G.b4.roofs.has(bx + ',' + by)) continue;
    w.hp -= 0.25 * dt;
    if (w.hp <= 0) breakWall4(w, null);
  }
  for (const [k, r] of G.b4.roofs) if (r.tier === 1) { r.hp -= 0.25 * dt; if (r.hp <= 0) { G.b4.roofs.delete(k); G.b4.ver++; puff(r.x + 0.5, r.y + 0.5, [150, 110, 70], 10, ROOF4_H); } }
  // 綠色的雨絲（在玩家附近、沒有遮著的地方）
  for (let i = 0; i < 6; i++) {
    const x = p.x + rand(-6, 6), y = p.y + rand(-6, 6);
    if (sheltered4(x, y) || isWall(Math.floor(x), Math.floor(y))) continue;
    G.fx.push({ type: 'spark', x, y, h: rand(2.5, 4), vx: 0, vy: 0, vh: -rand(5, 7), life: 0.5, max: 0.5, color: [120, 255, 110] });
  }
}
// 寒寂之境的體溫：在賣場裡每秒 −1，在家裡 −0.4（溫馨度越高越少），站在毯子上再少一點；火爐、岩漿板子、大白燈、熱飲取暖
function updateTemp4(dt) {
  const p = G.p, nb = nearestBaymax();
  G.timeFlash = Math.max(0, (G.timeFlash || 0) - dt * 2);
  p.slowT = Math.max(0, (p.slowT || 0) - dt);
  const hugging = !!(nb && nb.d < BAYMAX_HUG_R);
  if (hugging && !G.hugged) { Sound.play('hug'); if (!G.ev.hugTip) { G.ev.hugTip = 1; toast('🤍 大白抱住了你……好溫暖。被抱著的時候被打只扣一半的血。', 'good'); } }
  G.hugged = hugging; G.hugObj = nb ? nb.o : null;
  G.hug = clamp((G.hug || 0) + (hugging ? dt * 1.5 : -dt * 1.5), 0, 1);
  if (!G.cold) { p.temp = Math.min(100, p.temp + dt * 5); G.frost = 0; return; }
  const home = atHome4(), onBlanket = FURN.some(f => f.type === 'blanket4' && !f.held && p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h);
  let rate = home ? -0.4 * (1 - cozy4() * 0.12) : -1;
  if (onBlanket) rate *= 0.6;
  rate += heat4(p.x, p.y);
  if (nb) rate += hugging ? 10 : nb.d < BAYMAX_WARM_R ? 5 : 0;
  for (const e of G.enemies) if (e.kind === 'tyrant' && !e.dead && Math.hypot(e.x - p.x, e.y - p.y) < 3) rate += 4;
  p.temp = clamp(p.temp + rate * dt, 0, 100);
  G.frost = clamp((40 - p.temp) / 40, 0, 1);
  if (p.temp < 20) p.san -= 1.2 * D().san * dt;
  if (p.temp < 30 && !G.ev.coldTip) { G.ev.coldTip = 1; toast('🥶 體溫太低了！快回家、到火爐旁邊，或站到大白燈下面。', 'warn'); Sound.play('wind'); }
  if (p.temp >= 50) G.ev.coldTip = 0;
  if (p.temp <= 0 && mode === 'play') { gameOver('cold'); return; }
  // 雪從天花板飄下來
  for (let i = 0; i < 3; i++) {
    const x = p.x + rand(-6, 6), y = p.y + rand(-6, 6);
    if (sheltered4(x, y) || isWall(Math.floor(x), Math.floor(y))) continue;
    G.fx.push({ type: 'spark', x, y, h: rand(2.6, 4), vx: rand(-0.2, 0.2), vy: rand(-0.1, 0.1), vh: -rand(0.5, 0.9), life: 4, max: 4, color: [230, 240, 255] });
  }
  G.ev.windT = (G.ev.windT || 0) - dt;
  if (G.ev.windT <= 0) { G.ev.windT = rand(7, 12); Sound.play('wind', 0.35); }
}
const speedMult4 = () => (G.cold && G.p.temp < 30 ? 0.8 : 1) * (G.p.slowT > 0 ? 0.6 : 1) * (G.p.crouch ? 0.45 : 1) * (onMilk4() ? 0.6 : 1);

// ====================================================================
// 介面：狀態列的提示、小地圖、蓋房子的按鈕、背包
// ====================================================================
function alerts4() {
  const a = [], p = G.p;
  const hd = homeDir4();
  if (atHome4()) a.push(`🏠 在家裡　溫馨度 ${'★'.repeat(cozy4())}${'☆'.repeat(5 - cozy4())}`);
  else if (hd) a.push(hd);
  else if (!G.home && G.day <= 2) a.push('🧱 拿板子蓋一間房子吧（📍 記錄位置）');
  if (acidOn4()) a.push(sheltered4(p.x, p.y) ? '🌧️ 酸雨（你在屋頂底下）' : `🌧️ 酸雨！快躲到屋頂底下（${Math.ceil(G.acidT)} 秒）`);
  if (G.hand && G.hand.k === 'item') a.push(`✋ 手上拿著${itemName(G.hand.id)}（背包滿了）`);
  else if (G.hand) { const g = ghost4(), b = bld(); a.push(g && g.ok ? '🧱 預覽是綠色：按 E（平板按「放」）放下' : `🧱 ${(g && g.why) || '這裡放不下'}`); a.push(`🔄 X ${b.rx}°　Y ${b.ry}°　Z ${b.rz}°（一次轉 ${b.step}°）`); }
  if (G.phase === 'day' && merchantHere() && G.merchantSeen) a.push('🛒 神秘店員還在（天黑前會離開）');
  if (G.phase === 'day' && G.t >= DAY_LEN - DUSK) a.push('📢 快打烊了，燈要熄了！');
  for (const e of G.enemies) {
    if (e.kind === 'hubert' && !e.idle) a.push(e.home ? '🕷️ Hubert 在拆你的家！' : '🕷️ Hubert 在賣場裡（只拆房子，玻璃拆不了）');
    else if (e.kind === 'ember') a.push(e.kneel > 0 ? '👑 燼皇跪下了！傷害 2.5 倍' : '👑 燼皇來了（照牠頭上的光環；燼雨要躲屋頂）');
    else if (e.kind === 'mimic' && e.knock > 0) a.push('🚪 有人在敲你家的門……「開門，是我啊」（別開！）');
  }
  if (G.enemies.some(e => e.kind === 'staff' && e.state === 'chase')) a.push('👔 店員看到你了！躲起來或跑回家');
  return a;
}
// 背包格數、蓋房子的按鈕（拿著東西才出現）、蹲下和跑步的開關
function hud4() {
  const w4 = isW4();
  document.body.classList.toggle('holding', w4 && handBig());
  if (!w4) return;
  const bag = `🎒 ${bagUsed()}/${BAG_SLOTS}`;
  if ($('bagCount').textContent !== bag) $('bagCount').textContent = bag;
  $('bagCount').classList.toggle('full', bagUsed() >= BAG_SLOTS);
  const ax = bld().axis;
  for (const b of document.querySelectorAll('#bbtns .bb[data-ax]')) b.classList.toggle('on', b.dataset.ax === ax);
  const st = `${bld().step}°<small>角度</small>`;
  if ($('bbStep') && $('bbStep').innerHTML !== st) $('bbStep').innerHTML = st;
  $('tcrouch').classList.toggle('on', !!G.p.crouch);
  $('trun').classList.toggle('on', !!G.p.autoRun);
  if (G.cold) setBar('tempFill', G.p.temp);
}
function overlays4() {
  $('acidfx').style.opacity = (G.acidFx || 0).toFixed(3);
  $('milkfx').style.opacity = clamp(G.milk || 0, 0, 1).toFixed(3);
  $('coldfx').style.opacity = (G.frost || 0).toFixed(3);
  $('timefx').style.opacity = (G.timeFlash || 0).toFixed(3);
}
function drawMinimap4(c) {
  // 自己蓋的牆（玻璃是淡藍色）、屋頂、地上的板子、板材堆、家、找到的神秘店員
  for (const [, r] of G.b4.roofs) { c.fillStyle = 'rgba(200,170,120,.35)'; c.fillRect(r.x, r.y, 1, 1); }
  c.lineWidth = 0.35;
  for (const w of G.b4.list) {
    c.strokeStyle = w.tier === GLASS_TIER ? '#9fe6ff' : w.door ? '#d6a35a' : ['', '#c89a64', '#f0ece4', '#ffd23a', '#ff7a30'][w.tier];
    const [x0, y0, x1, y1] = wallEnds(w);
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  }
  for (const f of FURN) if (f.type === 'plankpile' && f.count > 0) { c.fillStyle = RARITY[PLANKS[f.tier].rar].color; c.fillRect(f.x + 0.2, f.y + 0.2, 0.6, 0.6); }
  for (const l of G.loose4) { c.fillStyle = RARITY[PLANKS[l.tier].rar].color; c.fillRect(l.x - 0.3, l.y - 0.3, 0.6, 0.6); }
  if (G.home) {
    const h = G.home;
    c.fillStyle = '#7ee081';
    c.beginPath(); c.moveTo(h.x, h.y - 1.2); c.lineTo(h.x + 1, h.y - 0.2); c.lineTo(h.x + 0.7, h.y - 0.2); c.lineTo(h.x + 0.7, h.y + 0.8); c.lineTo(h.x - 0.7, h.y + 0.8); c.lineTo(h.x - 0.7, h.y - 0.2); c.lineTo(h.x - 1, h.y - 0.2); c.closePath(); c.fill();
  }
}
function bindBuildButtons() {
  for (const b of document.querySelectorAll('#bbtns .bb')) {
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      Sound.init();
      if (mode !== 'play' || !G) return;
      b.classList.add('down');
      const k = b.dataset.k;
      if (b.dataset.ax) setAxis(b.dataset.ax);
      else if (k === 'rot') rotateHand();
      else if (k === 'step') cycleStep();
      else if (k === 'far') nudgeDist(1);
      else if (k === 'near') nudgeDist(-1);
      else if (k === 'put') place4();
    });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  }
  const tap = (id, fn) => $(id).addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); Sound.init(); if (mode === 'play' && G && isW4()) fn(); });
  tap('thome', () => setHome4(false));
  tap('tbag', openBag4);
  tap('twhistle', whistle4);
  tap('tcrouch', toggleCrouch4);
  tap('trun', () => { G.p.autoRun = !G.p.autoRun; Sound.play('click'); toast(G.p.autoRun ? '🏃 一直跑（會用體力）' : '🚶 用走的（輕推搖桿慢慢走、推到底跑）'); });
}
// 🎵 吹口哨（照 3008）：吹完 5 秒內，畫面上（不是小地圖）會在怪物的位置出現紅點、朋友（神秘店員）出現藍點，隔著牆也看得到；
// 但怪物也聽得到口哨聲！
const WHISTLE_T = 5, WHISTLE_CD = 8, WHISTLE_R = 45;
function whistle4() {
  if (!G || mode !== 'play' || !isW4()) return;
  if ((G.whistleCd || 0) > 0) { toast(`🎵 喘口氣……${Math.ceil(G.whistleCd)} 秒後才能再吹。`); return; }
  G.whistleT = WHISTLE_T; G.whistleCd = WHISTLE_CD;
  Sound.play('whistle'); makeNoise(10);
  const n = G.enemies.filter(e => !e.dead && Math.hypot(e.x - G.p.x, e.y - G.p.y) < WHISTLE_R).length;
  toast(G.ev.whistleTip ? `🎵 嗶——！附近有 ${n} 個紅點。` : `🎵 你吹了一聲口哨：紅點是怪物（附近有 ${n} 個）、藍點是朋友（神秘店員）。小心，怪物也聽得到口哨聲！`, n ? 'warn' : 'good');
  G.ev.whistleTip = 1;
}
// 口哨的點：[{ x, y, h, red }]（3D 畫面上畫）
function whistleDots4() {
  if (!(G.whistleT > 0)) return [];
  const p = G.p, out = [];
  for (const e of G.enemies) if (!e.dead && Math.hypot(e.x - p.x, e.y - p.y) < WHISTLE_R) out.push({ x: e.x, y: e.y, h: e.kind === 'shake' || e.kind === 'blob' ? 0.7 : 1.7, red: true });
  if (merchantHere() && Math.hypot(MERCHANT_POS.x - p.x, MERCHANT_POS.y - p.y) < WHISTLE_R * 1.5) out.push({ x: MERCHANT_POS.x, y: MERCHANT_POS.y, h: 1.6, red: false });
  return out;
}
function toggleCrouch4() {
  const p = G.p;
  p.crouch = !p.crouch;
  Sound.play('click');
  if (!G.ev.crouchTip && p.crouch) { G.ev.crouchTip = 1; toast('⬇ 蹲下：走得很慢、很安靜，店員要很近才看得到你。'); }
}
// 🎒 書包：看 16 格裡有什麼，可以把選中的東西丟在地上
function openBag4() {
  openModal(`🎒 書包（${bagUsed()}/${BAG_SLOTS}）`, () => {
    const cards = invList().map(id => `<div class="shopcard${id === G.selId ? ' sel' : ''}">${icBox(id)}<div class="nm">${itemName(id)}${G.inv[id] > 1 ? ' ×' + G.inv[id] : ''}</div>${rarityTag(id)}<div class="ds">${itemDesc(id)}</div>${G.inv[id] > 1 ? `<button data-act="one:${id}">放下 1 個</button>` : ''}<button data-act="drop:${id}">${G.inv[id] > 1 ? '全部放下' : '放在地上'}</button></div>`).join('');
    const hand = G.hand ? `<p class="hint">✋ 手上：${G.hand.k === 'item' ? itemName(G.hand.id) + '（背包滿了多拿的第 17 個）' : G.hand.k === 'plank' ? plankName(G.hand.tier, G.hand.door) : G.hand.f.name}</p>` : '';
    return `<p class="hint">背包有 ${BAG_SLOTS} 格，一種東西一格（同樣的東西疊在一起）。板子和家具不能放進背包。放在地上的東西是真的東西，看著它按 E 就能再拿起來。</p>${hand}<div class="shop">${cards || '<p class="hint">背包是空的。</p>'}</div>`;
  }, act => {
    const [a, id] = act.split(':');
    if (!G.inv[id]) return;
    G.selId = id; dropSelected4(a !== 'one');
  }, '關閉');
}

// ====================================================================
// 存檔：自己蓋的牆、屋頂、搬過的家具、手上的東西、家、地上的板子、板材堆、天氣（舊存檔沒有這些就用預設）
// ====================================================================
function save4() {
  const b = G.b4;
  return {
    // 斜放的牆：o 是 'f'，x、y 是中心，後面多存角度；最後一個是牆斜靠的角度（看起來的樣子）
    walls: b.list.map(w => [w.free ? 'f' : w.o, w.free ? Math.round(w.cx * 100) / 100 : w.x, w.free ? Math.round(w.cy * 100) / 100 : w.y, w.tier, Math.round(Math.min(w.hp, 9999)), w.door ? 1 : 0, w.open ? 1 : 0, w.free ? Math.round(w.ang * 180 / Math.PI) : 0, w.lean || 0]),
    roofs: [...b.roofs.values()].map(r => [r.x, r.y, r.tier, Math.round(Math.min(r.hp, 9999)), r.tilt || 0, r.tax || 'x']),
    furn: FURN.filter(f => f.move || f.type === 'plankpile' || f.fuel || f.on).map(f => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.h, side: f.side, yaw: f.yaw || undefined, held: f.held ? 1 : 0, fuel: f.fuel, on: f.on ? 1 : 0, count: f.count, sp: f.special ? [f.tier] : undefined })),
    hand: G.hand ? (G.hand.k === 'furn' ? { k: 'furn', id: G.hand.f.id } : G.hand) : null,
    home: G.home, loose: G.loose4.map(l => [Math.round(l.x * 10) / 10, Math.round(l.y * 10) / 10, l.tier, l.door ? 1 : 0]),
    wx: G.wx4, merchant: { x: MERCHANT_POS.x, y: MERCHANT_POS.y }, mv: W4_MAP_VER,
  };
}
function load4(s) {
  initB4();
  G.wx4 = s && s.wx ? s.wx : makeWeather4();
  if (!s) { refillPiles4(true); return; }
  if ((s.mv || 1) !== W4_MAP_VER) { migrate4(s); return; }
  for (const [o, x, y, tier, hp, door, open, ad, lean] of s.walls || []) {
    if (!PLANKS[tier]) continue;
    const base = { tier, hp: tier === GLASS_TIER ? Infinity : hp, door: !!door, open: !!open, lean: lean || 0 };
    if (o === 'f') setWall({ free: true, cx: x, cy: y, ang: (ad || 0) * Math.PI / 180, ...base });
    else if (!wallAt(o, x, y)) setWall({ o, x, y, ...base });
  }
  for (const [x, y, tier, hp, tilt, tax] of s.roofs || []) if (PLANKS[tier]) G.b4.roofs.set(x + ',' + y, { x, y, tier, hp: tier === GLASS_TIER ? Infinity : hp, tilt: tilt || 0, tax: tax || 'x' });
  for (const sf of s.furn || []) {
    let f = FURN_BY_ID[sf.id];
    if (!f && sf.sp) { f = { id: sf.id, type: 'plankpile', name: '板材堆', w: 1, h: 1, tier: sf.sp[0], special: true }; FURN.push(f); FURN_BY_ID[f.id] = f; }
    if (!f) continue;
    if (f.move || f.special) { liftFurn4(f); Object.assign(f, { x: sf.x, y: sf.y, w: sf.w || f.w, h: sf.h || f.h, side: sf.side || f.side, yaw: sf.yaw || 0 }); if (!sf.held) addFurn4(f); }
    if (sf.fuel) f.fuel = sf.fuel.filter(q => ITEMS[q.id]);
    if (sf.on !== undefined) f.on = !!sf.on;
    if (sf.count !== undefined) f.count = sf.count;
  }
  // 放回去的家具壓到別的東西就留在手上（不會不見）
  if (s.hand && s.hand.k === 'furn') { const f = FURN_BY_ID[s.hand.id]; if (f) { if (!f.held) liftFurn4(f); G.hand = { k: 'furn', f }; } }
  else if (s.hand && (s.hand.k === 'plank' ? PLANKS[s.hand.tier] : ITEMS[s.hand.id])) G.hand = s.hand;
  G.home = s.home || null;
  G.loose4 = (s.loose || []).filter(l => PLANKS[l[2]]).map(([x, y, tier, door]) => ({ x, y, tier, door: !!door, k: 'plank', a: Math.random() * 3 }));
  if (s.merchant && walkable(s.merchant.x, s.merchant.y)) Object.assign(MERCHANT_POS, s.merchant);
  G.cold = COLD_DAYS_W4.includes(G.day);
  const wx = (G.wx4.acid || []).find(a => a.day === G.day);
  G.acid = wx ? { ...wx, started: false } : null;
  Object.assign(GIFT_POS, G.home || G.p);
  spawnIdleStaff4();
}
// 舊的小賣場（2026/10/31 以前是 60×44）的存檔：蓋的牆和屋頂放不回新的地圖，板子全部疊在入口旁邊的地上，
// 家要重新記；天數、背包、硬幣都照舊（燈和櫃子裡自己放的東西在 game.js 的 loadGame 收回來）
function migrate4(s) {
  const tiers = [...(s.walls || []).map(w => [w[3], w[5]]), ...(s.roofs || []).map(r => [r[2], 0]), ...(s.loose || []).map(l => [l[2], l[3]])];
  if (s.hand && s.hand.k === 'plank') tiers.push([s.hand.tier, s.hand.door ? 1 : 0]);
  else if (s.hand && s.hand.k === 'item' && ITEMS[s.hand.id]) G.hand = s.hand;
  G.loose4 = tiers.filter(([t]) => PLANKS[t]).map(([tier, door], i) => ({ x: W4.start.x - 3 + (i % 8) * 0.8, y: W4.start.y - 2 - Math.floor(i / 8) * 0.8, tier, door: !!door, k: 'plank', a: Math.random() * 3 }));
  refillPiles4(true);
  Object.assign(G.p, W4.start);
  G.home = null; G.mapReset4 = true;
  G.cold = COLD_DAYS_W4.includes(G.day);
  const wx = (G.wx4.acid || []).find(a => a.day === G.day);
  G.acid = wx ? { ...wx, started: false } : null;
  Object.assign(GIFT_POS, G.p);
  spawnIdleStaff4();
}
// 新遊戲：送 4 片木頭板子放在入口旁邊的地上
function newGame4(carry) {
  load4(null);
  G.loose4 = W4.starterPlanks.map(([x, y]) => ({ x, y, tier: 1, k: 'plank', a: Math.random() * 3 }));
  G.tutorial4 = 1;
  startDay4(1);
  if (!carry) { addItem('hotdog', 2); addItem('soda', 1); }
}
// 測試用網址參數：&cold 強制寒寂之境、&acid 馬上下酸雨、&red 今晚強制紅月；kit 另外帶各級板子（放在旁邊的地上）、火爐、木柴和煤炭
function testStart4(q, night, kit) {
  if (q.has('cold')) { G.forceCold = true; G.cold = true; }
  if (q.has('red')) G.forceRed = true;
  if (q.has('acid')) { G.acid = { day: G.day, night: false, at: 0, dur: 90, started: true, warned: true }; G.acidT = 90; }
  if (kit) {
    for (let t = 1; t <= PLANK_MAX; t++) for (let i = 0; i < 2; i++) G.loose4.push({ x: W4.start.x - 2 + t * 0.7, y: W4.start.y - 1.4 - i * 0.5, tier: t, k: 'plank', a: 0 });
    G.loose4.push({ x: W4.start.x + 2.2, y: W4.start.y - 1, tier: 1, door: true, k: 'plank', a: 0 });
    addItem('wood', 4); addItem('charcoal', 4);
  }
}

// ====================================================================
// 第四世界的 5 隻新怪物（照設計圖，寫實風）：
// 葵氏奶昔（綠色鬼差）、紅涎偽人（紫色鬼將）、SCP-3008-2（紅色鬼王，每晚都有，取代黑影）、Hubert（黃色判官，專門拆房子）、燼皇（閻羅，最後一夜的大魔王）
// ====================================================================
const GRADE4 = { shake: 'runner', mimic: 'general', staff: 'king', hubert: 'judge', ember: 'yama' };
// 怪物受到不同攻擊的傷害倍數（world3.js 的 monsterDmgMult 會先問這裡）
function monsterDmgMult4(t, src) {
  switch (t.kind) {
    case 'staff': return src === 'flash' ? 0.5 : 1;                                     // 手電筒只有一半
    case 'hubert': return src === 'flash' ? 0 : src === 'pan' ? 0.5 : src === 'spray' ? 2 : src === 'bomb' ? 1.5 : 1;   // 黑色的硬殼把光吸掉：手電筒沒用
    case 'ember': {
      const k = t.kneel > 0 ? 2.5 : 1;
      return src === 'fire' || src === 'lava' ? 0 : src === 'bomb' ? 0.5 * k : src === 'spray' ? 2 * k : src === 'flash' ? 0.5 * k : k;
    }
    case 'mimic': return src === 'salt' ? 2 : 1;
    default: return 1;
  }
}
// 賣場裡巡邏的點（走道和空地，每 6 格一個），路線算一次就記住
let patrol4 = null;
function patrolPoints4() {
  if (patrol4) return patrol4;
  patrol4 = [];
  for (let y = 3; y < MAP_H - 2; y += 6) for (let x = 3; x < MAP_W - 2; x += 6) {
    for (let k = 0; k < 9; k++) {
      const tx = x + (k % 3) - 1, ty = y + Math.floor(k / 3) - 1;
      if (walkable(tx + 0.5, ty + 0.5) && !(zoneAt(tx, ty) || {}).cube) { patrol4.push({ x: tx + 0.5, y: ty + 0.5 }); break; }
    }
  }
  return patrol4;
}
// 走向某一點（沿著算上牆的路線）；回傳離目標多遠
function walkTo4(e, tx, ty, sp, dt, f = null) {
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return Infinity;
  const fl = f || flowTo(Math.floor(tx), Math.floor(ty), e.kind === 'blob' ? 'blob' : '');
  const ox = e.x, oy = e.y, dir = pathDir(e, fl, tx, ty, 0.12);
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  if (Math.hypot(e.x - ox, e.y - oy) > 0.002) e.face = Math.atan2(e.y - oy, e.x - ox);
  return Math.hypot(tx - e.x, ty - e.y);
}
// 看不看得到你（前方、沒被不透明的牆擋住；開手電筒看得更遠、蹲下要很近才看得到）
function seesPlayer4(e, range, fov = 1.25) {
  const p = G.p, d = Math.hypot(p.x - e.x, p.y - e.y);
  const r = range * (p.crouch ? 0.5 : 1) * (flashOn() ? 1.5 : 1);
  if (d > r) return false;
  const a = Math.atan2(p.y - e.y, p.x - e.x);
  if (castRay(e.x, e.y, a, d) < d - 0.05) return false;
  let da = a - (e.face || 0);
  while (da > Math.PI) da -= Math.PI * 2;
  while (da < -Math.PI) da += Math.PI * 2;
  return d < 2.5 || Math.abs(da) < fov;
}

// ---------- SCP-3008-2（店員）：白天站著不動、頭慢慢轉過來看你；天黑後巡邏，看到你就追過來打你，看不到 6 秒就回去巡邏 ----------
function spawnIdleStaff4() {
  for (let i = 0, n = 2 + Math.floor(G.day / 4); i < n; i++) {
    const sp = randomSpot4(12);
    if (!sp) continue;
    const e = spawnEnemy('staff', sp);
    if (e) { e.idle = true; e.spawn = 0; e.face = Math.random() * Math.PI * 2; }
  }
}
function updateStaff(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.stepT += dt;
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  if (e.idle && G.phase === 'day') {
    // 白天：面向牆站著，你靠近時頭慢慢轉過來
    e.look = d < 7 ? Math.atan2(p.y - e.y, p.x - e.x) : null;
    if (d < 4 && !G.ev.staffDayTip) { G.ev.staffDayTip = 1; toast('👔 穿黃色制服的店員……一動也不動，頭卻慢慢轉過來看你。白天牠們不會動手，天黑以後就不一樣了。', 'warn'); }
    return;
  }
  e.look = null;
  if (seesPlayer4(e, 12)) {
    if (e.state !== 'chase') {
      e.state = 'chase';
      Sound.play('staffAlert', nearVol(d));
      if (!G.ev.staffTip) { G.ev.staffTip = 1; toast('👔 店員看到你了！「本店已經打烊。」牠們很耐打（手電筒只有一半的傷害），躲回家、躲到牠們看不到的地方，或蹲下慢慢走。', 'warn'); }
    }
    e.lost = 0; e.lx = p.x; e.ly = p.y;
  } else if (e.state === 'chase') { e.lost = (e.lost || 0) + dt; if (e.lost > 6) { e.state = 'search'; if (e.lx === undefined) { e.lx = p.x; e.ly = p.y; } } }
  let sp;
  if (e.state === 'chase') { sp = Math.min(2.8 + n * 0.01, 3.5); walkTo4(e, p.x, p.y, sp * (e.spawn > 0 ? 0.3 : 1), dt, flow); }
  else if (e.state === 'search') { if (walkTo4(e, e.lx, e.ly, 2.0, dt) < 0.8) { e.state = 'patrol'; e.pt = null; } }
  else {
    if (!e.pt || Math.hypot(e.pt.x - e.x, e.pt.y - e.y) < 1) e.pt = pick(patrolPoints4());
    walkTo4(e, e.pt.x, e.pt.y, 1.4, dt);
  }
  if (e.stepT > (e.state === 'chase' ? 0.32 : 0.55) && d < 13) { e.stepT = 0; Sound.play('step', nearVol(d) * 0.45); }
  if (d < 1.0 && e.cd <= 0 && e.spawn <= 0 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) {
    damage(17 + n * 0.15, 10); p.inv = 1.2; e.cd = 1.6;
    const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 0.8, Math.sin(a) * 0.8, PLAYER_R);
    Sound.play('punch'); toast('👔 店員一拳打在你身上！', 'warn');
  }
}
// 兩點中間有沒有擋路的牆（隔著牆打不到）
const wallBetweenPts4 = (x0, y0, x1, y1) => b4On() && moveBlocked4(x0, y0, x1, y1);

// ---------- 葵氏奶昔：平常闔著眼躺著（像一盒奶昔），晚上你走到 3 格內眼睛睜開、一跳一跳衝過來，每 4 秒從吸管噴酸掉的奶 ----------
function updateShake(e, dt) {
  const p = G.p, d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.hopT += dt;
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; if (!e.awake && G.phase === 'night') wakeShake(e); }
  if (e.pose) return;
  if (!e.awake) { if (G.phase === 'night' && d < 3 && e.spawn <= 0) wakeShake(e); return; }
  const dir = chaseDir(e), sp = 3.2 * (0.4 + Math.abs(Math.sin(e.hopT * 7)));   // 一跳一跳
  const ox = e.x, oy = e.y;
  move(e, dir.x * sp * dt, dir.y * sp * dt, 0.22);
  if (Math.hypot(e.x - ox, e.y - oy) > 0.001) e.face = Math.atan2(e.y - oy, e.x - ox);
  e.spitT -= dt;
  if (e.spitT <= 0 && d < 4.5 && castRay(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), d) >= d - 0.05) {
    e.spitT = 4; e.spit = 0.4;
    Sound.play('squirt', nearVol(d));
    for (let i = 0; i < 14; i++) G.fx.push({ type: 'spark', x: e.x, y: e.y, h: 0.45, vx: (p.x - e.x) * rand(0.8, 1.4), vy: (p.y - e.y) * rand(0.8, 1.4), vh: rand(0.3, 1.2), life: 0.5, max: 0.5, color: [245, 240, 225] });
    if (p.z > 0.3) { if (!G.ev.milkDodge) { G.ev.milkDodge = 1; toast('⤒ 跳起來躲過了噴出來的奶！', 'good'); } }
    else {
      G.milk = 1.4; p.san -= 8 * D().san;
      if (!G.ev.milkTip) { G.ev.milkTip = 1; toast('🥛 葵氏奶昔從吸管噴出酸掉的奶，糊了你一臉！看不清楚……跳起來可以躲開。', 'warn'); }
    }
  }
  if (d < 0.6 && e.spawn <= 0 && p.inv <= 0) {
    damage(8, 6); p.inv = 0.8;
    Sound.play('pop'); toast('🥛 奶昔咬了你一口，然後破掉了，灑了一地。', 'warn');
    e.dead = true; puff(e.x, e.y, [240, 235, 220], 14, 0.3); addMilk4(e.x, e.y);
  }
}
function wakeShake(e) {
  e.awake = true; e.spitT = 1.2;
  Sound.play('squish', nearVol(Math.hypot(e.x - G.p.x, e.y - G.p.y)));
  if (!G.ev.shakeTip) { G.ev.shakeTip = 1; toast('👁️ 地上那盒奶昔……睜開了一顆眼睛！葵氏奶昔一跳一跳地衝過來了。牠很弱，手電筒照一下或平底鍋一敲就破。', 'warn'); }
}
function addMilk4(x, y) { G.milk4.push({ x, y, life: 25, r: rand(0.35, 0.5), a: Math.random() * 6 }); if (G.milk4.length > 30) G.milk4.shift(); }
const onMilk4 = () => G.p.z < 0.1 && (G.milk4 || []).some(m => (m.x - G.p.x) ** 2 + (m.y - G.p.y) ** 2 < m.r * m.r);

// ---------- 紅涎偽人：模仿朋友的聲音引你過去；你在家裡時來敲門（別開門！開了就撲進來）；看到你就四腳著地衝過來，留下一攤紅涎 ----------
function updateMimic(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.retreat = Math.max(0, e.retreat - dt); e.shriekCd = Math.max(0, e.shriekCd - dt);
  const beam = inBeam(e);
  if (beam) {
    flashHurt(e, dt); if (e.dead) return;
    if (d < 8 && e.shriekCd <= 0) { e.retreat = 3; e.shriekCd = 6; e.knock = 0; Sound.play('shriek', nearVol(d)); if (!G.ev.mimicLightTip) { G.ev.mimicLightTip = 1; toast('🔦 手電筒照到牠的臉，紅涎偽人尖叫著往後退了！', 'good'); } }
  }
  if (e.pose) return;
  e.droolT -= dt;
  if (e.retreat > 0) { const a = Math.atan2(e.y - p.y, e.x - p.x); move(e, Math.cos(a) * 3 * dt, Math.sin(a) * 3 * dt, ENEMY_R); e.face = a + Math.PI; return; }
  // 你躲在家裡：去敲你家的門（找你家的一扇門，沒有門就敲牆）
  const home = atHome4();
  if (home && e.state !== 'hunt') {
    if (!e.door || !G.b4.list.includes(e.door)) e.door = homeDoor4();
    if (e.door) {
      const at = outsideOf4(e.door);
      if (walkTo4(e, at.x, at.y, 2.6, dt) < 0.7) {
        if (!(e.knock > 0) && !e.knocked) { e.knock = 15; e.knocked = true; e.knockTick = 0; toast('🚪 叩、叩、叩……「開門……是我啊……」有人在敲你家的門。千萬不要開門！', 'warn'); }
        if (e.knock > 0) {
          e.knock -= dt; e.knockTick -= dt;
          if (e.knockTick <= 0) { e.knockTick = 2.4; Sound.play('knock', nearVol(d)); if (Math.random() < 0.5) Sound.play('friendCall', nearVol(d) * 0.8); }
          if (e.knock <= 0) { e.state = 'hunt'; toast('🩸 敲門聲停了……然後開始撞牆！', 'warn'); }
        }
      }
      return;
    }
  }
  if (e.state !== 'hunt' && seesPlayer4(e, 10)) { e.state = 'hunt'; Sound.play('mimicScreech', nearVol(d)); if (!G.ev.mimicTip) { G.ev.mimicTip = 1; toast('🩸 紅涎偽人看到你了，四腳著地衝過來！手電筒照牠的臉會讓牠退開，鹽巴傷害 2 倍。', 'warn'); } }
  let sp;
  if (e.state === 'hunt') {
    sp = Math.min(3.6 + n * 0.01, 4.3) * (e.spawn > 0 ? 0.3 : 1);
    walkTo4(e, p.x, p.y, sp, dt, flow);
    if (e.droolT <= 0) { e.droolT = 0.45; G.drool4.push({ x: e.x, y: e.y, life: 14, r: rand(0.28, 0.4), a: Math.random() * 6 }); if (G.drool4.length > 40) G.drool4.shift(); }
    if (d > 16) { e.state = 'wander'; e.pt = null; }
  } else {
    if (!e.pt || Math.hypot(e.pt.x - e.x, e.pt.y - e.y) < 1) e.pt = pick(patrolPoints4());
    walkTo4(e, e.pt.x, e.pt.y, 1.3, dt);
  }
  if (d < 0.8 && e.cd <= 0 && e.spawn <= 0 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) {
    damage(20 + n * 0.15, 14); p.inv = 1.3; e.cd = 2; e.retreat = 1.2;
    Sound.play('chomp'); toast('🩸 紅涎偽人咬住了你，紅色的口水滴了你一身！', 'warn');
  }
}
// 你家的門（沒有門就挑最近的一片牆）
function homeDoor4() {
  const enc = encCache && encCache.inside ? encCache.tiles : null;
  if (!enc) return null;
  let best = null, bd = Infinity;
  for (const w of G.b4.list) {
    const [ax, ay, bx, by] = w.o === 'v' ? [w.x - 1, w.y, w.x, w.y] : [w.x, w.y - 1, w.x, w.y];
    const inA = enc.has(ax + ',' + ay), inB = enc.has(bx + ',' + by);
    if (inA === inB) continue;   // 不是家的外牆
    const s = (w.door ? 0 : 50) + distToWall(G.p.x, G.p.y, w);
    if (s < bd) { bd = s; best = w; }
  }
  return best;
}
// 牆外面那一格的中心（敲門、拆牆時站的位置）
function outsideOf4(w) {
  const enc = encCache && encCache.tiles;
  const [ax, ay, bx, by] = w.o === 'v' ? [w.x - 1, w.y, w.x, w.y] : [w.x, w.y - 1, w.x, w.y];
  const out = enc && enc.has(ax + ',' + ay) ? [bx, by] : [ax, ay];
  return { x: out[0] + 0.5, y: out[1] + 0.5 };
}
// 敲門的時候你把門打開了：牠撲進來
function mimicDoorOpened4(w) {
  for (const e of G.enemies) {
    if (e.kind !== 'mimic' || !(e.knock > 0) || e.door !== w) continue;
    e.knock = 0; e.state = 'hunt';
    const p = G.p;
    e.x = p.x - Math.cos(p.face) * 0.5; e.y = p.y - Math.sin(p.face) * 0.5;
    if (!walkable(e.x, e.y)) { e.x = p.x; e.y = p.y; }
    jumpscare(drawMimicFace);
    damage(30 + diffN() * 0.15, 25); p.inv = 1.5; e.cd = 2.5;
    toast('😱 你打開了門……門外的「朋友」流著紅色的口水撲了進來！', 'warn');
  }
}
// 假的「呼叫朋友」：聽到朋友在叫你（其實是紅涎偽人）
function friendCall4() {
  const m = G.enemies.find(e => e.kind === 'mimic');
  if (!m) return;
  Sound.play('friendCall', nearVol(Math.hypot(m.x - G.p.x, m.y - G.p.y)) + 0.2);
  toast(`👥 你聽到朋友的聲音，從「${zoneName(m.x, m.y)}」那邊傳來：「喂——我在這裡！快過來！」……可是你在這裡沒有朋友。`, 'warn');
}

// ---------- Hubert：黑色的胖蜘蛛（照設計圖），專門拆房子。爬到你的家，用鐵管一下一下敲爛板子（玻璃除外）；你在 6 格內被看到時舉起鐵管往地上砸，震波擴散 4 格（跳起來就不會被震到） ----------
function updateHubert(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.smashCd = Math.max(0, e.smashCd - dt); e.hum += dt;
  if (inBeam(e) && !G.ev.hubertFlashTip && d < 9) { G.ev.hubertFlashTip = 1; toast('🕷️ 手電筒對 Hubert 沒用（牠黑色的硬殼會把光吸掉）！聖水槍傷害 2 倍、鞭炮也有效。', 'warn'); }
  if (e.pose) return;
  // 判決：舉起鐵管（1 秒）往地上砸
  if (e.raise > 0) {
    e.raise -= dt;
    if (e.raise <= 0) { G.waves4.push({ x: e.x, y: e.y, r: 0, max: 4, hit: false }); Sound.play('stompBig', nearVol(d) * 1.2); G.shake = Math.max(G.shake, 0.5); e.cd = 4.5; }
    return;
  }
  if (d < 6 && e.cd <= 0 && e.spawn <= 0 && seesPlayer4(e, 6, 1.6)) { e.raise = 1.0; Sound.play('hubertRaise', nearVol(d)); if (!G.ev.hubertWaveTip) { G.ev.hubertWaveTip = 1; toast('🕷️ Hubert 把鐵管舉高了……震波要來了，跳起來！', 'warn'); } return; }
  // 拆房子：去你家，找最近的一片打得破的外牆
  const home = G.home && G.b4.n ? homeTarget4(e) : null;
  e.home = !!home;
  if (home) {
    const at = outsideOf4(home);
    if (walkTo4(e, at.x, at.y, 1.5, dt) < 0.8 || distToWall(e.x, e.y, home) < 0.9) {
      e.face = Math.atan2((home.y + (home.o === 'h' ? 0 : 0.5)) - e.y, (home.x + (home.o === 'v' ? 0 : 0.5)) - e.x);
      if (e.smashCd <= 0) {
        e.smashCd = 1.6; e.swing = 0.35;
        damageWall4(home, 40, e);
        Sound.play('clang', nearVol(d)); G.shake = Math.max(G.shake, d < 6 ? 0.2 : 0.05);
        if (!G.ev.hubertHomeTip) { G.ev.hubertHomeTip = 1; toast('🕷️ Hubert 在用鐵管拆你的家！一下就敲掉 40 點。玻璃板子牠拆不了。', 'warn'); }
      }
    }
  } else walkTo4(e, p.x, p.y, Math.min(1.4 + n * 0.005, 1.8) * (e.spawn > 0 ? 0.3 : 1), dt, flow);
  e.swing = Math.max(0, (e.swing || 0) - dt);
  if (d < 1.0 && e.spawn <= 0 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) { damage(20 + n * 0.15, 8); p.inv = 1.2; Sound.play('clang'); toast('🕷️ Hubert 用鐵管把你打飛了！', 'warn'); const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 1.2, Math.sin(a) * 1.2, PLAYER_R); }
}
// Hubert 要拆的牆：家附近、打得破、離牠最近的外牆
function homeTarget4(e) {
  let best = null, bd = Infinity;
  for (const w of G.b4.list) {
    if (w.tier === GLASS_TIER || !nearHome4(w.x + 0.5, w.y + 0.5, HOME_R)) continue;
    const dd = distToWall(e.x, e.y, w);
    if (dd < bd) { bd = dd; best = w; }
  }
  return best;
}
// 震波：從 Hubert 腳下往外擴散的紅色圓圈，經過你的時候你在地上就會被震倒
function updateWaves4(dt) {
  const p = G.p;
  for (const w of G.waves4) {
    w.r += dt * 6;
    const d = Math.hypot(p.x - w.x, p.y - w.y);
    if (!w.hit && Math.abs(d - w.r) < 0.45 && d < w.max) {
      w.hit = true;
      if (p.z < 0.25 && p.inv <= 0) { damage(20 + diffN() * 0.1, 8); p.stunT = 0.7; p.inv = 1; toast('🕷️ 紅色的震波把你震倒了！看到 Hubert 舉起鐵管就跳起來。', 'warn'); }
      else if (p.z >= 0.25 && !G.ev.waveDodge) { G.ev.waveDodge = 1; toast('⤒ 跳起來躲過了震波！', 'good'); }
    }
  }
  G.waves4 = G.waves4.filter(w => w.r < w.max + 0.5);
}

// ---------- 燼皇（閻羅級，大魔王）：骷髏長身體、荊棘光環、燒著火的紅披風。每 14 秒下 3 秒燼雨（沒有屋頂就扣血、木頭板子會著火）；
// 飄過的地上長出帶刺的玫瑰藤。弱點是頭上的光環：抬頭用手電筒照著光環 3 秒，牠就跪下 8 秒（傷害 2.5 倍） ----------
function updateEmber(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.rainT -= dt; e.vineT -= dt;
  const beam = inBeam(e);
  if (beam) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  if (e.kneel > 0) {
    e.kneel -= dt;
    if (e.kneel <= 0) { toast('👑 燼皇的光環又亮起來了，牠站起來了……', 'warn'); Sound.play('roar', 0.5); }
    return;
  }
  // 光環：抬頭照著牠頭上的光環
  if (beam && p.pitch > 0.12 && d < 11) {
    e.haloT += dt; e.haloLit = true;
    if (e.haloT >= 3) { e.haloT = 0; e.kneel = 8; e.rain = 0; Sound.play('smite'); toast('👑 光環暗掉了！燼皇跪了下來（8 秒），所有傷害 2.5 倍，快打牠！', 'good'); return; }
    if (!G.ev.haloTip) { G.ev.haloTip = 1; toast('👑 照到燼皇的光環了！繼續照（要抬頭）……', 'good'); }
  } else { e.haloLit = false; e.haloT = Math.max(0, e.haloT - dt * 0.5); }
  // 燼雨
  if (e.rainT <= 0) { e.rainT = 14; e.rain = 3; Sound.play('emberRain', nearVol(d) + 0.3); toast('🔥 燼皇張開翅膀……火燼從天花板落下來了！躲到屋頂底下！', 'warn'); }
  if (e.rain > 0) {
    e.rain -= dt;
    for (let i = 0; i < 5; i++) {
      const x = p.x + rand(-5, 5), y = p.y + rand(-5, 5);
      if (!sheltered4(x, y) && !isWall(Math.floor(x), Math.floor(y))) G.fx.push({ type: 'ember', x, y, h: rand(2.5, 4), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vh: -rand(2.5, 4), life: 0.9, max: 0.9, color: pick(EMBER_COLORS) });
    }
    if (!sheltered4(p.x, p.y) && mode === 'play') { p.hp -= 6 * D().dmg * dt; p.hurt = Math.max(p.hurt, 0.3); if (p.hp <= 0) { gameOver(); return; } }
    for (const w of G.b4.list) if (w.tier === 1 && distToWall(p.x, p.y, w) < 5) w.burn = 6;
  }
  // 飄著追你，飄過的地上長出玫瑰藤
  walkTo4(e, p.x, p.y, Math.min(1.6 + n * 0.006, 2.1) * (e.spawn > 0 ? 0.3 : 1), dt, flow);
  if (e.vineT <= 0) { e.vineT = 0.7; G.thorns4.push({ x: e.x, y: e.y, life: 20, r: rand(0.35, 0.5), a: Math.random() * 6 }); if (G.thorns4.length > 40) G.thorns4.shift(); }
  if (d < 1.6 && e.cd <= 0 && e.spawn <= 0 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) {
    damage(26 + n * 0.2, 16); p.inv = 1.4; e.cd = 2.2;
    const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 1.4, Math.sin(a) * 1.4, PLAYER_R);
    Sound.play('stab'); toast('👑 燼皇的利爪抓過你的身體！', 'warn');
  }
}
// 著火的木頭板子、地上的紅涎和玫瑰藤、奶
function updateHazards4(dt) {
  const p = G.p;
  for (const w of [...G.b4.list]) if (w.burn > 0) { w.burn -= dt; damageWall4(w, 10 * dt, null, dt); if (Math.random() < dt * 10) { const [x0, y0, x1, y1] = wallEnds(w); G.fx.push({ type: 'ember', x: (x0 + x1) / 2 + rand(-0.4, 0.4), y: (y0 + y1) / 2 + rand(-0.4, 0.4), h: rand(0.2, 2.4), vx: 0, vy: 0, vh: rand(0.5, 1.4), life: 0.7, max: 0.7, color: pick(EMBER_COLORS) }); } }
  const on = list => p.z < 0.1 && list.some(m => m.life > 1 && (m.x - p.x) ** 2 + (m.y - p.y) ** 2 < m.r * m.r);
  for (const k of ['milk4', 'drool4', 'thorns4']) { for (const m of G[k]) m.life -= dt; G[k] = G[k].filter(m => m.life > 0); }
  if (on(G.drool4)) { p.hp -= 2.5 * D().dmg * dt; p.slowT = Math.max(p.slowT || 0, 0.3); p.hurt = Math.max(p.hurt, 0.3); if (!G.ev.droolTip) { G.ev.droolTip = 1; toast('🩸 踩到紅涎了，好燙！會扣血、走得慢。', 'warn'); } }
  if (on(G.thorns4)) { p.hp -= 3 * D().dmg * dt; p.slowT = Math.max(p.slowT || 0, 0.3); p.hurt = Math.max(p.hurt, 0.3); if (!G.ev.thornTip) { G.ev.thornTip = 1; toast('🌹 踩到燼皇留下的玫瑰藤，刺進腳裡了！跳過去。', 'warn'); } }
  if (p.hp <= 0 && mode === 'play') gameOver();
  G.milk = Math.max(0, (G.milk || 0) - dt * 0.55);
  updateWaves4(dt);
}

// ---------- 晚上：排程、生怪 ----------
function spawnW4Monster(kind) {
  const ev = G.ev;
  if (kind !== 'shake' && G.enemies.some(e => e.kind === kind)) return;
  if (kind !== 'shake' && kind !== 'mimic' && bossFull()) return;
  const e = spawnEnemy(kind, kind === 'shake' ? shakeSpot4() : null);
  if (!e) return;
  if (kind === 'shake') { e.spawn = 0; return; }   // 奶昔安安靜靜地躺在地上，不會有提示
  const tips = {
    mimic: ['🩸 你聽到有人在叫你的名字……那是朋友的聲音嗎？紅涎偽人會模仿朋友的聲音。躲在家裡的時候有人敲門，千萬不要開！', '🩸 那個「朋友」的聲音又出現了……'],
    hubert: ['🕷️ 一隻黑色的大蜘蛛爬進了賣場，底下透著紅光……Hubert 專門拆房子，玻璃板子牠拆不了。看到牠舉起鐵管就跳起來。', '🕷️ Hubert 又來拆房子了……'],
    ember: ['👑 天花板開始落下火燼……燼皇降臨了。弱點是牠頭上的光環：抬頭用手電筒照著光環，牠就會跪下。燼雨來時躲到屋頂底下！', '👑 燼皇又來了……'],
  }[kind];
  if (tips) { toast(ev['tip_' + kind] ? tips[1] : tips[0], 'warn'); ev['tip_' + kind] = 1; }
  Sound.play({ mimic: 'friendCall', hubert: 'hubertRaise', ember: 'emberRain' }[kind] || 'whisper', 0.6);
}
// 奶昔躺的地方：美食區、樣品間的冰箱旁邊（離你遠一點）
function shakeSpot4() {
  const near = FURN.filter(f => /food|drink|cold|fridge|counter|vending/.test(f.type) && Math.hypot(f.x - G.p.x, f.y - G.p.y) > 8);
  for (let i = 0; i < 20 && near.length; i++) {
    const f = pick(near), at = besideFurn(f);
    if (walkable(at.x, at.y)) return { x: at.x + rand(-0.2, 0.2), y: at.y + rand(-0.2, 0.2) };
  }
  return null;
}
function scheduleNight4(add, again, night, n, hz) {
  const blood = G.ev.blood;
  // 葵氏奶昔：每晚 2～4 盒
  for (let i = 0, k = 2 + (night >= 4) + (night >= 8); i < k; i++) add('shake', 2, 40);
  if (night === INTRO4.mimic) add('mimic', 30, 60); else if (night > INTRO4.mimic && (blood || again(0.4))) add('mimic', 20, NIGHT_LEN - 80);
  if (night >= 2 && Math.random() < 0.5) add('friend', 60, NIGHT_LEN - 60);
  if (night === INTRO4.hubert) add('hubert', 40, 70); else if (night > INTRO4.hubert && again(0.3)) add('hubert', 30, NIGHT_LEN - 90);
  if (night === INTRO4.ember || night === LAST_NIGHT) add('ember', 40, 70); else if (night > INTRO4.ember && again(0.2)) add('ember', 60, NIGHT_LEN - 90);
  // 舊怪物（晚上變長了，再來的機率調低一點）：黑球只吃據點的燈；血淚女、小丑、鳥腳女、「它」；第三世界的蕈裂、熔岩暴君、墮落戰神
  if (night >= 2 && again(0.4)) add('blob', 30, NIGHT_LEN - 60);
  if (night >= 3 && again(0.3)) add('woman', 30, NIGHT_LEN - 60);
  if (night >= 3 && again(0.3)) add('clown', 30, NIGHT_LEN - 60);
  if (night >= 4 && again(0.25)) add('momo', 30, NIGHT_LEN - 60);
  if (night >= 5 && (blood || again(0.18))) add('tall', 40, NIGHT_LEN - 80);
  if (night >= 2 && again(0.3)) add('kronos', 30, NIGHT_LEN - 60);
  if (night >= 5 && again(0.22)) add('tyrant', 40, NIGHT_LEN - 80);
  if (night >= 7 && again(0.22)) add('warlord', 40, NIGHT_LEN - 80);
  if (night >= 2 && Math.random() < Math.min(0.35 + n * 0.01, 0.7) * hz) add('blackout', 40, NIGHT_LEN - 40);
  // 紅月：地上長出草，第二世界的怪物都會來（眼球花也會長）
  if (blood) { add('awaken4', 1, 2); for (const k of ['sunflower', 'shroom', 'grass', 'snail', 'girl']) add(k, 20, 120); add('flower', 30, 90); }
}
// 店員：取代黑影，晚上越後面越多（2 隻 → 5 隻），從員工專用區走出來
function updateSpawns4(dt) {
  if (G.phase !== 'night') return;
  const night = G.day, dk = G.diff === 'easy' ? -1 : G.diff === 'hard' ? 1 : 0;
  const max = clamp(2 + Math.floor((night - 1) / 3) + dk + (G.ev.blood ? 1 : 0), 1, 6);
  G.spawnT -= dt;
  if (G.spawnT > 0) return;
  G.spawnT = rand(22, 34) / D().spawn * (G.power ? 1 : 0.8);
  if (G.enemies.filter(e => e.kind === 'staff').length >= max) return;
  const out = W4.staffOut, far = Math.hypot(out.x - G.p.x, out.y - G.p.y) > 10;
  const e = spawnEnemy('staff', far && Math.random() < 0.5 ? { ...out } : null);
  if (e) { e.state = 'patrol'; e.idle = false; }
}
// 紅月的晚上：賣場的地上長出草（3D 畫面），第二世界的怪物就可以出現
function awaken4() {
  G.grass4 = true;
  Sound.play('awaken');
  toast('🌿 紅月……賣場的水泥地上長出了一叢一叢的草。第二世界的怪物要來了。', 'warn');
}

// ====================================================================
// 臉和縮圖（2D 畫法；3D 貼圖、驚嚇畫面、圖鑑的 2D 縮圖共用）。全部寫實風
// ====================================================================
// 血絲（細細彎彎的紅線，從眼白外圍往瞳孔長）
function veins4(c, cx, cy, r0, r1, n, r) {
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    let x = cx + Math.cos(a) * r1, y = cy + Math.sin(a) * r1;
    c.strokeStyle = `rgba(${150 + r() * 60 | 0},${20 + r() * 30 | 0},${30 + r() * 20 | 0},${0.35 + r() * 0.4})`;
    c.lineWidth = 0.6 + r() * 1.4;
    c.beginPath(); c.moveTo(x, y);
    for (let k = 0; k < 5; k++) { const t = (k + 1) / 5, rr = r1 + (r0 - r1) * t, aa = a + (r() - 0.5) * 0.5; x = cx + Math.cos(aa) * rr; y = cy + Math.sin(aa) * rr; c.lineTo(x, y); }
    c.stroke();
  }
}
// SCP-3008-2（照設計圖）：白色的骷髏頭、兩個又大又圓的黑眼窩、鼻子兩個小洞、紅紅的嘴唇咧開一排牙齒
function drawStaffFace(c, S) {
  const r = seeded(30082);
  c.save(); c.scale(S / 512, S / 512);
  const g = c.createRadialGradient(240, 220, 40, 256, 270, 220); g.addColorStop(0, '#fbf8f2'); g.addColorStop(0.7, '#ebe4d6'); g.addColorStop(1, '#bdb2a0');
  c.fillStyle = g; c.beginPath(); c.ellipse(256, 250, 175, 215, 0, 0, Math.PI * 2); c.fill();
  for (let i = 0; i < 220; i++) { c.fillStyle = `rgba(${120 + r() * 60 | 0},${110 + r() * 50 | 0},${95 + r() * 40 | 0},${0.04 + r() * 0.08})`; c.beginPath(); c.arc(90 + r() * 332, 50 + r() * 400, 1 + r() * 4, 0, 7); c.fill(); }
  c.strokeStyle = 'rgba(110,95,80,.4)'; c.lineWidth = 1.5; for (let i = 0; i < 6; i++) { let x = 150 + r() * 210, y = 60 + r() * 80; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 30; y += r() * 22; c.lineTo(x, y); } c.stroke(); }
  // 又大又圓的黑眼窩
  for (const ex of [184, 328]) {
    const eg = c.createRadialGradient(ex, 214, 10, ex, 214, 74); eg.addColorStop(0, '#000'); eg.addColorStop(0.72, '#050404'); eg.addColorStop(0.86, '#3a3028'); eg.addColorStop(1, 'rgba(120,100,80,0)');
    c.fillStyle = eg; c.beginPath(); c.ellipse(ex, 214, 70, 66, 0, 0, 7); c.fill();
  }
  c.fillStyle = '#1a1210'; for (const s of [-1, 1]) { c.beginPath(); c.ellipse(256 + s * 11, 300, 7, 15, s * 0.25, 0, 7); c.fill(); }
  // 紅色的嘴唇，咧開一排牙齒
  c.fillStyle = '#d0202a'; c.beginPath(); c.moveTo(160, 360); c.quadraticCurveTo(256, 322, 352, 360); c.quadraticCurveTo(256, 432, 160, 360); c.fill();
  c.fillStyle = '#2a0406'; c.beginPath(); c.moveTo(176, 362); c.quadraticCurveTo(256, 346, 336, 362); c.quadraticCurveTo(256, 404, 176, 362); c.fill();
  c.fillStyle = '#efe6d2'; for (let x = 186; x < 328; x += 14) { const y0 = 356 - Math.sin((x - 176) / 160 * Math.PI) * 9; c.fillRect(x, y0, 11, 14); }
  c.strokeStyle = 'rgba(90,8,12,.7)'; c.lineWidth = 1.4; for (let i = 0; i < 14; i++) { const x = 176 + r() * 160; c.beginPath(); c.moveTo(x, 342 + r() * 8); c.lineTo(x + (r() - 0.5) * 6, 352 + r() * 6); c.stroke(); }
  c.restore();
}
// 紅涎偽人（照設計圖）：灰白、龜裂的臉，兩隻瞪得很大的眼睛（一隻凸出來、眼眶一圈紅），黑黑的嘴；
// 紅色的涎液從頭頂一道一道流過整張臉，從嘴巴一路往下流
function drawMimicFace(c, S) {
  const r = seeded(4404);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round';
  const g = c.createRadialGradient(256, 230, 40, 256, 250, 240); g.addColorStop(0, '#cfcac2'); g.addColorStop(0.7, '#aaa39a'); g.addColorStop(1, '#6a645c');
  c.fillStyle = g; c.beginPath(); c.ellipse(256, 240, 195, 225, 0, 0, Math.PI * 2); c.fill();
  // 龜裂的紋路
  for (let i = 0; i < 40; i++) { let x = 90 + r() * 330, y = 40 + r() * 400; c.strokeStyle = `rgba(50,44,40,${0.35 + r() * 0.35})`; c.lineWidth = 0.8 + r() * 2; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 50; y += (r() - 0.5) * 50; c.lineTo(x, y); } c.stroke(); }
  // 瞪大的眼睛
  for (const [ex, ey, er, ring] of [[176, 214, 52, true], [334, 210, 46, false]]) {
    c.fillStyle = 'rgba(60,30,30,.6)'; c.beginPath(); c.ellipse(ex, ey + 4, er + 14, er + 10, 0, 0, 7); c.fill();
    const wg = c.createRadialGradient(ex - 12, ey - 14, 6, ex, ey, er); wg.addColorStop(0, '#fbf5ea'); wg.addColorStop(0.8, '#e6d6c6'); wg.addColorStop(1, '#c8a69a');
    c.fillStyle = wg; c.beginPath(); c.arc(ex, ey, er, 0, 7); c.fill();
    veins4(c, ex, ey, er * 0.35, er * 0.98, 18, r);
    c.fillStyle = '#3a3026'; c.beginPath(); c.arc(ex + 4, ey + 2, er * 0.24, 0, 7); c.fill();
    c.fillStyle = '#050403'; c.beginPath(); c.arc(ex + 4, ey + 2, er * 0.12, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(ex - 12, ey - 14, er * 0.1, 0, 7); c.fill();
    if (ring) { c.strokeStyle = '#a01018'; c.lineWidth = 9; c.beginPath(); c.arc(ex, ey, er + 8, 0, 7); c.stroke(); }
  }
  // 黑黑的嘴
  c.fillStyle = '#1a0606'; c.beginPath(); c.ellipse(256, 352, 64, 50, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = 'rgba(200,190,170,.8)'; for (let x = 206; x < 306; x += 13) { c.beginPath(); c.moveTo(x, 312); c.lineTo(x + 6, 330 + r() * 8); c.lineTo(x + 12, 312); c.fill(); }
  // 紅色的涎液：從頭頂往下流過臉（一道一道），再從嘴巴往下流
  const streak = (x, y0, len, w) => {
    const dg = c.createLinearGradient(0, y0, 0, y0 + len); dg.addColorStop(0, '#c0101a'); dg.addColorStop(1, '#7a0008');
    c.strokeStyle = dg; c.lineWidth = w; c.beginPath(); c.moveTo(x, y0); c.bezierCurveTo(x + (r() - 0.5) * 24, y0 + len * 0.35, x + (r() - 0.5) * 24, y0 + len * 0.7, x + (r() - 0.5) * 16, y0 + len); c.stroke();
    c.fillStyle = '#c8121c'; c.beginPath(); c.ellipse(x, y0 + len + 4, w * 0.6, w * 0.9, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(255,190,190,.45)'; c.lineWidth = 2; c.beginPath(); c.moveTo(x - w * 0.25, y0 + 6); c.lineTo(x - w * 0.2, y0 + len * 0.6); c.stroke();
  };
  for (const [x, len] of [[120, 260], [150, 330], [196, 150], [236, 110], [300, 140], [352, 300], [390, 200]]) streak(x, 20 + r() * 30, len, 10 + r() * 10);
  for (const [x, len] of [[232, 150], [258, 170], [282, 130]]) streak(x, 380, len, 12 + r() * 8);
  c.restore();
}
// 燼皇（照設計圖）：長長的、像剝了皮的蒼白臉，一條一條紅色的紋路，深深的眼窩裡兩點火光
function drawEmberFace(c, S) {
  const r = seeded(5505);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round';
  const g = c.createRadialGradient(256, 240, 30, 256, 270, 230); g.addColorStop(0, '#e2cfc6'); g.addColorStop(0.6, '#c49a90'); g.addColorStop(1, '#5a2a26');
  c.fillStyle = g; c.beginPath(); c.ellipse(256, 270, 140, 225, 0, 0, Math.PI * 2); c.fill();
  for (let i = 0; i < 26; i++) { const x = 140 + r() * 232; c.strokeStyle = `rgba(${150 + r() * 70 | 0},${10 + r() * 30 | 0},${20 + r() * 20 | 0},${0.45 + r() * 0.4})`; c.lineWidth = 2 + r() * 4; c.beginPath(); c.moveTo(x, 60 + r() * 60); c.bezierCurveTo(x + (r() - 0.5) * 30, 200, x + (r() - 0.5) * 30, 330, x + (r() - 0.5) * 20, 470); c.stroke(); }
  for (const ex of [204, 308]) {
    c.fillStyle = '#100404'; c.beginPath(); c.ellipse(ex, 236, 44, 34, 0, 0, 7); c.fill();
    const eg = c.createRadialGradient(ex, 238, 1, ex, 238, 22); eg.addColorStop(0, '#fff2b0'); eg.addColorStop(0.4, '#ff5a20'); eg.addColorStop(1, 'rgba(255,40,10,0)');
    c.fillStyle = eg; c.beginPath(); c.arc(ex, 238, 22, 0, 7); c.fill();
  }
  c.fillStyle = '#2a0a08'; c.beginPath(); c.moveTo(256, 290); c.lineTo(240, 334); c.lineTo(272, 334); c.fill();
  c.fillStyle = '#3a0a0a'; c.fillRect(200, 380, 112, 34);
  c.fillStyle = '#e0d0c0'; for (let x = 204; x < 310; x += 12) c.fillRect(x, 380, 8, 24 + r() * 8);
  c.restore();
}
// 葵氏奶昔（照設計圖）：紙盒正面米白色、上下各兩條紅條紋，中間是一顆真的人眼：肉色的眼皮和眼窩、血絲、淡褐色的虹膜
function drawShakeFront(c, S, open = 1) {
  const r = seeded(7707);
  c.save(); c.scale(S / 512, S / 512);
  c.fillStyle = '#f2ebe0'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(${150 + r() * 60 | 0},${140 + r() * 50 | 0},${110 + r() * 40 | 0},${0.03 + r() * 0.07})`; c.fillRect(r() * 512, r() * 512, 2 + r() * 6, 2 + r() * 6); }
  c.fillStyle = '#d24a52'; for (const y of [28, 72, 420, 464]) c.fillRect(0, y, 512, 20);
  for (let i = 0; i < 5; i++) { c.fillStyle = `rgba(150,120,70,${0.06 + r() * 0.08})`; c.beginPath(); c.ellipse(r() * 512, r() * 512, 20 + r() * 60, 10 + r() * 40, r() * 3, 0, 7); c.fill(); }
  const ex = 256, ey = 262;
  // 眼窩和眼皮（肉色、有陰影和皺紋）
  const sk = c.createRadialGradient(ex, ey, 40, ex, ey, 170); sk.addColorStop(0, '#c8907c'); sk.addColorStop(0.6, '#e2b8a2'); sk.addColorStop(1, 'rgba(242,235,224,0)');
  c.fillStyle = sk; c.beginPath(); c.ellipse(ex, ey, 175, 135, 0, 0, 7); c.fill();
  c.strokeStyle = 'rgba(140,80,64,.45)'; c.lineWidth = 3; for (const k of [1.18, 1.3]) { c.beginPath(); c.ellipse(ex, ey - 6, 125 * k, 70 * k, 0, Math.PI * 1.08, Math.PI * 1.92); c.stroke(); }
  const rx = 118, ry = 72 * Math.max(0.05, open);
  c.save(); c.beginPath(); c.ellipse(ex, ey, rx, ry, 0, 0, 7); c.clip();
  const wg = c.createRadialGradient(ex - 20, ey - 20, 10, ex, ey, rx); wg.addColorStop(0, '#fffaf2'); wg.addColorStop(0.8, '#efdccc'); wg.addColorStop(1, '#c8968a');
  c.fillStyle = wg; c.fillRect(ex - rx, ey - 100, rx * 2, 200);
  veins4(c, ex, ey, 40, rx * 0.98, 34, r);
  const ig = c.createRadialGradient(ex, ey, 8, ex, ey, 50); ig.addColorStop(0, '#2a2410'); ig.addColorStop(0.35, '#7a6a3a'); ig.addColorStop(0.8, '#5a6a4a'); ig.addColorStop(1, '#2a2a1a');
  c.fillStyle = ig; c.beginPath(); c.arc(ex, ey, 50, 0, 7); c.fill();
  c.strokeStyle = 'rgba(40,30,10,.5)'; c.lineWidth = 1.5; for (let i = 0; i < 40; i++) { const a = i / 40 * Math.PI * 2; c.beginPath(); c.moveTo(ex + Math.cos(a) * 22, ey + Math.sin(a) * 22); c.lineTo(ex + Math.cos(a) * 48, ey + Math.sin(a) * 48); c.stroke(); }
  c.fillStyle = '#050302'; c.beginPath(); c.arc(ex, ey, 21, 0, 7); c.fill();
  c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(ex - 18, ey - 18, 9, 0, 7); c.fill();
  c.fillStyle = 'rgba(90,40,30,.35)'; c.fillRect(ex - rx, ey - ry, rx * 2, ry * 0.25);   // 上眼皮的影子
  c.restore();
  c.strokeStyle = '#8a4a3e'; c.lineWidth = 7; c.beginPath(); c.ellipse(ex, ey, rx, ry, 0, 0, 7); c.stroke();
  c.strokeStyle = 'rgba(40,20,16,.8)'; c.lineWidth = 2; for (let i = 0; i < 14; i++) { const a = Math.PI * (1.12 + i * 0.055); c.beginPath(); c.moveTo(ex + Math.cos(a) * rx, ey + Math.sin(a) * ry); c.lineTo(ex + Math.cos(a) * (rx + 12), ey + Math.sin(a) * (ry + 16)); c.stroke(); }   // 睫毛
  c.restore();
}
// 神秘店員（照設計圖）：帽兜裡一片黑，兩點發亮的黃眼睛，一張很大的鋸齒狀嘴巴（紅黑色的嘴裡、一排排尖牙）
function drawClerkFace(c, S) {
  c.save(); c.scale(S / 512, S / 512);
  c.fillStyle = '#0a0806'; c.fillRect(0, 0, 512, 512);
  for (const ex of [190, 322]) { const g = c.createRadialGradient(ex, 170, 1, ex, 170, 34); g.addColorStop(0, '#fff6c0'); g.addColorStop(0.35, '#ffcc2a'); g.addColorStop(1, 'rgba(255,200,60,0)'); c.fillStyle = g; c.beginPath(); c.arc(ex, 170, 34, 0, 7); c.fill(); }
  c.fillStyle = '#4a0a06'; c.beginPath(); c.moveTo(70, 250); c.quadraticCurveTo(256, 220, 442, 250); c.quadraticCurveTo(256, 500, 70, 250); c.fill();
  c.fillStyle = '#e8d8a8';
  for (let x = 80; x < 432; x += 30) { c.beginPath(); c.moveTo(x, 246); c.lineTo(x + 15, 320 + Math.sin(x) * 10); c.lineTo(x + 30, 246); c.fill(); }
  for (let x = 110; x < 400; x += 30) { const yb = 250 + Math.sin((x - 70) / 372 * Math.PI) * 160; c.beginPath(); c.moveTo(x, yb); c.lineTo(x + 15, yb - 60); c.lineTo(x + 30, yb); c.fill(); }
  c.restore();
}
// 圖鑑的 2D 縮圖（WebGL 開不起來時用）
function thumbStaff(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.fillStyle = '#e8c23a'; c.fillRect(66, 70, 68, 70);
  c.fillStyle = '#8a4ab0'; for (let x = 70; x < 134; x += 12) c.fillRect(x, 70, 5, 70);
  c.fillStyle = '#2a4aa0'; c.fillRect(70, 140, 26, 56); c.fillRect(104, 140, 26, 56);
  c.fillStyle = '#d9d0bf'; c.fillRect(48, 74, 18, 60); c.fillRect(134, 74, 18, 60);
  c.translate(60, 4); drawStaffFace(c, 80); c.restore();
}
function thumbShake(c, S) { c.save(); c.scale(S / 200, S / 200); c.translate(40, 20); drawShakeFront(c, 120); c.fillStyle = '#d9d0bf'; c.fillRect(30, -12, 60, 14); c.fillStyle = '#eee'; c.fillRect(56, -20, 6, 14); c.restore(); }
function thumbMimic(c, S) { c.save(); c.scale(S / 200, S / 200); c.translate(10, 4); drawMimicFace(c, 180); c.restore(); }
function thumbHubert(c, S) {
  // 黑色的胖蜘蛛（照設計圖）：大圓肚子、小圓頭、八隻粗腳、抓著一根鐵管
  c.save(); c.scale(S / 200, S / 200);
  const g = c.createRadialGradient(100, 170, 4, 100, 180, 60); g.addColorStop(0, 'rgba(255,40,30,.8)'); g.addColorStop(1, 'rgba(255,40,30,0)'); c.fillStyle = g; c.fillRect(30, 140, 140, 60);
  c.strokeStyle = '#1a1a1e'; c.lineWidth = 11; c.lineCap = 'round';
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) { c.beginPath(); c.moveTo(100 + s * 30, 120); c.lineTo(100 + s * (60 + k * 12), 88 + k * 6); c.lineTo(100 + s * (70 + k * 8), 180 - k * 4); c.stroke(); }
  const b = c.createRadialGradient(84, 100, 6, 100, 118, 56); b.addColorStop(0, '#4a4a50'); b.addColorStop(1, '#0e0e10');
  c.fillStyle = b; c.beginPath(); c.arc(100, 118, 52, 0, 7); c.fill();
  c.beginPath(); c.arc(100, 52, 24, 0, 7); c.fill();
  c.fillStyle = '#7a0a10'; for (const [x, y] of [[92, 54], [108, 54], [86, 47], [114, 47]]) { c.beginPath(); c.arc(x, y, 3, 0, 7); c.fill(); }
  c.fillStyle = '#5a5d62'; c.fillRect(156, 70, 14, 84);
  c.restore();
}
function thumbEmber(c, S) {
  // 燼皇（照設計圖）：張開的紅翅膀、下擺燒著火、紅色的光環、腳邊一圈紅玫瑰
  c.save(); c.scale(S / 200, S / 200);
  c.fillStyle = '#b0101a'; c.beginPath(); c.moveTo(100, 60); c.lineTo(8, 40); c.lineTo(20, 190); c.lineTo(180, 190); c.lineTo(192, 40); c.closePath(); c.fill();
  c.fillStyle = '#ff8a2a'; for (let x = 20; x < 180; x += 16) { c.beginPath(); c.moveTo(x, 190); c.lineTo(x + 8, 140 + (x % 3) * 10); c.lineTo(x + 16, 190); c.fill(); }
  c.fillStyle = '#e2cfc6'; c.fillRect(92, 60, 16, 120);
  c.strokeStyle = '#ff3a3a'; c.lineWidth = 4; c.beginPath(); c.ellipse(100, 14, 26, 8, 0, 0, 7); c.stroke();
  c.fillStyle = '#c0101c'; for (let i = 0; i < 9; i++) { c.beginPath(); c.arc(40 + i * 15, 192, 4, 0, 7); c.fill(); }
  c.translate(72, 18); drawEmberFace(c, 56); c.restore();
}

// ====================================================================
// 燈泡圖鑑的「拿過」紀錄：燈泡（第 1～15 級）、手電筒（第 1～7 級）、板子（五級）。拿過一次就記住，
// 存在 home99_progress_v1（跟解鎖世界、見過的怪物放在一起），刪存檔也不會清掉；測試版全部都算拿過
// ====================================================================
let gotCache = null;
function gotSets() {
  if (!gotCache) {
    const p = readProg();
    gotCache = { bulbs: new Set(Object.keys(p.bulbs || {}).map(Number)), flash: new Set(Object.keys(p.flash || {}).map(Number)), planks: new Set(Object.keys(p.planks || {}).map(Number)) };
    gotCache.flash.add(1);
  }
  return gotCache;
}
function markGot(kind, n) {
  if (TEST_MODE || !n) return;
  const s = gotSets()[kind];
  if (s.has(n)) return;
  s.add(n);
  const p = readProg();
  p[kind] = p[kind] || {}; p[kind][n] = 1;
  writeProg(p);
}
const markBulb = t => markGot('bulbs', t), markFlash = lv => markGot('flash', lv), markPlank = t => markGot('planks', t);
const gotIt = (kind, n) => TEST_MODE || gotSets()[kind].has(n);
// 舊玩家第一次用新版打開：照存檔裡最好的燈泡、手電筒等級補上
function initGot() {
  if (TEST_MODE) return;
  const p = readProg();
  if (p.gotInit) return;
  const s = readSave();
  p.bulbs = p.bulbs || {}; p.flash = p.flash || {};
  if (s) {
    const best = (s.stats && s.stats.bestTier) || 1;
    for (let t = 1; t <= Math.min(best, NORMAL_MAX); t++) p.bulbs[t] = 1;
    for (const id in s.inv || {}) if (ITEMS[id] && ITEMS[id].kind === 'bulb') p.bulbs[ITEMS[id].tier] = 1;
    for (const b of s.sockets || []) if (b && BULBS[b]) p.bulbs[b] = 1;
    const fl = (s.p && s.p.flashLv) || 1;
    for (let lv = 1; lv <= fl; lv++) p.flash[lv] = 1;
  }
  p.gotInit = true;
  writeProg(p);
  gotCache = null;
}

// 物品列最後面的 ✋ 那一格：手上拿的板子、家具，或背包滿了多拿的第 17 個
function handSlot4() {
  const h = G.hand;
  const ic = h.k === 'plank' ? plankIcon(h.tier, h.door) : h.k === 'furn' ? '<div class="ic"><span>🛋️</span></div>' : itemIcon(h.id);
  const name = h.k === 'plank' ? plankName(h.tier, h.door) : h.k === 'furn' ? h.f.name : itemName(h.id);
  return `<div class="slot hand" data-id="" title="手上：${name}"><span class="key">✋</span>${ic}<span class="cnt">${h.k === 'item' && h.n > 1 ? h.n : ''}</span></div>`;
}

// ====================================================================
// 第三到第四世界的過場：列車到站之後，走出車站，對面是一間巨大的賣場「3008」。走進自動門，門在身後消失了……
// 1. 淡出 → 2. 站在賣場的入口（燈還沒亮）→ 3. 日光燈一排一排「啪、啪、啪」亮起來 → 4. 大字「第四世界：3008 無盡賣場」→ 第 1 天早上
// 大約 10 秒，點一下畫面可以跳過
// ====================================================================
const CUT4 = { fade: 0.8, lights: 2.4, title: 6.4, end: 9.6 };
function startCutscene4(carry) {
  unlockW4();
  CUT = { kind: 4, t: 0, switched: false, carry };
  mode = 'cutscene';
  Sound.setDrone(0);
  releaseInputs();
  if (document.pointerLockElement) document.exitPointerLock();
  for (const id of ['gameover', 'hud']) $(id).classList.add('hidden');
  $('cutscene').classList.remove('hidden');
  cutCaption('列車到站了……', '走出車站，對面是一間好大的家具賣場');
}
function cut4Switch(c) {
  if (c.switched) return;
  c.switched = true;
  newGame(c.carry.diff, 4, c.carry);
  mode = 'cutscene';
  $('hud').classList.add('hidden');
  G.t = 0; G.phase = 'day';
  cutCaption('自動門在身後關上了……', '');
  Sound.play('doorSlam', 0.6);
}
function updateCutscene4(dt) {
  const c = CUT, K = CUT4;
  c.t += dt; G.time += dt;
  let black = 0;
  if (c.t < K.fade) black = c.t / K.fade;
  else {
    cut4Switch(c);
    black = c.t < K.fade + 0.8 ? 1 - (c.t - K.fade) / 0.8 : c.t > K.end - 0.8 ? (c.t - (K.end - 0.8)) / 0.8 : 0;
    // 日光燈一排一排亮起來（白天的天亮那一段）
    G.t = c.t < K.lights ? 0 : Math.min(DAWN, (c.t - K.lights) * 2.2);
    if (c.t >= K.lights && !c.lit) { c.lit = true; Sound.play('lightsOn'); cutCaption('燈一排一排亮起來，一眼望不到頭的家具……', '走進去之後，就再也找不到出口了。'); }
    if (c.t >= K.title && !c.titled) { c.titled = true; cutCaption('第四世界：3008 無盡賣場', '自己蓋房子、找食物；晚上燈熄了，店員會出來'); }
    const look = Math.sin(c.t * 0.35) * 0.35;
    c.cam = { x: W4.start.x, y: W4.start.y + 0.6 - Math.min(1, c.t / K.end) * 1.4, h: 0, face: W4.start.face + look, pitch: 0.05 };
  }
  const fade = $('cutFade');
  fade.style.background = '#000'; fade.style.opacity = clamp(black, 0, 1).toFixed(3);
  if (c.t >= K.end) endCutscene4();
}
function skipCutscene4() { if (CUT && CUT.t < CUT4.end - 0.8) { cut4Switch(CUT); CUT.t = CUT4.end - 0.8; } }
function endCutscene4() {
  cut4Switch(CUT);
  G.phase = 'day'; G.t = 0;
  Object.assign(G.p, { ...W4.start, pitch: 0, z: 0, vz: 0 });
  CUT = null; $('cutscene').classList.add('hidden'); $('cutFade').style.opacity = '0'; $('hud').classList.remove('hidden'); cutCaption('');
  mode = 'play'; invDirty = true; lockPointer();
  saveGame();
  showBig('第 1 天', '拿板子蓋一間房子、找食物');
  toast('🏬 第四世界解鎖了！之後在主選單「新遊戲」也可以直接選第四世界。', 'good');
}

// ====================================================================
// 第四世界破關：天亮了，賣場的燈又亮起來……結局畫面
// ====================================================================
function victory4() {
  CUT = { kind: 5, t: 0 };
  mode = 'cutscene';
  Sound.setDrone(0);
  releaseInputs();
  if (document.pointerLockElement) document.exitPointerLock();
  $('hud').classList.add('hidden');
  $('cutscene').classList.remove('hidden');
  cutCaption('🌅 天亮了', '日光燈一排一排亮了起來……');
  for (const e of G.enemies) puff(e.x, e.y);
  G.enemies = [];
}
function updateCutscene5(dt) {
  const c = CUT;
  c.t += dt; G.time += dt;
  G.phase = 'day'; G.t = Math.min(DAWN, c.t * 2);
  if (c.t > 0.3 && !c.lit) { c.lit = true; Sound.play('lightsOn'); }
  c.cam = { x: G.p.x, y: G.p.y, h: 0, face: G.p.face + Math.sin(c.t * 0.4) * 0.15, pitch: 0.08 };
  const white = clamp((c.t - 3.5) / 1.8, 0, 1), fade = $('cutFade');
  fade.style.background = '#fffaf0'; fade.style.opacity = white.toFixed(3);
  if (c.t >= 5.6) endVictory4();
}
function endVictory4() {
  CUT = null; $('cutscene').classList.add('hidden'); $('cutFade').style.opacity = '0'; cutCaption('');
  mode = 'over';
  Sound.play('win');
  if (!TEST_MODE) try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  $('goTitle').textContent = '🏬 你在 3008 撐過了 12 夜';
  $('goText').innerHTML = `天亮了，日光燈一排一排亮起來，店員們又站回走道上一動也不動。<br>賣場還是沒有出口……但你有了自己的家。<br>你在第四世界撐過了 ${LAST_NIGHT} 夜！搜索了 ${G.stats.searched} 次，打倒了 ${G.stats.dissolved} 個怪物。<br>最好的燈泡：${bulbName(G.stats.bestTier)}`;
  $('btnRetry').classList.add('hidden'); $('btnNextWorld').classList.add('hidden');
  $('gameover').classList.remove('hidden');
}

// ====================================================================
// 燈泡圖鑑（主選單和暫停選單）：燈泡第 1～15 級、手電筒第 1～7 級、板子五級。沒拿過的只顯示問號，名字和說明照樣看得到
// ====================================================================
let bulbFrom = 'title';
function openBulbBook(from) {
  bulbFrom = from;
  $(from).classList.add('hidden');
  $('bulbBook').classList.remove('hidden');
  showBulbPage('bulb');
}
// 手電筒卡片邊框閃的顏色（星晃照設計圖是黑和白）
const flashCardCols = lv => (lv === FLASH_MAX ? ['#ffffff', '#141414'] : FLASH_TIERS[lv].beam.map(c => `rgb(${c.join(',')})`));
function flashKeyframes4() {
  if (document.getElementById('flashKF')) return;
  let css = '';
  for (let lv = 4; lv <= FLASH_MAX; lv++) {
    const cols = flashCardCols(lv), n = cols.length;
    css += `@keyframes flk${lv} {` + [...cols, cols[0]].map((c, i) => `${(i * 100 / n).toFixed(1)}% { border-color: ${c}; box-shadow: 0 0 12px ${c}; }`).join(' ') + '}\n';
  }
  const st = document.createElement('style'); st.id = 'flashKF'; st.textContent = css; document.head.appendChild(st);
}
function showBulbPage(tab) {
  for (const b of document.querySelectorAll('#bulbTabs button')) b.classList.toggle('on', b.dataset.t === tab);
  const card = (got, rar, ic, name, lines, anim = '') => {
    const col = rar ? RARITY[rar].color : '#6a6478';
    return `<div class="bcardx${got ? '' : ' unseen'}" style="--rc:${col}${got && anim ? `;animation:${anim}` : ''}">${got ? ic : '<div class="ic q">？</div>'}<div class="tx"><b>${name}</b>` +
      (rar ? `<span><span class="rar r-${rar}">${RARITY[rar].name}</span></span>` : '') + lines.map(l => `<span>${l}</span>`).join('') + '</div></div>';
  };
  let html = '', note = '';
  if (tab === 'bulb') {
    note = '燈泡分 11 級，另外有 4 種有技能的特殊燈泡。等級越高照得越遠。第二、三世界的第 6～8 級燈泡會換個樣子；第四世界的燈泡全部變成放在地上的檯燈。沒拿過的燈泡只會顯示問號。';
    for (let t = 1; t <= MAX_TIER; t++) {
      const b = BULBS[t], v = [BULBS_W2[t] && `第二世界：${BULBS_W2[t].name}`, BULBS_W3[t] && `第三世界：${BULBS_W3[t].name}`].filter(Boolean);
      const range = b.noLight ? '不會發光' : `照 ${b.r} 格`;
      html += card(gotIt('bulbs', t), bulbRarity(t), `<div class="ic">${bulbSVG(t)}</div>`, b.name, [`${b.special || t === FIRE_TIER ? '特殊燈泡' : `第 ${t} 級`}・${range}`, b.desc, ...v.map(x => `<small>${x}</small>`)]);
    }
  } else if (tab === 'flash') {
    note = '手電筒照著怪物會一直扣牠的血。第 1～3 級在前三個世界都拿得到；第 4～7 級是第四世界的（地圖大，光線更大），光會變色。撿到就自動換上。';
    // 第 4～7 級的卡片邊框跟生物圖鑑的閻羅、酆都級一樣會閃：光有幾個顏色，邊框就在幾個顏色之間閃（星晃是黑和白）
    flashKeyframes4();
    for (let lv = 1; lv <= FLASH_MAX; lv++) {
      const f = FLASH_TIERS[lv], cols = f.beam ? f.beam.map(c => `rgb(${c.join(',')})`) : [f.color, f.color];
      const ic = `<div class="ic"><div class="flashbeam" style="background:linear-gradient(90deg,#555 0 22%,${cols.join(',')})"></div></div>`;
      const rar = lv <= 1 ? 'common' : lv === 2 ? 'rare' : lv === 3 ? 'legend' : lv <= 5 ? 'epic' : lv === 6 ? 'legend' : 'mythic';
      html += card(gotIt('flash', lv), rar, ic, f.name, [`第 ${lv} 級・傷害 ${f.dmg} 倍・照 ${f.range} 格`, f.desc || (lv === 1 ? '一開始就有的舊手電筒。' : lv === 2 ? '打怪物的傷害變 2 倍、照得更遠。' : '傷害 3 倍、照得最遠，光圈也更寬。'), lv >= 4 ? '<small>第四世界：神秘店員賣下一級、寶藏星星、很好的早晨禮物</small>' : ''], f.beam ? `flk${lv} ${0.7 * flashCardCols(lv).length}s linear infinite` : '');
    }
  } else {
    note = '第四世界的房子要自己蓋：板子分五級，等級越高越耐打。板子不能放進背包，一次只能拿一片。木門可以開關。';
    for (let t = 1; t <= PLANK_MAX; t++) {
      const pk = PLANKS[t];
      html += card(gotIt('planks', t), pk.rar, plankIcon(t), pk.name, [`耐打 ${t === GLASS_TIER ? '∞（打不破）' : pk.hp}・神秘店員 🪙 ${pk.price}`, pk.desc]);
    }
  }
  $('bulbNote').textContent = note;
  $('bulbList').innerHTML = html;
}
