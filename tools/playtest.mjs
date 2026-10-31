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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...ctxOpts });
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
    // 每個情境最多 2 分鐘，卡住就算失敗，不要整個測試停在那裡
    let timer;
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('超過 2 分鐘，卡住了')), 120000); });
    await Promise.race([fn({ page, ctx, shot, check }), limit]).finally(() => clearTimeout(timer));
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
    return { table, onTable, head, fell, sit, up, lie };
  });
  check(jump.onTable && jump.table.z > 0.7, `要能跳上桌子（腳的高度 ${jump.table.z.toFixed(2)}、在桌子上 ${jump.onTable}）`);
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
  check(s.y > 12.6, `白天要能從車門走下月台（現在 y=${s.y.toFixed(1)}）`);
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
  // 蠟燭：拿在手上（物品列選中蠟燭），在月台上體溫掉得慢很多；手上看得到點著的蠟燭、狀態列有提示
  const cd = await page.evaluate(() => {
    addItem('candle', 2);
    const drop = sel => { G.selId = sel; G.p.temp = 80; G.p.candleT = 0; for (let i = 0; i < 10; i++) updateWarmth3(0.2); return 80 - G.p.temp; };
    const without = drop('bulb1'), withC = drop('candle');
    updateHUD();
    return { without, withC, alert: document.getElementById('alert').textContent };
  });
  check(cd.withC < cd.without * 0.5 && cd.alert.includes('蠟燭讓你暖和一點'), `拿著蠟燭時體溫要掉得慢很多（沒拿 -${cd.without.toFixed(1)}、拿著 -${cd.withC.toFixed(1)}；狀態列「${cd.alert.slice(0, 40)}」）`);
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

await scenario('book', '怪物圖鑑（沒見過的只有問號；見過的卡片上是會動的 3D 怪物：三個世界各拍一張；舊存檔會照進度標成見過）', {}, async ({ page, shot, check }) => {
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

await scenario('w4', '第四世界第 1 天（?world=4&kit=1）：賣場、撿板子蓋牆圍成家、屋頂、檯燈的光不穿牆、搬家具、背包 16 格、火爐、存檔讀檔', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=4&kit=1', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(2000);
  const s = await state(page);
  check(s.hud && s.day === 1 && s.phase === 'day', `要在第四世界第 1 天早上（現在：${s.label}）`);
  const info = await page.evaluate(() => ({ world: curWorld, w: MAP_W, h: MAP_H, loose: G.loose4.length, day: DAY_LEN, night: NIGHT_LEN, bag: bagUsed(), piles: FURN.filter(f => f.type === 'plankpile' && f.count > 0).length, staff: G.enemies.filter(e => e.kind === 'staff' && e.idle).length }));
  check(info.world === 4 && info.w === 60 && info.h === 44, `第四世界的地圖要是 60×44（世界 ${info.world}、${info.w}×${info.h}）`);
  check(info.day === 300 && info.night === 360, `白天 5 分鐘、晚上 6 分鐘（${info.day}／${info.night} 秒）`);
  check(info.loose >= 4 && info.piles >= 10, `入口旁邊的地上要有板子、倉儲區要有板材堆（地上 ${info.loose} 片、板材堆 ${info.piles} 堆）`);
  check(info.bag <= 16, `kit 帶的東西不能超過背包 16 格（${info.bag} 格）`);
  check(info.staff >= 2, `白天賣場裡要站著不動的店員（${info.staff} 隻）`);
  await page.evaluate(() => { G.t = 100; Object.assign(G.p, { x: 29.5, y: 30.5, face: -Math.PI / 2, pitch: 0 }); });
  await sleep(1500);
  await shot('1-store');
  // 撿地上的板子（E 的互動）→ 預覽是綠色 → 放下變成一面牆；第一次放牆會自動記成家
  const first = await page.evaluate(() => {
    const l = G.loose4[0];
    Object.assign(G.p, { x: l.x, y: l.y + 0.5, face: -Math.PI / 2, pitch: -0.6 });
    const t = getTarget();
    if (t && t.action) t.action();
    const held = G.hand && G.hand.k === 'plank';
    Object.assign(G.p, { x: 34.5, y: 40.5, face: 0, pitch: 0 }); G.bld.dist = 1.1;
    const g = ghost4(), n0 = G.b4.n;
    place4();
    return { label: t && t.label, held, ok: g && g.ok, kind: g && g.kind, placed: G.b4.n - n0, home: !!G.home, hand: G.hand };
  });
  check(first.held && first.label && first.label.includes('板子'), `對著地上的板子按 E 要拿起來（互動「${first.label}」）`);
  check(first.ok && first.kind === 'wall' && first.placed === 1 && first.home && !first.hand, `拿著板子按 E 要放下一面牆、記成家（預覽 ${first.kind}/${first.ok}、放了 ${first.placed} 片、家 ${first.home}）`);
  // 用板子圍出 2×2 的家（x 31～32、y 38～39）：一面玻璃、一扇木門，上面蓋 4 片屋頂
  const house = await page.evaluate(() => {
    const out = [];
    const put = (tier, door, pos, rx = 0) => {
      holdThing({ k: 'plank', tier, door });
      Object.assign(G.p, pos); Object.assign(G.bld, { dist: 1.1, rx, ry: 0, rz: 0 });
      const g = ghost4(); out.push(g && g.ok ? '' : `${JSON.stringify(pos)}:${g && g.why}`);
      place4();
      if (G.hand) G.hand = null;
    };
    const tiers = [1, 2, 3, 4, 1, 2, 5, 3];
    let i = 0;
    for (const x of [31, 32]) { put(tiers[i++], false, { x: x + 0.5, y: 38 - 1.1, face: Math.PI / 2 }); put(tiers[i++], x === 32, { x: x + 0.5, y: 40 - 1.1, face: Math.PI / 2 }); }
    for (const y of [38, 39]) { put(tiers[i++], false, { x: 31 - 1.1, y: y + 0.5, face: 0 }); put(tiers[i++], false, { x: 33 - 1.1, y: y + 0.5, face: 0 }); }
    for (const x of [31, 32]) for (const y of [38, 39]) put(1, false, { x: x + 0.5, y: y + 1.6, face: -Math.PI / 2 }, 1);
    Object.assign(G.p, { x: 31.6, y: 38.6, face: 0 });
    return { bad: out.filter(Boolean), walls: G.b4.n, roofs: G.b4.roofs.size, home: atHome4(), cover: sheltered4(G.p.x, G.p.y) };
  });
  check(house.bad.length === 0, '每片板子都要放得下：' + house.bad.join('；'));
  check(house.walls === 9 && house.roofs === 4, `要有 9 片牆、4 片屋頂（${house.walls}／${house.roofs}）`);
  check(house.home && house.cover, `站在圍起來、有屋頂的地方要算「在家裡」、淋不到雨（在家 ${house.home}、遮著 ${house.cover}）`);
  // 檯燈：選燈泡按 Q 會在前面放一盞檯燈；家裡的燈不會穿過牆照到外面（玻璃透光）
  const lamp = await page.evaluate(() => {
    Object.assign(G.p, { x: 31.5, y: 39.6, face: -Math.PI / 2 }); G.selId = 'bulb5';
    const n0 = G.lamps.length; useSelected(); buildLights();
    const L = G.lamps[G.lamps.length - 1];
    return { placed: G.lamps.length - n0, free: !!(L && L.free), inside: lightAt4(32.5, 38.5, 0), outsideWood: lightAt4(33.5, 38.5, 0), outsideGlass: lightAt4(30.5, 39.5, 0) };
  });
  check(lamp.placed === 1 && lamp.free, `選燈泡按 Q 要放一盞檯燈（放了 ${lamp.placed} 盞）`);
  check(lamp.inside > 0.1 && lamp.outsideWood === 0 && lamp.outsideGlass > 0, `家裡的燈不能穿過牆照到外面，玻璃要透光（裡面 ${lamp.inside.toFixed(2)}、木牆外 ${lamp.outsideWood.toFixed(2)}、玻璃外 ${lamp.outsideGlass.toFixed(2)}）`);
  await page.evaluate(() => { Object.assign(G.p, { x: 32.5, y: 35.6, face: Math.PI / 2 + 0.25, pitch: -0.05 }); });
  await sleep(1500);
  await shot('2-house');
  // 搬家具：按住 E 拿起椅子，放在別的地方（3D 模型跟著重建）
  const chair = await page.evaluate(() => {
    const f = FURN.find(f => f.type === 'chair4' && f.x === 32 && f.y === 31);
    takeFurn4(f);
    const held = G.hand && G.hand.f === f;
    Object.assign(G.p, { x: 35.5, y: 40.5, face: 0 }); G.bld.dist = 1.4;
    const g = ghost4(); place4();
    return { held, ok: g && g.ok, x: f.x, y: f.y, solid: solid[f.y][f.x], hand: G.hand };
  });
  check(chair.held && chair.ok && chair.x === 36 && chair.y === 40 && chair.solid && !chair.hand, `椅子要能搬到別的地方（拿起 ${chair.held}、放在 ${chair.x},${chair.y}）`);
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
    const f = FURN.find(f => f.type === 'chair4' && f.x === 36 && f.y === 40);
    return { walls: G.b4.n, roofs: G.b4.roofs.size, chair: !!f, home: !!G.home, glass: G.b4.list.some(w => w.tier === 5 && w.hp === Infinity), door: G.b4.list.some(w => w.door) };
  });
  check(sv.walls === 9 && sv.roofs === 4 && sv.chair && sv.home && sv.glass && sv.door, `存檔讀回來牆、屋頂、家具、家都要在（${JSON.stringify(sv)}）`);
});

await scenario('w4night', '第四世界的晚上（?world=4&night=2&kit=1）：燈熄了、店員巡邏、怪物打破木牆、玻璃打不破；5 隻新怪物和神秘店員排一排（手電筒第 7 級星辰）', {}, async ({ page, shot, check }) => {
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
    Object.assign(G.p, { x: 30.5, y: 33.5, face: -Math.PI / 2, inv: 999, hp: 100 });
    // 把玩家圍在主走道的一格裡（四面木頭板子），店員從北邊過來
    for (const [o, x, y] of [['h', 30, 33], ['h', 30, 34], ['v', 30, 33], ['v', 31, 33]]) setWall({ o, x, y, tier: 1, hp: 40, door: false, open: false });
    const e = Object.assign(spawnEnemy('staff', { x: 30.5, y: 29.5 }), { spawn: 0, state: 'chase', idle: false, lx: G.p.x, ly: G.p.y });
    const hp0 = G.b4.list.map(w => w.hp).reduce((a, b) => a + b, 0);
    for (let i = 0; i < 400 && G.b4.n === 4; i++) { updateEnemies(0.05); }
    const hp1 = G.b4.list.map(w => w.hp).reduce((a, b) => a + b, 0);
    return { broke: G.b4.n < 4, hp0, hp1, ahead: !!e.wallAhead || G.b4.n < 4 };
  });
  check(bash.broke || bash.hp1 < bash.hp0, `店員要打擋路的木牆（耐打 ${bash.hp0} → ${bash.hp1}、打破 ${bash.broke}）`);
  const glass = await page.evaluate(() => {
    for (const w of [...G.b4.list]) removeWall(w);
    const gw = { o: 'h', x: 30, y: 33, tier: 5, hp: Infinity, door: false, open: false };
    setWall(gw);
    const e = G.enemies[0] || spawnEnemy('staff', { x: 30.5, y: 31.5 });
    e.wallAhead = gw; Object.assign(e, { x: 30.5, y: 32.7 });
    for (let i = 0; i < 60; i++) bash4(e, 0.1);
    return { hp: gw.hp, cost: edgeCost4(30, 32, 30, 33, '') };
  });
  check(glass.hp === Infinity && glass.cost === Infinity, `玻璃牆要打不破、尋路不能穿過（耐打 ${glass.hp}、通過代價 ${glass.cost}）`);
  // 怪物排一排：玩家站在主走道上往北看
  const lineup = await page.evaluate(() => {
    for (const w of [...G.b4.list]) removeWall(w);
    G.enemies = []; G.ev.schedule = [];
    Object.assign(G.p, { x: 29.8, y: 27.5, face: -Math.PI / 2, pitch: 0.1, inv: 999, flashLv: 7, bat: 100 });
    const put = (kind, x, y, extra) => Object.assign(spawnEnemy(kind, { x, y }), { spawn: 0, pose: true, face: Math.PI / 2, state: 'idle' }, extra);
    put('staff', 27.5, 23.5); put('shake', 28.9, 23.0, { awake: true }); put('mimic', 30.2, 23.4); put('hubert', 31.6, 23.2); put('ember', 30.0, 20.5);
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
  await page.evaluate(() => { G.phase = 'day'; G.t = 100; G.enemies = []; Object.assign(MERCHANT_POS, { x: 29.5, y: 24.5 }); Object.assign(G.p, { x: 29.6, y: 27.2, face: -Math.PI / 2, pitch: 0.05, flash: false }); });
  await sleep(1800);
  await shot('3-clerk');
});

await scenario('w4wx', '第四世界的天氣（寒寂之境下雪、酸雨、紅月長草）、燈泡圖鑑（燈泡、手電筒 1～7 級、板子五級）、生物圖鑑的第四世界', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?world=4&night=3&kit=1&cold', { waitUntil: 'load' });
  await page.waitForFunction(() => mode === 'play');
  await sleep(1500);
  const cold = await page.evaluate(() => { G.phase = 'day'; G.t = 100; Object.assign(G.p, { x: 29.5, y: 30.5, face: -Math.PI / 2, pitch: 0.2 }); const t0 = G.p.temp; for (let i = 0; i < 40; i++) updateTemp4(0.25); return { cold: G.cold, t0, t1: G.p.temp }; });
  await sleep(1500);
  cold.bar = await page.evaluate(() => !document.getElementById('tempBar').classList.contains('hidden'));
  check(cold.cold && cold.t1 < cold.t0 && cold.bar, `寒寂之境：體溫要往下掉、要顯示體溫條（${cold.t0} → ${cold.t1}、體溫條 ${cold.bar}）`);
  await shot('1-snow');
  // 酸雨：沒遮著會扣血；屋頂底下淋不到
  const acid = await page.evaluate(() => {
    G.cold = false;
    G.acid = { day: G.day, night: false, at: 0, dur: 90, started: true, warned: true }; G.acidT = 90;
    Object.assign(G.p, { x: 29.5, y: 30.5, hp: 100, inv: 0 });
    for (let i = 0; i < 20; i++) updateAcid4(0.1);
    const hpOut = G.p.hp;
    G.b4.roofs.set('29,30', { x: 29, y: 30, tier: 1, hp: 40 }); G.b4.ver++;
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
