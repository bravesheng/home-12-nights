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
  dustMotes(dt);
}
// 空氣裡慢慢飄的灰塵光點（在玩家前面幾格的範圍，少量就好）
function dustMotes(dt) {
  if (Math.random() > dt * 3) return;
  const p = G.p, a = p.face + rand(-0.7, 0.7), d = rand(1, 5);
  const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
  if (isWall(Math.floor(x), Math.floor(y)) || isStationRoom(roomAt(x, y)) && G.cold) return;
  G.fx.push({ type: 'spark', x, y, h: rand(0.4, 2.2), vx: rand(-0.04, 0.04), vy: rand(-0.04, 0.04), vh: rand(-0.03, 0.03), life: rand(3, 5), max: 5, color: [120, 105, 85] });
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
  if (ev.paxTurn) { ev.paxTurn.t += dt; if (ev.paxTurn.t > 16) ev.paxTurn = null; }
  dustMotes(dt);
  ev.clackT -= dt;
  if (tr.k > 0.15 && ev.clackT <= 0) { ev.clackT = 0.56 / tr.k; Sound.play('clack', 0.3 * tr.k); }
}
// 夜晚排程：第二世界追過來的大嘴觸角蟲和眼花女孩（第 1 夜就可能來）
function scheduleNight3(add, again, night, n, hz) {
  if (again(0.35)) add('snail', 30, NIGHT_LEN - 35);
  if (night === 1 ? Math.random() < 0.5 : again(0.4)) add('girl', 25, NIGHT_LEN - 40);
  // 4 隻新怪物：一隻一隻登場，之後每晚都可能再來；檮杌最後一夜一定來
  const intro3 = (k, a, b, base) => { if (night === INTRO3[k]) add(k, a, b); else if (night > INTRO3[k] && again(base)) add(k, 10, NIGHT_LEN - 35); };
  intro3('kronos', 40, 60, 0.6); intro3('tyrant', 30, 50, 0.45); intro3('warlord', 25, 45, 0.45);
  if (night === INTRO3.taowu || night === LAST_NIGHT) add('taowu', 30, 50);
  else if (night > INTRO3.taowu && again(0.3)) add('taowu', 40, 80);
  if (night >= 4 && Math.random() < 0.35 * hz) add('tender', 30, NIGHT_LEN - 40);   // 煤水車被撬開
  if (night >= 2 && Math.random() < 0.5) add('paxturn', 20, NIGHT_LEN - 30);       // 乘客轉頭
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
  for (const e of G.enemies) {
    if (e.kind === 'kronos') a.push('🍄 蕈裂衣在列車上（怕光，不敢靠近火爐）');
    else if (e.kind === 'tyrant') a.push(e.cooled > 0 ? '🪨 熔岩暴君冷卻了！快用平底鍋敲' : '🪨 熔岩暴君在列車上（聖水槍冷卻再敲）');
    else if (e.kind === 'warlord') a.push('⚔️ 墮落戰神在走道裡（從背後打、躲進包廂關門）');
    else if (e.kind === 'taowu') a.push(e.blind > 0 ? '👁️ 檮杌瞎了！傷害 3 倍' : `👁️ 檮杌・九瞳在列車上（眼睛 ${e.eyes.filter(x => x.shut).length}/9）`);
  }
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
  // 包廂的門可以關（墮落戰神進不來）：對著門按 E。車站的門和連結處的門不行
  for (const d of DOORS) {
    if (d.front || d.station || d.locked) continue;
    const cx = d.x + 0.5, cy = d.y + 0.5, rd = Math.hypot(cx - p.x, cy - p.y);
    if (rd > 1.4 || rd < 0.55 || lookAngle(cx, cy) > 0.9) continue;
    if (d.closed) cands.push({ d: rd + 0.4, id: `door:${d.x},${d.y}`, label: '打開包廂門', hold: 0, action: () => { setDoor(d, false); Sound.play('click'); } });
    else cands.push({ d: rd + 0.4, id: `door:${d.x},${d.y}`, label: '關上包廂門', sub: '關上的門擋得住怪物（檮杌除外）', hold: 0, action: () => closeDoor3(d) });
  }
}
function closeDoor3(d) {
  const cx = d.x + 0.5, cy = d.y + 0.5;
  if (Math.hypot(cx - G.p.x, cy - G.p.y) < 0.75 || G.enemies.some(e => Math.hypot(cx - e.x, cy - e.y) < 0.7)) { toast('門口有東西擋著，關不起來。'); return; }
  setDoor(d, true); Sound.play('doorSlam', 0.5);
  if (!G.ev.doorTip) { G.ev.doorTip = 1; toast('🚪 門關上了。關上的門跟牆一樣，怪物進不來（檮杌會撞壞）；再按一次 E 打開。', 'good'); }
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

// ====================================================================
// 第三世界的 4 隻新怪物（照紙本設計圖，寫實風）：
// 克蘿諾斯・蕈裂衣（鬼將級，第 1 夜）、熔岩暴君（羅判級，第 4 夜）、墮落戰神（羅判級，第 7 夜）、檮杌・九瞳（判官級，第 10 夜和最後一夜）
// ====================================================================
const GRADE3 = { kronos: '鬼將級', tyrant: '羅判級', warlord: '羅判級', taowu: '判官級' };
// 怪物受到不同攻擊的傷害倍數（src：flash 手電筒、pan 平底鍋、shot 彈珠、spray 聖水槍、salt 鹽巴、bomb 鞭炮、fire 火球、angel 天使）
function monsterDmgMult(t, src) {
  if (!t.kind) return 1;
  if (t.kind === 'tyrant') {
    if (src === 'flash') return 0;                      // 手電筒對岩石沒用
    if (src === 'spray') {   // 聖水冷卻：嘶——
      if (!(t.cooled > 0)) { t.cooled = 3; Sound.play('hiss'); if (!G.ev.coolTip) { G.ev.coolTip = 1; toast('💧 聖水讓熔岩暴君「嘶——」地冷卻了！3 秒內牠不會動，快用平底鍋敲碎牠！', 'good'); } }
      return 3;
    }
    if (src === 'pan' && t.cooled > 0) { Sound.play('crack'); return 4; }   // 冷卻後敲碎一塊
    if (src === 'bomb') return 1.5;
    return 1;
  }
  if (t.kind === 'warlord') {
    if (src === 'fire' || src === 'angel') return 1;
    // 正面有盔甲傷害減半；從背後打 3 倍
    const p = G.p, toP = Math.atan2(p.y - t.y, p.x - t.x);
    let da = toP - (t.face || 0);
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    if (Math.abs(da) > 2.2) { if (!G.ev.backTip) { G.ev.backTip = 1; toast('⚔️ 從背後打墮落戰神，傷害 3 倍！', 'good'); } return 3; }
    return Math.abs(da) < 1.0 ? 0.5 : 1;
  }
  if (t.kind === 'taowu') return t.blind > 0 ? 3 : 1;
  return 1;
}

// ---------- 克蘿諾斯・蕈裂衣：跟時間有關的矮人。用長矛刺你，被刺中夜晚的時鐘會倒退 10 秒；怕光和火 ----------
function updateKronos(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.retreat = Math.max(0, e.retreat - dt); e.limpT += dt;
  if (e.pose) return;
  const beam = inBeam(e);
  if (beam) {
    flashHurt(e, dt);
    if (e.dead) return;
    e.retreat = 0.5; e.smoke = 1;
    if (Math.random() < dt * 20) G.fx.push({ type: 'smoke', x: e.x + rand(-0.2, 0.2), y: e.y + rand(-0.2, 0.2), h: 1.6, vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vh: rand(0.6, 1.2), life: 0.8, max: 0.8, color: [150, 90, 200] });
    if (!G.ev.kronosLightTip) { G.ev.kronosLightTip = 1; toast('🔦 手電筒照到蘑菇傘，蕈裂衣冒煙往後退了！', 'good'); }
  }
  // 不敢靠近有燒的火爐：機車室是安全的
  const fb = FURN_BY_ID.firebox, fire = fb && fireBurning();
  const fd = fire ? Math.hypot(fb.x + 1 - e.x, fb.y + 1 - e.y) : 99;
  let dir, sp = Math.min(1.6 + n * 0.01, 2.4) * (e.spawn > 0 ? 0.3 : 1) * (0.7 + 0.5 * Math.abs(Math.sin(e.limpT * 3.2)));   // 一跛一跛
  if (e.retreat > 0 || fd < 4.5) {
    const ax = e.retreat > 0 ? p.x : fb.x + 1, ay = e.retreat > 0 ? p.y : fb.y + 1, a = Math.atan2(e.y - ay, e.x - ax);
    dir = { x: Math.cos(a), y: Math.sin(a) }; sp = 2.2;
    if (fd < 4.5 && !G.ev.kronosFireTip && d < 8) { G.ev.kronosFireTip = 1; toast('🔥 蕈裂衣不敢靠近有燒的火爐。機車室是安全的！', 'good'); }
  } else if (e.thrust > 0) dir = { x: 0, y: 0 };
  else dir = chaseDir(e);
  if (e.thrust <= 0) move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  e.face = Math.atan2(p.y - e.y, p.x - e.x);
  e.cackleT -= dt;
  if (e.cackleT <= 0 && d < 12) { Sound.play('kcackle', nearVol(d)); e.cackleT = rand(4, 7); }
  // 長矛：離你 2.5 格就舉矛，0.5 秒後刺出去
  if (e.thrust > 0) {
    e.thrust -= dt;
    if (e.thrust <= 0) {
      const dd = Math.hypot(e.x - p.x, e.y - p.y);
      if (dd < 2.9 && p.inv <= 0 && castRay(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), dd) >= dd - 0.05) kronosHit(e);
      e.cd = 3;
    }
  } else if (d < 2.5 && e.cd <= 0 && e.spawn <= 0 && e.retreat <= 0 && fd >= 4.5) { e.thrust = 0.5; Sound.play('spear', nearVol(d)); }
}
function kronosHit(e) {
  const p = G.p, n = diffN();
  damage(14 + n * 0.1, 10); p.inv = 1.2;
  e.hits = (e.hits || 0) + 1;
  // 時鐘倒退 10 秒：天亮變晚
  if (G.phase === 'night') G.t = Math.max(0, G.t - 10);
  G.timeFlash = 1; Sound.play('clockBack');
  toast(e.hits === 1 ? '⏳ 蕈裂衣的長矛刺中了你……夜晚的時鐘倒退了 10 秒！' : '⏳ 又被刺中了！時鐘倒退 10 秒。', 'warn');
  if (e.hits >= 3) {
    p.slowT = 5;
    for (let i = 0; i < 24; i++) G.fx.push({ type: 'spark', x: e.x + rand(-0.3, 0.3), y: e.y + rand(-0.3, 0.3), h: 1.5, vx: (p.x - e.x) * rand(0.3, 0.6), vy: (p.y - e.y) * rand(0.3, 0.6), vh: rand(-0.3, 0.3), life: 1.2, max: 1.2, color: [190, 120, 255] });
    Sound.play('spore');
    toast('🍄 蕈裂衣頭上的蘑菇噴出孢子，你走路變慢了 5 秒！', 'warn');
  }
}

// ---------- 熔岩暴君：岩石巨人，走得慢但很耐打。每走 5 步跺一次腳（2 格內的人會被震倒，跳起來就不會）；走過的地方燒出熔岩 ----------
function updateTyrant(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cooled = Math.max(0, (e.cooled || 0) - dt); e.cd = Math.max(0, e.cd - dt); e.hum += dt;
  if (inBeam(e)) { flashHurt(e, dt); if (!G.ev.tyrantFlashTip && d < 7) { G.ev.tyrantFlashTip = 1; toast('🪨 手電筒對岩石沒用！用聖水槍把牠冷卻，再用平底鍋敲碎。', 'warn'); } }
  if (e.dead || e.pose) return;
  if (e.cooled > 0) { e.stunT = Math.max(e.stunT || 0, 0.05); return; }   // 冷卻中：全身變黑、不會動
  if (Math.random() < dt * 6) G.fx.push({ type: 'ember', x: e.x + rand(-0.4, 0.4), y: e.y + rand(-0.4, 0.4), h: rand(0.5, 2.2), vx: rand(-0.3, 0.3), vy: rand(-0.3, 0.3), vh: -rand(0.5, 1.5), life: rand(0.4, 0.9), max: 0.9, color: pick(EMBER_COLORS) });
  if (e.stomp > 0) {
    e.stomp -= dt;
    if (e.stomp <= 0) {
      G.shake = Math.max(G.shake, 0.9); Sound.play('stompBig', nearVol(d) * 1.2);
      if (d < 2 && p.z < 0.25 && p.inv <= 0) { damage(10 + n * 0.1, 8); p.stunT = 1.0; p.inv = 1; toast('🪨 熔岩暴君跺腳，地板一震，你被震倒了！跳起來就不會被震到。', 'warn'); }
      else if (d < 2 && p.z >= 0.25 && !G.ev.stompDodgeTip) { G.ev.stompDodgeTip = 1; toast('⤒ 跳起來躲過了跺腳！', 'good'); }
    }
    return;
  }
  // 寒寂之境時被火爐吸引，在機車室附近徘徊
  const fb = FURN_BY_ID.firebox;
  let tx = p.x, ty = p.y, fl = flow;
  if (G.cold && fb && Math.hypot(fb.x + 1 - p.x, fb.y + 1 - p.y) > 6 && Math.sin(e.hum * 0.15) > 0) { tx = fb.x + 1; ty = fb.y + 2.5; fl = flowTo(fb.x + 1, fb.y + 2); }
  const dir = pathDir(e, fl, tx, ty, 0.1), sp = Math.min(0.85 + n * 0.004, 1.3) * (e.spawn > 0 ? 0.3 : 1);
  const ox = e.x, oy = e.y;
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  const moved = Math.hypot(e.x - ox, e.y - oy);
  e.walked += moved; e.face = Math.atan2(dir.y, dir.x);
  e.lavaT -= moved;
  if (e.lavaT <= 0) { e.lavaT = 0.6; addLava(e.x, e.y); }
  if (e.walked >= 5) { e.walked = 0; e.stomp = 0.6; Sound.play('armor', nearVol(d)); }
  if (d < 1.1 && e.spawn <= 0 && p.inv <= 0) {
    damage(28 + n * 0.15, 12); p.inv = 1.3;
    const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 1.4, Math.sin(a) * 1.4, PLAYER_R);
    G.shake = 0.7; Sound.play('thump');
    toast('🪨 熔岩暴君一拳把你打飛了！', 'warn');
  }
}
function addLava(x, y) {
  const last = G.lava[G.lava.length - 1];
  if (last && Math.hypot(last.x - x, last.y - y) < 0.35) { last.life = 15; return; }
  G.lava.push({ x, y, life: 15, r: rand(0.3, 0.42), a: Math.random() * 6 });
  if (G.lava.length > 60) G.lava.shift();
}
function updateLava(dt) {
  const p = G.p;
  let on = false;
  for (const l of G.lava) { l.life -= dt; if (l.life > 4 && p.z < 0.1 && (l.x - p.x) ** 2 + (l.y - p.y) ** 2 < 0.3) on = true; }
  if (G.lava.length && G.lava[0].life <= 0) G.lava = G.lava.filter(l => l.life > 0);
  if (on) {
    p.hp -= 4 * D().dmg * dt; p.hurt = Math.max(p.hurt, 0.4);
    if (!G.ev.lavaTip) { G.ev.lavaTip = 1; toast('🔥 踩到熔岩了！熔岩暴君走過的地方 15 秒後才會冷卻，跳過去或繞開。', 'warn'); Sound.play('hiss', 0.5); }
    if (p.hp <= 0) gameOver();
  }
}

// ---------- 墮落戰神：只在走道裡走。看到你就衝過來，2 格內橫掃一劍（打飛、眩暈）；不進包廂，會在門外等 10 秒 ----------
const HALL = ROOMS.find(r => r.id === 'hall');
const inHall = (x, y) => y >= HALL.y && y < HALL.y + HALL.h && x >= HALL.x && x < HALL.x + HALL.w;
function updateWarlord(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.stepT += dt;
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  const playerInHall = inHall(p.x, p.y), los = d < 16 && castRay(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), d) >= d - 0.05;
  e.dragT -= dt;
  if (e.dragT <= 0 && d < 12) { Sound.play('swordDrag', nearVol(d) * 0.7); e.dragT = rand(1.4, 2.2); }
  if (Math.random() < dt * 8) G.fx.push({ type: 'ember', x: e.x + Math.cos(e.face + 0.5) * 0.5, y: e.y + Math.sin(e.face + 0.5) * 0.5, h: 0.05, vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.6), vh: rand(0.3, 1), life: 0.3, max: 0.3, color: [255, 220, 150] });
  // 揮劍：先把劍舉高 0.6 秒，再橫掃
  if (e.swing > 0) {
    e.swing -= dt;
    if (e.swing <= 0) {
      Sound.play('swordSwing', nearVol(d));
      const dd = Math.hypot(e.x - p.x, e.y - p.y);
      if (dd < 2.4 && inHall(p.x, p.y) && p.inv <= 0) {
        damage(32 + n * 0.15, 15); p.inv = 1.5; p.stunT = 1;
        const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 2.5, Math.sin(a) * 2.5, PLAYER_R);
        G.shake = 0.8;
        toast('⚔️ 墮落戰神一劍把你打飛撞牆！看到牠舉劍就趕快退開，或躲進包廂關上門。', 'warn');
      }
      e.cd = 1.2;
    }
    return;
  }
  let tx, ty, sp;
  if (playerInHall && los) {
    // 看到你就衝過來
    tx = p.x; ty = p.y; sp = Math.min(4.0 + n * 0.01, 4.8); e.state = 'charge'; e.waitT = 0;
    if (!G.ev.warlordChargeTip) { G.ev.warlordChargeTip = 1; toast('⚔️ 墮落戰神看到你了，牠衝過來了！牠不會進包廂。', 'warn'); }
  } else if (e.state === 'charge' || e.state === 'wait') {
    // 你躲進包廂了：在門外等 10 秒，然後往下一節走
    if (e.state === 'charge') { e.state = 'wait'; e.waitT = 10; e.wx = clamp(p.x, HALL.x + 0.5, HALL.x + HALL.w - 0.5); }
    e.waitT -= dt;
    tx = e.wx; ty = 12.5; sp = 2.2;
    if (e.waitT <= 0) { e.state = 'patrol'; e.px = e.x < 22 ? HALL.x + HALL.w - 1.5 : HALL.x + 1.5; }
  } else {
    // 巡邏：從走道的一頭走到另一頭
    if (e.px === undefined || Math.abs(e.px - e.x) < 0.6) e.px = e.x < 22 ? HALL.x + HALL.w - 1.5 : HALL.x + 1.5;
    tx = e.px; ty = 12.5; sp = Math.min(1.5 + n * 0.006, 2.0);
  }
  if (e.spawn > 0) sp *= 0.3;
  const dx = tx - e.x, dy = ty - e.y, l = Math.hypot(dx, dy) || 1;
  if (l > 0.3) {
    const ox = e.x, oy = e.y;
    move(e, dx / l * sp * dt, dy / l * sp * dt, ENEMY_R);
    e.y = clamp(e.y, HALL.y + 0.35, HALL.y + HALL.h - 0.35);   // 永遠待在走道裡
    e.x = clamp(e.x, HALL.x + 0.35, HALL.x + HALL.w - 0.35);
    if (Math.hypot(e.x - ox, e.y - oy) > 0.001) e.face = Math.atan2(e.y - oy, e.x - ox);
    if (e.stepT > (e.state === 'charge' ? 0.3 : 0.6) && d < 14) { e.stepT = 0; Sound.play('armor', nearVol(d) * 0.8); if (d < 6) G.shake = Math.max(G.shake, 0.05); }
  } else if (playerInHall) e.face = Math.atan2(p.y - e.y, p.x - e.x);
  if (playerInHall && d < 2.0 && e.cd <= 0 && e.spawn <= 0) { e.swing = 0.6; e.face = Math.atan2(p.y - e.y, p.x - e.x); Sound.play('armor', nearVol(d)); }
}
// 走道裡離你最遠的那一頭
function warlordSpawn() {
  const p = G.p, x = p.x < 22 ? HALL.x + HALL.w - 2.5 : HALL.x + 2.5;
  return { x, y: 12.5 };
}

// ---------- 檮杌・九瞳：四腳巨獸，九顆眼睛看得到一切。用手電筒把九顆眼睛一顆一顆照到閉上，牠就瞎了 10 秒（傷害 3 倍） ----------
const TAOWU_EYES = 9;
function updateTaowu(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt); e.roarT -= dt; e.stepT += dt;
  const beam = inBeam(e);
  if (beam) { flashHurt(e, dt); if (e.dead) return; }
  // 眼睛：被手電筒照著時，目前這顆眼睛慢慢閉上（破爛 2 秒、稀有 1.3 秒、巨光 1 秒）
  const closeTime = [2, 1.33, 1][clamp(p.flashLv || 1, 1, 3) - 1];
  if (e.blind > 0) {
    e.blind -= dt;
    if (e.blind <= 0) { e.reopenT = 3; toast('👁️ 檮杌的眼睛開始重新張開了……', 'warn'); }
  } else {
    const shut = e.eyes.filter(x => x.shut).length;
    if (beam && shut < TAOWU_EYES) {
      e.eyeProg += dt; e.lit = true;
      if (e.eyeProg >= closeTime) {
        e.eyeProg = 0;
        const eye = e.eyes.find(x => !x.shut); eye.shut = true;
        Sound.play('tick', 0.6);
        if (shut + 1 >= TAOWU_EYES) { e.blind = 10; e.lit = false; Sound.play('roar', 0.6); toast('👁️ 九顆眼睛都閉上了！檮杌瞎了 10 秒，所有傷害 3 倍，快打牠！', 'good'); }
        else if (!G.ev.taowuEyeTip) { G.ev.taowuEyeTip = 1; toast(`👁️ 照到的眼睛閉上了（${shut + 1}/9）！繼續照，九顆都閉上牠就瞎了。`, 'good'); }
      }
    } else { e.lit = false; e.eyeProg = Math.max(0, e.eyeProg - dt * 0.5); }
    // 眼睛慢慢重新張開（每 3 秒一顆）
    if (shut > 0 && e.blind <= 0) { e.reopenT -= dt; if (e.reopenT <= 0) { e.reopenT = 3; const eye = [...e.eyes].reverse().find(x => x.shut); if (eye) eye.shut = false; } }
  }
  if (e.pose) return;
  // 咆哮（每 15 秒）：理智大掉、畫面模糊
  if (e.roarT <= 0) {
    e.roarT = 15; e.roar = 1.2;
    Sound.play('roar', nearVol(d) * 1.3); G.shake = Math.max(G.shake, 0.5);
    if (d < 14) { p.san -= 15 * D().san; G.dizzy = Math.min(1, (G.dizzy || 0) + 0.8); toast('🐾 檮杌的咆哮裡有好多人在低語……理智大掉！', 'warn'); }
  }
  e.roar = Math.max(0, (e.roar || 0) - dt);
  if (e.pounce > 0) {
    e.pounce -= dt;
    const a = e.pounceA;
    move(e, Math.cos(a) * 7 * dt, Math.sin(a) * 7 * dt, ENEMY_R);
    if (Math.hypot(e.x - p.x, e.y - p.y) < 1.0 && p.inv <= 0 && e.blind <= 0) {
      damage(35 + n * 0.2, 20); p.inv = 1.5;
      const b = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(b) * 1.8, Math.sin(b) * 1.8, PLAYER_R);
      G.shake = 0.9; Sound.play('chomp');
      toast('🐾 檮杌撲過來咬了你一口！', 'warn');
      e.pounce = 0; e.cd = 2.5;
    }
    return;
  }
  let dir, sp = Math.min(1.7 + n * 0.008, 2.4) * (e.spawn > 0 ? 0.3 : 1);
  if (e.blind > 0) {
    // 瞎了：亂撞
    e.wanderT -= dt;
    if (e.wanderT <= 0) { e.wanderT = rand(0.6, 1.4); e.wa = Math.random() * Math.PI * 2; }
    dir = { x: Math.cos(e.wa), y: Math.sin(e.wa) }; sp *= 1.3;
  } else dir = chaseDir(e);   // 九顆眼睛看得到一切：永遠知道你在哪裡
  const ox = e.x, oy = e.y;
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  if (Math.hypot(e.x - ox, e.y - oy) > 0.001) e.face = Math.atan2(e.y - oy, e.x - ox);
  // 撞壞關上的包廂門
  for (const dr of DOORS) if (dr.closed && !dr.locked && Math.hypot(dr.x + 0.5 - e.x, dr.y + 0.5 - e.y) < 1.3) { setDoor(dr, false); Sound.play('doorSlam'); G.shake = Math.max(G.shake, 0.4); toast('💥 檮杌撞壞了包廂的門！', 'warn'); }
  if (e.stepT > 0.5 && d < 14) { e.stepT = 0; Sound.play('thump', nearVol(d) * 0.5); }
  if (d < 1.6 && e.cd <= 0 && e.spawn <= 0 && e.blind <= 0 && e.pounce <= 0) { e.pounce = 0.45; e.pounceA = Math.atan2(p.y - e.y, p.x - e.x); e.cd = 2.5; Sound.play('swish'); }
}

// ---------- 事件：生新怪物、乘客轉頭 ----------
function spawnW3Monster(kind) {
  const ev = G.ev;
  if (G.enemies.some(e => e.kind === kind) || (kind !== 'kronos' && bossFull())) return;
  const e = spawnEnemy(kind, kind === 'warlord' ? warlordSpawn() : null);
  if (!e) return;
  const tips = {
    kronos: ['🍄 一個戴著裂開蘑菇傘的矮人一跛一跛地走進了列車……克蘿諾斯・蕈裂衣！牠的長矛會讓夜晚的時鐘倒退，用手電筒照牠的蘑菇傘，有燒的火爐牠不敢靠近。', '🍄 咯咯咯……蕈裂衣又來了。'],
    tyrant: ['🪨 地板在震動……熔岩暴君上車了！手電筒對牠沒用，用聖水槍冷卻牠再用平底鍋敲，鞭炮也有效。牠跺腳時跳起來就不會被震倒。', '🪨 地板又在震了……熔岩暴君來了。'],
    warlord: ['⚔️ 走道那頭傳來鐵甲和劍磨地的聲音……墮落戰神！牠只在走道裡走，看到你就衝過來。從背後打傷害 3 倍，躲進包廂關上門牠就進不來。', '⚔️ 劍磨地的聲音又出現了……墮落戰神在走道裡。'],
    taowu: ['🐾 一聲咆哮混著無數人的低語……檮杌・九瞳！牠知道你在哪裡。用手電筒把牠臉上的九顆眼睛一顆一顆照到閉上，牠就瞎了。', '🐾 檮杌・九瞳又來了……'],
  }[kind];
  Sound.play({ kronos: 'kcackle', tyrant: 'stompBig', warlord: 'swordDrag', taowu: 'roar' }[kind], 0.7);
  toast(ev['tip_' + kind] ? tips[1] : tips[0], 'warn');
  ev['tip_' + kind] = 1;
}
// 某個乘客的頭慢慢轉過來看你（跟閣樓娃娃一樣的做法）
function passengerTurn() {
  const seats = FURN.filter(f => f.pax);
  if (!seats.length) return;
  const f = pick(seats);
  G.ev.paxTurn = { id: f.id, t: 0 };
  Sound.play('whisper');
  toast('👤 ……有個乘客的頭，慢慢地轉了過來。', 'warn');
}

// ====================================================================
// 臉（2D 畫法；3D 貼圖、驚嚇畫面、圖鑑的 2D 縮圖共用）。全部寫實風：空洞的眼窩、裂開的嘴、沒有表情
// ====================================================================
// 克蘿諾斯・蕈裂衣：灰綠色乾裂的屍皮、深陷的眼窩裡一點黃光、裂開的嘴露出爛牙、尖耳朵
function drawKronosFace(c, S, bare = false) {
  const r = seeded(3301);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  if (!bare) {
    // 蘑菇傘（紫藍色、白斑、裂縫透出紫光）
    const cg = c.createRadialGradient(256, 150, 20, 256, 150, 240); cg.addColorStop(0, '#6a4a9c'); cg.addColorStop(0.7, '#4a2e7a'); cg.addColorStop(1, '#2c1a4a');
    c.fillStyle = cg; c.beginPath(); c.ellipse(256, 150, 250, 130, 0, Math.PI, 0); c.fill();
    c.fillStyle = '#3a2a5c'; c.fillRect(6, 146, 500, 14);
    for (let i = 0; i < 16; i++) { const x = 40 + r() * 432, y = 60 + r() * 80; c.fillStyle = `rgba(230,225,240,${0.55 + r() * 0.35})`; c.beginPath(); c.ellipse(x, y, 8 + r() * 12, 5 + r() * 8, r() * 3, 0, 7); c.fill(); }
    c.strokeStyle = '#d9b3ff'; c.lineWidth = 3; c.beginPath(); c.moveTo(256, 24); c.lineTo(248, 70); c.lineTo(262, 110); c.lineTo(250, 150); c.stroke();
    c.strokeStyle = 'rgba(220,180,255,.5)'; c.lineWidth = 8; c.stroke();
  }
  // 尖耳朵
  c.fillStyle = '#5f6e4e';
  for (const s of [-1, 1]) { c.beginPath(); c.moveTo(256 + s * 120, 250); c.lineTo(256 + s * 230, 180); c.lineTo(256 + s * 150, 300); c.fill(); }
  // 臉：灰綠色、乾裂
  const fg = c.createRadialGradient(256, 290, 30, 256, 300, 180); fg.addColorStop(0, '#8a9a72'); fg.addColorStop(0.75, '#5f6e4e'); fg.addColorStop(1, '#3a4530');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 300, 128, 150, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(30,40,25,.6)'; c.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) { let x = 140 + r() * 232, y = 170 + r() * 260; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 3; k++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; c.lineTo(x, y); } c.stroke(); }
  // 深陷的眼窩、小小的黃色眼珠
  for (const ex of [205, 307]) {
    const g = c.createRadialGradient(ex, 262, 4, ex, 262, 40); g.addColorStop(0, '#060805'); g.addColorStop(0.7, '#1c2416'); g.addColorStop(1, 'rgba(60,70,50,0)');
    c.fillStyle = g; c.beginPath(); c.ellipse(ex, 262, 38, 28, 0, 0, 7); c.fill();
    c.fillStyle = '#e8c24a'; c.beginPath(); c.arc(ex + 3, 264, 5, 0, 7); c.fill();
    c.fillStyle = 'rgba(232,194,74,.35)'; c.beginPath(); c.arc(ex + 3, 264, 10, 0, 7); c.fill();
  }
  // 鼻子：兩個洞
  c.fillStyle = '#2a3322'; for (const s of [-1, 1]) { c.beginPath(); c.ellipse(256 + s * 10, 318, 6, 9, 0, 0, 7); c.fill(); }
  // 裂開的嘴：咧到兩邊，爛牙
  c.fillStyle = '#1a1410'; c.beginPath(); c.moveTo(166, 360); c.quadraticCurveTo(256, 400, 346, 356); c.quadraticCurveTo(300, 420, 256, 422); c.quadraticCurveTo(212, 420, 166, 360); c.fill();
  c.fillStyle = '#c9b98a';
  for (let x = 180; x < 330; x += 17) { const h = 10 + r() * 14; c.fillRect(x, 366 + Math.abs(x - 256) * 0.1, 11, h); }
  c.strokeStyle = '#3a4530'; c.lineWidth = 5; c.beginPath(); c.moveTo(166, 360); c.quadraticCurveTo(256, 400, 346, 356); c.stroke();
  c.restore();
}
// 熔岩暴君：黑色的岩塊拼成的臉，縫隙透出橘紅色的熔岩光，兩個熔岩洞當眼睛，鋸齒狀的嘴
function drawTyrantFace(c, S) {
  const r = seeded(4402);
  c.save(); c.scale(S / 512, S / 512); c.lineJoin = 'round';
  c.beginPath(); c.ellipse(256, 270, 236, 250, 0, 0, Math.PI * 2); c.clip();   // 橢圓形的臉，外面透明（3D 的臉才不會是一塊方的）
  const lava = c.createRadialGradient(256, 280, 20, 256, 280, 240); lava.addColorStop(0, '#ff9a2a'); lava.addColorStop(0.6, '#e04a10'); lava.addColorStop(1, '#5a1000');
  c.fillStyle = lava; c.fillRect(0, 0, 512, 512);
  // 岩塊
  for (let i = 0; i < 70; i++) {
    const x = r() * 512, y = r() * 512, w = 30 + r() * 70, h = 24 + r() * 50;
    c.fillStyle = `rgb(${18 + r() * 20 | 0},${16 + r() * 16 | 0},${16 + r() * 14 | 0})`;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y + (r() - 0.5) * 14); c.lineTo(x + w + (r() - 0.5) * 14, y + h); c.lineTo(x + (r() - 0.5) * 14, y + h + (r() - 0.5) * 10); c.closePath(); c.fill();
  }
  // 眼睛：兩個熔岩洞
  for (const ex of [196, 316]) {
    c.fillStyle = '#0a0806'; c.beginPath(); c.ellipse(ex, 230, 52, 34, 0, 0, 7); c.fill();
    const g = c.createRadialGradient(ex, 232, 2, ex, 232, 36); g.addColorStop(0, '#fff2a0'); g.addColorStop(0.3, '#ffb020'); g.addColorStop(1, 'rgba(255,100,20,0)');
    c.fillStyle = g; c.beginPath(); c.ellipse(ex, 232, 40, 26, 0, 0, 7); c.fill();
    c.fillStyle = '#0a0806'; c.beginPath(); c.moveTo(ex - 60, 196); c.lineTo(ex + 60, 206); c.lineTo(ex + 50, 186); c.fill();
  }
  // 鋸齒狀的嘴，裡面是熔岩
  c.fillStyle = '#ff8a1a'; c.beginPath(); c.moveTo(150, 360); c.lineTo(362, 350); c.lineTo(340, 420); c.lineTo(172, 428); c.fill();
  c.fillStyle = '#0c0a08';
  for (let x = 150; x < 362; x += 24) { c.beginPath(); c.moveTo(x, 352); c.lineTo(x + 12, 392 + r() * 10); c.lineTo(x + 24, 352); c.fill(); c.beginPath(); c.moveTo(x + 6, 428); c.lineTo(x + 14, 396 - r() * 10); c.lineTo(x + 24, 428); c.fill(); }
  c.restore();
}
// 墮落戰神：骷髏的臉（空洞的眼窩、沒有鼻子、一排牙），頭盔的面罩在上面
function drawSkullFace(c, S) {
  const r = seeded(5503);
  c.save(); c.scale(S / 512, S / 512); c.lineJoin = 'round';
  const bg = c.createRadialGradient(256, 260, 40, 256, 280, 200); bg.addColorStop(0, '#d9d2c2'); bg.addColorStop(0.8, '#b3ab98'); bg.addColorStop(1, '#6a6458');
  c.fillStyle = bg; c.beginPath(); c.ellipse(256, 250, 150, 170, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(150, 320); c.quadraticCurveTo(256, 470, 362, 320); c.fill();
  c.strokeStyle = 'rgba(60,55,45,.5)'; c.lineWidth = 1.5;
  for (let i = 0; i < 20; i++) { let x = 130 + r() * 252, y = 120 + r() * 300; c.beginPath(); c.moveTo(x, y); for (let k = 0; k < 3; k++) { x += (r() - 0.5) * 36; y += (r() - 0.5) * 36; c.lineTo(x, y); } c.stroke(); }
  for (const ex of [196, 316]) { const g = c.createRadialGradient(ex, 250, 4, ex, 250, 54); g.addColorStop(0, '#000'); g.addColorStop(0.75, '#120e0c'); g.addColorStop(1, 'rgba(40,30,25,0)'); c.fillStyle = g; c.beginPath(); c.ellipse(ex, 250, 54, 44, 0, 0, 7); c.fill(); c.fillStyle = 'rgba(200,60,40,.55)'; c.beginPath(); c.arc(ex + 2, 254, 6, 0, 7); c.fill(); }
  c.fillStyle = '#1a1512'; c.beginPath(); c.moveTo(256, 300); c.lineTo(236, 340); c.lineTo(276, 340); c.fill();
  c.fillStyle = '#2a2420'; c.fillRect(176, 372, 160, 34);
  c.fillStyle = '#e4ddcc'; for (let x = 180; x < 332; x += 16) c.fillRect(x, 372, 12, 28 + r() * 8);
  c.strokeStyle = '#3a3430'; c.lineWidth = 3; c.beginPath(); c.moveTo(176, 406); c.lineTo(336, 406); c.stroke();
  c.restore();
}
// 檮杌・九瞳：一團深紫色的毛，上面聚著九顆大小不一的眼睛（紫色瞳孔）
function drawTaowuFace(c, S) {
  const r = seeded(6604);
  c.save(); c.scale(S / 512, S / 512);
  const fg = c.createRadialGradient(256, 256, 40, 256, 256, 250); fg.addColorStop(0, '#7a6a90'); fg.addColorStop(1, '#2a1a3a');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 270, 230, 230, 0, 0, 7); c.fill();
  c.strokeStyle = 'rgba(120,60,180,.6)'; c.lineCap = 'round';
  for (let i = 0; i < 160; i++) { const a = r() * Math.PI * 2, d = 150 + r() * 100; c.lineWidth = 2 + r() * 3; c.beginPath(); c.moveTo(256 + Math.cos(a) * d * 0.6, 270 + Math.sin(a) * d * 0.6); c.lineTo(256 + Math.cos(a) * d, 270 + Math.sin(a) * d); c.stroke(); }
  for (const [x, y, rr] of [[256, 250, 44], [196, 230, 30], [318, 236, 32], [226, 300, 26], [292, 304, 28], [170, 280, 20], [344, 288, 22], [256, 332, 22], [256, 190, 18]]) {
    c.fillStyle = '#1a0c22'; c.beginPath(); c.arc(x, y, rr + 6, 0, 7); c.fill();
    c.fillStyle = '#efe6ea'; c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill();
    c.strokeStyle = 'rgba(140,40,120,.6)'; c.lineWidth = 1; for (let k = 0; k < 6; k++) { const a = r() * Math.PI * 2; c.beginPath(); c.moveTo(x + Math.cos(a) * rr * 0.95, y + Math.sin(a) * rr * 0.95); c.lineTo(x + Math.cos(a) * rr * 0.55, y + Math.sin(a) * rr * 0.55); c.stroke(); }
    c.fillStyle = '#6a2a9c'; c.beginPath(); c.arc(x + rr * 0.12, y, rr * 0.5, 0, 7); c.fill();
    c.fillStyle = '#0a0410'; c.beginPath(); c.arc(x + rr * 0.12, y, rr * 0.24, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(x - rr * 0.1, y - rr * 0.2, rr * 0.12, 0, 7); c.fill();
  }
  c.restore();
}
// ---------- 圖鑑的 2D 縮圖（WebGL 開不起來時用） ----------
function thumbKronos(c, S) { c.save(); c.scale(S / 200, S / 200); c.translate(14, 6); drawKronosFace(c, 172); c.restore(); }
function thumbTyrant(c, S) { c.save(); c.scale(S / 200, S / 200); c.translate(10, 10); drawTyrantFace(c, 180); c.restore(); }
function thumbWarlord(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.fillStyle = '#e6e0d2'; c.beginPath(); c.moveTo(60, 200); c.lineTo(70, 90); c.lineTo(130, 90); c.lineTo(140, 200); c.fill();
  c.fillStyle = '#b8c0c8'; for (const s of [-1, 1]) { c.beginPath(); c.moveTo(100 + s * 28, 60); c.quadraticCurveTo(100 + s * 60, 30, 100 + s * 46, 4); c.lineTo(100 + s * 38, 54); c.fill(); }
  c.translate(60, 20); drawSkullFace(c, 80); c.restore();
  c.save(); c.scale(S / 200, S / 200); c.strokeStyle = '#8a8f96'; c.lineWidth = 9; c.beginPath(); c.moveTo(150, 110); c.lineTo(178, 196); c.stroke(); c.restore();
}
function thumbTaowu(c, S) { c.save(); c.scale(S / 200, S / 200); c.translate(8, 8); drawTaowuFace(c, 184); c.restore(); }

// ====================================================================
// 第二到第三世界的過場動畫（照故事：「我出去旅行，不小心睡著了，醒來時火車上的人已經都死了，只剩我一個……」）
// 1. 天亮，花園的眼睛閉上 → 2. 淡出 → 3. 黃昏的月台、一列黑色的列車：走上月台、進交誼車廂、在絨布座位上坐下（車上還有別的乘客）
// → 4. 畫面變黑，只剩車輪的聲音 → 5. 醒來：燈昏黃會閃、乘客全都蓋著白布、窗外一片黑 → 6. 大字「第三世界：末班列車」→ 第 1 天早上
// 大約 17 秒，點一下畫面可以跳過。做法跟第一到第二世界一樣：直接用遊戲的 3D 場景，鏡頭走設定好的路線
// ====================================================================
const CUT2 = { door: 2.6, fadeIn: 3.4, walk: 4.2, sit: 8.6, black: 9.6, wake: 11.6, title: 14.6, end: 17.2 };
const CUT2_SEAT = { x: 16.2, y: 22.2, lookX: 14.5, lookY: 21.4 };
function startCutscene2() {
  unlockW3();
  // 帶進第三世界的東西：背包、裝好的燈泡和燈具、硬幣、手電筒等級
  const inv = { ...G.inv };
  const put = (id, n = 1) => { inv[id] = (inv[id] || 0) + n; };
  for (const o of [...G.sockets, ...G.lamps]) if (o.bulb) put('bulb' + o.bulb);
  for (const l of G.lamps) put(lampItemId(l.type));
  CUT = { kind: 2, t: 0, switched: false, doorK: 0, alive: false, moving: false, clackT: 0, carry: { inv, coins: G.coins, flashLv: G.p.flashLv, diff: G.diff, stats: G.stats } };
  mode = 'cutscene';
  for (const e of G.enemies) puff(e.x, e.y);
  G.enemies = []; G.flowers = []; G.ghosts = []; G.fireballs = []; G.shots = []; G.bombs = [];
  G.phase = 'day'; G.t = 0; G.power = true; G.p.flash = false;
  G.ev.knock = 0; G.ev.tvOn = false; G.ev.closet = 0; G.ev.blood = false;
  Sound.setDrone(0); Sound.play('win');
  releaseInputs();
  if (document.pointerLockElement) document.exitPointerLock();
  $('hud').classList.add('hidden');
  $('cutscene').classList.remove('hidden');
  cutCaption(`🌅 你撐過了 ${LAST_NIGHT} 夜！`, '花園裡的眼睛，一個一個閉上了……');
}
// 換成第三世界：黃昏，列車停在第一站；乘客都還活著
function cut2Switch(c) {
  if (c.switched) return;
  c.switched = true;
  newGame(c.carry.diff, 3, c.carry);
  mode = 'cutscene';
  $('hud').classList.add('hidden');
  G.t = DAY_LEN - DUSK + 6;
  c.alive = true;
  cutCaption('我出去旅行……', '');
  Sound.play('steam');
}
// 睡著了：畫面變黑，列車開了（晚上、風景捲動、車輪聲）
function cut2Sleep(c) {
  if (c.slept) return;
  cut2Switch(c);
  c.slept = true;
  cutCaption('不小心睡著了……', '');
  G.phase = 'night'; G.t = 30; startNight3(); G.ev.schedule = []; G.train.k = 1; c.moving = true;
}
function updateCutscene2(dt) {
  const c = CUT, K = CUT2, ease = k => k * k * (3 - 2 * k);
  c.t += dt; G.time += dt;
  const t = c.t, S = CUT2_SEAT, seatFace = Math.atan2(S.lookY - S.y, S.lookX - S.x);
  let black = 0;
  const wheels = () => { c.clackT -= dt; if (c.clackT <= 0) { c.clackT = 0.56; Sound.play('clack', 0.35); } };
  if (t < K.door) {
    // 1. 天亮了：鏡頭停在原地
    G.t = Math.min(G.t + dt * 1.6, DAY_LEN - DUSK - 1);
    c.cam = { x: G.p.x, y: G.p.y, h: 0, face: G.p.face, pitch: G.p.pitch };
  } else if (t < K.fadeIn) {
    // 2. 淡出
    black = Math.min(1, (t - K.door) / 0.7);
    if (t >= K.door + 0.75) cut2Switch(c);
  } else if (t < K.sit) {
    // 3. 月台：看著列車、走向車門、走進交誼車廂、在絨布座位上坐下
    cut2Switch(c);
    black = t < K.fadeIn + 0.8 ? 1 - (t - K.fadeIn) / 0.8 : 0;
    const w = ease(clamp((t - K.walk) / (K.sit - K.walk), 0, 1));
    const pts = [[22.5, 29.8, 0], [22.5, 25.5, 0], [22.5, 23.4, 0], [S.x, S.y, -0.5]];
    const seg = w * 3, i = Math.min(2, Math.floor(seg)), k = seg - i, a = pts[i], b = pts[i + 1];
    const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k, h = a[2] + (b[2] - a[2]) * k;
    c.cam = { x, y, h, face: i < 2 ? -Math.PI / 2 : seatFace, pitch: 0.02 + Math.sin(t * 1.3) * 0.01 };
    if (Math.random() < dt * 5) steamPuff();
  } else if (t < K.wake) {
    // 4. 畫面慢慢變黑，只剩車輪的聲音；列車開了
    cut2Switch(c);
    black = Math.min(1, (t - K.sit) / 1.0);
    if (t >= K.black) cut2Sleep(c);
    if (c.moving) wheels();
    c.cam = { x: S.x, y: S.y, h: -0.5, face: seatFace, pitch: 0.02 };
  } else if (t < K.end) {
    // 5. 醒來：燈昏黃會閃、乘客全都蓋著白布不動、窗外一片黑；慢慢坐直、環顧四周
    cut2Sleep(c);
    if (!c.woke) { c.woke = true; c.alive = false; cutCaption('醒來時，火車上的人已經都死了……', '只剩我一個。'); }
    black = t < K.wake + 1.2 ? 1 - (t - K.wake) / 1.2 : t > K.end - 1.2 ? (t - (K.end - 1.2)) / 1.2 : 0;
    const look = ease(clamp((t - K.wake - 1) / 2.5, 0, 1));
    c.cam = { x: S.x, y: S.y, h: -0.5 + look * 0.5, face: seatFace + look * 1.5, pitch: 0.02 + Math.sin(t * 1.1) * 0.01 };
    wheels();
    if (t >= K.title && !c.titled) { c.titled = true; cutCaption('第三世界：末班列車', '白天下車找燃料和寶箱，晚上顧好火爐讓列車一直開'); Sound.play('whistle'); }
  } else { endCutscene2(); return; }
  const fade = $('cutFade');
  fade.style.background = '#000';
  fade.style.opacity = black.toFixed(3);
}
function skipCutscene2() {
  const c = CUT;
  if (!c || c.t >= CUT2.end - 1.2) return;
  cut2Switch(c);
  c.t = CUT2.end - 1.2;
}
function endCutscene2() {
  cut2Switch(CUT);
  // 第 1 天早上，列車停在第一個車站
  G.phase = 'day'; G.t = 0; G.train.k = 0; G.train.state = 'run'; G.ev.schedule = [];
  Object.assign(G.p, { x: 19.5, y: 23, face: -Math.PI / 2, pitch: 0 });
  lockStation(false);
  CUT = null; $('cutscene').classList.add('hidden'); $('cutFade').style.opacity = '0'; $('hud').classList.remove('hidden'); cutCaption('');
  mode = 'play'; invDirty = true; lockPointer();
  saveGame();
  showBig('第 1 天', '下車去車站找燃料和物資');
  toast('🚂 第三世界解鎖了！之後在主選單「新遊戲」也可以直接選第三世界。', 'good');
}

// ====================================================================
// 第三世界破關：天亮了，列車慢慢停進終點站 → 結局畫面
// ====================================================================
function victory3() {
  CUT = { kind: 3, t: 0 };
  mode = 'cutscene';
  Sound.setDrone(0);
  releaseInputs();
  if (document.pointerLockElement) document.exitPointerLock();
  $('hud').classList.add('hidden');
  $('cutscene').classList.remove('hidden');
  cutCaption('🌅 天亮了', '列車慢慢停進終點站……');
  Sound.play('whistle');
  for (const e of G.enemies) puff(e.x, e.y);
  G.enemies = [];
}
function updateCutscene3(dt) {
  const c = CUT;
  c.t += dt; G.time += dt;
  G.train.k = Math.max(0, 1 - c.t / 3.5);
  G.t = Math.min(NIGHT_LEN - 0.01, NIGHT_LEN - 4 + c.t);   // 天慢慢亮
  if (G.train.k > 0.1) { c.clackT = (c.clackT || 0) - dt; if (c.clackT <= 0) { c.clackT = 0.56 / G.train.k; Sound.play('clack', 0.3 * G.train.k); } }
  c.cam = { x: G.p.x, y: G.p.y, h: 0, face: G.p.face + Math.sin(c.t * 0.4) * 0.1, pitch: 0.03 };
  const white = clamp((c.t - 3.5) / 1.8, 0, 1), fade = $('cutFade');
  fade.style.background = '#fff6e6'; fade.style.opacity = white.toFixed(3);
  if (c.t >= 5.6) endVictory3();
}
function endVictory3() {
  CUT = null; $('cutscene').classList.add('hidden'); $('cutFade').style.opacity = '0'; cutCaption('');
  mode = 'over';
  Sound.play('win');
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  $('goTitle').textContent = '🚂 列車到站了';
  $('goText').innerHTML = `天亮了，列車慢慢停進終點站……月台上空無一人，只有你一個。<br>你在第三世界撐過了 ${LAST_NIGHT} 夜！<br>你搜索了 ${G.stats.searched} 次，驅散了 ${G.stats.dissolved} 個怪物。<br>最好的燈泡：${bulbName(G.stats.bestTier)}`;
  $('btnRetry').classList.add('hidden');
  $('gameover').classList.remove('hidden');
}
