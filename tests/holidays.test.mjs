/**
 * 法定节假日同步测试（web/js/holidays.js + remind/core 的自动标记回落）
 *
 * holidays.js 是纯函数层：URL 构建 / 响应解析 / 合并策略全部不碰网络，
 * 用真实抓回来的 JSON 结构做夹具（不 mock 一份想当然的字段名）。
 * 判定回落（手动优先 → 自动）在 remind.dayMark 上验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HD = require('../web/js/holidays.js');
const CF = require('../web/js/core.js');
const RM = require('../web/js/remind.js');

/** 与 NateScarlet/holiday-cn@master/2026.json 实际结构一致的夹具（节选） */
const SAMPLE_2026 = {
  $schema: 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/schema.json',
  year: 2026,
  papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '春节', date: '2026-02-15', isOffDay: false }, // 调休补班日
    { name: '春节', date: '2026-02-17', isOffDay: true }
  ]
};

test('sourceUrls：候选源按优先级排序，逐年份参数化', () => {
  const urls = HD.sourceUrls(2026);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /^https:\/\/cdn\.jsdelivr\.net\/gh\/NateScarlet\/holiday-cn@master\/2026\.json$/);
  assert.match(urls[1], /^https:\/\/fastly\.jsdelivr\.net\//);
  assert.match(urls[2], /^https:\/\/raw\.githubusercontent\.com\/NateScarlet\/holiday-cn\/master\/2026\.json$/);
  assert.ok(HD.sourceUrls(2027)[0].includes('2027.json'), '年份要进 URL');
});

test('yearsFor：今天年 + 学期结束年 + 次年，去重升序', () => {
  // 秋季学期跨年：2026-09-14 开学、20 周 → 结束日落在 2027 年
  assert.deepEqual(HD.yearsFor('2026-09-20', '2027-01-31'), [2026, 2027, 2028]);
  // 春季学期不跨年：今年 + 次年即可
  assert.deepEqual(HD.yearsFor('2026-03-01', '2026-06-30'), [2026, 2027]);
  // 非法输入安静忽略
  assert.deepEqual(HD.yearsFor('', ''), []);
  assert.deepEqual(HD.yearsFor('garbage', null), []);
});

test('parseHolidayCn：对象 / 文本两收，isOffDay 映射 off/makeup', () => {
  const days = HD.parseHolidayCn(SAMPLE_2026);
  assert.equal(days['2026-01-01'], 'off');
  assert.equal(days['2026-01-02'], 'off');
  assert.equal(days['2026-02-15'], 'makeup'); // 补班日
  assert.equal(days['2026-02-17'], 'off');
  // 文本输入等价
  assert.deepEqual(HD.parseHolidayCn(JSON.stringify(SAMPLE_2026)), days);
});

test('parseHolidayCn：坏结构 / 坏条目从紧丢弃，宁空勿错', () => {
  assert.deepEqual(HD.parseHolidayCn(null), {});
  assert.deepEqual(HD.parseHolidayCn('not json'), {});
  assert.deepEqual(HD.parseHolidayCn({ year: 2026 }), {});              // 缺 days
  assert.deepEqual(HD.parseHolidayCn({ days: 'oops' }), {});            // days 非数组
  assert.deepEqual(HD.parseHolidayCn({ days: [null, 42] }), {});        // 垃圾条目
  assert.deepEqual(HD.parseHolidayCn({ days: [{ date: '2026-13-01', isOffDay: true }] }), {});   // 非法月
  assert.deepEqual(HD.parseHolidayCn({ days: [{ date: '2026-1-1', isOffDay: 'yes' }] }), {});    // isOffDay 非 boolean
  // 宽松日期归一成补零格式（数据源是规范的，但别赌它永远规范）
  assert.equal(HD.parseHolidayCn({ days: [{ date: '2026-1-1', isOffDay: true }] })['2026-01-01'], 'off');
});

test('mergeInto：next 覆盖 prev 同一天的旧自动数据，不改入参', () => {
  const prev = { '2026-01-01': 'off', '2026-02-15': 'off' };
  const next = { '2026-02-15': 'makeup' };
  const merged = HD.mergeInto(prev, next);
  assert.equal(merged['2026-01-01'], 'off');
  assert.equal(merged['2026-02-15'], 'makeup'); // 数据源更正后以新一轮为准
  assert.equal(prev['2026-02-15'], 'off');      // 不改入参
});

test('pruneToRange：只保留学期范围内的自动标记', () => {
  const days = { '2026-09-20': 'off', '2027-01-01': 'off', '2025-12-31': 'off' };
  const pruned = HD.pruneToRange(days, '2026-09-14', '2027-01-31');
  assert.deepEqual(Object.keys(pruned).sort(), ['2026-09-20', '2027-01-01']);
});

// ==================== 判定回落（remind.dayMark） ====================

test('dayMark 回落：手动优先，取消手动后回落法定同步', () => {
  const s = CF.normalizeSettings({
    semesterStart: '2026-09-14',
    totalWeeks: 20,
    days: { '2026-09-15': 'off' },                 // 手动：周二放假
    holidayDays: { '2026-09-15': 'makeup' },       // 自动：同天法定是补班（用户校历特殊，手动覆盖）
    holidaySync: { enabled: true, lastSync: '2026-09-20', source: 'cdn.jsdelivr.net' }
  });
  assert.equal(RM.dayMark(s, '2026-09-15'), 'off');    // 手动胜
  assert.equal(RM.markIsAuto(s, '2026-09-15'), true);  // 来源标识仍指自动表（UI 徽标据此判断，配合 days 判定）
  assert.equal(RM.dayMark(s, '2026-09-16'), '');       // 两边都没有

  const s2 = CF.normalizeSettings({
    semesterStart: '2026-09-14',
    totalWeeks: 20,
    days: {},
    holidayDays: { '2026-10-01': 'off' }
  });
  assert.equal(RM.dayMark(s2, '2026-10-01'), 'off');   // 无手动 → 回落自动
  assert.equal(RM.markIsAuto(s2, '2026-10-01'), true);
});

test('放假日自动生效：提醒为空、时间线 off（与手动标记同一通路）', () => {
  const s = CF.normalizeSettings({
    semesterStart: '2026-09-14',
    totalWeeks: 20,
    sectionTimes: [
      { label: '1', start: '08:00', end: '08:45' },
      { label: '2', start: '08:55', end: '09:40' }
    ],
    days: {},
    holidayDays: { '2026-09-14': 'off' },
    remind: { enabled: true, lead: 10 }
  });
  const courses = [{ id: 'c1', name: '高数', teacher: '', location: '', day: 1, startSection: 1, endSection: 2, weeks: [1], color: 'blue', note: '' }];
  const now = new Date(2026, 8, 14, 7, 50, 0);
  assert.equal(RM.isDayOff(s, now), true);
  assert.deepEqual(RM.pendingAlerts(courses, s, now, {}), []);
  assert.equal(RM.dayTimeline(courses, s, now).off, true);
});

test('normalizeSettings：holidayDays / holidaySync 白名单清洗 + 默认开', () => {
  const s = CF.normalizeSettings({
    semesterStart: '2026-09-14',
    holidayDays: { '2026-10-01': 'off', 'bad-key': 'off', '2026-10-02': 'destroy' },
    holidaySync: { enabled: false, lastSync: '2026-9-20', source: 'x'.repeat(200) }
  });
  assert.deepEqual(s.holidayDays, { '2026-10-01': 'off' }); // 坏键坏值丢弃
  assert.equal(s.holidaySync.enabled, false);
  assert.equal(s.holidaySync.lastSync, '2026-09-20');        // 宽松日期归一
  assert.equal(s.holidaySync.source.length, 120);            // source 截断防注入
  // 完全没传时默认开、无状态
  const s2 = CF.normalizeSettings({ semesterStart: '2026-09-14' });
  assert.equal(s2.holidaySync.enabled, true);
  assert.deepEqual(s2.holidayDays, {});
});
