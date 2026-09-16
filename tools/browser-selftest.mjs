/**
 * 浏览器真机自检：在真实浏览器引擎 + 真实网络下跑 CourseForge 的 PDF 导入链路。
 *
 * 为什么需要它 —— 这是 Node 侧测试覆盖不到的那一段：
 *   · tests/importer-cmap.test.mjs 能验证「源选择」逻辑，但它跑在 Node 里，
 *     覆盖不到浏览器特有的三件事：同源相对路径 fetch、pdf.js worker 的加载、
 *     以及真实网络下各镜像的实际可达性。
 *   · 而 agent-browser 在本机会整段挂死（实测 4 次，3~4 分钟无输出，timeout 也拦不住）。
 *
 * 做法：临时生成一个同源自检页（必须与 cmaps/ 同源，否则跨域取不到），
 * 用 headless Edge 打开，再通过 CDP 直连轮询页面里的结果文本。
 * Node 22 自带全局 WebSocket，说 CDP 协议不需要任何第三方依赖。
 *
 * 用法：
 *   node tools/browser-selftest.mjs [pdf 路径]
 *   （默认用 tests/fixtures/cjk-timetable-rotated.pdf，仓库内合成夹具，无隐私数据）
 *
 * 退出码：0 = 链路跑通且解析出课程；1 = 失败（会把页面输出原样打出来）
 *
 * ⚠️ 需要绕过沙箱运行（启动浏览器进程），例如：
 *   node tools/browser-selftest.mjs            # 在允许 spawn 浏览器的环境下
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PDF = process.argv[2] || path.join(ROOT, 'tests/fixtures/cjk-timetable-rotated.pdf');
const SELFTEST = path.join(WEB, '_selftest.html');

/** 候选浏览器：先环境变量，再常见安装位置（x64 / x86 / Chrome 兜底）。 */
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));

if (!EDGE) {
  console.error('找不到浏览器，试过：\n  ' + EDGE_CANDIDATES.join('\n  ')
    + '\n可用 EDGE_PATH 环境变量指定');
  process.exit(1);
}
if (!fs.existsSync(PDF)) {
  console.error('找不到 PDF：' + PDF);
  process.exit(1);
}

// ==================== 临时静态服务（自检页必须与 cmaps/ 同源）====================

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.bcmap': 'application/octet-stream'
};

function startServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    const file = path.join(WEB, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ==================== 生成自检页 ====================

/**
 * 页面里必须真实复刻生产路径，只把 pdf.js 的源写死成镜像以便定位问题。
 * 结论判据是「解析出课程数」，不是「没报错」—— pdf.js 在 CMap 取不到时只 warn 不抛错。
 */
function makeSelftestHtml(pdfPath) {
  const b64 = fs.readFileSync(pdfPath).toString('base64');
  const ver = '3.11.174';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>CourseForge 真机自检</title></head>
<body style="font:14px/1.6 monospace;white-space:pre-wrap">
<div id="out">running...</div>
<script>
var out = document.getElementById('out'), lines = [];
function log(s) { lines.push(s); out.textContent = lines.join('\\n'); }
var PDF_B64 = '${b64}';
var BASE = 'https://registry.npmmirror.com/pdfjs-dist/${ver}/files/build/';

(async function () {
  try {
    var r = await fetch('cmaps/UniGB-UCS2-H.bcmap');
    var b = await r.arrayBuffer();
    log('[1] 同源取 CMap -> ' + r.status + ' / ' + b.byteLength + ' bytes');
  } catch (e) { log('[1] FAIL ' + e.message); }

  try {
    await new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = BASE + 'pdf.min.js';
      s.onload = res; s.onerror = function () { rej(new Error('pdf.min.js 加载失败')); };
      document.head.appendChild(s);
    });
    log('[2] pdf.js loaded, version=' + window.pdfjsLib.version);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
  } catch (e) { log('[2] FAIL ' + e.message); log('DONE'); return; }

  var doc;
  try {
    var bin = Uint8Array.from(atob(PDF_B64), function (c) { return c.charCodeAt(0); });
    doc = await window.pdfjsLib.getDocument({ data: bin, cMapUrl: 'cmaps/', cMapPacked: true }).promise;
    var page = await doc.getPage(1);
    var tc = await page.getTextContent();
    var chars = tc.items.reduce(function (n, i) { return n + (i.str || '').replace(/\\s/g, '').length; }, 0);
    var rotated = tc.items.filter(function (i) { return Math.abs(i.transform[1]) > 0.01; }).length;
    log('[3] page.rotate=' + page.rotate + '  items=' + tc.items.length + '  rotated=' + rotated + '  chars=' + chars);
    if (chars === 0) log('[3] !! 0 个字符 —— CMap 链路失败');
    window.__items = tc.items;
  } catch (e) { log('[3] FAIL ' + (e && e.message)); }

  try {
    await Promise.all(['js/pdf-layout.js', 'js/parser.js'].map(function (u) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = u; s.onload = res; s.onerror = function () { rej(new Error(u + ' 加载失败')); };
        document.head.appendChild(s);
      });
    }));
    var lay = window.CoursePdfLayout.layoutToText(window.__items);
    log('[4] isTable=' + lay.isTable + ' rows=' + lay.rows + ' cols=' + lay.cols);
    var res = window.CourseParser.parseScheduleText(lay.text);
    log('[4] RESULT courses=' + res.items.length);
    var D = ['', '一', '二', '三', '四', '五', '六', '日'];
    res.items.forEach(function (c) {
      log('     星期' + D[c.day] + ' ' + c.startSection + '-' + c.endSection + '  ' + c.name + ' / ' + (c.teacher || '-'));
    });
  } catch (e) { log('[4] FAIL ' + (e && e.message)); }

  if (doc) { try { await doc.destroy(); } catch (e) {} }
  log('DONE');
})();
</script></body></html>`;
}

// ==================== CDP 直连 ====================

async function waitForPageTarget(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* 端口还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 端口 ' + port + ' 上没有 page target');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });
  return { ws, ready, send };
}

// ==================== 主流程 ====================

let server = null;
let edge = null;
let cdp = null;
let profile = null;
let resultText = '';
let passed = false;

try {
  fs.writeFileSync(SELFTEST, makeSelftestHtml(PDF), 'utf8');
  server = await startServer();
  const port = server.address().port;
  const cdpPort = 9400 + (process.pid % 500);
  // profile 必须放系统临时目录：放仓库里会污染工作区，而且 Edge 退出后仍锁着文件，
  // 清理经常失败（初版就是固定在仓库根，留下了一坨 _edgeprofile/）。
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-selftest-'));

  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort, 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  const target = await waitForPageTarget(cdpPort);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/_selftest.html` });
  await sleep(1000);

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('out') ? document.getElementById('out').textContent : '(无 #out)'",
      returnByValue: true
    });
    resultText = (r && r.result && r.result.value) || '';
    if (/\bDONE\b/.test(resultText)) break;
    await sleep(400);
  }

  console.log(resultText || '(空)');
  const done = /\bDONE\b/.test(resultText);
  const m = /RESULT courses=(\d+)/.exec(resultText);
  const courses = m ? Number(m[1]) : 0;
  const chars = (/chars=(\d+)/.exec(resultText) || [, '0'])[1];
  passed = done && courses > 0;
  console.log('\n--- 浏览器：Edge headless + CDP 直连 ---');
  console.log('结论：' + (passed
    ? `✅ 真机链路跑通（提取 ${chars} 字符 → ${courses} 门课）`
    : (done ? '❌ 页面跑完了但没解析出课程' : '❌ 超时，页面未跑完')));
} catch (e) {
  console.error('自检失败：' + (e && e.message));
} finally {
  // 清理顺序：先关浏览器（含子进程树），再停服务，最后删自检页 —— 自检页绝不能留在 web/ 里
  try { if (cdp) { await cdp.send('Browser.close'); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (edge && edge.pid) {
    try {
      if (process.platform === 'win32') {
        // Windows 上 process.kill 只终止父进程，Edge 会留一堆子进程变孤儿
        spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-edge.pid, 'SIGKILL'); // detached 已单开进程组，负号杀整组
      }
    } catch { /* 忽略 */ }
  }
  try { if (server) server.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(SELFTEST, { force: true }); } catch { /* 忽略 */ }
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 锁着就留给系统清理 */ }
  if (fs.existsSync(SELFTEST)) {
    console.error('⚠️ 未能删除 ' + SELFTEST + '，请手工确认，别把它部署上去');
  } else {
    console.log('已清理临时自检页');
  }
}

process.exit(passed ? 0 : 1);
