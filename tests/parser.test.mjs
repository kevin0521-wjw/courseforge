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

// ==================== 回归：真实教务课表（上海大学 PDF 导出格式）====================
// 这几个断言守护的是被真实文件暴露出来的 bug，删掉对应代码必须变红。

test('回归：括号课程编号不得粘进课名（体育(1)(GBK2800002) → 体育）', () => {
  const r = CP.parseScheduleText('星期一 体育(1)(GBK2800002) (7-8节)1-16周/教师:闵伟/选 课备注:男生羽毛球(基础 )/学分:1.0', OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, '体育', '课名必须剥掉 (1) 与 (GBK2800002)');
  assert.equal(r.items[0].teacher, '闵伟');
  assert.equal(r.items[0].day, 1);
  assert.equal(r.items[0].startSection, 7);
  assert.equal(r.items[0].endSection, 8);
});

test('回归：括号内是汉字时属于课名本体，必须保留（大学英语(听说)）', () => {
  const r = CP.parseScheduleText('星期三 大学英语(听说) (3-4节)1-16周/教师:顾海悦', OPTS);
  assert.equal(r.items[0].name, '大学英语(听说)', '汉字括号是课名的一部分，不能被剥掉');
});

test('回归：显式「教师:」不得吞掉后续标注（教师:闵伟/选 → 闵伟）', () => {
  const r = CP.parseScheduleText('星期一 体育(1)(GBK2800002) (7-8节)1-16周/教师:闵伟/选 课备注:男生羽毛球(基础 )/学分:1.0', OPTS);
  assert.equal(r.items[0].teacher, '闵伟', '「/选」残片不得进入教师字段');
  assert.ok(!/选|备注|学分/.test(r.items[0].teacher));
});

test('回归：「教师:X/地点:Y」中地点不得被吞进教师，且应解析出地点', () => {
  const r = CP.parseScheduleText('星期一 C++程序设计(JBK2321001) (1-2节)1-16周/教师:胡珉/地点:东区一教101', OPTS);
  assert.equal(r.items[0].name, 'C++程序设计');
  assert.equal(r.items[0].teacher, '胡珉', '教师字段不得包含「/地点:…」');
  assert.equal(r.items[0].location, '东区一教101');
});

test('回归：pendingName 用完即清，同一课名不得被后续无课名行反复继承', () => {
  // 第 1 行给出课名（成为 pendingName），第 2 行靠它补全；
  // 第 3 行同样没有课名 —— 若 pendingName 没在用完时清空，第 3 行会再次继承
  // 「C++程序设计」，凭空多出一条记录（真实教务课表里表现为课名串台）。
  const text = ['C++程序设计', '周二 3-4节', '周四 5-6节'].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  const inherited = r.items.filter((i) => i.name === 'C++程序设计');
  assert.equal(inherited.length, 1, 'pendingName 只能被消费一次，不得被第 3 行重复继承');
  assert.equal(inherited[0].day, 2, '应归属第 2 行声明的星期二');
});

test('回归：无课名且无星期的行不得凭空造课', () => {
  const text = ['C++程序设计 周一 1-2节 1-16周 东区一教101 胡珉', '——（分割线，无有效信息）——'].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'C++程序设计');
  assert.ok(!r.items.some(i => i.name === '' || i.name.startsWith('——')));
});

test('回归：短课名不被误判为教师名（学术英语 4 字）', () => {
  const r = CP.parseScheduleText('星期一 学术英语 (1)(GBK2300001) (3-4节)1-16周/教师:顾海悦 /选课备注:/学分:10.0', OPTS);
  assert.equal(r.items[0].name, '学术英语', '「学术英语」是课名不是人名，不得被互换逻辑顶替');
  assert.equal(r.items[0].teacher, '顾海悦');
});

test('回归：全角括号编号同样被剥离（高等数学 B(1)(GBK0101003) → 高等数学 B）', () => {
  const r = CP.parseScheduleText('星期二 高等数学 B(1)(GBK0101003) (7-8节)1-16周/教师:张琴/选 课备注:/学分:5.0', OPTS);
  assert.equal(r.items[0].name, '高等数学 B');
  assert.equal(r.items[0].teacher, '张琴');
});

test('回归：教师标注后的「/选」残片不得被当成课名（教师:闵伟/选 体育 → 体育）', () => {
  // 「选」是选课类型标记，被「/」切成独立片段后排在课名前，
  // 早期实现会把它当成课名（实测解析出课名「选」）。
  const r = CP.parseScheduleText('星期一 教师:闵伟/选 体育(7-8节)1-16周', OPTS);
  assert.equal(r.items[0].name, '体育', '「选」是选课类型残片，不得成为课名');
  assert.equal(r.items[0].teacher, '闵伟');
});

test('回归：节次括号被摘除后不得残留孤立左括号（体育(7-8节) → 体育）', () => {
  // 节次片段「(7-8节)」被移走时会连带吃掉右括号，只剩「(」粘在课名尾部。
  const r = CP.parseScheduleText('星期一 体育(7-8节)1-16周', OPTS);
  assert.equal(r.items[0].name, '体育', '课名尾部不得残留「(」');
  assert.equal(r.items[0].startSection, 7);
  assert.equal(r.items[0].endSection, 8);
});

// ==================== 回归：4 字短课名不得被「详情行互换」顶替 ====================
//
// 背景（由旋转课表 PDF 的端到端夹具抓出）：
//   parser 有一条「详情行互换」逻辑，用于处理「课程名一行、详情行跟随」的排版
//   （如第 1 行「程序设计基础」，第 2 行「教学楼B105 陈老师」—— 第 2 行里唯一的
//   内容 token 其实是教师，需要把课名从上文继承过来）。
//   该逻辑的判据是 looksLikeTeacher(name) && !looksLikeCourseName(name)，
//   而 looksLikeCourseName 靠「学/论/语/数学/…」这类词尾白名单判断 ——
//   「线性代数」是 4 个汉字、又不以白名单词尾结尾，于是被判成「人名」，
//   课名被上一门课覆盖。同类还会中招：「微积分」「大学物理」等。
//
//   修法不是继续堆词表（堆不完，且会引发别的误判），而是加两道【结构性】门槛：
//     ① 本行已显式写「教师:X」→ 教师字段有出处，首 token 必然是课名
//     ② 本行除地点外只剩一个内容 token → 才符合「详情行」的形状
//   下面两条测试分别守护这两道门槛。

test('回归：带「教师:」标注的行，首 token 必须是课名，不得被互换（门槛①）', () => {
  const text = [
    '体育 星期一 1-2节 1-16周',
    '线性代数 星期四 5-6节 1-16周 教师:郑十'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].name, '体育');
  assert.equal(r.items[1].name, '线性代数', '「线性代数」是课名，不得被替换成上一条的「体育」');
  assert.equal(r.items[1].teacher, '郑十');
  assert.equal(r.items[1].day, 4);
  assert.equal(r.items[1].startSection, 5);
});

test('回归：本行自带课程编号等多个内容 token 时，不得继承上一行课名（门槛②）', () => {
  const text = [
    '体育 星期一 1-2节 1-16周',
    '线性代数 星期四 (GBK0102003) 5-6节 1-16周'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 2);
  assert.equal(
    r.items[1].name,
    '线性代数',
    '本行带自己的课程编号 → 它是一行完整的课程描述，不得借用上一行的课名'
  );
  assert.equal(r.items[1].day, 4);
});

test('回归：真正的详情行仍必须能继承上一行课名（门槛不得过度收紧）', () => {
  const text = [
    '程序设计基础',
    '1-16周 星期一 1,2节 教学楼B105 陈老师'
  ].join('\n');
  const r = CP.parseScheduleText(text, OPTS);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, '程序设计基础', '详情行必须继承上一行课名');
  assert.equal(r.items[0].teacher, '陈老师', '详情行里唯一的内容 token 是教师');
});
