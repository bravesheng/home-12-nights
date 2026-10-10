'use strict';
// ===== 第二世界：夢核花園的新怪物（依照草稿設計）=====
// 向日葵眼、千眼菇、草叢人、大嘴觸角蟲、眼花女孩。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、rand、move… 都是遊戲跑起來之後才呼叫。

// ====================================================================
// 向日葵眼：會轉向最亮的光；你開著手電筒被它看到，就盯著你往腳邊吐種子
// ====================================================================
const SUN_RANGE = 8, SUN_LOCK = 0.6, SPIT_CD = 2, SEED_SPEED = 7;
// 同一個房間裡最亮的燈（向日葵眼沒看到你時就對著它曬太陽）
function brightestLight(f) {
  const tx = Math.floor(f.x), ty = Math.floor(f.y), room = roomGrid[ty] && roomGrid[ty][tx];
  let best = null;
  for (const L of G.lights) if (L.room === room && (!best || L.r * L.f > best.r * best.f)) best = L;
  return best;
}
function updateSunflower(f, dt, night) {
  const p = G.p;
  f.sees = false;
  if (!night || f.grow < 1) { f.lock = 0; return; }
  const d = Math.hypot(f.x - p.x, f.y - p.y);
  if (d < 9 && inBeam(f)) { flashHurt(f, dt); if (f.dead) return; }
  const los = d < SUN_RANGE && castRay(f.x, f.y, Math.atan2(p.y - f.y, p.x - f.x), d) >= d - 0.05;
  if (flashOn() && los) {
    f.lock = Math.min(1.5, f.lock + dt);
    f.face = Math.atan2(p.y - f.y, p.x - f.x);
  } else {
    f.lock = Math.max(0, f.lock - dt * 0.8);
    f.lightT -= dt;
    if (f.lightT <= 0) {
      f.lightT = 0.7;
      const L = brightestLight(f);
      if (L) f.face = Math.atan2(L.y - f.y, L.x - f.x);
    }
  }
  if (f.lock >= SUN_LOCK) {
    if (!G.ev.sunLockTip) { G.ev.sunLockTip = 1; toast('🌻 向日葵眼轉過來盯著你的手電筒了！關掉手電筒，它就不會理你。', 'warn'); }
    f.spitT -= dt;
    if (f.spitT <= 0) { spitSeed(f); f.spitT = SPIT_CD; }
  } else f.spitT = Math.max(f.spitT, 0.5);
}
// 往你的腳邊吐一顆種子（跳起來就打不到）
function spitSeed(f) {
  const p = G.p, h0 = 1.35;
  const d = Math.hypot(p.x - f.x, p.y - f.y) || 1, T = d / SEED_SPEED;
  G.seeds.push({ x: f.x, y: f.y, h: h0, vx: (p.x - f.x) / T, vy: (p.y - f.y) / T, vh: (0.12 - h0) / T, life: T + 0.8, spin: Math.random() * 6 });
  Sound.play('spit', nearVol(d));
}

// ====================================================================
// 千眼菇：不會動，四面八方都看得到；靠近會撒孢子，每天早上旁邊再長出一朵小的
// ====================================================================
const SPORE_R = 4.2;
function updateShroom(f, dt, night) {
  const p = G.p;
  f.spore = false;
  if (!night || f.grow < 1) return;
  const d = Math.hypot(f.x - p.x, f.y - p.y);
  if (d < 9 && inBeam(f)) { f.shut = 1.2; flashHurt(f, dt); if (f.dead) return; }  // 被手電筒照到，眼睛全部閉起來
  f.shut = Math.max(0, f.shut - dt);
  f.dripT = (f.dripT || 0) - dt;
  if (f.dripT <= 0 && d < 10) { f.dripT = rand(2.5, 4.5); Sound.play('drip', nearVol(d) * 0.6); }
  if (f.shut > 0 || d > SPORE_R) return;
  if (castRay(f.x, f.y, Math.atan2(p.y - f.y, p.x - f.x), d) < d - 0.05) return;
  f.spore = true;
  G.spore = Math.min(1, G.spore + dt * 1.1);
  p.san -= 6 * D().san * dt;
  if (Math.random() < dt * 30) {
    const a = Math.random() * Math.PI * 2, r = rand(0.1, 0.6);
    G.fx.push({ type: 'spark', x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r, h: 1.45, vx: (p.x - f.x) * 0.12, vy: (p.y - f.y) * 0.12, vh: -rand(0.2, 0.6), life: rand(1, 1.8), max: 1.8, color: pick([[255, 90, 120], [120, 170, 255], [255, 220, 120], [190, 120, 255]]) });
  }
  if (!G.ev.sporeTip) { G.ev.sporeTip = 1; toast('🍄 千眼菇在撒孢子！快離開，或用手電筒照它，讓它的眼睛閉起來。', 'warn'); Sound.play('spore'); }
}
// 每天早上：還活著的千眼菇旁邊會再長出一朵小的（到了晚上才長大）
function spreadShrooms() {
  const grown = G.flowers.filter(f => f.ptype === 'shroom' && f.grow >= 1 && !f.dead);
  let k = 0;
  for (const f of grown) {
    const s = spawnFlower('shroom', { x: f.x, y: f.y, r0: 1, r1: 3 });
    if (s) { s.grow = 0.3; s.sprout = true; k++; }
  }
  if (k) toast(`🍄 千眼菇旁邊又長出了 ${k} 朵小千眼菇！到了晚上就會長大，白天先打掉它吧。`, 'warn');
}

// ====================================================================
// 草叢人：躲在草裡移動；靠近時撲出來抓腳（跳起來就抓不到），被抓住要連按跳掙脫
// ====================================================================
const GRAB_ESCAPE = 5;
function updateGrass(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.cd = Math.max(0, e.cd - dt);
  const beam = inBeam(e);
  switch (e.state) {
    case 'hidden': {
      e.hidden = true;
      e.rise = Math.max(0, e.rise - dt * 3);
      if (beam && d < 9) {
        // 手電筒照到晃動的草叢：把牠逼出來
        e.state = 'up'; e.upT = 6; e.hidden = false;
        Sound.play('grassRise', nearVol(d));
        if (!G.ev.grassOutTip) { G.ev.grassOutTip = 1; toast('🔦 手電筒把草叢人逼出來了！站出來的牠走得很慢，快打牠！', 'good'); }
        break;
      }
      const dir = chaseDir(e), sp = Math.min(1.7 + n * 0.012, 2.5) * (e.spawn > 0 ? 0.3 : 1);
      move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
      e.rustleT -= dt;
      if (e.rustleT <= 0 && d < 11) { Sound.play('rustle', nearVol(d)); e.rustleT = rand(0.8, 1.4); }
      if (d < 1.8 && e.cd <= 0 && e.spawn <= 0 && p.inv <= 0 && !p.grabbed && castRay(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), d) >= d - 0.05) {
        e.state = 'rise'; e.t = 0.42; e.hidden = false;
        Sound.play('grassRise', nearVol(d));
      }
      break;
    }
    case 'rise': // 從草裡站起來，準備撲過來
      e.rise = Math.min(1, e.rise + dt / 0.42);
      if (beam) { flashHurt(e, dt); if (e.dead) return; }
      e.t -= dt;
      if (e.t <= 0) {
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        e.state = 'lunge'; e.t = 0.38; e.lungeX = Math.cos(a); e.lungeY = Math.sin(a);
        Sound.play('swish');
      }
      break;
    case 'lunge':
      e.t -= dt;
      move(e, e.lungeX * 6 * dt, e.lungeY * 6 * dt, ENEMY_R);
      if (Math.hypot(e.x - p.x, e.y - p.y) < 0.75) {
        if (p.z > 0.25 || p.inv > 0) {
          // 跳起來了：撲空，站在原地發呆
          e.state = 'up'; e.upT = 5; e.stunT = 1.1;
          if (p.z > 0.25 && !G.ev.dodgeTip) { G.ev.dodgeTip = 1; toast('⤒ 跳起來躲過了草叢人！', 'good'); }
        } else grassGrab(e);
        break;
      }
      if (e.t <= 0) { e.state = 'up'; e.upT = 5; }
      break;
    case 'grab': {
      e.grabT += dt;
      p.hp -= (6 + n * 0.05) * D().dmg * (G.inv.amulet ? 0.5 : 1) * dt;
      p.san -= 3 * D().san * dt;
      p.hurt = Math.max(p.hurt, 0.35);
      if (beam) { e.shine += dt; flashHurt(e, dt); if (e.dead) return; }
      if (e.shine >= 0.8) grassRelease(e, '🔦 手電筒照到牠的臉，草叢人放手了！');
      else if (e.escape >= GRAB_ESCAPE) grassRelease(e, '⤒ 你掙脫了草叢人！');
      else if (e.grabT >= 4) grassRelease(e, '草叢人鬆開了你的腳……');
      break;
    }
    case 'up': { // 站出來了：走得很慢，打得到
      e.hidden = false;
      e.rise = Math.min(1, e.rise + dt * 3);
      if (beam) { flashHurt(e, dt); if (e.dead) return; }
      e.upT -= dt;
      const dir = chaseDir(e);
      move(e, dir.x * 0.9 * dt, dir.y * 0.9 * dt, ENEMY_R);
      if (d < 0.65 && p.z < 0.25 && p.inv <= 0 && !p.grabbed && e.spawn <= 0) grassGrab(e);
      else if (e.upT <= 0) { e.state = 'sink'; e.t = 0.6; }
      break;
    }
    case 'sink': // 鑽回草裡，跑到別的地方
      e.rise = Math.max(0, e.rise - dt / 0.6);
      e.t -= dt;
      if (e.t <= 0) {
        e.state = 'hidden'; e.hidden = true; e.cd = 6;
        const pos = findSpawn(9);
        if (pos) { e.x = pos.x; e.y = pos.y; }
      }
      break;
  }
}
function grassGrab(e) {
  const p = G.p;
  e.state = 'grab'; e.hidden = false; e.rise = 1; e.grabT = 0; e.escape = 0; e.shine = 0;
  // 站在你面前一步遠的地方抓著你的腳（臉才看得清楚）
  const a = Math.atan2(e.y - p.y, e.x - p.x), gx = p.x + Math.cos(a) * 0.85, gy = p.y + Math.sin(a) * 0.85;
  if (!hits(gx, gy, ENEMY_R)) { e.x = gx; e.y = gy; }
  p.face = a;
  p.grabbed = e; p.vz = 0; p.z = 0;
  if (G.nightStats) G.nightStats.caught++;
  Sound.play('grab'); G.shake = 0.5; p.hurt = 1;
  toast('🌿 草叢人抓住了你的腳！連按「跳」掙脫！', 'warn');
}
function grassRelease(e, msg) {
  const p = G.p;
  if (p.grabbed === e) p.grabbed = null;
  p.inv = Math.max(p.inv, 1.2);
  e.state = 'sink'; e.t = 0.6; e.escape = 0; e.shine = 0;
  if (msg) toast(msg, 'good');
}
// 被抓住時按跳：算一次掙扎
function grabEscapePress() {
  const e = G.p.grabbed;
  if (!e) return;
  e.escape++;
  Sound.play('jump', 0.5);
  G.shake = Math.max(G.shake, 0.15);
}

// ====================================================================
// 大嘴觸角蟲：爬得很慢但很耐打，留下黏液；手電筒照觸角會縮回去，鹽巴傷害 3 倍
// ====================================================================
function updateSnail(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.retractCd = Math.max(0, e.retractCd - dt);
  e.retract = Math.max(0, e.retract - dt);
  if (inBeam(e)) {
    flashHurt(e, dt);
    if (e.dead) return;
    if (e.retractCd <= 0) {
      e.retract = 2; e.retractCd = 6;
      Sound.play('squish', nearVol(d));
      if (!G.ev.retractTip) { G.ev.retractTip = 1; toast('🐌 手電筒照到觸角，牠縮起來停住了！趁現在撒鹽巴！', 'good'); }
    }
  }
  if (e.chew > 0) { e.chew -= dt; return; } // 咬完在嚼：快逃
  if (e.retract <= 0) {
    const dir = chaseDir(e), sp = Math.min(1.15 + n * 0.008, 1.7) * (e.spawn > 0 ? 0.3 : 1);
    move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    e.trailT -= dt;
    if (e.trailT <= 0) { e.trailT = 0.3; addTrail(e.x, e.y); }
  }
  if (d < 0.85 && e.spawn <= 0 && p.inv <= 0 && e.retract <= 0 && p.z < 0.6) {
    damage(30 + n * 0.15, 15);
    p.inv = 1.5; e.chew = 3; G.shake = 0.6;
    Sound.play('chomp');
    toast('🐌 大嘴觸角蟲咬了你一大口！牠在嚼東西，快逃！', 'warn');
  }
}
function addTrail(x, y) {
  const last = G.trails[G.trails.length - 1];
  if (last && Math.hypot(last.x - x, last.y - y) < 0.25) { last.life = 20; return; }
  G.trails.push({ x, y, life: 20, r: rand(0.32, 0.42), a: Math.random() * 6 });
  if (G.trails.length > 160) G.trails.shift();
}
function onTrail(x, y) {
  if (!G.trails || !G.trails.length) return false;
  for (const t of G.trails) if ((t.x - x) ** 2 + (t.y - y) ** 2 < 0.3) return true;
  return false;
}

// ====================================================================
// 眼花女孩：靠樹枝上的眼球花看東西，被盯著會眼花；會種下眼睛種子（長成向日葵眼）
// ====================================================================
const GIRL_SEE = 11;
function updateGirl(e, dt) {
  const p = G.p, n = diffN(), d = Math.hypot(e.x - p.x, e.y - p.y);
  e.blind = Math.max(0, e.blind - dt); e.blindCd = Math.max(0, e.blindCd - dt);
  if (inBeam(e)) {
    flashHurt(e, dt);
    if (e.dead) return;
    if (e.blindCd <= 0) {
      e.blind = 5; e.blindCd = 8;
      Sound.play('giggle', nearVol(d) * 0.7);
      if (!G.ev.blindTip) { G.ev.blindTip = 1; toast('👧 眼球花被照得閉起來了！她現在看不見，會到處亂走。', 'good'); }
    }
  }
  e.seen = e.blind <= 0 && e.spawn <= 0 && d < GIRL_SEE && castRay(e.x, e.y, Math.atan2(p.y - e.y, p.x - e.x), d) >= d - 0.05;
  if (e.seen) {
    G.dizzy = Math.min(1, G.dizzy + dt * 0.9);
    if (!G.ev.dizzyTip) { G.ev.dizzyTip = 1; toast('👧 眼花女孩的眼球花盯著你……你開始「眼花」了！用手電筒照她！', 'warn'); }
    const dir = chaseDir(e), sp = Math.min(1.9 + n * 0.01, 2.6) * (e.spawn > 0 ? 0.3 : 1);
    move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    e.state = 'hunt';
  } else {
    // 看不到你（或被照瞎了）：到處亂走
    if (e.state === 'hunt' || !e.flow) { e.state = 'wander'; pickWander(e); }
    if (Math.hypot(e.tx - e.x, e.ty - e.y) > 0.5) {
      const dir = pathDir(e, e.flow, e.tx, e.ty, 0.25), sp = e.blind > 0 ? 1.5 : 1.1;
      move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
    } else pickWander(e);
  }
  // 她是花園的園丁：走過的地方會種下眼睛種子
  e.plantT -= dt;
  if (e.plantT <= 0) { e.plantT = rand(16, 24); plantSeed(e.x, e.y); }
  e.humT -= dt;
  if (e.humT <= 0 && d < 13) { Sound.play('hum', nearVol(d)); e.humT = rand(4, 6.5); }
  if (d < 0.7 && e.spawn <= 0 && p.inv <= 0) {
    jumpscare(drawGirlFace);
    damage(28 + n * 0.15, 22); p.inv = 1.5;
    toast('👧 眼花女孩抓住了你……然後咯咯笑著消失了。', 'warn');
    womanVanish(e, 14);
  }
}
function plantSeed(x, y) {
  if (G.phase !== 'night' || !isW2()) return;   // 列車上沒有泥土，眼花女孩種不了種子
  const tx = Math.floor(x), ty = Math.floor(y);
  if (!plantSpotOk(tx, ty, 1.5) || G.seedlings.some(s => Math.hypot(s.x - tx - 0.5, s.y - ty - 0.5) < 1.2)) return;
  if (plantCount('sunflower') + G.seedlings.length >= MAX_PLANTS.sunflower) return;
  G.seedlings.push({ x: tx + 0.5, y: ty + 0.5, t: 15, max: 15 });
  Sound.play('plop', 0.4);
  if (!G.ev.seedlingTip) { G.ev.seedlingTip = 1; toast('👁️ 眼花女孩種下了一顆眼睛種子！15 秒後會長成向日葵眼，快去踩掉它。', 'warn'); }
}

// ====================================================================
// 每一幀：種子飛行、眼睛種子長大或被踩掉、黏液慢慢乾掉
// ====================================================================
function updateWorld2(dt) {
  if (!G.seeds) return;
  const p = G.p;
  for (const s of G.seeds) {
    s.life -= dt; s.spin += dt * 12;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.h = Math.max(0.05, s.h + s.vh * dt);
    if (s.h <= 0.06) { s.vx *= 0.9; s.vy *= 0.9; s.vh = 0; }      // 落地後滾一下
    if (isWall(Math.floor(s.x), Math.floor(s.y)) || s.life <= 0) { s.dead = true; continue; }
    if (Math.hypot(s.x - p.x, s.y - p.y) < 0.42 && s.h < 0.75 && p.z < 0.3) {
      s.dead = true;
      damage(5 + diffN() * 0.05, 3, false);
      Sound.play('seedHit');
      if (!G.ev.seedTip) { G.ev.seedTip = 1; toast('🌻 被種子打到了！種子是吐向腳邊的，跳起來就打不到。', 'warn'); }
    }
  }
  G.seeds = G.seeds.filter(s => !s.dead);
  for (const s of G.seedlings) {
    if (G.phase === 'night') s.t -= dt;
    if (Math.hypot(s.x - p.x, s.y - p.y) < 0.5 && p.z < 0.2) {
      s.dead = true;
      puff(s.x, s.y, [235, 230, 220], 8, 0.15);
      Sound.play('stomp');
      if (!G.ev.stompTip) { G.ev.stompTip = 1; toast('👟 你把眼睛種子踩爛了！', 'good'); }
    } else if (s.t <= 0) {
      s.dead = true;
      if (plantCount('sunflower') < MAX_PLANTS.sunflower) {
        G.flowers.push(newFlower(s.x, s.y, 'sunflower'));
        Sound.play('grassRise', nearVol(Math.hypot(s.x - p.x, s.y - p.y)));
        toast('🌻 眼睛種子長成向日葵眼了！', 'warn');
      }
    }
  }
  G.seedlings = G.seedlings.filter(s => !s.dead);
  for (const t of G.trails) t.life -= dt;
  if (G.trails.length && G.trails[0].life <= 0) G.trails = G.trails.filter(t => t.life > 0);
}

// 萬物甦醒（第 6 夜和最後一夜）：花園裡的植物怪一下子長出好幾朵，草叢人也來了
function awakenGarden() {
  let k = 0;
  for (let i = 0; i < 2; i++) if (spawnFlower('sunflower')) k++;
  if (spawnFlower('shroom')) k++;
  if (spawnFlower('eye')) k++;
  if (G.enemies.filter(e => e.kind === 'grass').length < 3) spawnEnemy('grass');
  Sound.play('awaken');
  toast(`🌸 萬物甦醒！花園裡一下子冒出了 ${k} 朵會看人的花和菇……`, 'warn');
}

// ====================================================================
// 臉和圖鑑縮圖（2D 畫法；3D 貼圖、驚嚇畫面、怪物圖鑑共用）
// ====================================================================
// 眼花女孩：短短的黑髮、流血的眼睛、右眼長出一根開著兩顆眼球花的樹枝、藍色衣領
// bare：3D 用的臉（頭髮、衣服、樹枝和眼球花另外用 3D 做，左眼也是 3D 的眼球）：只畫臉、瀏海、眼窩、血淚和嘴
function drawGirlFace(c, S, bare = false) {
  const r = seeded(5150);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  if (!bare) {
    // 後面的頭髮（到肩膀）
    c.fillStyle = '#1a1414';
    c.beginPath(); c.moveTo(256, 40);
    c.bezierCurveTo(110, 40, 78, 150, 82, 280); c.bezierCurveTo(84, 360, 96, 420, 110, 450);
    c.lineTo(402, 450); c.bezierCurveTo(416, 420, 428, 360, 430, 280); c.bezierCurveTo(434, 150, 402, 40, 256, 40); c.fill();
    // 藍色上衣（V 領）
    c.fillStyle = '#5f7fae';
    c.beginPath(); c.moveTo(70, 512); c.quadraticCurveTo(110, 440, 200, 430); c.lineTo(256, 500); c.lineTo(312, 430); c.quadraticCurveTo(402, 440, 442, 512); c.fill();
    c.strokeStyle = '#3f5a85'; c.lineWidth = 5; c.beginPath(); c.moveTo(200, 430); c.lineTo(256, 500); c.lineTo(312, 430); c.stroke();
    // 脖子
    c.fillStyle = '#dcd2c6'; c.fillRect(222, 380, 68, 70);
  }
  // 臉
  const fg = c.createRadialGradient(250, 260, 30, 256, 270, 190);
  fg.addColorStop(0, '#f1e9de'); fg.addColorStop(0.8, '#ddd2c4'); fg.addColorStop(1, '#b8ab9c');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 268, 128, 160, 0, 0, Math.PI * 2); c.fill();
  if (bare) {
    // 3D 的臉：臉頰兩邊和眼窩暗一點（有立體感），額頭上方是頭皮（深色，3D 髮束之間不會露出皮膚）
    c.save(); c.clip();
    const sg = c.createLinearGradient(128, 0, 384, 0);
    sg.addColorStop(0, 'rgba(60,40,40,.55)'); sg.addColorStop(0.3, 'rgba(60,40,40,0)'); sg.addColorStop(0.7, 'rgba(60,40,40,0)'); sg.addColorStop(1, 'rgba(60,40,40,.55)');
    c.fillStyle = sg; c.fillRect(0, 0, 512, 512);
    for (const ex of [200, 312]) { const eg = c.createRadialGradient(ex, 250, 20, ex, 250, 62); eg.addColorStop(0, 'rgba(70,30,40,.45)'); eg.addColorStop(1, 'rgba(70,30,40,0)'); c.fillStyle = eg; c.fillRect(ex - 62, 188, 124, 124); }
    c.fillStyle = '#141216'; c.beginPath(); c.ellipse(256, 150, 134, 60, 0, Math.PI, 0); c.fill();
    c.restore();
  }
  // 瀏海
  for (let i = 0; i < 70; i++) {
    const x = 140 + r() * 232, g = 20 + r() * 30 | 0;
    c.strokeStyle = `rgba(${g},${g - 4},${g - 4},.92)`; c.lineWidth = 3 + r() * 4;
    c.beginPath(); c.moveTo(x + (r() - 0.5) * 20, 70); c.quadraticCurveTo(x + (r() - 0.5) * 30, 130, x + (r() - 0.5) * 16, 160 + r() * 30); c.stroke();
  }
  // 左眼：瞪大、往下流血
  const eye = (ex, ey) => {
    c.fillStyle = 'rgba(80,30,30,.35)'; c.beginPath(); c.ellipse(ex, ey + 4, 42, 30, 0, 0, 7); c.fill();
    c.fillStyle = '#f6efe6'; c.beginPath(); c.ellipse(ex, ey, 34, 22, 0, 0, 7); c.fill();
    c.strokeStyle = 'rgba(190,40,40,.6)'; c.lineWidth = 1.4;
    for (let k = 0; k < 6; k++) { const sg = k % 2 ? 1 : -1; c.beginPath(); c.moveTo(ex + sg * 32, ey + (r() - 0.5) * 8); c.lineTo(ex + sg * 18, ey + (r() - 0.5) * 12); c.stroke(); }
    c.fillStyle = '#5a3a26'; c.beginPath(); c.arc(ex, ey + 1, 13, 0, 7); c.fill();
    c.fillStyle = '#0d0808'; c.beginPath(); c.arc(ex, ey + 1, 6, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(ex - 5, ey - 5, 3.5, 0, 7); c.fill();
    c.strokeStyle = '#7a1e1e'; c.lineWidth = 3.5; c.beginPath(); c.ellipse(ex, ey, 34, 22, 0, 0, 7); c.stroke();
  };
  eye(200, 252);
  // 右眼：黑洞，長出一根樹枝
  c.fillStyle = '#2a0c0c'; c.beginPath(); c.ellipse(312, 252, 30, 22, 0, 0, 7); c.fill();
  c.strokeStyle = '#8a1d1d'; c.lineWidth = 4; c.stroke();
  // 血淚
  c.strokeStyle = '#a3121c'; c.fillStyle = '#a3121c';
  for (const [x0, y0, len] of [[188, 272, 150], [214, 272, 96], [300, 270, 170], [326, 272, 120]]) {
    c.lineWidth = 7; c.beginPath(); c.moveTo(x0, y0); c.bezierCurveTo(x0 + 5, y0 + len * 0.3, x0 - 5, y0 + len * 0.7, x0 + 2, y0 + len); c.stroke();
    c.beginPath(); c.ellipse(x0 + 2, y0 + len + 5, 6, 9, 0, 0, 7); c.fill();
  }
  // 嘴：微微張開
  c.fillStyle = '#4a0a10'; c.beginPath(); c.ellipse(256, 360, 34, 14, 0, 0, 7); c.fill();
  c.strokeStyle = '#9a2a30'; c.lineWidth = 4; c.stroke();
  if (bare) { c.restore(); return; }
  // 樹枝和兩顆眼球花
  c.strokeStyle = '#5c3a22'; c.lineWidth = 12;
  c.beginPath(); c.moveTo(318, 250); c.quadraticCurveTo(380, 210, 450, 120); c.stroke();
  c.lineWidth = 8; c.beginPath(); c.moveTo(380, 205); c.quadraticCurveTo(420, 215, 470, 235); c.stroke();
  const ball = (bx, by, br) => {
    c.fillStyle = '#e88aa8';
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; c.beginPath(); c.ellipse(bx + Math.cos(a) * br * 0.95, by + Math.sin(a) * br * 0.95, br * 0.55, br * 0.32, a, 0, 7); c.fill(); }
    c.fillStyle = '#f6efe6'; c.beginPath(); c.arc(bx, by, br * 0.72, 0, 7); c.fill();
    c.fillStyle = '#5a3a26'; c.beginPath(); c.arc(bx - br * 0.12, by + br * 0.05, br * 0.34, 0, 7); c.fill();
    c.fillStyle = '#0d0808'; c.beginPath(); c.arc(bx - br * 0.12, by + br * 0.05, br * 0.16, 0, 7); c.fill();
  };
  ball(452, 112, 36); ball(474, 240, 30);
  c.restore();
}
// 草叢人：皺皺的頭頂長出草、兩個黑洞眼睛、咧開的紅色大嘴和咖啡色的牙
// bare：3D 用的臉，頭頂的草另外用會搖的 3D 草葉做
function drawGrassFace(c, S, bare = false) {
  const r = seeded(9021);
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  // 頭頂的草
  for (let i = 0; i < (bare ? 0 : 46); i++) {
    const x = 150 + r() * 212, h = 70 + r() * 70, g = 110 + r() * 80 | 0;
    c.strokeStyle = `rgb(${g * 0.35 | 0},${g},${g * 0.45 | 0})`; c.lineWidth = 3 + r() * 3;
    c.beginPath(); c.moveTo(x, 120); c.quadraticCurveTo(x + (r() - 0.5) * 60, 120 - h * 0.6, x + (r() - 0.5) * 90, 120 - h); c.stroke();
  }
  // 長長的臉
  const fg = c.createRadialGradient(256, 280, 30, 256, 290, 220);
  fg.addColorStop(0, '#d9d2b8'); fg.addColorStop(0.8, '#b9b392'); fg.addColorStop(1, '#8c8a6a');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 290, 118, 196, 0, 0, Math.PI * 2); c.fill();
  // 皺皺的頭頂（像腦）
  c.fillStyle = '#c9a9a0'; c.beginPath(); c.ellipse(256, 150, 112, 64, 0, Math.PI, 0); c.fill();
  c.strokeStyle = 'rgba(120,70,70,.8)'; c.lineWidth = 3;
  for (let i = 0; i < 9; i++) {
    c.beginPath(); let x = 160 + i * 22, y = 110 + r() * 20; c.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 26; y += 10 + r() * 8; c.quadraticCurveTo(x + 12, y - 8, x, y); }
    c.stroke();
  }
  // 黑洞眼睛
  for (const ex of [206, 306]) {
    const g = c.createRadialGradient(ex, 238, 4, ex, 238, 38);
    g.addColorStop(0, '#000'); g.addColorStop(0.6, '#2a0d08'); g.addColorStop(1, 'rgba(90,40,30,.2)');
    c.fillStyle = g; c.beginPath(); c.ellipse(ex, 238, 36, 30, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,60,40,.85)'; c.beginPath(); c.arc(ex + 4, 240, 4, 0, 7); c.fill();
  }
  // 咧開的大嘴
  c.fillStyle = '#c4202c';
  c.beginPath(); c.moveTo(140, 350); c.quadraticCurveTo(256, 330, 372, 350); c.quadraticCurveTo(340, 452, 256, 456); c.quadraticCurveTo(172, 452, 140, 350); c.fill();
  c.fillStyle = '#3a0a0a';
  c.beginPath(); c.moveTo(166, 362); c.quadraticCurveTo(256, 348, 346, 362); c.quadraticCurveTo(318, 432, 256, 436); c.quadraticCurveTo(194, 432, 166, 362); c.fill();
  c.fillStyle = '#7a5a3a';
  for (let x = 176; x < 336; x += 18) { c.fillRect(x, 360 + Math.pow((x - 256) / 90, 2) * 6, 13, 22 + r() * 8); }
  for (let x = 196; x < 320; x += 18) { const yb = 428 - Math.pow((x - 256) / 70, 2) * 8; c.fillRect(x, yb - 18 - r() * 6, 12, 18); }
  // 臉上紅紅綠綠的痕跡
  for (let i = 0; i < 10; i++) {
    c.strokeStyle = i % 2 ? 'rgba(170,20,30,.75)' : 'rgba(60,140,60,.7)'; c.lineWidth = 4 + r() * 4;
    const x = 150 + r() * 212; c.beginPath(); c.moveTo(x, 300 + r() * 60); c.lineTo(x + (r() - 0.5) * 20, 420 + r() * 70); c.stroke();
  }
  c.restore();
}
// 大嘴觸角蟲的臉：粉紅色的肉、兩顆大眼睛、滿口尖牙的大嘴
function drawSnailFace(c, S) {
  c.save(); c.scale(S / 512, S / 512); c.lineCap = 'round'; c.lineJoin = 'round';
  const fg = c.createRadialGradient(256, 256, 40, 256, 256, 260);
  fg.addColorStop(0, '#f2b8c4'); fg.addColorStop(1, '#c97888');
  c.fillStyle = fg; c.beginPath(); c.ellipse(256, 256, 250, 220, 0, 0, Math.PI * 2); c.fill();
  // 大嘴
  c.fillStyle = '#7a0a16'; c.beginPath(); c.ellipse(256, 300, 150, 100, 0, 0, 7); c.fill();
  c.fillStyle = '#3a0408'; c.beginPath(); c.ellipse(256, 312, 120, 72, 0, 0, 7); c.fill();
  c.fillStyle = '#fbf6ee';
  for (let i = 0; i < 11; i++) { const a = Math.PI + 0.25 + i / 10 * (Math.PI - 0.5), x = 256 + Math.cos(a) * 140, y = 300 + Math.sin(a) * 92; c.beginPath(); c.moveTo(x - 13, y - 2); c.lineTo(x + 13, y - 2); c.lineTo(256 + Math.cos(a) * 104, 300 + Math.sin(a) * 50); c.fill(); }
  for (let i = 0; i < 9; i++) { const a = 0.35 + i / 8 * (Math.PI - 0.7), x = 256 + Math.cos(a) * 140, y = 300 + Math.sin(a) * 92; c.beginPath(); c.moveTo(x - 12, y + 2); c.lineTo(x + 12, y + 2); c.lineTo(256 + Math.cos(a) * 106, 300 + Math.sin(a) * 52); c.fill(); }
  // 嘴邊兩顆大眼睛
  for (const ex of [74, 438]) {
    c.fillStyle = '#f6efe6'; c.beginPath(); c.arc(ex, 230, 46, 0, 7); c.fill();
    c.strokeStyle = '#8a4a50'; c.lineWidth = 5; c.stroke();
    c.fillStyle = '#6a3a1e'; c.beginPath(); c.arc(ex, 232, 22, 0, 7); c.fill();
    c.fillStyle = '#0d0808'; c.beginPath(); c.arc(ex, 232, 10, 0, 7); c.fill();
  }
  // 往下滴的口水和血
  c.strokeStyle = '#e07a22'; c.lineWidth = 9;
  for (const x of [168, 344]) { c.beginPath(); c.moveTo(x, 380); c.lineTo(x + 4, 500); c.stroke(); }
  c.restore();
}
// ---------- 圖鑑縮圖 ----------
function eyeBall2D(c, x, y, rr, iris = '#6a4a2a') {
  c.fillStyle = '#f6efe6'; c.beginPath(); c.arc(x, y, rr, 0, 7); c.fill();
  c.strokeStyle = 'rgba(180,40,50,.7)'; c.lineWidth = Math.max(0.6, rr * 0.06);
  for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; c.beginPath(); c.moveTo(x + Math.cos(a) * rr * 0.95, y + Math.sin(a) * rr * 0.95); c.lineTo(x + Math.cos(a + 0.2) * rr * 0.5, y + Math.sin(a + 0.2) * rr * 0.5); c.stroke(); }
  c.fillStyle = iris; c.beginPath(); c.arc(x, y, rr * 0.45, 0, 7); c.fill();
  c.fillStyle = '#0d0808'; c.beginPath(); c.arc(x, y, rr * 0.2, 0, 7); c.fill();
  c.fillStyle = 'rgba(255,255,255,.8)'; c.beginPath(); c.arc(x - rr * 0.2, y - rr * 0.22, rr * 0.1, 0, 7); c.fill();
}
function thumbSunflower(c, S) {
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  c.strokeStyle = '#4f8a3a'; c.lineWidth = 7; c.beginPath(); c.moveTo(100, 198); c.quadraticCurveTo(106, 140, 100, 104); c.stroke();
  c.fillStyle = '#6fbf4a';
  for (const s of [-1, 1]) { c.beginPath(); c.ellipse(100 + s * 30, 158, 30, 11, s * -0.5, 0, 7); c.fill(); }
  c.fillStyle = '#f7d23a'; c.strokeStyle = '#c9a018'; c.lineWidth = 1.5;
  for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; c.beginPath(); c.ellipse(100 + Math.cos(a) * 46, 62 + Math.sin(a) * 46, 18, 8, a, 0, 7); c.fill(); c.stroke(); }
  c.fillStyle = '#6a4a1a'; c.beginPath(); c.arc(100, 62, 36, 0, 7); c.fill();
  eyeBall2D(c, 100, 62, 30);
  c.restore();
}
function thumbShroom(c, S) {
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  const st = c.createLinearGradient(80, 0, 120, 0); st.addColorStop(0, '#e8dca0'); st.addColorStop(1, '#f7f1d6');
  c.fillStyle = st; c.beginPath(); c.moveTo(86, 196); c.lineTo(90, 96); c.lineTo(110, 96); c.lineTo(116, 196); c.fill();
  for (let i = 0; i < 9; i++) { c.strokeStyle = i % 2 ? '#d43a4a' : '#4a7ae0'; c.lineWidth = 2.5; const x = 32 + i * 17; c.beginPath(); c.moveTo(x, 96); c.lineTo(x + 2, 120 + (i % 3) * 14); c.stroke(); }
  c.fillStyle = '#c8303e'; c.beginPath(); c.ellipse(100, 98, 76, 62, 0, Math.PI, 0); c.fill();
  c.fillStyle = '#a82030'; c.fillRect(24, 94, 152, 6);
  for (const [x, y, rr] of [[70, 70, 11], [100, 56, 12], [130, 70, 11], [55, 88, 8], [85, 84, 9], [115, 84, 9], [145, 88, 8], [100, 76, 7], [80, 52, 7], [120, 52, 7]]) eyeBall2D(c, x, y, rr);
  c.restore();
}
function thumbGrass(c, S) {
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  c.translate(40, 8); drawGrassFace(c, 120);
  c.restore();
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  const r = seeded(31);
  for (let i = 0; i < 40; i++) {
    const x = 10 + r() * 180, g = 110 + r() * 90 | 0, h = 40 + r() * 70;
    c.strokeStyle = `rgb(${g * 0.3 | 0},${g},${g * 0.4 | 0})`; c.lineWidth = 2 + r() * 2;
    c.beginPath(); c.moveTo(x, 200); c.quadraticCurveTo(x + (r() - 0.5) * 30, 200 - h * 0.6, x + (r() - 0.5) * 40, 200 - h); c.stroke();
  }
  c.restore();
}
function thumbSnail(c, S) {
  c.save(); c.scale(S / 200, S / 200); c.lineCap = 'round';
  c.fillStyle = '#d9875a'; c.fillRect(0, 176, 200, 24);
  for (let i = 0; i < 8; i++) { const x = 18 + i * 23; c.strokeStyle = '#7a8a6a'; c.lineWidth = 2; c.beginPath(); c.moveTo(x, 182); c.lineTo(x, 168); c.stroke(); c.fillStyle = '#efe6d6'; c.beginPath(); c.arc(x, 165, 4, 0, 7); c.fill(); }
  const fg = c.createRadialGradient(100, 110, 10, 100, 120, 90); fg.addColorStop(0, '#f2b8c4'); fg.addColorStop(1, '#c97888');
  c.fillStyle = fg; c.beginPath(); c.ellipse(100, 120, 84, 60, 0, 0, 7); c.fill();
  for (const [x0, x1, y1] of [[64, 44, 34], [80, 72, 22], [120, 128, 22], [136, 156, 34]]) {
    c.strokeStyle = '#d98c9c'; c.lineWidth = 5; c.beginPath(); c.moveTo(x0, 76); c.quadraticCurveTo((x0 + x1) / 2, 50, x1, y1); c.stroke();
    eyeBall2D(c, x1, y1, 8);
  }
  c.save(); c.translate(52, 82); drawSnailFace(c, 96); c.restore();
  c.restore();
}
function thumbGirl(c, S) {
  c.save(); c.scale(S / 200, S / 200);
  c.translate(4, 4); drawGirlFace(c, 192);
  c.restore();
}
