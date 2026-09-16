/**
 * 「旋转绘制的中文课表 PDF」端到端回归测试
 *
 * ==================== 这个文件守护什么 ====================
 * 线上真实课表（上海大学教务导出）失败链条有【两段】，缺任何一段都复现不出来：
 *
 *   ① 字体是 Type0 + CMap 编码（STSong-Light / UniGB-UCS2-H，未嵌入）
 *      → pdf.js 缺 cMapUrl 时返回 0 个 item。
 *      由 tests/pdf-extraction.test.mjs + fixtures/cjk-cmap.pdf 守护。
 *
 *   ② 内容流首行是 `0 1 -1 0 595 0 cm`，即「在竖版页面里旋转 90° 绘制横版表格」。
 *      pdf.js 把这个矩阵烘焙进【每一个】item.transform（形如 [0,size,-size,0,e,f]），
 *      早期 normalizeItems「一见旋转就丢弃」→ 整页清空 → 一门课都解析不出来。
 *      由本文件 + fixtures/cjk-timetable-rotated.pdf 守护。
 *
 * ==================== 为什么第一版夹具是废的 ====================
 * 第一版夹具只写了页级 `/Rotate 90`，没有那条 `cm`。实测 pdf.js
 * 对页级 /Rotate【不改变文字坐标】（它只影响 viewport 渲染），
 * 拿到的 transform 仍是水平的 —— 夹具「看起来很像」，却完全触发不了那段逻辑，
 * 测试全绿而线上照样失败。**夹具不 representative 比没有夹具更糟**，
 * 所以本文件第 1、2 项测试专门盯着「夹具本身是否真的复现了旋转」。
 *
 * 另外，这个夹具还顺手抓出了一个与旋转无关的真 Bug：
 * 「线性代数」这类 4 字、又不带常见课名词尾的课名，会被 parser 的
 * 「详情行互换」逻辑当成人名，课名被上一门课顶替。详见 parser.test.mjs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WEB = join(ROOT, 'web');
const CMAPS = join(WEB, 'cmaps') + '/';
const FIXTURE = join(HERE, 'fixtures', 'cjk-timetable-rotated.pdf');

const PDFJS = (() => {
  try {
    return require('pdfjs-dist/legacy/build/pdf.js');
  } catch {
    return null;
  }
})();
const PL = require('../web/js/pdf-layout.js');
const CP = require('../web/js/parser.js');

const skip = PDFJS ? false : '未安装 pdfjs-dist（可选依赖），跳过 PDF 提取层测试';

/** 夹具写入的 12 门课：[星期, 课名, 教师, 起始节, 结束节]
 *  星期由所在列决定：COL_DAY 的 1..4 列 = 星期一..星期四，
 *  所以 (行, 列) 里的「列」就是星期几。必须与 make-rotated-timetable-fixture.py
 *  的 EXPECTED 保持一致（曾把「体育」错写成星期 1，实际它在第 4 列）。 */
const EXPECTED = [
  [1, '程序设计基础', '张三', 1, 2],
  [2, '学术英语', '李四', 1, 2],
  [3, '高等数学 B', '王五', 1, 2],
  [4, '体育', '赵六', 1, 2],
  [1, '信息与人工智能基础', '孙七', 3, 4],
  [3, '中国近现代史纲要', '周八', 3, 4],
  [2, '大学英语(听说)', '吴九', 5, 6],
  [4, '线性代数', '郑十', 5, 6],
  [1, '数据结构', '冯一', 7, 8],
  [2, '概率论与数理统计', '陈二', 7, 8],
  [3, '计算机网络', '褚三', 7, 8],
  [4, '思想道德与法治', '卫四', 7, 8]
];

const DAY = ['', '一', '二', '三', '四', '五', '六', '日'];

/** 按夹具写入顺序排序，便于与 EXPECTED 逐条比对 */
function signature(items) {
  return items.map((c) => [c.day, c.name, c.teacher || '', c.startSection, c.endSection]);
}

/** 走真实链路：pdf.js 提取 → 版面还原 → 文本解析 */
async function runPipeline() {
  const data = new Uint8Array(readFileSync(FIXTURE));
  const doc = await PDFJS.getDocument({
    data,
    cMapUrl: CMAPS,
    cMapPacked: true
  }).promise;
  const raw = [];
  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    raw.push(...tc.items);
    pageTexts.push(PL.layoutToText(tc.items).text);
  }
  await doc.destroy();
  const text = pageTexts.join('\n');
  return { raw, text, parsed: CP.parseScheduleText(text) };
}

// ==================== 夹具自身：必须真的复现「旋转」 ====================

test('夹具：旋转课表 PDF 存在且非空', () => {
  assert.ok(
    existsSync(FIXTURE),
    `缺少夹具 ${FIXTURE}；用 tools/make-rotated-timetable-fixture.py 生成`
  );
  assert.ok(readFileSync(FIXTURE).length > 1000, '夹具文件过小，可能生成失败');
});

test('夹具：源文件必须同时含页级 /Rotate 90 与内容流旋转矩阵', () => {
  // 这两条是「夹具 representative」的硬保证。
  // 若有人重新生成夹具时把 `0 1 -1 0 595 0 cm` 弄丢了，
  // 整套旋转回归测试会静默失效（第一版夹具就是这么废掉的），所以在这里拦住。
  const raw = readFileSync(FIXTURE, 'latin1');
  assert.ok(/\/Rotate\s+90/.test(raw), '夹具必须带页级 /Rotate 90');
  assert.ok(
    raw.includes('0 1 -1 0 595 0 cm'),
    '夹具内容流首行必须是 `0 1 -1 0 595 0 cm` —— ' +
      '这才是让 pdf.js 输出旋转坐标的真源头；页级 /Rotate 不改变文字坐标。'
  );
});

test(
  '夹具：pdf.js 输出的每个片段都带旋转分量（证明确实复现了线上条件）',
  { skip },
  async () => {
    const { raw } = await runPipeline();
    const nonEmpty = raw.filter((i) => i.str && i.str.trim());
    assert.ok(nonEmpty.length > 0, '应提取到文字片段');
    // 旋转后的线性部分是 [0, s, -s, 0]，即 b、c 分量非零
    const rotated = nonEmpty.filter(
      (i) => Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01
    );
    assert.equal(
      rotated.length,
      nonEmpty.length,
      '本夹具的全部片段都应是旋转的（b/c 分量非零）。' +
        '若有片段不旋转，说明夹具已不再复现线上条件，测试将失去意义。'
    );
  }
);

// ==================== 根因 ②：反旋转 ====================

test('根因：未扶正时整页片段会被 normalizeItems 全部丢弃（线上「一门课都解析不出」）', () => {
  // 直接喂「原始旋转片段」给 normalizeItems 的等价输入，验证 rectifyItems 的必要性。
  const rotated = [
    { str: '星期一', width: 36, height: 12, transform: [0, 12, -12, 0, 74, 170] },
    { str: '高等数学', width: 36, height: 9, transform: [0, 9, -9, 0, 95, 430] }
  ];
  // 绕过 rectifyItems 的「过滤」路径：把旋转片段直接交给过滤判据
  const kept = rotated.filter(
    (it) => !(Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01)
  );
  assert.equal(kept.length, 0, '旋转片段在「无扶正」的过滤下应当被全部丢弃');
});

test('修复：rectifyItems 把整页扶正 —— 不再有旋转分量，且横向几何关系还原', () => {
  const items = [
    { str: '星期一', width: 36, height: 12, transform: [0, 12, -12, 0, 74, 170] },
    { str: '星期二', width: 36, height: 12, transform: [0, 12, -12, 0, 74, 300] },
    { str: '高等数学', width: 36, height: 9, transform: [0, 9, -9, 0, 95, 430] },
    { str: '程序设计基础', width: 54, height: 9, transform: [0, 9, -9, 0, 95, 170] }
  ];
  const out = PL.rectifyItems(items);
  for (const it of out) {
    assert.equal(it.transform[1], 0, '扶正后 b 分量应为 0');
    assert.equal(it.transform[2], 0, '扶正后 c 分量应为 0');
    assert.ok(Math.abs(it.transform[0]) > 0.01, '扶正后 a 分量应为字号（正数）');
  }
  // 横向相对关系必须保留：星期一/程序设计基础 同列（同为 170），星期二在 300
  const byStr = {};
  for (const it of out) byStr[it.str] = it.transform[4];
  assert.equal(byStr['星期一'], byStr['程序设计基础'], '同一列的两段应还原到同一 x');
  assert.ok(byStr['星期二'] > byStr['星期一'], '星期二列应在星期一列右侧');
  assert.ok(byStr['高等数学'] > byStr['星期二'] - 1, '高等数学应落在更右的列');
});

test('修复：已经是正立的页面，rectifyItems 原样返回（不改变既有行为）', () => {
  const items = [
    { str: '星期一', width: 36, height: 12, transform: [12, 0, 0, 12, 74, 170] }
  ];
  assert.equal(PL.rectifyItems(items), items, '正立页面必须原样返回同一个引用');
});

// ==================== 端到端：提取 → 版面还原 → 解析 ====================

test(
  '端到端：旋转课表 PDF 必须完整解析出 12 门课程（真实链路）',
  { skip },
  async () => {
    const { parsed, text } = await runPipeline();
    assert.equal(
      parsed.items.length,
      EXPECTED.length,
      `应解析出 ${EXPECTED.length} 门课，实际 ${parsed.items.length} 门。\n` +
        `解析文本：\n${text}`
    );
    assert.deepEqual(parsed.warnings, [], '不应有任何告警');
    // 顺序无关比对：按 (星期, 节次, 课名) 排序后逐条对齐
    const key = (r) => `${r[0]}|${r[3]}-${r[4]}|${r[1]}`;
    assert.deepEqual(
      signature(parsed.items).sort((a, b) => (key(a) < key(b) ? -1 : 1)),
      EXPECTED.slice().sort((a, b) => (key(a) < key(b) ? -1 : 1))
    );
  }
);

test(
  '端到端：版面还原必须识别为表格（5 列），且表头四种星期都被认出',
  { skip },
  async () => {
    const data = new Uint8Array(readFileSync(FIXTURE));
    const doc = await PDFJS.getDocument({ data, cMapUrl: CMAPS, cMapPacked: true }).promise;
    const tc = await (await doc.getPage(1)).getTextContent();
    await doc.destroy();

    const out = PL.layoutToText(tc.items);
    assert.equal(out.isTable, true, '应被识别为表格');
    assert.equal(out.cols, 5, '应为节次列 + 4 个星期列 = 5 列');

    // 逐级验证列识别：findDayColumns 需要至少认到 4 个星期
    const norm = PL.normalizeItems(tc.items);
    const rows = PL.groupRows(norm);
    const rc = rows.map(PL.splitCells);
    const meaningful = rc.filter((cs) => cs.length >= 2);
    const cols = PL.findColumns(meaningful, rows.length);
    const found = PL.findDayColumns(rc, cols);
    assert.ok(found.rowIndex >= 0, '必须找到表头行');
    assert.deepEqual(found.map, { 1: 1, 2: 2, 3: 3, 4: 4 }, '四种星期必须各自归到独立列');
  }
);

test(
  '端到端：课程必须按「星期」正确归位（不得整列串台）',
  { skip },
  async () => {
    const { parsed } = await runPipeline();
    // 每个星期都必须有自己的课，且课名不重复落在错误的日子上
    const byDay = {};
    for (const c of parsed.items) (byDay[c.day] = byDay[c.day] || []).push(c.name);
    assert.deepEqual(Object.keys(byDay).sort(), ['1', '2', '3', '4'], '四个星期都应有课');
    assert.deepEqual(
      byDay[4].sort(),
      ['体育', '线性代数', '思想道德与法治'].sort(),
      '星期四的课不得被其它天顶替（「线性代数」曾被上一条的「体育」覆盖）'
    );
    assert.ok(!byDay[1].includes('线性代数'), '「线性代数」不应出现在星期一');
  }
);

test(
  '端到端：课名/教师/周次都要正确（含 体育(1)(GBK…) → 体育、高等数学+B(1)(…) → 高等数学 B）',
  { skip },
  async () => {
    const { parsed } = await runPipeline();
    const find = (day, name) =>
      parsed.items.find((c) => c.day === day && c.name === name);
    assert.ok(find(4, '体育'), '「体育(1)(GBK2800002)」应被剥成「体育」');
    assert.equal(find(4, '体育').teacher, '赵六');
    assert.ok(find(3, '高等数学 B'), '「高等数学」+「B(1)(GBK0101003)」应拼成「高等数学 B」');
    assert.ok(find(2, '大学英语(听说)'), '汉字括号属课名，不得被当作编号剥离');
    for (const c of parsed.items) {
      assert.equal(c.weeks && c.weeks.length, 16, `《${c.name}》周次应为 1-16 共 16 周`);
    }
  }
);

// ==================== 源码守护 ====================

test('源码：normalizeItems 必须调用 rectifyItems（删掉它整页会被清空）', () => {
  const src = readFileSync(join(WEB, 'js', 'pdf-layout.js'), 'utf8');
  const body = /function normalizeItems\s*\(items\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(body, '未找到 normalizeItems，源码结构可能已变化');
  assert.ok(
    /rectifyItems\(items\)/.test(body[1]),
    'normalizeItems 必须先调用 rectifyItems 把整页扶正 —— ' +
      '否则带 cm 旋转的 PDF（本案例）会整页被清空'
  );
});
