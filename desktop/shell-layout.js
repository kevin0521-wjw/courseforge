/**
 * 常驻小组件的几何与偏好（纯逻辑，不 require electron）
 *
 * 为什么单独成文件：这些函数要能被 node --test 直接单测。
 * 它们守护的是一个**用户自己救不回来**的场景 ——
 * 小组件没有任务栏按钮，窗口一旦落在屏幕外，用户既看不到也抓不到，
 * 只能去手删配置文件。所以位置夹取必须逐种情况测到，
 * 而 desktop-shell.js 顶层 require('electron')，在 Node 里根本加载不了。
 */
'use strict';

const fs = require('fs');

/** 小组件窗口尺寸：固定，它是「贴在桌面角落的一张信息卡」，不是可自由缩放的窗口 */
const WIDGET_W = 360;
const WIDGET_H = 196;
/** 距屏幕边缘的默认留白 */
const EDGE = 24;
/** 至少要露出这么大的方角，用户才抓得住窗口（小于它等于藏起来了） */
const MIN_VISIBLE = 48;
/** tooltip / 小组件数据的刷新节奏 */
const TICK_MS = 30000;

/**
 * 保存的位置是否还能在某块屏幕上看到一部分。
 * @param {{x:number,y:number}} pos  保存的位置
 * @param {{width:number,height:number}} size 窗口尺寸
 * @param {Array} areas workArea 列表 [{x,y,width,height}]
 */
function isVisibleOn(pos, size, areas) {
  if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) return false;
  if (!size || !isFinite(size.width) || !isFinite(size.height)) return false;
  const list = Array.isArray(areas) ? areas : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || !isFinite(a.x) || !isFinite(a.y)) continue;
    const ox = Math.min(pos.x + size.width, a.x + a.width) - Math.max(pos.x, a.x);
    const oy = Math.min(pos.y + size.height, a.y + a.height) - Math.max(pos.y, a.y);
    // 重叠区够大才算「看得见」：只露一条边或一个小角，用户是抓不住的
    if (ox >= MIN_VISIBLE && oy >= MIN_VISIBLE) return true;
  }
  return false;
}

/**
 * 把保存的位置夹回「看得见」的地方。
 * 位置合法就原样返回（尊重用户拖动过的结果），不合法才回落到主屏右上角。
 * @param {object} saved
 * @param {Array} areas  workArea 列表，**第一项视为主屏**（Electron 的约定）
 */
function clampToDisplays(saved, size, areas) {
  const s = size || { width: WIDGET_W, height: WIDGET_H };
  if (isVisibleOn(saved, s, areas)) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }
  const a = (Array.isArray(areas) && areas[0]) || { x: 0, y: 0, width: 1280, height: 800 };
  return {
    x: Math.round(a.x + a.width - s.width - EDGE),
    y: Math.round(a.y + EDGE)
  };
}

/** 读偏好文件；任何异常都当「没有偏好」，不抛 */
function loadPrefs(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    return {};
  }
}

/** 原子写偏好文件（先写 .tmp 再改名）：中途断电也不会留下半个 JSON */
function savePrefs(file, prefs) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 从候选路径里挑第一个真实存在的文件。
 *
 * 只做「存在性」判断、不碰 nativeImage —— 于是这条挑选逻辑可以单测，
 * 而真正加载图片那一步留在 shell 里（那需要 electron 环境）。
 * 分开的另一个好处：加载失败的原因（文件不存在 vs 图片解不开）在日志里能分清。
 */
function firstExistingFile(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== 'string') continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) { /* 权限之类的异常，换下一个 */ }
  }
  return '';
}

module.exports = {
  WIDGET_W: WIDGET_W,
  WIDGET_H: WIDGET_H,
  EDGE: EDGE,
  MIN_VISIBLE: MIN_VISIBLE,
  TICK_MS: TICK_MS,
  isVisibleOn: isVisibleOn,
  clampToDisplays: clampToDisplays,
  loadPrefs: loadPrefs,
  savePrefs: savePrefs,
  firstExistingFile: firstExistingFile
};
