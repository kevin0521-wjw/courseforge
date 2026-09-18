/**
 * 小组件渲染层测试（web/js/widget.js）
 *
 * 分三段：
 *   1. 纯文案函数 —— 倒计时单位换算、按 phase 出的短语。这块最容易出错，
 *      也最容易测（不需要 DOM、不需要真实时间）。
 *   2. render() —— 真给一份 DOM，断言写进去的文字。输入用真实的数据中枢产出，
 *      等于顺带把 store → render 这条链路验了一遍。
 *   3. boot() —— 按钮接线与订阅。小组件只有三个按钮，它们是它全部的人机接口。
 *
 * 关于时间：倒计时一律注入固定时刻（render 的第三个参数 / 自造的 computedAt），
 * 不依赖真实时钟 —— 否则测试会在「刚好跨过整分钟」时随机红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import W from '../web/js/widget.js';
import WS from '../desktop/widget-store.js';

const WIDGET_HTML = fileURLToPath(new URL('../web/widget.html', import.meta.url));

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch (e) {
  // jsdom 是开发依赖。缺了就跳过 DOM 部分，但要**显式说出来**，
  // 不能静默跳过 —— 静默跳过等于最值钱的那部分用例在 CI 里根本没跑。
  console.log('[widget-ui] 未安装 jsdom，跳过 DOM 相关用例');
}

// ==================== 1. 纯文案函数 ====================

test('remainText：按剩余时长选精度（一小时以上不说秒，十分钟内才给秒）', () => {
  assert.equal(W.remainText(2 * 3600 * 1000 + 15 * 60000), '2 小时 15 分钟');
  // 整点只说小时：把「1 小时 0 分钟」这种内部单位泄漏到界面上是难看的
  assert.equal(W.remainText(3600 * 1000), '1 小时');
  assert.equal(W.remainText(61 * 60000), '1 小时 1 分钟');
  assert.equal(W.remainText(59 * 60000), '59 分钟');
  assert.equal(W.remainText(45 * 60000), '45 分钟');
  assert.equal(W.remainText(10 * 60000), '10 分钟');
  assert.equal(W.remainText(9 * 60000 + 30000), '9 分 30 秒');
  assert.equal(W.remainText(42000), '42 秒');
  assert.equal(W.remainText(0), '0 秒');
  assert.equal(W.remainText(-5000), '0 秒', '已经开始了不该显示负数');
});

test('remainText：非法输入返回空串而不是 NaN 或 undefined', () => {
  for (const bad of [null, undefined, NaN, Infinity, 'x', {}]) {
    assert.equal(W.remainText(bad), '', '输入 ' + JSON.stringify(bad));
  }
});

test('headlineOf：每种 phase 都有自己的说法', () => {
  assert.equal(W.headlineOf({ phase: 'nodata' }), '还没有课表');
  assert.equal(W.headlineOf({ phase: 'beforeterm', daysToStart: 13 }), '距开学还有 13 天');
  assert.equal(W.headlineOf({ phase: 'beforeterm', daysToStart: 0 }), '学期即将开始');
  assert.equal(W.headlineOf({ phase: 'afterterm' }), '学期已结束');
  assert.equal(W.headlineOf({ phase: 'off' }), '今天放假');
  assert.equal(W.headlineOf({ phase: 'missing' }), '作息时间缺失');
  assert.equal(W.headlineOf({ phase: 'none' }), '接下来 14 天没有课');

  assert.equal(W.headlineOf({ phase: 'current' }, 25 * 60000), '正在上课 · 还有 25 分钟');
  assert.equal(W.headlineOf({ phase: 'current' }, -1000), '正在上课');

  assert.equal(W.headlineOf({ phase: 'next', next: { daysAhead: 0 } }, 42 * 60000),
    '还有 42 分钟上课');
  // 倒计时归零后仍在「已到点还没被判成正在上」的窗口里，措辞要成句
  assert.equal(W.headlineOf({ phase: 'next', next: { daysAhead: 0 } }, -1), '马上上课');
  assert.equal(W.headlineOf({ phase: 'next', next: { daysAhead: 1, dayLabel: '明天', startText: '08:00' } }, null),
    '明天 08:00 上课');
});

test('headlineOf：换 phase 不出错误文案（未知 phase 落到兜底而不是 undefined）', () => {
  const h = W.headlineOf({ phase: 'something-new' });
  assert.equal(typeof h, 'string');
  assert.ok(h.length > 0, '兜底也要是一句话，不能空着');
  assert.equal(W.headlineOf(null).length > 0, true);
});

test('subjectOf：放假时把「下一节课」顶上来（放假那天最想知道的就是下次什么时候上）', () => {
  const next = { name: '大学英语' };
  assert.equal(W.subjectOf({ phase: 'off', next: next }), next);
  assert.equal(W.subjectOf({ phase: 'off', next: null }), null);
  assert.equal(W.subjectOf({ phase: 'beforeterm', next: next }), null, '没开学时不摆课名');
  assert.equal(W.subjectOf({ phase: 'afterterm', next: next }), null);

  const cur = { name: '高等数学' };
  assert.equal(W.subjectOf({ phase: 'current', current: cur, next: next }), cur,
    '正在上课时应显示正在上的那节，而不是下一节');
  assert.equal(W.subjectOf({ phase: 'next', current: cur, next: next }), next);
});

test('nameOf：没有课可显示时给的是「用户该做什么」，不是空白', () => {
  assert.equal(W.nameOf({ phase: 'nodata' }), '打开完整课表导入');
  assert.equal(W.nameOf({ phase: 'missing' }), '请检查作息时间设置');
  assert.equal(W.nameOf({ phase: 'beforeterm', semesterName: '2026 秋季学期' }), '2026 秋季学期');
  assert.equal(W.nameOf({ phase: 'next', next: { name: '高等数学' } }), '高等数学');
});

test('metaOf：不是今天的课必须先说是哪天', () => {
  const item = {
    name: '大学英语', daysAhead: 1, dayLabel: '明天',
    rangeText: '08:00 ~ 09:40', sectionText: '第 1-2 节', location: '文荟楼 108'
  };
  assert.equal(W.metaOf({ phase: 'next', next: item }),
    '明天 · 08:00 ~ 09:40 · 第 1-2 节 · 文荟楼 108');

  const today = Object.assign({}, item, { daysAhead: 0, dayLabel: '今天' });
  assert.equal(W.metaOf({ phase: 'next', next: today }),
    '08:00 ~ 09:40 · 第 1-2 节 · 文荟楼 108',
    '今天的课不加「今天」，那是冗余信息');
});

test('metaOf：字段缺省时不留孤零零的分隔符', () => {
  const m = W.metaOf({ phase: 'next', next: { daysAhead: 0, rangeText: '08:00 ~ 09:40' } });
  assert.equal(m, '08:00 ~ 09:40');
  assert.ok(!/^\s*·|·\s*$/.test(m), '首尾不该有 ·');
});

test('todayTextOf：正在上课 / 今天有课 / 已上完 / 没课 四种说法', () => {
  assert.equal(W.todayTextOf({ hasData: true, phase: 'current', todayRemaining: 2 }), '今天还有 2 节');
  assert.equal(W.todayTextOf({ hasData: true, phase: 'current', todayRemaining: 0 }), '今天最后一节');
  assert.equal(W.todayTextOf({ hasData: true, phase: 'next', todayCount: 3, next: { daysAhead: 0 } }), '今天共 3 节');
  assert.equal(W.todayTextOf({ hasData: true, phase: 'next', todayCount: 2, next: { daysAhead: 3 } }), '今天的课已上完');
  assert.equal(W.todayTextOf({ hasData: true, phase: 'next', todayCount: 0 }), '今天没课');
  assert.equal(W.todayTextOf({ hasData: false }), '', '没有课表时不该谈今天的课');
});

// ==================== 倒计时锚点 ====================

test('anchorsOf：直接用主进程给的精确时刻当锚点', () => {
  const base = 1_800_000_000_000;
  const view = {
    phase: 'next', computedAt: base,
    next: { daysAhead: 0, startsInMin: 30, startAt: base + 30 * 60000 }
  };
  const a = W.anchorsOf(view);
  assert.equal(a.nextAt, base + 30 * 60000);
  assert.equal(a.curEndAt, null);
});

test('anchorsOf：用 startAt 而不是从取整到分钟的 startsInMin 反推', () => {
  // 主进程报的 startsInMin 会四舍五入到整分钟：真实开课在 59 分 15 秒后，
  // 它会说「60 分钟」。若渲染层拿 60 去反推锚点，倒计时就会整体偏 45 秒 ——
  // 而最后十分钟是显示到秒的，正好错在用户最在意的窗口里。
  const base = 1_800_000_000_000;
  const exact = base + 59 * 60000 + 15000;
  const a = W.anchorsOf({
    phase: 'next', computedAt: base,
    next: { daysAhead: 0, startsInMin: 60, startAt: exact }
  });
  assert.equal(a.nextAt, exact);
  assert.notEqual(a.nextAt, base + 60 * 60000, '不能落到「整 60 分钟」那个错值上');
});

test('anchorsOf：跨天的课不给锚点（否则会显示「还有 10080 分钟」）', () => {
  const a = W.anchorsOf({
    phase: 'next', computedAt: 1000,
    next: { daysAhead: 3, startsInMin: null, startAt: 999999999 }
  });
  assert.equal(a.nextAt, null, '再远的课也不该按分钟倒计时');
});

test('anchorsOf：正在上课时同时给出起止，进度条才能自己插值', () => {
  const base = 1_800_000_000_000;
  const start = base - 30 * 60000;
  const end = start + 155 * 60000;
  const a = W.anchorsOf({
    phase: 'current', computedAt: base,
    current: { endsInMin: 125, totalMin: 155, startAt: start, endAt: end }
  });
  assert.equal(a.curStartAt, start);
  assert.equal(a.curEndAt, end);
  assert.equal(a.curTotal, 155 * 60000);
});

test('anchorsOf：computedAt 缺失或时间字段倒置时不给锚点，不去猜', () => {
  assert.equal(W.anchorsOf({ phase: 'next', next: { daysAhead: 0, startAt: 1 } }).nextAt, null);
  // 起止倒置说明数据有问题：宁可不动进度条，也别画出一条反着走的
  const bad = W.anchorsOf({
    phase: 'current', computedAt: 1000,
    current: { startAt: 5000, endAt: 1000 }
  });
  assert.equal(bad.curEndAt, null);
  assert.equal(bad.curTotal, null);
});

test('percentOf：结果夹在 0~100，缺锚点时返回 null（交给调用方沿用旧值）', () => {
  const base = 1000 * 1000;
  const a = { curStartAt: base, curEndAt: base + 100000, curTotal: 100000 };
  assert.equal(W.percentOf(a, base), 0);
  assert.equal(W.percentOf(a, base + 50000), 50);
  assert.equal(W.percentOf(a, base + 100000), 100);
  assert.equal(W.percentOf(a, base + 999999), 100, '超出也要夹住，进度条不能溢出');
  assert.equal(W.percentOf(a, base - 50000), 0);

  assert.equal(W.percentOf(null, base), null);
  assert.equal(W.percentOf({ curStartAt: null, curTotal: null }, base), null);
});

// ==================== 2. render（真实 DOM） ====================

/** 用真实数据中枢造一份 view，保证 render 的输入与线上同源 */
function realView(courses, settings, now) {
  const s = WS.createWidgetStore();
  s.setWorkspace({
    activeId: 's1',
    semesters: [{
      id: 's1', name: '2026 秋季学期',
      settings: Object.assign({ semesterStart: '2026-09-14', totalWeeks: 20, days: {} }, settings || {}),
      courses: courses
    }]
  });
  return s.buildView(now);
}

const MATH = {
  id: 'c1', name: '高等数学', day: 3, startSection: 5, endSection: 6,
  weeks: [1, 2, 3, 4], location: '东区一教 305'
};

async function withDom(fn) {
  const { JSDOM: Dom } = await import('jsdom');
  const dom = new Dom(await readFile(WIDGET_HTML, 'utf8'));
  try {
    return await fn(dom.window.document, dom.window);
  } finally {
    // 不关窗口会让 node --test 迟迟不退出（打开过的窗口会被留着）
    dom.window.close();
  }
}

test('render：正在上课时把状态、课名、时间、进度都写进 DOM', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    const now = new Date(2026, 8, 16, 12, 30);
    const view = realView([MATH], null, now);
    W.render(doc, view, now.getTime());

    assert.equal(doc.getElementById('card').getAttribute('data-phase'), 'current');
    assert.equal(doc.getElementById('wName').textContent, '高等数学');
    assert.equal(doc.getElementById('wClock').textContent, '12:30');
    assert.match(doc.getElementById('wHeadline').textContent, /^正在上课 · 还有 /);
    assert.match(doc.getElementById('wMeta').textContent, /12:00 ~ 14:35/);
    assert.match(doc.getElementById('wMeta').textContent, /东区一教 305/);
    assert.equal(doc.getElementById('wToday').textContent, '今天最后一节');
    assert.equal(doc.getElementById('wDate').textContent, '9 月 16 日');
    // 进度条此时才有意义，宽度应是 30/155 ≈ 19%
    const w = doc.getElementById('wFill').style.width;
    assert.match(w, /^\d+%$/);
    assert.equal(parseInt(w, 10), 19);
  });
});

test('render：倒计时随注入的时刻变化（同一份 view，只改 now）', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    // 起点特意取 11:00:15 而不是 11:00:00 —— 距上课 59 分 45 秒。
    // 若取整点，30 秒后剩余会从 60 分整落到 59 分，分钟数必然跳变，
    // 那样测的是「边界」，不是「分钟粒度是否稳定」。要验后者就得落在分钟中段。
    const now = new Date(2026, 8, 16, 11, 0, 15);
    const view = realView([MATH], null, now);   // 距 12:00 还有 59 分 45 秒
    W.render(doc, view, now.getTime());
    assert.equal(doc.getElementById('wHeadline').textContent, '还有 59 分钟上课');

    // 30 秒后仍是同一分钟：界面上的数字不该每 30 秒抖一次
    W.render(doc, view, now.getTime() + 30000);   // 剩余 59 分 15 秒
    assert.equal(doc.getElementById('wHeadline').textContent, '还有 59 分钟上课');

    // 再过到 11:50:15：剩余 9 分 45 秒，进入「分 + 秒」精度
    W.render(doc, view, now.getTime() + 50 * 60000);
    assert.equal(doc.getElementById('wHeadline').textContent, '还有 9 分 45 秒上课');

    // 到点之后：不再说「0 分钟」
    W.render(doc, view, now.getTime() + 60 * 60000);
    assert.equal(doc.getElementById('wHeadline').textContent, '马上上课');
  });
});

test('render：放假时 phase 与文案都对，且把下次课顶上来', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    const now = new Date(2026, 8, 16, 11, 0);
    const eng = { id: 'c3', name: '大学英语', day: 4, startSection: 1, endSection: 2, weeks: [1, 2, 3, 4], location: '文荟楼 108' };
    const view = realView([MATH, eng], { days: { '2026-09-16': 'off' } }, now);
    W.render(doc, view, now.getTime());

    assert.equal(doc.getElementById('card').getAttribute('data-phase'), 'off');
    assert.equal(doc.getElementById('wHeadline').textContent, '今天放假');
    assert.equal(doc.getElementById('wName').textContent, '大学英语');
    assert.match(doc.getElementById('wMeta').textContent, /^明天 · /);
  });
});

test('render：未开学时显示距开学天数与开学日', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    const now = new Date(2026, 9, 1, 10, 0);   // 10-01，新学期 10-05 开学
    const s = WS.createWidgetStore();
    s.setWorkspace({
      activeId: 's1',
      semesters: [{
        id: 's1', name: '2026 秋季学期',
        settings: { semesterStart: '2026-10-05', totalWeeks: 20, days: {} },
        courses: [MATH]
      }]
    });
    W.render(doc, s.buildView(now), now.getTime());
    assert.equal(doc.getElementById('card').getAttribute('data-phase'), 'beforeterm');
    assert.equal(doc.getElementById('wHeadline').textContent, '距开学还有 4 天');
    assert.equal(doc.getElementById('wName').textContent, '2026 秋季学期');
    assert.equal(doc.getElementById('wMeta').textContent, '开学日 10 月 5 日');
  });
});

test('render：没有课表时给出可执行的指引，而不是空白卡片', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    W.render(doc, WS.createWidgetStore().buildView(new Date(2026, 8, 16, 10, 0)), Date.now());
    assert.equal(doc.getElementById('card').getAttribute('data-phase'), 'nodata');
    assert.equal(doc.getElementById('wHeadline').textContent, '还没有课表');
    assert.equal(doc.getElementById('wName').textContent, '打开完整课表导入');
    assert.equal(doc.getElementById('wToday').textContent, '');
    // 顶部仍要是应用名，不能空着让卡片看着像坏了
    assert.equal(doc.getElementById('wTerm').textContent, '课表工坊');
  });
});

test('render：view 为 null / 字段缺失时不抛，相位退到 nodata', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    for (const bad of [null, undefined, {}, { phase: 'current' }]) {
      W.render(doc, bad, Date.now());
      assert.equal(doc.getElementById('card').getAttribute('data-phase'),
        (bad && bad.phase) || 'nodata');
    }
    // DOM 里没有对应 id 时也要安静地跳过
    const empty = { getElementById: () => null };
    assert.doesNotThrow(() => W.render(empty, { phase: 'none' }, Date.now()));
    assert.doesNotThrow(() => W.render(null, { phase: 'none' }, Date.now()));
  });
});

test('render：顶部一行把周次、星期、学期名都带上', { skip: !JSDOM }, async () => {
  await withDom((doc) => {
    const now = new Date(2026, 8, 16, 11, 0);
    W.render(doc, realView([MATH], null, now), now.getTime());
    const t = doc.getElementById('wTerm').textContent;
    assert.equal(t, '第 1 周 · 周三 · 2026 秋季学期');
  });
});

// ==================== 3. boot（按钮与订阅） ====================

test('boot：三个按钮各自接到正确的方法，并主动拉一次数据', { skip: !JSDOM }, async (t) => {
  let handle = null;
  // ⚠️ 清理必须挂在 t.after 上，而不是写在断言后面：
  // 断言一失败，写在后面的 stop() 就被跳过 —— boot 的 1 秒定时器挂在
  // Node 层（不在 jsdom 窗口里，window.close() 关不掉它），进程永不退出，
  // 会把 node --test 的整条管线堵死（变异测试就是这么挂满 180 秒的）。
  t.after(() => { if (handle) handle.stop(); });
  await withDom(async (doc, win) => {
    const now = new Date(2026, 8, 16, 12, 30);
    const view = realView([MATH], null, now);
    const calls = { pull: 0, hide: 0, open: 0 };
    let pushUpdate = null;
    const api = {
      getView: () => { calls.pull++; return Promise.resolve(view); },
      hide: () => { calls.hide++; return Promise.resolve(true); },
      openMain: () => { calls.open++; return Promise.resolve(true); },
      onUpdate: (cb) => { pushUpdate = cb; return () => {}; }
    };

    handle = W.boot(api, doc);
    await new Promise((r) => setTimeout(r, 20));   // 等首次拉取的 Promise 落地

    assert.equal(calls.pull, 1, '挂载时就该拉一次，不该干等 30 秒');
    assert.equal(doc.getElementById('wName').textContent, '高等数学');

    doc.getElementById('btnClose').click();
    assert.equal(calls.hide, 1, '✕ 应隐藏窗口（不是退出应用）');
    doc.getElementById('btnOpen').click();
    assert.equal(calls.open, 1, '⤢ 应打开完整课表');
    doc.getElementById('btnRefresh').click();
    assert.equal(calls.pull, 2, '⟳ 应重新拉取');

    // 主进程推送新视图 → 页面跟着变（这是 30 秒 tick 的路径）
    assert.equal(typeof pushUpdate, 'function', '应订阅 widget:update');
    pushUpdate(realView([MATH], { days: { '2026-09-16': 'off' } }, now));
    assert.equal(doc.getElementById('card').getAttribute('data-phase'), 'off');
  });
});

test('boot：主进程不应答时保持上一帧，不把界面清空', { skip: !JSDOM }, async (t) => {
  let handle = null;
  t.after(() => { if (handle) handle.stop(); });   // 同上：失败也要停定时器
  await withDom(async (doc) => {
    const api = {
      getView: () => Promise.reject(new Error('主进程没应答')),
      hide: () => Promise.resolve(true),
      openMain: () => Promise.resolve(true),
      onUpdate: () => () => {}
    };
    handle = W.boot(api, doc);
    await new Promise((r) => setTimeout(r, 20));
    // 初始就是 loading 态，关键是不能因为一次失败就把卡片画成空白
    assert.ok(doc.getElementById('card').getAttribute('data-phase').length > 0);
    assert.equal(doc.getElementById('wHeadline').textContent, '正在读取课表…');
  });
});

test('boot：缺少可选接口（onUpdate / 按钮）时不抛异常', { skip: !JSDOM }, async (t) => {
  let handle = null;
  t.after(() => { if (handle) handle.stop(); });   // 同上：失败也要停定时器
  await withDom(async (doc) => {
    const minimal = { getView: () => Promise.resolve(null) };
    assert.doesNotThrow(() => { handle = W.boot(minimal, doc); });
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotThrow(() => W.boot(null, doc));
    assert.doesNotThrow(() => W.boot(minimal, null));
  });
});

// ==================== 4. 事件倒计时行（foot 第三格） ====================

test('eventLineOf：无事件 / 空数组 / 缺名字都返回空串，foot 不留空白格子', () => {
  assert.equal(W.eventLineOf(null), '');
  assert.equal(W.eventLineOf({}), '');
  assert.equal(W.eventLineOf({ events: [] }), '');
  assert.equal(W.eventLineOf({ events: [{ name: '', daysLeft: 3, countdownText: '还有 3 天' }] }), '');
});

test('eventLineOf：考试与普通事件前缀不同，文案用主进程给的 countdownText', () => {
  assert.equal(
    W.eventLineOf({ events: [{ name: '高数期末', kind: 'exam', daysLeft: 4, countdownText: '还有 4 天' }] }),
    '📝 高数期末 · 还有 4 天'
  );
  assert.equal(
    W.eventLineOf({ events: [{ name: '小组作业', kind: 'custom', daysLeft: 1, countdownText: '明天' }] }),
    '📌 小组作业 · 明天'
  );
});

test('eventLineOf：countdownText 缺失时兜底（不依赖 core.js，内联极简版）', () => {
  assert.equal(W.eventLineOf({ events: [{ name: 'x', kind: 'exam', daysLeft: 0 }] }), '📝 x · 今天');
  assert.equal(W.eventLineOf({ events: [{ name: 'x', kind: 'exam', daysLeft: 1 }] }), '📝 x · 明天');
  assert.equal(W.eventLineOf({ events: [{ name: 'x', kind: 'exam', daysLeft: 9 }] }), '📝 x · 还有 9 天');
  // daysLeft 也不合法（不该发生）→ 宁可空着也不写坏话
  assert.equal(W.eventLineOf({ events: [{ name: 'x', kind: 'exam', daysLeft: null }] }), '');
});

test('render：有事件时把倒计时写进 wEvent；没有时清空（旧内容不能残留）', { skip: !JSDOM }, async () => {
  await withDom(async (doc) => {
    const now = new Date(2026, 8, 16, 12, 30);
    const view = realView([MATH], null, now);
    view.events = [{ id: 'e1', name: '高数期末', kind: 'exam', daysLeft: 4, countdownText: '还有 4 天' }];
    W.render(doc, view, now.getTime());
    assert.equal(doc.getElementById('wEvent').textContent, '📝 高数期末 · 还有 4 天');

    // 下一帧事件消失了（被删掉）→ wEvent 必须清空，不能留着上一帧的考试吓人
    view.events = [];
    W.render(doc, view, now.getTime());
    assert.equal(doc.getElementById('wEvent').textContent, '');
  });
});
