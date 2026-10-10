'use strict';
// ===== 第三世界：末班列車 =====
// 白天列車停在車站（地圖最下面一排），可以下車找物資和寶箱；晚上列車開走，車站鎖起來，
// 要把木柴、木炭丟進機車室的火爐讓列車一直開。火熄了列車停下來，車外的東西就會擠進來。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、toast、move… 都是遊戲跑起來之後才呼叫。

const roomAt = (x, y) => (inMap(Math.floor(x), Math.floor(y)) ? roomGrid[Math.floor(y)][Math.floor(x)] : null);
const trainK = () => (G && G.train && curWorld === 3 ? G.train.k : 0);   // 車速 0～1（風景捲動、鏡頭和燈晃動用）
const curStation = () => STATIONS_W3[clamp((G.station || 0), 0, STATIONS_W3.length - 1)];
// 晚上窗外的風景照天數換；白天停在車站，窗外是站場
const scenery3 = () => (G.phase === 'night' || (mode === 'cutscene' && CUT && CUT.kind === 2 && CUT.moving) ? SCENERY_W3[clamp(G.day - 1, 0, SCENERY_W3.length - 1)] : 'yard');

// ====================================================================
// 車站的門：白天開著，天黑前 3 秒關上並鎖住（門板壓到的人推回車上；還留在車站的人在最後一刻跳上車）
// ====================================================================
const stationDoors = () => DOORS.filter(d => d.station);
function lockStation(lock) {
  for (const d of stationDoors()) setDoor(d, lock, lock);
  if (!lock) return;
  const p = G.p, r = roomAt(p.x, p.y), onDoor = doorGrid[Math.floor(p.y)] && doorGrid[Math.floor(p.y)][Math.floor(p.x)];
  if ((onDoor && onDoor.station) || isStationRoom(r)) {
    let best = null, bd = Infinity;
    for (const d of stationDoors()) { const dd = Math.hypot(d.x + 0.5 - p.x, d.y + 0.5 - p.y); if (dd < bd) { bd = dd; best = d; } }
    p.x = best.x + 0.5; p.y = best.y - 0.6; p.face = -Math.PI / 2;
    if (isStationRoom(r)) { toast('🚂 你在最後一刻跳上了車！', 'warn'); p.san -= 10 * D().san; G.shake = 0.5; Sound.play('thump'); }
  }
  // 從寶箱跑出來、還留在車站的怪物不會上車
  for (const e of G.enemies) if (isStationRoom(roomAt(e.x, e.y))) { e.dead = true; puff(e.x, e.y); }
  G.enemies = G.enemies.filter(e => !e.dead);
}

// ====================================================================
// 每天早上：列車停靠下一站，車站的門打開
// ====================================================================
function startDay3(d) {
  lockStation(false);
  G.station = clamp(d - 1, 0, STATIONS_W3.length - 1);
  G.cold = !!G.forceCold || COLD_DAYS.includes(d);
  G.train = { state: 'run', k: 0, t: 0, stopT: 0 };   // 停在車站
  G.lava = [];
  Object.assign(G.ev, { whistled: false, lockWarned: false, clackT: 0, fireLow: 0 });
  placeChests3();
  toast(`🚉 列車停靠在「${curStation()}」。白天車站的門開著，下車去找物資和寶箱吧。`, 'good');
  if (G.cold) toast('❄️ 寒寂之境：今天整天下雪、零下 100 度。體溫歸零就會死，常回火爐旁邊取暖！', 'warn');
}
// 讀存檔：白天開始，門開著
function loadDay3(chests) {
  lockStation(false);
  G.station = clamp(G.day - 1, 0, STATIONS_W3.length - 1);
  G.cold = COLD_DAYS.includes(G.day);
  G.train = { state: 'run', k: 0, t: 0, stopT: 0 };
  G.chests3 = chests.filter(c => CHESTS3[c.lv] && inMap(c.x, c.y)).map(c => ({ x: c.x, y: c.y, lv: c.lv, open: !!c.open, out: !!c.out, face: chestFace(c.x, c.y) }));
  if (!G.chests3.length) placeChests3(); else rebuildChestGrid();
}
// 第 1 天的教學提示
function dayTips3() {
  const ev = G.ev, t = G.t;
  if (t > 3 && !ev.w3tip1) { ev.w3tip1 = 1; toast('🚂 歡迎來到末班列車。白天列車停在車站：從車廂往南的三扇門下車，去車站找物資和寶箱。'); }
  if (t > 13 && !ev.w3tip2) { ev.w3tip2 = 1; toast(`🪵 晚上要把木柴、木炭丟進${RN('attic')}的火爐，列車才會一直開。${RN('basement')}的木堆每天都有木柴。`); }
  if (t > 25 && !ev.w3tip3) { ev.w3tip3 = 1; toast('🚪 天黑前 20 秒會聽到汽笛，天黑前 3 秒車站的門就會鎖上，一定要先回到車上！', 'warn'); }
  if (t > 37 && !ev.tipPan && !G.inv.pan) { ev.tipPan = 1; toast(`🍳 ${RN('kitchen')}的抽屜裡好像有一個平底鍋，可以拿來打怪物！`); }
  if (t > 50 && !ev.w3tip4) { ev.w3tip4 = 1; toast(`🪙 神秘商人在${RN('basement')}，幸運機在${RN('garage')}，修車工具台在${RN('storage')}。`); }
  if (t > 64 && !ev.w3tip5) { ev.w3tip5 = 1; toast('💡 這裡的藍鑽、紅鑽、紫鑽燈泡，變成了黃銅、鍍金、水晶吊燈燈泡。'); }
}
// 白天：汽笛、鎖門、月台上飄過的蒸汽
function updateDay3(dt) {
  const ev = G.ev;
  if (!ev.whistled && G.t >= DAY_LEN - DUSK) { ev.whistled = true; Sound.play('whistle'); }
  if (!ev.lockWarned && G.t >= DAY_LEN - 3) { ev.lockWarned = true; lockStation(true); Sound.play('doorSlam'); toast('🚪 車站的門關上鎖住了，列車要開了。', 'warn'); }
  if (Math.random() < dt * 1.5) steamPuff();
}
// 月台上一團一團飄過的蒸汽
function steamPuff() {
  const x = rand(2, 15), y = rand(26.5, 31);
  for (let i = 0; i < 5; i++) G.fx.push({ type: 'smoke', x: x + rand(-0.3, 0.3), y: y + rand(-0.3, 0.3), h: rand(0.3, 1.6), vx: rand(0.6, 1.4), vy: rand(-0.15, 0.15), vh: rand(0.1, 0.4), life: rand(1.5, 2.6), max: 2.6, color: [205, 200, 195] });
}

// ====================================================================
// 晚上：列車在開（車輪聲、風景捲動）
// ====================================================================
function startNight3() {
  lockStation(true);
  G.train.t = 0;
  G.ev.clackT = 0.5;
}
function updateNight3(dt) {
  const tr = G.train, ev = G.ev;
  tr.t += dt;
  updateFire3(dt);
  if (mode !== 'play') return;
  ev.clackT -= dt;
  if (tr.k > 0.15 && ev.clackT <= 0) { ev.clackT = 0.56 / tr.k; Sound.play('clack', 0.3 * tr.k); }
}
// 夜晚排程：第二世界追過來的大嘴觸角蟲和眼花女孩（第 1 夜就可能來）
function scheduleNight3(add, again, night, n, hz) {
  if (again(0.35)) add('snail', 30, NIGHT_LEN - 35);
  if (night === 1 ? Math.random() < 0.5 : again(0.4)) add('girl', 25, NIGHT_LEN - 40);
  if (night >= 4 && Math.random() < 0.35 * hz) add('tender', 30, NIGHT_LEN - 40);   // 煤水車被撬開
}

// ====================================================================
// 火爐：有沒有在燒（晚上有燃料才算；白天只有餘火）、燈光
// ====================================================================
const fireBurning = () => !!(G && G.fire && G.fire.queue.length && G.phase === 'night');
function addLights3(L) {
  for (const id of ['gaslamp1', 'gaslamp2']) {
    const f = FURN_BY_ID[id];
    if (f && f.room) L.push({ x: f.x + 0.5, y: f.y + 0.5, r: 2.8, tier: 0, room: f.room, f: 0.75 + Math.random() * 0.15, color: [255, 190, 110] });
  }
  const fb = FURN_BY_ID.firebox;
  if (fb && fb.room && G.fire) {
    const k = fireBurning() ? 1 : G.fire.queue.length ? 0.4 : 0.12;
    L.push({ x: fb.x + 1, y: fb.y + 1, r: 1 + 3.5 * k, tier: 0, room: fb.room, f: k * (0.85 + Math.random() * 0.15), color: [255, 140, 50], fire: true });
  }
}

// ====================================================================
// 介面：狀態列的提示、互動、小地圖、測試參數、結局
// ====================================================================
function alerts3() {
  const a = [], tr = G.train;
  if (G.phase === 'day' && G.t >= DAY_LEN - DUSK && G.t < DAY_LEN - 3) a.push('🚂 列車快開了，快上車！');
  if (G.phase === 'night') {
    if (tr.state === 'slowing') a.push('🚂 列車在減速！快丟燃料進火爐');
    else if (tr.state === 'stopped') a.push(`🚂 列車停了！→ ${RN('attic')}的火爐`);
    else if (tr.state === 'starting') a.push('🚂 列車重新開動中……');
    else if (fuelLeft() < 20) a.push(`🔥 火快熄了（剩 ${Math.round(fuelLeft())} 秒）`);
  }
  return a;
}
// 狀態列：🔥 火力（火還能燒幾秒，低於 20 秒會閃）、🌡️ 體溫（只有寒寂之境顯示）
function hud3() {
  const w3 = isW3();
  $('fireBar').classList.toggle('hidden', !w3);
  $('tempBar').classList.toggle('hidden', !w3 || !G.cold);
  if (!w3) return;
  const left = fuelLeft();
  setBar('fireFill', left / NIGHT_LEN * 100);
  $('fireFill').classList.toggle('low', left < 20);
  const txt = `${Math.round(left)} 秒`;
  if ($('fireText').textContent !== txt) $('fireText').textContent = txt;
  if (G.cold) setBar('tempFill', G.p.temp);
}
function overlays3() {
  const tr = G.train, stopped = tr.state === 'stopped' || tr.state === 'starting';
  $('stopfx').style.opacity = G.phase === 'night' && stopped ? (0.7 + 0.3 * Math.sin(G.time * 6)).toFixed(3) : '0';
  $('timefx').style.opacity = (G.timeFlash || 0).toFixed(3);
  $('coldfx').style.opacity = (G.frost || 0).toFixed(3);
}
function addTargets3(cands) {
  const p = G.p, fb = FURN_BY_ID.firebox;
  if (fb) {
    const rd = rectDist(p.x, p.y, fb);
    if (rd < 1.3) {
      const a = Math.min(lookAngle(clamp(p.x, fb.x, fb.x + fb.w), clamp(p.y, fb.y, fb.y + fb.h)), lookAngle(fb.x + 1, fb.y + 1));
      if (a < 1.0 || rd < 0.4) fireboxTarget(cands, rd + a * 0.9);
    }
  }
  chestTargets(cands);
}
// 小地圖：寶箱（照等級的顏色）
function drawMinimap3(c) {
  for (const ch of G.chests3) {
    c.fillStyle = ch.open ? 'rgba(160,150,140,.5)' : ['', '#a0784a', '#8a8f96', '#d0d6dd', '#e8f0ff'][ch.lv];
    c.fillRect(ch.x + 0.15, ch.y + 0.15, 0.7, 0.7);
  }
}
function testStart3(q, night) {
  if (q.has('cold')) { G.forceCold = true; G.cold = true; }
  if (q.get('fire') === '0') G.fire.queue = [];
  else if (night > 1) G.fire.queue = [{ id: 'charcoal', left: 55 }, { id: 'charcoal', left: 55 }, { id: 'charcoal', left: 55 }];   // 從某一夜開始測：火爐先放好燃料
}

// ====================================================================
// 火爐和燃料：對著火爐按 E 把燃料丟進去（一次最多 4 份，照放的順序燒）；晚上才會燒，白天只有餘火
// 火熄了列車先減速，5 秒後停下來：車外的東西拍打車身、擠進來，每秒扣血；補燃料 4 秒後重新開動
// ====================================================================
const fuelLeft = () => G.fire.queue.reduce((s, q) => s + q.left, 0);
const FUEL_ORDER = ['newspaper', 'cushion', 'wood', 'charcoal'];   // 最差的排前面
const worstFuel = () => FUEL_ORDER.find(id => G.inv[id] > 0) || null;
function nearFirebox() {
  const f = FURN_BY_ID.firebox;
  return !!f && rectDist(G.p.x, G.p.y, f) < 1.3;
}
function addFuel(id) {
  const it = ITEMS[id];
  if (!it || it.kind !== 'fuel' || !G.inv[id]) return false;
  if (G.fire.queue.length >= FUEL_SLOTS) { toast(`🔥 火爐已經放了 ${FUEL_SLOTS} 份燃料，燒完才能再放。`, 'warn'); Sound.play('empty'); return false; }
  removeItem(id);
  G.fire.queue.push({ id, left: it.burn });
  Sound.play('fuelIn'); makeNoise(3);
  toast(`🔥 把${it.name}丟進了火爐（還能燒 ${Math.round(fuelLeft())} 秒）`, 'good');
  if (!G.ev.fuelTip) { G.ev.fuelTip = 1; toast('🔥 狀態列的「火力」就是火還能燒幾秒。一個晚上 150 秒，大約要 6 根木柴或 3 塊木炭。'); }
  if (G.phase === 'night' && G.train.state !== 'run') restartTrain();
  return true;
}
function useFuel(id) {
  if (nearFirebox()) addFuel(id);
  else toast(`🪵 走到${RN('attic')}的火爐前面按 E，就會把${ITEMS[id].name}丟進去。`);
}
// 火爐的互動：選著燃料就丟那個，沒選就丟背包裡最差的
function fireboxTarget(cands, d) {
  const sel = G.selId && ITEMS[G.selId].kind === 'fuel' ? G.selId : worstFuel();
  const total = Math.round(fuelLeft()), q = G.fire.queue.length;
  if (sel) cands.push({ d: d - 0.3, id: 'firebox', label: `丟 ${ITEMS[sel].name} 進火爐`, sub: `火爐：${q}/${FUEL_SLOTS} 份，還能燒 ${total} 秒`, hold: 0, action: () => addFuel(sel) });
  else cands.push({ d, id: 'fireboxEmpty', label: `火爐：${q}/${FUEL_SLOTS} 份，還能燒 ${total} 秒`, sub: '背包裡沒有燃料（木柴、木炭、椅墊、舊報紙）' });
}
function trainStop() {
  const tr = G.train;
  tr.state = 'stopped'; tr.k = 0; tr.stopT = 0; tr.poundT = 0.3;
  Sound.play('trainStop'); G.shake = 0.8;
  showBig('列車停了……', '車外有東西貼在玻璃上。快丟燃料進火爐！');
  toast('🚂 列車停了！窗外有一雙雙手和眼睛，車身被拍打、搖晃……每秒都在扣血，快去機車室丟燃料！', 'warn');
}
function restartTrain() {
  const tr = G.train;
  if (tr.state === 'slowing') { tr.state = 'run'; toast('🔥 火又燒起來了，列車繼續開。', 'good'); }
  else if (tr.state === 'stopped') { tr.state = 'starting'; tr.t = 0; Sound.play('trainStart'); toast(`🔥 火燒起來了，列車 ${TRAIN_RESTART} 秒後重新開動……撐住！`, 'good'); }
}
function updateFire3(dt) {
  const fr = G.fire, tr = G.train, ev = G.ev;
  if (fr.queue.length) {
    fr.queue[0].left -= dt;
    if (fr.queue[0].left <= 0) { fr.queue.shift(); if (!fr.queue.length) toast('🔥 火熄了！快丟燃料進火爐，不然列車會停下來。', 'warn'); }
  }
  const left = fuelLeft();
  if (left > 0 && left < 20 && !ev.fireLow) { ev.fireLow = 1; toast(`🔥 火快熄了！只剩 ${Math.round(left)} 秒。`, 'warn'); }
  if (left >= 20) ev.fireLow = 0;
  if (tr.state === 'run') {
    if (!fr.queue.length) { tr.state = 'slowing'; tr.t = 0; Sound.play('trainSlow'); toast('🚂 火熄了，列車在減速……', 'warn'); }
    else tr.k = Math.min(1, tr.k + dt * 0.3);
  } else if (tr.state === 'slowing') {
    tr.t += dt; tr.k = Math.max(0, 1 - tr.t / TRAIN_STOP_DELAY);
    if (fr.queue.length) restartTrain();
    else if (tr.t >= TRAIN_STOP_DELAY) trainStop();
  } else if (tr.state === 'stopped' || tr.state === 'starting') {
    tr.k = 0; tr.stopT += dt; tr.poundT = (tr.poundT || 0) - dt;
    const mult = (ev.blood ? 2 : 1) * (tr.state === 'starting' ? 0.5 : 1);   // 紅月時扣血加倍
    G.p.hp -= 6 * mult * D().dmg * dt; G.p.san -= 3 * mult * D().san * dt;
    G.shake = Math.max(G.shake, 0.2); G.p.hurt = Math.max(G.p.hurt, 0.25);
    if (tr.poundT <= 0) { tr.poundT = rand(0.5, 1.3); Sound.play('pound'); G.shake = 0.6; }
    if (G.p.hp <= 0) { G.p.hp = 0; gameOver('train'); return; }
    if (tr.state === 'starting') { tr.t += dt; if (tr.t >= TRAIN_RESTART) { tr.state = 'run'; tr.k = 0.05; toast('🚂 列車重新開動了！車外的東西掉下去了。', 'good'); } }
  }
}
// 煤水車被撬開（第 4 夜起）：火爐裡還沒燒的燃料被偷走一份
function tenderRaid() {
  const q = G.fire.queue;
  Sound.play('crack'); G.shake = Math.max(G.shake, 0.3);
  if (q.length > 1) {
    const [taken] = q.splice(1 + Math.floor(Math.random() * (q.length - 1)), 1);
    toast(`🪓 煤水車被撬開了！火爐裡還沒燒的${ITEMS[taken.id].name}被偷走了，記得補上。`, 'warn');
  } else toast('🪓 有東西在翻煤水車……幸好火爐裡沒有多的燃料可以偷。', 'warn');
}
// 車廂裡的物資堆：木堆每天至少 4 根木柴、煤袋 1～2 塊木炭、椅墊堆 2 份（每天都補滿）
function refillPile(f, c) {
  c.items = [];
  if (f.loot === 'fuel') { for (let i = 0; i < 4; i++) c.items.push('wood'); if (Math.random() < 0.5) c.items.push(rollItem('fuel', f.room.level, G.day)); }
  else if (f.loot === 'coal') { c.items.push('charcoal'); if (Math.random() < 0.5) c.items.push('charcoal'); if (Math.random() < 0.3) c.items.push('wood'); }
  else for (let i = 0; i < 2; i++) c.items.push(rollItem('cushions', f.room.level, G.day));
}

// ====================================================================
// 寶箱：每天早上在車站三間隨機放（靠牆或家具旁邊，不擋門口）。四級：櫃箱、鐵寶箱、銀寶箱（1 把鑰匙）、鉑寶箱（2 把）
// 打開是賭：可能是物資，也可能跳出怪物；跑出怪物的寶箱再開一次還是拿得到東西
// ====================================================================
function chestSpots() {
  const spots = [];
  for (const r of ROOMS) {
    if (!isStationRoom(r)) continue;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      if (solid[y][x] || tiles[y][x] !== 1) continue;
      if ([...G.sockets, ...G.lamps].some(o => o.x === x && o.y === y)) continue;
      if (Math.hypot(MERCHANT_POS.x - x - 0.5, MERCHANT_POS.y - y - 0.5) < 1.8) continue;
      let near = false, doorNear = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) continue;
        if (tiles[ny][nx] === 0 || furnGrid[ny][nx]) near = true;
      }
      for (const d of DOORS) if (Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 2) doorNear = true;
      if (near && !doorNear) spots.push({ x, y });
    }
  }
  return spots;
}
// 蓋子朝哪裡開：正面背對牆或家具
function chestFace(x, y) {
  for (const [dx, dy, a] of [[0, 1, 0], [0, -1, Math.PI], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
    const nx = x - dx, ny = y - dy;
    if (!inMap(nx, ny) || tiles[ny][nx] === 0 || furnGrid[ny][nx]) return a;
  }
  return 0;
}
function rebuildChestGrid() {
  dynSolid = grid(false);
  for (const c of G.chests3) dynSolid[c.y][c.x] = true;
  fixFlows.clear(); flow = null;
}
function placeChests3() {
  G.chests3 = [];
  const spots = chestSpots();
  const counts = [0, 3, 2, 1, G.day >= 7 ? 1 : G.day >= 3 && Math.random() < 0.5 ? 1 : 0];
  for (let lv = 4; lv >= 1; lv--) for (let i = 0; i < counts[lv]; i++) {
    for (let tries = 0; tries < 60 && spots.length; tries++) {
      const k = Math.floor(Math.random() * spots.length), sp = spots[k];
      if (G.chests3.some(c => Math.hypot(c.x - sp.x, c.y - sp.y) < 2.5)) continue;
      spots.splice(k, 1);
      G.chests3.push({ x: sp.x, y: sp.y, lv, open: false, out: false, face: chestFace(sp.x, sp.y) });
      break;
    }
  }
  rebuildChestGrid();
}
function chestTargets(cands) {
  const p = G.p;
  for (const c of G.chests3) {
    const cx = c.x + 0.5, cy = c.y + 0.5, rd = Math.hypot(cx - p.x, cy - p.y);
    if (rd > 1.7) continue;
    const a = lookAngle(cx, cy);
    if (a > 1.0 && rd > 0.7) continue;
    const d = rd - 0.3 + a * 0.9, spec = CHESTS3[c.lv];
    if (c.open) { cands.push({ d, id: 'chest3open', label: `${spec.name}：已經打開過了` }); continue; }
    const keys = G.inv.key || 0;
    if (keys < spec.keys) cands.push({ d, id: 'chest3lock', label: `${spec.name}（需要 ${spec.keys} 把鑰匙，你有 ${keys} 把）` });
    else cands.push({ d, id: `chest3:${c.x},${c.y}`, label: `打開${spec.name}`, sub: c.out ? '怪物已經跑出來了，裡面還有東西' : `LV${c.lv}${spec.keys ? `・用 ${spec.keys} 把鑰匙` : ''}・有機會跑出怪物`, hold: spec.hold, action: () => openChest3(c) });
  }
}
function chestLoot(lv) {
  const items = [];
  const bulb = (lo, hi) => 'bulb' + clamp(randi(lo, hi), 1, NORMAL_MAX);
  const legend = [FIRE_TIER, ANGEL_TIER, HEAL_TIER, SLIME_TIER];
  if (lv === 1) {
    items.push(['wood', randi(2, 3)], [pick(['snack', 'battery', 'candle', 'chocolate']), 1]);
    if (Math.random() < 0.7) items.push([bulb(1, 4), 1]);
  } else if (lv === 2) {
    items.push(['charcoal', randi(1, 2)], [pick(['canned', 'marble', 'firecracker', 'cocoa']), 1], [bulb(4, 7), 1]);
    if (Math.random() < 0.2) items.push(['key', 1]);
  } else if (lv === 3) {
    items.push(['charcoal', randi(2, 3)], [Math.random() < 0.3 ? bulb(8, 9) : bulb(6, 9), 1], [pick(['salt', 'holywater', 'strongflash', 'amulet', 'medkit']), 1]);
    if (Math.random() < 0.3) items.push(['bulb' + pick(legend), 1]);
  } else {
    const pool = [...legend];
    if ((G.baymaxGot || 0) < BAYMAX_MAX) pool.push(BAYMAX_TIER, BAYMAX_TIER);   // 大白燈主要從鉑寶箱來
    items.push(['bulb' + pick(pool), 1], [pick(['megaflash', 'watergun', 'lamp_chand', 'amulet']), 1], ['charcoal', randi(2, 4)]);
    if (Math.random() < 0.5) items.push(['bulb' + pick(legend), 1]);
  }
  for (const it of items) if (LOOT_QTY[it[0]] && it[1] === 1) it[1] = LOOT_QTY[it[0]];
  return items;
}
function openChest3(c) {
  const spec = CHESTS3[c.lv];
  if (c.open || (G.inv.key || 0) < spec.keys) return;
  for (let i = 0; i < spec.keys; i++) removeItem('key');
  makeNoise(4);
  const mult = G.diff === 'easy' ? 0.5 : G.diff === 'hard' ? 1.3 : 1;
  if (!c.out && Math.random() < spec.monster * mult) { c.out = true; chestMonster(c); return; }
  c.open = true;
  const items = chestLoot(c.lv), coins = [0, randi(1, 3), randi(2, 5), randi(5, 9), randi(10, 16)][c.lv];
  const got = gainAll(items);
  addCoins(coins);
  Sound.play('chestOpen');
  for (const [id] of got) if (ITEMS[id].kind === 'bulb') showBulbCard(ITEMS[id].tier);
  showReward(`📦 ${spec.name}打開了！`, c.lv === 4 ? '鉑金色的箱子微微發著光……' : c.out ? '怪物跑掉了，東西還在。' : '', [...got, ['coin', coins]]);
}
// 寶箱裡跳出怪物：蓋子彈開、黑煙噴出來，怪物從煙裡站起來（寶箱等級越高怪物越強；鉑寶箱的怪物等級 +3）
function chestMonsterPool(lv) {
  const d = G.day;
  if (lv === 1) return ['shadow'];
  if (lv === 2) return ['shadow', 'stick', ...(d >= 2 ? ['kronos'] : [])];
  if (lv === 3) return ['kronos', 'woman', 'momo', ...(d >= 5 ? ['tyrant'] : [])];
  return ['tyrant', ...(d >= 8 ? ['warlord'] : []), ...(d >= 11 ? ['taowu'] : [])];
}
function chestMonster(c) {
  let kind = pick(chestMonsterPool(c.lv));
  if (!SPECIAL_AI[kind] && kind !== 'shadow') kind = 'shadow';
  let pos = null;
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const nx = c.x + dx, ny = c.y + dy;
    if (inMap(nx, ny) && !isSolid(nx, ny) && tiles[ny][nx] === 1) { pos = { x: nx + 0.5, y: ny + 0.5 }; break; }
  }
  const e = spawnEnemy(kind, pos || { x: c.x + 0.5, y: c.y + 0.5 });
  if (!e) { c.open = true; return; }
  e.spawn = 0.8; e.fromChest = true;
  if (c.lv === 4) setLevel(e, kind, Math.min(12, e.lv + 3));
  if (kind === 'momo') pickWander(e);
  puff(c.x + 0.5, c.y + 0.5, [15, 12, 14], 26, 0.6);
  Sound.play('chestMonster'); G.shake = 0.6;
  toast(`💥 ${CHESTS3[c.lv].name}裡跳出了${MONSTER_NAME[kind]}（Lv.${e.lv}）！打倒牠之後再開一次，還是拿得到東西。`, 'warn');
  if (!G.ev.chestMonTip) { G.ev.chestMonTip = 1; toast('☀️ 白天也會戰鬥：寶箱跑出來的怪物會追你，打倒一樣算驅散。天黑時留在車站的怪物不會上車。', 'warn'); }
}

// 第三世界破關：列車到站了，天亮了
function victory3() {
  mode = 'over';
  Sound.setDrone(0);
  Sound.play('win');
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  $('goTitle').textContent = '🚂 列車到站了';
  $('goText').innerHTML = `天亮了，列車慢慢停進終點站……月台上空無一人，只有你一個。<br>你在第三世界撐過了 ${LAST_NIGHT} 夜！<br>你搜索了 ${G.stats.searched} 次，驅散了 ${G.stats.dissolved} 個怪物。<br>最好的燈泡：${bulbName(G.stats.bestTier)}`;
  $('btnRetry').classList.add('hidden');
  $('gameover').classList.remove('hidden');
}

// ====================================================================
// 寒寂之境（第 3、7、10、12 天）：整天下雪、零下 100 度，多了「體溫」。體溫歸零就死。
// 每秒掉：車站（室外）2、列車上 0.8；機車室火爐有燒 +3；大白燈 3 格內 +5、被大白抱住 +10；熔岩暴君身邊 3 格 +4
// 大白燈（第 15 級）：燈下站著一個大白，走到它面前它會抱住你（被打只扣一半的血）。不管有沒有下雪都會回體溫
// ====================================================================
const BAYMAX_WARM_R = 3, BAYMAX_HUG_R = 1.0;
function nearestBaymax() {
  const p = G.p, tx = Math.floor(p.x), ty = Math.floor(p.y);
  if (!inMap(tx, ty)) return null;
  const rooms = roomsAt(tx, ty);
  let best = null, bd = Infinity;
  for (const o of fixtures()) {
    if (o.bulb !== BAYMAX_TIER || !rooms.includes(o.room)) continue;
    const d = Math.hypot(o.x + 0.5 - p.x, o.y + 0.5 - p.y);
    if (d < bd) { bd = d; best = o; }
  }
  return best ? { o: best, d: bd } : null;
}
// 走路的速度：寒寂之境的車站積雪、體溫太低、被孢子噴到都會變慢
function speedMult3() {
  const p = G.p, r = roomAt(p.x, p.y);
  return (G.cold && isStationRoom(r) ? 0.75 : 1) * (G.cold && p.temp < 30 ? 0.8 : 1) * (p.slowT > 0 ? 0.6 : 1);
}
function updateWarmth3(dt) {
  const p = G.p, nb = nearestBaymax();
  p.slowT = Math.max(0, (p.slowT || 0) - dt);
  G.timeFlash = Math.max(0, (G.timeFlash || 0) - dt * 2);
  // 大白的擁抱
  const hugging = !!(nb && nb.d < BAYMAX_HUG_R);
  if (hugging && !G.hugged) { Sound.play('hug'); if (!G.ev.hugTip) { G.ev.hugTip = 1; toast('🤍 大白抱住了你……好溫暖。被抱著的時候被打只扣一半的血，體溫回得更快。', 'good'); } }
  G.hugged = hugging; G.hugObj = nb ? nb.o : null;
  G.hug = clamp((G.hug || 0) + (hugging ? dt * 1.5 : -dt * 1.5), 0, 1);
  if (!G.cold) { p.temp = Math.min(100, p.temp + dt * 5); G.frost = 0; return; }
  const r = roomAt(p.x, p.y);
  let rate = isStationRoom(r) ? -2 : -0.8;
  if (r && r.id === 'attic' && G.fire.queue.length) rate = 3;
  if (nb) rate += hugging ? 10 : nb.d < BAYMAX_WARM_R ? 5 : 0;
  for (const e of G.enemies) if (e.kind === 'tyrant' && !e.dead && Math.hypot(e.x - p.x, e.y - p.y) < 3) rate += 4;
  p.temp = clamp(p.temp + rate * dt, 0, 100);
  G.frost = clamp((40 - p.temp) / 40, 0, 1);
  if (p.temp < 20) p.san -= 1.2 * D().san * dt;
  if (p.temp < 30 && !G.ev.coldTip) { G.ev.coldTip = 1; toast('🥶 體溫太低了！快去機車室的火爐旁邊，或站到大白燈下面取暖。', 'warn'); Sound.play('wind'); }
  if (p.temp >= 50) G.ev.coldTip = 0;
  if (rate > 0 && !G.ev.warmTip && p.temp < 60) { G.ev.warmTip = 1; toast('🔥 體溫正在回升。', 'good'); }
  if (p.temp <= 0) { gameOver('cold'); return; }
  // 下雪：車站裡飄雪；風聲
  if (isStationRoom(r) || G.phase === 'night') {
    for (let i = 0; i < 3; i++) {
      const x = p.x + rand(-6, 6), y = p.y + rand(-6, 6), rr = roomAt(x, y);
      if (!isStationRoom(rr)) continue;
      G.fx.push({ type: 'spark', x, y, h: rand(1.8, 2.6), vx: rand(0.2, 0.5), vy: rand(-0.1, 0.1), vh: -rand(0.5, 0.9), life: 3, max: 3, color: [230, 240, 255] });
    }
  }
  G.ev.windT = (G.ev.windT || 0) - dt;
  if (G.ev.windT <= 0) { G.ev.windT = rand(6, 11); Sound.play('wind', isStationRoom(r) ? 0.9 : 0.4); }
}
