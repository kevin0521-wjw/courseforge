/**
 * 教务系统 HTML 课表解析测试
 *
 * 这层测试的价值：教务直连的「取数」部分（桌面端 IPC）没法脱离 Electron 测，
 * 但「把 HTML 变成课程」这部分是纯函数，可以用真实感的 fixture 完整覆盖。
 * 目标是让解析逻辑的正确性不依赖「能不能登录上真教务系统」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Edu = require(fileURLToPath(new URL('../web/js/edu-html.js', import.meta.url)));

// ==================== fixture ====================

/** 典型网格型课表：行=节次、列=星期，第一列是节次，含 rowspan 合并与页面噪音 */
const GRID_HTML = `<!DOCTYPE html>
<html><head><title>个人课表</title>
<style>.kb td { border: 1px solid #ccc }</style>
<script>var junk = "<td>星期一天天</td>"; // 脚本里的假表格不能被解析</script>
</head><body>
<div class="banner">上海大学 2026-2027 学年秋季学期 个人课表</div>
<table class="kb">
  <tr><td colspan="8" align="center">学生：张三　学号：20260001</td></tr>
  <tr>
    <td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td>
    <td>星期四</td><td>星期五</td><td>星期六</td><td>星期日</td>
  </tr>
  <tr>
    <td>第1节</td>
    <td rowspan="2">高等数学<br>张老师<br>东区一教101<br>1-16周</td>
    <td>&nbsp;</td>
    <td>大学英语<br>李老师<br>东区二教202<br>1-16周</td>
    <td>&nbsp;</td>
    <td>程序设计基础<br>王老师<br>计算中心B101<br>1-8周</td>
    <td>&nbsp;</td><td>&nbsp;</td>
  </tr>
  <tr>
    <td>第2节</td>
    <td>&nbsp;</td>
    <td>大学英语<br>李老师<br>东区二教202<br>1-16周</td>
    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
  </tr>
  <tr>
    <td>第3节</td>
    <td>&nbsp;</td>
    <td>数据结构<br>陈老师<br>东区三教305<br>1-16周</td>
    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
  </tr>
</table>
</body></html>`;

/** 一格里塞两门课（用空行分隔），常见于同一时段分单双周上的两门课 */
const MULTI_COURSE_CELL_HTML = `<table>
  <tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>
  <tr><td>第5节</td>
    <td>大学物理<br>赵老师<br>东区一教201<br>1-16周<br><br>物理实验<br>孙老师<br>物理楼302<br>1-16周</td>
    <td colspan="4">&nbsp;</td>
  </tr>
</table>`;

/** 转置版面：行=星期、列=节次 */
const TRANSPOSED_HTML = `<table>
  <tr><td>&nbsp;</td><td>第1节</td><td>第2节</td><td>第3节</td><td>第4节</td></tr>
  <tr><td>星期一</td><td>线性代数<br>周老师<br>东区一教101<br>1-16周</td><td colspan="3">&nbsp;</td></tr>
  <tr><td>星期二</td><td>&nbsp;</td><td>大学英语<br>李老师<br>东区二教202<br>1-16周</td><td colspan="2">&nbsp;</td></tr>
  <tr><td>星期三</td><td colspan="4">&nbsp;</td></tr>
  <tr><td>星期四</td><td colspan="4">&nbsp;</td></tr>
  <tr><td>星期五</td><td colspan="4">&nbsp;</td></tr>
</table>`;

/** 列表型：一行一门课 */
const LIST_HTML = `<table class="course-list">
  <tr><th>序号</th><th>课程名称</th><th>任课教师</th><th>上课时间</th><th>上课地点</th></tr>
  <tr><td>1</td><td>高等数学</td><td>张老师</td><td>星期一第1-2节 1-16周</td><td>东区一教101</td></tr>
  <tr><td>2</td><td>大学英语</td><td>李老师</td><td>星期三第1-2节 1-16周</td><td>东区二教202</td></tr>
  <tr><td>3</td><td>程序设计基础</td><td>王老师</td><td>星期五第1节 1-8周</td><td>计算中心B101</td></tr>
</table>`;

// ==================== 基础工具 ====================

test('实体解码：数字实体、命名实体与 &amp; 的顺序问题', () => {
  assert.equal(Edu.decodeEntities('A&nbsp;B'), 'A B');
  assert.equal(Edu.decodeEntities('&lt;div&gt;'), '<div>');
  assert.equal(Edu.decodeEntities('&#65;&#x42;'), 'AB');
  assert.equal(Edu.decodeEntities('&#x4E2D;&#25991;'), '中文');
  // 双重转义的 &amp;lt; 必须解成字面量 "&lt;"，而不是继续被当成 <
  assert.equal(Edu.decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(Edu.decodeEntities('a&amp;b'), 'a&b');
  // 非法码点不能抛异常
  assert.doesNotThrow(() => Edu.decodeEntities('&#x110000;'));
});

test('标签剥离：br 与块级标签要变成换行，否则字段会粘成一串', () => {
  const t = Edu.cellText('高等数学<br>张老师</div>东区一教101');
  assert.equal(t.split('\n').length >= 3, true, '应至少分成 3 行，实际: ' + JSON.stringify(t));
  assert.ok(t.includes('高等数学'));
  assert.ok(t.includes('张老师'));
  assert.ok(t.includes('东区一教101'));
});

test('cellText：保留空行作为多课分隔，但压掉多余空行与首尾空白', () => {
  assert.equal(Edu.cellText('A<br><br><br>B'), 'A\n\nB');
  assert.equal(Edu.cellText('<br>A<br><br>'), 'A');
  assert.equal(Edu.cellText('&nbsp;&nbsp;'), '');
  assert.deepEqual(Edu.cellBlocks('A\n\nB\n\nC'), ['A', 'B', 'C']);
  assert.deepEqual(Edu.cellBlocks('A\nB'), ['A\nB']);
});

test('extractTables：跳过 script 里的假表格，正确处理嵌套与未闭合', () => {
  const html = '<script>var x = "<table><tr><td>假</td></tr></table>"</script>'
    + '<table id="a"><tr><td>真</td></tr></table>';
  const tables = Edu.extractTables(html);
  assert.equal(tables.length, 1);
  assert.ok(tables[0].includes('真'));
  assert.ok(!tables[0].includes('假'));

  // 嵌套表格不能把外层提前截断
  const nested = '<table><tr><td><table><tr><td>内</td></tr></table></td></tr><tr><td>外2</td></tr></table>';
  const t2 = Edu.extractTables(nested);
  assert.equal(t2.length, 1, '嵌套表格应只算一张外层表');
  const m = Edu.parseGrid(t2[0]);
  assert.equal(m.length, 2, '外层应解析出 2 行');
  assert.ok(Edu.cellText(m[0][0].text).includes('内'));
  assert.ok(Edu.cellText(m[1][0].text).includes('外2'));

  assert.deepEqual(Edu.extractTables('没有表格'), []);
  assert.deepEqual(Edu.extractTables(''), []);
});

test('parseGrid：rowspan/colspan 展开成矩形矩阵', () => {
  const m = Edu.parseGrid('<table>'
    + '<tr><td rowspan="2">A</td><td>B</td></tr>'
    + '<tr><td>C</td></tr>'
    + '</table>');
  assert.equal(m.length, 2);
  assert.equal(m[0].length, 2);
  assert.equal(m[1].length, 2, '第二行补上被 rowspan 占住的列');
  assert.equal(m[0][0], m[1][0], 'rowspan 覆盖的位置应是同一个单元格对象');
  assert.equal(Edu.cellText(m[1][0].text), 'A');
  assert.equal(Edu.cellText(m[1][1].text), 'C');

  const m2 = Edu.parseGrid('<table><tr><td colspan="3">X</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>');
  assert.equal(m2[0].length, 3);
  assert.equal(m2[0][0], m2[0][2], 'colspan 三列应是同一个对象');
  assert.equal(m2[1].length, 3);
});

test('parseGrid：单元格未闭合、属性里带 > 都不应错位', () => {
  const m = Edu.parseGrid('<table><tr><td title="a>b">A<td>B</tr></table>');
  assert.equal(m.length, 1);
  assert.equal(m[0].length, 2, '缺少 </td> 也要容错');
  assert.equal(Edu.cellText(m[0][0].text), 'A');
  assert.equal(Edu.cellText(m[0][1].text), 'B');
});

// ==================== 语义识别 ====================

test('dayOfText：中文 / 数字 / 英文星期，且不误吞长文本', () => {
  assert.equal(Edu.dayOfText('星期一'), 1);
  assert.equal(Edu.dayOfText('周日'), 7);
  assert.equal(Edu.dayOfText('礼拜天'), 7);
  assert.equal(Edu.dayOfText('周3'), 3);
  assert.equal(Edu.dayOfText('Mon'), 1);
  assert.equal(Edu.dayOfText('Friday'), 5);
  assert.equal(Edu.dayOfText('星期一(Mon)'), 1);
  // 反例：课程文本不能被当成星期
  assert.equal(Edu.dayOfText('高等数学'), null);
  assert.equal(Edu.dayOfText('体育（星期一上课）'), null, '长文本不应判为表头');
  assert.equal(Edu.dayOfText(''), null);
  assert.equal(Edu.dayOfText('节次'), null);
});

test('readSections：标准节次 / 时间映射 / 裸数字三种写法', () => {
  assert.deepEqual(Edu.readSections('第1节'), { start: 1, end: 1 });
  assert.deepEqual(Edu.readSections('第3-4节'), { start: 3, end: 4 });
  assert.deepEqual(Edu.readSections('5-6'), { start: 5, end: 6 });
  assert.deepEqual(Edu.readSections('7'), { start: 7, end: 7 });
  // 按作息时间表映射
  const times = [{ label: '第1节', start: '08:00', end: '08:45' }, { label: '第2节', start: '08:55', end: '09:40' }];
  assert.deepEqual(Edu.readSections('08:00-08:45', times), { start: 1, end: 1 });
  // 识别不出返回 null，而不是瞎猜
  assert.equal(Edu.readSections('上午'), null);
  assert.equal(Edu.readSections(''), null);
  assert.equal(Edu.readSections('高等数学'), null);
});

test('findDayHeaderRow：需要 ≥4 个星期列才算表头', () => {
  const m = Edu.parseGrid('<table>'
    + '<tr><td>课程</td><td>周一</td><td>周二</td></tr>'
    + '</table>');
  assert.equal(Edu.findDayHeaderRow(m), null, '只有 2 个星期列不该认定为表头');

  const m2 = Edu.parseGrid('<table><tr><td>节次</td>'
    + '<td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr></table>');
  const h = Edu.findDayHeaderRow(m2);
  assert.ok(h);
  assert.equal(h.row, 0);
  assert.equal(h.map[1], 1);
  assert.equal(h.map[5], 5);
  assert.equal(h.map[0], undefined, '「节次」列不是星期列');
});

// ==================== 网格型课表 ====================

test('网格型课表：完整解析出课程/教师/地点/星期/节次/周次', () => {
  const res = Edu.parseEduHtml(GRID_HTML);
  assert.equal(res.layout, 'grid', 'warnings: ' + res.warnings.join('; '));
  assert.ok(res.items.length >= 4, '应解析出至少 4 门课，实际 ' + res.items.length);

  const byName = {};
  res.items.forEach((it) => { byName[it.name] = it; });

  const math = byName['高等数学'];
  assert.ok(math, '应有高等数学');
  assert.equal(math.teacher, '张老师');
  assert.equal(math.location, '东区一教101');
  assert.equal(math.day, 1, '星期一 → day 1');
  assert.deepEqual(math.weeks, Array.from({ length: 16 }, (_, i) => i + 1), '1-16周');

  const english = byName['大学英语'];
  assert.ok(english);
  assert.equal(english.day, 3, '星期三 → day 3');
  assert.equal(english.teacher, '李老师');

  const prog = byName['程序设计基础'];
  assert.ok(prog);
  assert.equal(prog.day, 5, '星期五 → day 5');
  assert.equal(prog.weeks.length, 8, '1-8周应只有 8 周');

  // 表头行「节次/星期一…」和页眉「学生：张三」都不能被当成课程
  assert.ok(!res.items.some((i) => /节次|学生|学号|个人课表/.test(i.name)),
    '表头/页眉不应变成课程: ' + res.items.map((i) => i.name).join(','));
});

test('网格型课表：rowspan 合并的课只出现一次，且节次跨度正确', () => {
  const res = Edu.parseEduHtml(GRID_HTML);
  const math = res.items.filter((i) => i.name === '高等数学');
  assert.equal(math.length, 1, 'rowspan=2 的高等数学不能变成两门，实际 ' + math.length);
  assert.equal(math[0].startSection, 1);
  assert.equal(math[0].endSection, 2, '跨第1-2节');

  // 没有 rowspan 的课就是单节
  const prog = res.items.find((i) => i.name === '程序设计基础');
  assert.equal(prog.startSection, 1, '第1节');
  assert.equal(prog.endSection, 1, '没有 rowspan，不应被拉长');

  const ds = res.items.find((i) => i.name === '数据结构');
  assert.equal(ds.startSection, 3, '第3节');
  assert.equal(ds.day, 2, '星期二');
});

test('网格型课表：一格两门课按空行拆开', () => {
  const res = Edu.parseEduHtml(MULTI_COURSE_CELL_HTML);
  assert.equal(res.layout, 'grid');
  const names = res.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['大学物理', '物理实验'], '实际解析出: ' + JSON.stringify(names));
  const phy = res.items.find((i) => i.name === '大学物理');
  assert.equal(phy.teacher, '赵老师');
  assert.equal(phy.location, '东区一教201');
  const exp = res.items.find((i) => i.name === '物理实验');
  assert.equal(exp.teacher, '孙老师');
  assert.equal(exp.location, '物理楼302');
  // 两门课都在星期一第5节
  res.items.forEach((it) => {
    assert.equal(it.day, 1);
    assert.equal(it.startSection, 5);
  });
});

test('转置版面（行=星期、列=节次）也能识别', () => {
  const res = Edu.parseEduHtml(TRANSPOSED_HTML);
  assert.equal(res.layout, 'transposed', 'warnings: ' + res.warnings.join('; '));
  const la = res.items.find((i) => i.name === '线性代数');
  assert.ok(la, '实际: ' + JSON.stringify(res.items.map((i) => i.name)));
  assert.equal(la.day, 1, '星期一那一行');
  assert.equal(la.startSection, 1, '第1节那一列');
  assert.equal(la.teacher, '周老师');

  const en = res.items.find((i) => i.name === '大学英语');
  assert.ok(en);
  assert.equal(en.day, 2, '星期二');
  assert.equal(en.startSection, 2, '第2节');
});

// ==================== 列表型课表 ====================

test('列表型课表：按列映射拼装后复用启发式引擎', () => {
  const res = Edu.parseEduHtml(LIST_HTML);
  assert.equal(res.layout, 'list', 'warnings: ' + res.warnings.join('; '));
  assert.equal(res.items.length, 3);

  const math = res.items.find((i) => i.name === '高等数学');
  assert.ok(math);
  assert.equal(math.teacher, '张老师', '教师来自「任课教师」列，不能被误判成地点');
  assert.equal(math.location, '东区一教101');
  assert.equal(math.day, 1);
  assert.deepEqual([math.startSection, math.endSection], [1, 2]);

  const prog = res.items.find((i) => i.name === '程序设计基础');
  assert.equal(prog.day, 5);
  assert.equal(prog.startSection, 1);
  assert.equal(prog.weeks.length, 8);
  // 序号列不能被当成课程名
  assert.ok(!res.items.some((i) => /^\d+$/.test(i.name)));
});

test('列表型课表：只有「课程名称」列没有时间/地点时不算列表型', () => {
  const html = '<table><tr><th>课程名称</th></tr><tr><td>高等数学</td></tr></table>';
  const res = Edu.parseEduHtml(html);
  assert.equal(res.layout, 'none');
  assert.equal(res.items.length, 0);
  assert.ok(res.warnings.length > 0, '应给出 warning 而不是静默返回空');
});

// ==================== 边界与降级 ====================

test('无表格 / 空输入：返回 none 并带 warning，不抛异常', () => {
  for (const bad of ['', '<html><body>没有表格</body></html>', '<table></table>', null, undefined]) {
    assert.doesNotThrow(() => Edu.parseEduHtml(bad));
    const res = Edu.parseEduHtml(bad);
    assert.equal(res.items.length, 0);
    assert.equal(res.layout, 'none');
    assert.ok(res.warnings.length >= 1, '必须给出可读的原因，否则用户在界面上看不到任何反馈');
  }
});

test('有表格但没有课表结构：明确报「识别不出结构」', () => {
  const res = Edu.parseEduHtml('<table><tr><td>通知</td><td>内容</td></tr></table>');
  assert.equal(res.layout, 'none');
  assert.ok(res.warnings.join(' ').includes('没识别出课表结构'), '实际: ' + res.warnings.join(';'));
});

test('脚本内容不参与解析：<script> 里的课程文本不能被当成课', () => {
  const html = '<script>var tpl = "高等数学 张老师 东区一教101 周一第1节";</script>'
    + '<table><tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>'
    + '<tr><td>第1节</td><td>真正的课<br>真老师<br>真教室<br>1-16周</td>'
    + '<td colspan="4">&nbsp;</td></tr></table>';
  const res = Edu.parseEduHtml(html);
  assert.equal(res.items.length, 1, '实际: ' + JSON.stringify(res.items.map((i) => i.name)));
  assert.equal(res.items[0].name, '真正的课');
});

test('HTML 注释里的课程也不能被解析进来', () => {
  const html = '<!-- <table><tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>'
    + '<tr><td>第1节</td><td>注释里的课</td><td colspan="4">&nbsp;</td></tr></table> -->'
    + '<table><tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>'
    + '<tr><td>第1节</td><td>正常课<br>老师<br>教室<br>1-16周</td><td colspan="4">&nbsp;</td></tr></table>';
  const res = Edu.parseEduHtml(html);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].name, '正常课');
});

test('页面有多张表时挑课最多的那张（装饰性小表不能被选中）', () => {
  const noise = '<table><tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>'
    + '<tr><td>第1节</td><td>&nbsp;</td><td colspan="4">&nbsp;</td></tr></table>';
  const res = Edu.parseEduHtml(noise + GRID_HTML);
  assert.ok(res.items.length >= 4, '应选中真正的主表，实际 ' + res.items.length);
  assert.ok(res.items.some((i) => i.name === '高等数学'));
});

test('dedupe：完全相同的条目去重，字段不同的保留', () => {
  const base = { name: 'A', teacher: 'T', location: 'L', day: 1, startSection: 1, endSection: 1, weeks: [1] };
  const items = [base, { ...base }, { ...base, startSection: 2 }, { ...base, day: 2 }];
  assert.equal(Edu.dedupe(items).length, 3);
  assert.equal(Edu.dedupe([]).length, 0);
});

test('解析结果与 core.normalizeCourse 兼容（能直接入库）', async () => {
  const CF = require(fileURLToPath(new URL('../web/js/core.js', import.meta.url)));
  const res = Edu.parseEduHtml(GRID_HTML);
  const courses = res.items.map((it) => CF.normalizeCourse(it));
  for (const c of courses) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0, '应自动发号');
    assert.ok(c.name.length > 0);
    assert.ok(c.day >= 1 && c.day <= 7, 'day 必须在 1-7，实际 ' + c.day);
    assert.ok(c.startSection >= 1 && c.endSection >= c.startSection);
    assert.ok(Array.isArray(c.weeks));
  }
  // 不能有重号（两个学期/多条导入共用 id 会串台）
  const ids = courses.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('模块可在浏览器环境挂载（UMD 双环境）', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(fileURLToPath(new URL('../web/js/edu-html.js', import.meta.url)), 'utf-8');
  assert.ok(/root\.CourseForgeEdu\s*=/.test(src), '浏览器端应挂 window.CourseForgeEdu');
  assert.ok(/require\('\.\/parser\.js'\)/.test(src), 'Node 端应 require parser.js');
});
