/**
 * 桌面外壳：托盘图标 + 常驻小组件
 *
 * 这一层只做「窗口与托盘」，不做任何课表判定 —— 判定全在 widget-store.js 里。
 * 于是本文件里几乎没有 if/else 业务分支，剩下的都是 GUI 的坑。
 *
 * 涉及的 GUI 坑（都实测过，不是设想）：
 *   1) 托盘图标加载失败时 new Tray(空图) 在 Windows 上直接抛异常，
 *      连带把 app ready 流程炸掉 —— 托盘只是锦上添花，绝不能因为它起不来就整个应用起不来。
 *   2) 小组件没有任务栏按钮。位置一旦存到已拔掉的外接屏坐标上，
 *      窗口就在屏幕外、还抓不回来，用户只能去手删配置文件。所以位置必须夹回可见区域。
 *   3) 关掉主窗口时若把 app 一起退了，托盘也就没了 —— 那「常驻」二字就白写了。
 *      因此窗口全关后是否退出，由这里说了算（见 shouldQuitOnAllClosed）。
 */
'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell } = require('electron');
const path = require('path');
const L = require('./shell-layout.js');

/** 小组件窗口尺寸、刷新节奏等常量都在 shell-layout.js 里（那边可单测） */
const WIDGET_W = L.WIDGET_W;
const WIDGET_H = L.WIDGET_H;
const TICK_MS = L.TICK_MS;
const clampToDisplays = L.clampToDisplays;
const loadPrefs = L.loadPrefs;
const savePrefs = L.savePrefs;

/**
 * 挑一个能用的托盘图标。
 * 两级流程：先按存在性挑路径（纯逻辑，见 shell-layout.js），再交给 nativeImage 解。
 * 全都不行就明确回报「没有图标」而不是硬塞一张空图 ——
 * 空图会让 new Tray 抛异常，把 app ready 的后续步骤全带崩。
 * @returns {{image: object|null, source: string}}
 */
function pickTrayIcon(candidates) {
  const p = L.firstExistingFile(candidates);
  if (!p) return { image: null, source: '' };
  try {
    const img = nativeImage.createFromPath(p);
    // 文件存在不代表解得开（损坏 / 扩展名骗人），isEmpty 才是真的判据
    if (img && !img.isEmpty()) return { image: img, source: p };
    return { image: null, source: 'empty:' + p };
  } catch (e) {
    return { image: null, source: 'error:' + ((e && e.message) || e) };
  }
}

// ==================== 外壳 ====================

/**
 * @param {object} opts
 * @param {string} opts.webDir      web/ 目录（含 widget.html）
 * @param {object} opts.store       widget-store 实例
 * @param {Array<string>} opts.iconCandidates 托盘图标候选路径（按优先级）
 * @param {string} opts.prefsFile   偏好文件路径
 * @param {function} opts.openMain  唤起主窗口
 * @param {function} [opts.log]
 */
function createShell(opts) {
  const o = opts || {};
  const store = o.store;
  const prefsFile = o.prefsFile;
  const log = typeof o.log === 'function' ? o.log : function () {};

  let prefs = loadPrefs(prefsFile);
  let tray = null;
  let widget = null;
  let tickTimer = null;
  let trayReason = '';
  // 「正在退出」用模块内私有变量，不往 electron 的 app 对象上挂自定义属性 ——
  // app 是框架对象，往上写字段迟早会和框架自己的字段撞名
  let quitting = false;

  // ---------- 小组件窗口 ----------

  function workAreas() {
    try {
      return screen.getAllDisplays().map((d) => d.workArea);
    } catch (e) {
      return [];
    }
  }

  function createWidgetWindow() {
    const size = { width: WIDGET_W, height: WIDGET_H };
    const pos = clampToDisplays(prefs.widgetPos || null, size, workAreas());

    widget = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: pos.x,
      y: pos.y,
      frame: false,            // 自绘标题条，才有一块干净的卡片
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,       // 它不该占任务栏格；唤回靠托盘
      alwaysOnTop: true,       // 「贴在桌面角落」的核心诉求
      show: false,
      title: '课表小组件',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload-widget.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });

    widget.loadFile(path.join(o.webDir, 'widget.html'));
    widget.setMenuBarVisibility(false);

    // 位置变化就记住：用户拖到哪，下次就在哪。拖动是高频事件，只在松手后写盘
    widget.on('moved', () => {
      if (!widget || widget.isDestroyed()) return;
      const b = widget.getBounds();
      prefs.widgetPos = { x: b.x, y: b.y };
      savePrefs(prefsFile, prefs);
    });

    // 关闭按钮 / Alt+F4 → 只是藏起来。真正销毁发生在退出时
    widget.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      hideWidget();
    });

    widget.on('closed', () => { widget = null; });

    widget.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    return widget;
  }

  function ensureWidgetWindow() {
    if (!widget || widget.isDestroyed()) createWidgetWindow();
    return widget;
  }

  function showWidget() {
    const w = ensureWidgetWindow();
    if (!w) return false;
    // 每次显示都重新夹一次位置：期间可能拔过外接屏
    const size = { width: WIDGET_W, height: WIDGET_H };
    const pos = clampToDisplays(prefs.widgetPos || null, size, workAreas());
    w.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    w.showInactive();  // showInactive 不抢焦点 —— 常驻挂件弹出来抢走输入焦点非常烦人
    w.setAlwaysOnTop(true);
    prefs.widgetVisible = true;
    savePrefs(prefsFile, prefs);
    pushView();
    refreshMenu();
    return true;
  }

  function hideWidget() {
    if (widget && !widget.isDestroyed()) widget.hide();
    prefs.widgetVisible = false;
    savePrefs(prefsFile, prefs);
    refreshMenu();
    return true;
  }

  function isWidgetVisible() {
    return !!(widget && !widget.isDestroyed() && widget.isVisible());
  }

  function toggleWidget() {
    return isWidgetVisible() ? hideWidget() : showWidget();
  }

  // ---------- 数据推送 ----------

  /** 把最新视图推给小组件页面（页面只负责画，不做判定） */
  function pushView() {
    if (!widget || widget.isDestroyed()) return;
    const v = store.buildView(new Date());
    try {
      widget.webContents.send('widget:update', v);
    } catch (e) { /* 页面还没加载完，等下一次 tick */ }
  }

  /** 每 30 秒刷一次：托盘提示与小组件内容。倒计时的秒级跳动由页面自己插值，不用主进程操心 */
  function tick() {
    if (tray) {
      try { tray.setToolTip(store.tooltip(new Date())); } catch (e) { /* 托盘已销毁 */ }
    }
    pushView();
  }

  // ---------- 托盘 ----------

  function refreshMenu() {
    if (!tray) return;
    const v = store.buildView(new Date());
    const template = [
      // 第一行直接把「下一次课」摆出来：这是用户瞄托盘时最想知道的一件事
      { label: v.statusLine || '课表工坊', enabled: false },
      { type: 'separator' },
      {
        label: '显示课表小组件',
        type: 'checkbox',
        checked: isWidgetVisible(),
        click: () => toggleWidget()
      },
      { label: '打开课表', click: () => o.openMain && o.openMain() },
      { type: 'separator' },
      { label: '退出', click: () => quit() }
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /** 退出：先把 quitting 立起来，widget 的 close 拦截才会放行 */
  function quit() {
    quitting = true;
    app.quit();
  }

  function createTray() {
    const picked = pickTrayIcon(o.iconCandidates || []);
    if (!picked.image) {
      trayReason = 'noicon';
      log('托盘图标不可用，跳过托盘（不影响其他功能）');
      return null;
    }
    try {
      tray = new Tray(picked.image);
    } catch (e) {
      trayReason = 'error:' + ((e && e.message) || e);
      log('托盘创建失败：' + trayReason);
      tray = null;
      return null;
    }
    tray.setToolTip(store.tooltip(new Date()));
    // 左键点击切换小组件显隐 —— 比「必须右键点菜单」顺手得多
    tray.on('click', () => toggleWidget());
    refreshMenu();
    return tray;
  }

  // ---------- IPC ----------

  function registerIpc() {
    // 主窗口每次数据变化后推快照过来
    ipcMain.handle('shell:push', (event, payload) => {
      const ok = store.setWorkspace(payload);
      tick();
      refreshMenu();
      return { ok: ok };
    });

    ipcMain.handle('shell:status', () => ({
      tray: !!(tray && !tray.isDestroyed()),
      trayReason: trayReason,
      widgetVisible: isWidgetVisible(),
      alwaysOnTop: !!(widget && !widget.isDestroyed() && widget.isAlwaysOnTop()),
      bounds: (widget && !widget.isDestroyed()) ? widget.getBounds() : null
    }));

    ipcMain.handle('shell:widget-show', () => showWidget());
    ipcMain.handle('shell:widget-hide', () => hideWidget());
    ipcMain.handle('shell:widget-toggle', () => toggleWidget());

    // 小组件页面来取数据（首次加载时主动拉一次，不等 30 秒的 tick）
    ipcMain.handle('widget:view', () => store.buildView(new Date()));
    ipcMain.handle('widget:hide', () => hideWidget());
    ipcMain.handle('widget:open-main', () => {
      if (o.openMain) o.openMain();
      return true;
    });
  }

  function start() {
    registerIpc();
    createTray();
    // 上次关掉之前是开着的 → 这次启动自动恢复。不然每次开机都要手动点一次托盘
    if (prefs.widgetVisible === true) {
      try { showWidget(); } catch (e) { log('恢复小组件失败：' + ((e && e.message) || e)); }
    }
    tickTimer = setInterval(tick, TICK_MS);
    // Node 的定时器会拖住事件循环；Electron 里不 unref 的话退出会变慢
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  /**
   * 应用即将退出时调用：置上退标志，widget 的 close 拦截才会放行，
   * 否则会出现「点了退出但窗口关不掉、进程也不退」的死局。
   */
  function beginQuit() {
    quitting = true;
  }

  /**
   * 所有窗口都关掉之后，要不要退出应用。
   * 有托盘常驻时**不退出** —— 否则用户顺手关掉主窗口，托盘也跟着没了，
   * 「常驻挂件」这个概念就不成立了。退出的入口在托盘菜单里。
   */
  function shouldQuitOnAllClosed() {
    return !(tray && !tray.isDestroyed());
  }

  return {
    start: start,
    stop: stop,
    beginQuit: beginQuit,
    quit: quit,
    showWidget: showWidget,
    hideWidget: hideWidget,
    toggleWidget: toggleWidget,
    isWidgetVisible: isWidgetVisible,
    refreshMenu: refreshMenu,
    pushView: pushView,
    tick: tick,
    shouldQuitOnAllClosed: shouldQuitOnAllClosed,
    getTray: () => tray,
    getWidget: () => widget
  };
}

module.exports = {
  createShell: createShell,
  pickTrayIcon: pickTrayIcon,
  // 几何与偏好逻辑的实现都在 shell-layout.js（可单测），这里只是转出去，
  // 免得调用方还要知道「哪个常量在哪个文件」
  isVisibleOn: L.isVisibleOn,
  clampToDisplays: L.clampToDisplays,
  loadPrefs: L.loadPrefs,
  savePrefs: L.savePrefs,
  WIDGET_W: WIDGET_W,
  WIDGET_H: WIDGET_H,
  MIN_VISIBLE: L.MIN_VISIBLE,
  TICK_MS: TICK_MS
};
