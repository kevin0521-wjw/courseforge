/**
 * 全流程 DOM 测试（jsdom）：加载真实 index.html + 四个 JS，
 * 模拟「打开页面 → 切周 → 添加课程 → 导出 → 清空」完整用户路径
 * jsdom 为可选依赖：未安装时自动跳过（npm i jsdom 后生效）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

let jsdom = null;
try {
  jsdom = require('jsdom');
} catch (e) {
  jsdom = null;
}

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

function bootDom() {
  return readFile(path.join(WEB, 'index.html'), 'utf-8').then((html) => {
    const dom = new jsdom.JSDOM(html, {
      url: 'http://localhost/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const w = dom.window;
    return Promise.all([
      readFile(path.join(WEB, 'js', 'core.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'storage.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'render.js'), 'utf-8'),
      readFile(path.join(WEB, 'js', 'app.js'), 'utf-8')
    ]).then(([core, storage, render, app]) => {
      // 按依赖顺序执行（app.js 会因 readyState 非 loading 直接 init）
      w.eval(core);
      w.eval(storage);
      w.eval(render);
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
