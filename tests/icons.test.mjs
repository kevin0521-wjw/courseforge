/**
 * 图标产物护栏。
 *
 * 背景：图标位图是**派生产物**（源是 web/icon.svg，由 tools/make-icons.py 生成）。
 * 派生产物的老问题就是「改了源、忘了重生成」，而且图标这类东西**不报错**：
 * 浏览器标签页读的是 SVG，PWA/安装向导读的是 PNG/ICO，两边悄悄不一致，
 * 直到有人在 iPhone 上「添加到主屏幕」发现图标空白，才知道漏了。
 *
 * 另外这里要守住两个曾经真的错过的地方：
 *   1. apple-touch-icon 挂了 SVG —— iOS 不认，图标直接空白；
 *   2. maskable 图标四周有透明边 —— maskable 的语义是「背景铺满整幅」，
 *      系统按圆形裁剪时会露出透明，看着像图标缺了一块。
 *
 * ⚠️ 本文件刻意**不调用 Python**（CI 只装 Node，没有 Pillow），
 * 所以那两件事都得靠纯 Node 解析 PNG 像素来判断 —— 于是下面自己解 PNG。
 * 只用 zlib，不引任何依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

/** 期望的 PNG 产物及其边长（与 tools/make-icons.py 的 PNG_TARGETS 对应） */
const PNGS = [
  ['icon-180.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512]
];
const ICO = path.join(ROOT, 'desktop', 'build', 'icon.ico');

// ---------------------------------------------------------------- PNG 解码

/**
 * 解出 8 位无隔行的 PNG 像素（RGBA / RGB / 灰度）。
 * 只覆盖我们产物实际会用的子集，遇到别的形态就直接报错 ——
 * 报错也比悄悄按错的字节数解读、得出错误结论强。
 */
function decodePng(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, '不是 PNG（magic 不对）');

  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  assert.ok(ihdr, 'PNG 缺少 IHDR');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  assert.equal(bitDepth, 8, `只支持 8 位色深，实际 ${bitDepth}`);
  assert.equal(interlace, 0, '不支持隔行 PNG（产物不该是隔行的）');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `未知的颜色类型 ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else {
        assert.equal(filter, 0, `未知的滤波类型 ${filter}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/** 取某点像素；返回 [r,g,b,a]（无 alpha 通道时补 255） */
function pixel(img, x, y) {
  const base = (y * img.width + x) * img.channels;
  const d = img.data;
  if (img.channels === 4) return [d[base], d[base + 1], d[base + 2], d[base + 3]];
  if (img.channels === 3) return [d[base], d[base + 1], d[base + 2], 255];
  return [d[base], d[base], d[base], d[base + 1]];
}

function loadPng(file) {
  return decodePng(fs.readFileSync(file));
}

// ---------------------------------------------------------------- ICO 解析

/** 读 ICO 目录表；0 表示 256（格式如此，不是笔误） */
function icoSizes(buf) {
  return {
    reserved: buf.readUInt16LE(0),
    type: buf.readUInt16LE(2),
    count: buf.readUInt16LE(4),
    sizes: Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
      const off = 6 + i * 16;
      const w = buf[off] === 0 ? 256 : buf[off];
      const h = buf[off + 1] === 0 ? 256 : buf[off + 1];
      return Math.min(w, h);
    }).sort((a, b) => a - b)
  };
}

// ---------------------------------------------------------------- 用例

test('图标产物齐全，尺寸与用途声明一致', () => {
  for (const [name, size] of PNGS) {
    const file = path.join(WEB, name);
    assert.ok(fs.existsSync(file), `缺少 web/${name}（跑 python tools/make-icons.py）`);
    const img = loadPng(file);
    assert.equal(img.width, size, `${name} 宽度应为 ${size}`);
    assert.equal(img.height, size, `${name} 高度应为 ${size}`);
  }
});

test('maskable 图标满幅不透明 —— 被裁成圆形时不能露出透明边', () => {
  const img = loadPng(path.join(WEB, 'icon-maskable-512.png'));
  const bad = [];
  const check = (x, y) => {
    if (pixel(img, x, y)[3] !== 255) bad.push(`(${x},${y})=${pixel(img, x, y)[3]}`);
  };
  for (let i = 0; i < img.width; i++) {
    check(i, 0);                     // 上边
    check(i, img.height - 1);        // 下边
    check(0, i);                     // 左边
    check(img.width - 1, i);         // 右边
  }
  assert.deepEqual(bad.slice(0, 5), [],
    `maskable 图标边缘有 ${bad.length} 个透明像素。maskable 的语义是背景铺满整幅，` +
    '四周留透明会在圆形裁剪时露出空洞（曾把美术和底色一起缩放，就是这个后果）');
});

test('普通图标是圆角：四角透明、中心不透明', () => {
  for (const name of ['icon-192.png', 'icon-512.png']) {
    const img = loadPng(path.join(WEB, name));
    const d = img.channels;
    if (d !== 4) continue; // 没 alpha 就无所谓圆不圆角
    const last = img.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      assert.equal(pixel(img, x, y)[3], 0, `${name} 的 (${x},${y}) 应该是透明的圆角外沿`);
    }
    assert.equal(pixel(img, img.width >> 1, img.height >> 1)[3], 255,
      `${name} 中心必须不透明`);
  }
});

test('apple-touch-icon 必须是 PNG —— iOS 不认 SVG', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
  const tags = [...html.matchAll(/<link[^>]+rel="apple-touch-icon"[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length > 0, 'index.html 里找不到 apple-touch-icon');

  for (const tag of tags) {
    const href = (/href="([^"]+)"/.exec(tag) || [])[1] || '';
    assert.ok(!/\.svg(\?|$)/i.test(href),
      `apple-touch-icon 指向了 SVG（${href}）。iOS 只认 PNG，` +
      '挂 SVG 会让「添加到主屏幕」拿不到图标，页面装上了但图标是空白');
    assert.match(href, /\.png$/i, `apple-touch-icon 应该是 PNG：${href}`);
    assert.ok(fs.existsSync(path.join(WEB, href)), `apple-touch-icon 指向的文件不存在：${href}`);
  }
});

test('manifest 里每个 icon 都真实存在，且尺寸与声明相符', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf-8'));
  assert.ok(Array.isArray(mf.icons) && mf.icons.length > 0, 'manifest 没有 icons');

  for (const icon of mf.icons) {
    const file = path.join(WEB, icon.src);
    assert.ok(fs.existsSync(file), `manifest 引用了不存在的图标：${icon.src}`);
    if (icon.type === 'image/png') {
      const img = loadPng(file);
      assert.equal(`${img.width}x${img.height}`, icon.sizes,
        `${icon.src} 实际 ${img.width}x${img.height}，manifest 里却声明 ${icon.sizes}`);
    }
  }

  // maskable 必须指向专门的 maskable 产物，不能拿普通图标或 SVG 顶替：
  // 普通图标四角有透明、SVG 更是会被很多系统直接忽略
  const maskable = mf.icons.filter((i) => String(i.purpose).includes('maskable'));
  assert.ok(maskable.length > 0, 'manifest 缺少 maskable 图标（Android 自适应图标会退化）');
  for (const icon of maskable) {
    assert.match(icon.src, /maskable/, `maskable 应指向专门的产物，当前是 ${icon.src}`);
  }
});

test('SW 预缓存覆盖 index.html 与 manifest 引用的所有图标', () => {
  const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf-8');
  const block = sw.match(/const ASSETS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'sw.js 里找不到 ASSETS 数组');
  const cached = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, '')));

  const referenced = new Set();
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
  for (const m of html.matchAll(/<link[^>]+rel="(?:icon|apple-touch-icon|manifest)"[^>]*>/g)) {
    const href = (/href="([^"]+)"/.exec(m[0]) || [])[1];
    if (href) referenced.add(href);
  }
  const mf = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf-8'));
  for (const icon of mf.icons) referenced.add(icon.src);

  const missing = [...referenced].filter((f) => !cached.has(f));
  assert.deepEqual(missing, [],
    '下面的图标被页面/manifest 引用，却没进 SW 预缓存 —— 离线安装 PWA 时会请求失败：\n  ' + missing.join('\n  '));
});

test('桌面端 .ico 至少含 256 尺寸，且 electron-builder 配置指向它', () => {
  assert.ok(fs.existsSync(ICO), '缺少 desktop/build/icon.ico（跑 python tools/make-icons.py）');
  const parsed = icoSizes(fs.readFileSync(ICO));
  assert.equal(parsed.reserved, 0, 'ICO 保留位应为 0');
  assert.equal(parsed.type, 1, 'ICO 类型应为 1（图标）');
  assert.ok(Math.max(...parsed.sizes) >= 256,
    `ICO 最大尺寸只有 ${Math.max(...parsed.sizes)}，electron-builder 要求 ≥256，否则打包报错`);
  for (const s of [16, 32, 48]) {
    assert.ok(parsed.sizes.includes(s), `ICO 缺少 ${s}px 档（任务栏/资源管理器会糊）`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf-8'));
  const configured = pkg.build && pkg.build.win && pkg.build.win.icon;
  assert.ok(configured, 'desktop/package.json 没配 build.win.icon —— exe 会顶着 Electron 默认图标');
  assert.ok(fs.existsSync(path.join(ROOT, 'desktop', configured)),
    `build.win.icon 指向的文件不存在：${configured}`);
});

test('改了 icon.svg 就必须重新生成位图（锁文件护栏）', () => {
  const svg = fs.readFileSync(path.join(WEB, 'icon.svg'));
  const lockFile = path.join(WEB, 'icons.lock.json');
  assert.ok(fs.existsSync(lockFile),
    '缺少 web/icons.lock.json（跑 python tools/make-icons.py 生成）');

  const hash = crypto.createHash('sha256').update(svg).digest('hex');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  const problem = lockProblem(lock, hash);

  // ① 真实断言：当前 SVG 与锁一致
  assert.equal(problem, null,
    `${problem}\n（位图是派生产物：改了 SVG 不重新生成，浏览器标签页用新图标、` +
    'PWA 和安装包还是旧的，两边不一致且不报错）');

  // ② 变异自检：证明上面这条断言不是恒真 —— 换一个哈希必须判为不一致
  assert.ok(lockProblem(lock, hash.replace(/^./, hash[0] === '0' ? '1' : '0')),
    'hash 变了却仍判定为一致，说明这条护栏是假的（恒真）');
});

/** 比对锁与当前哈希；一致返回 null，否则返回给用户看的问题描述 */
function lockProblem(lock, actualHash) {
  if (lock.source && lock.source !== 'web/icon.svg') {
    return `锁文件记的源是 ${lock.source}，预期是 web/icon.svg`;
  }
  if (lock.sha256 !== actualHash) {
    return `web/icon.svg 已改动，但图标没重新生成（锁里 ${lock.sha256}，当前 ${actualHash}）` +
      '\n→ 跑一次 `python tools/make-icons.py`';
  }
  return null;
}
