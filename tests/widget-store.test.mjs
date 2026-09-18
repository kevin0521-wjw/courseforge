/**
 * 桌面常驻小组件的数据中枢测试（desktop/widget-store.js）
 *
 * 这个模块是「托盘提示 / 托盘菜单 / 小组件窗口」三处文案的唯一来源，
 * 所以它错一次会同时错三处。测试重点放在**状态边界**上：
 * 没课表、空课表、未开学、学期结束、放假、作息缺失、正在上课、跨天、跨周。
 *
 * 这些状态在现实里每天都会遇到，但都会表现为「界面上没有下一节课」——
 * 分不清它们，用户就不知道自己该做的是「导入课表」还是「等到开学」还是「改作息」。
 * 所以 phase 必须逐个断言，不能只断言「有内容」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WS from '../desktop/widget-store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 学期起点：2026-09-14 是周一，于是第 N 周的周三 = 2026-09-14 + (N-1)*7 + 2 天 */
const TERM = '2026-09-14';
/** 周三 / 周四 / 周六 的星期序号 */
const WED = 3, THU = 4, SAT = 6;

const at = (y, m, d, hh, mm, ss) => new Date(y, m - 1, d, hh, mm, ss || 0, 0);

/** 造一个学期；courses 直接给最小字段，normalizeCourse 会补齐其余 */
function term(courses, settings) {
  return {
    activeId: 's1',
    semesters: [{
      id: 's1',
      name: '2026 秋季学期',
      settings: Object.assign({ semesterStart: TERM, totalWeeks: 20, days: {} }, settings || {}),
      courses: courses
    }]
  };
}

const math = {
  id: 'c1', name: '高等数学', day: WED, startSection: 5, endSection: 6,
  weeks: [1, 2, 3, 4], location: '东区一教 305', teacher: '张三'
};
const alg = {
  id: 'c2', name: '数据结构与算法分析', day: WED, startSection: 7, endSection: 8,
  weeks: [1, 2, 3, 4], location: '计算机楼 201'
};
const eng = {
  id: 'c3', name: '大学英语', day: THU, startSection: 1, endSection: 2,
  weeks: [1, 2, 3, 4], location: '文荟楼 108'
};

function newStore(courses, settings) {
  const s = WS.createWidgetStore();   // 不传 webJsDir：顺带验证默认路径能解析到 web/js
  s.setWorkspace(term(courses, settings));
  return s;
}

// ==================== 空数据与非法输入 ====================

test('无快照时 phase=nodata，文案指向「去导入」而不是「没课」', () => {
  const s = WS.createWidgetStore();
  const v = s.buildView(at(2026, 9, 16, 10, 0));
  assert.equal(v.hasData, false);
  assert.equal(v.phase, 'nodata');
  assert.match(v.statusLine, /还没有课表/);
  assert.equal(v.next, null);
  assert.equal(v.current, null);
});

test('空课表（有学期但零门课）与「无课表」是两回事', () => {
  const s = newStore([]);
  const v = s.buildView(at(2026, 9, 16, 10, 0));
  assert.equal(v.hasData, true);
  assert.equal(v.courseCount, 0);
  // 有学期数据、只是没课 —— 说「还没有课表」会让人以为数据丢了
  assert.equal(v.phase, 'none');
  assert.match(v.statusLine, /接下来 14 天没有课/);
});

test('setWorkspace 对垃圾输入返回 false 且不抛（IPC 另一端不该把托盘搞挂）', () => {
  const s = WS.createWidgetStore();
  for (const bad of [null, undefined, 123, 'x', [], {}, { semesters: 'no' }]) {
    assert.equal(s.setWorkspace(bad), false, JSON.stringify(bad) + ' 应被拒');
  }
  assert.equal(s.hasWorkspace(), false);
  // 拒绝之后仍然能正常出视图，不能留下半截状态
  assert.equal(s.buildView(new Date()).phase, 'nodata');
});

test('clear() 之后回到 nodata', () => {
  const s = newStore([math]);
  assert.equal(s.hasWorkspace(), true);
  s.clear();
  assert.equal(s.buildView(at(2026, 9, 16, 10, 0)).phase, 'nodata');
});

// ==================== 正在上课 ====================

test('正在上课：phase=current，剩余/已过分钟与进度都算得出来', () => {
  const s = newStore([math, alg]);
  // 周三 12:30：第 5-6 节 12:00 ~ 14:35，已上 30 分钟、共 155 分钟
  const v = s.buildView(at(2026, 9, 16, 12, 30));
  assert.equal(v.phase, 'current');
  assert.equal(v.current.name, '高等数学');
  assert.equal(v.current.state, 'now');
  assert.equal(v.current.startsInMin, -30, '已开始 30 分钟应表现为负数');
  assert.equal(v.current.endsInMin, 125);
  assert.equal(v.current.totalMin, 155);
  assert.equal(v.current.percent, 19, '30/155 ≈ 19%');
  assert.equal(v.current.rangeText, '12:00 ~ 14:35');
  assert.equal(v.current.sectionText, '第 5-6 节');
  assert.match(v.statusLine, /正在上 高等数学 · 还有 125 分钟/);
});

test('item 必须带精确的上/下课时刻（渲染层的秒级倒计时靠它）', () => {
  const s = newStore([math]);
  // 11:00:15 距 12:00 是 59 分 45 秒
  const now = at(2026, 9, 16, 11, 0, 15);
  const v = s.buildView(now);
  // 展示字段会四舍五入到整分钟 —— 这正是不能拿它反推时刻的原因
  assert.equal(v.next.startsInMin, 60);
  assert.equal(v.next.startAt, at(2026, 9, 16, 12, 0).getTime());
  assert.equal(v.next.startAt - now.getTime(), 59 * 60000 + 45000,
    '精确到毫秒：差 45 秒会在最后十分钟的秒级倒计时上直接看出来');

  const cur = newStore([math]).buildView(at(2026, 9, 16, 12, 30));
  assert.equal(cur.current.startAt, at(2026, 9, 16, 12, 0).getTime());
  assert.equal(cur.current.endAt, at(2026, 9, 16, 14, 35).getTime());
});

test('正在上课时 next 指向再下一节', () => {
  const s = newStore([math, alg]);
  const v = s.buildView(at(2026, 9, 16, 12, 30));
  assert.equal(v.next.name, '数据结构与算法分析');
  assert.equal(v.next.startsInMin, 135);   // 12:30 → 14:45
  assert.equal(v.next.dayLabel, '今天');
});

test('当前节次结束的那一刻就翻到下一节（边界不含糊）', () => {
  const s = newStore([math, alg]);
  // 14:35 是第 6 节下课时刻：dayTimeline 用 [start, end) 判定，此刻应已不算「正在上」
  const v = s.buildView(at(2026, 9, 16, 14, 35));
  assert.equal(v.phase, 'next');
  assert.equal(v.next.name, '数据结构与算法分析');
  assert.equal(v.next.startsInMin, 10);
});

// ==================== 即将上课与倒计时 ====================

test('同日即将上课：startsInMin 有值，跨天则为 null', () => {
  const s = newStore([math, eng]);
  const today = s.buildView(at(2026, 9, 16, 11, 0));
  assert.equal(today.phase, 'next');
  assert.equal(today.next.name, '高等数学');
  assert.equal(today.next.startsInMin, 60);
  assert.match(today.statusLine, /60 分钟后上课：高等数学 · 东区一教 305/);

  // 周四 07:00 → 08:00 的课是今天；再往后看（周三的课）就是跨天
  const nextWeek = newStore([math]).buildView(at(2026, 9, 16, 15, 0));
  assert.equal(nextWeek.next.daysAhead, 7);
  // 「还有 10080 分钟」没人愿意心算，跨天一律给 null 由界面说「下周三 12:00」
  assert.equal(nextWeek.next.startsInMin, null);
});

test('倒计时归零的那一刻不说「0 分钟后上课」', () => {
  const s = newStore([math]);
  // 正好 12:00 开课：此刻 dayTimeline 已把它算作 current，不再是 next
  const v = s.buildView(at(2026, 9, 16, 12, 0));
  assert.equal(v.phase, 'current');
  assert.equal(v.statusLine.startsWith('正在上'), true);
});

test('今天课都上完了 → 下一次课跨天，今日剩余归零', () => {
  const s = newStore([math, alg]);
  const v = s.buildView(at(2026, 9, 16, 17, 0));
  assert.equal(v.todayRemaining, 0);
  assert.equal(v.todayCount, 2);
  assert.equal(v.next.daysAhead, 7);
  assert.equal(v.next.dayLabel, '下周三');
});

// ==================== 跨天称呼（本周X / 下周X / 明天） ====================

test('跨天称呼：明天 / 本周X / 下周X 三者分得清', () => {
  // 只有周三一门课，于是「下一个周三」在不同日子有不同的说法
  const s = newStore([math]);

  // 周二 20:00 → 周三就在明天
  assert.equal(s.buildView(at(2026, 9, 15, 20, 0)).next.dayLabel, '明天');

  // 周一 20:00 → 本周三（还没跨过周一，不能说「下周三」）
  assert.equal(s.buildView(at(2026, 9, 14, 20, 0)).next.dayLabel, '本周三');

  // 周五 20:00 → 下周三。说「周三」会被理解成本周那个已经过去的周三
  const fri = s.buildView(at(2026, 9, 18, 20, 0));
  assert.equal(fri.next.dayLabel, '下周三');
  assert.match(fri.statusLine, /下周三 12:00 高等数学/);
});

test('跨天称呼不出现「下周周三」这种重复「周」的拼接', () => {
  // 坑：DAY_NAMES 里已经是「周三」，前缀再写「下周」就成了「下周周三」。
  // （分享图那轮在「1-16 周周」上踩过一次同类问题，这里用断言钉住）
  const s = newStore([math]);
  for (const d of [[9, 14], [9, 15], [9, 17], [9, 18], [9, 19]]) {
    const v = s.buildView(at(2026, d[0], d[1], 20, 0));
    if (v.next && v.next.daysAhead > 1) {
      assert.ok(!/周周/.test(v.next.dayLabel), '不该出现重复的「周」：' + v.next.dayLabel);
      assert.ok(!/^下周/.test(v.next.dayLabel) || /^下周[一二三四五六日]$/.test(v.next.dayLabel),
        '跨周称呼应形如「下周三」：' + v.next.dayLabel);
    }
  }
});

// ==================== 学期边界 ====================

test('未开学：phase=beforeterm 并给出距开学天数', () => {
  const s = newStore([math]);
  const v = s.buildView(at(2026, 9, 1, 10, 0));   // 距 9-14 还有 13 天
  assert.equal(v.phase, 'beforeterm');
  assert.equal(v.weekLabel, '未开学');
  assert.equal(v.daysToStart, 13);
  assert.equal(v.statusLine, '距开学还有 13 天');
  assert.equal(v.termStart, TERM);
  assert.equal(v.termStartLabel, '9 月 14 日');
});

test('开学当天：daysToStart 归零且不再是 beforeterm（不能显示「距开学还有 0 天」）', () => {
  const s = newStore([math]);
  const v = s.buildView(at(2026, 9, 14, 7, 0));   // 周一开学日 07:00
  assert.notEqual(v.phase, 'beforeterm');
  assert.equal(v.week, 1);
  assert.equal(v.weekLabel, '第 1 周');
  assert.ok(!/距开学/.test(v.statusLine), '开学当天不该再说距开学：' + v.statusLine);
});

test('学期结束后：phase=afterterm，而不是含糊的「14 天没有课」', () => {
  const s = newStore([math]);
  const v = s.buildView(at(2027, 2, 10, 10, 0));
  assert.equal(v.weekLabel, '学期已结束');
  assert.equal(v.phase, 'afterterm');
  assert.equal(v.statusLine, '学期已结束');
});

test('周次文案：第 0 周 / 第 25 周都不该原样露出来', () => {
  assert.equal(WS.weekLabelOf(0, 20), '未开学');
  assert.equal(WS.weekLabelOf(-3, 20), '未开学');
  assert.equal(WS.weekLabelOf(21, 20), '学期已结束');
  assert.equal(WS.weekLabelOf(20, 20), '第 20 周');
  assert.equal(WS.weekLabelOf(1, 20), '第 1 周');
});

// ==================== 放假与调休 ====================

test('放假当天：phase=off，但下一节课要指出来', () => {
  const s = newStore([math, eng], { days: { '2026-09-16': 'off' } });
  const v = s.buildView(at(2026, 9, 16, 11, 0));
  assert.equal(v.off, true);
  assert.equal(v.phase, 'off');
  assert.equal(v.todayCount, 0);
  // 放假时用户最想知道的就是「下一次什么时候上」
  assert.equal(v.next.name, '大学英语');
  assert.equal(v.next.dayLabel, '明天');
  assert.equal(v.statusLine, '今天放假 · 下次课 明天 08:00');
});

test('调休补课不会把当天的课吞掉（markup 只表示「照常」）', () => {
  const sat = { id: 'c9', name: '补课测试', day: SAT, startSection: 1, endSection: 2, weeks: [1, 2, 3, 4] };
  const s = newStore([sat], { days: { '2026-09-19': 'makeup' } });   // 9-19 是周六
  const v = s.buildView(at(2026, 9, 19, 7, 0));
  assert.equal(v.off, false);
  assert.equal(v.next.name, '补课测试');
  assert.equal(v.next.daysAhead, 0);
});

// ==================== 单双周 ====================

test('单双周：单周才有课时，双周应跳到下一个单周', () => {
  const odd = { id: 'c5', name: '单周课', day: WED, startSection: 5, endSection: 6, weeks: [1, 3] };
  const s = newStore([odd]);
  // 09-16 是第 1 周（有课）
  assert.equal(s.buildView(at(2026, 9, 16, 11, 0)).next.daysAhead, 0);
  // 09-23 是第 2 周（无课）→ 下一次应在第 3 周的 09-30，相隔 7 天
  const v = s.buildView(at(2026, 9, 23, 11, 0));
  assert.equal(v.todayCount, 0);
  assert.equal(v.next.daysAhead, 7);
  assert.equal(v.week, 2);
});

// ==================== 作息缺失 ====================

test('有课但作息算不出时间 → phase=missing（和「今天没课」必须分开）', () => {
  const s = newStore([math], {
    sectionTimes: [{ label: '1', start: '', end: '' }]
  });
  const v = s.buildView(at(2026, 9, 16, 7, 0));
  assert.equal(v.phase, 'missing');
  assert.equal(v.todayCount, 0);
  assert.match(v.statusLine, /作息时间缺失/);
});

test('今天本来就没课时，不能误报成作息缺失', () => {
  const s = newStore([eng]);   // 只有周四有课
  const v = s.buildView(at(2026, 9, 16, 7, 0));   // 周三
  assert.equal(v.weekday, WED);
  assert.equal(v.phase, 'next');   // 下周四的课
  assert.ok(!/作息/.test(v.statusLine));
});

// ==================== tooltip ====================

test('tooltip 两行且长度受限（Windows 托盘提示过长会被截断在半路）', () => {
  const s = newStore([math]);
  const tip = s.tooltip(at(2026, 9, 16, 11, 0));
  assert.ok(tip.indexOf('\n') > 0, '应是两行：' + JSON.stringify(tip));
  assert.match(tip, /^课表工坊 · 第 1 周 周三 2026-09-16\n/);
  assert.ok(tip.length <= 120, '长度 ' + tip.length + ' 超过上限：' + JSON.stringify(tip));
});

test('没有课表时 tooltip 不出现「第 0 周」这类空壳信息', () => {
  const s = WS.createWidgetStore();
  const tip = s.tooltip(at(2026, 9, 16, 11, 0));
  assert.equal(tip.split('\n')[0], '课表工坊');
  assert.match(tip, /还没有课表/);
});

test('tooltip 过长时自己截断加省略号（Windows 会把它切在半路）', () => {
  const long = {
    id: 'cl',
    name: '超长课名测试'.repeat(6),
    day: WED, startSection: 5, endSection: 6, weeks: [1, 2, 3, 4],
    location: '很长很长很长的教学楼名字'.repeat(4)
  };
  const s = newStore([long]);
  const tip = s.tooltip(at(2026, 9, 16, 11, 0));
  assert.ok(tip.length <= 120, '长度 ' + tip.length + '：' + JSON.stringify(tip));
  assert.ok(tip.endsWith('…'), '截断后要有省略号，别让用户以为内容就到这：' + JSON.stringify(tip));
});

// ==================== 小工具函数 ====================

test('sectionText：单节与多节两种写法', () => {
  assert.equal(WS.sectionText({ startSection: 5, endSection: 5 }), '第 5 节');
  assert.equal(WS.sectionText({ startSection: 5, endSection: 6 }), '第 5-6 节');
  assert.equal(WS.sectionText({}), '');
});

test('dateLabel：月日都带「月/日」，个位数不加 0', () => {
  assert.equal(WS.dateLabel(new Date(2026, 8, 16)), '9 月 16 日');
  assert.equal(WS.dateLabel(new Date(2026, 0, 5)), '1 月 5 日');
});

test('同一份数据在不同时刻取视图互不干扰（buildView 无副作用）', () => {
  const s = newStore([math]);
  const a = s.buildView(at(2026, 9, 16, 11, 0));
  const b = s.buildView(at(2026, 9, 16, 13, 0));
  assert.equal(a.phase, 'next');
  assert.equal(b.phase, 'current');
  // 再取一次应与第一次完全一致，说明上一步没污染内部状态
  const a2 = s.buildView(at(2026, 9, 16, 11, 0));
  assert.deepEqual(a2, a);
});
