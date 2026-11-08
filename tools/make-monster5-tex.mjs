#!/usr/bin/env node
// 第五世界 7 隻新怪物的大貼圖預先畫好、存成 tex/m5-<key>.webp（render3d.js 的 m5Tex 直接載入，不用在平板上一個一個像素算）
//
//   node tools/make-monster5-tex.mjs
//
// 用無頭瀏覽器打開 ?model=cradle&bake5（當場畫，不載圖檔），呼叫 Renderer.bake5() 把 7 隻怪物都蓋一次，
// 2048×1024 的縮成 1024×512 再壓成 WebP。改了怪物貼圖的畫法（cr、lk、dm、sl、gz、gf、cl 開頭的 paint 函式）要重跑；
// 多了新的貼圖要把檔名加進 sw.js 的 ASSETS（這支程式會印出缺了哪些）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png' };
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(BASE + '?model=cradle&bake5', { waitUntil: 'load' });
await page.waitForFunction(() => window.Renderer && Renderer.bake5, null, { timeout: 60000 });
const { ms, tex } = await page.evaluate(() => Renderer.bake5());
await browser.close();
server.close();
if (errors.length) { console.error('頁面出錯：', errors.join('\n')); process.exit(1); }

let total = 0;
for (const t of tex) {
  const buf = Buffer.from(t.url.split(',')[1], 'base64');
  fs.writeFileSync(path.join(ROOT, 'tex', `m5-${t.key}.webp`), buf);
  total += buf.length;
  console.log(`tex/m5-${t.key}.webp　${t.w}×${t.h}　${Math.round(buf.length / 1024)} KB`);
}
console.log(`共 ${tex.length} 張，${(total / 1024 / 1024).toFixed(1)} MB`);
console.log('當場畫的時候每隻蓋多久（毫秒）：' + Object.entries(ms).map(([k, v]) => `${k} ${v}`).join('、'));
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const miss = tex.map(t => `./tex/m5-${t.key}.webp`).filter(u => !sw.includes(`'${u}'`));
if (miss.length) console.log('⚠️ sw.js 的 ASSETS 還沒有：' + miss.map(u => `'${u}'`).join(', '));
