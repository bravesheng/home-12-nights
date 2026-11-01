#!/usr/bin/env node
// 自動試玩測試：用無頭 Chromium 開遊戲跑幾個情境，截圖並檢查有沒有錯誤
// 用法：node tools/playtest.mjs [截圖資料夾，預設 playtest-out]
// 只跑某幾個情境：PT_ONLY=w3,w3cold node tools/playtest.mjs（情境名稱是 scenario() 的第一個參數）
// 需要 Node 18 以上和 Playwright（雲端 session 已內建；自己電腦上：npm i -g playwright && npx playwright install chromium）
// 有 JS 錯誤、檔案載入失敗或檢查沒過，結束代碼就不是 0
// 注意：無頭瀏覽器沒有 GPU，3D 用軟體算，FPS 很低，只能抓錯誤，看不出平板上順不順
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'playtest-out'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 找 Playwright：先找專案裡的，找不到再找全域安裝的 ----------
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* 專案裡沒有 */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href);
  } catch {
    console.error('找不到 Playwright，請先安裝：npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}
const { chromium } = await loadPlaywright();

// ---------- 小型靜態伺服器（不用另外裝東西） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

// ---------- 共用工具 ----------
const results = [];
const ONLY = process.env.PT_ONLY ? process.env.PT_ONLY.split(',') : null;
async function scenario(name, title, ctxOpts, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  const { limit = 120000, ...opts } = ctxOpts;   // limit：這個情境最多跑多久（預設 2 分鐘）
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  const page = await ctx.newPage();
  const problems = [];
  // 同一個檔案載入失敗，瀏覽器會報好幾次（404、console、中斷），只記一次
  const failedUrls = new Set();
  const loadFail = (url, why) => {
    if (failedUrls.has(url)) return;
    failedUrls.add(url);
    problems.push(`載入失敗：${url.replace(BASE, '')}（${why}）`);
  };
  page.on('pageerror', e => problems.push('JS 錯誤：' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) problems.push('console 錯誤：' + m.text());
  });
  page.on('response', r => { if (r.status() >= 400) loadFail(r.url(), r.status()); });
  page.on('requestfailed', r => loadFail(r.url(), r.failure()?.errorText));
  const shot = label => page.screenshot({ path: path.join(OUT, `${name}-${label}.png`) });
  const check = (ok, msg) => { if (!ok) problems.push('檢查沒過：' + msg); };
  const t0 = Date.now();
  let fps = '';
  try {
    // 每個情境最多 2 分鐘（兩個分頁的 net 情境 4 分鐘），卡住就算失敗，不要整個測試停在那裡
    let timer;
    const stop = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超過 ${limit / 60000} 分鐘，卡住了`)), limit); });
    await Promise.race([fn({ page, ctx, shot, check }), stop]).finally(() => clearTimeout(timer));
    fps = await measureFps(page);
  } catch (e) {
    problems.push('執行失敗：' + e.message.split('\n')[0]);
    await shot('crash').catch(() => {});
  }
  results.push({ name, title, problems, fps, secs: ((Date.now() - t0) / 1000).toFixed(0) });
  await ctx.close();
}
function measureFps(page) {
  return page.evaluate(() => new Promise(res => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : res((n / 2).toFixed(1)); };
    requestAnimationFrame(tick);
  }));
}
// 遊戲狀態：game.js 是一般 script，頂層的 G、mode 在頁面上直接讀得到
const state = page => page.evaluate(() => ({
  mode, day: G?.day, phase: G?.phase, x: G?.p.x, y: G?.p.y, z: G?.p.z, flash: G?.p.flash,
  hud: !document.getElementById('hud').classList.contains('hidden'),
  label: document.getElementById('dayLabel').textContent,
  items: document.querySelectorAll('#hotbar > *').length,
}));
async function startFromMenu(page, world, diff, tap = false) {
  const press = sel => tap ? page.tap(sel) : page.click(sel);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  await press('#btnNew');
  await press(`#worldPick .worldbtn.w${world}`);
  await press(`#diffPick .diffbtn.${diff}`);
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
}
// 低 FPS 時遊戲時間走很慢（每幀最多 0.05 秒），直接把時間撥到天黑前一點點
const skipToDusk = page => page.evaluate(() => { G.t = DAY_LEN - 0.3; });
// 已經在天黑前幾秒（例如 ?night=2 從天黑前 3 秒開始）：直接撥到天黑前一瞬間，不用等低 FPS 慢慢走完
const skipToNight = page => page.evaluate(() => { if (G.phase === 'day') G.t = Math.max(G.t, DAY_LEN - 0.05); });
// 版面重疊：提示不能壓到大字、燈泡卡和左上角、右上角的面板，大字不能壓到下面的物品說明和物品列，
// 固定的東西（面板、小地圖、物品列、搖桿、按鈕、暫停鍵）彼此也不能疊在一起
const overlaps = page => page.evaluate(() => {
  const $ = id => document.getElementById(id);
  const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const area = (name, e) => { const r = e.getBoundingClientRect(); return { name, l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const shown = id => $(id).offsetWidth > 0 && $(id).offsetHeight > 0;
  // 提示和燈泡卡用排版位置（offset），不受進場、飛走動畫的位移和縮放影響
  const laid = (name, e, box) => ({ name, l: box.left + e.offsetLeft, t: box.top + e.offsetTop, r: box.left + e.offsetLeft + e.offsetWidth, b: box.top + e.offsetTop + e.offsetHeight });
  const tb = $('toasts').getBoundingClientRect(), cb = $('cards').getBoundingClientRect();
  const toasts = [...$('toasts').children].filter(e => e.style.opacity !== '0').map(e => laid(`提示「${e.textContent.slice(0, 8)}…」`, e, tb));
  const cards = [...$('cards').children].map(e => laid('燈泡卡', e, cb));
  const big = $('bigText').classList.contains('show') ? [area('大字', $('bigText'))] : [];
  const panels = [['狀態列', 'bars'], ['時鐘', 'clock'], ['小地圖', 'minimap']].filter(([, id]) => shown(id)).map(([n, id]) => area(n, $(id)));
  const bottom = [['物品說明', 'itemInfo'], ['物品列', 'hotbar']].filter(([, id]) => shown(id)).map(([n, id]) => area(n, $(id)));
  const touch = [['搖桿', 'stick'], ['觸控按鈕', 'tbtns'], ['暫停鍵', 'tpause']].filter(([, id]) => shown(id)).map(([n, id]) => area(n, $(id)));
  const out = [];
  for (const t of toasts) for (const o of [...panels, ...big, ...cards]) if (hit(t, o)) out.push(`${t.name}壓到${o.name}`);
  for (const g of big) for (const o of bottom) if (hit(g, o)) out.push(`大字壓到${o.name}`);
  for (const c of cards) for (const g of big) if (hit(c, g)) out.push('燈泡卡壓到大字');
  const fixed = [...panels, ...bottom, ...touch];
  for (let i = 0; i < fixed.length; i++) for (let j = i + 1; j < fixed.length; j++) if (hit(fixed[i], fixed[j])) out.push(`${fixed[i].name}壓到${fixed[j].name}`);
  return out;
});
// 手機：上面的面板和下面的物品列不能佔掉太多畫面，中間要看得到 3D 畫面
const hudCover = page => page.evaluate(() => {
  const $ = id => document.getElementById(id), H = innerHeight;
  const top = Math.max(...['clock', 'bars', 'minimap'].map(id => $(id).getBoundingClientRect().bottom));
  const bottom = $('bottom').getBoundingClientRect().top;
  return { phone: document.body.classList.contains('phone'), top: Math.round(top / H * 100), bottom: Math.round(bottom / H * 100) };
});

// ---------- 情境 ----------
await scenario('w1', '第一世界・簡單（電腦：主選單開新遊戲、走路、手電筒）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  await sleep(1000);
  await shot('1-title');
  await startFromMenu(page, 1, 'easy');
  let s = await state(page);
  check(s.hud, '開始遊戲後 HUD 要出現');
  check(s.day === 1 && s.label.includes('第 1 天'), `要從第 1 天開始（現在：${s.label}）`);
  check(s.items > 0, '道具列要有東西');
  await shot('2-start');
  const from = { x: s.x, y: s.y };
  await page.keyboard.down('w'); await sleep(2000); await page.keyboard.up('w');
  await page.keyboard.press('f');
  await sleep(500);
  s = await state(page);
  check(Math.hypot(s.x - from.x, s.y - from.y) > 0.05, '按 W 要往前走');
  check(s.flash === true, '按 F 要打開手電筒');
  // 第一世界也能跳（設計師：要可以跳躍！！！）：按空白鍵跳起來
  await page.keyboard.press('Space');
  await sleep(120);
  const jz = await page.evaluate(() => ({ z: G.p.z, vz: G.p.vz, btn: getComputedStyle(document.querySelector('#tbtns .tb.jump')).visibility }));
  check(jz.z > 0.05 || jz.vz > 0, `第一世界按空白鍵要跳起來（高度 ${jz.z.toFixed(2)}）`);
  check(jz.btn === 'visible', `第一世界平板也要有跳的按鈕（${jz.btn}）`);
  await sleep(800);
  await shot('3-walk');
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  await sleep(400);
  s = await state(page);
  check(s.label.includes('第 1 夜'), `天黑後要顯示第 1 夜（現在：${s.label}）`);
  // 黃昏和天黑的提示一起出現（4 則），最容易壓到「第 1 夜」大字
  const lay = await overlaps(page);
  check(lay.length === 0, '天黑時版面重疊：' + lay.join('、'));
  await sleep(600);
  await shot('4-night');
});

await scenario('w2', '第二世界第 6 夜＋全套裝備（?world=2&night=6&kit=1）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=2&night=6&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  let s = await state(page);
  check(s.hud, 'HUD 要出現');
  check(s.day === 6, `要是第 6 天（現在：${s.label}）`);
  check(s.items >= 20, `kit=1 要帶齊裝備（道具列只有 ${s.items} 格）`);
  await shot('1-start');
  // 跳：低 FPS 下一次跳躍只有幾幀，一直按著空白鍵、連續讀高度
  await page.keyboard.down('Space');
  const maxZ = await page.evaluate(() => new Promise(res => {
    let m = 0; const t0 = performance.now();
    const poll = () => { m = Math.max(m, G.p.z); performance.now() - t0 < 3000 ? setTimeout(poll, 20) : res(m); };
    poll();
  }));
  await page.keyboard.up('Space');
  check(maxZ > 0, '第二世界按空白鍵要能跳');
  // 溜滑梯：站在遊樂場溜滑梯西邊的爬梯前，互動是「爬上溜滑梯」；玩的時候會爬高再滑下來，結束後站在東邊（直接呼叫更新函式，不用等低 FPS）
  const sl = await page.evaluate(() => {
    const f = FURN_BY_ID.car;
    Object.assign(G.p, { x: f.x - 0.6, y: f.y + f.h / 2, face: 0, pitch: 0, z: 0, vz: 0, grabbed: null });
    const t = getTarget();
    startSlide(f);
    let maxZ = 0;
    for (let i = 0; i < 80; i++) { updatePlayer(0.05); maxZ = Math.max(maxZ, G.p.z); }
    return { label: t && t.label, maxZ, done: !ride, east: G.p.x > f.x + 4, ok: walkable(G.p.x, G.p.y) };
  });
  check(sl.label === '爬上溜滑梯' && sl.maxZ > 1.2 && sl.done && sl.east && sl.ok, `溜滑梯要能玩（互動「${sl.label}」、最高 ${sl.maxZ.toFixed(2)}、滑完 ${sl.done}、在東邊 ${sl.east}）`);
  await page.evaluate(() => { const f = FURN_BY_ID.car; Object.assign(G.p, { x: f.x - 0.6, y: f.y + f.h / 2, face: 0, pitch: 0 }); startSlide(f); });
  await sleep(1200);
  await shot('1b-slide');
  await page.waitForFunction(() => !ride, null, { timeout: 30000 }).catch(() => {});
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  await sleep(400);
  s = await state(page);
  check(s.label.includes('第 6 夜'), `天黑後要顯示第 6 夜（現在：${s.label}）`);
  const lay = await overlaps(page);
  check(lay.length === 0, '天黑時版面重疊：' + lay.join('、'));
  await sleep(1100);
  await shot('2-night');
});

await scenario('w3', '第三世界第 1 天（照片貼圖、各式各樣死去的乘客、乘客轉頭、下車到月台、天黑前車站鎖門、留在車站會被拉回車上）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=3&diff=normal', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2500);
  let s = await state(page);
  check(s.hud && s.day === 1, `要從第 1 天開始（現在：${s.label}）`);
  check(await page.evaluate(() => MAP_W === 59 && ROOMS.find(r => r.id === 'engine').name === '機車室' && ROOMS.some(r => r.roof) && ROOMS.find(r => r.id === 'platform').open && DOORS.length === 8 && !ROOMS.some(r => r.id === 'sleeper' || r.id.startsWith('berth')) && document.body.classList.contains('w3')), '第三世界要是 59 格長的列車地圖（機車室、車頂、露天的月台、8 扇門，沒有臥鋪車廂）');
  // 設計師第二次意見（2026/10/31）：車廂加寬（走道 3 格以上、7 排）、天花板加高、走道中間不放桌子、早晨禮物在火爐旁邊、神秘商人在景觀車廂車門外
  const lay3 = await page.evaluate(() => {
    const cars = ROOMS.filter(r => r.aisle), fb = FURN_BY_ID.firebox;
    // 每節車廂中間那三排（y=7～9）不能有家具擋路（地毯不算）
    const blocked = [];
    for (const r of cars) for (let x = r.x; x < r.x + r.w; x++) for (let y = 7; y <= 9; y++) if (furnGrid[y][x]) blocked.push(furnGrid[y][x].id + '@' + x + ',' + y);
    return { h: cars.map(r => r.h), blocked, ceil: CEIL_W3, roofH: ROOF_H, gift: Math.hypot(GIFT_POS.x - (fb.x + fb.w / 2), GIFT_POS.y - (fb.y + fb.h / 2)), giftOk: walkable(GIFT_POS.x, GIFT_POS.y),
      merchant: roomAt(MERCHANT_POS.x, MERCHANT_POS.y).id, mdoor: DOORS.some(d => d.station && Math.abs(d.x + 0.5 - MERCHANT_POS.x) < 0.6) };
  });
  check(lay3.h.every(h => h >= 7) && lay3.blocked.length === 0, `車廂要 7 排寬、中間的走道不能有桌子擋路（${lay3.h.join(',')}；擋路：${lay3.blocked.join('、')}）`);
  check(lay3.ceil >= 3.2 && lay3.roofH > lay3.ceil, `天花板要加高到 3.2 公尺以上（現在 ${lay3.ceil}，車頂 ${lay3.roofH}）`);
  check(lay3.gift < 2 && lay3.giftOk, `早晨禮物要在機車室的火爐旁邊（離火爐 ${lay3.gift.toFixed(1)} 格）`);
  check(lay3.merchant === 'platform' && lay3.mdoor, `神秘商人要在月台上、車門下車的正前方（現在在 ${lay3.merchant}）`);
  check(await page.evaluate(() => document.getElementById('alert').textContent.includes('🎯')), '狀態列要有 🎯 今天的目標');
  // 駕駛台：站在前面對著它，互動是「拉汽笛」；拉了之後要冷卻
  const wh = await page.evaluate(() => {
    const th = FURN_BY_ID.throttle;
    Object.assign(G.p, { x: th.x + 1.5, y: th.y + 1.6, face: -Math.PI / 2, pitch: 0 });
    const t = getTarget();
    pullWhistle();
    return { label: t && t.label, cd: G.ev.whistleCd };
  });
  check(wh.label === '拉汽笛' && wh.cd > 0, `駕駛台要能拉汽笛（互動「${wh.label}」）`);
  await shot('1-start');
  // 照片貼圖（Gemini 生成的牆壁、絨布、地毯、地磚、天花板、鐵板……）都要載入
  const photo = await page.evaluate(() => Renderer.photos());
  check(photo.total >= 20 && photo.loaded.length === photo.total, `第三世界的照片貼圖都要載入（tex/*.webp；${photo.loaded.length}/${photo.total} 張）`);
  // 乘客：座位上是寫實、各式各樣的死去乘客（紳士、和服婦人、學生……），都閉著眼；「乘客轉頭」事件時頭轉過來、睜開眼睛
  const pax = await page.evaluate(() => Renderer.pax());
  check(pax.n >= 20 && pax.kinds.length >= 8 && pax.list.every(p => p.state === 'dead'), `車上要有 20 個以上、8 種以上死去的乘客（現在 ${pax.n} 個、${pax.kinds.length} 種：${pax.kinds.join('、')}）`);
  await page.evaluate(() => {
    const sp = Renderer.pax().list.find(p => p.id === 'seatN4');
    Object.assign(G.p, { x: sp.x - 1.26, y: sp.y + 1.1, face: Math.atan2(-1.1, 1.26), pitch: -0.3 });
    G.ev.paxTurn = { id: 'seatN4', t: 5 };
  });
  const stare = await page.waitForFunction(() => Renderer.pax().list.find(p => p.id === 'seatN4').state === 'stare', null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(stare, '「乘客轉頭」事件時，那個乘客要睜開眼睛看你');
  await sleep(600);
  await shot('1b-passenger-turn');
  await page.evaluate(() => { G.ev.paxTurn = null; });
  // 跳上家具（設計師：「可跳到床、椅子、桌子、人的頭上」）：直接呼叫更新函式，不用等低 FPS 的遊戲時間
  const jump = await page.evaluate(() => {
    const run = (x, y, face, z, n = 60) => {
      Object.assign(G.p, { x, y, face, z, vz: 0, pitch: 0, pose: null });
      keys.w = true; tryJump();
      let top = 0;
      for (let i = 0; i < n; i++) { updatePlayer(0.02); top = Math.max(top, G.p.z); if (i > 18) keys.w = false; }
      keys.w = false;
      for (let i = 0; i < 40; i++) updatePlayer(0.02);
      return { z: G.p.z, x: G.p.x, y: G.p.y, top };
    };
    const t = FURN_BY_ID.dtable4;   // 沒有乘客的餐桌：中間那格是桌子
    const table = run(t.x + 1.5, t.y - 0.6, Math.PI / 2, 0);
    const onTable = furnGrid[Math.floor(table.y)][Math.floor(table.x)] === t;
    // 站在座位上，再跳到旁邊乘客的頭上
    const sN = FURN_BY_ID.seatN3, [hx, hy] = sN.paxAt[0];
    const head = run(sN.x + hx + 0.5, sN.y + hy + 1.5, -Math.PI / 2, furnTopH(sN, hx, hy + 1));
    // 走出桌子的邊緣會掉下來
    Object.assign(G.p, { x: t.x + 1.5, y: t.y + 0.5, z: 0.78, vz: 0, face: -Math.PI / 2 });
    keys.w = true; for (let i = 0; i < 40; i++) updatePlayer(0.02); keys.w = false;
    for (let i = 0; i < 40; i++) updatePlayer(0.02);
    const fell = G.p.z;
    // 坐下、躺下、站起來
    sitDown(FURN_BY_ID.seatN2);
    const sit = { pose: G.p.pose && G.p.pose.kind, drop: G.p.camDrop, z: G.p.z, face: G.p.face };
    keys.w = true; updatePlayer(0.02); keys.w = false;
    const up = { pose: G.p.pose, ok: walkable(G.p.x, G.p.y) };
    Object.assign(G.p, { x: FURN_BY_ID.bed.x + 1, y: FURN_BY_ID.bed.y - 0.6, face: Math.PI / 2 });
    const lieT = getTarget();
    lieDown(FURN_BY_ID.bed);
    const lie = { pose: G.p.pose && G.p.pose.kind, pitch: G.p.pitch, label: lieT && lieT.label, t: getTarget().label };
    standUp();
    return { table, onTable, head, fell, sit, up, lie, mode };
  });
  check(jump.onTable && jump.table.z > 0.7, `要能跳上桌子（腳的高度 ${jump.table.z.toFixed(2)}、在桌子上 ${jump.onTable}、mode ${jump.mode}）`);
  check(jump.head.z > 1.2, `要能從座位跳到乘客的頭上（腳的高度 ${jump.head.z.toFixed(2)}，最高 ${jump.head.top.toFixed(2)}）`);
  check(jump.fell < 0.05, `走出桌子的邊緣要掉下來（腳的高度 ${jump.fell.toFixed(2)}）`);
  check(jump.sit.pose === 'sit' && jump.sit.drop > 0.5 && Math.abs(jump.sit.face - Math.PI) < 0.01 && !jump.up.pose && jump.up.ok, `對著座位要能坐下（面向車頭）、一走動就站起來（${JSON.stringify(jump.sit)}）`);
  check(jump.lie.pose === 'lie' && jump.lie.pitch > 1 && jump.lie.label === '躺下' && jump.lie.t === '起來', `對著床要能躺下、看天花板（互動「${jump.lie.label}」→「${jump.lie.t}」）`);
  // 坐在座位上拍一張（鏡頭比較低）
  await page.evaluate(() => { Object.assign(G.p, { x: 15.5, y: 7.5, face: -Math.PI / 2 }); sitDown(FURN_BY_ID.seatN2); G.p.pitch = 0.05; G.p.face = 0.3; });
  await sleep(1500);
  await shot('1c-sit');
  await page.evaluate(() => { standUp(); });
  // 下車：站在景觀車廂的車門北邊往南走，白天要走得下月台
  await page.evaluate(() => { Object.assign(G.p, { x: 50.5, y: 11.3, face: Math.PI / 2, pitch: 0.05 }); });
  await page.keyboard.down('w');
  await page.waitForFunction(() => G.p.y > 12.6, null, { timeout: 20000 }).catch(() => {});
  await page.keyboard.up('w');
  s = await state(page);
  check(s.y > 12.6, `白天要能從車門走下月台（現在 y=${s.y.toFixed(1)}、mode ${await page.evaluate(() => mode)}）`);
  await shot('2-platform');
  // 寶箱：每天在車站放 6 個（LV1×3、LV2×2、LV3×1）；走到櫃箱前面開它（直接呼叫開箱的函式，不用等按住 E）
  const ch = await page.evaluate(() => {
    const list = G.chests3.map(c => c.lv), c = G.chests3.find(c => c.lv === 1);
    Object.assign(G.p, { x: c.x + 0.5 + Math.cos(c.face + Math.PI / 2) * 1.0, y: c.y + 0.5 + Math.sin(c.face + Math.PI / 2) * 1.0 });
    G.p.face = Math.atan2(c.y + 0.5 - G.p.y, c.x + 0.5 - G.p.x);
    const solid = isSolid(c.x, c.y), before = G.coins;
    Math.random = () => 0.99;   // 這次一定開出物資，不跳怪物
    openChest3(c);
    return { list, solid, opened: c.open, coins: G.coins - before, modal: mode === 'modal' };
  });
  check(ch.list.length === 6 && ch.list.filter(l => l === 1).length === 3, `第 1 天要放 6 個寶箱（現在：${ch.list.join(',')}）`);
  check(ch.solid && ch.opened && ch.coins > 0 && ch.modal, `櫃箱要擋路、開了要有東西（開了 ${ch.opened}、硬幣 +${ch.coins}）`);
  await sleep(600);
  await shot('2b-chest');
  await page.evaluate(() => { closeModal(); });
  // 火爐：站在火爐前面丟木柴，火力要增加
  const fire = await page.evaluate(() => {
    const f = FURN_BY_ID.firebox;
    Object.assign(G.p, { x: f.x + 1, y: f.y + f.h + 0.6, face: -Math.PI / 2 });
    const n0 = G.fire.queue.length, w0 = G.inv.wood || 0;
    G.selId = 'wood';
    useSelected();
    return { n0, n1: G.fire.queue.length, w0, w1: G.inv.wood || 0, left: G.fire.queue.reduce((s, q) => s + q.left, 0), bar: !document.getElementById('fireBar').classList.contains('hidden') };
  });
  check(fire.n1 === fire.n0 + 1 && fire.w1 === fire.w0 - 1 && fire.left >= 25, `對著火爐用木柴要丟進去（火爐 ${fire.n0}→${fire.n1}，木柴 ${fire.w0}→${fire.w1}）`);
  check(fire.bar, '第三世界要顯示 🔥 火力條');
  // 天黑前 3 秒車站鎖門：門變成牆，還留在車站的人會被拉回車上
  await page.evaluate(() => { Object.assign(G.p, { x: 30.5, y: 15.5 }); G.t = DAY_LEN - 3.2; });
  await page.waitForFunction(() => DOORS.some(d => d.locked) || G.phase === 'night', null, { timeout: 30000 });
  await skipToNight(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  await sleep(400);
  const d = await page.evaluate(() => ({ locked: DOORS.filter(d => d.locked).length, y: G.p.y, solid: isSolid(19, 12), wall: isWall(35, 12) }));
  check(d.locked === 3 && d.solid && d.wall, `天黑時車站的三扇門要鎖住、變成牆（鎖了 ${d.locked} 扇）`);
  check(d.y < 12, `留在車站的玩家要被拉回車上（現在 y=${d.y.toFixed(1)}）`);
  const lay = await overlaps(page);
  check(lay.length === 0, '天黑時版面重疊：' + lay.join('、'));
  await sleep(1200);
  await shot('3-night');
  // 晚上：看得到你的乘客全部慢慢把頭轉過來盯著你（睜開眼睛）
  await page.evaluate(() => { G.enemies = []; G.ev.schedule = []; G.ev.paxTurn = null; Object.assign(G.p, { x: 16.4, y: 7.6, face: -0.75, pitch: -0.3, inv: 999, flash: true, bat: 100 }); });
  const stareN = await page.waitForFunction(() => Renderer.pax().list.filter(p => p.state === 'stare').length >= 4, null, { timeout: 30000 }).then(() => true).catch(() => false);
  const nst = await page.evaluate(() => Renderer.pax().list.filter(p => p.state === 'stare').length);
  check(stareN, `晚上看得到你的乘客都要轉頭盯著你（現在 ${nst} 個）`);
  await sleep(800);
  await shot('3b-stare');
});

await scenario('w3stop', '第三世界第 2 夜火爐是空的（?world=3&night=2&fire=0）：列車減速、停下來被攻擊，補燃料後重新開動', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=3&night=2&kit=1&fire=0', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await skipToNight(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  // 火爐是空的：列車先減速，5 秒後停下來（低 FPS 下遊戲時間走很慢，直接把時間撥快）
  await page.evaluate(() => { G.train.t = TRAIN_STOP_DELAY + 1; });
  await page.waitForFunction(() => G.train.state === 'stopped', null, { timeout: 30000 });
  const hp0 = await page.evaluate(() => G.p.hp);
  await sleep(2500);
  const st = await page.evaluate(() => ({ state: G.train.state, hp: G.p.hp, k: G.train.k, fx: +document.getElementById('stopfx').style.opacity, alert: document.getElementById('alert').textContent }));
  check(st.state === 'stopped' && st.hp < hp0, `列車停下來要一直扣血（${hp0.toFixed(0)} → ${st.hp.toFixed(0)}）`);
  check(st.fx > 0 && st.alert.includes('列車停了'), '列車停了要有畫面效果和提示');
  const lay = await overlaps(page);
  check(lay.length === 0, '列車停下時版面重疊：' + lay.join('、'));
  await shot('1-stopped');
  // 丟燃料：列車 4 秒後重新開動
  const re = await page.evaluate(() => {
    const f = FURN_BY_ID.firebox;
    Object.assign(G.p, { x: f.x + 1, y: f.y + f.h + 0.6, face: -Math.PI / 2 });
    G.selId = 'charcoal'; useSelected();
    const starting = G.train.state;
    G.train.t = TRAIN_RESTART + 1;
    return { starting };
  });
  check(re.starting === 'starting', `補燃料後列車要準備重新開動（現在：${re.starting}）`);
  await page.waitForFunction(() => G.train.state === 'run', null, { timeout: 30000 });
  check(true, '');
  await sleep(1000);
  await shot('2-running');
});

await scenario('w3cold', '第三世界寒寂之境（?world=3&night=3&cold）：體溫條、在車站體溫會掉、大白燈抱住你會回體溫', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=3&night=3&kit=1&cold', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  // 站在月台上：體溫每秒掉 2 點（低 FPS 下遊戲時間走得慢，直接比較前後）
  const t0 = await page.evaluate(() => { Object.assign(G.p, { x: 30.5, y: 15.5, face: -Math.PI / 2 }); return { cold: G.cold, temp: G.p.temp, bar: !document.getElementById('tempBar').classList.contains('hidden') }; });
  check(t0.cold && t0.bar, '&cold 要是寒寂之境，狀態列要顯示 🌡️ 體溫');
  await sleep(3000);
  const t1 = await page.evaluate(() => ({ temp: G.p.temp, frost: G.frost, snow: G.fx.length }));
  check(t1.temp < t0.temp, `在車站體溫要一直掉（${t0.temp} → ${t1.temp.toFixed(1)}）`);
  check(t1.snow > 0, '寒寂之境的車站要下雪');
  await shot('1-platform');
  // 蠟燭：拿在手上（物品列選中蠟燭），在月台上體溫會慢慢回升（設計師：下雪時拿著蠟燭可以回溫暖）；手上看得到點著的蠟燭、狀態列有提示
  const cd = await page.evaluate(() => {
    addItem('candle', 2);
    const drop = sel => { G.selId = sel; G.p.temp = 80; G.p.candleT = 0; for (let i = 0; i < 10; i++) updateWarmth3(0.2); return 80 - G.p.temp; };
    const without = drop('bulb1'), withC = drop('candle');
    updateHUD();
    return { without, withC, alert: document.getElementById('alert').textContent };
  });
  check(cd.without > 0 && cd.withC < 0 && cd.alert.includes('蠟燭讓你暖和起來'), `拿著蠟燭時體溫要回升（沒拿掉了 ${cd.without.toFixed(1)}、拿著回升 ${(-cd.withC).toFixed(1)}；狀態列「${cd.alert.slice(0, 40)}」）`);
  await sleep(1200);
  await shot('1a-candle');
  // 大白燈：放一盞落地燈裝上大白燈，走到大白面前會被抱住、體溫回升
  const h0 = await page.evaluate(() => {
    Object.assign(G.p, { x: 49.5, y: 7.6, face: -Math.PI / 2, pitch: -0.1 });
    G.selId = 'lamp_floor'; useSelected(); installBulb(G.lamps[0], BAYMAX_TIER);
    Object.assign(G.p, { x: 49.5, y: 6.7 }); G.p.temp = 40;
    return { ok: G.lamps.length > 0 && G.lamps[0].bulb === BAYMAX_TIER, temp: G.p.temp };
  });
  check(h0.ok, '落地燈要能裝上大白燈');
  // 抱住要一點時間，低 FPS 時遊戲時間走得慢：最多等 12 秒
  await page.waitForFunction(() => G.hugged && G.hug > 0.5, null, { timeout: 12000 }).catch(() => {});
  const h1 = await page.evaluate(() => ({ hugged: G.hugged, hug: G.hug, temp: G.p.temp, frost: G.frost }));
  check(h1.hugged && h1.hug > 0.5, `走到大白面前要被抱住（hug=${h1.hug.toFixed(2)}）`);
  check(h1.temp > h0.temp, `被大白抱住體溫要回升（${h0.temp} → ${h1.temp.toFixed(1)}）`);
  await shot('1b-hug');
  const lay = await overlaps(page);
  check(lay.length === 0, '寒寂之境時版面重疊：' + lay.join('、'));
  // 退後幾步看大白（抱著的時候鏡頭在它身體裡面）
  await page.evaluate(() => { Object.assign(G.p, { x: 49.5, y: 9.3, face: -Math.PI / 2, pitch: -0.05 }); document.getElementById('hud').style.opacity = '0'; });
  await sleep(1500);
  await shot('2-baymax');
});

await scenario('monsters', '怪物模型（火柴人、鳥腳女和爬行女會動的頭髮、眼球花，手電筒開關各拍一張；小丑突然出現在面前嚇你、扣血）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=1&night=6&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  // 在客廳排一排怪物；讓牠們不追、不咬人，才拍得到（頭髮、火柴人的動作照樣會動）
  const n = await page.evaluate(() => {
    G.enemies = []; G.flowers = [];
    Object.assign(G.p, { x: 20.5, y: 23.2, face: -Math.PI / 2, pitch: -0.12, inv: 999 });
    const put = (kind, x, y, extra) => Object.assign(spawnEnemy(kind, { x, y }), { spawn: 0 }, extra);
    put('stick', 18.6, 19.6);
    put('momo', 19.9, 19.4, { cd: 999 });
    put('crawler', 21.1, 20.6, { pauseT: 999 });
    const f = newFlower(22.4, 19.8);
    Object.assign(f, { grow: 1, watch: -999 });
    G.flowers.push(f);
    return G.enemies.length + G.flowers.length;
  });
  check(n === 4, `要放好 4 隻怪物（現在 ${n} 隻）`);
  await page.evaluate(() => { document.getElementById('hud').style.opacity = '0'; }); // 道具列會擋到地上的爬行女
  await sleep(1500);
  await shot('1-lamp');
  await page.keyboard.press('f');
  await sleep(1500);
  check((await state(page)).flash === true, '按 F 要打開手電筒');
  await shot('2-flashlight');
  // 小丑（設計師：「小丑會突然出現在你面前然後嚇死你，血量會減少」）：氣球碰到你，小丑出現在鏡頭正前方約 1 公尺，然後撲上來嚇你、扣血
  const cl = await page.evaluate(() => {
    G.enemies = []; G.flowers = [];
    Object.assign(G.p, { x: 20.5, y: 23.2, face: -Math.PI / 2, pitch: 0, inv: 0, hp: 100, flash: false });
    const b = Object.assign(spawnEnemy('balloon', { x: 20.5, y: 22.8 }), { spawn: 0 });
    updateBalloon(b, 0.05);
    G.enemies = G.enemies.filter(e => !e.dead);   // 破掉的氣球（遊戲迴圈本來會在同一幀拿掉）
    const c = G.enemies.find(e => e.kind === 'clown');
    if (!c) return null;
    c.pop = 99;   // 先讓他站著拍照
    return { d: Math.hypot(c.x - G.p.x, c.y - G.p.y), a: lookAngle(c.x, c.y) };
  });
  check(cl && cl.d < 1.5 && cl.a < 0.5, `氣球碰到你，小丑要出現在你面前（距離 ${cl && cl.d.toFixed(2)}、偏 ${cl && cl.a.toFixed(2)}）`);
  await page.keyboard.press('f');
  await sleep(1500);
  await shot('3-clown');
  const scare = await page.evaluate(() => {
    const c = G.enemies.find(e => e.kind === 'clown'), hp = G.p.hp;
    c.pop = 0.01; updateClown(c, 0.05);
    return { hp0: hp, hp1: G.p.hp, js: document.getElementById('jumpscare').classList.contains('show'), back: c.back > 0 };
  });
  check(scare.js && scare.hp1 < scare.hp0 - 10 && scare.back, `小丑要撲上來嚇你（驚嚇畫面 ${scare.js}）、扣血（${scare.hp0.toFixed(0)} → ${scare.hp1.toFixed(0)}）、再往後退（帶著護身符，只扣一半）`);
});

await scenario('monsters2', '第二世界怪物模型（草叢人、大嘴觸角蟲、眼花女孩、向日葵眼、千眼菇排成一排，手電筒開關各拍一張）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=2&night=6&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  // 在玩家前面排一排；草叢人站出來、向日葵眼盯著玩家，才看得到臉和眼睛
  const n = await page.evaluate(() => {
    G.enemies = []; G.flowers = [];
    const p = G.p, c = Math.cos(p.face), s = Math.sin(p.face);
    const at = (fwd, side) => [p.x + c * fwd - s * side, p.y + s * fwd + c * side];
    const put = (kind, fwd, side, extra) => { const [x, y] = at(fwd, side); Object.assign(spawnEnemy(kind, { x, y }), { spawn: 0 }, extra); };
    const plant = (ptype, fwd, side, extra) => { const [x, y] = at(fwd, side); G.flowers.push(Object.assign(newFlower(x, y, ptype), { grow: 1, face: Math.atan2(p.y - y, p.x - x) }, extra)); };
    put('grass', 3.2, -2.2, { rise: 1, hidden: false, state: 'up', upT: 999 });
    put('snail', 3.4, -0.8, { chew: 999 });
    put('girl', 3.6, 0.6, { blind: 0, blindCd: 999 });
    plant('sunflower', 3.0, 2.0, { lock: 1 });
    plant('shroom', 4.6, 1.2, {});
    Object.assign(p, { pitch: -0.08, inv: 999 });
    return G.enemies.length + G.flowers.length;
  });
  check(n === 5, `要放好 5 隻怪物（現在 ${n} 隻）`);
  await page.evaluate(() => { document.getElementById('hud').style.opacity = '0'; });
  await sleep(1500);
  await shot('1-lamp');
  await page.keyboard.press('f');
  await sleep(1500);
  check((await state(page)).flash === true, '按 F 要打開手電筒');
  await shot('2-flashlight');
});

await scenario('monsters3', '第三世界怪物模型（克羅諾斯・蕈裂、熔岩暴君、墮落戰神、檮杌・九瞳排成一排，旁邊站著大白燈的大白；手電筒開關各拍一張）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=3&night=6&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  // 在景觀車廂排一排（pose：不追、不咬人，只做待機的動作），玩家在車尾那一頭往車頭看；落地燈裝上大白燈
  const n = await page.evaluate(() => {
    G.enemies = []; G.ev.schedule = [];
    Object.assign(G.p, { x: 53.5, y: 8.5, face: Math.PI, pitch: -0.06, inv: 999 });
    const put = (kind, x, y, extra) => Object.assign(spawnEnemy(kind, { x, y }), { spawn: 0, pose: true, face: 0 }, extra);
    put('kronos', 49.8, 6.7, { thrust: 0.3 });
    put('tyrant', 47.2, 9.9);
    put('warlord', 49.8, 10.1);
    put('taowu', 46.6, 7.1);
    G.p.x = 50.5; G.p.y = 6.8; G.selId = 'lamp_floor'; useSelected(); installBulb(G.lamps[0], BAYMAX_TIER);
    Object.assign(G.p, { x: 53.5, y: 8.5, face: Math.PI });
    return G.enemies.length + G.lamps.filter(l => l.bulb === BAYMAX_TIER).length;
  });
  check(n === 5, `要放好 4 隻怪物和大白（現在 ${n}）`);
  await page.evaluate(() => { document.getElementById('hud').style.opacity = '0'; });
  await sleep(1500);
  const alive = await page.evaluate(() => G.enemies.map(e => e.kind));
  check(alive.length === 4, `擺姿勢的怪物不能自己消失（剩 ${alive.join(',')}）`);
  await shot('1-lamp');
  await page.keyboard.press('f');
  await sleep(1500);
  check((await state(page)).flash === true, '按 F 要打開手電筒');
  await shot('2-flashlight');
  // 檮杌的眼睛：手電筒照著牠，眼睛要一顆一顆閉上
  const eyes = await page.evaluate(() => {
    const e = G.enemies.find(e => e.kind === 'taowu');
    Object.assign(G.p, { x: e.x, y: e.y + 2.2, face: -Math.PI / 2, flash: true, bat: 100 });
    e.eyeProg = 0;   // 牠擺著姿勢不動（pose），眼睛的判定照常
    for (let i = 0; i < 40; i++) updateTaowu(e, 0.05);
    return { shut: e.eyes.filter(x => x.shut).length, lit: e.lit };
  });
  check(eyes.shut >= 1, `手電筒照著檮杌，眼睛要閉上（閉了 ${eyes.shut} 顆）`);
});

await scenario('w3roof', '第三世界的車頂（爬梯上去、風、檮杌會跟上來、艙口爬回來）和墮落戰神只在走道裡走', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=3&night=2&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await skipToNight(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  await sleep(500);
  // 對著景觀車廂的爬梯：互動是「爬上車頂」；爬上去之後站在車頂（地板比較高）
  const up = await page.evaluate(() => {
    G.enemies = []; G.ev.schedule = []; G.train.k = 1;
    Object.assign(G.p, { x: 56.5, y: 6.5, face: 0, pitch: 0 });
    const t1 = getTarget();
    climbRoof(FURN_BY_ID.ladder2);
    Object.assign(G.p, { face: Math.PI, pitch: -0.05 });
    return { label: t1 && t1.label, roof: onRoof(G.p.x, G.p.y), fh: floorH(G.p.x, G.p.y), room: roomAt(G.p.x, G.p.y).name };
  });
  check(up.label === '爬上車頂' && up.roof && up.fh > 3.2 && up.room === '車頂', `爬梯要能爬上車頂（互動「${up.label}」、房間「${up.room}」、高度 ${up.fh}）`);
  await sleep(1500);
  const wind = await page.evaluate(() => ({ fx: G.fx.some(f => f.vx > 5), alert: document.getElementById('alert').textContent }));
  check(wind.fx && wind.alert.includes('車頂'), '車頂上要有迎面的風（光點）和提示');
  await shot('1-roof');
  // 檮杌會跟上車頂：牠在車廂裡、你在車頂，4 秒後牠從最近的艙口跳上來（直接呼叫牠的更新函式，不用等低 FPS 的遊戲時間）
  const tw = await page.evaluate(() => {
    const e = Object.assign(spawnEnemy('taowu', { x: 47.5, y: 8.5 }), { spawn: 0 });
    for (let i = 0; i < 60; i++) updateTaowu(e, 0.1);
    return { roof: onRoof(e.x, e.y), pos: [Math.round(e.x), Math.round(e.y)] };
  });
  check(tw.roof, `檮杌 4 秒後要跳上車頂（現在在 ${tw.pos}）`);
  // 艙口：互動是「爬回車廂」，爬下去之後站在爬梯旁邊
  const down = await page.evaluate(() => {
    G.enemies = [];
    Object.assign(G.p, { x: 57.5, y: 2.5, face: 0 });
    const t2 = getTarget();
    climbDown(FURN_BY_ID.hatch2);
    return { label: t2 && t2.label, roof: onRoof(G.p.x, G.p.y), ok: walkable(G.p.x, G.p.y), room: roomAt(G.p.x, G.p.y).name };
  });
  check(down.label === '爬回車廂' && !down.roof && down.ok && down.room === '景觀車廂', `艙口要能爬回車廂（互動「${down.label}」、房間「${down.room}」）`);
  // 墮落戰神：從列車的一頭巡邏到另一頭（走得動、一直在走道裡）；你躲進機車室牠就在門外的走道上等，不會進來
  const wl = await page.evaluate(() => {
    Object.assign(G.p, { x: 50.5, y: 8.5, face: Math.PI });
    const e = Object.assign(spawnEnemy('warlord', warlordSpawn()), { spawn: 0 });
    const x0 = e.x;
    let hall = true;
    for (let i = 0; i < 40; i++) { updateWarlord(e, 0.1); if (!inHall(e.x, e.y)) hall = false; }
    const walked = Math.abs(e.x - x0);
    // 玩家躲進機車室，戰神從走道衝過來
    Object.assign(G.p, { x: 4.5, y: 7.5 });
    Object.assign(e, { x: 14.5, y: 8.5, state: 'charge', waitT: 0, pt: null });
    let inside = false;
    for (let i = 0; i < 60; i++) { updateWarlord(e, 0.1); if (roomAt(e.x, e.y) && roomAt(e.x, e.y).comp) inside = true; }
    const door = DOORS.find(d => d.comp);
    return { walked, hall, state: e.state, wait: [Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10], inside, near: Math.hypot(e.x - (door.x + 1.5), e.y - (door.y + 0.5)) < 1.3 };
  });
  check(wl.walked > 3 && wl.hall, `墮落戰神要在走道裡巡邏（走了 ${wl.walked.toFixed(1)} 格、一直在走道 ${wl.hall}）`);
  check(wl.state === 'wait' && wl.near && !wl.inside, `躲進機車室時戰神要在門外等（狀態 ${wl.state}、位置 ${wl.wait}、進過機車室 ${wl.inside}）`);
  const lay = await overlaps(page);
  check(lay.length === 0, '車頂時版面重疊：' + lay.join('、'));
  await shot('2-corridor');
});

await scenario('tablet', '平板觸控（Android 平板尺寸，用點的開新遊戲）', { isMobile: true, hasTouch: true }, async ({ page, shot, check }) => {
  await startFromMenu(page, 1, 'normal', true);
  const s = await state(page);
  check(s.hud, 'HUD 要出現');
  const touchUI = await page.evaluate(() => getComputedStyle(document.getElementById('touch')).display !== 'none');
  check(touchUI, '觸控按鈕（搖桿、E、手電筒）要出現');
  await shot('1-start');
});

await scenario('layout', '小平板版面（962×601：天黑、天亮、撿到燈泡時，提示不壓到大字、燈泡卡和面板）', { viewport: { width: 962, height: 601 }, isMobile: true, hasTouch: true }, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=1&diff=easy', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(3500); // 等「第 1 天」大字消失
  // 直接叫天黑、天亮、撿到燈泡的函式，不用等遊戲時間；中間等提示都消失，才不會疊在一起
  for (const [label, name, fn] of [
    ['1-night', '天黑', () => startNight()],
    ['2-day', '天亮', () => startDay(2)],
    ['3-bulb', '撿到燈泡', () => { toast('撿到了' + itemName('bulb1'), 'item'); showBulbCard(1); }],
  ]) {
    await page.evaluate(fn);
    await sleep(500);
    const lay = await overlaps(page);
    check(lay.length === 0, `${name}時版面重疊：${lay.join('、')}`);
    await shot(label);
    await sleep(4500);
  }
});

await scenario('phone', '手機版面（橫放 852×393、直放 393×852：介面縮小，不擋住畫面中央，也不互相重疊）', { viewport: { width: 852, height: 393 }, isMobile: true, hasTouch: true }, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=1&diff=easy', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(3500); // 等「第 1 天」大字消失
  let c = await hudCover(page);
  check(c.phone, '852×393 要用手機版面（body.phone）');
  check(c.top <= 40 && c.bottom >= 65, `手機橫放時面板佔太多畫面（上面到 ${c.top}%，下面從 ${c.bottom}% 開始）`);
  for (const [label, name, fn] of [
    ['1-night', '天黑', () => startNight()],
    ['2-day', '天亮', () => startDay(2)],
    ['3-bulb', '撿到燈泡', () => { toast('撿到了' + itemName('bulb1'), 'item'); showBulbCard(1); }],
  ]) {
    await page.evaluate(fn);
    await sleep(500);
    const lay = await overlaps(page);
    check(lay.length === 0, `手機橫放${name}時版面重疊：${lay.join('、')}`);
    await shot(label);
    await sleep(4500);
  }
  // 轉成直放：物品列要移到搖桿和按鈕上面，小地圖到時鐘下面
  await page.setViewportSize({ width: 393, height: 852 });
  await sleep(500);
  c = await hudCover(page);
  check(c.phone, '393×852 也要用手機版面');
  await page.evaluate(() => { toast('撿到了' + itemName('bulb1'), 'item'); showBulbCard(1); startNight(); });
  await sleep(500);
  const lay = await overlaps(page);
  check(lay.length === 0, `手機直放天黑時版面重疊：${lay.join('、')}`);
  await shot('4-portrait');
});

await scenario('book', '怪物圖鑑（沒見過的只有問號；見過的卡片上是會動的 3D 怪物：三個世界各拍一張；舊存檔會照進度標成見過；?model= 看第五世界七隻怪物的模型）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#btnBook');
  await page.click('#btnBook');
  await sleep(1500);
  const stat = () => page.evaluate(() => ({ ok: Renderer.book.ok(), stages: document.querySelectorAll('#bookList .stage:not(.unseen)').length, unseen: document.querySelectorAll('#bookList .stage.unseen').length, cards: document.querySelectorAll('#bookList .card').length, rendered: Renderer.book.stats.rendered, built: Renderer.book.stats.built, note: !document.getElementById('bookUnseen').classList.contains('hidden') }));
  // 全新的玩家：什麼都沒見過，每張卡片都是問號
  let s = await stat();
  check(s.cards > 0 && s.unseen === s.cards && s.stages === 0 && s.note, `沒見過的怪物要顯示問號（${s.unseen}/${s.cards}）`);
  await shot('0-unseen');
  // 見過第一世界的怪物（在你 8 格內出現超過 1 秒就算）：卡片變成 3D 怪物
  await page.evaluate(() => { for (const m of BESTIARY) if ((m.world || 1) === 1) markSeen(m.kind || 'f:' + m.flower); showBookPage(1); });
  await sleep(2500);
  s = await stat();
  check(s.ok && s.stages === s.cards && s.unseen === 0, `見過的怪物要用 3D 舞台（${s.stages}/${s.cards}）`);
  check(s.rendered > 0 && s.built > 0, `圖鑑要畫出 3D 怪物（畫了 ${s.rendered} 次、建了 ${s.built} 隻）`);
  await shot('1-world1');
  await page.evaluate(() => { document.querySelector('#book .panel').scrollTop = 99999; });
  await sleep(1500);
  await shot('1b-world1-scrolled');
  // 第二世界：新怪物還沒見過是問號，第一世界來的怪物已經見過
  await page.click('#bookTabs button[data-w="2"]');
  await sleep(1500);
  s = await stat();
  check(s.unseen === 5 && s.stages > 0, `第二世界的 5 隻新怪物要是問號、第一世界來的要有 3D（問號 ${s.unseen}、3D ${s.stages}）`);
  const before = s.built;
  await page.evaluate(() => { for (const m of BESTIARY) markSeen(m.kind || 'f:' + m.flower); showBookPage(2); });
  await sleep(1500);
  await shot('2-world2');
  // 往下捲：捲到面板外面的不畫，下面的第二世界怪物要建出新的模型
  await page.evaluate(() => { document.querySelector('#book .panel').scrollTop = 99999; });
  await sleep(2500);
  s = await stat();
  check(s.built > before && s.unseen === 0, `見過第二世界的怪物要建出新的模型（建了 ${s.built} 隻）`);
  await shot('3-scrolled');
  // 第三世界：每張卡片都寫著九級裡的哪一級（蕈裂鬼將級、熔岩暴君和墮落戰神判官級、檮杌羅剎級），邊框是那一級的顏色；上面有九級的說明列
  await page.click('#bookTabs button[data-w="3"]');
  await sleep(2500);
  s = await stat();
  const gr = await page.evaluate(() => ({
    grades: [...document.querySelectorAll('#bookList .card .grade')].map(e => e.textContent),
    cards: document.querySelectorAll('#bookList .card').length,
    border: getComputedStyle(document.querySelector('#bookList .card.g-rakshasa .stage')).borderTopColor,
    legend: document.querySelectorAll('#bookGrades .gtag').length,
  }));
  check(s.stages === s.cards && gr.grades.length === gr.cards && gr.grades.filter(g => g === '判官級').length === 2 && gr.grades.includes('羅剎級') && gr.grades.includes('鬼將級'), `第三世界每張卡片都要寫等級（${gr.grades.join('、')}）`);
  check(gr.border === 'rgb(255, 138, 42)' && gr.legend === 9, `檮杌的卡片邊框要是羅剎級的橘色、上面要有九級的說明列（邊框 ${gr.border}、說明 ${gr.legend} 級）`);
  await shot('4-world3');
  await page.evaluate(() => { document.querySelector('#book .panel').scrollTop = 99999; });
  await sleep(1500);
  await shot('5-world3-scrolled');
  await page.click('#btnBookBack');
  check(await page.evaluate(() => !document.getElementById('title').classList.contains('hidden')), '返回要回到主選單');
  // 舊玩家：有存檔（第一世界第 5 天）但沒有見過的紀錄 → 第 1～4 夜登場的怪物自動標成見過，第 5 夜的「它」還是問號
  await page.evaluate(() => {
    localStorage.setItem('home99_progress_v1', JSON.stringify({ w2: false }));
    localStorage.setItem('home99_save_v1', JSON.stringify({ v: 1, day: 5, diff: 'normal', world: 1, p: { x: 19.5, y: 23, hp: 100, san: 100, hunger: 100, bat: 100, flashLv: 1 }, inv: { bulb1: 1 }, sockets: [], lamps: [], containers: {}, stats: { searched: 0, dissolved: 0, bestTier: 1 } }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#btnBook');
  const mig = await page.evaluate(() => { const s = seenSet(); return { stick: s.has('stick'), momo: s.has('momo'), tall: s.has('tall'), grass: s.has('grass') }; });
  check(mig.stick && mig.momo && !mig.tall && !mig.grass, `舊存檔要照進度標成見過（火柴人 ${mig.stick}、鳥腳女 ${mig.momo}、它 ${mig.tall}、草叢人 ${mig.grass}）`);
  // 看模型（?model=cradle）：還沒有第五世界，搖籃囈語先用這個看；拖曳會轉，返回之後圖鑑照常
  await page.goto(BASE + '?model=cradle', { waitUntil: 'load' });
  const built5 = await page.waitForFunction(() => window.Renderer && Renderer.book.stats.built > 0 && !document.getElementById('book').classList.contains('hidden'), null, { timeout: 30000 }).then(() => true, () => false);
  const mv = await page.evaluate(() => ({ title: document.querySelector('#book h2').textContent, stage: !!document.querySelector('#bookList .model-stage'), cards: document.querySelectorAll('#bookList .card').length }));
  check(built5 && mv.stage && mv.cards === 0 && mv.title.includes('搖籃囈語'), `?model=cradle 要打開搖籃囈語的大舞台（${JSON.stringify(mv)}）`);
  await sleep(1500);
  await shot('6-cradle');
  const box = await page.locator('#bookList .model-stage').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, { steps: 6 }); await page.mouse.up();
  await sleep(1200);
  await shot('7-cradle-turned');
  await page.click('#btnBookBack');
  await page.click('#btnBook');
  await sleep(1500);
  const back = await page.evaluate(() => ({ title: document.querySelector('#book h2').textContent, cards: document.querySelectorAll('#bookList .card').length, tabs: getComputedStyle(document.getElementById('bookTabs')).display }));
  check(back.title === '生物圖鑑' && back.cards > 0 && back.tabs !== 'none', `看完模型返回，再打開圖鑑要照常（${JSON.stringify(back)}）`);
  // 記憶洩漏源（22 公尺高）、白日夢（16 公尺長）：舞台放大來看
  for (const [kind, name] of [['leak', '記憶洩漏源'], ['daydream', '白日夢'], ['slice', '夢境切片'], ['gaze', '404視線'], ['green', '綠溫室'], ['clone', '複製人']]) {
    await page.goto(BASE + '?model=' + kind, { waitUntil: 'load' });
    const built = await page.waitForFunction(() => window.Renderer && Renderer.book.stats.built > 0 && !document.getElementById('book').classList.contains('hidden'), null, { timeout: 30000 }).then(() => true, () => false);
    check(built && await page.evaluate(n => document.querySelector('#book h2').textContent.includes(n), name), `?model=${kind} 要打開${name}的大舞台`);
    await sleep(1500);
    await shot('8-' + kind);
  }
});

await scenario('w5', '第五世界（?world=5&kit=1）：80×80 沒有天花板的草原、白天 6 分鐘晚上 5 分鐘、砍樹（掉板子和木柴、樹樁、2 天後長回來）、樹上和花上長的東西、釣魚、沐浴球丟進水裡洗出東西、工作台的合成書做方塊放在地上、12 天的天氣（下雨、雷暴雨打雷、霧）、7 隻新怪物晚上出來（不會出錯）、圖鑑的第五世界、存檔讀檔砍倒的樹', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=5&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  const info = await page.evaluate(() => ({ world: curWorld, w: MAP_W, h: MAP_H, day: DAY_LEN, night: NIGHT_LEN, bag: bagUsed(), trees: FURN.filter(f => f.type === 'tree5').length, flowers: FURN.filter(f => f.type === 'flower5').length, water: W5MAP.water.size, grown: G.pickups.filter(p => p.s).length, loose: G.loose4.length, bench: !!FURN_BY_ID.bench5, bath: !!FURN_BY_ID.bath5, ceil: Renderer.dbg().scene.children.length > 0 }));
  check(info.world === 5 && info.w === 80 && info.h === 80, `第五世界的地圖要是 80×80（世界 ${info.world}、${info.w}×${info.h}）`);
  check(info.day === 360 && info.night === 300, `白天 6 分鐘、晚上 5 分鐘（${info.day}／${info.night} 秒）`);
  check(info.trees > 120 && info.flowers > 100 && info.water > 300, `草原上要有樹、花、池塘和河（樹 ${info.trees}、花 ${info.flowers}、水 ${info.water} 格）`);
  check(info.grown > 60, `樹上和花上要長著東西（${info.grown} 個）`);
  check(info.bench && info.bath && info.loose >= 4, `起點旁邊要有工作台、沐浴球機和地上的板子（板子 ${info.loose} 片）`);
  check(info.bag <= 16, `kit 帶的東西不能超過背包 16 格（${info.bag} 格）`);
  await page.evaluate(() => { G.t = 100; Object.assign(G.p, { x: 40.5, y: 44.5, face: -Math.PI / 2, pitch: 0.02 }); });
  await sleep(1500);
  await shot('1-meadow');
  // 砍樹：看著樹按住 E 砍 3 下，樹倒了掉 2 片板子和木柴，留下樹樁
  const chop = await page.evaluate(() => {
    const f = FURN.filter(o => o.type === 'tree5' && !o.cut).sort((a, b) => Math.hypot(a.x - 40, a.y - 40) - Math.hypot(b.x - 40, b.y - 40))[0];
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: f.x + 0.5 + dx * 1.0, y: f.y + 0.5 + dy * 1.0 })).find(q => walkable(q.x, q.y));
    Object.assign(G.p, { x: spot.x, y: spot.y, face: Math.atan2(f.y + 0.5 - spot.y, f.x + 0.5 - spot.x), pitch: 0 });
    const t = getTarget(), loose0 = G.loose4.length, pk0 = G.pickups.filter(p => p.id === 'wood').length;
    for (let i = 0; i < 3; i++) { const tt = getTarget(); if (tt && tt.id && tt.id.startsWith('tree:')) tt.action(); }
    return { label: t && t.label, cut: !!f.cut, solid: solid[f.y][f.x], planks: G.loose4.length - loose0, wood: G.pickups.filter(p => p.id === 'wood').length - pk0, id: f.id };
  });
  check(chop.label === '砍樹' && chop.cut && !chop.solid, `看著樹按住 E 砍 3 下樹要倒（「${chop.label}」、倒了 ${chop.cut}、還擋路 ${chop.solid}）`);
  check(chop.planks === 2 && chop.wood === 1, `樹倒了要掉 2 片板子和木柴（板子 ${chop.planks}、木柴 ${chop.wood}）`);
  await sleep(800);
  await shot('2-chopped');
  // 樹上長的東西：看著它按 E 摘下來
  const fruit = await page.evaluate(() => {
    const pk = G.pickups.filter(p => p.s && FURN_BY_ID[p.s].type === 'tree5' && !FURN_BY_ID[p.s].cut)[0];
    const f = FURN_BY_ID[pk.s], a = Math.atan2(pk.y - f.y - 0.5, pk.x - f.x - 0.5), x = pk.x + Math.cos(a) * 0.9, y = pk.y + Math.sin(a) * 0.9;
    Object.assign(G.p, { x, y, face: a + Math.PI, pitch: Math.atan2(pk.z + 0.1 - 1.5, 0.9) });
    if (!walkable(x, y)) return { skip: true };
    while (bagUsed() >= BAG_SLOTS) delete G.inv[invList().find(i => i !== pk.id)];
    const lp = lookedPickup4(), n0 = G.inv[pk.id] || 0;
    if (lp) takePickup4(lp.pk);
    return { looked: !!lp, got: (G.inv[pk.id] || 0) > n0, id: pk.id };
  });
  check(fruit.skip || (fruit.looked && fruit.got), `看著樹上的東西按 E 要摘得下來（${JSON.stringify(fruit)}）`);
  // 釣魚：站在水邊看著水按住 E
  const fish = await page.evaluate(() => {
    for (const k of W5MAP.water) {
      const [x, y] = k.split(',').map(Number);
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (walkable(x + dx + 0.5, y + dy + 0.5)) {
        Object.assign(G.p, { x: x + dx + 0.5, y: y + dy + 0.5, face: Math.atan2(-dy, -dx), pitch: -0.2 });
        while (bagUsed() >= BAG_SLOTS - 1) delete G.inv[invList().find(i => i !== 'bathbomb')];
        const t = getTarget(), n0 = Object.values(G.inv).reduce((a, b) => a + b, 0), c0 = G.coins;
        if (t && t.id === 'fish5') t.action();
        return { label: t && t.label, hold: t && t.hold, got: Object.values(G.inv).reduce((a, b) => a + b, 0) > n0 || G.coins > c0 };
      }
    }
    return {};
  });
  check(fish.label === '釣魚' && fish.got, `站在水邊看著水按住 E 要釣到東西（「${fish.label}」、釣到 ${fish.got}）`);
  // 沐浴球：在水邊選它按 Q 丟進水裡，冒泡之後岸邊浮上來 2～4 樣東西
  const bath = await page.evaluate(() => {
    G.inv.bathbomb = 2; G.selId = 'bathbomb';
    const n0 = G.pickups.length, c0 = G.coins;
    useSelected();
    const fizz = (G.bath5 || []).length;
    updateBath5(2.1);
    return { fizz, left: G.inv.bathbomb, washed: G.pickups.length - n0 + (G.coins - c0) / 2 };   // 洗出來的硬幣直接給丟的人（一次 2 枚）
  });
  check(bath.fizz === 1 && bath.left === 1 && bath.washed >= 2 && bath.washed <= 4, `沐浴球丟進水裡要冒泡、洗出 2～4 樣東西（${JSON.stringify(bath)}）`);
  await sleep(600);
  await shot('3-water');
  // 工作台：打開合成書，2 根木柴做 2 個方塊，拿在手上放到地上（站得上去的 1 公尺方塊）
  const craft = await page.evaluate(() => {
    const b = FURN_BY_ID.bench5;
    Object.assign(G.p, { x: b.x + 1, y: b.y + 2.2, face: -Math.PI / 2, pitch: 0 });
    G.hand = null; G.inv.wood = 6;
    const t = getTarget();
    if (t && t.id === 'bench5') t.action();
    const opened = mode === 'modal' && document.getElementById('mTitle').textContent.includes('合成書');
    const n0 = FURN.filter(f => f.type === 'cube5').length;
    modalAct('cube');
    closeModal();
    const hand = G.hand && G.hand.k === 'furn' && G.hand.f.type;
    G.p.face = Math.PI / 2;
    const g = ghost4(); if (g && g.ok) place4();
    const cubes = FURN.filter(f => f.type === 'cube5' && !f.held);
    return { label: t && t.label, opened, made: FURN.filter(f => f.type === 'cube5').length - n0, hand, placed: cubes.length, top: cubes[0] ? tileTopH(cubes[0].x, cubes[0].y) : null, wood: G.inv.wood };
  });
  check(craft.opened && craft.made === 2 && craft.hand === 'cube5', `工作台要打開合成書、做出 2 個方塊拿在手上（${JSON.stringify(craft)}）`);
  check(craft.placed >= 2 && craft.top === 1 && craft.wood === 4, `方塊要放得到地上、站得上去（1 公尺高）、用掉 2 根木柴（${JSON.stringify(craft)}）`);
  await page.evaluate(() => { const c = FURN.find(f => f.type === 'cube5' && !f.held); Object.assign(G.p, { x: c.x + 0.5, y: c.y + 3, face: -Math.PI / 2, pitch: -0.15 }); });
  await sleep(1000);
  await shot('4-cubes');
  // 天氣：第 7 天雷暴雨（打雷、閃電）、第 2 天下雨加起霧、第 3 天寒寂之境；下雨有雨聲
  const wx = await page.evaluate(() => {
    const out = {};
    G.day = 7; out.storm = rain5(); G.ev.boltT = 0; updateWeather5(0.016); out.flash = G.flash5 > 0; out.bolt = !!G.bolt5;
    G.day = 2; out.rain = rain5(); out.fog = fog5();
    out.counts = Object.fromEntries(['rain', 'storm', 'cold', 'red', 'fog', 'acid'].map(k => [k, Object.values(W5_WEATHER).filter(l => l.includes(k)).length]));
    out.sound = typeof Sound.setRain === 'function';
    G.day = 1;
    return out;
  });
  check(wx.storm === 1 && wx.flash && wx.bolt, `雷暴雨的那天要打雷、有閃電（${JSON.stringify(wx)}）`);
  check(wx.rain > 0 && wx.fog === 1 && wx.sound, `第 2 天要下雨又起霧、有雨聲（${JSON.stringify(wx)}）`);
  const c = wx.counts;
  check(c.rain === 6 && c.storm === 1 && c.cold === 3 && c.red === 2 && c.fog === 2 && c.acid === 2, `12 天的天氣照設計圖：下雨 6、雷暴雨 1、寒寂之境 3、紅月 2、霧 2、酸雨 2（${JSON.stringify(c)}）`);
  await page.evaluate(() => { G.day = 2; Object.assign(G.p, { x: 40.5, y: 44.5, face: -Math.PI / 2, pitch: 0.05 }); });
  await sleep(1500);
  await shot('5-rain-fog');
  // 存檔讀檔：砍倒的樹讀回來還是倒的；2 天後長回來
  const sv = await page.evaluate(id => {
    const s = save4(), f = FURN_BY_ID[id];
    f.cut = null; furnGrid[f.y][f.x] = f; solid[f.y][f.x] = true;
    load5(s.w5);
    const back = !!f.cut && !solid[f.y][f.x];
    G.day = f.cut + 2; regrow5();
    return { back, regrown: !f.cut && solid[f.y][f.x], saved: (s.w5.cut || []).length };
  }, chop.id);
  check(sv.back && sv.regrown && sv.saved >= 1, `存檔要記得砍倒的樹、2 天後長回來（${JSON.stringify(sv)}）`);
  // 晚上：7 隻新怪物都叫出來動一動，不能出錯；手電筒照得到
  await page.evaluate(() => { G.day = 10; G.t = DAY_LEN - 0.05; Object.assign(G.p, { x: 40.5, y: 40.5, face: -Math.PI / 2, pitch: 0.1 }); });
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 20000 });
  const night = await page.evaluate(() => {
    G.enemies = [];
    for (const k of ['daydream', 'gaze', 'slice', 'green', 'cradle', 'clone', 'leak']) {
      const e = spawnEnemy(k, k === 'leak' ? { x: 40.5, y: 18.5 } : { x: 40.5 + (Math.random() - 0.5) * 8, y: 33.5 + Math.random() * 3 });
      if (e) e.spawn = 0;
    }
    G.p.flash = true; G.p.bat = 100;
    for (let i = 0; i < 40; i++) updateEnemies(0.05);
    update5(0.05);
    return { kinds: G.enemies.map(e => e.kind), hp: Math.round(G.p.hp) };
  });
  check(['daydream', 'gaze', 'slice', 'green', 'cradle', 'clone', 'leak'].every(k => night.kinds.includes(k)), `第五世界的 7 隻新怪物都要能在晚上出現（${night.kinds.join('、')}）`);
  await page.evaluate(() => { G.p.hp = 100; G.p.san = 100; for (const e of G.enemies) { e.x = 40.5 + (e.x - 40.5) * 0.6; } });
  await sleep(2500);
  await shot('6-night-monsters');
  const book = await page.evaluate(() => BESTIARY.filter(m => monsterWorlds(m).includes(5)).map(m => m.kind || m.flower));
  check(['daydream', 'gaze', 'slice', 'green', 'cradle', 'clone', 'leak'].every(k => book.includes(k)), `圖鑑的第五世界要有 7 隻新怪物（${book.join('、')}）`);
});

await scenario('cut', '破關開門動畫（?cut=1）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?cut=1', { waitUntil: 'load' });
  await sleep(2500);
  const s = await state(page);
  check(s.mode === 'cutscene' && !(await page.$('#cutscene.hidden')), `要在播動畫（現在 mode：${s.mode}）`);
  await shot('1-cutscene');
});

await scenario('cut2', '第二到第三世界的過場動畫（?cut=2）：月台上車（乘客活著）、睡著、醒來乘客都死了、進第三世界第 1 天', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?cut=2', { waitUntil: 'load' });
  await sleep(2000);
  let s = await state(page);
  check(s.mode === 'cutscene' && !(await page.$('#cutscene.hidden')), `要在播動畫（現在 mode：${s.mode}）`);
  // 低 FPS 下動畫時間走很慢，直接撥到月台那一段、醒來那一段各拍一張
  await page.evaluate(() => { CUT.t = CUT2.walk + 0.3; });
  await sleep(1500);
  const c1 = await page.evaluate(() => ({ world: curWorld, alive: CUT.alive, text: document.getElementById('cutText').textContent, x: Math.round(CUT.cam.x), y: Math.round(CUT.cam.y) }));
  check(c1.world === 3 && c1.alive && c1.text.includes('旅行'), `月台那一段要在第三世界、乘客還活著（世界 ${c1.world}、字幕「${c1.text}」）`);
  const alive1 = await page.waitForFunction(() => Renderer.pax().list.every(p => p.state === 'alive'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(alive1, '月台那一段車上的乘客要是活的（睜著眼、膚色正常）');
  await shot('1-platform');
  await page.evaluate(() => { CUT.t = CUT2.wake + 1.5; });
  await sleep(1500);
  const c2 = await page.evaluate(() => ({ alive: CUT.alive, moving: CUT.moving, k: G.train.k, text: document.getElementById('cutText').textContent }));
  check(!c2.alive && c2.moving && c2.k > 0 && c2.text.includes('死了'), `醒來那一段乘客要死了、列車在開（字幕「${c2.text}」）`);
  const dead2 = await page.waitForFunction(() => Renderer.pax().list.every(p => p.state === 'dead'), null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(dead2, '醒來那一段車上的乘客要都死了（閉著眼、臉色灰白）');
  await shot('2-wake');
  await page.evaluate(() => { CUT.t = CUT2.end - 0.2; });
  await page.waitForFunction(() => mode === 'play', null, { timeout: 30000 });
  s = await state(page);
  check(s.day === 1 && s.phase === 'day' && s.hud, `動畫結束要進第三世界第 1 天早上（現在：${s.label}）`);
  check(await page.evaluate(() => w3Unlocked() && Object.keys(G.inv).length > 5), '第三世界要解鎖、背包要帶過去');
  await sleep(800);
  await shot('3-day1');
});

await scenario('w4', '第四世界第 1 天（?world=4&kit=1）：100×76 的大賣場、架上真的東西（拿起、放下再撿回來）、2×2 公尺的正方形板子疊高蓋牆圍成家、屋頂、早晨禮物在家的正中央、寒寂之境的蠟燭和檯燈取暖、斜放 45° 的牆、45° 斜坡接屋頂、屋頂底下跳會撞頭、自己爬貨架的梯子、電視、檯燈的光不穿牆、搬家具、背包 16 格、火爐、存檔讀檔、舊存檔', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=4&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  const s = await state(page);
  check(s.hud && s.day === 1 && s.phase === 'day', `要在第四世界第 1 天早上（現在：${s.label}）`);
  const info = await page.evaluate(() => ({ world: curWorld, w: MAP_W, h: MAP_H, loose: G.loose4.length, day: DAY_LEN, night: NIGHT_LEN, bag: bagUsed(), piles: FURN.filter(f => f.type === 'plankpile' && f.count > 0).length, staff: G.enemies.filter(e => e.kind === 'staff' && e.idle).length }));
  check(info.world === 4 && info.w === 100 && info.h === 76, `第四世界的地圖要是 100×76（世界 ${info.world}、${info.w}×${info.h}）`);
  check(info.day === 300 && info.night === 360, `白天 5 分鐘、晚上 6 分鐘（${info.day}／${info.night} 秒）`);
  check(info.loose >= 4 && info.piles >= 10, `入口旁邊的地上要有板子、倉儲區要有板材堆（地上 ${info.loose} 片、板材堆 ${info.piles} 堆）`);
  check(info.bag <= 16, `kit 帶的東西不能超過背包 16 格（${info.bag} 格）`);
  check(info.staff >= 2, `白天賣場裡要站著不動的店員（${info.staff} 隻）`);
  await page.evaluate(() => { G.t = 100; Object.assign(G.p, { x: 49.5, y: 61.5, face: -Math.PI / 2, pitch: 0 }); });
  await sleep(1500);
  await shot('1-store');
  // 架上真的東西（設計師：東西就直接是實體）：看著它按 E 拿起來；放在地上之後還能再撿回來；第四世界的燈泡叫「檯燈」
  const items = await page.evaluate(() => {
    const shelf = G.pickups.filter(pk => pk.s).length;
    const pk = G.pickups.find(p => p.s && FURN_BY_ID[p.s].type === 'goods4' && p.z < 1.2 && p.id !== 'coin');
    Object.assign(G.p, { x: pk.x + Math.cos(pk.a), y: pk.y + Math.sin(pk.a), face: pk.a + Math.PI, pitch: Math.atan2(pk.z + 0.1 - 1.5, 1) });
    const t = getTarget(), id = pk.id, n0 = G.inv[id] || 0;
    if (t && t.action) t.action();
    const took = (G.inv[id] || 0) > n0 || (G.hand && G.hand.id === id);
    // 放在地上，再看著它撿回來（背包先空出一格，撿回來才不會變成手上的第 17 個）
    G.hand = null;
    while (bagUsed() >= BAG_SLOTS) { const o = invList().find(x => x !== id); delete G.inv[o]; }
    G.inv[id] = Math.max(G.inv[id] || 0, 1); G.selId = id;
    const c0 = G.inv[id]; dropSelected4(false);
    const dropped = G.pickups.find(p => p.id === id && !p.s && Math.hypot(p.x - G.p.x, p.y - G.p.y) < 1.2);
    if (dropped) G.p.pitch = -Math.atan2(1.4, Math.max(0.05, Math.hypot(dropped.x - G.p.x, dropped.y - G.p.y)));
    const lp = lookedPickup4(); if (lp) takePickup4(lp.pk);
    const back = (G.inv[id] || 0) === c0;
    G.hand = null;
    return { shelf, label: t && t.label, took, dropped: !!dropped, back, lamp: bulbName(1), flash7: FLASH_TIERS[7].name };
  });
  check(items.shelf > 60, `架子上要擺著真的東西（${items.shelf} 個）`);
  check(items.took && items.label && items.label.startsWith('拿起'), `看著架上的東西按 E 要拿起來（「${items.label}」）`);
  check(items.dropped && items.back, `放在地上的東西要能再撿回來（放下 ${items.dropped}、撿回 ${items.back}）`);
  check(items.lamp.includes('檯燈') && items.flash7.startsWith('星晃'), `第四世界的燈泡叫檯燈、第 7 級手電筒叫星晃（${items.lamp}、${items.flash7}）`);
  // 撿地上的板子（E 的互動）→ 預覽是綠色 → 放下變成一面牆；第一次放牆會自動記成家
  const first = await page.evaluate(() => {
    const l = G.loose4[0];
    Object.assign(G.p, { x: l.x, y: l.y + 0.5, face: -Math.PI / 2, pitch: -0.6 });
    const t = getTarget();
    if (t && t.action) t.action();
    const held = G.hand && G.hand.k === 'plank';
    Object.assign(G.p, { x: 54.5, y: 71.5, face: 0, pitch: 0 }); G.bld.dist = 1.1;
    const g = ghost4(), n0 = G.b4.n;
    place4();
    return { label: t && t.label, held, ok: g && g.ok, kind: g && g.kind, placed: G.b4.n - n0, home: !!G.home, hand: G.hand };
  });
  check(first.held && first.label && first.label.includes('板子'), `對著地上的板子按 E 要拿起來（互動「${first.label}」）`);
  check(first.ok && first.kind === 'wall' && first.placed === 1 && first.home && !first.hand, `拿著板子按 E 要放下一面牆、記成家（預覽 ${first.kind}/${first.ok}、放了 ${first.placed} 片、家 ${first.home}）`);
  // 用 2×2 公尺的板子圍出 4×4 的家（x 51～54、y 69～72）：每面牆 2 片（西北是玻璃、南邊一扇對開的木門），上面蓋 4 片屋頂（屋頂是繞 X 轉 90°）
  const house = await page.evaluate(() => {
    const out = [];
    const put = (tier, door, pos, rx = 0) => {
      holdThing({ k: 'plank', tier, door });
      Object.assign(G.p, pos); Object.assign(G.bld, { dist: 1.1, rx, ry: 0, rz: 0 });
      const g = ghost4(); out.push(g && g.ok ? '' : `${JSON.stringify(pos)}:${g && g.why}`);
      place4();
      if (G.hand) G.hand = null;
    };
    put(1, false, { x: 52, y: 69 - 1.1, face: Math.PI / 2 }); put(2, false, { x: 54, y: 69 - 1.1, face: Math.PI / 2 });     // 北
    put(3, false, { x: 52, y: 73 - 1.1, face: Math.PI / 2 }); put(1, true, { x: 54, y: 73 - 1.1, face: Math.PI / 2 });      // 南（門）
    put(5, false, { x: 51 - 1.1, y: 70, face: 0 }); put(4, false, { x: 51 - 1.1, y: 72, face: 0 });                        // 西（玻璃）
    put(1, false, { x: 55 - 1.1, y: 70, face: 0 }); put(2, false, { x: 55 - 1.1, y: 72, face: 0 });                        // 東
    for (const x of [52, 54]) for (const y of [70, 72]) put(1, false, { x, y: y + 1.1, face: -Math.PI / 2 }, 90);
    Object.assign(G.p, { x: 52.6, y: 70.6, face: 0 });
    const door = stackAt('h', 53, 73), span = door && door[0].door && stackAt('h', 54, 73) === door;
    return { bad: out.filter(Boolean), walls: G.b4.n, roofs: roofList4().length, cells: G.b4.roofs.size, home: atHome4(), cover: sheltered4(G.p.x, G.p.y), span };
  });
  check(house.bad.length === 0, '每片板子都要放得下：' + house.bad.join('；'));
  check(house.walls === 9 && house.roofs === 4 && house.cells === 16, `要有 9 片 2×2 公尺的板子（8 片牆、1 片第一片）、4 片屋頂蓋住 16 格（${house.walls}／${house.roofs}／${house.cells}）`);
  check(house.span, '一片板子（門）要橫跨兩個格子的邊');
  check(house.home && house.cover, `站在圍起來、有屋頂的地方要算「在家裡」、淋不到雨（在家 ${house.home}、遮著 ${house.cover}）`);
  // 早晨禮物放在家的正中央（設計師）
  const gift = await page.evaluate(() => { G.home = { x: 51.5, y: 69.5 }; const c = homeCenter4(); return c && [c.x, c.y]; });
  check(gift && Math.abs(gift[0] - 53) <= 0.6 && Math.abs(gift[1] - 71) <= 0.6, `早晨禮物要放在家的正中央（${JSON.stringify(gift)}，家是 51～54、69～72）`);
  // 檯燈：選燈泡按 Q 會在前面放一盞檯燈；家裡的燈不會穿過牆照到外面（玻璃透光）
  const lamp = await page.evaluate(() => {
    Object.assign(G.p, { x: 52.5, y: 71.0, face: -Math.PI / 2 }); G.selId = 'bulb5';
    const n0 = G.lamps.length; useSelected(); buildLights();
    const L = G.lamps[G.lamps.length - 1];
    return { placed: G.lamps.length - n0, free: !!(L && L.free), inside: lightAt4(52.5, 69.5, 0), outsideWood: lightAt4(55.5, 69.5, 0), outsideGlass: lightAt4(50.5, 69.5, 0) };
  });
  check(lamp.placed === 1 && lamp.free, `選燈泡按 Q 要放一盞檯燈（放了 ${lamp.placed} 盞）`);
  check(lamp.inside > 0.1 && lamp.outsideWood === 0 && lamp.outsideGlass > 0, `家裡的燈不能穿過牆照到外面，玻璃要透光（裡面 ${lamp.inside.toFixed(2)}、木牆外 ${lamp.outsideWood.toFixed(2)}、玻璃外 ${lamp.outsideGlass.toFixed(2)}）`);
  // 寒寂之境：手上拿著蠟燭、躺在家裡的床上、亮著的檯燈旁邊，體溫都會回升（設計師）
  const warm = await page.evaluate(() => {
    const save = { cold: G.cold, sel: G.selId };
    G.cold = true; Object.assign(G.p, { x: 47.5, y: 66.5, temp: 50 });
    const t0 = G.p.temp; updateTemp4(1); const out = G.p.temp - t0;
    G.inv.candle = Math.max(G.inv.candle || 0, 1); G.selId = 'candle';
    const c0 = G.p.temp; updateTemp4(1); const candle = G.p.temp - c0;
    G.selId = save.sel;
    Object.assign(G.p, { x: 52.5, y: 70.4 }); const l0 = G.p.temp; updateTemp4(1); const lamp = G.p.temp - l0;
    G.cold = save.cold;
    return { out, candle, lamp };
  });
  check(warm.out < 0 && warm.candle > 0 && warm.lamp > 0, `寒寂之境：在賣場裡體溫往下掉、拿著蠟燭和在亮著的檯燈旁邊要回升（${JSON.stringify(warm)}）`);
  await page.evaluate(() => { Object.assign(G.p, { x: 56.2, y: 64.6, face: Math.PI / 2 + 0.55, pitch: -0.12 }); });
  await sleep(1500);
  await shot('2-house');
  // 搬家具：按住 E 拿起椅子，放在別的地方（3D 模型跟著重建）
  const chair = await page.evaluate(() => {
    const f = FURN.find(f => f.type === 'chair4' && !(zoneAt(f.x, f.y) || {}).cube);
    takeFurn4(f);
    const held = G.hand && G.hand.f === f;
    Object.assign(G.p, { x: 56.5, y: 70.5, face: 0 }); G.bld.dist = 1.4;
    const g = ghost4(); place4();
    return { held, ok: g && g.ok, x: f.x, y: f.y, solid: solid[f.y][f.x], hand: G.hand };
  });
  check(chair.held && chair.ok && chair.x === 57 && chair.y === 70 && chair.solid && !chair.hand, `椅子要能搬到別的地方（拿起 ${chair.held}、放在 ${chair.x},${chair.y}）`);
  // 背包 16 格：滿了以後新的東西只能拿在手上（第 17 個）；手上拿著板子就拿不了
  const bag = await page.evaluate(() => {
    const extra = Object.keys(ITEMS).filter(id => !G.inv[id] && ITEMS[id].kind === 'food');
    for (const id of extra) { if (bagUsed() >= BAG_SLOTS) break; addItem(id, 1); }
    const other = Object.keys(ITEMS).find(id => !G.inv[id] && ITEMS[id].kind === 'food');
    const full = bagUsed(), fitsEmpty = bagFits(other);
    holdThing({ k: 'plank', tier: 1 });
    const fitsHolding = bagFits(other);
    G.hand = null;
    return { full, fitsEmpty, fitsHolding };
  });
  check(bag.full === 16 && bag.fitsEmpty && !bag.fitsHolding, `背包 16 格滿了：空手還能拿第 17 個、拿著板子就不行（${bag.full} 格、空手 ${bag.fitsEmpty}、拿著板子 ${bag.fitsHolding}）`);
  // 火爐：丟木柴進去會燒、會發光、旁邊會暖
  const fire = await page.evaluate(() => {
    const f = FURN.find(f => f.type === 'fireplace4');
    G.inv.wood = Math.max(G.inv.wood || 0, 1);
    fuelFire4(f, 'wood'); buildLights();
    return { left: fireLeft4(f), lit: G.lights.some(L => L.fire), heat: heat4(f.x + 1, f.y + 1.5) };
  });
  check(fire.left > 0 && fire.lit && fire.heat > 0, `火爐丟木柴要會燒、發光、旁邊溫暖（還能燒 ${fire.left} 秒、火光 ${fire.lit}、暖 ${fire.heat}）`);
  // 存檔讀檔：牆、屋頂、搬過的家具、家都要留著
  const sv = await page.evaluate(() => {
    const data = JSON.parse(JSON.stringify(save4()));
    load4(data);
    const f = FURN.find(f => f.type === 'chair4' && f.x === 57 && f.y === 70);
    return { walls: G.b4.n, roofs: roofList4().length, chair: !!f, home: !!G.home, glass: G.b4.list.some(w => w.tier === 5 && w.hp === Infinity), door: G.b4.list.some(w => w.door), loose: G.loose4.length };
  });
  check(sv.walls === 9 && sv.roofs === 4 && sv.chair && sv.home && sv.glass && sv.door, `存檔讀回來牆、屋頂、家具、家都要在（${JSON.stringify(sv)}）`);
  // 斜放的牆（XYZ 也要有分 15°、45°、90°）：一次轉 45°，放下去是斜的、擋得住人，存檔讀回來還是斜的；吹口哨會看到紅點
  const free = await page.evaluate(() => {
    holdThing({ k: 'plank', tier: 1 });
    Object.assign(G.p, { x: 49.5, y: 64.5, face: -Math.PI / 2, pitch: 0 }); Object.assign(G.bld, { dist: 1.5, step: 45, axis: 'y' });
    rotateHand();
    const g = ghost4(); place4();
    const w = G.b4.list.find(w => w.free);
    const hit = w ? hitsWall4(w.cx, w.cy, PLAYER_R) : false;
    const back = w ? (load4(JSON.parse(JSON.stringify(save4()))), G.b4.list.some(x => x.free && Math.abs(x.ang - w.ang) < 0.01)) : false;
    const e = spawnEnemy('mimic', { x: 49.5, y: 55.5 }); if (e) e.spawn = 0;
    whistle4();
    return { kind: g && g.kind, ok: g && g.ok, deg: w ? Math.round(w.ang * 180 / Math.PI) : null, hit, back, dots: whistleDots4().filter(d => d.red).length };
  });
  check(free.kind === 'free' && free.ok && free.deg % 90 !== 0 && free.hit && free.back, `一次轉 45° 要放得下斜的牆、擋得住人、存檔讀回來（${JSON.stringify(free)}）`);
  check(free.dots > 0, `吹口哨要看到怪物的紅點（${free.dots} 個）`);
  // 2×2 公尺的板子往上疊（跟人一樣高，跳不過去）、45° 的斜坡接屋頂再接斜坡、屋頂底下跳會撞到頭、貨架的梯子要自己爬、第 6 級以上的燈泡是電視
  const sq = await page.evaluate(() => {
    const put = (tier, pos, rx = 0) => { holdThing({ k: 'plank', tier }); Object.assign(G.p, pos); Object.assign(G.bld, { dist: 1.0, rx, ry: 0, rz: 0 }); const g = ghost4(); place4(); G.hand = null; return g; };
    const a = put(1, { x: 44.3, y: 54.5, face: 0 }), b = put(1, { x: 44.3, y: 54.5, face: 0 });
    const s1 = stackAt('v', 45, 54), lvs = s1 ? s1.map(p => p.lv) : [];
    removeWall(s1[1]);
    moveWho = G.p; G.p.z = 0; const low = hitsWall4(45.05, 54.5, PLAYER_R); G.p.z = 1.2; const over = hitsWall4(45.05, 54.5, PLAYER_R); G.p.z = 2.1; const above = hitsWall4(45.05, 54.5, PLAYER_R); moveWho = null; G.p.z = 0;
    // 斜坡（2×2 格、升高 2 公尺）→ 屋頂（2 公尺高）→ 屋頂上再一片斜坡（2～4 公尺），走上去
    const r = [put(2, { x: 49.5, y: 56.5, face: -Math.PI / 2 }, 45), put(2, { x: 49.5, y: 54.5, face: -Math.PI / 2 }, 90), put(2, { x: 49.5, y: 52.5, face: -Math.PI / 2 }, 45)];
    Object.assign(G.p, { x: 49.5, y: 58.3, face: -Math.PI / 2, z: 0, vz: 0 });
    let top = 0; for (let i = 0; i < 120; i++) { keys.w = true; updatePlayer(0.05); top = Math.max(top, G.p.z); } keys.w = false;
    // 屋頂底下跳：頭撞到屋頂
    Object.assign(G.p, { x: 49.5, y: 54.0, z: 0, vz: 0 }); tryJump(); let head = 0; for (let i = 0; i < 20; i++) { updatePlayer(0.05); head = Math.max(head, G.p.z); }
    // 梯子：按 E 抓住倉儲貨架的梯子；不推就停著（要自己爬），往前推往上爬，按跳放手會掉下來，再抓住爬到頂
    const L = ladderList4().find(l => l.f.type === 'rack4');
    const grab = () => { Object.assign(G.p, { x: L.base.x, y: L.base.y, z: 0, vz: 0, face: Math.atan2(L.edge.y - L.base.y, L.edge.x - L.base.x), pitch: 0.2 }); const t = getTarget(); if (t && t.action) t.action(); return t; };
    const t = grab();
    for (let i = 0; i < 10; i++) updatePlayer(0.05);
    const idle = { on: !!(ride && ride.climb), z: G.p.z };
    keys.w = true; for (let i = 0; i < 20; i++) updatePlayer(0.05); keys.w = false;
    const mid = G.p.z;
    tryJump(); const letGo = !ride; for (let i = 0; i < 30; i++) updatePlayer(0.05);
    const fell = G.p.z;
    grab(); keys.w = true; for (let i = 0; i < 200 && ride; i++) updatePlayer(0.05); keys.w = false;
    for (let i = 0; i < 5; i++) updatePlayer(0.05);
    const rackZ = G.p.z;
    Object.assign(G.p, { x: 49.5, y: 66.5, z: 0, vz: 0 });
    const jumpVis = getComputedStyle(document.querySelector('#tbtns .tb.jump')).visibility;
    return { jumpVis, lvs, kinds: [a.lv, b.lv], low, over, above, ramps: r.map(g => g && g.ok && (g.kind === 'ramp' ? g.lv : g.kind)), top, head, climb: t && t.label, idle, mid, letGo, fell, rackZ, tv: bulbName(7), lamp: bulbName(3) };
  });
  check(JSON.stringify(sq.lvs) === '[0,2]' && sq.low && sq.over && !sq.above, `2×2 公尺的板子要往上疊（${JSON.stringify(sq.lvs)}）、跟人一樣高：跳起來也越不過去、站在 2 公尺高的地方才過得去（地上 ${sq.low}、跳起來 ${sq.over}、2 公尺 ${sq.above}）`);
  check(JSON.stringify(sq.ramps) === '[0,"roof",2]' && sq.top > 3.9, `45° 的斜坡要接到屋頂、屋頂上再接斜坡（${JSON.stringify(sq.ramps)}），走得上去（最高 ${sq.top.toFixed(2)} 公尺）`);
  check(sq.head < 0.3, `在屋頂底下跳，頭要撞到屋頂（腳最高 ${sq.head.toFixed(2)} 公尺）`);
  check(sq.climb && sq.climb.includes('抓住梯子') && sq.idle.on && sq.idle.z < 0.05 && sq.mid > 1, `梯子要自己爬：按 E 抓住、不推就停著、往前推才往上爬（「${sq.climb}」、停著 ${JSON.stringify(sq.idle)}、爬了 ${sq.mid.toFixed(2)} 公尺）`);
  check(sq.letGo && sq.fell < 0.05, `抓著梯子按跳要放手、掉下來（放手 ${sq.letGo}、高度 ${sq.fell.toFixed(2)}）`);
  check(Math.abs(sq.rackZ - 5.2) < 0.05, `貨架的梯子要爬得上去（高度 ${sq.rackZ}）`);
  check(sq.jumpVis === 'visible', `第四世界平板要有跳的按鈕（${sq.jumpVis}）`);
  check(sq.tv.endsWith('電視') && sq.lamp.endsWith('檯燈'), `第 6 級以上的燈泡在第四世界是電視、以下是檯燈（${sq.tv}、${sq.lamp}）`);
  // 舊的小賣場存檔（60×44）：蓋的板子要堆在入口旁邊、家要重記，不能壞掉
  const old = await page.evaluate(() => {
    load4({ walls: [['h', 31, 38, 1, 40, 0, 0], ['v', 31, 38, 2, 100, 0, 0]], roofs: [[31, 38, 1, 40]], home: { x: 31.5, y: 38.5 }, loose: [[30, 39, 3, 0]], furn: [] });
    return { walls: G.b4.n, loose: G.loose4.length, home: G.home, x: G.p.x, y: G.p.y, ok: walkable(G.p.x, G.p.y) };
  });
  check(old.walls === 0 && old.loose === 3 && !old.home && old.ok, `舊的小賣場存檔：板子要換算成大板子堆在入口旁邊、家要重記（${JSON.stringify(old)}）`);
  // 2026/11/01 上午以前的存檔：蓋的板子（1 公尺的小板子 4 片、2.6 公尺的長板子 2 片換 1 片大板子，門一扇換一扇）退回來放在家旁邊的地上
  const v2 = await page.evaluate(() => {
    load4({ mv: W4_MAP_VER, walls: [['h', 51, 69, 2, 100, 0, 0], ['v', 51, 69, 1, 40, 1, 0]], roofs: [], furn: [], home: { x: 51.5, y: 69.5 } });
    const a = { n: G.b4.n, loose: G.loose4.map(l => l.tier + (l.door ? 'd' : '')).sort().join() };
    load4({ mv: W4_MAP_VER, sq: 1, walls: [1, 2, 3, 4, 5].map(i => ['h', 50 + i, 69, 1, 20, 0, 0, 0, 0, 0]), roofs: [[51, 70, 1, 20], [52, 70, 1, 20]], furn: [], home: { x: 51.5, y: 69.5 } });
    const near = G.loose4.every(l => Math.hypot(l.x - 51.5, l.y - 69.5) < 5 && walkable(l.x, l.y));
    return { a, b: { n: G.b4.n, loose: G.loose4.length, near } };
  });
  check(v2.a.n === 0 && v2.a.loose === '1d,2', `2.6 公尺長板子的存檔：2 片換 1 片大板子、門一扇換一扇（${JSON.stringify(v2.a)}）`);
  check(v2.b.n === 0 && v2.b.loose === 2 && v2.b.near, `1 公尺小板子的存檔：4 片換 1 片大板子，放在家旁邊（${JSON.stringify(v2.b)}）`);
});

await scenario('w4night', '第四世界的晚上（?world=4&night=2&kit=1）：燈熄了、店員巡邏、怪物打破木牆、玻璃打不破；照設計圖重做的 5 隻新怪物和神秘店員排一排（手電筒第 7 級星晃）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=4&night=2&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await page.evaluate(() => { G.t = DAY_LEN - 0.05; });
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  await sleep(800);
  const n = await page.evaluate(() => ({ staff: G.enemies.filter(e => e.kind === 'staff').map(e => e.idle ? 'idle' : e.state), dark: darkLevel() }));
  check(n.staff.length >= 2 && !n.staff.includes('idle'), `天黑以後店員要開始巡邏（${n.staff.join(',')}）`);
  check(n.dark > 0.5, `賣場的燈要熄掉（暗度 ${n.dark.toFixed(2)}）`);
  // 擋路的木牆：店員走不過去就會打，打到破掉；玻璃牆打不破，路線會繞開
  const bash = await page.evaluate(() => {
    G.enemies = []; G.ev.schedule = [];
    Object.assign(G.p, { x: 50.5, y: 45.5, face: -Math.PI / 2, inv: 999, hp: 100 });
    // 把玩家圍在主走道的一格裡（四面木頭板子），店員從北邊過來
    for (const [o, x, y] of [['h', 50, 45], ['h', 50, 46], ['v', 50, 45], ['v', 51, 45]]) setWall({ o, x, y, tier: 1, hp: 40, door: false, open: false });
    const e = Object.assign(spawnEnemy('staff', { x: 50.5, y: 41.5 }), { spawn: 0, state: 'chase', idle: false, lx: G.p.x, ly: G.p.y });
    const hp0 = G.b4.list.map(w => w.hp).reduce((a, b) => a + b, 0);
    for (let i = 0; i < 400 && G.b4.n === 4; i++) { updateEnemies(0.05); }
    const hp1 = G.b4.list.map(w => w.hp).reduce((a, b) => a + b, 0);
    return { broke: G.b4.n < 4, hp0, hp1, ahead: !!e.wallAhead || G.b4.n < 4 };
  });
  check(bash.broke || bash.hp1 < bash.hp0, `店員要打擋路的木牆（耐打 ${bash.hp0} → ${bash.hp1}、打破 ${bash.broke}）`);
  const glass = await page.evaluate(() => {
    for (const w of [...G.b4.list]) removeWall(w);
    const gw = { o: 'h', x: 50, y: 45, tier: 5, hp: Infinity, door: false, open: false };
    setWall(gw);
    const e = G.enemies[0] || spawnEnemy('staff', { x: 50.5, y: 43.5 });
    e.wallAhead = gw; Object.assign(e, { x: 50.5, y: 44.7 });
    for (let i = 0; i < 60; i++) bash4(e, 0.1);
    return { hp: gw.hp, cost: edgeCost4(50, 44, 50, 45, '') };
  });
  check(glass.hp === Infinity && glass.cost === Infinity, `玻璃牆要打不破、尋路不能穿過（耐打 ${glass.hp}、通過代價 ${glass.cost}）`);
  // 怪物排一排：玩家站在主走道上往北看
  const lineup = await page.evaluate(() => {
    for (const w of [...G.b4.list]) removeWall(w);
    G.enemies = []; G.ev.schedule = [];
    Object.assign(G.p, { x: 49.9, y: 52.5, face: -Math.PI / 2, pitch: 0.12, inv: 999, flashLv: 7, bat: 100 });
    const put = (kind, x, y, extra) => Object.assign(spawnEnemy(kind, { x, y }), { spawn: 0, pose: true, face: Math.PI / 2, state: 'idle' }, extra);
    put('staff', 47.6, 47.5); put('shake', 48.9, 47.3, { awake: true }); put('mimic', 50.4, 47.5); put('hubert', 52.2, 47.2); put('ember', 49.9, 44.0);
    G.t = Math.max(G.t, 1); G.stock = G.stock && G.stock.length ? G.stock : [['battery', 3]];
    return G.enemies.length;
  });
  check(lineup === 5, `要放好 5 隻第四世界的怪物（${lineup}）`);
  await page.evaluate(() => { document.getElementById('hud').style.opacity = '0'; });
  await sleep(1500);
  const alive = await page.evaluate(() => G.enemies.map(e => e.kind));
  check(alive.length === 5, `擺姿勢的怪物不能自己消失（剩 ${alive.join(',')}）`);
  await shot('1-lineup-dark');
  await page.keyboard.press('f');
  await sleep(1500);
  check((await state(page)).flash === true, '按 F 要打開手電筒');
  await shot('2-lineup-flash7');
  // 神秘店員：白天在賣場的某個地方（黃色雨衣、帽兜裡兩點眼睛）
  await page.evaluate(() => { G.phase = 'day'; G.t = 100; G.enemies = []; Object.assign(MERCHANT_POS, { x: 49.9, y: 47.6 }); Object.assign(G.p, { x: 49.9, y: 50.3, face: -Math.PI / 2, pitch: 0.05, flash: false }); });
  await sleep(1800);
  await shot('3-clerk');
});

await scenario('w4wx', '第四世界的天氣（寒寂之境下雪、酸雨、紅月長草）、燈泡圖鑑（燈泡、手電筒 1～7 級、板子五級）、生物圖鑑的第四世界', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=4&night=3&kit=1&cold', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(1500);
  const cold = await page.evaluate(() => { G.phase = 'day'; G.t = 100; Object.assign(G.p, { x: 49.5, y: 61.5, face: -Math.PI / 2, pitch: 0.2 }); const t0 = G.p.temp; for (let i = 0; i < 40; i++) updateTemp4(0.25); return { cold: G.cold, t0, t1: G.p.temp }; });
  await sleep(1500);
  cold.bar = await page.evaluate(() => !document.getElementById('tempBar').classList.contains('hidden'));
  check(cold.cold && cold.t1 < cold.t0 && cold.bar, `寒寂之境：體溫要往下掉、要顯示體溫條（${cold.t0} → ${cold.t1}、體溫條 ${cold.bar}）`);
  await shot('1-snow');
  // 酸雨：沒遮著會扣血；屋頂底下淋不到
  const acid = await page.evaluate(() => {
    G.cold = false;
    G.acid = { day: G.day, night: false, at: 0, dur: 90, started: true, warned: true }; G.acidT = 90;
    Object.assign(G.p, { x: 49.5, y: 61.5, hp: 100, inv: 0 });
    for (let i = 0; i < 20; i++) updateAcid4(0.1);
    const hpOut = G.p.hp;
    G.b4.roofs.set('49,61', { x: 49, y: 61, tier: 1, hp: 40 }); G.b4.ver++;
    G.p.hp = 100;
    for (let i = 0; i < 20; i++) updateAcid4(0.1);
    return { on: acidOn4(), hpOut, hpIn: G.p.hp };
  });
  check(acid.on && acid.hpOut < 100 && acid.hpIn === 100, `酸雨：沒遮著要扣血、屋頂底下不會（外面 ${acid.hpOut.toFixed(1)}、屋頂下 ${acid.hpIn}）`);
  await page.evaluate(() => { G.b4.roofs.clear(); G.b4.ver++; });
  await sleep(1500);
  await shot('2-acid');
  // 紅月：賣場的地上長出草
  await page.evaluate(() => { G.acid = null; G.acidT = 0; G.phase = 'night'; G.t = 10; G.ev.blood = true; awaken4(); Object.assign(G.p, { flash: true, bat: 100 }); });
  await sleep(1800);
  check(await page.evaluate(() => G.grass4 === true), '紅月的晚上地上要長草');
  await shot('3-redmoon');
  // 燈泡圖鑑：三個分頁（燈泡、手電筒 1～7 級、板子五級）
  await page.evaluate(() => { mode = 'paused'; openBulbBook('hud'); });
  await sleep(600);
  const bb = {};
  for (const t of ['bulb', 'flash', 'plank']) {
    await page.click(`#bulbTabs button[data-t="${t}"]`);
    await sleep(300);
    bb[t] = await page.evaluate(() => document.querySelectorAll('#bulbList .bcardx').length);
    if (t === 'flash') await shot('4-bulbbook-flash');
  }
  check(bb.bulb === 15 && bb.flash === 7 && bb.plank === 5, `燈泡圖鑑要有 15 種燈泡、7 級手電筒、5 級板子（${JSON.stringify(bb)}）`);
  // 手電筒 4～7 級的卡片邊框會閃（跟生物圖鑑的閻羅、酆都級一樣）
  await page.click('#bulbTabs button[data-t="flash"]');
  const blink = await page.evaluate(() => { for (let lv = 4; lv <= 7; lv++) markFlash(lv); showBulbPage('flash'); return [...document.querySelectorAll('#bulbList .bcardx')].filter(el => el.style.animation.includes('flk')).length; });
  check(blink === 4, `手電筒第 4～7 級的卡片邊框要會閃（${blink} 張）`);
  // 生物圖鑑的第四世界：見過之後是 3D 模型
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#btnBook');
  await page.evaluate(() => { unlockW4(); for (const m of BESTIARY) markSeen(m.kind || 'f:' + m.flower); });
  await page.click('#btnBook');
  await sleep(800);
  await page.click('#bookTabs button[data-w="4"]');
  await sleep(2500);
  const bk = await page.evaluate(() => ({ cards: document.querySelectorAll('#bookList .card').length, stages: document.querySelectorAll('#bookList .stage:not(.unseen)').length }));
  check(bk.cards >= 5 && bk.stages === bk.cards, `生物圖鑑的第四世界要有新怪物的 3D 卡片（${bk.stages}/${bk.cards}）`);
  await shot('5-book4');
});

await scenario('cut3', '第三到第四世界（?cut=3）：第三世界的結局、「走進賣場」、日光燈一排一排亮起來、進第四世界第 1 天', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?cut=3', { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => { if (CUT) CUT.t = 5.6; });
  await page.waitForFunction(() => mode === 'over', null, { timeout: 30000 });
  check(await page.evaluate(() => !document.getElementById('btnNextWorld').classList.contains('hidden') && w4Unlocked()), '第三世界的結局要有「走進賣場」的按鈕、第四世界要解鎖');
  await shot('1-ending3');
  await page.click('#btnNextWorld');
  await page.waitForFunction(() => mode === 'cutscene' && CUT && CUT.kind === 4, null, { timeout: 15000 });
  await page.evaluate(() => { CUT.t = CUT4.lights + 1.2; });
  await sleep(1500);
  const c = await page.evaluate(() => ({ world: curWorld, text: document.getElementById('cutText').textContent }));
  check(c.world === 4 && c.text.includes('燈'), `動畫要在第四世界、燈一排一排亮起來（世界 ${c.world}、字幕「${c.text}」）`);
  await shot('2-lights');
  await page.evaluate(() => { CUT.t = CUT4.end - 0.1; });
  await page.waitForFunction(() => mode === 'play', null, { timeout: 30000 });
  const s = await state(page);
  check(s.day === 1 && s.phase === 'day' && s.hud, `動畫結束要進第四世界第 1 天早上（現在：${s.label}）`);
  check(await page.evaluate(() => curWorld === 4 && bagUsed() > 0), '要進第四世界、背包要帶過去');
});

await scenario('net', '跟朋友一起玩（?nettest：同一個瀏覽器開兩個分頁，用 BroadcastChannel 互連，不用上網）：遊戲中開房間、用代碼加入、客人進到房主的世界和天數、時間對齊、看得到彼此的 3D 人物和手電筒、自訂事件（大訊息切塊）、換白天晚上、客人倒下天亮時醒來、客人的存檔不變、暫停同步（有人暫停大家都暫停、寫著是誰、誰按繼續大家一起繼續、開書包不算暫停）、切到別的 App 時藏起人物、離開房間（人物馬上消失）、在主選單等房主開始、關掉分頁馬上算離開、第四世界一起蓋房子（板子、家具、架上的東西、斜坡同步）、怪物同步（交給離牠最近的人算、打朋友算的怪物、用手電筒照，第一和第四世界）', { limit: 300000 }, async ({ page, ctx, shot, check }) => {
  // 房主用測試版（不存檔，不會蓋掉客人的存檔；兩個分頁共用 localStorage），客人用正式版
  const guest = await ctx.newPage();
  guest.on('pageerror', e => check(false, '客人的分頁 JS 錯誤：' + e.message));
  guest.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) check(false, '客人的分頁 console 錯誤：' + m.text()); });
  const gshot = label => guest.screenshot({ path: path.join(OUT, `net-${label}.png`) });
  const SAVE = JSON.stringify({ v: 1, day: 3, diff: 'easy', world: 1, p: { x: 19.5, y: 23, hp: 100, san: 100, hunger: 100, bat: 100, flashLv: 1 }, inv: { bulb1: 1 }, sockets: [], lamps: [], containers: {}, stats: { searched: 0, dissolved: 0, bestTier: 1 } });
  await guest.goto(BASE + '?nettest', { waitUntil: 'load' });
  await guest.evaluate(s => { localStorage.setItem('home99_save_v1', s); localStorage.removeItem('home99_progress_v1'); }, SAVE);
  await page.goto(BASE + 'test.html?world=4&night=2&nettest', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play' && curWorld === 4, null, { timeout: 60000 });   // 電腦很忙的時候蓋賣場會超過 30 秒
  await page.evaluate(() => { G.t = 40; Object.assign(G.p, { ...W4.start, pitch: 0 }); });   // 第 2 天的白天
  // 房主：遊戲中按暫停 →「👥 朋友」→「開房間」
  await page.evaluate(() => pauseGame());
  await page.click('#btnPauseFriends');
  await page.click('#fHost');
  await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('fRoomCode').textContent), null, { timeout: 10000 });
  const code = await page.evaluate(() => document.getElementById('fRoomCode').textContent);
  check(!/[01OI]/.test(code), `房間代碼不能有 0、O、1、I（${code}）`);
  await shot('1-room');
  await page.click('#fResume');
  // 客人：主選單「👥 朋友」→ 取名字、選女生 → 輸入代碼 → 加入
  await guest.reload({ waitUntil: 'load' });
  await guest.waitForSelector('#btnFriends');
  await guest.click('#btnFriends');
  check(await guest.evaluate(() => document.getElementById('fOffline').classList.contains('hidden')), '測試用的本機連線要能用（不能顯示「沒有網路」）');
  await guest.fill('#fName', '小明');
  await guest.click('#fLook button[data-look="f"]');
  await guest.fill('#fCode', code.toLowerCase());
  check(await guest.evaluate(c => document.getElementById('fCode').value === c, code), '輸入的代碼要自動變成大寫');
  await guest.click('#fJoin');
  // 房主這時可能是暫停的（例如切到別的分頁）：客人進來也會是暫停畫面，房主按繼續就大家一起繼續
  await guest.waitForFunction(() => (mode === 'play' || mode === 'pause') && curWorld === 4 && Net.ready, null, { timeout: 60000 });
  await page.evaluate(() => { if (mode === 'pause') resumeGame(); });
  // 客人剛進來要蓋房主的整個賣場（沒有 GPU 時會卡十幾秒），多等一下
  await guest.waitForFunction(() => mode === 'play', null, { timeout: 20000 }).catch(async () => check(false, `房主按繼續，剛進來的客人也要一起繼續（房主 ${await page.evaluate(() => mode)}、客人 ${await guest.evaluate(() => mode)}）`));
  await page.waitForFunction(() => Net.friends().some(f => f.ingame && f.world === 4), null, { timeout: 15000 }).catch(() => {});
  await guest.waitForFunction(() => Net.friends().some(f => f.ingame && f.world === 4), null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  const hs = await page.evaluate(() => ({ t: G.t, day: G.day, net: Net.isHost && Net.active, fr: Net.friends(), roster: Net.roster().map(r => r.name) }));
  const gs = await guest.evaluate(() => ({ t: G.t, day: G.day, phase: G.phase, world: curWorld, guest: Net.guest, ready: Net.ready, fr: Net.friends(), name: Net.name, inv: Object.keys(G.inv).length }));
  check(gs.guest && gs.ready && gs.world === 4 && gs.day === 2 && gs.phase === 'day', `客人要進到房主的世界和天數（第 ${gs.world} 世界、第 ${gs.day} 天 ${gs.phase}）`);
  check(Math.abs(gs.t - hs.t) < 2, `客人的時間要跟房主對齊（房主 ${hs.t.toFixed(1)}、客人 ${gs.t.toFixed(1)} 秒）`);
  check(hs.net && hs.roster.includes('小明') && hs.fr.some(f => f.name === '小明' && f.ingame && f.world === 4), `房主要看得到客人（${JSON.stringify(hs.roster)}；${JSON.stringify(hs.fr)}）`);
  check(gs.fr.some(f => f.host && f.ingame && f.world === 4), '客人要看得到房主');
  check(gs.inv > 0, '客人要有新遊戲的起始物品');
  // 自訂事件：客人 → 房主、房主 → 客人（3 萬字的大訊息要自動切塊再拼回來）
  await page.evaluate(() => { window.__got = []; Net.on('hi', (d, from) => window.__got.push({ d, from })); });
  await guest.evaluate(() => { window.__got = []; Net.on('big', d => window.__got.push(d)); Net.send('hi', { n: 7, s: '你好' }); });
  const gid = await guest.evaluate(() => Net.myId);
  await page.evaluate(id => Net.sendTo(id, 'big', { s: 'x'.repeat(30000) + '完' }), gid);
  await sleep(800);
  const ev1 = await page.evaluate(() => window.__got), ev2 = await guest.evaluate(() => window.__got);
  check(ev1.length === 1 && ev1[0].d.n === 7 && ev1[0].d.s === '你好' && ev1[0].from === gid, `房主要收到客人的自訂事件（${JSON.stringify(ev1).slice(0, 80)}）`);
  check(ev2.length === 1 && ev2[0].s.length === 30001 && ev2[0].s.endsWith('完'), `客人要收到房主送的大訊息（收到 ${ev2.length} 則）`);
  // 兩個人面對面站著，客人開手電筒：兩邊的 3D 畫面都要有對方的人物
  await page.evaluate(() => Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 3.5, face: -Math.PI / 2, pitch: 0.05 }));
  await guest.evaluate(() => { Object.assign(G.p, { x: W4AX + 0.8, y: W4H - 6.3, face: Math.PI / 2 + 0.25, pitch: -0.05, flash: true, bat: 100 }); });
  await sleep(2000);
  for (const pg of [page, guest]) await pg.waitForFunction(() => Renderer.friends().some(r => r.visible), null, { timeout: 10000 }).catch(() => {});
  const r3 = await page.evaluate(() => Renderer.friends()), r3g = await guest.evaluate(() => Renderer.friends());
  check(r3.length === 1 && r3[0].visible && r3[0].meshes >= 15, `房主的畫面要有客人的人物（${JSON.stringify(r3)}）`);
  const near = await page.evaluate(() => { const f = Renderer.friends()[0]; return f && Math.hypot(f.x - (W4AX + 0.8), f.y - (W4H - 6.3)); });
  check(near !== undefined && near < 0.6, `客人的人物要在客人的位置（差 ${near && near.toFixed(2)} 格）`);
  check(r3.length === 1 && r3[0].beam, '客人開手電筒，房主要看得到光束');
  check(r3g.length === 1 && r3g[0].visible, `客人的畫面要有房主的人物（${JSON.stringify(r3g)}）`);
  await shot('2-host-sees-guest');
  await gshot('3-guest-sees-host');
  // 朋友的人物：網格不能太多（平板要順）；房主走近一點、從斜前方看客人的細節（衣服、手、手電筒、球鞋、頭髮）
  check(r3.length === 1 && r3[0].meshes <= 24, `朋友的人物網格太多了（${r3[0] && r3[0].meshes} 個）`);
  await page.evaluate(() => Object.assign(G.p, { x: W4AX + 2.0, y: W4H - 4.9, face: Math.atan2(-1.4, -1.2), pitch: -0.4 }));
  await sleep(1500);
  await shot('2b-guest-close');
  // 客人切到別的 App（visibilitychange）：房主那邊馬上藏起他的人物（還在房間裡）；切回來又看得到
  const setHidden = h => guest.evaluate(h => { if (h) Object.defineProperty(document, 'hidden', { value: true, configurable: true }); else delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }, h);
  await setHidden(true);
  await page.waitForFunction(() => !Renderer.friends().some(r => r.visible), null, { timeout: 3000 }).catch(() => {});
  const aw = await page.evaluate(() => ({ vis: Renderer.friends().filter(r => r.visible).length, f: Net.friends().map(f => ({ away: f.away, ingame: f.ingame })), roster: Net.roster().length }));
  check(aw.vis === 0 && aw.f.length === 1 && aw.f[0].away && !aw.f[0].ingame && aw.roster === 2, `客人切到別的 App，房主那邊要馬上藏起他的人物、但他還在房間裡（${JSON.stringify(aw)}）`);
  await setHidden(false);
  await page.waitForFunction(() => Renderer.friends().some(r => r.visible), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => Renderer.friends().some(r => r.visible) && !Net.friends()[0].away), '客人切回來，房主那邊又要看得到他的人物');
  check(await page.evaluate(() => typeof drawMinimap === 'function'), '小地圖照常');
  // 口哨（第四世界）：朋友是藍點
  const dots = await page.evaluate(() => { G.whistleT = 5; const d = whistleDots4(); G.whistleT = 0; return d.filter(x => !x.red).length; });
  check(dots >= 1, '吹口哨時朋友要是藍點');
  // 第四世界一起蓋房子：客人進來時拿到房主的賣場（架上的東西一樣）；之後房主放的板子、搬的家具，客人拿走的架上東西、放的斜坡都會同步
  await guest.waitForFunction(() => G.pickups.some(p => p.uid), null, { timeout: 10000 }).catch(() => {});
  const b1 = await page.evaluate(() => {
    holdThing({ k: 'plank', tier: 2 }); Object.assign(G.p, { x: 46.3, y: 66.5, face: 0, pitch: 0 }); Object.assign(G.bld, { dist: 1.0, rx: 0, ry: 0, rz: 0 }); place4(); G.hand = null;
    const w = G.b4.list[G.b4.list.length - 1], pk = G.pickups.find(p => p.s && p.uid && p.id !== 'coin');
    const f = FURN.find(f => f.type === 'chair4' && !(zoneAt(f.x, f.y) || {}).cube);
    takeFurn4(f); Object.assign(G.p, { x: 56.5, y: 64.5, face: 0 }); G.bld.dist = 1.4; place4(); G.hand = null;
    Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 3.5 });
    return { pid: w && w.pid, uid: pk && pk.uid, fid: f.id, fx: f.x, fy: f.y, shelf: G.pickups.filter(p => p.s).map(p => p.uid).sort().join() };
  });
  await guest.waitForFunction(pid => G.b4.list.some(w => w.pid === pid), b1.pid, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const b2 = await guest.evaluate(b => {
    const f = FURN_BY_ID[b.fid], pk = G.pickups.find(p => p.uid === b.uid);
    const out = { wall: G.b4.list.some(w => w.pid === b.pid), shelf: G.pickups.filter(p => p.s).map(p => p.uid).sort().join() === b.shelf, chair: f && !f.held && f.x === b.fx && f.y === b.fy, pk: !!pk };
    if (pk) { G.hand = null; G.inv = {}; takePickup4(pk); }
    holdThing({ k: 'plank', tier: 1 }); Object.assign(G.p, { x: 52.5, y: 64.5, face: -Math.PI / 2, pitch: 0 }); Object.assign(G.bld, { dist: 1.0, rx: 45, ry: 0, rz: 0 }); place4(); G.hand = null;
    return out;
  }, b1);
  check(b2.wall && b2.shelf && b2.pk, `客人要看到房主放的板子、架上的東西要跟房主一樣（${JSON.stringify(b2)}）`);
  check(b2.chair, `房主搬的家具，客人那邊也要搬過去（${JSON.stringify(b2)}）`);
  await page.waitForFunction(() => G.b4.ramps.size > 0, null, { timeout: 8000 }).catch(() => {});
  const b3 = await page.evaluate(uid => ({ gone: !G.pickups.some(p => p.uid === uid), ramp: G.b4.ramps.has('52,63') }), b1.uid);
  check(b3.gone && b3.ramp, `客人拿走的架上東西、放的斜坡，房主那邊也要同步（${JSON.stringify(b3)}）`);
  // 電視開關、火爐的燃料、櫃子裡放的東西、第 3 天以後才出現的特別板材堆（岩漿、玻璃）也要同步
  const s1 = await page.evaluate(() => {
    const tv = FURN.find(f => f.type === 'tv4'), fire = FURN.find(f => f.type === 'fireplace4'), cab = FURN.find(f => (FURN4[f.type] || {}).store);
    if (tv.on) toggleTv4(tv);
    toggleTv4(tv);
    G.inv.wood = 2; fuelFire4(fire, 'wood');
    G.inv.marble = 3; openStore4(cab); modalAct('put:marble'); closeModal();
    G.hand = null;
    const sp = addSpecialPile4('pile_sp99', Math.floor(W4AX + 3), Math.floor(W4H - 9), LAVA_TIER); net4Day();
    return { tv: tv.id, fire: fire.id, cab: cab.id, sp: sp.id };
  });
  await guest.waitForFunction(s => FURN_BY_ID[s.sp] && (G.containers[s.cab] || { items: [] }).items.length > 0, s1, { timeout: 6000 }).catch(() => {});
  const s2 = await guest.evaluate(s => ({ tv: FURN_BY_ID[s.tv].on, fuel: (FURN_BY_ID[s.fire].fuel || []).length, cab: ((G.containers[s.cab] || {}).items || []).join(), sp: !!FURN_BY_ID[s.sp] }), s1);
  check(s2.tv && s2.fuel === 1 && s2.cab.includes('marble') && s2.sp, `房主開電視、丟木柴進火爐、把彈珠放進櫃子、出現特別板材堆，客人那邊要一樣（${JSON.stringify(s2)}）`);
  // 客人把彈珠從櫃子拿出來；房主拿走特別板材堆的最後一片：兩邊都要跟著變
  await guest.evaluate(s => { G.hand = null; const f = FURN_BY_ID[s.cab]; openStore4(f); modalAct('take:marble'); closeModal(); }, s1);
  await page.evaluate(s => { G.hand = null; takeFromPile4(FURN_BY_ID[s.sp]); G.hand = null; }, s1);
  await sleep(1200);
  const s3 = { h: await page.evaluate(s => ((G.containers[s.cab] || {}).items || []).join(), s1), g: await guest.evaluate(s => ({ cab: ((G.containers[s.cab] || {}).items || []).join(), sp: !!FURN_BY_ID[s.sp], marble: G.inv.marble || 0 }), s1) };
  check(!s3.h.includes('marble') && s3.h === s3.g.cab && !s3.g.sp && s3.g.marble > 0, `客人從櫃子拿走的彈珠、房主拿完的特別板材堆，另一邊也要跟著變（櫃子裡原本可能就有東西）（${JSON.stringify(s3)}）`);
  // 朋友頭上的血量條、手上拿的東西：客人拿著平底鍋、血剩 37 → 房主看得到；客人揮平底鍋，房主那邊的手臂也揮
  await guest.evaluate(() => { G.inv.pan = 1; G.selId = 'pan'; G.p.hp = 37; invDirty = true; });
  await page.waitForFunction(() => { const f = Net.friends()[0]; return f && f.hand === 'pan' && f.hp === 37; }, null, { timeout: 5000 }).catch(() => {});
  await sleep(800);
  const hf = await page.evaluate(() => ({ f: Net.friends().map(f => ({ hand: f.hand, hp: f.hp })), r: Renderer.friends().map(r => ({ held: r.held, label: r.label })) }));
  check(hf.f[0] && hf.f[0].hand === 'pan' && hf.f[0].hp === 37 && hf.r[0] && hf.r[0].held === 'pan' && hf.r[0].label.endsWith('|8'), `房主要看到客人手上的平底鍋和血量（${JSON.stringify(hf)}）`);
  await page.evaluate(() => Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 3.6, face: -Math.PI / 2, pitch: -0.1 }));
  await guest.evaluate(() => { Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 5.4, face: Math.PI / 2, pitch: 0, flash: false }); G.swingT = 1; G.swingId = 'pan'; });
  await sleep(250);
  await shot('2d-guest-holds-pan');
  // 送東西：客人看著房主按 E（點一下）送平底鍋；房主已經有平底鍋了就退回來；按住 E 給 5 枚硬幣
  await page.evaluate(() => { delete G.inv.pan; G.coins = 0; Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 14, face: -Math.PI / 2 }); });   // 離早晨禮物遠一點
  await guest.evaluate(() => { Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 15.1, face: Math.PI / 2, pitch: 0, hp: 100 }); G.coins = 12; G.inv.pan = 1; G.selId = 'pan'; });
  await guest.waitForFunction(() => Net.friends().some(f => f.ingame && Math.hypot(f.x - G.p.x, f.y - G.p.y) < 1.5), null, { timeout: 5000 }).catch(() => {});
  const gt = await guest.evaluate(() => { const t = getTarget(); return t ? t.label : ''; });
  check(gt.startsWith('送平底鍋給'), `看著朋友時 E 要是「送平底鍋給…」（${gt}）`);
  await guest.evaluate(() => { const f = Net.friends()[0]; giveFriend(f, 'pan'); giveFriend(f, 'coin'); });
  await page.waitForFunction(() => G.inv.pan === 1 && G.coins === 5, null, { timeout: 5000 }).catch(() => {});
  const gv = { h: await page.evaluate(() => ({ pan: G.inv.pan || 0, coins: G.coins })), g: await guest.evaluate(() => ({ pan: G.inv.pan || 0, coins: G.coins })) };
  check(gv.h.pan === 1 && gv.h.coins === 5 && gv.g.pan === 0 && gv.g.coins === 7, `客人送平底鍋和 5 枚硬幣給房主（${JSON.stringify(gv)}）`);
  await guest.evaluate(() => { G.inv.pan = 1; giveFriend(Net.friends()[0], 'pan'); });
  await guest.waitForFunction(() => G.inv.pan === 1, null, { timeout: 5000 }).catch(() => {});
  check(await guest.evaluate(() => G.inv.pan === 1) && await page.evaluate(() => G.inv.pan === 1), '房主已經有平底鍋了，送過去的要退回來');
  await guest.evaluate(() => { G.selId = null; G.swingT = 0; invDirty = true; });
  // 怪物同步（netmon.js）：每隻怪物由離牠最近的人算，別人照著畫；打別人算的怪物、用手電筒照，傷害交給牠的主人
  const monIds = pg => pg.evaluate(() => G.enemies.filter(e => !e.dead && e.nid).map(e => e.nid).sort().join());
  await page.waitForFunction(() => G.enemies.every(e => e.nid), null, { timeout: 3000 }).catch(() => {});
  await sleep(1500);
  const st1 = await page.evaluate(() => G.enemies.filter(e => e.kind === 'staff').length), mh = await monIds(page), mg = await monIds(guest);
  check(st1 > 0 && mh === mg, `客人要看到房主那邊白天站著的店員，而且是同一批（房主 ${st1} 隻：${mh}；客人：${mg}）`);
  const MY = await page.evaluate(() => W4H - 22);
  await page.evaluate(() => Object.assign(G.p, { x: W4AX + 0.5, y: W4H - 3.5, face: -Math.PI / 2, flash: false }));
  await guest.evaluate(y => Object.assign(G.p, { x: W4AX + 0.5, y, face: Math.PI / 2, pitch: 0, inv: 999, flash: false }), MY);
  await sleep(400);
  // 房主生一隻黑影在客人旁邊：客人比房主近很多，要交給客人算
  const nid1 = await page.evaluate(y => { const e = spawnEnemy('shadow', { x: W4AX + 0.5, y: y + 2 }); e.spawn = 0; return NetMon.id(e); }, MY);
  await guest.waitForFunction(id => G.enemies.some(e => e.nid === id && !e.rm), nid1, { timeout: 6000 }).catch(() => {});
  await sleep(600);
  const g1 = await guest.evaluate(id => { const e = G.enemies.find(e => e.nid === id); return e && { mine: !e.rm, x: e.x, y: e.y }; }, nid1);
  const h1 = await page.evaluate(id => { const e = G.enemies.find(e => e.nid === id); return e && { rm: e.rm, x: e.x, y: e.y }; }, nid1);
  check(nid1 && g1 && g1.mine && h1 && h1.rm === gid, `房主生在客人旁邊的怪物要交給客人算（客人 ${JSON.stringify(g1)}、房主 ${JSON.stringify(h1)}）`);
  check(g1 && h1 && Math.hypot(g1.x - h1.x, g1.y - h1.y) < 1.2, `房主畫面上的怪物要在客人那邊的位置（差 ${g1 && h1 && Math.hypot(g1.x - h1.x, g1.y - h1.y).toFixed(2)} 格）`);
  // 房主用平底鍋打客人算的怪物：客人那邊扣血打倒，兩邊都不見；房主也算打倒了一隻
  const k0 = await page.evaluate(() => G.stats.dissolved);
  await page.evaluate(id => { const e = G.enemies.find(e => e.nid === id); if (e) hurtMonster(e, 50, 'pan'); }, nid1);
  await guest.waitForFunction(id => !G.enemies.some(e => e.nid === id), nid1, { timeout: 4000 }).catch(() => {});
  await page.waitForFunction(id => !G.enemies.some(e => e.nid === id), nid1, { timeout: 4000 }).catch(() => {});
  const gone = { g: await guest.evaluate(id => G.enemies.some(e => e.nid === id), nid1), h: await page.evaluate(id => G.enemies.some(e => e.nid === id), nid1), k: await page.evaluate(() => G.stats.dissolved) };
  check(!gone.g && !gone.h && gone.k === k0 + 1, `房主打客人算的怪物：要在客人那邊打倒，兩邊都不見，房主也算打倒一隻（${JSON.stringify({ ...gone, k0 })}）`);
  // 客人那邊的怪物被敲暈站著，房主走過去用手電筒照：客人那邊的血要一直掉
  const nid2 = await guest.evaluate(y => { const e = spawnEnemy('shadow', { x: W4AX + 0.5, y: y + 2.5 }); Object.assign(e, { spawn: 0, stunT: 60, hp: 50, maxHp: 50 }); return NetMon.id(e); }, MY);
  await page.evaluate(y => Object.assign(G.p, { x: W4AX + 0.5, y: y + 6, face: -Math.PI / 2, pitch: 0, flash: true, bat: 100 }), MY);
  await page.waitForFunction(id => G.enemies.some(e => e.nid === id && e.rm), nid2, { timeout: 4000 }).catch(() => {});
  const hp0 = await guest.evaluate(id => (G.enemies.find(e => e.nid === id) || {}).hp, nid2);
  await sleep(2500);
  const hp1 = await guest.evaluate(id => { const e = G.enemies.find(e => e.nid === id); return e ? { hp: e.hp, mine: !e.rm } : null; }, nid2);
  check(hp1 && hp1.mine && hp1.hp < hp0 - 0.3, `房主的手電筒照著客人算的怪物，客人那邊的血要掉（${hp0} → ${JSON.stringify(hp1)}）`);
  await shot('2c-host-lights-guest-monster');
  await guest.evaluate(id => { const e = G.enemies.find(e => e.nid === id); if (e) e.dead = true; G.p.inv = 0; }, nid2);
  await page.evaluate(() => { G.p.flash = false; });
  // 房主天黑 → 客人跟著天黑
  await page.evaluate(() => { G.t = DAY_LEN - 0.05; });
  await guest.waitForFunction(() => G.phase === 'night' && G.day === 2, null, { timeout: 20000 });
  // 客人倒下：不會卡在結束畫面，等天亮
  await guest.evaluate(() => gameOver());
  await sleep(600);
  const dn = await guest.evaluate(() => ({ mode, over: !document.getElementById('gameover').classList.contains('hidden'), down: !document.getElementById('netDown').classList.contains('hidden'), text: document.getElementById('netDownText').textContent }));
  check(dn.mode === 'down' && !dn.over && dn.down && dn.text.includes('天亮'), `客人倒下要顯示「天亮時會醒來」、不是結束畫面（${JSON.stringify(dn)}）`);
  await gshot('4-guest-down');
  // 房主走到倒下的客人旁邊按住 E：把他扶起來（在原地起來）；再倒下一次，接著測天亮時醒來
  const gpos = await guest.evaluate(() => ({ x: G.p.x, y: G.p.y }));
  await page.waitForFunction(() => Net.friends().some(f => f.down), null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(g => Object.assign(G.p, { x: g.x, y: g.y + 1, face: -Math.PI / 2, pitch: 0.3 }), gpos);
  await page.waitForFunction(() => Net.friends().some(f => f.down && Math.hypot(f.x - G.p.x, f.y - G.p.y) < 1.5), null, { timeout: 5000 }).catch(() => {});
  const rt = await page.evaluate(() => { const t = getTarget(); return t ? { label: t.label, hold: t.hold } : null; });
  check(rt && rt.label.startsWith('扶') && rt.hold > 1, `朋友倒下了，走到旁邊 E 要是「扶…起來」（按住）（${JSON.stringify(rt)}）`);
  await page.evaluate(() => reviveFriend(Net.friends().find(f => f.down)));
  await guest.waitForFunction(() => mode === 'play', null, { timeout: 5000 }).catch(() => {});
  const rv = await guest.evaluate(g => ({ mode, hp: G.p.hp, moved: Math.hypot(G.p.x - g.x, G.p.y - g.y), big: document.getElementById('bigText').textContent }), gpos);
  check(rv.mode === 'play' && rv.hp === 40 && rv.moved < 0.5 && rv.big.includes('扶起來'), `朋友把客人扶起來：在原地醒來、血 40（${JSON.stringify(rv)}）`);
  await guest.evaluate(() => gameOver());
  await guest.waitForFunction(() => mode === 'down', null, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => Net.friends().some(f => f.down), null, { timeout: 5000 }).catch(() => check(false, '房主要看到客人倒下了'));
  // 房主天亮 → 客人在第 3 天醒過來
  await page.evaluate(() => { G.t = NIGHT_LEN - 0.05; });
  await guest.waitForFunction(() => G.phase === 'day' && G.day === 3 && mode === 'play', null, { timeout: 20000 }).catch(() => {});
  const up = await guest.evaluate(() => ({ mode, day: G.day, phase: G.phase, hp: G.p.hp, down: !document.getElementById('netDown').classList.contains('hidden'), ok: walkable(G.p.x, G.p.y) }));
  check(up.mode === 'play' && up.day === 3 && up.phase === 'day' && up.hp > 0 && !up.down && up.ok, `天亮了客人要醒過來（${JSON.stringify(up)}）`);
  check(await guest.evaluate(s => localStorage.getItem('home99_save_v1') === s, SAVE), '客人自己的存檔不能被改掉');
  // 暫停同步：房主暫停 → 客人也進暫停畫面（寫著是誰暫停的），兩邊的時間都停住
  const hostName = await page.evaluate(() => Net.name);
  const pzState = pg => pg.evaluate(() => ({ mode, t: G.t, shown: !document.getElementById('pause').classList.contains('hidden'),
    who: document.getElementById('pauseWho').classList.contains('hidden') ? '' : document.getElementById('pauseWho').textContent }));
  await page.evaluate(() => pauseGame());
  await guest.waitForFunction(() => mode === 'pause', null, { timeout: 5000 }).catch(() => {});
  const pz1 = await pzState(guest), pz1h = await pzState(page);
  check(pz1.mode === 'pause' && pz1.shown && pz1.who.includes(`${hostName}暫停了`), `房主暫停時客人也要進暫停畫面、寫著是誰暫停的（${JSON.stringify(pz1)}）`);
  check(pz1h.who.includes('你暫停了'), `房主自己的暫停畫面要寫「你暫停了」（${JSON.stringify(pz1h)}）`);
  await sleep(1500);
  const pz2 = await pzState(guest), pz2h = await pzState(page);
  check(Math.abs(pz2.t - pz1.t) < 0.1 && Math.abs(pz2h.t - pz1h.t) < 0.1, `暫停時房主和客人的時間都要停住（客人 ${pz1.t.toFixed(2)}→${pz2.t.toFixed(2)}、房主 ${pz1h.t.toFixed(2)}→${pz2h.t.toFixed(2)}）`);
  await gshot('4b-guest-paused-by-host');
  // 客人按「繼續」→ 兩邊一起繼續，房主那邊跳「小明按了繼續」
  await guest.click('#btnResume');
  await page.waitForFunction(() => mode === 'play', null, { timeout: 5000 }).catch(() => {});
  const rs1 = await page.evaluate(() => ({ mode, pause: !document.getElementById('pause').classList.contains('hidden'), toast: document.getElementById('toasts').textContent }));
  const rs1g = await guest.evaluate(() => mode);
  check(rs1.mode === 'play' && !rs1.pause && rs1g === 'play', `客人按「繼續」，房主和客人要一起繼續（房主 ${rs1.mode}、客人 ${rs1g}）`);
  check(rs1.toast.includes('小明按了繼續'), `房主要看到「小明按了繼續」（${rs1.toast.slice(-60)}）`);
  // 客人暫停 → 房主也暫停、寫「小明暫停了」；房主按 Esc 繼續 → 客人也繼續
  await guest.evaluate(() => pauseGame());
  await page.waitForFunction(() => mode === 'pause', null, { timeout: 5000 }).catch(() => {});
  const pz3 = await pzState(page);
  check(pz3.mode === 'pause' && pz3.who.includes('小明暫停了'), `客人暫停時房主也要暫停、寫「小明暫停了」（${JSON.stringify(pz3)}）`);
  await shot('4c-host-paused-by-guest');
  await page.keyboard.press('Escape');
  await guest.waitForFunction(() => mode === 'play', null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => mode) === 'play' && await guest.evaluate(() => mode) === 'play', '房主按 Esc 繼續，客人也要一起繼續');
  // 開書包的視窗不算暫停：房主開書包，客人照樣在玩；客人這時暫停，房主的書包不會被關掉，關掉書包才進暫停畫面
  await page.evaluate(() => openBag4());
  await sleep(800);
  check(await guest.evaluate(() => mode) === 'play', '房主開書包的視窗時，客人不能被拉進暫停畫面');
  await guest.evaluate(() => pauseGame());
  await sleep(800);
  check(await page.evaluate(() => mode) === 'modal', '房主開著書包時，客人暫停不能把書包關掉');
  await page.evaluate(() => closeModal());
  await page.waitForFunction(() => mode === 'pause', null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => mode) === 'pause', '房主關掉書包之後要進暫停畫面（客人暫停了）');
  await page.evaluate(() => resumeGame());
  await guest.waitForFunction(() => mode === 'play', null, { timeout: 5000 }).catch(() => {});
  check(await guest.evaluate(() => mode) === 'play', '房主按繼續，客人也要一起繼續');
  // 客人離開房間：回主選單，自己的存檔還在；房主看到客人離開了、他的人物馬上不見；客人是暫停的人，房主的暫停畫面改寫「小明離開了」
  await guest.evaluate(() => pauseGame());
  check(await guest.evaluate(() => document.getElementById('btnQuit').textContent.includes('離開房間') && !document.getElementById('pauseNet').classList.contains('hidden')), '客人的暫停選單要寫「離開房間」和房間資訊');
  await page.waitForFunction(() => mode === 'pause', null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { window.__leftAt = 0; Net.on('@leave', () => { window.__leftAt = Date.now(); }); });
  const quitAt = await guest.evaluate(() => Date.now());
  await guest.click('#btnQuit');
  await guest.waitForFunction(() => mode === 'title' && !Net.active);
  await page.waitForFunction(() => Net.friends().length === 0 && Net.roster().length === 1, null, { timeout: 5000 }).catch(() => check(false, '客人離開後房主的房間裡要只剩自己'));
  await page.waitForFunction(() => !Renderer.friends().some(r => r.visible), null, { timeout: 3000 }).catch(() => {});
  const lv = await page.evaluate(() => ({ at: window.__leftAt, vis: Renderer.friends().filter(r => r.visible).length, mode,
    who: document.getElementById('pauseWho').classList.contains('hidden') ? '' : document.getElementById('pauseWho').textContent }));
  check(lv.at > 0 && lv.at - quitAt < 2000, `客人按「離開房間」，房主那邊要馬上知道（${lv.at ? lv.at - quitAt : '沒收到'} 毫秒）`);
  check(lv.vis === 0, '客人離開房間後，房主的畫面上不能再有他的人物');
  check(lv.mode === 'pause' && lv.who.includes('小明離開了'), `暫停的客人離開了，房主還在暫停畫面、要寫「小明離開了」（${JSON.stringify(lv)}）`);
  await shot('4d-host-pauser-left');
  const tt = await guest.evaluate(() => ({ cont: !document.getElementById('btnContinue').disabled, info: document.getElementById('saveInfo').textContent }));
  check(tt.cont && tt.info.includes('第 3 天'), `離開房間後客人自己的存檔要還在（${tt.info}）`);
  // 房主回主選單（房間還開著）→ 客人再加入，在朋友的畫面等 → 房主開新遊戲（第一世界）→ 客人跟著進去
  await page.evaluate(() => pauseGame());
  await page.click('#btnQuit');
  await page.waitForFunction(() => mode === 'title' && Net.isHost && !document.getElementById('netNote').classList.contains('hidden'));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));   // 等房主畫好主選單（沒有 GPU 時第一次畫要編譯很久，這時回不了「有人要加入」）
  await guest.click('#btnFriends');
  check(await guest.evaluate(c => document.getElementById('fCode').value === c, code), '再打開朋友的畫面時，代碼要記得上一次的');
  await guest.click('#fJoin');
  await guest.waitForFunction(() => Net.guest && !document.getElementById('fWait').classList.contains('hidden'), null, { timeout: 10000 });
  await gshot('5-guest-lobby');
  await page.click('#btnFriends');
  await page.waitForFunction(() => document.querySelectorAll('#fRoster li').length === 2);
  await page.click('#fStartNew');
  await page.click('#worldPick .worldbtn.w1');
  await page.click('#diffPick .diffbtn.easy');
  await guest.waitForFunction(() => mode === 'play' && curWorld === 1, null, { timeout: 30000 }).catch(() => {});
  const w1 = await guest.evaluate(() => ({ mode, world: curWorld, day: G.day, diff: G.diff, ready: Net.ready }));
  check(w1.mode === 'play' && w1.world === 1 && w1.day === 1 && w1.diff === 'easy' && w1.ready, `房主開新遊戲時，在主選單等的客人要跟著進去（${JSON.stringify(w1)}）`);
  await sleep(1200);
  await gshot('6-guest-w1');
  // 第一世界的房子也一樣：房主在離自己很遠的房間生一隻黑影，客人站在那裡，要交給客人算，房主畫面上也看得到
  const far = await page.evaluate(() => { const at = findSpawn(12); return at && { x: at.x, y: at.y }; });
  if (far) {
    await guest.evaluate(at => Object.assign(G.p, { x: at.x, y: at.y + 0.6, inv: 999 }), far);
    await sleep(500);
    const nid3 = await page.evaluate(at => { const e = spawnEnemy('shadow', at); e.spawn = 0; return NetMon.id(e); }, far);
    await guest.waitForFunction(id => G.enemies.some(e => e.nid === id && !e.rm), nid3, { timeout: 6000 }).catch(() => {});
    const w1m = { g: await guest.evaluate(id => G.enemies.some(e => e.nid === id && !e.rm), nid3), h: await page.evaluate(id => (G.enemies.find(e => e.nid === id) || {}).rm || '', nid3) };
    check(w1m.g && w1m.h === await guest.evaluate(() => Net.myId), `第一世界：房主生在客人旁邊的黑影要交給客人算（${JSON.stringify(w1m)}）`);
    await guest.evaluate(() => { G.p.inv = 0; });
  } else check(false, '第一世界找不到離房主很遠的地方');
  // 房主關掉房間：客人回到主選單，有提示
  await page.evaluate(() => Net.leave());
  await guest.waitForFunction(() => mode === 'title' && !Net.active, null, { timeout: 15000 }).catch(() => {});
  const bye = await guest.evaluate(() => ({ mode, note: document.getElementById('netNote').textContent }));
  check(bye.mode === 'title' && bye.note.includes('房主'), `房主關掉房間時，客人要回到主選單並看到提示（${JSON.stringify(bye)}）`);
  // 客人直接關掉分頁（App）：pagehide 送「掰掰」，房主馬上拿掉他的人物、跳「離開了」，不用等 15 秒斷線
  const code2 = await page.evaluate(() => Net.host());
  await guest.click('#btnFriends');
  await guest.fill('#fCode', code2);
  await guest.click('#fJoin');
  await guest.waitForFunction(() => mode === 'play' && Net.ready, null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => Renderer.friends().some(r => r.visible), null, { timeout: 10000 }).catch(() => check(false, '再加入之後房主要看得到客人'));
  const closeAt = Date.now();
  await guest.close();
  await page.waitForFunction(() => Net.roster().length === 1 && !Renderer.friends().some(r => r.visible), null, { timeout: 5000 }).catch(() => {});
  const cl = await page.evaluate(() => ({ roster: Net.roster().length, vis: Renderer.friends().filter(r => r.visible).length, toast: document.getElementById('toasts').textContent }));
  check(cl.roster === 1 && cl.vis === 0 && Date.now() - closeAt < 6000, `客人關掉分頁，房主要馬上拿掉他的人物（${JSON.stringify(cl)}）`);
  check(cl.toast.includes('小明 離開了'), `客人關掉分頁，房主要看到「小明 離開了」（${cl.toast.slice(-60)}）`);
});

await scenario('net5', '跟朋友一起玩第五世界（?nettest）：客人進到房主的草原、砍倒的樹、砍樹（樹倒了掉的板子和木柴）、樹上的東西拿走、工作台做的方塊、沐浴球冒泡和洗出來的東西、閃電、記憶的光點、早上長回來的樹，兩邊都一樣', { limit: 240000 }, async ({ page, ctx, check }) => {
  const guest = await ctx.newPage();
  guest.on('pageerror', e => check(false, '客人的分頁 JS 錯誤：' + e.message));
  guest.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) check(false, '客人的分頁 console 錯誤：' + m.text()); });
  await guest.goto(BASE + '?nettest', { waitUntil: 'load' });
  await guest.evaluate(() => { localStorage.removeItem('home99_save_v1'); localStorage.removeItem('home99_progress_v1'); });
  await page.goto(BASE + 'test.html?world=5&kit=1&nettest', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play' && curWorld === 5, null, { timeout: 60000 });
  // 房主先砍倒一棵樹（客人加入時要拿到）
  const first = await page.evaluate(() => { G.t = 60; const f = FURN.find(o => o.type === 'tree5' && !o.cut); fellTree5(f, true); return f.id; });
  await page.evaluate(() => pauseGame());
  await page.click('#btnPauseFriends');
  await page.click('#fHost');
  await page.waitForFunction(() => /^[A-Z2-9]{4}$/.test(document.getElementById('fRoomCode').textContent), null, { timeout: 10000 });
  const code = await page.evaluate(() => document.getElementById('fRoomCode').textContent);
  await page.click('#fResume');
  await guest.reload({ waitUntil: 'load' });
  await guest.waitForSelector('#btnFriends');
  await guest.click('#btnFriends');
  await guest.fill('#fName', '小華');
  await guest.fill('#fCode', code);
  await guest.evaluate(() => { window.__left = []; Net.on('@close', d => window.__left.push({ why: d && d.why, t: Math.round(performance.now()), w: curWorld })); });
  await guest.click('#fJoin');
  await guest.waitForFunction(() => (mode === 'play' || mode === 'pause') && curWorld === 5 && Net.ready, null, { timeout: 90000 });
  await page.evaluate(() => { if (mode === 'pause') resumeGame(); });
  await guest.waitForFunction(() => mode === 'play', null, { timeout: 30000 }).catch(() => {});
  // 兩邊都看得到對方在第五世界裡、客人拿到房主的整片草原（砍倒的樹）才開始（電腦很忙時要等比較久）
  await page.waitForFunction(() => Net.friends().some(f => f.ingame && f.world === 5), null, { timeout: 30000 }).catch(() => {});
  await guest.waitForFunction(() => Net.friends().some(f => f.ingame && f.world === 5), null, { timeout: 30000 }).catch(() => {});
  await guest.waitForFunction(id => curWorld === 5 && FURN_BY_ID[id] && FURN_BY_ID[id].cut, first, { timeout: 40000 }).catch(() => {});
  const g0 = await guest.evaluate(id => ({ world: curWorld, cut: !!(FURN_BY_ID[id] && FURN_BY_ID[id].cut), grown: G.pickups.filter(p => p.s).length, left: window.__left, mode }), first);
  const h0 = await page.evaluate(() => G.pickups.filter(p => p.s).length);
  check(g0.world === 5 && g0.cut, `客人要進到房主的草原、房主之前砍倒的樹也是倒的（${JSON.stringify(g0)}）`);
  check(g0.grown === h0 && h0 > 30, `樹上和花上的東西要跟房主一樣（房主 ${h0}、客人 ${g0.grown}）`);
  // 房主砍樹：客人那邊也倒、掉的板子和木柴一樣
  const fell = await page.evaluate(() => {
    const f = FURN.find(o => o.type === 'tree5' && !o.cut);
    for (let i = 0; i < 3; i++) chop5(f);
    return { id: f.id, loose: G.loose4.slice(-2).map(l => l.uid), wood: G.pickups.filter(p => p.id === 'wood').map(p => p.uid).pop() };
  });
  await guest.waitForFunction(d => FURN_BY_ID[d.id] && FURN_BY_ID[d.id].cut && d.loose.every(u => G.loose4.some(l => l.uid === u)), fell, { timeout: 15000 }).catch(() => {});
  const g1 = await guest.evaluate(d => ({ cut: !!FURN_BY_ID[d.id].cut, solid: solid[FURN_BY_ID[d.id].y][FURN_BY_ID[d.id].x], loose: d.loose.every(u => G.loose4.some(l => l.uid === u)), wood: G.pickups.some(p => p.uid === d.wood) }), fell);
  check(g1.cut && !g1.solid && g1.loose && g1.wood, `房主砍倒樹，客人那邊也要倒、掉一樣的板子和木柴（${JSON.stringify(g1)}）`);
  // 客人拿走樹上的東西：房主那邊也不見
  const took = await guest.evaluate(() => { const pk = G.pickups.find(p => p.s); const uid = pk.uid; while (bagUsed() >= BAG_SLOTS) delete G.inv[invList()[0]]; takePickup4(pk); return uid; });
  await page.waitForFunction(u => !G.pickups.some(p => p.uid === u), took, { timeout: 15000 }).catch(() => check(false, '客人摘走樹上的東西，房主那邊也要不見'));
  // 房主在工作台做方塊放在地上：客人那邊也有
  const cube = await page.evaluate(() => {
    G.hand = null; G.inv.wood = 4; openBook5(); modalAct('cube'); closeModal();
    const f = G.hand && G.hand.f; G.p.face = Math.PI / 2;
    const g = ghost4(); if (g && g.ok) place4();
    const other = FURN.filter(o => o.type === 'cube5' && o !== f).map(o => o.id);
    return { id: f && f.id, placed: f && !f.held, x: f && f.x, y: f && f.y, other };
  });
  await guest.waitForFunction(c => FURN_BY_ID[c.id] && !FURN_BY_ID[c.id].held, cube, { timeout: 15000 }).catch(() => {});
  const g2 = await guest.evaluate(c => { const f = FURN_BY_ID[c.id]; return { has: !!f, placed: !!f && !f.held && furnGrid[c.y][c.x] === f, other: c.other.every(id => !!FURN_BY_ID[id]) }; }, cube);
  check(cube.placed && g2.has && g2.placed && g2.other, `房主做的方塊（拿在手上的、放在工作台旁邊的），客人那邊也要有、放在一樣的地方（${JSON.stringify({ cube, g2 })}）`);
  // 沐浴球：房主丟進水裡，客人看到冒泡、洗出來的東西也看得到
  const bath = await page.evaluate(() => {
    for (const k of W5MAP.water) { const [x, y] = k.split(',').map(Number); if (walkable(x + 0.5, y + 1.5)) { Object.assign(G.p, { x: x + 0.5, y: y + 1.5, face: -Math.PI / 2 }); break; } }
    G.inv.bathbomb = 1; G.selId = 'bathbomb'; useSelected();
    const n0 = G.pickups.length; updateBath5(2.1);
    return G.pickups.slice(n0).map(p => p.uid);
  });
  await guest.waitForFunction(u => u.every(x => G.pickups.some(p => p.uid === x)), bath, { timeout: 15000 }).catch(() => {});
  const g3 = await guest.evaluate(u => ({ items: u.filter(x => G.pickups.some(p => p.uid === x)).length }), bath);
  check(bath.length >= 1 && g3.items === bath.length, `房主用沐浴球洗出來的東西，客人那邊也要有（洗出 ${bath.length}、客人看到 ${g3.items}）`);
  // 閃電（房主決定）、記憶的光點（算記憶洩漏源的人放出來）
  await page.evaluate(() => { G.force5 = ['storm']; G.ev.boltT = 0; updateWeather5(0.016); });
  await guest.waitForFunction(() => G.flash5 > 0 || !!G.bolt5, null, { timeout: 15000, polling: 50 }).catch(() => check(false, '房主那邊打雷，客人那邊也要閃電'));
  await page.evaluate(() => { const e = spawnEnemy('leak', { x: 40.5, y: 18.5 }); e.spawn = 0; e.cd = 0; updateLeak5(e, 0.05); });
  await guest.waitForFunction(() => (G.motes5 || []).length > 0, null, { timeout: 15000, polling: 50 }).catch(() => check(false, '記憶洩漏源放出的光點，客人那邊也要有'));
  // 早上長回來的樹：房主算好，送給客人
  const regrow = await page.evaluate(id => { const f = FURN_BY_ID[id]; f.cut = G.day - 2; Object.assign(G.p, { x: 40.5, y: 40.5 }); regrow5(); net4Day(); return !f.cut; }, first);
  check(regrow, '房主那邊的樹要長回來');
  await guest.waitForFunction(id => !FURN_BY_ID[id].cut && solid[FURN_BY_ID[id].y][FURN_BY_ID[id].x], first, { timeout: 15000 }).catch(() => check(false, '房主那邊長回來的樹，客人那邊也要長回來'));
  await guest.close();
});

await scenario('test', '測試版頁面（test.html）：所有世界都開著、圖鑑沒有問號、新遊戲可以從第 6 夜開始、不存檔也不碰正式版的進度；test.html 要跟 index.html 同步', {}, async ({ page, shot, check }) => {
  // test.html 是 tools/make-test.mjs 從 index.html 產生的，改了 index.html 要重新產生
  const { makeTest } = await import('./make-test.mjs');
  check(makeTest(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')) === fs.readFileSync(path.join(ROOT, 'test.html'), 'utf8'), 'test.html 跟 index.html 不同步：請跑 node tools/make-test.mjs');
  await page.goto(BASE + 'test.html', { waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  // 先放一份正式版的存檔和進度（第一世界第 3 天、第二世界沒解鎖），測試版不可以動到它們
  await page.evaluate(() => {
    localStorage.setItem('home99_save_v1', JSON.stringify({ v: 1, day: 3, diff: 'easy', world: 1, p: { x: 19.5, y: 23, hp: 100, san: 100, hunger: 100, bat: 100, flashLv: 1 }, inv: { bulb1: 1 }, sockets: [], lamps: [], containers: {}, stats: { searched: 0, dissolved: 0, bestTier: 1 } }));
    localStorage.setItem('home99_progress_v1', JSON.stringify({ w2: false }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  const t = await page.evaluate(() => ({ test: TEST_MODE, title: document.title.includes('測試版'), w2: w2Unlocked(), w3: w3Unlocked(), noContinue: document.getElementById('btnContinue').disabled, badge: !document.getElementById('testBadge').classList.contains('hidden'), noTransfer: document.getElementById('btnTransfer').classList.contains('hidden'), seen: seenSet().size === BESTIARY.length }));
  check(Object.values(t).every(Boolean), `測試版要全部解鎖、圖鑑全部見過、沒有繼續遊戲和存檔轉移（${JSON.stringify(t)}）`);
  await shot('1-title');
  await page.click('#btnNew');
  check(await page.evaluate(() => [...document.querySelectorAll('#worldPick .worldbtn')].every(b => !b.disabled)), '測試版三個世界都要能選');
  await page.click('#worldPick .worldbtn.w3');
  check(await page.evaluate(() => !document.getElementById('testOpts').classList.contains('hidden') && document.querySelectorAll('#testNight option').length === 12), '選難度的畫面要有「從第幾夜開始」的選項（1～12）');
  await page.selectOption('#testNight', '6');
  await page.check('#testKit');
  await shot('2-diff');
  await page.click('#diffPick .diffbtn.normal');
  await page.waitForFunction(() => mode === 'play');
  await sleep(1500);
  // 從第 6 夜開始、帶齊裝備；存檔、標成見過、解鎖都不可以寫進 localStorage
  const g = await page.evaluate(() => { saveGame(); markSeen('tall'); unlockW3(); return { world: curWorld, day: G.day, pan: !!G.inv.pan, dusk: G.t > DAY_LEN - 10, save: JSON.parse(localStorage.getItem('home99_save_v1')).day, prog: localStorage.getItem('home99_progress_v1') }; });
  check(g.world === 3 && g.day === 6 && g.pan && g.dusk, `測試版要能從第三世界第 6 夜開始、帶齊裝備（世界 ${g.world}、第 ${g.day} 天、平底鍋 ${g.pan}）`);
  check(g.save === 3 && g.prog === '{"w2":false}', `測試版不可以動到正式版的存檔和進度（存檔第 ${g.save} 天、進度 ${g.prog}）`);
  await sleep(1200);
  await shot('3-night6');
  // 正式版的頁面不受影響：不是測試版、存檔照樣讀得到、第二世界還是鎖著
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  const n = await page.evaluate(() => ({ test: TEST_MODE, cont: !document.getElementById('btnContinue').disabled, day: (document.getElementById('saveInfo').textContent.match(/第 (\d+) 天/) || [])[1], w2: w2Unlocked(), opts: document.getElementById('testOpts').classList.contains('hidden') }));
  check(!n.test && n.cont && n.day === '3' && !n.w2 && n.opts, `正式版要照舊（測試版 ${n.test}、繼續遊戲 ${n.cont}、第 ${n.day} 天、第二世界解鎖 ${n.w2}）`);
});

await scenario('offline', '離線（快取後斷網，重新打開並開新遊戲）', {}, async ({ page, ctx, shot, check }) => {
  await page.goto(BASE, { waitUntil: 'load' });
  // 遊戲只在 https 註冊 service worker，本機測試這裡手動註冊
  // 快取清單裡有檔案載入失敗的話 service worker 裝不起來，ready 會永遠等下去，所以限時 20 秒
  const swOk = await page.evaluate(async () => {
    await navigator.serviceWorker.register('sw.js');
    return Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 20000))]);
  });
  check(swOk, 'service worker 要能裝好（sw.js 的快取清單裡可能有檔案不存在）');
  if (!swOk) return;
  await page.reload({ waitUntil: 'load' });
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker 要接管頁面');
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#btnNew');
  // 跟朋友一起玩：斷網時連線程式庫照樣載得到（遊戲不會壞），朋友的畫面寫「沒有網路，現在只能自己玩」
  check(await page.evaluate(() => typeof Peer === 'function' && typeof Net === 'object'), '斷網後連線程式庫（js/vendor/peerjs.min.js、js/net.js）也要載得到');
  await page.click('#btnFriends');
  const off = await page.evaluate(() => ({ shown: !document.getElementById('fOffline').classList.contains('hidden'), text: document.getElementById('fOffline').textContent, host: document.getElementById('fHost').disabled }));
  check(off.shown && off.text.includes('沒有網路，現在只能自己玩') && off.host, `斷網時朋友的畫面要寫「沒有網路，現在只能自己玩」、不能開房間（${JSON.stringify(off)}）`);
  await shot('0-friends-offline');
  await page.click('#fBack');
  await page.click('#btnNew');
  await page.click('#worldPick .worldbtn.w1');
  await page.click('#diffPick .diffbtn.easy');
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  check((await state(page)).hud, '斷網後也要能開始遊戲');
  const ph = await page.evaluate(() => Renderer.photos());
  check(ph.loaded.length === ph.total, `斷網後照片貼圖也要載得到（tex/*.webp 要在 sw.js 的快取清單裡；${ph.loaded.length}/${ph.total} 張）`);
  await shot('1-start');
});

await browser.close();
server.close();

// ---------- 結果 ----------
console.log('');
let failed = 0;
for (const r of results) {
  const ok = r.problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${r.title}　${r.fps ? r.fps + ' FPS，' : ''}${r.secs} 秒`);
  for (const p of r.problems) console.log('     ' + p);
}
console.log(`\n${results.length - failed}/${results.length} 個情境通過，截圖在 ${path.relative(process.cwd(), OUT) || '.'}/`);
console.log('（FPS 是沒有 GPU 的軟體算繪數字，不代表平板上的表現）');
process.exit(failed ? 1 : 0);
