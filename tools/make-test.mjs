#!/usr/bin/env node
// 從 index.html 產生測試版的頁面 test.html（不同網址：.../test.html，可以另外加到主畫面）。
// 測試版跟正式版用同一套程式，只多了 window.TEST_MODE = true：所有世界和圖鑑的怪物都開著、新遊戲可以從任一夜開始、
// 不會存檔也不會碰正式版的進度（見 js/game.js 的 TEST_MODE）。
// stamp.sh 發布時會自動跑；改了 index.html 之後也要跑一次（node tools/make-test.mjs），tools/playtest.mjs 會檢查有沒有同步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function makeTest(html) {
  let out = html;
  const rep = (a, b) => { if (!out.includes(a)) throw new Error('index.html 裡找不到：' + a); out = out.replace(a, b); };
  rep('<!DOCTYPE html>\n', '<!DOCTYPE html>\n<!-- 測試版：這個檔案是 tools/make-test.mjs 從 index.html 產生的，不要手改 -->\n');
  rep('<title>在家生存 12 夜</title>', '<title>在家生存 12 夜（測試版）</title>');
  rep('href="manifest.webmanifest"', 'href="manifest-test.webmanifest"');
  rep('<script src="js/version.js', '<script>window.TEST_MODE = true;</script>\n  <script src="js/version.js');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = makeTest(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
  fs.writeFileSync(path.join(ROOT, 'test.html'), out);
  console.log('已從 index.html 產生 test.html');
}
