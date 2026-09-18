/**
 * 桌面端导入链路真机自检（npm run check:import-edu，自带假教务服务器，不碰真教务）
 *
 * 覆盖：
 *   1. PDF 导入：真文件 → CDP setFileInputFiles → pdf.js（CDN 懒加载 + 源诊断）
 *   2. 照片 OCR：canvas 现画课表图 → Tesseract chi_sim（含 normalizeOcrText 归一化回归）
 *   3. 教务直连端到端：本地「假教务系统」（正方 V9 登录页同构 + kbList 接口），真走 edu:open/edu:login/edu:courses 三个 IPC
 *   1. PDF 导入：真文件 → CDP setFileInputFiles → pdf.js（CDN 懒加载）
 *   2. 照片 OCR：canvas 现画课表图 → Tesseract chi_sim
 *   3. 教务直连端到端：本地起「假教务系统」（正方 V9 登录页同构 + kbList 接口），
 *      真走 edu:open/edu:login/edu:courses 三个 IPC —— 不碰真教务、不用真账号。
 * 退出码 0 = 可行链路全部跑通。
 */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const PDF_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'cjk-timetable-rotated.pdf');
const SHOTS = path.join(ROOT, '.shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail != null ? '  —— ' + detail : ''));
}

// ==================== 假教务系统（正方 jwglxt 同构的最小实现） ====================

/** 与 tests/fixtures/jwxt-login-real.html 同构的关键 id：yhm/mm/dl/tips/dlktsxx/dlsfbxyzm/csrftoken/xxdm */
const LOGIN_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>用户登录-假教务</title></head>
<body>
<form id="slogin_form" method="post">
  <input id="yhm" name="yhm" type="text">
  <input id="mm" name="mm" type="password">
  <input id="dlsfbxyzm" type="hidden" value="0">
  <input id="csrftoken" type="hidden" value="fake-csrf-token">
  <input id="xxdm" type="hidden" value="10280">
  <div id="yzmDiv" style="display:none"><input id="yzm" type="text"></div>
  <div id="tips" style="display:none"></div>
  <div id="dlktsxx" style="display:none"></div>
  <button id="dl" type="button">登 录</button>
</form>
<script>
document.getElementById('dl').addEventListener('click', function () {
  var kt = document.getElementById('dlktsxx');
  kt.textContent = '';
  fetch('/jwglxt/xtgl/login_slogin.html', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'yhm=' + encodeURIComponent(document.getElementById('yhm').value)
        + '&mm=' + encodeURIComponent(document.getElementById('mm').value)
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.success) { location.href = '/jwglxt/frt/index.jsp'; return; }
    kt.textContent = (j && j.message) || '用户名或密码错误';
    kt.style.display = 'block';
  })['catch'](function (e) { kt.textContent = '网络错误：' + e.message; kt.style.display = 'block'; });
});
</script></body></html>`;

const INDEX_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>学生主页-假教务</title></head>
<body>
<ul id="menu">
  <li><a href="/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151">学生课表查询</a></li>
  <li><a href="/jwglxt/xsxxx/xsxxgl_cxXsxx.html?gnmkdm=N100801">个人信息</a></li>
</ul>
</body></html>`;

const KB_PAGE_HTML = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>学生课表查询-假教务</title></head>
<body>
<select id="xnm"><option value="2024">2024-2025学年</option><option value="2025" selected>2025-2026学年</option></select>
<select id="xqm"><option value="3" selected>第1学期</option><option value="12">第2学期</option></select>
<div id="kbTable"></div>
</body></html>`;

const KB_LIST = JSON.stringify({
  kbList: [
    { kcmc: '高等数学A1', xqj: '1', jcs: '3-4节', zcd: '1-16周', xm: '张三', xqmc: '宝山校区', cdmc: 'D楼202' },
    { kcmc: '数据结构', xqj: '3', jcs: '5,6节', zcd: '1-16周(单)', xm: '李四', xqmc: '宝山校区', cdmc: 'BJ102' },
    { kcmc: '大学英语', xqj: '5', jcs: '1-2节', zcd: '1-16周', xm: '王五', xqmc: '宝山校区', cdmc: 'A楼305' },
    { kcmc: '操作系统', xqj: '2', jcs: '3-4节', zcd: '1-16周', xm: '孙七', xqmc: '宝山校区', cdmc: 'C楼401' }
  ]
});

function startFakeEdu() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const send = (code, body, type) => {
      res.writeHead(code, { 'Content-Type': type || 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (p === '/jwglxt/xtgl/login_slogin.html') {
      if (req.method === 'POST') {
        let d = '';
        req.on('data', (c) => { d += c; });
        req.on('end', () => send(200, JSON.stringify({ success: true }), 'application/json; charset=utf-8'));
        return;
      }
      return send(200, LOGIN_HTML);
    }
    if (p === '/jwglxt/frt/index.jsp') return send(200, INDEX_HTML);
    if (p === '/jwglxt/kbcx/xskbcx_cxXsgrkb.html' || p === '/jwglxt/kbcx/xskbcx_cxXsKb.html') {
      if (req.method === 'POST') return send(200, KB_LIST, 'application/json; charset=utf-8');
      return send(200, KB_PAGE_HTML);
    }
    send(404, 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    server.unref(); // 别让探针进程被服务器挂着不退出
    resolve(server);
  }));
}

// ==================== CDP ====================

async function waitForPageTarget(port, urlHint) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl
        && (!urlHint || (x.url || '').indexOf(urlHint) !== -1))
        || list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* 还没起 */ }
    await sleep(300);
  }
  throw new Error('CDP 没等到 page target');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  return { ws, ready, send };
}

async function evalJs(cdp, expr, timeoutMs = 15000) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => { throw new Error('evaluate 超时'); })
  ]);
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result ? r.result.value : undefined;
}

const SNAP = `JSON.stringify((function () {
  var g = function (id) { return document.getElementById(id); };
  var st = g('importStatus'), res = g('importResult'), btn = g('btnImportApply');
  var rows = res ? res.querySelectorAll('tbody tr').length : 0;
  var names = [];
  if (res) res.querySelectorAll('tbody tr input[data-field="name"]').forEach(function (i) { names.push(i.value); });
  return { status: st && !st.hidden ? st.textContent.trim() : '', rows: rows, names: names,
           applyEnabled: !!btn && !btn.disabled, hasDesktopBridge: !!window.CourseForgeDesktop };
})())`;

async function pollUntil(cdp, snapExpr, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { last = await evalJs(cdp, snapExpr, 10000); } catch (e) { last = 'ERR ' + e.message; }
    if (pred(last)) return last;
    await sleep(1500);
  }
  throw new Error('轮询超时（' + label + '），最后快照: ' + String(last).slice(0, 300));
}

const shot = async (cdp, name) => {
  for (const fromSurface of [true, false]) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface }, 15000).catch(() => null);
    if (s && s.data) {
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(s.data, 'base64'));
      return path.join(SHOTS, name);
    }
  }
  return null;
};

const MAKE_IMAGE = `(async function () {
  var c = document.createElement('canvas');
  c.width = 1600; c.height = 560;
  var x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#000'; x.font = '54px "Microsoft YaHei", sans-serif'; x.textBaseline = 'top';
  var lines = [
    '高等数学A1 周一 3-4节 第1-16周 D楼202 张三',
    '数据结构 周三 5,6节 1-16周(单) BJ102 李四',
    '大学英语 周二 1-2节 1-16周 A楼305 王五',
    '操作系统 周四 3-4节 1-16周 C楼401 孙七',
    '大学体育 周五 18:00-19:40 体育馆 赵六'
  ];
  for (var i = 0; i < lines.length; i++) x.fillText(lines[i], 60, 40 + i * 100);
  var blob = await new Promise(function (res) { c.toBlob(res, 'image/png'); });
  var dt = new DataTransfer();
  dt.items.add(new File([blob], 'tt.png', { type: 'image/png' }));
  var inp = document.getElementById('importImage');
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched';
})()`;

// ==================== 主流程 ====================

let electron = null, cdp = null, profile = null, fakeEdu = null;
try {
  fakeEdu = await startFakeEdu();
  const eduPort = fakeEdu.address().port;
  console.log('假教务系统: http://127.0.0.1:' + eduPort + '（正方同构，登录→菜单→学期→kbList）');

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-import-desk-'));
  const cdpPort = 9460 + (process.pid % 400);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS; // 宿主注入的 shim 会干扰 Electron 子进程网络/启动
  env.COURSEFORGE_SAFE_MODE = '1'; // 沙箱 GPU 崩溃 → 产品自带安全模式（用户真机无需）
  electron = spawn(ELECTRON, ['.', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile],
    { cwd: DESKTOP, env, stdio: 'ignore' });

  const target = await waitForPageTarget(cdpPort, 'index.html');
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await pollUntil(cdp, "String(document.readyState)", (s) => s === 'complete', 30000, '应用加载');
  const bridge = await evalJs(cdp, "String(!!window.CourseForgeDesktop)");
  check('桌面端：preload 桥已注入', bridge === 'true', 'bridge=' + bridge);

  // ---------- 链路 1：PDF ----------
  // 诊断：沙箱里 Electron GUI 进程的「第一个外网请求」有被吞的历史（update-e2e 教训），
  // 先逐个试 CDN 候选并汇报，再决定是产品问题还是环境问题
  const cdnDiag = JSON.parse(await evalJs(cdp, `(async function () {
    var urls = [
      'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/build/pdf.min.js',
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js'
    ];
    var out = [];
    for (var i = 0; i < urls.length; i++) {
      out.push(await new Promise(function (res) {
        var done = false;
        var s = document.createElement('script');
        s.src = urls[i];
        s.onload = function () { if (!done) { done = true; res('load'); } };
        s.onerror = function () { if (!done) { done = true; res('error'); } };
        document.head.appendChild(s);
        setTimeout(function () { if (!done) { done = true; res('timeout'); } }, 15000);
      }));
    }
    return JSON.stringify({ results: out, libLoaded: typeof window.pdfjsLib !== 'undefined' });
  })()`, 60000));
  check('PDF：CDN 候选诊断（npmmirror/jsdelivr/unpkg）', true,
    cdnDiag.results.join(' / ') + '，pdfjsLib=' + cdnDiag.libLoaded);

  const doc = await cdp.send('DOM.getDocument', { depth: 1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importPdf' });
  await cdp.send('DOM.setFileInputFiles', { files: [PDF_FIXTURE], nodeId: q.nodeId });
  await evalJs(cdp, `document.getElementById('importPdf').dispatchEvent(new Event('change', { bubbles: true })); 'ok'`);
  let pdfO = null;
  try {
    const s = await pollUntil(cdp, SNAP, (v) => {
      const o = JSON.parse(v);
      return o.rows > 0 || /失败|没有解析出|无法|引擎/.test(o.status.replace('正在加载 PDF 引擎…', ''));
    }, 240000, '桌面 PDF 解析');
    pdfO = JSON.parse(s);
  } catch (e) {
    check('PDF：解析出课程', false, e.message);
  }
  if (pdfO) {
    check('PDF：解析出课程（真机 pdf.js）', pdfO.rows > 0,
      pdfO.rows + ' 门：' + pdfO.names.slice(0, 4).join('、') + (pdfO.status ? ' | 状态: ' + pdfO.status : ''));
    check('PDF：「导入所选」按钮已激活', pdfO.applyEnabled);
  }
  await shot(cdp, 'import-pdf-desktop.png');

  // ---------- 链路 2：照片 OCR ----------
  let ocrSnap = '';
  try {
    // 先清空上一链路的结果，防止轮询吃到残留行（首轮教训：PDF 的 12 行被误认成 OCR 结果）
    await evalJs(cdp, `document.getElementById('importResult').innerHTML = '';
      var sm = document.getElementById('importSummary'); if (sm) sm.textContent = ''; 'ok'`);
    await evalJs(cdp, MAKE_IMAGE, 20000);
    ocrSnap = await pollUntil(cdp, SNAP, (v) => {
      const o = JSON.parse(v);
      return o.rows > 0 || /识别失败|没有解析出|未识别出/.test(o.status);
    }, 300000, '桌面 OCR');
  } catch (e) {
    check('照片 OCR：真引擎全链路', false, e.message);
  }
  if (ocrSnap) {
    const ocrO = JSON.parse(ocrSnap);
    const expect = ['高等数学A1', '数据结构', '大学英语', '操作系统', '大学体育'];
    const hit = expect.filter((n) => ocrO.names.some((m) => m.indexOf(n) !== -1));
    check('照片 OCR：Tesseract chi_sim 真引擎识别出课程', ocrO.rows > 0,
      ocrO.rows + ' 行 / 命中 ' + hit.length + '/' + expect.length + '：' + hit.join('、')
      + ' | 全部行: ' + ocrO.names.join('、'));
    check('照片 OCR：识别率过半（≥3/5）', hit.length >= 3, '命中 ' + hit.length + ' 门');
    await shot(cdp, 'import-ocr-desktop.png');
  }

  // ---------- 链路 3：教务直连端到端（假教务服务器） ----------
  let eduState = null;
  try {
    eduState = JSON.parse(await evalJs(cdp, `JSON.stringify((function () {
    var g = function (id) { return document.getElementById(id); };
    var tab = document.querySelector('[data-imp-tab="edu"]');
    if (tab) tab.click();
    var dp = g('eduDesktopPane'), wh = g('eduWebHint');
    return { desktopPaneVisible: !!dp && !dp.hidden, webHintHidden: !wh || wh.hidden };
  })())`));
  } catch (e) {
    check('教务直连（桌面端）：显示完整表单（不引导粘贴）', false, '页面求值失败: ' + e.message);
  }
  if (eduState) {
    check('教务直连（桌面端）：显示完整表单（不引导粘贴）',
      eduState.desktopPaneVisible && eduState.webHintHidden, JSON.stringify(eduState));
  }

  // 填表并点「一键登录并取课表」；求值失败不拖垮后续清理
  let eduClicked = false;
  try {
    await evalJs(cdp, `(function () {
    var g = function (id) { return document.getElementById(id); };
    g('eduUrl').value = 'http://127.0.0.1:${eduPort}';
    g('eduUser').value = '26123456';
    g('eduPass').value = 'Fake@2026';
    var btn = document.querySelector('[data-action="edu-autologin"]');
    btn.click();
    return 'clicked';
  })()`);
    eduClicked = true;
  } catch (e) {
    check('教务直连：登录→菜单发现→学期→接口取课表 全链路', false, '填表求值失败: ' + e.message);
  }
  let eduSnap = '';
  if (eduClicked) {
    try {
      eduSnap = await pollUntil(cdp, SNAP, (v) => {
        const o = JSON.parse(v);
        // ⚠️ 首轮教训：状态文案自带「（若学校开启验证码…）」括号说明，/验证码/ 会误匹配。
        // 只认终态词，且排除「正在…」进行时
        if (/^正在/.test(o.status)) return false;
        return /已从教务接口取到|已从课表页面识别出|接口已连上|读取失败|登录失败|登录没成功|要验证码|没等到登录表单|没找到用户名/.test(o.status);
      }, 150000, '教务端到端');
    } catch (e) {
      check('教务直连：登录→取课表端到端', false, e.message);
    }
  }
  if (eduSnap) {
    const eduO = JSON.parse(eduSnap);
    const m = /已从教务接口取到 (\d+) 门课/.exec(eduO.status);
    check('教务直连：登录→菜单发现→学期→接口取课表 全链路', !!m,
      '状态: ' + eduO.status + (m ? '（假教务返回 4 门，解析出 ' + m[1] + ' 门）' : ''));
    if (m) {
      check('教务直连：4 门课全部解析且进确认表', Number(m[1]) === 4 && eduO.rows === 4,
        '确认表 ' + eduO.rows + ' 行: ' + eduO.names.join('、'));
    }
    await shot(cdp, 'import-edu-desktop.png');
  }
} catch (e) {
  console.error('探针异常：' + (e && e.message));
  results.push({ name: '探针完整性', ok: false, detail: e.message });
} finally {
  // Browser.close 在渲染进程挂死时会无限等 —— 必须 race 超时，否则探针自己挂住不退出
  try { if (cdp) { await Promise.race([cdp.send('Browser.close'), sleep(5000)]).catch(() => {}); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (electron && electron.pid) {
    try { spawnSync('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
  try { spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  try { if (fakeEdu) { try { fakeEdu.closeAllConnections && fakeEdu.closeAllConnections(); } catch {} fakeEdu.close(); } } catch { /* 忽略 */ }
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 留给系统 */ }
}

const fail = results.filter((r) => !r.ok);
console.log('\n===== 桌面端导入链路：' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
process.exit(fail.length ? 1 : 0);
