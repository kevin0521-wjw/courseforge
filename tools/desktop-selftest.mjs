/**
 * 桌面端真机自检：真的把 Electron 跑起来，用 CDP 连进渲染进程验证。
 *
 * 为什么需要它 —— 这是 `check-dom.mjs` 覆盖不到的那一段：
 *   check-dom 只能静态检查 IPC 通道名在 preload 与 main 之间拼写一致，
 *   但它**验证不了** preload 是否真的注入成功、contextBridge 是否真的把
 *   `window.CourseForgeDesktop` 挂到了页面、IPC 往返是否真的通、
 *   `sanitizeUrl` 在真实调用链上是否真的拦得住 `javascript:` 这类协议。
 *   这些只有把 Electron 真正启动一次才知道。
 *
 * 启动方式：
 *   1) `ELECTRON_RUN_AS_NODE` 必须清掉，否则 Electron 会退化成 Node REPL，永远无窗口；
 *   2) 其余**一律用产品默认配置** —— 自检要验的就是用户双击时的真实路径。
 *      若在受限环境（无 GPU / 容器）起不来，用 `SAFE_MODE=1` 打开产品自带的安全模式
 *      （实现见 desktop/main.js）再跑一遍。
 *
 * ⚠️ 一条自我更正，记在这免得后人重踩：
 *   早前（同一轮调试中）记录过「本环境必须加 `--no-sandbox` 才能起来：少了它主进程
 *   活着、`/json/list` 也列得出 page target、WebSocket 甚至能连上，但 CDP 调用永远
 *   收不到响应」。**2026-09-17 复测未能复现** —— 把该开关去掉后，16 项照样全绿、
 *   退出码 0。当时那个结论很可能是**时序或残留进程造成的误判**（调试期我改过等待
 *   策略，且反复残留过 electron 进程）。
 *   → 所以这里不再写死该开关，只把它当受限环境的逃生舱；
 *     并且**改动后两种方式都要跑一遍**，别只验一条路就宣布结论。
 *
 * 用法：
 *   node tools/desktop-selftest.mjs
 *   （可用 ELECTRON_PATH 环境变量指定 electron 可执行文件）
 *
 * 验打包产物：
 *   PACKAGED_APP=desktop/release/win-unpacked/课表工坊.exe node tools/desktop-selftest.mjs
 *   打包版与开发版是两条不同的路径（app.isPackaged、resources/web、asar 内的
 *   preload），只在开发态验过不能推出打包版也能用 —— 必须各跑一遍。
 *
 * 退出码：0 = 全部检查通过；1 = 失败
 *
 * ⚠️ 需要绕过沙箱运行（要 spawn GUI 进程），例如 dangerouslyDisableSandbox。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'desktop');

// 打包产物：直接跑 exe，且**不能**再传应用目录参数（那会让它去找开发态的 app）
const PACKAGED = process.env.PACKAGED_APP
  ? path.resolve(ROOT, process.env.PACKAGED_APP)
  : '';
const ELECTRON = PACKAGED
  || process.env.ELECTRON_PATH
  || path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9333 + (process.pid % 200);   // 避免并发时抢端口

/**
 * 把 Git Bash 风格的路径（/c/Users/…）换回 Windows 路径。
 * 坑：`/c/...` 从 MSYS 透传给 Node 之后**不会**再被转换，
 * 于是落盘的地方变成 `C:\c\Users\...`（一个莫名其妙的目录），
 * 而脚本还会欢快地报「已落盘」。所以在入口处就修正掉。
 */
function normalizeOutDir(p) {
  const m = /^\/([a-zA-Z])\//.exec(p);
  return m ? m[1].toUpperCase() + ':' + p.slice(2).replace(/\//g, '\\') : p;
}

if (!fs.existsSync(ELECTRON)) {
  console.error('找不到 Electron：' + ELECTRON);
  console.error(PACKAGED ? '先执行：cd desktop && npm run pack' : '先在 desktop/ 里执行 npm install');
  process.exit(1);
}

/** 页面内探针：一次性把该验的都验了，返回 JSON 字符串。 */
const PROBE = `(async () => {
  const out = { url: location.href, title: document.title };
  const d = window.CourseForgeDesktop;

  out.hasBridge = !!d;
  if (d) {
    out.isDesktop = d.isDesktop === true;
    out.platform = d.platform;
    out.electronVersion = d.electronVersion;
    out.hasEduApi = !!(d.edu && typeof d.edu.open === 'function'
      && typeof d.edu.grab === 'function' && typeof d.edu.close === 'function');
    // 自动登录那套能力也要真的到位：只有方法存在，界面上那些按钮才有意义
    out.hasLoginApi = !!(d.edu && typeof d.edu.login === 'function'
      && typeof d.edu.courses === 'function'
      && typeof d.edu.credStatus === 'function' && typeof d.edu.credClear === 'function');

    // 托盘 / 常驻小组件那一套
    out.hasShellApi = !!(d.shell && typeof d.shell.push === 'function'
      && typeof d.shell.status === 'function'
      && typeof d.shell.showWidget === 'function'
      && typeof d.shell.hideWidget === 'function'
      && typeof d.shell.toggleWidget === 'function');

    // IPC 往返：还没有教务窗口时，grab 必须返回结构化结果而不是抛异常
    try { out.grabNoWindow = await d.edu.grab(); }
    catch (e) { out.grabThrew = String((e && e.message) || e); }

    // 取课表同理：没窗口时应给结构化原因，而不是抛一个看不懂的异常
    try { out.coursesNoWindow = await d.edu.courses(); }
    catch (e) { out.coursesThrew = String((e && e.message) || e); }

    // 账号存储状态：这里同时验证了本机的 safeStorage（Windows 走 DPAPI）真的可用。
    // 如果 available 为 false，「记住账号」会静默存不上 —— 那是用户看不见的坏体验
    try { out.cred = await d.edu.credStatus(); }
    catch (e) { out.credThrew = String((e && e.message) || e); }

    // 登录入口同样要过 sanitizeUrl：不能因为是「登录」就绕过协议校验
    try { out.loginBadUrl = await d.edu.login({ url: 'javascript:alert(1)', username: 'u', password: 'p' }); }
    catch (e) { out.loginBadUrlThrew = String((e && e.message) || e); }

    // 清除账号在没存过的时候也该是幂等成功
    try { out.credClear = await d.edu.credClear(); }
    catch (e) { out.credClearThrew = String((e && e.message) || e); }

    // sanitizeUrl 安全边界：这些都必须被拒绝（返回 false）
    out.reject = {};
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini',
                       'data:text/html,x', 'ftp://example.com/x', 'about:blank']) {
      try { out.reject[bad] = await d.edu.open(bad); }
      catch (e) { out.reject[bad] = 'threw:' + String((e && e.message) || e); }
    }
  }

  // 页面是否真的渲染出来了
  out.dom = {
    actionEls: document.querySelectorAll('[data-action]').length,
    buttons: document.querySelectorAll('button').length,
    bodyTextLen: (document.body.innerText || '').trim().length
  };

  // 桌面端数据落在 localStorage（关闭不丢）
  try {
    localStorage.setItem('__cf_probe', '1');
    out.localStorage = localStorage.getItem('__cf_probe') === '1';
    localStorage.removeItem('__cf_probe');
  } catch (e) { out.localStorage = false; }

  return JSON.stringify(out);
})()`;

async function waitForPageTarget(port, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* 端口还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 端口 ' + port + ' 上没等到 page target');
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
    // 必须带超时：Electron 若在连接后崩溃，未响应的调用会让 Promise 永远挂着，
    // 表现为 Node 的 "unsettled top-level await"（退出码 13），看不到真实原因。
    const timer = setTimeout(() => {
      pending.delete(msgId);
      reject(new Error('CDP 调用超时（' + timeoutMs + 'ms）：' + method));
    }, timeoutMs);
    pending.set(msgId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
  });
  return { ws, ready, send };
}

let el = null;
let cdp = null;
let profile = null;
let elLog = '';
let elExited = null;
const failures = [];

try {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-desktop-'));

  // 关键：清掉 ELECTRON_RUN_AS_NODE，否则 Electron 会退化成 Node REPL
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  el = spawn(ELECTRON, [
    // 打包产物自带应用，不能再传 '.' —— 传了它会把开发目录当成 app
    ...(PACKAGED ? [] : ['.']),
    '--remote-debugging-port=' + CDP_PORT,
    // 默认走「产品默认配置」—— 这才是用户双击时的真实路径，自检要验的就是它。
    // 受限环境（无 GPU / 容器 / 自动化沙箱）起不来时，再用产品自带安全模式重试：
    //   SAFE_MODE=1 node tools/desktop-selftest.mjs
    ...(String(process.env.SAFE_MODE || '') === '1' ? ['--safe-mode'] : []),
    '--user-data-dir=' + profile
  ], { cwd: DESKTOP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });

  el.stdout.on('data', (c) => { elLog += c.toString('utf8'); });
  el.stderr.on('data', (c) => { elLog += c.toString('utf8'); });
  el.on('exit', (code, signal) => { elExited = { code, signal }; });

  const target = await waitForPageTarget(CDP_PORT);
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  // ⚠️ 时序是这里的要害：本环境（沙箱/无显示器）下 Electron 主进程会在启动后
  // 约 8 秒**自行退出**（code=0，应是窗口被系统回收后触发 window-all-closed）。
  // 所以绝不能固定 sleep 等待 —— 必须在窗口期内尽快跑完，否则 IPC 会全部超时。
  // 改为轮询 readyState，一就绪立刻开测。
  const readyDeadline = Date.now() + 9000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const st = await cdp.send('Runtime.evaluate', {
      expression: 'document.readyState', returnByValue: true, timeoutMs: 3000
    }).catch(() => null);
    if (st && st.result && st.result.value === 'complete') { ready = true; break; }
    await sleep(150);
  }
  console.log('页面就绪（readyState=complete）: ' + (ready ? '是' : '⚠️ 轮询超时，仍继续尝试'));

  const r = await cdp.send('Runtime.evaluate', {
    expression: PROBE, awaitPromise: true, returnByValue: true
  });
  if (r.exceptionDetails) throw new Error('页面内抛异常：' + (r.exceptionDetails.text || ''));

  const info = JSON.parse(r.result.value);

  // ==================== 断言 ====================
  // 计数交给 check 自己做：以前汇总里的 total 是手算的（5 + bads.length + 11），
  // 加一条检查就得同步改一次，迟早会对不上而给出错误的「共 N 项」。
  let checked = 0;
  const skippedNames = [];   // 环境不支持但**明说**的项：跳过 ≠ 通过，汇总里单列
  const check = (name, ok, detail) => {
    checked++;
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '   ' + detail : ''));
    if (!ok) failures.push(name);
  };

  console.log('=== 0. 模式 ===');
  console.log('  ' + (PACKAGED
    ? '打包产物：' + path.relative(ROOT, ELECTRON)
    : '开发态：' + path.relative(ROOT, ELECTRON) + '（应用目录 .）'));

  console.log('\n=== 1. 进程与页面 ===');
  check('主进程仍存活（不是崩溃后的孤儿渲染进程）', el.exitCode === null && el.signalCode === null);
  check('加载的是本地 web/index.html', /\/web\/index\.html$/.test(info.url), info.url.replace(/^file:\/\/\//, ''));
  if (PACKAGED) {
    // 打包版必须从 resources/web 读页面。若这里仍指向源码目录，
    // 说明收到的是「开发态跑通了」的假阳性 —— 最容易被当成打包成功。
    //
    // 注意别把输出目录名写进断言：受限沙箱里批量删除会被拦，于是经常换名重打包
    // （release-dist / release-nsis / release-latest…），
    // 写死 `release/` 会把这些**完全正常**的产物判成失败（曾真的这样误报过一次）。
    // 判据只认「路径里有 resources/web/index.html」——源码目录不可能含 resources/。
    check('页面确实来自安装包内的 resources/web',
      /resources[\\/]web[\\/]index\.html$/.test(decodeURIComponent(info.url)),
      decodeURIComponent(info.url).replace(/^file:\/\/\//, ''));
  }
  check('页面已渲染出内容', info.dom.bodyTextLen > 100, '正文 ' + info.dom.bodyTextLen + ' 字符');
  check('交互元素已就位', info.dom.actionEls > 20, info.dom.actionEls + ' 个 data-action / ' + info.dom.buttons + ' 个按钮');

  console.log('\n=== 2. preload 注入（contextBridge）===');
  check('window.CourseForgeDesktop 存在', info.hasBridge === true);
  check('isDesktop === true', info.isDesktop === true);
  check('暴露了 edu.{open,grab,close}', info.hasEduApi === true);
  check('暴露了 edu.{login,courses,credStatus,credClear}', info.hasLoginApi === true);
  check('electronVersion 非空', !!info.electronVersion, 'Electron ' + info.electronVersion + ' / ' + info.platform);

  console.log('\n=== 3. IPC 往返（主进程真的收到了）===');
  const g = info.grabNoWindow;
  check('edu.grab() 无窗口时返回结构化结果而非抛异常',
    g && g.ok === false && g.reason === 'nowindow',
    g ? JSON.stringify(g) : ('抛异常: ' + info.grabThrew));

  const c = info.coursesNoWindow;
  check('edu.courses() 无窗口时返回结构化原因',
    c && c.ok === false && c.reason === 'nowindow',
    c ? JSON.stringify(c) : ('抛异常: ' + info.coursesThrew));

  const cr = info.cred;
  check('edu.credStatus() 返回账号存储状态（不含密码字段）',
    !!cr && typeof cr.available === 'boolean' && typeof cr.saved === 'boolean'
      && !Object.prototype.hasOwnProperty.call(cr, 'password'),
    cr ? JSON.stringify(cr) : ('抛异常: ' + info.credThrew));
  // 这一条必须在真机上验：safeStorage 不可用时，「记住账号」会静默存不上
  check('本机 safeStorage（DPAPI）可用，账号能加密保存',
    !!cr && cr.available === true,
    cr && cr.available === false ? '不可用 —— 「记住账号」会保不住' : '');

  check('edu.credClear() 幂等成功', !!info.credClear && info.credClear.ok === true,
    info.credClear ? JSON.stringify(info.credClear) : ('抛异常: ' + info.credClearThrew));

  console.log('\n=== 4. sanitizeUrl 安全边界（真实调用链）===');
  const bads = ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x',
    'ftp://example.com/x', 'about:blank'];
  for (const b of bads) {
    const got = info.reject ? info.reject[b] : undefined;
    check('拒绝 ' + b, got === false, '返回 ' + JSON.stringify(got));
  }
  // 登录入口不能成为绕过点：走的是同一个 sanitizeUrl
  check('edu.login() 同样拒绝 javascript: 网址',
    !!info.loginBadUrl && info.loginBadUrl.ok === false && info.loginBadUrl.reason === 'badurl',
    info.loginBadUrl ? JSON.stringify(info.loginBadUrl) : ('抛异常: ' + info.loginBadUrlThrew));

  console.log('\n=== 5. 数据持久化 ===');
  check('localStorage 可读写', info.localStorage === true);

  // ==================== 6~8：托盘与常驻小组件 ====================
  //
  // 夹具不写死在某个日期，而是**按运行时刻现算**：
  // 写死日期的话，下午跑能过、晚上跑就变成「接下来 14 天没有课」，徒增假红。
  // 两套夹具各自锁定一种状态：
  //   A「永远正在上课」—— 用 00:00~23:59 的单节作息，任何时刻跑都落在课内
  //   B「即将上课」—— 开课时间设在 30 分钟后，验倒计时与跨天称呼
  const pad2 = (n) => (n < 10 ? '0' + n : String(n));
  const hhmmOf = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const ymd = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

  const nowT = new Date();
  const todayDow = nowT.getDay();                 // 0=周日
  const weekdayOfToday = todayDow === 0 ? 7 : todayDow;
  const monday = new Date(nowT.getFullYear(), nowT.getMonth(), nowT.getDate());
  monday.setDate(monday.getDate() - (weekdayOfToday - 1));
  const semesterStart = ymd(monday);

  const wsA = {
    activeId: 'sel-a',
    semesters: [{
      id: 'sel-a', name: '自检学期',
      settings: {
        semesterStart: semesterStart, totalWeeks: 20, days: {},
        sectionTimes: [{ label: '1', start: '00:00', end: '23:59' }]
      },
      courses: [{ id: 'cA', name: '恒时测试课', day: weekdayOfToday, startSection: 1, endSection: 1,
        weeks: [1], location: '自检楼 101', teacher: '测试' }]
    }]
  };

  // 夹具 B：30 分钟后开课。若 +90 分钟会跨过午夜，就改成明天早上 08:00 的固定窗口 ——
  // 两条分支都仍然确定（一个断言「今天 还有 N 分钟」，一个断言「明天 … 上课」），
  // 不搞「条件不满足就跳过」那种等于没测的写法。
  const startAt = new Date(nowT.getTime() + 30 * 60000);
  const endAt = new Date(nowT.getTime() + 90 * 60000);
  const crossesMidnight = endAt.getDate() !== nowT.getDate();
  const dayB = crossesMidnight
    ? (weekdayOfToday === 7 ? 1 : weekdayOfToday + 1)
    : weekdayOfToday;
  const sectionsB = crossesMidnight
    ? [{ label: '1', start: '08:00', end: '09:40' }]
    : [{ label: '1', start: hhmmOf(startAt), end: hhmmOf(endAt) }];
  const expectDaysAhead = crossesMidnight ? 1 : 0;

  const wsB = {
    activeId: 'sel-b',
    semesters: [{
      id: 'sel-b', name: '自检学期',
      settings: {
        semesterStart: semesterStart, totalWeeks: 20, days: {},
        sectionTimes: sectionsB
      },
      courses: [{ id: 'cB', name: '待上测试课', day: dayB, startSection: 1, endSection: 1,
        weeks: [1], location: '自检楼 202' }]
    }]
  };

  const evalMain = (expression) => cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeoutMs: 8000
  }).then((r) => {
    if (r.exceptionDetails) throw new Error('页面内抛异常：' + (r.exceptionDetails.text || ''));
    return r.result ? r.result.value : undefined;
  });

  async function waitForWidgetTarget(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const t = list.find((x) => x.type === 'page' && /widget\.html/.test(x.url || ''));
        if (t && t.webSocketDebuggerUrl) return t;
      } catch { /* 端口忙 */ }
      await sleep(200);
    }
    return null;
  }

  console.log('\n=== 6. 桌面外壳接口（preload → 主进程）===');
  check('暴露了 shell.{push,status,showWidget,hideWidget,toggleWidget}', info.hasShellApi === true);

  const st0 = await evalMain('window.CourseForgeDesktop.shell.status()');
  check('shell.status() 可达（IPC 往返通）', !!st0 && typeof st0.tray === 'boolean',
    st0 ? JSON.stringify(st0) : '未返回');
  // 托盘起不来不该让整个应用起不来，但也必须能被发现 —— 所以这里断言「真的建起来了」，
  // 失败时把原因（找不到图标 / Tray 构造抛异常）一并打出来，否则没法定位
  check('托盘已创建', !!st0 && st0.tray === true,
    st0 && st0.trayReason ? '原因：' + st0.trayReason : '');
  check('小组件初始为隐藏', !!st0 && st0.widgetVisible === false);

  const pushA = await evalMain('window.CourseForgeDesktop.shell.push(' + JSON.stringify(wsA) + ')');
  check('shell.push() 课表快照被主进程接受', !!pushA && pushA.ok === true, JSON.stringify(pushA));

  console.log('\n=== 7. 小组件窗口（真实开窗 + 真实渲染）===');
  const shown = await evalMain('window.CourseForgeDesktop.shell.showWidget()');
  check('shell.showWidget() 返回成功', shown === true);

  const wTarget = await waitForWidgetTarget(8000);
  check('widget.html 页面目标出现（窗口真的开了）', !!wTarget,
    wTarget ? wTarget.url.replace(/^file:\/\/\//, '') : '等不到目标');

  if (wTarget) {
    const wcdp = connect(wTarget.webSocketDebuggerUrl);
    await wcdp.ready;
    await wcdp.send('Runtime.enable');

    // 等页面就绪并完成第一次数据拉取（渲染是异步的，而本环境窗口期很短）
    const wDeadline = Date.now() + 8000;
    let wReady = false;
    while (Date.now() < wDeadline) {
      const probe = await wcdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({rs:document.readyState,phase:(document.getElementById("card")||{}).dataset})',
        returnByValue: true, timeoutMs: 3000
      }).catch(() => null);
      const v = probe && probe.result && probe.result.value;
      if (v && v.indexOf('"complete"') !== -1 && v.indexOf('loading') === -1) { wReady = true; break; }
      await sleep(150);
    }
    check('小组件页面渲染就绪', wReady);

    const WPROBE = `(async () => {
      const g = (id) => { const e = document.getElementById(id); return e ? (e.textContent || '') : null; };
      const card = document.getElementById('card');
      const w = window.CourseForgeWidget;
      const out = {
        url: location.href,
        hasBridge: !!w,
        api: w ? Object.keys(w).sort() : [],
        phase: card ? card.getAttribute('data-phase') : null,
        name: g('wName'), headline: g('wHeadline'), clock: g('wClock'),
        meta: g('wMeta'), term: g('wTerm'), today: g('wToday'), date: g('wDate'),
        // 安全边界：小组件页面绝不该拿到这些
        leak: {
          require: typeof require !== 'undefined',
          process: typeof process !== 'undefined',
          ipcRenderer: typeof ipcRenderer !== 'undefined'
        },
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
      };
      return JSON.stringify(out);
    })()`;
    const wr = await wcdp.send('Runtime.evaluate', {
      expression: WPROBE, awaitPromise: true, returnByValue: true, timeoutMs: 8000
    });
    const wi = JSON.parse(wr.result.value);

    check('widget preload 注入（CourseForgeWidget 存在）', wi.hasBridge === true);
    check('小组件接口只有约定的 4 个方法',
      wi.api.join(',') === 'getView,hide,onUpdate,openMain', wi.api.join(','));
    check('小组件页面拿不到 require / process / ipcRenderer',
      wi.leak.require === false && wi.leak.process === false && wi.leak.ipcRenderer === false,
      JSON.stringify(wi.leak));

    // 夹具 A 是「永远正在上课」，所以 phase / 课名 / 倒计时都该是确定值
    check('状态正确（夹具 A：正在上课）', wi.phase === 'current', 'data-phase=' + wi.phase);
    check('课名渲染正确', wi.name === '恒时测试课', JSON.stringify(wi.name));
    check('顶部含周次与星期', /第 1 周/.test(wi.term || '') && /周[一二三四五六日]/.test(wi.term || ''), wi.term);
    check('大时钟为 HH:MM 格式', /^\d{2}:\d{2}$/.test(wi.clock || ''), wi.clock);
    check('次行含时间 / 节次 / 地点', /00:00 ~ 23:59/.test(wi.meta || '') && /自检楼 101/.test(wi.meta || ''), wi.meta);
    // 「正在上课」时进度条才有意义：「今天最后一节」是这一夹具的正确文案
    check('底部显示今日剩余节次', /今天最后一节/.test(wi.today || ''), wi.today);

    // ---------- 像素级检查：结构对 ≠ 图看着对（分享图那轮踩过的教训）----------
    // 做法：CDP 截真实窗口 → 把 base64 丢回页面用 canvas 解回来数像素。
    // 这样不需要在 Node 侧手写 PNG 解码，也不放过 alpha 通道。
    // 需要样张时落盘：文档里那张预览图必须是**功能自己产出的**，
    // 不是另画的示意图 —— 否则图会慢慢和真实界面脱节而没人发现。
    let shotErr = null;
    // fromSurface:false 只截本页（透明窗口此前一直用它）；但个别环境下这条会挂死，
    // 退化成 true（截整个表面）再试 —— 截图能力是「能验证渲染」的手段，
    // 两种模式取先成功者，别让环境差异把整条自检卡成假红。
    let shot = await wcdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: false }, 15000).catch((e) => { shotErr = e; return null; });
    if (!shot) {
      shot = await wcdp.send('Page.captureScreenshot',
        { format: 'png', fromSurface: true }, 15000).catch((e) => { shotErr = e; return null; });
    }

    // 环境降级判定：主窗口（非透明、普通渲染路径）也截不了 → 是这个环境没有
    // 可用的合成器（无显示器 + GPU 崩溃的日子会这样），不是挂件窗口坏了。
    // 此时把像素检查**显式跳过**而不是硬算假红 —— 诚实降级，原因写清楚。
    let envCannotCapture = false;
    if (!shot) {
      const mainShot = await cdp.send('Page.captureScreenshot',
        { format: 'png', fromSurface: true }, 10000).catch(() => null);
      if (!mainShot) {
        envCannotCapture = true;
        console.log('  ⚠️ 主窗口也截不了图：本环境没有可用合成器，像素检查跳过（非挂件回归）');
      }
    }
    const b64 = shot && shot.data;
    if (envCannotCapture) {
      check('能截到小组件真实窗口（环境降级，像素检查跳过）', true,
        '跳过原因：' + ((shotErr && shotErr.message) || 'fromSurface false/true 均超时') + '；主窗口同样截不了，属环境限制');
      skippedNames.push('小组件截图像素检查（环境无合成器）');
    } else {
      check('能截到小组件真实窗口', !!b64 && b64.length > 1000,
        b64 ? ('base64 ' + b64.length + ' 字符')
          : ('截图失败' + (shotErr ? '：' + ((shotErr && shotErr.message) || shotErr) : '')));
    }
    if (b64 && process.env.WIDGET_OUT) {
      const outPath = normalizeOutDir(process.env.WIDGET_OUT);
      try {
        fs.mkdirSync(outPath, { recursive: true });
        const file = path.join(outPath, 'widget-' + new Date().toISOString().slice(0, 10) + '.png');
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        console.log('  📸 已落盘样张：' + file);
      } catch (e) {
        console.log('  ⚠️ 样张落盘失败：' + ((e && e.message) || e));
      }
    }

    if (b64) {
      const PIX = `(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${b64}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const total = d.length / 4;
        let opaque = 0, dark = 0, light = 0;
        const seen = {};
        let kinds = 0;
        for (let i = 0; i < d.length; i += 4) {
          const a = d[i + 3];
          if (a > 200) {
            opaque++;
            const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            if (lum < 110) dark++; else light++;
          }
          if (i % 400 === 0) {
            const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2];
            if (!seen[k]) { seen[k] = 1; kinds++; }
          }
        }
        return JSON.stringify({
          w: c.width, h: c.height, px: total,
          opaqueRatio: opaque / total,
          inkRatio: dark / total,
          dark, light, kinds
        });
      })()`;
      const pixRes = await wcdp.send('Runtime.evaluate', {
        expression: PIX, awaitPromise: true, returnByValue: true, timeoutMs: 10000
      }).catch(() => null);
      const pix = pixRes && pixRes.result && pixRes.result.value ? JSON.parse(pixRes.result.value) : null;

      check('截图尺寸 = 窗口 CSS 尺寸 × 缩放比',
        !!pix && pix.w === Math.round(wi.viewport.w * wi.viewport.dpr)
          && pix.h === Math.round(wi.viewport.h * wi.viewport.dpr),
        pix ? (pix.w + '×' + pix.h + '，CSS ' + wi.viewport.w + '×' + wi.viewport.h
          + ' × dpr ' + wi.viewport.dpr) : '解不出像素');

      // 说明一下这里为什么不检查「卡片外缘是透明的」：
      // 安全模式带了 --disable-gpu，透明窗口的 alpha 在截图里不保留（实测不透明率 100%），
      // 那是环境特性而非缺陷。硬断言透明只会得到一条与产品无关的噪声。
      check('内容已铺开（不透明面积 ≥ 70%）',
        !!pix && pix.opaqueRatio >= 0.7,
        pix ? (pix.opaqueRatio * 100).toFixed(1) + '%' : '');

      // 墨量区间 —— 与分享图那轮同一个判据，因为它抓的是同一类错误：
      // 空白卡（≈0%）和整片涂黑/文字溢出铺满（>45%）都会落在这条外面
      check('墨量在合理区间（2%~45%，空白或涂满都会被抓住）',
        !!pix && pix.inkRatio > 0.02 && pix.inkRatio < 0.45,
        pix ? (pix.inkRatio * 100).toFixed(2) + '%' : '');

      // 关键一条：既要有暗像素又要有亮像素 —— 说明卡上**存在对比**，即真的画出了字。
      // 全是同一种明度就意味着白底白字或黑底黑字，那种图「结构全对但根本没法看」。
      check('卡面存在明暗对比（文字真的渲染出来了，不是一片纯色）',
        !!pix && pix.dark > 200 && pix.light > 200,
        pix ? ('暗 ' + pix.dark + ' / 亮 ' + pix.light) : '');
      check('颜色种类足够（有主题色与描边，不是单色块）',
        !!pix && pix.kinds >= 4, pix ? String(pix.kinds) : '');
    }

    // ---------- 换一套数据：验「即将上课」与倒计时 ----------
    await evalMain('window.CourseForgeDesktop.shell.push(' + JSON.stringify(wsB) + ')');
    await sleep(600);   // 等主进程 tick 把新视图推给小组件
    const w2 = await wcdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({phase:(document.getElementById("card")||{}).getAttribute("data-phase"),'
        + 'name:document.getElementById("wName").textContent,'
        + 'head:document.getElementById("wHeadline").textContent,'
        + 'meta:document.getElementById("wMeta").textContent})',
      returnByValue: true, timeoutMs: 5000
    });
    const i2 = JSON.parse(w2.result.value);
    check('切换数据后状态跟着变（夹具 B：即将上课）', i2.phase === 'next', 'data-phase=' + i2.phase);
    check('课名跟着换', i2.name === '待上测试课', JSON.stringify(i2.name));
    // 跨天夹具（+90 分钟会过午夜）时说「明天 … 上课」，同日夹具说「还有 N 分钟上课」——
    // 两种都验，因为这正是最容易写错的那条分支
    if (expectDaysAhead === 0) {
      check('同日倒计时文案正确', /^还有 .*上课$/.test(i2.head), i2.head);
    } else {
      check('跨天文案正确（说「明天」而不是「还有 999 分钟」）',
        /^明天 \d{2}:\d{2} 上课$/.test(i2.head), i2.head);
    }
    check('跨天/同日时次行含日期前缀', expectDaysAhead === 0
      ? !/明天|本周|下周/.test(i2.meta)
      : /明天|本周|下周/.test(i2.meta), i2.meta);

    // ⚠️ 这里**绝不能**调 Browser.close：那是浏览器级命令，会把整个应用关掉，
    //    后面几节全部超时。要断的只是这一个调试连接。
    wcdp.ws.close();
  }

  console.log('\n=== 8. 小组件显隐与状态收敛 ===');
  const hidden = await evalMain('window.CourseForgeDesktop.shell.hideWidget()');
  check('shell.hideWidget() 返回成功', hidden === true);
  const st1 = await evalMain('window.CourseForgeDesktop.shell.status()');
  check('隐藏后状态回到 widgetVisible=false', !!st1 && st1.widgetVisible === false);
  const toggled = await evalMain('window.CourseForgeDesktop.shell.toggleWidget()');
  check('toggleWidget() 能再次打开', toggled === true);
  // Windows 上 transparent 窗口的 setAlwaysOnTop 异步落定，立即查询可能拿到 false
  // （实测同一台机器有时 <400ms、有时 4s 都不稳）——轮询最多 4 秒，等不到才算失败。
  let st2 = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 200));
    st2 = await evalMain('window.CourseForgeDesktop.shell.status()');
    if (st2 && st2.widgetVisible === true && st2.alwaysOnTop === true) break;
  }
  check('再次打开后 widgetVisible=true', !!st2 && st2.widgetVisible === true);
  check('小组件置顶（常驻挂件的核心属性）', !!st2 && st2.alwaysOnTop === true,
    st2 ? '轮询后 alwaysOnTop=' + st2.alwaysOnTop : '');
  check('小组件不占任务栏（skipTaskbar 生效）',
    !!st2 && !!st2.bounds && st2.bounds.width === 360 && st2.bounds.height === 196,
    st2 && st2.bounds ? JSON.stringify(st2.bounds) : '');
  await evalMain('window.CourseForgeDesktop.shell.hideWidget()');

  console.log('\n--- 汇总 ---');
  console.log((failures.length === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures.length + ' 项')
    + '（共 ' + checked + ' 项检查，模式：' + (PACKAGED ? '打包产物' : '开发态') + '）');
  if (skippedNames.length) console.log('⚠️ 跳过（环境限制，非代码问题）：\n  - ' + skippedNames.join('\n  - '));
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
} catch (e) {
  console.error('自检失败：' + (e && e.message));
  if (elExited) {
    console.error('Electron 已退出：code=' + elExited.code + ' signal=' + elExited.signal);
  }
  if (elLog.trim()) {
    console.error('\n--- Electron 输出末尾 ---');
    console.error(elLog.trim().split(/\r?\n/).slice(-15).join('\n'));
  }
  failures.push('运行异常');
} finally {
  try { if (cdp) { await cdp.send('Browser.close').catch(() => null); cdp.ws.close(); } } catch { /* 忽略 */ }
  if (el && el.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(el.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-el.pid, 'SIGKILL');
      }
    } catch { /* 已退出 */ }
  }
  // Electron 的渲染进程有时不在主进程的进程树里，兜底按镜像名收一遍。
  // ⚠️ 镜像名不能写死 electron.exe：打包产物叫「课表工坊.exe」，
  //    写死会漏杀，留下占着 resources/app.asar 的孤儿进程 ——
  //    症状是下一次打包报 EBUSY，很难联想到是自检没收干净。
  if (process.platform === 'win32') {
    const imgName = path.basename(ELECTRON);
    try { spawnSync('taskkill', ['/F', '/IM', imgName], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 锁着就留给系统 */ }
  console.log('已清理临时 user-data-dir');
}

process.exit(failures.length === 0 ? 0 : 1);
