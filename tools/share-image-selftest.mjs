/**
 * 分享图的**真机出图**自检：在真实浏览器里画一遍，然后去数像素。
 *
 * 为什么 Node 测试不够 —— tests/share-image.test.mjs 全部跑在 Node 里，有两件事它永远碰不到：
 *
 *  1. **真实字体度量**。Node 侧必须注入一个确定性的 `estimateWidth`（汉字按 1 个字宽、
 *     西文按 0.55），而浏览器用的是真 `measureText`。两者不一定一致：某些字体栈下
 *     数字串、破折号的实际宽度会超出估算 → 图上文字压到隔壁格子。这个偏差只有真机能测。
 *  2. **canvas 真的画出来了没有**。「指令序列正确」和「画布上确实有那些像素」是两回事：
 *     font 少写 `px`、fillStyle 传了空串、getContext 拿到的其实是另一个 canvas，
 *     这三种情况下指令全对而图是空白的。所以这里的判据是**数像素**，不是「没抛异常」。
 *
 * 做法沿用 tools/browser-selftest.mjs 的 headless Edge + CDP 直连（agent-browser 在本机会挂死）。
 *
 * 用法：node tools/share-image-selftest.mjs
 *      SHARE_OUT=<目录>  额外把两张样图（浅色 / 深色）写到该目录，便于人眼复核
 * 退出码：0 = 全部检查通过；1 = 有检查失败（会把失败项原样打出来）
 *
 * ⚠️ 需要绕过沙箱运行（要 spawn 浏览器进程）。
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
const SELFTEST = path.join(WEB, '_share-selftest.html');

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.bcmap': 'application/octet-stream'
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

// ==================== 自检页 ====================
//
// 页面里的检查项全部是「读真实像素 / 读真实字体宽度」，输出 key=value 形式的行，
// 由外层脚本解析。最后一行固定是 VERDICT pass=<n> fail=<n>。

function makeSelftestHtml() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>CourseForge 分享图自检</title></head>
<body style="font:13px/1.5 monospace;white-space:pre-wrap">
<div id="out">running...</div>
<script>
var out = document.getElementById('out'), lines = [];
function log(s) { lines.push(s); out.textContent = lines.join('\\n'); }

var P = 0, F = 0;
function check(name, ok, detail) {
  if (ok) { P++; log('ok   ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { F++; log('FAIL ' + name + '  [' + detail + ']'); }
}

function loadScript(u) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = u; s.onload = res; s.onerror = function () { rej(new Error(u + ' 加载失败')); };
    document.head.appendChild(s);
  });
}

function hex2rgb(h) {
  var n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lum(r, g, b) { return r * 0.299 + g * 0.587 + b * 0.114; }
function samePixel(d, i, hex) {
  var c = hex2rgb(hex);
  return d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2];
}

(async function () {
  try {
    await loadScript('js/core.js');
    await loadScript('js/share-image.js');
  } catch (e) { log('FAIL 脚本加载：' + e.message); log('VERDICT pass=0 fail=1'); return; }

  var CF = window.CourseForge, SI = window.CourseForgeShare;
  check('core.js 与 share-image.js 都挂上了全局', !!(CF && SI));

  var SETTINGS = CF.normalizeSettings({ totalWeeks: 16, sectionsPerDay: 12, semesterStart: '2026-09-07' });
  function course(over) {
    return Object.assign({
      id: 'c' + Math.random().toString(36).slice(2, 8),
      name: '高等数学', teacher: '王老师', location: '教学楼A301',
      day: 1, startSection: 1, endSection: 2,
      weeks: CF.generateWeeks(1, 16, 'all', 16), color: 'blue'
    }, over || {});
  }
  var FIXTURE = [
    course({ id: 'a', name: '高等数学', day: 1, startSection: 1, endSection: 2, color: 'blue' }),
    course({ id: 'b', name: '大学英语', day: 2, startSection: 3, endSection: 4, color: 'green' }),
    course({ id: 'c', name: '数据结构与算法分析', day: 3, startSection: 5, endSection: 6, color: 'purple' }),
    course({ id: 'd', name: '大学体育', day: 4, startSection: 9, endSection: 10, color: 'orange' }),
    course({ id: 'e', name: '程序设计基础', day: 5, startSection: 3, endSection: 4, color: 'red',
      weeks: CF.generateWeeks(1, 8, 'all', 16) })
  ];

  // 真实字体度量（不是估算函数）—— 后面「文字不得溢出」那条检查全靠它
  var measure = SI.makeMeasure(document);
  check('makeMeasure 拿到的是可用的度量函数', typeof measure === 'function' && measure !== SI.estimateWidth,
    measure === SI.estimateWidth ? '回落到估算函数了' : '真实 canvas.measureText');
  var w1 = measure('高等数学', 19), w2 = measure('12345678', 19);
  check('measureText 返回有限正数', Number.isFinite(w1) && w1 > 0 && Number.isFinite(w2) && w2 > 0,
    '汉字 ' + w1.toFixed(1) + 'px / 数字 ' + w2.toFixed(1) + 'px');

  function build(over) {
    return SI.buildLayout(Object.assign({
      courses: FIXTURE, settings: SETTINGS, semesterName: '2026-2027 学年 第一学期',
      week: 3, scope: 'current', theme: 'light', today: 3, measure: measure
    }, over || {}));
  }

  // ---------- 1. 浅色主题：真的画出来了吗 ----------
  var L = build();
  var canvas = SI.drawToCanvas(L, document);
  check('canvas 尺寸与布局一致', canvas.width === L.width && canvas.height === L.height,
    canvas.width + 'x' + canvas.height);
  check('尺寸是 1080 宽（微信/朋友圈竖图基准）', canvas.width === 1080, String(canvas.width));

  var ctx = canvas.getContext('2d');
  var img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  check('左上角像素就是主题底色（整张底铺满了）', samePixel(img, 0, L.theme.bg),
    '期望 ' + L.theme.bg);

  // 墨量：统计「不是底色」的像素占比。空白图会接近 0，纯色块会接近 1，正常排布应在中间。
  var ink = 0, dark = 0, colors = {};
  for (var i = 0; i < img.length; i += 4) {
    var r = img[i], g = img[i + 1], b = img[i + 2];
    if (!(r === hex2rgb(L.theme.bg)[0] && g === hex2rgb(L.theme.bg)[1] && b === hex2rgb(L.theme.bg)[2])) ink++;
    if (lum(r, g, b) < 110) dark++;          // 深色文字
    colors[r + ',' + g + ',' + b] = 1;
  }
  var total = canvas.width * canvas.height;
  var inkRatio = ink / total;
  check('墨量在合理区间（2%~80%）', inkRatio > 0.02 && inkRatio < 0.8,
    (inkRatio * 100).toFixed(2) + '%');
  check('存在深色文字像素（fillText 真的渲染了）', dark > 500, dark + ' px');
  check('颜色种类足够多（底色/网格/面板/色条/文字都在）',
    Object.keys(colors).length >= 6, Object.keys(colors).length + ' 种');

  // ---------- 2. 某个课块的色条必须精确等于该课配色 ----------
  var bx = L.blocks.find(function (b) { return b.courseId === 'a'; });
  check('找得到「高等数学」的课块', !!bx);
  if (bx) {
    var barIdx = ((Math.round(bx.x + 2) + Math.round(bx.y + bx.h / 2) * canvas.width)) * 4;
    var palette = SI.resolvePalette();
    var main = palette.blue.main;
    check('课块左侧色条颜色 = 该课配色 main', samePixel(img, barIdx, main),
      'x=' + Math.round(bx.x + 2) + ' 期望 ' + main);

    // 课块内部要有文字墨迹：块底色是浅蓝，文字是近黑 —— 数一数深色像素
    var x0 = Math.round(bx.x + 20), x1 = Math.round(bx.x + bx.w - 4);
    var y0 = Math.round(bx.y + 2), y1 = Math.round(bx.y + bx.h - 2);
    var inkInBlock = 0;
    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var k = (y * canvas.width + x) * 4;
        if (lum(img[k], img[k + 1], img[k + 2]) < 110) inkInBlock++;
      }
    }
    check('课块内部有课名墨迹（不是空色块）', inkInBlock > 40, inkInBlock + ' px');

    // 文字不能贴到块的最右边 —— 贴到了说明它溢出了格子（fitText 没起作用）
    var lastInkX = -1;
    for (var yy = y0; yy < y1; yy++) {
      for (var xx = x1 - 1; xx >= x0; xx--) {
        var kk = (yy * canvas.width + xx) * 4;
        if (lum(img[kk], img[kk + 1], img[kk + 2]) < 110) { if (xx > lastInkX) lastInkX = xx; break; }
      }
    }
    check('课名没有顶到课块右边缘（留得有内边距）',
      lastInkX < 0 || lastInkX <= bx.x + bx.w - 3,
      '最右墨迹 x=' + lastInkX + ' / 右边界 ' + Math.round(bx.x + bx.w));
  }

  // ---------- 3. 今天那一列有高亮底 ----------
  var todayCol = L.meta.days.indexOf(3);
  if (todayCol >= 0) {
    var colW = (L.width - SI.MARGIN * 2 - SI.TIME_COL_W) / L.meta.days.length;
    // 选一个既不是表头、也没有课块遮住的位置：第 11 节那一行（夹具里没人用）
    var probeY = Math.round(SI.MARGIN + 96 + SI.HEAD_ROW_H + 10.5 * SI.ROW_H);
    var probeX = Math.round(SI.MARGIN + SI.TIME_COL_W + todayCol * colW + colW / 2);
    var pi = (probeY * canvas.width + probeX) * 4;
    check('周三（今天）那一列在空白节次上有高亮底',
      samePixel(img, pi, L.theme.today), '期望 ' + L.theme.today);
  }

  // ---------- 4. 深色主题：底色真的换了吗 ----------
  var LD = build({ theme: 'dark' });
  var cD = SI.drawToCanvas(LD, document);
  var imgD = cD.getContext('2d').getImageData(0, 0, 4, 4).data;
  check('深色主题左上角是深色底', samePixel(imgD, 0, LD.theme.bg),
    '期望 ' + LD.theme.bg);
  check('深色底确实比浅色底暗',
    lum(imgD[0], imgD[1], imgD[2]) < lum(img[0], img[1], img[2]) - 100,
    '深 ' + lum(imgD[0], imgD[1], imgD[2]).toFixed(0) + ' vs 浅 ' + lum(img[0], img[1], img[2]).toFixed(0));

  // 深色主题下的课块：底色必须是暗的、文字必须是亮的。
  // 这条是**数像素**才拦得住的：模块算出来的指令全都「对」，只是颜色配成了浅底白字 ——
  // 全图指令合法、尺寸正确、PNG 完整，课名却整片看不见（真机样图里出现过）。
  var imgDAll = cD.getContext('2d').getImageData(0, 0, cD.width, cD.height).data;
  var bd = LD.blocks.find(function (b) { return b.courseId === 'a'; });
  if (bd) {
    var dx0 = Math.round(bd.x + 2), dx1 = Math.round(bd.x + bd.w - 2);
    var dy0 = Math.round(bd.y + 2), dy1 = Math.round(bd.y + bd.h - 2);
    var dLight = 0, dDark = 0, dAll = 0;
    for (var dy = dy0; dy < dy1; dy++) {
      for (var dx = dx0; dx < dx1; dx++) {
        var dk = (dy * cD.width + dx) * 4;
        var dl = lum(imgDAll[dk], imgDAll[dk + 1], imgDAll[dk + 2]);
        dAll++;
        if (dl > 140) dLight++;
        if (dl < 110) dDark++;
      }
    }
    check('深色主题课块以暗色为底（白字压浅底会让课名整片消失）',
      dLight / dAll < 0.35, '亮色占比 ' + (dLight / dAll * 100).toFixed(1) + '%');
    check('深色主题课块里有亮色文字像素（课名真的画出来了）', dLight > 40, dLight + ' px 亮色');
    check('深色主题课块底色够暗', dDark / dAll > 0.5, (dDark / dAll * 100).toFixed(1) + '% 暗色');
    // 课名与底色的实际亮度差
    var bgLumSample = 0, samples = 0;
    for (var sy = dy0; sy < dy1; sy += 3) {
      var sk = (sy * cD.width + dx1 - 3) * 4;
      bgLumSample += lum(imgDAll[sk], imgDAll[sk + 1], imgDAll[sk + 2]);
      samples++;
    }
    check('深色主题课块底色亮度 < 110', bgLumSample / samples < 110,
      (bgLumSample / samples).toFixed(0));
  }

  // ---------- 5. 真实字体下，任何带宽度上限的文字都不能溢出 ----------
  // 这条是 Node 测试**测不到**的：那边用的是注入的估算函数，这里用的是真 measureText。
  // 一旦真实字体比估算宽，就会在这里暴露。
  function overflowReport(layout) {
    var bad = [];
    layout.ops.forEach(function (op) {
      if (op.type !== 'text' || !(op.maxWidth > 0)) return;
      var w = measure(op.text, op.size);
      if (w > op.maxWidth + 0.5) bad.push(op.text + ' ' + w.toFixed(1) + '>' + op.maxWidth);
    });
    return bad;
  }
  var badL = overflowReport(build());
  check('浅色·本周视图：无文字超出其宽度上限', badL.length === 0, badL.slice(0, 3).join(' | ') || '全部通过');
  var badA = overflowReport(build({ scope: 'all' }));
  check('浅色·整学期视图：无文字超出其宽度上限', badA.length === 0, badA.slice(0, 3).join(' | ') || '全部通过');
  // 超长课名 + 极端窄的作息（每天 4 节 → 泳道更窄）是最挤的情况
  var badN = overflowReport(build({
    settings: CF.normalizeSettings({ totalWeeks: 16, sectionsPerDay: 4, semesterStart: '2026-09-07' })
  }));
  check('窄作息（每天 4 节）：无文字超出其宽度上限', badN.length === 0, badN.slice(0, 3).join(' | ') || '全部通过');

  // ---------- 6. 端到端导出：exportPNG 真的吐出一张合法 PNG ----------
  await new Promise(function (resolve) {
    SI.exportPNG(L, { document: document, fileName: 'x.png' }, function (err, res) {
      check('exportPNG 无错返回', !err && !!res, err ? err.message : 'ok');
      if (!res) { resolve(); return; }
      check('文件名按 .png 结尾', /\\.png$/.test(res.fileName), res.fileName);
      res.blob.arrayBuffer().then(function (ab) {
        var u8 = new Uint8Array(ab);
        var magic = [u8[0], u8[1], u8[2], u8[3]].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
        check('PNG 魔数正确', magic === '89504e47', magic);
        var ihdr = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
        var pw = (u8[16] << 24 | u8[17] << 16 | u8[18] << 8 | u8[19]) >>> 0;
        var ph = (u8[20] << 24 | u8[21] << 16 | u8[22] << 8 | u8[23]) >>> 0;
        check('PNG 头是 IHDR 且宽高与布局一致', ihdr === 'IHDR' && pw === L.width && ph === L.height,
          ihdr + ' ' + pw + 'x' + ph);
        check('PNG 体积合理（> 10KB，不是一张空白图）', res.blob.size > 10240,
          (res.blob.size / 1024).toFixed(1) + ' KB');
        // 结尾必须是 IEND，否则是被截断的图
        var tail = String.fromCharCode(u8[u8.length - 8], u8[u8.length - 7], u8[u8.length - 6], u8[u8.length - 5]);
        check('PNG 以 IEND 结尾（文件完整）', tail === 'IEND', tail);
        resolve();
      }).catch(function (e) { check('读 blob 字节失败', false, e.message); resolve(); });
    });
  });

  // ---------- 7. 和屏幕配色对齐：overrides 传进来要真的改变图上颜色 ----------
  var L2 = build({ palette: SI.resolvePalette({ blue: { main: '#ff0000' } }) });
  var c2 = SI.drawToCanvas(L2, document);
  var img2 = c2.getContext('2d').getImageData(0, 0, c2.width, c2.height).data;
  var b2 = L2.blocks.find(function (b) { return b.courseId === 'a'; });
  var i2 = (Math.round(b2.x + 2) + Math.round(b2.y + b2.h / 2) * c2.width) * 4;
  check('配色 overrides 真的画到了图上（深色主题跟随的关键）', samePixel(img2, i2, '#ff0000'),
    '红=' + img2[i2] + ',' + img2[i2 + 1] + ',' + img2[i2 + 2]);

  // ---------- 8. 留两张样图给外层落盘（人眼复核用）----------
  // 用 toDataURL 而不是 toBlob：这里只需要 base64，外层拿到就能直接写文件。
  window.__png = {
    light: canvas.toDataURL('image/png').split(',')[1],
    dark: cD.toDataURL('image/png').split(',')[1],
    current: c2.width + 'x' + c2.height
  };

  log('VERDICT pass=' + P + ' fail=' + F);
})().catch(function (e) {
  log('FAIL 脚本异常：' + (e && e.message));
  log('VERDICT pass=' + P + ' fail=' + (F + 1));
});
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

/**
 * Git Bash 里习惯把路径写成 `/c/Users/...`，但 Node 在 Windows 上会把它当成
 * 「当前盘根目录下的 c\Users\...」→ 样图默默落到 `C:\c\...`（真踩过一次）。
 * 这里把这种写法转回盘符形式。
 */
function normalizeOutDir(p) {
  const m = /^\/([a-zA-Z])\//.exec(p);
  return m ? m[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\') : p;
}
let server = null;
let edge = null;
let cdp = null;
let profile = null;
let resultText = '';
let passed = false;

try {
  fs.writeFileSync(SELFTEST, makeSelftestHtml(), 'utf8');
  server = await startServer();
  const port = server.address().port;
  const cdpPort = 9500 + (process.pid % 400);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-share-'));

  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort, 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  const target = await waitForPageTarget(cdpPort);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/_share-selftest.html` });
  await sleep(800);

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: "document.getElementById('out') ? document.getElementById('out').textContent : '(无 #out)'",
      returnByValue: true
    });
    resultText = (r && r.result && r.result.value) || '';
    if (/VERDICT/.test(resultText)) break;
    await sleep(300);
  }

  console.log(resultText || '(空)');

  // 落盘样图（可选）。放在 VERDICT 判定之前：即使有检查失败，样图也是排查的第一手材料。
  const outDir = process.env.SHARE_OUT ? normalizeOutDir(process.env.SHARE_OUT) : null;
  if (outDir) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'window.__png ? JSON.stringify(window.__png) : ""',
        returnByValue: true
      });
      const dump = JSON.parse((r && r.result && r.result.value) || '{}');
      if (dump.light && dump.dark) {
        fs.mkdirSync(outDir, { recursive: true });
        const w = (name, b64) => {
          const p = path.join(outDir, name);
          fs.writeFileSync(p, Buffer.from(b64, 'base64'));
          console.log(`样图已写出：${p}（${(fs.statSync(p).size / 1024).toFixed(1)} KB）`);
        };
        w('课表分享图-浅色.png', dump.light);
        w('课表分享图-深色.png', dump.dark);
      } else {
        console.error('⚠️ 页面没有回传样图（window.__png 为空）');
      }
    } catch (e) {
      console.error('⚠️ 写样图失败：' + (e && e.message));
    }
  }

  const m = /VERDICT pass=(\d+) fail=(\d+)/.exec(resultText);
  const p = m ? Number(m[1]) : 0;
  const f = m ? Number(m[2]) : -1;
  passed = !!m && f === 0 && p > 0;
  console.log('\n--- 浏览器：Edge headless + CDP 直连（真实像素 / 真实字体度量）---');
  console.log('结论：' + (passed
    ? `✅ 分享图真机出图正常（${p} 项检查全过）`
    : (m ? `❌ ${f} 项检查失败（通过 ${p} 项）` : '❌ 超时，页面未跑完')));
} catch (e) {
  console.error('自检失败：' + (e && e.message));
} finally {
  try { if (cdp) { await cdp.send('Browser.close'); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (edge && edge.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-edge.pid, 'SIGKILL');
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
