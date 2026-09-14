/**
 * 多学期（工作区）UI 回归护栏
 *
 * 这一层锁的是「静态检查拦不住、只有真机上才看得出来」的问题：
 *  - render.js 产出的 class 名必须在 style.css 里有对应样式（否则列表裸奔成无样式文本）
 *  - 移动端复合选择器优先级问题（.sem-actions .btn 压过 .btn）
 *  - 弹窗 / 列表的 DOM 元素与 data-action 必须与 app.js 的处理函数对上
 *
 * 说明：这些断言是「护栏」——它们不验证视觉效果，只保证关键属性不被改坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const R = (p) => fileURLToPath(new URL(p, import.meta.url));

const load = async () => {
  const [css, render, app, html] = await Promise.all([
    readFile(R('../web/css/style.css'), 'utf-8'),
    readFile(R('../web/js/render.js'), 'utf-8'),
    readFile(R('../web/js/app.js'), 'utf-8'),
    readFile(R('../web/index.html'), 'utf-8')
  ]);
  return { css, render, app, html };
};

/** 按大括号配对提取媒体查询内容 */
function extractBlock(css, marker) {
  const i = css.indexOf(marker);
  assert.ok(i >= 0, 'CSS 中找不到：' + marker);
  const open = css.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, j);
    }
  }
  throw new Error('大括号未闭合：' + marker);
}

// ==================== render.js 产出的 class 必须有样式 ====================

test('学期列表：renderSemesterList 产出的每个 class 都在 CSS 中有定义', async () => {
  const { css } = await load();
  // 与 render.js 的 renderSemesterList 输出严格对应
  const classes = ['sem-list', 'sem-row', 'sem-active', 'sem-main', 'sem-name', 'sem-meta', 'sem-actions'];
  for (const c of classes) {
    assert.ok(new RegExp('\\.' + c + '\\b').test(css),
      'render.js 会输出 .' + c + '，style.css 里必须有对应规则，否则列表无样式裸奔');
  }
});

test('学期列表：当前学期样式必须比普通行更醒目（描边或左侧色条）', async () => {
  const { css } = await load();
  const rule = css.match(/\.sem-row\.sem-active\s*\{([^}]*)\}/);
  assert.ok(rule, '必须有 .sem-row.sem-active 规则');
  assert.ok(/border-color|box-shadow|background/.test(rule[1]),
    '当前学期要用描边/左侧色条/底色区分，否则用户看不出自己正在改哪个学期');
});

test('学期名与元信息：长名称必须省略号截断而不是撑破布局', async () => {
  const { css } = await load();
  for (const sel of ['sem-name', 'sem-meta']) {
    const rule = css.match(new RegExp('\\.' + sel + '\\s*\\{([^}]*)\\}'));
    assert.ok(rule, '缺少 .' + sel + ' 规则');
    assert.ok(/text-overflow:\s*ellipsis/.test(rule[1]), '.' + sel + ' 需要省略号截断');
    assert.ok(/overflow:\s*hidden/.test(rule[1]), '.' + sel + ' 需要 overflow: hidden');
  }
  // min-width:0 是 flex 子项能被截断的前提，漏了就永远不省略
  const main = css.match(/\.sem-main\s*\{([^}]*)\}/);
  assert.ok(main && /min-width:\s*0/.test(main[1]),
    '.sem-main 必须有 min-width: 0，否则 flex 子项拒绝收缩，省略号失效');
});

test('新建学期按钮：整行可点，避免右侧留一块空白区', async () => {
  const { css } = await load();
  const rule = css.match(/\.sem-add-btn\s*\{([^}]*)\}/);
  assert.ok(rule, '缺少 .sem-add-btn 规则');
  assert.ok(/width:\s*100%/.test(rule[1]), '.sem-add-btn 应占满一行');
  assert.ok(/justify-content:\s*center/.test(rule[1]), '.sem-add-btn 内容应居中');
});

// ==================== 移动端 ====================

test('移动端：学期行改成上下两行堆叠，避免名称被挤成一列字', async () => {
  const { css } = await load();
  const mobile = extractBlock(css, '@media (max-width: 768px)');
  assert.ok(/\.sem-row\s*\{[^}]*flex-direction:\s*column/.test(mobile),
    '窄屏下 .sem-row 必须改为纵向堆叠（对齐工具栏中文竖排那次踩坑）');
  assert.ok(/\.sem-actions\s*\{[^}]*justify-content:\s*flex-end/.test(mobile),
    '窄屏下操作按钮应靠右对齐');
});

test('移动端：.sem-actions .btn 是复合选择器，必须显式覆盖 44px 点击区', async () => {
  const { css } = await load();
  const mobile = extractBlock(css, '@media (max-width: 768px)');
  // .sem-actions .btn 优先级 (0,2,0) > .btn (0,1,0)，只写 .btn 完全无效
  assert.ok(/\.sem-actions\s+\.btn[\s\S]{0,120}min-height:\s*44px/.test(mobile),
    '必须单独列出 .sem-actions .btn 才能生效（同 .parity-bar .btn 的坑）');
  assert.ok(/\.sem-actions\s+\.btn-icon[\s\S]{0,120}min-width:\s*44px/.test(mobile),
    '.sem-actions .btn-icon 需要 44px 宽，否则相邻图标容易点错');
});

// ==================== DOM 与事件接线 ====================

test('index.html：多学期相关元素齐全，且都在表单/弹窗结构内', async () => {
  const { html } = await load();
  for (const id of ['semesterList', 'semesterModal', 'semesterName', 'semesterStart', 'semesterKeepTimes', 'semesterCopyCourses']) {
    assert.ok(html.includes('id="' + id + '"'), 'index.html 缺少 #' + id);
  }
  // 弹窗默认收起，否则首屏就盖住课表
  assert.ok(/id="semesterModal"[^>]*\bhidden\b/.test(html), '#semesterModal 初始必须 hidden');
  // 两个复选框默认值：沿用作息=勾选、复制课程=不勾选
  assert.ok(/id="semesterKeepTimes"\s+checked/.test(html), '「沿用周数/作息」应默认勾选');
  assert.ok(/id="semesterCopyCourses">/.test(html), '「复制课程」应默认不勾选');
  // 名称输入限制 20 字，与 core.js renameSemester 的截断长度一致
  assert.ok(/id="semesterName"[^>]*maxlength="20"/.test(html), '学期名应限制 20 字（与 core 截断一致）');
});

test('app.js：六个多学期动作全部注册进 ACTIONS 映射表', async () => {
  const { app } = await load();
  const block = app.match(/var ACTIONS = \{([\s\S]*?)\n  \};/);
  assert.ok(block, '找不到 ACTIONS 映射表');
  const actions = ['open-semester-modal', 'close-semester-modal', 'create-semester',
    'switch-semester', 'rename-semester', 'delete-semester'];
  for (const a of actions) {
    assert.ok(new RegExp('[\'"]' + a + '[\'"]\\s*:').test(block[1]),
      'ACTIONS 里漏了 ' + a + ' → 按钮点了毫无反应（静默失败）');
  }
});

test('app.js：学期弹窗支持遮罩点击与 Esc 关闭', async () => {
  const { app } = await load();
  assert.ok(/e\.target\.id === 'semesterModal'[\s\S]{0,60}closeSemesterModal\(\)/.test(app),
    '点击遮罩应关闭学期弹窗');
  const esc = app.match(/if \(e\.key === 'Escape'\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(esc && /closeSemesterModal\(\)/.test(esc[1]), 'Esc 应能关闭学期弹窗');
});

test('app.js：改动学期的每个分支都必须落盘（persist）', () => {
  // 回归：重命名曾漏写 persist()，内存改了但 localStorage 没改，刷新即回滚
  return load().then(({ app }) => {
    const fns = ['switchSemester', 'onCreateSemester', 'onRenameSemester', 'onDeleteSemester'];
    for (const fn of fns) {
      const m = app.match(new RegExp('function ' + fn + '\\s*\\([^)]*\\)\\s*\\{'));
      assert.ok(m, '找不到函数 ' + fn);
      // 从函数开头截到下一个顶层「  function 」声明为止
      const rest = app.slice(m.index);
      const nextFn = rest.indexOf('\n  function ', 10);
      const body = nextFn === -1 ? rest : rest.slice(0, nextFn);
      assert.ok(/persist\(\)/.test(body),
        fn + ' 必须以 persist() 落盘，否则内存改动会在刷新后丢失');
    }
  });
});

test('app.js：切换/删除学期后必须重新装载工作副本，避免串台', () => {
  return load().then(({ app }) => {
    // 切学期要 loadSemester；删当前学期后 activeId 会变，也要重新装载
    const sw = app.match(/function switchSemester[\s\S]*?\n  \}/);
    assert.ok(sw && /loadSemester\(/.test(sw[0]), 'switchSemester 必须调用 loadSemester 重新装载课程');

    const del = app.match(/function onDeleteSemester[\s\S]*?\n  \}/);
    assert.ok(del && /loadSemester\(/.test(del[0]), 'onDeleteSemester 删掉当前学期后必须重新装载剩下的学期');
  });
});
