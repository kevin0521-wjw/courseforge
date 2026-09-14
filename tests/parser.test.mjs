/**
 * 课表文本解析引擎测试
 * 覆盖：星期/节次/周次(单双周)/地点/教师/时间映射/多天/表头跳过/上下文名称
 */
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CP = require('../web/js/parser.js');

// 上海大学官方作息（jwb.shu.edu.cn，2021-09-01 起实施）
const SHU_TIMES = [
  { label: '1', start: '08:00', end: '08:45' },
  { label: '2', start: '08:55', end: '09:40' },
  { label: '3', start: '10:00', end: '10:45' },
  { label: '4', start: '10:55', end: '11:40' },
  { label: '5', start: '13:00', end: '13:45' },
  { label: '6', start: '13:55', end: '14:40' },
  { label: '7', start: '15:00', end: '15:45' },
  { label: '8', start: '15:55', end: '16:40' },
  { label: '9', start: '18:00', end: '18:45' },
  { label: '10', start: '18:55', end: '19:40' },
  { label: '11', start: '20:00', end: '20:45' },
  { label: '12', start: '20:55', end: '21:40' }
];

const OPTS = { sectionTimes: SHU_TIMES, totalWeeks: 18 };

test('parseWeeksSpec: 基础区间', () => {
  assert.deepEqual(CP.parseWeeksSpec('1-16周'), Array.from({ length: 16 }, (_, i) => i + 1));
});

test('parseWeeksSpec: 列表+区间混合', () => {
  assert.deepEqual(CP.parseWeeksSpec('1-8,10-16周'), [
    1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16
  ]);
});

test('parseWeeksSpec: 单周过滤', () => {
  const w = CP.parseWeeksSpec('1-16(单)');
  assert.ok(w.every(x => x % 2 === 1));
  assert.equal(w.length, 8);
});

test('parseWeeksSpec: 双周过滤', () => {
  const w = CP.parseWeeksSpec('2-16双周');
  assert.ok(w.every(x => x % 2 === 0));
});

test('标准行：课程名+星期+节次+周次+地点+教师', () => {
  const r = CP.parseScheduleText('高等数学A1 周一 3-4节 第1-16周 D楼202 张三', OPTS);
  assert.equal(r.items.length, 1);
  const c = r.items[0];
  assert.equal(c.name, '高等数学A1');
  assert.equal(c.day, 1);
  assert.equal(c.startSection, 3);
  assert.equal(c.endSection, 4);
  assert.equal(c.weeks.length, 16);
  assert.equal(c.location, 'D楼202');
  assert.equal(c.teacher, '张三');
});

test('单双周括号写法', () => {
  const r = CP.parseScheduleText('数据结构 周三 5,6节 1-16周(单) BJ102 李四', OPTS);
  const c = r.items[0];
  assert.equal(c.startSection, 5);
  assert.equal(c.endSection, 6);
  assert.ok(c.weeks.every(w => w % 2 === 1));
  assert.equal(c.location, 'BJ102');
  assert.equal(c.teacher, '李四');
});

test('「星期二」写法 + 教师后缀', () => {
  const r = CP.parseScheduleText('大学英语 星期二 第3-4节 1-15周（单周） 外语楼204 王五教授', OPTS);
  const c = r.items[0];
  assert.equal(c.day, 2);
  assert.equal(c.startSection, 3);
  assert.equal(c.location, '外语楼204');
  assert.ok(c.teacher.includes('王五'));
});

test('时间→节次映射（上海大学作息）', () => {
  const r = CP.parseScheduleText('大学体育 周五 18:00-19:40 体育馆 赵六', OPTS);
  const c = r.items[0];
  assert.equal(c.startSection, 9);
  assert.equal(c.endSection, 10);
  assert.equal(c.location, '体育馆');
});

test('一行多星期 → 生成多条', () => {
  const r = CP.parseScheduleText('线性代数 周二,周四 1-2节 1-16周 教学楼B105 钱七', OPTS);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(i => i.day).sort(), [2, 4]);
  assert.ok(r.items.every(i => i.name === '线性代数'));
});

test('上下文名称：课程名一行、详情行跟随', () => {
  const text = [
    '程序设计基础',
    '1-16周 星期一 1,2节 教学楼B105 陈老师'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, '程序设计基础');
  assert.equal(r.items[0].day, 1);
  assert.equal(r.items[0].startSection, 1);
  assert.equal(r.items[0].endSection, 2);
});

test('表头行跳过不告警', () => {
  const r = CP.parseScheduleText('课程表\n星期一 星期二 星期三 星期四 星期五\n高等数学 周一 3-4节 第1-16周 D楼202 张三', OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.warnings.length, 0);
});

test('缺节次：产出条目并告警', () => {
  const r = CP.parseScheduleText('人工智能导论 周四 第1-16周 实验楼502 孙八', OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].startSection, null);
  assert.ok(r.warnings.some(w => w.includes('节次')));
});

test('缺星期：跳过并告警', () => {
  const r = CP.parseScheduleText('心理学 3-4节 1-16周 A301', OPTS);
  assert.equal(r.items.length, 0);
  assert.ok(r.warnings.some(w => w.includes('星期')));
});

test('多行混合解析（模拟 OCR 输出）', () => {
  const text = [
    '2026-2027学年第一学期课表',
    '高等数学A1 周一 1-2节 1-16周 教学楼A301 王老师',
    '大学英语 周二 3-4节 1-16周(双) 外语楼204 李老师',
    '数据结构 周三 5-6节 1-16周 实验楼502 张老师',
    '大学物理 周四 18:00-19:40 物理楼101 赵老师'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 4);
  assert.equal(r.items[0].startSection, 1);
  assert.ok(r.items[1].weeks.every(w => w % 2 === 0));
  assert.equal(r.items[3].startSection, 9);
  assert.equal(r.items[3].endSection, 10);
});

test('回归：4 字中文课名不被误判为教师名（多行名称不串行）', () => {
  const text = [
    '高等数学A1 周一 3-4节 第1-16周 D楼202 张三',
    '数据结构 周三 5,6节 1-16周(单) BJ102 李四',
    '大学体育 周五 18:00-19:40 体育馆 赵六'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.deepEqual(r.items.map(i => i.name), ['高等数学A1', '数据结构', '大学体育']);
  assert.deepEqual(r.items.map(i => i.teacher), ['张三', '李四', '赵六']);
});

test('全角字符归一化', () => {
  const r = CP.parseScheduleText('高等数学 周一 ３-４节 第１-１６周 Ｄ楼２０２ 张三', OPTS);
  const c = r.items[0];
  assert.equal(c.startSection, 3);
  assert.equal(c.endSection, 4);
  assert.equal(c.weeks.length, 16);
  assert.equal(c.location, 'D楼202');
});
