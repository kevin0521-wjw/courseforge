/**
 * CourseForge 桌面端主进程
 * 复用 web/ 目录下的页面，通过 file:// 协议加载
 *
 * 相比网页版，桌面端多一项能力：教务系统直连。
 * 浏览器里 JS 受同源策略限制拿不到教务系统页面，主进程没有这个限制，
 * 因此由主进程开一个窗口让用户自己登录，再按需把当前页 HTML 交回渲染进程解析。
 */
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

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

function createWindow() {
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

  if (eduWindow && !eduWindow.isDestroyed()) {
    eduWindow.loadURL(target);
    eduWindow.focus();
    return true;
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

  eduWindow.loadURL(target);
  eduWindow.on('closed', () => {
    eduWindow = null;
  });
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
  registerEduIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    // macOS：点击 Dock 图标时若无窗口则新建
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Windows/Linux：关闭全部窗口即退出
  if (process.platform !== 'darwin') app.quit();
});
