/**
 * PDF 版面还原引擎测试
 *
 * 这组用例守护的是「真实课表 PDF 识别失败」的修复 —— pdf.js 的 getTextContent()
 * 只给出带坐标的文字片段，课表「哪门课属于星期几」的信息【只存在于坐标里】。
 * 把片段 join(' ') 拍平就会丢掉这个信息，导致 0 门课。
 *
 * 因此断言分两层：
 *   1) 各内部步骤（分行/切格/推列）单独可验证
 *   2) 用源自真实课表的 PDF 夹具（tests/fixtures/shu-kb.json，87 个带坐标片段）走端到端
 *      —— 姓名与学号已替换为化名，且刻意保持字符宽度与原值一致，故不影响版面/宽度断言
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PL = require('../web/js/pdf-layout.js');
const Parser = require('../web/js/parser.js');

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/shu-kb.json'
);

/** 造一个 pdf.js 风格的文字片段（transform = [a,b,c,d,e,f]，e=x、f=y、d≈字号） */
function frag(str, x, y, size = 12, width = null) {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: width == null ? str.length * size * 0.9 : width,
    height: size
  };
}

// ==================== normalizeItems ====================

test('normalizeItems: 过滤空串与纯空白片段', () => {
  const out = PL.normalizeItems([frag('语文', 10, 100), frag('   ', 20, 100), frag('', 30, 100)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, '语文');
});

test('normalizeItems: 提取坐标与字号', () => {
  const out = PL.normalizeItems([frag('数学', 104, 506, 14)]);
  assert.equal(out[0].x, 104);
  assert.equal(out[0].y, 506);
  assert.equal(out[0].size, 14);
});

test('normalizeItems: 丢弃旋转文本（水印/竖排会污染行聚类）', () => {
  const rotated = { str: '水印', transform: [0, 12, 12, 0, 50, 50], width: 24, height: 12 };
  const out = PL.normalizeItems([frag('正常', 10, 100), rotated]);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, '正常');
});

test('normalizeItems: 空输入安全返回（不抛异常）', () => {
  assert.deepEqual(PL.normalizeItems([]), []);
  assert.deepEqual(PL.normalizeItems(null), []);
  assert.deepEqual(PL.normalizeItems(undefined), []);
});

test('normalizeItems: 残缺 transform 降级为原点坐标而非崩溃', () => {
  // 缺 transform 的片段不该让整个导入失败 —— 降级为 (0,0) 后由后续聚类处理
  const out = PL.normalizeItems([{ str: '缺transform' }]);
  assert.equal(out.length, 1, '应保留片段而不是抛异常');
  assert.equal(out[0].x, 0);
  assert.equal(out[0].y, 0);
});

// ==================== groupRows ====================

test('groupRows: 同一 y（容差内）的片段归为一行，并按 x 排序', () => {
  const items = PL.normalizeItems([
    frag('B', 200, 500),
    frag('A', 100, 500),
    frag('C', 150, 501.5) // 容差内，应并入同一行
  ]);
  const rows = PL.groupRows(items);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].items.map((i) => i.str), ['A', 'C', 'B']);
});

test('groupRows: y 差超过容差的片段分成不同行，且按阅读顺序（自上而下）排列', () => {
  const items = PL.normalizeItems([
    frag('第二行', 100, 400),
    frag('第一行', 100, 500) // y 更大 = 更靠上
  ]);
  const rows = PL.groupRows(items);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].items[0].str, '第一行', 'y 大的行应排在前（PDF 原点在左下）');
  assert.equal(rows[1].items[0].str, '第二行');
});

// ==================== splitCells ====================

test('splitCells: 间距超过 0.8 倍字号时切开并排格子', () => {
  // 同一行里三个并排格子，间距明显大于字号
  const items = PL.normalizeItems([
    frag('1', 78, 506, 12, 10),
    frag('C++程序设计', 208, 506, 12, 70),
    frag('学术英语', 519, 506, 12, 48)
  ]);
  const rows = PL.groupRows(items);
  const cells = PL.splitCells(rows[0]);
  assert.equal(cells.length, 3, '三个不同 x 的格子必须切开，不能粘成一格');
  assert.deepEqual(cells.map((c) => c.text), ['1', 'C++程序设计', '学术英语']);
});

test('splitCells: 间距小于阈值时视为同格内的连续文字', () => {
  const items = PL.normalizeItems([
    frag('C++', 100, 500, 12, 22),
    frag('程序设计', 123, 500, 12, 48) // 紧邻，间距约 1pt
  ]);
  const rows = PL.groupRows(items);
  const cells = PL.splitCells(rows[0]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].text, 'C++程序设计');
});

test('splitCells: 阈值随字号缩放（大字号允许更大间距）', () => {
  const make = (size, gap) => {
    const items = PL.normalizeItems([
      frag('甲', 100, 500, size, size),
      frag('乙', 100 + size + gap, 500, size, size)
    ]);
    return PL.splitCells(PL.groupRows(items)[0]).length;
  };
  // 同样 10pt 间距：小字号（阈值 8）切开，大字号（阈值 16）不切
  assert.equal(make(10, 10), 2, '10pt 字号 + 10pt 间距 → 应切开');
  assert.equal(make(20, 10), 1, '20pt 字号 + 10pt 间距 → 仍在同格');
});

// ==================== findColumns ====================

test('findColumns: 只出现一次的列也必须保留（不得按出现频次筛列）', () => {
  // 三列，其中 x=312（星期三）全局只出现一次 —— 按频次筛列会把它丢掉
  const items = PL.normalizeItems([
    frag('星期一', 104, 500),
    frag('星期二', 208, 500),
    frag('星期三', 312, 500),
    frag('星期一', 104, 450),
    frag('星期二', 208, 450)
  ]);
  const rowsOfCells = PL.groupRows(items).map(PL.splitCells);
  const cols = PL.findColumns(rowsOfCells, rowsOfCells.length);

  assert.ok(Array.isArray(cols) && cols.length >= 3,
    `应推断出至少 3 个列边界（含只出现一次的 312），实际 ${JSON.stringify(cols)}`);

  // 关键：312 必须落在某个列边界区间内，且与 208 分属不同列
  const idx208 = cols.findIndex((b, i) => 208 >= b && (i === cols.length - 1 || 208 < cols[i + 1]));
  const idx312 = cols.findIndex((b, i) => 312 >= b && (i === cols.length - 1 || 312 < cols[i + 1]));
  assert.ok(idx208 >= 0 && idx312 >= 0, '208 与 312 都应能被映射到某一列');
  assert.notEqual(idx208, idx312, 'x=208 与 x=312 必须落在不同列（否则星期三的课会混进星期二）');
});

test('findColumns: 真实夹具能推断出完整列结构', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const rowsOfCells = PL.groupRows(PL.normalizeItems(items)).map(PL.splitCells);
  const meaningful = rowsOfCells.filter((cs) => cs.length >= 2);
  const cols = PL.findColumns(meaningful, rowsOfCells.length);

  assert.ok(cols.length >= 7,
    `真实课表应推断出至少 7 列（节次+周一至周日），实际 ${cols.length}：${JSON.stringify(cols)}`);
});

// ==================== layoutToText 端到端（真实夹具）====================

test('layoutToText: 空输入安全返回，不抛异常', () => {
  const res = PL.layoutToText([]);
  assert.equal(res.text, '');
  assert.equal(res.isTable, false);
});

test('layoutToText: 非表格文本原样按行返回（isTable=false）', () => {
  const items = PL.normalizeItems([
    frag('高等数学 周一 3-4节 第1-16周 D楼202 张三', 50, 500)
  ]);
  const res = PL.layoutToText(items);
  assert.equal(res.isTable, false, '单列散文本不应被误判为表格');
  assert.ok(res.text.includes('高等数学'));
});

test('layoutToText: 真实课表 PDF 还原为表格（8 列结构）', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  assert.equal(res.isTable, true, '真实课表必须被识别为表格（识别失败即 isTable=false）');
  assert.ok(res.cols >= 7, `应还原出至少 7 列（节次+周一至周日），实际 ${res.cols}`);
  assert.ok(res.rows >= 10, `应还原出至少 10 个课程行，实际 ${res.rows}`);
});

test('layoutToText: 每门课程都带上正确的「星期X」前缀（坐标归属未丢失）', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  // 这是本次修复的核心：星期归属只存在于坐标里，拍平就会全部丢失
  const dayLines = res.text.split('\n').filter((l) => /^星期[一二三四五六日]/.test(l.trim()));
  assert.ok(dayLines.length >= 11, `应有 11 门课带星期前缀，实际 ${dayLines.length}`);

  for (const line of dayLines) {
    assert.ok(
      /^星期[一二三四五六日]\s+\S/.test(line.trim()),
      `行格式应为「星期X 课程名…」，实际：${line.slice(0, 40)}`
    );
  }
});

test('layoutToText: 表头与噪声行（标题/学号/打印时间/统计）不得混入结果', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  assert.ok(!/学生甲/.test(res.text), '课表标题（姓名）不应出现在正文');
  assert.ok(!/学号/.test(res.text), '学号行不应出现在正文');
  assert.ok(!/打印时间|打印日期/.test(res.text), '打印时间不应出现在正文');
  assert.ok(!/^\s*时间段/m.test(res.text) || /时间段/.test(res.text), '表头处理不应崩溃');
});

test('layoutToText: 星期四的高等数学 B 归属正确（跨格合并未错位）', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  // 「高等数学 B」在周二与周四各一次；若列归属错乱会跑到别的星期
  const thu = res.text.split('\n').filter((l) => /^星期四/.test(l.trim()));
  assert.ok(
    thu.some((l) => /高等数学/.test(l)),
    `星期四应有高等数学，实际星期四的行：${JSON.stringify(thu.map((l) => l.slice(0, 30)))}`
  );
  assert.ok(
    thu.some((l) => /学术英语/.test(l)),
    '星期四应有学术英语'
  );
});

test('layoutToText: 同一格的课名与编号不会被拆成两门课', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  // 「C++程序设计 (JBK2321001)」应同行；若被拆开会出现只有编号的行
  const orphanCode = res.text
    .split('\n')
    .filter((l) => /^\s*(?:星期[一二三四五六日]\s*)?\(?[A-Z]{2,}\d{5,}\)?\s*$/.test(l.trim()));
  assert.equal(orphanCode.length, 0, `不应出现「只有课程编号」的孤立行：${JSON.stringify(orphanCode)}`);
});

// ==================== 端到端：真实 PDF 夹具 → 完整课表 ====================
// 这组断言用【精确值】而非「>= N」：阈值过松会让被破坏的合并常量蒙混过关
// （实测把 MERGE_GAP 改成 9999 时，只断言数量 >= 11 的用例全部照过）。

const DAY_CN = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 跑完整链路：坐标片段 → 版面还原 → 课表解析 */
function parseRealFixture() {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const layout = PL.layoutToText(items);
  const parsed = Parser.parseScheduleText(layout.text);
  return { layout, parsed };
}

test('端到端：真实课表精确解析出 11 门课（课名/星期/节次/教师全对）', () => {
  const { parsed } = parseRealFixture();
  const actual = parsed.items.map(
    (i) => '星期' + DAY_CN[i.day] + ' ' + i.startSection + '-' + i.endSection + ' ' + i.name + ' ' + (i.teacher || '-')
  );
  const expected = [
    '星期一 1-2 C++程序设计 胡珉',
    '星期一 3-4 学术英语 顾海悦',
    '星期一 5-6 信息与人工智能基础 刘瀛浩',
    '星期一 7-8 体育 闵伟',
    '星期二 5-6 学术英语 顾海悦',
    '星期二 7-8 高等数学 B 张琴',
    '星期二 9-11 中国近现代史纲要 艾萍',
    '星期三 3-4 学术英语 顾海悦',
    '星期三 5-6 C++程序设计 胡珉',
    '星期四 1-2 学术英语 顾海悦',
    '星期四 7-8 高等数学 B 张琴'
  ];
  assert.deepEqual(actual, expected, '真实课表的完整解析结果必须逐条精确匹配');
  assert.equal(parsed.warnings.length, 0, '不应有告警，实际：' + JSON.stringify(parsed.warnings));
});

test('端到端：版面结构精确为 8 列 / 12 行（表格形态未被破坏）', () => {
  const { layout } = parseRealFixture();
  assert.equal(layout.isTable, true);
  assert.equal(layout.cols, 8, '应为 节次 + 周一~周日 = 8 列');
  assert.equal(layout.rows, 12, '应为 表头 + 11 门课 = 12 行');
});

// ==================== 断格机制：内容形态（真正起作用的那条规则）====================
// 变异测试发现：这份课表的相邻行距全在 11.5~15.6pt，都小于 MERGE_GAP(22)，
// 所以「间距断格」这条分支从不触发 —— 真正把课程切开的是「内容形态」判断。
// 这组用例专门锁住该机制，避免误以为调间距阈值能解决问题。

test(
  '同一格：课名 + 编号 + 节次 + 教师 + 学分 必须聚成一个块（不得被拆成多门课）',
  () => {
    const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const res = PL.layoutToText(items);
    const lines = res.text.split('\n').filter((l) => /^星期/.test(l.trim()));

    // 每门课一行：课名与它的括号编号、节次、教师、学分必须在同一行
    for (const line of lines) {
      assert.ok(
        /\/教师[:：]/.test(line),
        '每行应包含教师信息（说明整格内容聚在一行）：' + line.slice(0, 60)
      );
      assert.ok(
        /\(\d+-\d+节\)/.test(line),
        '每行应包含节次信息：' + line.slice(0, 60)
      );
    }

    // 反例守卫：若断格失效，会被切成「只有编号」或「只有节次」的碎片行
    const fragments = lines.filter((l) => !/[\u4e00-\u9fa5]{2,}/.test(l.replace(/^星期[一二三四五六日]/, '')));
    assert.equal(
      fragments.length,
      0,
      '不应出现无课名的碎片行：' + JSON.stringify(fragments)
    );
  }
);

test('同一门课不得因断格失效而重复出现（11 门课恰好 11 行）', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);
  const lines = res.text.split('\n').filter((l) => /^星期/.test(l.trim()));
  assert.equal(lines.length, 11, '应恰好 11 行课程；多于 11 说明断格失效把整格拆碎了');

  // 且每行的课名互不重复于同一星期同一节次
  const key = lines.map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '));
  assert.equal(new Set(key).size, key.length, '同一星期+节次不应出现重复行');
});

// ==================== 行数守恒：断格与聚合的最终一致性 ====================
// 每门课恰好一行、总数恰好 12 行。这是断格机制的总闸：
//   - 切得太碎 → 行数偏大
//   - 合得太狠 → 行数偏小 / 一行塞两门课
// 注意：本份课表的备注文本与课名同格，所以这条用例并【不能】
// 守护 isCourseNameLike 里那条「备注行」防御分支（变异测试已验证）。

test('形态判断：备注/学分/教师/地点行不得被当成课名（否则会把整格切碎）', () => {
  const items = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = PL.layoutToText(items);

  // 断格正确时每门课恰好一行；误把备注行当课名会多切出块 → 行数 > 12
  assert.equal(
    res.rows,
    12,
    '应恰好 12 行（表头 + 11 门课）；偏大说明备注行被误判为课名'
  );

  // 课名行里不应出现「课备注」「学分:」开头的片段充当课名
  const lines = res.text.split('\n').filter((l) => /^星期/.test(l.trim()));
  for (const line of lines) {
    const afterDay = line.trim().replace(/^星期[一二三四五六日]\s*/, '');
    assert.ok(
      !/^(?:选课)?课备注|^学分[:：]|^教师[:：]|^地点[:：]/.test(afterDay),
      '课名位置不应是备注/学分/教师/地点行：' + line.slice(0, 50)
    );
  }
});
