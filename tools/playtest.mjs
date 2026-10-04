#!/usr/bin/env node
// 自動試玩測試：用無頭 Chromium 開遊戲跑幾個情境，截圖並檢查有沒有錯誤
// 用法：node tools/playtest.mjs [截圖資料夾，預設 playtest-out]
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
async function scenario(name, title, ctxOpts, fn) {
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
  s = await state(page);
  check(s.label.includes('第 1 夜'), `天黑後要顯示第 1 夜（現在：${s.label}）`);
  await sleep(1000);
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
  await skipToDusk(page);
  await page.waitForFunction(() => G.phase === 'night', null, { timeout: 30000 });
  s = await state(page);
  check(s.label.includes('第 6 夜'), `天黑後要顯示第 6 夜（現在：${s.label}）`);
  await sleep(1500);
  await shot('2-night');
});

await scenario('monsters', '怪物模型（火柴人、鳥腳女和爬行女會動的頭髮、眼球花，手電筒開關各拍一張）', {}, async ({ page, shot, check }) => {
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
});

await scenario('tablet', '平板觸控（Android 平板尺寸，用點的開新遊戲）', { isMobile: true, hasTouch: true }, async ({ page, shot, check }) => {
  await startFromMenu(page, 1, 'normal', true);
  const s = await state(page);
  check(s.hud, 'HUD 要出現');
  const touchUI = await page.evaluate(() => getComputedStyle(document.getElementById('touch')).display !== 'none');
  check(touchUI, '觸控按鈕（搖桿、E、手電筒）要出現');
  await shot('1-start');
});

await scenario('cut', '破關開門動畫（?cut=1）', {}, async ({ page, shot, check }) => {
  await page.goto(BASE + '?cut=1', { waitUntil: 'load' });
  await sleep(2500);
  const s = await state(page);
  check(s.mode === 'cutscene' && !(await page.$('#cutscene.hidden')), `要在播動畫（現在 mode：${s.mode}）`);
  await shot('1-cutscene');
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
