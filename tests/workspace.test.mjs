/**
 * 多学期（工作区 / schema v2）测试
 * 重点：v1 → v2 迁移不能丢数据；最后一个学期不可删除；activeId 失效必须回落
 * 运行：node --test
 */
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CF = require('../web/js/core.js');

// 2026-09-14 是周一
const SETTINGS = {
  semesterStart: '2026-09-14',
  totalWeeks: 20,
  sectionsPerDay: 12,
  sectionTimes: CF.getPresetTimes('shu')
};

function mkCourse(over) {
  return Object.assign({
    id: 'c1', name: '高等数学', teacher: '王老师', location: '教学楼A301',
    day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3], color: 'blue'
  }, over || {});
}

// ==================== defaultSemesterName ====================

test('defaultSemesterName: 8-12 月为当年秋季学期', () => {
  assert.equal(CF.defaultSemesterName('2026-09-14'), '2026 秋季学期');
  assert.equal(CF.defaultSemesterName('2026-12-01'), '2026 秋季学期');
  assert.equal(CF.defaultSemesterName('2026-08-01'), '2026 秋季学期');
});

test('defaultSemesterName: 1 月仍属上一年秋季学期', () => {
  assert.equal(CF.defaultSemesterName('2027-01-05'), '2026 秋季学期');
});

test('defaultSemesterName: 2-7 月为当年春季学期', () => {
  assert.equal(CF.defaultSemesterName('2027-02-22'), '2027 春季学期');
  assert.equal(CF.defaultSemesterName('2027-07-01'), '2027 春季学期');
});

test('defaultSemesterName: 日期非法时兜底', () => {
  assert.equal(CF.defaultSemesterName('not-a-date'), '我的课表');
  assert.equal(CF.defaultSemesterName(null), '我的课表');
  assert.equal(CF.defaultSemesterName(''), '我的课表');
});

// ==================== normalizeSemester ====================

test('normalizeSemester: 名称缺失时按开始日期推导，超长截断到 20 字', () => {
  const a = CF.normalizeSemester({ settings: SETTINGS });
  assert.equal(a.name, '2026 秋季学期');
  assert.ok(a.id, '应自动生成 id');

  const long = CF.normalizeSemester({ name: '一'.repeat(40), settings: SETTINGS });
  assert.equal(long.name.length, 20);

  const named = CF.normalizeSemester({ name: '  大三上  ', settings: SETTINGS });
  assert.equal(named.name, '大三上', '应去掉首尾空白');
});

test('normalizeSemester: 课程与设置都经过清洗，非法值不抛错', () => {
  const s = CF.normalizeSemester({
    name: '测试',
    settings: { totalWeeks: 999, semesterStart: 'bad' },
    courses: [mkCourse(), null, 'garbage', { name: '英语' }]
  });
  assert.equal(s.settings.totalWeeks, 20, '非法总周数应回落默认值');
  assert.equal(s.courses.length, 4, '每一条都应被清洗成课程对象而不是被丢弃');
  assert.ok(s.courses[3].id, '缺 id 的课程应自动补 id');
});

test('normalizeSemester: courses 非数组时视为空', () => {
  for (const bad of [undefined, null, 'x', 42, {}]) {
    const s = CF.normalizeSemester({ name: 'A', settings: SETTINGS, courses: bad });
    assert.deepEqual(s.courses, []);
  }
});

// ==================== normalizeWorkspace：v1 迁移 ====================

test('normalizeWorkspace: v1 扁平数据迁移后课程与设置一字不丢', () => {
  const v1 = {
    version: 1,
    courses: [mkCourse({ id: 'a', name: '高数' }), mkCourse({ id: 'b', name: '英语', day: 3 })],
    settings: SETTINGS
  };
  const ws = CF.normalizeWorkspace(v1);
  assert.equal(ws.semesters.length, 1, 'v1 应迁移为单个学期');
  assert.equal(ws.activeId, ws.semesters[0].id);
  assert.equal(ws.semesters[0].courses.length, 2);
  assert.equal(ws.semesters[0].courses[0].name, '高数');
  assert.equal(ws.semesters[0].courses[1].day, 3);
  assert.equal(ws.semesters[0].settings.semesterStart, '2026-09-14');
  assert.equal(ws.semesters[0].settings.totalWeeks, 20);
  assert.equal(ws.semesters[0].name, '2026 秋季学期');
});

test('normalizeWorkspace: v1 且课程为空时仍能迁移出空学期', () => {
  const ws = CF.normalizeWorkspace({ version: 1, courses: [], settings: SETTINGS });
  assert.equal(ws.semesters.length, 1);
  assert.deepEqual(ws.semesters[0].courses, []);
});

test('normalizeWorkspace: 完全无效的输入返回 null', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { version: 99 }]) {
    assert.equal(CF.normalizeWorkspace(bad), null, '输入 ' + JSON.stringify(bad) + ' 应返回 null');
  }
});

// ==================== normalizeWorkspace：v2 ====================

test('normalizeWorkspace: v2 保留全部学期与 activeId', () => {
  const ws = CF.normalizeWorkspace({
    version: 2,
    activeId: 's2',
    semesters: [
      { id: 's1', name: '大一上', settings: SETTINGS, courses: [mkCourse()] },
      { id: 's2', name: '大一下', settings: SETTINGS, courses: [] }
    ]
  });
  assert.equal(ws.semesters.length, 2);
  assert.equal(ws.activeId, 's2');
  assert.equal(ws.semesters[0].name, '大一上');
  assert.equal(ws.semesters[0].courses.length, 1);
});

test('normalizeWorkspace: activeId 失效时回落到第一个学期（避免白屏）', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 'no-such-id',
    semesters: [{ id: 's1', name: 'A', settings: SETTINGS, courses: [] }]
  });
  assert.equal(ws.activeId, 's1');

  const noActive = CF.normalizeWorkspace({
    semesters: [{ id: 's1', name: 'A', settings: SETTINGS, courses: [] }]
  });
  assert.equal(noActive.activeId, 's1');
});

test('normalizeWorkspace: 重复 id 会被重新发号（否则切学期会串数据）', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 'dup',
    semesters: [
      { id: 'dup', name: 'A', settings: SETTINGS, courses: [] },
      { id: 'dup', name: 'B', settings: SETTINGS, courses: [] }
    ]
  });
  assert.equal(ws.semesters.length, 2);
  assert.notEqual(ws.semesters[0].id, ws.semesters[1].id, '重复 id 必须被修复');
  assert.equal(ws.semesters[0].name, 'A');
  assert.equal(ws.semesters[1].name, 'B');
});

// ==================== 查找 ====================

test('findSemester / activeSemester', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 's2',
    semesters: [
      { id: 's1', name: 'A', settings: SETTINGS, courses: [] },
      { id: 's2', name: 'B', settings: SETTINGS, courses: [] }
    ]
  });
  assert.equal(CF.findSemester(ws, 's1').name, 'A');
  assert.equal(CF.findSemester(ws, 'nope'), null);
  assert.equal(CF.activeSemester(ws).name, 'B');
  assert.equal(CF.activeSemester(null), null);
  assert.equal(CF.findSemester(null, 'x'), null);
});

// ==================== 新学期默认值 ====================

test('nextSemesterStart: 顺延到当前学期结束后那一周的周一', () => {
  // 2026-09-14（周一）+ 20 周 = 2027-02-01（也是周一）
  assert.equal(CF.nextSemesterStart(SETTINGS), '2027-02-01');
  // 非周一开学也要对齐到周一：2026-09-16（周三）+ 12 周 = 2026-12-09（周三）→ 周一 12-07
  assert.equal(CF.nextSemesterStart({ semesterStart: '2026-09-16', totalWeeks: 12 }), '2026-12-07');
});

test('nextSemesterStart: 日期非法时回落到本周周一', () => {
  const got = CF.nextSemesterStart({ semesterStart: 'bad', totalWeeks: 20 });
  assert.ok(CF.parseDate(got), '应返回合法日期');
  assert.equal(CF.mondayOf(CF.parseDate(got)).getTime(), CF.parseDate(got).getTime(), '结果必须是周一');
});

test('nextSemesterDefaults: 沿用总周数/节次/作息，只顺延开始日期', () => {
  const cur = { settings: SETTINGS };
  const d = CF.nextSemesterDefaults(cur);
  assert.equal(d.settings.semesterStart, '2027-02-01');
  assert.equal(d.settings.totalWeeks, 20);
  assert.equal(d.settings.sectionsPerDay, 12);
  assert.equal(d.settings.sectionTimes.length, SETTINGS.sectionTimes.length);
  assert.equal(d.name, '2027 春季学期');
  // 不应污染入参
  assert.equal(cur.settings.semesterStart, '2026-09-14');
});

test('nextSemesterDefaults: 隐藏周末的偏好也要被沿用', () => {
  const d = CF.nextSemesterDefaults({ settings: Object.assign({}, SETTINGS, { showWeekend: false }) });
  assert.equal(d.settings.showWeekend, false);
});

// ==================== addSemester ====================

test('addSemester: 新学期成为当前学期，且不修改入参', () => {
  const ws = CF.normalizeWorkspace({ version: 1, courses: [mkCourse()], settings: SETTINGS });
  const snapshot = JSON.stringify(ws);
  const res = CF.addSemester(ws, { name: '大一下', settings: { semesterStart: '2027-02-01' }, courses: [] });
  assert.equal(res.workspace.semesters.length, 2);
  assert.equal(res.workspace.activeId, res.semester.id, '新加的学期应自动成为当前学期');
  assert.equal(res.semester.name, '大一下');
  assert.equal(res.workspace.semesters[0].id, ws.semesters[0].id, '原有学期应原样保留');
  assert.equal(JSON.stringify(ws), snapshot, 'addSemester 不得修改入参');
});

test('addSemester: 支持把旧学期课程复制到新学期', () => {
  const ws = CF.normalizeWorkspace({ version: 1, courses: [mkCourse({ id: 'a' })], settings: SETTINGS });
  const copied = ws.semesters[0].courses.map((c) => Object.assign({}, c));
  const res = CF.addSemester(ws, { name: '新学期', settings: SETTINGS, courses: copied });
  assert.equal(res.semester.courses.length, 1);
  assert.equal(res.semester.courses[0].name, '高等数学');
  assert.equal(ws.semesters.length, 1, '入参工作区不应被改动');
});

// ==================== renameSemester ====================

test('renameSemester: 正常改名 / 空名失败 / 找不到失败', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 's1',
    semesters: [{ id: 's1', name: '旧名', settings: SETTINGS, courses: [mkCourse()] }]
  });

  const ok = CF.renameSemester(ws, 's1', '  大三上  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.workspace.semesters[0].name, '大三上');
  assert.equal(ok.workspace.semesters[0].courses.length, 1, '改名不应丢课程');
  assert.equal(ws.semesters[0].name, '旧名', '不应修改入参');

  assert.equal(CF.renameSemester(ws, 's1', '   ').ok, false);
  assert.equal(CF.renameSemester(ws, 's1', '').ok, false);
  assert.equal(CF.renameSemester(ws, 's1', null).ok, false);
  const miss = CF.renameSemester(ws, 'nope', 'X');
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'notfound');
});

test('renameSemester: 超长名称截断到 20 字', () => {
  const ws = CF.normalizeWorkspace({ semesters: [{ id: 's1', name: 'A', settings: SETTINGS, courses: [] }] });
  const res = CF.renameSemester(ws, 's1', '一'.repeat(50));
  assert.equal(res.workspace.semesters[0].name.length, 20);
});

// ==================== removeSemester ====================

test('removeSemester: 最后一个学期不允许删除', () => {
  const ws = CF.normalizeWorkspace({ version: 1, courses: [mkCourse()], settings: SETTINGS });
  const res = CF.removeSemester(ws, ws.activeId);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'last');
  assert.equal(res.workspace.semesters.length, 1);
});

test('removeSemester: 删掉非当前学期时当前学期不变', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 's2',
    semesters: [
      { id: 's1', name: 'A', settings: SETTINGS, courses: [] },
      { id: 's2', name: 'B', settings: SETTINGS, courses: [mkCourse()] }
    ]
  });
  const res = CF.removeSemester(ws, 's1');
  assert.equal(res.ok, true);
  assert.equal(res.workspace.semesters.length, 1);
  assert.equal(res.workspace.activeId, 's2', '删除其它学期不应切换当前学期');
  assert.equal(res.workspace.semesters[0].name, 'B');
});

test('removeSemester: 删掉当前学期时自动切到剩下的第一个', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 's2',
    semesters: [
      { id: 's1', name: 'A', settings: SETTINGS, courses: [] },
      { id: 's2', name: 'B', settings: SETTINGS, courses: [] }
    ]
  });
  const res = CF.removeSemester(ws, 's2');
  assert.equal(res.ok, true);
  assert.equal(res.workspace.activeId, 's1');
  assert.equal(res.workspace.semesters.length, 1);
});

test('removeSemester: 找不到 / 空工作区都安全返回', () => {
  const ws = CF.normalizeWorkspace({
    activeId: 's1',
    semesters: [
      { id: 's1', name: 'A', settings: SETTINGS, courses: [] },
      { id: 's2', name: 'B', settings: SETTINGS, courses: [] }
    ]
  });
  const miss = CF.removeSemester(ws, 'nope');
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'notfound');
  assert.equal(miss.workspace.semesters.length, 2, '找不到时不应误删');

  assert.equal(CF.removeSemester(null, 'x').ok, false);
  assert.equal(CF.removeSemester({ semesters: [] }, 'x').reason, 'empty');
});

// ==================== 端到端往返 ====================

test('往返一致性：v1 → 工作区 → 加学期 → 序列化 → 再解析，数据完全一致', () => {
  const v1 = { version: 1, courses: [mkCourse({ id: 'a', name: '高数' })], settings: SETTINGS };
  let ws = CF.normalizeWorkspace(v1);
  ws = CF.addSemester(ws, {
    name: '大一下',
    settings: CF.nextSemesterDefaults(CF.activeSemester(ws)).settings,
    courses: [{ name: '线性代数', day: 4, startSection: 1, endSection: 2, weeks: [1, 2], color: 'green' }]
  }).workspace;
  ws = CF.renameSemester(ws, ws.activeId, '第二学期').workspace;

  // 模拟存盘 → 重新读盘
  const round = CF.normalizeWorkspace(JSON.parse(JSON.stringify({ version: 2, activeId: ws.activeId, semesters: ws.semesters })));
  assert.equal(round.semesters.length, 2);
  assert.equal(round.activeId, ws.activeId);
  assert.equal(round.semesters[0].name, '2026 秋季学期');
  assert.equal(round.semesters[0].courses[0].name, '高数');
  assert.equal(round.semesters[1].name, '第二学期');
  assert.equal(round.semesters[1].courses[0].name, '线性代数');
  assert.equal(round.semesters[1].settings.semesterStart, '2027-02-01');
});

test('切换学期后课程互不串台（模拟真实使用）', () => {
  let ws = CF.normalizeWorkspace({
    version: 1,
    courses: [mkCourse({ id: 'a', name: '秋季课' })],
    settings: SETTINGS
  });
  // 加一个空的新学期并写入不同课程
  ws = CF.addSemester(ws, { name: '春季', settings: SETTINGS, courses: [mkCourse({ id: 'b', name: '春季课' })] }).workspace;

  const spring = CF.activeSemester(ws);
  assert.equal(spring.courses.length, 1);
  assert.equal(spring.courses[0].name, '春季课');

  // 切回秋季
  const autumn = CF.findSemester(ws, ws.semesters[0].id);
  assert.equal(autumn.courses[0].name, '秋季课');
  assert.equal(autumn.courses.length, 1);
});
