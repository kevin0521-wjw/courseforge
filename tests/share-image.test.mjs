/**
 * 课表分享图的护栏。
 *
 * 这个功能的验收标准是「**导出的那张图看着对**」—— 而这种标准最容易糊弄过去：
 * 代码不报错、返回了一张 1080×1446 的图、打开一看课程挤在一起或者课名被切掉一半。
 * 所以这里不去测「函数跑了没」，而是把「看着对」拆成可断言的不变量：
 *
 *   · 任何绘制指令都不能跑到画布外面去（坐标有 NaN 是最典型的溃败）
 *   · 每门该出现的课都要出现，且**同一天重叠的两门课必须分到不同泳道**（否则叠成一坨）
 *   · 同一泳道里纵向不能互相盖住
 *   · 文字必须按可用宽度截断（宁可显示「高等数学…」，也不能溢出格子盖到隔壁）
 *   · 深色主题要真的是深色底（曾经很容易「切换了但图没变」）
 *
 * 三层是分开测的：buildLayout 纯数据断言、paint 用记录型 mock ctx 断言，
 * 这样出问题时能立刻分清是「算错了」还是「画错了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CF from '../web/js/core.js';
import SI from '../web/js/share-image.js';

// ---------------------------------------------------------------- 夹具

const SETTINGS = CF.normalizeSettings({
  totalWeeks: 16, sectionsPerDay: 12, semesterStart: '2026-09-07'
});

function course(over = {}) {
  return Object.assign({
    id: 'c' + Math.random().toString(36).slice(2, 8),
    name: '高等数学', teacher: '王老师', location: '教学楼A301',
    day: 1, startSection: 1, endSection: 2,
    weeks: CF.generateWeeks(1, 16, 'all', 16), color: 'blue'
  }, over);
}

/** 固定夹具：不依赖 buildSampleCourses（那个是给界面用的，改动会影响测试） */
function fixture() {
  return [
    course({ id: 'a', name: '高等数学', day: 1, startSection: 1, endSection: 2, color: 'blue' }),
    course({ id: 'b', name: '大学英语', day: 2, startSection: 3, endSection: 4, color: 'green' }),
    course({ id: 'c', name: '数据结构', day: 3, startSection: 5, endSection: 6, color: 'purple' }),
    course({ id: 'd', name: '大学体育', day: 4, startSection: 9, endSection: 10, color: 'orange' }),
    // 只在前 8 周上：用来验证「本周视图」的过滤
    course({ id: 'e', name: '程序设计基础', day: 5, startSection: 3, endSection: 4,
      weeks: CF.generateWeeks(1, 8, 'all', 16), color: 'red' })
  ];
}

function build(over = {}) {
  return SI.buildLayout(Object.assign({
    courses: fixture(), settings: SETTINGS, semesterName: '2026-2027 学年 第一学期',
    week: 3, scope: 'current', theme: 'light', today: 3,
    measure: SI.estimateWidth // 固定量法，保证测试与字体环境无关
  }, over));
}

/** 记录型 2D context：只记调用，不真画 */
function mockCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    beginPath() { calls.push(['beginPath']); },
    rect(...a) { calls.push(['rect', ...a]); },
    moveTo(...a) { calls.push(['moveTo', ...a]); },
    lineTo(...a) { calls.push(['lineTo', ...a]); },
    quadraticCurveTo(...a) { calls.push(['quadraticCurveTo', ...a]); },
    closePath() { calls.push(['closePath']); },
    fill() { calls.push(['fill', this.fillStyle]); },
    stroke() { calls.push(['stroke', this.strokeStyle]); },
    fillText(...a) { calls.push(['fillText', ...a, this.font, this.fillStyle]); },
    fillRect(...a) { calls.push(['fillRect', ...a]); }
  };
}

/** 文本指令占用的横向区间（要考虑对齐方式，否则右对齐的页脚会被误判越界） */
function textSpan(op) {
  const w = op.maxWidth > 0 && SI.estimateWidth(op.text, op.size) > op.maxWidth
    ? op.maxWidth
    : SI.estimateWidth(op.text, op.size);
  if (op.align === 'center') return [op.x - w / 2, op.x + w / 2];
  if (op.align === 'right') return [op.x - w, op.x];
  return [op.x, op.x + w];
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- 布局不变量

test('所有绘制指令都在画布内，且没有 NaN 坐标', () => {
  const L = build();
  assert.ok(L.width > 0 && L.height > 0 && isNum(L.width) && isNum(L.height));
  assert.ok(L.ops.length > 30, `指令太少（${L.ops.length}），布局可能整体塌了`);

  const bad = [];
  for (const op of L.ops) {
    if (op.type === 'rect') {
      if (![op.x, op.y, op.w, op.h].every(isNum)) bad.push(['rect 非数字', op]);
      else if (op.w <= 0 || op.h <= 0) bad.push(['rect 尺寸非正', op]);
      else if (op.x < -0.5 || op.y < -0.5 || op.x + op.w > L.width + 0.5 || op.y + op.h > L.height + 0.5) {
        bad.push(['rect 越界', op]);
      }
    } else if (op.type === 'line') {
      if (![op.x1, op.y1, op.x2, op.y2].every(isNum)) bad.push(['line 非数字', op]);
      else if (Math.min(op.x1, op.x2) < -0.5 || Math.max(op.x1, op.x2) > L.width + 0.5) bad.push(['line 横向越界', op]);
      else if (Math.min(op.y1, op.y2) < -0.5 || Math.max(op.y1, op.y2) > L.height + 0.5) bad.push(['line 纵向越界', op]);
    } else if (op.type === 'text') {
      if (![op.x, op.y].every(isNum)) bad.push(['text 非数字', op]);
      else {
        const [x0, x1] = textSpan(op);
        if (x0 < -0.5 || x1 > L.width + 0.5) bad.push(['text 横向越界', op, x0, x1]);
        if (op.y < 0 || op.y > L.height) bad.push(['text 纵向越界', op]);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 4), [], `${bad.length} 条指令越界或含 NaN`);
});

test('本周视图：覆盖本周的课都在，不覆盖的一门都不画', () => {
  const L = build({ scope: 'current', week: 3 });
  const ids = L.blocks.map((b) => b.courseId).sort();
  // 第 3 周：a~d 都覆盖（1-16 周），e 只到第 8 周也覆盖
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);

  const L9 = build({ scope: 'current', week: 9 });
  assert.deepEqual(L9.blocks.map((b) => b.courseId).sort(), ['a', 'b', 'c', 'd'],
    '第 9 周不该再出现只上到第 8 周的课');
  assert.equal(L9.meta.hiddenByWeek, 1, '被周次过滤掉的课要计数，页脚要说明');

  const foot = L9.ops.filter((o) => o.type === 'text' && o.text.includes('不在本周'));
  assert.equal(foot.length, 1, '页脚必须说明「另有 N 门不在本周」，否则用户以为课丢了');
});

test('整学期视图不过滤周次，并标出每门课的周次', () => {
  const L = build({ scope: 'all' });
  assert.equal(L.blocks.length, 5, '整学期视图应包含全部课程');
  assert.equal(L.meta.hiddenByWeek, 0);

  // weeksText 的输出形如 "1-16 周" / "单周"（中间那个空格是它自己的格式）
  const weekTexts = L.ops.filter((o) => o.type === 'text' && /^\d+(-\d+)?\s*周|单周|双周/.test(o.text));
  assert.ok(weekTexts.length >= 5, `课块上应带上周次说明，实际只有 ${weekTexts.length} 条`);
  // 顺手钉住「不要重复加周」这个刚修掉的 bug：文案里不能出现「周周」
  assert.deepEqual(L.ops.filter((o) => o.type === 'text' && o.text.includes('周周')).map((o) => o.text), [],
    '周次文案出现了「周周」，说明又在 weeksText 的结果上补了一个「周」');
});

test('同一天重叠的两门课必须分到不同泳道，且横向不重叠', () => {
  const courses = [
    course({ id: 'x', name: '冲突A', day: 1, startSection: 1, endSection: 2, color: 'blue' }),
    course({ id: 'y', name: '冲突B', day: 1, startSection: 2, endSection: 3, color: 'green' }),
    course({ id: 'z', name: '不冲突', day: 1, startSection: 5, endSection: 6, color: 'red' })
  ];
  const L = SI.buildLayout({
    courses, settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });

  const bx = L.blocks.find((b) => b.courseId === 'x');
  const by = L.blocks.find((b) => b.courseId === 'y');
  const bz = L.blocks.find((b) => b.courseId === 'z');

  assert.notEqual(bx.lane, by.lane, '重叠的两门课在同一泳道会叠成一坨，分不清谁是谁');
  const [lx0, lx1] = [Math.min(bx.x, by.x), Math.max(bx.x, by.x)];
  assert.ok(lx1 >= lx0 + bx.w - 0.5, '两个泳道的横向区间不该重合');
  assert.equal(bz.lane, 0, '不冲突的课应该留在第一条泳道（不浪费横向空间）');
  assert.equal(bx.lane, 0, '先排的课留在第一条泳道');
});

test('同一泳道里纵向不重叠（课块没有互相盖住）', () => {
  const courses = [
    course({ id: 'p', name: '第一节', day: 1, startSection: 1, endSection: 2, color: 'blue' }),
    course({ id: 'q', name: '第二节', day: 1, startSection: 3, endSection: 4, color: 'green' }),
    course({ id: 'r', name: '第三节', day: 1, startSection: 5, endSection: 6, color: 'red' })
  ];
  const L = SI.buildLayout({
    courses, settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });
  const sorted = L.blocks.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h - 0.5,
      `${sorted[i].name} 盖住了 ${sorted[i - 1].name}`);
  }
});

test('课块必须落在自己那天的列里，且落在画布网格内', () => {
  const L = build();
  const meta = L.meta;
  const colW = (L.width - SI.MARGIN * 2 - SI.TIME_COL_W) / meta.days.length;
  for (const b of L.blocks) {
    const idx = meta.days.indexOf(b.day);
    assert.ok(idx >= 0, `课块落在没显示的那一天（day=${b.day}）`);
    const colX = SI.MARGIN + SI.TIME_COL_W + idx * colW;
    assert.ok(b.x >= colX - 0.5 && b.x + b.w <= colX + colW + 0.5,
      `${b.name} 超出了周${'一二三四五六日'[b.day - 1]}那一列的范围`);
    // 课块的纵向范围要跟节次对上，否则「第 5 节」会画到别的地方
    const rowTop = SI.MARGIN + 96 + SI.HEAD_ROW_H + (b.start - 1) * SI.ROW_H;
    assert.ok(b.y >= rowTop - 0.5 && b.y < rowTop + SI.ROW_H, `${b.name} 的纵向位置与节次不符`);
  }
});

/** 某个课块里的课名文字指令。块内唯一的粗体文字就是课名，可能折成 1~2 行。 */
function nameOpsOf(L, courseId) {
  const b = L.blocks.find((x) => x.courseId === courseId);
  assert.ok(b, `找不到课块 ${courseId}`);
  return L.ops.filter((o) => o.type === 'text' && o.weight === 'bold' && o.maxWidth > 0 &&
    o.x >= b.x - 0.5 && o.x <= b.x + b.w && o.y >= b.y && o.y <= b.y + b.h);
}

test('超长课名要折行 / 截断，且每一行都不超过可用宽度', () => {
  const long = '马克思主义基本原理概论（含社会实践环节与专题研讨）';
  const courses = [course({ id: 'long', name: long, day: 1, startSection: 1, endSection: 2 })];
  const L = SI.buildLayout({
    courses, settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });

  const nameOps = nameOpsOf(L, 'long');
  assert.ok(nameOps.length >= 1, '找不到课名的文字指令');
  assert.ok(nameOps.length <= 2, `课名最多折 2 行，实际 ${nameOps.length} 行`);

  for (const op of nameOps) {
    assert.ok(SI.estimateWidth(op.text, op.size) <= op.maxWidth + 0.5,
      `「${op.text}」仍然超出可用宽度 ${op.maxWidth}`);
  }
  const joined = nameOps.map((o) => o.text).join('');
  assert.notEqual(joined, long, '这么长的课名必须被截断');
  assert.ok(nameOps[nameOps.length - 1].text.endsWith('…'),
    `最后一行应以省略号结尾，实际：${nameOps[nameOps.length - 1].text}`);
  if (nameOps.length === 2) {
    assert.ok(nameOps[1].y - nameOps[0].y >= nameOps[0].size,
      '两行课名挨得比字号还近，会糊成一块');
  }
});

test('中等长度的课名：宁可缩小字号也要让整名可见（不许出现「数据结…」）', () => {
  // 7 天摊在 1080px 上时单列可用宽度只有 ~89px，19px 字下只能放 4 个汉字 ——
  // 这正是「数据结构与算法分析」被截成「数据结…」的原因，而课名是图上最重要的信息。
  const courses = [course({ id: 'mid', name: '数据结构与算法分析', day: 1, startSection: 1, endSection: 2 })];
  const L = SI.buildLayout({
    courses, settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });
  const ops = nameOpsOf(L, 'mid');
  assert.ok(ops.length > 0, '找不到课名的文字指令');
  assert.equal(ops.map((o) => o.text).join(''), '数据结构与算法分析',
    `这一档长度的课名应当完整显示，而不是截断成「${ops.map((o) => o.text).join('')}」`);
  assert.ok(ops.length <= 2, '课名最多折两行');
  assert.ok(ops.every((o) => SI.estimateWidth(o.text, o.size) <= o.maxWidth + 0.5),
    '为了塞下全名而让文字超出了可用宽度');
  // 折行是为了放下全名，不是为了把字号无脑缩小
  assert.equal(ops[0].size, 17, '19px 两行放不下时才该降到 17px');

  // 短课名不该被顺手缩字号（一行就放得下，没必要更小）
  const L2 = SI.buildLayout({
    courses: [course({ id: 's', name: '体育', day: 1, startSection: 1, endSection: 2 })],
    settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });
  const short = nameOpsOf(L2, 's');
  assert.equal(short.length, 1);
  assert.equal(short[0].size, 19, '短课名不该被降字号');
  assert.equal(short[0].y, ops[0].y, '第一行课名的基线位置不该因为折行逻辑而改变');
});

test('wrapText：按字符折行，行数用尽时最后一行带省略号', () => {
  const m = (t, s) => SI.estimateWidth(t, s);
  assert.deepEqual(SI.wrapText('短', 20, 100, m, 2), { lines: ['短'], truncated: false });
  assert.deepEqual(SI.wrapText('', 20, 100, m, 2), { lines: [], truncated: false });

  // 每行最多 5 个汉字（20px，宽 100）
  const r = SI.wrapText('十个汉字刚刚好呢另说', 20, 100, m, 2);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines, ['十个汉字刚', '刚好呢另说']);
  assert.equal(r.truncated, false, '两行放得下就不该截断');

  const r2 = SI.wrapText('这些字两行绝对放不下还会多出好多个', 20, 100, m, 2);
  assert.equal(r2.lines.length, 2);
  assert.equal(r2.truncated, true);
  assert.ok(r2.lines[1].endsWith('…'), `末行应截断：${r2.lines[1]}`);
  assert.equal(r2.lines[0], '这些字两行', '第一行不该被后来的截断影响');
  assert.ok(r2.lines[1].startsWith('绝对放不'), '截断行必须从上一行之后接着排（不能把已排好的字丢掉）');

  // 只给一行时：折行逻辑不能把第一个字弄丢（第一版就是写成 s.slice(i)，短名会少头一个字）
  const r3 = SI.wrapText('这些字一行放不下', 20, 100, m, 1);
  assert.equal(r3.lines.length, 1);
  assert.ok(r3.lines[0].startsWith('这些字'), `单行截断丢了开头的字：${r3.lines[0]}`);
  assert.ok(m(r3.lines[0], 20) <= 100);
});

test('fitName：能在降档字号里放下就用小字号，放不下才截断', () => {
  const m = (t, s) => SI.estimateWidth(t, s);
  // 宽 100、19px → 每行 5 字 → 两行正好放下全名，不必降档
  const roomy = SI.fitName('数据结构与算法分析', 100, 19, m, 2);
  assert.equal(roomy.size, 19, '两行就放得下时不该降字号');
  assert.deepEqual(roomy.lines, ['数据结构与', '算法分析']);

  // 宽 90、19px → 每行 4 字 → 要 3 行；降到 17px 后 5 字/行 → 两行放下
  const narrow = SI.fitName('数据结构与算法分析', 90, 19, m, 2);
  assert.equal(narrow.size, 17, '应当选「能放下整名」的那一档最大字号');
  assert.equal(narrow.lines.join(''), '数据结构与算法分析');
  assert.ok(narrow.lines.every((l) => m(l, narrow.size) <= 90));

  // 短名字一行就放下，不该降档
  assert.deepEqual(SI.fitName('体育', 100, 19, m, 2), { size: 19, lines: ['体育'] });

  // 窄到极限时必须截断，且不许超宽、不许出现空行
  const tiny = SI.fitName('马克思主义基本原理概论', 40, 19, m, 2);
  assert.equal(tiny.size, 14, '放不下时应在末尾档（14px）截断');
  assert.ok(tiny.lines.every((l) => l && m(l, 14) <= 40), '截断后仍超宽或出现空行');
  assert.ok(tiny.lines[tiny.lines.length - 1].endsWith('…'));
});

test('周末开关生效：关掉后只有 5 列，且表头不出现周六周日', () => {
  const L = build({ showWeekend: false });
  assert.deepEqual(L.meta.days, [1, 2, 3, 4, 5]);
  const headers = L.ops.filter((o) => o.type === 'text' && SI.WEEKDAY.includes(o.text));
  assert.deepEqual(headers.map((h) => h.text), ['周一', '周二', '周三', '周四', '周五']);

  const weekendCourse = [course({ id: 'sat', name: '周末选修', day: 6, startSection: 1, endSection: 2 })];
  const L2 = SI.buildLayout({
    courses: weekendCourse, settings: SETTINGS, week: 3, scope: 'current', showWeekend: false,
    measure: SI.estimateWidth
  });
  assert.equal(L2.blocks.length, 0, '不显示周末时，周六的课不应被画出来（否则会画到画面外）');
});

test('节次超出当前作息的课不画，但也不能让整张图崩掉', () => {
  const courses = [
    course({ id: 'ok', day: 1, startSection: 1, endSection: 2 }),
    course({ id: 'over', name: '第 15 节的课', day: 1, startSection: 15, endSection: 16 })
  ];
  const L = SI.buildLayout({
    courses, settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });
  assert.deepEqual(L.blocks.map((b) => b.courseId), ['ok']);
  assert.equal(L.ops.length > 0, true);

  // 「画不出来」和「不算数」必须是同一件事 ——
  // 否则会出现页脚说「共 2 门课程」而图上只有 1 块，用户会以为课丢了。
  // （这条是变异测试抓出来的：只断言 blocks 内容时，把超界跳过删掉仍然全绿。）
  assert.equal(L.meta.courseCount, L.blocks.length,
    `meta.courseCount=${L.meta.courseCount} 与图上课块数 ${L.blocks.length} 不一致`);
  const foot = L.ops.find((o) => o.type === 'text' && /^共 \d+ 门课程/.test(o.text));
  assert.ok(foot, '找不到页脚的课程数文案');
  assert.equal(Number(/共 (\d+) 门课程/.exec(foot.text)[1]), L.blocks.length,
    `页脚写「${foot.text}」，但图上只有 ${L.blocks.length} 块课`);
});

test('深色主题真的换底色（不是切了开关但图没变）', () => {
  const light = build({ theme: 'light' });
  const dark = build({ theme: 'dark' });
  assert.notEqual(light.theme.bg, dark.theme.bg);
  assert.equal(light.ops[0].fill, light.theme.bg, '第一条指令应该是整张底');
  assert.equal(dark.ops[0].fill, dark.theme.bg);

  // 深色底必须比浅色底暗（用亮度粗判，避免有人把两个值写反）
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  };
  assert.ok(lum(dark.theme.bg) < lum(light.theme.bg), '深色主题的底色反而更亮，两个主题可能接反了');
});

test('今天那一列会被高亮，但只在看本周时高亮', () => {
  const withToday = build({ scope: 'current', today: 3, week: 3 });
  const highlight = withToday.ops.filter((o) => o.type === 'rect' && o.fill === SI.THEMES.light.today);
  assert.ok(highlight.length > 0, '本周视图里今天那一列应当有高亮底');

  const noToday = build({ scope: 'current', today: null, week: 3 });
  const h2 = noToday.ops.filter((o) => o.type === 'rect' && o.fill === SI.THEMES.light.today);
  assert.equal(h2.length, 0, '没传 today 时不该凭空高亮某一列');
});

// ---------------------------------------------------------------- 绘制层

test('paint 只按指令画：填充次数与文字次数对得上，且没有 NaN 传给 canvas', () => {
  const L = build();
  const ctx = mockCtx();
  const n = SI.paint(ctx, L);
  assert.equal(n, L.ops.length, 'paint 应逐条执行全部指令');

  const fills = ctx.calls.filter((c) => c[0] === 'fill');
  const texts = ctx.calls.filter((c) => c[0] === 'fillText');
  const rectOps = L.ops.filter((o) => o.type === 'rect').length;
  const textOps = L.ops.filter((o) => o.type === 'text').length;

  assert.equal(fills.length, rectOps, '矩形指令数与实际 fill 次数不一致');
  assert.equal(texts.length, textOps, '文字指令数与实际 fillText 次数不一致');
  assert.ok(fills.length >= L.blocks.length, '每个课块至少要有一次填充');

  for (const c of ctx.calls) {
    for (const v of c.slice(1)) {
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `画布收到了非有限数值：${JSON.stringify(c)}`);
      }
    }
  }
  // 字号必须带 px，漏了单位 canvas 会当成非法 font 整体忽略 → 文字全部不显示
  for (const c of texts) {
    const font = c[c.length - 2];
    assert.match(String(font), /\d+px/, `font 缺少 px 单位：${font}`);
  }
});

test('paint 对残缺输入是「什么都不画」而不是抛异常', () => {
  assert.equal(SI.paint(null, null), 0);
  assert.equal(SI.paint(mockCtx(), null), 0);
  assert.equal(SI.paint(mockCtx(), { ops: null }), 0);
});

test('圆角半径不会超过边长的一半（否则 path 会自交、画出奇怪的形状）', () => {
  const ctx = mockCtx();
  SI.roundRectPath(ctx, 0, 0, 20, 10, 99);
  const pts = ctx.calls.filter((c) => c[0] === 'quadraticCurveTo' || c[0] === 'lineTo');
  for (const p of pts) {
    assert.ok(p[1] >= -0.001 && p[1] <= 20.001, `路径 x 越界：${p}`);
    assert.ok(p[2] >= -0.001 && p[2] <= 10.001, `路径 y 越界：${p}`);
  }
  assert.equal(SI.roundRectPath(mockCtx(), 0, 0, 20, 10, 0) === undefined, true);
});

test('没有 document 时给出可读的报错，而不是 TypeError', () => {
  const L = build();
  assert.throws(() => SI.drawToCanvas(L, null), /document/);
  // 但传了假 document、拿不到 2d context 时也要说清是哪一步坏了
  const fakeDoc = { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };
  assert.throws(() => SI.drawToCanvas(L, fakeDoc), /Canvas 2D/);
});

// ---------------------------------------------------------------- 配色与文件名

test('配色表覆盖 core.js 的全部颜色，且 overrides 能覆盖', () => {
  const palette = SI.resolvePalette();
  for (const c of CF.COURSE_COLORS) {
    assert.ok(palette[c.key], `配色表漏了 ${c.key}（core.js 新增颜色后要能自动带上）`);
    assert.equal(palette[c.key].main, c.main);
  }
  const over = SI.resolvePalette({ blue: { main: '#111111' }, brandnew: { main: '#222222', bg: '#333333' } });
  assert.equal(over.blue.main, '#111111', 'overrides 没生效');
  assert.equal(over.blue.bg, palette.blue.bg, '只覆盖 main 时不该把 bg 弄丢');
  assert.equal(over.brandnew.main, '#222222', '未知 key 也要能补进来');

  // 未知颜色 key 的课程要能回落到默认色，而不是画出 undefined
  const L = SI.buildLayout({
    courses: [course({ id: 'weird', color: 'not-a-color', day: 1 })],
    settings: SETTINGS, week: 3, scope: 'current', measure: SI.estimateWidth
  });
  assert.equal(L.blocks.length, 1);
  assert.equal(L.blocks[0].color, 'blue', '非法颜色应回落到第一个预设色');
});

test('建议文件名：含学期名与范围、剔除非法字符、按天打戳', () => {
  const now = new Date(2026, 8, 18); // 2026-09-18
  const f1 = SI.suggestFileName(now, '2026-2027 学年 第一学期', 'current', 3);
  assert.match(f1, /\.png$/);
  assert.ok(f1.includes('20260918'), `文件名应带日期：${f1}`);
  assert.ok(f1.includes('第3周'), `本周视图应体现周次：${f1}`);
  assert.ok(!/[\\/:*?"<>|\s]/.test(f1), `文件名里不能有非法字符：${f1}`);

  const f2 = SI.suggestFileName(now, 'a/b:c*d?e', 'all', 1);
  assert.ok(!/[\\/:*?"<>|]/.test(f2), `学期名里的非法字符要被清掉：${f2}`);
  assert.ok(f2.includes('全部周次'));

  assert.ok(SI.suggestFileName(now, '', 'current', 0).includes('第1周'), '周次缺失时按第 1 周兜底');
});

/** 某个课块的底色（课块矩形 + 左侧色条是两条 rect，按宽度区分） */
function blockBgOf(L, block) {
  const op = L.ops.find((o) => o.type === 'rect' && o.fill !== undefined &&
    Math.abs(o.x - block.x) < 0.5 && Math.abs(o.y - block.y) < 0.5 &&
    Math.abs(o.w - block.w) < 0.5 && Math.abs(o.h - block.h) < 0.5);
  assert.ok(op, `找不到课块 ${block.name} 的底色指令`);
  return op.fill;
}

test('深色主题下课块的底色必须压暗 —— 否则课名是白底白字（真机上整片看不见）', () => {
  // 关键场景：页面是浅色主题，用户在分享弹窗里选「深色导出」。
  // 这时传进来的 palette 仍是浅色页面读到的 CSS 变量值（bg 是 #e8effd 这种浅色），
  // 而深色主题的文字色是近白色 #e6eaf2 → 课名完全消失。
  // 真机样图上就是这个现象：格子有色条、有地点、有教师，唯独课名没了。
  const L = build({ theme: 'dark' });
  assert.ok(L.blocks.length > 0);

  for (const b of L.blocks) {
    const bg = blockBgOf(L, b);
    const nameOp = nameOpsOf(L, b.courseId)[0];
    assert.ok(nameOp, `课块 ${b.name} 没有课名指令`);
    const gap = Math.abs(SI.relLum(bg) - SI.relLum(nameOp.color));
    assert.ok(gap >= 110,
      `深色主题下课块底色 ${bg} 与课名颜色 ${nameOp.color} 亮度只差 ${gap.toFixed(0)}，` +
      '课名会看不清（浅底白字）。底色应该被 darkenForTheme 压暗。');
    // 除了课名，地点/教师（muted 色）也不能糊在底色里
    const muted = L.ops.filter((o) => o.type === 'text' && o.color === L.theme.muted &&
      o.x >= b.x && o.x <= b.x + b.w && o.y >= b.y && o.y <= b.y + b.h);
    for (const m of muted) {
      assert.ok(Math.abs(SI.relLum(bg) - SI.relLum(m.color)) >= 70,
        `「${m.text}」的颜色 ${m.color} 与课块底色 ${bg} 太接近`);
    }
  }

  // 页面本来就是深色时，palette 里已经是暗底 —— 不该被二次压暗（否则会一路压到全黑）
  const cssDark = SI.resolvePalette({
    blue: { bg: '#1b2740', main: '#7aa5ff' }, green: { bg: '#14332a', main: '#45d69b' }
  });
  assert.equal(SI.darkenForTheme('#1b2740'), '#1b2740', '本来就是暗底不该再压');
  assert.equal(SI.darkenForTheme('#14332a'), '#14332a');
  const L3 = build({ theme: 'dark', palette: cssDark });
  assert.equal(blockBgOf(L3, L3.blocks[0]), '#1b2740',
    '页面已是深色主题时，课块底色应当原样使用 CSS 里的暗底值');
});

test('darkenForTheme：浅底压暗且保住色相，非法输入不崩', () => {
  const d = SI.darkenForTheme('#e8effd');
  assert.match(d, /^#[0-9a-f]{6}$/);
  assert.ok(SI.relLum(d) <= 90, `压暗后应该足够暗，实际亮度 ${SI.relLum(d).toFixed(0)}`);
  const h = SI.parseHex(d);
  assert.ok(h[2] > h[0], `浅蓝压暗后仍应偏蓝（色相丢失了）：${d}`);
  // 绿色系的色相也要保住（不能全压成灰）
  const g = SI.parseHex(SI.darkenForTheme('#e6f7ef'));
  assert.ok(g[1] > g[0] && g[1] > g[2], `浅绿压暗后仍应偏绿：${SI.darkenForTheme('#e6f7ef')}`);

  // 非法/缺省输入不该抛异常，也不该把颜色画没
  assert.equal(SI.darkenForTheme(''), '');
  assert.equal(SI.darkenForTheme('not-a-color'), 'not-a-color');
  assert.equal(SI.darkenForTheme(null), null);
  // 注意 'bad' 本身是合法的三位简写（#bbaadd）—— 别拿它当「非法值」的样本
  assert.deepEqual(SI.parseHex('bad'), [187, 170, 221]);
  assert.equal(SI.relLum('xyz'), 128, '解析不了的色值要给中间亮度，不能返回 NaN');
  assert.equal(SI.relLum(null), 128);
  assert.deepEqual(SI.parseHex('#abc'), [170, 187, 204], '三位简写要能展开');
  assert.equal(SI.parseHex('#abcde'), null, '五位不是合法色值');
  assert.equal(SI.toHex([300, -20, 128]), '#ff0080', '越界分量要夹到 0~255');
});

test('文字宽度估算：中文比西文宽，且能识别全角', () => {
  const size = 20;
  assert.ok(SI.estimateWidth('中', size) > SI.estimateWidth('a', size));
  assert.ok(Math.abs(SI.estimateWidth('中', size) - size) < 0.01, '汉字按一个字宽计');
  assert.ok(SI.estimateWidth('ａ', size) > SI.estimateWidth('a', size), '全角字母要按宽字符算');
  assert.equal(SI.estimateWidth('', size), 0);
});

test('fitText：放得下就原样返回，放不下才截断加省略号', () => {
  const m = (t, s) => SI.estimateWidth(t, s);
  assert.equal(SI.fitText('短', 20, 100, m), '短');
  assert.equal(SI.fitText('', 20, 100, m), '');
  assert.equal(SI.fitText(null, 20, 100, m), '');
  const out = SI.fitText('这是一个非常非常长的课程名称', 20, 60, m);
  assert.ok(out.endsWith('…'));
  assert.ok(m(out, 20) <= 60, '截断结果必须真的放得下');
  assert.equal(SI.fitText('字', 20, 2, m), '', '连省略号都放不下时返回空串，而不是超宽输出');
});
