/**
 * ICS 日历导出测试（RFC 5545 合规性 + 日期/周次正确性）
 * 运行：node --test
 */
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CF = require('../web/js/core.js');
const ICS = require('../web/js/ics.js');

// 2026-09-14 是周一
const SETTINGS = {
  semesterStart: '2026-09-14',
  totalWeeks: 20,
  sectionsPerDay: 12,
  sectionTimes: CF.getPresetTimes('shu')
};

function mkCourse(over) {
  return CF.normalizeCourse(Object.assign({
    id: 'c1',
    name: '高等数学',
    teacher: '王老师',
    location: '教学楼A301',
    day: 1,
    startSection: 1,
    endSection: 2,
    weeks: [1, 2],
    color: 'blue'
  }, over || {}));
}

/** 取出所有 VEVENT 块 */
function eventsOf(text) {
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  return blocks.map((b) => b.split('END:VEVENT')[0]);
}

test('buildICS: 生成基础日历框架', () => {
  const res = ICS.buildICS([mkCourse()], SETTINGS, { now: new Date(2026, 8, 15, 10, 0, 0) });
  assert.ok(res.text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(res.text.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(res.text.includes('VERSION:2.0'));
  assert.ok(res.text.includes('PRODID:-//CourseForge//'));
  assert.ok(res.text.includes('CALSCALE:GREGORIAN'));
  assert.equal(res.events, 2); // 第 1、2 周
  assert.ok(!res.truncated);
});

test('buildICS: DTSTART 日期与节次时间正确（第1周周一 08:00-09:40）', () => {
  const res = ICS.buildICS([mkCourse({ weeks: [1] })], SETTINGS, {});
  assert.ok(res.text.includes('DTSTART:20260914T080000'), '开始时间应为第1周周一 08:00');
  assert.ok(res.text.includes('DTEND:20260914T094000'), '结束时间应为第2节结束 09:40');
});

test('buildICS: 第2周日期按 7 天递增', () => {
  const res = ICS.buildICS([mkCourse({ weeks: [2] })], SETTINGS, {});
  assert.ok(res.text.includes('DTSTART:20260921T080000'));
});

test('buildICS: 跨年周次日期正确（2026-12-28 起第2周落在 2027 年）', () => {
  const s = Object.assign({}, SETTINGS, { semesterStart: '2026-12-28' });
  const res = ICS.buildICS([mkCourse({ weeks: [2] })], s, {});
  assert.ok(res.text.includes('DTSTART:20270104T080000'));
});

test('buildICS: 单双周只展开对应周次', () => {
  const odd = CF.generateWeeks(1, 6, 'odd', 20); // 1,3,5
  const res = ICS.buildICS([mkCourse({ weeks: odd })], SETTINGS, {});
  assert.equal(res.events, 3);
  assert.ok(res.text.includes('DTSTART:20260914T080000')); // 第1周
  assert.ok(res.text.includes('DTSTART:20260928T080000')); // 第3周
  assert.ok(!res.text.includes('DTSTART:20260921T080000')); // 第2周不应出现
});

test('buildICS: 周三课程日期偏移正确', () => {
  const res = ICS.buildICS([mkCourse({ day: 3, weeks: [1] })], SETTINGS, {});
  assert.ok(res.text.includes('DTSTART:20260916T080000')); // 周一 9/14 + 2 天
});

test('buildICS: 文本转义（逗号/分号/反斜杠/换行）', () => {
  const res = ICS.buildICS([mkCourse({
    name: '数学,分析;导论\\上',
    note: '第一行\n第二行',
    weeks: [1]
  })], SETTINGS, {});
  assert.ok(res.text.includes('SUMMARY:数学\\,分析\\;导论\\\\上'));
  assert.ok(res.text.includes('第一行\\n第二行'));
});

test('buildICS: 每行不超过 75 字节且续行以空格开头', () => {
  const longName = '中外合作办学专业导论与学术英语综合实践课程（含实验环节与分组研讨）';
  const res = ICS.buildICS([mkCourse({ name: longName, weeks: [1] })], SETTINGS, {});
  const lines = res.text.split('\r\n').filter((l) => l.length > 0);
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, 'utf-8');
    assert.ok(bytes <= 75, `行超长(${bytes} 字节): ${line}`);
  }
  // 折行不能切碎中文：还原后应包含完整课程名
  const unfolded = lines.map((l, i) => (i === 0 || !l.startsWith(' ')) ? '\n' + l : l.slice(1)).join('');
  assert.ok(unfolded.includes(longName), '折行后应能还原出完整课程名');
});

test('buildICS: 作息时间缺失时跳过事件而不产生脏数据', () => {
  const s = Object.assign({}, SETTINGS, { sectionTimes: [{ label: '1', start: '', end: '' }] });
  const res = ICS.buildICS([mkCourse({ weeks: [1, 2] })], s, {});
  assert.equal(res.events, 0);
  assert.ok(res.skipped >= 2);
  assert.ok(!res.text.includes('BEGIN:VEVENT'));
});

test('buildICS: 学期日期非法时全部跳过（不抛异常）', () => {
  const s = Object.assign({}, SETTINGS, { semesterStart: 'not-a-date' });
  const res = ICS.buildICS([mkCourse()], s, {});
  assert.equal(res.events, 0);
  assert.ok(res.skipped >= 1);
});

test('buildICS: 事件数上限截断', () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push(mkCourse({ id: 'c' + i, weeks: [1, 2, 3] }));
  const res = ICS.buildICS(many, SETTINGS, { limit: 10 });
  assert.equal(res.events, 10);
  assert.equal(res.truncated, true);
});

test('buildICS: UID 唯一且不污染入参课程对象', () => {
  const c = mkCourse({ weeks: [1, 2] });
  const snapshot = JSON.stringify(c);
  const res = ICS.buildICS([c], SETTINGS, {});
  const uids = eventsOf(res.text).map((ev) => /UID:([^\r\n]+)/.exec(ev)[1]);
  assert.equal(new Set(uids).size, uids.length, 'UID 应互不相同');
  assert.equal(JSON.stringify(c), snapshot, '不应往课程对象里写临时字段');
});

test('buildICS: 每个 VEVENT 结构完整（含提醒 VALARM）', () => {
  const res = ICS.buildICS([mkCourse({ weeks: [1] })], SETTINGS, {});
  const ev = eventsOf(res.text)[0];
  for (const key of ['UID:', 'DTSTAMP:', 'DTSTART:', 'DTEND:', 'SUMMARY:', 'LOCATION:', 'DESCRIPTION:', 'BEGIN:VALARM', 'END:VALARM']) {
    assert.ok(ev.includes(key), '缺少 ' + key);
  }
});

test('buildICS: 空课程列表返回合法空日历', () => {
  const res = ICS.buildICS([], SETTINGS, {});
  assert.equal(res.events, 0);
  assert.ok(res.text.includes('BEGIN:VCALENDAR'));
  assert.ok(res.text.includes('END:VCALENDAR'));
  assert.ok(!res.text.includes('BEGIN:VEVENT'));
});

test('buildICS: skipPast 跳过已经过去的日程', () => {
  const now = new Date(2026, 8, 30, 12, 0, 0); // 第 3 周周三
  const res = ICS.buildICS([mkCourse({ weeks: [1, 2, 3, 4] })], SETTINGS, { skipPast: true, now });
  assert.equal(res.events, 1, '仅第 4 周（10/5）在未来');
  assert.ok(res.text.includes('DTSTART:20261005T080000'));
});

test('escText / timeCompact / suggestFileName 单元行为', () => {
  assert.equal(ICS.escText('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(ICS.escText(null), '');
  assert.equal(ICS.timeCompact('08:00'), '080000');
  assert.equal(ICS.timeCompact('8:5'), null);
  assert.equal(ICS.timeCompact('25:00'), null);
  assert.equal(ICS.suggestFileName(new Date(2026, 8, 15)), 'courseforge-20260915.ics');
});

test('foldLine: 短行原样返回，长行按 75 字节折', () => {
  assert.equal(ICS.foldLine('SUMMARY:abc'), 'SUMMARY:abc');
  const folded = ICS.foldLine('DESCRIPTION:' + 'x'.repeat(200));
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  assert.ok(parts.slice(1).every((p) => p.startsWith(' ')));
  assert.ok(parts.every((p) => Buffer.byteLength(p, 'utf-8') <= 75));
});

/** 检测字符串里是否存在「落单代理」（UTF-16 半个字符），有则说明折行切碎了 emoji */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // 落单低位代理
    }
  }
  return false;
}

/** 还原折行后的行（去掉续行前缀空格） */
function unfold(text) {
  return text.split('\r\n').map((l, i) => (i === 0 || !l.startsWith(' ')) ? l : l.slice(1)).join('');
}

test('foldLine: emoji 代理对不被切碎（回归：曾把 4 字节算成 2+3 字节）', () => {
  // 遍历各种偏移，逼迫折行边界正好落在 emoji 中间
  for (let pad = 28; pad <= 40; pad++) {
    const line = 'DESCRIPTION:' + 'a'.repeat(pad) + '🎓'.repeat(20);
    const parts = ICS.foldLine(line).split('\r\n');
    for (const p of parts) {
      const bytes = Buffer.byteLength(p, 'utf-8');
      assert.ok(bytes <= 75, `行超长(${bytes} 字节): ${p}`);
      assert.ok(!hasLoneSurrogate(p), `折行切碎了 emoji: ${JSON.stringify(p)}`);
    }
    assert.equal(unfold(parts.join('\r\n')), line, '折行后必须能无损还原');
  }
});

test('foldLine: 单个 emoji 按 4 字节计算（而非 5 字节）', () => {
  assert.equal(Buffer.byteLength('🎓', 'utf-8'), 4);
  // 2 字节前缀 + 18 个 emoji = 2 + 72 = 74 字节，应能放进一行
  const fit = ICS.foldLine('X:' + '🎓'.repeat(18));
  assert.ok(!fit.includes('\r\n'), '74 字节不应触发折行');
  // 再加一个就超了
  const overflow = ICS.foldLine('X:' + '🎓'.repeat(19));
  assert.ok(overflow.includes('\r\n'), '78 字节必须折行');
  assert.equal(unfold(overflow), 'X:' + '🎓'.repeat(19));
});

test('buildICS: 课程名含 emoji 时导出合法且可还原', () => {
  const name = '🎓' + '计算机导论与人工智能基础（含实验）'.repeat(4);
  const res = ICS.buildICS([mkCourse({ name, weeks: [1] })], SETTINGS, {});
  const lines = res.text.split('\r\n').filter(Boolean);
  for (const l of lines) {
    assert.ok(Buffer.byteLength(l, 'utf-8') <= 75, `行超长: ${l}`);
    assert.ok(!hasLoneSurrogate(l));
  }
  assert.ok(unfold(res.text).includes(name), 'SUMMARY 应能还原出完整课程名');
});
