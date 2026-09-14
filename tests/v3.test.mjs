/**
 * v0.3 新能力测试：今日实时进度 / 下一节课 / 深色主题色变量渲染
 * 运行：node --test
 */
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CF = require('../web/js/core.js');
const CR = require('../web/js/render.js');

const SETTINGS = {
  semesterStart: '2026-09-14',
  totalWeeks: 20,
  sectionsPerDay: 12,
  sectionTimes: CF.getPresetTimes('shu') // 1节 08:00-08:45；2节 08:55-09:40；5节 13:00-13:45
};

function mkCourse(over) {
  return CF.normalizeCourse(Object.assign({
    id: 'c1', name: '高等数学', teacher: '王老师', location: '教学楼A301',
    day: 2, startSection: 1, endSection: 2, weeks: [1, 2, 3], color: 'blue'
  }, over || {}));
}

function at(h, m) { return new Date(2026, 8, 15, h, m, 0); } // 2026-09-15 周二

// ==================== courseProgress ====================

test('courseProgress: 上课前返回 startInMin', () => {
  const p = CF.courseProgress(mkCourse(), at(7, 30), SETTINGS);
  assert.equal(p.state, 'before');
  assert.equal(p.startInMin, 30);
  assert.equal(p.percent, 0);
});

test('courseProgress: 进行中百分比与剩余时间正确', () => {
  // 08:00-09:40 共 100 分钟，08:25 → 25%
  const p = CF.courseProgress(mkCourse(), at(8, 25), SETTINGS);
  assert.equal(p.state, 'now');
  assert.equal(p.percent, 25);
  assert.equal(p.remainMin, 75);
});

test('courseProgress: 已结束返回 100%', () => {
  const p = CF.courseProgress(mkCourse(), at(11, 0), SETTINGS);
  assert.equal(p.state, 'done');
  assert.equal(p.percent, 100);
  assert.equal(p.remainMin, 0);
});

test('courseProgress: 作息缺失时返回 unknown 且不抛错', () => {
  const s = Object.assign({}, SETTINGS, { sectionTimes: [{ label: '1', start: '', end: '' }] });
  const p = CF.courseProgress(mkCourse(), at(8, 25), s);
  assert.equal(p.state, 'unknown');
  assert.equal(p.percent, 0);
});

test('courseProgress: 边界时刻（正好上课=0%，正好下课=已结束）', () => {
  assert.equal(CF.courseProgress(mkCourse(), at(8, 0), SETTINGS).percent, 0);
  assert.equal(CF.courseProgress(mkCourse(), at(8, 0), SETTINGS).state, 'now');
  assert.equal(CF.courseProgress(mkCourse(), at(9, 40), SETTINGS).state, 'done');
});

// ==================== nextCourse ====================

test('nextCourse: 返回最近一节未开始的课', () => {
  const list = [
    mkCourse({ id: 'a', startSection: 1, endSection: 2 }),  // 08:00
    mkCourse({ id: 'b', startSection: 5, endSection: 6, name: '数据结构' }) // 13:00
  ];
  const next = CF.nextCourse(list, at(9, 0), SETTINGS);
  assert.equal(next.course.id, 'b');
  assert.equal(next.startInMin, 240);
  assert.equal(next.startTime, '13:00');
});

test('nextCourse: 全部已开始返回 null', () => {
  const list = [mkCourse({ startSection: 1, endSection: 2 })];
  assert.equal(CF.nextCourse(list, at(14, 0), SETTINGS), null);
  assert.equal(CF.nextCourse([], at(14, 0), SETTINGS), null);
});

test('courseMinutes: 时间区间解析与非法兜底', () => {
  assert.deepEqual(CF.courseMinutes(mkCourse(), SETTINGS), { start: 480, end: 580 });
  // 节次时间不完整 → 无法计算区间
  const bad = { sectionTimes: [{ label: '1', start: '', end: '' }] };
  assert.equal(CF.courseMinutes(mkCourse(), bad), null);
  // sectionTimes 为空数组时回落默认作息，仍可算出区间（设计如此）
  assert.deepEqual(CF.courseMinutes(mkCourse(), { sectionTimes: [] }), { start: 480, end: 580 });
});

test('nowMinutes: 当日分钟数', () => {
  assert.equal(CF.nowMinutes(at(0, 0)), 0);
  assert.equal(CF.nowMinutes(at(13, 30)), 810);
});

// ==================== 渲染：今日实时区块 ====================

test('renderToday: 显示当前时间与下一节课倒计时', () => {
  const list = [mkCourse({ id: 'a', startSection: 1, endSection: 2 })];
  const html = CR.renderToday(list, 1, SETTINGS, at(7, 30));
  assert.ok(html.includes('today-clock'), '应有当前时间');
  assert.ok(html.includes('07:30'), '时间文本应为 07:30');
  assert.ok(html.includes('today-live'), '应有实时提示条');
  assert.ok(html.includes('下一节'), '应显示下一节课');
  assert.ok(html.includes('30 分钟'), '应显示倒计时分钟数');
});

test('renderToday: 进行中课程显示进度条与剩余时间', () => {
  const list = [mkCourse({ id: 'a', startSection: 1, endSection: 2 })];
  const html = CR.renderToday(list, 1, SETTINGS, at(8, 25));
  assert.ok(html.includes('tc-progress'), '应有进度条');
  assert.ok(html.includes('width:25%'), '进度应为 25%');
  assert.ok(html.includes('还剩'), '应显示剩余时间');
  assert.ok(html.includes('进行中'));
});

test('renderToday: 未开始课程显示开课倒计时', () => {
  const list = [mkCourse({ id: 'a', startSection: 5, endSection: 6 })];
  const html = CR.renderToday(list, 1, SETTINGS, at(12, 0));
  assert.ok(html.includes('还有'), '应显示还有多久开始');
  assert.ok(html.includes('1 小时'), '12:00 → 13:00 应为 1 小时');
  assert.ok(html.includes('未开始'));
});

test('renderToday: 今日无课 / 学期未开始的空态', () => {
  assert.ok(CR.renderToday([], 1, SETTINGS, at(9, 0)).includes('今天没有课'));
  assert.ok(CR.renderToday([], 0, SETTINGS, at(9, 0)).includes('学期还未开始'));
  assert.ok(CR.renderToday([], 21, SETTINGS, at(9, 0)).includes('本学期已结束'));
});

// ==================== 渲染：主题化颜色 ====================

test('colorVars: 输出带 fallback 的 CSS 变量表达式', () => {
  const v = CR.colorVars('green');
  assert.equal(v.key, 'green');
  assert.equal(v.bg, 'var(--c-green-bg, #e2f6ee)');
  assert.equal(v.main, 'var(--c-green-main, #0e9f6e)');
});

test('colorVars: 非法颜色回落到第一个预设', () => {
  assert.equal(CR.colorVars('nope').key, CF.COURSE_COLORS[0].key);
});

test('renderCourseCard/renderList 使用主题变量而非硬编码浅色', () => {
  const grid = CR.renderGrid([mkCourse()], 1, SETTINGS, at(9, 0));
  assert.ok(grid.includes('var(--c-blue-bg'), '网格卡片应使用主题变量');
  assert.ok(!grid.includes('background:#e8effd'), '不应硬编码浅色背景');
  const list = CR.renderList([mkCourse()], 1, SETTINGS);
  assert.ok(list.includes('var(--c-blue-main'), '列表行应使用主题变量');
  assert.ok(list.includes('data-color="blue"'), '应带 data-color 便于调试与主题覆盖');
});

test('hhmm / humanMin 格式化', () => {
  assert.equal(CR.hhmm(at(8, 5)), '08:05');
  assert.equal(CR.humanMin(45), '45 分钟');
  assert.equal(CR.humanMin(60), '1 小时');
  assert.equal(CR.humanMin(125), '2 小时 5 分钟');
  assert.equal(CR.humanMin(null), '');
});

test('深色主题：CSS 中每个课程色都有深色变体', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const css = await readFile(fileURLToPath(new URL('../web/css/style.css', import.meta.url)), 'utf-8');
  const darkBlock = /html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(darkBlock, 'CSS 中应有深色主题变量块');
  for (const c of CF.COURSE_COLORS) {
    assert.ok(darkBlock[1].includes('--c-' + c.key + '-bg'), '缺少深色背景变量: ' + c.key);
    assert.ok(darkBlock[1].includes('--c-' + c.key + '-main'), '缺少深色主色变量: ' + c.key);
  }
});

// ==================== 显示周末开关（v0.3 优化） ====================

const NO_WEEKEND = Object.assign({}, SETTINGS, { showWeekend: false });

test('normalizeSettings: showWeekend 默认 true（兼容旧数据）', () => {
  assert.equal(CF.normalizeSettings({}).showWeekend, true);
  assert.equal(CF.normalizeSettings({ showWeekend: undefined }).showWeekend, true);
  assert.equal(CF.normalizeSettings({ showWeekend: true }).showWeekend, true);
  assert.equal(CF.normalizeSettings({ showWeekend: false }).showWeekend, false);
  // 非法值不应把周末关掉
  assert.equal(CF.normalizeSettings({ showWeekend: 'no' }).showWeekend, true);
  assert.equal(CF.normalizeSettings({ showWeekend: 0 }).showWeekend, true);
});

test('visibleDays: 默认 7 天，关闭周末后 5 天', () => {
  assert.equal(CR.visibleDays(SETTINGS), 7);
  assert.equal(CR.visibleDays(NO_WEEKEND), 5);
  assert.equal(CR.visibleDays(null), 7);
});

test('renderGrid: 关闭周末后只渲染 5 列', () => {
  const courses = [mkCourse({ id: 'a', day: 2 }), mkCourse({ id: 'b', day: 6, name: '周末课' })];
  const full = CR.renderGrid(courses, 1, SETTINGS, at(9, 0));
  assert.ok(full.includes('repeat(7,minmax(96px,1fr))'), '默认应为 7 列');
  assert.ok(full.includes('周六') && full.includes('周日'));

  const slim = CR.renderGrid(courses, 1, NO_WEEKEND, at(9, 0));
  assert.ok(slim.includes('repeat(5,minmax(96px,1fr))'), '关闭周末应为 5 列');
  assert.ok(!slim.includes('周六'), '不应出现周六表头');
  assert.ok(!slim.includes('周日'), '不应出现周日表头');
  assert.ok(slim.includes('高等数学'), '工作日课程仍应渲染');
  assert.ok(!slim.includes('周末课'), '周末课程不应渲染到网格里');
  // 空白格也不该出现在周末列
  assert.ok(!slim.includes('data-day="6"') && !slim.includes('data-day="7"'));
});

test('renderGrid: 表头与主体列数一致（否则会错位）', () => {
  for (const s of [SETTINGS, NO_WEEKEND]) {
    const html = CR.renderGrid([mkCourse()], 1, s, at(9, 0));
    const head = /<div class="cf-gridhead"[^>]*grid-template-columns:var\(--time-w\) repeat\((\d+)/.exec(html);
    const body = /<div class="cf-gridbody"[^>]*repeat\((\d+)/.exec(html);
    assert.ok(head && body, '应能解析出列数');
    assert.equal(head[1], body[1], '表头与主体列数必须一致');
    assert.equal(Number(head[1]), CR.visibleDays(s));
  }
});

test('renderStats: 隐藏周末时提示被折叠的周末课程数', () => {
  const courses = [mkCourse({ id: 'a', day: 2 }), mkCourse({ id: 'b', day: 6 })];
  const slim = CR.renderStats(courses, 1, NO_WEEKEND);
  assert.ok(slim.includes('周末还有 1 门课被隐藏'), '应明确提示周末课程被隐藏');
  const full = CR.renderStats(courses, 1, SETTINGS);
  assert.ok(!full.includes('被隐藏'), '显示周末时不应出现该提示');
});

test('renderList: 关闭周末后不列出周六周日', () => {
  const courses = [mkCourse({ id: 'a', day: 6, name: '周末课' })];
  assert.ok(CR.renderList(courses, 1, NO_WEEKEND).includes('本周暂无课程'));
  assert.ok(CR.renderList(courses, 1, SETTINGS).includes('周末课'));
});

test('renderWeekNav: 日期区间随可见天数变化', () => {
  const full = CR.renderWeekNav(1, SETTINGS, 1);
  assert.ok(full.includes('9.14 - 9.20'), '默认应显示到周日');
  const slim = CR.renderWeekNav(1, NO_WEEKEND, 1);
  assert.ok(slim.includes('9.14 - 9.18'), '关闭周末应显示到周五');
});

// ==================== 移动端触屏硬指标（回归护栏） ====================

/** 从 CSS 中按大括号配对提取某个媒体查询的完整内容 */
function extractBlock(css, marker) {
  const i = css.indexOf(marker);
  assert.ok(i >= 0, 'CSS 中找不到：' + marker);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  throw new Error('大括号未闭合：' + marker);
}

test('移动端 CSS：复合选择器也必须满足 44px 点击区', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const css = await readFile(fileURLToPath(new URL('../web/css/style.css', import.meta.url)), 'utf-8');
  const mobile = extractBlock(css, '@media (max-width: 768px)');
  // 这些选择器优先级高于通用的 .btn，遗漏任何一个都会留下 32~40px 的小按钮
  for (const sel of ['.btn', '.btn-switch', '.tool-actions .btn', '.parity-bar .btn', '.lr-actions .btn', '.sem-actions .btn', '.week-btn', '.swatch']) {
    assert.ok(mobile.includes(sel), '移动端必须显式覆盖 ' + sel + ' 的点击区');
  }
  assert.ok(/min-height:\s*44px/.test(mobile), '移动端必须存在 min-height: 44px 规则');
  assert.ok(/\.lr-actions \.btn[\s\S]{0,40}min-width:\s*44px/.test(mobile) ||
    /min-width:\s*44px/.test(mobile), '图标类按钮必须保证 44px 宽');
  assert.ok(/min-height:\s*48px/.test(mobile), '复选字段整行点击区应 ≥48px');
});

test('移动端 CSS：输入控件字号 16px 必须用 !important 才能压过 ID/类选择器', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const css = await readFile(fileURLToPath(new URL('../web/css/style.css', import.meta.url)), 'utf-8');
  const mobile = extractBlock(css, '@media (max-width: 768px)');
  assert.ok(/input:not\(\[type="checkbox"\]\)[\s\S]{0,200}font-size:\s*16px\s*!important/.test(mobile),
    '输入控件字号需 16px !important，否则 #importText/.mode-select 的 13~14px 会生效导致 iOS 自动放大');
  // 反例检查：确认 #importText / .mode-select 确实存在更小字号（说明 !important 是必要的）
  assert.ok(/#importText\s*\{[\s\S]*?font-size:\s*14px/.test(css), '#importText 的 14px 是 !important 必要性的依据');
  assert.ok(/\.mode-select\s*\{[\s\S]*?font-size:\s*13px/.test(css), '.mode-select 的 13px 是 !important 必要性的依据');
});

test('移动端 CSS：textarea 不能被强行压成 44px 高', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const css = await readFile(fileURLToPath(new URL('../web/css/style.css', import.meta.url)), 'utf-8');
  const mobile = extractBlock(css, '@media (max-width: 768px)');
  // min-height 若对 textarea 生效，会把高 150px 的粘贴框压扁
  assert.ok(!/textarea\s*\{[^}]*min-height/.test(mobile), 'textarea 不应被设置 min-height');
  assert.ok(!/,?\s*textarea\s*,?[\s\S]{0,80}min-height:\s*44px/.test(mobile), 'textarea 不应落入 44px 组');
});
