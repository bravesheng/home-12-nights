// 在家生存 12 夜 — 離線快取
// 第一次打開時把整個遊戲存到平板裡，之後沒有網路也能玩。
// 每次更新遊戲都要改 VERSION，平板連上網路時就會自動下載新版本。
const VERSION = 'home12-v31';
const ASSETS = [
  './', './index.html', './style.css', './manifest.webmanifest', './test.html', './manifest-test.webmanifest',
  './js/version.js', './js/data.js', './js/audio.js', './js/world2.js', './js/world3.js', './js/world4.js', './js/world5.js', './js/net.js', './js/netmon.js', './js/game.js', './js/render3d.js',
  './js/vendor/peerjs.min.js',   // 跟朋友一起玩的連線程式庫（沒有網路時也要載得到，遊戲才不會壞）
  './lib/three.module.js', './lib/three.core.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  // 照片貼圖（render3d.js 的 PHOTO_TEX）：第三世界的場景
  './tex/w3-wall.webp', './tex/w3-ironwall.webp', './tex/w3-velvet.webp', './tex/w3-runner.webp', './tex/w3-carpet.webp',
  './tex/w3-tile.webp', './tex/w3-ceiling.webp', './tex/w3-iron.webp', './tex/w3-herringbone.webp', './tex/w3-concrete.webp',
  './tex/w3-wood.webp', './tex/w3-leather.webp', './tex/w3-brass.webp', './tex/w3-linen.webp', './tex/w3-station.webp',
  './tex/w3-carriage.webp', './tex/w3-cardoor.webp', './tex/w3-door.webp', './tex/w3-roof.webp', './tex/w3-rug.webp',
  './tex/w3-far.webp', './tex/w3-mid-plain.webp', './tex/w3-mid-trees.webp', './tex/w3-mid-bridge.webp', './tex/w3-mid-snow.webp', './tex/w3-mid-city.webp',
  './tex/w3-yard.webp', './tex/w3-timetable.webp', './tex/w3-poster-bridge.webp', './tex/w3-poster-snow.webp', './tex/w3-poster-meadow.webp',
  // 怪物的照片材質（細節紋路 d-*、直接用的照片 m-*）
  './tex/d-skin.webp', './tex/d-birdleg.webp', './tex/d-cotton.webp', './tex/d-bone.webp', './tex/d-steel.webp', './tex/d-rag.webp', './tex/d-bark.webp',
  './tex/d-moss.webp', './tex/d-hair.webp', './tex/d-grass.webp', './tex/d-fur.webp', './tex/d-sclera.webp', './tex/d-slug.webp', './tex/d-corpse.webp',
  './tex/m-capred.webp', './tex/m-capk.webp', './tex/m-gills.webp', './tex/m-stem.webp', './tex/m-seeds.webp', './tex/m-petal.webp', './tex/m-rock.webp', './tex/m-lava.webp',
  // 第五世界怪物預先畫好的貼圖（render3d.js 的 m5Tex，tools/make-monster5-tex.mjs 產生）
  './tex/m5-cr.webp', './tex/m5-lk.webp', './tex/m5-dmCloud.webp', './tex/m5-dmFace.webp', './tex/m5-slShellfalse.webp', './tex/m5-slShelltrue.webp',
  './tex/m5-slMantle.webp', './tex/m5-slHead.webp', './tex/m5-gzSkinfalse.webp', './tex/m5-gzSkintrue.webp', './tex/m5-gzHead.webp',
  './tex/m5-gfLeaffalse.webp', './tex/m5-gfLeaftrue.webp', './tex/m5-gfFace11.webp', './tex/m5-gfFace12.webp', './tex/m5-gfFace13.webp', './tex/m5-gfFace14.webp', './tex/m5-clHead.webp',
  './tex/m5-crSclera.webp', './tex/m5-iris26.webp', './tex/m5-iris22.webp', './tex/m5-iris30.webp', './tex/m5-lkWisp.webp', './tex/m5-dmFlesh.webp',
  './tex/m5-gzIris.webp', './tex/m5-slIn.webp', './tex/m5-gfCore.webp', './tex/m5-clSkin.webp',
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
