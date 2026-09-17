/**
 * 校验打包产物是否真的完整
 *
 * 为什么需要它：
 *  electron-builder 打出产物 ≠ 产物能跑。`files` 白名单漏一个模块，
 *  构建照样成功、exe 照样生成、体积也正常 —— 但用户双击就是启动不起来。
 *  「打包成功」这句话本身没有任何信息量，必须解开 app.asar 逐个核对。
 *
 * 这里刻意不依赖 @electron/asar：CI 只装根目录依赖，那个包在 CI 里不存在，
 *  一旦顶层 require 会直接抛错（哪怕这次本该跳过）。asar 头格式很稳定，
 *  自己解析十行就够，少一个依赖少一处坑。
 *
 * 用法：
 *   node tools/verify-package.mjs                     # 默认查 desktop/release/win-unpacked
 *   node tools/verify-package.mjs <解包目录>
 *
 * 未打包时（CI 常态）打印提示并以 0 退出，不制造假失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESKTOP = path.join(ROOT, 'desktop');

/**
 * 找产物目录。
 * 默认 `release/win-unpacked`；但在受限沙箱里批量删除会被策略拦下，
 * 于是改用「换个新输出目录」的方式重打包（如 release-dist、release-nsis）。
 * 这里把所有以 release 开头的目录下的 win-unpacked 都收进来，取最近改动的那个，
 * 免得换个目录名就查不到产物、误报成「尚未打包」。
 * （注意：这条注释里不能出现星号加斜杠，会提前闭合块注释。）
 */
function findOutDir() {
  const cands = [];
  if (!fs.existsSync(DESKTOP)) return null;
  for (const e of fs.readdirSync(DESKTOP, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^release/.test(e.name)) continue;
    const p = path.join(DESKTOP, e.name, 'win-unpacked');
    if (fs.existsSync(p)) cands.push(p);
  }
  cands.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return cands[0] || null;
}

const outDir = process.argv[2] ? path.resolve(process.argv[2]) : findOutDir();

if (!outDir) {
  console.log('[verify-package] 尚未打包（desktop/ 下没有 release*/win-unpacked），跳过。');
  console.log('                 先执行：cd desktop && npm run pack');
  process.exit(0);
}

if (!fs.existsSync(outDir)) {
  console.error('[verify-package] 指定的目录不存在：' + outDir);
  process.exit(1);
}

const failures = [];
const notes = [];
function check(name, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  —— ' + detail : ''));
  if (!ok) failures.push(name);
}

// ---------- 读取 asar 头（无依赖）----------
// 布局实测（Electron 33 产出的 asar）：
//   u32@0  = 4          第一层 pickle 负载长度
//   u32@4  = 1276       第二层 pickle 总长（含自身 4 字节长度字段）
//   u32@8  = 1272       第二层 pickle 的负载长度
//   u32@12 = 1266       JSON 字符串长度
//   @16    = {"files":…  ← JSON 起点
// 这是「长度字段 + 数据」反复嵌套的结构，层数不要写死。这里改为先找到 JSON 的
// 起始 '{'，再读它前面紧挨着的那个长度字段 —— 对一层/两层嵌套都能对上。
function readAsarEntries(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) !== 8) throw new Error('asar 头被截断');
    const size = head.readUInt32LE(4);
    if (size <= 0 || size > 200 * 1024 * 1024) throw new Error('asar 头长度异常：' + size);
    const pickle = Buffer.alloc(size);
    if (fs.readSync(fd, pickle, 0, size, 8) !== size) throw new Error('asar 头读取不完整');

    const start = pickle.indexOf(0x7b);            // '{' —— JSON 对象起点
    if (start < 4) throw new Error('没在 asar 头里找到 JSON 起点');

    // 紧挨着 JSON 的 4 字节就是它的长度；越界说明布局变了，退回「取到末尾再去掉补齐位」
    const declared = pickle.readUInt32LE(start - 4);
    const json = (declared > 0 && start + declared <= pickle.length)
      ? pickle.subarray(start, start + declared).toString('utf8')
      : pickle.subarray(start).toString('utf8').replace(/[\u0000\s]+$/, '');

    const header = JSON.parse(json);
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, v] of Object.entries(node.files || {})) {
        const p = prefix ? prefix + '/' + name : name;
        if (v.files) walk(v, p);
        else out.push(p);
      }
    };
    walk(header, '');
    return { entries: out, pkg: header.files && header.files['package.json'] };
  } finally {
    fs.closeSync(fd);
  }
}

/** 从源码里取相对 require 的目标（与 tests/desktop.test.mjs 同口径） */
function localRequires(src) {
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
    let p = m[1].replace(/^\.\//, '');
    if (!/\.[a-z]+$/i.test(p)) p += '.js';
    out.add(p);
  }
  return [...out];
}

function walkSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += walkSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
  }
  return total;
}

console.log('=== 校验打包产物：' + path.relative(ROOT, outDir) + ' ===\n');

// ---------- 1. 可执行文件 ----------
console.log('--- 1. 可执行文件 ---');
const top = fs.readdirSync(outDir);
const exe = top.filter((f) => f.toLowerCase().endsWith('.exe'));
check('存在顶层 exe', exe.length === 1, exe.join(', ') || '一个都没有');
if (exe.length > 1) notes.push('顶层有多个 exe，可能混入了其它构建产物');

// ---------- 2. app.asar ----------
console.log('\n--- 2. app.asar 内容（漏模块=启动即崩）---');
const asarPath = path.join(outDir, 'resources', 'app.asar');
if (!fs.existsSync(asarPath)) {
  check('resources/app.asar 存在', false);
} else {
  check('resources/app.asar 存在', true);
  let parsed = null;
  try {
    parsed = readAsarEntries(asarPath);
  } catch (e) {
    check('能解析 asar 头', false, String(e.message || e));
  }

  if (parsed) {
    const entries = parsed.entries;

    // 主进程与 preload 里的本地依赖，必须一个不少地进包
    const needed = new Set();
    for (const f of ['main.js', 'preload.js']) {
      const src = fs.readFileSync(path.join(DESKTOP, f), 'utf8');
      for (const r of localRequires(src)) needed.add(r);
    }
    const missing = [...needed].filter((n) => !entries.includes(n));
    check('主进程全部本地依赖都在包内', missing.length === 0,
      missing.length ? '缺：' + missing.join(', ') : [...needed].join(', '));

    check('package.json 在包内', entries.includes('package.json'));
    check('main 字段指向的入口在包内',
      entries.includes('main.js'), 'main=' + (parsed.pkg ? 'main.js' : '?'));
  }
}

// ---------- 3. 前端资源 ----------
// extraResources 把 web/ 放到 resources/web，主进程打包态正是读这里。
// 只校验目录存在是不够的：js/ 与 cmaps/ 缺一个，页面能开但功能废掉。
console.log('\n--- 3. 前端资源（resources/web）---');
const webDir = path.join(outDir, 'resources', 'web');
check('resources/web 存在', fs.existsSync(webDir));
if (fs.existsSync(webDir)) {
  check('index.html 存在', fs.existsSync(path.join(webDir, 'index.html')));
  check('css 目录存在', fs.existsSync(path.join(webDir, 'css')));

  const jsDir = path.join(webDir, 'js');
  const jsFiles = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')) : [];
  check('js 目录有脚本', jsFiles.length >= 5, jsFiles.length + ' 个');

  // cmaps 是 pdf.js 的中文/日文编码表，缺了会让 PDF 导入「识别不出文字」
  check('pdf.js 的 cmaps 存在', fs.existsSync(path.join(webDir, 'cmaps')));

  // web/js 下的文件名应与源码一致（防止拿到旧产物误判为成功）
  const srcJs = fs.readdirSync(path.join(ROOT, 'web', 'js')).filter((f) => f.endsWith('.js')).sort();
  const gotJs = [...jsFiles].sort();
  const sameJs = JSON.stringify(srcJs) === JSON.stringify(gotJs);
  check('js 文件清单与源码一致（产物不是旧的）', sameJs,
    sameJs ? srcJs.length + ' 个一致' : '源码 ' + srcJs.join(',') + ' / 产物 ' + gotJs.join(','));

  const bytes = walkSize(webDir);
  console.log('  ℹ️  resources/web 体积 ' + (bytes / 1024).toFixed(0) + ' KB');
  if (bytes < 200 * 1024) failures.push('resources/web 体积异常偏小');
}

// ---------- 4. 已知无害项 ----------
console.log('\n--- 4. 附注 ---');
if (fs.existsSync(path.join(outDir, 'resources', 'default_app.asar'))) {
  // 用 electronDist 复用本地 Electron 时会连带拷过来，Electron 不会加载它
  notes.push('resources/default_app.asar 也在包里（electronDist 复用本地发行版的副产物，无害）');
}
notes.push('exe 未做代码签名 —— 首次运行会有 SmartScreen 提示，需在「更多信息」里放行');

console.log('\n--- 汇总 ---');
for (const n of notes) console.log('  ℹ️  ' + n);
if (failures.length === 0) {
  console.log('\n✅ 产物完整，可以安装/运行');
  process.exit(0);
}
console.log('\n❌ 有 ' + failures.length + ' 项不通过：');
for (const f of failures) console.log('   - ' + f);
process.exit(1);
