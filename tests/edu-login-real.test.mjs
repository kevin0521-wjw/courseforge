/**
 * 真人级回归：拿**上海大学教务系统真实登录页**当夹具跑一遍
 *
 * 为什么需要这层：其余用例都是「按我理解的页面结构写的假 DOM」，
 * 一旦正方改版（改 id、换提示容器、加验证码开关），假 DOM 全绿而真机全废 ——
 * 用户看到的现象是「点了一键登录什么都没发生」，且无法自查。
 * 这份夹具是 2026-09-18 用无头浏览器从 https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html
 * 实抓的 DOM（已去掉 ?time= 随机参数），正方版本 V-9.0。
 *
 * 它同时钉死三件事：
 *  1. 关键选择器（#yhm/#mm/#dl/#tips）在真实页面上确实存在；
 *  2. 现在这套填表脚本在真实页面上能跑通（返回值 ok:true、值真的填进去了）；
 *  3. V-9.0 的失败提示容器是 #dlktsxx（不是只有老版的 #tips）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EduLogin = require(fileURLToPath(new URL('../desktop/edu-login.js', import.meta.url)));
const FIXTURE = fileURLToPath(new URL('./fixtures/jwxt-login-real.html', import.meta.url));

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
const maybe = jsdom ? test : test.skip;
const realHtml = fs.readFileSync(FIXTURE, 'utf-8');

function bootReal() {
  // runScripts:'outside-only' 才会让 window.eval 跑在页面上下文里（document 可见），
  // 同时页面的 <script src> 不会被加载 —— 正好避免触发真实登录逻辑
  const dom = new jsdom.JSDOM(realHtml, { url: 'https://jwxt.shu.edu.cn/jwglxt/xtgl/login_slogin.html', runScripts: 'outside-only' });
  return dom.window;
}

maybe('真实登录页上，脚本依赖的选择器全部存在', () => {
  const w = bootReal();
  for (const id of ['yhm', 'mm', 'dl', 'tips', 'dlktsxx', 'dlsfbxyzm', 'csrftoken', 'xxdm']) {
    assert.ok(w.document.getElementById(id), '真实页面缺少 #' + id + '（学校改版了，脚本要跟着改）');
  }
  w.close();
});

maybe('真实登录页上，学校代码与「是否需要验证码」的配置符合预期', () => {
  const w = bootReal();
  assert.equal(w.document.getElementById('xxdm').value, '10280', '上海大学 xxdm 变了？');
  // dlsfbxyzm=0 表示当前校方配置不要求验证码；若哪天变成 1，下面的填表用例会跟着红
  assert.equal(w.document.getElementById('dlsfbxyzm').value, '0');
  w.close();
});

maybe('填表脚本在真实页面上跑得通，且值真的进了输入框', () => {
  const w = bootReal();
  const res = w.eval(EduLogin.buildFillScript('26123456', 'Shu@2026'));
  assert.equal(res.ok, true, '真实页面上填表脚本应当成功');
  assert.equal(w.document.getElementById('yhm').value, '26123456');
  assert.equal(w.document.getElementById('mm').value, 'Shu@2026');
  // 上一次的失败提示必须被清掉，否则用户分不清新旧报错
  assert.equal(w.document.getElementById('tips').textContent, '');
  assert.equal(w.document.getElementById('dlktsxx').textContent, '');
  w.close();
});

maybe('密码里带引号/反斜杠也原样填进去，不会把脚本拼断', () => {
  const w = bootReal();
  const nasty = 'p"a\\s\'s\\";alert(1);//';
  const res = w.eval(EduLogin.buildFillScript('user', nasty));
  assert.equal(res.ok, true, '真实页面上填表脚本应当成功');
  assert.equal(w.document.getElementById('mm').value, nasty);
  w.close();
});

maybe('校方把验证码开关打开（dlsfbxyzm=1）时不自动填表，交给人工', () => {
  const w = bootReal();
  w.document.getElementById('dlsfbxyzm').value = '1';
  const r = w.eval(EduLogin.buildFillScript('a', 'b'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'captcha');
  // 报状态时也要把这个信号带出去，否则界面只会一直转圈
  assert.equal(w.eval(EduLogin.buildStatusScript()).captchaVisible, true);
  w.close();
});

maybe('V-9.0 的失败提示在 #dlktsxx 上也能读到（不只是老版 #tips）', () => {
  const w = bootReal();
  w.document.getElementById('dlktsxx').textContent = '用户名或密码错误，连续错误 2 次将被锁定';
  const st = w.eval(EduLogin.buildStatusScript());
  assert.equal(st.onLoginPage, true);
  assert.match(st.tip, /密码错误/);
  const verdict = EduLogin.classifyStatus(st);
  assert.equal(verdict.state, 'fail');
  // 带「锁定」字样的提示要追加劝阻，避免用户无脑重试把账号试锁
  assert.match(verdict.message, /先别重复尝试/);
  w.close();
});

maybe('离开登录页即判定成功（即使提示区还留着字）', () => {
  const w = bootReal();
  w.document.getElementById('tips').textContent = '登录中…';
  w.history.replaceState({}, '', 'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html');
  assert.equal(EduLogin.classifyStatus(w.eval(EduLogin.buildStatusScript())).state, 'success');
  w.close();
});
