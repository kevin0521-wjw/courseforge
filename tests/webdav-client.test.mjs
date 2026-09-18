/**
 * WebDAV 客户端测试（desktop/webdav-client.js）
 *
 * 用 Node 原生 http 模块起一个**真实本地服务器**来测 —— 客户端的全部价值
 * 就在「真的把请求发出去、真的把响应读回来」：Basic 头对不对、重定向跟不跟、
 * 错误码翻译成人话没有。桩测桩等于没测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWebdavClient } = require('../desktop/webdav-client.js');

const client = createWebdavClient({ http, https: { request: null } });

/** 起一次性服务器：handler 收 (req, res, bodyText)，返回监听端口 */
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { handler(req, res, Buffer.concat(chunks).toString('utf8')); }
        catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      fn('http://127.0.0.1:' + port)
        .catch(reject)
        .then(() => server.close(resolve));
    });
    server.on('error', reject);
  });
}

test('upload：PUT 带 Basic 认证头与 JSON 体，2xx 算成功', async () => {
  let seenAuth = '';
  let seenBody = '';
  let seenCt = '';
  await withServer((req, res, body) => {
    seenAuth = req.headers.authorization || '';
    seenCt = req.headers['content-type'] || '';
    seenBody = body;
    res.writeHead(201); res.end();
  }, async (base) => {
    const r = await client.upload(base + '/dav/CourseForge/courseforge-workspace.json', 'kevin', 'app-pass',
      '{"version":2,"semesters":[]}');
    assert.equal(r.ok, true, '201 应算上传成功：' + r.message);
    assert.equal(r.status, 201);
  });
  assert.equal(seenAuth, 'Basic ' + Buffer.from('kevin:app-pass', 'utf8').toString('base64'),
    'Basic 头必须是 user:pass 的 base64');
  assert.equal(seenCt, 'application/json');
  assert.match(seenBody, /"semesters"/);
});

test('upload：401 拒绝时给「认证失败」的人话，不假装成功', async () => {
  await withServer((req, res) => { res.writeHead(401); res.end(); }, async (base) => {
    const r = await client.upload(base + '/x', 'kevin', 'wrong');
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(r.message, /认证失败/);
  });
});

test('download：200 回正文与 Last-Modified；404 给「先上传一次」的引导', async () => {
  const payload = '{"version":2,"semesters":[{"courses":[1,2,3]}]}';
  await withServer((req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('kevin:app-pass').toString('base64')) {
      res.writeHead(401); res.end(); return;
    }
    res.writeHead(200, { 'Last-Modified': 'Fri, 18 Sep 2026 08:00:00 GMT' });
    res.end(payload);
  }, async (base) => {
    const r = await client.download(base + '/dav/x.json', 'kevin', 'app-pass');
    assert.equal(r.ok, true);
    assert.equal(r.body, payload, '正文必须一字不差');
    assert.equal(r.lastModified, 'Fri, 18 Sep 2026 08:00:00 GMT');
  });

  await withServer((req, res) => { res.writeHead(404); res.end('not found'); }, async (base) => {
    const r = await client.download(base + '/missing.json', 'kevin', 'app-pass');
    assert.equal(r.ok, false);
    assert.match(r.message, /先上传一次/, '404 要引导「先上传」，不是冷冰冰的状态码');
  });
});

test('download：跟随 302 重定向（坚果云式甩地址），最多 3 次', async () => {
  let hops = 0;
  await withServer((req, res) => {
    hops++;
    if (hops <= 2) { res.writeHead(302, { Location: '/hop' + hops }); res.end(); return; }
    res.writeHead(200); res.end('final');
  }, async (base) => {
    const r = await client.download(base + '/start', 'kevin', 'p');
    assert.equal(r.ok, true, '两次重定向后应拿到 200');
    assert.equal(r.body, 'final');
  });
  assert.equal(hops, 3, '必须真的跟了两次跳转');
});

test('download：重定向超过 3 次按失败处理，不无限绕圈', async () => {
  let hops = 0;
  await withServer((req, res) => { hops++; res.writeHead(302, { Location: '/hop' + hops }); res.end(); },
    async (base) => {
      const r = await client.download(base + '/start', 'kevin', 'p');
      assert.equal(r.ok, false);
      assert.match(r.message, /重定向/);
    });
  assert.ok(hops <= 4, '跳转次数必须有上限，实际 ' + hops);
});

test('网络层错误（连接拒绝）返回统一形状，不向外抛异常', async () => {
  // 0 号端口连不上任何东西：用「已被关闭的服务器」制造真实网络错误
  const dead = http.createServer(() => {});
  const port = await new Promise((r) => { dead.listen(0, '127.0.0.1', () => r(dead.address().port)); });
  await new Promise((r) => dead.close(r));
  const r = await client.download('http://127.0.0.1:' + port + '/x', 'u', 'p');
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.ok(r.message, '必须给一句能看懂的原因');
});

test('协议白名单：非 http(s) 的地址在客户端就被拒掉', async () => {
  const r = await client.download('file:///etc/passwd', 'u', 'p');
  assert.equal(r.ok, false);
});
