/**
 * 渲染层测试：HTML 字符串生成、XSS 转义、关键内容存在性
 * 渲染函数是纯函数，无需浏览器环境
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import CF from '../web/js/core.js';
import CR from '../web/js/render.js';

const settings = CF.normalizeSettings({ semesterStart: '2026-09-14', totalWeeks: 20, sectionsPerDay: 12 });
const sample = CF.buildSampleCourses().map(c => CF.normalizeCourse(c));

// ---------- 转义 ----------

test('esc: 转义所有危险字符', () => {
  assert.equal(CR.esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(CR.esc("it's"), 'it&#39;s');
  assert.equal(CR.esc('a&b'), 'a&amp;b');
});

test('esc: null/undefined 转为空串', () => {
  assert.equal(CR.esc(null), '');
  assert.equal(CR.esc(undefined), '');
});

test('课程名包含 HTML 时不被执行', () => {
  const evil = CF.normalizeCourse({ name: '<img src=x onerror=alert(1)>', day: 1, startSection: 1, endSection: 2, weeks: [1] });
  const html = CR.renderGrid([evil], 1, settings, new Date(2026, 8, 14, 10, 0));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

// ---------- 周导航 ----------

test('renderWeekNav: 包含周次与日期范围', () => {
  const html = CR.renderWeekNav(2, settings, 2);
  assert.ok(html.includes('第 2 周'));
  assert.ok(html.includes('9.21 - 9.27'));
  assert.ok(html.includes('data-action="next-week"'));
  assert.ok(html.includes('chip-brand')); // 本周标识
});

test('renderWeekNav: 非当前周时「回到本周」可用', () => {
  const html = CR.renderWeekNav(5, settings, 2);
  assert.ok(html.includes('data-action="this-week"'));
  assert.ok(!html.includes('data-action="this-week" disabled'));
});

// ---------- 今日课程 ----------

test('renderToday: 显示今天的课与状态', () => {
  // 2026-09-14 周一，有高等数学 1-2 节
  const html = CR.renderToday(sample, 1, settings, new Date(2026, 8, 14, 8, 30));
  assert.ok(html.includes('高等数学（上）'));
  assert.ok(html.includes('进行中'));
  assert.ok(html.includes('教学楼A301'));
});

test('renderToday: 周末显示无课', () => {
  const html = CR.renderToday(sample, 1, settings, new Date(2026, 8, 19, 10, 0)); // 周六
  assert.ok(html.includes('今天没有课'));
});

test('renderToday: 学期未开始提示', () => {
  const html = CR.renderToday(sample, 0, settings, new Date(2026, 8, 7, 10, 0));
  assert.ok(html.includes('学期还未开始'));
});

test('renderToday: 学期已结束提示', () => {
  const html = CR.renderToday(sample, 21, settings, new Date(2027, 1, 8, 10, 0));
  assert.ok(html.includes('学期已结束'));
});

// ---------- 周视图网格 ----------

test('renderGrid: 包含 7 天表头与日期', () => {
  const html = CR.renderGrid(sample, 1, settings, new Date(2026, 8, 14, 10, 0));
  assert.ok(html.includes('周一'));
  assert.ok(html.includes('周日'));
  assert.ok(html.includes('9.14'));
  assert.ok(html.includes('9.20'));
});

test('renderGrid: 课程卡片按位置定位', () => {
  const math = sample[0]; // 周一 1-2 节
  const html = CR.renderGrid([math], 1, settings, new Date(2026, 8, 14, 10, 0));
  assert.ok(html.includes('top:calc(var(--row-h) * 0 + 2px)'));   // 第 1 节起
  assert.ok(html.includes('height:calc(var(--row-h) * 2 - 6px)')); // 占 2 节
  assert.ok(html.includes('data-id="' + math.id + '"'));
});

test('renderGrid: 节次超出每日上限时被夹住（不越界）', () => {
  const c = CF.normalizeCourse({ name: '夜猫课', day: 1, startSection: 11, endSection: 13, weeks: [1] });
  const html = CR.renderGrid([c], 1, settings, new Date(2026, 8, 14, 10, 0));
  // 13 节超过 12 节上限，显示应夹到 12
  assert.ok(html.includes('height:calc(var(--row-h) * 2 - 6px)'));
});

test('renderGrid: 空白格子可点击添加', () => {
  const html = CR.renderGrid([], 1, settings, new Date(2026, 8, 14, 10, 0));
  assert.ok(html.includes('data-day="3" data-section="5"'));
  assert.equal(html.match(/class="cf-cell"/g).length, 12 * 7);
});

test('renderGrid: 单双周课程按当前周显隐', () => {
  const eng = sample[1]; // 单周课（周二 3-4）
  // 第 2 周（双周）不显示
  const htmlEven = CR.renderGrid([eng], 2, settings, new Date(2026, 8, 21, 10, 0));
  assert.ok(!htmlEven.includes(eng.name));
  // 第 3 周（单周）显示
  const htmlOdd = CR.renderGrid([eng], 3, settings, new Date(2026, 8, 28, 10, 0));
  assert.ok(htmlOdd.includes(eng.name));
});

// ---------- 列表视图 ----------

test('renderList: 按天分组并显示周次文本', () => {
  const html = CR.renderList(sample, 1, settings);
  assert.ok(html.includes('周一'));
  assert.ok(html.includes('1-16 周'));
  assert.ok(html.includes('单周上课')); // 备注
  assert.ok(html.includes('data-action="edit-course"'));
  assert.ok(html.includes('data-action="delete-course"'));
});

test('renderList: 无课天数显示占位', () => {
  const html = CR.renderList(sample, 1, settings);
  assert.ok(html.includes('无课'));
});

test('renderList: 整周无课显示空状态', () => {
  const html = CR.renderList([], 1, settings);
  assert.ok(html.includes('本周暂无课程'));
});

// ---------- 统计栏 ----------

test('renderStats: 统计本周节数与课程数', () => {
  const html = CR.renderStats(sample, 1, settings);
  assert.ok(html.includes('节课'));
  assert.ok(html.includes('门课程'));
});

test('renderStats: 有冲突时显示红色提示', () => {
  const a = CF.normalizeCourse({ name: 'A', day: 1, startSection: 1, endSection: 4, weeks: [1] });
  const b = CF.normalizeCourse({ name: 'B', day: 1, startSection: 3, endSection: 5, weeks: [1] });
  const html = CR.renderStats([a, b], 1, settings);
  assert.ok(html.includes('chip-danger'));
});

test('renderStats: 课程超过 30 条提示备份', () => {
  const many = Array.from({ length: 31 }, (_, i) =>
    CF.normalizeCourse({ name: '课' + i, id: 'x' + i, day: (i % 7) + 1, startSection: 12, endSection: 12, weeks: [i + 1] })
  );
  const html = CR.renderStats(many, 1, settings);
  assert.ok(html.includes('建议导出备份'));
});

// ---------- 弹窗动态部分 ----------

test('renderWeeksGrid: 选中态正确', () => {
  const html = CR.renderWeeksGrid([1, 3], 4);
  assert.equal((html.match(/active/g) || []).length, 2);
  assert.ok(html.includes('data-week="1"'));
  assert.ok(html.includes('data-week="3"'));
});

test('renderWeeksGrid: 总周数为 0 时兜底为 1', () => {
  const html = CR.renderWeeksGrid([], 0);
  assert.equal((html.match(/data-week/g) || []).length, 1);
});

test('renderColorSwatches: 8 色且单选高亮', () => {
  const html = CR.renderColorSwatches('green');
  assert.equal((html.match(/class="swatch/g) || []).length, 8);
  assert.equal((html.match(/ active/g) || []).length, 1);
});

test('renderParityButtons: 三个快捷按钮', () => {
  const html = CR.renderParityButtons();
  assert.ok(html.includes('parity-all'));
  assert.ok(html.includes('parity-odd'));
  assert.ok(html.includes('parity-even'));
});

test('clashConfirmText: 列出冲突周次', () => {
  const a = CF.normalizeCourse({ name: '高数', day: 1, startSection: 1, endSection: 4, weeks: [1, 2, 3] });
  const b = CF.normalizeCourse({ name: '英语', day: 1, startSection: 3, endSection: 5, weeks: [2] });
  const text = CR.clashConfirmText(a, [{ other: b, weeks: [2] }]);
  assert.ok(text.includes('高数'));
  assert.ok(text.includes('英语'));
  assert.ok(text.includes('2 周'));
});
