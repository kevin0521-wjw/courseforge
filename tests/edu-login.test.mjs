/**
 * 教务自动登录脚本生成测试
 *
 * 这层测试回答两个问题：
 *  1. 注入进来的用户名/密码**原样**填进了表单吗？（密码里一个引号、一个反斜杠
 *     都可能把脚本拼断 —— 而「拼断」的表现是静默失败，用户只会看到「登录没反应」）
 *  2. 恶意的用户名能不能借这条路在教务页面里执行任意代码？
 *     用户名是用户自己输入的，但「自己输入的」不等于「可信的」——
 *     用户可能从聊天里复制粘贴，也可能贴进来一段带引号的怪东西。
 *     所以按不可信输入处理，用 JSON.stringify 转义，然后用真实 DOM 验证逃逸不出去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EduLogin = require(fileURLToPath(new URL('../desktop/edu-login.js', import.meta.url)));

/** jsdom 是可选依赖，缺失时 DOM 相关用例整组跳过（与 app.dom.test.cjs 一致） */
function loadJsdom() {
  const candidates = [() => require('jsdom')];
  for (const dir of String(process.env.NODE_PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(() => require(path.join(dir, 'jsdom')));
  }
  for (const fn of candidates) {
    try { return fn(); } catch (e) { /* 试下一个 */ }
  }
  return null;
}
const jsdom = loadJsdom();

const openWindows = new Set();
if (typeof test.after === 'function') {
  test.after(() => {
    // jsdom 的定时器挂在窗口上，不关窗口进程退不出去 —— 必须统一收尾
    for (const w of openWindows) { try { w.close(); } catch (e) { /* 忽略 */ } }
  });
}
const D = jsdom === null
  ? (name, fn) => test(name, { skip: '未安装 jsdom（可选依赖），跳过 DOM 相关用例' }, fn)
  : test;

/** 造一个带登录表单的 jsdom 环境，url 用真实的登录页地址 */
function loginDom(html) {
  const dom = new jsdom.JSDOM(
    html || '<!doctype html><html><body>' +
      '<input id="yhm"><input id="mm" type="text">' +
      '<button id="dl" type="button">登录</button>' +
      '<div id="tips" style="display:none"></div></body></html>',
    { runScripts: 'outside-only', url: 'https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html' }
  );
  openWindows.add(dom.window);
  return dom;
}

// ==================== 纯函数：地址归一化 ====================

test('loginUrlFrom：任何教务系统地址都归一到登录页，非法输入返回 null', () => {
  assert.equal(
    EduLogin.loginUrlFrom('https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs&_t=1788358153110&echarts=1'),
    'https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html',
    '学生菜单地址应归一到登录页');
  assert.equal(
    EduLogin.loginUrlFrom('https://jwxt.shu.edu.cn/'),
    'https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html');
  assert.equal(
    EduLogin.loginUrlFrom('http://a.example:8080/x'),
    'http://a.example:8080/jwglxt/xtgl/login_slogin.html',
    '端口要保留，有的学校教务在 8080');

  assert.equal(EduLogin.loginUrlFrom('jwxt.shu.edu.cn'), null, '缺协议一律拒绝（协议由上层补全）');
  assert.equal(EduLogin.loginUrlFrom('file:///C:/x.html'), null);
  assert.equal(EduLogin.loginUrlFrom('javascript:alert(1)'), null);
  assert.equal(EduLogin.loginUrlFrom(''), null);
  assert.equal(EduLogin.loginUrlFrom(null), null);
});

test('isLoginPage：只有停在登录页才算「还没登录」', () => {
  assert.equal(EduLogin.isLoginPage('https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html'), true);
  assert.equal(EduLogin.isLoginPage('https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html?x=1'), true);
  assert.equal(EduLogin.isLoginPage('https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs'), false);
  assert.equal(EduLogin.isLoginPage(''), false);
});

// ==================== 纯函数：脚本拼装的安全性 ====================

test('buildFillScript：密码原样传递（不做字符过滤），靠转义而不是靠清洗', () => {
  // 「过滤掉引号」这类做法会改掉用户真实密码，必须禁止
  const pw = 'a"b\\c\nd\'e';
  const script = EduLogin.buildFillScript('user', pw);
  assert.ok(script.includes(JSON.stringify(pw)), '应把密码按 JSON 转义后原样注入');
  assert.ok(!script.includes('yhm.value = "user"'), '不能裸拼字符串字面量');
  assert.ok(script.includes(`var u = ${JSON.stringify('user')}`));
});

test('buildFillScript：点的是页面自己的登录按钮，而不是自己发请求', () => {
  const script = EduLogin.buildFillScript('u', 'p');
  assert.ok(/getElementById\("dl"\)/.test(script), '应找页面上的 #dl 按钮');
  assert.ok(/dl\.click\(\)/.test(script), '应由页面自己的 login.js 完成加密封装与提交');
  assert.ok(!/fetch\(|XMLHttpRequest|login_slogin\.html"/.test(script),
    '不能在脚本里自己提交表单 —— 那样就得自己实现 RSA 与 csrftoken');
});

test('buildFetchScript：同源凭据 + 参数全部转义', () => {
  const evilUrl = '/jwglxt/kbcx/x.html?a=\'&b="';
  const script = EduLogin.buildFetchScript(evilUrl, 'xnm=\'&xqm=');
  assert.ok(script.includes('credentials: "same-origin"'), '必须带同源 cookie，否则接口没会话');
  assert.ok(script.includes(JSON.stringify(evilUrl)), 'URL 要转义后注入');
  assert.ok(script.includes(JSON.stringify('xnm=\'&xqm=')), '请求体要转义后注入');
});

// ==================== DOM：真的填进表单了吗 ====================

D('填表脚本：把值原样写进 #yhm / #mm 并触发登录按钮', () => {
  const dom = loginDom();
  const doc = dom.window.document;
  let clicked = 0;
  doc.getElementById('dl').addEventListener('click', () => { clicked++; });

  const res = dom.window.eval(EduLogin.buildFillScript('26125005', 'P@ss 机密-1'));

  assert.equal(res.ok, true);
  assert.equal(doc.getElementById('yhm').value, '26125005');
  assert.equal(doc.getElementById('mm').value, 'P@ss 机密-1', '含空格与中文的密码也要一字不差');
  assert.equal(clicked, 1, '应触发一次登录');
});

D('填表脚本：密码里的引号/反斜杠/换行不会拼断脚本', () => {
  const dom = loginDom();
  const doc = dom.window.document;
  const pw = 'a"b\\c\nd\'e;//';

  const res = dom.window.eval(EduLogin.buildFillScript('u', pw));
  assert.equal(res.ok, true, '脚本本身必须仍然可执行（拼断会静默失败，最难查）');

  // 注意：换行读回来会消失，这不是转义漏了，而是 <input> 按 HTML 规范
  // 本身就会剥掉换行（值消毒）。密码框里也输不进换行，所以不影响真实使用；
  // 这里把行为写实，免得以后有人看到「换行没了」去查错方向。
  assert.equal(doc.getElementById('mm').value, 'a"b\\cd\'e;//');
  assert.ok(doc.getElementById('mm').value.includes('"'), '引号必须原样保留');
  assert.ok(doc.getElementById('mm').value.includes('\\'), '反斜杠必须原样保留');
  assert.ok(doc.getElementById('mm').value.includes(';//'), '分号与注释符也必须原样保留');
});

D('注入攻击：恶意用户名/密码不能在教务页面里执行代码', () => {
  const dom = loginDom();
  const w = dom.window;
  const doc = w.document;

  const res = w.eval(EduLogin.buildFillScript(
    'x";globalThis.PWNED_USER=1;//',
    '\';globalThis.PWNED_PASS=1;//'
  ));

  assert.equal(res.ok, true);
  assert.equal(w.PWNED_USER, undefined, '用户名里的注入必须被转义掉');
  assert.equal(w.PWNED_PASS, undefined, '密码里的注入必须被转义掉');
  // 值仍要原样填进去：转义不能改变用户输入本身
  assert.equal(doc.getElementById('yhm').value, 'x";globalThis.PWNED_USER=1;//');
});

D('填表脚本：学校开了验证码就收手，交给人工（不猜、不重试）', () => {
  const dom = loginDom('<!doctype html><html><body>' +
    '<input id="yhm"><input id="mm">' +
    '<div id="yzmDiv"><img id="yzmPic"></div>' +
    '<button id="dl" type="button">登录</button>' +
    '<div id="tips"></div></body></html>');
  const doc = dom.window.document;
  let clicked = 0;
  doc.getElementById('dl').addEventListener('click', () => { clicked++; });

  // jsdom 不实现布局，offsetParent 恒为 null；显式造出「可见」的情形
  Object.defineProperty(doc.getElementById('yzmDiv'), 'offsetParent', { value: doc.body });

  const res = dom.window.eval(EduLogin.buildFillScript('u', 'p'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'captcha');
  assert.equal(clicked, 0, '要验证码时不该提交任何一次 —— 提交只会白送一次失败计数');
  assert.equal(doc.getElementById('yhm').value, '', '也不该先把密码填进去');
});

D('填表脚本：登录页改版（找不到输入框）要给明确原因，而不是静默失败', () => {
  const dom = loginDom('<!doctype html><html><body><p>新版登录页</p></body></html>');
  const res = dom.window.eval(EduLogin.buildFillScript('u', 'p'));
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noform');
});

D('填表脚本：顺带清掉上一次的报错、勾上用户协议（有的学校要求）', () => {
  const dom = loginDom('<!doctype html><html><body>' +
    '<input id="yhm"><input id="mm">' +
    '<button id="dl" type="button">登录</button>' +
    '<input type="checkbox" id="agreePolicy">' +
    '<div id="tips" style="display:block">用户名或密码错误</div></body></html>');
  const doc = dom.window.document;

  dom.window.eval(EduLogin.buildFillScript('u', 'p'));
  assert.equal(doc.getElementById('tips').textContent, '', '上次的报错要清掉，否则会把新旧错误看混');
  assert.equal(doc.getElementById('agreePolicy').checked, true, '用户协议要勾上，否则提交会被前端拦住');
});

// ==================== DOM：状态判定 ====================

D('状态脚本：登录中 / 失败 / 成功三种信号都能读出来', () => {
  const dom = loginDom();
  const doc = dom.window.document;
  const dl = doc.getElementById('dl');
  const tips = doc.getElementById('tips');

  // 登录中：按钮被禁用
  dl.setAttribute('disabled', 'disabled');
  let st = dom.window.eval(EduLogin.buildStatusScript());
  assert.equal(st.busy, true);
  assert.equal(EduLogin.classifyStatus(st).state, 'pending', '登录中不能误判成失败');

  // 失败：按钮恢复 + 有提示
  dl.removeAttribute('disabled');
  tips.textContent = '用户名或密码错误';
  st = dom.window.eval(EduLogin.buildStatusScript());
  const cls = EduLogin.classifyStatus(st);
  assert.equal(cls.state, 'fail');
  assert.ok(/用户名或密码错误/.test(cls.message), '必须把学校给的原因原样带给用户');

  // 成功：页面已经跳走（offsite url 需要另造一个窗口）
  const away = new jsdom.JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs'
  });
  openWindows.add(away.window);
  assert.equal(EduLogin.classifyStatus(away.window.eval(EduLogin.buildStatusScript())).state, 'success');
});

test('classifyStatus：拿不到状态时只能算「继续等」，绝不能算成功', () => {
  assert.equal(EduLogin.classifyStatus(null).state, 'pending');
  assert.equal(EduLogin.classifyStatus(undefined).state, 'pending');
  // 页面正在跳转时脚本会执行失败 → 拿到 null。此时判成功会掩盖真实结果
  assert.equal(EduLogin.classifyStatus({ onLoginPage: true, busy: false, tip: '' }).state, 'pending');
});

test('withLockHint：连续失败会触发验证码/锁定，文案里要说出来', () => {
  assert.ok(/别重复尝试|验证码/.test(EduLogin.withLockHint('密码错误次数过多，请稍后再试')));
  assert.equal(EduLogin.withLockHint('用户名或密码错误'), '用户名或密码错误',
    '普通错误不必加戏，保持学校原文更可信');
});

// ==================== DOM：菜单发现与接口请求 ====================

D('菜单发现：只认站内 /jwglxt/ 路径，外链一律不要', () => {
  const dom = loginDom('<!doctype html><html><body>' +
    '<a href="/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151">学生课表查询</a>' +
    '<a href="/jwglxt/xtgl/index_initMenu.html?jsdm=xs">首页</a>' +
    '<a href="https://evil.example/steal?gnmkdm=N1">看起来正常的外链</a>' +
    '<a href="/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151">学生课表查询</a>' +
    '</body></html>');

  const found = dom.window.eval(EduLogin.buildMenuProbeScript());
  const urls = found.map((f) => f.url);

  assert.equal(urls.length, 1, '重复菜单项要去重，首页这种不带 kb 的也不该混进来');
  assert.equal(urls[0], '/jwglxt/kbcx/xskbcx_cxXsgrkb.html?gnmkdm=N2151');
  assert.equal(found[0].text, '学生课表查询');
  assert.ok(urls.every((u) => u.indexOf('evil.example') === -1), '外链绝不能进入候选列表');
});

D('接口请求：URL 与请求体正确送达，且没有逃逸出脚本', async () => {
  const dom = loginDom();
  const w = dom.window;
  let captured = null;
  w.fetch = (url, opts) => {
    captured = { url, opts };
    return Promise.resolve({
      status: 200,
      url: String(url),
      text: () => Promise.resolve('{"kbList":[{"kcmc":"高数"}]}')
    });
  };

  const evil = '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151&x=\';globalThis.PWNED=1;//';
  const res = await w.eval(EduLogin.buildFetchScript(evil, 'xnm=&xqm='));

  assert.equal(w.PWNED, undefined, 'URL 里的注入必须被转义掉');
  assert.equal(captured.url, evil, 'URL 要原样送达（转义不能改变请求本身）');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.credentials, 'same-origin');
  assert.equal(captured.opts.body, 'xnm=&xqm=');
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"kbList":[{"kcmc":"高数"}]}');
});

D('接口请求：网络异常要变成可读结果，不能把异常抛进主进程', async () => {
  const dom = loginDom();
  const w = dom.window;
  w.fetch = () => Promise.reject(new Error('Failed to fetch'));

  const res = await w.eval(EduLogin.buildFetchScript('/jwglxt/x.html', ''));
  assert.equal(res.status, 0);
  assert.ok(/Failed to fetch/.test(res.error));
});

// ==================== 外壳识别 ====================

test('hasKbList：认得出课表数据，也不会把登录页 HTML 当成课表', () => {
  assert.equal(EduLogin.hasKbList('{"kbList":[{"kcmc":"高数"}]}'), true);
  assert.equal(EduLogin.hasKbList('{"data":{"kbList":[{"kcmc":"高数"}]}}'), true);
  assert.equal(EduLogin.hasKbList('[{"kcmc":"高数"}]'), true);
  assert.equal(EduLogin.hasKbList('{"xskbList":[{"kcmc":"高数"}]}'), true);

  assert.equal(EduLogin.hasKbList('{"kbList":[]}'), false, '空数组说明这个接口不是课表接口');
  assert.equal(EduLogin.hasKbList('<!DOCTYPE html><html>请登录</html>'), false);
  assert.equal(EduLogin.hasKbList('{"errcode":-1}'), false);
  assert.equal(EduLogin.hasKbList(''), false);
});

test('内置候选：页面路径与数据接口路径成对给出，且都是站内路径', () => {
  assert.ok(EduLogin.TIMETABLE_CANDIDATES.length >= 1);
  for (const c of EduLogin.TIMETABLE_CANDIDATES) {
    assert.ok(/^\/jwglxt\//.test(c.page), '页面必须用站内绝对路径，避免被外部地址带跑');
    assert.ok(/^\/jwglxt\//.test(c.api), '接口同样必须是站内绝对路径');
    assert.ok(/gnmkdm=/.test(c.page));
  }
});
