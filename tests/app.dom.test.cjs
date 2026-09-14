/**
 * 全流程 DOM 测试（jsdom）：加载真实 index.html + 四个 JS，
 * 模拟「打开页面 → 切周 → 添加课程 → 导出 → 清空」完整用户路径
 * jsdom 为可选依赖：未安装时自动跳过（npm i jsdom 后生效）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

/**
 * jsdom 加载策略（可选依赖，缺失时跳过 DOM 流程测试）：
 *  1. 常规 require（项目本地 node_modules）
 *  2. 通过 NODE_PATH 显式定位——node --test 的子进程不会自动应用 NODE_PATH，
 *     这一步能救回「托管依赖目录」下的 jsdom
 */
let jsdom = null;
function loadJsdom() {
  const candidates = [];
  candidates.push(() => require('jsdom'));
  for (const dir of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(() => require(path.join(dir, 'jsdom')));
  }
  for (const fn of candidates) {
    try { return fn(); } catch (e) { /* 试下一个 */ }
  }
  return null;
}
jsdom = loadJsdom();

/**
 * 已创建的 jsdom 窗口。
 * app.js 会启动 setInterval 做实时刷新；jsdom 的定时器是挂在窗口上的，
 * 不关闭窗口进程就永远退不出（实测 node --test 会一直挂着）。
 * 这里统一登记，测试结束后全部 close()，从根上解决挂起，
 * 而不是只靠 --test-force-exit 强杀进程。
 */
const openWindows = new Set();

if (typeof test.after === 'function') {
  test.after(() => {
    for (const w of openWindows) {
      try { w.close(); } catch (e) { /* 忽略 */ }
    }
    openWindows.clear();
  });
}

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/**
 * @param {(w: Window) => void} [seedFn] 在脚本执行前预置 localStorage（用于测试旧数据迁移）
 */
function bootDom(seedFn) {
  return readFile(path.join(WEB, 'index.html'), 'utf-8').then((html) => {
    const dom = new jsdom.JSDOM(html, {
      url: 'http://localhost/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const w = dom.window;
    openWindows.add(w); // 登记以便测试结束后关闭，否则定时器会让进程挂住
    // jsdom 未实现 Blob URL，导出功能用桩替代
    if (!w.URL.createObjectURL) w.URL.createObjectURL = () => 'blob:stub';
    if (!w.URL.revokeObjectURL) w.URL.revokeObjectURL = () => {};
    if (typeof seedFn === 'function') seedFn(w);
    return Promise.all([
      readFile(path.join(WEB, 'js', 'core.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'storage.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'render.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'parser.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'ics.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'importer.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'app.js'), 'utf-8')
    ]).then(([core, storage, render, parser, ics, importer, app]) => {
      // 按依赖顺序执行（app.js 会因 readyState 非 loading 直接 init）
      w.eval(core);
      w.eval(storage);
      w.eval(render);
      w.eval(parser);
      w.eval(ics);
      w.eval(importer);
      w.eval(app);
      return w;
    });
  });
}

// jsdom 缺失时所有用例标记为跳过
const D = (jsdom === null)
  ? (name, fn) => test(name, { skip: '未安装 jsdom（可选依赖），跳过 DOM 流程测试' }, fn)
  : test;

D('页面初始化：预置示例课程并渲染周网格', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    // 今日面板存在
    assert.ok(doc.querySelector('#todayPanel .today-head'));
    // 周网格有课程卡片（示例 5 门在第 1 周都有课）
    const cards = doc.querySelectorAll('#mainView .cf-card');
    assert.ok(cards.length >= 4, '第 1 周应至少渲染 4 张课程卡，实际 ' + cards.length);
    // 周导航显示第 1 周
    assert.ok(doc.querySelector('#weekNav .week-label').textContent.includes('第 1 周'));
    // 清空示例按钮可见（存在示例课程）
    assert.equal(doc.getElementById('btnClearSample').hidden, false);
  });
});

D('点击下一周：周次与表头联动更新', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="next-week"]').click();
    assert.ok(doc.querySelector('#weekNav .week-label').textContent.includes('第 2 周'));
    // 示例课程「程序设计基础」只在 1-8 周，第 2 周仍应在；大学英语是单周，第 2 周应消失
    const grid = doc.getElementById('mainView').innerHTML;
    assert.ok(grid.includes('程序设计基础'));
  });
});

D('通过空白格子添加课程：预填星期节次并保存成功', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    // 点击 周三 第 7 节的空白格子
    doc.querySelector('.cf-cell[data-day="3"][data-section="7"]').click();
    assert.equal(doc.getElementById('modalOverlay').hidden, false);
    const form = doc.getElementById('courseForm');
    assert.equal(doc.getElementById('courseDay').value, '3');
    assert.equal(doc.getElementById('courseStart').value, '7');
    assert.equal(doc.getElementById('courseEnd').value, '7');
    // 填写并保存
    doc.getElementById('courseName').value = '操作系统';
    form.querySelector('button[type="submit"]').click();
    assert.equal(doc.getElementById('modalOverlay').hidden, true);
    // 网格中出现新课程
    assert.ok(doc.getElementById('mainView').innerHTML.includes('操作系统'));
  });
});

D('校验拦截：不填课程名无法保存', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="add-course"]').click();
    const form = doc.getElementById('courseForm');
    doc.getElementById('courseName').value = '';
    form.querySelector('button[type="submit"]').click();
    // 弹窗仍打开（被校验拦截）
    assert.equal(doc.getElementById('modalOverlay').hidden, false);
  });
});

D('删除课程：确认后从网格消失', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const wConfirm = w.confirm;
    w.confirm = () => true;
    const card = doc.querySelector('#mainView .cf-card');
    const id = card.getAttribute('data-id');
    card.click(); // 点击卡片打开编辑弹窗
    doc.getElementById('btnDeleteCourse').click();
    w.confirm = wConfirm;
    assert.ok(!doc.querySelector('#mainView .cf-card[data-id="' + id + '"]'));
  });
});

D('周次按钮：单双周快捷选择联动周网格', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="add-course"]').click();
    // 选择单周
    doc.querySelector('[data-action="parity-odd"]').click();
    const active = doc.querySelectorAll('#weeksGrid .week-btn.active');
    assert.ok(active.length > 0);
    active.forEach((b) => {
      assert.equal(Number(b.getAttribute('data-week')) % 2, 1, '单周模式下不应选中偶数周');
    });
  });
});

D('视图切换：列表视图按天分组渲染', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="view-list"]').click();
    const list = doc.getElementById('mainView').innerHTML;
    assert.ok(list.includes('周一'));
    assert.ok(list.includes('周日'));
    assert.ok(list.includes('data-action="edit-course"'));
  });
});

D('数据持久化：刷新（重新 init）后数据仍在', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    // 添加一门课
    doc.querySelector('.cf-cell[data-day="6"][data-section="1"]').click();
    const form = doc.getElementById('courseForm');
    doc.getElementById('courseName').value = '周六自习';
    form.querySelector('button[type="submit"]').click();
    const countBefore = doc.querySelectorAll('#mainView .cf-card').length;
    // 模拟刷新：重新执行 app.js（storage 中已有数据）
    return readFile(path.join(WEB, 'js', 'app.js'), 'utf-8').then((app) => {
      w.eval(app);
      const countAfter = doc.querySelectorAll('#mainView .cf-card').length;
      assert.equal(countAfter, countBefore);
      assert.ok(doc.getElementById('mainView').innerHTML.includes('周六自习'));
    });
  });
});

D('主题切换：三态循环 + 持久化 + 图标渲染', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const btn = doc.getElementById('btnTheme');
    assert.ok(btn, '应有主题切换按钮');
    // 初始化后 html 上应已应用主题
    const initial = doc.documentElement.getAttribute('data-theme');
    assert.ok(initial === 'light' || initial === 'dark', '初始主题应为 light/dark，实际: ' + initial);
    assert.ok(btn.innerHTML.includes('<svg'), '按钮应渲染内联 SVG 图标（不用 emoji）');

    const modes = [];
    for (let i = 0; i < 3; i++) {
      btn.click();
      modes.push(btn.getAttribute('data-theme-mode'));
    }
    assert.deepEqual(modes, ['light', 'dark', 'system'], '按钮应循环 跟随系统→浅色→深色');

    // 切到深色（system → light → dark）
    btn.click();
    btn.click();
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(w.localStorage.getItem('wb_courseforge_theme'), 'dark', '主题选择应持久化');
    const meta = doc.querySelector('meta[name="theme-color"]');
    assert.equal(meta.getAttribute('content'), '#0f131a', '深色下浏览器主题色应同步');
  });
});

D('导出日历：ICS 生成 + 一键下载链路', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    assert.ok(w.CourseForgeICS, 'ICS 模块应随页面加载');
    // storage 里现在是 schema v2 工作区，先归一化再取当前学期
    const ws = w.CourseForge.normalizeWorkspace(JSON.parse(w.localStorage.getItem('wb_courseforge_v1')));
    const sem = w.CourseForge.activeSemester(ws);
    assert.ok(sem, '应能取到当前学期');
    const res = w.CourseForgeICS.buildICS(sem.courses, sem.settings, {});
    assert.ok(res.events > 0, '示例课程应生成日程');
    assert.ok(res.text.includes('BEGIN:VCALENDAR'));
    assert.ok(res.text.includes('DTSTART:'), '应包含具体上课时间');

    // 走完整按钮链路
    doc.querySelector('[data-action="export-ics"]').click();
    const toast = doc.getElementById('toast').textContent;
    assert.ok(/已导出 \d+ 个日程/.test(toast), 'toast 应提示导出结果，实际: ' + toast);
  });
});

D('今日课程：实时时间与提示区块渲染', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const html = doc.getElementById('todayPanel').innerHTML;
    assert.ok(html.includes('today-head'), '应有今日标题区');
    assert.ok(html.includes('today-clock'), '应显示当前时间');
    assert.ok(html.includes('today-live') || html.includes('today-empty'), '应有实时提示区');
    assert.ok(/今天 · \d+月\d+日/.test(html), '应显示今天日期');
  });
});

// ==================== 多学期（工作区）全流程 ====================

/** 读取窗口内的持久化工作区（schema v2） */
function readWs(w) {
  return JSON.parse(w.localStorage.getItem('wb_courseforge_v1'));
}

D('多学期：新建后课程互相独立，切回来数据还在', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const firstId = readWs(w).activeId;
    const before = doc.querySelectorAll('#mainView .cf-card').length;
    assert.ok(before >= 4, '起始学期应有示例课程');

    // 打开「新建学期」弹窗：应自动预填下一个学期
    doc.querySelector('[data-action="open-semester-modal"]').click();
    assert.equal(doc.getElementById('semesterModal').hidden, false, '弹窗应打开');
    assert.equal(doc.getElementById('semesterKeepTimes').checked, true, '默认沿用周数/作息');
    assert.ok(doc.getElementById('semesterName').value.length > 0, '应预填学期名');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(doc.getElementById('semesterStart').value),
      '应预填开学日期，实际: ' + doc.getElementById('semesterStart').value);

    // 不复制课程 → 新学期的课表应为空
    doc.getElementById('semesterName').value = '2027 春季学期';
    doc.getElementById('semesterCopyCourses').checked = false;
    doc.querySelector('[data-action="create-semester"]').click();

    assert.equal(doc.getElementById('semesterModal').hidden, true, '创建后弹窗应关闭');
    const ws = readWs(w);
    assert.equal(ws.version, 2, '应落盘为 schema v2');
    assert.equal(ws.semesters.length, 2, '应有 2 个学期');
    assert.notEqual(ws.activeId, firstId, '新建后应切换到新学期的 id');
    assert.equal(doc.querySelectorAll('#mainView .cf-card').length, 0, '新学期课程应为空');
    assert.ok(doc.getElementById('weekNav').innerHTML.includes('2027 春季学期'), '周导航应显示学期名');

    // 学期列表：当前学期显示「当前」chip，另一个显示「切换」
    // 新建的学期按时间顺序追加在列表末尾
    const rows = [...doc.querySelectorAll('#semesterList .sem-row')];
    assert.equal(rows.length, 2);
    assert.equal(rows[1].getAttribute('data-id'), ws.activeId, '新创建的学期应追加在列表末尾');
    assert.equal(rows[1].querySelector('.sem-actions .chip').textContent, '当前');
    assert.equal(rows[1].querySelector('[data-action="switch-semester"]'), null, '当前学期不应有切换按钮');
    assert.ok(rows[0].querySelector('[data-action="switch-semester"]'), '非当前学期应有切换按钮');

    // 切回第一个学期 → 课程恢复
    rows[0].querySelector('[data-action="switch-semester"]').click();
    assert.equal(readWs(w).activeId, firstId, '切换后 activeId 应更新');
    assert.equal(doc.querySelectorAll('#mainView .cf-card').length, before, '切回后课程数应恢复');
    assert.ok(doc.getElementById('weekNav').innerHTML.includes('秋季学期'), '周导航应回到第一个学期');
  });
});

D('多学期：勾选「复制课程」后新学期带课', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const before = doc.querySelectorAll('#mainView .cf-card').length;

    doc.querySelector('[data-action="open-semester-modal"]').click();
    doc.getElementById('semesterCopyCourses').checked = true;
    doc.querySelector('[data-action="create-semester"]').click();

    assert.equal(doc.querySelectorAll('#mainView .cf-card').length, before, '应复制同样的课程数');
    const ws = readWs(w);
    const ids = ws.semesters.flatMap((s) => s.courses.map((c) => c.id));
    assert.equal(new Set(ids).size, ids.length, '两个学期不应共用课程 id');
    assert.ok(doc.getElementById('toast').textContent.includes('已复制'), '应提示复制数量');
  });
});

D('多学期：重命名走 prompt，空名被拦下', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const realPrompt = w.prompt;
    const id = readWs(w).activeId;
    const nameBefore = readWs(w).semesters[0].name;

    // 空名 → 拦截且不改名
    w.prompt = () => '   ';
    doc.querySelector(`[data-action="rename-semester"][data-id="${id}"]`).click();
    assert.equal(doc.getElementById('toast').textContent, '名称不能为空');
    assert.equal(readWs(w).semesters[0].name, nameBefore, '空名不应改动');
    assert.equal(readWs(w).semesters.length, 1, '不应凭空多出学期');

    // 正常改名
    w.prompt = () => '大二上';
    doc.querySelector(`[data-action="rename-semester"][data-id="${id}"]`).click();
    w.prompt = realPrompt;
    assert.equal(readWs(w).semesters[0].name, '大二上', '名称应落盘');
    assert.ok(doc.getElementById('weekNav').innerHTML.includes('大二上'), '周导航应同步');
    assert.ok(doc.getElementById('semesterList').innerHTML.includes('大二上'), '列表应同步');

    // 取消（null）→ 不改名
    w.prompt = () => null;
    doc.querySelector(`[data-action="rename-semester"][data-id="${id}"]`).click();
    w.prompt = realPrompt;
    assert.equal(readWs(w).semesters[0].name, '大二上');
  });
});

D('多学期：删除学期需确认，最后一个删不掉', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const realConfirm = w.confirm;
    w.confirm = () => true;

    // 先建第二个学期
    doc.querySelector('[data-action="open-semester-modal"]').click();
    doc.querySelector('[data-action="create-semester"]').click();
    const ws2 = readWs(w);
    assert.equal(ws2.semesters.length, 2);
    const staleId = ws2.semesters[0].id; // 非当前学期

    // 删掉非当前学期 → 只剩 1 个，且当前学期不变
    const activeBefore = ws2.activeId;
    doc.querySelector(`[data-action="delete-semester"][data-id="${staleId}"]`).click();
    let ws = readWs(w);
    assert.equal(ws.semesters.length, 1, '应删掉一个学期');
    assert.equal(ws.activeId, activeBefore, '删非当前学期不应改变当前选中');
    assert.equal(doc.getElementById('semesterList').querySelectorAll('.sem-row').length, 1);

    // 再删最后一个 → 拦截
    doc.querySelector(`[data-action="delete-semester"][data-id="${ws.activeId}"]`).click();
    w.confirm = realConfirm;
    ws = readWs(w);
    assert.equal(ws.semesters.length, 1, '最后一个学期不可删除');
    assert.equal(doc.getElementById('toast').textContent, '至少要保留一个学期');
  });
});

D('多学期：删除当前学期会自动切到剩下的学期并装载其课程', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const realConfirm = w.confirm;
    w.confirm = () => true;

    const firstId = readWs(w).activeId;
    // 建一个带课程的第二学期，然后删掉它自己（当前学期）
    doc.querySelector('[data-action="open-semester-modal"]').click();
    doc.getElementById('semesterCopyCourses').checked = true;
    doc.querySelector('[data-action="create-semester"]').click();
    const secondId = readWs(w).activeId;
    assert.notEqual(secondId, firstId);

    doc.querySelector(`[data-action="delete-semester"][data-id="${secondId}"]`).click();
    w.confirm = realConfirm;

    const ws = readWs(w);
    assert.equal(ws.semesters.length, 1, '应只剩第一个学期');
    assert.equal(ws.activeId, firstId, '应自动切回剩下的学期');
    assert.ok(doc.querySelectorAll('#mainView .cf-card').length >= 4, '应装载剩下学期的课程');
    assert.equal(doc.getElementById('weekNav').innerHTML.includes('2027'), false, '不应残留被删学期的名称');
  });
});

D('数据迁移：v1 扁平结构自动升级为 v2 且不丢课程', () => {
  const v1 = {
    version: 1,
    settings: { semesterStart: '2026-09-14', totalWeeks: 16, sectionsPerDay: 12 },
    courses: [
      { id: 'old_1', name: '迁移课A', teacher: '张老师', location: 'A101', day: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3], color: 'blue' },
      { id: 'old_2', name: '迁移课B', day: 3, startSection: 5, endSection: 6, weeks: [1, 2, 3], color: 'teal' }
    ]
  };
  // 注意：必须在 app.js 执行前写入 localStorage，才能命中 init() 的迁移分支
  return bootDom((w) => w.localStorage.setItem('wb_courseforge_v1', JSON.stringify(v1))).then((w) => {
    const doc = w.document;
    const ws = readWs(w);
    assert.equal(ws.version, 2, '应立刻回写为 v2');
    assert.equal(ws.semesters.length, 1, 'v1 应迁移为单学期');
    assert.equal(ws.semesters[0].courses.length, 2, '课程不能丢');
    assert.ok(ws.semesters[0].name, '迁移时应按开学日期自动命名学期');
    assert.equal(ws.activeId, ws.semesters[0].id, 'activeId 应指向唯一学期');

    // 界面上应看到迁移过来的课程，且不混入示例数据
    const html = doc.getElementById('mainView').innerHTML;
    assert.ok(html.includes('迁移课A'));
    assert.ok(html.includes('迁移课B'));
    assert.equal(doc.getElementById('btnClearSample').hidden, true, '不应播种示例课程');
    assert.equal(doc.querySelectorAll('#semesterList .sem-row').length, 1);
  });
});

