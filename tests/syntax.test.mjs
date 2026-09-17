/**
 * 语法门禁：整个仓库的 JS 必须能被解析。
 *
 * 为什么单独写这条 —— 因为踩过一个代价很大的坑：
 * 一次「被打断的自动编辑」在 desktop/main.js 里留下了一段重复嵌套的循环，
 * 大括号没闭合。表现不是「测试红」，而是**应用一启动就静默退出**：
 * Electron 主进程加载失败 → 没有窗口 → 立刻触发 window-all-closed → 进程退出，
 * 全程零输出、退出码 0，看上去跟「启动成功」几乎一样。
 *
 * 单元测试不会 import main.js（它依赖 electron 运行时），于是这类错误
 * 能一路穿过 340 条用例、CI 全绿、打包成功，直到用户双击图标才发现打不开。
 *
 * `node --check` 只做解析、不执行，正好用来堵这个洞：
 * 零依赖、且专门抓「写完就崩」这一类。
 *
 * ⚠️ 性能教训（第一版踩过）：最初用 execFileSync **串行**检查 130 个文件，
 * 每个文件都要起一个 Node 进程（~200ms），于是这一条测试独占 26 秒 ——
 * 而 `node --test` 是按文件并行的，**全量跑的总耗时被它一家决定**（30 秒里它占 26 秒）。
 * 更糟的是变异检查每条变异都要跑一次全量，21 条变异光在这里就烧掉 9 分钟。
 * 现在改成并发池：同样跑 `node --check`（语义完全不变，不自己造解析器），
 * 只是不再排队。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 要检查的目录；node_modules / 打包产物 / 构建输出一律跳过 */
const SCAN_DIRS = ['desktop', 'web', 'tools', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'release-nsis', 'release-win', '.git']);
const EXT = /\.(js|mjs|cjs)$/;

/** 并发上限：磁盘与进程创建是瓶颈，开太多反而变慢 */
const CONCURRENCY = Math.min(16, Math.max(4, (os.cpus() || []).length * 2));

function collect(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out; // 目录不存在（例如还没构建）→ 跳过
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || /^release[-.]/.test(ent.name)) continue;
      collect(full, out);
    } else if (EXT.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 检查单个文件；语法有问题时返回一行描述，正常返回 null */
function checkOne(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { stdio: 'pipe' }, (err, stdout, stderr) => {
      if (!err) return resolve(null);
      const detail = String(stderr || err.message || '')
        .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' ');
      resolve(path.relative(ROOT, file).replace(/\\/g, '/') + ' → ' + detail);
    });
  });
}

/** 并发池：跑完一批再补下一批，保持并发数恒定 */
async function checkAll(files) {
  const results = new Array(files.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (next < files.length) {
      const i = next++;
      results[i] = await checkOne(files[i]);
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

test('仓库内所有 JS 都能通过语法解析（防止「写完就崩」）', async () => {
  const files = [];
  for (const d of SCAN_DIRS) collect(path.join(ROOT, d), files);

  // 快照一下规模：如果扫描逻辑坏了（比如目录改名），会静默变成 0 个文件，
  // 这个断言保证「检查过」这件事本身不是假的
  assert.ok(files.length > 20, `扫描到的 JS 文件太少（${files.length}），扫描逻辑可能失效`);

  const broken = await checkAll(files);

  assert.deepEqual(broken, [], '存在语法错误的文件：\n' + broken.join('\n'));
});

test('扫描会跳过 node_modules 与打包产物目录', () => {
  const files = [];
  collect(path.join(ROOT, 'desktop'), files);
  const bad = files.filter((f) => /node_modules|[\\/]release/.test(f));
  assert.deepEqual(bad, [], '不该扫到依赖或产物目录');
});
