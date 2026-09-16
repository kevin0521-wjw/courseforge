/**
 * Service Worker 策略回归测试。
 *
 * 为什么值得单独守护：SW 的策略选择直接决定「已发布的修复什么时候才能在用户端生效」。
 * 早期用的是 cache-first（命中缓存立刻返回旧副本，只顺带在后台更新），
 * 结果是新代码要等用户访问两次才生效 —— 表现就是
 * 「我这边明明改好并发布了，用户打开还报同样的错」，
 * 上两轮排查正是被这个假象带偏的。
 *
 * 另外还有一个更隐蔽的坑：同源的 cmaps/*.bcmap 若取不到，
 * 不能被 index.html 兜底 —— pdf.js 会把 HTML 当成 CMap 表来解析，
 * 中文一个字符都解不出来，而界面只报「PDF 中未提取到文字」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEB } from './helpers/importer-harness.mjs';

const SW = readFileSync(join(WEB, 'sw.js'), 'utf8');
const APP = readFileSync(join(WEB, 'js', 'app.js'), 'utf8');

test('SW：必须网络优先 —— cache-first 会让已发布的修复延迟一两次访问才生效', () => {
  const i = SW.indexOf("addEventListener('fetch'");
  assert.ok(i > 0, 'sw.js 里找不到 fetch 事件监听');

  const body = SW.slice(i);
  const netIdx = body.indexOf('fetch(req)');
  const cacheIdx = body.indexOf('caches.match(req');

  assert.ok(netIdx > 0, 'fetch 处理器里应当先发起网络请求');
  assert.ok(
    cacheIdx === -1 || netIdx < cacheIdx,
    '网络优先：fetch(req) 必须出现在 caches.match(req) 之前；' +
      '若缓存查询在前，命中就返回旧副本，用户要多访问一次才拿到新代码'
  );
  assert.match(body, /\.catch\(/, '网络失败时才回退到缓存');
});

test('SW：非导航资源失败时不得用 index.html 兜底（否则 cmaps 会被当成 HTML 喂给 pdf.js）', () => {
  const i = SW.indexOf("caches.match('./index.html'");
  assert.ok(i > 0, '找不到 index.html 兜底逻辑');

  const before = SW.slice(Math.max(0, i - 400), i);
  assert.match(
    before,
    /isNavigation/,
    'index.html 兜底必须受 isNavigation 保护：只给导航请求用'
  );
  assert.match(
    SW,
    /Response\.error\(\)/,
    '其他资源失败时应返回错误响应，绝不能拿 HTML 顶替 —— ' +
      '那会让 pdf.js 把 HTML 当 CMap 解析，中文全解不出，且症状只是「PDF 中未提取到文字」'
  );
});

test('SW：缓存名必须带版本号（换版本即失效）', () => {
  assert.match(SW, /const CACHE = 'courseforge-v\d+'/, 'CACHE 常量必须包含版本号');
});

test('SW：新版本接管后自动刷新一次，用户不会停留在旧代码上', () => {
  assert.match(APP, /controllerchange/, 'app.js 应监听 controllerchange');
  assert.match(APP, /location\.reload\(\)/, '新 SW 接管后应刷新页面，让修复当场生效');
});

test('SW：版本升级时由 SW 主动重载已打开的页面（旧页面自己不会刷）', () => {
  // 这一条是「修复发布了但用户还说不行」的正面解法：
  // 停在旧页面上的 app.js 是旧代码，没有 controllerchange 监听，
  // 光靠页面自己永远刷新不了。必须由新 SW 主动 navigate。
  const i = SW.indexOf("addEventListener('activate'");
  assert.ok(i > 0, '找不到 activate 事件');
  const body = SW.slice(i, i + 2000);

  assert.match(body, /upgrading/, '必须区分「版本升级」与「首次安装」');
  assert.match(body, /clients\.matchAll/, '升级时要找出已打开的页面');
  assert.match(body, /\.navigate\(/, '升级时要让已打开的页面重新加载');

  // 首次安装不能刷：否则新用户第一次打开就被刷一次，白等一轮
  assert.match(
    body,
    /if\s*\(!upgrading\)\s*return/,
    '首次安装（无旧缓存）时不应触发重载'
  );
});
