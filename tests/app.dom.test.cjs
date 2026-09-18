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
 * 按 index.html 里 <script src> 的**真实顺序**取出本地脚本。
 *
 * 为什么不再手写一份清单：原来的清单是手抄的，而 index.html 里其实还有
 * pdf-layout.js —— 也就是说「测试跑的页面」和「用户跑的页面」已经不是同一个了。
 * 这种漂移不会报警，只会让 DOM 测试慢慢变成安慰剂。直接从 HTML 推导，
 * 保证测的就是真的。
 *
 * @returns {Promise<{src: string, code: string}[]>}
 */
function scriptsInOrder(html) {
  const srcs = [];
  const re = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1]);
  return Promise.all(srcs.map((src) =>
    readFile(path.join(WEB, src), 'utf-8').then((code) => ({ src, code }))
  ));
}

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
    return scriptsInOrder(html).then((scripts) => {
      // 按 index.html 的顺序执行（app.js 会因 readyState 非 loading 直接 init）
      scripts.forEach((s) => w.eval(s.code));
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

// ==================== 教务系统直连（桌面端能力） ====================

/** 教务系统课表页 fixture：网格型 + 页眉噪音 + iframe 里才是真课表 */
const EDU_GRID_HTML = `<html><head><title>个人课表</title></head><body>
<div class="head">上海大学 2026-2027 学年秋季学期 学生课表</div>
<table>
  <tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>
  <tr><td>第1节</td><td rowspan="2">高等数学<br>张老师<br>东区一教101<br>1-16周</td>
      <td colspan="4">&nbsp;</td></tr>
  <tr><td>第2节</td><td colspan="4">&nbsp;</td></tr>
  <tr><td>第3节</td><td colspan="4">&nbsp;</td></tr>
  <tr><td>第3节</td><td colspan="4">&nbsp;</td>
      </tr>
  <tr><td>第5节</td><td colspan="4">&nbsp;</td></tr>
  <tr><td>第5节</td><td colspan="4">&nbsp;</td></tr>
</table>
</body></html>`;

/** 正方课表接口的最小真实感返回（字段名按实测结构写） */
const EDU_KB_API = {
  kbList: [
    {
      kcmc: '高等数学(二)', xqjmc: '星期一', xqj: '1', jcs: '1-2', zcd: '1-16周',
      cdmc: '东区一教101', xm: '张老师', xqmc: '宝山校区'
    },
    {
      kcmc: '大学英语', xqjmc: '星期三', xqj: '3', jcs: '3-4', zcd: '1-8周(单)',
      cdmc: '东区二教205', xm: '李老师', xqmc: '宝山校区'
    }
  ],
  xqjmcMap: { '1': '星期一', '3': '星期三' }
};

/** 在 bootDom 之后注入桌面桥（模拟 Electron preload 暴露的能力） */
function injectDesktop(w, over) {
  const o = over || {};
  const calls = { open: [], grab: 0, close: 0, login: [], courses: 0, credClear: 0 };
  w.CourseForgeDesktop = {
    isDesktop: true,
    platform: 'win32',
    edu: {
      open: (url) => { calls.open.push(url); return Promise.resolve(true); },
      grab: () => { calls.grab++; return Promise.resolve(Object.assign({ ok: true, html: EDU_GRID_HTML }, o.grab || {})); },
      close: () => { calls.close++; return Promise.resolve(true); },
      login: (payload) => {
        calls.login.push(payload);
        return Promise.resolve(o.login || {
          ok: true,
          url: 'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs',
          remembered: !!(payload && payload.remember)
        });
      },
      courses: () => {
        calls.courses++;
        return Promise.resolve(o.courses || {
          ok: true, source: 'api', candidate: '学生课表查询', json: JSON.stringify(EDU_KB_API)
        });
      },
      credStatus: () => Promise.resolve(o.cred || { available: true, saved: false, username: '' }),
      credClear: () => {
        calls.credClear++;
        return Promise.resolve({ ok: true, status: { available: true, saved: false, username: '' } });
      }
    }
  };
  return calls;
}

/** 让挂起的 Promise 链跑完 */
const flush = () => new Promise((r) => setTimeout(r, 0));

D('教务直连：网页版给粘贴引导，不显示桌面操作区', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="open-import"]').click();
    doc.querySelector('[data-imp-tab="edu"]').click();

    assert.equal(doc.querySelector('[data-imp-pane="edu"]').hidden, false, '应切到教务直连面板');
    assert.equal(doc.getElementById('eduWebHint').hidden, false, '网页版必须给出可用的替代路径');
    assert.equal(doc.getElementById('eduDesktopPane').hidden, true, '网页版不该出现只有桌面端才有的按钮');
    assert.ok(/粘贴/.test(doc.getElementById('eduWebHint').textContent), '引导文案要指明改用粘贴文本');

    // 引导按钮要能真的跳到粘贴页签，而不是死链
    doc.querySelector('[data-action="edu-goto-text"]').click();
    assert.equal(doc.querySelector('[data-imp-pane="text"]').hidden, false);
    assert.equal(doc.querySelector('[data-imp-tab="text"]').classList.contains('active'), true);
  });
});

D('教务直连：桌面端显示操作区，能读回页面并渲染确认表、入库', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const calls = injectDesktop(w);

    doc.querySelector('[data-action="open-import"]').click();
    doc.querySelector('[data-imp-tab="edu"]').click();
    assert.equal(doc.getElementById('eduWebHint').hidden, true, '桌面端不该显示网页版的引导');
    assert.equal(doc.getElementById('eduDesktopPane').hidden, false);

    // 打开教务系统：自动补 https:// 并记住网址
    doc.getElementById('eduUrl').value = 'jwb.shu.edu.cn';
    doc.querySelector('[data-action="edu-open"]').click();
    return flush().then(() => {
      assert.deepEqual(calls.open, ['https://jwb.shu.edu.cn'], '应自动补全协议');
      assert.equal(w.localStorage.getItem('wb_courseforge_edu_url'), 'https://jwb.shu.edu.cn',
        '网址应被记住，下次不用重填');

      // 没填网址时应给出提示而不是静默失败
      doc.getElementById('eduUrl').value = '';
      doc.querySelector('[data-action="edu-open"]').click();
      assert.equal(doc.getElementById('importStatus').textContent, '请先填写教务系统网址');
      doc.getElementById('eduUrl').value = 'jwb.shu.edu.cn';

      // 读取当前页 → 解析 → 渲染确认表
      doc.querySelector('[data-action="edu-grab"]').click();
      return flush();
    }).then(() => {
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/已从教务系统识别出 \d+ 门课/.test(status), '状态栏应回报识别结果，实际: ' + status);

      const table = doc.getElementById('importResult');
      assert.ok(table.innerHTML.includes('高等数学'), '确认表应列出识别到的课程');
      assert.ok(table.innerHTML.includes('张老师'), '教师应被识别');
      assert.ok(table.innerHTML.includes('东区一教101'), '地点应被识别');

      // 入库：勾选后导入，课表里应出现这门课
      const before = doc.querySelectorAll('#mainView .cf-card').length;
      const applyBtn = doc.querySelector('[data-action="import-apply"]');
      assert.ok(applyBtn, '应有「导入所选」按钮');
      applyBtn.click();
      assert.ok(doc.querySelectorAll('#mainView .cf-card').length > before,
        '导入后课表应多出课程卡片');
      assert.ok(doc.getElementById('mainView').innerHTML.includes('高等数学'),
        '导入的课程应出现在当前学期的课表里');
    });
  });
});

D('教务直连：没开教务窗口时读取，给明确提示而不是静默失败', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    w.CourseForgeDesktop = {
      isDesktop: true,
      edu: {
        open: () => Promise.resolve(true),
        grab: () => Promise.resolve({ ok: false, reason: 'nowindow' }),
        close: () => Promise.resolve(true)
      }
    };
    doc.querySelector('[data-action="open-import"]').click();
    doc.querySelector('[data-imp-tab="edu"]').click();
    doc.querySelector('[data-action="edu-grab"]').click();
    return flush().then(() => {
      const s = doc.getElementById('importStatus').textContent;
      assert.ok(s.includes('还没有打开教务系统窗口'), '应提示先打开窗口，实际: ' + s);
      // 不能把上一次的结果留在表里误导用户
      assert.equal(doc.querySelectorAll('#importResult tr[data-idx]').length, 0);
    });
  });
});

D('教务直连：读取到非课表页面时明确说明，不产生垃圾数据', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    injectDesktop(w, { grab: { html: '<html><body><p>请先登录</p></body></html>' } });
    doc.querySelector('[data-action="open-import"]').click();
    doc.querySelector('[data-imp-tab="edu"]').click();
    doc.querySelector('[data-action="edu-grab"]').click();
    return flush().then(() => {
      const s = doc.getElementById('importStatus').textContent;
      assert.ok(s.includes('没能从当前页面识别出课表'), '应说明识别失败的原因，实际: ' + s);
      assert.equal(doc.querySelectorAll('#importResult tr[data-idx]').length, 0, '不应产生半成品数据');
    });
  });
});

D('教务直连：桌面端「去粘贴文本」与关闭窗口按钮可用', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    const calls = injectDesktop(w);
    doc.querySelector('[data-action="open-import"]').click();
    doc.querySelector('[data-imp-tab="edu"]').click();
    doc.querySelector('[data-action="edu-close-window"]').click();
    assert.equal(calls.close, 1, '关闭按钮应调用主进程');

    doc.querySelector('[data-action="edu-goto-text"]').click();
    assert.equal(doc.querySelector('[data-imp-pane="text"]').hidden, false);
  });
});

// ==================== 一键登录并取课表 ====================

/** 打开导入弹窗并切到教务面板 */
function openEduPane(w) {
  const doc = w.document;
  doc.querySelector('[data-action="open-import"]').click();
  doc.querySelector('[data-imp-tab="edu"]').click();
  return doc;
}

D('自动登录：填账号 → 一键登录 → 取课表 → 进确认表，且密码不留在页面里', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w);
    const doc = openEduPane(w);

    doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
    doc.getElementById('eduUser').value = '26125005';
    doc.getElementById('eduPass').value = 'my-secret-pw';
    doc.querySelector('[data-action="edu-autologin"]').click();

    return flush().then(() => {
      assert.equal(calls.login.length, 1, '应调用一次自动登录');
      const p = calls.login[0];
      assert.equal(p.url, 'https://jwxt.shu.edu.cn', '网址应补全协议后传给主进程');
      assert.equal(p.username, '26125005');
      assert.equal(p.password, 'my-secret-pw');
      assert.equal(p.remember, false, '没勾选就不该请求保存');

      // 密码交给主进程后必须立刻从页面清掉：留在 DOM 里的明文没有任何用处，只有风险
      assert.equal(doc.getElementById('eduPass').value, '', '登录后应立刻清空密码框');

      assert.equal(calls.courses, 1, '登录成功后应自动取课表');
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/已从教务接口取到 2 门课/.test(status), '状态栏应说明走的是接口，实际: ' + status);
      assert.ok(doc.getElementById('importResult').innerHTML.includes('高等数学'),
        '接口返回的课程应进入确认表');
      assert.ok(doc.getElementById('importResult').innerHTML.includes('张老师'));
      assert.ok(doc.getElementById('importResult').innerHTML.includes('东区一教101'));
    });
  });
});

D('自动登录：勾「记住账号」时把 remember 传下去，并刷新账号状态文案', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w);
    const doc = openEduPane(w);

    doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
    doc.getElementById('eduUser').value = '26125005';
    doc.getElementById('eduPass').value = 'pw';
    doc.getElementById('eduRemember').checked = true;
    doc.querySelector('[data-action="edu-autologin"]').click();

    return flush().then(() => {
      assert.equal(calls.login[0].remember, true, '勾了记住账号就要传 remember');
      const state = doc.getElementById('eduCredState').textContent;
      assert.ok(/已保存账号：26125005/.test(state), '应提示账号已保存，实际: ' + state);
      assert.ok(!/pw/.test(state), '状态文案里不能出现密码');
    });
  });
});

D('自动登录：本机已存账号时，密码留空也能点按钮', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w, {
      cred: { available: true, saved: true, username: '26125005' },
      login: { ok: true, url: 'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html', alreadyLoggedIn: true }
    });

    // 把取课表卡住，好观察「登录成功」这条中间反馈 ——
    // 否则它会立刻被取课表的结果覆盖，测不到（而用户在真机上就是靠它知道登录过了）
    let release = null;
    w.CourseForgeDesktop.edu.courses = () => {
      calls.courses++;
      return new Promise((r) => { release = r; });
    };

    const doc = openEduPane(w);

    return flush().then(() => {
      // 切进面板时应该已经把学号填回去了，省得用户再打一遍
      assert.equal(doc.getElementById('eduUser').value, '26125005', '已保存的学号应自动填回');
      assert.equal(doc.getElementById('eduRemember').checked, true);
      assert.ok(/已保存账号/.test(doc.getElementById('eduCredState').textContent));

      doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
      doc.querySelector('[data-action="edu-autologin"]').click();
      return flush();
    }).then(() => {
      assert.equal(calls.login.length, 1, '留空密码时应让主进程用已保存的密码，而不是拦住用户');
      assert.equal(calls.login[0].password, '', '密码留空交给主进程去取已保存的那份');
      assert.ok(/上次的登录状态/.test(doc.getElementById('importStatus').textContent),
        '会话还在时要说明用的是上次登录状态，实际: ' + doc.getElementById('importStatus').textContent);

      release({ ok: true, source: 'api', candidate: '学生课表查询', json: JSON.stringify(EDU_KB_API) });
      return flush();
    }).then(() => {
      assert.ok(/已从教务接口取到 2 门课/.test(doc.getElementById('importStatus').textContent));
    });
  });
});

D('自动登录：失败时把学校给的原因原样显示，且不去取课表', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w, {
      login: { ok: false, reason: 'fail', message: '用户名或密码错误' }
    });
    const doc = openEduPane(w);
    doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
    doc.getElementById('eduUser').value = '26125005';
    doc.getElementById('eduPass').value = 'wrong';
    doc.querySelector('[data-action="edu-autologin"]').click();

    return flush().then(() => {
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/登录失败：用户名或密码错误/.test(status), '失败原因必须来自学校页面，实际: ' + status);
      assert.equal(calls.courses, 0, '没登录成功就不该去取课表');
      assert.equal(doc.querySelectorAll('#importResult tr[data-idx]').length, 0);
    });
  });
});

D('自动登录：学校要验证码时退回手动，并指路「重新取课表」', () => {
  return bootDom().then((w) => {
    injectDesktop(w, { login: { ok: false, reason: 'captcha' } });
    const doc = openEduPane(w);
    doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
    doc.getElementById('eduUser').value = '26125005';
    doc.getElementById('eduPass').value = 'pw';
    doc.querySelector('[data-action="edu-autologin"]').click();

    return flush().then(() => {
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/验证码/.test(status) && /手动登录/.test(status), '要给可执行的替代路径，实际: ' + status);
    });
  });
});

D('重新取课表：不碰账号，直接走接口', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w);
    const doc = openEduPane(w);
    doc.querySelector('[data-action="edu-fetch"]').click();

    return flush().then(() => {
      assert.equal(calls.courses, 1);
      assert.equal(calls.login.length, 0, '「重新取课表」不该再动账号');
      assert.ok(/已从教务接口取到 2 门课/.test(doc.getElementById('importStatus').textContent));
    });
  });
});

D('重新取课表：还没登录时给明确提示，而不是丢一个空表', () => {
  return bootDom().then((w) => {
    injectDesktop(w, { courses: { ok: false, reason: 'nologin', message: '还没登录教务系统，请先自动登录或手动登录' } });
    const doc = openEduPane(w);
    doc.querySelector('[data-action="edu-fetch"]').click();

    return flush().then(() => {
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/还没登录教务系统/.test(status), '实际: ' + status);
      assert.equal(doc.querySelectorAll('#importResult tr[data-idx]').length, 0);
    });
  });
});

D('取课表：接口取不到时退回抓页面，两种来源都要能进确认表', () => {
  return bootDom().then((w) => {
    injectDesktop(w, {
      courses: { ok: true, source: 'html', candidate: '学生课表查询', html: EDU_GRID_HTML }
    });
    const doc = openEduPane(w);
    doc.querySelector('[data-action="edu-fetch"]').click();

    return flush().then(() => {
      const html = doc.getElementById('importResult').innerHTML;
      assert.ok(html.includes('高等数学'), 'HTML 兜底路径也要能解析出课程');
      const status = doc.getElementById('importStatus').textContent;
      assert.ok(/课表页面识别出/.test(status), '应说明走的是页面解析，实际: ' + status);
    });
  });
});

D('忘记账号：调用主进程清除，并回到未保存状态', () => {
  return bootDom().then((w) => {
    const calls = injectDesktop(w, { cred: { available: true, saved: true, username: '26125005' } });
    const doc = openEduPane(w);

    return flush().then(() => {
      assert.equal(doc.getElementById('eduRemember').checked, true);
      doc.querySelector('[data-action="edu-forget"]').click();
      return flush();
    }).then(() => {
      assert.equal(calls.credClear, 1, '应调用主进程删除凭据');
      assert.equal(doc.getElementById('eduRemember').checked, false, '清除后不该还显示勾选状态');
      assert.ok(/账号未保存/.test(doc.getElementById('eduCredState').textContent));
      assert.ok(/已清除/.test(doc.getElementById('importStatus').textContent));
    });
  });
});

D('旧版桌面端（没有新桥方法）不炸：给出可执行的替代路径', () => {
  return bootDom().then((w) => {
    // 只提供最早那三个方法，模拟旧版 preload
    w.CourseForgeDesktop = {
      isDesktop: true,
      edu: {
        open: () => Promise.resolve(true),
        grab: () => Promise.resolve({ ok: true, html: EDU_GRID_HTML }),
        close: () => Promise.resolve(true)
      }
    };
    const doc = openEduPane(w);
    doc.getElementById('eduUrl').value = 'jwxt.shu.edu.cn';
    doc.getElementById('eduUser').value = 'u';

    doc.querySelector('[data-action="edu-autologin"]').click();
    assert.ok(/不支持自动登录/.test(doc.getElementById('importStatus').textContent));

    doc.querySelector('[data-action="edu-fetch"]').click();
    assert.ok(/不支持一键取课表/.test(doc.getElementById('importStatus').textContent));

    doc.querySelector('[data-action="edu-forget"]').click();
    // 清除账号在旧版里没有对应能力，但也不能抛异常把整个面板搞死
    assert.ok(doc.getElementById('eduCredState').textContent.length > 0);
  });
});

D('设置面板：提醒开关能存进设置，重开面板会回显', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="open-settings"]').click();

    const enabled = doc.getElementById('settingsRemindEnabled');
    const lead = doc.getElementById('settingsRemindLead');
    assert.equal(enabled.checked, false, '默认必须是关的：浏览器通知权限只能由用户点击触发');
    assert.equal(lead.disabled, true, '开关关闭时，提前量选择应当置灰（否则用户会以为选了就生效）');

    enabled.checked = true;
    lead.value = '15';
    doc.querySelector('[data-action="save-settings"]').click();

    // 落盘的是「多学期工作区」结构（{ activeId, semesters:[{ settings }] }），
    // 不是扁平的 { settings } —— 取错层级会拿到 undefined，于是断言永远测不到真东西
    const ws = JSON.parse(w.localStorage.getItem('wb_courseforge_v1'));
    const active = ws.semesters.filter((s) => s.id === ws.activeId)[0];
    assert.ok(active, '找不到当前学期，存储结构变了');
    assert.equal(active.settings.remind.enabled, true, '提醒开关没落盘');
    assert.equal(active.settings.remind.lead, 15, '提前量必须是数字 15，而不是字符串');

    // 重开面板：如果不同步回来，用户会以为「保存了但没生效」
    doc.querySelector('[data-action="open-settings"]').click();
    assert.equal(doc.getElementById('settingsRemindEnabled').checked, true);
    assert.equal(doc.getElementById('settingsRemindLead').value, '15');
    assert.equal(doc.getElementById('settingsRemindLead').disabled, false);
  });
});

D('设置面板：提前量只能选引擎认得的档位（界面与引擎同一份取值）', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="open-settings"]').click();
    const lead = doc.getElementById('settingsRemindLead');
    const values = Array.prototype.map.call(lead.options, (o) => o.value);
    // 用字符串比较而不是 deepEqual：jsdom 里的数组来自另一个 realm，
    // deepStrictEqual 会因为「数组原型不同」而失败（是陷阱，不是真的不一致）
    assert.equal(values.join(','), w.CourseForgeRemind.LEAD_CHOICES.join(','),
      '下拉选项与 RM.LEAD_CHOICES 必须一致，否则会出现「选了却被引擎忽略」的档位');
  });
});


// ---------------------------------------------------------------- 分享图弹窗
//
// jsdom 里拿不到 canvas 2D 上下文（除非装 `canvas` 这个原生包，本项目刻意不装），
// 所以这两条**不是在测出图**——出图由 tests/share-image.test.mjs（布局）与
// tools/share-image-selftest.mjs（真机像素）负责。
// 它们测的是「点下去之后应用会不会卡住 / 用户看不看得到反馈」这类接线问题：
// 出图失败时若直接抛出去，用户看到的是一个点不动的弹窗，而控制台里才有报错。

D('分享图弹窗：打开后必须有可见反馈（画布或可读的错误提示），不能是空白', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="share-image"]').click();
    assert.equal(doc.getElementById('shareModal').hidden, false, '点「分享图片」没打开弹窗');

    const host = doc.getElementById('sharePreview');
    assert.ok(host.childNodes.length > 0,
      '预览区是空的：用户点了按钮但什么都看不到，会以为是按钮坏了');

    // 无 canvas 环境（jsdom 默认）下必须是**可读文案**，不能静默空白
    const tip = host.querySelector('.share-loading');
    if (tip) {
      assert.match(tip.textContent, /Canvas 2D|生成预览失败|图片模块未加载|还没有课程/,
        '出图失败时的提示文案读不出原因：' + tip.textContent);
    }
  });
});

D('分享图弹窗：切换范围/配色会同步选中态，关闭后收起', () => {
  return bootDom().then((w) => {
    const doc = w.document;
    doc.querySelector('[data-action="share-image"]').click();

    const all = doc.querySelector('[data-action="share-scope"][data-scope="all"]');
    const cur = doc.querySelector('[data-action="share-scope"][data-scope="current"]');
    assert.ok(cur.classList.contains('active'), '默认应当是「只看本周」选中');
    all.click();
    assert.ok(all.classList.contains('active'), '点了「全部周次」但按钮没有选中态');
    assert.ok(!cur.classList.contains('active'), '同一组里的另一个选项应当取消选中');

    const dark = doc.querySelector('[data-action="share-theme"][data-theme="dark"]');
    dark.click();
    assert.ok(dark.classList.contains('active'), '点了「深色」但按钮没有选中态');
    // 再点一次同一个选项不该抛异常（early-return 分支）
    dark.click();

    doc.querySelector('[data-action="close-share"]').click();
    assert.equal(doc.getElementById('shareModal').hidden, true, '关闭按钮没把弹窗收起来');
  });
});

// ==================== 桌面端「常驻小组件」接线 ====================
//
// 这几条验的是**接线**，不是视觉：
//   1. 网页版绝不能显示这个开关（那里没有桌面外壳，点了必然无反应）
//   2. 桌面端的勾选状态真身在主进程（托盘菜单也能改），打开抽屉时必须重读
//   3. 调用失败要把勾选改回去 —— 界面显示「已开启」而窗口没出来，
//      是比功能坏掉更糟的状态：用户会一直等一个不会出现的东西
//   4. 课表一改就要把快照推给主进程，否则托盘会长期显示旧数据

/**
 * 造一个假的桌面外壳桥。
 * 返回值挂在 window 上（测试里可以直接查调用记录），同时也 return 出来方便链式使用。
 * @param {object} [opts] { visible, pushResult(), showResult() }
 */
function desktopBridge(w, opts) {
  const o = opts || {};
  const calls = { push: [], status: 0, show: 0, hide: 0 };
  const state = { visible: !!o.visible };
  const shell = {
    push: (ws) => {
      calls.push.push(ws);
      return o.pushResult ? o.pushResult() : Promise.resolve({ ok: true });
    },
    status: () => {
      calls.status++;
      return Promise.resolve({ tray: true, widgetVisible: state.visible, alwaysOnTop: true, bounds: null });
    },
    showWidget: () => {
      calls.show++;
      return o.showResult ? o.showResult() : Promise.resolve(true);
    },
    hideWidget: () => {
      calls.hide++;
      return Promise.resolve(true);
    },
    toggleWidget: () => Promise.resolve(true)
  };
  w.CourseForgeDesktop = { isDesktop: true, platform: 'win32', shell: shell };
  const handle = { calls, state, setVisible: (v) => { state.visible = v; } };
  w.__shell = handle;
  return handle;
}

/** 勾选框走一次 change 事件（app.js 里就是监听 change）；flush 复用文件上部已有的那个 */
function toggleBox(w, checked) {
  const box = w.document.getElementById('settingsDesktopWidget');
  box.checked = checked;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  return box;
}

D('网页版：设置里不出现「常驻小组件」开关（没有桌面外壳，点了必然无反应）', () => {
  return bootDom().then((w) => {
    const field = w.document.getElementById('desktopWidgetField');
    assert.ok(field, 'index.html 里应当有这块设置（靠 hidden 控制显隐）');
    assert.equal(field.hidden, true, '无桌面桥时这块必须保持隐藏');
  });
});

D('桌面端：显示「常驻小组件」开关，且勾选状态取自主进程', () => {
  return bootDom((w) => desktopBridge(w, { visible: true })).then(async (w) => {
    const doc = w.document;
    assert.equal(doc.getElementById('desktopWidgetField').hidden, false, '桌面端应当显示这块设置');
    assert.ok(w.__shell.calls.status >= 1, '必须真的问过主进程，而不是猜一个默认值');
    await flush();
    assert.equal(doc.getElementById('settingsDesktopWidget').checked, true,
      '主进程说窗口开着，勾选就该是选中态');
  });
});

D('桌面端：打开设置抽屉时会重读状态（托盘菜单也能改显隐）', () => {
  return bootDom((w) => desktopBridge(w, { visible: false })).then(async (w) => {
    const doc = w.document;
    const box = doc.getElementById('settingsDesktopWidget');
    await flush();
    assert.equal(box.checked, false);

    // 模拟用户从托盘菜单把小组件打开了
    w.__shell.setVisible(true);
    doc.querySelector('[data-action="open-settings"]').click();
    await flush();
    assert.equal(box.checked, true,
      '抽屉打开时没重读状态：用户看到的是过期勾选，会以为自己的操作没生效');
  });
});

D('桌面端：勾选立即生效（不等「保存设置」），且调的是 showWidget', () => {
  return bootDom((w) => desktopBridge(w)).then(async (w) => {
    await flush();
    const box = toggleBox(w, true);
    await flush();
    assert.equal(w.__shell.calls.show, 1, '勾上应当调用 showWidget');
    assert.equal(w.__shell.calls.hide, 0);
    assert.equal(box.checked, true, '调用成功后应保持勾选');

    // 取消勾选走另一条分支
    toggleBox(w, false);
    await flush();
    assert.equal(w.__shell.calls.hide, 1, '取消勾选应当调用 hideWidget');
  });
});

D('桌面端：打开小组件失败时勾选要回滚（不能让界面骗人）', () => {
  return bootDom((w) => desktopBridge(w, { showResult: () => Promise.resolve(false) }))
    .then(async (w) => {
      await flush();
      const box = toggleBox(w, true);
      await flush();
      assert.equal(box.checked, false,
        '主进程明确回报失败，勾选必须退回去 —— 否则用户会一直等一个不会出现的窗口');
    });
});

D('桌面端：主进程没应答（Promise reject）同样要回滚', () => {
  return bootDom((w) => desktopBridge(w, { showResult: () => Promise.reject(new Error('没响应')) }))
    .then(async (w) => {
      await flush();
      const box = toggleBox(w, true);
      await flush();
      assert.equal(box.checked, false, '异常路径也必须把勾选改回去');
    });
});

D('桌面端：启动即推一次快照，改课表后再推一次（托盘才不会显示旧数据）', () => {
  return bootDom((w) => desktopBridge(w)).then(async (w) => {
    const calls = w.__shell.calls;
    assert.ok(calls.push.length >= 1, '启动后 persist() 就该把课表推给主进程');
    const first = calls.push[0];
    assert.equal(first.version, 2);
    assert.ok(Array.isArray(first.semesters) && first.semesters.length >= 1,
      '推送的必须是完整工作区（含 semesters），否则主进程算不出下节课');
    assert.ok(Array.isArray(first.semesters[0].courses));

    const before = calls.push.length;

    // 通过空白格子加一门课（这条路径最后会走到 persist）
    // ⚠️ 挑格子要挑真空白：示例课表里 day1/section1 已有课，
    //    点到课程卡不会开弹窗，表单提交必然校验失败，测试会红得莫名其妙
    const doc = w.document;
    doc.querySelector('.cf-cell[data-day="2"][data-section="1"]').click();
    doc.getElementById('courseName').value = '快照推送测试课';
    doc.getElementById('courseForm').querySelector('button[type="submit"]').click();
    await flush();

    assert.ok(calls.push.length > before, '改完课表应当再推一次快照');
    const last = calls.push[calls.push.length - 1];
    const names = last.semesters[0].courses.map((c) => c.name);
    assert.ok(names.indexOf('快照推送测试课') !== -1,
      '刚加的课必须出现在快照里：' + names.join('/'));
  });
});

D('桌面端：桥的 push 抛异常也不能影响课表保存（托盘是锦上添花）', () => {
  return bootDom((w) => desktopBridge(w, {
    pushResult: () => { throw new Error('桥坏了'); }
  })).then(async (w) => {
    const doc = w.document;
    doc.querySelector('.cf-cell[data-day="2"][data-section="1"]').click();
    doc.getElementById('courseName').value = '桥坏了也要能存';
    doc.getElementById('courseForm').querySelector('button[type="submit"]').click();
    await flush();
    // 关键断言：课表本身照常落盘，没被桌面外壳拖累
    const saved = JSON.parse(w.localStorage.getItem(w.CourseStorage.KEY));
    const names = saved.semesters[0].courses.map((c) => c.name);
    assert.ok(names.indexOf('桥坏了也要能存') !== -1,
      '桌面外壳出问题不该让课表存不下：' + names.join('/'));
  });
});

// ==================== 考试与事件（P3） ====================

D('事件：没有事件时首页倒计时条整条隐藏', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    const bar = doc.getElementById('eventsBar');
    assert.ok(bar, 'index.html 里应当有这条倒计时栏');
    assert.equal(bar.hidden, true, '一条事件都没有时必须整体藏起来，不能摆一条空栏');
  });
});

D('事件：填表添加 → 首页出现倒计时 chip、抽屉出现管理行、数据落盘', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('eventName').value = '高数期末';
    doc.getElementById('eventDate').value = '2027-06-01';
    doc.getElementById('eventTime').value = '09:00';
    doc.getElementById('eventKind').value = 'exam';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();

    const bar = doc.getElementById('eventsBar');
    assert.equal(bar.hidden, false, '添加后倒计时条应当亮出来');
    assert.match(bar.textContent, /高数期末/);
    assert.match(bar.textContent, /还有 \d+ 天/, '必须带倒计时文案');

    const list = doc.getElementById('eventsList');
    assert.match(list.textContent, /高数期末/, '抽屉管理列表里也应当有一行');
    assert.ok(list.querySelector('[data-action="delete-event"]'), '管理行必须带删除按钮');

    // 数据真的落盘了：学期对象上挂着清洗过的 events
    const saved = JSON.parse(w.localStorage.getItem('wb_courseforge_v1') || 'null');
    assert.ok(saved, 'localStorage 里应当有工作区');
    const sems = saved.semesters || [];
    const found = sems.some((s) => Array.isArray(s.events) && s.events.some((e) => e.name === '高数期末'));
    assert.ok(found, 'events 必须随学期一起存盘');

    // 输入框应当清空，方便连着录几门考试
    assert.equal(doc.getElementById('eventName').value, '');
    assert.equal(doc.getElementById('eventTime').value, '');
  });
});

D('事件：名称或日期没填就添加 → 不落盘（toast 提示，不弹窗打断）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    const before = w.localStorage.getItem('wb_courseforge_v1');

    // 只有名字没有日期
    doc.getElementById('eventName').value = '没日期的事件';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();
    const after = w.localStorage.getItem('wb_courseforge_v1');
    assert.equal(after, before, '缺日期时绝不能把坏数据写进去');
    assert.equal(doc.getElementById('eventsBar').hidden, true);

    // 只有日期没有名字
    doc.getElementById('eventName').value = '';
    doc.getElementById('eventDate').value = '2027-06-01';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();
    assert.equal(w.localStorage.getItem('wb_courseforge_v1'), before, '缺名字同样不能写');
  });
});

D('事件：删除 → chip 消失、倒计时条回到隐藏（不能残留上一帧）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('eventName').value = '四六级';
    doc.getElementById('eventDate').value = '2027-06-01';
    doc.getElementById('eventKind').value = 'exam';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();
    assert.equal(doc.getElementById('eventsBar').hidden, false);

    doc.querySelector('#eventsList [data-action="delete-event"]').click();
    await flush();
    assert.equal(doc.getElementById('eventsBar').hidden, true, '删光后必须整条隐藏');
    assert.equal(doc.getElementById('eventsBar').textContent, '', '旧 chip 内容也不能残留');
    assert.equal(doc.getElementById('wEvent') ? 1 : 1, 1);   // wEvent 属于挂件页，此处只需不炸
  });
});

// ==================== 考试提醒 / 分享图复制（P3 补强） ====================

/** 相对真实「今天」偏移 n 天后的 'YYYY-MM-DD'（考试提醒判定用的是真实时钟） */
function dateAfterDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => (x < 10 ? '0' + x : String(x));
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

D('考试提醒：添加 3 天后的考试 → 页内提示弹出，账本记下「今天已提醒」', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('eventName').value = '线代期末';
    doc.getElementById('eventDate').value = dateAfterDays(3);
    doc.getElementById('eventKind').value = 'exam';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();

    // jsdom 没有 Notification → deliverAlert 降级成页内提示，正好让我们能断言
    const tip = doc.getElementById('toast');
    assert.equal(tip.hidden, false, '考试提醒应当以页内提示形式出现（jsdom 无系统通知）');
    assert.match(tip.textContent, /考试临近/);
    assert.match(tip.textContent, /线代期末/);
    assert.match(tip.textContent, /3 天后/);

    // 账本落盘且只记今天：今天内重复 tick 不再弹
    const ledger = JSON.parse(w.localStorage.getItem('wb_courseforge_exam_notified') || 'null');
    assert.ok(ledger && typeof ledger === 'object' && !Array.isArray(ledger), '账本应当是对象');
    const ids = Object.keys(ledger);
    assert.equal(ids.length, 1, '账本里只应有这一条考试，实际 ' + JSON.stringify(ledger));
    assert.equal(ledger[ids[0]], dateAfterDays(0), '账本记的必须是今天的日期键');
  });
});

D('考试提醒：8 天外的考试今天不提醒（账本保持为空）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('eventName').value = '远期考试';
    doc.getElementById('eventDate').value = dateAfterDays(8);
    doc.getElementById('eventKind').value = 'exam';
    doc.querySelector('[data-action="add-event"]').click();
    await flush();

    assert.equal(w.localStorage.getItem('wb_courseforge_exam_notified'), null,
      '窗口外的考试不该留任何账');
  });
});

D('分享图复制：jsdom 不支持剪贴板 → 明确提示改用保存，按钮不报错', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    // index.html 里必须有这个按钮（缺了就是文案单一真相源断链）
    const btn = doc.querySelector('[data-action="copy-share"]');
    assert.ok(btn, '分享弹窗外应当挂「复制图片」按钮');
    assert.equal(btn.id, 'btnCopyShare');

    btn.click();
    await flush();
    const tip = doc.getElementById('toast');
    assert.equal(tip.hidden, false, '不支持时应给出明确提示而不是无声失败');
    assert.match(tip.textContent, /不支持复制图片/);
    assert.match(tip.textContent, /保存图片/);
    // 提示后按钮要恢复可用，不能永久禁用
    assert.equal(btn.disabled, false, '提示降级后按钮必须恢复可点');
  });
});

// ==================== WebDAV 云同步接线（P3 后 / v1.0） ====================

D('云同步：设置抽屉里有云同步区，打开后状态行有内容（没有桌面桥时说明当前环境）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    assert.ok(doc.getElementById('cloudUrl'), 'index.html 应有云同步服务器地址输入框');
    assert.ok(doc.getElementById('cloudUser'));
    assert.ok(doc.getElementById('cloudPass'));
    assert.ok(doc.querySelector('[data-action="cloud-save"]'), '保存配置按钮必须在');
    assert.ok(doc.querySelector('[data-action="cloud-upload"]'));
    assert.ok(doc.querySelector('[data-action="cloud-download"]'));

    doc.querySelector('[data-action="open-settings"]').click();
    await flush();
    const state = doc.getElementById('cloudState').textContent;
    assert.ok(state && state !== '—', '打开设置后 cloudState 必须有说明文字，实际：' + JSON.stringify(state));
    assert.match(state, /不支持/, 'jsdom 无桌面桥无 fetch，应明说当前环境不支持');
  });
});

D('云同步：保存配置 → 落盘 localStorage；勾选记住密码才存密码（网页端明文本机）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();

    // 没填全就保存 → 提示且不落盘
    doc.getElementById('cloudUrl').value = 'https://dav.example.com/dav/';
    doc.querySelector('[data-action="cloud-save"]').click();
    await flush();
    assert.match(doc.getElementById('toast').textContent, /完整填写/);
    assert.equal(w.localStorage.getItem('wb_courseforge_webdav_cfg'), null, '配置不全时不能写入');

    // 填全、不勾记住 → 存 url/用户名，不存密码
    doc.getElementById('cloudUser').value = 'kevin';
    doc.getElementById('cloudPass').value = 'app-pass';
    doc.querySelector('[data-action="cloud-save"]').click();
    await flush();
    let cfg = JSON.parse(w.localStorage.getItem('wb_courseforge_webdav_cfg'));
    assert.equal(cfg.url, 'https://dav.example.com/dav', '尾部斜杠应被清洗');
    assert.equal(cfg.username, 'kevin');
    assert.equal(cfg.password, undefined, '不记住密码时绝不能落盘');

    // 勾选记住 → 网页端明文存（这是勾选时已被告知的取舍）
    doc.getElementById('cloudRemember').checked = true;
    doc.querySelector('[data-action="cloud-save"]').click();
    await flush();
    cfg = JSON.parse(w.localStorage.getItem('wb_courseforge_webdav_cfg'));
    assert.equal(cfg.password, 'app-pass', '勾选记住后网页端按明文本机存储');
  });
});

D('云同步：jsdom（无桥无 fetch）点上传/恢复 → 明确提示不支持且按钮恢复可点', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('cloudUrl').value = 'https://dav.example.com/dav';
    doc.getElementById('cloudUser').value = 'kevin';
    doc.getElementById('cloudPass').value = 'app-pass';

    const up = doc.getElementById('btnCloudUpload');
    up.click();
    await flush();
    assert.match(doc.getElementById('toast').textContent, /不支持云同步/);
    assert.equal(up.disabled, false, '提示后按钮必须恢复可点');

    const down = doc.getElementById('btnCloudDownload');
    down.click();
    await flush();
    assert.match(doc.getElementById('toast').textContent, /不支持云同步/);
    assert.equal(down.disabled, false);
  });
});

D('云同步：服务器地址只认 http(s)，ftp/file 直接拒（不发任何请求）', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    doc.getElementById('cloudUrl').value = 'ftp://dav.example.com';
    doc.getElementById('cloudUser').value = 'kevin';
    doc.getElementById('cloudPass').value = 'app-pass';
    doc.querySelector('[data-action="cloud-upload"]').click();
    await flush();
    assert.match(doc.getElementById('toast').textContent, /完整填写/, '非法地址应被配置清洗拦下');
    // 坏配置也不该留下任何云同步痕迹
    assert.equal(w.localStorage.getItem('wb_courseforge_webdav_cfg'), null);
  });
});

// ==================== 检查更新接线（v1.1） ====================

D('检查更新：无桌面桥时区块保持隐藏；jsdom 点按钮 → 明说「不支持」', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    await flush();
    const field = doc.getElementById('updateField');
    assert.ok(field, 'index.html 应有检查更新区');
    assert.equal(field.hidden, true, '网页版（无桌面桥）必须隐藏检查更新区');
    doc.querySelector('[data-action="open-settings"]').click();
    await flush();
    assert.equal(field.hidden, true);
    doc.getElementById('btnUpdateCheck').click();
    await flush();
    assert.match(doc.getElementById('updateState').textContent, /不支持|刷新即是最新/,
      '点了按钮就要有明确交代，不能干等');
  });
});

D('检查更新：mock 桥 available → 状态行含版本与 github 下载链接，按钮恢复可点', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    let called = 0;
    w.CourseForgeDesktop = {
      isDesktop: true, platform: 'win32',
      update: {
        check: () => {
          called++;
          return Promise.resolve({
            ok: true, status: 'available', current: '0.1.0', latest: '0.2.0',
            downloadUrl: 'https://github.com/kevin0521-wjw/courseforge/releases/tag/v0.2.0',
            message: '发现新版本 v0.2.0（当前 v0.1.0）'
          });
        }
      }
    };
    doc.querySelector('[data-action="open-settings"]').click();
    await flush();
    assert.equal(doc.getElementById('updateField').hidden, false, '有桌面桥就应显示检查更新区');
    const btn = doc.getElementById('btnUpdateCheck');
    btn.click();
    await flush();
    assert.equal(called, 1, '点一次按钮恰好查一次');
    const state = doc.getElementById('updateState');
    assert.match(state.textContent, /发现新版本 v0\.2\.0/);
    const a = state.querySelector('a');
    assert.ok(a, 'available 时必须给「前往下载」链接');
    assert.equal(a.href, 'https://github.com/kevin0521-wjw/courseforge/releases/tag/v0.2.0');
    assert.equal(a.rel, 'noopener noreferrer');
    assert.equal(btn.disabled, false, '检查结束后按钮必须恢复可点');
  });
});

D('检查更新：mock 桥 latest → 显示「已是最新」，不给下载链接', () => {
  return bootDom().then(async (w) => {
    const doc = w.document;
    w.CourseForgeDesktop = {
      isDesktop: true, platform: 'win32',
      update: {
        check: () => Promise.resolve({
          ok: true, status: 'latest', current: '0.2.0', latest: '0.2.0',
          downloadUrl: 'https://github.com/kevin0521-wjw/courseforge/releases/latest',
          message: '已是最新版本（v0.2.0）'
        })
      }
    };
    doc.querySelector('[data-action="open-settings"]').click();
    await flush();
    doc.getElementById('btnUpdateCheck').click();
    await flush();
    const state = doc.getElementById('updateState');
    assert.match(state.textContent, /已是最新/);
    assert.equal(state.querySelector('a'), null, '已是最新时不该放下载链接（避免误引导重装）');
  });
});
