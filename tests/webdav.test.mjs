/**
 * WebDAV 云同步纯逻辑测试（web/js/webdav.js）
 *
 * 云端是用户自己管的服务器，返回什么都有可能 —— 配置清洗、路径拼接、
 * 载荷安检这三道闸是这个模块的全部价值，边界一个都不能漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WD = require('../web/js/webdav.js');

test('normalizeConfig：合法配置保留，首尾空白与尾部斜杠清掉', () => {
  const cfg = WD.normalizeConfig({
    url: '  https://dav.example.com/dav/// ',
    username: ' kevin ',
    password: 'app-pass'
  });
  assert.deepEqual(cfg, {
    url: 'https://dav.example.com/dav',
    username: 'kevin',
    password: 'app-pass'
  });
});

test('normalizeConfig：非 http(s) / 空值 / 缺用户名一律拒绝', () => {
  assert.equal(WD.normalizeConfig({ url: 'ftp://x.com', username: 'u' }), null, 'ftp 不行');
  assert.equal(WD.normalizeConfig({ url: 'file:///C:/x', username: 'u' }), null, 'file 不行');
  assert.equal(WD.normalizeConfig({ url: 'dav.example.com/dav', username: 'u' }), null, '没有协议不行');
  assert.equal(WD.normalizeConfig({ url: '', username: 'u' }), null, '空地址不行');
  assert.equal(WD.normalizeConfig({ url: 'https://x.com', username: '' }), null, '空用户名不行');
  assert.equal(WD.normalizeConfig(null), null);
  // 密码允许为空（有些内网服务器匿名可写）
  assert.ok(WD.normalizeConfig({ url: 'https://x.com/dav', username: 'u', password: '' }));
});

test('remoteUrl：拼接固定目录与文件名；空配置给空串', () => {
  assert.equal(
    WD.remoteUrl({ url: 'https://dav.jianguoyun.com/dav' }),
    'https://dav.jianguoyun.com/dav/CourseForge/courseforge-workspace.json'
  );
  assert.equal(WD.remoteUrl(null), '');
});

test('authHeader：Basic + 注入的 base64；b64 不是函数时给空串', () => {
  const seen = [];
  const head = WD.authHeader('user', 'p@ss:wõrd', (s) => { seen.push(s); return 'B64'; });
  assert.equal(head, 'Basic B64');
  assert.equal(seen[0], 'user:p@ss:wõrd', 'user:password 原样交给编码器（UTF-8 由它负责）');
  assert.equal(WD.authHeader('u', 'p', null), '');
});

test('validateBackupText：v2 / v1 放行，其余全部挡下', () => {
  const v2 = { version: 2, activeId: 's1', semesters: [{ id: 's1', courses: [] }] };
  assert.deepEqual(WD.validateBackupText(JSON.stringify(v2)), v2, 'v2 完整结构放行');

  const v1 = { version: 1, courses: [] };
  assert.ok(WD.validateBackupText(JSON.stringify(v1)), 'v1 旧备份也要认（导入文件同款兼容）');

  assert.equal(WD.validateBackupText('not json'), null, '不是 JSON');
  assert.equal(WD.validateBackupText(''), null, '空串');
  assert.equal(WD.validateBackupText('[1,2]'), null, '顶层数组');
  assert.equal(WD.validateBackupText('null'), null, '顶层数组null');
  assert.equal(WD.validateBackupText(JSON.stringify({ version: 2, activeId: 'x' })), null, 'v2 缺 semesters');
  assert.equal(WD.validateBackupText(JSON.stringify({ semesters: [] })), null, '缺 version');
  assert.equal(WD.validateBackupText(JSON.stringify({ version: 3, semesters: [] })), null, '不认识的版本');
  assert.equal(WD.validateBackupText(null), null, '非字符串');
});

test('validateBackupText：超过 20MB 直接挡下（防呆服务器返回天文数字）', () => {
  const big = '{"version":2,"semesters":[],"pad":"' + 'x'.repeat(21 * 1024 * 1024) + '"}';
  assert.equal(big.length > 20 * 1024 * 1024, true, '夹具本身必须真的超限');
  assert.equal(WD.validateBackupText(big), null, '超大载荷一律不解析');
});

test('workspaceSummary：v2 数学期数课程、v1 数课程、垃圾给空串', () => {
  const v2 = { version: 2, semesters: [
    { courses: [{}, {}, {}] },
    { courses: [{}] },
    {}
  ] };
  assert.equal(WD.workspaceSummary(v2), '3 个学期 · 共 4 门课');
  assert.equal(WD.workspaceSummary({ version: 1, courses: [{}, {}] }), '旧版数据 · 2 门课');
  assert.equal(WD.workspaceSummary(null), '');
  assert.equal(WD.workspaceSummary({ version: 2 }), '');
});
