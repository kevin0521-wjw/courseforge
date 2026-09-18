/**
 * 检查更新测试（desktop/update-checker.js）
 *
 * 与 WebDAV 客户端同一套哲学：起**真实本地服务器**测 —— User-Agent 头、
 * 404 的预期态语义、tag 解析失败的结构化返回、html_url 白名单。桩测桩等于没测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdateChecker, compareVersions, normalizeTag, RELEASES_PAGE } = require('../desktop/update-checker.js');

const checker = createUpdateChecker({ http, https: { request: null } });

/** 起一次性服务器：handler 收 (req, res)，返回监听地址 */
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        try { handler(req, res); }
        catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      fn('http://127.0.0.1:' + server.address().port)
        .catch(reject)
        .then(() => server.close(resolve));
    });
    server.on('error', reject);
  });
}

const release = (tag, htmlUrl) => JSON.stringify({ tag_name: tag, html_url: htmlUrl || ('https://github.com/kevin0521-wjw/courseforge/releases/tag/' + tag) });

test('compareVersions：三段数字比较，v 前缀剥掉，解析不了返回 null', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('v0.2.0', '0.1.0'), 1, 'v 前缀要剥掉');
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1, 'major 压过 minor/patch');
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('0.1.0-beta', '0.1.0'), null, '后缀不认识就承认不认识');
  assert.equal(compareVersions('', '0.1.0'), null);
  assert.equal(compareVersions('abc', '0.1.0'), null);
});

test('normalizeTag：剥 v 前缀，非字符串给空串', () => {
  assert.equal(normalizeTag('v1.2.3'), 'v1.2.3', 'normalize 只 trim 不剥 v（剥 v 是比较器的职责）');
  assert.equal(normalizeTag(' 0.2.0 '), '0.2.0');
  assert.equal(normalizeTag(null), '');
});

test('check：远端版本更新 → available，带 github 白名单内的下载链接', async () => {
  let seenUa = '';
  let seenAccept = '';
  await withServer((req, res) => {
    seenUa = req.headers['user-agent'] || '';
    seenAccept = req.headers.accept || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(release('v0.2.0'));
  }, async (base) => {
    const r = await checker.check(base + '/releases/latest', '0.1.0');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'available');
    assert.equal(r.latest, 'v0.2.0');
    assert.equal(r.current, '0.1.0');
    assert.match(r.downloadUrl, /^https:\/\/github\.com\//);
    assert.match(r.message, /发现新版本/);
  });
  assert.match(seenUa, /CourseForge/, 'GitHub API 缺 User-Agent 直接 403，必须带上');
  assert.match(seenAccept, /vnd\.github\+json/);
});

test('check：本机已是最新 / 远端更旧 → latest，不误报有更新', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end(release('v0.1.0'));
  }, async (base) => {
    const same = await checker.check(base + '/x', '0.1.0');
    assert.equal(same.status, 'latest');
    assert.match(same.message, /已是最新/);
    const older = await checker.check(base + '/x', '0.2.0');
    assert.equal(older.status, 'latest', '远端比本机旧也该算「已是最新」，绝不能引导降级');
  });
});

test('check：404 是预期态（还没发布过版本），返回结构化结论而非错误', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('{"message":"Not Found"}'); }, async (base) => {
    const r = await checker.check(base + '/x', '0.1.0');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'norelease');
    assert.match(r.message, /还没有发布/);
  });
});

test('check：tag 解析不了给 badtag，绝不当「已是最新」糊弄', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end(release('v1.0.0-beta.1'));
  }, async (base) => {
    const r = await checker.check(base + '/x', '0.1.0');
    assert.equal(r.ok, false);
    assert.equal(r.status, 'badtag');
    assert.match(r.message, /解析失败/);
  });
});

test('check：403 限流有人话；坏 JSON 给 badresponse', async () => {
  await withServer((req, res) => { res.writeHead(403); res.end(); }, async (base) => {
    const r = await checker.check(base + '/x', '0.1.0');
    assert.match(r.message, /限流/);
  });
  await withServer((req, res) => { res.writeHead(200); res.end('<html>not json</html>'); }, async (base) => {
    const r = await checker.check(base + '/x', '0.1.0');
    assert.equal(r.status, 'badresponse');
  });
});

test('check：html_url 不是 github.com 一律回落到固定发布页（防响应被篡改引流）', async () => {
  await withServer((req, res) => {
    res.writeHead(200);
    res.end(release('v9.9.9', 'https://evil.example.com/download'));
  }, async (base) => {
    const r = await checker.check(base + '/x', '0.1.0');
    assert.equal(r.status, 'available');
    assert.equal(r.downloadUrl, RELEASES_PAGE, '白名单外的链接必须换成固定 releases 页');
  });
});

test('check：连接拒绝 → 统一形状的 network 失败，不抛异常', async () => {
  // 端口 1 几乎必然无监听；即便个别环境有，也是一次确定性的失败路径
  const r = await checker.check('http://127.0.0.1:1/x', '0.1.0');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'network');
  assert.ok(r.message && r.message.length > 0);
});
