/**
 * 网页版导入链路真机自检（npm run check:import-web，需先 npm run start:web）
 *
 * 覆盖：
 *   1. PDF 导入：真文件（cjk-timetable-rotated.pdf）→ CDP setFileInputFiles → pdf.js 解析
 *   2. 照片 OCR：canvas 现画课表图 → Tesseract chi_sim 真引擎（2026-09-19 抓到并修复字间空格 bug）
 *   3. 教务直连：网页版必须显示「同源策略」引导（设计如此）
 *   1. PDF 导入：真文件（cjk-timetable-rotated.pdf）→ CDP setFileInputFiles → pdf.js 解析
 *   2. 照片 OCR：页面里 canvas 现画一张课表图 → DataTransfer 塞进 #importImage → Tesseract chi_sim
 *   3. 教务直连：网页版必须显示「同源策略」引导（设计如此），断言面板切换正确
 * headless Edge + CDP 直连（agent-browser 在本机不可用的替代方案）。
 * 退出码 0 = 三条全部可行。
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'cjk-timetable-rotated.pdf');
const SHOTS = path.join(ROOT, '.shots');
const APP_URL = 'http://localhost:5173/';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error('找不到浏览器'); process.exit(1); }
if (!fs.existsSync(PDF_FIXTURE)) { console.error('找不到 PDF 夹具'); process.exit(1); }
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail == null ? '' : String(detail) });
  console.log((ok ? '✅' : '❌') + ' ' + name + (detail != null ? '  —— ' + detail : ''));
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
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

/** 页面求值：async 函数内部 stringify（async 返回 Promise 外层序列化是 {}） */
async function evalJs(cdp, expr, timeoutMs = 15000) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => { throw new Error('evaluate 超时: ' + expr.slice(0, 60)); })
  ]);
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result ? r.result.value : undefined;
}

const shot = async (cdp, name) => {
  for (const fromSurface of [true, false]) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface }, 15000).catch(() => null);
    if (s && s.data) {
      const file = path.join(SHOTS, name);
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      // 墨量自检：纯白图不算截到
      let dark = 0;
      const buf = Buffer.from(s.data, 'base64');
      for (let i = 0; i < buf.length; i += 997 * 4) { if (buf[i] < 200) dark++; }
      if (dark > 3) return file;
    }
  }
  return null;
};

/** 轮询直到 fn(快照) 为真 */
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

const SNAP = `JSON.stringify((function () {
  var g = function (id) { return document.getElementById(id); };
  var st = g('importStatus'), res = g('importResult'), sum = g('importSummary'), btn = g('btnImportApply');
  var rows = res ? res.querySelectorAll('tbody tr').length : 0;
  var names = [];
  if (res) res.querySelectorAll('tbody tr input[data-field="name"]').forEach(function (i) { names.push(i.value); });
  return {
    status: st && !st.hidden ? st.textContent.trim() : '',
    rows: rows,
    names: names,
    summary: sum ? sum.textContent.trim() : '',
    applyEnabled: !!btn && !btn.disabled
  };
})())`;

// OCR 用的课表图：页面里现画（白底黑字大号微软雅黑，OCR 引擎最容易认的形态）
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

let edge = null, cdp = null, profile = null;
try {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-import-web-'));
  const cdpPort = 9500 + (process.pid % 400);
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort, 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  const target = await waitForPageTarget(cdpPort);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: APP_URL });
  await pollUntil(cdp, "String(document.readyState)", (s) => s === 'complete', 20000, '页面加载');

  // ---------- 链路 1：PDF ----------
  const doc = await cdp.send('DOM.getDocument', { depth: 1 });
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#importPdf' });
  check('PDF：找到 #importPdf 输入框', !!q.nodeId);
  await cdp.send('DOM.setFileInputFiles', { files: [PDF_FIXTURE], nodeId: q.nodeId });
  // 双保险：CDP 设文件在部分版本不派发 change，手动补一次（重复解析同一文件无副作用）
  await evalJs(cdp, `document.getElementById('importPdf').dispatchEvent(new Event('change', { bubbles: true })); 'ok'`);
  const pdfSnap = await pollUntil(cdp, SNAP, (s) => {
    const o = JSON.parse(s);
    return o.rows > 0 || /失败|没有解析出|无法/.test(o.status);
  }, 120000, 'PDF 解析');
  const pdfO = JSON.parse(pdfSnap);
  check('PDF：解析出课程（真机 pdf.js + 版面还原 + 课表解析）', pdfO.rows > 0,
    pdfO.rows + ' 门：' + pdfO.names.slice(0, 4).join('、') + (pdfO.status ? ' | 状态: ' + pdfO.status : ''));
  check('PDF：「导入所选」按钮已激活', pdfO.applyEnabled);
  await shot(cdp, 'import-pdf-web.png');

  // ---------- 链路 2：照片 OCR ----------
  // 先清空 PDF 链路的结果，防止轮询吃到残留行（首轮教训：PDF 的 12 行被误认成 OCR 结果）
  await evalJs(cdp, `document.getElementById('importResult').innerHTML = '';
    var sm = document.getElementById('importSummary'); if (sm) sm.textContent = ''; 'ok'`);
  await evalJs(cdp, MAKE_IMAGE, 20000);
  let ocrSnap = '';
  try {
    ocrSnap = await pollUntil(cdp, SNAP, (s) => {
      const o = JSON.parse(s);
      return o.rows > 0 || /识别失败|没有解析出|未识别出/.test(o.status);
    }, 300000, 'OCR 识别');
  } catch (e) {
    check('照片 OCR：识别引擎全链路', false, e.message);
  }
  if (ocrSnap) {
    const ocrO = JSON.parse(ocrSnap);
    const expect = ['高等数学A1', '数据结构', '大学英语', '操作系统', '大学体育'];
    const hit = expect.filter((n) => ocrO.names.some((m) => m.indexOf(n) !== -1));
    check('照片 OCR：Tesseract chi_sim 真引擎识别出课程', ocrO.rows > 0,
      ocrO.rows + ' 行 / 命中 ' + hit.length + '/' + expect.length + '：' + hit.join('、')
      + ' | 全部行: ' + ocrO.names.join('、'));
    check('照片 OCR：识别率过半（≥3/5）', hit.length >= 3, '命中 ' + hit.length + ' 门');
    await shot(cdp, 'import-ocr-web.png');
  }

  // ---------- 链路 3：教务直连（网页版设计 = 引导粘贴） ----------
  const edu = JSON.parse(await evalJs(cdp, `JSON.stringify((function () {
    var g = function (id) { return document.getElementById(id); };
    var tab = document.querySelector('[data-imp-tab="edu"]');
    if (tab) tab.click();
    var desktopPane = g('eduDesktopPane'), webHint = g('eduWebHint');
    return {
      tabOk: !!tab,
      desktopHidden: !desktopPane || desktopPane.hidden,
      hintVisible: !!webHint && !webHint.hidden,
      hintText: webHint ? webHint.textContent.slice(0, 60) : '',
      gotoBtn: !!document.querySelector('[data-action="edu-goto-text"]')
    };
  })())`));
  check('教务直连（网页版）：显示跨域引导而非不可用的表单', edu.tabOk && edu.desktopHidden && edu.hintVisible,
    edu.hintText + '…');
  check('教务直连（网页版）：提供「去粘贴文本」一键切换', edu.gotoBtn);
  await shot(cdp, 'import-edu-web.png');
} catch (e) {
  console.error('探针异常：' + (e && e.message));
  results.push({ name: '探针完整性', ok: false, detail: e.message });
} finally {
  try { if (cdp) { await cdp.send('Browser.close').catch(() => {}); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (edge && edge.pid) {
    try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 留给系统 */ }
}

const fail = results.filter((r) => !r.ok);
console.log('\n===== 网页版导入链路：' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
process.exit(fail.length ? 1 : 0);
