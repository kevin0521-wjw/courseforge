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
 * 沙箱/受限环境下三个必需项（都是实测踩出来的，缺一不可）：
 *   1) `ELECTRON_RUN_AS_NODE` 必须清掉，否则 Electron 以 Node REPL 模式跑，永远无窗口；
 *   2) `--in-process-gpu --disable-gpu` —— 否则 GPU 进程反复启动失败，最终
 *      `FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
 *      主进程 1.5 秒内就退出（此时会留下**孤儿渲染进程**，CDP 居然还能连上，
 *      极易误判成"跑起来了"——所以本脚本会额外校验主进程是否仍存活）；
 *   3) `--no-sandbox` —— **最关键也最隐蔽的一个**。少了它会得到一个极难诊断的状态：
 *      主进程活着、`/json/list` 也能列出 page target、WebSocket 甚至能连上，
 *      但**发出的 CDP 调用永远收不到任何响应**（渲染进程实际已死）。
 *      加上它之后同一个页面的 title 立刻从空串变成「课表工坊 CourseForge」。
 *
 *      注：`--no-sandbox` 关掉的是 Chromium 自带沙箱。本工具只加载本地 file:// 页面、
 *      不访问外部内容，因此在这里可以接受；**不要**把它搬到产品运行配置里。
 *
 * 用法：
 *   node tools/desktop-selftest.mjs
 *   （可用 ELECTRON_PATH 环境变量指定 electron 可执行文件）
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
const ELECTRON = process.env.ELECTRON_PATH
  || path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9333 + (process.pid % 200);

if (!fs.existsSync(ELECTRON)) {
  console.error('找不到 Electron：' + ELECTRON);
  console.error('先在 desktop/ 里执行 npm install');
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

    // IPC 往返：还没有教务窗口时，grab 必须返回结构化结果而不是抛异常
    try { out.grabNoWindow = await d.edu.grab(); }
    catch (e) { out.grabThrew = String((e && e.message) || e); }

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
    '.',
    '--remote-debugging-port=' + CDP_PORT,
    '--no-sandbox',       // ⭐ 最关键：不禁用 Chromium 自带沙箱，渲染进程在本环境起不来
    '--in-process-gpu',   // GPU 放进主进程：避免独立 GPU 进程崩溃拖死整个应用
    '--disable-gpu',
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
  const check = (name, ok, detail) => {
    console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '   ' + detail : ''));
    if (!ok) failures.push(name);
  };

  console.log('=== 1. 进程与页面 ===');
  check('主进程仍存活（不是崩溃后的孤儿渲染进程）', el.exitCode === null && el.signalCode === null);
  check('加载的是本地 web/index.html', /\/web\/index\.html$/.test(info.url), info.url.replace(/^file:\/\/\//, ''));
  check('页面已渲染出内容', info.dom.bodyTextLen > 100, '正文 ' + info.dom.bodyTextLen + ' 字符');
  check('交互元素已就位', info.dom.actionEls > 20, info.dom.actionEls + ' 个 data-action / ' + info.dom.buttons + ' 个按钮');

  console.log('\n=== 2. preload 注入（contextBridge）===');
  check('window.CourseForgeDesktop 存在', info.hasBridge === true);
  check('isDesktop === true', info.isDesktop === true);
  check('暴露了 edu.{open,grab,close} 三个动作', info.hasEduApi === true);
  check('electronVersion 非空', !!info.electronVersion, 'Electron ' + info.electronVersion + ' / ' + info.platform);

  console.log('\n=== 3. IPC 往返（主进程真的收到了）===');
  const g = info.grabNoWindow;
  check('edu.grab() 无窗口时返回结构化结果而非抛异常',
    g && g.ok === false && g.reason === 'nowindow',
    g ? JSON.stringify(g) : ('抛异常: ' + info.grabThrew));

  console.log('\n=== 4. sanitizeUrl 安全边界（真实调用链）===');
  const bads = ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x',
    'ftp://example.com/x', 'about:blank'];
  for (const b of bads) {
    const got = info.reject ? info.reject[b] : undefined;
    check('拒绝 ' + b, got === false, '返回 ' + JSON.stringify(got));
  }

  console.log('\n=== 5. 数据持久化 ===');
  check('localStorage 可读写', info.localStorage === true);

  console.log('\n--- 汇总 ---');
  const total = 5 + bads.length + 6;
  console.log((failures.length === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures.length + ' 项')
    + '（共 ' + total + ' 项检查）');
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
  // Electron 的渲染进程有时不在主进程的进程树里，兜底按镜像名收一遍
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
  }
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 锁着就留给系统 */ }
  console.log('已清理临时 user-data-dir');
}

process.exit(failures.length === 0 ? 0 : 1);
