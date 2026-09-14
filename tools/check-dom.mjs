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
const files = ['core.js', 'storage.js', 'render.js', 'parser.js', 'edu-html.js', 'ics.js', 'importer.js', 'app.js'];

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

// ---- data-action 接线校验 ----
// 页面/render.js 里写的每个 data-action 必须在 app.js 的 ACTIONS 表里有对应处理函数。
// 捕获的典型 bug：新加了按钮但忘了在 ACTIONS 里注册 → 点击毫无反应（静默失败）。
const appCode = await readFile(join(WEB, 'js', 'app.js'), 'utf-8');
const renderCode = await readFile(join(WEB, 'js', 'render.js'), 'utf-8');

const actionsBlock = appCode.match(/var ACTIONS = \{([\s\S]*?)\n  \};/);
if (!actionsBlock) {
  console.error('检查失败：app.js 中未找到 ACTIONS 映射表');
  process.exit(1);
}
const registered = new Set();
for (const m of actionsBlock[1].matchAll(/['"]([\w-]+)['"]\s*:/g)) registered.add(m[1]);

// 其它模块可以自带委托处理（如 importer.js 的导入弹窗），
// 形式为 if (action === 'x') {...}，这里一并收集，避免误报。
for (const name of files) {
  const code = await readFile(join(WEB, 'js', name), 'utf-8');
  for (const m of code.matchAll(/action\s*===\s*['"]([\w-]+)['"]/g)) registered.add(m[1]);
}

const used = new Set();
for (const src of [html, renderCode, appCode]) {
  for (const m of src.matchAll(/data-action="([\w-]+)"/g)) used.add(m[1]);
  // 模板拼接形式：data-action="' + ... + '" 这类动态值无法静态判定，忽略
}

const unregistered = [...used].filter((a) => !registered.has(a));
if (unregistered.length) {
  console.error('检查失败：以下 data-action 没有在 ACTIONS 中注册（点了不会有反应）：');
  for (const a of unregistered) console.error('  - ' + a);
  process.exit(1);
}

const unused = [...registered].filter((a) => !used.has(a));
console.log(`data-action 检查通过：${used.size} 个动作全部已注册${unused.length ? `（另有 ${unused.length} 个已注册但当前未被引用：${unused.join('、')}）` : ''}`);

// ---- CSS 结构合法性 ----
// 浏览器会静默丢弃语法错误的声明块（整段样式凭空消失），这里提前拦住。
const css = await readFile(join(WEB, 'css', 'style.css'), 'utf-8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去掉注释再数括号

let depth = 0;
let line = 1;
let badLine = 0;
for (let i = 0; i < stripped.length; i++) {
  const ch = stripped[i];
  if (ch === '\n') line++;
  else if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth < 0 && !badLine) badLine = line;
  }
}
if (depth !== 0 || badLine) {
  console.error(`检查失败：style.css 大括号不配对${badLine ? `（第 ${badLine} 行出现多余的 }）` : `（结尾缺少 ${depth} 个 }）`}`);
  process.exit(1);
}

// 常见手误：中文标点混进声明、忘记分号导致两条声明粘连
const cjkPunct = stripped.match(/[，；：（）]{1}/);
if (cjkPunct) {
  const at = stripped.slice(0, cjkPunct.index).split('\n').length;
  console.error(`检查失败：style.css 第 ${at} 行出现中文标点（CSS 里必须用半角 , ; : ()）`);
  process.exit(1);
}

const ruleCount = (stripped.match(/\{/g) || []).length;
console.log(`CSS 结构检查通过：${ruleCount} 个规则块，大括号配对、无中文标点`);

// ---- 桌面端 IPC 通道名一致性 ----
// preload 里 ipcRenderer.invoke('x') 与 main 里 ipcMain.handle('x') 必须一一对应。
// 通道名写错不会报错，只会让 Promise 永远挂着（按钮点了没反应），属于最难查的一类 bug。
try {
  const preload = await readFile(join(ROOT, 'desktop', 'preload.js'), 'utf-8');
  const main = await readFile(join(ROOT, 'desktop', 'main.js'), 'utf-8');

  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([\w:-]+)['"]/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\(\s*['"]([\w:-]+)['"]/g)].map((m) => m[1]));

  const orphanInvoke = [...invoked].filter((c) => !handled.has(c));
  const orphanHandle = [...handled].filter((c) => !invoked.has(c));
  if (orphanInvoke.length) {
    console.error('检查失败：preload 调用了主进程没有注册的 IPC 通道（会永远等待）：');
    for (const c of orphanInvoke) console.error('  - ' + c);
    process.exit(1);
  }
  if (orphanHandle.length) {
    console.warn(`提示：主进程注册了但页面未使用的 IPC 通道：${orphanHandle.join('、')}`);
  }
  console.log(`IPC 通道检查通过：${invoked.size} 个通道名在 preload 与 main 之间一一对应`);
} catch (e) {
  // desktop/ 缺失不算失败（比如只分发 web/ 的场景）
  console.log('IPC 通道检查跳过：未找到 desktop/ 目录');
}

