/**
 * 核心逻辑测试：周次计算 / 单双周 / 冲突检测 / 校验 / 数据清洗 / 作息时间
 * 运行：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import CF from '../web/js/core.js';

// ---------- 周次计算 ----------

test('getWeekNumber: 学期开始当天是第 1 周', () => {
  // 2026-09-14 是周一
  const w = CF.getWeekNumber('2026-09-14', new Date(2026, 8, 14));
  assert.equal(w, 1);
});

test('getWeekNumber: 一周后是第 2 周', () => {
  const w = CF.getWeekNumber('2026-09-14', new Date(2026, 8, 21));
  assert.equal(w, 2);
});

test('getWeekNumber: 学期开始前返回 0 或负数', () => {
  const w = CF.getWeekNumber('2026-09-14', new Date(2026, 8, 7));
  assert.equal(w, 0);
});

test('getWeekNumber: 跨年计算正确（12月末→次年1月）', () => {
  // 2026-12-28 是周一，第 1 周；2027-01-04 应为第 2 周
  const w = CF.getWeekNumber('2026-12-28', new Date(2027, 0, 4));
  assert.equal(w, 2);
});

test('getWeekNumber: 跨年且跨月边界（12-31 → 1-1）', () => {
  const w1 = CF.getWeekNumber('2026-12-28', new Date(2026, 11, 31));
  const w2 = CF.getWeekNumber('2026-12-28', new Date(2027, 0, 1));
  assert.equal(w1, 1);
  assert.equal(w2, 1); // 12-31 是周一，1-1 是同周周日
});

test('getWeekNumber: 周日属于所在周（周日 ≠ 下周）', () => {
  const w = CF.getWeekNumber('2026-09-14', new Date(2026, 8, 20)); // 周日
  assert.equal(w, 1);
});

test('getWeekNumber: 学期开始日非周一也能对齐', () => {
  // 2026-09-16 是周三，第 1 周从 09-14（周一）算起
  const w = CF.getWeekNumber('2026-09-16', new Date(2026, 8, 16));
  assert.equal(w, 1);
});

test('getWeekNumber: 非法学期日期兜底返回 1', () => {
  assert.equal(CF.getWeekNumber('not-a-date', new Date()), 1);
  assert.equal(CF.getWeekNumber(null, new Date()), 1);
});

test('mondayOfWeek: 第 n 周周一 = 起点 + (n-1)*7 天', () => {
  const mon = CF.mondayOfWeek('2026-09-14', 3);
  assert.equal(CF.formatDate(mon), '2026-09-28');
});

test('mondayOfWeek: 非法学期日期返回 null', () => {
  assert.equal(CF.mondayOfWeek('bad', 1), null);
});

// ---------- 周次生成 ----------

test('generateWeeks: 全周 1-16', () => {
  assert.deepEqual(CF.generateWeeks(1, 16, 'all', 20), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('generateWeeks: 单周', () => {
  assert.deepEqual(CF.generateWeeks(1, 8, 'odd', 20), [1, 3, 5, 7]);
});

test('generateWeeks: 双周', () => {
  assert.deepEqual(CF.generateWeeks(1, 8, 'even', 20), [2, 4, 6, 8]);
});

test('generateWeeks: 超出学期总周数被截断', () => {
  assert.deepEqual(CF.generateWeeks(1, 30, 'all', 20).pop(), 20);
});

test('generateWeeks: 起止颠倒自动交换', () => {
  assert.deepEqual(CF.generateWeeks(8, 6, 'all', 20), [6, 7, 8]);
});

// ---------- 课程查询与冲突 ----------

const mkCourse = (over) => CF.normalizeCourse(Object.assign({
  name: '测试课', day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3]
}, over));

test('getDayCourses: 只返回该天该周的课程并按节次排序', () => {
  const a = mkCourse({ id: 'a', day: 1, startSection: 5, endSection: 6 });
  const b = mkCourse({ id: 'b', day: 1, startSection: 1, endSection: 2 });
  const c = mkCourse({ id: 'c', day: 2 });
  const list = CF.getDayCourses([a, b, c], 1, 1);
  assert.deepEqual(list.map(x => x.id), ['b', 'a']);
});

test('getDayCourses: 单双周过滤', () => {
  const odd = mkCourse({ id: 'odd', weeks: [1, 3, 5] });
  assert.equal(CF.getDayCourses([odd], 2, 1).length, 0);
  assert.equal(CF.getDayCourses([odd], 3, 1).length, 1);
});

test('sectionsOverlap: 相邻节次不重叠（1-2 与 3-4）', () => {
  assert.equal(CF.sectionsOverlap(1, 2, 3, 4), false);
});

test('sectionsOverlap: 交叉重叠（1-3 与 2-4）', () => {
  assert.equal(CF.sectionsOverlap(1, 3, 2, 4), true);
});

test('sectionsOverlap: 包含重叠（1-4 与 2-3）', () => {
  assert.equal(CF.sectionsOverlap(1, 4, 2, 3), true);
});

test('detectConflicts: 同周同天节次重叠才报警', () => {
  const a = mkCourse({ id: 'a', day: 1, startSection: 1, endSection: 4, weeks: [1] });
  const b = mkCourse({ id: 'b', day: 1, startSection: 3, endSection: 5, weeks: [1] });
  const c = mkCourse({ id: 'c', day: 2, startSection: 3, endSection: 5, weeks: [1] }); // 不同天
  const conf = CF.detectConflicts([a, b, c], 1);
  assert.equal(conf.length, 1);
  assert.equal(conf[0].day, 1);
});

test('detectConflicts: 不同周不冲突', () => {
  const a = mkCourse({ id: 'a', weeks: [1] });
  const b = mkCourse({ id: 'b', weeks: [2] });
  assert.equal(CF.detectConflicts([a, b], 1).length, 0);
  assert.equal(CF.detectConflicts([a, b], 2).length, 0);
});

test('findCourseClashes: 返回共同冲突周次', () => {
  const a = mkCourse({ id: 'a', weeks: [1, 2, 3, 4] });
  const b = mkCourse({ id: 'b', startSection: 2, endSection: 3, weeks: [3, 4, 5] });
  const clashes = CF.findCourseClashes(a, [b]);
  assert.equal(clashes.length, 1);
  assert.deepEqual(clashes[0].weeks, [3, 4]);
});

test('findCourseClashes: 排除自身', () => {
  const a = mkCourse({ id: 'a', weeks: [1] });
  assert.equal(CF.findCourseClashes(a, [a]).length, 0);
});

// ---------- 校验 ----------

test('validateCourse: 缺少名称报错', () => {
  const errs = CF.validateCourse(mkCourse({ name: '  ' }), { sectionsPerDay: 12 }, []);
  assert.ok(errs.some(e => e.includes('课程名称')));
});

test('validateCourse: 结束节次超上限报错', () => {
  const errs = CF.validateCourse(mkCourse({ endSection: 13 }), { sectionsPerDay: 12 }, []);
  assert.ok(errs.some(e => e.includes('最大节次')));
});

test('validateCourse: 起止颠倒报错（未经 normalize 的原始输入）', () => {
  const errs = CF.validateCourse({ name: 'x', day: 1, startSection: 5, endSection: 3, weeks: [1] }, { sectionsPerDay: 12 }, []);
  assert.ok(errs.some(e => e.includes('不能晚于')));
});

test('validateCourse: 无周次报错', () => {
  const errs = CF.validateCourse(mkCourse({ weeks: [] }), { sectionsPerDay: 12 }, []);
  assert.ok(errs.some(e => e.includes('上课周')));
});

test('validateCourse: 合法课程零错误', () => {
  const errs = CF.validateCourse(mkCourse({}), { sectionsPerDay: 12 }, []);
  assert.deepEqual(errs, []);
});

// ---------- 数据清洗 ----------

test('normalizeCourse: 脏数据兜底', () => {
  const c = CF.normalizeCourse({
    name: '  脏数据  ', day: '9', startSection: 'x', endSection: null, weeks: ['2', 1, 2, 'abc', 99], teacher: null
  });
  assert.equal(c.name, '脏数据');
  assert.equal(c.day, 7); // 9 越界回落到 7
  assert.equal(c.startSection, 1);
  assert.equal(c.endSection, 1);
  assert.deepEqual(c.weeks, [1, 2]); // '2'→2, 1, 2 去重排序；'abc'/99 被过滤
});

test('normalizeCourse: 起止颠倒自动交换', () => {
  const c = CF.normalizeCourse({ name: 'x', startSection: 4, endSection: 2, weeks: [1] });
  assert.equal(c.startSection, 2);
  assert.equal(c.endSection, 4);
});

test('normalizeCourse: 缺 id 自动生成且不重复', () => {
  const a = CF.normalizeCourse({ name: 'x', weeks: [1] });
  const b = CF.normalizeCourse({ name: 'x', weeks: [1] });
  assert.ok(a.id && b.id && a.id !== b.id);
});

test('normalizeCourse: 保留已有 id', () => {
  const c = CF.normalizeCourse({ id: 'my-id', name: 'x', weeks: [1] });
  assert.equal(c.id, 'my-id');
});

test('normalizeSettings: 非法字段回落默认值', () => {
  const s = CF.normalizeSettings({ totalWeeks: 999, sectionsPerDay: -1, semesterStart: 'bad-date' });
  assert.equal(s.totalWeeks, 20);
  assert.equal(s.sectionsPerDay, 12);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(s.semesterStart)); // 兜底为本周一
});

test('normalizeSettings: 合法值被保留', () => {
  const s = CF.normalizeSettings({ totalWeeks: 18, sectionsPerDay: 10, semesterStart: '2026-09-14' });
  assert.equal(s.totalWeeks, 18);
  assert.equal(s.sectionsPerDay, 10);
  assert.equal(s.semesterStart, '2026-09-14');
});

test('normalizeSettings: 非法 sectionTimes 保留默认表', () => {
  const s = CF.normalizeSettings({ sectionTimes: 'not-array' });
  assert.equal(s.sectionTimes.length, 12);
});

// ---------- 作息时间 ----------

test('sectionRangeText: 1-2 节跨节次取时间范围', () => {
  const text = CF.sectionRangeText(null, { startSection: 1, endSection: 2 });
  assert.equal(text, '08:00 ~ 09:40');
});

test('getCurrentSection: 课前/课中/课后', () => {
  const s = CF.normalizeSettings({});
  assert.equal(CF.getCurrentSection(new Date(2026, 8, 14, 7, 30), s), 0);
  assert.equal(CF.getCurrentSection(new Date(2026, 8, 14, 8, 30), s), 1);
  assert.equal(CF.getCurrentSection(new Date(2026, 8, 14, 9, 50), s), 0); // 课间
});

test('courseStatus: before/now/done', () => {
  const s = CF.normalizeSettings({});
  const c = { startSection: 1, endSection: 2 };
  assert.equal(CF.courseStatus(c, new Date(2026, 8, 14, 7, 0), s), 'before');
  assert.equal(CF.courseStatus(c, new Date(2026, 8, 14, 9, 0), s), 'now');
  assert.equal(CF.courseStatus(c, new Date(2026, 8, 14, 10, 0), s), 'done');
});

// ---------- 周次文本 ----------

test('weeksText: 连续区间压缩', () => {
  assert.equal(CF.weeksText([1, 2, 3, 7]), '1-3,7 周');
});

test('weeksText: 单周序列标注', () => {
  assert.equal(CF.weeksText([1, 3, 5, 7, 9, 11, 13, 15]), '1-15 周（单周）');
});

test('weeksText: 双周序列标注', () => {
  assert.equal(CF.weeksText([2, 4, 6, 8, 10, 12, 14, 16]), '2-16 周（双周）');
});

test('weeksText: 空数组返回占位', () => {
  assert.equal(CF.weeksText([]), '—');
});

// ---------- 示例数据 ----------

test('buildSampleCourses: 5 门示例课全部通过校验且无冲突', () => {
  const settings = CF.normalizeSettings({ semesterStart: '2026-09-14' });
  const courses = CF.buildSampleCourses().map(c => CF.normalizeCourse(c));
  assert.equal(courses.length, 5);
  for (const c of courses) {
    assert.deepEqual(CF.validateCourse(c, settings, courses), [], `示例课 ${c.name} 校验失败`);
  }
  for (let w = 1; w <= 20; w++) {
    assert.deepEqual(CF.detectConflicts(courses, w), [], `第 ${w} 周不应有冲突`);
  }
});
