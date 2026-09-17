/**
 * 提醒引擎测试（web/js/remind.js）
 *
 * 重点全在「边界」上：跨天、跨周、放假、调休、页面休眠造成的迟到。
 * 这些场景手动点是点不出来的 —— 谁也不会为了验证一条提醒去等一节课，
 * 所以时间相关的判定必须是纯函数 + 可注入的时刻。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CF = require('../web/js/core.js');
const RM = require('../web/js/remind.js');

/** 2026-09-14 是周一；用它当学期开始日，周次换算全部可预期 */
const TERM_START = '2026-09-14';

function settings(patch) {
  return Object.assign({
    semesterStart: TERM_START,
    totalWeeks: 20,
    sectionsPerDay: 12,
    showWeekend: true,
    // 用自定义作息把时间钉死，避免测试依赖默认预设的具体分钟数
    sectionTimes: [
      { label: '1', start: '08:00', end: '08:45' },
      { label: '2', start: '08:55', end: '09:40' },
      { label: '3', start: '10:00', end: '10:45' },
      { label: '4', start: '10:55', end: '11:40' }
    ],
    days: {},
    remind: { enabled: true, lead: 10 }
  }, patch || {});
}

/** 造一门在第 1-20 周全上的课 */
function course(patch) {
  const weeks = [];
  for (let w = 1; w <= 20; w++) weeks.push(w);
  return Object.assign({
    id: 'c1', name: '高等数学', teacher: '王老师', location: 'D楼202',
    day: 1, startSection: 1, endSection: 2, weeks, color: 'blue', note: ''
  }, patch || {});
}

/** 本地时刻 → Date（2026-09-14 周一） */
function at(day, hh, mm) {
  return new Date(2026, 8, day, hh, mm, 0, 0);
}

// ==================== 调休 / 放假日 ====================

test('调休标记：只认 off / makeup，其余值一律忽略', () => {
  const s = settings({ days: { '2026-09-15': 'off', '2026-09-19': 'makeup', '2026-09-16': 'whatever' } });
  assert.equal(RM.dayMark(s, '2026-09-15'), 'off');
  assert.equal(RM.dayMark(s, '2026-09-19'), 'makeup');
  assert.equal(RM.dayMark(s, '2026-09-16'), '');
  assert.equal(RM.dayMark(s, '2026-09-17'), '');
});

test('toggleDayMark：同标记再点一次等于取消，且不修改原对象', () => {
  const s = settings({ days: {} });
  const a = RM.toggleDayMark(s, '2026-09-15', 'off');
  assert.equal(a['2026-09-15'], 'off');
  assert.deepEqual(s.days, {}, '原对象不该被改（渲染层可能还在用它）');

  const b = RM.toggleDayMark({ days: a }, '2026-09-15', 'off');
  assert.equal(b['2026-09-15'], undefined, '再点一次应取消');

  const c = RM.toggleDayMark({ days: a }, '2026-09-15', 'makeup');
  assert.equal(c['2026-09-15'], 'makeup', '换标记应覆盖');
});

test('pruneDayMarks：学期外的标记被清掉，学期内的保留', () => {
  const s = settings({
    days: { '2026-01-01': 'off', '2026-09-15': 'off', '2027-06-01': 'makeup' }
  });
  const out = RM.pruneDayMarks(s);
  assert.deepEqual(Object.keys(out), ['2026-09-15']);
});

// ==================== 今日时间线 ====================

test('dayTimeline：按作息把节次换算成具体时刻，并给出 current / next', () => {
  const courses = [course({})];
  const tl = RM.dayTimeline(courses, settings(), at(14, 9, 30));
  assert.equal(tl.date, '2026-09-14');
  assert.equal(tl.weekday, 1);
  assert.equal(tl.off, false);
  assert.equal(tl.items.length, 1);
  assert.equal(tl.items[0].start.getHours(), 8);
  assert.equal(tl.items[0].start.getMinutes(), 0);
  assert.equal(tl.items[0].end.getHours(), 9);
  assert.equal(tl.items[0].end.getMinutes(), 40);

  // 09:30 在 08:00~09:40 之内 → current，没有下一节
  assert.ok(tl.current, '09:30 应处于上课中');
  assert.equal(tl.current.course.name, '高等数学');
  assert.equal(tl.next, null);
});

test('dayTimeline：放假日即使有课也返回空课表（不猜、不提醒）', () => {
  const courses = [course({})];
  const s = settings({ days: { '2026-09-14': 'off' } });
  const tl = RM.dayTimeline(courses, s, at(14, 8, 30));
  assert.equal(tl.off, true);
  assert.equal(tl.items.length, 0);
  assert.equal(tl.current, null);
  assert.equal(tl.next, null);
});

test('dayTimeline：调休补课日按当天星期几正常排课', () => {
  // 2026-09-19 是周六；正常情况下周六没课（这门课在周一）
  const sat = course({ id: 'c2', name: '补课', day: 6 });
  const s = settings({ days: { '2026-09-19': 'makeup' } });
  const tl = RM.dayTimeline([sat], s, at(19, 7, 30));
  assert.equal(tl.weekday, 6);
  assert.equal(tl.items.length, 1, '调休日应照常按周六排课');
});

test('dayTimeline：作息缺失（时间为空）的课程不参与时间线，也不报错', () => {
  const broken = course({ startSection: 9, endSection: 10 }); // 自定义作息里没有第 9 节
  const tl = RM.dayTimeline([broken], settings(), at(14, 7, 0));
  assert.equal(tl.items.length, 0);
});

test('dayTimeline：周次不匹配的课不出现（第 3 周的课在第 1 周不排）', () => {
  const c = course({ weeks: [3] });
  const tl = RM.dayTimeline([c], settings(), at(14, 7, 0));
  assert.equal(tl.items.length, 0);
});

// ==================== 提醒判定 ====================

test('pendingAlerts：提前 10 分钟时，在 07:55 触发课前提醒', () => {
  const a = RM.pendingAlerts([course({})], settings(), at(14, 7, 55), {});
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'before');
  assert.equal(a[0].minutesLeft, 5);
  assert.match(a[0].title, /5 分钟后上课/);
  assert.match(a[0].title, /高等数学/);
  assert.match(a[0].body, /08:00 ~ 09:40/);
  assert.match(a[0].body, /D楼202/);
});

test('pendingAlerts：还没进提醒窗口时不打扰（07:30 距离 08:00 还有 30 分钟）', () => {
  const a = RM.pendingAlerts([course({})], settings(), at(14, 7, 30), {});
  assert.deepEqual(a, []);
});

test('pendingAlerts：已弹过的 key 不再重复弹', () => {
  const s = settings();
  const first = RM.pendingAlerts([course({})], s, at(14, 7, 55), {});
  assert.equal(first.length, 1);
  const fired = {};
  fired[first[0].key] = 1;
  const again = RM.pendingAlerts([course({})], s, at(14, 7, 56), fired);
  assert.deepEqual(again, [], '同一节课的课前提醒只该弹一次');
});

test('pendingAlerts：上课时刻触发「现在上课」，与课前提醒是两个独立的 key', () => {
  const s = settings();
  const before = RM.pendingAlerts([course({})], s, at(14, 7, 55), {});
  const fired = {};
  fired[before[0].key] = 1;
  const nowAlert = RM.pendingAlerts([course({})], s, at(14, 8, 0), fired);
  assert.equal(nowAlert.length, 1);
  assert.equal(nowAlert[0].kind, 'at');
  assert.notEqual(nowAlert[0].key, before[0].key);
  assert.match(nowAlert[0].title, /现在上课/);
});

test('pendingAlerts：迟到容忍 —— 上课后 3 分钟内仍补弹，超过 5 分钟就不再补', () => {
  const s = settings();
  const late = RM.pendingAlerts([course({})], s, at(14, 8, 3), {});
  assert.equal(late.length, 1, '页面刚打开/刚从休眠恢复时，8:03 应该还能收到 8:00 的提醒');
  assert.equal(late[0].kind, 'at');

  const tooLate = RM.pendingAlerts([course({})], s, at(14, 8, 6), {});
  assert.deepEqual(tooLate, [], '迟到 6 分钟就不该再补了，否则一开电脑满屏通知');
});

test('pendingAlerts：提醒关闭时一条都不弹', () => {
  const s = settings({ remind: { enabled: false, lead: 10 } });
  assert.deepEqual(RM.pendingAlerts([course({})], s, at(14, 7, 55), {}), []);
});

test('pendingAlerts：lead=0 时只在上课时刻弹，不产生课前提醒', () => {
  const s = settings({ remind: { enabled: true, lead: 0 } });
  assert.deepEqual(RM.pendingAlerts([course({})], s, at(14, 7, 55), {}), []);
  const at8 = RM.pendingAlerts([course({})], s, at(14, 8, 0), {});
  assert.equal(at8.length, 1);
  assert.equal(at8[0].kind, 'at');
});

test('pendingAlerts：放假日不提醒（这是调休感知的核心价值）', () => {
  const s = settings({ days: { '2026-09-14': 'off' } });
  assert.deepEqual(RM.pendingAlerts([course({})], s, at(14, 7, 55), {}), []);
});

test('pendingAlerts：同一时段多门课各自提醒，key 用课程 id 区分', () => {
  const s = settings();
  const a = course({ id: 'a', name: '课程A' });
  const b = course({ id: 'b', name: '课程B' });
  const list = RM.pendingAlerts([a, b], s, at(14, 7, 55), {});
  assert.equal(list.length, 2);
  assert.notEqual(list[0].key, list[1].key);
});

test('pendingAlerts：key 里带日期 —— 明天同一门课会重新提醒', () => {
  const s = settings();
  const mon = RM.pendingAlerts([course({})], s, at(14, 7, 55), {});
  const nextMon = RM.pendingAlerts([course({})], s, at(21, 7, 55), {});
  assert.notEqual(mon[0].key, nextMon[0].key);
  assert.match(nextMon[0].key, /^2026-09-21\|/);
});

test('pendingAlerts：没有任何课程时不报错、不弹', () => {
  assert.deepEqual(RM.pendingAlerts([], settings(), at(14, 9, 0), {}), []);
  assert.deepEqual(RM.pendingAlerts(null, settings(), at(14, 9, 0), {}), []);
});

// ==================== runTick ====================

test('runTick：把提醒交给 sender，并回报新的已弹集合（跨 tick 去重）', () => {
  const s = settings();
  const sent = [];
  const first = RM.runTick({ courses: [course({})], settings: s, fired: {} }, at(14, 7, 55), (a) => sent.push(a));
  assert.equal(sent.length, 1);
  assert.equal(first.alerts.length, 1);
  assert.equal(Object.keys(first.fired).length, 1);

  // 第二次 tick：同一时刻不该再发
  const second = RM.runTick({ courses: [course({})], settings: s, fired: first.fired }, at(14, 7, 56), (a) => sent.push(a));
  assert.equal(second.alerts.length, 0);
  assert.equal(sent.length, 1, 'sender 不该被重复调用');
});

test('runTick：跨天后自动清掉昨天的已弹记录（否则 fired 会无限长大）', () => {
  const s = settings();
  const mon = RM.runTick({ courses: [course({})], settings: s, fired: {} }, at(14, 7, 55), null);
  assert.equal(Object.keys(mon.fired).length, 1);

  const tue = RM.runTick({ courses: [course({})], settings: s, fired: mon.fired }, at(15, 7, 55), null);
  assert.deepEqual(Object.keys(tue.fired), [], '周二还没到提醒窗口，且周一的记录应被清掉');

  const nextMon = RM.runTick({ courses: [course({})], settings: s, fired: mon.fired }, at(21, 7, 55), null);
  assert.equal(nextMon.alerts.length, 1, '下周一应重新提醒');
  assert.equal(Object.keys(nextMon.fired).length, 1, '并且只剩今天这条');
});

test('runTick：sender 抛异常不该把整个 tick 打断', () => {
  const s = settings();
  const boom = () => { throw new Error('通知炸了'); };
  assert.throws(
    () => RM.runTick({ courses: [course({})], settings: s, fired: {} }, at(14, 7, 55), boom),
    /通知炸了/
  );
  // 这里刻意记录当前行为：sender 的异常由调用方（app.js）负责兜住。
  // 写成断言是为了让「改了行为」时测试会红，逼着人重新想一遍。
});

// ==================== 跨天查找（托盘 / 挂件用） ====================

test('nextUpcoming：今天还有课时 daysAhead=0', () => {
  const hit = RM.nextUpcoming([course({})], settings(), at(14, 7, 0), 14);
  assert.equal(hit.daysAhead, 0);
  assert.equal(hit.item.course.name, '高等数学');
});

test('nextUpcoming：今天的课上完后，跨到下周同一天', () => {
  const hit = RM.nextUpcoming([course({})], settings(), at(14, 12, 0), 14);
  assert.equal(hit.daysAhead, 7);
  assert.equal(hit.date, '2026-09-21');
});

test('nextUpcoming：中间的放假日被跳过', () => {
  // 每天都有课，但把明天标成放假 → 应该落到后天
  const daily = [
    course({ id: 'd1', day: 1 }), course({ id: 'd2', day: 2 }),
    course({ id: 'd3', day: 3 }), course({ id: 'd4', day: 4 })
  ];
  const s = settings({ days: { '2026-09-15': 'off' } });
  const hit = RM.nextUpcoming(daily, s, at(14, 12, 0), 14);
  assert.equal(hit.date, '2026-09-16', '放假日不该被当成下一节课');
});

test('nextUpcoming：14 天内完全没课返回 null', () => {
  const s = settings({ semesterStart: '2026-11-01' }); // 学期还没开始
  const hit = RM.nextUpcoming([course({})], s, at(14, 12, 0), 14);
  assert.equal(hit, null);
});

test('upcomingSummary：一行摘要里同时给出日期、时间、课名与地点', () => {
  const now = at(14, 7, 0);
  const hit = RM.nextUpcoming([course({})], settings(), now, 14);
  const text = RM.upcomingSummary(hit, settings(), now);
  assert.match(text, /今天/);
  assert.match(text, /08:00/);
  assert.match(text, /高等数学/);
  assert.match(text, /D楼202/);
});

test('upcomingSummary：没有课时给一句明确的话，而不是空字符串', () => {
  assert.equal(RM.upcomingSummary(null, settings(), at(14, 7, 0)), '接下来 14 天没有课');
});

// ==================== 设置清洗 ====================

test('remindConfig：非法提前分钟数回落到 10，缺省时功能关闭', () => {
  assert.deepEqual(RM.remindConfig({}), { enabled: false, lead: 10 });
  assert.deepEqual(RM.remindConfig({ remind: { enabled: true, lead: -5 } }), { enabled: true, lead: 10 });
  assert.deepEqual(RM.remindConfig({ remind: { enabled: true, lead: 999 } }), { enabled: true, lead: 10 });
  assert.deepEqual(RM.remindConfig({ remind: { enabled: true, lead: 15 } }), { enabled: true, lead: 15 });
  // enabled 必须是显式 true 才算开 —— 字符串 'true' 不算
  assert.equal(RM.remindConfig({ remind: { enabled: 'true' } }).enabled, false);
});

test('remindSettings：只改传入的字段，另一个保持原值', () => {
  const s = { remind: { enabled: true, lead: 15 } };
  assert.deepEqual(RM.remindSettings(s, { lead: 30 }), { enabled: true, lead: 30 });
  assert.deepEqual(RM.remindSettings(s, { enabled: false }), { enabled: false, lead: 15 });
});

test('core.normalizeSettings：清洗并保留 days / remind，脏数据被丢弃', () => {
  const s = CF.normalizeSettings({
    semesterStart: TERM_START,
    days: { '2026-09-15': 'off', '2026-09-16': 'bogus', 'not-a-date': 'off' },
    remind: { enabled: true, lead: 20 }
  });
  assert.deepEqual(s.days, { '2026-09-15': 'off' });
  assert.deepEqual(s.remind, { enabled: true, lead: 20 });

  const empty = CF.normalizeSettings({ semesterStart: TERM_START });
  assert.deepEqual(empty.days, {});
  assert.deepEqual(empty.remind, { enabled: false, lead: 10 });

  // 数组不是合法的 days（会被当成对象展开成 {0:...}）→ 丢弃
  const arr = CF.normalizeSettings({ semesterStart: TERM_START, days: ['off'] });
  assert.deepEqual(arr.days, {});
});
