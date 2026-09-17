/**
 * 单文件版（dist/CourseForge-standalone.html）的护栏。
 *
 * 起因是一个真实漏过的 bug：build-standalone.mjs 里剥离 PWA 声明的三行
 * `replace` 忘了加 `g` 标志，于是**只删掉第一个匹配**。
 * 当初 icon 只有一行（SVG），所以一直看不出问题；后来给 iOS 补了 PNG 兜底，
 * 第二个 `<link rel="icon">` 就留在了产物里，指向一个相对于 HTML 并不存在的
 * `icon-192.png`。而构建末尾的自检只查 stylesheet / script / manifest，
 * 压根没查 icon —— 构建报「成功」，产物却是坏的（打开会 404）。
 *
 * 所以这里**真的跑一遍构建**再检查产物。检查方式刻意采用「扫所有
 * <link>/<script> 标签」而不是枚举已知类型：枚举法正是当初漏掉 icon 的原因。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

let out = '';
let buildLog = '';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-standalone-'));
const OUT = path.join(tmpDir, 'standalone.html');

before(async () => {
  const { promise, resolve: done, reject } = Promise.withResolvers();
  execFile(
    process.execPath,
    [path.join(ROOT, 'tools', 'build-standalone.mjs')],
    { cwd: ROOT, env: { ...process.env, STANDALONE_OUT: OUT }, encoding: 'utf-8' },
    (err, stdout, stderr) => {
      buildLog = (stdout || '') + (stderr || '');
      if (err) return reject(new Error(`构建失败：\n${buildLog}`));
      done();
    }
  );
  await promise;
  out = fs.readFileSync(OUT, 'utf-8');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('产物里没有任何指向外部文件的 <link>/<script>（否则打开就 404）', () => {
  const dangling = [];
  for (const m of out.matchAll(/<(?:link|script)\b[^>]*>/g)) {
    const tag = m[0];
    const url = (/href="([^"]+)"/.exec(tag) || /src="([^"]+)"/.exec(tag) || [])[1];
    if (!url) continue;
    if (/^(?:https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
    dangling.push(tag.trim().replace(/\s+/g, ' '));
  }
  assert.deepEqual(dangling, [],
    '单文件版残留了外部引用，双击打开时这些请求会失败：\n  ' + dangling.join('\n  '));
});

test('CSS 与所有 JS 模块都已内联', () => {
  assert.ok(out.includes('<style>'), 'style.css 没被内联');
  assert.ok(!/<link[^>]+rel="stylesheet"/.test(out), '仍有 stylesheet 外链');

  // 脚本清单从 web/index.html 派生，保证「加了模块忘了内联」也会被测出来
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
  const scripts = [...html.matchAll(/<script src="js\/([\w.-]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 8, `解析出的脚本数偏少（${scripts.length}），HTML 结构可能变了`);

  for (const name of scripts) {
    assert.ok(!out.includes(`js/${name}`),
      `仍能看到对 js/${name} 的外部引用，说明它没被内联`);
  }
  // 抽查几个模块确实以代码形式进了产物（用真实存在的全局名，别凭印象编）
  for (const marker of ['CourseForgeRemind', 'CourseForgeICS', 'CourseForgeEdu']) {
    assert.ok(out.includes(marker), `产物里找不到 ${marker} 的代码`);
  }
});

test('PWA 声明已移除，但页面主体结构保持完整', () => {
  assert.ok(!/rel="manifest"/.test(out), 'file:// 下 manifest 无意义，应移除');
  assert.ok(!/rel="apple-touch-icon"/.test(out), '单文件版不该留 apple-touch-icon');
  assert.ok(out.includes('<title>课表工坊 CourseForge</title>'), '标题丢了');
  assert.ok(out.includes('<main class="app-main">'), '主体容器不见了，内联过程可能破坏了 HTML');
  for (const id of ['weeksGrid', 'weekNav', 'settingsPanel']) {
    assert.ok(out.includes(`id="${id}"`), `关键节点 #${id} 不见了`);
  }
});
