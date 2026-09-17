/**
 * 桌面端（Electron）逻辑测试
 *
 * 为什么可以脱离 Electron 测：
 *  「取页面 HTML」与「校验网址」这两段是主进程里唯一的真逻辑，
 *  但它们本身不依赖 electron 模块（只依赖 document / URL）。
 *  把这两段源码抽出来在 jsdom + Node 上跑，就能覆盖最容易写错的 iframe 合并与协议白名单，
 *  不必真的启动一个 GUI（本机会话内也起不了 Electron 窗口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MAIN_SRC = await readFile(fileURLToPath(new URL('../desktop/main.js', import.meta.url)), 'utf-8');

let jsdom = null;
function loadJsdom() {
  const candidates = [() => require('jsdom')];
  const { delimiter, join } = require('node:path');
  for (const dir of String(process.env.NODE_PATH || '').split(delimiter)) {
    if (dir) candidates.push(() => require(join(dir, 'jsdom')));
  }
  for (const fn of candidates) {
    try { return fn(); } catch (e) { /* 试下一个 */ }
  }
  return null;
}
jsdom = loadJsdom();

/** 按大括号配对从源码里取出一个完整函数定义 */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'main.js 里找不到函数 ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('大括号未闭合：' + name);
}

/** 取出 main.js 里的 GRAB_SCRIPT 常量（按模板字面量求值，\n 才能真正变成换行） */
function loadGrabScript() {
  const m = MAIN_SRC.match(/const GRAB_SCRIPT = `[\s\S]*?`;/);
  assert.ok(m, 'main.js 里找不到 GRAB_SCRIPT');
  return new Function(m[0] + '\nreturn GRAB_SCRIPT;')();
}

const GRAB_SCRIPT = loadGrabScript();
const sanitizeUrl = new Function(extractFn(MAIN_SRC, 'sanitizeUrl') + '\nreturn sanitizeUrl;')();

// ==================== 网址白名单 ====================

test('sanitizeUrl：只放行 http/https，其它协议一律拒绝', () => {
  assert.equal(sanitizeUrl('https://jwb.shu.edu.cn/'), 'https://jwb.shu.edu.cn/');
  assert.equal(sanitizeUrl('http://10.0.0.1/kb'), 'http://10.0.0.1/kb');
  // 用户通常只输域名，应自动补 https
  assert.equal(sanitizeUrl('jwb.shu.edu.cn'), 'https://jwb.shu.edu.cn/');
  assert.equal(sanitizeUrl('   jwb.shu.edu.cn   '), 'https://jwb.shu.edu.cn/');

  // 危险协议必须被拦下（否则等于开了一个任意协议加载器）
  assert.equal(sanitizeUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeUrl('file:///C:/Windows/System32/drivers/etc/hosts'), null);
  assert.equal(sanitizeUrl('about:blank'), null);
  assert.equal(sanitizeUrl(''), null);
  assert.equal(sanitizeUrl('   '), null);
  assert.equal(sanitizeUrl(null), null);
  assert.equal(sanitizeUrl(undefined), null);
  assert.equal(sanitizeUrl(123), null);
});

test('sanitizeUrl：非法网址不能抛异常，只能返回 null', () => {
  for (const bad of ['http://', 'https://', '://x', 'http://[', '%%%']) {
    assert.doesNotThrow(() => sanitizeUrl(bad), '输入 ' + JSON.stringify(bad) + ' 不应抛异常');
  }
});

// ==================== 页面抓取 ====================

const D = jsdom === null
  ? (name, fn) => test(name, { skip: '未安装 jsdom（可选依赖），跳过桌面端抓取测试' }, fn)
  : test;

function makeDom(html) {
  // runScripts: 'outside-only' 才会提供在窗口上下文里执行的 window.eval
  // （默认模式下 eval 落在 Node 上下文，GRAB_SCRIPT 里的 document 会取不到）
  const dom = new jsdom.JSDOM(html, {
    url: 'https://jwb.shu.edu.cn/kb',
    runScripts: 'outside-only'
  });
  return dom.window;
}

D('抓取脚本：返回顶层页面 HTML', () => {
  const w = makeDom('<html><body><h1>个人课表</h1><table><tr><td>高等数学</td></tr></table></body></html>');
  const out = w.eval(GRAB_SCRIPT);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('个人课表'), '应包含页面内容');
  assert.ok(out.includes('高等数学'));
  w.close();
});

D('抓取脚本：同源 iframe 里的课表也要取回来（教务系统课表常在 iframe 里）', () => {
  // 顶层是空壳，真课表在 iframe 里 —— 这是教务系统最常见的一种结构
  const shell = `<html><body>
    <div class="head">教务系统</div>
    <iframe id="f" srcdoc="&lt;html&gt;&lt;body&gt;&lt;table&gt;&lt;tr&gt;&lt;td&gt;高等数学&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
  </body></html>`;
  const w = makeDom(shell);
  const out = w.eval(GRAB_SCRIPT);
  assert.ok(out.includes('高等数学'), 'iframe 内的课表必须被取回，否则直连会解析出空结果');
  assert.ok(out.includes('<!--CourseForgeFrame-->'), '帧之间应有分隔标记');
  assert.ok(out.includes('教务系统'), '顶层内容也要保留（表头信息可能有用）');
  w.close();
});

D('抓取脚本：无 iframe 时不产生多余分隔标记', () => {
  const w = makeDom('<html><body>没有 iframe</body></html>');
  const out = w.eval(GRAB_SCRIPT);
  assert.equal(out.includes('<!--CourseForgeFrame-->'), false);
  w.close();
});

D('抓取脚本：结果能被教务解析器接住（端到端）', () => {
  const kbTable = `<table>
    <tr><td>节次</td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>
    <tr><td>第1节</td><td>高等数学<br>张老师<br>东区一教101<br>1-16周</td><td colspan="4">&nbsp;</td></tr>
  </table>`;
  const w = makeDom('<html><body><div>课表</div>' + kbTable + '</body></html>');
  const grabbed = w.eval(GRAB_SCRIPT);
  w.close();

  const Edu = require(fileURLToPath(new URL('../web/js/edu-html.js', import.meta.url)));
  const res = Edu.parseEduHtml(grabbed);
  assert.equal(res.items.length, 1, '抓回来的 HTML 应能被解析器直接解析，warnings: ' + res.warnings.join(';'));
  assert.equal(res.items[0].name, '高等数学');
  assert.equal(res.items[0].teacher, '张老师');
  assert.equal(res.items[0].location, '东区一教101');
  assert.equal(res.items[0].day, 1);
  // 这个 fixture 没有 rowspan，就是单节；跨节次的合并单元格在 edu-html.test.mjs 里单独覆盖
  assert.deepEqual([res.items[0].startSection, res.items[0].endSection], [1, 1]);
});

// ==================== 主进程与 preload 的一致性 ====================

test('main.js：注册了全部教务 IPC 通道，且都在 whenReady 之后注册', () => {
  assert.ok(/ipcMain\.handle\(\s*'edu:open'/.test(MAIN_SRC));
  assert.ok(/ipcMain\.handle\(\s*'edu:grab'/.test(MAIN_SRC));
  assert.ok(/ipcMain\.handle\(\s*'edu:close'/.test(MAIN_SRC));
  // 自动登录与取课表
  assert.ok(/ipcMain\.handle\(\s*'edu:login'/.test(MAIN_SRC));
  assert.ok(/ipcMain\.handle\(\s*'edu:courses'/.test(MAIN_SRC));
  // 账号存储状态：只回状态，不回密码
  assert.ok(/ipcMain\.handle\(\s*'edu:cred-status'/.test(MAIN_SRC));
  assert.ok(/ipcMain\.handle\(\s*'edu:cred-clear'/.test(MAIN_SRC));
  // handle 必须在 app ready 之后注册（在模块顶层注册会在部分平台报错）
  assert.ok(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*registerEduIpc\(\)/.test(MAIN_SRC),
    'registerEduIpc() 应在 app.whenReady() 回调里调用');
  assert.ok(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]*registerAutoLoginIpc\(\)/.test(MAIN_SRC),
    'registerAutoLoginIpc() 同样应在 whenReady 回调里调用');
});

test('main.js：菜单发现的地址必须是站内 /jwglxt/ 路径（防被篡改的页面带跑会话）', () => {
  // 发现逻辑来自教务页面本身，属于「外部输入」：只允许站内绝对路径，
  // 且必须拼到已登录的 origin 上，不能拿页面给的完整 URL 直接请求
  assert.ok(/\/\^\\\/jwglxt\\\/\/\.test\(url\)/.test(MAIN_SRC),
    'buildCandidates 必须用 /^\\/jwglxt\\// 约束发现的路径');
});

test('main.js：账号只交给人家的主进程，密码不写日志', () => {
  // 凭据存储走 safeStorage，且不把密码拼进任何 console.log
  assert.ok(/createCredStore\(/.test(MAIN_SRC));
  const logs = [...MAIN_SRC.matchAll(/console\.log\(([^\n]*)/g)].map((m) => m[1]);
  for (const line of logs) {
    assert.ok(!/password/.test(line), '日志里不能出现 password：' + line);
  }
});

test('main.js / preload.js：安全基线不变（contextIsolation、无 nodeIntegration）', () => {
  const preload = MAIN_SRC; // 仅用于断言 main.js 的窗口配置
  assert.ok(/contextIsolation:\s*true/.test(preload), '主窗口必须开启 contextIsolation');
  assert.ok(/nodeIntegration:\s*false/.test(preload), '主窗口必须关闭 nodeIntegration');
  // 教务窗口也应使用同样的隔离配置
  const eduWin = MAIN_SRC.match(/eduWindow = new BrowserWindow\(\{[\s\S]*?\}\);/);
  assert.ok(eduWin, '应能找到教务窗口的创建代码');
  assert.ok(/contextIsolation:\s*true/.test(eduWin[0]), '教务窗口同样要开启 contextIsolation');
  assert.ok(/nodeIntegration:\s*false/.test(eduWin[0]), '教务窗口同样要关闭 nodeIntegration');
  assert.ok(/partition:\s*'persist:courseforge-edu'/.test(eduWin[0]),
    '教务窗口应用独立的持久化分区，登录态与主窗口隔离');
});

test('preload.js：不把 ipcRenderer 整个暴露给页面', async () => {
  const preload = await readFile(fileURLToPath(new URL('../desktop/preload.js', import.meta.url)), 'utf-8');
  assert.ok(/contextBridge\.exposeInMainWorld/.test(preload));
  // 只暴露固定动作，绝不能整体交出 ipcRenderer（否则页面被注入脚本后可调用任意通道）
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preload),
    '不能让页面直接拿到 ipcRenderer');
  assert.ok(!/\bipcRenderer:\s*ipcRenderer\b/.test(preload));
  const invokes = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([\w:-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(invokes.sort(), [
    'edu:close', 'edu:courses', 'edu:cred-clear', 'edu:cred-status',
    'edu:grab', 'edu:login', 'edu:open'
  ], '暴露的通道清单变化必须是有意为之：每多一个通道就多一个被页面调用的入口');
});
