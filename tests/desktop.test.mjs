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
    'edu:grab', 'edu:login', 'edu:open',
    // 桌面外壳：推送课表快照 + 读写小组件显隐状态
    'shell:push', 'shell:status', 'shell:widget-hide', 'shell:widget-show',
    'shell:widget-toggle'
  ], '暴露的通道清单变化必须是有意为之：每多一个通道就多一个被页面调用的入口');
});

test('preload-widget.js：小组件窗口的能力面比主窗口更小', async () => {
  const src = await readFile(fileURLToPath(new URL('../desktop/preload-widget.js', import.meta.url)), 'utf-8');
  assert.ok(/contextBridge\.exposeInMainWorld/.test(src));
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(src),
    '不能让小组件页面直接拿到 ipcRenderer');
  assert.ok(!/\bipcRenderer:\s*ipcRenderer\b/.test(src));

  const invokes = [...src.matchAll(/ipcRenderer\.invoke\(\s*'([\w:-]+)'/g)].map((m) => m[1]);
  // 小组件只需要「取数据 / 隐藏自己 / 打开主窗口」三件事 —— 没有任何教务系统能力
  assert.deepEqual(invokes.sort(), ['widget:hide', 'widget:open-main', 'widget:view'],
    '小组件是一个纯展示窗口，能力面扩大必须是有意为之');
  assert.ok(!/edu:/.test(src), '小组件不该有任何教务系统通道');

  // 订阅走 ipcRenderer.on；回调只能收数据，不能把 IpcRendererEvent 透传给页面
  // （那个对象上挂着 sender，等于把主进程引用递了出去）
  const onCalls = [...src.matchAll(/ipcRenderer\.on\(\s*'([\w:-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(onCalls, ['widget:update']);
  assert.ok(/\(event,\s*view\)\s*=>\s*cb\(view\)/.test(src) || /\(event, view\) => cb\(view\)/.test(src),
    'onUpdate 必须只把 view 交给回调，不透传 event');
});

// ==================== 打包配置与主进程的一致性 ====================
//
// 为什么要有这几条：
//  打包配置的 files 白名单和主进程的 require 是两处各自独立的清单。
//  加了新模块却忘了改白名单 —— 开发态一切正常，打包后才在启动那一刻
//  报 Cannot find module。这类错「打包成功」是看不出来的（构建产物照样生成），
//  只能靠断言锁住。少一个文件不会让构建失败，只会让用户装完打不开。

const DESKTOP_PKG = JSON.parse(
  await readFile(fileURLToPath(new URL('../desktop/package.json', import.meta.url)), 'utf-8'));

const _preloadForPack = await readFile(
  fileURLToPath(new URL('../desktop/preload.js', import.meta.url)), 'utf-8');

const BUILD = DESKTOP_PKG.build || {};
const FILE_PATTERNS = BUILD.files || ['**/*'];

/** electron-builder 的 files 是 glob；这里只实现本项目会用到的 `*` / `**` / `!` 前缀 */
function globRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*');
  return new RegExp('^' + body + '$');
}

function isPacked(rel) {
  const inc = FILE_PATTERNS.filter((p) => !p.startsWith('!'));
  const exc = FILE_PATTERNS.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  if (exc.some((p) => globRe(p).test(rel))) return false;
  return inc.some((p) => globRe(p).test(rel));
}

/** 取出源码里所有「相对 require」的目标，统一成 `a/b.js` 形式（包名不算） */
function localRequires(src) {
  const out = new Set();
  for (const m of src.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
    let p = m[1].replace(/^\.\//, '');
    if (!/\.[a-z]+$/i.test(p)) p += '.js';
    out.add(p);
  }
  return [...out];
}

test('打包白名单必须覆盖主进程的每一个本地依赖', () => {
  const deps = [...new Set([...localRequires(MAIN_SRC), ...localRequires(_preloadForPack)])];
  assert.ok(deps.length >= 2, '至少应识别出 edu-login.js 与 cred-store.js 两个本地依赖，实际：'
    + JSON.stringify(deps));
  for (const d of deps) {
    assert.ok(isPacked(d),
      '打包白名单漏了 ' + d + '：构建仍会成功，但装完启动就报 Cannot find module');
  }
});

test('打包入口与 package.json 必须在白名单内', () => {
  assert.ok(isPacked(DESKTOP_PKG.main), 'main 字段指向的入口必须被打包：' + DESKTOP_PKG.main);
  assert.ok(isPacked('package.json'), 'package.json 必须被打包 —— Electron 靠它找 main');
  assert.equal(DESKTOP_PKG.main, 'main.js');
});

test('extraResources 的落点必须和 main.js 读的路径一致', () => {
  const res = BUILD.extraResources || [];
  const web = res.find((r) => r && typeof r === 'object' && r.to && /web$/.test(String(r.from || '')));
  assert.ok(web, '应有把 web/ 带进包的 extraResources 配置');

  // 不硬编码 'web'：改成别的名字也行，但必须和主进程读的路径一起改。
  // 这条断言锁的是「两处一致」，不是「必须叫 web」。
  const expected = new RegExp("path\\.join\\(process\\.resourcesPath,\\s*'" + web.to + "'\\)");
  assert.ok(expected.test(MAIN_SRC),
    '打包态必须用 process.resourcesPath 拼 ' + web.to + '/，否则页面路径会飘到包外面');
  assert.ok(/app\.isPackaged/.test(MAIN_SRC), '必须按 app.isPackaged 区分开发态与打包态两条路径');
});

test('打包只出 x64，并复用本地 Electron（不再多下一份 100MB+）', () => {
  const flat = JSON.stringify((BUILD.win && BUILD.win.target) || '');
  assert.ok(/x64/.test(flat), '应显式指定 x64 目标');
  assert.ok(!/ia32/.test(flat), '不要顺带出 ia32 —— 那会另外下载一份 Electron');
  assert.ok(BUILD.electronDist, '必须设置 electronDist 复用已装好的 Electron');
  assert.ok(/node_modules[\\/]electron[\\/]dist/.test(BUILD.electronDist),
    'electronDist 应指向本地 electron 发行版：' + BUILD.electronDist);
});

test('安装包文件名不含中文（避开命令行与下载环节的编码坑）', () => {
  const name = BUILD.artifactName || '';
  if (!name) return; // 没配时 electron-builder 会用 productName，中文就会进文件名
  assert.ok(/^[\x20-\x7e]+$/.test(name), 'artifactName 必须是纯 ASCII：' + name);
});
