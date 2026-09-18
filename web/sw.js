/**
 * CourseForge Service Worker
 * 策略：**网络优先 + 缓存兜底** —— 已发布的修复下次打开立即生效，离线仍可看课表。
 * 注意：跨域请求（OCR 引擎 / PDF 引擎 CDN）不拦截，交给网络
 */
// 缓存名带版本号：内容一改就要升版本，否则老用户会一直吃旧缓存。
// 升版本后 activate 会清掉旧缓存，实现「换版本即失效」。
const CACHE = 'courseforge-v10';
// 预缓存清单必须与 index.html 里的 <script src> 完全对齐 ——
// 漏掉任何一个，首次离线访问时该脚本会 fetch 失败并 fallback 到 index.html，
// 把 HTML 当 JS 返回，脚本解析报错、应用整个崩掉。
// 此清单的完整性由 tools/check-dom.mjs 静态校验，不要凭记忆手工增删。
//
// 注意：cmaps/（168 个 .bcmap，中文 PDF 解码必需）**刻意不列入**。
// 它们只在导入中文 PDF 时按需请求，下面的 fetch 处理器会顺带写入缓存；
// 若塞进预缓存，每次安装都要多下 1.5MB，得不偿失。
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/core.js',
  './js/storage.js',
  './js/remind.js',
  './js/render.js',
  './js/parser.js',
  './js/pdf-layout.js',
  './js/edu-html.js',
  './js/ics.js',
  './js/share-image.js',
  './js/webdav.js',
  './js/importer.js',
  './js/app.js',
  './icon.svg',
  // 位图图标由 tools/make-icons.py 从 icon.svg 生成（iOS 与安装向导不认 SVG）。
  // 它们体积很小（合计约 50KB），且「添加到主屏幕」时必然被请求，
  // 预缓存后离线装 PWA 也能拿到正确图标。
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
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
      .then((keys) => {
        // 存在「别的版本」的缓存 → 这是一次版本升级，而非首次安装
        const upgrading = keys.some((k) => k !== CACHE);
        return Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
          .then(() => self.clients.claim())
          .then(() => {
            if (!upgrading) return null;
            // 主动让已经打开的页面重新加载。
            //
            // 为什么必须由 SW 来做这一步：停在旧页面上的 app.js 是【旧代码】，
            // 它根本没有 controllerchange 监听（那是新版本才加的），
            // 所以页面不会自己刷新，用户会继续看到旧界面 ——
            // 表现就是「修复明明已经发布，用户却还说不行」，
            // 这个问题在定位真根因时误导了两轮，代价很大。
            //
            // 只在版本升级时触发（首次安装不刷），因此不会造成刷新循环：
            // 重新加载后 SW 已是最新，不会再触发 activate。
            return self.clients.matchAll({ type: 'window' }).then((list) =>
              Promise.all(list.map((c) => c.navigate(c.url).catch(() => null)))
            );
          });
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // 外部引擎走网络，不进缓存

  const isNavigation = req.mode === 'navigate';

  const save = (res) => {
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  };

  // 网络优先。
  // 这里原来是 cache-first（命中就立刻返回旧副本，只顺带在后台更新），
  // 代价是「已发布的修复要等用户访问两次才生效」—— 排查
  // 「我这边明明改好了，用户打开还报同样的错」时，这个延迟极具误导性。
  // 改成网络优先后：在线永远拿最新，离线才退回缓存。
  // 课表数据本身存在 localStorage，离线可用性不受影响。
  event.respondWith(
    fetch(req)
      .then(save)
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => {
          if (hit) return hit;
          // 只有导航请求才允许退回 index.html。
          // 其他资源【绝不能】用 HTML 兜底：曾出现 cmaps/*.bcmap 取不到时
          // 被 index.html 顶上，pdf.js 把 HTML 当成 CMap 表来解析 →
          // 中文一个字符都解不出，界面只报「PDF 中未提取到文字」，
          // 查了几轮才定位到 SW 这一层。
          if (isNavigation) {
            return caches.match('./index.html', { ignoreSearch: true })
              .then((page) => page || Response.error());
          }
          return Response.error();
        })
      )
  );
});
