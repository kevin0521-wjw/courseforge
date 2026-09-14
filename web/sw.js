/**
 * CourseForge Service Worker
 * 策略：应用外壳「缓存优先 + 后台更新」，让课表离线可看（课表本身就是离线数据）
 * 注意：跨域请求（OCR 引擎 / PDF 引擎 CDN）不拦截，交给网络
 */
const CACHE = 'courseforge-v3';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/core.js',
  './js/storage.js',
  './js/render.js',
  './js/parser.js',
  './js/ics.js',
  './js/importer.js',
  './js/app.js',
  './icon.svg',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // 外部引擎走网络，不进缓存

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) {
        // 后台静默更新，下次打开即最新
        fetch(req).then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
          }
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html', { ignoreSearch: true }));
    })
  );
});
