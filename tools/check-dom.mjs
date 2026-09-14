/**
 * DOM 静态检查：确认 JS 中引用的所有 DOM id 在 index.html 中真实存在
 * 捕获「getElementById 拿到 null」这类运行时才暴露的低级错误
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(join(ROOT, 'web', 'index.html'), 'utf-8');
const files = ['core.js', 'storage.js', 'render.js', 'parser.js', 'importer.js', 'app.js'];

// HTML 中声明的所有 id
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

let missing = [];
let referenced = new Set();

for (const name of files) {
  const code = await readFile(join(ROOT, 'web', 'js', name), 'utf-8');
  // getElementById('x') / getElementById("x")
  for (const m of code.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) {
    referenced.add(m[1]);
  }
  // querySelector('#x')
  for (const m of code.matchAll(/querySelector\(\s*['"]#([\w-]+)['"]\s*\)/g)) {
    referenced.add(m[1]);
  }
}

for (const id of referenced) {
  if (!htmlIds.has(id)) missing.push(id);
}

if (missing.length) {
  console.error('检查失败：以下 id 被 JS 引用但在 index.html 中不存在：');
  for (const id of missing) console.error('  - #' + id);
  process.exit(1);
}

console.log(`DOM 静态检查通过：JS 引用的 ${referenced.size} 个 id 全部存在于 index.html`);
