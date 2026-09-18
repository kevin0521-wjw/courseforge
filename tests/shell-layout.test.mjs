/**
 * 小组件窗口几何与偏好持久化测试（desktop/shell-layout.js）
 *
 * 守护的是一个**用户自己救不回来**的场景：
 * 小组件没有任务栏按钮、没有标题栏，窗口一旦被放到屏幕外，
 * 用户看不到也抓不到，只能去手动删 %APPDATA% 下的配置文件。
 * 触发条件很日常 —— 把外接显示器拔掉、或者改分辨率，存下来的绝对坐标就失效了。
 *
 * 所以这里逐种情况断言：还在屏内 / 部分露出 / 完全在外 / 多屏 / 负坐标（副屏在主屏左侧）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import L from '../desktop/shell-layout.js';

const SIZE = { width: L.WIDGET_W, height: L.WIDGET_H };   // 360×196

/** 主屏 1920×1080，任务栏占掉下面 40px */
const MAIN = { x: 0, y: 0, width: 1920, height: 1040 };
/** 副屏挂在主屏右边 */
const RIGHT = { x: 1920, y: 0, width: 1920, height: 1040 };

test('窗口尺寸是固定值（它不是可自由缩放的窗口，尺寸写死才有稳定的排版）', () => {
  assert.equal(SIZE.width, 360);
  assert.equal(SIZE.height, 196);
});

test('位置在屏内：原样保留（用户拖过的位置必须被尊重）', () => {
  const pos = { x: 1500, y: 300 };
  assert.equal(L.isVisibleOn(pos, SIZE, [MAIN]), true);
  assert.deepEqual(L.clampToDisplays(pos, SIZE, [MAIN]), pos);
});

test('贴着右下角的合法位置不该被误判成「在外面」', () => {
  const pos = { x: MAIN.width - SIZE.width, y: MAIN.height - SIZE.height };
  assert.equal(L.isVisibleOn(pos, SIZE, [MAIN]), true);
  assert.deepEqual(L.clampToDisplays(pos, SIZE, [MAIN]), pos);
});

test('整块在屏幕右侧之外（拔掉外接屏的典型症状）→ 夹回主屏右上角', () => {
  const pos = { x: 2400, y: 200 };          // 副屏还在时是合法的
  assert.equal(L.isVisibleOn(pos, SIZE, [MAIN]), false);
  assert.deepEqual(L.clampToDisplays(pos, SIZE, [MAIN]),
    { x: MAIN.width - SIZE.width - L.EDGE, y: L.EDGE });
});

test('整块在屏幕下方之外 → 同样夹回来', () => {
  const pos = { x: 400, y: 1200 };
  assert.equal(L.isVisibleOn(pos, SIZE, [MAIN]), false);
  assert.deepEqual(L.clampToDisplays(pos, SIZE, [MAIN]),
    { x: MAIN.width - SIZE.width - L.EDGE, y: L.EDGE });
});

test('只露出很小一角（抓不住）也算看不见', () => {
  // 只露出 20px 宽的边条：够不到，等于藏起来了
  const sliver = { x: MAIN.width - 20, y: 300 };
  assert.equal(L.isVisibleOn(sliver, SIZE, [MAIN]), false);
  // 露出 60px 宽（> MIN_VISIBLE 48）就抓得住
  const enough = { x: MAIN.width - 60, y: 300 };
  assert.equal(L.isVisibleOn(enough, SIZE, [MAIN]), true);
});

test('多显示器：副屏上的位置应被承认，只有全都不在时才夹取', () => {
  const onRight = { x: RIGHT.x + 100, y: 100 };
  assert.equal(L.isVisibleOn(onRight, SIZE, [MAIN, RIGHT]), true);
  assert.deepEqual(L.clampToDisplays(onRight, SIZE, [MAIN, RIGHT]), onRight);
  // 同一坐标在只有主屏时就不合法了
  assert.equal(L.isVisibleOn(onRight, SIZE, [MAIN]), false);
});

test('副屏在主屏左侧（负坐标）是合法的，不能被当成垃圾值丢掉', () => {
  const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };
  const pos = { x: -1800, y: 120 };
  assert.equal(L.isVisibleOn(pos, SIZE, [MAIN, LEFT]), true);
  assert.deepEqual(L.clampToDisplays(pos, SIZE, [MAIN, LEFT]), pos);
});

test('非法位置（null / NaN / 缺字段）一律回落到主屏右上角，且不抛', () => {
  const fallback = { x: MAIN.width - SIZE.width - L.EDGE, y: L.EDGE };
  for (const bad of [null, undefined, {}, { x: 1 }, { x: NaN, y: 3 },
    { x: 'a', y: 'b' }, { x: Infinity, y: 0 }]) {
    assert.deepEqual(L.clampToDisplays(bad, SIZE, [MAIN]), fallback,
      JSON.stringify(bad) + ' 应回落到默认位置');
  }
});

test('拿不到任何屏幕信息时也有兜底，不会算出 NaN 坐标', () => {
  const r = L.clampToDisplays({ x: 99999, y: 99999 }, SIZE, []);
  assert.ok(isFinite(r.x) && isFinite(r.y), '坐标必须是有限数：' + JSON.stringify(r));
  assert.ok(r.x >= 0 && r.y >= 0);
  // 屏幕列表里有脏项也不能崩
  const r2 = L.clampToDisplays(null, SIZE, [null, { x: 0 }, MAIN]);
  assert.ok(isFinite(r2.x) && isFinite(r2.y));
});

test('尺寸缺失时用默认尺寸兜底（调用点漏传不该算出 NaN）', () => {
  const r = L.clampToDisplays({ x: 99999, y: 0 }, null, [MAIN]);
  assert.equal(r.x, MAIN.width - L.WIDGET_W - L.EDGE);
});

// ==================== 偏好持久化 ====================

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shell-'));
  return path.join(dir, name);
}

test('偏好文件不存在 / 内容损坏时都返回空对象，不抛', () => {
  const f = tmpFile('prefs.json');
  assert.deepEqual(L.loadPrefs(f), {});

  fs.writeFileSync(f, '{ 这不是 JSON', 'utf8');
  assert.deepEqual(L.loadPrefs(f), {}, '半个 JSON 也要当没有，而不是让应用起不来');

  fs.writeFileSync(f, '"just a string"', 'utf8');
  assert.deepEqual(L.loadPrefs(f), {});

  fs.writeFileSync(f, '[1,2,3]', 'utf8');
  assert.deepEqual(L.loadPrefs(f), {}, '数组不是合法的偏好结构');
});

test('偏好能存能读，且写盘用的是原子替换（先 .tmp 再改名）', () => {
  const f = tmpFile('prefs.json');
  const prefs = { widgetVisible: true, widgetPos: { x: 100, y: 200 } };
  assert.equal(L.savePrefs(f, prefs), true);
  assert.deepEqual(L.loadPrefs(f), prefs);
  // 中间文件不该留下
  assert.equal(fs.existsSync(f + '.tmp'), false);
});

test('写盘失败返回 false 而不是抛（目录不可写时不该炸掉整个退出流程）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shell-'));
  // 目标路径的父级是个文件：必然写不进去
  const blocked = path.join(dir, 'afile', 'prefs.json');
  fs.writeFileSync(path.join(dir, 'afile'), 'x', 'utf8');
  assert.equal(L.savePrefs(blocked, { a: 1 }), false);
});

// ==================== 图标候选挑选 ====================

test('图标候选按顺序挑第一个真实存在的；全都不存在返回空串', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-icon-'));
  const a = path.join(dir, 'a.ico');
  const b = path.join(dir, 'b.png');
  fs.writeFileSync(b, 'x', 'utf8');

  assert.equal(L.firstExistingFile([a, b]), b, '不存在 a 就应落到 b');
  fs.writeFileSync(a, 'x', 'utf8');
  assert.equal(L.firstExistingFile([a, b]), a, 'a 存在就该优先用 a');
  assert.equal(L.firstExistingFile([path.join(dir, 'nope.ico')]), '');
  assert.equal(L.firstExistingFile([]), '');
  assert.equal(L.firstExistingFile(null), '');
  // 候选里混进空值 / 非字符串不能崩
  assert.equal(L.firstExistingFile([null, '', 0, b]), b);
});
