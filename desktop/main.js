/**
 * CourseForge 桌面端主进程
 * 复用 web/ 目录下的页面：窗口走 file:// 加载，随包 cmaps/ 走 cfcmap:// 特权协议
 * （file:// 页面 fetch 不了本地资源，CMap 必须由这个协议供给，见下方说明）
 *
 * 相比网页版，桌面端多一项能力：教务系统直连。
 * 浏览器里 JS 受同源策略限制拿不到教务系统页面，主进程没有这个限制，
 * 因此由主进程开一个窗口让用户自己登录，再按需把当前页 HTML 交回渲染进程解析。
 */
const { app, BrowserWindow, Menu, shell, ipcMain, safeStorage, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('node:url');
const EduLogin = require('./edu-login.js');
const { createCredStore } = require('./cred-store.js');
const { createWebdavClient } = require('./webdav-client.js');
const { createUpdateChecker, RELEASES_PAGE } = require('./update-checker.js');
const { createWidgetStore } = require('./widget-store.js');
const { createShell } = require('./desktop-shell.js');

// ==================== 安全模式（受限环境启动）====================
/**
 * 受限环境（无 GPU / 容器 / 自动化沙箱）下 Chromium 会以几种方式失败，
 * 每一种都在真实环境实测过，症状一个比一个难诊断：
 *
 *   1) GPU 进程反复启动失败 → 主进程 1.5 秒内直接退出：
 *      `FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
 *      更坑的是它会留下**孤儿渲染进程** —— CDP 端口照样能连上，很容易误判成"起来了"。
 *   2) 宿主沙箱（如 Windows job object）与 Chromium 自带沙箱冲突 →
 *      主进程活着、`/json/list` 能列出 page target、WebSocket 甚至能连上，
 *      但发出的调试调用**永远收不到任何响应**（渲染进程实际已死）。
 *      这是最难查的一种：所有表面信号都正常。
 *
 * ⚠️ 实测备注（2026-09-17 复测）：本机**默认配置已能正常启动并跑完全部自检**，
 *    上面第 2 条的症状后来没能复现（疑为调试期的时序/残留进程误判）。
 *    所以安全模式不是"必须开"，而是**受限环境起不来时的逃生舱** ——
 *    默认关闭，代价为零。
 *
 * ⚠️ 安全模式会关掉 Chromium 自带沙箱，**只在「本机加载本地 file:// 页面」这个前提
 * 下可接受**。所以它默认不启用，必须显式开启：
 *
 *   electron . --safe-mode            # 命令行
 *   set COURSEFORGE_SAFE_MODE=1       # 或环境变量（Windows）
 *
 * 普通桌面环境请不要用，保持默认的沙箱保护。
 */
const SAFE_MODE = process.argv.includes('--safe-mode')
  || /^(1|true|yes)$/i.test(String(process.env.COURSEFORGE_SAFE_MODE || '').trim());

if (SAFE_MODE) {
  // 这些开关必须写在 app ready **之前**，之后再调就晚了
  app.disableHardwareAcceleration();           // 官方 API：明确放弃硬件加速
  app.commandLine.appendSwitch('in-process-gpu'); // GPU 放进主进程，避免独立 GPU 进程崩溃拖死整个应用
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  console.log('[CourseForge] 安全模式已启用：已禁用 GPU 与 Chromium 沙箱（仅限受限环境）');
}

let mainWindow = null;
let eduWindow = null;

/**
 * 网页目录的位置。
 * 开发态：desktop/ 的上一级里的 web/。
 * 打包后：web/ 被 electron-builder 的 extraResources 放到 <安装目录>/resources/web，
 *        靠 __dirname 猜路径在不同打包参数下会飘，所以这里按 app.isPackaged 显式区分。
 */
const WEB_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'web');

// ==================== 随包 CMap 协议（cfcmap://）====================
/**
 * 为什么需要它：主窗口仍是 file:// 加载（改动最小、也保住了既有的安全边界），
 * 但 Chromium 【禁止 file:// 页面 fetch 任何资源】——于是随包的 cmaps/
 * （pdf.js 解中文 PDF 必需的 168 个 .bcmap）在桌面端永远取不到，
 * 之前全靠 CDN 兜底：真机弱网/离线时中文 PDF 会「一个字都解不出」。
 *
 * 解法：注册一个支持 fetch API 的特权协议，只服务 WEB_DIR/cmaps/ 这个目录，
 * 页面把它作为 CMap 首选源。取不到时 importer.js 的实试逻辑自然落到 CDN，
 * 行为与网页版完全一致。
 *
 * 安全边界：handler 只映射 cmaps/ 目录，且 resolve 后必须仍在该目录内
 * （../ 路径穿越直接 403）；除这个协议外不注册任何其它资源路径。
 * ⚠️ registerSchemesAsPrivileged 必须在 app ready 之前调用，晚了无效。
 */
const CMAP_SCHEME = 'cfcmap';
const CMAP_BASE = path.join(WEB_DIR, 'cmaps');

protocol.registerSchemesAsPrivileged([
  {
    scheme: CMAP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

/** 注册 cfcmap:// 处理器（在 app ready 之后、创建窗口之前调用一次） */
function registerCmapProtocol() {
  protocol.handle(CMAP_SCHEME, (request) => {
    // 约定 URL 形如 cfcmap://cmaps/<文件名>：host 固定 cmaps，path 是文件名
    const u = new URL(request.url);
    if (u.hostname !== 'cmaps') {
      return new Response('forbidden', { status: 403 });
    }
    let name;
    try {
      name = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const target = path.resolve(CMAP_BASE, name);
    if (!target.startsWith(CMAP_BASE + path.sep)) {
      return new Response('forbidden', { status: 403 }); // 路径穿越
    }
    return net.fetch(pathToFileURL(target).toString())
      ['catch'](() => new Response('not found', { status: 404 }));
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 已存在就前置，别开出第二个主窗口 —— 两份界面各自持有一份 state，
    // 编辑课表时会出现「改了这边那边还是旧的」
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: '课表工坊 CourseForge',
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(WEB_DIR, 'index.html'));

  // 外部链接用系统浏览器打开，不在应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ==================== 托盘与常驻小组件 ====================

let widgetStore = null;
let deskShell = null;

/**
 * 托盘图标的候选路径，按优先级排。
 * 优先用 .ico：它内含 16/24/32 多档尺寸，Windows 在不同 DPI 缩放下会挑最合适的一档，
 * 直接拿 192×192 的 PNG 缩到 16px 会糊。PNG 只作兜底。
 */
function trayIconCandidates() {
  return [
    // 打包后：electron-builder 把 build/icon.ico 复制到 resources/tray.ico
    app.isPackaged ? path.join(process.resourcesPath, 'tray.ico') : '',
    // 开发态：直接用构建目录里的 .ico
    path.join(__dirname, 'build', 'icon.ico'),
    // 最后兜底：PWA 那套图标里最小的那张
    path.join(WEB_DIR, 'icon-192.png')
  ].filter(Boolean);
}

function initDesktopShell() {
  widgetStore = createWidgetStore({
    webJsDir: path.join(WEB_DIR, 'js'),
    log: (m) => console.log('[CourseForge] ' + m)
  });

  deskShell = createShell({
    webDir: WEB_DIR,
    store: widgetStore,
    iconCandidates: trayIconCandidates(),
    prefsFile: path.join(app.getPath('userData'), 'desktop-prefs.json'),
    openMain: () => createWindow(),
    log: (m) => console.log('[CourseForge] ' + m)
  });

  deskShell.start();
}

// ==================== 教务系统直连 ====================

/** 只允许 http/https，避免 file:// 之类的意外协议被当成网页加载 */
function sanitizeUrl(raw) {
  // 只接受字符串：IPC 传进来的就是字符串，类型不对一律当非法输入，
  // 避免 Number/String 之类的意外类型被静默转成看似正常的地址（如 123 → https://0.0.0.123/）
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // 已经写了协议但不是 http/https → 直接拒绝，不能靠「补 https://」蒙混过去。
  // 否则 file:///C:/… 会被解释成「主机名叫 file 的 https 地址」，看似安全实则荒谬。
  // 这里要区分「协议」与「主机:端口」：
  //   file:///x、ftp://x      → 带 :// 的一定是协议，拒绝
  //   javascript:/data:/about: → 不带 ://，靠协议黑名单识别，拒绝
  //   localhost:5173、jwb.shu.edu.cn:8080 → 是主机加端口，应补 https 而不是拒绝
  const hasScheme = /^https?:\/\//i.test(s);
  if (!hasScheme) {
    if (/^[a-zA-Z][\w+.-]*:\/\//.test(s)) return null;
    if (/^(?:javascript|data|vbscript|about|blob|file|ftp|ws|wss|chrome|resource):/i.test(s)) return null;
  }

  const url = hasScheme ? s : 'https://' + s;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

/**
 * 在页面上下文里抓 HTML。
 * 教务系统的课表常常放在 iframe 里，只取顶层 document 会拿到空壳，
 * 所以同源 iframe 的 HTML 一并取出并拼接（跨域 iframe 会抛异常，跳过即可）。
 */
const GRAB_SCRIPT = `(function () {
  var parts = [document.documentElement.outerHTML];
  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length; i++) {
    try {
      var doc = frames[i].contentDocument;
      if (doc && doc.documentElement) parts.push(doc.documentElement.outerHTML);
    } catch (e) { /* 跨域 iframe 取不到，忽略 */ }
  }
  return parts.join('\\n<!--CourseForgeFrame-->\\n');
})()`;

function openEduWindow(url) {
  const target = sanitizeUrl(url);
  if (!target) return false;
  // 窗口创建统一走 ensureEduWindow：手动登录与自动登录必须共用同一个窗口和同一份
  // cookie 分区，否则会出现「一个窗口登录了、另一个窗口还是登录页」的分裂状态
  ensureEduWindow(target);
  return true;
}

function registerEduIpc() {
  ipcMain.handle('edu:open', (event, url) => openEduWindow(url));

  ipcMain.handle('edu:grab', async () => {
    if (!eduWindow || eduWindow.isDestroyed()) {
      return { ok: false, reason: 'nowindow' };
    }
    try {
      const html = await eduWindow.webContents.executeJavaScript(GRAB_SCRIPT, true);
      return {
        ok: true,
        url: eduWindow.webContents.getURL(),
        title: eduWindow.webContents.getTitle(),
        html: typeof html === 'string' ? html : ''
      };
    } catch (err) {
      return { ok: false, reason: 'error', message: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('edu:close', () => {
    if (eduWindow && !eduWindow.isDestroyed()) eduWindow.close();
    return true;
  });
}

// ==================== 教务账号存储（本机加密）====================

let credStore = null;

/**
 * 凭据存储按需创建：safeStorage 在部分平台要等 app ready 才可用，
 * 放在模块顶层初始化迟早会踩到「还没 ready 就调用」的坑。
 */
function getCredStore() {
  if (!credStore) {
    credStore = createCredStore({
      file: path.join(app.getPath('userData'), 'edu-credentials.json'),
      safeStorage: safeStorage,
      log: (m) => console.log('[CourseForge] ' + m)
    });
  }
  return credStore;
}

// ==================== 教务系统自动登录 ====================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 加载页面并等它稳定；超时或失败返回 false，绝不抛出去炸掉 IPC */
async function loadUrlWithTimeout(wc, url, timeoutMs) {
  let timer = null;
  const beat = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const load = wc.loadURL(url).then(() => true)['catch'](() => false);
  const ok = await Promise.race([load, beat]);
  if (timer) clearTimeout(timer);
  return ok;
}

/**
 * 轮询一段脚本直到 decide 返回真值。
 * 之所以到处都要轮询：页面的 JS 是异步的（登录是 ajax、课表是 ajax 渲染），
 * 用固定 sleep 猜时间只有两种结果 —— 要么白等，要么在慢网下失败。
 * decide 返回 null/false 表示继续等。
 */
async function pollScript(wc, script, decide, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const intervalMs = (opts && opts.intervalMs) || 400;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await wc.executeJavaScript(script, true);
    } catch (e) {
      // 页面正在跳转时执行上下文会被销毁，这里属于正常现象，等下一轮
      last = null;
    }
    const decision = decide(last);
    if (decision) return { value: last, decision: decision };
    await sleep(intervalMs);
  }
  return { value: last, decision: null };
}

/**
 * 确保教务窗口存在。
 * 保留原 openEduWindow 的行为（已有窗口就导航并前置），这样「打开教务系统并登录」
 * 与自动登录共用同一个窗口和同一份 cookie 分区，不会出现「两个窗口各自登录」的混乱。
 */
function ensureEduWindow(target) {
  if (eduWindow && !eduWindow.isDestroyed()) {
    if (target) eduWindow.loadURL(target);
    eduWindow.focus();
    return eduWindow;
  }

  eduWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 420,
    minHeight: 480,
    title: '登录教务系统（CourseForge）',
    autoHideMenuBar: true,
    // 独立的持久化分区：登录状态可以保留，但与本应用主窗口的 cookie 隔离
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:courseforge-edu',
      spellcheck: false
    }
  });

  if (target) eduWindow.loadURL(target);
  eduWindow.on('closed', () => {
    eduWindow = null;
  });
  return eduWindow;
}

/**
 * 自动登录。
 *
 * 流程刻意简单：打开登录页 → 等表单就绪 → 填 #yhm/#mm → 点 #dl → 盯状态。
 * 加密密码、csrftoken 全部交给学校页面自己的 login.js（原因见 edu-login.js 顶部注释）。
 * 这里唯一需要小心的是**别把密码写进日志、别把它返回给渲染进程**。
 */
async function autoLogin(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const target = sanitizeUrl(p.url);
  if (!target) return { ok: false, reason: 'badurl', message: '教务系统网址不正确' };

  const loginUrl = EduLogin.loginUrlFrom(target);
  if (!loginUrl) return { ok: false, reason: 'badurl', message: '教务系统网址不正确' };

  let username = typeof p.username === 'string' ? p.username.trim() : '';
  let password = typeof p.password === 'string' ? p.password : '';
  const remember = !!p.remember;
  const store = getCredStore();

  if (!username || !password) {
    const stored = store.read();
    if (stored) {
      if (!username) username = stored.username;
      // 只在用户名与已存账号一致时复用密码：否则用户换了账号，
      // 会拿旧账号的密码去撞新账号 —— 白送一次失败计数
      if (!password && username === stored.username) password = stored.password;
    }
  }
  if (!username) return { ok: false, reason: 'nocred', message: '请填写教务系统用户名' };
  if (!password) {
    return { ok: false, reason: 'nocred', message: '请填写密码；想免输入就先勾「记住账号」登录成功一次' };
  }

  const win = ensureEduWindow(loginUrl);
  const wc = win.webContents;
  await loadUrlWithTimeout(wc, loginUrl, 25000);

  /** 登录成功后的收尾：记住账号（可选）+ 回报结果 */
  const finishOk = (extra) => {
    let remembered = false;
    let rememberError = '';
    if (remember) {
      const r = store.save({ username: username, password: password });
      remembered = !!r.ok;
      rememberError = r.ok ? '' : r.reason;
    }
    return Object.assign({ ok: true, url: wc.getURL(), remembered: remembered, rememberError: rememberError }, extra || {});
  };

  // 会话还在的话登录页会直接跳走 —— 这种情况没必要再填表
  if (!EduLogin.isLoginPage(wc.getURL())) {
    return finishOk({ alreadyLoggedIn: true });
  }

  // 等页面自己的 login.js 把事件绑上（DOM 出来 ≠ 事件绑好）
  const form = await pollScript(wc, '!!document.getElementById("dl")', (v) => v === true,
    { timeoutMs: 12000, intervalMs: 200 });
  if (!form.decision) {
    return { ok: false, reason: 'noform', message: '等了 12 秒没等到登录表单，请确认网址是不是教务系统登录页' };
  }

  let filled = null;
  try {
    filled = await wc.executeJavaScript(EduLogin.buildFillScript(username, password), true);
  } catch (err) {
    return { ok: false, reason: 'error', message: '填表失败：' + String((err && err.message) || err) };
  }
  if (!filled || !filled.ok) {
    if (filled && filled.reason === 'captcha') {
      return { ok: false, reason: 'captcha', message: '教务系统这次要验证码，请在弹窗里手动输完再点登录' };
    }
    return { ok: false, reason: 'noform', message: '页面上没找到用户名/密码输入框（登录页可能改版了）' };
  }

  // 登录是 ajax，靠页面自己的信号判定结果，不靠 sleep 猜
  const polled = await pollScript(wc, EduLogin.buildStatusScript(), (st) => {
    const c = EduLogin.classifyStatus(st);
    return c.state === 'pending' ? null : c;
  }, { timeoutMs: 45000, intervalMs: 600 });

  const decision = polled.decision
    || { state: 'timeout', message: '等登录结果超时了，请到教务窗口里看看到哪一步' };
  if (decision.state !== 'success') {
    return { ok: false, reason: decision.state, message: decision.message, url: wc.getURL() };
  }
  return finishOk();
}

/**
 * 取课表：先试结构化接口，不行再退回抓页面。
 *
 * 顺序不能反 —— 结构化数据字段明确、不需要靠版面启发式猜，
 * 而抓 HTML 要面对「课表是 ajax 渲染的、还可能带装饰性表格」这些变数。
 * 只有接口这条路走不通（学校定制/升级改了路径）才退回 HTML。
 */
async function fetchTimetable() {
  if (!eduWindow || eduWindow.isDestroyed()) {
    return { ok: false, reason: 'nowindow', message: '还没有打开教务系统窗口' };
  }
  const wc = eduWindow.webContents;
  const cur = wc.getURL();
  if (!cur || EduLogin.isLoginPage(cur)) {
    return { ok: false, reason: 'nologin', message: '还没登录教务系统，请先自动登录或手动登录' };
  }

  let origin;
  try {
    origin = new URL(cur).origin;
  } catch (e) {
    return { ok: false, reason: 'badurl', message: '教务窗口当前地址不正常：' + cur };
  }

  // 先从左侧菜单发现真实的课表入口（各校菜单名不同，硬编码迟早会失效）
  let discovered = null;
  try {
    discovered = await wc.executeJavaScript(EduLogin.buildMenuProbeScript(), true);
  } catch (e) {
    discovered = null;
  }

  const candidates = buildCandidates(discovered);

  // 先问一次「现在是哪个学期」。
  // 正方页面把当前学期渲染在 #xnm / #xqm 两个下拉里，这是唯一的权威来源 ——
  // 自己按月份推开学日会在小学期、寒假小学期、各校不同校历上翻车。
  const bodies = [];
  let semLabel = '';
  for (let s = 0; s < candidates.length && !semLabel; s++) {
    if (!candidates[s].page) continue;
    let pg = null;
    try {
      pg = await wc.executeJavaScript(
        EduLogin.buildPageGetScript(origin + candidates[s].page), true);
    } catch (e) {
      pg = null;
    }
    if (!pg || pg.status !== 200 || !pg.text) continue;
    const sem = EduLogin.parseSemesterOptions(pg.text);
    if (sem.xnm || sem.xqm) {
      bodies.push(EduLogin.bodyFor(sem.xnm, sem.xqm));
      semLabel = (sem.xnm || '?') + '/' + (sem.xqm || '?');
    }
  }
  bodies.push(EduLogin.TIMETABLE_BODY); // 兜底：不显式指定学期

  // 第一轮：数据接口（每个候选 × 每种学期参数）
  let failWhy = '';
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.api) continue;
    for (let b = 0; b < bodies.length; b++) {
      let res = null;
      try {
        res = await wc.executeJavaScript(
          EduLogin.buildFetchScript(c.api, bodies[b]), true);
      } catch (e) {
        res = null;
      }
      if (res && res.status === 200 && EduLogin.hasKbList(res.body)) {
        return {
          ok: true,
          source: 'api',
          candidate: c.name + (semLabel ? '（' + semLabel + '）' : ''),
          json: res.body,
          pageUrl: c.page ? origin + c.page : ''
        };
      }
      // 记下最像课表接口的那次失败原因：「接口名不对」「学期参数不对」
      // 「会话过期」三件事用户要做的事完全不同，不能在最后笼统报一句「没找到」。
      // 优先保留「有课表外壳但内容为空」这种最接近成功的诊断。
      if (res && res.status === 200) {
        const why = EduLogin.describeKbResponse(res.status, res.body);
        if (!failWhy || /空/.test(why)) failWhy = c.name + '：' + why;
      }
    }
  }

  // 第二轮：抓课表页 HTML
  for (let j = 0; j < candidates.length; j++) {
    const c2 = candidates[j];
    if (!c2.page) continue;
    await loadUrlWithTimeout(wc, origin + c2.page, 25000);
    // 等表格真的渲染出来（课表是 ajax 渲染的，加载完成 ≠ 有表格）
    const ready = await pollScript(wc, 'document.querySelectorAll("table").length',
      (v) => typeof v === 'number' && v > 0, { timeoutMs: 15000, intervalMs: 500 });
    if (!ready.decision) continue;

    let html = '';
    try {
      html = await wc.executeJavaScript(GRAB_SCRIPT, true);
    } catch (e) {
      html = '';
    }
    if (html && /<table/i.test(html)) {
      return { ok: true, source: 'html', candidate: c2.name, html: html, pageUrl: wc.getURL() };
    }
  }

  return {
    ok: false,
    reason: 'notfound',
    message: (failWhy
      ? '没能自动取到课表 —— 接口诊断：' + failWhy + '。'
      : '没能自动取到课表。')
      + '你也可以在教务窗口里手动打开课表页面，再点「读取当前页课表」'
  };
}

/**
 * 候选入口：菜单里发现的 + 内置兜底。
 *
 * ⚠️ 安全要点：菜单发现的结果**只接受站内 `/jwglxt/` 开头的相对路径**。
 * 否则一个被篡改的教务页面只要在菜单里塞个外链，就能让本应用带着会话去请求任意地址。
 */
function buildCandidates(discovered) {
  const out = [];
  const seen = {};

  const add = (c) => {
    const key = (c.api || '') + '|' + (c.page || '');
    if (seen[key]) return;
    seen[key] = 1;
    out.push(c);
  };

  if (Object.prototype.toString.call(discovered) === '[object Array]') {
    for (let i = 0; i < discovered.length; i++) {
      const d = discovered[i];
      const url = typeof d === 'string' ? d : (d && d.url);
      if (typeof url !== 'string' || !/^\/jwglxt\//.test(url)) continue;
      const apis = guessApiPaths(url);
      for (let a = 0; a < apis.length; a++) {
        add({ name: (d && d.text) || '菜单发现', page: url, api: apis[a] });
      }
    }
  }

  for (let k = 0; k < EduLogin.TIMETABLE_CANDIDATES.length; k++) {
    add(EduLogin.TIMETABLE_CANDIDATES[k]);
  }
  return out;
}

/**
 * 从课表页路径推可能要试的数据接口路径。
 *
 * 关键事实（踩过一次才记住）：正方同一个 `.html` 是**双面的** ——
 * GET 出课表页面，POST 出 kbList 的 JSON。所以**页面路径本身就是第一候选**，
 * 根本不需要「换算成接口路径」；下面那些变体只是不同版本/学校用过的另一个名字，
 * 排在后面当兜底。
 *
 * 返回数组而不是单个值：宁可多试一个已知的合法变体，也不要在唯一的假设上失败。
 * 非法输入（不是站内路径）直接返回空数组 —— 不猜，猜出来的地址只会白跑并污染日志。
 */
function guessApiPaths(pageUrl) {
  const page = String(pageUrl == null ? '' : pageUrl);
  if (!/^\/jwglxt\//.test(page)) return [];

  const out = [page];
  if (/xskbcx_cxXsgrkb\.html/.test(page)) {
    out.push(page.replace('xskbcx_cxXsgrkb.html', 'xskbcx_cxXsKb.html'));
  } else if (/xskbcx_cxXsKb\.html/.test(page)) {
    out.push(page.replace('xskbcx_cxXsKb.html', 'xskbcx_cxXsgrkb.html'));
  }
  return out;
}

function registerAutoLoginIpc() {
  ipcMain.handle('edu:login', (event, payload) => autoLogin(payload));
  ipcMain.handle('edu:courses', () => fetchTimetable());

  ipcMain.handle('edu:cred-status', () => getCredStore().status());
  ipcMain.handle('edu:cred-clear', () => {
    const ok = getCredStore().clear();
    return { ok: ok, status: getCredStore().status() };
  });
}

// ==================== WebDAV 云同步（可选，v1.0） ====================
//
// 与教务凭据同一套铁律：密码只在内存与加密存储之间走，磁盘上只有 safeStorage 密文，
// 主进程只回「存没存过 + 用户名」，不回密码。凭据文件独立（webdav-credentials.json），
// 「清除教务账号」绝不能顺带清掉 WebDAV 的，反之亦然 —— 两个功能不要互相连坐。

const webdav = createWebdavClient({ http: require('http'), https: require('https') });
let cloudCredStore = null;

function getCloudCredStore() {
  if (!cloudCredStore) {
    cloudCredStore = createCredStore({
      file: path.join(app.getPath('userData'), 'webdav-credentials.json'),
      safeStorage: safeStorage,
      log: (m) => console.log('[CourseForge] ' + m)
    });
  }
  return cloudCredStore;
}

/** 入参收敛：IPC 传来的东西不可信，先切干净再往深处走 */
function cleanCloudArgs(p) {
  p = (p && typeof p === 'object') ? p : {};
  return {
    url: String(p.url == null ? '' : p.url),
    username: String(p.username == null ? '' : p.username),
    password: String(p.password == null ? '' : p.password),
    body: (typeof p.body === 'string') ? p.body : null,
    useStored: !!p.useStored
  };
}

function registerCloudIpc() {
  // 上传/下载共用一段密码解析：输入框给了就用输入框的；没给且「已存过」才用存的。
  // 存过的用户名必须与本次请求的用户名一致 —— 换了账号还拿旧密码去撞是事故不是便捷。
  async function resolvePassword(args) {
    if (args.password) return args.password;
    if (args.useStored) {
      const saved = getCloudCredStore().read();
      if (saved && saved.password && saved.username === args.username) return saved.password;
    }
    return '';
  }

  ipcMain.handle('cloud:upload', async (event, p) => {
    const args = cleanCloudArgs(p);
    if (!args.url || !args.username) return { ok: false, status: 0, message: '缺少服务器地址或用户名' };
    if (args.body == null) return { ok: false, status: 0, message: '备份内容为空' };
    const pass = await resolvePassword(args);
    if (!pass) return { ok: false, status: 0, message: '没有可用的密码（先填写并保存，或勾选记住密码）' };
    return webdav.upload(args.url, args.username, pass, args.body);
  });

  ipcMain.handle('cloud:download', async (event, p) => {
    const args = cleanCloudArgs(p);
    if (!args.url || !args.username) return { ok: false, status: 0, message: '缺少服务器地址或用户名' };
    const pass = await resolvePassword(args);
    if (!pass) return { ok: false, status: 0, message: '没有可用的密码（先填写并保存，或勾选记住密码）' };
    return webdav.download(args.url, args.username, pass);
  });

  ipcMain.handle('cloud:cred-save', (event, p) => {
    const args = cleanCloudArgs(p);
    return getCloudCredStore().save({ username: args.username, password: args.password });
  });

  ipcMain.handle('cloud:cred-status', () => getCloudCredStore().status());
  ipcMain.handle('cloud:cred-clear', () => {
    const ok = getCloudCredStore().clear();
    return { ok: ok, status: getCloudCredStore().status() };
  });
}

// ==================== 检查更新（v1.1） ====================
//
// 只查版本 + 给下载链接，不自动下载安装 —— 安装包未签名，静默升级必被 SmartScreen 拦。
// 版本源是本仓库的 GitHub Releases；没发布过版本（404）是预期态，明说而不是报错。

const updateChecker = createUpdateChecker({ http: require('http'), https: require('https') });

function registerUpdateIpc() {
  ipcMain.handle('update:check', async () => {
    const result = await updateChecker.check(RELEASES_PAGE, app.getVersion());
    // 链接在 checker 里已过 github.com 白名单；这里再兜一道，绝不把别的字符串带给页面
    if (result.downloadUrl && !/^https:\/\/github\.com\//.test(result.downloadUrl)) {
      result.downloadUrl = RELEASES_PAGE;
    }
    return result;
  });
}

// 精简菜单：保留复制/粘贴/刷新等基础能力
function buildMenu() {
  const template = [
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerCmapProtocol();
  registerEduIpc();
  registerAutoLoginIpc();
  registerCloudIpc();
  registerUpdateIpc();
  buildMenu();
  initDesktopShell();
  createWindow();

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则新建
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // 必须先置退标志：小组件窗口拦了 close 事件（关掉只隐藏），
  // 不置标志的话「点退出」会变成「窗口关不掉、进程也不退」
  if (deskShell) deskShell.beginQuit();
});

app.on('will-quit', () => {
  if (deskShell) deskShell.stop();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // 有托盘常驻时不退出：用户顺手关掉主窗口后，托盘点一下就能唤回，
  // 「桌面常驻」才成立。要退出就去托盘菜单点退出。
  if (deskShell && !deskShell.shouldQuitOnAllClosed()) return;
  app.quit();
});
