'use strict';
// ===== 第五世界：世界夾層（照設計師第五次手稿 docs/sketches/IMG_7436.jpeg） =====
// 沒有天花板的夢核草原：樹、花、池塘、河、草，四周是白白的霧。玩法跟第四世界一樣（背包 16 格、自己蓋房子、火爐、天氣，
// 第四世界的程式 isW4() 在第五世界也是 true），這個檔案是第五世界不一樣的地方：
// 樹要自己砍（掉板子和木柴）、工作台打開書合成（木柴做成 1 公尺的方塊）、樹上和花上長東西、池塘和河可以釣魚、
// 扭蛋機換成沐浴球（丟進水裡洗出東西）、12 天的天氣（下雨、雷暴雨、霧、寒寂之境、紅月、酸雨）、7 隻新怪物。
// 這個檔案在 game.js 之前載入，函式裡用到的 G、toast、move… 都是遊戲跑起來之後才呼叫。
const isW5 = () => curWorld === 5;

// ====================================================================
// 水：池塘和河（data.js 的 W5MAP.water，地圖上是走不進去的牆格）
// ====================================================================
const isWater5 = (x, y) => isW5() && W5MAP.water.has(Math.floor(x) + ',' + Math.floor(y));
// 前面或旁邊最近的水（釣魚、丟沐浴球）：回傳水格的中心，沒有就是 null
function waterNear5(maxD = 1.8, front = true) {
  const p = G.p;
  if (front) for (let d = 0.6; d <= maxD; d += 0.3) { const x = p.x + Math.cos(p.face) * d, y = p.y + Math.sin(p.face) * d; if (isWater5(x, y)) return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, d }; }
  let best = null;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy, d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y);
    if (d <= maxD + 0.3 && isWater5(x, y) && (!best || d < best.d)) best = { x: x + 0.5, y: y + 0.5, d };
  }
  return best;
}

// ====================================================================
// 樹：看著樹按住 E 砍，砍 3 下就倒（掉 2 片木頭板子在地上、2 根木柴），樹上長的東西掉到地上；2 天後在原地長回來
// ====================================================================
const TREE_CHOPS = 3, TREE_REGROW = 2;
const treesUp5 = () => FURN.filter(f => f.type === 'tree5' && !f.cut);
function chop5(f) {
  if (!f || f.cut) return;
  f.chops = (f.chops || 0) + 1;
  Sound.play('chop'); makeNoise(5); G.shake = Math.max(G.shake, 0.08);
  puff(f.x + 0.5, f.y + 0.5, [150, 110, 70], 6, 1.1);
  net4('chop5', { id: f.id, chops: f.chops });   // 跟朋友一起玩：朋友看得到你在砍、一起砍同一棵
  if (f.chops < TREE_CHOPS) { if (!G.ev.chopTip) { G.ev.chopTip = 1; toast(`🪓 砍了一下！再砍 ${TREE_CHOPS - f.chops} 下樹就會倒。`); } return; }
  fellTree5(f, true);
}
// 樹倒了（自己砍的、被閃電打到的）：掉板子和木柴，樹上的東西掉下來
function fellTree5(f, mine) {
  f.cut = G.day; f.chops = 0;
  if (furnGrid[f.y][f.x] === f) { furnGrid[f.y][f.x] = null; solid[f.y][f.x] = tiles[f.y][f.x] === 0; }
  b4Changed();
  Sound.play('treeFall'); G.shake = Math.max(G.shake, 0.25);
  const a = Math.random() * Math.PI * 2, loose = [];
  for (let i = 0; i < 2; i++) { dropLoose4(f.x + 0.5 + Math.cos(a) * (0.9 + i * 0.7), f.y + 0.5 + Math.sin(a) * (0.9 + i * 0.7), { k: 'plank', tier: 1 }); loose.push(G.loose4[G.loose4.length - 1]); }
  const wood = { x: f.x + 0.5 - Math.cos(a) * 0.6, y: f.y + 0.5 - Math.sin(a) * 0.6, id: 'wood', n: 2, keep: 1, t: Math.random() * 6 };
  G.pickups.push(wood);
  dropFruit5(f);
  if (window.Renderer && Renderer.tree5) Renderer.tree5(f);
  // 跟朋友一起玩：掉在地上的板子和木柴照 uid 送過去（朋友撿走時兩邊一起消失）
  net4('fell5', { id: f.id, loose: loose.map(l => ({ x: l.x, y: l.y, a: l.a, tier: 1, uid: uidOf4(l) })), wood: pkSpec4(wood) });
  if (mine && !G.ev.fellTip) { G.ev.fellTip = 1; toast('🌳 樹倒了！地上有 2 片木頭板子（對著它按 E 拿起來蓋牆）和 2 根木柴（放進背包，在工作台做成方塊、丟進火爐）。樹 2 天後會長回來。', 'good'); }
}
// 樹上長的東西掉到地上（uid 不變，朋友那邊同一個東西也掉下來）
function dropFruit5(f) { for (const pk of G.pickups) if (pk.s === f.id) { delete pk.s; delete pk.si; pk.z = 0; } }
// 一棵樹變成倒的／站著的（朋友送來的、房主早上送來的）
function setCut5(f, day) {
  if (!f || f.type !== 'tree5' || !!f.cut === !!day) return;
  f.cut = day || null; f.chops = 0;
  if (day) { if (furnGrid[f.y][f.x] === f) { furnGrid[f.y][f.x] = null; solid[f.y][f.x] = tiles[f.y][f.x] === 0; } }
  else if (!furnGrid[f.y][f.x]) { furnGrid[f.y][f.x] = f; solid[f.y][f.x] = true; }
  if (window.Renderer && Renderer.tree5) Renderer.tree5(f);
}
// 照房主的清單（[[樹的 id, 哪一天倒的], ...]）：清單裡的倒下、其他的站著
function applyCut5(list) {
  const m = new Map(list.map(([id, day]) => [id, day]));
  for (const f of FURN) if (f.type === 'tree5') setCut5(f, m.get(f.id) || null);
  b4Changed();
}
// 每天早上：倒了 2 天的樹長回來（那一格沒有東西擋著才長）；跟朋友一起玩時只有房主算，客人照房主送來的（net4ApplyDay）
function regrow5() {
  for (const f of FURN) {
    if (f.type !== 'tree5' || !f.cut || G.day - f.cut < TREE_REGROW) continue;
    if (furnGrid[f.y][f.x] || Math.hypot(G.p.x - f.x - 0.5, G.p.y - f.y - 0.5) < 1.2 || (G.b4 && G.b4.cells.has(f.x + ',' + f.y))) continue;
    f.cut = null; f.chops = 0;
    furnGrid[f.y][f.x] = f; solid[f.y][f.x] = true;
    if (window.Renderer && Renderer.tree5) Renderer.tree5(f);
  }
  b4Changed();
}
// 樹上、花上長的東西（設計圖：食物水果、飲料、餅乾、電池、檯燈……都會長在樹上或花上）：每天早上補，第 1 天多一點。
// 跟第四世界架上的東西一樣是 G.pickups 裡有 s（長在哪一棵）、z（多高）的那些，看著按 E 拿
function stock5(first) {
  const on = new Map();
  for (const pk of G.pickups) if (pk.s) on.set(pk.s, (on.get(pk.s) || 0) + 1);
  for (const f of FURN) {
    if (!f.grow || f.cut) continue;
    const tree = f.type === 'tree5', have = on.get(f.id) || 0, max = tree ? 2 : 1;
    if (have >= max || Math.random() > (first ? 0.85 : 0.55) * Math.min(1.3, D().items)) continue;
    for (let k = have; k < max && (k === have || Math.random() < 0.5); k++) {
      const id = rollItem(f.grow, 2, G.day), a = Math.random() * Math.PI * 2, rr = tree ? 0.62 + Math.random() * 0.2 : 0;
      G.pickups.push({ x: f.x + 0.5 + Math.cos(a) * rr, y: f.y + 0.5 + Math.sin(a) * rr, z: tree ? 1.7 + Math.random() * 0.35 : 1.02 * (f.big || 1), a: Math.random() * 6, id, n: LOOT_QTY[id] || 1, s: f.id, si: k, keep: 1, t: Math.random() * 6 });
    }
  }
}

// ====================================================================
// 釣魚：站在池塘或河邊、看著水，按住 E（有釣竿快一倍）就釣到一條魚；偶爾釣到別的東西
// ====================================================================
const FISH_JUNK = { battery: 2, coin: 3, bathbomb: 1, candle: 1, marble: 1, wood: 1 };
function fish5() {
  const w = waterNear5(1.8);
  if (!w) return;
  const junk = Math.random() < 0.18, id = junk ? weighted(FISH_JUNK) : 'fish5';
  if (id === 'coin') { addCoins(2); toast('🎣 釣上來一個小袋子……裡面有 2 枚硬幣！', 'item'); }
  else {
    if (!bagFits(id)) { toast(`🎒 背包滿了，釣到的${itemName(id)}又滑回水裡了。`, 'warn'); Sound.play('splash'); return; }
    gainItem(id, 1);
    toast(id === 'fish5' ? '🎣 釣到一條魚！生的有點腥，在工作台烤熟比較好吃。' : `🎣 釣上來的不是魚……是${itemName(id)}！`, 'item');
  }
  Sound.play('fish');
  splash5(w.x, w.y);
  net4('fx5', { k: 'fish', x: w.x, y: w.y });   // 跟朋友一起玩：朋友看得到你釣起來的水花
  makeNoise(2);
}
function splash5(x, y) {
  for (let i = 0; i < 12; i++) G.fx.push({ type: 'spark', x: x + rand(-0.4, 0.4), y: y + rand(-0.4, 0.4), h: 0.05, vx: rand(-0.6, 0.6), vy: rand(-0.6, 0.6), vh: rand(1, 2.4), life: 0.5, max: 0.5, color: [200, 230, 255] });
}

// ====================================================================
// 沐浴球（設計圖：扭蛋機不見了，變成沐浴球！買沐浴球後可以去池塘、河流洗出物資）：
// 選沐浴球按 Q 丟進旁邊的水裡，咕嚕咕嚕冒泡 2 秒，洗出 2～4 樣東西浮到岸邊
// ====================================================================
const BATH_PRICE = 3;
function useBath5() {
  const w = waterNear5(2.2, false);
  if (!w) { toast('🫧 要走到池塘或河邊才能丟沐浴球（丟進水裡才會洗出東西）。'); Sound.play('empty'); return false; }
  G.inv.bathbomb--; if (G.inv.bathbomb <= 0) { delete G.inv.bathbomb; if (G.selId === 'bathbomb') G.selId = invList()[0] || null; }
  invDirty = true;
  G.bath5 = G.bath5 || [];
  G.bath5.push({ x: w.x, y: w.y, t: 2 });
  net4('bath5', { x: w.x, y: w.y });   // 跟朋友一起玩：朋友也看得到冒泡（洗出來的東西用 drop 一個一個送）
  Sound.play('splash'); Sound.play('fizz');
  if (!G.ev.bathTip) { G.ev.bathTip = 1; toast('🫧 沐浴球掉進水裡，咕嚕咕嚕地冒泡泡……', 'good'); }
  return true;
}
function updateBath5(dt) {
  if (!G.bath5 || !G.bath5.length) return;
  for (const b of G.bath5) {
    b.t -= dt;
    if (Math.random() < dt * 40) G.fx.push({ type: 'spark', x: b.x + rand(-0.8, 0.8), y: b.y + rand(-0.8, 0.8), h: 0.05, vx: rand(-0.2, 0.2), vy: rand(-0.2, 0.2), vh: rand(0.4, 1.4), life: 0.7, max: 0.7, color: pick([[255, 190, 230], [190, 220, 255], [230, 255, 220], [255, 255, 255]]) });
    if (b.t > 0 || b.remote) continue;   // 朋友丟的：只冒泡，東西由朋友那邊送過來
    // 洗出來的東西浮到岸邊（離玩家近的那一邊）；硬幣直接給丟的人
    const n = randi(2, 4), got = [];
    for (let i = 0; i < n; i++) {
      const id = rollItem('bath5', 3, G.day);
      let x = G.p.x, y = G.p.y;
      for (let k = 0; k < 20; k++) { const a = Math.random() * Math.PI * 2, rr = 0.6 + Math.random() * 1.2, tx = G.p.x + Math.cos(a) * rr, ty = G.p.y + Math.sin(a) * rr; if (walkable(tx, ty)) { x = tx; y = ty; break; } }
      if (id === 'coin') { addCoins(2); got.push('2 枚硬幣'); }
      else { const pk = { x, y, z: 0, id, n: LOOT_QTY[id] || 1, keep: 1, t: Math.random() * 6 }; G.pickups.push(pk); net4('drop', { pk: pkSpec4(pk) }); got.push(itemName(id)); }
    }
    Sound.play('pop'); Sound.play('pickup');
    toast(`🫧 泡泡散開了，洗出來：${got.join('、')}！岸邊的東西看著它按 E 撿起來。`, 'good');
  }
  G.bath5 = G.bath5.filter(b => b.t > 0);
}
// 沐浴球機（取代扭蛋機）：投 3 枚硬幣買一顆沐浴球
function openBath5() {
  openModal('🫧 沐浴球機', () => `<div class="gacha"><div class="ic big">🫧</div><div class="nm">投 ${BATH_PRICE} 枚硬幣買一顆沐浴球。<br>拿到池塘或河邊，選它按 Q 丟進水裡，會洗出 2～4 樣東西！</div></div>
    <p class="hint">🪙 你有 ${G.coins || 0} 枚硬幣・🫧 背包裡有 ${G.inv.bathbomb || 0} 顆沐浴球</p>
    <div class="btns"><button data-act="buy" ${G.coins >= BATH_PRICE && bagFits('bathbomb') ? '' : 'disabled'}>🪙 ${BATH_PRICE} 買一顆</button></div>`, act => {
    if (act !== 'buy' || G.coins < BATH_PRICE || !bagFits('bathbomb')) return;
    G.coins -= BATH_PRICE; gainItem('bathbomb', 1); Sound.play('pickup');
  });
}

// ====================================================================
// 工作台（設計圖：工作台打開書就能合成）：一本合成書，每一頁一樣東西、要用什麼做
// 方塊、家具做好了拿在手上（手上有東西就放在工作台旁邊的地上）；東西直接放進背包
// ====================================================================
const RECIPES5 = [
  { id: 'cube', name: '木頭方塊 ×2', icon: '🧊', need: { wood: 2 }, desc: '1 公尺的木頭方塊（設計圖：板子變方塊）：搬得動、站得上去，排起來就是一道牆，怪物要打很久。', furn: 'cube5', n: 2 },
  { id: 'plank', name: '木頭板子', icon: '🪵', need: { wood: 3 }, desc: '2×2 公尺的木頭板子（跟砍樹掉的一樣），可以蓋牆和屋頂。', plank: { tier: 1 } },
  { id: 'door', name: '木門', icon: '🚪', need: { wood: 4 }, desc: '跟板子一樣大的木門（兩扇對開），放在牆上可以開關。', plank: { tier: 1, door: true } },
  { id: 'fire', name: '火爐', icon: '🔥', need: { wood: 5 }, desc: '放在家裡取暖（寒寂之境一定要有），丟木柴進去燒。', furn: 'fireplace4' },
  { id: 'bed', name: '床', icon: '🛏️', need: { wood: 6 }, desc: '躺在家裡的床上會暖起來，白天還可以睡到傍晚。', furn: 'bed4', w: 2, h: 2 },
  { id: 'chair', name: '椅子', icon: '🪑', need: { wood: 2 }, desc: '可以坐。家裡的家具越多越溫馨。', furn: 'chair4' },
  { id: 'rod', name: '釣竿', icon: '🎣', need: { wood: 2 }, desc: '帶在身上就有效：釣魚快一倍。', item: 'rod5' },
  { id: 'fishc', name: '烤魚', icon: '🍢', need: { fish5: 1, wood: 1 }, desc: '把生魚烤熟：飽食 +48、理智 +10，還會暖身子。', item: 'fishc5' },
  { id: 'lamp', name: '檯燈', icon: '💡', need: { battery: 2, wood: 1 }, desc: '一盞第 3 級的檯燈（選它按 Q 放在前面）。', item: 'bulb3' },
  { id: 'candle', name: '蠟燭', icon: '🕯️', need: { wood: 1, apple5: 1 }, desc: '用樹脂和蘋果蠟做的蠟燭，拿在手上可以取暖。', item: 'candle' },
];
const canCraft5 = r => Object.entries(r.need).every(([id, n]) => (G.inv[id] || 0) >= n);
function openBook5() {
  Sound.play('page');
  openModal('📖 工作台的合成書', () => {
    const cards = RECIPES5.map(r => {
      const need = Object.entries(r.need).map(([id, n]) => `${ITEMS[id].icon || ''}${itemName(id)} ×${n}<span class="hint">（有 ${G.inv[id] || 0}）</span>`).join('、');
      return `<div class="shopcard${canCraft5(r) ? '' : ' dim'}"><div class="ic">${r.icon}</div><div class="nm">${r.name}</div><div class="ds">${r.desc}</div><div class="ds">要用：${need}</div><button data-act="${r.id}" ${canCraft5(r) ? '' : 'disabled'}>合成</button></div>`;
    }).join('');
    return `<p class="hint">打開工作台上的書：每一頁是一樣東西和它的材料。木柴是砍樹掉的（看著樹按住 E 砍 3 下）。做好的方塊和家具拿在手上，對著地上按 E 放下。</p><div class="shop">${cards}</div>`;
  }, act => {
    const r = RECIPES5.find(q => q.id === act);
    if (!r || !canCraft5(r)) return;
    if (r.item && !bagFits(r.item)) { toast('🎒 背包滿了，做好也放不下。', 'warn'); return; }
    for (const [id, n] of Object.entries(r.need)) { G.inv[id] -= n; if (G.inv[id] <= 0) delete G.inv[id]; }
    if (G.selId && !G.inv[G.selId]) G.selId = invList()[0] || null;
    invDirty = true;
    Sound.play('craft');
    const bench = FURN_BY_ID.bench5 || { x: G.p.x, y: G.p.y, w: 1, h: 1 };
    if (r.item) gainItem(r.item, 1);
    else if (r.plank) {
      if (!G.hand) holdThing({ k: 'plank', ...r.plank, hp: PLANKS[1].hp });
      else { dropLoose4(bench.x + 1, bench.y + 1.6, { k: 'plank', ...r.plank }); const l = G.loose4[G.loose4.length - 1]; net4('loose', { l: { x: l.x, y: l.y, a: l.a, tier: l.tier, door: l.door, uid: uidOf4(l) } }); }
    }
    else for (let i = 0; i < (r.n || 1); i++) makeFurn5(r.furn, r.w || 1, r.h || 1, bench);
    toast(`🔨 做好了${r.name}！`, 'good');
  }, '闔上書本');
}
// 做好的家具（自己做的方塊、火爐、床、椅子）：手上空著就拿在手上，不然放在工作台旁邊的地上
function makeFurn5(type, w, h, near) {
  G.mk5 = (G.mk5 || 0) + 1;
  const f = { id: 'mk5_' + rid4(), type, name: FURN4[type].name, x: 0, y: 0, w, h, side: 's', move: true, dyn: type, held: true, w0: w, h0: h, side0: 's' };   // w0、h0、side0：拿在手上轉方向的基準（跟 liftFurn4 一樣）
  if (FURN4[type].solid === false) f.solid = false;
  FURN.push(f); FURN_BY_ID[f.id] = f;
  const tell = () => net4('mk5', { f: { id: f.id, type, w, h, x: f.x, y: f.y, held: f.held ? 1 : 0 } });   // 跟朋友一起玩：朋友那邊也有這件家具（之後搬、放照 id 同步）
  if (!G.hand) { holdThing({ k: 'furn', f }); tell(); return f; }
  for (let i = 0; i < 80; i++) {
    const rr = 1.4 + Math.sqrt(i) * 0.6, a = i * 2.4, x = Math.floor(near.x + near.w / 2 + Math.cos(a) * rr), y = Math.floor(near.y + near.h / 2 + Math.sin(a) * rr);
    let ok = true;
    for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) if (!inMap(xx, yy) || tiles[yy][xx] !== 1 || furnGrid[yy][xx] || Math.hypot(xx + 0.5 - G.p.x, yy + 0.5 - G.p.y) < 0.8) { ok = false; break; }
    if (!ok) continue;
    f.x = x; f.y = y; addFurn4(f); tell();
    return f;
  }
  f.x = Math.floor(G.p.x); f.y = Math.floor(G.p.y);   // 真的沒地方放：拿在手上（換掉手上的東西）
  G.hand = { k: 'furn', f }; invDirty = true; tell();
  return f;
}

// ====================================================================
// 看著的東西（getTarget 的 addTargets4 會呼叫）：樹（砍）、水（釣魚）、工作台、沐浴球機
// ====================================================================
function addTargets5(cands) {
  const p = G.p;
  for (const f of FURN) {
    if (f.held || f.cut) continue;
    const rd = rectDist(p.x, p.y, f);
    if (rd > 1.35) continue;
    const a = Math.min(lookAngle(clamp(p.x, f.x, f.x + f.w), clamp(p.y, f.y, f.y + f.h)), lookAngle(f.x + f.w / 2, f.y + f.h / 2));
    if (a > 1.0 && rd > 0.35) continue;
    const d = rd + a * 0.9;
    if (f.type === 'tree5') cands.push({ d: d + 0.25, id: 'tree:' + f.id, label: '砍樹', sub: `按住 E 砍（再 ${TREE_CHOPS - (f.chops || 0)} 下就倒）`, hold: 0.8, action: () => chop5(f) });
    else if (f.type === 'bench5') cands.push({ d, id: 'bench5', label: '打開工作台的合成書', hold: 0, action: openBook5 });
    else if (f.type === 'bath5') cands.push({ d, id: 'bath5', label: `沐浴球機（${BATH_PRICE} 🪙 一顆）`, hold: 0, action: openBath5 });
  }
  const w = waterNear5(1.8);
  if (w && !airborne(p)) cands.push({ d: w.d + 0.6, id: 'fish5', label: '釣魚', sub: G.inv.rod5 ? '按住 E（有釣竿，很快）' : '按住 E（在工作台做釣竿會快一倍）', hold: G.inv.rod5 ? 1.4 : 2.8, action: fish5 });
}

// ====================================================================
// 天氣：照 data.js 的 W5_WEATHER，每天早上決定（下雨、雷暴雨、霧可以跟別的天氣一起）
// 下雨不會怎樣（設計師：不會怎樣），只有雨聲；雷暴雨會打雷（閃電打在你旁邊會扣很多血，打到樹會把樹劈倒）
// ====================================================================
function makeWeather5() {
  const acid = [];
  for (let d = 1; d <= LAST_NIGHT; d++) if (wx5(d, 'acid')) { const night = d === 10; acid.push({ day: d, night, at: Math.round(rand(50, (night ? NIGHT_SECS[5] : DAY_SECS[5]) - 120)), dur: randi(60, 90) }); }
  return { acid };
}
const wxOn5 = k => !!G && (wx5(G.day, k) || !!(G.force5 && G.force5.includes(k)));   // 今天有沒有這種天氣（測試用的 &storm 也算）
const rain5 = () => (wxOn5('storm') ? 1 : wxOn5('rain') ? (G.cold ? 0.45 : 0.65) : 0);
const fog5 = () => (wxOn5('fog') ? 1 : 0);
function startDay5(d) {
  if (!isGuest4()) { regrow5(); stock5(d === 1); }   // 跟朋友一起玩的客人：樹和樹上的東西照房主的（day4）
  const w = W5_WEATHER[d] || [];
  G.ev.boltT = rand(4, 9);
  const say = [];
  if (w.includes('storm')) say.push('⛈️ 今天是雷暴雨！會打雷，閃電可能打在你旁邊（躲到屋頂底下）。');
  else if (w.includes('rain')) say.push('🌧️ 今天下雨（不會怎樣，只是濕濕的）。');
  if (w.includes('fog')) say.push('🌫️ 今天起大霧，白茫茫的，什麼都看不清楚……');
  if (say.length) toast(say.join(''), w.includes('storm') ? 'warn' : '');
}
function updateWeather5(dt) {
  const p = G.p, r = rain5(), roof = sheltered4(p.x, p.y);
  Sound.setRain(mode === 'play' || mode === 'modal' ? r * (roof ? 0.55 : 1) : 0);
  G.flash5 = Math.max(0, (G.flash5 || 0) - dt * 2.5);
  if (mode !== 'play' || !wxOn5('storm') || isGuest4()) return;   // 跟朋友一起玩：閃電由房主決定，送給大家（bolt5）
  // 雷暴雨：每 6～14 秒打一次雷；閃電打在某一個人（你或朋友）附近 30 公尺內的某個地方
  G.ev.boltT = (G.ev.boltT ?? 5) - dt;
  if (G.ev.boltT > 0) return;
  G.ev.boltT = rand(6, 14);
  const who = pick([{ x: p.x, y: p.y, roof }, ...(net4On() ? Net.friends().filter(f => f.ingame && f.world === 5).map(f => ({ x: f.x, y: f.y, roof: sheltered4(f.x, f.y) })) : [])]);
  const near = Math.random() < 0.18 && !who.roof, a = Math.random() * Math.PI * 2, rr = near ? rand(0.5, 2) : rand(6, 30);
  const bx = clamp(who.x + Math.cos(a) * rr, 1, MAP_W - 1), by = clamp(who.y + Math.sin(a) * rr, 1, MAP_H - 1);
  strike5(bx, by);
  net4('bolt5', { x: bx, y: by });
  // 打到樹：樹被劈倒（房主劈倒、送 fell5 給大家）
  const tree = treesUp5().find(f => Math.hypot(f.x + 0.5 - bx, f.y + 0.5 - by) < 1.6);
  if (tree) { fellTree5(tree, false); toast('⚡ 閃電劈倒了一棵樹！', 'warn'); }
}
// 一道閃電打在 (bx, by)：閃一下、打雷、打在自己旁邊就扣血（自己的、房主送來的都用這個）
function strike5(bx, by) {
  const p = G.p, roof = sheltered4(p.x, p.y), d = Math.hypot(bx - p.x, by - p.y);
  G.flash5 = 1; G.bolt5 = { x: bx, y: by, t: 0.35 };
  Sound.play(d < 14 ? 'thunder' : 'farThunder', d < 14 ? 1 : 0.7);
  G.shake = Math.max(G.shake, d < 10 ? 0.5 : 0.15);
  puff(bx, by, [240, 240, 255], 10, 0.4);
  if (mode !== 'play') return;
  if (d < 2.5 && !roof && p.inv <= 0) {
    damage(26, 12); p.inv = 1; p.stunT = 0.5;
    toast('⚡ 閃電打在你旁邊！雷暴雨的時候要躲到屋頂底下。', 'warn');
    if (p.hp <= 0) gameOver('bolt');
  } else if (!G.ev.stormTip) { G.ev.stormTip = 1; toast('⛈️ 打雷了！閃電會打在草原上，躲到屋頂（躺平的板子）底下比較安全。', 'warn'); }
}
// 每一幀（world4.js 的 update4 會呼叫）
function update5(dt) {
  updateWeather5(dt);
  updateBath5(dt);
  if (G.bolt5 && (G.bolt5.t -= dt) <= 0) G.bolt5 = null;
  updateMotes5(dt);
  if (mode === 'play' && G.phase === 'day') {
    if (G.day === 1) dayTips5();
    if (!G.ev.duskWarn5 && G.t >= DAY_LEN - DUSK) { G.ev.duskWarn5 = 1; Sound.play('dusk'); toast('🌆 天快黑了……白霧裡傳來奇怪的聲音。快回家！', 'warn'); }
  }
}
function dayTips5() {
  const ev = G.ev, t = G.t;
  if (t > 3 && !ev.w5tip1) { ev.w5tip1 = 1; toast('🌫️ 這裡是世界夾層：沒有天花板的草原，四周是白白的霧。白天 6 分鐘、晚上 5 分鐘。白天砍樹、找吃的、蓋房子；晚上夢裡的東西會出來。'); }
  if (t > 15 && !ev.w5tip2) { ev.w5tip2 = 1; toast('🪓 看著樹按住 E 砍 3 下，樹會倒：掉木頭板子（蓋牆）和木柴。起點旁邊的地上也有 4 片板子。'); }
  if (t > 30 && !ev.w5tip3) { ev.w5tip3 = 1; toast('🍎 食物、飲料、餅乾、電池、檯燈都長在樹上和花上：看著它按 E 摘下來。每天早上會再長。'); }
  if (t > 48 && !ev.w5tip4) { ev.w5tip4 = 1; toast('📖 起點旁邊有工作台：打開書就能合成，木柴可以做成 1 公尺的方塊、火爐、床、釣竿，還能烤魚。'); }
  if (t > 66 && !ev.w5tip5) { ev.w5tip5 = 1; toast('🎣 走到池塘或河邊看著水，按住 E 就能釣魚。🫧 沐浴球機（扭蛋機不見了）買沐浴球，丟進水裡會洗出東西。'); }
}

// ====================================================================
// 第五世界的 7 隻新怪物（照設計圖，寫實風；模型在 render3d.js 的「第五世界」那一段）
// 白日夢（鬼將）、404視線（鬼王）、夢境切片（鬼王）、綠溫室（判官）、搖籃囈語（判官）、複製人（羅剎）、記憶洩漏源（酆都，大魔王）
// ====================================================================
const GRADE5 = { daydream: 'general', gaze: 'king', slice: 'king', green: 'judge', cradle: 'judge', clone: 'rakshasa', leak: 'fengdu' };
const INTRO5 = { daydream: 1, gaze: 2, slice: 3, green: 5, cradle: 6, clone: 8, leak: 10 };
// 暫時關掉 7 隻新怪物（2026/11/02：平板上很卡，先關掉試玩，看是不是牠們的模型太精細）：晚上不排牠們、天黑前也不先蓋模型，
// 黑影、黑球、血淚女、小丑照常來；圖鑑還看得到。網址加 &mon5 可以打開（自動試玩測試用）。確定之後把這行拿掉
const MON5_ON = /[?&]mon5\b/.test(location.search);
function monsterDmgMult5(t, src) {
  switch (t.kind) {
    case 'gaze': return t.seen ? 1.5 : 1;                         // 你看著牠的時候牠卡住了：打牠比較痛
    case 'slice': return t.shut > 0 ? 0.2 : 1;                     // 殼闔起來的時候很硬
    case 'leak': return src === 'flash' ? 0.6 : 1;
    case 'daydream': return src === 'flash' ? 1.4 : 0.5;           // 雲一樣的肉：敲不太到，手電筒照比較有效
    default: return 1;
  }
}
// 怪物登場：每一種的提示（第一次和之後）、聲音、生在哪裡
function spawnW5Monster(kind) {
  const ev = G.ev;
  if (!MON5_ON) return;
  if (kind !== 'slice' && G.enemies.some(e => e.kind === kind)) return;
  if (bossFull()) return;
  const at = kind === 'slice' ? shoreSpot5() : kind === 'leak' ? findSpawn(22) : null;
  const e = spawnEnemy(kind, at);
  if (!e) return;
  const tips = {
    daydream: ['☁️ 天上飄來一大團軟軟的、像雲一樣的肉……白日夢。站在牠底下會被滴到，理智一直掉。用手電筒照牠！', '☁️ 白日夢又飄過來了……'],
    gaze: ['📺 404視線出現了。你看著牠的時候牠會卡住不動；一轉頭，牠就「跳格」衝過來。別讓牠離開你的視線！', '📺 草原上又出現了一個黑黑的、咧著嘴笑的影子……'],
    slice: ['🐚 池塘邊有一個巨大的貝殼……殼裡擠出一張咧嘴笑的嬰兒臉。夢境切片會慢慢爬過來，靠近就夾你！手電筒照牠會把殼闔起來。', '🐚 水邊又多了一個大貝殼……'],
    green: ['🫛 遠處傳來好幾個人一起哼的搖籃曲……綠溫室會把你吸過去。不要靠近，躲回家裡就聽不到了。', '🫛 搖籃曲又響起來了……'],
    cradle: ['👶 一顆長著蛾翅膀的大嬰兒頭飛過來了，翅膀上的眼睛流著血……搖籃囈語會在你頭上繞圈，再俯衝下來。手電筒照牠就會退開。', '👶 搖籃囈語又飛來了……'],
    clone: ['👥 地面在震動……一大團粉紫色的肉爬過來，上面是六顆一模一樣的頭。複製人很慢，但牆擋不住牠。', '👥 複製人又爬過來了……'],
    leak: ['🧠 遠處的霧裡浮出一顆像山一樣大的頭……記憶洩漏源。牠會放出一點一點發光的「記憶」追著你，用手電筒把它照散！', '🧠 記憶洩漏源又出現了……'],
  }[kind];
  if (tips) { toast(ev['tip_' + kind] ? tips[1] : tips[0], 'warn'); ev['tip_' + kind] = 1; }
  Sound.play({ daydream: 'whisper', gaze: 'tick', slice: 'giggle', green: 'hum', cradle: 'giggle', clone: 'tall', leak: 'tall' }[kind] || 'whisper', 0.7);
}
// 夢境切片住在水邊：池塘或河岸上一格空地（離你遠一點）
function shoreSpot5() {
  const list = [...W5MAP.water];
  for (let i = 0; i < 60; i++) {
    const [x, y] = pick(list).split(',').map(Number), a = pick([[1, 0], [-1, 0], [0, 1], [0, -1]]), tx = x + a[0] * 2, ty = y + a[1] * 2;
    if (!walkable(tx + 0.5, ty + 0.5) || Math.hypot(tx + 0.5 - G.p.x, ty + 0.5 - G.p.y) < 12 || nearHome4(tx, ty, 7)) continue;
    return { x: tx + 0.5, y: ty + 0.5 };
  }
  return null;
}
function scheduleNight5(add, again, night, n, hz) {
  const blood = G.ev.blood, P = { daydream: 0.4, gaze: 0.65, slice: 0.5, green: 0.35, cradle: 0.4, clone: 0.28 };
  if (MON5_ON) {
    for (const [k, p] of Object.entries(P)) {
      if (night === INTRO5[k]) add(k, 25, 55);
      else if (night > INTRO5[k] && (blood || again(p))) add(k, 30, NIGHT_LEN - 80);
    }
    if (night >= 4 && again(0.4)) add('slice', 60, NIGHT_LEN - 60);   // 水邊的貝殼可以有兩個
    if (night === INTRO5.leak || night === LAST_NIGHT) add('leak', 40, 70);
    else if (night > INTRO5.leak && again(0.3)) add('leak', 60, NIGHT_LEN - 90);
  }
  // 舊怪物：黑球（只吃據點的燈）、血淚女、小丑
  if (night >= 2 && again(0.35)) add('blob', 30, NIGHT_LEN - 60);
  if (night >= 3 && again(0.25)) add('woman', 30, NIGHT_LEN - 60);
  if (night >= 4 && again(0.2)) add('clown', 30, NIGHT_LEN - 60);
}
// 晚上一直會來的：黑影（第一世界的），越後面越多；紅月多一隻
function updateSpawns5(dt) {
  if (G.phase !== 'night') return;
  const night = G.day, dk = G.diff === 'easy' ? -1 : G.diff === 'hard' ? 1 : 0;
  const max = Math.round(clamp(2 + Math.floor((night - 1) / 3) + dk + (G.ev.blood ? 1 : 0), 1, 6) * NetMon.crowd());
  G.spawnT -= dt;
  if (G.spawnT > 0) return;
  G.spawnT = rand(18, 30) / D().spawn;
  if (G.enemies.filter(e => e.kind === 'shadow').length >= max) return;
  spawnEnemy('shadow');
}
function startNight5() {
  Sound.play('dusk');
  toast('🌙 天黑了。白霧變成了灰色……夢裡的東西醒過來了。', 'warn');
}
const dist5 = e => Math.hypot(e.x - G.p.x, e.y - G.p.y);
const losTo5 = e => { const d = dist5(e); return castRay(e.x, e.y, Math.atan2(G.p.y - e.y, G.p.x - e.x), d) >= d - 0.05; };
// 直接飄過去（不管牆，飛在天上的、雲一樣的）
function drift5(e, tx, ty, sp, dt) {
  const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy) || 1, s = Math.min(d, sp * dt);
  e.x = clamp(e.x + dx / d * s, 1.5, MAP_W - 1.5); e.y = clamp(e.y + dy / d * s, 1.5, MAP_H - 1.5);
  e.face = Math.atan2(dy, dx);
}
// ---------- 白日夢：慢慢飄過來，停在你頭上；底下一直滴黏液：站在底下理智掉、被滴到扣血 ----------
function updateDaydream5(e, dt) {
  const p = G.p, d = dist5(e);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  drift5(e, p.x + Math.cos(e.wob * 0.2) * 2, p.y + Math.sin(e.wob * 0.2) * 2, d > 12 ? 1.2 : 0.55, dt);
  if (d < 8 && e.spawn <= 0) {
    p.san -= 1.6 * D().san * dt;
    if (d < 4.5 && !sheltered4(p.x, p.y)) {
      p.hp -= 2.5 * D().dmg * dt; p.hurt = Math.max(p.hurt, 0.2);
      if (!G.ev.dripTip) { G.ev.dripTip = 1; toast('☁️ 白日夢滴下來的黏液滴在你身上，好燙！躲到屋頂底下、或離開牠底下。', 'warn'); }
    }
  }
}
// ---------- 404視線：你看著牠就卡住（理智掉）；沒看著就很快衝過來，還會「跳格」往前閃 ----------
function updateGaze5(e, dt) {
  const p = G.p, n = diffN(), d = dist5(e);
  e.cd = Math.max(0, (e.cd || 0) - dt);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  e.seen = e.spawn <= 0 && d < 24 && lookAngle(e.x, e.y) < 0.5 && losTo5(e);
  if (e.seen) {
    p.san -= 2.4 * D().san * dt;
    if (!G.ev.gazeTip) { G.ev.gazeTip = 1; toast('📺 你一看著 404視線，牠就像畫面卡住一樣不動了……但理智一直在掉。一轉頭牠就會衝過來！', 'warn'); }
    return;
  }
  e.blinkT = (e.blinkT ?? 3) - dt;
  if (e.blinkT <= 0 && d > 4 && d < 30) {
    e.blinkT = rand(2.5, 4.5);
    const dir = chaseDir(e);
    move(e, dir.x * 2.6, dir.y * 2.6, ENEMY_R);
    Sound.play('tick', nearVol(d)); puff(e.x, e.y, [20, 18, 18], 6, 2);
  }
  const dir = chaseDir(e), sp = Math.min(3.2 + n * 0.02, 4.2) * (e.spawn > 0 ? 0.3 : 1);
  const ox = e.x, oy = e.y;
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  if (Math.hypot(e.x - ox, e.y - oy) > 0.001) e.face = Math.atan2(e.y - oy, e.x - ox);
  if (d < 1.1 && e.spawn <= 0 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) {
    damage(22 + n * 0.2, 16); p.inv = 1.3; Sound.play('static'); G.shake = Math.max(G.shake, 0.4);
    toast('📺 404視線抓住了你！畫面一陣雜訊……牠又不見了。', 'warn');
    const pos = findSpawn(12); if (pos) { e.x = pos.x; e.y = pos.y; e.spawn = 1.2; }
  }
}
// ---------- 夢境切片：住在水邊的大貝殼，慢慢爬過來；靠近就把殼一夾（咬）；手電筒照著殼會闔起來（很硬） ----------
function updateSlice5(e, dt) {
  const p = G.p, n = diffN(), d = dist5(e);
  e.cd = Math.max(0, (e.cd || 0) - dt); e.shut = Math.max(0, (e.shut || 0) - dt); e.snap = Math.max(0, (e.snap || 0) - dt);
  if (inBeam(e)) { e.shut = Math.max(e.shut, 0.6); flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  if (e.bite > 0) {
    e.bite -= dt;
    if (e.bite <= 0) {
      e.snap = 0.6; e.cd = 3; Sound.play('clang', nearVol(d)); G.shake = Math.max(G.shake, d < 4 ? 0.35 : 0.1);
      if (d < 3.4 && p.inv <= 0 && !wallBetweenPts4(e.x, e.y, p.x, p.y)) { damage(28 + n * 0.2, 12); p.inv = 1.2; toast('🐚 夢境切片的殼「啪」地夾了下來！', 'warn'); }
    }
    return;
  }
  if (e.shut > 0) return;
  if (d < 3.0 && e.cd <= 0 && e.spawn <= 0) { e.bite = 0.45; Sound.play('giggle', nearVol(d)); if (!G.ev.sliceTip) { G.ev.sliceTip = 1; toast('🐚 嬰兒臉咯咯地笑了……殼要夾下來了，快退開！', 'warn'); } return; }
  if (d < 16) walkTo4(e, p.x, p.y, 0.75 * (0.4 + Math.abs(Math.sin(e.wob * 2.2))), dt, flow);
}
// ---------- 綠溫室：站在原地哼搖籃曲，10 公尺內會把你慢慢吸過去、理智掉；被吸到旁邊就被包進豆莢裡（扣很多血）。在家裡聽不到 ----------
function updateGreen5(e, dt) {
  const p = G.p, n = diffN(), d = dist5(e);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose || e.spawn > 0) return;
  e.humT = (e.humT ?? 0) - dt;
  if (e.humT <= 0 && d < 30) { e.humT = rand(5, 8); Sound.play('hum', nearVol(d) * 0.9); }
  if (d > 10.5 || atHome4()) return;
  const k = 1 - d / 10.5;
  p.san -= (1 + 2 * k) * D().san * dt;
  move(p, (e.x - p.x) / d * (0.35 + 0.6 * k) * dt, (e.y - p.y) / d * (0.35 + 0.6 * k) * dt, PLAYER_R);
  if (!G.ev.greenTip) { G.ev.greenTip = 1; toast('🫛 搖籃曲好好聽……你的腳不聽使喚地往那個豆莢走過去！往反方向跑、或躲回家裡。', 'warn'); }
  if (d < 1.7 && p.inv <= 0) {
    damage(30 + n * 0.2, 20); p.inv = 1.6; Sound.play('slurp'); G.shake = Math.max(G.shake, 0.4);
    const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 3, Math.sin(a) * 3, PLAYER_R);
    toast('🫛 豆莢把你包了進去，又吐了出來……你差一點變成第五張睡著的臉。', 'warn');
  }
}
// ---------- 搖籃囈語：飛在空中（牆擋不住），在你頭上繞圈，每 6 秒俯衝下來撞你；翅膀上的眼睛盯著你，理智掉；手電筒照牠就退開 ----------
function updateCradle5(e, dt) {
  const p = G.p, n = diffN(), d = dist5(e);
  e.cd = Math.max(0, (e.cd ?? 3) - dt); e.dive = Math.max(0, (e.dive || 0) - dt); e.back = Math.max(0, (e.back || 0) - dt);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; if (!e.back) { e.back = 1.2; e.dive = 0; } }
  if (e.pose || e.spawn > 0) return;
  if (d < 12 && losTo5(e)) p.san -= 0.9 * D().san * dt;
  if (e.back > 0) { const a = Math.atan2(e.y - p.y, e.x - p.x); drift5(e, e.x + Math.cos(a) * 3, e.y + Math.sin(a) * 3, 4, dt); return; }
  if (e.dive > 0) {
    drift5(e, p.x, p.y, 6.5 + n * 0.03, dt);
    if (d < 1.6 && p.inv <= 0) { damage(20 + n * 0.2, 14); p.inv = 1.2; e.dive = 0; e.back = 1.5; Sound.play('scream', 0.5); toast('👶 搖籃囈語俯衝下來撞到你！', 'warn'); }
    return;
  }
  const orb = e.wob * 0.5, R = 6.5;
  drift5(e, p.x + Math.cos(orb) * R, p.y + Math.sin(orb) * R, d > 12 ? 4 : 2.6, dt);
  if (e.cd <= 0 && d < 11) { e.cd = rand(5, 7); e.dive = 1.6; Sound.play('giggle', nearVol(d)); if (!G.ev.cradleTip) { G.ev.cradleTip = 1; toast('👶 嬰兒頭咯咯地笑……要俯衝下來了！往旁邊閃，或用手電筒照牠。', 'warn'); } }
}
// ---------- 複製人：很大、很慢，一路爬過來，牆一下就被壓壞；被牠碰到扣很多血、被推開 ----------
function updateClone5(e, dt) {
  const p = G.p, n = diffN(), d = dist5(e);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose) return;
  e.moanT = (e.moanT ?? 2) - dt;
  if (e.moanT <= 0 && d < 30) { e.moanT = rand(6, 10); Sound.play('tall', nearVol(d) * 0.8); }
  const dir = chaseDir(e), sp = Math.min(0.9 + n * 0.006, 1.25) * (e.spawn > 0 ? 0.3 : 1);
  move(e, dir.x * sp * dt, dir.y * sp * dt, ENEMY_R);
  if (d < 2.8 && e.spawn <= 0 && p.inv <= 0) {
    damage(30 + n * 0.2, 14); p.inv = 1.4; G.shake = Math.max(G.shake, 0.5); Sound.play('thump');
    const a = Math.atan2(p.y - e.y, p.x - e.x); move(p, Math.cos(a) * 2.5, Math.sin(a) * 2.5, PLAYER_R);
    toast('👥 複製人壓過來，六顆頭一起轉過來看著你……', 'warn');
  }
}
// ---------- 記憶洩漏源（大魔王）：在遠處不會動，每 5 秒從裂開的洞放出發光的「記憶」追著你；被碰到扣血、理智掉，手電筒照得散 ----------
function updateLeak5(e, dt) {
  const p = G.p, d = dist5(e);
  if (inBeam(e)) { flashHurt(e, dt); if (e.dead) return; }
  if (e.pose || e.spawn > 0) return;
  e.cd = (e.cd ?? 3) - dt;
  if (e.cd <= 0 && d < 45) {
    e.cd = rand(4, 6);
    const n = 2 + (G.ev.blood ? 1 : 0);
    spawnMotes5(e.x, e.y, n);
    net4('motes5', { x: e.x, y: e.y, n });   // 跟朋友一起玩：每個人那邊都放出光點，追自己
    Sound.play('whisper', nearVol(d / 3));
    if (!G.ev.moteTip) { G.ev.moteTip = 1; toast('🧠 一點一點發光的「記憶」從那顆大頭裡飄出來，朝你飛過來了！用手電筒照散它們。', 'warn'); }
  }
}
function spawnMotes5(x, y, n) {
  G.motes5 = G.motes5 || [];
  for (let i = 0; i < n; i++) G.motes5.push({ x: x + rand(-3, 3), y: y + rand(-3, 3), h: rand(4, 9), life: 14, sp: rand(2.4, 3.2) });
}
function updateMotes5(dt) {
  if (!G.motes5 || !G.motes5.length) return;
  const p = G.p;
  for (const m of G.motes5) {
    m.life -= dt;
    const dx = p.x - m.x, dy = p.y - m.y, dh = 1.4 - m.h, d = Math.hypot(dx, dy, dh) || 1;
    m.x += dx / d * m.sp * dt; m.y += dy / d * m.sp * dt; m.h += dh / d * m.sp * dt;
    G.fx.push({ type: 'spark', x: m.x, y: m.y, h: m.h, vx: 0, vy: 0, vh: 0, life: 0.12, max: 0.12, color: [255, 236, 190] });
    if (flashOn() && inMyBeam(m)) { m.life = 0; puff(m.x, m.y, [255, 240, 210], 6, m.h); continue; }
    if (d < 0.7 && mode === 'play') {
      m.life = 0;
      if (p.inv <= 0) { damage(12, 10, false); p.inv = 0.5; toast('🧠 一段不是你的記憶鑽進了腦袋……頭好痛。', 'warn'); }
    }
  }
  G.motes5 = G.motes5.filter(m => m.life > 0);
}

// ====================================================================
// 跟朋友一起玩（world4.js 的 net4Apply 收到第五世界的變動時呼叫，這時 net4Mute 是 true，不會再送出去）：
// 砍樹（chop5）、樹倒了（fell5：掉的板子和木柴照 uid）、工作台做的家具（mk5）、沐浴球冒泡（bath5，洗出來的東西用 drop）、
// 釣魚的水花（fx5）、閃電（bolt5，房主決定）、記憶的光點（motes5）。砍倒的樹每天早上和剛加入時照房主的清單（applyCut5）
// ====================================================================
function net5Apply(d) {
  const near = (x, y) => nearVol(Math.hypot(x - G.p.x, y - G.p.y));
  switch (d.a) {
    case 'chop5': {
      const f = FURN_BY_ID[d.id];
      if (!f || f.cut) break;
      f.chops = Math.max(f.chops || 0, d.chops || 0);
      Sound.play('chop', near(f.x, f.y)); puff(f.x + 0.5, f.y + 0.5, [150, 110, 70], 6, 1.1);
      break;
    }
    case 'fell5': {
      const f = FURN_BY_ID[d.id];
      if (!f || f.type !== 'tree5' || f.cut) break;
      setCut5(f, G.day); b4Changed(); dropFruit5(f);
      for (const l of d.loose || []) if (!G.loose4.some(o => o.uid === l.uid)) G.loose4.push({ ...l, k: 'plank' });
      if (d.wood && !G.pickups.some(p => p.uid === d.wood.uid)) G.pickups.push({ ...d.wood, t: 0, keep: 1 });
      Sound.play('treeFall', near(f.x, f.y));
      break;
    }
    case 'mk5': {
      const o = d.f;
      if (!o || FURN_BY_ID[o.id] || !FURN4[o.type]) break;
      const f = { id: o.id, type: o.type, name: FURN4[o.type].name, x: o.x, y: o.y, w: o.w || 1, h: o.h || 1, side: 's', move: true, dyn: o.type, held: true, w0: o.w || 1, h0: o.h || 1, side0: 's' };
      if (FURN4[o.type].solid === false) f.solid = false;
      FURN.push(f); FURN_BY_ID[f.id] = f;
      if (!o.held && inMap(f.x, f.y)) addFurn4(f);
      break;
    }
    case 'bath5': (G.bath5 = G.bath5 || []).push({ x: d.x, y: d.y, t: 2, remote: true }); Sound.play('fizz', near(d.x, d.y)); break;
    case 'fx5': splash5(d.x, d.y); Sound.play('fish', near(d.x, d.y) * 0.6); break;
    case 'bolt5': if (Number.isFinite(d.x) && Number.isFinite(d.y)) strike5(d.x, d.y); break;
    case 'motes5': if (Number.isFinite(d.x)) spawnMotes5(d.x, d.y, clamp(d.n || 2, 1, 4)); break;
  }
}

// ====================================================================
// 破關：第 12 夜天亮了，白霧散開，草原上的花一朵一朵開了
// ====================================================================
function endVictory5() {
  $('goTitle').textContent = '🌫️ 你在世界夾層撐過了 12 夜';
  $('goText').innerHTML = `天亮了，草原上的白霧慢慢散開，花一朵一朵開了。<br>夢裡的東西都睡著了……你也終於可以醒過來了。<br>你在第五世界撐過了 ${LAST_NIGHT} 夜！搜索了 ${G.stats.searched} 次，打倒了 ${G.stats.dissolved} 個怪物。<br>最好的燈泡：${bulbName(G.stats.bestTier)}`;
}

// ====================================================================
// 存檔：砍倒的樹、自己做的家具編號（地圖每一局都一樣，只存改變的地方）
// ====================================================================
function save5() {
  return { cut: FURN.filter(f => f.type === 'tree5' && f.cut).map(f => [f.id, f.cut, f.chops || 0]), mk: G.mk5 || 0, mv: W5_MAP_VER };
}
function load5(s) {
  if (!s) return;
  G.mk5 = s.mk || 0;
  for (const [id, day] of s.cut || []) {
    const f = FURN_BY_ID[id];
    if (!f || f.type !== 'tree5') continue;
    f.cut = day;
    if (furnGrid[f.y][f.x] === f) { furnGrid[f.y][f.x] = null; solid[f.y][f.x] = tiles[f.y][f.x] === 0; }
  }
  b4Changed();
}
// 小地圖：水是藍色的、樹是綠色的點
function drawMinimap5(c) {
  c.fillStyle = 'rgba(80,150,210,.85)';
  for (const k of W5MAP.water) { const [x, y] = k.split(',').map(Number); c.fillRect(x, y, 1, 1); }
  c.fillStyle = 'rgba(60,140,70,.9)';
  for (const f of FURN) if (f.type === 'tree5' && !f.cut) c.fillRect(f.x + 0.2, f.y + 0.2, 0.6, 0.6);
  c.fillStyle = 'rgba(220,200,120,.9)';
  for (const b of W5MAP.bridges) c.fillRect(b.x - 1, b.y - 1, 3, 3);
}
