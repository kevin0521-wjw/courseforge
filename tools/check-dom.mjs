/**
 * 静态检查（DOM + 资源引用）：
 *  1. JS 中引用的所有 DOM id 必须在 index.html 中存在
 *  2. index.html 引用的本地资源文件（css/js/icon/manifest）必须真实存在
 * 捕获「getElementById 拿到 null」「部署缺文件」这类运行时才暴露的低级错误
 */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(ROOT, 'web');
const html = await readFile(join(WEB, 'index.html'), 'utf-8');
const files = ['core.js', 'storage.js', 'render.js', 'parser.js', 'ics.js', 'importer.js', 'app.js'];

// HTML 中声明的所有 id
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

let missing = [];
let referenced = new Set();

for (const name of files) {
  const code = await readFile(join(WEB, 'js', name), 'utf-8');
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

// ---- 本地资源引用存在性 ----
const refs = [];
for (const m of html.matchAll(/<(?:link|script)[^>]+(?:href|src)="([^"]+)"/g)) {
  const url = m[1];
  if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
  refs.push(url);
}
const missingFiles = [];
for (const url of refs) {
  try {
    await access(join(WEB, url));
  } catch (e) {
    missingFiles.push(url);
  }
}
if (missingFiles.length) {
  console.error('检查失败：index.html 引用了不存在的文件：');
  for (const f of missingFiles) console.error('  - ' + f);
  process.exit(1);
}

console.log(`DOM 静态检查通过：JS 引用的 ${referenced.size} 个 id 全部存在；HTML 引用的 ${refs.length} 个本地资源全部就位`);
