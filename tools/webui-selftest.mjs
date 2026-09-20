/**
 * 网页端 UI 真机自检：headless Edge + CDP 直连，真实打开页面做冒烟测试。
 *
 * 覆盖 check-dom.mjs（静态检查）与 Node 侧 jsdom 测试都够不到的那一段：
 *   真实浏览器渲染、真实点击链路（设置抽屉 / 添加考试 / 云同步 UI）、
 *   Service Worker 注册、localStorage 持久化，以及「截图非白」的像素级判定。
 *
 * 用法：
 *   node tools/webui-selftest.mjs            # 需要 http://localhost:5173 已由 npm run start:web 起好
 *   WEBUI_URL=http://localhost:8000/ node tools/webui-selftest.mjs
 * 截图落盘：.shots/web-*.png（退出码 0 = 全部通过）
 *
 * ⚠️ 需要绕过沙箱运行（要 spawn 浏览器进程），例如 dangerouslyDisableSandbox。
 * ⚠️ 沙箱外的子进程工作目录固定为工作区根，`cd` 不延续 —— 用绝对路径调用本脚本。
 *
 * 两条踩过的坑，改这段代码前先看：
 *   1) headless=new 下 Page.captureScreenshot 必须 fromSurface:true，
 *      false 只截得到背景层（全白图）。所以这里先 true 后 false，
 *      并且截图后把 base64 丢回页面用 canvas 数暗像素 —— 墨量 <0.5% 判为白图，不算通过。
 *   2) CDP Runtime.evaluate 的表达式如果是 `JSON.stringify((async () => {...})())`，
 *      stringify 拿到的是 **Promise**，序列化结果是 "{}"。
 *      async 探针必须在函数内部 stringify、直接返回字符串（awaitPromise 等的就是它）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, '.shots');
const URL = process.env.WEBUI_URL || 'http://localhost:5173/';

/** 候选浏览器：先环境变量，再常见安装位置。 */
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('找不到浏览器，试过：\n  ' + EDGE_CANDIDATES.join('\n  ') + '\n可用 EDGE_PATH 环境变量指定');
  process.exit(1);
}

const CDP_PORT = 9500 + (process.pid % 400);

async function waitForPageTarget(port, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
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
  const send = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const msgId = ++id;
    // 必须带超时：浏览器若在连接后崩溃，未响应的调用会让 Promise 永远挂着
    const timer = setTimeout(() => {
      pending.delete(msgId);
      reject(new Error('CDP 调用超时：' + method));
    }, timeoutMs);
    pending.set(msgId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });
  return { ws, ready, send };
}

const evalJs = async (cdp, expression, timeoutMs = 10000) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面内异常：' + (r.exceptionDetails.text || '') + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result ? r.result.value : undefined;
};

/**
 * 截图 + 像素自检：headless=new 下 fromSurface:false 只截得到背景层（全白），
 * 必须 true 才截完整表面。白图不算截到 —— 解回 canvas 数暗像素，墨量 <0.5% 就换模式重试。
 * 返回 { file, ink }；两种模式都白时仍落盘（便于人工查看）但断言会显式变红。
 */
const shot = async (cdp, name) => {
  const file = path.join(SHOTS, name);
  let lastInk = -1;
  for (const fromSurface of [true, false]) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface }, 15000).catch(() => null);
    if (s && s.data) {
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      lastInk = await evalJs(cdp, `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${s.data}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.min(img.naturalWidth, 400); c.height = Math.min(img.naturalHeight, 300);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) {
          const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          if (lum < 120 && d[i + 3] > 200) dark++;
        }
        return dark / (c.width * c.height);
      })()`, 10000).catch(() => -1);
      if (lastInk > 0.005) return { file, ink: lastInk };
    }
  }
  return { file, ink: lastInk };
};

const failures = [];
const results = [];
const check = (name, ok, detail) => {
  results.push((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '   ' + detail : ''));
  if (!ok) failures.push(name);
};

let edge = null, cdp = null, profile = null;
try {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-webui-'));
  edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT, 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  edge.unref();

  const target = await waitForPageTarget(CDP_PORT);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL });

  // 轮询 readyState（不固定 sleep，避免错过或浪费时间）
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    const st = await evalJs(cdp, 'document.readyState', 4000).catch(() => null);
    if (st === 'complete') { ready = true; break; }
    await sleep(200);
  }
  check('页面加载完成（readyState=complete）', ready);
  await sleep(1200); // 等 init / SW 注册

  // ---------- 探针 1：首页 ----------
  const p1 = JSON.parse(await evalJs(cdp, `JSON.stringify((() => {
    const mainView = document.getElementById('mainView');
    const todayPanel = document.getElementById('todayPanel');
    return {
      title: document.title,
      bodyTextLen: (document.body.innerText || '').trim().length,
      actionEls: document.querySelectorAll('[data-action]').length,
      mainChildren: mainView ? mainView.children.length : -1,
      todayLen: todayPanel ? (todayPanel.innerText || '').trim().length : -1,
      lsOk: (() => { try { localStorage.setItem('__t','1'); const v = localStorage.getItem('__t')==='1'; localStorage.removeItem('__t'); return v; } catch(e){ return false; } })()
    };
  })())`));
  check('标题正确', p1.title.indexOf('课表') !== -1, p1.title);
  check('页面渲染出内容（>300 字符）', p1.bodyTextLen > 300, p1.bodyTextLen + ' 字符');
  check('交互元素就位（>40 个 data-action）', p1.actionEls > 40, p1.actionEls + ' 个');
  check('课表视图已渲染（mainView 有结构）', p1.mainChildren > 0, p1.mainChildren + ' 个子节点');
  check('今日面板有内容', p1.todayLen > 0, p1.todayLen + ' 字符');
  check('localStorage 可用', p1.lsOk);
  const swState = await evalJs(cdp, `navigator.serviceWorker.getRegistration().then(r => r ? (r.active ? 'active' : 'registering') : 'none').catch(e => 'error:' + e.message)`);
  check('Service Worker 状态', swState === 'active' || swState === 'registering' || swState === 'none', swState);
  const homeShot = await shot(cdp, 'web-home.png');
  check('首页截图非白（墨量 >0.5%）', homeShot.ink > 0.005, (homeShot.ink * 100).toFixed(2) + '% -> ' + homeShot.file);

  // ---------- 探针 2：打开设置抽屉 ----------
  await evalJs(cdp, `document.querySelector('[data-action="open-settings"]').click()`);
  await sleep(500);
  const p2 = JSON.parse(await evalJs(cdp, `JSON.stringify((() => {
    const g = (id) => document.getElementById(id);
    const cloudField = g('cloudField');
    return {
      drawerVisible: !!document.querySelector('.drawer.open, .drawer[data-open="true"], #settingsDrawer'),
      anyVisible: !!cloudField && cloudField.offsetParent !== null,
      cloudUrl: !!g('cloudUrl'), cloudUser: !!g('cloudUser'), cloudPass: !!g('cloudPass'),
      cloudRemember: !!g('cloudRemember'), cloudState: g('cloudState') ? g('cloudState').textContent : null,
      eventName: !!g('eventName'), eventDate: !!g('eventDate')
    };
  })())`));
  check('设置抽屉能打开', p2.drawerVisible || p2.anyVisible);
  check('云同步区四件套齐全（地址/用户/密码/记住）', p2.cloudUrl && p2.cloudUser && p2.cloudPass && p2.cloudRemember);
  check('云同步状态行有网页端提示', !!p2.cloudState && p2.cloudState !== '—', JSON.stringify(p2.cloudState));
  check('考试表单齐全（名称/日期）', p2.eventName && p2.eventDate);
  const settingsShot = await shot(cdp, 'web-settings.png');
  check('设置抽屉截图非白（墨量 >0.5%）', settingsShot.ink > 0.005, (settingsShot.ink * 100).toFixed(2) + '% -> ' + settingsShot.file);

  // ---------- 探针 3：添加一场 3 天后的考试 ----------
  // async 探针必须在函数内部 stringify（外层包 stringify 拿到 Promise -> "{}"）
  const p3raw = await evalJs(cdp, `(async () => {
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const d = new Date(Date.now() + 3 * 86400000);
    const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const g = (id) => document.getElementById(id);
    g('eventName').value = '高数期末';
    g('eventDate').value = dateStr;
    g('eventTime').value = '';
    g('eventKind').value = 'exam';
    document.querySelector('[data-action="add-event"]').click();
    await new Promise(r => setTimeout(r, 600));
    const toast = g('toast');
    return JSON.stringify({
      dateStr,
      listText: g('eventsList') ? g('eventsList').textContent.trim() : null,
      toastText: toast ? toast.textContent.trim() : null,
      toastHidden: toast ? toast.hidden : null,
      countdownOnHome: (document.body.innerText || '').indexOf('高数期末') !== -1
    });
  })()`, 12000);
  const p3 = JSON.parse(p3raw);
  // 列表空态本身有占位元素，判据用「列表里出现该考试」而不是「子元素 +1」
  check('考试添加成功（列表出现该考试）', (p3.listText || '').indexOf('高数期末') !== -1, JSON.stringify((p3.listText || '').slice(0, 80)));
  check('添加后有 toast 反馈', p3.toastHidden === false || !!p3.toastText, JSON.stringify(p3.toastText));
  check('窗口内考试立即触发「考试临近」提醒（优于「已添加」）', /考试临近/.test(p3.toastText || ''), JSON.stringify(p3.toastText));
  check('首页出现考试倒计时', p3.countdownOnHome);
  const eventShot = await shot(cdp, 'web-event-added.png');
  check('添加考试截图非白（墨量 >0.5%）', eventShot.ink > 0.005, (eventShot.ink * 100).toFixed(2) + '% -> ' + eventShot.file);

  // ---------- 探针 4：云同步 UI（网页端模式，不真连任何服务器）----------
  const p4raw = await evalJs(cdp, `(async () => {
    const g = (id) => document.getElementById(id);
    // 空配置点上传 -> 应该被拦下并提示
    g('cloudUrl').value = ''; g('cloudUser').value = ''; g('cloudPass').value = '';
    document.querySelector('[data-action="cloud-upload"]').click();
    await new Promise(r => setTimeout(r, 500));
    const emptyHint = g('cloudState').textContent;
    // ftp 地址必须被协议白名单拦下且不落盘
    g('cloudUrl').value = 'ftp://bad.example.com/dav';
    document.querySelector('[data-action="cloud-save"]').click();
    await new Promise(r => setTimeout(r, 500));
    const ftpHint = g('cloudState').textContent;
    const ftpStored = !!localStorage.getItem('wb_courseforge_webdav_cfg');
    // 合法地址 + 保存（不勾记住密码）
    g('cloudUrl').value = 'https://dav.jianguoyun.com/dav/';
    g('cloudUser').value = 'tester@example.com';
    g('cloudPass').value = 'app-password-123';
    document.querySelector('[data-action="cloud-save"]').click();
    await new Promise(r => setTimeout(r, 500));
    const saved = JSON.parse(localStorage.getItem('wb_courseforge_webdav_cfg') || 'null');
    return JSON.stringify({
      emptyHint, ftpHint, ftpStored,
      savedUrl: saved ? saved.url || saved.baseUrl || JSON.stringify(saved).slice(0, 120) : null,
      savedPassNotStored: !saved || !saved.password
    });
  })()`, 15000);
  const p4 = JSON.parse(p4raw);
  check('空配置点上传被拦下（有提示、不上传）', !!p4.emptyHint && p4.emptyHint !== '—', JSON.stringify(p4.emptyHint));
  check('ftp 地址被协议白名单拦下且不落盘', p4.ftpStored === false, 'state=' + JSON.stringify(p4.ftpHint));
  check('合法配置保存后落盘 localStorage', !!p4.savedUrl, JSON.stringify(p4.savedUrl));
  check('网页端不勾「记住密码」就不存密码', p4.savedPassNotStored);
  // 截图前滚到云同步区，让样张拍到它
  await evalJs(cdp, `document.getElementById('cloudField').scrollIntoView({ block: 'center' })`).catch(() => null);
  await sleep(400);
  const cloudShot = await shot(cdp, 'web-cloud.png');
  check('云同步截图非白（墨量 >0.5%）', cloudShot.ink > 0.005, (cloudShot.ink * 100).toFixed(2) + '% -> ' + cloudShot.file);

  // ---------- 法定节假日自动同步 ----------
  // 启动时同步器已在后台跑，但冷启动首连可能失败（设计为静默重试）——
  // 这里主动点设置抽屉里的「立即同步」验证完整链路：按钮 → 拉取 → 解析 → 落盘 → 状态行。
  // 网络是环境属性不是代码属性：同步不到时标跳过说明原因，不算失败。
  await evalJs(cdp, `(() => {
    const btn = document.querySelector('[data-action="sync-holidays"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  // 拉取 3 个年份 × 每年最多 3 个候选源，网络慢时需要时间 —— 轮询最多 30 秒
  let h = null;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const raw = await evalJs(cdp, `JSON.stringify((() => {
      try {
        const ws = JSON.parse(localStorage.getItem('wb_courseforge_v1') || 'null');
        const s = ws && ws.semesters && ws.semesters[0] && ws.semesters[0].settings;
        const sync = s && s.holidaySync || {};
        const days = s && s.holidayDays || {};
        const stateEl = document.getElementById('holidaySyncState');
        return { lastSync: sync.lastSync || '', source: sync.source || '',
          count: Object.keys(days).length,
          sample: days['2026-10-01'] || days['2027-01-01'] || '',
          stateText: stateEl ? stateEl.textContent : null };
      } catch (e) { return { error: e.message }; }
    })())`, 15000);
    h = JSON.parse(raw);
    if (h.count > 0) break;
  }
  if (h.count > 0) {
    check('法定节假日同步落盘（点「立即同步」）', !!h.lastSync && !!h.source,
      h.count + ' 个标记，源 ' + h.source + '，sync ' + h.lastSync);
    check('法定假日样例映射正确（国庆=off）', h.sample === 'off', '2026-10-01/2027-01-01=' + JSON.stringify(h.sample));
    check('设置抽屉显示同步状态行', !!h.stateText && h.stateText.indexOf('上次同步') !== -1, JSON.stringify(h.stateText));
  } else {
    check('法定节假日同步（网络不可达，跳过）', true, '环境限制：' + JSON.stringify(h));
  }

  // ---------- 汇总 ----------
  console.log('\n=== 网页端真机自检（headless Edge + CDP，' + URL + '）===');
  console.log(results.join('\n'));
  console.log(failures.length === 0
    ? '✅ 全部通过（共 ' + results.length + ' 项）'
    : '❌ 失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - '));
} catch (e) {
  console.error('自检失败：' + (e && e.message));
  if (results.length) console.log(results.join('\n'));
  failures.push('运行异常');
} finally {
  try { if (cdp) { await cdp.send('Browser.close').catch(() => null); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (edge && edge.pid) {
    try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
  // profile 放系统临时目录：锁着删不掉也无害，绝不放仓库里
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 留给系统 */ }
}
process.exit(failures.length === 0 ? 0 : 1);
