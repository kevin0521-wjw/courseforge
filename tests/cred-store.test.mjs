/**
 * 教务账号本机加密存储测试
 *
 * 这层测试守的是**最不能出错的东西**：磁盘上不能出现明文密码。
 * 所以除了常规的读写往返，还有两条关键断言：
 *  1. 写完之后，把密文文件整个读出来，里面**不能出现密码明文**；
 *  2. 本机没有加密能力时（Linux 无 keyring / safeStorage 抛异常），
 *     保存必须**失败**，绝不能「降级成明文」偷偷存下来。
 *     这个降级一旦发生，用户永远不会知道自己的密码躺在硬盘里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCredStore, FILE_VERSION } = require(
  fileURLToPath(new URL('../desktop/cred-store.js', import.meta.url)));

/** 临时目录按用例建，跑完删掉，避免相互干扰 */
function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cred-'));
  return path.join(dir, name || 'edu-credentials.json');
}

/**
 * safeStorage 桩：只做可逆变换，不真加密。
 * 这个测试关心的不是密码学强度（那是 Electron/DPAPI 的职责），
 * 而是「有没有把明文写下去」以及各条分支的行为。
 */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b) => Buffer.from(String(b).replace(/^ENC:/, ''), 'base64').toString('utf8')
  };
}

test('保存后能读回，且磁盘上不出现密码明文', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage() });

  const saved = store.save({ username: '26125005', password: 'P@ssw0rd-机密' });
  assert.equal(saved.ok, true);

  const back = store.read();
  assert.equal(back.username, '26125005');
  assert.equal(back.password, 'P@ssw0rd-机密', '应能原样解回密码（含特殊字符与中文）');

  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('P@ssw0rd'), '磁盘上绝不能出现密码明文');
  assert.ok(!raw.includes('26125005'), '用户名也一并在密文里，不该裸着落盘');

  const env = JSON.parse(raw);
  assert.equal(env.v, FILE_VERSION, '要带版本号，换加密方式时才认得出老文件');
  assert.ok(typeof env.secret === 'string' && env.secret.length > 0);
});

test('没有加密能力时拒绝保存，绝不降级成明文', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage(false) });

  const saved = store.save({ username: 'u', password: 'p' });
  assert.equal(saved.ok, false);
  assert.equal(saved.reason, 'noenc');
  assert.equal(fs.existsSync(file), false, '被拒绝时不该留下任何文件');

  assert.equal(store.available(), false);
  const st = store.status();
  assert.equal(st.available, false);
  assert.equal(st.saved, false);
});

test('safeStorage 抛异常（平台未就绪）也要按「不可用」处理，而不是崩掉', () => {
  const file = tmpFile();
  const boom = {
    isEncryptionAvailable: () => { throw new Error('not ready'); },
    encryptString: () => { throw new Error('not ready'); },
    decryptString: () => { throw new Error('not ready'); }
  };
  const store = createCredStore({ file, safeStorage: boom });
  assert.equal(store.available(), false);
  assert.equal(store.save({ username: 'u', password: 'p' }).reason, 'noenc');
  assert.equal(store.read(), null);
});

test('文件损坏 / 版本不认识 / 换个账户解不开 —— 一律当作没存过且不抛异常', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage() });

  fs.writeFileSync(file, '这不是 JSON');
  assert.equal(store.read(), null, '损坏文件应静默返回 null，不能让启动流程炸掉');

  fs.writeFileSync(file, JSON.stringify({ v: 999, secret: 'x' }));
  assert.equal(store.read(), null, '版本不认识就当没存过');

  // 解密抛异常 = 常见于用户换了 Windows 账户 / 换了机器
  const broken = createCredStore({
    file,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('x'),
      decryptString: () => { throw new Error('dpapi fail'); }
    }
  });
  fs.writeFileSync(file, JSON.stringify({ v: FILE_VERSION, secret: 'AAAA' }));
  assert.equal(broken.read(), null);
});

test('参数不合法不落盘：空用户名、空密码、超长输入', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage() });

  assert.equal(store.save({ username: '', password: 'p' }).reason, 'badinput');
  assert.equal(store.save({ username: 'u', password: '' }).reason, 'badinput');
  assert.equal(store.save({ username: 'u'.repeat(201), password: 'p' }).reason, 'badinput');
  assert.equal(store.save({ username: 'u', password: 'p'.repeat(201) }).reason, 'badinput');
  assert.equal(fs.existsSync(file), false);
});

test('清除：文件消失、再读为空、重复清除也算成功', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage() });
  store.save({ username: 'u', password: 'p' });
  assert.equal(store.read().username, 'u');

  assert.equal(store.clear(), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.read(), null);
  assert.equal(store.clear(), true, '本来就不存在时应视为成功（幂等）');
});

test('状态只回用户名、不回密码（密码不该有机会到达页面）', () => {
  const file = tmpFile();
  const store = createCredStore({ file, safeStorage: fakeSafeStorage() });
  store.save({ username: '26125005', password: 'secret-pw' });

  const st = store.status();
  assert.equal(st.saved, true);
  assert.equal(st.username, '26125005');
  assert.equal(Object.prototype.hasOwnProperty.call(st, 'password'), false,
    'status 的返回里不能带密码字段，否则会被渲染进程拿到');
});
