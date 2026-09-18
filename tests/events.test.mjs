/**
 * 考试与自定义事件的数据层测试（core.js 的 events 部分）
 *
 * 事件是「用户手填的自由文本 + 日期」，坏输入比课程更常见（名字空着、日期选错月份）。
 * 清洗必须把坏项**丢掉**而不是报错 —— 添加入口在设置抽屉里，弹窗报错会打断用户。
 * 倒计时纯函数则重点测跨月 / 跨年 / 今天 / 明天这几条边界：
 * 「还有 0 天」和「今天」是两种完全不同的语气，写错会显得很没人味。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import CF from '../web/js/core.js';

const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);

// ==================== normalizeEvent：清洗 ====================

test('normalizeEvent：合法数据原样保留，id 缺失时补发', () => {
  const ev = CF.normalizeEvent({ name: '高数期末', date: '2026-09-30', time: '09:00', kind: 'exam' });
  assert.equal(ev.name, '高数期末');
  assert.equal(ev.date, '2026-09-30');
  assert.equal(ev.time, '09:00');
  assert.equal(ev.kind, 'exam');
  assert.ok(ev.id, 'id 必须补上');
});

test('normalizeEvent：名字为空 / 日期非法 → 返回 null（由调用方丢弃）', () => {
  assert.equal(CF.normalizeEvent({ name: '  ', date: '2026-09-30' }), null);
  assert.equal(CF.normalizeEvent({ name: '没日期', date: 'abc' }), null);
  assert.equal(CF.normalizeEvent({ name: '没日期', date: '' }), null);
  assert.equal(CF.normalizeEvent(null), null);
  assert.equal(CF.normalizeEvent('字符串'), null);
});

test('normalizeEvent：松散日期写法被归一（2026-9-3 → 2026-09-03）', () => {
  const ev = CF.normalizeEvent({ name: 'x', date: '2026-9-3' });
  assert.equal(ev.date, '2026-09-03');
});

test('normalizeEvent：时间格式不合法就清空，而不是原样带出去', () => {
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', time: '9点' }).time, '');
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', time: '25:00' }).time, '');
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', time: '09:60' }).time, '');
  // 合法时间零填充成 HH:MM：零填充后字符串比较与数值同序，按时间排序才不会错
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', time: '9:30' }).time, '09:30');
});

test('normalizeEvent：kind 只认 exam，别的都归 custom（写错不丢数据）', () => {
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', kind: 'exam' }).kind, 'exam');
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30', kind: 'EXAM' }).kind, 'custom');
  assert.equal(CF.normalizeEvent({ name: 'x', date: '2026-09-30' }).kind, 'custom');
});

test('normalizeEvent：名字 / 备注超长截断（上限常量与界面输入框一致）', () => {
  const name40 = '一'.repeat(40);          // 超过名字上限（24），没超备注上限（60）
  const note80 = '一'.repeat(80);          // 超过备注上限
  const ev = CF.normalizeEvent({ name: name40, date: '2026-09-30', note: note80 });
  assert.equal(ev.name.length, CF.EVENT_NAME_MAX);
  assert.equal(ev.note.length, CF.EVENT_NOTE_MAX);
});

test('normalizeEvents：非法项丢弃 + 重复 id 重新发号 + 非数组返回空', () => {
  const out = CF.normalizeEvents([
    { id: 'a', name: '好的', date: '2026-09-30' },
    { name: '', date: '2026-09-30' },
    { id: 'a', name: '重复id', date: '2026-10-01' },
    '垃圾'
  ]);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id, '重复 id 必须重新发号，否则删除会误删');
  assert.deepEqual(CF.normalizeEvents('垃圾'), []);
  assert.deepEqual(CF.normalizeEvents(null), []);
});

// ==================== normalizeSemester：事件挂学期 ====================

test('normalizeSemester：events 缺省为空数组（旧数据免迁移），合法数据保留', () => {
  const old = CF.normalizeSemester({ name: '旧学期', settings: {}, courses: [] });
  assert.deepEqual(old.events, [], '旧数据没有 events 字段，不能是 undefined');

  const neu = CF.normalizeSemester({
    name: '新学期', settings: {}, courses: [],
    events: [{ name: '高数期末', date: '2026-09-30', kind: 'exam' }]
  });
  assert.equal(neu.events.length, 1);
  assert.equal(neu.events[0].name, '高数期末');
});

// ==================== daysUntil / countdownTextOf ====================

test('daysUntil：同一天 0、明天 1，跨月与跨年都按自然日算', () => {
  const now = at(2026, 9, 18, 23, 59);   // 深夜 23:59 —— 时刻不影响自然日差
  assert.equal(CF.daysUntil('2026-09-18', now), 0);
  assert.equal(CF.daysUntil('2026-09-19', now), 1);
  assert.equal(CF.daysUntil('2026-10-01', now), 13);   // 跨月
  assert.equal(CF.daysUntil('2027-01-01', now), 105);  // 跨年
  assert.equal(CF.daysUntil('2026-09-17', now), -1);   // 昨天
  assert.equal(CF.daysUntil('垃圾', now), null);
});

test('countdownTextOf：今天 / 明天 / N 天，绝不说「还有 0 天」', () => {
  assert.equal(CF.countdownTextOf(0), '今天');
  assert.equal(CF.countdownTextOf(1), '明天');
  assert.equal(CF.countdownTextOf(12), '还有 12 天');
  assert.ok(!/还有 0 天|还有 1 天/.test(CF.countdownTextOf(0) + CF.countdownTextOf(1)));
});

// ==================== upcomingEvents ====================

test('upcomingEvents：过滤过去、升序、limit 截断', () => {
  const now = at(2026, 9, 18, 15, 0);
  const list = [
    { name: '上周的', date: '2026-09-10' },
    { name: '远的', date: '2026-12-01' },
    { name: '近的', date: '2026-09-20' },
    { name: '今天的', date: '2026-09-18' }
  ];
  const up = CF.upcomingEvents(list, now, 2);
  assert.equal(up.length, 2);
  assert.equal(up[0].name, '今天的', '今天的最先');
  assert.equal(up[1].name, '近的');
  assert.equal(up[0].daysLeft, 0);
});

test('upcomingEvents：同一天按时间先后排（没填时间的排最后）', () => {
  const now = at(2026, 9, 18, 15, 0);
  const up = CF.upcomingEvents([
    { name: '晚上', date: '2026-09-19', time: '19:00' },
    { name: '早上', date: '2026-09-19', time: '08:00' },
    { name: '没填时间', date: '2026-09-19' }
  ], now, 10);
  assert.deepEqual(up.map(function (x) { return x.name; }), ['早上', '晚上', '没填时间']);
});

test('upcomingEvents：countdownText 随条目给出（挂件 / 托盘只管用，不再各算一份）', () => {
  const up = CF.upcomingEvents([{ name: '考试', date: '2026-09-19', kind: 'exam' }], at(2026, 9, 18), 1);
  assert.equal(up[0].countdownText, '明天');
});

test('upcomingEvents：空 / 全坏 / 全过去 → 空数组（不是 null，调用方不用判空）', () => {
  const now = at(2026, 9, 18);
  assert.deepEqual(CF.upcomingEvents([], now, 3), []);
  assert.deepEqual(CF.upcomingEvents([{ name: '', date: 'x' }], now, 3), []);
  assert.deepEqual(CF.upcomingEvents([{ name: '去年的', date: '2025-01-01' }], now, 3), []);
  assert.deepEqual(CF.upcomingEvents(null, now, 3), []);
});
