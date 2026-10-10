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
  Object.assign(G.ev, { whistled: false, lockWarned: false, clackT: 0 });
  toast(`🚉 列車停靠在「${curStation()}」。白天車站的門開著，下車去找物資和寶箱吧。`, 'good');
  if (G.cold) toast('❄️ 寒寂之境：今天整天下雪、零下 100 度。體溫歸零就會死，常回火爐旁邊取暖！', 'warn');
}
// 讀存檔：白天開始，門開著
function loadDay3(chests) {
  lockStation(false);
  G.station = clamp(G.day - 1, 0, STATIONS_W3.length - 1);
  G.cold = COLD_DAYS.includes(G.day);
  G.train = { state: 'run', k: 0, t: 0, stopT: 0 };
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
  tr.k = Math.min(1, tr.k + dt * 0.3);
  ev.clackT -= dt;
  if (tr.k > 0.15 && ev.clackT <= 0) { ev.clackT = 0.56 / tr.k; Sound.play('clack', 0.3 * tr.k); }
}
// 夜晚排程：第二世界追過來的大嘴觸角蟲和眼花女孩（第 1 夜就可能來）
function scheduleNight3(add, again, night, n, hz) {
  if (again(0.35)) add('snail', 30, NIGHT_LEN - 35);
  if (night === 1 ? Math.random() < 0.5 : again(0.4)) add('girl', 25, NIGHT_LEN - 40);
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
  const a = [];
  if (G.phase === 'day' && G.t >= DAY_LEN - DUSK && G.t < DAY_LEN - 3) a.push('🚂 列車快開了，快上車！');
  return a;
}
function addTargets3(cands) {}
function useFuel(id) { toast(`🪵 走到${RN('attic')}的火爐前面按 E，就會把${ITEMS[id].name}丟進去。`); }
function drawMinimap3(c) {}
function testStart3(q, night) {
  if (q.has('cold')) { G.forceCold = true; G.cold = true; }
  if (q.get('fire') === '0') G.fire.queue = [];
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
