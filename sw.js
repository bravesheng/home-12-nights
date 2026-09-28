// 在家生存 12 夜 — 離線快取
// 第一次打開時把整個遊戲存到平板裡，之後沒有網路也能玩。
// 每次更新遊戲都要改 VERSION，平板連上網路時就會自動下載新版本。
const VERSION = 'home12-v8';
const ASSETS = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './js/version.js', './js/data.js', './js/audio.js', './js/game.js', './js/render3d.js',
  './lib/three.module.js', './lib/three.core.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 先用存好的檔案（離線也能玩），沒有的才上網抓
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
